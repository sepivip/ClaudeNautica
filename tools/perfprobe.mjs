#!/usr/bin/env node
/**
 * REAL interactive performance probe.
 *
 * Every fps number this project has recorded came from tools/capture.mjs, which
 * FREEZES the render loop and steps it manually (CN.status().fpsSource === 'step').
 * That measures the cost of engine.render() alone. It never runs simulate(), so
 * per-frame module update() work — spawning, culling, flocking, allocation, GC
 * churn — has never been measured at all in 35 rounds.
 *
 * This runs the game the way a player does: the real requestAnimationFrame loop,
 * no capture flag, no freezing. It reports a PER-SECOND time series, because the
 * reported symptom is periodic ("fine for ~30s, then lags, then fine again") and
 * an average over a short window hides exactly that.
 *
 *   node tools/perfprobe.mjs [--seconds=90] [--shot=shallows-reef]
 *
 * NOTE for anyone extending this: main.js sets `m.update = null` on a module that
 * THROWS, permanently disabling it for the session. An instrumentation bug here
 * therefore does not just mismeasure, it silently deletes the thing being
 * measured. The first version of this file did exactly that and read 97.7 fps
 * from a game with most of its modules switched off.
 */
import { chromium } from 'playwright';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.replace(/^--/, ''); const j = i.indexOf('=');
  return j < 0 ? [i, true] : [i.slice(0, j), i.slice(j + 1)];
}));
const SECONDS = Number(argv.seconds || 90);
const SHOT = argv.shot || null;
const MOVE = argv.move !== undefined ? argv.move !== '0' : true;   // default: move like a player
const URL = `http://localhost:${argv.port || 5173}/?seed=${argv.seed || 1337}${argv.params ? '&' + argv.params : ''}`;

const browser = await chromium.launch({
  headless: true, channel: 'chrome',
  /**
   * COLD SHADER CACHE BY DEFAULT.
   *
   * Chrome persists compiled programs to a GPU shader disk cache that survives
   * across launches. Every probe run therefore warms the cache for the next one,
   * and an A/B measured back-to-back compares a cold arm against a warm one
   * rather than the change under test. It made a fix look like a 3x win when the
   * control, run afterwards, was identical.
   *
   * A player's first launch after a reboot is the COLD case, and that is the one
   * that reads 18 fps with 26-second freezes. Measure that by default; pass
   * --warmcache=1 to measure the repeat-launch case deliberately.
   */
  args: ['--use-angle=d3d11', '--use-gl=angle', '--enable-gpu-rasterization',
         '--ignore-gpu-blocklist', '--enable-zero-copy', '--js-flags=--expose-gc',
         ...(argv.warmcache === '1' ? [] : ['--disable-gpu-shader-disk-cache'])],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(240000);
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

console.log(`[perfprobe] ${URL}  (real rAF loop, ${SECONDS}s)`);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__CN?.ready === true, { timeout: 240000, polling: 250 });
if (SHOT) { await page.evaluate((s) => window.__CN.shot(s), SHOT); await page.waitForTimeout(500); }

const result = await page.evaluate(async ({ seconds, move }) => {
  const CN = window.__CN;
  const stats = new Map();
  const get = (id) => {
    let s = stats.get(id);
    if (!s) { s = { update: 0, preRender: 0, worst: 0 }; stats.set(id, s); }
    return s;
  };

  // Wrap without ever throwing out of the wrapper: main.js disables a module
  // whose update() throws, so a bug here would delete the subject.
  for (const [id, m] of CN.modules) {
    for (const key of ['update', 'preRender']) {
      const fn = m[key];
      if (typeof fn !== 'function') continue;
      m[key] = function (...args) {
        const t0 = performance.now();
        try { return fn.apply(this, args); }
        finally {
          try {
            const dt = performance.now() - t0;
            const s = get(id); s[key] += dt; if (dt > s.worst) s.worst = dt;
          } catch { /* never let instrumentation break the game */ }
        }
      };
    }
  }

  let renderMs = 0, renderN = 0, renderWorst = 0;
  const eng = CN.engine, origRender = eng.render.bind(eng);
  // Name the shader programs that compile DURING play. three.js compiles a
  // program lazily the first time a material/lighting/shadow variant is drawn,
  // synchronously, on the main thread.
  const compileEvents = [];
  let progSeen = new Set((eng.renderer.info.programs || []).map((p) => p.cacheKey));
  eng.render = function (...a) {
    const t0 = performance.now();
    try { return origRender(...a); }
    finally {
      const dt = performance.now() - t0;
      renderMs += dt; renderN++; if (dt > renderWorst) renderWorst = dt;
      if (dt > 120) {
        const now = (eng.renderer.info.programs || []);
        const fresh = now.filter((p) => !progSeen.has(p.cacheKey));
        for (const p of now) progSeen.add(p.cacheKey);
        compileEvents.push({
          ms: +dt.toFixed(0),
          newPrograms: fresh.length,
          names: fresh.map((p) => p.name || '?').join(),
          keys: fresh.map((p) => String(p.cacheKey || '')),
        });
      }
    }
  };

  // Per-second buckets so a periodic stall is visible instead of averaged away.
  // Long tasks: any main-thread block over 50ms, reported by the browser itself.
  // This attributes a stall even when it happens inside the renderer or the GC,
  // where per-module wrapping cannot see it.
  const longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longtasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* not all builds expose it */ }

  const series = [];
  const frames = [];
  let last = performance.now();
  let bucketStart = last, bucketFrames = 0, bucketWorst = 0, stop = false;

  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;
    frames.push(dt);
    bucketFrames++; if (dt > bucketWorst) bucketWorst = dt;
    if (now - bucketStart >= 1000) {
      series.push({
        t: Math.round((now - bucketStart) / 10) / 100,
        fps: +(bucketFrames / ((now - bucketStart) / 1000)).toFixed(1),
        worstMs: +bucketWorst.toFixed(1),
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : 0,
        objects: eng.scene ? countObjects(eng.scene) : 0,
        programs: eng.renderer?.info?.programs?.length ?? 0,
        calls: eng.renderer?.info?.render?.calls ?? 0,
        longtasks: longtasks.splice(0).map((l) => Math.round(l)).join(),
      });
      bucketStart = now; bucketFrames = 0; bucketWorst = 0;
    }
    if (!stop) requestAnimationFrame(tick);
  };
  function countObjects(root) { let n = 0; root.traverse(() => n++); return n; }

  requestAnimationFrame(tick);

  /**
   * MOVE, the way a player does.
   *
   * The first version of this probe sat with a static camera and saw only one or
   * two compile stalls in 110 s. Beka, swimming around, called the game "almost
   * unplayable" — because moving drags new species, biomes and terrain into
   * view continuously, and every first draw of an uncompiled variant is another
   * multi-second freeze. A static probe measures a strictly easier case than the
   * one a player experiences, which is why it under-reported the severity.
   */
  if (move) {
    const hold = (code, down) =>
      dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    hold('KeyW', true);
    const inp = CN.ctx?.input;
    const legs = [[26, 0], [-30, 6], [12, -8], [-18, 10], [34, 0], [0, 12], [-24, -6]];
    let leg = 0;
    const steer = setInterval(() => {
      const [yaw, pitch] = legs[leg++ % legs.length];
      if (inp?.mouse) { inp.mouse.dx = yaw * 0.9; inp.mouse.dy = pitch * 0.9; }
    }, 2500);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(steer);
    hold('KeyW', false);
  } else {
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  stop = true;

  frames.shift();
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const total = frames.reduce((a, b) => a + b, 0);

  const mods = [...stats.entries()]
    .map(([id, s]) => ({ id, up: s.update / Math.max(1, renderN), pre: s.preRender / Math.max(1, renderN), worst: s.worst }))
    .sort((a, b) => (b.up + b.pre) - (a.up + a.pre));

  return {
    frames: frames.length,
    fps: +(frames.length / (total / 1000)).toFixed(1),
    frameMs: { p50: +pct(0.5).toFixed(2), p90: +pct(0.9).toFixed(2), p99: +pct(0.99).toFixed(2), max: +sorted[sorted.length - 1].toFixed(1) },
    slowFrames: frames.filter((f) => f > 33).length,
    renderMsPerFrame: +(renderMs / Math.max(1, renderN)).toFixed(2),
    renderWorst: +renderWorst.toFixed(1),
    modules: mods.filter((m) => m.up + m.pre > 0.005 || m.worst > 5),
    series,
    programsEnd: eng.renderer?.info?.programs?.length ?? 0,
    compileEvents,
    liveModules: [...CN.modules].filter(([, m]) => m.update).length,
    totalModules: CN.modules.size,
  };
}, { seconds: SECONDS, move: MOVE });

console.log(`\n  REAL LOOP: ${result.fps} fps over ${result.frames} frames`);
console.log(`  frame ms:  p50 ${result.frameMs.p50}   p90 ${result.frameMs.p90}   p99 ${result.frameMs.p99}   MAX ${result.frameMs.max}`);
console.log(`  frames over 33ms (visible stutter): ${result.slowFrames}`);
console.log(`  render: ${result.renderMsPerFrame} ms/frame avg, worst ${result.renderWorst} ms`);
console.log(`  modules still alive: ${result.liveModules}/${result.totalModules}`);

console.log('\n  PER-SECOND SERIES (fps | worst frame ms | heap MB | scene objects):');
for (const s of result.series) {
  const bar = s.fps < 30 ? '  <<< STALL' : s.fps < 50 ? '  <<' : '';
  console.log(`    ${String(result.series.indexOf(s) + 1).padStart(3)}s ${String(s.fps).padStart(6)} ${String(s.worstMs).padStart(8)}ms ${String(s.heapMB).padStart(4)}MB ${String(s.objects).padStart(5)}obj ${String(s.programs).padStart(4)}prog${s.longtasks ? '  LT:' + s.longtasks : ''}${bar}`);
}

console.log('\n  per-module ms/frame (avg update, avg preRender, WORST single call):');
for (const m of result.modules.slice(0, 16)) {
  console.log(`    ${m.id.padEnd(16)}${m.up.toFixed(2).padStart(7)}${m.pre.toFixed(2).padStart(8)}${m.worst.toFixed(1).padStart(10)} ms`);
}
if (result.compileEvents?.length) {
  console.log('');
  console.log('  SLOW RENDER CALLS (>120ms) and what compiled during them:');
  for (const e of result.compileEvents) {
    console.log(`    ${String(e.ms).padStart(5)} ms   newPrograms=${e.newPrograms}  ${e.names}`);
    for (const k of e.keys) console.log(`            key: ${k}`);
  }
}
if (errs.length) { console.log('\n  console errors:'); for (const e of errs.slice(0, 5)) console.log('    ' + e); }
await browser.close();
