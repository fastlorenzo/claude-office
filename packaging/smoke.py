"""End-to-end check of the frozen sidecars (run after `make -C packaging all`).

Starts dist/claude-office-server against a temp data dir with an explicit key
(the desktop configuration) and a minimal static export, then verifies:
health, the static index loads without a key, the API rejects a missing key,
the frozen hook delivers an event that shows up as a session, the server stops
when stdin closes, and the hook's cold-start latency.
"""

import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

DIST = Path(__file__).parent / "dist"
EXE = ".exe" if os.name == "nt" else ""
SERVER = DIST / "claude-office-server" / f"claude-office-server{EXE}"
HOOK = DIST / "claude-office-hook" / f"claude-office-hook{EXE}"
KEY = "smoke-key"
HOOK_P95_BUDGET_MS = float(os.environ.get("HOOK_P95_BUDGET_MS", "150"))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url: str, key: str | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"X-API-Key": key} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, OSError):
        return 0, b""  # not listening yet


def main() -> int:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="co-smoke-"))
    static = tmp / "static"
    (static / "_next").mkdir(parents=True)
    (static / "index.html").write_text("<html>smoke-index</html>")
    home = tmp / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "claude-office-config.env").write_text(
        f'CLAUDE_OFFICE_API_KEY="{KEY}"\nCLAUDE_OFFICE_API_URL="{base}/api/v1/events"\n'
    )

    env = {
        **os.environ,
        "CLAUDE_OFFICE_DATA_DIR": str(tmp / "data"),
        "CLAUDE_OFFICE_STATIC_DIR": str(static),
        "CLAUDE_OFFICE_API_KEY": KEY,
        "SERVE_STATIC": "1",
        "CI_POLL_ENABLED": "0",
    }
    server = subprocess.Popen(
        [str(SERVER), "--port", str(port), "--exit-on-stdin-close"],
        stdin=subprocess.PIPE,
        stdout=open(tmp / "server.log", "wb"),
        stderr=subprocess.STDOUT,
        env=env,
        cwd=tmp,
    )
    failures: list[str] = []

    def check(name: str, ok: bool) -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(name)

    try:
        t0 = time.monotonic()
        while time.monotonic() - t0 < 30 and get(f"{base}/health")[0] != 200:
            time.sleep(0.2)
        check(f"health (startup {time.monotonic() - t0:.1f}s)", get(f"{base}/health")[0] == 200)
        status, body = get(f"{base}/")
        check("static index served without key", status == 200 and b"smoke-index" in body)
        check("API rejects missing key", get(f"{base}/api/v1/sessions")[0] == 401)

        hook_env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
        payload = json.dumps(
            {"session_id": "smoke-session", "hook_event_name": "SessionStart", "cwd": str(tmp)}
        ).encode()
        subprocess.run([str(HOOK), "session_start"], input=payload, env=hook_env, timeout=10)
        status, body = get(f"{base}/api/v1/sessions", KEY)
        check("hook event became a session", status == 200 and b"smoke-session" in body)

        times = []
        for _ in range(20):
            t = time.perf_counter()
            subprocess.run([str(HOOK), "--version"], capture_output=True, env=hook_env)
            times.append((time.perf_counter() - t) * 1000)
        times.sort()
        p95 = times[18]
        print(f"      hook cold start: median {statistics.median(times):.0f} ms, p95 {p95:.0f} ms")
        check(f"hook p95 under {HOOK_P95_BUDGET_MS:.0f} ms", p95 < HOOK_P95_BUDGET_MS)
        ver = subprocess.run([str(HOOK), "--version"], capture_output=True, text=True).stdout
        check(f"hook reports a real version ({ver.strip()})", "unknown" not in ver)

        assert server.stdin is not None
        server.stdin.close()
        try:
            server.wait(timeout=8)
            check("server exits on stdin close", True)
        except subprocess.TimeoutExpired:
            check("server exits on stdin close", False)
    finally:
        if server.poll() is None:
            server.kill()
    if failures:
        print(f"\nserver log: {tmp / 'server.log'}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
