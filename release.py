#!/usr/bin/env python3
"""Package and publish the extension to the Chrome Web Store, in one command.

    python3 release.py              # package + verify only; nothing leaves the machine
    python3 release.py --upload     # + upload as a draft, review it in the dashboard
    python3 release.py --publish    # + upload AND submit for review

Why this exists: the dashboard cannot be automated. Chrome refuses to let ANY
extension script chrome.google.com/webstore or chromewebstore.google.com ("The
extensions gallery cannot be scripted") — deliberately, since an extension that
could drive the store could publish or install on your behalf. The Web Store's
own HTTPS API has no such restriction, so this script goes straight to it.

## Packaging is a DENY-list, on purpose

Everything in the directory ships unless it matches EXCLUDE below. The opposite
design — listing what to include, or copying the previous release's file list —
silently drops any file added since, and a manifest that references a missing
file is rejected at upload. So: ship by default, exclude deliberately, and then
VERIFY that every path the manifest names is actually in the archive before the
zip is considered valid.

## Credentials

Read from ~/.config/essencescholar/cws.json (chmod 0600), or the environment:

    CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID

See SETUP-CWS-API.md for how to mint them. They are NOT in this repo and must
never be — `.gitignore` already excludes *.json only incidentally, so keep them
in ~/.config.

Standard library only: a release script that needs `pip install` first is a
release script that fails at the worst moment.
"""
import argparse
import fnmatch
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CRED_PATH = Path(os.environ.get(
    "CWS_CREDENTIALS", Path.home() / ".config" / "essencescholar" / "cws.json"))

# Everything else ships. Add to this list when you add something that must not.
EXCLUDE = [
    ".git/*", ".git", "debug_test/*", "store-screenshots/*", "__pycache__/*",
    "*.zip", "*.backup", "*.bak", "*.md", "*.log", "*.tmp",
    ".gitignore", ".dropboxignore", ".DS_Store", "Thumbs.db",
    "test_*", "*.test.js", "release.py", "node_modules/*",
]

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/chromewebstore/v1.1/items/{item}"
PUBLISH_URL = "https://www.googleapis.com/chromewebstore/v1.1/items/{item}/publish"


def excluded(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel.split("/")[0], pat)
               for pat in EXCLUDE)


def collect() -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel_dir = os.path.relpath(dirpath, ROOT)
        rel_dir = "" if rel_dir == "." else rel_dir
        dirnames[:] = [d for d in dirnames
                       if not excluded(f"{rel_dir}/{d}".lstrip("/"))]
        for f in filenames:
            rel = f"{rel_dir}/{f}".lstrip("/")
            if not excluded(rel):
                out.append(rel)
    return sorted(out)


def manifest_refs(manifest: dict) -> set[str]:
    """Every file path the manifest names. Missing one of these is the single
    most common reason an upload is rejected."""
    blob = json.dumps(manifest)
    return set(re.findall(r"[A-Za-z0-9_./-]+\.(?:js|html|css|png|svg|json)", blob))


def package() -> tuple[Path, str]:
    manifest = json.loads((ROOT / "manifest.json").read_text())
    version = manifest["version"]
    files = collect()

    missing = sorted(manifest_refs(manifest) - set(files))
    if missing:
        sys.exit(f"REFUSING to package: manifest.json references files that would "
                 f"not be in the archive: {missing}\n"
                 f"Either add them, or they are matched by an EXCLUDE pattern.")

    out = ROOT / f"essence-scholar-v{version}.zip"
    if out.exists():
        print(f"  note: overwriting the existing {out.name}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            z.write(ROOT / rel, rel)

    print(f"  packaged {out.name} — {len(files)} files, {out.stat().st_size:,} bytes")
    print(f"  manifest version {version}; every referenced file is present")
    return out, version


def credentials() -> dict:
    cred = {}
    if CRED_PATH.exists():
        cred = json.loads(CRED_PATH.read_text())
    for key in ("client_id", "client_secret", "refresh_token", "item_id"):
        env = os.environ.get(f"CWS_{key.upper()}")
        if env:
            cred[key] = env
    missing = [k for k in ("client_id", "client_secret", "refresh_token", "item_id")
               if not cred.get(k)]
    if missing:
        sys.exit(f"Missing credentials: {missing}\n"
                 f"Put them in {CRED_PATH} (chmod 600) or the environment — "
                 f"see SETUP-CWS-API.md.")
    return cred


def post(url: str, data: bytes | None, headers: dict) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"  HTTP {e.code} from {url}\n  {e.read().decode()[:600]}")
    return json.loads(body) if body.strip() else {}


def access_token(cred: dict) -> str:
    payload = urllib.parse.urlencode({
        "client_id": cred["client_id"],
        "client_secret": cred["client_secret"],
        "refresh_token": cred["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    data = post(TOKEN_URL, payload,
                {"Content-Type": "application/x-www-form-urlencoded"})
    if "access_token" not in data:
        sys.exit(f"  no access_token in the token response: {data}")
    return data["access_token"]


def upload(zip_path: Path, cred: dict, token: str) -> dict:
    req = urllib.request.Request(
        UPLOAD_URL.format(item=cred["item_id"]),
        data=zip_path.read_bytes(),
        headers={"Authorization": f"Bearer {token}", "x-goog-api-version": "2"},
        method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"  upload failed: HTTP {e.code}\n  {e.read().decode()[:600]}")
    state = data.get("uploadState")
    if state != "SUCCESS":
        # FAILURE carries itemError[]; the message is usually exact and actionable.
        sys.exit(f"  uploadState={state}\n  {json.dumps(data, indent=2)[:900]}")
    print(f"  uploaded — uploadState SUCCESS (draft is now in the dashboard)")
    return data


def publish(cred: dict, token: str) -> dict:
    data = post(PUBLISH_URL.format(item=cred["item_id"]), b"",
                {"Authorization": f"Bearer {token}", "x-goog-api-version": "2",
                 "Content-Length": "0"})
    print(f"  publish status: {data.get('status')} — {data.get('statusDetail')}")
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--upload", action="store_true",
                    help="upload the package as a draft")
    ap.add_argument("--publish", action="store_true",
                    help="upload AND submit for review (implies --upload)")
    args = ap.parse_args()

    print("package")
    zip_path, version = package()

    if not (args.upload or args.publish):
        print("\nPackaged only. Add --upload to send it, --publish to submit for review.")
        return 0

    cred = credentials()
    print(f"\nupload  (item {cred['item_id']})")
    token = access_token(cred)
    upload(zip_path, cred, token)

    if args.publish:
        print("\npublish")
        publish(cred, token)
        print(f"\nv{version} submitted for review. Review usually takes a few days; "
              f"a permissions change makes it longer.")
    else:
        print(f"\nv{version} is a DRAFT. Review it in the dashboard, then either hit "
              f"Submit there or re-run with --publish.")
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (only needed in the auth path)
    sys.exit(main())
