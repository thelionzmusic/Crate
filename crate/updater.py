"""Install an update (a Crate .zip) into the updates folder the launcher loads from."""
from __future__ import annotations

import io
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath


def install(blob: bytes, home: Path) -> str:
    """Validate and unpack the `crate` package from `blob`. Returns the new version."""
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise ValueError("That isn't a Crate update file (.zip).") from None
    names = z.namelist()
    # The package is the folder holding __init__.py next to analysis/ and export/.
    prefix = next((n[:-len("__init__.py")] for n in names if n.endswith("crate/__init__.py")
                   and n[:-len("__init__.py")] + "analysis/__init__.py" in names
                   and n[:-len("__init__.py")] + "export/__init__.py" in names), None)
    if prefix is None:
        raise ValueError("That zip doesn't contain Crate.")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', z.read(prefix + "__init__.py").decode("utf-8"))
    version = m.group(1) if m else "unknown"

    app = home / "app"
    staging, old = home / "app.new", home / "app.old"
    for d in (staging, old):
        shutil.rmtree(d, ignore_errors=True)
    target = staging / "crate"
    for n in names:
        if not n.startswith(prefix) or n.endswith("/") or "__pycache__" in n:
            continue
        rel = PurePosixPath(n[len(prefix):])
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError("Update file has unsafe paths.")
        dest = target.joinpath(*rel.parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(z.read(n))
    if app.exists():
        app.replace(old)
    staging.replace(app)
    shutil.rmtree(old, ignore_errors=True)
    return version
