const apiBaseInput = document.getElementById('apiBase');
const syncSecretInput = document.getElementById('syncSecret');
const syncIntervalInput = document.getElementById('syncInterval');
const requireRealAccountInput = document.getElementById('requireRealAccount');
const saveBtn = document.getElementById('save-btn');
const saveState = document.getElementById('save-state');
const installBtn = document.getElementById('install-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusPill = document.getElementById('status-pill');
const logEl = document.getElementById('log');
const pythonStatusEl = document.getElementById('python-status');
const secretHelp = document.getElementById('secret-help');
const helpText = document.getElementById('help-text');
const toggleSecretBtn = document.getElementById('toggle-secret');

function appendLog(line) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.textContent += (logEl.textContent ? '\n' : '') + line;
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(status) {
  statusPill.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  statusPill.className = `status-pill ${status}`;
  const running = status === 'running' || status === 'starting' || status === 'restarting';
  startBtn.disabled = running;
  stopBtn.disabled = !running;
}

async function loadConfig() {
  const config = await window.syncAgent.getConfig();
  apiBaseInput.value = config.apiBase || '';
  syncSecretInput.value = config.syncSecret || '';
  syncIntervalInput.value = config.syncInterval || 60;
  requireRealAccountInput.checked = Boolean(config.requireRealAccount);
}

async function saveConfig() {
  const config = {
    apiBase: apiBaseInput.value.trim() || 'http://localhost:4000/api',
    syncSecret: syncSecretInput.value.trim(),
    syncInterval: Math.max(10, Number(syncIntervalInput.value) || 60),
    requireRealAccount: requireRealAccountInput.checked,
  };
  await window.syncAgent.saveConfig(config);
  saveState.textContent = 'Saved';
  setTimeout(() => { saveState.textContent = ''; }, 1800);
}

async function checkPython() {
  const result = await window.syncAgent.checkPython();
  pythonStatusEl.textContent = result.found
    ? `Python detected (${result.command}).`
    : 'Python was not found. Install Python 3 from python.org, then reopen this app.';
  pythonStatusEl.style.color = result.found ? 'var(--green)' : 'var(--red)';
}

saveBtn.addEventListener('click', saveConfig);

installBtn.addEventListener('click', async () => {
  installBtn.disabled = true;
  appendLog('--- Installing dependencies ---');
  const result = await window.syncAgent.installDependencies();
  if (!result.ok && result.error) appendLog(`Error: ${result.error}`);
  installBtn.disabled = false;
});

startBtn.addEventListener('click', async () => {
  await saveConfig();
  appendLog('--- Starting sync ---');
  const result = await window.syncAgent.start();
  if (!result.ok && result.error) appendLog(`Error: ${result.error}`);
});

stopBtn.addEventListener('click', async () => {
  appendLog('--- Stopping sync ---');
  await window.syncAgent.stop();
});

secretHelp.addEventListener('click', (event) => {
  event.preventDefault();
  helpText.classList.toggle('hidden');
});

toggleSecretBtn.addEventListener('click', () => {
  syncSecretInput.type = syncSecretInput.type === 'password' ? 'text' : 'password';
});

window.syncAgent.onLog(appendLog);
window.syncAgent.onStatus(setStatus);

loadConfig();
checkPython();
setStatus('stopped');
