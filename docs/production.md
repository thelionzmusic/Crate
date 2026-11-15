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

Next: devices (built-in effects, then VST3 hosting), sends to the returns, firing clips
from Perform with the kick sidechain, MIDI clips and instruments.
