# Essence Scholar 1.9.9

Includes everything in 1.9.8 (library routes — see RELEASE_NOTES_v1.9.8.md).

## NBER downloads now go through your browser, not our server

NBER caps how many PDFs one reader may download. A server-side fetch either trips
that cap or spends your allowance from an address you cannot see — the same reason
SSRN has never been fetched server-side.

nber.org is now marked as an unstable server fetch, which is the flag that makes
the popup steer you to download the paper yourself and import the file. nber.org
was already on the capture whitelist; only this flag was missing, so the capture
worked but nothing pointed you at it.

The app side of the same change: nber.org used to be *preferred* in the
downloader's candidate ranking (scored +30, above every publisher and just under
arXiv), so when a paper existed both on NBER and in an open repository the server
deliberately chose the one host it should have avoided. It is now penalised, and an
NBER-only paper is parked for your browser instead.

## No other changes

The injection-probe fix described in the commit history shipped in 1.9.8; it is
listed here only because it was committed late.
