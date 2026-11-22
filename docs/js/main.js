// App shell: screens, input, fixed-timestep loop, modes, persistence, sharing.
import {
  Game, Course, BotPilot, BOT_PROFILES, DT, RACE_FINISH, CAUSES, PERFECT_FRAC,
  dateKey, dailyNumber, dailySeed, shareText, rankRacers, formatTime, mixSeed, difficulty, predictTap, aimStrength,
} from './core.js';
import { Renderer } from './render.js';
import * as audio from './audio.js';
import { load, save, prevDayKey } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = load();
const params = new URLSearchParams(location.search);

const canvas = $('#game');
const R = new Renderer(canvas);

const BOT_KEYS = ['ace', 'pro', 'rookie'];
const isTouch = matchMedia('(hover: none)').matches;
/** Move keyboard focus for desktop players; skip on touch screens where a focus ring looks like a stuck press. */
const focusEl = (sel) => setTimeout(() => { if (!isTouch) $(sel)?.focus({ preventScroll: true }); }, 40);

const app = {
  screen: 'title', // title | howto | playing | results
  mode: null, // endless | daily | race
  game: null,
  bots: [],
  px: null,
  py: null,
  paused: false,
  countdown: 0,
  acc: 0,
  deadFor: 0,
  ended: false,
  resultsAt: 0,
  timeScale: Math.max(0.25, Math.min(16, Number(params.get('speed')) || 1)),
  autopilot: null,
  attract: null,
  attractDim: 0.45,
  pendingMode: null,
  lastResult: null,
  hintStage: 0,
  raceResult: null,
};

// ------------------------------------------------------------------ helpers
function todayKey() {
  const d = new Date();
  return dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function show(id, on = true) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el) el.hidden = !on;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function ticker(html) {
  const box = $('#ticker');
  const d = document.createElement('div');
  d.innerHTML = html;
  box.appendChild(d);
  setTimeout(() => d.remove(), 2700);
  while (box.children.length > 3) box.firstChild.remove();
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th');
const botIcon = '<svg class="ic"><use href="#i-bot"/></svg>';

// ------------------------------------------------------------------ settings UI
function refreshToggles() {
  $$('.btn-sfx').forEach((b) => {
    b.classList.toggle('off', !store.settings.sfx);
    b.querySelector('use').setAttribute('href', store.settings.sfx ? '#i-sound' : '#i-mute');
    b.setAttribute('aria-pressed', String(store.settings.sfx));
  });
  $$('.btn-music').forEach((b) => {
    b.classList.toggle('off', !store.settings.music);
    b.setAttribute('aria-pressed', String(store.settings.music));
  });
}
function toggleSfx() {
  store.settings.sfx = !store.settings.sfx;
  audio.setSfx(store.settings.sfx);
  save();
  refreshToggles();
  toast(store.settings.sfx ? 'Sound on' : 'Sound off');
}
function toggleMusic() {
  store.settings.music = !store.settings.music;
  audio.setMusic(store.settings.music);
  if (store.settings.music && app.screen === 'playing' && !app.paused) audio.startMusic();
  save();
  refreshToggles();
  toast(store.settings.music ? 'Music on' : 'Music off');
}
audio.setSfx(store.settings.sfx);
audio.setMusic(store.settings.music);

// ------------------------------------------------------------------ title
function refreshTitle() {
  const key = todayKey();
  const num = dailyNumber(key);
  $('#daily-title').textContent = `Daily #${num}`;
  const today = store.daily[key];
  $('#sub-daily').textContent = today ? `Today's best: ${today.best.hops} hops · ⭐${today.best.stars}` : 'Same course for everyone today';
  const st = store.stats;
  $('#sub-endless').textContent = st.bestScore ? `Best ${st.bestScore} · ${st.bestHops} hops` : 'How far can you go?';
  $('#sub-race').textContent = store.race.played ? `Wins ${store.race.wins}/${store.race.played} · first to planet ${RACE_FINISH}` : `First to planet ${RACE_FINISH} · computer opponents`;
  const items = [
    ['Best', st.bestScore],
    ['Runs', st.runs],
    ['Perfects', st.perfects],
    ['Streak', `${store.streak.count}d`],
  ];
  $('#stats').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function goTitle() {
  app.screen = 'title';
  app.game = null;
  app.bots = [];
  app.paused = false;
  audio.stopMusic();
  ['#hud', '#hint', '#countdown', '#screen-results', '#screen-pause', '#screen-howto', '#screen-credits'].forEach((s) => show(s, false));
  $('#ticker').innerHTML = '';
  show('#screen-title');
  refreshTitle();
  startAttract();
  focusEl('.mode-endless');
}

// attract mode: a bot plays a random course behind the menu
function startAttract() {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const g = new Game({ seed });
  app.attract = { game: g, pilot: new BotPilot('ace', seed ^ 0x5151), px: g.x, py: g.y, deadFor: 0 };
  R.reset(g);
}

// ------------------------------------------------------------------ how to
function openHowTo(thenMode = null) {
  app.pendingMode = thenMode;
  show('#screen-howto');
  focusEl('#btn-howto-ok');
}
function closeHowTo() {
  show('#screen-howto', false);
  if (!store.seenHowTo) {
    store.seenHowTo = true;
    save();
  }
  if (app.pendingMode) {
    const m = app.pendingMode;
    app.pendingMode = null;
    startMode(m);
  }
}

// ------------------------------------------------------------------ start a run
function startMode(mode) {
  audio.unlock();
  if (!store.seenHowTo && !params.has('skiphowto')) return openHowTo(mode);
  app.mode = mode;
  let seed;
  const finishAt = mode === 'race' ? RACE_FINISH : null;
  if (mode === 'daily') {
    app.dailyKey = todayKey();
    seed = dailySeed(app.dailyKey);
  } else {
    seed = params.has('seed') ? Number(params.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
  }
  const course = new Course(seed, { finishAt });
  app.game = new Game({ seed, course });
  app.bots = [];
  if (mode === 'race') {
    app.bots = BOT_KEYS.map((k, idx) => {
      const prof = BOT_PROFILES[k];
      const g = new Game({ seed, course });
      return { key: k, name: prof.name, color: prof.color, game: g, pilot: new BotPilot(prof, mixSeed(seed, idx + 1)), px: g.x, py: g.y };
    });
  }
  app.px = app.game.x;
  app.py = app.game.y;
  app.acc = 0;
  app.deadFor = 0;
  app.ended = false;
  app.paused = false;
  app.hintStage = 0;
  app.raceResult = null;
  app.countdown = mode === 'race' ? 3.0 : 0;
  app.lastCount = null;
  app.attract = null;
  R.reset(app.game);
  app.screen = 'playing';
  ['#screen-title', '#screen-results', '#screen-pause', '#screen-howto', '#screen-credits'].forEach((s) => show(s, false));
  $('#ticker').innerHTML = '';
  show('#hud');
  show('#race-board', mode === 'race');
  $('#hud-sub').textContent = mode === 'endless' ? 'ENDLESS' : mode === 'daily' ? `DAILY #${dailyNumber(app.dailyKey)}` : `RACE · FIRST TO ${RACE_FINISH}`;
  show('#countdown', app.countdown > 0);
  setHint(mode === 'race' ? '' : hintText(0));
  lastHud = {};
  updateHud(true);
  audio.startMusic();
  audio.setIntensity(0);
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function hintText(stage) {
  if (stage === 0) return isTouch ? 'Tap when the dotted line turns green' : 'Press Space or click when the line turns green';
  if (stage === 1) return 'Green = you\u2019ll land \u00b7 Gold = PERFECT';
  return '';
}
function setHint(text) {
  const h = $('#hint');
  h.textContent = text;
  show(h, !!text);
}

// ------------------------------------------------------------------ input
function tap() {
  audio.unlock();
  if (app.screen !== 'playing' || app.paused || app.countdown > 0) return;
  const g = app.game;
  if (!g || !g.alive) return;
  g.tap();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button > 0) return;
  e.preventDefault();
  if (app.screen === 'playing' && app.paused) return resume();
  tap();
});
// taps on non-interactive overlay areas (hint/countdown) also count
document.addEventListener('contextmenu', (e) => {
  if (e.target === canvas) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'm' || k === 'M') return toggleSfx();
  if (!$('#screen-credits').hidden) {
    if (k === 'Escape' || k === 'Enter' || k === ' ') { e.preventDefault(); show('#screen-credits', false); }
    return;
  }
  if (!$('#screen-howto').hidden) {
    if (k === ' ' || k === 'Enter' || k === 'Escape') {
      e.preventDefault();
      closeHowTo();
    }
    return;
  }
  if (app.screen === 'title') {
    if (k === '1') startMode('endless');
    else if (k === '2') startMode('daily');
    else if (k === '3') startMode('race');
    else if (k === '?' || k === 'h' || k === 'H') openHowTo();
    return;
  }
  if (app.screen === 'playing') {
    if (app.paused) {
      if (k === ' ' || k === 'p' || k === 'P' || k === 'Enter' || k === 'Escape') {
        e.preventDefault();
        resume();
      } else if (k === 'r' || k === 'R') restart();
      return;
    }
    if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W' || k === 'Enter') {
      e.preventDefault();
      if (!e.repeat) tap();
    } else if (k === 'p' || k === 'P' || k === 'Escape') {
      pause();
    } else if (k === 'r' || k === 'R') {
      restart();
    }
    return;
  }
  if (app.screen === 'results') {
    const settled = performance.now() >= (app.resultsGuardUntil || 0);
    if (k === 'r' || k === 'R' || (settled && (k === ' ' || k === 'Enter') && (document.activeElement === document.body || document.activeElement === $('#btn-retry')))) {
      e.preventDefault();
      restart();
    } else if (k === 'Escape') goTitle();
    else if (k === 'c' || k === 'C') copyResult();
  }
});

function restart() {
  // restarting during the short crash beat still records the finished run
  if (app.screen === 'playing' && app.ended) onRunEnd();
  if (app.mode) startMode(app.mode);
}

function pause() {
  if (app.screen !== 'playing' || app.paused || !app.game || app.ended) return;
  app.paused = true;
  show('#screen-pause');
  audio.stopMusic();
  focusEl('#btn-resume');
}
function resume() {
  if (!app.paused) return;
  app.paused = false;
  show('#screen-pause', false);
  audio.resume();
  audio.startMusic();
  last = performance.now();
  if (document.activeElement) document.activeElement.blur();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pause();
    audio.suspend();
  } else {
    audio.resume();
  }
});

// ignore clicks on the results card for a beat after it appears (protects against ghost taps)
$('#screen-results').addEventListener('click', (e) => {
  if (performance.now() < (app.resultsGuardUntil || 0)) { e.stopPropagation(); e.preventDefault(); }
}, true);

// buttons
$$('.mode-btn').forEach((b) => b.addEventListener('click', () => { audio.sfx.click(); startMode(b.dataset.mode); }));
$('#btn-howto').addEventListener('click', () => { audio.unlock(); audio.sfx.click(); openHowTo(); });
$('#btn-howto-ok').addEventListener('click', () => { audio.sfx.click(); closeHowTo(); });
$('#btn-pause').addEventListener('click', () => pause());
$('#btn-resume').addEventListener('click', () => resume());
$('#btn-restart').addEventListener('click', () => restart());
$('#btn-quit').addEventListener('click', () => goTitle());
$('#btn-retry').addEventListener('click', () => { audio.sfx.click(); restart(); });
$('#btn-menu').addEventListener('click', () => { audio.sfx.click(); goTitle(); });
$('#btn-share').addEventListener('click', () => copyResult());
$('#btn-credits').addEventListener('click', () => { show('#screen-credits'); focusEl('#btn-credits-ok'); });
$('#btn-credits-ok').addEventListener('click', () => show('#screen-credits', false));
$$('.btn-sfx').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); audio.unlock(); toggleSfx(); }));
$$('.btn-music').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); audio.unlock(); toggleMusic(); }));
// stop HUD button presses from launching the ship
$$('#hud button').forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));

// ------------------------------------------------------------------ simulation
function stepWorld() {
  const g = app.game;
  if (app.autopilot && g.alive) app.autopilot.control(g);
  app.px = g.x;
  app.py = g.y;
  const ev = g.step();
  if (ev.length) handlePlayerEvents(ev);
  for (const b of app.bots) {
    b.px = b.game.x;
    b.py = b.game.y;
    if (!b.game.alive) continue;
    b.pilot.control(b.game);
    const be = b.game.step();
    for (const e of be) {
      if (e.type === 'crash') {
        R.onEvents([e], { isPlayer: false, game: b.game });
        audio.sfx.botCrash();
        ticker(`<span style="color:${b.color}">${botIcon} BOT ${b.name}</span> crashed at planet ${b.game.planetIdx}`);
      } else if (e.type === 'finish') {
        ticker(`<span style="color:${b.color}">${botIcon} BOT ${b.name}</span> finished · ${formatTime(e.tick)}`);
      }
    }
  }
}

function handlePlayerEvents(ev) {
  const g = app.game;
  R.onEvents(ev, { isPlayer: true, game: g });
  for (const e of ev) {
    if (e.type === 'launch') {
      audio.sfx.launch();
      if (app.hintStage === 0) {
        app.hintStage = 1;
        setHint('');
      }
    } else if (e.type === 'capture') {
      if (e.skip) audio.sfx.skip();
      else audio.sfx.capture(e.perfect, e.combo);
      bumpScore();
      audio.setIntensity(Math.min(1, difficulty(g.planetIdx) * 1.4));
      if (app.hintStage === 1 && g.planetIdx >= 3) app.hintStage = 2;
    } else if (e.type === 'star') audio.sfx.star();
    else if (e.type === 'warn') audio.sfx.warn();
    else if (e.type === 'crash') {
      if (e.cause === 'lost') audio.sfx.lost();
      else audio.sfx.crash();
      navigator.vibrate?.(e.cause === 'lost' ? 40 : [60, 40, 90]);
      app.hintStage = 3;
      setHint('');
    } else if (e.type === 'finish') {
      audio.sfx.win();
    }
  }
}

function bumpScore() {
  const s = $('#hud-score');
  s.classList.remove('bump');
  void s.offsetWidth;
  s.classList.add('bump');
  setTimeout(() => s.classList.remove('bump'), 130);
}

// ------------------------------------------------------------------ HUD
let lastHud = {};
function updateHud(force = false) {
  const g = app.game;
  if (!g) return;
  const set = (id, v) => {
    if (force || lastHud[id] !== v) {
      lastHud[id] = v;
      $(id).textContent = v;
    }
  };
  set('#hud-score', String(g.score));
  set('#hud-hops', String(g.hops));
  set('#hud-stars', String(g.stars));
  const combo = g.combo >= 2 ? `COMBO ×${g.combo}` : '';
  if (force || lastHud.combo !== combo) {
    lastHud.combo = combo;
    const el = $('#hud-combo');
    el.textContent = combo;
    show(el, !!combo);
  }
  if (app.mode === 'race') {
    const rows = [{ name: 'You', color: '#7ee8ff', game: g, me: true }, ...app.bots.map((b) => ({ name: b.name, color: b.color, game: b.game, me: false }))];
    const order = rows
      .map((r) => ({ ...r, prog: r.game.phase === 'finished' ? 1e6 - r.game.endTick : r.game.hops * 1000 + (r.game.alive ? 500 : 0) }))
      .sort((a, b) => b.prog - a.prog);
    const sig = order.map((r) => `${r.name}:${r.game.hops}:${r.game.phase}`).join('|');
    if (force || lastHud.board !== sig) {
      lastHud.board = sig;
      $('#race-board').innerHTML = order
        .map((r, k) => {
          const st = r.game.phase === 'finished' ? '<svg class="ic"><use href="#i-flag"/></svg>' : r.game.phase === 'dead' ? '✕' : '';
          const hops = Math.min(r.game.hops, RACE_FINISH);
          const label = r.me ? '<b>You</b>' : `${botIcon}<b>BOT ${r.name}</b>`;
          return `<li class="${r.me ? 'me' : ''} ${r.game.phase === 'dead' ? 'out' : ''}"><span class="pos">${k + 1}</span><span class="sw" style="background:${r.color}"></span>${label}<span>${hops}</span>${st}</li>`;
        })
        .join('');
    }
  }
  if (app.hintStage === 1 && g.phase === 'orbit' && g.planetIdx >= 1 && g.planetIdx < 3) setHint(hintText(1));
  else if (app.hintStage >= 2 && !$('#hint').hidden) setHint('');
}

/**
 * Aim guide: exact (simulated) green/gold preview, full strength on the first AIM_FULL planets, then
 * fading out (shorter, dimmer, less saturated) over planets AIM_FULL..AIM_FADE_END-1 so the training
 * wheels come off gradually instead of in one step; after that a plain direction stub. Green means
 * "tap now and you land" for a human tap that arrives ~150–280 ms after the line lights up (simulated
 * at 9, 13 and 17 ticks ahead: visual reaction plus input latency), so slivers too short to react to
 * never flash green. Offline sim (300 seeds, planets 0–4): a hint-follower reacting in 180–300 ms
 * reaches planet 5 in ~84% of runs, vs ~50% with leads 5/8/11 and ~16% with delay 0.
 * tools/human-sim.mjs measures the whole curve.
 */
const AIM_LEADS = [9, 13, 17];
const AIM_MID = 13;
function aimGuide(g) {
  if (!g.alive || g.phase !== 'orbit' || app.countdown > 0) return null;
  const fade = aimStrength(g.planetIdx);
  if (fade <= 0) return { full: false, fade: 0 };
  let mid = null;
  for (const d of AIM_LEADS) {
    const pr = predictTap(g, d);
    if (!pr.ok) return { full: true, ok: false, perfect: false, fade };
    if (d === AIM_MID) mid = pr;
  }
  return { full: true, ok: true, perfect: mid.q < PERFECT_FRAC, fade };
}

let boardCache = { t: 0, v: 96 };
function boardBottom() {
  const now = performance.now();
  if (now - boardCache.t > 500) boardCache = { t: now, v: $('#race-board').getBoundingClientRect().bottom || 96 };
  return boardCache.v;
}

// ------------------------------------------------------------------ end of run
function finishRace() {
  // fast-forward any bots still flying so the standings are final
  for (const b of app.bots) {
    let n = 0;
    while (b.game.alive && n++ < 60 * 180) {
      b.pilot.control(b.game);
      b.game.step();
    }
  }
  const g = app.game;
  const racers = [
    { name: 'You', isPlayer: true, color: '#7ee8ff', ...g.summary() },
    ...app.bots.map((b) => ({ name: b.name, isPlayer: false, color: b.color, ...b.game.summary() })),
  ];
  return rankRacers(racers);
}

function onRunEnd() {
  const g = app.game;
  const s = g.summary();
  const st = store.stats;
  st.runs++;
  st.totalHops += s.hops;
  st.totalStars += s.stars;
  st.perfects += s.perfects;
  st.bestCombo = Math.max(st.bestCombo, s.maxCombo);
  let newBest = false;
  let note = '';
  if (app.mode === 'endless') {
    if (s.score > st.bestScore) {
      newBest = st.bestScore > 0 || s.score > 0;
      st.bestScore = s.score;
    }
    st.bestHops = Math.max(st.bestHops, s.hops);
    note = newBest ? `Previous best beaten!` : `Best: ${st.bestScore} · ${st.bestHops} hops`;
  } else if (app.mode === 'daily') {
    const key = app.dailyKey;
    const rec = store.daily[key] || (store.daily[key] = { attempts: 0, best: null });
    rec.attempts++;
    if (!rec.best || s.score > rec.best.score) {
      newBest = !!rec.best;
      rec.best = { score: s.score, hops: s.hops, stars: s.stars, perfects: s.perfects, maxCombo: s.maxCombo, hopLog: s.hopLog };
    }
    // streak
    if (store.streak.last !== key) {
      store.streak.count = store.streak.last === prevDayKey(key) ? store.streak.count + 1 : 1;
      store.streak.last = key;
      store.streak.best = Math.max(store.streak.best, store.streak.count);
    }
    st.bestHops = Math.max(st.bestHops, s.hops);
    note = `Attempt ${rec.attempts} · today's best ${rec.best.score} (${rec.best.hops} hops) · new course tomorrow`;
  } else if (app.mode === 'race') {
    app.raceResult = finishRace();
    const me = app.raceResult.find((r) => r.isPlayer);
    store.race.played++;
    if (me.place === 1) store.race.wins++;
    store.race.bestPlace = Math.min(store.race.bestPlace ?? 9, me.place);
    if (g.phase === 'finished' && (store.race.bestTicks == null || g.endTick < store.race.bestTicks)) {
      newBest = store.race.bestTicks != null;
      store.race.bestTicks = g.endTick;
    }
    st.bestHops = Math.max(st.bestHops, s.hops);
    note = store.race.bestTicks ? `Best finish time ${formatTime(store.race.bestTicks)} · wins ${store.race.wins}/${store.race.played}` : `Wins ${store.race.wins}/${store.race.played}`;
  }
  save();
  app.lastResult = { ...s, mode: app.mode, newBest, note };
}

function showResults() {
  const r = app.lastResult;
  const g = app.game;
  app.screen = 'results';
  audio.stopMusic();
  show('#hud', false);
  setHint('');
  $('#res-kicker').textContent = app.mode === 'endless' ? 'ENDLESS' : app.mode === 'daily' ? `DAILY #${dailyNumber(app.dailyKey)}` : 'RACE VS 3 BOTS';
  let title;
  if (app.mode === 'race') {
    const me = app.raceResult.find((x) => x.isPlayer);
    title = me.place === 1 ? 'You win the race!' : `${ordinal(me.place)} place`;
    if (me.place === 1) audio.sfx.best();
  } else {
    title = CAUSES[g.cause] || 'Run over';
  }
  $('#res-h').textContent = title;
  show('#res-badge', r.newBest);
  if (r.newBest && app.mode !== 'race') audio.sfx.best();
  $('#res-score').textContent = r.score;
  $('#res-hops').textContent = r.hops;
  $('#res-stars').textContent = r.stars;
  $('#res-perf').textContent = r.perfects;
  $('#res-combo').textContent = `×${r.maxCombo}`;
  // hop strip
  const max = 40;
  const cells = [...r.hopLog].slice(0, max).map((c) => `<i class="${c}"></i>`);
  if (r.hopLog.length > max) cells.push(`<i class="more">+${r.hopLog.length - max}</i>`);
  if (g.phase === 'dead') cells.push('<i class="x"></i>');
  $('#res-strip').innerHTML = cells.join('');
  // race table
  const tbl = $('#res-race');
  if (app.mode === 'race') {
    tbl.innerHTML = app.raceResult
      .map((x) => {
        const who = x.isPlayer ? '<b>You</b>' : `<span style="color:${x.color}">${botIcon}</span><b>${x.name}</b><span class="bot-tag">BOT</span>`;
        const res = x.phase === 'finished' ? `Finished · ${formatTime(x.ticks)}` : `Crashed · planet ${x.hops}`;
        return `<li class="${x.isPlayer ? 'me' : ''}"><span class="place">${x.place}</span><span class="who">${who}</span><span class="res">${res}</span></li>`;
      })
      .join('');
    show(tbl);
    show('#res-strip', false);
  } else {
    show(tbl, false);
    show('#res-strip');
  }
  $('#res-note').textContent = r.note;
  const tip = app.mode !== 'race' && r.hops < 8 ? TIPS[g.cause] : '';
  $('#res-tip').textContent = tip || '';
  show('#res-tip', !!tip);
  // a frantic tap that lands just as the card appears must not hit Copy/Menu by accident
  app.resultsGuardUntil = performance.now() + 550;
  $('#btn-share span').textContent = app.mode === 'daily' ? 'Share daily' : 'Copy result';
  show('#screen-results');
  focusEl('#btn-retry');
}

const TIPS = {
  lost: 'Tip: you fly straight off along your orbit \u2014 launch when that line points into the next dashed ring.',
  burn: 'Tip: orbits decay \u2014 the shrinking arc shows how long you have before you burn up.',
  asteroid: 'Tip: asteroids drift sideways \u2014 if one is in the way, wait half a lap for a gap.',
  moon: 'Tip: moons circle their planet \u2014 time your entry between passes.',
  well: 'Tip: gravity wells bend your path \u2014 launch a little wide of them.',
};

function resultText() {
  const r = app.lastResult;
  const url = location.origin && location.origin !== 'null' ? location.origin + location.pathname : '';
  if (app.mode === 'daily') {
    const best = store.daily[app.dailyKey]?.best || r;
    return shareText({ num: dailyNumber(app.dailyKey), hops: best.hops, stars: best.stars, perfects: best.perfects, maxCombo: best.maxCombo, hopLog: best.hopLog, url });
  }
  if (app.mode === 'race') {
    const me = app.raceResult.find((x) => x.isPlayer);
    const time = me.phase === 'finished' ? ` in ${formatTime(me.ticks)}` : '';
    return `Orbit Hop 🏁 Race vs 3 bots: ${ordinal(me.place)} place${time}\n🚀 ${r.hops} hops ⭐${r.stars} ✨${r.perfects} perfect${url ? '\n' + url : ''}`;
  }
  return `Orbit Hop 🚀 Endless: ${r.score} pts · ${r.hops} hops ⭐${r.stars}\n✨ ${r.perfects} perfect · best combo x${r.maxCombo}${url ? '\n' + url : ''}`;
}

async function copyResult() {
  if (!app.lastResult) return;
  const text = resultText();
  app.lastShare = text;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  toast(ok ? 'Result copied — paste it anywhere!' : 'Could not access clipboard');
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  const dtReal = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  R.resize();

  if (app.screen === 'playing' && app.game) {
    const g = app.game;
    if (!app.paused) {
      if (app.countdown > 0) {
        app.countdown -= dtReal * Math.min(app.timeScale, 4);
        const n = Math.ceil(app.countdown);
        if (n !== app.lastCount) {
          app.lastCount = n;
          const el = $('#countdown');
          el.textContent = n > 0 ? String(n) : 'GO!';
          el.classList.remove('tick');
          void el.offsetWidth;
          el.classList.add('tick');
          audio.sfx.count(n <= 0);
          if (n <= 0) {
            setTimeout(() => show('#countdown', false), 600);
            setHint(hintText(0));
          }
        }
      } else {
        app.acc += dtReal * app.timeScale;
        let steps = 0;
        while (app.acc >= DT && steps < 400) {
          stepWorld();
          app.acc -= DT;
          steps++;
          if (!g.alive && !app.ended) break;
        }
        if (!g.alive) {
          if (!app.ended) {
            app.ended = true;
            app.acc = 0;
            app.resultsAt = g.phase === 'finished' ? 1.6 : 1.25;
          }
          app.deadFor += dtReal;
          // bots keep racing during the short death beat
          if (app.mode === 'race') {
            app.acc += dtReal * app.timeScale;
            while (app.acc >= DT) {
              for (const b of app.bots) {
                b.px = b.game.x;
                b.py = b.game.y;
                if (b.game.alive) {
                  b.pilot.control(b.game);
                  b.game.step();
                }
              }
              app.acc -= DT;
            }
          }
          if (app.deadFor * Math.min(app.timeScale, 4) >= app.resultsAt && app.screen === 'playing') {
            onRunEnd();
            showResults();
          }
        }
      }
    }
    const alpha = app.paused || app.ended ? 1 : Math.min(1, app.acc / DT);
    R.draw(app.paused ? 0 : dtReal, {
      player: g,
      alpha,
      px: app.px,
      py: app.py,
      aim: aimGuide(g),
      deadFor: app.deadFor,
      topInset: app.mode === 'race' ? boardBottom() : 0,
      ghosts: app.bots.map((b) => ({ key: b.key, name: b.name, color: b.color, game: b.game, px: b.px, py: b.py })),
    });
    updateHud();
  } else if (app.screen === 'results' && app.game) {
    app.deadFor += dtReal;
    R.draw(dtReal, { player: app.game, alpha: 1, deadFor: app.deadFor, ghosts: app.bots.map((b) => ({ key: b.key, name: b.name, color: b.color, game: b.game })), dim: 0.25 });
  } else {
    // title / attract
    const a = app.attract || (startAttract(), app.attract);
    const g = a.game;
    a.acc = (a.acc || 0) + dtReal;
    while (a.acc >= DT) {
      a.acc -= DT;
      a.px = g.x;
      a.py = g.y;
      if (g.alive) {
        a.pilot.control(g);
        R.onEvents(g.step(), { isPlayer: true, game: g });
      }
    }
    if (!g.alive) {
      a.deadFor += dtReal;
      if (a.deadFor > 1.6) startAttract();
    }
    R.draw(dtReal, { player: g, alpha: Math.min(1, a.acc / DT), px: a.px, py: a.py, deadFor: a.deadFor, dim: app.attractDim });
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ test hook (used by tests/e2e.mjs)
window.__orbithop = {
  get state() {
    const g = app.game;
    return {
      screen: app.screen,
      mode: app.mode,
      paused: app.paused,
      phase: g?.phase,
      hops: g?.hops,
      score: g?.score,
      stars: g?.stars,
      planet: g?.planetIdx,
      countdown: app.countdown,
      bots: app.bots.map((b) => ({ name: b.name, phase: b.game.phase, hops: b.game.hops })),
      share: app.lastShare || null,
    };
  },
  setAttractDim(v) {
    app.attractDim = v;
  },
  setSpeed(n) {
    app.timeScale = n;
  },
  setAutopilot(key) {
    app.autopilot = key ? new BotPilot(key, 4242) : null;
  },
  start: (m) => startMode(m),
  /**
   * Would a tap arriving `lo`..`hi` ticks from now land on a planet ahead? Lets the e2e test send
   * well-timed real taps. The range must include 0: a real input can reach the page before the next
   * tick, and polling stops at the leading edge of the landing window, where delay 0 always misses.
   * 0..8 ticks (0–133 ms of input latency) is available on every start planet within ~1 s.
   */
  wouldLand: (lo = 0, hi = 8) => {
    const g = app.game;
    if (!g || g.phase !== 'orbit') return false;
    for (let d = lo; d <= hi; d++) if (!predictTap(g, d).ok) return false;
    return true;
  },
  resultText: () => (app.lastResult ? resultText() : null),
};

// ------------------------------------------------------------------ boot
refreshToggles();
goTitle();
if (params.get('autopilot')) window.__orbithop.setAutopilot(params.get('autopilot'));
addEventListener('resize', () => R.resize());
document.fonts?.ready?.then(() => R.planetCache.clear());
requestAnimationFrame(frame);
