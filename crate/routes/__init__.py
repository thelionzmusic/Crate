"""The app's HTTP API, one module per feature. Each handler names its own route:

    @route("POST", "licence/signin")
    def post_licence_signin(self, body): ...

server.App combines the feature classes, and the request handler finds every route on it."""
from __future__ import annotations

from collections.abc import Callable


def route(verb: str, path: str) -> Callable:
    def mark(fn: Callable) -> Callable:
        fn.route = (verb, path)
        return fn
    return mark


def table(app) -> dict[tuple[str, str], Callable]:
    """{(verb, path): bound handler} for every @route on the app and its feature classes."""
    out = {}
    for name in dir(type(app)):
        fn = getattr(type(app), name, None)
        if callable(fn) and hasattr(fn, "route"):
            out[fn.route] = getattr(app, name)
    return out
