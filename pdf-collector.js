/* global chrome */

// PDF Collector Content Script
// This script runs on all pages and handles PDF detection and content extraction
// when signaled by the background script after network-layer PDF detection

let alreadySent = false;

/** Listen for the background signal */
chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg.action !== 'pdfDetected') return;

  // ONLY proceed if this is a manual trigger from the popup/user
  // We ignore the automatic 'webRequest' signal from background.js to prevent auto-digestion
  if (msg.details?.method !== 'manual' && !msg.force) {
    console.info('[PDF-collector] PDF detected. Auto-digestion is DISABLED. Waiting for manual trigger (click "Import" in the popup).');
    return;
  }

  if (alreadySent) {
    console.log('[PDF-collector] PDF already collected/sent for this session');
    return;
  }
  
  alreadySent = true;
  console.log('[PDF-collector] Manual PDF trigger received, starting collection process');

  try {
    const payload = await grabPDF();
    const paperId = await sendToBackend(payload);

    chrome.runtime.sendMessage({
      status: 'ready',
      paperId,
      pdf: { ...payload, url: location.href }
    });

    console.log('[PDF-collector] PDF ready, paper_id:', paperId);
  } catch (err) {
    // Reset alreadySent so the user can retry
    alreadySent = false;
    
    console.warn('[PDF-collector] Content script could not collect PDF bytes:', err.message);

    // Fallback: send the URL to the background script and let IT try to fetch the bytes.
    // This is often more successful for file:// URLs as the background has broader permissions.
    const url = location.href;
    try {
      const paperId = await sendToBackend({ url });

      chrome.runtime.sendMessage({
        status: 'ready',
        paperId,
        pdf: { url, fallback: true, source: 'background_fetch_fallback' }
      });
      console.log('[PDF-collector] PDF ready via background fetch, paper_id:', paperId);
    } catch (bgErr) {
      console.error('[PDF-collector] Background fetch fallback also failed:', bgErr.message);
      chrome.runtime.sendMessage({
        action: 'analysisError',
        tabId: -1,
        error: bgErr.message
      });
    }
  }
});

/* ---- PDF Collection Helpers ---- */

async function grabPDF() {
  const url = location.href;

  // blob: document — fetch directly
  if (location.protocol === 'blob:') return fetchBytes(url);

  // file:// — Chrome PDF viewer doesn't expose a blob URL to content scripts;
  if (location.protocol === 'file:') {
    try {
      // Try XHR first (traditionally more successful for file:// in content scripts)
      return await fetchBytesXHR(url);
    } catch (xhrErr) {
      console.log('[PDF-collector] XHR failed for local file, trying fetch()...');
      try {
        // Fallback to fetch()
        return await fetchBytes(url);
      } catch (fetchErr) {
        throw new Error(`Local file access denied. Please ensure "Allow access to file URLs" is enabled in chrome://extensions and RELOAD this page.`);
      }
    }
  }

  // https:// — wait for Chrome's built-in PDF viewer to expose a blob: embed URL
  const blobSrc = await new Promise(resolve => {
    const found = [...document.querySelectorAll('embed,object')]
      .find(el => el.src?.startsWith('blob:'));
    if (found) return resolve(found.src);

    const mo = new MutationObserver(muts => {
      const el = muts.flatMap(m => [...m.addedNodes])
        .find(n => n.src?.startsWith('blob:'));
      if (el) { mo.disconnect(); resolve(el.src); }
    });
    mo.observe(document, { childList: true, subtree: true });
    setTimeout(() => { mo.disconnect(); resolve(null); }, 3000);
  });

  if (blobSrc) return fetchBytes(blobSrc);

  // same-origin fallback
  if (new URL(url).origin === location.origin) return fetchBytes(url);

  throw new Error('CORS blocked or cross-origin, cannot fetch PDF bytes');
}

/** Fetch → Uint8Array → SHA-256 */
async function fetchBytes(url) {
  console.log('[PDF-collector] Fetching bytes from:', url);
  
  const res = await fetch(url, {credentials: 'include'});
  if (!res.ok || res.type === 'opaque') {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText} (type: ${res.type})`);
  }
  
  const buf = await res.arrayBuffer();
  console.log('[PDF-collector] Fetched', buf.byteLength, 'bytes');
  
  const hash = await sha256(buf);
  return {bytes: buf, hash, url};
}

/** XHR-based fetch for file:// URLs (fetch() blocks file:// in content scripts, XHR does not) */
async function fetchBytesXHR(url) {
  console.log('[PDF-collector] Reading local file via XHR:', url);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = async () => {
      // file:// responses return status 0 on success
      if (xhr.status === 0 || xhr.status === 200) {
        const buf = xhr.response;
        console.log('[PDF-collector] XHR read', buf.byteLength, 'bytes');
        const hash = await sha256(buf);
        resolve({bytes: buf, hash, url});
      } else {
        reject(new Error(`XHR failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error(
      'XHR error reading local file — enable "Allow access to file URLs" for Essence Scholar in chrome://extensions'
    ));
    xhr.send();
  });
}

/** Simple streaming SHA-256 (first 64 kB is plenty) */
async function sha256(input) {
  const data = input instanceof ArrayBuffer ? input.slice(0, 65536)
                                            : new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Ingest PDF — returns paper_id or null.
 *  Delegates network request to background script to bypass CSP/CORS.
 */
async function sendToBackend({bytes, url}) {
  return new Promise((resolve, reject) => {
    console.log('[PDF-collector] Sending ingest request to background script');
    
    let b64 = null;
    if (bytes) {
      try {
        b64 = arrayBufferToBase64(bytes);
      } catch (e) {
        console.error('[PDF-collector] Base64 conversion failed:', e);
      }
    }

    chrome.runtime.sendMessage({
      action: 'proxyAnalyzeStream',
      file_content: b64,
      url: url,
      source: 'browser_extension_collector'
    }, response => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error('[PDF-collector] Message error:', error.message);
        resolve(null);
      } else if (response && response.success) {
        resolve(response.paperId);
      } else {
        const errorMsg = response?.error || 'Unknown background error';
        console.warn('[PDF-collector] Background ingestion failed:', errorMsg);
        resolve(null);
      }
    });
  });
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Also expose a simple ping handler for compatibility
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ status: 'ok', type: 'pdf-collector' });
    return true;
  }
});

console.log('[PDF-collector] Content script loaded on:', location.href);
