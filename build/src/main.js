// build/src/main.js — RBX Infinity Electron main process

const { app, BrowserWindow, ipcMain, protocol, safeStorage, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { DownloadsEngine } = require('./downloads.js');

let mainWindow = null;
let downloadsEngine = null;
let discordClient = null;

// ─── SINGLE INSTANCE ────────────────────────────────────────────────────────
// Without this, launching the app a second time (e.g. double-clicking a
// desktop shortcut while it's already open) spawns a second process that
// fights the first for the same downloads folder.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ─── OFFLINE PLAYBACK PROTOCOL ───────────────────────────────────────────────
// Registers a custom "rbx-offline://" scheme so the renderer's <video> tag
// can request encrypted segments by a stable URL and get back decrypted
// bytes, without ever exposing the raw encryption key or decrypted files
// to disk. Video.js/HLS.js just sees normal HTTP-like responses.
function registerOfflineProtocol() {
  protocol.registerBufferProtocol('rbx-offline', (request, callback) => {
    try {
      // rbx-offline://<uid>/<contentId>/<filename>
      const url = new URL(request.url);
      const uid = url.hostname;
      const [, contentId, filename] = url.pathname.split('/');
      const data = downloadsEngine.readSegment(uid, contentId, filename);
      const mimeType = filename.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t';
      callback({ mimeType, data });
    } catch (e) {
      console.error('[rbx-offline protocol]', e.message);
      callback({ error: -6 /* net::ERR_FILE_NOT_FOUND */ });
    }
  });
}

// ─── WINDOW ───────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#000d1f',
    icon: path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The offline protocol above is registered as privileged (see
      // registerSchemesAsPrivileged below) so it can be fetched by
      // Video.js like any other stream URL, subject to normal web
      // security — it's not a nodeIntegration bypass.
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  mainWindow.removeMenu();

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links (e.g. GitHub releases page) open in the OS browser
    // rather than a second Electron window.
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Must be called before app.whenReady() for a custom scheme to support
// fetch()/XHR and be treated like a normal origin by Video.js's HLS engine.
protocol.registerSchemesAsPrivileged([
  { scheme: 'rbx-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

app.whenReady().then(() => {
  registerOfflineProtocol();
  downloadsEngine = new DownloadsEngine(app.getPath('userData'), safeStorage);
  createWindow();
  setupAutoUpdater();
  setupDiscordRPC();
  setupDownloadsIPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── AUTO UPDATE (GitHub Releases) ───────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', { version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:ready', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater]', err);
  });

  // Check on launch and then every 4 hours — frequent enough to catch
  // releases promptly without hammering the GitHub API on every session.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

ipcMain.handle('update:install-now', () => {
  autoUpdater.quitAndInstall();
});

// ─── DISCORD RICH PRESENCE ───────────────────────────────────────────────────
function setupDiscordRPC() {
  const DISCORD_CLIENT_ID = 'YOUR_DISCORD_APP_ID'; // from Discord Developer Portal
  try {
    const RPC = require('discord-rpc');
    discordClient = new RPC.Client({ transport: 'ipc' });
    discordClient.on('ready', () => {
      discordClient.setActivity({
        details: 'En el menú principal',
        state: 'RBX Infinity',
        largeImageKey: 'rbx_logo',
        largeImageText: 'RBX Infinity',
        startTimestamp: Date.now(),
        instance: false,
      }).catch(() => {});
    });
    discordClient.login({ clientId: DISCORD_CLIENT_ID }).catch(() => {
      // Discord not running or RPC unavailable — non-fatal, app works without it.
      discordClient = null;
    });
  } catch (e) {
    console.warn('[Discord RPC] not available:', e.message);
  }
}

ipcMain.handle('discord:set-activity', (event, activity) => {
  if (!discordClient) return;
  discordClient.setActivity({
    details: activity.details || 'Navegando RBX Infinity',
    state: activity.state || '',
    largeImageKey: 'rbx_logo',
    largeImageText: 'RBX Infinity',
    startTimestamp: Date.now(),
    instance: false,
  }).catch(() => {});
});

// ─── DOWNLOADS IPC ────────────────────────────────────────────────────────────
function setupDownloadsIPC() {
  ipcMain.handle('downloads:start', async (event, opts) => {
    try {
      await downloadsEngine.downloadTitle({
        ...opts,
        onProgress: (pct) => {
          mainWindow?.webContents.send('downloads:progress', { contentId: opts.contentId, pct });
        }
      });
      mainWindow?.webContents.send('downloads:complete', { contentId: opts.contentId });
      return { success: true };
    } catch (e) {
      mainWindow?.webContents.send('downloads:error', { contentId: opts.contentId, error: e.message });
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('downloads:cancel', (event, { uid, contentId }) => {
    downloadsEngine.cancelDownload(uid, contentId);
  });

  ipcMain.handle('downloads:delete', (event, { uid, contentId }) => {
    downloadsEngine.deleteDownload(uid, contentId);
  });

  ipcMain.handle('downloads:list', (event, { uid }) => {
    return downloadsEngine.listDownloads(uid);
  });

  ipcMain.handle('downloads:get', (event, { uid, contentId }) => {
    return downloadsEngine.getDownload(uid, contentId);
  });

  // Returns the rbx-offline:// URL the renderer's player should use as its
  // <video> source for a completed download.
  ipcMain.handle('downloads:get-playback-url', (event, { uid, contentId }) => {
    const entry = downloadsEngine.getDownload(uid, contentId);
    if (!entry || entry.status !== 'complete') return null;
    return `rbx-offline://${uid}/${contentId}/local.m3u8`;
  });
}
