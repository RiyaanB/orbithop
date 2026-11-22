// Unit tests for the pure game logic. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, Course, BotPilot, BOT_PROFILES, RACE_FINISH, DT, MAX_FLIGHT_TICKS, CENTER_X,
  makeRng, hashStr, mixSeed, wrapX, WRAP_MIN, WRAP_W, replay, predictTap, rankRacers,
  dateKey, dailyNumber, dailySeed, shareText, hopEmojis, formatTime, planetX, difficulty,
} from '../docs/js/core.js';

/** Play with a bot pilot; returns the game. */
function botRun(seed, key = 'ace', { finishAt = null, maxTicks = 60 * 240, maxHops = Infinity } = {}) {
  const g = new Game({ seed, finishAt });
  const bot = new BotPilot(key, mixSeed(seed, 3));
  while (g.alive && g.tick < maxTicks && g.hops < maxHops) {
    bot.control(g);
    g.step();
  }
  return g;
}

test('rng is deterministic and in range', () => {
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const sa = Array.from({ length: 50 }, a.next);
  const sb = Array.from({ length: 50 }, b.next);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, Array.from({ length: 50 }, c.next));
  for (const v of sa) assert.ok(v >= 0 && v < 1);
  const r = makeRng(7);
  for (let i = 0; i < 200; i++) {
    const n = r.int(2, 5);
    assert.ok(n >= 2 && n <= 5 && Number.isInteger(n));
  }
});

test('hashing and seed mixing are stable', () => {
  assert.equal(hashStr('orbit'), hashStr('orbit'));
  assert.notEqual(hashStr('orbit'), hashStr('orbiT'));
  assert.equal(mixSeed(1, 2, 3), mixSeed(1, 2, 3));
  assert.notEqual(mixSeed(1, 2, 3), mixSeed(3, 2, 1));
});

test('wrapX keeps asteroids inside the wrap band', () => {
  for (const x of [-1000, -260, 0, 619.9, 620, 5000]) {
    const w = wrapX(x);
    assert.ok(w >= WRAP_MIN && w < WRAP_MIN + WRAP_W, `${x} -> ${w}`);
  }
});

test('course generation is deterministic and independent of access order', () => {
  const a = new Course(1234), b = new Course(1234), c = new Course(999);
  // b generates lazily out of order
  b.gap(30);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(a.planet(i), b.planet(i));
    assert.deepEqual(a.gap(i), b.gap(i));
  }
  assert.notDeepEqual(a.planet(5), c.planet(5));
});

test('course is well formed: planets ascend, stay on screen, orbits do not overlap', () => {
  for (let s = 1; s <= 20; s++) {
    const c = new Course(mixSeed(s));
    for (let i = 1; i < 80; i++) {
      const p = c.planet(i), q = c.planet(i - 1);
      assert.ok(p.y > q.y, 'ascending');
      assert.ok(p.y - p.outer > q.y + q.outer, 'no overlap');
      assert.ok(p.x - p.amp >= 40 && p.x + p.amp <= 320, `planet ${i} on course: ${p.x}±${p.amp}`);
      assert.ok(p.orbitR > p.pr + 10, 'capture ring outside the body');
      const g = c.gap(i - 1);
      for (const a of g.asteroids) assert.ok(a.y > q.y + q.outer && a.y < p.y - p.outer, 'asteroids live in the gap');
    }
  }
});

test('difficulty ramps up with planet index', () => {
  assert.equal(difficulty(0), 0);
  assert.ok(difficulty(20) > difficulty(5));
  assert.equal(difficulty(500), 1);
  const c = new Course(77);
  const early = c.planet(3).decay, late = c.planet(60).decay;
  assert.ok(late < early, 'orbits decay faster later');
});

test('ship stays in orbit on the start planet until tapped', () => {
  const g = new Game({ seed: 5 });
  for (let i = 0; i < 60 * 30; i++) g.step();
  assert.equal(g.phase, 'orbit');
  assert.equal(g.planetIdx, 0);
  assert.equal(g.orbitRemaining(), Infinity);
});

test('a tap launches the ship tangentially at launch speed', () => {
  const g = new Game({ seed: 5 });
  g.step();
  g.tap();
  const ev = g.step();
  assert.equal(ev[0].type, 'launch');
  assert.equal(g.phase, 'flight');
  assert.ok(Math.abs(Math.hypot(g.vx, g.vy) - 330) < 1e-6);
  // velocity is perpendicular to the radius
  const p = g.course.planet(0);
  const rx = ev[0].x - p.x, ry = ev[0].y - p.y;
  assert.ok(Math.abs(rx * ev[0].vx + ry * ev[0].vy) < 1e-6);
});

test('idling on a later planet decays the orbit and burns up', () => {
  // launch at the best moment for planet 1, then never tap again
  const g = new Game({ seed: 11 });
  const bot = new BotPilot({ ...BOT_PROFILES.ace, blunder: 0, jitter: 0, margin: 0 }, 1);
  while (g.planetIdx === 0 && g.alive) {
    bot.control(g);
    g.step();
  }
  assert.equal(g.planetIdx, 1);
  let warned = false;
  while (g.alive) if (g.step().some((e) => e.type === 'warn')) warned = true;
  assert.equal(g.cause, 'burn');
  assert.ok(warned, 'warn event fired before burning up');
});

test('launching away from the course gets lost in space', () => {
  // find a moment where tapping heads away (downward/outward) and misses everything
  const g = new Game({ seed: 3 });
  let found = false;
  for (let k = 0; k < 200 && !found; k++) {
    const pr = predictTap(g, 0, MAX_FLIGHT_TICKS + 10);
    if (!pr.ok && pr.cause === 'lost') found = true;
    else g.step();
  }
  assert.ok(found);
  g.tap();
  while (g.alive) g.step();
  assert.equal(g.cause, 'lost');
  assert.equal(g.hops, 0);
});

test('capture scoring: hop points, perfect combos and hop log', () => {
  const g = botRun(mixSeed(21), 'ace', { maxHops: 8 });
  assert.ok(g.hops >= 8, `ace bot should reach 8 hops, got ${g.hops}`);
  assert.equal(g.hopLog.length > 0, true);
  assert.ok(g.perfects >= 1, 'ace bot lands some perfects');
  assert.ok(g.maxCombo >= 1);
  const minScore = g.hops * 10 + g.stars * 5;
  assert.ok(g.score >= minScore, 'score at least base hop + star points');
});

test('runs replay identically from (seed, taps)', () => {
  for (const s of [1, 2, 3, 4, 5]) {
    const g = botRun(mixSeed(s, 9), 'pro', { maxTicks: 60 * 60 });
    const sum = g.summary();
    const rep = replay(sum.seed, sum.taps, { maxTicks: sum.ticks + 5 });
    assert.equal(rep.score, sum.score);
    assert.equal(rep.hops, sum.hops);
    assert.equal(rep.stars, sum.stars);
    assert.equal(rep.hopLog, sum.hopLog);
    if (sum.phase === 'dead') {
      assert.equal(rep.cause, sum.cause);
      assert.equal(rep.ticks, sum.ticks);
    }
  }
});

test('prediction clones never mutate the real game', () => {
  const g = botRun(mixSeed(8), 'ace', { maxHops: 3 });
  const before = JSON.stringify({ ...g, course: null });
  predictTap(g, 2);
  predictTap(g, 0);
  assert.equal(JSON.stringify({ ...g, course: null }), before);
});

test('courses are solvable: a careful bot gets deep on many seeds', () => {
  const careful = { key: 'careful', jitter: 0, q: 0.15, blunder: 0, margin: 1, waitMin: 2, waitMax: 4 };
  const hops = [];
  for (let s = 1; s <= 25; s++) {
    const g = new Game({ seed: mixSeed(s, 1001) });
    const bot = new BotPilot(careful, s);
    while (g.alive && g.hops < 30) {
      bot.control(g);
      g.step();
    }
    hops.push(g.hops);
  }
  const reached = hops.filter((h) => h >= 30).length;
  assert.ok(reached >= 23, `careful bot reached 30 hops on ${reached}/25 seeds: ${hops}`);
});

test('bots are deterministic, ranked by skill, and can crash', () => {
  const N = 24;
  const res = {};
  for (const k of ['ace', 'pro', 'rookie']) {
    let total = 0, crashes = 0;
    for (let s = 1; s <= N; s++) {
      const g = botRun(mixSeed(s, 555), k, { finishAt: RACE_FINISH });
      total += g.hops;
      if (g.phase === 'dead') crashes++;
    }
    res[k] = { avg: total / N, crashes };
  }
  assert.ok(res.ace.avg > res.pro.avg && res.pro.avg > res.rookie.avg, JSON.stringify(res));
  assert.ok(res.rookie.crashes > N / 2, 'rookie crashes often');
  assert.ok(res.ace.crashes >= 1, 'even the ace bot can crash');
  const a = botRun(777, 'pro', { finishAt: RACE_FINISH }).summary();
  const b = botRun(777, 'pro', { finishAt: RACE_FINISH }).summary();
  assert.deepEqual(a, b);
});

test('race mode: reaching the finish planet ends the run as finished', () => {
  let finished = null;
  for (let s = 1; s <= 10 && !finished; s++) {
    const g = botRun(mixSeed(s, 4242), 'ace', { finishAt: RACE_FINISH });
    if (g.phase === 'finished') finished = g;
  }
  assert.ok(finished, 'ace finished at least one of 10 races');
  assert.ok(finished.planetIdx >= RACE_FINISH);
  assert.ok(finished.endTick > 0);
  assert.ok(finished.course.planet(RACE_FINISH).finish);
});

test('rankRacers orders finishers by time, then by distance', () => {
  const ranked = rankRacers([
    { name: 'A', phase: 'dead', hops: 10, ticks: 900 },
    { name: 'B', phase: 'finished', hops: 25, ticks: 1500 },
    { name: 'C', phase: 'finished', hops: 25, ticks: 1400 },
    { name: 'D', phase: 'dead', hops: 12, ticks: 800 },
    { name: 'E', phase: 'dead', hops: 10, ticks: 1000 },
  ]);
  assert.deepEqual(ranked.map((r) => r.name), ['C', 'B', 'D', 'E', 'A']);
  assert.deepEqual(ranked.map((r) => r.place), [1, 2, 3, 4, 5]);
});

test('daily helpers: key, number, seed', () => {
  assert.equal(dateKey(2026, 11, 21), '2026-11-21');
  assert.equal(dailyNumber('2026-11-21'), 1);
  assert.equal(dailyNumber('2026-12-02'), 12);
  assert.equal(dailyNumber('2027-01-01'), 42);
  assert.equal(dailySeed('2026-11-21'), dailySeed('2026-11-21'));
  assert.notEqual(dailySeed('2026-11-21'), dailySeed('2026-11-22'));
  // same daily seed => identical course for everyone
  const a = new Course(dailySeed('2026-11-25')), b = new Course(dailySeed('2026-11-25'));
  assert.deepEqual(a.planet(20), b.planet(20));
});

test('share text format', () => {
  const t = shareText({ num: 12, hops: 38, stars: 14, perfects: 9, maxCombo: 5, hopLog: 'PnnPPs', url: 'https://example.com/orbithop/' });
  const lines = t.split('\n');
  assert.equal(lines[0], 'Orbit Hop #12 🚀 38 hops ⭐14');
  assert.equal(lines[1], '✨ 9 perfect · best combo x5');
  assert.equal(lines[2], '🟨🟦🟦🟨🟨🟪💥');
  assert.equal(lines[3], 'https://example.com/orbithop/');
  const long = hopEmojis('P'.repeat(55));
  assert.ok(long.includes('+15'));
  assert.equal(long.split('\n').length, 5);
});

test('formatTime', () => {
  assert.equal(formatTime(60 * 23.4), '23.4s');
  assert.equal(formatTime(60 * 75), '1:15.0');
});

test('moving planets oscillate within their track', () => {
  const c = new Course(31337);
  let moving = null;
  for (let i = 1; i < 60 && !moving; i++) if (c.planet(i).amp) moving = c.planet(i);
  assert.ok(moving);
  for (let t = 0; t < 20; t += 0.37) {
    const x = planetX(moving, t);
    assert.ok(Math.abs(x - moving.x) <= moving.amp + 1e-9);
  }
  assert.equal(planetX(c.planet(0), 5), CENTER_X);
});

test('fixed timestep constant', () => {
  assert.equal(DT, 1 / 60);
});

test('early capture rings are wider, and bots react at human speed', () => {
  let early = 0, late = 0;
  for (let s = 1; s <= 30; s++) {
    const c = new Course(mixSeed(s, 31));
    early += c.planet(1).orbitR - c.planet(1).pr;
    late += c.planet(20).orbitR - c.planet(20).pr;
  }
  assert.ok(early / 30 > late / 30 + 10, `early ring margin ${early / 30} vs late ${late / 30}`);
  // bots wait at least ~0.35 s after arriving before looking for a launch, like a person would
  for (const p of Object.values(BOT_PROFILES)) assert.ok(p.waitMin / 60 >= 0.35, `${p.name} reacts in ${p.waitMin} ticks`);
});
