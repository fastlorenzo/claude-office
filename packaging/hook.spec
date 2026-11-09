# PyInstaller spec: frozen Claude Code hook CLI (onedir) for the desktop app.
# Build: make -C packaging hook   (output: packaging/dist/claude-office-hook/)
# Kept separate from the server so it stays small and fast: it runs on every
# Claude Code event under a 2 s timeout (spike: ~73 ms median cold start).
from pathlib import Path

from PyInstaller.utils.hooks import copy_metadata

HOOKS_SRC = str(Path(SPECPATH).parent / "hooks" / "src")

a = Analysis(
    [str(Path(HOOKS_SRC) / "claude_office_hooks" / "__main__.py")],
    pathex=[HOOKS_SRC],
    datas=copy_metadata("claude-office-hooks"),
    excludes=["tkinter", "pytest", "pyright", "ruff"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="claude-office-hook",
    console=True,
)
coll = COLLECT(exe, a.binaries, a.datas, name="claude-office-hook")
