import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { DeskApi, DeskState } from "../shared/desk"

const desk: DeskApi = {
  getState: () => ipcRenderer.invoke("state:get"),
  togglePanel: () => ipcRenderer.invoke("panel:toggle"),
  setAvatar: (avatar) => ipcRenderer.invoke("assistant:set-avatar", avatar),
  chooseAvatar: () => ipcRenderer.invoke("assistant:choose-avatar"),
  runCommand: (input) => ipcRenderer.invoke("assistant:command", input),
  listConnections: () => ipcRenderer.invoke("connections:list"),
  saveConnection: (input) => ipcRenderer.invoke("connections:save", input),
  removeConnection: (id) => ipcRenderer.invoke("connections:remove", id),
  previewConnection: (id) => ipcRenderer.invoke("connections:preview", id),
  loginConnection: (id) => ipcRenderer.invoke("connections:login", id),
  getAIConfig: () => ipcRenderer.invoke("ai:config"),
  saveAIConfig: (input) => ipcRenderer.invoke("ai:save", input),
  listAIModels: (input) => ipcRenderer.invoke("ai:models", input),
  listCachedAIModels: () => ipcRenderer.invoke("ai:models-cached"),
  probeAI: () => ipcRenderer.invoke("ai:probe"),
  testAIChat: (stage) => ipcRenderer.invoke("ai:test-chat", stage),
  askAI: (input) => ipcRenderer.invoke("ai:ask", input),
  cancelAI: () => ipcRenderer.invoke("ai:cancel"),
  getAIHistory: () => ipcRenderer.invoke("ai:history"),
  chooseCodex: () => ipcRenderer.invoke("ai:choose-codex"),
  runAISandbox: () => ipcRenderer.invoke("ai:sandbox"),
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DeskState): void => callback(state)
    ipcRenderer.on("state", listener)
    return () => ipcRenderer.removeListener("state", listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("desk", desk)
}
