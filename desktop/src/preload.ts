/**
 * Bridge for the local setup window only (the office window itself loads the
 * web frontend without any preload). Exposes a fixed set of IPC calls.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("claudeOffice", {
  status: () => ipcRenderer.invoke("co:status"),
  connect: (opts: { statusline: boolean; wslDistros: string[] }) =>
    ipcRenderer.invoke("co:connect", opts),
  disconnect: () => ipcRenderer.invoke("co:disconnect"),
  setPrefs: (prefs: { openAtLogin?: boolean; closeToTray?: boolean }) =>
    ipcRenderer.invoke("co:set-prefs", prefs),
  openLogs: () => ipcRenderer.invoke("co:open-logs"),
  openOffice: () => ipcRenderer.invoke("co:open-office"),
});
