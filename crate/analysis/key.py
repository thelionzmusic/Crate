"""Musical key from a tuning-corrected chromagram matched against key profiles."""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

N_FFT, HOP = 8192, 4096

# Krumhansl-Kessler profiles, tonic first.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Names as DJs read them: flats for major/Camelot-friendly spellings.
MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]


def camelot(pc: int, minor: bool) -> str:
    tonic = (pc + 3) % 12 if minor else pc
    num = (7 * tonic + 8) % 12 or 12
    return f"{num}{'A' if minor else 'B'}"


def key_name(pc: int, minor: bool) -> str:
    return MINOR_NAMES[pc] if minor else MAJOR_NAMES[pc]


def detect(x: np.ndarray, sr: int) -> dict:
    if len(x) < N_FFT * 4:
        return {"key": "", "camelot": ""}
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    wide = np.flatnonzero((freqs >= 40.0) & (freqs <= 2600.0))  # whitened region (no edge bias)
    keep = (freqs[wide] >= 98.0) & (freqs[wide] <= 2000.0)    # analysed region: above kick fundamentals
    sel = wide[keep]
    midi = 69.0 + 12.0 * np.log2(freqs[sel] / 440.0)
    win = np.hanning(N_FFT).astype(np.float32)
    frames = sliding_window_view(x, N_FFT)[::HOP]

    spec_sum = np.zeros(len(sel))
    smooth = np.ones(31) / 31
    for s in range(0, len(frames), 256):
        mag = np.log1p(1000.0 * np.abs(np.fft.rfft(frames[s:s + 256] * win, axis=1)))[:, wide]
        # Whitening: keep only peaks above the local spectral floor, which drops
        # broadband drums and noise while tonal partials survive.
        floor = np.apply_along_axis(np.convolve, 1, mag, smooth, mode="same")
        spec_sum += np.maximum(mag - floor, 0.0)[:, keep].sum(axis=0)

    # Global tuning offset (in semitones) from the circular mean of bin positions.
    tuning = np.angle(np.sum(spec_sum * np.exp(2j * np.pi * midi))) / (2 * np.pi)
    m = midi - tuning
    dev = m - np.round(m)
    weight = np.exp(-(dev ** 2) / (2 * 0.12 ** 2)) * spec_sum
    weight *= np.where(freqs[sel] < 260.0, 2.5, 1.0)  # the bass line usually states the tonic
    chroma = np.bincount(np.round(m).astype(int) % 12, weights=weight, minlength=12)
    if chroma.sum() <= 0:
        return {"key": "", "camelot": ""}

    best, best_r = (0, False), -2.0
    for pc in range(12):
        c = np.roll(chroma, -pc)
        for minor, prof in ((False, MAJOR), (True, MINOR)):
            r = np.corrcoef(c, prof)[0, 1]
            if r > best_r:
                best, best_r = (pc, minor), r
    pc, minor = best
    return {"key": key_name(pc, minor), "camelot": camelot(pc, minor)}


_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def normalise(name: str) -> tuple[str, str]:
    """Accept '8A', 'Am', 'A min', 'F#m', 'Dbm'... -> (key name, camelot)."""
    n = (name or "").strip().replace("min", "m").replace("maj", "").replace(" ", "")
    if not n:
        return "", ""
    if n[:-1].isdigit() and n[-1].upper() in "AB":
        num, minor = int(n[:-1]), n[-1].upper() == "A"
        for pc in range(12):
            if camelot(pc, minor) == f"{num}{'A' if minor else 'B'}":
                return key_name(pc, minor), camelot(pc, minor)
        return "", ""
    if n[0].upper() not in _PC:
        return n, ""
    pc = _PC[n[0].upper()]
    rest = n[1:]
    if rest[:1] in ("#", "\u266f"):
        pc, rest = pc + 1, rest[1:]
    elif rest[:1] in ("b", "\u266d"):
        pc, rest = pc - 1, rest[1:]
    minor = rest.lower().startswith("m")
    pc %= 12
    return key_name(pc, minor), camelot(pc, minor)
