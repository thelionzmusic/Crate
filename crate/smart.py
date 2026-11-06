"""Smart playlists: rules that keep a playlist's tracks current by themselves.

A rule set is {"match": "all" | "any", "rules": [{"field", "op", "value"}], "limit": n}.
"""
from __future__ import annotations

import datetime as dt

# field -> kind. Kinds decide which operators make sense.
FIELDS = {
    "bpm": "number", "energy": "number", "rating": "number", "plays": "number", "lufs": "number",
    "year": "number", "duration": "number",
    "camelot": "key", "genre": "text", "artist": "text", "title": "text", "label": "text", "comment": "text",
    "codec": "text", "date_added": "date", "color": "number", "has_vocals": "flag", "has_issues": "flag",
}
OPS = {"number": {"between", ">=", "<=", "="}, "text": {"contains", "is", "not_contains"},
       "key": {"in", "compatible"}, "date": {"within_days"}, "flag": {"is"}}


def validate(rules: dict) -> dict:
    """Normalise a rule set, rejecting unknown fields and operators."""
    out = {"match": "any" if rules.get("match") == "any" else "all", "rules": []}
    for r in rules.get("rules", []):
        kind = FIELDS.get(r.get("field"))
        if not kind or r.get("op") not in OPS[kind]:
            raise ValueError(f"Can't filter on {r.get('field')} {r.get('op')}")
        out["rules"].append({"field": r["field"], "op": r["op"], "value": r.get("value")})
    if rules.get("limit"):
        out["limit"] = max(1, int(rules["limit"]))
    if rules.get("sort") in FIELDS:
        out["sort"] = rules["sort"]
    return out


def _compatible(a: str, b: str) -> bool:
    """Camelot neighbours: same key, one step round the wheel, or the relative major/minor."""
    try:
        na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    except (ValueError, IndexError):
        return False
    d = (na - nb) % 12
    return (la == lb and d in (0, 1, 11)) or na == nb


def _test(rule: dict, t: dict, today: dt.date) -> bool:
    f, op, v = rule["field"], rule["op"], rule["value"]
    if f == "has_vocals":
        val = bool(t.get("vocals") and t["vocals"] != "[]")
    elif f == "has_issues":
        val = bool(t.get("issues"))
    else:
        val = t.get(f)
    if op == "is" and FIELDS[f] == "flag":
        return val == bool(v)
    if val is None or val == "":
        return False
    if op == "between":
        return float(v[0]) <= float(val) <= float(v[1])
    if op == ">=":
        return float(val) >= float(v)
    if op == "<=":
        return float(val) <= float(v)
    if op == "=":
        return float(val) == float(v)
    if op == "contains":
        return str(v).lower() in str(val).lower()
    if op == "not_contains":
        return str(v).lower() not in str(val).lower()
    if op == "is":
        return str(val).lower() == str(v).lower()
    if op == "in":
        return str(val).upper() in {str(k).upper() for k in v}
    if op == "compatible":
        return _compatible(str(val).upper(), str(v).upper())
    if op == "within_days":
        try:
            return (today - dt.date.fromisoformat(str(val)[:10])).days <= int(v)
        except ValueError:
            return False
    return False


def evaluate(rules: dict, tracks: list[dict]) -> list[int]:
    today = dt.date.today()
    want = all if rules.get("match", "all") == "all" else any
    hits = [t for t in tracks if rules.get("rules") and want(_test(r, t, today) for r in rules["rules"])]
    key = rules.get("sort")
    if key:
        hits.sort(key=lambda t: (t.get(key) is None, t.get(key) or 0))
    if rules.get("limit"):
        hits = hits[: rules["limit"]]
    return [t["id"] for t in hits]
