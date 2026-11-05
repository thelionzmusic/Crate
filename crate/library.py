"""The collection: SQLite (WAL) plus a flat store of waveform blobs."""
from __future__ import annotations

import datetime as dt
import sqlite3
import threading
from pathlib import Path

import numpy as np

from .analysis import structure
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
CREATE TABLE IF NOT EXISTS folders(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
"""

DEFAULTS = {"phrase_export": "0", "waveform": "rgb", "target_mode": "auto", "target_lufs": "-10", "ceiling": "-1.0", "bpm_min": "88",
            "profile": "cdj3000", "level": "1", "menu_tables": "1"}

TRACK_COLS = ["id", "title", "artist", "album", "genre", "label", "bpm", "key", "camelot", "duration",
              "lufs", "true_peak", "codec", "sample_rate", "bit_depth", "bitrate", "rating", "color",
              "date_added", "analysed", "error", "path", "year", "remixer", "comment", "plays", "has_art"]


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

    def _migrate(self) -> None:
        """One-off fixes for libraries made by earlier versions."""
        if "auto" not in {r["name"] for r in self.q("PRAGMA table_info(cues)")}:
            self.x("ALTER TABLE cues ADD COLUMN auto INT DEFAULT 0")  # 1.2: cues Crate placed itself
        if self.settings().get("flatten_rekordbox_import") != "1":
            # 1.0 imported rekordbox playlists inside a top-level 'rekordbox' folder; lift them out.
            with self.tx():
                for r in self.db.execute("SELECT id FROM nodes WHERE parent_id = 0 AND is_folder = 1 AND name = 'rekordbox'").fetchall():
                    top = self.db.execute("SELECT COALESCE(MAX(sort), -1) FROM nodes WHERE parent_id = 0").fetchone()[0]
                    for i, c in enumerate(self.db.execute("SELECT id FROM nodes WHERE parent_id = ? ORDER BY sort, id", (r["id"],)).fetchall()):
                        self.db.execute("UPDATE nodes SET parent_id = 0, sort = ? WHERE id = ?", (top + 1 + i, c["id"]))
                    self.db.execute("DELETE FROM nodes WHERE id = ?", (r["id"],))
            self.set("flatten_rekordbox_import", 1)

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
    def table(self) -> dict:
        rows = self.q(f"SELECT {', '.join(TRACK_COLS)} FROM tracks ORDER BY id")
        return {"cols": TRACK_COLS, "rows": [list(r) for r in rows]}

    def track(self, tid: int) -> dict | None:
        r = self.q("SELECT * FROM tracks WHERE id = ?", (tid,))
        return dict(r[0]) if r else None

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

    def save_analysis(self, tid: int, r: dict) -> None:
        if not r["ok"]:
            self.x("UPDATE tracks SET error = ?, analysed = strftime('%s','now') WHERE id = ?", (r["error"], tid))
            return
        (self.waves / f"{tid}.u8").write_bytes(r["wave"])
        self.x("""UPDATE tracks SET lufs = ?, true_peak = ?, error = NULL, analysed = strftime('%s','now'),
                  bpm = CASE WHEN grid_locked THEN bpm ELSE ? END,
                  first_beat_ms = CASE WHEN grid_locked THEN first_beat_ms ELSE ? END,
                  downbeat = CASE WHEN grid_locked THEN downbeat ELSE ? END,
                  key = CASE WHEN key_locked THEN key ELSE ? END,
                  camelot = CASE WHEN key_locked THEN camelot ELSE ? END
               WHERE id = ?""",
               (r["lufs"], r["true_peak"], r["bpm"], r["first_beat_ms"], r["downbeat"], r["key"], r["camelot"], tid))
        self.restructure(tid)

    def restructure(self, tid: int) -> None:
        """Rebuild phrases (and Crate's own auto cues) from the track's current grid.

        Auto cues are placed only on tracks with no cues of their own, and only ever replace
        cues Crate placed, never ones you or rekordbox set."""
        t = self.track(tid)
        wave = self.wave(tid)
        if not t or not len(wave) or not t["bpm"]:
            return
        phr = structure.phrases(wave, t["bpm"], t["first_beat_ms"] or 0.0, t["downbeat"] or 0, t["duration"] or len(wave) / 150)
        with self.tx():
            self.db.execute("DELETE FROM phrases WHERE track_id = ?", (tid,))
            self.db.executemany("INSERT INTO phrases(track_id, start_ms, end_ms, start_bar, bars, label) VALUES(?,?,?,?,?,?)",
                                [(tid, p["start_ms"], p["end_ms"], p["start_bar"], p["bars"], p["label"]) for p in phr])
            manual = self.db.execute("SELECT COUNT(*) FROM cues WHERE track_id = ? AND auto = 0", (tid,)).fetchone()[0]
            if not manual:
                self.db.execute("DELETE FROM cues WHERE track_id = ? AND auto = 1", (tid,))
                self.db.executemany("INSERT INTO cues(track_id, slot, start_ms, end_ms, color, name, auto) VALUES(?,?,?,?,?,?,1)",
                                    [(tid, c["slot"], c["start_ms"], c["end_ms"], c["color"], c["name"])
                                     for c in structure.auto_cues(phr)])

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
        if {"bpm", "first_beat_ms", "downbeat"} & f.keys():
            f["grid_locked"] = 1
        if "key" in f:
            f["key"], f["camelot"] = normalise(str(f["key"]))
            f["key_locked"] = 1
        self.x(f"UPDATE tracks SET {', '.join(f'{k} = ?' for k in f)} WHERE id = ?", [*f.values(), tid])
        if "grid_locked" in f:
            self.restructure(tid)  # phrases sit on the grid, so they follow it

    def remove(self, ids: list[int]) -> None:
        with self.tx():
            for tid in ids:
                self.db.execute("DELETE FROM tracks WHERE id = ?", (tid,))
                (self.waves / f"{tid}.u8").unlink(missing_ok=True)

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
        return [{**dict(r), "tracks": members.get(r["id"], [])}
                for r in self.q("SELECT id, parent_id, name, is_folder, sort FROM nodes ORDER BY parent_id, sort, id")]

    def create_node(self, name: str, parent_id: int = 0, is_folder: bool = False) -> int:
        nxt = self.q("SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM nodes WHERE parent_id = ?", (parent_id,))[0]["s"]
        return self.x("INSERT INTO nodes(parent_id, name, is_folder, sort) VALUES(?,?,?,?)",
                      (parent_id, name, int(is_folder), nxt))

    def update_node(self, nid: int, name: str | None = None, parent_id: int | None = None, sort: int | None = None):
        for col, val in (("name", name), ("parent_id", parent_id), ("sort", sort)):
            if val is not None:
                self.x(f"UPDATE nodes SET {col} = ? WHERE id = ?", (val, nid))

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

    # ---- export --------------------------------------------------------------
    def export_payload(self, node_ids: list[int] | None, everything: bool = False) -> tuple:
        """Tracks, playlist nodes, cues and level target for an export.

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
            ids += [r["id"] for r in self.q("SELECT id FROM tracks ORDER BY artist, title") if r["id"] not in set(ids)]

        rows = {r["id"]: dict(r) for r in self.q(
            f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
        tracks = [rows[i] for i in ids if i in rows and rows[i]["analysed"] and not rows[i]["error"]]
        s = self.settings()
        ceiling = float(s["ceiling"])
        target = (auto_target([t["lufs"] for t in tracks], [t["true_peak"] for t in tracks], ceiling)
                  if s["target_mode"] == "auto" else float(s["target_lufs"]))
        for t in tracks:
            t["ceiling"] = ceiling
            t["gain_db"] = level_gain(t["lufs"], t["true_peak"], target, ceiling)[0] if t["lufs"] is not None else 0.0
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
