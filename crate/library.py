"""The collection: SQLite (WAL) plus flat files for waveforms and variable beat lists."""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import threading
from pathlib import Path

import numpy as np

from . import smart
from .analysis import structure, tempo
from .analysis.key import normalise
from .analysis.loudness import auto_target, level_gain
from .export import anlz, pdb

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INT, mtime REAL,
  title TEXT, artist TEXT, album TEXT, genre TEXT, label TEXT, remixer TEXT, comment TEXT,
  year INT, track_no INT, duration REAL, sample_rate INT, bit_depth INT, channels INT, bitrate INT,
  codec TEXT, has_art INT,
  bpm REAL, first_beat_ms REAL, downbeat INT, key TEXT, camelot TEXT, lufs REAL, true_peak REAL,
  rating INT DEFAULT 0, color INT DEFAULT 0, plays INT DEFAULT 0, date_added TEXT,
  analysed REAL, error TEXT, grid_locked INT DEFAULT 0, key_locked INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS cues(
  id INTEGER PRIMARY KEY, track_id INT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  slot INT NOT NULL, start_ms INT NOT NULL, end_ms INT DEFAULT -1, color TEXT, name TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS cues_track ON cues(track_id);
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY, parent_id INT DEFAULT 0, name TEXT NOT NULL, is_folder INT DEFAULT 0, sort INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS node_tracks(
  node_id INT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  track_id INT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, pos INT NOT NULL);
CREATE INDEX IF NOT EXISTS node_tracks_node ON node_tracks(node_id, pos);
CREATE TABLE IF NOT EXISTS phrases(
  track_id INT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  start_ms INT NOT NULL, end_ms INT NOT NULL, start_bar INT, bars INT, label TEXT);
CREATE INDEX IF NOT EXISTS phrases_track ON phrases(track_id);
CREATE TABLE IF NOT EXISTS wishlist(
  id INTEGER PRIMARY KEY, artist TEXT, title TEXT, note TEXT DEFAULT '', added TEXT, track_id INT);
CREATE TABLE IF NOT EXISTS folders(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
"""

# Columns added after 1.0, applied in place on older libraries.
MIGRATIONS = {
    "cues": {"auto": "INT DEFAULT 0"},
    "tracks": {"energy": "INT", "quality": "TEXT", "vocals": "TEXT", "variable": "INT DEFAULT 0",
               "mix_in_ms": "INT", "mix_out_ms": "INT", "bandwidth": "INT", "thumb": "BLOB", "cue_ver": "INT DEFAULT 0",
               "tempos": "TEXT", "grid_ver": "INT DEFAULT 0", "last_played": "TEXT"},  # JSON [{ms, bpm}] where each tempo section starts, for tracks that change tempo
    "nodes": {"rules": "TEXT"},
}

DEFAULTS = {"prolink": "0", "phrase_export": "0", "waveform": "rgb", "target_mode": "auto", "target_lufs": "-10", "ceiling": "-1.0",
            "bpm_min": "88", "profile": "cdj3000", "level": "1", "menu_tables": "1", "energy_comment": "0",
            "watch_downloads": "1", "downloads": str(Path.home() / "Downloads"),
            "labs_soulseek": "0", "slsk_mode": "builtin", "slsk_user": "", "slsk_pass": "",
            "slsk_dir": str(Path.home() / "Music" / "Soulseek"),
            "slsk_url": "http://localhost:5030", "slsk_key": ""}

TRACK_COLS = ["id", "title", "artist", "album", "genre", "label", "bpm", "key", "camelot", "duration",
              "lufs", "true_peak", "codec", "sample_rate", "bit_depth", "bitrate", "rating", "color",
              "date_added", "analysed", "error", "path", "year", "remixer", "comment", "plays", "has_art",
              "energy", "variable", "quality", "vocals", "tempos", "last_played"]


class Library:
    def __init__(self, home: Path):
        self.home = home
        self.waves = home / "waves"
        self.waves.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(home / "library.db", check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        self._migrate()
        self._change_log()

    # Every insert, edit and delete of a track is noted here by the database itself, so the
    # page can ask for just what changed (a few rows) instead of the whole library.
    def _change_log(self) -> None:
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS track_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, track_id INT, gone INT DEFAULT 0);
            CREATE TRIGGER IF NOT EXISTS track_added AFTER INSERT ON tracks BEGIN INSERT INTO track_changes(track_id) VALUES(NEW.id); END;
            CREATE TRIGGER IF NOT EXISTS track_changed AFTER UPDATE ON tracks BEGIN INSERT INTO track_changes(track_id) VALUES(NEW.id); END;
            CREATE TRIGGER IF NOT EXISTS track_removed AFTER DELETE ON tracks BEGIN INSERT INTO track_changes(track_id, gone) VALUES(OLD.id, 1); END;
        """)
        self.x("DELETE FROM track_changes WHERE seq < (SELECT MAX(seq) FROM track_changes) - 200000")

    def change_seq(self) -> int:
        return self.q("SELECT COALESCE(MAX(seq), 0) AS s FROM track_changes")[0]["s"]

    def changed_since(self, seq: int) -> tuple[list[int], list[int]] | None:
        """(changed ids, removed ids) since `seq`, or None if the log no longer reaches back that far."""
        oldest = self.q("SELECT MIN(seq) AS s FROM track_changes")[0]["s"]
        if oldest is None or seq < oldest - 1:
            return None
        rows = self.q("SELECT track_id, MAX(gone) AS gone, MAX(seq) FROM track_changes WHERE seq > ? GROUP BY track_id", (seq,))
        gone = {r["track_id"] for r in rows if r["gone"]}
        alive = {r["id"] for r in self.q(f"SELECT id FROM tracks WHERE id IN ({','.join(str(r['track_id']) for r in rows) or '0'})")}
        return sorted(alive), sorted({r["track_id"] for r in rows} - alive | (gone - alive))

    def _migrate(self) -> None:
        for table, cols in MIGRATIONS.items():
            have = {r["name"] for r in self.q(f"PRAGMA table_info({table})")}
            for col, decl in cols.items():
                if col not in have:
                    self.x(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        if self.settings().get("flatten_rekordbox_import") != "1":
            # 1.0 imported rekordbox playlists inside a top-level 'rekordbox' folder; lift them out.
            with self.tx():
                for r in self.db.execute("SELECT id FROM nodes WHERE parent_id = 0 AND is_folder = 1 AND name = 'rekordbox'").fetchall():
                    top = self.db.execute("SELECT COALESCE(MAX(sort), -1) FROM nodes WHERE parent_id = 0").fetchone()[0]
                    for i, c in enumerate(self.db.execute("SELECT id FROM nodes WHERE parent_id = ? ORDER BY sort, id", (r["id"],)).fetchall()):
                        self.db.execute("UPDATE nodes SET parent_id = 0, sort = ? WHERE id = ?", (top + 1 + i, c["id"]))
                    self.db.execute("DELETE FROM nodes WHERE id = ?", (r["id"],))
            self.set("flatten_rekordbox_import", 1)

    # ---- backups -------------------------------------------------------------
    # A copy of the library (playlists, cues, grids, edits) is taken before every update and
    # once a day. Waveforms aren't included: they're rebuilt by analysis if ever lost.
    KEEP_BACKUPS = 14

    def backup(self, reason: str = "daily") -> str:
        folder = self.home / "backups"
        folder.mkdir(exist_ok=True)
        name = f"library-{dt.datetime.now():%Y%m%d-%H%M%S}-{reason}.db"
        dst = sqlite3.connect(folder / name)
        try:
            with self.lock:
                self.db.backup(dst)
        finally:
            dst.close()
        for old in sorted(folder.glob("library-*.db"))[:-self.KEEP_BACKUPS]:
            old.unlink(missing_ok=True)
        return name

    def backups(self) -> list[dict]:
        out = []
        for f in sorted((self.home / "backups").glob("library-*.db"), reverse=True):
            parts = f.stem.split("-")
            when = dt.datetime.strptime(parts[1] + parts[2], "%Y%m%d%H%M%S")
            out.append({"name": f.name, "when": when.isoformat(timespec="minutes"), "reason": "-".join(parts[3:]),
                        "kb": f.stat().st_size // 1024})
        return out

    def backup_daily(self) -> None:
        last = self.backups()
        if not last or last[0]["when"][:10] != dt.date.today().isoformat():
            self.backup("daily")

    def restore(self, name: str) -> None:
        f = self.home / "backups" / Path(name).name
        if not f.is_file():
            raise ValueError("That backup isn't there any more")
        self.backup("before-restore")  # so a restore can itself be undone
        src = sqlite3.connect(f)
        try:
            with self.lock:
                src.backup(self.db)
        finally:
            src.close()
        self._migrate()

    # ---- basics --------------------------------------------------------------
    def q(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def x(self, sql: str, args=()) -> int:
        with self.lock:
            return self.db.execute(sql, args).lastrowid

    def tx(self):
        return _Tx(self)

    def settings(self) -> dict:
        s = dict(DEFAULTS)
        s.update({r["k"]: r["v"] for r in self.q("SELECT k, v FROM settings")})
        return s

    def set(self, k: str, v) -> None:
        self.x("INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, str(v)))

    # ---- tracks --------------------------------------------------------------
    @staticmethod
    def issues(t: dict) -> list[str]:
        """Plain-language problems worth fixing. Peak-limited levelling is not one of them."""
        out = []
        if t.get("path") and not os.path.exists(t["path"]):
            out.append("File not found. It was moved or deleted; use Find moved files to reconnect it")
        if t.get("error"):
            out.append(f"Couldn't be analysed: {t['error']}")
        q = json.loads(t["quality"]) if t.get("quality") else {}
        return out + q.get("issues", [])

    def rows(self, ids: list[int] | None = None) -> list[dict]:
        where = f" WHERE id IN ({','.join(str(int(i)) for i in ids) or '0'})" if ids is not None else ""
        return [dict(r) for r in self.q(f"SELECT {', '.join(TRACK_COLS)} FROM tracks{where} ORDER BY id")]

    def table(self, ids: list[int] | None = None) -> dict:
        cols = [c for c in TRACK_COLS if c not in ("quality", "vocals")] + ["issues", "has_vocals"]
        out = []
        for t in self.rows(ids):
            t["issues"] = self.issues(t)
            t["has_vocals"] = int(bool(t["vocals"] and t["vocals"] != "[]"))
            t["tempos"] = json.loads(t["tempos"]) if t["tempos"] else None
            out.append([t[c] for c in cols])
        return {"cols": cols, "rows": out}

    def track(self, tid: int) -> dict | None:
        r = self.q("SELECT * FROM tracks WHERE id = ?", (tid,))
        return dict(r[0]) if r else None

    def detail(self, tid: int) -> dict | None:
        """Everything the detail view draws for one track."""
        t = self.track(tid)
        if not t:
            return None
        t.pop("thumb", None)
        t["issues"] = self.issues(t)
        t["vocals"] = json.loads(t["vocals"] or "[]")
        t["quality"] = json.loads(t["quality"] or "{}")
        t["cues"], t["phrases"] = self.cues(tid), self.phrases(tid)
        t["beats"] = self.beats(tid) if t["variable"] else None
        t["tempos"] = json.loads(t["tempos"]) if t["tempos"] else None
        return t

    def known(self) -> dict[str, tuple[int, float, int]]:
        return {r["path"]: (r["id"], r["mtime"], r["size"]) for r in self.q("SELECT id, path, mtime, size FROM tracks")}

    def upsert(self, path: str, info: dict) -> int:
        cols = list(info)
        with self.lock:
            row = self.db.execute("SELECT id FROM tracks WHERE path = ?", (path,)).fetchone()
            if row:
                self.db.execute(f"UPDATE tracks SET {', '.join(f'{c} = ?' for c in cols)}, analysed = NULL WHERE id = ?",
                                [info[c] for c in cols] + [row["id"]])
                return row["id"]
            return self.db.execute(
                f"INSERT INTO tracks(path, date_added, {', '.join(cols)}) VALUES(?, ?, {', '.join('?' * len(cols))})",
                [path, dt.date.today().isoformat()] + [info[c] for c in cols]).lastrowid

    def relink(self, tid: int, path: str, info: dict) -> None:
        """Point a track at its file's new location, keeping cues, grid and playlists."""
        self.x("UPDATE tracks SET path = ?, size = ?, mtime = ? WHERE id = ?", (path, info["size"], info["mtime"], tid))

    def save_analysis(self, tid: int, r: dict) -> None:
        if not r["ok"]:
            self.x("UPDATE tracks SET error = ?, analysed = strftime('%s','now') WHERE id = ?", (r["error"], tid))
            return
        (self.waves / f"{tid}.u8").write_bytes(r["wave"])
        self.x("UPDATE tracks SET thumb = ? WHERE id = ?", (self._thumb(np.frombuffer(r["wave"], np.uint8).reshape(-1, 3)), tid))
        locked = self.q("SELECT grid_locked FROM tracks WHERE id = ?", (tid,))[0]["grid_locked"]
        if not locked:
            self._write_beats(tid, r.get("beats_ms"))
        self.x("""UPDATE tracks SET lufs = ?, true_peak = ?, error = NULL, analysed = strftime('%s','now'),
                  energy = ?, quality = ?, vocals = ?, bandwidth = ?,
                  bpm = CASE WHEN grid_locked THEN bpm ELSE ? END,
                  first_beat_ms = CASE WHEN grid_locked THEN first_beat_ms ELSE ? END,
                  downbeat = CASE WHEN grid_locked THEN downbeat ELSE ? END,
                  variable = CASE WHEN grid_locked THEN variable ELSE ? END,
                  tempos = CASE WHEN grid_locked THEN tempos ELSE ? END, grid_ver = ?,
                  key = CASE WHEN key_locked THEN key ELSE ? END,
                  camelot = CASE WHEN key_locked THEN camelot ELSE ? END
               WHERE id = ?""",
               (r["lufs"], r["true_peak"], r["energy"], json.dumps(r["quality"]), json.dumps(r["vocals"]),
                r["quality"]["bandwidth_hz"], r["bpm"], r["first_beat_ms"], r["downbeat"], int(bool(r.get("beats_ms"))),
                json.dumps(r["tempos"]) if r.get("tempos") else None, tempo.GRID_VERSION, r["key"], r["camelot"], tid))
        self.restructure(tid)

    # ---- beat grids ------------------------------------------------------------
    def _write_beats(self, tid: int, beats_ms: list[float] | None) -> None:
        f = self.waves / f"{tid}.beats"
        if beats_ms:
            f.write_bytes(np.asarray(beats_ms, np.float64).tobytes())
        else:
            f.unlink(missing_ok=True)

    def beats(self, tid: int) -> list[float]:
        f = self.waves / f"{tid}.beats"
        return np.frombuffer(f.read_bytes(), np.float64).tolist() if f.is_file() else []

    def grid(self, t: dict) -> list[tuple[int, float]]:
        """(beat in bar, ms) for every beat: the tracked beats when the tempo drifts,
        otherwise the constant grid."""
        if t.get("variable"):
            b = self.beats(t["id"])
            if b:
                db = t["downbeat"] or 0
                return [(((i - db) % 4) + 1, ms) for i, ms in enumerate(b)]
        return tempo.grid(t["bpm"] or 0.0, t["first_beat_ms"] or 0.0, t["downbeat"] or 0, t["duration"] or 0.0)

    def stale_grids(self) -> list[dict]:
        """Tracks whose grid came from an older analysis and that you haven't set by hand."""
        return self.q("SELECT id, path FROM tracks WHERE analysed IS NOT NULL AND error IS NULL AND bpm > 0 "
                      "AND NOT COALESCE(grid_locked, 0) AND COALESCE(grid_ver, 0) < ?", (tempo.GRID_VERSION,))

    def regrid(self, tid: int, r: dict) -> bool:
        """Take a re-checked grid if it found tempo sections; steady grids stay exactly as they were."""
        changed = bool(r.get("ok") and r.get("tempos"))
        if changed:
            self._write_beats(tid, r["beats_ms"])
            self.x("UPDATE tracks SET bpm = ?, first_beat_ms = ?, downbeat = ?, variable = 1, tempos = ? "
                   "WHERE id = ? AND NOT COALESCE(grid_locked, 0)",
                   (r["bpm"], r["first_beat_ms"], r["downbeat"], json.dumps(r["tempos"]), tid))
            self.restructure(tid)
        self.x("UPDATE tracks SET grid_ver = ? WHERE id = ?", (tempo.GRID_VERSION, tid))
        return changed

    def stale_cues(self) -> list[int]:
        """Analysed tracks whose smart cues came from an older layout."""
        return [r["id"] for r in self.q("SELECT id FROM tracks WHERE analysed IS NOT NULL AND error IS NULL AND bpm > 0 "
                                         "AND COALESCE(cue_ver, 0) < ?", (structure.CUE_VERSION,))]

    def restructure(self, tid: int) -> None:
        """Rebuild phrases, mix points and Crate's own auto cues from the current grid.

        Auto cues are placed only on tracks with no cues of their own, and only ever replace
        cues Crate placed, never ones you or rekordbox set."""
        t = self.track(tid)
        wave = self.wave(tid)
        if not t or not len(wave) or not t["bpm"]:
            if t:  # nothing to build from: mark it done so it isn't retried on every launch
                self.x("UPDATE tracks SET cue_ver = ? WHERE id = ?", (structure.CUE_VERSION, tid))
            return
        phr = structure.phrases(wave, structure.bar_starts(self.grid(t)), t["duration"] or len(wave) / 150)
        vocal = [tuple(v) for v in json.loads(t["vocals"] or "[]")]
        mix = structure.mix_points(phr, vocal)
        with self.tx():
            self.db.execute("UPDATE tracks SET mix_in_ms = ?, mix_out_ms = ?, cue_ver = ? WHERE id = ?",
                            (mix.get("mix_in_ms"), mix.get("mix_out_ms"), structure.CUE_VERSION, tid))
            self.db.execute("DELETE FROM phrases WHERE track_id = ?", (tid,))
            self.db.executemany("INSERT INTO phrases(track_id, start_ms, end_ms, start_bar, bars, label) VALUES(?,?,?,?,?,?)",
                                [(tid, p["start_ms"], p["end_ms"], p["start_bar"], p["bars"], p["label"]) for p in phr])
            manual = self.db.execute("SELECT COUNT(*) FROM cues WHERE track_id = ? AND auto = 0", (tid,)).fetchone()[0]
            if not manual:
                self.db.execute("DELETE FROM cues WHERE track_id = ? AND auto = 1", (tid,))
                self.db.executemany("INSERT INTO cues(track_id, slot, start_ms, end_ms, color, name, auto) VALUES(?,?,?,?,?,?,1)",
                                    [(tid, c["slot"], c["start_ms"], c["end_ms"], c["color"], c["name"])
                                     for c in structure.auto_cues(phr, mix, vocal)])

    THUMB = 96  # columns in the list-row waveform

    @classmethod
    def _thumb(cls, wave: np.ndarray) -> bytes:
        from .analysis.waveform import resample
        return resample(wave, cls.THUMB).astype(np.uint8).tobytes() if len(wave) else b""

    def thumbs(self) -> bytes:
        """Every row waveform in one blob: [u32 id][THUMB*3 bytes]..., filling any missing ones."""
        out = bytearray()
        for r in self.q("SELECT id, thumb FROM tracks WHERE analysed IS NOT NULL AND error IS NULL"):
            blob = r["thumb"]
            if not blob:
                blob = self._thumb(self.wave(r["id"]))
                if blob:
                    self.x("UPDATE tracks SET thumb = ? WHERE id = ?", (blob, r["id"]))
            if blob and len(blob) == self.THUMB * 3:
                out += r["id"].to_bytes(4, "little") + blob
        return bytes(out)

    def wave(self, tid: int) -> np.ndarray:
        f = self.waves / f"{tid}.u8"
        data = f.read_bytes() if f.is_file() else b""
        return np.frombuffer(data, np.uint8).reshape(-1, 3)

    EDITABLE = {"title", "artist", "album", "genre", "label", "remixer", "comment", "year", "rating", "color",
                "bpm", "first_beat_ms", "downbeat", "key", "camelot"}

    def edit(self, tid: int, fields: dict) -> None:
        f = {k: v for k, v in fields.items() if k in self.EDITABLE}
        if not f:
            return
        t = self.track(tid)
        if {"bpm", "first_beat_ms", "downbeat"} & f.keys():
            f["grid_locked"] = 1
            if t and t["variable"]:
                if "bpm" in f:  # typing a tempo means a constant grid
                    f["variable"] = 0
                    f["tempos"] = None
                    self._write_beats(tid, None)
                elif "first_beat_ms" in f and t["first_beat_ms"] is not None:
                    shift = float(f["first_beat_ms"]) - t["first_beat_ms"]  # nudges move every tracked beat
                    self._write_beats(tid, [b + shift for b in self.beats(tid)])
                    if t.get("tempos"):
                        f["tempos"] = json.dumps([{**x, "ms": round(x["ms"] + shift, 1)} for x in json.loads(t["tempos"])])
        if "key" in f:
            f["key"], f["camelot"] = normalise(str(f["key"]))
            f["key_locked"] = 1
        self.x(f"UPDATE tracks SET {', '.join(f'{k} = ?' for k in f)} WHERE id = ?", [*f.values(), tid])
        if "grid_locked" in f:
            self.restructure(tid)  # phrases sit on the grid, so they follow it

    def import_grid(self, tid: int, beats: list[tuple[int, float, float]]) -> None:
        """Take a beat grid from rekordbox as it is: [(beat in bar 1-4, bpm, ms)] for each beat
        (or each tempo anchor, for a steady grid). Locked, so analysis never overwrites it."""
        beats = sorted((b for b in beats if b[1] > 0), key=lambda b: b[2])
        if not beats:
            return
        bpms = [b[1] for b in beats]
        first_bar = next((i for i, b in enumerate(beats[:4]) if b[0] == 1), 0)
        if max(bpms) - min(bpms) < 0.02:  # steady: keep it as a plain grid
            bpm, (bar, _, ms) = bpms[0], beats[0]
            period = 60000.0 / bpm
            start = ms % period
            k = round((ms - start) / period)
            self.x("UPDATE tracks SET bpm = ?, first_beat_ms = ?, downbeat = ?, variable = 0, tempos = NULL, grid_locked = 1 WHERE id = ?",
                   (bpm, round(start, 2), (k - (bar - 1)) % 4, tid))
            self._write_beats(tid, None)
        else:  # tempo changes: every beat, plus where each tempo section starts
            sections = [{"ms": round(b[2], 1), "bpm": b[1]} for i, b in enumerate(beats) if i == 0 or abs(b[1] - beats[i - 1][1]) >= 0.02]
            main = max(set(bpms), key=bpms.count)
            self._write_beats(tid, [b[2] for b in beats])
            self.x("UPDATE tracks SET bpm = ?, first_beat_ms = ?, downbeat = ?, variable = 1, tempos = ?, grid_locked = 1 WHERE id = ?",
                   (main, round(beats[0][2], 2), first_bar % 4, json.dumps(sections) if len(sections) > 1 else None, tid))
        self.restructure(tid)

    def log_live_play(self, tid: int, started: float) -> bool:
        """A track the decks just played on air: add it to today's live set under History,
        count the play and remember when. False if it isn't a track in this library."""
        if not self.track(tid):
            return False
        day = dt.datetime.fromtimestamp(started)
        parent, name = self.folder("History"), f"Live {day:%d %b %Y}"
        r = self.q("SELECT id FROM nodes WHERE parent_id = ? AND name = ? AND is_folder = 0", (parent, name))
        self.append_to_node(r[0]["id"] if r else self.create_node(name, parent), tid)
        self.x("UPDATE tracks SET plays = COALESCE(plays, 0) + 1, last_played = ? WHERE id = ?", (day.isoformat(timespec="minutes"), tid))
        return True

    def set_plays(self, tid: int, plays: int) -> None:
        self.x("UPDATE tracks SET plays = MAX(COALESCE(plays, 0), ?) WHERE id = ?", (int(plays), tid))

    def bump_plays(self, counts: dict[int, int]) -> None:
        with self.tx():
            self.db.executemany("UPDATE tracks SET plays = COALESCE(plays, 0) + ? WHERE id = ?",
                                [(n, tid) for tid, n in counts.items()])

    def remove(self, ids: list[int]) -> None:
        with self.tx():
            for tid in ids:
                self.db.execute("DELETE FROM tracks WHERE id = ?", (tid,))
        for tid in ids:
            for ext in (".u8", ".beats"):
                (self.waves / f"{tid}{ext}").unlink(missing_ok=True)

    # ---- cues ----------------------------------------------------------------
    def cues(self, tid: int) -> list[dict]:
        return [dict(r) for r in self.q("SELECT slot, start_ms, end_ms, color, name, auto FROM cues WHERE track_id = ? "
                                        "ORDER BY slot = 0, slot, start_ms", (tid,))]

    def phrases(self, tid: int) -> list[dict]:
        return [dict(r) for r in self.q("SELECT start_ms, end_ms, start_bar, bars, label FROM phrases "
                                        "WHERE track_id = ? ORDER BY start_ms", (tid,))]

    def set_cues(self, tid: int, cues: list[dict]) -> None:
        with self.tx():
            self.db.execute("DELETE FROM cues WHERE track_id = ?", (tid,))
            for c in cues:
                self.db.execute("INSERT INTO cues(track_id, slot, start_ms, end_ms, color, name, auto) VALUES(?,?,?,?,?,?,?)",
                                (tid, int(c["slot"]), int(c["start_ms"]), int(c.get("end_ms", -1)),
                                 c.get("color"), c.get("name", ""), int(bool(c.get("auto")))))

    # ---- playlists -----------------------------------------------------------
    def nodes(self) -> list[dict]:
        members: dict[int, list[int]] = {}
        for r in self.q("SELECT node_id, track_id FROM node_tracks ORDER BY node_id, pos"):
            members.setdefault(r["node_id"], []).append(r["track_id"])
        nodes = [dict(r) for r in self.q("SELECT id, parent_id, name, is_folder, sort, rules FROM nodes ORDER BY parent_id, sort, id")]
        rows = None
        for n in nodes:
            if n["rules"]:  # smart playlist: membership is computed, always current
                if rows is None:
                    rows = self.rows()
                    for t in rows:
                        t["issues"] = self.issues(t)
                n["rules"] = json.loads(n["rules"])
                n["tracks"] = smart.evaluate(n["rules"], rows)
            else:
                n["tracks"] = members.get(n["id"], [])
        return nodes

    def create_node(self, name: str, parent_id: int = 0, is_folder: bool = False, rules: dict | None = None) -> int:
        nxt = self.q("SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM nodes WHERE parent_id = ?", (parent_id,))[0]["s"]
        return self.x("INSERT INTO nodes(parent_id, name, is_folder, sort, rules) VALUES(?,?,?,?,?)",
                      (parent_id, name, int(is_folder), nxt, json.dumps(smart.validate(rules)) if rules else None))

    def update_node(self, nid: int, name: str | None = None, parent_id: int | None = None, sort: int | None = None,
                    rules: dict | None = None) -> None:
        for col, val in (("name", name), ("parent_id", parent_id), ("sort", sort)):
            if val is not None:
                self.x(f"UPDATE nodes SET {col} = ? WHERE id = ?", (val, nid))
        if rules is not None:
            self.x("UPDATE nodes SET rules = ? WHERE id = ?", (json.dumps(smart.validate(rules)), nid))

    def delete_node(self, nid: int) -> None:
        with self.tx():
            stack = [nid]
            while stack:
                n = stack.pop()
                stack += [r["id"] for r in self.db.execute("SELECT id FROM nodes WHERE parent_id = ?", (n,))]
                self.db.execute("DELETE FROM nodes WHERE id = ?", (n,))

    def set_node_tracks(self, nid: int, track_ids: list[int]) -> None:
        with self.tx():
            self.db.execute("DELETE FROM node_tracks WHERE node_id = ?", (nid,))
            self.db.executemany("INSERT INTO node_tracks(node_id, track_id, pos) VALUES(?,?,?)",
                                [(nid, t, i) for i, t in enumerate(track_ids)])

    def append_to_node(self, nid: int, track_id: int) -> bool:
        """Add one track to the end of a playlist, unless it's already there."""
        with self.tx():
            if self.db.execute("SELECT 1 FROM node_tracks WHERE node_id = ? AND track_id = ?", (nid, track_id)).fetchone():
                return False
            pos = self.db.execute("SELECT COALESCE(MAX(pos) + 1, 0) FROM node_tracks WHERE node_id = ?", (nid,)).fetchone()[0]
            self.db.execute("INSERT INTO node_tracks(node_id, track_id, pos) VALUES(?,?,?)", (nid, track_id, pos))
            return True

    def folder(self, name: str, parent_id: int = 0) -> int:
        """Id of the folder called `name` under `parent_id`, created if needed."""
        r = self.q("SELECT id FROM nodes WHERE parent_id = ? AND name = ? AND is_folder = 1", (parent_id, name))
        return r[0]["id"] if r else self.create_node(name, parent_id, True)

    # ---- wishlist --------------------------------------------------------------
    def wishlist(self) -> list[dict]:
        return [dict(r) for r in self.q("SELECT * FROM wishlist ORDER BY id DESC")]

    def wish(self, artist: str, title: str, note: str = "", track_id: int | None = None) -> int:
        return self.x("INSERT INTO wishlist(artist, title, note, added, track_id) VALUES(?,?,?,?,?)",
                      (artist, title, note, dt.date.today().isoformat(), track_id))

    def unwish(self, wid: int) -> None:
        self.x("DELETE FROM wishlist WHERE id = ?", (wid,))

    # ---- export --------------------------------------------------------------
    def export_payload(self, node_ids: list[int] | None, everything: bool = False) -> tuple:
        """Tracks, playlist nodes, cues, level target and phrases for an export.

        node_ids=None exports every playlist; `everything` adds the whole collection
        (browsable on the player under TRACK / ARTIST / GENRE ...)."""
        all_nodes = self.nodes()
        by_id = {n["id"]: n for n in all_nodes}
        if node_ids is None:
            chosen = set(by_id)
        else:
            chosen, stack = set(), list(node_ids)
            while stack:  # selecting a folder selects everything under it
                n = stack.pop()
                if n in by_id and n not in chosen:
                    chosen.add(n)
                    stack += [c["id"] for c in all_nodes if c["parent_id"] == n]
            for n in list(chosen):  # keep ancestors so the tree stays intact
                p = by_id[n]["parent_id"]
                while p and p in by_id:
                    chosen.add(p)
                    p = by_id[p]["parent_id"]
        nodes = [pdb.Node(n["id"], n["name"], n["parent_id"] if n["parent_id"] in chosen else 0, bool(n["is_folder"]),
                          n["sort"], list(n["tracks"])) for n in all_nodes if n["id"] in chosen]
        ids = list(dict.fromkeys(t for n in nodes for t in n.track_ids))
        if everything:
            have = set(ids)
            ids += [r["id"] for r in self.q("SELECT id FROM tracks ORDER BY artist, title") if r["id"] not in have]

        rows = {r["id"]: dict(r) for r in self.q(
            f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
        tracks = [rows[i] for i in ids if i in rows and rows[i]["analysed"] and not rows[i]["error"]
                  and os.path.exists(rows[i]["path"])]
        s = self.settings()
        ceiling = float(s["ceiling"])
        target = (auto_target([t["lufs"] for t in tracks], [t["true_peak"] for t in tracks], ceiling)
                  if s["target_mode"] == "auto" else float(s["target_lufs"]))
        for t in tracks:
            t["ceiling"] = ceiling
            t["gain_db"] = level_gain(t["lufs"], t["true_peak"], target, ceiling)[0] if t["lufs"] is not None else 0.0
            t["grid"] = self.grid(t)
            if s["energy_comment"] == "1" and t["energy"]:  # MIK-style "E7 - comment", visible on the player
                t["comment"] = f"E{t['energy']} - {t['comment']}" if t["comment"] else f"E{t['energy']}"
        cues = {}
        for r in self.q(f"SELECT * FROM cues WHERE track_id IN ({','.join('?' * len(tracks))})",
                        [t["id"] for t in tracks]) if tracks else []:
            rgb = tuple(int(r["color"][i:i + 2], 16) for i in (1, 3, 5)) if r["color"] else None
            cues.setdefault(r["track_id"], []).append(anlz.Cue(r["slot"], r["start_ms"], r["end_ms"], rgb, r["name"] or ""))
        phrases = {t["id"]: self.phrases(t["id"]) for t in tracks}
        return tracks, nodes, cues, target, phrases


class _Tx:
    def __init__(self, lib: Library):
        self.lib = lib

    def __enter__(self):
        self.lib.lock.acquire()
        self.lib.db.execute("BEGIN")

    def __exit__(self, exc, *_):
        try:
            self.lib.db.execute("ROLLBACK" if exc else "COMMIT")
        finally:
            self.lib.lock.release()
