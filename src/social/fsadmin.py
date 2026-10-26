"""Private admin data in Firestore (the admin tab's post calendar and cost breakdown), written from GitHub Actions.

Nothing here goes in the repo or docs/: both are public (GitHub Pages serves docs/, and the repo itself is public),
so anything committed could be read by anyone. Firestore's rules (firestore.rules: admin_*) let only the owner
account read these collections and nobody write them from the site; the jobs write with the service-account key
(the FIREBASE_SERVICE_ACCOUNT secret, same as push.py), which the rules don't apply to.
Without the key (a local run), rows go to out/admin/*.json instead, which git ignores.
"""
import base64
import io
import json
import os
from pathlib import Path

PROJECT = "cupcake-index"
DOCS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
LOCAL = Path(__file__).resolve().parent.parent.parent / "out" / "admin"
_s = None


def session():
    """An authorized session, or None (no key: local run)."""
    global _s
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        return None
    if _s is None:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        _s = AuthorizedSession(service_account.Credentials.from_service_account_info(
            json.loads(raw), scopes=["https://www.googleapis.com/auth/datastore"]))
    return _s


def _val(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: _val(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_val(x) for x in v]}}
    return {"stringValue": str(v)}


def _py(v):
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    if "mapValue" in v:
        return {k: _py(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [_py(x) for x in v["arrayValue"].get("values", [])]
    return next(iter(v.values()), None)


def put(coll, doc_id, data):
    """Create or replace one document."""
    s = session()
    if not s:
        LOCAL.mkdir(parents=True, exist_ok=True)
        f = LOCAL / f"{coll}.json"
        rows = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        rows[doc_id] = data
        f.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
        return
    r = s.patch(f"{DOCS}/{coll}/{doc_id}", json={"fields": {k: _val(v) for k, v in data.items()}}, timeout=30)
    r.raise_for_status()


def since(coll, field, value, fields=None):
    """Documents whose field >= value (a date string), as dicts with their id in "_id". fields: only these
    (skips the pictures)."""
    s = session()
    if not s:
        f = LOCAL / f"{coll}.json"
        rows = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        return [{**r, "_id": k} for k, r in rows.items() if str(r.get(field, "")) >= value]
    q = {"structuredQuery": {"from": [{"collectionId": coll}],
                             "where": {"fieldFilter": {"field": {"fieldPath": field}, "op": "GREATER_THAN_OR_EQUAL", "value": _val(value)}}}}
    if fields:
        q["structuredQuery"]["select"] = {"fields": [{"fieldPath": f} for f in fields]}
    r = s.post(f"{DOCS}:runQuery", json=q, timeout=30)
    r.raise_for_status()
    return [{**{k: _py(v) for k, v in x["document"].get("fields", {}).items()}, "_id": x["document"]["name"].rsplit("/", 1)[-1]}
            for x in r.json() if "document" in x]


def picture(path, width=640):
    """A small JPEG of a card as base64 (Firestore documents max out at 1 MB; the free plan has no file storage)."""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=72, optimize=True)
    return base64.b64encode(buf.getvalue()).decode()
