// build/src/preload.js — RBX Infinity preload bridge
//
// Runs in an isolated context with access to Node/Electron APIs, but the
// web app (index.html/app.js) never gets that access directly — only what's
// explicitly exposed here via contextBridge. This is what lets app.js
// safely call window.rbxDesktop.downloads.start(...) etc. while staying a
// normal web page from the browser engine's point of view.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rbxDesktop', {
  isDesktop: true,
  platform: process.platform, // 'win32' | 'darwin' | 'linux'

  downloads: {
    start: (opts) => ipcRenderer.invoke('downloads:start', opts),
    cancel: (uid, contentId) => ipcRenderer.invoke('downloads:cancel', { uid, contentId }),
    delete: (uid, contentId) => ipcRenderer.invoke('downloads:delete', { uid, contentId }),
    list: (uid) => ipcRenderer.invoke('downloads:list', { uid }),
    get: (uid, contentId) => ipcRenderer.invoke('downloads:get', { uid, contentId }),
    getPlaybackUrl: (uid, contentId) => ipcRenderer.invoke('downloads:get-playback-url', { uid, contentId }),
    onProgress: (callback) => {
      ipcRenderer.on('downloads:progress', (event, data) => callback(data));
    },
    onComplete: (callback) => {
      ipcRenderer.on('downloads:complete', (event, data) => callback(data));
    },
    onError: (callback) => {
      ipcRenderer.on('downloads:error', (event, data) => callback(data));
    }
  },

  updates: {
    installNow: () => ipcRenderer.invoke('update:install-now'),
    onAvailable: (callback) => {
      ipcRenderer.on('update:available', (event, data) => callback(data));
    },
    onReady: (callback) => {
      ipcRenderer.on('update:ready', (event, data) => callback(data));
    }
  },

  discord: {
    setActivity: (activity) => ipcRenderer.invoke('discord:set-activity', activity)
  }
});
