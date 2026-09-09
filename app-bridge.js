// app-bridge.js — the ONE script that runs on the Essence Scholar web app.
//
// Declared in the manifest against the app's own origins (content.js is injected
// programmatically on paper pages and never runs here, which is where the first
// version of this bridge was mistakenly put). It is deliberately tiny: a marker
// the app can read synchronously, and two messages.
// =============================================================================
// App handshake — the web app asks for a paper, this hands it to the capture
// =============================================================================
//
// SSRN sits behind Cloudflare, so the SERVER cannot fetch most papers: measured
// 2026-09-05 on four SSRN hits, three failed outright after ~60-80s and the one
// that "succeeded" imported the 2-page cover sheet as if it were the paper. The
// person's own browser has no such problem — they are logged in and clicking
// Download like anyone else — and this extension already captures that download.
//
// What was missing is the join: the app had no way to know the extension is
// here, and the capture had no way to know that THIS download is the one the
// reader just asked for. Two messages over `window.postMessage`, on the app's
// own pages only:
//
//   app  → extension   { type: 'arm-capture', ssrn_id, title, doi }
//   extension → app    { type: 'armed' | 'extension-here', version }
//
// and the marker attribute below, which the app reads synchronously to tell
// "install the extension" from "it is installed and waiting".
//
// CONSENT: arming does NOT widen what is captured. The whitelist still decides
// (capture-sources.js), and an armed record only says "this reader already
// pressed Download & import for THIS paper in the app, so do not ask a second
// time". It matches one paper, expires, and is used once.
(function essenceScholarAppBridge() {
  const APP_HOST_RX = /(^|\.)essencescholar\.com$|essence-scholar-website[\w-]*\.vercel\.app$|^localhost$|^127\.0\.0\.1$/i;
  if (!APP_HOST_RX.test(location.hostname)) return;

  const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  try {
    document.documentElement.setAttribute('data-essence-scholar-extension', version);
  } catch (_) { /* a page that blocks attribute writes still gets the message below */ }

  const say = (payload) => {
    try { window.postMessage({ source: 'essence-scholar-extension', ...payload }, location.origin); }
    catch (_) { /* nothing to do */ }
  };
  say({ type: 'extension-here', version });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'essence-scholar-app') return;
    if (d.type === 'ping') {
      // Installed is not the same as READY: the capture needs the API key the
      // reader pastes during onboarding, SSRN must not have been unticked in
      // settings, and capture must not be switched off. The app asks before it
      // sends anyone to SSRN so it can name whichever half is missing.
      try {
        chrome.runtime.sendMessage({ action: 'captureReadiness' }, (res) => {
          void chrome.runtime.lastError;
          say({ type: 'extension-here', version, ...(res || {}) });
        });
      } catch (_) {
        say({ type: 'extension-here', version });
      }
      return;
    }
    if (d.type === 'browse-ssrn') {
      // "Read these SSRN pages in my browser." The eJournal listing fetch is
      // refused for the server every single time (measured 2026-09-05), so the
      // app hands the pages over here: the extension arms exactly these journals,
      // opens them, and posts each page back to the reader's own backend.
      try {
        chrome.runtime.sendMessage(
          { action: 'armBrowse', targets: Array.isArray(d.targets) ? d.targets : [] },
          (res) => {
            void chrome.runtime.lastError;
            say({ type: 'browse-armed', ...(res || { armed: 0, opened: 0 }) });
          },
        );
      } catch (_) {
        say({ type: 'browse-armed', armed: 0, opened: 0, degraded: true });
      }
      return;
    }
    if (d.type !== 'arm-capture') return;
    try {
      chrome.runtime.sendMessage(
        { action: 'armCapture', ssrn_id: String(d.ssrn_id || ''), title: String(d.title || ''), doi: String(d.doi || '') },
        () => {
          // A dead service worker rejects here; the app falls back to the
          // extension's own ask-notification, which still imports the paper.
          void chrome.runtime.lastError;
          say({ type: 'armed', ssrn_id: String(d.ssrn_id || ''), version });
        },
      );
    } catch (_) {
      say({ type: 'armed', ssrn_id: String(d.ssrn_id || ''), version, degraded: true });
    }
  });

  // Progress from the service worker: which journal was captured, which is stuck
  // behind Cloudflare's "are you human?" check. The app also polls its backend —
  // that is the source of truth — so this only makes the panel move at the
  // moment it happens rather than on the next poll.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.essenceBrowse) say({ type: 'browse-progress', ...msg.essenceBrowse });
    });
  } catch (_) { /* no runtime here: the page keeps polling */ }
})();
