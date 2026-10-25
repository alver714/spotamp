const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spotamp", {
  hide: () => ipcRenderer.send("widget:hide"),
  dragStart: (x, y) => ipcRenderer.send("widget:drag-start", x, y),
  dragMove: (x, y) => ipcRenderer.send("widget:drag-move", x, y),
  openUrl: (url) => ipcRenderer.send("open-url", url),
  startEngine: () => ipcRenderer.send("engine:start"),
  setupDone: () => ipcRenderer.send("setup:done"),
});
