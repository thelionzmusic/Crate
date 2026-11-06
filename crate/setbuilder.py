"""Set builder: an ordered run of tracks that mix into each other and follow an energy arc.

Each step scores every candidate on harmonic fit (Camelot), tempo fit (with half and
double time), how close its energy sits to the arc at that point in the set, and variety
(no artist twice in a row, never a track twice). A small beam search keeps the best few
partial sets at each step, so one greedy choice early on can't paint the set into a corner.
"""
from __future__ import annotations

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


def build(tracks: list[dict], start_id: int, length: int, arc: str = "warmup",
          tempo_window: float = 6.0, beam: int = 12) -> list[int]:
    """Return track ids, starting with `start_id`, up to `length` long."""
    by_id = {t["id"]: t for t in tracks}
    if start_id not in by_id:
        raise ValueError("Pick a starting track that's been analysed.")
    curve = ARCS.get(arc, ARCS["warmup"])
    start = by_id[start_id]
    e0 = start.get("energy") or 5
    states = [(0.0, [start_id])]
    for step in range(1, max(1, length)):
        target = curve(step / max(1, length - 1), e0)
        grown = []
        for score, path in states:
            last = by_id[path[-1]]
            used = set(path)
            options = []
            for t in tracks:
                if t["id"] in used:
                    continue
                k, b = _key_fit(last.get("camelot"), t.get("camelot")), _tempo_fit(last.get("bpm"), t.get("bpm"), tempo_window)
                if k == 0 or b == 0:
                    continue  # it wouldn't mix
                e = 1 - min(1.0, abs((t.get("energy") or 5) - target) / 4)
                same_artist = 0.25 if t.get("artist") and t.get("artist") == last.get("artist") else 0.0
                options.append((0.4 * k + 0.3 * b + 0.3 * e - same_artist, t["id"]))
            options.sort(reverse=True)
            grown += [(score + s, path + [tid]) for s, tid in options[:beam]]
        if not grown:
            break  # nothing left that mixes
        grown.sort(key=lambda sp: -sp[0])
        states = grown[:beam]
    return max(states, key=lambda sp: (len(sp[1]), sp[0]))[1]
