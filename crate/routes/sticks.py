"""USB sticks and rekordbox: export, check, play history, and importing from rekordbox."""
from __future__ import annotations

from pathlib import Path

from .. import desktop, rbstick, rbxml
from ..export import usb
from . import route


class SticksRoutes:
    @route("GET", "drives")
    def get_drives(self, _):
        return [{**d, "library": (Path(d["path"]) / "PIONEER" / "rekordbox" / "export.pdb").is_file()} for d in usb.drives()]

    @route("POST", "export")
    def post_export(self, body):
        opts = usb.Options(profile=body.get("profile", "cdj3000"), level=bool(body.get("level", True)),
                           menu_tables=bool(body.get("menu_tables", True)), phrases=bool(body.get("phrases", False)))
        self.lib.set("profile", opts.profile)
        self.lib.set("level", int(opts.level))
        self.jobs.export(body.get("paths") or body["path"], body.get("nodes"), bool(body.get("everything")), opts)
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
