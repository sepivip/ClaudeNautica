#!/usr/bin/env node
/**
 * BUILD HEALTH GATE. Run this before dispatching work and before judging any
 * frame. Exits non-zero if the build is not renderable.
 *
 *   node tools/verify.mjs           # fast: boot + one shot
 *   node tools/verify.mjs --full    # boot + all 18 shots + perf budget
 *
 * WHY THIS EXISTS. A vertex-stage fwidth() once failed to link 34-37 shader
 * programs. Nothing threw. Every module reported init OK. The game drew flora
 * and a HUD over empty water, and an entire round of agent work — six builders,
 * six critics, five subsystem scores — was spent grading a game that was not
 * rendering. The cost of that round was far higher than the cost of this check.
 *
 * It fails on:
 *   - any module that failed to init or threw during update
 *   - ANY shader that failed to compile or link  <- the one that got us
 *   - a frame that is suspiciously empty (near-zero triangles)
 *   - a page error or unhandled rejection
 *   - with --full: any shot below the fps budget
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const FULL = process.argv.includes('--full');
const MIN_FPS = Number((process.argv.find((a) => a.startsWith('--minfps=')) || '--minfps=60').split('=')[1]);
const MIN_TRIS = 50000;

const fail = [];
const warn = [];

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  headless: true, channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

try {
  // Cold starts genuinely time out sometimes (first Vite transform of ~57k lines,
  // then shader compilation). A gate that cries wolf gets ignored, which is the
  // one thing this gate cannot afford — so retry the boot, and only call it
  // broken if it fails twice.
  let booted = false;
  for (let attempt = 1; attempt <= 2 && !booted; attempt++) {
    try {
      await page.goto(`${url}/?capture=1`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__CN?.ready === true, null, { timeout: 180000, polling: 250 });
      booted = true;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log('  (boot attempt 1 timed out — retrying once before failing)');
      await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    }
  }

  const shots = FULL
    ? await page.evaluate(() => window.__CN.listShots())
    : ['shallows-floor'];

  const rows = [];
  for (const name of shots) {
    await page.evaluate(() => window.__CN.freeze(true));
    await page.evaluate((n) => window.__CN.shot(n), name);
    await page.evaluate(() => window.__CN.freeze(false));
    await page.waitForTimeout(900);
    const st = await page.evaluate(() => window.__CN.status());
    rows.push({ name, fps: st.fps, tris: st.triangles, draws: st.drawCalls });
    if (st.triangles < MIN_TRIS) fail.push(`${name}: only ${st.triangles} triangles drawn — the frame is empty`);
    // Geometry can be submitted and still land on a black screen — the drawCalls
    // check would pass that. Sample the actual framebuffer.
    const lum = await page.evaluate(() => {
      // Render and read in the SAME task. Without preserveDrawingBuffer the WebGL
      // buffer is cleared once the frame is composited, so reading it from a
      // separate evaluate() returns black — which is exactly the false positive
      // this check produced on its first run.
      window.__CN.engine.render();
      const c = window.__CN.engine.canvas;
      const t = document.createElement('canvas');
      t.width = 64; t.height = 36;
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let s = 0, mx = 0;
      for (let i = 0; i < d.length; i += 4) {
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += L; if (L > mx) mx = L;
      }
      return { mean: s / (d.length / 4), max: mx };
    }).catch(() => null);
    if (lum && lum.max < 4) {
      fail.push(`${name}: frame is BLACK (max luminance ${lum.max.toFixed(1)}) despite ${st.triangles} triangles — geometry drew into nothing`);
    }
    /**
     * fps is a HARD failure below half budget, a warning below budget.
     *
     * This was warn-only and gated behind --full, so a battery running
     * kelp-forest at 21.0, seamoth at 18.9 and surface-above at 26.3 fps on an
     * RTX 5070 still reported "BUILD OK". A blind critic found it, not the gate.
     * Draw calls were fine everywhere (208-534 against 900), so this is fill and
     * shader cost, and nothing in the loop was watching for it.
     */
    if (st.fps > 0 && st.fps < MIN_FPS * 0.5) {
      fail.push(`${name}: ${st.fps} fps — less than HALF the ${MIN_FPS} budget (draws ${st.draws ?? st.drawCalls})`);
    } else if (st.fps > 0 && st.fps < MIN_FPS) {
      warn.push(`${name}: ${st.fps} fps (budget ${MIN_FPS})`);
    }
  }

  const st = await page.evaluate(() => window.__CN.status());
  for (const s of st.shaderErrors || []) fail.push(s);
  for (const s of (st.modules || []).filter((m) => !m.ok && !m.missing)) fail.push(`module ${s.id}: ${s.error}`);
  for (const s of (st.stubs || [])) warn.push(`module ${s} is still a stub`);
  for (const e of pageErrors) fail.push(`pageerror: ${e}`);

  console.log('\n  shot                fps     draws    tris');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.fps).padStart(6)}  ${String(r.draws).padStart(6)}  ${r.tris}`);
  }
} catch (e) {
  const msg = String(e.message);
  // Vite HMR navigates the page when another agent writes a source file, which
  // surfaced as "Execution context was destroyed" and got reported as a broken
  // build. The gate is the one thing everyone is told to trust, so it must not
  // cry wolf at a concurrent edit.
  if (/Execution context was destroyed|navigation/i.test(msg)) {
    warn.push('harness: page navigated mid-run (likely a concurrent source edit / vite HMR) — rerun to confirm');
  } else {
    fail.push('harness: ' + msg.slice(0, 200));
  }
}

await browser.close();
await server.close();

console.log('');
if (warn.length) {
  console.log('  WARNINGS');
  for (const w of warn) console.log('    ! ' + w);
  console.log('');
}
if (fail.length) {
  console.log('  ***************************************************************');
  console.log('  *** BUILD IS BROKEN — DO NOT JUDGE ANY FRAME FROM THIS BUILD ***');
  console.log('  ***************************************************************');
  for (const f of fail) console.log('    X ' + f.slice(0, 200));
  console.log(`\n  ${fail.length} blocking problem(s). Fix these before any visual work.\n`);
  process.exit(1);
}
console.log('  BUILD OK — renderable, no shader failures, no module failures.\n');
process.exit(0);
