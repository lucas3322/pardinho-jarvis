// Ponte mínima entre o app desktop e a interface.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisDesktop", {
  shortcut: "⌥⇧J",
  chooseFolder(current) {
    return ipcRenderer.invoke("jarvis:choose-folder", current);
  },
  captureScreen() {
    return ipcRenderer.invoke("jarvis:capture-screen");
  },
  setWake(enabled) {
    ipcRenderer.send("jarvis:set-wake", enabled);
  },
  setLive(live) {
    ipcRenderer.send("jarvis:live", live);
  },
  onWake(callback) {
    ipcRenderer.on("jarvis:wake", () => callback());
  },
  onWakeCommand(callback) {
    ipcRenderer.on("jarvis:wake-command", (_e, text) => callback(text));
  },
  onWakeError(callback) {
    ipcRenderer.on("jarvis:wake-error", (_e, message) => callback(message));
  },
  onToggle(callback) {
    ipcRenderer.on("jarvis:toggle", () => callback());
  },
});
