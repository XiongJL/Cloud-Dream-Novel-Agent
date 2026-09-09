from __future__ import annotations

import argparse
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test a packaged Agent runtime")
    parser.add_argument("--binary", required=True)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.is_file():
        raise FileNotFoundError(f"Agent runtime binary does not exist: {binary}")

    with tempfile.TemporaryDirectory(prefix="novel-agent-smoke-") as temp_value:
        temp_dir = Path(temp_value)
        automation_runtime = temp_dir / "automation-runtime.json"
        automation_runtime.write_text(json.dumps({"port": 1, "token": "smoke"}), encoding="utf-8")
        state_dir = temp_dir / "state"
        state_dir.mkdir()
        port = free_port()
        process = subprocess.Popen(
            [
                str(binary),
                "--port",
                str(port),
                "--token",
                "smoke-token",
                "--automation-runtime",
                str(automation_runtime),
                "--state-dir",
                str(state_dir),
            ],
            cwd=binary.parent,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + args.timeout
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    stdout, stderr = process.communicate(timeout=5)
                    raise RuntimeError(
                        f"Agent runtime exited before health check: code={process.returncode}\n"
                        f"stdout:\n{stdout[-4000:]}\nstderr:\n{stderr[-4000:]}"
                    )
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                        payload = json.load(response)
                    capabilities = ((payload.get("data") or {}).get("capabilities") or [])
                    if payload.get("ok") is True and "agent.plan" in capabilities:
                        print(f"[agent-runtime] health smoke passed on port {port}")
                        break
                    raise RuntimeError(f"Unexpected health response: {payload}")
                except URLError:
                    time.sleep(0.25)
            else:
                raise TimeoutError(f"Agent runtime did not become healthy within {args.timeout:.0f}s")

            request = Request(
                f"http://127.0.0.1:{port}/invoke",
                data=json.dumps({
                    "requestId": "packaged-skill-smoke",
                    "method": "agent.skills",
                    "params": {"locale": "zh-CN"},
                    "context": {"locale": "zh-CN"},
                }).encode("utf-8"),
                headers={
                    "Authorization": "Bearer smoke-token",
                    "Content-Type": "application/json",
                },
            )
            with urlopen(request, timeout=10) as response:
                skills_response = json.load(response)
            skills = skills_response.get("data") if skills_response.get("ok") is True else None
            skill_ids = {item.get("id") for item in skills if isinstance(item, dict)} if isinstance(skills, list) else set()
            expected = {
                "builtin.continuity-review",
                "builtin.novel-bootstrap",
                "builtin.style-skill-extractor",
            }
            if not expected.issubset(skill_ids):
                raise RuntimeError(f"Packaged Agent runtime built-in skills smoke failed: {skills_response}")
            print(f"[agent-runtime] built-in skills smoke passed: {sorted(expected)}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
