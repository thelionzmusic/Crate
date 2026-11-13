"""Following the CDJs over Pro DJ Link, and what to play next."""
from __future__ import annotations

from .. import licence, prolink, setbuilder
from . import route


class LiveRoutes:
    def _link_up(self) -> None:
        """Follow the CDJs while the setting is on (a Pro feature)."""
        want = self.lib.settings().get("prolink") == "1" and licence.status(self._licence())["pro"]
        if want and not (self.link and self.link.running):
            self.link = prolink.Link(on_play=lambda tid, deck, started: self.lib.log_live_play(tid, started)).start()
        elif not want and self.link:
            self.link.stop()
            self.link = None

    @route("GET", "live")
    def get_live(self, _):
        if not licence.status(self._licence())["pro"]:
            return {"running": False, "locked": True, "error": str(licence.ProRequired("live")), "decks": [], "log": [], "devices": []}
        if not self.link:
            return {"running": False, "error": None, "decks": [], "log": [], "devices": []}
        snap = self.link.snapshot()
        ids = {d["track"] for d in snap["decks"]} | {e["track"] for e in snap["log"]}
        rows = {i: self.lib.track(i) for i in ids if i}
        brief = lambda i: {k: rows[i][k] for k in ("id", "title", "artist", "bpm", "key", "camelot", "energy")} if rows.get(i) else None  # noqa: E731
        for d in snap["decks"]:
            d["info"] = brief(d["track"])
        for e in snap["log"]:
            e["info"] = brief(e["track"])
        return snap

    @route("POST", "suggest")
    def post_suggest(self, body):
        """What to play next after a track. With the CDJs followed, tonight's set is left out."""
        self.pro("suggest")
        played = {e["track"] for e in self.link.snapshot()["log"]} if self.link else set()
        tracks = [t for t in self.lib.rows() if t["analysed"] and not t["error"]]
        return setbuilder.suggest(tracks, int(body["id"]), int(body.get("n", 12)), played)

    @route("POST", "set")
    def post_set(self, body):
        """Build a set and save it as a playlist."""
        self.pro("setbuilder")
        pool = None
        if body.get("pool"):
            pool = set(next((n["tracks"] for n in self.lib.nodes() if n["id"] == int(body["pool"])), []))
        tracks = [t for t in self.lib.rows() if t["analysed"] and not t["error"] and (pool is None or t["id"] in pool)]
        ids = setbuilder.build(tracks, int(body["start"]), int(body.get("length", 20)), body.get("arc", "warmup"))
        name = body.get("name") or "New set"
        nid = self.lib.create_node(name, self.lib.folder("Sets"))
        self.lib.set_node_tracks(nid, ids)
        return {"id": nid, "tracks": ids}
