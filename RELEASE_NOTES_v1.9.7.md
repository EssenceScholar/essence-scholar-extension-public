# Essence Scholar 1.9.7

The live Chrome Web Store version is **1.9.3**, so this is what users actually
receive. 1.9.4–1.9.6 were built but never published.

## New: read SSRN eJournal listings in your own browser

SSRN refuses our servers. Measured 2026-09-05 against the live site, every
eJournal listing fetch from the backend was blocked by Cloudflare in ~2.5s, so
"Browse eJournals" and every newsletter scan had nothing to show. Your browser
is not blocked.

Press **Read it in my browser** in the app and the extension opens the journal's
SSRN page, waits for the listing, and hands the page to the backend — which runs
the same parser the blocked server fetch used, so the two paths cannot drift.

- Only a page **you** asked for is ever read. `ssrn-browse.js` asks the service
  worker "was this page armed?" and does nothing otherwise: un-armed SSRN
  browsing is never read, never sent, never logged. Arming expires after 30 min
  and is matched on the journal id.
- A Cloudflare check you have to click is reported as a challenge and your tab
  is brought forward. A page that loaded with no listing on it is reported as a
  timeout — you are not sent looking for a human check that isn't on screen.
- Scripts, styles and SVG are stripped before the page is sent (about a third of
  the bytes, none of which the parser reads).

## Fixed: the popup said "No PDF on This Page" on every landing page

Broken since 1.6.1, in every published build including the live 1.9.3.

`pdf-collector.js` (a declared content script on every page) answered the
"is content.js here?" probe, so `content.js` was never injected anywhere. Every
`checkImportableStatus` reached a tab with no listener for it, and the popup fell
through to "No PDF on This Page" on SSRN, arXiv and publisher landing pages —
taking the **Analyze Page Content** and **Download & Import PDF** cards with it,
and the download-first steer for unstable sources added in 1.9.3.

The probe is no longer answered by `pdf-collector.js`.

## Fixed: a failed import is no longer silent

Importing a captured download without a connected account returned 401, and the
error was thrown past the code that sets the red `!` badge — a new user clicked
**Import** and saw nothing happen at all. The badge now shows on that path too.

## Package

Smaller and cleaner: 1.9.3 shipped `.gitignore`, `.dropboxignore` and all five
store screenshots *inside* the extension (34 files, 1.52 MiB). 1.9.7 ships the
28 files the extension actually uses.
