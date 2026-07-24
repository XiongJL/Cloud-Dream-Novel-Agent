import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata


runtime_root = Path(SPECPATH)
datas = []
binaries = []
hiddenimports = []

for package in ("charset_normalizer", "docx", "fitz"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for distribution in ("charset-normalizer", "PyMuPDF", "python-docx"):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(runtime_root / "document_extractor_entry.py")],
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
    name="document-extractor",
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
    name="document-extractor",
)
