// Setup window logic. Talks to the main process only through window.claudeOffice
// (desktop/src/preload.ts). No remote content, no Node access.
"use strict";

const api = window.claudeOffice;
const $ = (id) => document.getElementById(id);

function setCheck(id, state, text) {
  const el = $(id);
  el.className = state;
  el.textContent = text;
}

function say(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = kind;
}

function selectedDistros() {
  return [...document.querySelectorAll("#wsl-list input:checked")].map((i) => i.value);
}

function render(s) {
  setCheck(
    "chk-claude",
    s.claudeDirFound ? "ok" : "warn",
    s.claudeDirFound
      ? "Claude Code settings folder found (~/.claude)."
      : "No ~/.claude folder yet. Run Claude Code once, or connect anyway and it will be created.",
  );
  const h = s.hooks;
  if (!h) {
    setCheck("chk-hooks", "warn", "Could not read the hook status (see logs).");
  } else if (h.installed_hooks.length === 0) {
    setCheck("chk-hooks", "", "Not connected.");
  } else if (h.missing_hooks.length === 0) {
    setCheck("chk-hooks", "ok", `Connected: ${h.installed_hooks.length} hooks in ${h.settings_path}.`);
  } else {
    setCheck("chk-hooks", "warn", `Partially connected (${h.missing_hooks.length} hooks missing): connect again to repair.`);
  }
  $("opt-statusline").checked = s.statusline || Boolean(h && h.statusline_wrapped);
  $("opt-login").checked = s.openAtLogin;
  $("opt-tray").checked = s.closeToTray;
  $("btn-disconnect").disabled = !(h && h.installed_hooks.length > 0) && !s.connected;
  $("meta").textContent = `v${s.version} · port ${s.port}`;

  const wsl = s.wsl;
  $("wsl").hidden = !(wsl && wsl.available);
  if (wsl && wsl.available) {
    const list = $("wsl-list");
    list.replaceChildren(
      ...wsl.distros.map((d) => {
        const label = document.createElement("label");
        label.className = "opt";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = d.name;
        box.checked = s.wslDistros.includes(d.name);
        const text = document.createElement("span");
        text.textContent = d.connected ? `${d.name} (connected)` : d.name;
        label.append(box, text);
        return label;
      }),
    );
    $("wsl-net").textContent = wsl.mirrored
      ? "WSL networking is mirrored: distributions reach this app on localhost."
      : "WSL uses NAT networking: hooks reach this app through the Windows host address. " +
        "If events do not arrive, set networkingMode=mirrored in %UserProfile%\\.wslconfig.";
  }
}

async function refresh() {
  try {
    render(await api.status());
  } catch (err) {
    say(String(err.message || err), "err");
  }
}

async function busy(label, fn) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  say(label);
  try {
    await fn();
  } catch (err) {
    say(String(err.message || err).replace(/^Error invoking remote method '[^']+': /, ""), "err");
    buttons.forEach((b) => (b.disabled = false));
    await refresh();
    return false;
  }
  buttons.forEach((b) => (b.disabled = false));
  await refresh();
  return true;
}

$("btn-connect").addEventListener("click", async () => {
  const ok = await busy("Connecting…", () =>
    api.connect({ statusline: $("opt-statusline").checked, wslDistros: selectedDistros() }),
  );
  if (ok) say("Connected. Restart any running Claude Code sessions to pick up the hooks.", "ok");
});

$("btn-disconnect").addEventListener("click", async () => {
  const ok = await busy("Disconnecting…", () => api.disconnect());
  if (ok) say("Disconnected. Your Claude Code settings are back to how they were.", "ok");
});

$("opt-login").addEventListener("change", (e) => api.setPrefs({ openAtLogin: e.target.checked }));
$("opt-tray").addEventListener("change", (e) => api.setPrefs({ closeToTray: e.target.checked }));
$("btn-logs").addEventListener("click", () => api.openLogs());
$("btn-office").addEventListener("click", () => api.openOffice());

refresh();
