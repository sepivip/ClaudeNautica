#!/usr/bin/env node
/**
 * Render the real game headlessly on the GPU and write PNGs + a JSON report.
 *
 *   node tools/capture.mjs --tag=terrain-r1 --shots=shallows-reef,dropoff
 *   node tools/capture.mjs --tag=all-r3 --all
 *   node tools/capture.mjs --tag=x --all --w=2560 --h=1440
 *
 * Output: shots/<tag>/<shot>.png  and  shots/<tag>/report.json
 * The report contains module load status, JS errors, fps, draw calls and tris —
 * a critic should always read it, a black PNG usually means a module threw.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Split on the FIRST '=' only. Destructuring split('=') dropped everything after
 * the second one, so --params="aotoe=0&bloom=2" reached the page as bare "aotoe"
 * with no value — every ablation switch an agent passed through this flag was
 * silently inert. That is the third time a switch that quietly did nothing has
 * corrupted a round's evidence; every other tool here already parsed it this way.
 */
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const s = a.replace(/^--/, '');
    const i = s.indexOf('=');
    return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
  })
);

const TAG = argv.tag || 'adhoc';
const W = Number(argv.w || 1920);
const H = Number(argv.h || 1080);
const SEED = argv.seed || '1337';
const OUT = path.resolve('shots', TAG);
const TIMEOUT = Number(argv.timeout || 180000);

const GPU_ARGS = [
  '--use-gl=angle', '--use-angle=d3d11',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--enable-unsafe-swiftshader',            // fallback if d3d11 is unavailable
  '--disable-frame-rate-limit',
  '--force-device-scale-factor=1',
];

async function main() {
  /**
   * PURGE STALE PNGs BEFORE CAPTURING.
   *
   * capture.mjs was observed printing "FATAL: Execution context was destroyed"
   * and "0 shots" while LEAVING THE PREVIOUS RUN'S PNGs in place under the tag.
   * Anything measuring that tag afterwards silently read the OLD build and
   * reported it as the new one. Round 17 hit the same trap; a builder hit it
   * again in round 33.
   *
   * This is the fifth instrument bug in this project to manufacture false
   * evidence, so the rule is now structural rather than behavioural: a tag
   * directory NEVER contains frames from two different runs. Delete first, so a
   * crashed run leaves an empty directory that measures as missing instead of a
   * full one that measures as wrong.
   */
  await mkdir(OUT, { recursive: true });
  for (const f of await readdir(OUT).catch(() => [])) {
    if (/\.(png|json)$/i.test(f)) await rm(path.join(OUT, f), { force: true });
  }

  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');

  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: GPU_ARGS });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 400));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 400)));

  const report = { tag: TAG, url, width: W, height: H, seed: SEED, shots: [], startedAt: new Date().toISOString() };

  try {
    // --params=meter=0&bloom=0 — reach the modules' own debug/bypass switches.
    // Without this, knobs like postfx's ?meter= and ?nopostfx= were unreachable
    // from the harness, which is how a 58%-authority auto-exposure loop survived
    // four rounds of critique without anyone being able to A/B it.
    const extra = argv.params ? `&${String(argv.params).replace(/^[?&]/, '')}` : '';
    report.params = extra;
    await page.goto(`${url}/?seed=${SEED}&capture=1&harness=still${extra}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__CN && window.__CN.ready === true, null,
      { timeout: TIMEOUT, polling: 250 });

    const renderer = await page.evaluate(() => {
      const gl = window.__CN.engine.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    report.renderer = renderer;
    report.gpu = /SwiftShader/i.test(renderer) ? 'SOFTWARE (slow, not representative)' : 'HARDWARE';

    const all = await page.evaluate(() => window.__CN.listShots());
    const shots = argv.all ? all : String(argv.shots || 'shallows-reef').split(',').filter(Boolean);

    report.status = await page.evaluate(() => window.__CN.status());

    // A full battery is the input to cross-round comparison, so it defaults to
    // full isolation: a fresh page per shot. Costs a boot per shot, buys the
    // guarantee that a metric means the same thing in every battery.
    const isolate = argv.isolate !== undefined ? argv.isolate !== 'false' : !!argv.all;
    report.isolated = isolate;
    if (isolate) console.log('[capture] isolate: fresh page per shot (no cross-shot state)');

    /**
     * DISCARD A WARM-UP SHOT FIRST.
     *
     * A builder measured that the first capture of a cold session is not
     * comparable to any later one on a byte-identical tree: cave median 3.9 -> 7.7
     * (97%), cave R% 22 -> 30, shallows-reef topBottom 0.37 -> 1.68 (4.5x),
     * tileContrast 21.8 -> 14.8, and even draw calls 232 -> 214. Every capture
     * after the first reproduced to ~0.1%. So the published 0.4% noise floor did
     * not hold for a session's first run, and any round whose battery happened to
     * be first was comparing against a different machine state.
     *
     * Render one shot and throw it away, so the first REAL shot is the second
     * render of the session.
     */
    try {
      await page.evaluate(async (n) => {
        window.__CN.freeze(true);
        await window.__CN.shot(n);
        window.__CN.step(30, 1 / 60);
      }, shots[0]);
    } catch (e) { /* warm-up is best-effort; never fail the run on it */ }

    for (const name of shots) {
      // Reload before EVERY shot, including the first. Previously the reload was
      // skipped for shot #1 (report.shots.length > 0), so the warm-up render left
      // shot #1 on a page that had already drawn it while shots 2..n each got a
      // fresh one. On kelp-forest that is a 1.7x difference: position 1 reads
      // median 49.3 / sat 0.674, positions 2 and 5 read 28.4 / 0.759 and are
      // bit-identical to each other. grand-reef and shallows-reef are indifferent,
      // which is why it survived. My round-22 warm-up fix created this.
      if (isolate) {
        // waitUntil:'load' can resolve while a previous evaluate is still
        // unwinding, which surfaced as "Execution context was destroyed" in 2 of
        // 5 isolate runs. Wait for the network to go quiet as well.
        await page.goto(`${url}/?seed=${SEED}&capture=1&harness=still${extra}`,
          { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
          page.goto(`${url}/?seed=${SEED}&capture=1&harness=still${extra}`,
            { waitUntil: 'load', timeout: 60000 }));
        await page.waitForFunction(() => window.__CN && window.__CN.ready === true, null,
          { timeout: TIMEOUT, polling: 250 });
        // ready===true only means modules initialised. Streaming, adaptive
        // exposure and any temporal history still need to converge, and a shot
        // taken before they do carries the difference into the measurement.
      }
      // EVERY shot gets the same warm-up, including the first. Applying it only
      // after a reload made shot #1 the odd one out and simply moved the
      // order-dependence rather than removing it.
      await page.evaluate(() => { window.__CN.freeze(true); window.__CN.settle(3); });
      if (!all.includes(name)) { report.shots.push({ name, error: 'unknown shot' }); continue; }
      const t0 = Date.now();
      await page.evaluate(() => window.__CN.freeze(true));
      // "Execution context was destroyed" on one shot used to abort the entire
      // battery and leave a partial shots dir. Retry the shot instead — a builder
      // hit this twice on deep-void, on both the shipped and the ablated build,
      // and both succeeded on retry.
      let meta;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { meta = await page.evaluate((n) => window.__CN.shot(n), name); break; }
        catch (e) {
          if (attempt === 2) throw e;
          console.log(`  (shot ${name} lost its context — reloading and retrying)`);
          await page.goto(`${url}/?seed=${SEED}&capture=1&harness=still${extra}`,
            { waitUntil: 'load', timeout: 60000 }).catch(() => {});
          await page.waitForFunction(() => window.__CN && window.__CN.ready === true, null,
            { timeout: TIMEOUT, polling: 250 });
          await page.evaluate(() => { window.__CN.freeze(true); window.__CN.settle(3); });
        }
      }

      /**
       * Measure perf WITHOUT unfreezing.
       *
       * This used to freeze(false), wait 1200ms of WALL CLOCK, then re-freeze —
       * so the simulation advanced by however many frames the machine managed in
       * that window. Two runs at the same seed produced different animation
       * phase, different md5, and 217 vs 215 draw calls. A critic correctly
       * identified that as the reason fixed-crop A/B on this project is unsound
       * and why both a builder's claimed gains and any counter-claim had to be
       * treated as noise. Stepping a FIXED number of frames and timing them gives
       * real perf numbers and a reproducible frame.
       */
      const perf = await page.evaluate(() => {
        const CN = window.__CN;
        CN.step(1, 1 / 60);                    // warm, discard
        const t0 = performance.now();
        const N = 30;
        for (let i = 0; i < N; i++) CN.step(1, 1 / 60);
        const ms = (performance.now() - t0) / N;
        const st = CN.status();
        return { ...st, fps: +(1000 / ms).toFixed(1), fpsSource: 'stepped', msPerFrame: +ms.toFixed(2) };
      });
      // Re-apply the pose so the screenshot is taken from the shot's own settled
      // state, not 31 frames past it.
      await page.evaluate((n) => window.__CN.shot(n), name);

      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      const empty = perf.drawCalls === 0 || perf.triangles === 0;
      if (empty) {
        report.emptyFrames = report.emptyFrames || [];
        report.emptyFrames.push(name);
        report.brokenBuild = true;
      }
      report.shots.push({
        name, file: path.relative(process.cwd(), file), desc: meta.desc, ref: meta.ref,
        empty: empty || undefined,
        camera: meta.pos, yaw: meta.yaw, pitch: meta.pitch,
        fps: perf.fps, drawCalls: perf.drawCalls, triangles: perf.triangles,
        depth: perf.depth, ms: Date.now() - t0,
      });
      process.stdout.write(`  shot ${name.padEnd(18)} fps=${String(perf.fps).padStart(6)} draws=${String(perf.drawCalls).padStart(5)} tris=${perf.triangles}\n`);
    }

    report.status = await page.evaluate(() => window.__CN.status());
  } catch (err) {
    report.fatal = String(err.message);
    try { await page.screenshot({ path: path.join(OUT, '_fatal.png') }); } catch {}
  }

  report.consoleErrors = [...new Set(consoleErrors)].slice(0, 40);
  // Surface gameplay suppressions at the top level: a still battery legitimately
  // freezes some state, but a critic must be told rather than have to find out.
  report.godModes = report.status?.godModes || [];

  /**
   * A shader that fails to LINK leaves every module reporting init OK, so a
   * broken build looks exactly like an art problem. That happened: a vertex-stage
   * fwidth() killed 34-37 programs and an entire round of critique was spent
   * scoring frames with no terrain, no structures, no vehicles and no lamps.
   * Never again — this is a hard failure, reported at the top of the run.
   */
  const linkFailures = [...new Set(consoleErrors)].filter((e) =>
    /VALIDATE_STATUS false|not compiled|Shader Error|INVALID_OPERATION: useProgram/i.test(e));
  if (linkFailures.length) {
    report.shaderLinkFailures = linkFailures.slice(0, 20);
    report.brokenBuild = true;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  await server.close();

  /**
   * ZERO SHOTS IS A FAILURE, NOT AN EMPTY SUCCESS. A run that captured nothing
   * must never exit 0 — that is what let a crashed capture pass for a clean one.
   */
  const bad = report.fatal || report.status?.failed?.length || report.brokenBuild
    || report.shots.length === 0;
  console.log(`\n[capture] ${TAG}: ${report.shots.length} shots -> ${path.relative(process.cwd(), OUT)}`);
  if (report.gpu) console.log(`[capture] gpu: ${report.gpu} (${report.renderer})`);
  if (report.brokenBuild) {
    console.log('\n[capture] *** BROKEN BUILD — SHADER PROGRAMS FAILED TO LINK ***');
    console.log('[capture] The frames below are NOT a valid basis for visual judgement.');
    for (const f of report.shaderLinkFailures.slice(0, 6)) console.log('  ' + f.slice(0, 160));
    console.log('');
  }
  if (report.fatal) console.log(`[capture] FATAL: ${report.fatal}`);
  if (report.status?.failed?.length) console.log(`[capture] FAILED MODULES: ${report.status.failed.join(' | ')}`);
  if (report.status?.missing?.length) console.log(`[capture] not yet built: ${report.status.missing.join(', ')}`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
