import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata


runtime_root = Path(SPECPATH)
datas = []
binaries = []
hiddenimports = [
    "uvicorn.lifespan.on",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
]

fastmcp_datas, fastmcp_binaries, fastmcp_hiddenimports = collect_all("fastmcp")
datas += fastmcp_datas
binaries += fastmcp_binaries
hiddenimports += fastmcp_hiddenimports
hiddenimports += collect_submodules("langgraph")

for distribution in (
    "fastapi",
    "fastmcp",
    "httpx",
    "langgraph",
    "langgraph-checkpoint",
    "langgraph-checkpoint-sqlite",
    "pydantic",
    "uvicorn",
):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(runtime_root / "runtime_entry.py")],
    pathex=[str(runtime_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="novel-agent-runtime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    target_arch=os.environ.get("NOVEL_AGENT_TARGET_ARCH") or None,
)

bundle = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="novel-agent-runtime",
)
