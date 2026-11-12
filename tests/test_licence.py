"""Crate Pro accounts: invite, sign in, revoke, offline grace, and Pro gating on the server.
GitHub is replaced by an in-memory licences.json."""
import json
import sys
import tempfile
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crate import licence, server  # noqa: E402

ok = True


def check(cond, name, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, detail)
    ok &= bool(cond)


published = {"v": 1, "accounts": {}}
licence.accounts = lambda timeout=8.0: json.loads(json.dumps(published))
licence._write_accounts = lambda token, change, message: change(published["accounts"])

# owner account, as made by hand for Sean
pw = licence.new_password()
published["accounts"][licence.email_id("Owner@Example.com")] = licence._account_entry(pw, "owner")
check("owner@example.com" not in json.dumps(published) and pw not in json.dumps(published), "file holds no email or password")

app = server.App(Path(tempfile.mkdtemp()))
try:
    app.post_suggest({"id": 1})
    check(False, "Pro features are locked when signed out")
except licence.ProRequired as e:
    check(True, "Pro features are locked when signed out", str(e))
check(app.get_live(None).get("locked"), "Live says it's locked")

try:
    app.post_licence_signin({"email": "owner@example.com", "password": "wrong"})
    check(False, "a wrong password is refused")
except ValueError:
    check(True, "a wrong password is refused")
st = app.post_licence_signin({"email": " OWNER@example.com ", "password": pw})
check(st["pro"] and st["owner"], "owner signs in", st)
check("licence" not in app.public_settings() and "gh_token" not in app.public_settings(), "secrets stay out of settings")

try:
    app.post_licence_invite({"email": "tester@example.com"})
    check(False, "inviting needs the token")
except ValueError:
    check(True, "inviting needs the token")
app.post_licence_token({"token": "github_pat_abc"})
opened = []
server._open_external = opened.append
r = app.post_licence_invite({"email": "Tester@Example.com"})
check(r["sent"]["password"] in r["sent"]["body"] and opened and opened[0].startswith("mailto:tester%40example.com"), "invite drafts the email", opened[0][:60])
check(r["invited"][0]["email"] == "tester@example.com", "invite is listed for the owner")

tester = server.App(Path(tempfile.mkdtemp()))
t = tester.post_licence_signin({"email": "tester@example.com", "password": r["sent"]["password"]})
check(t["pro"] and not t["owner"], "tester signs in with the emailed password")
try:
    tester.post_licence_invite({"email": "x@y.z"})
    check(False, "testers can't invite")
except PermissionError:
    check(True, "testers can't invite")

app.post_licence_revoke({"email": "tester@example.com"})
tester._licence_recheck()
check(not tester.get_licence(None)["pro"], "revoked tester loses Pro at the next check")

# offline: the saved licence holds for the grace period
def offline(timeout=8.0):
    raise urllib.error.URLError("no network")
licence.accounts = offline
before = app._licence()
app._licence_recheck()
check(app.get_licence(None)["pro"] and app._licence() == before, "offline keeps Pro")
print("all passed" if ok else "FAILURES")
sys.exit(0 if ok else 1)
