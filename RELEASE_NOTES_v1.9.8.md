# Essence Scholar 1.9.8

Includes everything in 1.9.7 (attended SSRN browsing — see RELEASE_NOTES_v1.9.7.md).

## New: library routes — "open via your library" downloads are imported

Settings → Connected access in the app lists your libraries; a paywalled paper is
parked with one "Open via <library>" link per library (LibKey or your library's
proxy). This release makes the download that follows land in your library:

- The app arms the capture with the paper's **DOI** as well as its SSRN id. A
  download whose URL or referrer carries that DOI (Wiley, Springer, OUP…) is
  matched exactly; ScienceDirect downloads carry no DOI, so the one DOI armed in
  the last ten minutes is taken to be it and the backend confirms by title.
- Publisher patterns now accept `-` as well as `.` between host words, because a
  library proxy rewrites `www.sciencedirect.com` to
  `www-sciencedirect-com.proxy-…` — the same PDF is captured on both routes.
- New whitelist entry **Your library (LibKey / proxy links)** for `libkey.io`,
  EZproxy hosts and `/login?url=` pages. Off by unticking it in the settings like
  any other source.
- The import carries the armed DOI and title, so the parked request is resolved
  by DOI rather than by guessing a title out of the PDF.

Nothing changes about consent: an un-armed download from a library route still
asks first (or is imported automatically only if you chose that mode).
