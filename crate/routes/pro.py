"""Crate Pro: licences, accounts, tester invites, and the Pro gate."""
from __future__ import annotations

import datetime as dt
import json

from .. import desktop, licence
from . import route


class ProRoutes:
    def _licence(self) -> dict:
        try:
            return json.loads(self.lib.settings().get("licence") or "{}")
        except ValueError:
            return {}

    def _save_licence(self, lic: dict) -> None:
        self.lib.set("licence", json.dumps(lic) if lic else "")

    def _licence_recheck(self) -> None:
        lic = self._licence()
        if lic:
            self._save_licence(licence.recheck(lic))
            self._link_up()

    def pro(self, feature: str) -> None:
        if not licence.status(self._licence())["pro"]:
            raise licence.ProRequired(feature)

    @route("GET", "licence")
    def get_licence(self, _):
        s = self.lib.settings()
        st = licence.status(self._licence())
        if st.get("owner"):
            st["invited"] = json.loads(s.get("invited") or "[]")
            st["has_token"] = bool(s.get("gh_token"))
        st["store_url"] = s.get("store_url", "")
        st["features"] = licence.PRO_FEATURES
        return st

    @route("POST", "licence/signin")
    def post_licence_signin(self, body):
        self._save_licence(licence.sign_in(body["email"], body["password"]))
        self._link_up()
        return self.get_licence(None)

    @route("POST", "licence/key")
    def post_licence_key(self, body):
        self._save_licence(licence.activate_key(body["key"]))
        self._link_up()
        return self.get_licence(None)

    @route("POST", "licence/signout")
    def post_licence_signout(self, _):
        self._save_licence({})
        self._link_up()
        return self.get_licence(None)

    def _owner_token(self) -> str:
        if not licence.status(self._licence()).get("owner"):
            raise PermissionError("Only the owner account can invite testers")
        token = self.lib.settings().get("gh_token", "")
        if not token:
            raise ValueError("Add your GitHub access token first (Settings > Crate Pro)")
        return token

    @route("POST", "licence/invite")
    def post_licence_invite(self, body):
        inv = licence.invite(self._owner_token(), body["email"], "tester")
        invited = [i for i in json.loads(self.lib.settings().get("invited") or "[]") if i["email"] != inv["email"]]
        invited.insert(0, {"email": inv["email"], "date": dt.date.today().isoformat()})
        self.lib.set("invited", json.dumps(invited))
        desktop.open_external(inv["mailto"])  # the invite email, drafted in their mail app, ready to send
        return {**self.get_licence(None), "sent": inv}

    @route("POST", "licence/revoke")
    def post_licence_revoke(self, body):
        licence.revoke(self._owner_token(), body["email"])
        invited = [i if i["email"] != body["email"] else {**i, "revoked": True} for i in json.loads(self.lib.settings().get("invited") or "[]")]
        self.lib.set("invited", json.dumps(invited))
        return self.get_licence(None)

    @route("POST", "licence/token")
    def post_licence_token(self, body):
        token = body.get("token", "").strip()
        if token and not token.startswith(("github_pat_", "ghp_")):
            raise ValueError("That isn't a GitHub access token. They start with github_pat_")
        self.lib.set("gh_token", token)
        return self.get_licence(None)

    @route("POST", "getpro")
    def post_get_pro(self, _):
        url = self.lib.settings().get("store_url", "")
        if not url.startswith("https://"):
            raise ValueError("Crate Pro isn't on sale yet")
        desktop.open_external(url)
        return {}
