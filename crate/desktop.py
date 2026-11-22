"""The computer Crate runs on: opening links and mail outside the app window."""
from __future__ import annotations

import os
import subprocess

from . import audio


def open_external(url: str) -> None:
    """A link or a mailto: in the system's own browser or mail app, never the Crate window."""
    if os.name == "nt":
        os.startfile(url)  # noqa: S606
    else:
        import webbrowser
        webbrowser.open(url)


def pick(kind: str) -> str:
    """Native Windows picker via PowerShell (no GUI toolkit needed). '' if cancelled."""
    if os.name != "nt":
        return ""
    if kind == "folder":
        script = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
                  "$d.Description='Choose a music folder';$d.UseDescriptionForTitle=$true;"
                  "if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}")
    else:
        script = ("Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.OpenFileDialog;"
                  "$d.Filter='rekordbox collection (*.xml)|*.xml';"
                  "if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.FileName)}")
    out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True,
                         text=True, encoding="utf-8", creationflags=audio.NO_WINDOW)
    return out.stdout.strip()


def eject(path: str) -> bool:
    """Safely remove a stick, as the taskbar's Eject does. False if the system refused
    (a file on it still open, say)."""
    try:
        if os.name == "nt":
            drive = os.path.splitdrive(path)[0] or path.rstrip("\\/")
            script = f"(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{drive}').InvokeVerb('Eject')"
            subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, timeout=20,
                           creationflags=audio.NO_WINDOW)
            return not os.path.exists(path)
        cmd = ["diskutil", "eject", path] if os.uname().sysname == "Darwin" else ["umount", path]
        return subprocess.run(cmd, capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
