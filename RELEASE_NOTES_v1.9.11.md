# Essence Scholar 1.9.11

Includes everything in 1.9.10 (attended downloads — see RELEASE_NOTES_v1.9.9.md
and the 1.9.10 commit).

## Journal PDFs that open in a tab are now offered for import

Until now, capture only ever watched Chrome's **downloads**. That is the whole
story on SSRN, where you press Download and a file appears — and it is why SSRN
has always worked. On a journal it usually is not: you click "View PDF" or
"PDF", the publisher opens the paper **in a new tab**, and Chrome renders it
rather than saving it. No download is created, so nothing fired, and the paper
was on your screen with the extension blind to it.

Two things were missing, and both are fixed.

**The tab is now noticed.** When a tab finishes loading a PDF, it goes through
exactly the same gate a download does: the academic-source whitelist, your
per-source toggles, and your ask / auto / off setting. Nothing is bypassed — this
adds a trigger, not an exception. With the default "ask", you get the same
consent card you already know, worded for what actually happened ("opened in a
tab" rather than "downloaded"). A paper you asked for by name in the app still
imports without a second question.

Detection uses the response's content type first and the URL shape second, so a
link like `/article/download?id=48812` — which looks nothing like a PDF — is
caught by what the server actually sent.

**The paper keeps its identity.** A PDF tab carries the bytes and nothing else:
no DOI, no publisher title, no landing page. SSRN escapes this because its id is
in the URL; `https://…/doi/pdfdirect/10.1111/jofi.13245` often does too, but many
publisher links say nothing at all. The extension now remembers which tab opened
the PDF tab and asks that page — the article page it already understands — for
its DOI and publisher title, and sends those with the import. That is the "cannot
keep track" part of the report.

## A fetched file is now checked to BE a PDF

A paywall answers 200 with a login page; an "epdf" link answers 200 with a
JavaScript reader. Both were previously base64'd and uploaded as though they were
the paper. Bytes fetched from a link are now verified to start with `%PDF` before
anything is sent, and the failure says which it was. (The content script already
made this check on its own candidates; the two places that fetch bytes no longer
disagree about what counts as a PDF.)

## Unchanged

Your capture whitelist, per-source toggles, ask/auto/off setting, and the armed
"Download & import" flow all behave exactly as before. Nothing is uploaded that
you have not agreed to, and switching capture off still switches off everything,
including this.
