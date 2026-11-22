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

Next: MIDI clips and the piano roll (double-click a MIDI clip); then Crate's own instruments on
the native engine: an FM synth, an additive (drawbar) synth and a granular synth with 100
presets each, 808s and a drum rack, a seed/node synth and a modular builder; then VST3 hosting
in the engine, and Crate's instruments built as VST3 plugins so they load in Ableton.
