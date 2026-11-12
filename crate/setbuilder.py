"""Set builder: an ordered run of tracks that mix into each other and follow an energy arc.

Each step scores every candidate on harmonic fit (Camelot), tempo fit (with half and
double time), how close its energy sits to the arc at that point in the set, and variety
(no artist twice in a row, never a track twice). A small beam search keeps the best few
partial sets at each step, so one greedy choice early on can't paint the set into a corner.
"""
from __future__ import annotations

import datetime as dt
import json

import numpy as np

ARCS = {
    "warmup": lambda p, e0: e0 + (min(10, e0 + 3) - e0) * p,           # build steadily
    "peak": lambda p, e0: max(e0, 8) if p > 0.15 else e0 + (max(e0, 8) - e0) * p / 0.15,  # get up there, stay
    "journey": lambda p, e0: e0 + 3 * (1 - abs(2 * p - 1)),            # rise to the middle, come home
    "closing": lambda p, e0: e0 + (max(1, e0 - 4) - e0) * p,           # wind down
}


def _key_fit(a: str | None, b: str | None) -> float:
    try:
        na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    except (TypeError, ValueError, IndexError):
        return 0.3  # unknown key: neutral
    d = (nb - na) % 12
    if la == lb and d == 0:
        return 1.0
    if la == lb and d in (1, 11):
        return 0.9
    if na == nb:
        return 0.85  # relative major/minor
    if la == lb and d in (2, 10):
        return 0.35  # energy-boost jump, use sparingly
    return 0.0


def _tempo_fit(a: float | None, b: float | None, window: float) -> float:
    if not a or not b:
        return 0.3
    gap = min(abs(b * r / a - 1) for r in (1, 0.5, 2)) * 100  # percent
    return max(0.0, 1 - gap / window)


def _ends(t: dict) -> tuple[float | None, float | None]:
    """(tempo it starts at, tempo it ends at): different for tracks that change tempo."""
    tp = t.get("tempos")
    if isinstance(tp, str):
        tp = json.loads(tp)
    return (tp[0]["bpm"], tp[-1]["bpm"]) if tp else (t.get("bpm"), t.get("bpm"))


class _Pool:
    """Every candidate's key, tempos, energy and artist as arrays, so one step scores the
    whole library at once (a 20-track set from 20,000 tracks in well under a second)."""

    def __init__(self, tracks: list[dict]):
        self.ids = np.array([t["id"] for t in tracks])
        self.index = {tid: i for i, tid in enumerate(self.ids.tolist())}
        num, maj = [], []
        for t in tracks:
            c = t.get("camelot") or ""
            try:
                num.append(int(c[:-1]))
                maj.append(1 if c[-1] == "B" else 0)
            except (ValueError, IndexError):
                num.append(-1)
                maj.append(-1)
        self.num, self.maj = np.array(num), np.array(maj)
        ends = [_ends(t) for t in tracks]
        self.bpm_in = np.array([e[0] or 0.0 for e in ends], float)
        self.bpm_out = np.array([e[1] or 0.0 for e in ends], float)
        self.energy = np.array([t.get("energy") or 5 for t in tracks], float)
        names = {a: i for i, a in enumerate({t.get("artist") or "" for t in tracks})}
        self.artist = np.array([names[t.get("artist") or ""] if t.get("artist") else -1 for t in tracks])

    def key_fit(self, i: int) -> np.ndarray:
        """_key_fit from track i to every track."""
        na, la = self.num[i], self.maj[i]
        if na < 0:
            return np.full(len(self.ids), 0.3)
        d, same = (self.num - na) % 12, self.maj == la
        out = np.zeros(len(self.ids))
        out[(self.num == na) & ~same] = 0.85
        out[same & ((d == 2) | (d == 10))] = 0.35
        out[same & ((d == 1) | (d == 11))] = 0.9
        out[same & (d == 0)] = 1.0
        out[self.num < 0] = 0.3
        return out

    def tempo_fit(self, i: int, window: float) -> np.ndarray:
        """_tempo_fit from track i's closing tempo into every track's opening tempo."""
        a, b = self.bpm_out[i], self.bpm_in
        if not a:
            return np.full(len(self.ids), 0.3)
        with np.errstate(divide="ignore", invalid="ignore"):
            gap = np.min(np.abs(np.outer(b, (1, 0.5, 2)) / a - 1), axis=1) * 100
        out = np.clip(1 - gap / window, 0.0, None)
        out[b == 0] = 0.3
        return out


def build(tracks: list[dict], start_id: int, length: int, arc: str = "warmup",
          tempo_window: float = 6.0, beam: int = 12) -> list[int]:
    """Return track ids, starting with `start_id`, up to `length` long."""
    pool = _Pool(tracks)
    if start_id not in pool.index:
        raise ValueError("Pick a starting track that's been analysed.")
    curve = ARCS.get(arc, ARCS["warmup"])
    e0 = pool.energy[pool.index[start_id]]
    states = [(0.0, [pool.index[start_id]])]
    for step in range(1, max(1, length)):
        target = curve(step / max(1, length - 1), e0)
        e_fit = 1 - np.minimum(1.0, np.abs(pool.energy - target) / 4)
        grown = []
        for score, path in states:
            last = path[-1]
            k, b = pool.key_fit(last), pool.tempo_fit(last, tempo_window)
            total = 0.4 * k + 0.3 * b + 0.3 * e_fit - np.where((pool.artist == pool.artist[last]) & (pool.artist >= 0), 0.25, 0.0)
            total[(k == 0) | (b == 0)] = -np.inf  # it wouldn't mix
            total[path] = -np.inf
            best = np.argpartition(-total, min(beam, len(total) - 1))[:beam]
            grown += [(score + total[j], path + [int(j)]) for j in best if np.isfinite(total[j])]
        if not grown:
            break  # nothing left that mixes
        grown.sort(key=lambda sp: -sp[0])
        states = grown[:beam]
    best = max(states, key=lambda sp: (len(sp[1]), sp[0]))[1]
    return [int(pool.ids[i]) for i in best]

def suggest(tracks: list[dict], current_id: int, n: int = 12, played: set[int] | None = None,
            tempo_window: float = 6.0, recent_days: int = 14) -> list[dict]:
    """What to play after `current_id`: tracks that mix in, ranked, each with why.

    Leaves out what's already been played tonight (`played`), and marks anything played
    in the last couple of weeks so the same crowd doesn't hear it twice."""
    by_id = {t["id"]: t for t in tracks}
    cur = by_id.get(current_id)
    if not cur:
        return []
    played = played or set()
    out_bpm, e0 = _ends(cur)[1], cur.get("energy") or 5
    today = dt.date.today()
    picks = []
    for t in tracks:
        if t["id"] == current_id or t["id"] in played:
            continue
        k, b = _key_fit(cur.get("camelot"), t.get("camelot")), _tempo_fit(out_bpm, _ends(t)[0], tempo_window)
        if k == 0 or b == 0:
            continue
        e = t.get("energy") or 5
        lift = 1 - min(1.0, abs(e - (e0 + 0.5)) / 4)  # a touch more energy is the usual move
        days = None
        if t.get("last_played"):
            try:
                days = (today - dt.date.fromisoformat(t["last_played"][:10])).days
            except ValueError:
                days = None
        stale = 0.25 if days is not None and days < recent_days else 0.0
        same_artist = 0.2 if t.get("artist") and t.get("artist") == cur.get("artist") else 0.0
        why = []
        if k >= 0.85:
            why.append("same key" if k == 1.0 else "relative key" if k == 0.85 else "next key")
        elif k > 0:
            why.append("energy-boost key")
        bpm = _ends(t)[0]
        if bpm and out_bpm:
            ratio = min((1, 0.5, 2), key=lambda r: abs(bpm * r / out_bpm - 1))
            why.append(f"{(bpm * ratio / out_bpm - 1) * 100:+.1f}% tempo" + ("" if ratio == 1 else " (half/double)"))
        if e != e0:
            why.append(f"energy {e0}→{e}")
        picks.append({"id": t["id"], "score": round(0.45 * k + 0.35 * b + 0.2 * lift - stale - same_artist, 3),
                      "why": why, "played_days_ago": days})
    picks.sort(key=lambda p: -p["score"])
    return picks[:n]
