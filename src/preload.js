const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scheduleApp', {
  getProviders: () => ipcRenderer.invoke('providers:get'),
  selectTimetable: () => ipcRenderer.invoke('timetable:select'),
  analyzeTimetable: (config) => ipcRenderer.invoke('timetable:analyze', config),
  generate: (payload) => ipcRenderer.invoke('schedule:generate', payload),
  save: (markdown, suggestedName) => ipcRenderer.invoke('schedule:save', markdown, suggestedName),
});
