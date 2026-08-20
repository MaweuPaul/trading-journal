const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Only one copy of this app should run at a time -- a second launch just
// focuses the existing window instead of spawning a second sync.py.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = { apiBase: 'http://localhost:4000/api', syncSecret: '', syncInterval: 60, requireRealAccount: false };

// sync.py + requirements.txt ship as extraResources in a packaged build
// (see package.json "build.extraResources"), but during `npm start` in this
// dev checkout they still live one directory up at the repo root.
const SYNC_PY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'sync.py')
  : path.join(__dirname, '..', 'sync.py');
const REQUIREMENTS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'requirements.txt')
  : path.join(__dirname, '..', 'requirements.txt');

let mainWindow = null;
let tray = null;
let syncProcess = null;
let syncStoppedByUser = true;
let restartAttempts = 0;
let restartTimer = null;
let pythonCommand = null; // resolved once, cached ('python' | 'python3' | full path)

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function appendLog(line) {
  sendToRenderer('sync:log', line);
}

function setStatus(status) {
  sendToRenderer('sync:status', status);
  if (tray) tray.setToolTip(`TradeJournal Sync Agent — ${status}`);
  buildTrayMenu(status);
}

// Try `python` then `python3` once and cache whichever actually reports a
// version -- Windows commonly only has one of these on PATH, and which one
// varies by how Python was installed.
async function resolvePython() {
  if (pythonCommand) return pythonCommand;
  for (const candidate of ['python', 'python3']) {
    const found = await new Promise(resolve => {
      execFile(candidate, ['--version'], (error) => resolve(!error));
    });
    if (found) { pythonCommand = candidate; return candidate; }
  }
  return null;
}

function buildTrayMenu(status) {
  if (!tray) return;
  const running = status === 'running';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show TradeJournal Sync Agent', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: running ? 'Stop Sync' : 'Start Sync', click: () => (running ? stopSync() : startSync()) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

async function startSync() {
  if (syncProcess) return { ok: true };
  const config = loadConfig();
  if (!config.syncSecret) return { ok: false, error: 'Add your sync secret first (from the Accounts page in TradeJournal).' };
  if (!fs.existsSync(SYNC_PY_PATH)) return { ok: false, error: `sync.py not found at ${SYNC_PY_PATH}` };

  const python = await resolvePython();
  if (!python) return { ok: false, error: 'Python was not found on this machine. Install Python 3 from python.org, then try again.' };

  syncStoppedByUser = false;
  restartAttempts = 0;
  setStatus('starting');
  appendLog(`Starting sync.py with ${python}...`);

  syncProcess = spawn(python, ['-u', SYNC_PY_PATH], {
    cwd: path.dirname(SYNC_PY_PATH),
    env: {
      ...process.env,
      API_BASE: config.apiBase,
      SYNC_SECRET: config.syncSecret,
      SYNC_INTERVAL: String(config.syncInterval),
      MT5_REQUIRE_REAL_ACCOUNT: config.requireRealAccount ? 'true' : 'false',
    },
  });

  setStatus('running');

  syncProcess.stdout.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(appendLog));
  syncProcess.stderr.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(appendLog));

  syncProcess.on('exit', (code) => {
    syncProcess = null;
    if (syncStoppedByUser) { setStatus('stopped'); return; }
    appendLog(`sync.py exited unexpectedly (code ${code}).`);
    // Back off increasingly rather than hot-looping a crash (e.g. a broker
    // outage or a config typo would otherwise restart dozens of times a minute).
    restartAttempts += 1;
    const delayMs = Math.min(30000, 2000 * restartAttempts);
    setStatus('restarting');
    appendLog(`Restarting in ${Math.round(delayMs / 1000)}s (attempt ${restartAttempts})...`);
    restartTimer = setTimeout(startSync, delayMs);
  });

  return { ok: true };
}

function stopSync() {
  syncStoppedByUser = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (syncProcess) {
    appendLog('Stopping sync.py...');
    syncProcess.kill();
  } else {
    setStatus('stopped');
  }
  return { ok: true };
}

function installDependencies() {
  return new Promise(async (resolve) => {
    const python = await resolvePython();
    if (!python) { resolve({ ok: false, error: 'Python was not found on this machine.' }); return; }
    appendLog(`Installing Python dependencies from ${REQUIREMENTS_PATH}...`);
    const install = spawn(python, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH]);
    install.stdout.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(appendLog));
    install.stderr.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(appendLog));
    install.on('exit', code => {
      const ok = code === 0;
      appendLog(ok ? 'Dependencies installed.' : `pip install failed (code ${code}).`);
      resolve({ ok });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'TradeJournal Sync Agent',
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window just hides it -- the sync process (if running) keeps
  // going in the tray, the same way a background sync agent should.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  const trayIconPath = path.join(__dirname, 'assets', 'icon.png');
  const trayIcon = fs.existsSync(trayIconPath) ? nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  buildTrayMenu('stopped');

  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:save', (_event, config) => { saveConfig(config); return { ok: true }; });
  ipcMain.handle('python:check', async () => ({ found: Boolean(await resolvePython()), command: pythonCommand }));
  ipcMain.handle('deps:install', () => installDependencies());
  ipcMain.handle('sync:start', () => startSync());
  ipcMain.handle('sync:stop', () => stopSync());
});

app.on('before-quit', () => { app.isQuitting = true; stopSync(); });
app.on('window-all-closed', () => {
  // On macOS apps conventionally stay alive (in the tray) after the last
  // window closes; on Windows/Linux there's no dock icon to reopen from,
  // so only macOS gets that behavior here.
  if (process.platform !== 'darwin') { /* stay running for the tray */ }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else mainWindow?.show(); });
