const { contextBridge, ipcRenderer } = require('electron');

// nodeIntegration is off and contextIsolation is on in main.js, so the
// renderer (plain HTML/JS, no framework) only ever gets this narrow,
// explicit surface -- it can't reach fs/child_process/etc. directly.
contextBridge.exposeInMainWorld('syncAgent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  checkPython: () => ipcRenderer.invoke('python:check'),
  installDependencies: () => ipcRenderer.invoke('deps:install'),
  start: () => ipcRenderer.invoke('sync:start'),
  stop: () => ipcRenderer.invoke('sync:stop'),
  onLog: (callback) => ipcRenderer.on('sync:log', (_event, line) => callback(line)),
  onStatus: (callback) => ipcRenderer.on('sync:status', (_event, status) => callback(status)),
});
