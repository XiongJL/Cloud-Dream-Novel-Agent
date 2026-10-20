from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import secrets
import socket
import time
import urllib.request

import PyInstaller.__main__


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNTIME_ROOT.parent
DEFAULT_OUTPUT = REPO_ROOT / "apps" / "desktop" / "build" / "agent-runtime"
BUILD_ROOT = RUNTIME_ROOT / "build"


def resolve_output(value: str | None) -> Path:
    output = Path(value).resolve() if value else DEFAULT_OUTPUT.resolve()
    repo_root = REPO_ROOT.resolve()
    if os.path.commonpath((str(repo_root), str(output))) != str(repo_root):
        raise ValueError(f"Runtime output must stay inside the repository: {output}")
    return output


def reset_directory(path: Path, output: Path) -> None:
    build_root = BUILD_ROOT.resolve()
    output_root = output.resolve()
    resolved = path.resolve()
    allowed = resolved == output_root or os.path.commonpath((str(build_root), str(resolved))) == str(build_root)
    if not allowed:
        raise ValueError(f"Refusing to remove unexpected directory: {resolved}")
    if resolved.exists():
        shutil.rmtree(resolved)


def runtime_binary(directory: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return directory / f"novel-agent-runtime{suffix}"


def extractor_binary(directory: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return directory / f"document-extractor{suffix}"


def smoke_http_gateway(binary: Path) -> None:
    """Exercise the primary packaged transport without desktop data or models."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token = secrets.token_hex(32)
    env = dict(os.environ, NOVEL_MCP_HTTP_TOKEN=token)
    with tempfile.TemporaryFile() as log:
        child = subprocess.Popen(
            [str(binary), "--mode", "mcp-http", "--port", str(port), "--parent-stdio"],
            stdin=subprocess.PIPE, stdout=log, stderr=log, env=env,
        )
        try:
            for _ in range(450):
                if child.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(f"Packaged MCP HTTP exited: {log.read().decode('utf-8', errors='replace')}")
                try:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}/health", headers={"Authorization": f"Bearer {token}"},
                    )
                    with urllib.request.urlopen(request, timeout=.5) as response:
                        if json.load(response).get("service") == "novel-editor-mcp":
                            break
                except (OSError, ValueError):
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError("Packaged MCP HTTP startup timed out")
            result = subprocess.run(
                [str(binary), "--mode", "mcp-stdio", "--smoke", "--url", f"http://127.0.0.1:{port}/mcp", "--list-only"],
                capture_output=True, check=True, timeout=60, env=env,
            )
            if json.loads(result.stdout.decode("utf-8")).get("toolCount") != 31:
                raise RuntimeError("Packaged MCP HTTP did not expose the expected tools")
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the bundled CloudDream Agent runtime")
    parser.add_argument("--output", help="Output directory inside the repository")
    parser.add_argument("--skip-smoke", action="store_true", help="Skip packaged MCP, runtime and document extractor smoke tests")
    args = parser.parse_args()

    output = resolve_output(args.output)
    dist_root = BUILD_ROOT / "dist"
    work_root = BUILD_ROOT / "work"
    for directory in (output, dist_root, work_root):
        reset_directory(directory, output)

    PyInstaller.__main__.run(
        [
            str(RUNTIME_ROOT / "novel-agent-runtime.spec"),
            "--noconfirm",
            "--clean",
            "--distpath",
            str(dist_root),
            "--workpath",
            str(work_root),
        ]
    )

    PyInstaller.__main__.run(
        [
            str(RUNTIME_ROOT / "document-extractor.spec"),
            "--noconfirm",
            "--clean",
            "--distpath",
            str(dist_root),
            "--workpath",
            str(work_root / "document-extractor"),
        ]
    )

    built_bundle = dist_root / "novel-agent-runtime"
    PyInstaller.__main__.run(
        [
            str(RUNTIME_ROOT / "document-exporter.spec"),
            "--noconfirm", "--clean", "--distpath", str(dist_root),
            "--workpath", str(work_root / "document-exporter"),
        ]
    )
    built_exporter_bundle = dist_root / "document-exporter"
    exporter_name = "document-exporter.exe" if os.name == "nt" else "document-exporter"
    if not (built_exporter_bundle / exporter_name).is_file():
        raise FileNotFoundError("PyInstaller document exporter binary was not created")
    binary = runtime_binary(built_bundle)
    if not binary.is_file():
        raise FileNotFoundError(f"PyInstaller runtime binary was not created: {binary}")

    shutil.copytree(built_bundle, output)
    shutil.copytree(built_exporter_bundle, output / "document-exporter")
    packaged_binary = runtime_binary(output)
    built_extractor_bundle = dist_root / "document-extractor"
    built_extractor = extractor_binary(built_extractor_bundle)
    if not built_extractor.is_file():
        raise FileNotFoundError(f"PyInstaller document extractor binary was not created: {built_extractor}")
    packaged_extractor_bundle = output / "document-extractor"
    shutil.copytree(built_extractor_bundle, packaged_extractor_bundle)
    packaged_extractor = extractor_binary(packaged_extractor_bundle)
    if not args.skip_smoke:
        smoke_http_gateway(packaged_binary)
        mcp_smoke = subprocess.run(
            [str(packaged_binary), "--mode", "mcp-stdio", "--smoke", "--list-only"],
            capture_output=True, check=True, timeout=90,
        )
        mcp_report = json.loads(mcp_smoke.stdout.decode("utf-8"))
        if mcp_report.get("toolCount") != 31:
            raise RuntimeError("Packaged MCP gateway did not expose the expected tools")
        subprocess.run(
            [str(packaged_binary), "--help"],
            check=True,
            timeout=90,
        )
        with tempfile.TemporaryDirectory(prefix="cloud-dream-extractor-smoke-") as temp_dir:
            source = Path(temp_dir) / "smoke.txt"
            source.write_text("document extractor smoke test 😀", encoding="utf-8")
            request = {
                "protocolVersion": "document-extractor-v1",
                "jobId": "packaged-smoke",
                "temporaryFilePath": str(source),
                "originalFileName": source.name,
                "extension": ".txt",
                "limits": {"maxCharacters": 1000, "timeoutMs": 30000},
            }
            result = subprocess.run(
                [str(packaged_extractor)],
                input=json.dumps(request).encode("utf-8"),
                capture_output=True,
                check=True,
                timeout=90,
            )
            response = json.loads(result.stdout.decode("utf-8"))
            if response.get("ok") is not True or response.get("document", {}).get("plainText") != source.read_text(encoding="utf-8"):
                raise RuntimeError("Packaged document extractor smoke test returned an invalid response")
        with tempfile.TemporaryDirectory(prefix="cloud-dream-exporter-smoke-") as temp_dir:
            directory = Path(temp_dir)
            snapshot = {"title": "导出测试😀", "author": "作者", "description": "简介", "volumes": [
                {"id": "v", "title": "第一卷", "chapters": [{"id": "c", "title": "第一章", "paragraphs": ["正文😀"]}]}
            ]}
            (directory / "snapshot.json").write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            for format in ("txt", "docx"):
                result = subprocess.run(
                    [str(output / "document-exporter" / exporter_name)],
                    input=json.dumps({"protocolVersion": "document-exporter-v1", "jobId": "smoke", "directory": str(directory), "format": format}).encode("utf-8"),
                    capture_output=True, check=True, timeout=90,
                )
                response = json.loads(result.stdout.decode("utf-8").splitlines()[-1])
                if response.get("ok") is not True or response.get("chapters") != 1 or not (directory / f"output.{format}").is_file():
                    raise RuntimeError("Packaged document exporter smoke test failed")

    print(f"[agent-runtime] built {packaged_binary}")
    print(f"[document-extractor] built {packaged_extractor}")
    print(f"[document-exporter] built {output / 'document-exporter' / exporter_name}")


if __name__ == "__main__":
    main()
