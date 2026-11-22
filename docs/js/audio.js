// Chiptune-ish sound effects and a tiny looping soundtrack, all synthesised with WebAudio.
// No audio files. The context is created lazily on the first user gesture.

let ctx = null;
let master = null, sfxBus = null, musicBus = null;
let sfxOn = true, musicOn = true;
let noiseBuf = null;

function ensure() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxOn ? 0.55 : 0;
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return ctx;
}

export function unlock() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setSfx(on) {
  sfxOn = on;
  if (sfxBus) sfxBus.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.02);
}
export function setMusic(on) {
  musicOn = on;
  if (!on) stopMusic();
}
export const isSfx = () => sfxOn;
export const isMusic = () => musicOn;

function tone({ f = 440, f2 = null, type = 'square', dur = 0.12, vol = 0.3, at = 0, attack = 0.005, bus = sfxBus }) {
  if (!ctx || !sfxOn && bus === sfxBus) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ dur = 0.3, vol = 0.4, f = 1200, f2 = 200, at = 0, q = 0.8 }) {
  if (!ctx || !sfxOn) return;
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f, t);
  filt.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(sfxBus);
  src.start(t);
  src.stop(t + dur + 0.02);
}

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export const sfx = {
  click() {
    tone({ f: 660, f2: 880, type: 'square', dur: 0.06, vol: 0.12 });
  },
  launch() {
    tone({ f: 220, f2: 880, type: 'square', dur: 0.14, vol: 0.18 });
    noise({ dur: 0.18, vol: 0.12, f: 3000, f2: 400 });
  },
  capture(perfect, combo) {
    if (perfect) {
      // climbs the pentatonic scale as the combo grows
      const base = 72 + PENTA[Math.min(Math.max(combo, 1) - 1, 7)];
      [0, 4, 7, 12].forEach((iv, k) => tone({ f: NOTE(base + iv), type: 'square', dur: 0.1, vol: 0.14, at: k * 0.045 }));
      tone({ f: NOTE(base + 24), type: 'triangle', dur: 0.25, vol: 0.1, at: 0.18 });
    } else {
      tone({ f: NOTE(67), type: 'triangle', dur: 0.1, vol: 0.22 });
      tone({ f: NOTE(74), type: 'triangle', dur: 0.14, vol: 0.2, at: 0.06 });
    }
  },
  skip() {
    [0, 5, 9, 12, 17].forEach((n, k) => tone({ f: NOTE(70 + n), type: 'square', dur: 0.08, vol: 0.12, at: k * 0.04 }));
  },
  star() {
    tone({ f: NOTE(88), type: 'square', dur: 0.05, vol: 0.1 });
    tone({ f: NOTE(95), type: 'square', dur: 0.09, vol: 0.1, at: 0.05 });
  },
  warn() {
    tone({ f: 330, f2: 300, type: 'sawtooth', dur: 0.09, vol: 0.08 });
    tone({ f: 330, f2: 300, type: 'sawtooth', dur: 0.09, vol: 0.08, at: 0.14 });
  },
  crash() {
    noise({ dur: 0.7, vol: 0.55, f: 2400, f2: 60, q: 1.2 });
    tone({ f: 180, f2: 40, type: 'sawtooth', dur: 0.5, vol: 0.2 });
  },
  lost() {
    tone({ f: 600, f2: 90, type: 'triangle', dur: 0.9, vol: 0.18 });
  },
  botCrash() {
    noise({ dur: 0.25, vol: 0.12, f: 1500, f2: 100 });
  },
  count(go) {
    tone({ f: go ? NOTE(84) : NOTE(72), type: 'square', dur: go ? 0.3 : 0.12, vol: 0.16 });
  },
  win() {
    [60, 64, 67, 72, 76, 79, 84].forEach((n, k) => tone({ f: NOTE(n), type: 'square', dur: 0.14, vol: 0.13, at: k * 0.07 }));
  },
  best() {
    [72, 76, 79, 84].forEach((n, k) => tone({ f: NOTE(n), type: 'triangle', dur: 0.2, vol: 0.16, at: 0.25 + k * 0.09 }));
  },
};

// ------------------------------------------------------------------ music
// A 4-bar pentatonic arpeggio loop over a pulsing bass, scheduled with lookahead.
let musicTimer = null;
let nextNoteTime = 0;
let step = 0;
let intensity = 0;
const PROG = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [43, 50, 55, 59, 62], [40, 47, 52, 55, 59]];

export function setIntensity(v) {
  intensity = v;
}

export function startMusic() {
  if (!musicOn) return;
  const c = ensure();
  if (!c || musicTimer) return;
  musicBus.gain.cancelScheduledValues(c.currentTime);
  musicBus.gain.setTargetAtTime(0.32, c.currentTime, 0.4);
  nextNoteTime = c.currentTime + 0.05;
  step = 0;
  musicTimer = setInterval(schedule, 40);
}

export function stopMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = null;
  if (ctx && musicBus) musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
}

function schedule() {
  if (!ctx) return;
  const spb = 60 / (118 + intensity * 24) / 2; // eighth notes
  while (nextNoteTime < ctx.currentTime + 0.15) {
    const bar = Math.floor(step / 8) % 4;
    const chord = PROG[bar];
    const s8 = step % 8;
    const at = nextNoteTime - ctx.currentTime;
    if (s8 % 2 === 0) tone({ f: NOTE(chord[0] - 12), type: 'triangle', dur: spb * 1.6, vol: 0.22, at, bus: musicBus });
    const arp = [1, 2, 3, 4, 3, 2, 4, 1][s8];
    tone({ f: NOTE(chord[arp] + 12), type: 'square', dur: spb * 0.8, vol: 0.045 + intensity * 0.02, at, bus: musicBus });
    if (intensity > 0.3 && (s8 === 2 || s8 === 6)) {
      // soft hat
      const t = nextNoteTime;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(f).connect(g).connect(musicBus);
      src.start(t);
      src.stop(t + 0.06);
    }
    nextNoteTime += spb;
    step++;
  }
}

export function suspend() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}
export function resume() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
