const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desk", {
  getState: () => ipcRenderer.invoke("state:get"),
  togglePanel: () => ipcRenderer.invoke("panel:toggle"),
  punch: (type) => ipcRenderer.invoke("day:punch", type),
  saveDay: (patch) => ipcRenderer.invoke("day:save", patch),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  clearToday: () => ipcRenderer.invoke("day:clear"),
  goBack: () => ipcRenderer.invoke("oa:back"),
  goForward: () => ipcRenderer.invoke("oa:forward"),
  reload: () => ipcRenderer.invoke("oa:reload"),
  goHome: () => ipcRenderer.invoke("oa:home"),
  refreshAttendance: () => ipcRenderer.invoke("attendance:refresh"),
  openExternal: () => ipcRenderer.invoke("oa:open-external"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  }
});
