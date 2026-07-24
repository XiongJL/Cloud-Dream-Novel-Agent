from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the bundled CloudDream Agent runtime")
    parser.add_argument("--output", help="Output directory inside the repository")
    parser.add_argument("--skip-smoke", action="store_true", help="Skip the packaged --help smoke test")
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

    built_bundle = dist_root / "novel-agent-runtime"
    binary = runtime_binary(built_bundle)
    if not binary.is_file():
        raise FileNotFoundError(f"PyInstaller runtime binary was not created: {binary}")

    shutil.copytree(built_bundle, output)
    packaged_binary = runtime_binary(output)
    if not args.skip_smoke:
        subprocess.run(
            [str(packaged_binary), "--help"],
            check=True,
            timeout=90,
        )

    print(f"[agent-runtime] built {packaged_binary}")


if __name__ == "__main__":
    main()
