"""Entry point for Crate.exe (PyInstaller) and `python run_crate.py`.

The .exe carries a frozen copy of the app. Updates installed from inside Crate live in
%APPDATA%\\Crate\\app and take priority, so new versions never need a rebuild. If an
installed update fails to load, the frozen copy runs instead.
"""
import importlib.abc
import importlib.machinery
import logging
import os
import sys
from pathlib import Path


def _updates_dir() -> Path:
    if os.environ.get("CRATE_HOME"):
        return Path(os.environ["CRATE_HOME"]) / "app"
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "Crate" / "app"
    return Path.home() / ".crate" / "app"


class _UpdatedCrate(importlib.abc.MetaPathFinder):
    """Serve the `crate` package from the updates folder, ahead of the frozen copy."""

    def __init__(self, root: Path):
        self.root = str(root)

    def find_spec(self, name, path=None, target=None):
        if name == "crate":
            return importlib.machinery.PathFinder.find_spec(name, [self.root])
        if name.startswith("crate."):
            return importlib.machinery.PathFinder.find_spec(name, path)
        return None


def _version(text: str) -> tuple:
    import re
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    return tuple(int(p) for p in re.findall(r"\d+", m.group(1))) if m else ()


def _newer_update(root: Path) -> bool:
    """Use an installed update only if it's newer than the copy built into this .exe,
    so installing a fresh Crate Setup always wins over an older in-app update."""
    init = root / "crate" / "__init__.py"
    if not init.is_file():
        return False
    import crate as bundled
    newer = _version(init.read_text("utf-8")) > _version(f'__version__ = "{bundled.__version__}"')
    for mod in [m for m in sys.modules if m == "crate" or m.startswith("crate.")]:
        del sys.modules[mod]
    return newer


def _load():
    root = _updates_dir()
    if getattr(sys, "frozen", False) and _newer_update(root):
        finder = _UpdatedCrate(root)
        sys.meta_path.insert(0, finder)
        try:
            from crate.__main__ import main
            return main
        except Exception:
            logging.exception("installed update failed to load; using the built-in version")
            sys.meta_path.remove(finder)
            for mod in [m for m in sys.modules if m == "crate" or m.startswith("crate.")]:
                del sys.modules[mod]
    from crate.__main__ import main
    return main


if __name__ == "__main__":
    _load()()
