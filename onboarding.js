document.addEventListener('DOMContentLoaded', async () => {
  const keyInput      = document.getElementById('api-key-input');
  const saveBtn       = document.getElementById('save-btn');
  const statusMsg     = document.getElementById('status-msg');
  const existingRow   = document.getElementById('existing-key-row');
  const existingMask  = document.getElementById('existing-key-masked');
  const removeBtn     = document.getElementById('remove-key-btn');

  // ── Load existing key ──────────────────────────────────────────
  async function getStoredKey() {
    const a = await chrome.storage.local.get(['essenceScholarApiKey']);
    if (a.essenceScholarApiKey) return a.essenceScholarApiKey;
    const b = await chrome.storage.sync.get(['essence_scholar_api_key']);
    return b.essence_scholar_api_key || null;
  }

  function mask(key) {
    if (!key || key.length < 8) return '••••••••';
    return key.slice(0, 8) + '••••••••' + key.slice(-4);
  }

  const existing = await getStoredKey();
  if (existing) {
    existingRow.style.display = 'flex';
    existingMask.textContent = mask(existing);
    saveBtn.textContent = 'Update Key';
  }

  // ── Input validation ───────────────────────────────────────────
  keyInput.addEventListener('input', () => {
    saveBtn.disabled = !keyInput.value.trim();
    clearStatus();
  });

  // ── Remove key ─────────────────────────────────────────────────
  removeBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['essenceScholarApiKey']);
    await chrome.storage.sync.remove(['essence_scholar_api_key']);
    existingRow.style.display = 'none';
    existingMask.textContent = '';
    saveBtn.textContent = 'Connect Account';
    showStatus('Key removed. Enter a new key below.', 'error');
  });

  // ── Save ───────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) return;

    saveBtn.disabled = true;
    showStatus('Connecting…', 'loading');

    const valid = await testKey(key);
    if (!valid) {
      saveBtn.disabled = false;
      showStatus('Could not verify this key. Please check it and try again.', 'error');
      return;
    }

    await chrome.storage.local.set({
      essenceScholarApiKey: key,
      onboardingCompleted: true,
    });
    await chrome.storage.sync.set({ essence_scholar_api_key: key });

    existingRow.style.display = 'flex';
    existingMask.textContent = mask(key);
    keyInput.value = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Update Key';
    showStatus('Account connected! You can now import PDFs.', 'success');
  });

  // ── Key validation ─────────────────────────────────────────────
  async function testKey(key) {
    try {
      const backend = typeof BackendManager !== 'undefined'
        ? BackendManager.getPriorityOneBackend()
        : null;
      const baseUrl = backend?.url || 'https://ssrn-summarizer-backend-v1-8-0-pisqy7uvxq-uc.a.run.app';

      const res = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (_) {
      // Network error — allow save anyway (backend may be cold-starting)
      return true;
    }
  }

  // ── Status helpers ─────────────────────────────────────────────
  function showStatus(msg, type) {
    statusMsg.className = 'status-msg ' + type;
    if (type === 'loading') {
      statusMsg.innerHTML = `<div class="spinner"></div>${msg}`;
    } else {
      statusMsg.textContent = msg;
    }
  }

  function clearStatus() {
    statusMsg.className = 'status-msg';
    statusMsg.textContent = '';
  }
});
