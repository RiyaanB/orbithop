// Orbit Hop — pure, deterministic, isomorphic game logic.
// No DOM, no Date.now(), no Math.random(): everything derives from a seed and a tick counter,
// so a run is fully described by (seed, list of tap ticks) and can be replayed / verified
// identically in the browser, in Node tests, or on a future multiplayer server.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const CENTER_X = 180; // course is ~360 units wide, centred on x = 180
export const WRAP_MIN = -260; // asteroids wrap within [WRAP_MIN, WRAP_MIN + WRAP_W)
export const WRAP_W = 880;

export const SHIP_R = 5;
export const LAUNCH_SPEED = 330; // units / s
export const ORBIT_SPEED = 150; // tangential speed while orbiting (units / s)
export const MAX_OMEGA = 6.2; // rad / s cap so tiny orbits stay readable
export const MAX_FLIGHT_TICKS = Math.round(1.8 * TICK_RATE);
export const PERFECT_FRAC = 0.3; // aim offset / capture radius below this = PERFECT
export const DECAY_GRACE = 0.35; // seconds before an orbit starts to decay
export const STAR_PICK_R = 16;
export const WELL_CORE_R = 11;
export const WELL_RANGE = 230;
export const RACE_FINISH = 20; // vs-bots race: first to planet #20
export const MAX_COMBO_BONUS = 10;
export const EARLY_RING_BONUS = 14; // extra capture radius on planet 1, easing out to 0 by planet EARLY_RING_END
export const EARLY_RING_END = 30;
export const AIM_FULL = 5; // full-strength aim guide on planets 0..AIM_FULL-1
export const AIM_FADE_END = 9; // guide fades out over planets AIM_FULL..AIM_FADE_END-1, then a plain stub

// ---------------------------------------------------------------- RNG / hashing

/** FNV-1a 32-bit string hash → uint32. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix several integers into one well-scrambled uint32 (murmur-ish finaliser). */
export function mixSeed(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= (p >>> 0) + 0x7f4a7c15 + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** mulberry32 PRNG wrapped with helpers. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapX = (x) => ((((x - WRAP_MIN) % WRAP_W) + WRAP_W) % WRAP_W) + WRAP_MIN;

/** Difficulty 0..1 as a function of planet index. */
export const difficulty = (i) => clamp((i - 1) / 40, 0, 1);

/** Extra capture radius for planet i: smooth ease-out so rings narrow gradually, not in one step. */
export function earlyRingBonus(i) {
  const t = clamp((i - 1) / (EARLY_RING_END - 1), 0, 1);
  return EARLY_RING_BONUS * (1 - t * t * (3 - 2 * t));
}

/** Aim-guide strength while orbiting planet i: 1 on the first planets, then fades 0.8/0.6/0.4/0.2, then 0. */
export function aimStrength(i) {
  if (i < AIM_FULL) return 1;
  if (i >= AIM_FADE_END) return 0;
  return 1 - (i - AIM_FULL + 1) / (AIM_FADE_END - AIM_FULL + 1);
}

// ---------------------------------------------------------------- Course generation

/**
 * Infinite, lazily generated course. Planet i and the gap (obstacles) between planet i and i+1
 * are pure functions of (seed, i) plus the previous planet, generated strictly in order.
 */
export class Course {
  constructor(seed, { finishAt = null } = {}) {
    this.seed = seed >>> 0;
    this.finishAt = finishAt;
    this.planets = [];
    this.gaps = [];
  }

  planet(i) {
    while (this.planets.length <= i) this._genPlanet(this.planets.length);
    return this.planets[i];
  }

  gap(i) {
    if (i < 0) return EMPTY_GAP;
    while (this.gaps.length <= i) {
      const g = this.gaps.length;
      this.planet(g + 1);
      this.gaps.push(this._genGap(g));
    }
    return this.gaps[i];
  }

  _genPlanet(i) {
    const rng = makeRng(mixSeed(this.seed, i, 0xa11ce));
    const d = difficulty(i);
    const palette = rng.int(0, 7);
    const style = rng.int(0, 3);
    if (i === 0) {
      this.planets.push({
        i, x: CENTER_X, y: 0, pr: 24, orbitR: 54, outer: 54, decay: Infinity,
        amp: 0, freq: 0, phase: 0, moon: null, palette, style, finish: false, rings: false,
      });
      return;
    }
    const prev = this.planets[i - 1];
    const pr = rng.range(15, 25) - 3 * d;
    // the first few capture rings are wider so a new player's first hops are forgiving
    const orbitR = pr + rng.range(25, 34) - 8 * d + earlyRingBonus(i);
    let amp = 0, freq = 0, phase = 0;
    if (i >= 5 && rng.chance(0.22 + 0.5 * d)) {
      amp = rng.range(22, 36 + 30 * d);
      freq = rng.range(0.55, 0.9 + 0.8 * d) * rng.sign();
      phase = rng.range(0, Math.PI * 2);
    }
    let moon = null;
    if (i >= 8 && rng.chance(0.14 + 0.42 * d)) {
      const mr = rng.range(5, 7.5);
      moon = {
        r: mr,
        ringR: orbitR + rng.range(14, 20),
        w: rng.range(0.9, 1.5 + 0.9 * d) * rng.sign(),
        phase: rng.range(0, Math.PI * 2),
      };
    }
    const outer = moon ? moon.ringR + moon.r : orbitR;
    const lo = 58 + amp, hi = 302 - amp;
    let x = rng.range(lo, hi);
    // avoid long straight stacks: nudge if almost directly above the previous planet
    if (Math.abs(x - prev.x) < 26) x = clamp(x + (x < CENTER_X ? 40 : -40), lo, hi);
    const gapClear = rng.range(52, 84) + 58 * d;
    const y = prev.y + prev.outer + gapClear + outer;
    const decay = (i <= 2 ? 7 : lerp(5.4, 2.5, d)) + rng.range(-0.3, 0.5);
    const finish = this.finishAt != null && i === this.finishAt;
    this.planets.push({
      i, x, y, pr, orbitR, outer, decay, amp, freq, phase, moon, palette, style, finish,
      rings: !moon && rng.chance(0.18),
    });
  }

  _genGap(i) {
    const rng = makeRng(mixSeed(this.seed, i, 0xb0a7));
    const d = difficulty(i + 1);
    const p = this.planets[i], q = this.planets[i + 1];
    const yLo = p.y + p.outer + 10, yHi = q.y - q.outer - 10;
    const h = yHi - yLo;
    const asteroids = [], wells = [], stars = [];
    const finishGap = this.finishAt != null && i >= this.finishAt;
    if (!finishGap && i >= 3 && h > 24 && rng.chance(0.3 + 0.55 * d)) {
      const bands = h > 90 && d > 0.45 && rng.chance(0.5) ? 2 : 1;
      for (let b = 0; b < bands; b++) {
        const y = bands === 1 ? yLo + h * rng.range(0.35, 0.65) : yLo + h * (b === 0 ? rng.range(0.2, 0.35) : rng.range(0.65, 0.8));
        const n = rng.int(1, 2 + Math.round(2 * d));
        const vx = rng.range(40, 70 + 75 * d) * (b === 0 ? rng.sign() : -Math.sign(asteroids[0]?.vx || 1));
        const base = rng.range(0, WRAP_W);
        for (let k = 0; k < n; k++) {
          asteroids.push({
            y,
            x0: wrapX(WRAP_MIN + base + (WRAP_W / n) * k + rng.range(-50, 50)),
            vx,
            r: rng.range(7, 10.5 + 3 * d),
            rot: rng.range(0, Math.PI * 2),
            spin: rng.range(-2, 2),
            shape: rng.int(0, 1e6),
          });
        }
      }
    }
    if (!finishGap && i >= 10 && rng.chance(0.12 + 0.34 * d)) {
      const side = rng.sign();
      wells.push({
        x: CENTER_X + side * rng.range(110, 165),
        y: yLo + h * rng.range(0.3, 0.7),
        g: rng.range(0.55, 0.95 + 0.5 * d) * 1e6,
      });
    }
    if (!finishGap) {
      const n = rng.chance(0.55) ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? rng.range(0.4, 0.6) : (k === 0 ? rng.range(0.3, 0.45) : rng.range(0.55, 0.7));
        const off = rng.range(-14, 14);
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const sx = p.x + dx * f - (dy / len) * off;
        const sy = p.y + dy * f + (dx / len) * off;
        if (wells.some((w) => Math.hypot(w.x - sx, w.y - sy) < 40)) continue;
        stars.push({ id: i * 8 + k, x: sx, y: sy });
      }
      if (i >= 2 && rng.chance(0.3)) {
        // a risky bonus star off the direct line
        const sx = clamp(lerp(p.x, q.x, 0.5) + rng.sign() * rng.range(60, 100), 30, 330);
        const sy = yLo + h * rng.range(0.3, 0.7);
        if (!wells.some((w) => Math.hypot(w.x - sx, w.y - sy) < 40)) stars.push({ id: i * 8 + 5, x: sx, y: sy });
      }
    }
    return { i, yLo, yHi, asteroids, wells, stars };
  }
}

const EMPTY_GAP = Object.freeze({ i: -1, yLo: 0, yHi: 0, asteroids: [], wells: [], stars: [] });

// ---------------------------------------------------------------- Kinematics of course objects

export function planetX(p, t) {
  return p.amp ? p.x + p.amp * Math.sin(p.phase + t * p.freq) : p.x;
}
export function moonPos(p, t) {
  const px = planetX(p, t);
  const a = p.moon.phase + t * p.moon.w;
  return { x: px + p.moon.ringR * Math.cos(a), y: p.y + p.moon.ringR * Math.sin(a) };
}
export function asteroidX(a, t) {
  return wrapX(a.x0 + a.vx * t);
}

// ---------------------------------------------------------------- Simulation

export const CAUSES = {
  burn: 'Orbit decayed — burned up',
  lost: 'Lost in deep space',
  asteroid: 'Smashed into an asteroid',
  moon: 'Clipped a moon',
  well: 'Swallowed by a gravity well',
};

/**
 * One ship on one course. Call tap() any time; step() advances exactly one fixed tick and
 * returns the list of events that happened during it (for rendering / audio).
 */
export class Game {
  constructor({ seed = 1, finishAt = null, course = null } = {}) {
    this.seed = seed >>> 0;
    this.course = course || new Course(this.seed, { finishAt });
    this.finishAt = this.course.finishAt;
    this.tick = 0;
    this.phase = 'orbit'; // orbit | flight | dead | finished
    this.planetIdx = 0;
    this.angle = -Math.PI / 2;
    this.dir = 1;
    this.r = this.course.planet(0).orbitR;
    this.orbitTicks = 0;
    this.flightTicks = 0;
    const p0 = this.course.planet(0);
    this.x = p0.x + this.r * Math.cos(this.angle);
    this.y = p0.y + this.r * Math.sin(this.angle);
    this.vx = 0;
    this.vy = 0;
    this.hops = 0;
    this.stars = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfects = 0;
    this.lastQ = 1;
    this.warned = false;
    this.hopLog = ''; // one char per landing: P = perfect, n = normal, s = skip (multi-planet hop)
    this.collected = {};
    this.taps = [];
    this.tapQueued = false;
    this.cause = null;
    this.endTick = null;
    this.predict = false; // true on throw-away clones used for bot look-ahead
  }

  get t() {
    return this.tick * DT;
  }
  get alive() {
    return this.phase === 'orbit' || this.phase === 'flight';
  }
  get done() {
    return !this.alive;
  }

  clone(predict = true) {
    const g = Object.create(Game.prototype);
    Object.assign(g, this);
    g.predict = predict;
    g.taps = predict ? [] : this.taps.slice();
    g.collected = predict ? this.collected : { ...this.collected };
    return g;
  }

  planetPos(i, tick = this.tick) {
    const p = this.course.planet(i);
    return { x: planetX(p, tick * DT), y: p.y };
  }

  /** Seconds left before the current orbit decays into the planet (Infinity on the start planet). */
  orbitRemaining() {
    if (this.phase !== 'orbit') return Infinity;
    const p = this.course.planet(this.planetIdx);
    if (!isFinite(p.decay)) return Infinity;
    return Math.max(0, DECAY_GRACE + p.decay - this.orbitTicks * DT);
  }

  /** Orbit progress 0 (fresh) .. 1 (about to burn up). */
  decayFrac() {
    const p = this.course.planet(this.planetIdx);
    if (this.phase !== 'orbit' || !isFinite(p.decay)) return 0;
    return clamp((this.orbitTicks * DT - DECAY_GRACE) / p.decay, 0, 1);
  }

  tap() {
    if (this.alive) this.tapQueued = true;
  }

  step() {
    const ev = [];
    if (!this.alive) return ev;
    if (this.tapQueued) {
      this.tapQueued = false;
      if (this.phase === 'orbit') this._launch(ev);
    }
    this.tick++;
    const t = this.tick * DT;
    if (this.phase === 'orbit') this._stepOrbit(t, ev);
    else this._stepFlight(t, ev);
    return ev;
  }

  _launch(ev) {
    const tx = -Math.sin(this.angle) * this.dir;
    const ty = Math.cos(this.angle) * this.dir;
    this.vx = tx * LAUNCH_SPEED;
    this.vy = ty * LAUNCH_SPEED;
    this.phase = 'flight';
    this.flightTicks = 0;
    if (!this.predict) this.taps.push(this.tick);
    ev.push({ type: 'launch', x: this.x, y: this.y, vx: this.vx, vy: this.vy });
  }

  _stepOrbit(t, ev) {
    const p = this.course.planet(this.planetIdx);
    this.orbitTicks++;
    const frac = this.decayFrac();
    const minR = p.pr + 2;
    this.r = lerp(p.orbitR, minR, frac * frac * 0.35 + frac * 0.65);
    const omega = Math.min(MAX_OMEGA, ORBIT_SPEED / this.r);
    this.angle += this.dir * omega * DT;
    if (this.angle > Math.PI) this.angle -= Math.PI * 2;
    else if (this.angle < -Math.PI) this.angle += Math.PI * 2;
    const px = planetX(p, t);
    this.x = px + this.r * Math.cos(this.angle);
    this.y = p.y + this.r * Math.sin(this.angle);
    if (!this.warned && this.orbitRemaining() < 1.1) {
      this.warned = true;
      ev.push({ type: 'warn' });
    }
    if (frac >= 1) this._die('burn', ev);
  }

  _stepFlight(t, ev) {
    const c = this.course;
    const pi = this.planetIdx;
    // gravity wells bend the flight path
    for (let gi = pi - 1; gi <= pi + 2; gi++) {
      for (const w of c.gap(gi).wells) {
        const dx = w.x - this.x, dy = w.y - this.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > WELL_RANGE * WELL_RANGE) continue;
        const d = Math.sqrt(d2);
        if (d < WELL_CORE_R + SHIP_R) return this._die('well', ev);
        const fade = 1 - d / WELL_RANGE;
        const a = (w.g / (d2 + 400)) * fade;
        this.vx += (dx / d) * a * DT;
        this.vy += (dy / d) * a * DT;
      }
    }
    this.x += this.vx * DT;
    this.y += this.vy * DT;
    this.flightTicks++;

    // hazards
    for (let gi = pi - 1; gi <= pi + 2; gi++) {
      const g = c.gap(gi);
      for (const a of g.asteroids) {
        const ax = asteroidX(a, t);
        const rr = a.r + SHIP_R - 1;
        if (Math.abs(ax - this.x) < rr && Math.abs(a.y - this.y) < rr && (ax - this.x) ** 2 + (a.y - this.y) ** 2 < rr * rr) {
          return this._die('asteroid', ev);
        }
      }
      if (!this.predict) {
        for (const s of g.stars) {
          if (this.collected[s.id]) continue;
          if ((s.x - this.x) ** 2 + (s.y - this.y) ** 2 < STAR_PICK_R * STAR_PICK_R) {
            this.collected[s.id] = true;
            this.stars++;
            this.score += 5;
            ev.push({ type: 'star', x: s.x, y: s.y, id: s.id });
          }
        }
      }
    }
    for (let j = Math.max(0, pi - 1); j <= pi + 3; j++) {
      const p = c.planet(j);
      if (p.moon) {
        const m = moonPos(p, t);
        const rr = p.moon.r + SHIP_R - 1;
        if ((m.x - this.x) ** 2 + (m.y - this.y) ** 2 < rr * rr) return this._die('moon', ev);
      }
    }
    // capture by a planet ahead
    for (let j = pi + 1; j <= pi + 3; j++) {
      const p = c.planet(j);
      const px = planetX(p, t);
      const rx = px - this.x, ry = p.y - this.y;
      const d2 = rx * rx + ry * ry;
      if (d2 <= p.orbitR * p.orbitR) return this._capture(j, px, rx, ry, ev);
    }
    // drifting away?
    const cur = c.planet(pi);
    if (this.flightTicks > MAX_FLIGHT_TICKS || Math.abs(this.x - CENTER_X) > 300 || this.y < cur.y - 200) {
      this._die('lost', ev);
    }
  }

  _capture(j, px, rx, ry, ev) {
    const p = this.course.planet(j);
    const sp = Math.hypot(this.vx, this.vy) || 1;
    // perpendicular distance from the planet centre to the flight line, relative to capture radius
    const off = Math.abs(rx * this.vy - ry * this.vx) / sp;
    const q = off / p.orbitR;
    const perfect = q < PERFECT_FRAC;
    const adv = j - this.planetIdx;
    this.hops += adv;
    let points = 10 * adv + 15 * (adv - 1);
    if (perfect) {
      this.combo++;
      this.perfects++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      points += 5 * Math.min(this.combo, MAX_COMBO_BONUS);
    } else {
      this.combo = 0;
    }
    this.score += points;
    this.hopLog += adv > 1 ? 's' : perfect ? 'P' : 'n';
    this.lastQ = q;
    // enter orbit where we crossed the capture circle, turning the same way we were travelling
    const sx = this.x - px, sy = this.y - p.y;
    const L = sx * this.vy - sy * this.vx;
    this.dir = L >= 0 ? 1 : -1;
    this.angle = Math.atan2(sy, sx);
    this.r = p.orbitR;
    this.planetIdx = j;
    this.phase = 'orbit';
    this.orbitTicks = 0;
    this.warned = false;
    this.x = px + this.r * Math.cos(this.angle);
    this.y = p.y + this.r * Math.sin(this.angle);
    ev.push({ type: 'capture', planet: j, x: this.x, y: this.y, perfect, combo: this.combo, points, skip: adv > 1, q });
    if (this.finishAt != null && j >= this.finishAt) {
      this.phase = 'finished';
      this.endTick = this.tick;
      ev.push({ type: 'finish', tick: this.tick });
    }
  }

  _die(cause, ev) {
    this.phase = 'dead';
    this.cause = cause;
    this.endTick = this.tick;
    this.combo = 0;
    ev.push({ type: 'crash', cause, x: this.x, y: this.y, vx: this.vx, vy: this.vy });
  }

  summary() {
    return {
      seed: this.seed,
      score: this.score,
      hops: this.hops,
      stars: this.stars,
      perfects: this.perfects,
      maxCombo: this.maxCombo,
      ticks: this.endTick ?? this.tick,
      phase: this.phase,
      cause: this.cause,
      hopLog: this.hopLog,
      taps: this.taps.slice(),
    };
  }
}

/** Re-simulate a run from its seed and tap ticks (verification / ghosts). */
export function replay(seed, taps, { finishAt = null, maxTicks = 60 * 60 * 10 } = {}) {
  const g = new Game({ seed, finishAt });
  let k = 0;
  while (g.alive && g.tick < maxTicks) {
    while (k < taps.length && taps[k] <= g.tick) {
      if (taps[k] === g.tick) g.tap();
      k++;
    }
    g.step();
    if (k >= taps.length && g.phase === 'orbit' && !isFinite(g.orbitRemaining())) break; // idle on start planet
  }
  return g.summary();
}

// ---------------------------------------------------------------- Bots

// waitMin/waitMax: ticks between arriving in an orbit and starting to look for a launch — a human-like
// reaction time (0.35–1.1 s), so a good human player can genuinely out-race BOT Vega.
export const BOT_PROFILES = {
  ace: { key: 'ace', name: 'Vega', jitter: 1, q: 0.2, blunder: 0.035, margin: 1, waitMin: 21, waitMax: 40, color: '#ff7ad9' },
  pro: { key: 'pro', name: 'Orion', jitter: 2, q: 0.25, blunder: 0.03, margin: 1, waitMin: 26, waitMax: 52, color: '#7cf0a8' },
  rookie: { key: 'rookie', name: 'Pip', jitter: 2, q: 0.35, blunder: 0.06, margin: 0, waitMin: 30, waitMax: 66, color: '#ffb35c' },
};

/** Look ahead: what happens if we wait `delay` ticks and then tap? */
export function predictTap(game, delay = 0, maxTicks = 150) {
  const g = game.clone(true);
  for (let k = 0; k < delay; k++) {
    g.step();
    if (g.phase !== 'orbit') return { ok: false, q: 1 };
  }
  const from = g.planetIdx;
  g.tap();
  for (let k = 0; k < maxTicks; k++) {
    g.step();
    if (g.phase === 'dead') return { ok: false, q: 1, cause: g.cause };
    if (g.planetIdx !== from) return { ok: true, q: g.lastQ, to: g.planetIdx, ticks: k };
  }
  return { ok: false, q: 1 };
}

/**
 * Imperfect bot pilot. Deterministic given (seed, profile). It looks ahead to find a launch that
 * lands, but its actual tap lands up to ±jitter ticks off, it sometimes blunders, and it can
 * dither too long on decaying orbits — so bots genuinely crash.
 */
export class BotPilot {
  constructor(profile, seed) {
    this.p = typeof profile === 'string' ? BOT_PROFILES[profile] : profile;
    this.rng = makeRng(seed >>> 0);
    this.pending = null;
    this.lastPlanet = -1;
    this.waitUntil = 0;
    this.blunderNow = false;
  }

  control(game) {
    if (game.phase !== 'orbit') {
      this.pending = null;
      return;
    }
    const p = this.p;
    if (game.planetIdx !== this.lastPlanet) {
      this.lastPlanet = game.planetIdx;
      this.waitUntil = game.tick + this.rng.int(p.waitMin, p.waitMax);
      this.blunderNow = game.planetIdx > 0 && this.rng.chance(p.blunder);
      this.pending = null;
    }
    if (this.pending !== null) {
      if (game.tick >= this.pending) {
        game.tap();
        this.pending = null;
      }
      return;
    }
    if (game.tick < this.waitUntil) return;
    if (this.blunderNow) {
      this.pending = game.tick + this.rng.int(0, 20);
      return;
    }
    const J = p.jitter;
    const rem = game.orbitRemaining();
    const period = (Math.PI * 2) / Math.min(MAX_OMEGA, ORBIT_SPEED / game.r);
    let ev = predictTap(game, J);
    // careful pilots also check that being a tick early/late would still land
    if (ev.ok && p.margin) {
      for (let dd = Math.max(0, J - p.margin); dd <= J + p.margin; dd++) {
        if (dd === J) continue;
        const e2 = predictTap(game, dd);
        if (!e2.ok) { ev = { ok: false, q: 1 }; break; }
      }
      if (!ev.ok && rem < 0.5) ev = predictTap(game, J); // no time to be picky
    }
    // accept a looser aim as the orbit decays (less than ~one lap left → take what you can get)
    const thr = rem < period * 0.8 ? 1.01 : rem < period * 1.4 ? Math.max(p.q, 0.65) : p.q;
    if (ev.ok && ev.q <= thr) {
      this.pending = game.tick + J + this.rng.int(-J, J);
      if (this.pending <= game.tick) {
        game.tap();
        this.pending = null;
      }
    }
  }
}

// ---------------------------------------------------------------- Race ranking

/** Rank racers: finishers by finish tick, then by planets reached, then by survival time. */
export function rankRacers(racers) {
  return racers
    .map((r) => ({ ...r }))
    .sort((a, b) => {
      const af = a.phase === 'finished', bf = b.phase === 'finished';
      if (af !== bf) return af ? -1 : 1;
      if (af && bf) return a.ticks - b.ticks || (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0);
      if (a.hops !== b.hops) return b.hops - a.hops;
      return b.ticks - a.ticks;
    })
    .map((r, k) => ({ ...r, place: k + 1 }));
}

// ---------------------------------------------------------------- Daily & sharing

const DAILY_EPOCH = Date.UTC(2026, 10, 21); // Orbit Hop #1 = 2026-11-21

/** Local calendar date → 'YYYY-MM-DD' (pass the components so the module stays clock-free). */
export function dateKey(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function dailyNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - DAILY_EPOCH) / 86400000) + 1;
}
export function dailySeed(key) {
  return hashStr('orbithop-daily-' + key);
}

export function hopEmojis(hopLog, crashed = true, max = 40) {
  const map = { P: '🟨', n: '🟦', s: '🟪' };
  let chars = [...hopLog].slice(0, max).map((c) => map[c] || '🟦');
  if (hopLog.length > max) chars.push(`+${hopLog.length - max}`);
  if (crashed) chars.push('💥');
  const lines = [];
  for (let i = 0; i < chars.length; i += 10) lines.push(chars.slice(i, i + 10).join(''));
  return lines.join('\n');
}

export function shareText({ num, hops, stars, perfects, maxCombo, hopLog, crashed = true, url = '' }) {
  const lines = [`Orbit Hop #${num} 🚀 ${hops} hops ⭐${stars}`];
  lines.push(`✨ ${perfects} perfect · best combo x${maxCombo}`);
  lines.push(hopEmojis(hopLog, crashed));
  if (url) lines.push(url);
  return lines.join('\n');
}

export function formatTime(ticks) {
  const s = ticks / TICK_RATE;
  return s < 60 ? s.toFixed(1) + 's' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
