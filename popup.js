document.addEventListener('DOMContentLoaded', async () => {
  const WEB_APP = 'https://essencescholar.com';
  const IMPORT_TIMEOUT_MS = 30000;
  let currentPaperId = null;

  // ── State machine ──────────────────────────────────────────────
  const stateEls = {
    connect:   document.getElementById('state-connect'),
    pdf:       document.getElementById('state-pdf'),
    importing: document.getElementById('state-importing'),
    done:      document.getElementById('state-done'),
    noPdf:     document.getElementById('state-no-pdf'),
    error:     document.getElementById('state-error'),
  };

  function show(name) {
    Object.values(stateEls).forEach(el => el.classList.remove('active'));
    stateEls[name].classList.add('active');
  }

  // ── Auth helpers ───────────────────────────────────────────────
  async function getApiKey() {
    const a = await chrome.storage.local.get(['essenceScholarApiKey']);
    if (a.essenceScholarApiKey) return a.essenceScholarApiKey;
    const b = await chrome.storage.sync.get(['essence_scholar_api_key']);
    return b.essence_scholar_api_key || null;
  }

  // ── PDF detection ──────────────────────────────────────────────
  function looksLikePdf(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return lower.endsWith('.pdf') || lower.includes('/pdf/') ||
           lower.includes('application%2Fpdf') || lower.includes('content-type=pdf');
  }

  async function getPdfStatus(tabId) {
    try {
      return await chrome.runtime.sendMessage({ action: 'checkPDFStatus', tabId });
    } catch (_) {
      return { isPDF: false };
    }
  }

  function displayName(url) {
    try {
      const decoded = decodeURIComponent(url);
      const name = decoded.split('/').pop().split('?')[0] || decoded;
      return name.length > 52 ? '…' + name.slice(-49) : name;
    } catch (_) {
      return url.length > 52 ? '…' + url.slice(-49) : url;
    }
  }

  // ── Import ─────────────────────────────────────────────────────
  async function triggerImport(tab) {
    show('importing');

    // Re-signal the content script (noop if alreadySent; covers manual/file:// case)
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'pdfDetected',
        details: { url: tab.url, method: 'manual' }
      });
    } catch (_) {
      // Content script might not be injected yet on file:// or viewer pages — that's ok,
      // background.js already sent pdfDetected on navigation. We just wait below.
    }

    // Wait for background to confirm the PDF is ready
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Import timed out. The PDF may already be in your library.')),
        IMPORT_TIMEOUT_MS
      );

      function listener(msg) {
        if (msg.action === 'pdfReady' && msg.tabId === tab.id) {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          currentPaperId = msg.paperId || null;
          resolve();
        }
      }
      chrome.runtime.onMessage.addListener(listener);
    });

    show('done');
  }

  // ── Open web app ───────────────────────────────────────────────
  function openApp() {
    const url = currentPaperId
      ? `${WEB_APP}/app?paperID=${encodeURIComponent(currentPaperId)}`
      : `${WEB_APP}/app`;
    chrome.tabs.create({ url });
  }

  document.getElementById('open-app-from-pdf').addEventListener('click', openApp);
  document.getElementById('open-app-no-pdf').addEventListener('click', openApp);
  document.getElementById('open-app-error').addEventListener('click', openApp);
  document.getElementById('view-btn').addEventListener('click', openApp);
  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });

  // ── Connect flow ───────────────────────────────────────────────
  const keyInput   = document.getElementById('api-key-input');
  const connectBtn = document.getElementById('connect-btn');

  keyInput.addEventListener('input', () => {
    connectBtn.disabled = !keyInput.value.trim();
  });

  connectBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) return;
    await chrome.storage.local.set({ essenceScholarApiKey: key });
    await chrome.storage.sync.set({ essence_scholar_api_key: key });
    await init();
  });

  // ── Main init ──────────────────────────────────────────────────
  async function init() {
    const apiKey = await getApiKey();
    if (!apiKey) { show('connect'); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { show('noPdf'); return; }

    const bgStatus = await getPdfStatus(tab.id);

    if (bgStatus.isPDF) {
      // Background confirmed PDF via content-type headers
      if (bgStatus.pdfReady) {
        currentPaperId = bgStatus.paperId || null;
        show('done');
      } else {
        // Auto-import is in progress; show PDF state so user can also trigger manually
        show('pdf');
        document.getElementById('pdf-filename').textContent = displayName(bgStatus.url || tab.url);
        document.getElementById('import-btn').onclick = () =>
          triggerImport(tab).catch(err => {
            document.getElementById('error-message').textContent = err.message;
            show('error');
          });

        // Also listen in case background finishes while popup is open
        chrome.runtime.onMessage.addListener(function autoListener(msg) {
          if (msg.action === 'pdfReady' && msg.tabId === tab.id) {
            currentPaperId = msg.paperId || null;
            chrome.runtime.onMessage.removeListener(autoListener);
            show('done');
          }
        });
      }
    } else if (looksLikePdf(tab.url)) {
      // URL heuristic — background may have missed it (e.g. after service-worker restart)
      show('pdf');
      document.getElementById('pdf-filename').textContent = displayName(tab.url);
      document.getElementById('import-btn').onclick = () =>
        triggerImport(tab).catch(err => {
          document.getElementById('error-message').textContent = err.message;
          show('error');
        });
    } else {
      show('noPdf');
    }
  }

  // Retry button re-runs init
  document.getElementById('retry-btn').addEventListener('click', init);

  await init();
});
