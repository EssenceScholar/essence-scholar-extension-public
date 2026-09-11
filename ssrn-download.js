// ssrn-download.js — press "Download This Paper" for the reader, on a paper they asked for.
//
// The server is never allowed to fetch from SSRN (Cloudflare refuses machines in
// ~2.5s), so a paper asked for in the app, the chat or an MCP client is PARKED and
// the reader's own browser has to do the download. Until 1.9.10 that meant two
// clicks nobody asked for: open the page, press Download. Owner, 2026-09-11: "it
// should be able to open in browser click download and then the extention will
// digest". The MCP (or the app) now opens the page; this script presses the button.
//
// It does NOTHING on its own. On an SSRN abstract page it asks the service worker
// one question — "did the reader ask for this paper?" — and only a paper that is
// armed in the app or waiting in the reader's download queue on the backend is
// touched (background.js `_attendedDownloadFor`). The click is the same anchor
// the reader would press; the file goes through the download manager, where the
// existing capture (armed, so no second consent) imports it. An un-asked SSRN page
// is never clicked, never read, never sent.
(function essenceScholarSsrnDownload() {
  const HOST_RX = /(^|\.)ssrn\.com$/i;
  if (!HOST_RX.test(location.hostname)) return;
  const m = location.href.match(/[?&]abstract_?id=(\d+)/i) || location.href.match(/\/abstract=(\d+)/i);
  if (!m) return;                                   // a listing, not a paper
  const ssrnId = m[1];
  const ONCE_KEY = 'essence-scholar-attended-' + ssrnId;
  const LINK_WAIT_MS = 15000;
  const POLL_MS = 400;

  const ask = (msg) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
    } catch (_) { resolve(null); }
  });

  // Cloudflare's interstitial, seen from inside the page: only the reader can
  // answer it, and the page reloads and runs this script again afterwards.
  const isChallenge = () =>
    Boolean(document.getElementById('challenge-form')
      || document.querySelector('#challenge-running, .cf-browser-verification')
      || /just a moment|checking your browser/i.test(document.title || ''));

  /** SSRN's own download anchor: a Delivery.cfm link, preferably the one that
   *  says "Download This Paper" (the other opens the PDF in the browser). */
  function downloadLink() {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const delivery = links.filter(a => /Delivery\.cfm/i.test(a.getAttribute('href') || ''));
    return delivery.find(a => /download\s+this\s+paper/i.test(a.textContent || ''))
      || delivery[0]
      || links.find(a => /download\s+this\s+paper/i.test(a.textContent || ''))
      || null;
  }

  function waitFor(fn, ms) {
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - started > ms) return resolve(null);
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  (async () => {
    const armed = await ask({ action: 'attendedDownloadFor', url: location.href, ssrn_id: ssrnId });
    if (!armed || !armed.armed) return;
    if (isChallenge()) {
      await ask({ action: 'attendedDownloadStatus', ssrn_id: ssrnId, phase: 'challenge' });
      return;
    }
    // One press per page load — a reload after the download must not download again.
    let pressed = null;
    try { pressed = sessionStorage.getItem(ONCE_KEY); } catch (_) { /* storage off */ }
    if (pressed) return;
    const link = await waitFor(downloadLink, LINK_WAIT_MS);
    if (!link) {
      await ask({ action: 'attendedDownloadStatus', ssrn_id: ssrnId, phase: 'no-link' });
      return;
    }
    try { sessionStorage.setItem(ONCE_KEY, String(Date.now())); } catch (_) { /* fine */ }
    // Same-tab navigation, never `a.click()` on a target=_blank anchor: a scripted
    // popup is blocked without a user gesture, a scripted navigation is not, and
    // Delivery.cfm answers with Content-Disposition: attachment, so the page stays
    // and the file lands in the download manager with this page as its referrer —
    // which is what the capture matches the armed record on.
    const href = link.href;
    await ask({ action: 'attendedDownloadStatus', ssrn_id: ssrnId, phase: 'clicked', href });
    location.assign(href);
  })();
})();
