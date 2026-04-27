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
 *  With bytes: POST base64 to /analyze-stream (works for file:// and https://).
 *  URL-only fallback: POST to /process-paper-url (https:// only).
 */
async function sendToBackend({bytes, url}) {
  const BACKEND_URL = await getBackendUrl();
  if (!BACKEND_URL) {
    console.warn('[PDF-collector] No backend URL available');
    return null;
  }

  let apiKey = null;
  try {
    const r = await chrome.storage.local.get(['essenceScholarApiKey']);
    apiKey = r.essenceScholarApiKey || null;
    if (!apiKey) {
      const r2 = await chrome.storage.sync.get(['essence_scholar_api_key']);
      apiKey = r2.essence_scholar_api_key || null;
    }
  } catch (_) {}

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // ── Strategy A: upload bytes via /analyze-stream ──────────────────────────
  if (bytes) {
    console.log('[PDF-collector] Uploading bytes via /analyze-stream');
    try {
      const b64 = arrayBufferToBase64(bytes);
      const response = await fetch(`${BACKEND_URL}/analyze-stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          file_content: b64,
          model: 'gemini-2.5-flash-preview-04-17',
          source: 'browser_extension'
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) {
        console.error('[PDF-collector] /analyze-stream failed:', response.status);
        return null;
      }

      const paperId = await parseSseForPaperId(response);
      console.log('[PDF-collector] /analyze-stream paper_id:', paperId);
      return paperId;
    } catch (err) {
      console.error('[PDF-collector] /analyze-stream error:', err.message);
      return null;
    }
  }

  // ── Strategy B: URL-only via /process-paper-url ───────────────────────────
  if (!url || url.startsWith('file://')) {
    console.warn('[PDF-collector] No bytes and no fetchable URL — cannot ingest');
    return null;
  }

  console.log('[PDF-collector] Ingesting URL via /process-paper-url:', url);
  try {
    const response = await fetch(`${BACKEND_URL}/process-paper-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paper_url: url, source: 'browser_extension' }),
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      console.error('[PDF-collector] /process-paper-url failed:', response.status);
      return null;
    }

    const data = await response.json();
    console.log('[PDF-collector] /process-paper-url paper_id:', data.paper_id);
    return data.paper_id || null;
  } catch (err) {
    console.error('[PDF-collector] /process-paper-url error:', err.message);
    return null;
  }
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Read an SSE response stream and return paper_id from the first 'completed' event */
async function parseSseForPaperId(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (event.status === 'completed' && event.paper_id) {
          reader.cancel();
          return event.paper_id;
        }
        if (event.status === 'error') {
          console.error('[PDF-collector] SSE error:', event.message);
          reader.cancel();
          return null;
        }
      } catch (_) {}
    }
  }
  return null;
}

/** Get backend URL — prefers cached choice, falls back to cloud */
async function getBackendUrl() {
  try {
    const result = await chrome.storage.local.get(['currentBackend']);
    if (result.currentBackend?.url) return result.currentBackend.url;
  } catch (_) {}
  return 'https://ssrn-summarizer-backend-v1-8-0-pisqy7uvxq-uc.a.run.app';
}

// Also expose a simple ping handler for compatibility
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ status: 'ok', type: 'pdf-collector' });
    return true;
  }
});

console.log('[PDF-collector] Content script loaded on:', location.href);