// Canvas 2D renderer: camera, parallax space, planets, hazards, ships, ghosts, particles, juice.
// Purely visual — reads game state, never mutates it.
import {
  DT, CENTER_X, WRAP_MIN, WRAP_W,
  planetX, moonPos, asteroidX, makeRng, clamp, lerp,
} from './core.js';

const TAU = Math.PI * 2;
const FONT = "'Fredoka', 'Trebuchet MS', system-ui, sans-serif";

const PALETTES = [
  { a: '#ffd36e', b: '#ff8a3d', c: '#b8452a', glow: '255,170,80' }, // sun-gold
  { a: '#7ee8ff', b: '#3a9bdc', c: '#1d3f8f', glow: '110,200,255' }, // ice blue
  { a: '#c59bff', b: '#8357e8', c: '#3d2394', glow: '170,130,255' }, // violet
  { a: '#8ff0b4', b: '#2fb980', c: '#13614a', glow: '110,240,170' }, // jade
  { a: '#ff9bc4', b: '#e8467c', c: '#7d1d4a', glow: '255,110,170' }, // rose
  { a: '#ffe9b0', b: '#d9a45b', c: '#7a4d22', glow: '240,200,140' }, // sand
  { a: '#9fb5ff', b: '#5a6cf0', c: '#262b85', glow: '130,150,255' }, // periwinkle
  { a: '#ffb38a', b: '#f0603a', c: '#7a1f16', glow: '255,120,80' }, // lava
];

const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.cx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.scale = 1;
    this.camY = 0;
    this.camTarget = 0;
    this.shake = 0;
    this.time = 0;
    this.particles = [];
    this.texts = [];
    this.rings = [];
    this.trails = new Map(); // key -> [{x,y}]
    this.planetCache = new Map();
    this.shapeCache = new Map();
    this.flash = 0;
    this.flashColor = '255,255,255';
    this.bgStars = null;
    this.glowSprites = new Map();
    this.resize();
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
    const w = this.cv.clientWidth || innerWidth;
    const h = this.cv.clientHeight || innerHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    // show at least 400 x 640 world units on portrait screens; landscape screens (desktop, portal
    // embeds) only need ~540 units of height, so the playfield isn't a thin strip
    this.scale = Math.min(w / 400, h / (w > h ? 540 : 640));
    this.planetCache.clear();
    this._buildStars();
    this._buildNebula();
  }

  get viewH() {
    return this.h / this.scale;
  }

  reset(game) {
    this.particles.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
    this.trails.clear();
    this.planetCache.clear();
    this.shake = 0;
    this.flash = 0;
    if (game) {
      const p = game.course.planet(game.planetIdx);
      this.camY = this.camTarget = this._focusTarget(p.y);
    }
  }

  _focusTarget(y, topInset = 0) {
    // keep the planet we're orbiting low on screen so more of the course ahead is visible;
    // a HUD block at the top (race standings) pushes it down a little further
    return y + this.viewH * 0.22 + (topInset * 0.45) / this.scale;
  }

  // world -> screen (CSS px)
  sx(x) {
    return this.w / 2 + (x - CENTER_X) * this.scale;
  }
  sy(y) {
    return this.h / 2 - (y - this.camY) * this.scale;
  }

  // ------------------------------------------------------------ effects from sim events
  onEvents(events, { isPlayer = true, color = '#7ee8ff', game } = {}) {
    for (const e of events) {
      if (e.type === 'launch' && isPlayer) {
        this._burst(e.x, e.y, 10, { speed: 80, life: 0.35, color: '255,220,150', size: 2, dirX: -e.vx, dirY: -e.vy, spread: 0.7 });
      } else if (e.type === 'capture') {
        if (!isPlayer) continue;
        const p = game.course.planet(e.planet);
        const pal = PALETTES[p.palette];
        this.rings.push({ x: planetX(p, game.t), y: p.y, r: p.pr, r2: p.orbitR * (e.perfect ? 2.1 : 1.5), life: 0, max: 0.55, color: e.perfect ? '255,215,90' : pal.glow });
        this._burst(e.x, e.y, e.perfect ? 26 : 14, { speed: e.perfect ? 170 : 110, life: 0.6, color: e.perfect ? '255,220,110' : pal.glow, size: 2.4 });
        let label = `+${e.points}`;
        if (e.skip) label = `SKIP! +${e.points}`;
        else if (e.perfect) label = e.combo > 1 ? `PERFECT ×${e.combo}` : 'PERFECT';
        this.texts.push({ x: e.x, y: e.y + 26, text: label, life: 0, max: 1.0, color: e.perfect || e.skip ? '#ffd75a' : '#ffffff', big: e.perfect || e.skip });
        if (e.perfect) {
          this.shake = Math.max(this.shake, 3 + Math.min(e.combo, 6));
          this.flash = 0.18;
          this.flashColor = '255,215,90';
        }
      } else if (e.type === 'star' && isPlayer) {
        this._burst(e.x, e.y, 12, { speed: 120, life: 0.5, color: '255,226,120', size: 2 });
        this.texts.push({ x: e.x, y: e.y + 14, text: '+5', life: 0, max: 0.7, color: '#ffe27a', big: false });
      } else if (e.type === 'crash') {
        if (e.cause === 'lost') {
          if (isPlayer) this.texts.push({ x: clamp(e.x, 40, 320), y: e.y, text: 'SIGNAL LOST', life: 0, max: 1.4, color: '#9fb5ff', big: true });
          continue;
        }
        const big = isPlayer;
        this._burst(e.x, e.y, big ? 46 : 16, { speed: big ? 240 : 120, life: big ? 1.1 : 0.6, color: e.cause === 'well' ? '190,120,255' : '255,140,70', size: big ? 3.2 : 2 });
        this._burst(e.x, e.y, big ? 18 : 6, { speed: 90, life: 1.4, color: '200,200,220', size: 4, debris: true });
        if (big) {
          this.rings.push({ x: e.x, y: e.y, r: 4, r2: 70, life: 0, max: 0.5, color: '255,170,90' });
          this.shake = reduceMotion ? 4 : 16;
          this.flash = 0.35;
          this.flashColor = '255,120,80';
        }
      } else if (e.type === 'finish' && isPlayer) {
        this._burst(e.x || 180, e.y || 0, 60, { speed: 260, life: 1.4, color: '255,230,120', size: 3 });
      }
    }
  }

  _burst(x, y, n, { speed = 100, life = 0.6, color = '255,255,255', size = 2, dirX = 0, dirY = 0, spread = TAU, debris = false }) {
    if (this.particles.length > 600) return;
    const base = dirX || dirY ? Math.atan2(dirY, dirX) : 0;
    for (let i = 0; i < n; i++) {
      const a = dirX || dirY ? base + (Math.random() - 0.5) * spread : Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: life * (0.6 + Math.random() * 0.6), color, size: size * (0.6 + Math.random() * 0.8), debris, rot: Math.random() * TAU, spin: (Math.random() - 0.5) * 10 });
    }
  }

  kick(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  // ------------------------------------------------------------ main draw
  /**
   * @param scene { player: Game, alpha, ghosts: [{game, color, name, prevX, prevY}], aim: bool, dim: 0..1,
   *                trailKey, px, py (prev pos for interpolation) }
   */
  draw(dtReal, scene) {
    this.time += dtReal;
    const g = scene.player;
    const cx = this.cx;
    const dpr = this.dpr;
    const tWorld = Math.max(0, (g.tick - 1 + scene.alpha) * DT);

    // interpolated player position
    const shipX = scene.px != null ? lerp(scene.px, g.x, scene.alpha) : g.x;
    const shipY = scene.py != null ? lerp(scene.py, g.y, scene.alpha) : g.y;

    // camera
    const cur = g.course.planet(g.planetIdx);
    let focus = cur.y;
    if (g.phase === 'flight') focus = Math.max(cur.y, Math.min(shipY - 30, g.course.planet(g.planetIdx + 1).y));
    if (g.phase === 'dead' && g.cause === 'lost') focus = cur.y;
    this.camTarget = this._focusTarget(focus, scene.topInset || 0);
    const k = 1 - Math.exp(-dtReal * (g.phase === 'flight' ? 4 : 3.2));
    this.camY += (this.camTarget - this.camY) * k;

    // shake
    let ox = 0, oy = 0;
    if (this.shake > 0.05) {
      const s = reduceMotion ? this.shake * 0.3 : this.shake;
      ox = (Math.random() - 0.5) * 2 * s;
      oy = (Math.random() - 0.5) * 2 * s;
      this.shake *= Math.exp(-dtReal * 9);
    }

    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawBackground(g);
    cx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);

    const viewTop = this.camY + this.viewH / 2 + 60;
    const viewBot = this.camY - this.viewH / 2 - 60;
    const course = g.course;

    // find planet index range in view
    let i0 = Math.max(0, g.planetIdx - 3);
    while (i0 > 0 && course.planet(i0).y + 120 > viewBot) i0--;
    let i1 = g.planetIdx + 1;
    while (course.planet(i1).y - 120 < viewTop) i1++;

    // gaps: wells first (under everything), then asteroids/stars
    for (let i = i0 - 1; i <= i1; i++) {
      const gap = course.gap(i);
      for (const w of gap.wells) if (w.y > viewBot - 100 && w.y < viewTop + 100) this._drawWell(w);
    }
    // planets
    for (let i = i0; i <= i1; i++) {
      const p = course.planet(i);
      if (p.y + p.outer < viewBot || p.y - p.outer > viewTop) continue;
      this._drawPlanet(p, tWorld, g, i);
    }
    for (let i = i0 - 1; i <= i1; i++) {
      const gap = course.gap(i);
      if (gap.yHi < viewBot || gap.yLo > viewTop) continue;
      for (const s of gap.stars) if (!g.collected[s.id]) this._drawStar(s);
      for (const a of gap.asteroids) this._drawAsteroid(a, tWorld);
    }

    // aim guide for the first few hops
    if (scene.aim && g.phase === 'orbit') this._drawAim(g, shipX, shipY, scene.aim);

    // ghosts
    if (scene.ghosts) {
      const tags = [];
      for (const gh of scene.ghosts) {
        const gx = gh.px != null ? lerp(gh.px, gh.game.x, scene.alpha) : gh.game.x;
        const gy = gh.py != null ? lerp(gh.py, gh.game.y, scene.alpha) : gh.game.y;
        this._trail(gh.key, gx, gy, gh.game.alive, 14);
        this._drawTrail(gh.key, gh.color, 0.35);
        if (gh.game.alive || gh.game.phase === 'finished') this._drawShip(gx, gy, gh.game, gh.color, 0.55);
        if (this.sy(gy) >= (scene.topInset || 0) + 36) tags.push({ gh, X: this.sx(gx), Y: this.sy(gy) - 26 });
      }
      // stack name tags that would overlap (e.g. everyone on the start line)
      for (let a = 0; a < tags.length; a++) {
        for (let b = 0; b < a; b++) {
          if (Math.abs(tags[a].X - tags[b].X) < 70 && Math.abs(tags[a].Y - tags[b].Y) < 16) tags[a].Y = tags[b].Y - 17;
        }
        this._drawGhostTag(tags[a].gh, tags[a].X, tags[a].Y);
      }
    }

    // player
    const showShip = g.alive || g.phase === 'finished' || (g.phase === 'dead' && g.cause === 'lost');
    let drawX = shipX, drawY = shipY;
    if (g.phase === 'dead' && g.cause === 'lost') {
      // keep drifting off into the void
      const since = (scene.deadFor || 0);
      drawX = g.x + g.vx * since;
      drawY = g.y + g.vy * since;
    }
    this._trail('player', drawX, drawY, g.alive, 22);
    this._drawTrail('player', '#7ee8ff', 0.9);
    if (showShip) this._drawShip(drawX, drawY, g, '#ffffff', g.phase === 'dead' ? Math.max(0, 1 - (scene.deadFor || 0)) : 1, true);

    // particles / rings / texts
    this._drawFx(dtReal);

    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (scene.ghosts && scene.ghosts.length) this._drawOffscreenGhosts(scene.ghosts, scene.topInset || 96, g.finishAt);
    // vignette at the course edges on wide screens
    this._drawVignette();
    if (this.flash > 0) {
      cx.fillStyle = `rgba(${this.flashColor},${this.flash * 0.5})`;
      cx.fillRect(0, 0, this.w, this.h);
      this.flash = Math.max(0, this.flash - dtReal * 1.6);
    }
    if (scene.dim) {
      cx.fillStyle = `rgba(6,4,20,${scene.dim})`;
      cx.fillRect(0, 0, this.w, this.h);
    }
  }

  // ------------------------------------------------------------ background
  _buildStars() {
    const rng = makeRng(1234);
    this.bgStars = [0.08, 0.2, 0.42].map((par, layer) => {
      const n = Math.round((this.w * this.h) / (layer === 0 ? 2200 : layer === 1 ? 5200 : 12000));
      const stars = [];
      for (let i = 0; i < n; i++) stars.push({ x: rng.next() * this.w, y: rng.next() * this.h, r: (0.4 + rng.next() * 0.7) * (1 + layer * 0.5), tw: rng.next() * TAU, hue: rng.pick(['255,255,255', '200,220,255', '255,230,200', '220,200,255']) });
      return { par, stars };
    });
  }

  _buildNebula() {
    const c = document.createElement('canvas');
    const W = Math.max(64, Math.round(this.w / 2)), H = Math.max(64, Math.round(this.h * 1.5 / 2));
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    const rng = makeRng(99);
    const cols = ['120,60,200', '40,120,220', '220,60,140', '60,180,200'];
    for (let i = 0; i < 7; i++) {
      const gx = rng.next() * W, gy = rng.next() * H, r = (0.25 + rng.next() * 0.45) * Math.max(W, H);
      const col = rng.pick(cols);
      // draw wrapped copies so the tile repeats vertically without a seam
      for (const oy of [-H, 0, H]) {
        const grd = x.createRadialGradient(gx, gy + oy, 0, gx, gy + oy, r);
        grd.addColorStop(0, `rgba(${col},0.16)`);
        grd.addColorStop(1, `rgba(${col},0)`);
        x.fillStyle = grd;
        x.fillRect(0, 0, W, H);
      }
    }
    this.nebula = c;
  }

  _drawBackground(g) {
    const cx = this.cx;
    // hue drifts deeper/warmer the further you get
    const prog = clamp(g.planetIdx / 50, 0, 1);
    const top = mixColor([16, 10, 46], [40, 8, 40], prog);
    const bot = mixColor([6, 6, 22], [14, 4, 18], prog);
    const grd = cx.createLinearGradient(0, 0, 0, this.h);
    grd.addColorStop(0, `rgb(${top})`);
    grd.addColorStop(1, `rgb(${bot})`);
    cx.fillStyle = grd;
    cx.fillRect(0, 0, this.w, this.h);
    // nebula (slow parallax, tiled vertically)
    if (this.nebula) {
      const nh = this.h * 1.5;
      let off = ((this.camY * this.scale * 0.05) % nh + nh) % nh;
      cx.globalAlpha = 1;
      cx.drawImage(this.nebula, 0, off - nh, this.w, nh);
      cx.drawImage(this.nebula, 0, off, this.w, nh);
    }
    // starfield layers
    const t = this.time;
    for (const layer of this.bgStars) {
      const off = (this.camY * this.scale * layer.par) % this.h;
      for (const s of layer.stars) {
        let y = s.y + off;
        if (y > this.h) y -= this.h;
        else if (y < 0) y += this.h;
        const a = 0.45 + 0.4 * Math.sin(t * 1.7 + s.tw);
        cx.fillStyle = `rgba(${s.hue},${a})`;
        cx.fillRect(s.x, y, s.r, s.r);
      }
    }
  }

  _drawVignette() {
    const cx = this.cx;
    const courseHalf = 230 * this.scale;
    if (this.w / 2 > courseHalf + 20) {
      const l = this.w / 2 - courseHalf;
      const gl = cx.createLinearGradient(0, 0, l, 0);
      gl.addColorStop(0, 'rgba(4,3,14,0.7)');
      gl.addColorStop(1, 'rgba(4,3,14,0)');
      cx.fillStyle = gl;
      cx.fillRect(0, 0, l, this.h);
      const gr = cx.createLinearGradient(this.w, 0, this.w - l, 0);
      gr.addColorStop(0, 'rgba(4,3,14,0.7)');
      gr.addColorStop(1, 'rgba(4,3,14,0)');
      cx.fillStyle = gr;
      cx.fillRect(this.w - l, 0, l, this.h);
    }
  }

  _glow(color, size) {
    const key = color + '|' + size;
    let c = this.glowSprites.get(key);
    if (!c) {
      c = document.createElement('canvas');
      const S = Math.max(8, Math.round(size * 2));
      c.width = c.height = S;
      const x = c.getContext('2d');
      const grd = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, `rgba(${color},0.55)`);
      grd.addColorStop(0.4, `rgba(${color},0.18)`);
      grd.addColorStop(1, `rgba(${color},0)`);
      x.fillStyle = grd;
      x.fillRect(0, 0, S, S);
      if (this.glowSprites.size > 200) this.glowSprites.clear();
      this.glowSprites.set(key, c);
    }
    return c;
  }

  // ------------------------------------------------------------ planets
  _planetSprite(p) {
    const key = p.i;
    let spr = this.planetCache.get(key);
    if (spr) return spr;
    const R = p.pr * this.scale * this.dpr;
    const S = Math.ceil(R * 2 + 4);
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    const pal = PALETTES[p.palette];
    const m = S / 2;
    const rng = makeRng(p.i * 7919 + 13);
    x.save();
    x.beginPath();
    x.arc(m, m, R, 0, TAU);
    x.clip();
    const grd = x.createRadialGradient(m - R * 0.35, m - R * 0.4, R * 0.1, m, m, R * 1.05);
    grd.addColorStop(0, pal.a);
    grd.addColorStop(0.55, pal.b);
    grd.addColorStop(1, pal.c);
    x.fillStyle = grd;
    x.fillRect(0, 0, S, S);
    if (p.style === 1) {
      // gas bands
      for (let b = 0; b < 6; b++) {
        const yy = m - R + rng.next() * R * 2;
        x.fillStyle = `rgba(255,255,255,${0.06 + rng.next() * 0.1})`;
        x.fillRect(0, yy, S, R * (0.08 + rng.next() * 0.18));
        x.fillStyle = `rgba(0,0,0,${0.05 + rng.next() * 0.08})`;
        x.fillRect(0, yy + R * 0.2, S, R * (0.05 + rng.next() * 0.1));
      }
    } else if (p.style === 2) {
      // icy spots
      for (let b = 0; b < 7; b++) {
        x.fillStyle = `rgba(255,255,255,${0.1 + rng.next() * 0.15})`;
        x.beginPath();
        x.ellipse(m + (rng.next() - 0.5) * R * 1.6, m + (rng.next() - 0.5) * R * 1.6, R * (0.1 + rng.next() * 0.25), R * (0.06 + rng.next() * 0.12), rng.next() * 3, 0, TAU);
        x.fill();
      }
    } else if (p.style === 3) {
      // glowing cracks
      x.strokeStyle = 'rgba(255,240,180,0.45)';
      x.lineWidth = Math.max(1, R * 0.05);
      for (let b = 0; b < 4; b++) {
        x.beginPath();
        let px = m + (rng.next() - 0.5) * R * 1.4, py = m + (rng.next() - 0.5) * R * 1.4;
        x.moveTo(px, py);
        for (let s = 0; s < 4; s++) {
          px += (rng.next() - 0.5) * R * 0.6;
          py += (rng.next() - 0.5) * R * 0.6;
          x.lineTo(px, py);
        }
        x.stroke();
      }
    } else {
      // craters
      for (let b = 0; b < 6; b++) {
        const cr = R * (0.08 + rng.next() * 0.16);
        const ccx = m + (rng.next() - 0.5) * R * 1.4, ccy = m + (rng.next() - 0.5) * R * 1.4;
        x.fillStyle = 'rgba(0,0,0,0.16)';
        x.beginPath();
        x.arc(ccx, ccy, cr, 0, TAU);
        x.fill();
        x.fillStyle = 'rgba(255,255,255,0.12)';
        x.beginPath();
        x.arc(ccx - cr * 0.25, ccy - cr * 0.25, cr * 0.7, 0, TAU);
        x.fill();
      }
    }
    // terminator shading
    const sh = x.createRadialGradient(m - R * 0.5, m - R * 0.5, R * 0.6, m - R * 0.2, m - R * 0.2, R * 1.7);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,0,10,0.55)');
    x.fillStyle = sh;
    x.fillRect(0, 0, S, S);
    x.restore();
    // rim light
    x.strokeStyle = 'rgba(255,255,255,0.25)';
    x.lineWidth = Math.max(1, R * 0.04);
    x.beginPath();
    x.arc(m, m, R - x.lineWidth / 2, Math.PI * 1.05, Math.PI * 1.6);
    x.stroke();
    spr = { c, S };
    this.planetCache.set(key, spr);
    if (this.planetCache.size > 40) this.planetCache.delete(this.planetCache.keys().next().value);
    return spr;
  }

  _drawPlanet(p, t, g, i) {
    const cx = this.cx;
    const s = this.scale;
    const px = planetX(p, t);
    const X = this.sx(px), Y = this.sy(p.y);
    const pal = PALETTES[p.palette];
    const isCur = i === g.planetIdx && g.phase === 'orbit';
    const isNext = i === g.planetIdx + 1 && g.alive;
    const passed = i < g.planetIdx;

    // atmosphere glow
    const gs = this._glow(pal.glow, 64);
    const GR = p.pr * s * 2.3;
    cx.globalAlpha = passed ? 0.4 : 0.9;
    cx.drawImage(gs, X - GR, Y - GR, GR * 2, GR * 2);
    cx.globalAlpha = 1;

    // moving planet track
    if (p.amp) {
      cx.strokeStyle = 'rgba(255,255,255,0.07)';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.moveTo(this.sx(p.x - p.amp), Y);
      cx.lineTo(this.sx(p.x + p.amp), Y);
      cx.stroke();
    }

    // capture ring
    const R = p.orbitR * s;
    if (p.finish) {
      // checkered finish ring
      const n = 24;
      cx.lineWidth = 4;
      for (let k = 0; k < n; k++) {
        cx.strokeStyle = k % 2 ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,30,0.85)';
        cx.beginPath();
        cx.arc(X, Y, R, (k / n) * TAU + this.time * 0.3, ((k + 1) / n) * TAU + this.time * 0.3);
        cx.stroke();
      }
      cx.font = `600 ${Math.round(14 * Math.max(0.9, s))}px ${FONT}`;
      cx.textAlign = 'center';
      cx.fillStyle = '#ffe27a';
      cx.fillText('FINISH', X, Y - R - 10);
    } else if (!isCur && !passed && i !== g.planetIdx) {
      cx.setLineDash([5, 7]);
      cx.lineDashOffset = -this.time * 12;
      const pulse = isNext ? 0.6 + 0.25 * Math.sin(this.time * 5) : 0.22;
      cx.strokeStyle = `rgba(${isNext ? '170,240,255' : '255,255,255'},${pulse})`;
      cx.lineWidth = isNext ? 2.5 : 1.5;
      cx.beginPath();
      cx.arc(X, Y, R, 0, TAU);
      cx.stroke();
      cx.setLineDash([]);
    }
    if (isCur) {
      // the current, decaying orbit
      const frac = g.decayFrac();
      const col = frac < 0.5 ? mixColor([110, 230, 255], [255, 210, 90], frac * 2) : mixColor([255, 210, 90], [255, 70, 70], (frac - 0.5) * 2);
      cx.strokeStyle = `rgba(${col},0.5)`;
      cx.lineWidth = 2;
      cx.beginPath();
      cx.arc(X, Y, g.r * s, 0, TAU);
      cx.stroke();
      // remaining-time arc
      if (isFinite(g.orbitRemaining())) {
        cx.strokeStyle = `rgba(${col},0.9)`;
        cx.lineWidth = 3;
        cx.beginPath();
        cx.arc(X, Y, R + 6, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - frac));
        cx.stroke();
      }
      // danger atmosphere
      if (frac > 0.4) {
        const a = (frac - 0.4) / 0.6;
        cx.strokeStyle = `rgba(255,80,60,${a * (0.5 + 0.3 * Math.sin(this.time * 18))})`;
        cx.lineWidth = 3;
        cx.beginPath();
        cx.arc(X, Y, (p.pr + 3) * s, 0, TAU);
        cx.stroke();
      }
    }

    // rings (decor) behind
    if (p.rings) this._drawPlanetRings(X, Y, p, pal, true);
    const spr = this._planetSprite(p);
    const D = spr.S / this.dpr;
    cx.globalAlpha = passed ? 0.55 : 1;
    cx.drawImage(spr.c, X - D / 2, Y - D / 2, D, D);
    cx.globalAlpha = 1;
    if (p.rings) this._drawPlanetRings(X, Y, p, pal, false);

    // moon
    if (p.moon) {
      cx.strokeStyle = 'rgba(200,200,230,0.12)';
      cx.setLineDash([2, 6]);
      cx.lineWidth = 1;
      cx.beginPath();
      cx.arc(X, Y, p.moon.ringR * s, 0, TAU);
      cx.stroke();
      cx.setLineDash([]);
      const m = moonPos(p, t);
      const MX = this.sx(m.x), MY = this.sy(m.y), MR = p.moon.r * s;
      const mg = cx.createRadialGradient(MX - MR * 0.4, MY - MR * 0.4, MR * 0.1, MX, MY, MR);
      mg.addColorStop(0, '#f2f0ff');
      mg.addColorStop(1, '#6d6a8a');
      cx.fillStyle = mg;
      cx.beginPath();
      cx.arc(MX, MY, MR, 0, TAU);
      cx.fill();
      cx.fillStyle = 'rgba(60,50,90,0.35)';
      cx.beginPath();
      cx.arc(MX + MR * 0.25, MY + MR * 0.15, MR * 0.3, 0, TAU);
      cx.fill();
    }
  }

  _drawPlanetRings(X, Y, p, pal, back) {
    const cx = this.cx;
    const s = this.scale;
    cx.save();
    cx.translate(X, Y);
    cx.rotate(-0.35);
    cx.scale(1, 0.32);
    cx.strokeStyle = `rgba(${pal.glow},0.55)`;
    cx.lineWidth = p.pr * s * 0.35;
    cx.beginPath();
    if (back) cx.arc(0, 0, p.pr * s * 1.55, Math.PI, TAU);
    else cx.arc(0, 0, p.pr * s * 1.55, 0, Math.PI);
    cx.stroke();
    cx.restore();
  }

  // ------------------------------------------------------------ hazards & pickups
  _drawAsteroid(a, t) {
    const cx = this.cx;
    const x = asteroidX(a, t);
    // fade out near the wrap seam
    const edge = Math.min(x - WRAP_MIN, WRAP_MIN + WRAP_W - x);
    const alpha = clamp(edge / 80, 0, 1);
    if (alpha <= 0) return;
    const X = this.sx(x), Y = this.sy(a.y);
    if (X < -40 || X > this.w + 40) return;
    let shape = this.shapeCache.get(a.shape);
    if (!shape) {
      const rng = makeRng(a.shape);
      shape = [];
      const n = 9;
      for (let k = 0; k < n; k++) shape.push(0.72 + rng.next() * 0.38);
      this.shapeCache.set(a.shape, shape);
    }
    const R = a.r * this.scale;
    cx.save();
    cx.globalAlpha = alpha;
    cx.translate(X, Y);
    cx.rotate(a.rot + a.spin * t);
    cx.beginPath();
    shape.forEach((f, k) => {
      const ang = (k / shape.length) * TAU;
      const px = Math.cos(ang) * R * f, py = Math.sin(ang) * R * f;
      k ? cx.lineTo(px, py) : cx.moveTo(px, py);
    });
    cx.closePath();
    const grd = cx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.1, 0, 0, R);
    grd.addColorStop(0, '#b9a89a');
    grd.addColorStop(1, '#4e4058');
    cx.fillStyle = grd;
    cx.fill();
    cx.strokeStyle = 'rgba(255,150,110,0.55)';
    cx.lineWidth = 1.5;
    cx.stroke();
    cx.fillStyle = 'rgba(30,20,40,0.35)';
    cx.beginPath();
    cx.arc(R * 0.2, R * 0.15, R * 0.22, 0, TAU);
    cx.fill();
    cx.restore();
  }

  _drawWell(w) {
    const cx = this.cx;
    const X = this.sx(w.x), Y = this.sy(w.y), s = this.scale;
    const G = this._glow('150,80,255', 64);
    const GR = 95 * s;
    cx.drawImage(G, X - GR, Y - GR, GR * 2, GR * 2);
    cx.save();
    cx.translate(X, Y);
    const t = this.time;
    for (let arm = 0; arm < 4; arm++) {
      cx.rotate(TAU / 4);
      cx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const f = k / 24;
        const ang = -t * 2.2 + f * 3.2;
        const r = (12 + f * 46) * s;
        const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
        k ? cx.lineTo(px, py) : cx.moveTo(px, py);
      }
      cx.strokeStyle = 'rgba(190,140,255,0.35)';
      cx.lineWidth = 2;
      cx.stroke();
    }
    cx.restore();
    const core = cx.createRadialGradient(X, Y, 0, X, Y, 14 * s);
    core.addColorStop(0, '#000');
    core.addColorStop(0.75, '#0a0014');
    core.addColorStop(1, 'rgba(200,150,255,0.9)');
    cx.fillStyle = core;
    cx.beginPath();
    cx.arc(X, Y, 12 * s, 0, TAU);
    cx.fill();
  }

  _drawStar(st) {
    const cx = this.cx;
    const X = this.sx(st.x), Y = this.sy(st.y + Math.sin(this.time * 3 + st.id) * 2.5);
    const s = this.scale;
    const G = this._glow('255,220,90', 32);
    const GR = 18 * s;
    cx.drawImage(G, X - GR, Y - GR, GR * 2, GR * 2);
    cx.save();
    cx.translate(X, Y);
    cx.rotate(Math.sin(this.time * 2 + st.id) * 0.4);
    starPath(cx, 7.5 * s, 3.4 * s);
    cx.fillStyle = '#ffd75a';
    cx.fill();
    cx.strokeStyle = '#fff3c0';
    cx.lineWidth = 1.2;
    cx.stroke();
    cx.restore();
  }

  _drawAim(g, x, y, aim) {
    // dotted tangent line. Full guide (first hops): green when a tap now would land, gold when it
    // would be PERFECT — from an exact simulation of the tap, so moving planets/wells can't fool it.
    // Over the next few planets it fades (aim.fade 0.8 → 0.2): shorter, dimmer and paler each hop.
    // Afterwards a short plain stub still shows which way you'd fly.
    const tx = -Math.sin(g.angle) * g.dir, ty = Math.cos(g.angle) * g.dir;
    const f = aim.full ? (aim.fade ?? 1) : 0;
    let col = '255,255,255';
    if (aim.full && aim.ok) {
      const c = aim.perfect ? [255, 215, 90] : [120, 255, 170];
      const k = 0.35 + 0.65 * f; // tint strength: fully coloured at f = 1, pale at the end of the fade
      col = c.map((v) => Math.round(255 + (v - 255) * k)).join(',');
    }
    const cx = this.cx;
    const L = 80 + 180 * f;
    const lit = aim.full && aim.ok;
    const base = 0.5 + ((lit ? 1 : 0.75) - 0.5) * f;
    const rad = (lit ? 1.8 + 0.6 * f : 1.8) * Math.max(1, this.scale * 0.85);
    for (let d = 14; d < L; d += 11) {
      const a = (1 - (d / L) * 0.85) * base;
      cx.fillStyle = `rgba(${col},${a})`;
      cx.beginPath();
      cx.arc(this.sx(x + tx * d), this.sy(y + ty * d), rad, 0, TAU);
      cx.fill();
    }
  }

  // ------------------------------------------------------------ ships & trails
  _trail(key, x, y, alive, max) {
    let tr = this.trails.get(key);
    if (!tr) this.trails.set(key, (tr = []));
    const last = tr[tr.length - 1];
    if (!last || Math.hypot(last.x - x, last.y - y) > 1.5) tr.push({ x, y });
    while (tr.length > max) tr.shift();
    if (!alive && tr.length) tr.shift();
  }

  _drawTrail(key, color, alpha) {
    const tr = this.trails.get(key);
    if (!tr || tr.length < 2) return;
    const cx = this.cx;
    cx.lineCap = 'round';
    for (let k = 1; k < tr.length; k++) {
      const f = k / tr.length;
      cx.strokeStyle = hexA(color, f * f * alpha * 0.8);
      cx.lineWidth = Math.max(1, f * 5 * this.scale);
      cx.beginPath();
      cx.moveTo(this.sx(tr[k - 1].x), this.sy(tr[k - 1].y));
      cx.lineTo(this.sx(tr[k].x), this.sy(tr[k].y));
      cx.stroke();
    }
  }

  _drawShip(x, y, g, color, alpha = 1, isPlayer = false) {
    const cx = this.cx;
    let ang;
    if (g.phase === 'flight' || g.phase === 'dead') ang = Math.atan2(g.vy, g.vx);
    else ang = Math.atan2(Math.cos(g.angle) * g.dir, -Math.sin(g.angle) * g.dir);
    const X = this.sx(x), Y = this.sy(y), s = this.scale * (isPlayer ? 1.15 : 1);
    cx.save();
    cx.globalAlpha = alpha;
    cx.translate(X, Y);
    cx.rotate(-ang); // screen y is flipped
    if (isPlayer) {
      const G = this._glow('130,230,255', 32);
      cx.drawImage(G, -16 * s, -16 * s, 32 * s, 32 * s);
    }
    // flame
    const flying = g.phase === 'flight';
    const fl = (flying ? 9 : 4) + Math.random() * (flying ? 5 : 2);
    cx.fillStyle = flying ? 'rgba(255,190,90,0.95)' : 'rgba(255,190,90,0.7)';
    cx.beginPath();
    cx.moveTo(-6 * s, -2.6 * s);
    cx.lineTo((-6 - fl) * s, 0);
    cx.lineTo(-6 * s, 2.6 * s);
    cx.fill();
    cx.fillStyle = 'rgba(255,255,220,0.9)';
    cx.beginPath();
    cx.moveTo(-6 * s, -1.3 * s);
    cx.lineTo((-6 - fl * 0.5) * s, 0);
    cx.lineTo(-6 * s, 1.3 * s);
    cx.fill();
    // body
    cx.fillStyle = color;
    cx.beginPath();
    cx.moveTo(9 * s, 0);
    cx.quadraticCurveTo(2 * s, -5.2 * s, -6 * s, -4.2 * s);
    cx.lineTo(-6 * s, 4.2 * s);
    cx.quadraticCurveTo(2 * s, 5.2 * s, 9 * s, 0);
    cx.fill();
    // fins
    cx.fillStyle = isPlayer ? '#ff5d8f' : 'rgba(0,0,0,0.35)';
    cx.beginPath();
    cx.moveTo(-3 * s, -4 * s);
    cx.lineTo(-8 * s, -7.5 * s);
    cx.lineTo(-6.5 * s, -2.5 * s);
    cx.fill();
    cx.beginPath();
    cx.moveTo(-3 * s, 4 * s);
    cx.lineTo(-8 * s, 7.5 * s);
    cx.lineTo(-6.5 * s, 2.5 * s);
    cx.fill();
    // window
    cx.fillStyle = isPlayer ? '#2bc4ff' : 'rgba(10,10,30,0.6)';
    cx.beginPath();
    cx.arc(2.5 * s, 0, 1.9 * s, 0, TAU);
    cx.fill();
    cx.restore();
  }

  _drawGhostTag(gh, X, Y) {
    const cx = this.cx;
    if (Y < -20 || Y > this.h + 20) return;
    const label = gh.game.phase === 'dead' ? `BOT ${gh.name} ✕` : `BOT ${gh.name}`;
    cx.font = `600 11px ${FONT}`;
    cx.textAlign = 'center';
    const w = cx.measureText(label).width + 10;
    cx.globalAlpha = gh.game.phase === 'dead' ? 0.5 : 0.9;
    cx.fillStyle = 'rgba(10,8,30,0.8)';
    roundRect(cx, X - w / 2, Y, w, 15, 7);
    cx.fill();
    cx.fillStyle = gh.color;
    cx.fillText(label, X, Y + 11);
    cx.globalAlpha = 1;
  }

  _drawOffscreenGhosts(ghosts, top, finishAt) {
    const cx = this.cx;
    cx.font = `600 11px ${FONT}`;
    cx.textAlign = 'center';
    const gap = 4, margin = 6;
    // bots above the visible course (or hidden under the standings board) get a pill at the top
    const pills = ghosts
      .filter((gh) => (gh.game.alive || gh.game.phase === 'finished') && this.sy(gh.game.y) < top + 36)
      .map((gh) => {
        const hops = finishAt ? Math.min(gh.game.hops, finishAt) : gh.game.hops;
        const label = `▲ BOT ${gh.name} · ${hops}`;
        return { gh, label, w: cx.measureText(label).width + 12, x: this.sx(gh.game.x) };
      })
      .sort((a, b) => a.x - b.x);
    if (!pills.length) return;
    // 1-D layout: keep each pill near its bot's x, push neighbours apart, then fit on screen
    for (let k = 0; k < pills.length; k++) {
      const p = pills[k];
      p.x = Math.max(p.x, p.w / 2 + margin);
      if (k) p.x = Math.max(p.x, pills[k - 1].x + pills[k - 1].w / 2 + gap + p.w / 2);
    }
    for (let k = pills.length - 1; k >= 0; k--) {
      const p = pills[k];
      const lim = k === pills.length - 1 ? this.w - margin - p.w / 2 : pills[k + 1].x - pills[k + 1].w / 2 - gap - p.w / 2;
      p.x = Math.min(p.x, lim);
    }
    const Y = top + 16;
    for (const p of pills) {
      cx.fillStyle = 'rgba(10,8,30,0.8)';
      roundRect(cx, p.x - p.w / 2, Y - 12, p.w, 17, 8);
      cx.fill();
      cx.fillStyle = p.gh.color;
      cx.fillText(p.label, p.x, Y + 1);
    }
  }

  // ------------------------------------------------------------ particles / text
  _drawFx(dt) {
    const cx = this.cx;
    const s = this.scale;
    // rings
    for (let k = this.rings.length - 1; k >= 0; k--) {
      const r = this.rings[k];
      r.life += dt;
      const f = r.life / r.max;
      if (f >= 1) {
        this.rings.splice(k, 1);
        continue;
      }
      const rad = lerp(r.r, r.r2, easeOut(f)) * s;
      cx.strokeStyle = `rgba(${r.color},${(1 - f) * 0.8})`;
      cx.lineWidth = 3 * (1 - f) + 1;
      cx.beginPath();
      cx.arc(this.sx(r.x), this.sy(r.y), rad, 0, TAU);
      cx.stroke();
    }
    // particles
    cx.globalCompositeOperation = 'lighter';
    for (let k = this.particles.length - 1; k >= 0; k--) {
      const p = this.particles[k];
      p.life += dt;
      if (p.life >= p.max) {
        this.particles.splice(k, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-dt * 2.2);
      p.vy *= Math.exp(-dt * 2.2);
      const f = 1 - p.life / p.max;
      const X = this.sx(p.x), Y = this.sy(p.y);
      if (p.debris) {
        cx.globalCompositeOperation = 'source-over';
        p.rot += p.spin * dt;
        cx.save();
        cx.translate(X, Y);
        cx.rotate(p.rot);
        cx.fillStyle = `rgba(${p.color},${f})`;
        cx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        cx.restore();
        cx.globalCompositeOperation = 'lighter';
      } else {
        cx.fillStyle = `rgba(${p.color},${f})`;
        const sz = p.size * (0.5 + f * 0.8);
        cx.fillRect(X - sz / 2, Y - sz / 2, sz, sz);
      }
    }
    cx.globalCompositeOperation = 'source-over';
    // floating texts
    for (let k = this.texts.length - 1; k >= 0; k--) {
      const t = this.texts[k];
      t.life += dt;
      const f = t.life / t.max;
      if (f >= 1) {
        this.texts.splice(k, 1);
        continue;
      }
      const pop = f < 0.15 ? 0.6 + (f / 0.15) * 0.6 : 1.2 - Math.min(0.2, (f - 0.15) * 0.5);
      const size = (t.big ? 20 : 14) * pop;
      cx.font = `700 ${Math.round(size)}px ${FONT}`;
      cx.textAlign = 'center';
      cx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
      const X = clamp(this.sx(t.x), 70, this.w - 70), Y = this.sy(t.y + f * 30);
      cx.lineWidth = 4;
      cx.strokeStyle = 'rgba(10,6,30,0.85)';
      cx.strokeText(t.text, X, Y);
      cx.fillStyle = t.color;
      cx.fillText(t.text, X, Y);
      cx.globalAlpha = 1;
    }
  }
}

// ------------------------------------------------------------ helpers
function mixColor(a, b, t) {
  t = clamp(t, 0, 1);
  return `${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))}`;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}
function starPath(cx, R, r) {
  cx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r : R;
    k ? cx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : cx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  cx.closePath();
}
function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

export { PALETTES, FONT };
