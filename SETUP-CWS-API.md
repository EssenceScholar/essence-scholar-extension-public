# Publishing from the command line

One-time setup, then every release is:

```bash
python3 release.py --publish
```

## Why not just automate the dashboard?

Because Chrome won't allow it. Any extension that tries to script
`chrome.google.com/webstore` or `chromewebstore.google.com` gets
*"The extensions gallery cannot be scripted"* — both hosts, deliberately, so that
an extension can't publish or install things on your behalf. The Web Store's own
HTTPS API carries no such restriction, which is what `release.py` uses.

## What you need

Four values. Three come from the steps below; the fourth is your extension's id.

| | where it comes from |
|---|---|
| `item_id` | the 32-letter id in your item's dashboard URL (`…/detail/`**`abcdefgh…`**) |
| `client_id` | step 2 |
| `client_secret` | step 2 |
| `refresh_token` | step 3 |

## 1. Enable the API

In [Google Cloud Console](https://console.cloud.google.com/), with
**sasi2400@gmail.com** — the account that owns the store listing, not the RUG one:

1. Create a project (or reuse one). Name it anything.
2. **APIs & Services → Library** → search *Chrome Web Store API* → **Enable**.

## 2. Create an OAuth client

1. **APIs & Services → OAuth consent screen**. External, fill the required fields,
   and add **sasi2400@gmail.com** as a test user. It can stay in "Testing" — you
   are the only user, and publishing the consent screen is not needed.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   Application type: **Desktop app**.
3. Copy the **client ID** and **client secret**.

A refresh token from a consent screen left in "Testing" expires after 7 days.
If `release.py` starts reporting `invalid_grant`, that is what happened — either
redo step 3, or set the consent screen to "In production", which stops the
expiry. For a release you cut weekly, production is the saner choice.

## 3. Authorise once, to get a refresh token

**This step has to be you.** It grants an OAuth scope on your Google account, and
that is not something to hand to a script or an assistant.

Open this in the browser signed in as sasi2400@gmail.com, with your client id
substituted:

```
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
```

Approve it, copy the code it shows, then exchange it:

```bash
curl -s -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=THE_CODE" \
     -d "grant_type=authorization_code" \
     -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
     https://oauth2.googleapis.com/token
```

The `refresh_token` in the reply is the durable one. Keep it; the `access_token`
beside it expires in an hour and `release.py` mints its own.

## 4. Store them

```bash
mkdir -p ~/.config/essencescholar
cat > ~/.config/essencescholar/cws.json <<'JSON'
{
  "item_id": "…",
  "client_id": "…",
  "client_secret": "…",
  "refresh_token": "…"
}
JSON
chmod 600 ~/.config/essencescholar/cws.json
```

Outside the repo on purpose. `release.py` also accepts `CWS_ITEM_ID`,
`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` from the environment,
which is what a CI runner would use.

## Releasing

```bash
python3 release.py              # package + verify; nothing leaves the machine
python3 release.py --upload     # + upload as a draft, then review in the dashboard
python3 release.py --publish    # + submit for review
```

Bump `version` in `manifest.json` first — the Web Store rejects a version it has
already seen, which is the most common failure here.

### What the packaging step guarantees

It ships **everything in the directory except** the deny-list at the top of
`release.py` (`.git`, `debug_test/`, `store-screenshots/`, `*.zip`, `*.backup`,
`*.md`, `test_*`, …), and then **refuses to package at all** if `manifest.json`
names a file that would not be in the archive.

That order matters. An include-list — or copying the previous release's file
list — silently drops anything added since, and a manifest pointing at a missing
file is rejected at upload with a message that does not always name it. Shipping
by default and excluding deliberately fails loudly instead, before anything is
sent.

### After a release

Review usually takes a few days. **A permissions change makes it considerably
longer and prompts every existing user to re-consent** — so if a release widens
`host_permissions`, expect that and say so in the release notes.
