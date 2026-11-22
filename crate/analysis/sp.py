"""scipy.signal, loaded on first use so opening Crate doesn't wait for it."""
from __future__ import annotations


def butter(*a, **k):
    from scipy.signal import butter as f
    return f(*a, **k)


def sosfilt(*a, **k):
    from scipy.signal import sosfilt as f
    return f(*a, **k)


def resample_poly(*a, **k):
    from scipy.signal import resample_poly as f
    return f(*a, **k)
