"""A stop button for a background job: asked for from the page, honoured only while stopping
is still safe. A job opens it, checks it at safe points, and commits once it reaches work
that has to finish (an export rewriting a stick's library)."""
from __future__ import annotations

import threading


class Cancelled(Exception):
    """The job was stopped from the status bar."""


class Cancel:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._asked = False
        self.open = False

    def reset(self) -> None:
        with self._lock:
            self._asked = self.open = False

    def allow(self) -> None:
        with self._lock:
            self.open = True

    def ask(self) -> bool:
        """From the page: True if the job will stop."""
        with self._lock:
            self._asked = self._asked or self.open
            return self._asked

    @property
    def asked(self) -> bool:
        return self._asked

    def commit(self) -> None:
        """Past this point the job finishes: raises Cancelled if a stop came first."""
        with self._lock:
            if self._asked:
                raise Cancelled()
            self.open = False
