"""USB sticks and rekordbox: export, check, play history, and importing from rekordbox."""
from __future__ import annotations

import shutil
from pathlib import Path

from .. import desktop, rbstick, rbxml
from ..export import stick, usb
from . import route


class SticksRoutes:
    @route("GET", "drives")
    def get_drives(self, _):
        return [{**d, "library": (Path(d["path"]) / "PIONEER" / "rekordbox" / "export.pdb").is_file()} for d in usb.drives()]

    @route("POST", "export")
    def post_export(self, body):
        opts = usb.Options(profile=body.get("profile", "cdj3000"), level=bool(body.get("level", False)))
        self.lib.set("profile", opts.profile)
        self.lib.set("level", int(opts.level))
        self.jobs.export(body.get("paths") or body["path"], body.get("nodes"), bool(body.get("everything")), opts,
                         bool(body.get("replace")))
        return {}

    @route("POST", "export/estimate")
    def post_export_estimate(self, body):
        """Per stick: what the export would add, the space it needs, the time it takes, and the
        playlists already on it (to tick them again)."""
        out = {}
        for root in body.get("paths", []):
            p = Path(root)
            if not p.is_dir():
                continue
            keep = None if body.get("replace") else usb.layout(p)
            tracks = self.lib.export_payload(body.get("nodes"), bool(body.get("everything")), keep)[0]
            out[root] = {**usb.estimate(p, tracks, body.get("profile", "cdj3000")),
                         "on_stick": [n["id"] for n in keep["playlists"]] if keep else []}
        return out

    @route("POST", "stick/eject")
    def post_stick_eject(self, body):
        return {"ejected": desktop.eject(body["path"])}

    @route("POST", "stick/copy")
    def post_stick_copy(self, body):
        self.jobs.copy_stick(body["from"], body["to"])
        return {}

    @route("GET", "onstick")
    def get_stick_tracks(self, _):
        """Crate track ids on every stick plugged in, to mark them in the library."""
        ids: set[int] = set()
        for d in usb.drives():
            ids |= {int(i) for i in usb.manifest(Path(d["path"]))["tracks"]}
        return sorted(ids)

    @route("GET", "stick")
    def get_stick(self, q):
        """A stick's playlists and tracks; `managed` when Crate wrote it and can change it."""
        root = Path(q["path"][0])
        try:
            found = stick.contents(root)
        except ValueError as e:
            return {"error": str(e)}
        u = shutil.disk_usage(root)
        managed = usb.layout(root) is not None
        return {**found, "managed": managed, "older": not managed and (root / usb.MANIFEST).is_file()
                and not any((root / "PIONEER" / "rekordbox").glob("exportLibrary.db*")), "free": u.free, "total": u.total}

    @route("POST", "stick/remove")
    def post_stick_remove(self, body):
        s = self.lib.settings()
        opts = usb.Options(profile=s["profile"], level=s["level"] != "0")
        self.jobs.update_stick(body["path"], [int(i) for i in body.get("playlists", [])], [int(i) for i in body.get("tracks", [])], opts,
                               body.get("within"))
        return {}

    @route("POST", "stick/check")
    def post_stick_check(self, body):
        self.jobs.check_stick(body["path"])
        return {}

    @route("POST", "history")
    def post_history(self, body):
        self.jobs.import_history(body["path"])
        return {}

    @route("POST", "import/stick")
    def post_import_stick(self, body):
        self.pro("import")
        root = body["path"]
        dest = body.get("dest") or str(Path.home() / "Music" / "Crate" / "From rekordbox")

        def run(report):
            res = rbstick.import_stick(self.lib, root, dest, report)
            self.jobs._analyse(res.pop("ids"))
            return {**res, "dest": dest}
        self.jobs.run("Importing rekordbox stick", run)
        return {"dest": dest}

    @route("POST", "import/rekordbox")
    def post_import_rekordbox(self, body):
        self.pro("import")
        path = body.get("path") or desktop.pick("xml")
        if not path:
            return {"cancelled": True}

        def run(report):
            res = rbxml.import_xml(self.lib, path, report)
            self.jobs._analyse(res.pop("ids"))
            return res
        self.jobs.run("Importing rekordbox", run)
        return {"path": path}
