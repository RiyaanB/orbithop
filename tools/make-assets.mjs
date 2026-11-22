// Dev-only: render PNG icons from favicon.svg and the og.png share image from the live game.
// Usage: serve docs/ on PORT (default 8841) then `node tools/make-assets.mjs`.
import fs from 'node:fs';
import path from 'node:path';
const PW = process.env.PLAYWRIGHT || '/home/box/swarm/side-gig/games/triangulate/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const port = process.env.PORT || 8841;
const docs = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../docs');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const svg = fs.readFileSync(path.join(docs, 'favicon.svg'), 'utf8');
for (const size of [180, 192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: path.join(docs, `icon-${size}.png`), omitBackground: true });
  await p.close();
}
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.goto(`http://127.0.0.1:${port}/?seed=7`);
await p.addStyleTag({ content: '.modes,.title-row,.stats,.title-foot{display:none!important} .title-wrap{display:block!important;width:auto!important} .logo h1{font-size:120px!important} .tagline{font-size:30px!important;color:#fff!important} .logo-orbit{width:480px;height:130px;margin:-65px 0 0 -240px} .logo-ship{offset-path:ellipse(240px 65px at 50% 50%)}' });
await p.evaluate(() => window.__orbithop.setAttractDim(0.2));
await p.waitForTimeout(3500);
await p.screenshot({ path: path.join(docs, 'og.jpg'), type: 'jpeg', quality: 86 });
await b.close();
console.log('assets written');
