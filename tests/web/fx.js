// Effects, rendered offline: each one must do what its name says.
// Run against a running Crate:  BASE=http://127.0.0.1:47800 node tests/web/fx.js
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(`${BASE}/`); await p.waitForTimeout(800);
  const r = await p.evaluate(async () => {
    const { EFFECTS } = await import('/js/engine/fx.js');
    const sr = 48000, secs = 2.5;
    async function render(type, settings, signal) {
      const ctx = new OfflineAudioContext(2, sr * secs, sr);
      await ctx.audioWorklet.addModule('/js/engine/fx.worklet.js');
      const fx = EFFECTS[type].build(ctx), src = ctx.createBufferSource(), buf = ctx.createBuffer(2, sr * secs, sr);
      for (let c = 0; c < 2; c++) buf.getChannelData(c).set(signal);
      src.buffer = buf; src.connect(fx.input); fx.output.connect(ctx.destination);
      fx.update({ p1: 0.5, p2: 0.6, beats: 1, bpm: 120, ...settings }); src.start();
      const out = await ctx.startRendering(); return [out.getChannelData(0), out.getChannelData(1)];
    }
    const n = sr * secs, impulse = new Float32Array(n), tone = new Float32Array(n), noise = new Float32Array(n);
    impulse[0] = 1;
    for (let i = 0; i < n; i++) { tone[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr); noise[i] = (Math.random() * 2 - 1) * 0.3; }
    const peakAt = (x, a, b) => { let m = 0, at = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) if (Math.abs(x[i]) > m) { m = Math.abs(x[i]); at = i; } return [at / sr, m]; };
    const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
    const corr = (x, y) => { let a = 0, b2 = 0, c = 0; for (let i = sr; i < 2 * sr; i++) { a += x[i] * y[i]; b2 += x[i] * x[i]; c += y[i] * y[i]; } return a / Math.sqrt(b2 * c); };
    const out = {};
    // echo: one beat at 120 BPM = 0.5 s, so the first repeat lands there
    { const [L] = await render('echo', {}, impulse); out.echo = peakAt(L, 0.3, 0.7)[0].toFixed(3); }
    // ping pong: first repeat on the left at 0.5 s, then the right at 1.0 s
    { const [L, R] = await render('pingpong', { p1: 0.8 }, impulse); out.pingpong = [peakAt(L, 0.3, 0.7)[0].toFixed(2), peakAt(R, 0.8, 1.2)[0].toFixed(2)].join(' / '); }
    // reverb: an impulse leaves a tail half a second later
    { const [L] = await render('reverb', {}, impulse); out.reverbTail = rms(L, 0.5 * sr, 0.6 * sr).toExponential(1); }
    // gater: depth 1 at 1/4 beat cuts a steady tone on and off 8 times a second
    { const [L] = await render('gater', { p1: 1, p2: 0, beats: 0.25 }, tone); const w = sr / 64, lv = []; for (let i = sr; i < 2 * sr; i += w) lv.push(rms(L, i, i + w)); out.gaterRange = (Math.max(...lv) / Math.max(1e-6, Math.min(...lv))).toFixed(1); }
    // crusher: at full Bits the tone collapses to a handful of levels
    { const [L] = await render('crusher', { p1: 1, p2: 0 }, tone); out.crusherLevels = new Set(Array.from(L.subarray(sr, 2 * sr), (v) => v.toFixed(4))).size; }
    // modulation effects change the sound measurably
    for (const k of ['flanger', 'autofilter']) { const [L] = await render(k, { p1: 1 }, noise); out[k] = corr(L, noise).toFixed(2); }
    // phaser: notches sweep through a tone, so its level rises and falls over a cycle
    { const t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = 0.5 * Math.sin(2 * Math.PI * 600 * i / sr);
      const [L] = await render('phaser', { p1: 1, p2: 0.6, beats: 1 }, t); const w = sr / 50, lv = []; for (let i = sr / 2; i < 2 * sr; i += w) lv.push(rms(L, i, i + w));
      out.phaserRange = (Math.max(...lv) / Math.max(1e-6, Math.min(...lv))).toFixed(1); }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  const ok = r.echo > 0.49 && r.echo < 0.51 && r.pingpong.startsWith('0.50 / 1.00') && +r.reverbTail > 1e-4 && +r.gaterRange > 10 && r.crusherLevels <= 9
    && +r.phaserRange > 2 && ['flanger', 'autofilter'].every((k) => +r[k] < 0.9);
  console.log(ok ? 'all passed' : 'FAILED'); await b.close(); process.exit(ok ? 0 : 1);
})();
