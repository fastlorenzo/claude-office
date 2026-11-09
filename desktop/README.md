# Claude Office desktop app

An Electron shell that packages the whole visualizer as one install per OS:

- **Windows**: `Claude-Office-Setup-<version>.exe` (per-user NSIS installer, no admin)
- **Linux**: `Claude-Office-<version>-x86_64.AppImage` and a `.deb`

The user launches it, clicks **Connect** once in the Integrations window, and
the office shows their Claude Code sessions. No Python, Node or `uv` needed.

## How it works

```
Electron main (src/main.ts)
 ├─ spawns resources/server/claude-office-server   frozen FastAPI backend (PyInstaller)
 │    127.0.0.1:<port> (8000 when free), explicit API key, --exit-on-stdin-close
 │    env: CLAUDE_OFFICE_DATA_DIR=<userData>/data, CLAUDE_OFFICE_STATIC_DIR=resources/static
 ├─ office window → http://127.0.0.1:<port>/?token=<key>  (same-origin static export)
 ├─ Integrations window (setup/, preload bridge) → claude-office-hook install|uninstall|status
 └─ tray, single instance, open at login, auto-update (NSIS + AppImage)
```

- **Hooks**: the bundled `claude-office-hook` is copied to a stable, versioned
  per-user dir (`~/.local/share/claude-office/hook/<version>/`,
  `%LOCALAPPDATA%\claude-office\hook\<version>\`) and registered there by
  absolute path. An AppImage mounts at a random path on every launch, and a
  versioned dir means an update never overwrites a running binary. On each
  launch the app re-points the hooks if the version or port changed.
- **Key**: the backend enforces an explicit key. The app adopts the key in
  `~/.claude/claude-office-config.env` when there is one (`install` never
  replaces it), so a previous dev install keeps working.
- **GPU**: `gpu: "auto"` in `config.json` ignores Chromium's GPU blocklist,
  which otherwise disables WebGL entirely on some drivers (e.g. WSLg).
  `"software"` forces SwiftShader. `CLAUDE_OFFICE_DESKTOP_GPU` overrides it.
- **Files**: `config.json`, `logs/server.log` and `data/` (SQLite DB, telemetry)
  live in Electron's userData dir (`~/.config/Claude Office`,
  `%APPDATA%\Claude Office`). The menu has *Open logs folder* / *Open data folder*.

## Develop

```bash
make install                 # bun install + Electron binary
make sidecars                # = make -C ../packaging all (frozen server + hook)
make dev                     # run against packaging/dist + ../frontend/out
make checkall                # lint, typecheck, unit tests (bun test)
make dist-linux              # AppImage + .deb into release/
```

`make dist-win` runs on Windows and also needs `../packaging/dist-linux/claude-office-hook`
(the Linux hook bundle installed into WSL distros), which the release workflow
provides from its Linux job.

### Smoke mode

```bash
CLAUDE_OFFICE_DESKTOP_SMOKE=/path/out \
CLAUDE_OFFICE_DESKTOP_USER_DATA=/tmp/profile \
CLAUDE_OFFICE_DESKTOP_SMOKE_CONNECT=1 \
  release/linux-unpacked/claude-office
```

This loads the office, writes `office.png` and `report.json` (WebGL renderer,
GPU feature status, console errors) and quits. With `SMOKE_CONNECT=1` it also
connects Claude Code (run it with a throwaway `HOME`!), fires one event through
the deployed hook and checks that the backend received it.

## Uninstalling

The Windows uninstaller offers to remove the hooks (it skips this during
auto-updates). On Linux, click **Disconnect** first. Disconnect restores the
original `statusLine` and removes only Claude Office's own hook entries.
