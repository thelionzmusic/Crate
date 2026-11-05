# Crate

A DJ library manager that replaces rekordbox for USB prep. It analyses your music on every CPU core, levels loudness without touching dynamics, and writes USB sticks that Pioneer players read natively, playlists included.

## Install

Download **Crate-Setup.exe** from this repository's Releases page and run it. It installs for your user only (no admin prompt), adds Start menu and desktop shortcuts, and opens Crate when it's done. Every push to `main` builds a new release automatically.

To build it yourself instead, double-click **build.bat**, which produces `dist\Crate\Crate.exe`.

Your library is kept in `%APPDATA%\Crate`. Your music files are never modified.

## Updating

Updates come as a `.zip`. In Crate, open **Settings > Install update** and pick the file, or drop it anywhere on the Crate window. Crate installs it and restarts itself. Only a change to the bundled tools (Python packages or ffmpeg) would ever need a rebuild.

## Move over from rekordbox

In rekordbox, choose **File > Export Collection in xml format**. Then in Crate, click **Import rekordbox** and pick that file. You keep your playlists, beatgrids, hot cues (colours and names), memory cues, ratings and track colours. Crate then analyses loudness and waveforms for everything. Imported grids and keys are kept unless you change them.

## Prep

- **Add music folder**: scans and analyses BPM, beatgrid, downbeat, key, loudness and true peak, plus RGB and 3-band waveforms.
- **Phrases and automatic cues**: every track is split into Intro, Build, Drop, Breakdown, Verse and Outro on the 8-bar phrase grid. Tracks without cues of their own get hot cues on the start and on each build, drop, breakdown and the outro, plus a named memory cue on every phrase. Cues you set, or that came from rekordbox, are never touched. Use *Auto cues* in the detail view to redo a track.
- **Deck**: Space to play, 1–8 to set or jump hot cues (Shift+1–8 deletes), M for a memory cue, D to make the beat at the playhead beat 1, `[` `]` to nudge the grid (Shift for larger steps), ←/→ to jump by a beat (Shift for 16). Use the scroll wheel on the waveform to zoom, drag it to scrub, and Shift-click a cue marker to delete it. *Click* plays a metronome so you can check the grid by ear.
- **Matching**: with a track loaded, every compatible track in the list (key ±1 or relative, BPM within 6%, half and double time included) gets an outlined key.
- **Search**: free text, plus `bpm:122-126` and `key:8A`.
- **Playlists**: drag tracks onto a playlist in the sidebar, and drag rows inside a playlist to reorder. Right-click for folders, moving and deleting.

## Export

**Export to USB**, then pick the drive, the player family, and playlists (choosing a folder includes everything inside it).

| Players | What gets converted |
|---|---|
| CDJ-3000 / 3000X, XDJ-AZ, OPUS-QUAD, OMNIS-DUO | Nothing (up to 96 kHz / 24-bit) |
| CDJ-2000NXS2, TOUR1, XDJ-1000MK2, XDJ-RX2/RX3/XZ/RR | Nothing (up to 96 kHz / 24-bit) |
| Any Pioneer player (CDJ-2000/900, NXS, XDJ-700/1000…) | FLAC/ALAC to AIFF, above 48 kHz resampled |

Re-exports are incremental: only new or changed tracks are copied, and tracks you've removed from the stick's playlists are deleted from it.

### Loudness matching (no distortion)

Each exported copy gets plain gain, so the whole set sits at one loudness. Gain never takes a track's true peak above the ceiling (-1 dBTP by default), and nothing is limited or compressed, so tracks can't clip.

- **Automatic target** (default) picks the loudest level that 9 in 10 of your tracks can reach. Loud masters come down to it and quiet ones come up to it. The rare dynamic track that can't reach it without passing the ceiling stops short. Those show in amber in the Level column and under *Needs attention*, and you raise the trim on those.
- WAV, AIFF, FLAC and ALAC are re-rendered sample-accurately, so grids and cues stay exactly in place. MP3 uses the lossless mp3gain method (1.5 dB steps, no re-encode). AAC can't be changed losslessly, so it's copied as-is and flagged.

Expect the stick to sound a few dB quieter overall than before, because loud masters are brought down rather than quiet ones squashed up. Set the mixer once at the start of the night and leave it.

## Before a gig

The stick format follows the reverse-engineered rekordbox export spec, and an independent reader checks it in the test suite. It hasn't been tested on a real CDJ yet, so **test one stick on your own players before you rely on it**: check that it mounts, the playlists show, tracks load with their waveforms, the grid lines up and the hot cues are in place. If a player hangs while loading the stick, export again with *Troubleshooting > Write the player browse-menu tables* switched off and try again.

## Developing

```
pip install numpy scipy        # ffmpeg/ffprobe on PATH or in .\bin
python run_crate.py            # opens the app
python tests/test_analysis.py  # BPM, phase, downbeat, key, LUFS vs ffmpeg's EBU R128 meter
python tests/test_export.py    # full USB export, read back by an independent parser
```
