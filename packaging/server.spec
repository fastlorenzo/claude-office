# PyInstaller spec: frozen FastAPI backend (onedir) for the desktop app.
# Build: make -C packaging server   (output: packaging/dist/claude-office-server/)
# Findings from the Phase 0 spike: SQLAlchemy imports the aiosqlite driver
# dynamically, uvicorn picks loop/protocol modules by name, and the version
# string comes from package metadata, so all three must be declared here.
# backend/floors.toml is deliberately NOT bundled (it is a developer's own
# floor layout; a missing file means an empty building config).
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

BACKEND = str(Path(SPECPATH).parent / "backend")

hiddenimports = (
    collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("sqlalchemy.dialects.sqlite")
    + ["aiosqlite", "greenlet"]
)

a = Analysis(
    [str(Path(BACKEND) / "app" / "__main__.py")],
    pathex=[BACKEND],
    datas=copy_metadata("claude-office-visualizer"),
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "pyright", "ruff"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="claude-office-server",
    console=True,
)
coll = COLLECT(exe, a.binaries, a.datas, name="claude-office-server")
