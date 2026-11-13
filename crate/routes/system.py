"""The app itself: updates, backups, problem reports, the audio engine, and window hand-over."""
from __future__ import annotations

import logging
import time
from pathlib import Path

from .. import __version__, desktop, updater, updates
from . import route

UPDATE_EVERY_S = 6 * 3600  # how often a running Crate looks for a new version


class SystemRoutes:
    def _check_updates(self) -> None:
        """At launch, then every few hours while Crate stays open."""
        while True:
            self.update_info = updates.check() or self.update_info
            self.update_checked = time.monotonic()
            time.sleep(UPDATE_EVERY_S)

    @route("GET", "update")
    def get_update(self, _):
        return self.update_info or {}

    # POST --------------------------------------------------------------------
    def post_update(self, blob: bytes):
        if self.jobs.snapshot()["running"]:
            raise ValueError("Wait for the current job to finish, then install the update.")
        self.lib.backup(f"before-{__version__}-update")
        self.engine.stop()  # its exe lives in the folder being replaced
        version = updater.install(blob, self.home)
        self.restart = True  # the launcher restarts Crate once this reply is sent
        return {"version": version}

    @route("POST", "update/check")
    def post_update_check(self, body):
        """Check GitHub now (Settings). quiet (the page settling after launch): reuse a check
        from the last quarter hour, so a launch costs GitHub one request, not two."""
        if body.get("quiet") and time.monotonic() - self.update_checked < 900:
            return {"current": __version__, "update": self.update_info}
        self.update_info = updates.check(strict=not body.get("quiet"))
        self.update_checked = time.monotonic()
        return {"current": __version__, "update": self.update_info}

    @route("POST", "update/fetch")
    def post_update_fetch(self, _):
        info = self.update_info or updates.check()
        if not info or not info.get("update_asset"):
            raise ValueError("No update is available right now.")
        return self.post_update(updates.download(info["update_asset"]))

    @route("GET", "backups")
    def get_backups(self, _):
        return self.lib.backups()

    @route("POST", "backup")
    def post_backup(self, body):
        if body.get("restore"):
            if self.jobs.snapshot()["running"]:
                raise ValueError("Wait for the current job to finish, then restore.")
            self.lib.restore(body["restore"])
            return {"restored": body["restore"]}
        return {"name": self.lib.backup("manual")}

    def _report(self, note: str = "") -> dict:
        """Version, system and the end of crate.log, with your user name taken out of paths."""
        import platform
        log = ""
        for name in ("crate.log", "crate.old.log"):
            f = self.home / name
            if f.is_file():
                log = f.read_text("utf-8", "replace")[-6000:]
                break
        log = log.replace(str(Path.home()), "~")
        return {"version": __version__, "system": f"{platform.system()} {platform.release()} ({platform.machine()})",
                "note": note.strip(), "log": log}

    @route("GET", "report")
    def get_report(self, _):
        return self._report()

    @route("POST", "report")
    def post_report(self, body):
        """Open a GitHub issue with the report filled in; the person sees it before it's sent."""
        import urllib.parse
        r = self._report(body.get("note", ""))
        text = (f"{r['note'] or 'What were you doing when it happened?'}\n\n**Crate** {r['version']} on {r['system']}\n\n"
                f"<details><summary>Log</summary>\n\n```\n{r['log'][-4500:]}\n```\n</details>")
        url = (f"https://github.com/{updates.REPO}/issues/new?title={urllib.parse.quote('Crash report: ' + r['version'])}"
               f"&body={urllib.parse.quote(text)}")
        desktop.open_external(url)
        return {}

    @route("POST", "jserror")
    def post_jserror(self, body):
        """Errors in the page go to crate.log, so a report includes them."""
        logging.error("page: %s at %s\n%s", str(body.get("message", ""))[:500], str(body.get("where", ""))[:200], str(body.get("stack", ""))[:2000])
        return {}

    # another launch of Crate asks the running one to show itself instead of opening a second copy
    @route("GET", "hello")
    def get_hello(self, _):
        return {"window": self.window is not None, "version": __version__}

    @route("POST", "focus")
    def post_focus(self, _):
        self.focus()
        return {}

    @route("POST", "bye")
    def post_bye(self, _):
        self.closed_at = time.monotonic()
        return {}

    @route("GET", "job")
    def get_job(self, _):
        return self.jobs.snapshot()

    @route("GET", "engine")
    def get_engine(self, _):
        return self.engine.info()

    @route("POST", "engine/start")
    def post_engine_start(self, _):
        origins = [f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"]
        return {"port": self.engine.start(origins)}

    @route("POST", "pcm")
    def post_pcm(self, body):
        t = self.lib.detail(int(body["id"]))
        if not t:
            raise ValueError("That track isn't in the library")
        return self.engine.decode(t["path"], int(body["id"]), int(body["rate"]))
