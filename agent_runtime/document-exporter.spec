import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, copy_metadata

runtime_root = Path(SPECPATH)
datas, binaries, hiddenimports = collect_all("docx")
datas += copy_metadata("python-docx")
analysis = Analysis(
    [str(runtime_root / "document_exporter_entry.py")],
    pathex=[str(runtime_root)], binaries=binaries, datas=datas,
    hiddenimports=hiddenimports, hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=["pytest"], noarchive=False, optimize=0,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz, analysis.scripts, [], exclude_binaries=True, name="document-exporter",
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=True, target_arch=os.environ.get("NOVEL_AGENT_TARGET_ARCH") or None,
)
bundle = COLLECT(exe, analysis.binaries, analysis.datas, strip=False, upx=False, name="document-exporter")
