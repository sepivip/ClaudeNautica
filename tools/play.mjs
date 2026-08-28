#!/usr/bin/env node
/**
 * Scripted playthrough: drive the game through its REAL input path (synthetic
 * key/mouse events), then report what a player would have experienced.
 *
 * Screenshots prove it renders. This proves it *plays*.
 *
 *   node tools/play.mjs --route=dive --tag=movement-r1
 *   node tools/play.mjs --route=explore --tag=x --frames=12
 *   node tools/play.mjs --list
 *
 * Emits shots/<tag>/play-<route>.png (contact sheet) and play-<route>.json —
 * a timeline of position, depth, speed, oxygen, health and any errors, so a
 * critic can see whether the player actually moved, sank, drowned or got stuck.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.replace(/^--/, ''); const j = i.indexOf('=');
  return j < 0 ? [i, true] : [i.slice(0, j), i.slice(j + 1)];
}));

/** A route is a list of segments: how long, which keys are held, and mouse look per second. */
const ROUTES = {
  dive: {
    desc: 'Start at the surface, look down, swim down to ~40m, level off and look around',
    start: [0, 1.0, 0],
    segments: [
      { dur: 1.5, keys: [], look: [0, 0], note: 'floating at the surface' },
      { dur: 1.0, keys: [], look: [0, 26], note: 'look down' },
      { dur: 6.0, keys: ['KeyW'], look: [0, 0], note: 'swim down' },
      { dur: 1.2, keys: [], look: [0, -26], note: 'level off' },
      { dur: 4.0, keys: ['KeyW'], look: [30, 0], note: 'cruise and pan' },
      { dur: 2.0, keys: [], look: [0, 0], note: 'stop, drift' },
    ],
  },
  explore: {
    desc: 'Swim across the shallows at depth, panning to judge streaming, pop-in and life density',
    start: [30, -14, 40],
    segments: [
      { dur: 1.0, keys: [], look: [0, 0], note: 'settle' },
      { dur: 7.0, keys: ['KeyW'], look: [14, 0], note: 'cruise east, pan' },
      { dur: 5.0, keys: ['KeyW', 'KeyA'], look: [-20, 0], note: 'strafe and turn back' },
      { dur: 4.0, keys: ['KeyW'], look: [0, -14], note: 'rise while moving' },
    ],
  },
  descend: {
    // Was start [0,-20,0]: the seabed rises under this path, so a 20s nose-down
    // hold bottomed out at 41m and then RODE THE SEABED BACK UP. Two whole-game
    // rounds reported "no play route reaches the deep half of the game" — every
    // deep shot existed only as a teleported still. Start over the drop-off
    // instead, where the floor genuinely falls away to -244m.
    desc: 'Long descent over the drop-off into the deep — depth colour ramp and O2 pressure',
    start: [-160, -70, 150],
    segments: [
      { dur: 1.0, keys: [], look: [0, 30], note: 'look down over the lip' },
      { dur: 8.0, keys: ['KeyW'], look: [12, 0], note: 'out over the drop' },
      { dur: 20.0, keys: ['KeyW'], look: [0, 8], note: 'sustained descent into the deep' },
      { dur: 2.0, keys: [], look: [0, -40], note: 'look back up' },
    ],
  },
  pressure: {
    // Was [-160,-120,150]: at that XZ the seabed is -81.4, so the route STARTED 39m
    // INSIDE the terrain and frame 1 rendered the seabed from underneath with lit
    // water above it. Probed 50m along the dropoff bearing instead, where the floor
    // falls to about -261 and there is genuine open water to descend through.
    desc: 'Descends through the 144-200m suit-rating band, which no other route ever enters',
    start: [-143, -120, 197],
    segments: [
      { dur: 1.0, keys: [], look: [0, 42], note: 'pitch steeply down at 120m' },
      { dur: 16.0, keys: ['KeyW'], look: [3, 0], note: 'descend through the 144-200m warning band' },
      { dur: 10.0, keys: ['KeyW'], look: [0, 3], note: 'past the 200m suit rating' },
      { dur: 3.0, keys: [], look: [0, -40], note: 'hold and look back up' },
    ],
  },
  deep: {
    desc: 'Already deep: traverse at ~280m to judge the deep medium in motion, not as a still',
    start: [340, -280, -260],
    segments: [
      { dur: 1.0, keys: [], look: [0, 0], note: 'settle at 280m' },
      { dur: 10.0, keys: ['KeyW'], look: [16, 0], note: 'traverse the grand reef' },
      { dur: 6.0, keys: ['KeyW'], look: [0, 20], note: 'descend further' },
      { dur: 4.0, keys: [], look: [-30, 0], note: 'pan across the dark' },
    ],
  },
  surface: {
    desc: 'Rise from underwater and break the surface — tests the waterline crossing',
    start: [0, -12, 0],
    segments: [
      { dur: 1.0, keys: [], look: [0, -40], note: 'look up' },
      { dur: 8.0, keys: ['KeyW'], look: [0, 0], note: 'swim up through the surface' },
      { dur: 3.0, keys: [], look: [0, 30], note: 'level off above water' },
    ],
  },
};

if (argv.list) {
  for (const [k, v] of Object.entries(ROUTES)) console.log(`${k.padEnd(10)} ${v.desc}`);
  process.exit(0);
}

const ROUTE = argv.route || 'dive';
const TAG = argv.tag || 'adhoc';
const FRAMES = Number(argv.frames || 9);
const W = Number(argv.w || 640), H = Number(argv.h || 360);
const COLS = Number(argv.cols || 3);
const OUT = path.resolve('shots', TAG);
const r = ROUTES[ROUTE];
if (!r) { console.error(`unknown route "${ROUTE}" (have: ${Object.keys(ROUTES).join(', ')})`); process.exit(1); }

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  headless: true, channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-unsafe-swiftshader', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));

await mkdir(OUT, { recursive: true });
// harness=play, and deliberately NOT capture=1: a play route is real gameplay.
// survival.js keyed a 35 HP god-mode floor off capture=1, so every route ever run
// through this harness was measuring a game that could not kill the player.
await page.goto(`${url}/?seed=${argv.seed || 1337}&harness=play`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__CN?.ready === true, null, { timeout: 180000, polling: 250 });

const result = await page.evaluate(async ({ route, frames, cols, w, h }) => {
  const CN = window.__CN;
  const ctx = CN.ctx;
  const DT = 1 / 60;
  CN.freeze(true);

  // Pointer-lock never engages headlessly, so grant look control directly.
  ctx.input.locked = true;

  const mv = CN.modules.get('movement');
  // Place the player through the movement module if it exists, else the camera.
  if (mv?.position?.set) mv.position.set(...route.start);
  else if (mv?.setPosition) mv.setPosition(...route.start);
  CN.setCamera({ pos: route.start, yaw: 0, pitch: 0 });

  const total = route.segments.reduce((a, s) => a + s.dur, 0);
  const shotAt = Array.from({ length: frames }, (_, i) => (i / (frames - 1)) * total * 0.999);

  const rows = Math.ceil(frames / cols), pad = 4;
  const cv = document.createElement('canvas');
  cv.width = cols * w + (cols + 1) * pad;
  cv.height = rows * h + (rows + 1) * pad + 22;
  const g = cv.getContext('2d');
  g.fillStyle = '#05161f'; g.fillRect(0, 0, cv.width, cv.height);

  const timeline = []; let taken = 0, t = 0;
  const snap = (note) => {
    const cx = pad + (taken % cols) * (w + pad), cy = pad + Math.floor(taken / cols) * (h + pad);
    CN.engine.render();
    g.drawImage(CN.engine.canvas, cx, cy, w, h);
    g.fillStyle = 'rgba(0,0,0,.66)'; g.fillRect(cx, cy, w, 19);
    g.fillStyle = '#8fe6ff'; g.font = '12px monospace';
    const st = CN.status();
    g.fillText(`t+${t.toFixed(1)}s  ${st.depth}m  ${note}`.slice(0, 64), cx + 5, cy + 14);
    taken++;
  };

  for (const seg of route.segments) {
    for (const k of seg.keys) {
      ctx.input.keys.add(k); ctx.input.pressed.add(k);
      dispatchEvent(new KeyboardEvent('keydown', { code: k, bubbles: true }));
    }
    const steps = Math.max(1, Math.round(seg.dur / DT));
    for (let i = 0; i < steps; i++) {
      // re-assert held keys: the loop clears edge state every frame
      for (const k of seg.keys) ctx.input.keys.add(k);
      ctx.input.mouse.dx = seg.look[0] * DT * 8;
      ctx.input.mouse.dy = seg.look[1] * DT * 8;
      CN.step(1, DT);
      t += DT;
      const st = CN.status();
      const sv = CN.modules.get('survival');
      if (i % 12 === 0) {
        timeline.push({
          t: +t.toFixed(2), note: seg.note, depth: st.depth, pos: st.camera,
          fps: st.fps, draws: st.drawCalls,
          oxygen: sv?.oxygen ?? null, health: sv?.health ?? null,
        });
      }
      if (taken < frames && t >= shotAt[taken]) snap(seg.note);
    }
    for (const k of seg.keys) {
      ctx.input.keys.delete(k);
      dispatchEvent(new KeyboardEvent('keyup', { code: k, bubbles: true }));
    }
  }
  while (taken < frames) snap('end');

  g.fillStyle = '#6fb6cd'; g.font = '13px monospace';
  g.fillText(`route "${route.name}" — ${route.desc}`.slice(0, 130), pad + 2, cv.height - 7);

  /**
   * STOP MEASURING PAST DEATH. A respawn teleports the body to the lifepod, and
   * that jump was being folded into distanceTravelled — one route reported 340.3m
   * travelled of which 232m was the teleport, and depthEnd 0 because the player
   * was dead and floating at the surface. Truncate the measured window at the
   * first death, and report the death separately as the outcome it is.
   */
  let deathIdx = -1;
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1], cur = timeline[i];
    const died = (prev.health > 0 && cur.health <= 0);
    const jumped = Math.hypot(cur.pos[0] - prev.pos[0], cur.pos[1] - prev.pos[1], cur.pos[2] - prev.pos[2]) > 40;
    if (died || jumped) { deathIdx = i; break; }
  }
  const live = deathIdx > 0 ? timeline.slice(0, deathIdx) : timeline;
  const depths = live.map((x) => x.depth);
  const positions = live.map((x) => x.pos);
  const dist = positions.reduce((a, p, i) => i ? a + Math.hypot(p[0] - positions[i - 1][0], p[1] - positions[i - 1][1], p[2] - positions[i - 1][2]) : 0, 0);

  CN.freeze(false);
  return {
    sheet: cv.toDataURL('image/png'), timeline,
    summary: {
      died: deathIdx > 0,
      diedAtS: deathIdx > 0 ? timeline[deathIdx].t : null,
      diedAtDepth: deathIdx > 0 ? timeline[deathIdx - 1].depth : null,
      measuredUntilS: live.length ? live[live.length - 1].t : 0,
      durationS: +t.toFixed(1),
      distanceTravelled: +dist.toFixed(1),
      depthStart: depths[0], depthEnd: depths[depths.length - 1],
      depthMin: Math.min(...depths), depthMax: Math.max(...depths),
      moved: dist > 2,
      status: CN.status(),
      godModes: CN.status().godModes || [],
    },
  };
}, { route: { ...r, name: ROUTE }, frames: FRAMES, cols: COLS, w: W, h: H });

await writeFile(path.join(OUT, `play-${ROUTE}.png`),
  Buffer.from(result.sheet.split(',')[1], 'base64'));
await writeFile(path.join(OUT, `play-${ROUTE}.json`),
  JSON.stringify({ route: ROUTE, desc: r.desc, ...result.summary, timeline: result.timeline, errors: [...new Set(errors)] }, null, 2));

await browser.close(); await server.close();

const s = result.summary;
console.log(`[play] ${ROUTE}: ${s.durationS}s, travelled ${s.distanceTravelled}m, depth ${s.depthStart}m -> ${s.depthEnd}m (max ${s.depthMax}m)`);
if (s.died) console.log(`[play] player DIED at t+${s.diedAtS}s at ${s.diedAtDepth}m — metrics above cover only the live window (${s.measuredUntilS}s)`);
if (!s.moved) console.log('[play] WARNING: the player barely moved — movement may be broken or not yet built');
if (s.status?.godModes?.length) {
  console.log('[play] *** GOD MODES ACTIVE — THIS IS NOT THE REAL GAME ***');
  for (const g of s.status.godModes) console.log('  ' + g);
}
if (s.status.failed?.length) console.log(`[play] FAILED MODULES: ${s.status.failed.join(' | ')}`);
console.log(`[play] -> shots/${TAG}/play-${ROUTE}.png + .json`);
