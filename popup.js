document.addEventListener('DOMContentLoaded', async () => {
  const WEB_APP = 'https://essencescholar.com';
  const IMPORT_TIMEOUT_MS = 60000;
  let currentPaperId = null;
  let detectedMeta = null;   // paper-page detection result (pdfUrl, doi, title, …)

  // ── State machine ──────────────────────────────────────────────
  const stateEls = {
    connect:    document.getElementById('state-connect'),
    pdf:        document.getElementById('state-pdf'),
    importable: document.getElementById('state-importable'),
    importing:  document.getElementById('state-importing'),
    done:       document.getElementById('state-done'),
    noPdf:      document.getElementById('state-no-pdf'),
    error:      document.getElementById('state-error'),
  };

  function show(name) {
    Object.values(stateEls).forEach(el => {
      if (el) el.classList.remove('active');
    });
    if (stateEls[name]) stateEls[name].classList.add('active');
  }

  // ── Auth helpers ───────────────────────────────────────────────
  async function getApiKey() {
    const a = await chrome.storage.local.get(['essenceScholarApiKey']);
    if (a.essenceScholarApiKey) return a.essenceScholarApiKey;
    const b = await chrome.storage.sync.get(['essence_scholar_api_key']);
    return b.essence_scholar_api_key || null;
  }

  // ── Helpers ───────────────────────────────────────────────────
  async function getPdfStatus(tabId) {
    try {
      return await chrome.runtime.sendMessage({ action: 'checkPDFStatus', tabId });
    } catch (_) {
      return { isPDF: false };
    }
  }

  function openApp() {
    console.log('Opening Essence Scholar app. currentPaperId:', currentPaperId);
    
    // Ensure we don't have double slashes if WEB_APP has one
    const baseUrl = WEB_APP.endsWith('/') ? WEB_APP.slice(0, -1) : WEB_APP;
    let url = `${baseUrl}/app/`;
    
    if (currentPaperId) {
      url = `${baseUrl}/app/?paperID=${encodeURIComponent(currentPaperId)}`;
    }
    
    console.log('Redirecting to:', url);
    chrome.tabs.create({ url });
  }

  // ── Detection Helpers ──────────────────────────────────────────
  async function checkTabStatus(tab) {
    // 1. Check background status (header-based)
    const bgStatus = await getPdfStatus(tab.id);
    if (bgStatus.isPDF) return { type: 'pdf', status: bgStatus };

    // 2. Check via Enhanced PDF Handler (content-based)
    try {
      if (window.PDFHandler) {
        const enhancedStatus = await window.PDFHandler.checkIfPDFPage(tab);
        if (enhancedStatus.isPDF) return { type: 'pdf', status: enhancedStatus };
      }
    } catch (e) {
      console.warn('Enhanced PDF check failed:', e);
    }

    // 3. Check for Importable Content
    try {
      // Check if URL is accessible before even trying to inject/message
      if (window.PDFHandler && !window.PDFHandler.isUrlAccessibleForContentScript(tab.url)) {
        console.log('[Popup] URL not accessible for content script injection, skipping importable check.');
        return { type: 'none' };
      }

      if (window.PDFHandler) {
        await window.PDFHandler.ensureContentScriptWithRetry(tab.id);
      }
      
      const importableStatus = await chrome.tabs.sendMessage(tab.id, { action: 'checkImportableStatus' });
      if (importableStatus && importableStatus.isImportable) {
        return { type: 'importable', status: importableStatus };
      }
    } catch (e) {
      // Log as info/debug rather than warning if it's a known restriction
      if (e.message.includes('chrome://') || e.message.includes('restricted')) {
        console.log('Restricted URL info:', e.message);
      } else {
        console.warn('Importable status check failed:', e);
      }
    }

    return { type: 'none' };
  }

  function displayName(url, title) {
    if (title && title !== 'Untitled' && !title.includes('http')) return title;
    try {
      const decoded = decodeURIComponent(url);
      const name = decoded.split('/').pop().split('?')[0] || decoded;
      return name.length > 52 ? '…' + name.slice(-49) : name;
    } catch (_) {
      return url.length > 52 ? '…' + url.slice(-49) : url;
    }
  }

  // ── Import ─────────────────────────────────────────────────────
  async function triggerImport(tab, mode = 'pdf') {
    show('importing');

    if (mode === 'pdf') {
      // Re-signal the content script
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'pdfDetected',
          details: { url: tab.url, method: 'manual' }
        });
      } catch (_) {
        // background.js already sent pdfDetected on navigation. We just wait below.
      }
    } else if (mode === 'paper') {
      // Detected paper landing page. Ask the content script to grab the PDF
      // with the user's session cookies (paywall-friendly); it forwards to the
      // backend, which falls back to resolving/downloading from url/doi/title.
      const meta = detectedMeta || { url: tab.url };
      try {
        if (window.PDFHandler) await window.PDFHandler.ensureContentScriptWithRetry(tab.id);
        await chrome.tabs.sendMessage(tab.id, { action: 'importDetectedPaper', meta });
      } catch (err) {
        console.warn('Content-script paper import failed, deferring to backend:', err);
        await chrome.runtime.sendMessage({
          action: 'proxyAnalyzeStream',
          url: meta.url || tab.url,
          pdf_url: meta.pdfUrl || null,
          doi: meta.doi || null,
          title: meta.citationTitle || null,  // trusted title only, for verification
          tabId: tab.id,
          source: 'popup_paper'
        });
      }
    } else {
      // URL-based import (no local bytes) — the background asks the server to
      // download and ingest the PDF, then broadcasts pdfReady with the tabId.
      try {
        await chrome.runtime.sendMessage({
          action: 'proxyAnalyzeStream',
          url: tab.url,
          tabId: tab.id,
          source: 'popup_url'
        });
      } catch (err) {
        console.error('URL import trigger failed:', err);
      }
    }

    // Wait for background to confirm completion
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Import timed out. The paper may already be in your library.')),
        IMPORT_TIMEOUT_MS
      );

      function listener(msg) {
        if (msg.action === 'pdfReady' && msg.tabId === tab.id) {
          console.log('Received pdfReady message in triggerImport wait loop:', msg);
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          currentPaperId = msg.paperId || null;
          console.log('Updated currentPaperId to:', currentPaperId);
          resolve();
        } else if (msg.action === 'analysisError' && msg.tabId === tab.id) {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error(msg.error || 'Import failed'));
        }
      }
      chrome.runtime.onMessage.addListener(listener);
    });

    show('done');
  }

  // ── Event Listeners ─────────────────────────────────────────────
  document.getElementById('open-app-from-pdf').addEventListener('click', openApp);
  document.getElementById('open-app-from-importable')?.addEventListener('click', openApp);
  document.getElementById('open-app-no-pdf').addEventListener('click', openApp);
  document.getElementById('open-app-error').addEventListener('click', openApp);
  document.getElementById('view-btn').addEventListener('click', openApp);
  
  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });

  document.getElementById('import-page-btn')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) triggerImport(tab, 'paper').catch(err => {
      document.getElementById('error-message').textContent = err.message;
      show('error');
    });
  });

  document.getElementById('analyze-anyway-btn')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) triggerImport(tab, 'url').catch(err => {
      document.getElementById('error-message').textContent = err.message;
      show('error');
    });
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

    const status = await checkTabStatus(tab);
    const bgStatus = status.status || {};

    // Check if already done or in progress
    if (bgStatus.pdfReady) {
      currentPaperId = bgStatus.paperId || null;
      console.log('Init: Paper already ready, currentPaperId:', currentPaperId);
      show('done');
      return;
    }

    if (bgStatus.analysisInProgress) {
      show('importing');
      // Set up listener to transition to done
      chrome.runtime.onMessage.addListener(function autoListener(msg) {
        if (msg.action === 'pdfReady' && msg.tabId === tab.id) {
          console.log('Received pdfReady during in-progress analysis:', msg);
          currentPaperId = msg.paperId || null;
          console.log('Updated currentPaperId to:', currentPaperId);
          chrome.runtime.onMessage.removeListener(autoListener);
          show('done');
        } else if (msg.action === 'analysisError' && msg.tabId === tab.id) {
          chrome.runtime.onMessage.removeListener(autoListener);
          document.getElementById('error-message').textContent = msg.error || 'Import failed';
          show('error');
        }
      });
      return;
    }

    if (status.type === 'pdf') {
      show('pdf');
      document.getElementById('pdf-filename').textContent = displayName(bgStatus.url || tab.url, tab.title);
      document.getElementById('import-btn').onclick = () =>
        triggerImport(tab, 'pdf').catch(err => {
          document.getElementById('error-message').textContent = err.message;
          show('error');
        });

      chrome.runtime.onMessage.addListener(function autoListener(msg) {
        if (msg.action === 'pdfReady' && msg.tabId === tab.id) {
          console.log('Received pdfReady for detected PDF:', msg);
          currentPaperId = msg.paperId || null;
          console.log('Updated currentPaperId to:', currentPaperId);
          chrome.runtime.onMessage.removeListener(autoListener);
          show('done');
        }
      });
    } else if (status.type === 'importable') {
      detectedMeta = status.status || null;
      show('importable');
      document.getElementById('importable-title').textContent = displayName(status.status.url, status.status.title);
      // If a PDF is available for this page, present it as a download/import action.
      const btn = document.getElementById('import-page-btn');
      if (btn) btn.textContent = status.status.pdfAvailable ? '⬇ Download & Import PDF' : 'Analyze Page Content';
    } else {
      show('noPdf');
    }
  }

  // Retry button re-runs init
  document.getElementById('retry-btn').addEventListener('click', init);

  await init();
});
