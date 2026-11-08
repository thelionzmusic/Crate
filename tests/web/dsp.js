// Deck processor, rendered offline: key lock keeps pitch, vinyl shifts it, nothing clicks.
// Run against a running Crate:  python run_crate.py --headless --port 47800
//                               BASE=http://127.0.0.1:47800 node tests/web/dsp.js
// Needs Node with Playwright and Chromium.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(`${BASE}/`); await p.waitForTimeout(800);
  const r = await p.evaluate(async () => {
    const sr = 44100, secs = 6, ctxFor = () => new OfflineAudioContext(2, sr * 3, sr);
    const tone = new Int16Array(sr * secs * 2);
    for (let i = 0; i < sr * secs; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 0.5 * 32767); tone[2 * i] = v; tone[2 * i + 1] = v; }
    // count zero crossings -> frequency; largest jump between samples relative to a clean sine's
    const analyse = (x) => { let zc = 0, jump = 0; for (let i = sr / 2 + 1; i < x.length - 10; i++) { if ((x[i - 1] < 0) !== (x[i] < 0)) zc++; jump = Math.max(jump, Math.abs(x[i] - x[i - 1])); } return { hz: +(zc / 2 / ((x.length - 10 - sr / 2) / sr)).toFixed(1), jump: +jump.toFixed(4) }; };
    async function run(rate, keylock, loop) {
      const ctx = ctxFor(); await ctx.audioWorklet.addModule('/js/engine/deck.worklet.js');
      const init = [{ type: 'load', pcm: tone, at: 0 }, { type: 'keylock', on: keylock }, { type: 'rate', rate, now: true }, ...(loop ? [{ type: 'loop', loop }] : []), { type: 'play' }];
      const n = new AudioWorkletNode(ctx, 'crate-deck', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { init } }); n.connect(ctx.destination);
      const buf = await ctx.startRendering(); return analyse(buf.getChannelData(0));
    }
    const clean = 2 * Math.PI * 440 / sr * 0.5;  // biggest step a clean 440 Hz sine at half scale takes
    return { cleanStep: +clean.toFixed(4), vinyl108: await run(1.08, false), keylock108: await run(1.08, true), keylock092: await run(0.92, true), loopHalfBeat: await run(1, false, [10000, 10000 + 100 * 3]) };
  });
  console.log(JSON.stringify(r, null, 1)); await b.close();
})();
