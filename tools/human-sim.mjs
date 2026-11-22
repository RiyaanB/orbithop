// Dev-only: simulate a human-like player against core.js to measure run length / difficulty curve.
// Model (from QA2): notices each capture after 220–370 ms. While the aim guide is shown at strength s
// (1 on the first planets, fading after), the player follows it with probability s: waits for green
// (taps simulated 9/13/17 ticks ahead all land) and taps 180–300 ms later. Otherwise they aim at the
// centre of the next landable window with Gaussian timing error σ (ms).
// Usage: node tools/human-sim.mjs [seeds=300] [sigmaMs=42,58]
import * as core from '../docs/js/core.js';
const { Game, predictTap, mixSeed, makeRng } = core;
const aimStrength = core.aimStrength || ((i) => (i < 5 ? 1 : 0));

const N = Number(process.argv[2] || 300);
const SIGMAS = (process.argv[3] || '42,58').split(',').map(Number);
const LEADS = [9, 13, 17];
const MAX_T = 60 * 120;

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
}
const lit = (g) => LEADS.every((d) => predictTap(g, d).ok);

/** Returns the tick (relative to now) the player taps on this planet, or null to never tap. */
function plan(g, rng, sigma) {
  const notice = Math.round(rng.range(220, 370) * 0.06);
  const useGuide = rng.next() < aimStrength(g.planetIdx);
  const c = g.clone(true);
  for (let k = 0; k < notice; k++) { c.step(); if (c.phase !== 'orbit') return 0; }
  let start = null;
  for (let k = notice; k < notice + 600; k++) {
    if (useGuide) {
      if (lit(c)) return k + Math.round(rng.range(180, 300) * 0.06);
    } else {
      const ok = predictTap(c, 0).ok;
      if (ok && start == null) start = k;
      if (!ok && start != null) return Math.max(0, Math.round((start + k - 1) / 2 + (gauss(rng) * sigma) * 0.06));
    }
    c.step();
    if (c.phase !== 'orbit') break;
  }
  if (start != null) return start; // window still open at horizon end
  return notice + 30; // nothing found: panic tap
}

const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const sigma of SIGMAS) {
  const hops = [], secs = [];
  let r5 = 0, r10 = 0, r15 = 0;
  for (let s = 1; s <= N; s++) {
    const g = new Game({ seed: mixSeed(s, 4242) });
    const rng = makeRng(mixSeed(s, 7, sigma));
    let target = null, planet = -1;
    while (g.alive && g.tick < MAX_T) {
      if (g.phase === 'orbit' && g.planetIdx !== planet) {
        planet = g.planetIdx;
        target = g.tick + plan(g, rng, sigma);
      }
      if (g.phase === 'orbit' && target != null && g.tick >= target) { g.tap(); target = null; }
      g.step();
    }
    hops.push(g.hops); secs.push(g.tick / 60);
    if (g.planetIdx >= 5 || g.hops >= 5) r5++;
    if (g.hops >= 10) r10++;
    if (g.hops >= 15) r15++;
  }
  const pct = (n) => `${Math.round((100 * n) / N)}%`;
  console.log(`σ ${sigma} ms: hops med ${med(hops)} | secs med ${med(secs).toFixed(1)} | ≥5 hops ${pct(r5)} ≥10 ${pct(r10)} ≥15 ${pct(r15)}`);
}
