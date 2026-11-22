// Dev-only tuning: run bots over many seeds and report how far they get.
import { Game, BotPilot, BOT_PROFILES, RACE_FINISH, mixSeed, CAUSES } from '../docs/js/core.js';
const N = Number(process.argv[2] || 60);
const finishAt = process.argv[3] === 'race' ? RACE_FINISH : null;
for (const key of Object.keys(BOT_PROFILES)) {
  const hops = [], secs = [], causes = {}; let fin = 0;
  const t0 = performance.now();
  for (let s = 1; s <= N; s++) {
    const g = new Game({ seed: mixSeed(s, 77), finishAt });
    const bot = new BotPilot(key, mixSeed(s, 99, key.length));
    while (g.alive && g.tick < 60 * 300) { bot.control(g); g.step(); }
    hops.push(g.hops); secs.push(g.tick / 60);
    if (g.phase === 'finished') fin++; else causes[g.cause] = (causes[g.cause] || 0) + 1;
  }
  hops.sort((a, b) => a - b); secs.sort((a, b) => a - b);
  const med = (a) => a[a.length >> 1];
  console.log(key.padEnd(7), 'hops med', med(hops), 'p10', hops[Math.floor(N * .1)], 'p90', hops[Math.floor(N * .9)], '| secs med', med(secs).toFixed(1), '| finished', fin, '|', JSON.stringify(causes), `| ${(performance.now() - t0).toFixed(0)}ms`);
}
