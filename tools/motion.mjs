#!/usr/bin/env node
/**
 * Motion capture for critics: still frames cannot show whether kelp sways
 * plausibly, whether a fish undulates, or whether the swim feel has weight.
 *
 *   node tools/motion.mjs --tag=flora-r1 --shot=kelp-forest --frames=9 --interval=0.28
 *      -> shots/<tag>/motion-<shot>.png       a labelled contact sheet (one image, 9 frames)
 *      -> shots/<tag>/motion-<shot>-NN.png    the individual frames
 *
 *   node tools/motion.mjs --tag=x --shot=hud --frames=12 --interval=0.2 --dolly=0,0,-14
 *      moves the camera over the sequence, for judging parallax and streaming pop.
 *
 * The contact sheet is the point: one Read call shows a critic the whole motion.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.replace(/^--/, ''); const j = i.indexOf('=');
  return j < 0 ? [i, true] : [i.slice(0, j), i.slice(j + 1)];
}));

const TAG = argv.tag || 'adhoc';
const SHOT = argv.shot || 'shallows-reef';
const FRAMES = Number(argv.frames || 9);
const INTERVAL = Number(argv.interval || 0.3);      // simulated seconds between frames
const W = Number(argv.w || 640), H = Number(argv.h || 360);
const COLS = Number(argv.cols || 3);
const DOLLY = String(argv.dolly || '0,0,0').split(',').map(Number);
const OUT = path.resolve('shots', TAG);

const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--enable-unsafe-swiftshader', '--disable-frame-rate-limit'];

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: GPU_ARGS });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));

await mkdir(OUT, { recursive: true });
await page.goto(`${url}/?seed=${argv.seed || 1337}&capture=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__CN?.ready === true, null, { timeout: 180000, polling: 250 });

// Capture the sequence entirely inside the page, then tile it into one sheet.
const sheet = await page.evaluate(async ({ shot, frames, interval, cols, dolly, w, h }) => {
  const CN = window.__CN;
  CN.freeze(true);
  const meta = await CN.shot(shot);
  const cam = CN.engine.camera;
  const start = cam.position.clone();

  const gl = CN.engine.canvas;
  const rows = Math.ceil(frames / cols);
  const pad = 4;
  const sheetCv = document.createElement('canvas');
  sheetCv.width = cols * w + (cols + 1) * pad;
  sheetCv.height = rows * h + (rows + 1) * pad + 22;
  const c2 = sheetCv.getContext('2d');
  c2.fillStyle = '#05161f'; c2.fillRect(0, 0, sheetCv.width, sheetCv.height);

  const singles = [];
  for (let i = 0; i < frames; i++) {
    if (i > 0) CN.step(Math.max(1, Math.round(interval * 60)), 1 / 60);
    if (dolly.some((v) => v !== 0)) {
      const k = i / Math.max(1, frames - 1);
      cam.position.set(start.x + dolly[0] * k, start.y + dolly[1] * k, start.z + dolly[2] * k);
      cam.updateMatrixWorld(true);
      CN.step(1, 1 / 60);
    }
    CN.engine.render();
    const cx = pad + (i % cols) * (w + pad);
    const cy = pad + Math.floor(i / cols) * (h + pad);
    c2.drawImage(gl, cx, cy, w, h);
    c2.fillStyle = 'rgba(0,0,0,.62)'; c2.fillRect(cx, cy, 62, 18);
    c2.fillStyle = '#8fe6ff'; c2.font = '12px monospace';
    c2.fillText(`t+${(i * interval).toFixed(2)}s`, cx + 5, cy + 13);
    singles.push(gl.toDataURL('image/png'));
  }
  c2.fillStyle = '#6fb6cd'; c2.font = '13px monospace';
  c2.fillText(`${shot} — ${frames} frames, ${interval}s apart (read left→right, top→bottom)`,
    pad + 2, sheetCv.height - 7);

  CN.freeze(false);
  return { sheet: sheetCv.toDataURL('image/png'), singles, desc: meta.desc };
}, { shot: SHOT, frames: FRAMES, interval: INTERVAL, cols: COLS, dolly: DOLLY, w: W, h: H });

const write = async (dataUrl, file) =>
  writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

await write(sheet.sheet, path.join(OUT, `motion-${SHOT}.png`));
for (let i = 0; i < sheet.singles.length; i++) {
  await write(sheet.singles[i], path.join(OUT, `motion-${SHOT}-${String(i).padStart(2, '0')}.png`));
}

await browser.close();
await server.close();
console.log(`[motion] ${SHOT}: ${FRAMES} frames @ ${INTERVAL}s -> shots/${TAG}/motion-${SHOT}.png (contact sheet)`);
if (errors.length) console.log(`[motion] page errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
