/* global chrome */

// PDF Collector Content Script
// This script runs on all pages and handles PDF detection and content extraction
// when signaled by the background script after network-layer PDF detection

let alreadySent = false;

/** Listen for the background "go" signal */
chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg.action !== 'pdfDetected' || alreadySent) return;
  alreadySent = true;

  console.log('[PDF-collector] PDF detected, starting collection process');

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
    console.warn('[PDF-collector] Could not collect PDF bytes, falling back to URL:', err.message);

    const url = location.href;
    const paperId = await sendToBackend({ url });

    chrome.runtime.sendMessage({
      status: 'ready',
      paperId,
      pdf: { url, fallback: true, source: 'url_fallback' }
    });
  }
});

/* ---- PDF Collection Helpers ---- */

async function grabPDF() {
  const url = location.href;

  // blob: document — fetch directly
  if (location.protocol === 'blob:') return fetchBytes(url);

  // file:// — Chrome PDF viewer doesn't expose a blob URL to content scripts;
  // use XHR which works when "Allow access to file URLs" is enabled for the extension
  if (location.protocol === 'file:') return fetchBytesXHR(url);

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
      if (chrome.runtime.lastError) {
        console.error('[PDF-collector] Message error:', chrome.runtime.lastError);
        resolve(null);
      } else if (response && response.success) {
        resolve(response.paperId);
      } else {
        console.warn('[PDF-collector] Background ingestion failed:', response?.error);
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
