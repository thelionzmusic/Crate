"""Crate Pro: who has it, and how they got it.

Three ways in:
* an account (email + password), for you as the owner and the testers you invite. Accounts
  live in licences.json in Crate's GitHub repo, which Crate reads at launch. Emails and
  passwords are only ever stored there as salted hashes, so the file shows nothing.
* a Lemon Squeezy licence key, for people who buy Pro.
Either way Crate keeps working offline for GRACE_DAYS after the last successful check.

Inviting writes to licences.json through GitHub's API, with a token only the owner's copy
of Crate holds, then drafts the invite email for the owner to send.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import secrets
import socket
import urllib.error
import urllib.parse
import urllib.request

REPO = "thelionzmusic/Crate"
ACCOUNTS_URL = f"https://raw.githubusercontent.com/{REPO}/main/licences.json"
CONTENTS_API = f"https://api.github.com/repos/{REPO}/contents/licences.json"
LS_API = "https://api.lemonsqueezy.com/v1/licenses"
DOWNLOAD = f"https://github.com/{REPO}/releases/latest"
GRACE_DAYS = 30
ROUNDS = 200_000
UA = {"User-Agent": "Crate-licence"}
# What Pro unlocks. Kept in one place so it's easy to move a feature either side of the line.
PRO_FEATURES = {"live": "Follow the CDJs and log your sets", "import": "Import from rekordbox",
                "suggest": "What next", "setbuilder": "Set builder"}


class ProRequired(PermissionError):
    def __init__(self, feature: str):
        super().__init__(f"{PRO_FEATURES.get(feature, 'That')} is part of Crate Pro. Sign in or add a licence in Settings")


def email_id(email: str) -> str:
    return hashlib.sha256(("crate:" + email.strip().lower()).encode()).hexdigest()


def hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ROUNDS).hex()


def new_password() -> str:
    """Easy to read out and type: four groups of four, no 0/O or 1/l."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def _get(url: str, timeout: float = 8.0, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def accounts(timeout: float = 8.0) -> dict:
    """The account list as published (cache-busted, since raw.githubusercontent caches for minutes)."""
    try:
        return json.loads(_get(f"{ACCOUNTS_URL}?t={secrets.token_hex(4)}", timeout))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"v": 1, "accounts": {}}
        raise


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def _offline(e: BaseException) -> bool:
    return isinstance(e, (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError)) and not isinstance(e, urllib.error.HTTPError)


# ---- accounts ---------------------------------------------------------------------

def sign_in(email: str, password: str) -> dict:
    """Check an email and password against the published list. Returns the licence to keep."""
    acc = accounts().get("accounts", {}).get(email_id(email))
    if not acc or acc.get("revoked") or not hmac.compare_digest(
            hash_password(password.strip(), bytes.fromhex(acc["salt"])), acc["hash"]):
        raise ValueError("That email and password don't match an invite. Check the email you were invited on")
    return {"kind": "account", "email": email.strip().lower(), "tier": acc.get("tier", "tester"), "checked": _now()}


def _account_entry(password: str, tier: str) -> dict:
    salt = secrets.token_bytes(16)
    return {"salt": salt.hex(), "hash": hash_password(password, salt), "tier": tier, "added": dt.date.today().isoformat()}


def _write_accounts(token: str, change, message: str) -> None:
    """Read licences.json through the API, apply `change` to its accounts, write it back."""
    auth = {"Authorization": f"Bearer {token.strip()}", "Accept": "application/vnd.github+json"}
    try:
        cur = json.loads(_get(CONTENTS_API, headers=auth))
        data, sha = json.loads(base64.b64decode(cur["content"])), cur["sha"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            data, sha = {"v": 1, "accounts": {}}, None
        elif e.code in (401, 403):
            raise ValueError("GitHub didn't accept the access token. Make a new one (Contents: read and write on the Crate repo) in Settings > Crate Pro") from None
        else:
            raise
    change(data.setdefault("accounts", {}))
    body = {"message": message, "content": base64.b64encode((json.dumps(data, indent=1, sort_keys=True) + "\n").encode()).decode()}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(CONTENTS_API, data=json.dumps(body).encode(), method="PUT",
                                 headers={**UA, **auth, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):
            raise ValueError("That GitHub token can't write to the Crate repo. It needs Contents: read and write") from None
        raise


def invite(token: str, email: str, tier: str = "tester") -> dict:
    """Make an account for `email`. Returns its password and a ready-to-send email."""
    email = email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("That doesn't look like an email address")
    password = new_password()
    _write_accounts(token, lambda a: a.__setitem__(email_id(email), _account_entry(password, tier)), f"Invite a Crate {tier}")
    subject = "You're invited to test Crate"
    body = (f"Hey,\n\nYou're in for Crate Pro.\n\n1. Download Crate: {DOWNLOAD}\n   (on Windows run Crate-Setup; on a Mac, unzip Crate-mac and open Crate)\n"
            f"2. Open Settings > Crate Pro and sign in with:\n\n   Email: {email}\n   Password: {password}\n\n"
            "Any problems or ideas, just reply to this.\n")
    mailto = f"mailto:{urllib.parse.quote(email)}?subject={urllib.parse.quote(subject)}&body={urllib.parse.quote(body)}"
    return {"email": email, "password": password, "mailto": mailto, "subject": subject, "body": body}


def revoke(token: str, email: str) -> None:
    def change(a: dict) -> None:
        if email_id(email) in a:
            a[email_id(email)]["revoked"] = True
    _write_accounts(token, change, "Revoke a Crate account")


# ---- Lemon Squeezy ----------------------------------------------------------------

def _ls(action: str, fields: dict) -> dict:
    req = urllib.request.Request(f"{LS_API}/{action}", data=urllib.parse.urlencode(fields).encode(), method="POST",
                                 headers={**UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            raise ValueError(f"The licence server answered with an error ({e.code})") from None


def activate_key(key: str) -> dict:
    r = _ls("activate", {"license_key": key.strip(), "instance_name": socket.gethostname()[:60] or "Crate"})
    if not r.get("activated"):
        raise ValueError(r.get("error") or "That licence key wasn't accepted")
    return {"kind": "key", "key": key.strip(), "instance": r["instance"]["id"], "tier": "pro",
            "email": (r.get("meta") or {}).get("customer_email", ""), "checked": _now()}


# ---- status -----------------------------------------------------------------------

def recheck(lic: dict) -> dict:
    """Confirm a saved licence still stands. Offline keeps it (within the grace period);
    a definite no from the server drops it."""
    try:
        if lic.get("kind") == "account":
            acc = accounts(6).get("accounts", {}).get(email_id(lic["email"]))
            ok = bool(acc) and not acc.get("revoked")
            tier = acc.get("tier", lic.get("tier")) if acc else lic.get("tier")
        elif lic.get("kind") == "key":
            r = _ls("validate", {"license_key": lic["key"], "instance_id": lic["instance"]})
            ok, tier = bool(r.get("valid")), "pro"
        else:
            return {}
    except Exception as e:
        if _offline(e):
            return lic
        return lic  # an unexpected answer is treated like being offline, never as a revoke
    return {**lic, "tier": tier, "checked": _now()} if ok else {}


def status(lic: dict) -> dict:
    if not lic:
        return {"pro": False}
    try:
        age = (dt.datetime.now() - dt.datetime.fromisoformat(lic["checked"])).days
    except (KeyError, ValueError):
        age = GRACE_DAYS + 1
    return {"pro": age <= GRACE_DAYS, "tier": lic.get("tier"), "kind": lic.get("kind"), "email": lic.get("email", ""),
            "owner": lic.get("tier") == "owner" and age <= GRACE_DAYS, "checked": lic.get("checked"),
            "offline_days_left": max(0, GRACE_DAYS - age)}
