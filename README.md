# Orbit Hop

A one-tap space arcade game for the browser. Your ship circles a planet. **Tap to launch**: you fly off in a straight line along your orbit. Fly into the next planet's dashed ring to be captured, then do it again. Orbits decay, so you can't wait forever. Asteroids, moons and gravity wells get in the way. Aim dead-centre for a **PERFECT** hop and chain PERFECTs into combos. Runs are short (a few seconds to a minute), and a new run is one tap away.

- **Genre:** one-tap arcade / reflex
- **Controls:** tap / click / <kbd>Space</kbd> (also <kbd>↑</kbd>, <kbd>W</kbd>, <kbd>Enter</kbd>) to launch · <kbd>P</kbd>/<kbd>Esc</kbd> pause · <kbd>R</kbd> instant restart · <kbd>M</kbd> mute · <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> pick a mode on the title screen
- **Modes**
  - **Endless**: a random procedural course that gets harder the further you go. Your high score is saved.
  - **Daily #N**: one seeded course per local calendar day, the same for every player. Tracks your attempts, best run and daily streak. **Share daily** copies a spoiler-free result such as `Orbit Hop #12 🚀 38 hops ⭐14` plus an emoji strip of your hops.
  - **Race 3 bots**: a race to planet 20 on a shared seeded course against three **clearly labelled computer opponents** (BOT Vega, BOT Orion, BOT Pip). They fly as translucent ghosts, their timing is imperfect, and they can crash. You'll see a live standings bar and a final results table.
- Stats, best scores, daily results and settings are stored in `localStorage`. No accounts, no network.

## Run locally

No build step and no dependencies.

```sh
python3 -m http.server 8841 -d docs
# open http://localhost:8841/
```

Everything is under `docs/`. All paths are relative and nothing is loaded from the network at runtime (no CDNs, fonts or analytics), so the game works offline and from any sub-path.

## Tests

```sh
node --test tests/*.test.js     # unit tests for the pure game logic (no deps)
node tests/e2e.mjs              # headless Chrome: plays every mode at desktop + phone sizes
```

`tests/e2e.mjs` needs Playwright and Chrome. It imports Playwright from the path in `$PLAYWRIGHT` (it defaults to a sibling project's copy; Playwright is *not* a dependency of the game). It serves `docs/` on a free port in 8842–8849 and plays Endless, Daily and Race start to finish at 1280×800 and at 390×844 with touch. It also does quick checks at 960×540 and phone landscape. It asserts zero console errors and writes screenshots to `/workspace/arcade-shots/orbithop/` (override with `SHOTS_DIR`).

Dev tools:
- `node tools/simulate.mjs 60 race`: bot balance report over 60 seeds.
- `node tools/make-assets.mjs`: regenerates `icon-*.png` and `og.png`. It needs a server on port 8841.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Build and deployment**, choose *Deploy from a branch*, then branch `main` and folder **`/docs`**.
3. The game is served at `https://<user>.github.io/<repo>/`. The "More games" link points to `../arcade/`, the sibling hub path.

## Project layout

```
docs/                 deployable static site
  index.html          markup, SVG icon sprite, meta/OG tags
  css/style.css       UI styles (mobile-first, safe-area aware)
  js/core.js          PURE deterministic game logic: seeded RNG, course generation,
                      fixed-timestep simulation, bots, ranking, daily + share helpers
  js/render.js        Canvas 2D renderer (camera, parallax, planets, particles, ghosts)
  js/audio.js         WebAudio synthesised SFX + tiny chiptune loop
  js/storage.js       localStorage persistence
  js/main.js          app shell: screens, input, loop, modes, results, sharing
  fonts/              Fredoka subset (SIL OFL 1.1) + OFL.txt
tests/                node --test unit tests + Playwright e2e
tools/                dev-only balance sim and asset generator
```

## Architecture notes

`docs/js/core.js` doesn't touch the DOM, the clock or `Math.random`. A run is fully determined by `(seed, tap ticks)`:

- Course: `new Course(seed)` generates planet *i* and the gap after it lazily, from `mixSeed(seed, i)`. Access order doesn't change the result.
- Simulation: `Game.step()` advances one fixed 1/60 s tick and returns events (launch, capture, star, warn, crash, finish). The renderer and audio only consume these events.
- Replays: `replay(seed, taps)` re-simulates a run exactly. This allows ghost replays and server-side score verification.
- Bots: `BotPilot` looks ahead with throw-away clones of the game (`predictTap`). Its real tap lands ±jitter ticks off, it sometimes blunders, and it gets less picky as its orbit decays. It is deterministic given its seed.

## Credits & licenses

- Code, art and sound are original. All graphics are drawn in code and all audio is synthesised with WebAudio. MIT licensed, see `LICENSE`.
- Font: **Fredoka** © 2016 The Fredoka Project Authors (Milena B. Brandão, Ben Nathan), SIL Open Font License 1.1. A subset ships in `docs/fonts/fredoka.woff`, with the license in `docs/fonts/OFL.txt`.
- No third-party data is used.
