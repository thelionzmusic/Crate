// Shared by Production's engine and both of its outputs: fader law and where clip audio lives.

export const UNITY = 0.85;  // the fader position for 0 dB
export const gainOf = (v) => (v / UNITY) ** 2;

export const srcKey = (src) => (src.kind === "track" ? `t${src.id}` : `s${src.f}:${src.p}`);
export const srcUrl = (src) => (src.kind === "track" ? `/api/audio/${src.id}` : `/api/sample?f=${src.f}&p=${encodeURIComponent(src.p)}`);
