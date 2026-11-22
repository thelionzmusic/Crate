# Production tab: layout spec

The third mode beside Library and Perform. Ableton's working layout and density, drawn in
Crate's Studio theme (near-black, flat, hairline dividers, Crate yellow as the one accent,
track colours carrying meaning). Two views of the same set, switched with Tab.

Its tempo always follows the Perform tab's master deck, so anything made here plays in time
with the set. Clips can be fired from Perform, sidechained to the playing track's kick.

A new set opens empty, as in Ableton: a couple of blank MIDI and audio tracks, two returns
and Main, no clips or devices, with each area showing its drop hint. The screenshots this
spec was drawn from had a full project loaded only to show the layout filled.

## Shared frame

```
+--------------------------------------------------------------------------------------+
| transport: tap  BPM (follows deck) 4/4  quantise | pos | play stop rec | loop | key  |
+-----------------+--------------------------------------------------------------------+
| BROWSER         |                                                                    |
| Collections     |              CLIP VIEW   or   TIMELINE VIEW                         |
| Library         |                                                                    |
|  All, Sounds,   |                                                                    |
|  Drums, Instr., |                                                                    |
|  Audio FX,      |                                                                    |
|  MIDI FX, Plug- |                                                                    |
|  ins, Clips,    |                                                                    |
|  Samples        |                                                                    |
| Places          |                                                                    |
|  sample folders |                                                                    |
| [search]        |                                                                    |
| filter tags     |                                                                    |
| results list    |                                                                    |
+-----------------+--------------------------------------------------------------------+
| DEVICE CHAIN for the selected track: device cards left to right, each with a title  |
| bar (on/off, name, fold), its controls, and a drop zone at the end                   |
+--------------------------------------------------------------------------------------+
```

- Browser, left: Collections, a Library list (All, Sounds, Drums, Instruments, Audio
  Effects, MIDI Effects, Plug-ins, Clips, Samples), Places (sample folders the user
  adds). Above the results: search, then filter tags (Content, Type, Character, Key...).
  Results are a dense one-line-per-item list; click previews in time with the set, drag
  into a slot, track or device chain.
- Device chain, bottom, full width: built-in devices and VST3s as cards; a card's title
  bar is its on/off and name; the chain ends in "Drop audio effects here".

## Clip view (first screenshot)

- One column per track, coloured title bar (name + arm/fold icon). Under it, a stack of
  clip slots: a filled slot shows its clip in the track colour with a play triangle;
  empty slots show a stop square. Scenes run across rows; a scene column on the far right
  launches a whole row.
- Return tracks (A, B, C) and Main sit at the right edge, apart from the tracks.
- Mixer at the foot of each column: input and output routing (MIDI/Audio From, Monitor
  In/Auto/Off, Audio To), sends A/B/C as small knobs, then volume value box, pan knob,
  meter with dB scale, track number button (activator), solo, arm.
- Empty space to the right: "Drop files and devices here".

## Timeline view (second screenshot)

- Bar ruler on top with an overview strip; time ruler (m:ss) at the foot.
- Lanes run left to right, clips drawn as coloured blocks in the track colour: MIDI clips
  show their notes, audio clips their waveform. Group tracks fold into thin lanes that
  show their children's clips as slivers.
- Track headers on the right of the lanes: coloured name strip, routing, track number,
  solo, arm, volume and pan values. Returns and Main at the bottom of the header column.
- Automation draws over the lanes; the loop brace and insert marker on the ruler.
- Zoom and the grid size (1/8 etc.) at the bottom right of the lanes.

## Look

- Studio tokens throughout (css/theme.css): black panels, 1px dividers, flat controls.
- Track colours from the existing cue/track palette, used for title bars, clips, meters.
- Labels small and quiet; values in flat recessed boxes (Ableton), yellow when active.
- Knobs: the Perform knobs, arc in the track colour.

## Where it stands

Built (1.16.0): the frame above; transport following the lead deck (Follow), its own tempo
otherwise, launch quantise, bars.beats position; Clip view with slots, scenes, Stop all,
per-track activator, solo, volume (dB), pan and meter; Timeline with drag, snap, lengthen,
insert marker, playback, zoom; browser with sample folders, categories, Crate tracks,
search, preview and drag; clips from samples or library tracks, warped by playback rate;
undo; the set saved as it changes. Code: web/js/produce/, crate/routes/produce.py.

Built (1.22.0): the mixer and Crate's own effects.

- Every track, return and Main is a strip: input, device chain, volume, pan, meter. Tracks
  send post-fader to the returns (A to L); a new set's A holds a Reverb and B a Delay, both
  fully wet. Returns are added with + Return or Ctrl+Alt+T, removed with their sends.
- Twelve devices in the browser under Audio Effects: EQ Eight, Auto Filter, Compressor,
  Gate, Limiter, Saturator, Redux, Delay, Reverb, Chorus, Phaser, Utility. Compressor,
  Gate, Limiter, Redux and Utility are Crate's own DSP (fx/dynamics.worklet.js): the
  browser's compressor adds its own make-up gain, and our own leave room for sidechain.
  The rest are built from Web Audio nodes (fx/devices.js).
- Panels in the Ableton manner (chain.js, fx/views.js): title bar with on/off, A/B and a
  menu; displays drawn from the live nodes (EQ curve with draggable bands and a spectrum,
  filter response, compressor transfer curve with gain reduction, gate state, limiter
  reduction, saturation curve, reverb envelope); knobs with typed values; presets, factory
  and your own; fold, rename, duplicate, Delete; drag to reorder, Ctrl-drag to copy.
- Parameters are stored only where they differ from the default (fx/params.js), so devices
  can gain parameters without breaking saved sets. A knob gesture is one undo step.

Built (1.23.0): Production on the native engine.

- With Perform on Crate's engine (Settings, Audio engine: Native), Produce renders there too:
  over ASIO, WASAPI or Core Audio, mixed into the master with the decks, not in the browser.
  On the browser engine nothing changed (out-web.js is the old code, moved).
- engine.js keeps the clock, the scheduler and the set; the sound is an output with one
  shape: out-web.js (Web Audio) or out-native.js, which sends "s ..." lines to the engine
  (native/src/studio.cpp) and gets meters back 30 times a second.
- The engine's twelve devices (studio_fx.cpp) take the page's parameter names and defaults;
  tests/web/native_produce.js checks the two tables match. Where the browser leans on a node,
  the engine does it its own way: an 8-line feedback delay network for the reverb, and
  antiderivative anti-aliasing instead of oversampling for the shaping curves. Displays on
  the native engine draw from fx/response.js, the same biquad formulas.
- Clips start on their exact frame. The engine never allocates on the audio thread: routing
  is published as a whole graph and swapped; what it lets go of is freed on the control side.
- crate-engine --selftest checks the studio in CI on both builds: timing, warp, fades, each
  device, sends, bypass, rewiring while playing, and a 16-track set's cost.

Built (1.25.0): group tracks.

- A group is a track of kind "group"; its tracks carry `group: <id>` and follow it in the
  list, groups inside groups included. Its tracks play into its strip (devices, fader, pan,
  sends), and it plays into Main. Muting it mutes them; soloing it solos them; soloing one of
  them keeps the groups it plays through up.
- Ctrl/Shift-click track titles to pick several, Ctrl+G groups them, Ctrl+Shift+G ungroups.
  Groups fold in Clip view and the timeline; a group's slots launch its tracks' clips in that
  row, and its timeline lane shows their clips as slivers.
- On the native engine a "route" line sends a track into a group; tracks render deepest first.

Built (1.26.0): the menu bar.

- File, Edit, Create, View, Play, Library and Help across every tab, as a Windows program has
  them. What doesn't apply on the tab you're on is greyed, not hidden. Alt and a menu's letter
  opens it (holding Alt underlines the letters); once open, hover or Left/Right walks across.
- Every item calls the same function as its shortcut: Produce exposes `commands`, and its key
  handler goes through them. Exit and Full screen drive the app window (POST quit, fullscreen).

Built (1.27.0): MIDI clips, the piano roll and Crate FM.

- A MIDI clip holds notes {p, s, l, v} (pitch, start and length in beats, velocity 1–127),
  a length and a loop flag. Double-click an empty slot on a MIDI track, or an empty MIDI lane in
  the timeline, to make one; double-click a MIDI clip to open it below in the piano roll
  (Shift+Tab or the title strip switches between it and the devices). The engine schedules only
  the notes that start before its horizon, so edits are heard within a tick.
- The piano roll: draw (double-click, or B for draw mode), move, resize either end, Ctrl-drag to
  copy, marquee, arrows (Shift for octaves and bars), Ctrl+D repeats a selection a bar on, Ctrl+C/X/V,
  Ctrl+U quantises, velocity along the bottom, the loop's end dragged in the ruler, ×2 and /2,
  grids from 1/4 to 1/32 with triplets, Fold to the rows in use. The keys play.
- Clip slots work as Ableton's: the ▶ launches, the body selects.
- Instruments are devices with `instrument: true`: first in a MIDI track's chain, one per track.
  New MIDI tracks get Crate FM. Notes go to the native engine as `s note <id> <key> <pitch> <vel>
  <when> <length>` and start and stop on exact frames; `stop <id>` ends one early.
- Crate FM (native/synth/fm.hpp): four operators on band-limited wavetables that morph sine →
  triangle → saw → square → pulse → vowel, eight algorithms, feedback, unison to 7, sub, noise, a
  drivable state-variable filter (low 12/24, high, band, notch) with its own envelope, amp and mod
  envelopes, two LFOs (free or synced, per note or shared), a six-slot mod matrix, glide, mono and
  legato, distortion. No C library and no allocation: the same header builds into crate-engine
  and, by native/synth/make-wasm.sh, into fm.wasm, which the browser engine runs in an
  AudioWorklet. One sound on both engines.
- 100 presets by kind: plucks, leads, supersaws and chords, pads, basses, 808s, growls and
  wobbles, stabs, drawbar organs, keys and bells. All sit within 1.5 dB of one another
  (tests/web/instruments.js renders every one). In the device's menu and the browser's Instruments.

Built (1.28.0): Crate Additive, and native audio by default.

- Crate Additive (native/synth/additive.hpp): an organ layer and a harmonic layer, both from sines.
  The organ: nine drawbars at 16' to 1', 3 dB a step; single-trigger percussion on the 2nd or
  3rd harmonic, fast or slow, normal or soft, taking the 1' drawbar as the real one does; key
  click; the V1–V3 / C1–C3 scanner; tube drive; a rotary speaker whose horn and drum turn and
  change speed independently, heard by two microphones. The harmonic layer: up to 32 partials
  shaped by tilt, odd/even, stretch (piano to bell), a formant, damping (higher partials die
  first) and spread, with its own envelope. An LFO for vibrato, tremolo and spectral tilt.
- Every sine is a phasor turned by a complex multiply; spectra are rebuilt only when the pitch or
  settings change. Decaying values are flushed to zero before they become denormals (which made
  an early build cost 67% of a core; it's 4% for 16 voices with everything on).
- 100 presets: drawbar registrations for jazz, gospel, rock and soul; church and theatre organs;
  keys and bells; pads and choirs; plucks; basses; leads; textures. Balanced and checked by
  tests/web/instruments.js with Crate FM's.
- native/synth/parts.hpp holds what the synths share; make-wasm.sh builds one module per synth;
  studio_fx.cpp wraps any synth class as a device (SynthDevice<S>).
- The audio engine setting is now Automatic by default: Crate's native engine (ASIO, WASAPI or
  Core Audio) whenever it has a sound API, otherwise the browser's. Settings saved with the old
  default ("web") move to Automatic once; an explicit choice of either stays.

Next: the granular synth with 100 presets; a drum rack and sampler with 808 kits; a seed/node
synth in Synplant's manner and a modular builder; automation lanes; then VST3 hosting in the
engine, and Crate's instruments as VST3 plugins for Ableton. Also: WASAPI exclusive mode (RtAudio
only does shared mode, which adds the Windows mixer's period), and vectorising Crate FM's unison
for ARM Macs.
