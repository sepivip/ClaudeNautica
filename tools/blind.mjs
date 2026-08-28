#!/usr/bin/env node
/**
 * Blind A/B: pair our render against a real Subnautica frame under neutral names
 * so a critic must decide which one is the real game without knowing.
 *
 *   node tools/blind.mjs make --tag=underwater-r2 --shots=godrays,shallows-reef
 *      -> blind/<trial>/001-a.png, 001-b.png, ... and blind/<trial>/QUESTIONS.md
 *      (answer key is written OUTSIDE the trial dir, to blind/.keys/<trial>.json)
 *
 *   node tools/blind.mjs score --trial=<trial> --answers=001:a,002:b
 *      -> prints per-pair correctness and the overall "fooled" rate
 *
 * A critic that cannot beat chance is telling you the render is at parity.
 */
import { readFile, writeFile, mkdir, copyFile, readdir, utimes } from 'node:fs/promises';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = process.cwd();
const argv = Object.fromEntries(process.argv.slice(3).map((a) => {
  const i = a.replace(/^--/, ''); const j = i.indexOf('=');
  return j < 0 ? [i, true] : [i.slice(0, j), i.slice(j + 1)];
}));
const cmd = process.argv[2] || 'make';

const shuffleSeed = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

async function make() {
  const tag = argv.tag;
  if (!tag) { console.error('--tag=<capture tag> required'); process.exit(1); }
  const trial = argv.trial || `${tag}-blind`;
  const dir = path.join(ROOT, 'blind', trial);
  const keyDir = path.join(ROOT, 'blind', '.keys');
  await mkdir(dir, { recursive: true }); await mkdir(keyDir, { recursive: true });

  const refs = JSON.parse(await readFile(path.join(ROOT, 'reference', 'subnautica', 'index.json'), 'utf8'));
  /**
   * Pair by the VERIFIED shot-to-plate mapping, not by the loose category label.
   *
   * A 58-plate audit found the category rule had been pairing our frames against
   * plates that cannot fairly judge them: our 40m up-look (godrays) against a
   * 140-160m horizontal spire frame whose topBottom of 8.62 no up-look can
   * produce; our 26m daylight diver frame (school) against a 345m shot from
   * inside a Cyclops, a 13x depth error; our -20m underwater HUD frame against a
   * 0m above-water shot of the Neptune rocket. Some of the recorded detection
   * rate was therefore measuring category mislabelling rather than art.
   *
   * Four shots have NO fair plate (godrays, dropoff, creature-close, school).
   * They are skipped and reported, because an unjudgeable pair is worse than a
   * missing one — it inflates the detection rate with a comparison nobody could
   * lose.
   */
  const byCat = {};
  for (const r of refs) {
    const fair = Array.isArray(r.matchesShots) ? r.matchesShots : null;
    if (fair) for (const s of fair) (byCat[s] ||= []).push(r);
    else (byCat[r.category] ||= []).push(r);   // pre-audit index, fall back
  }
  const unjudgeable = [];

  const oursDir = path.join(ROOT, 'shots', tag);
  const ours = (await readdir(oursDir)).filter((f) => f.endsWith('.png') && !f.startsWith('_'));
  const want = argv.shots ? String(argv.shots).split(',') : ours.map((f) => f.replace(/\.png$/, ''));

  const key = []; const lines = []; const pairs = [];
  let n = 0;
  for (const shot of want) {
    const oursFile = path.join(oursDir, `${shot}.png`);
    const pool = byCat[shot] || [];
    if (!pool.length) { unjudgeable.push(shot); continue; }
    try { await readFile(oursFile); } catch { continue; }
    n++;
    const id = String(n).padStart(3, '0');
    // deterministic per-trial ordering so a rerun of the same trial is stable
    const ref = pool[shuffleSeed(trial + shot) % pool.length];
    const oursIsA = (shuffleSeed(trial + shot + 'side') & 1) === 0;
    // NORMALISE BOTH SIDES. A whole-game critic found this trial leaked the answer
    // through four side channels before a single pixel was examined:
    //   - our PNGs were 2,374,420 bytes, the references 297,275
    //   - our mtimes were today, the references were weeks old
    //   - ours were always exactly 1920x1080, references 1280x720 to 3000x1205
    //   - our HUD vs Subnautica's HUD/watermark identified the frame outright
    // Every 18/18 detection rate this project has recorded is suspect because of
    // it. Both images are now centre-cropped away from the HUD margins, resized
    // identically, re-encoded at one quality, and stamped with one mtime.
    pairs.push({
      id, oursIsA,
      ours: oursFile,
      ref: path.join(ROOT, 'reference', 'subnautica', ref.file),
    });
    key.push({ id, shot, real: oursIsA ? 'b' : 'a', ref: ref.file });
    lines.push(`- **${id}** — ${shot}: which of \`${id}-a.png\` / \`${id}-b.png\` is a frame from the real Subnautica?`);
  }

  // ---- normalise every pair through a canvas so no metadata distinguishes them
  if (pairs.length) {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage();
    await page.goto('about:blank');
    for (const pr of pairs) {
      const enc = async (file) => {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const src = `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
        return page.evaluate(async ({ src, W, H, MARGIN }) => {
          const img = new Image(); img.src = src; await img.decode();
          // Centre-crop away the outer margin, where HUDs and watermarks live on
          // both sides, then resize to one common size.
          const cw = img.naturalWidth * (1 - 2 * MARGIN);
          const ch = img.naturalHeight * (1 - 2 * MARGIN);
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, img.naturalWidth * MARGIN, img.naturalHeight * MARGIN, cw, ch, 0, 0, W, H);
          return c.toDataURL('image/jpeg', 0.86);
        }, { src, W: 1024, H: 576, MARGIN: 0.11 });
      };
      const oursData = await enc(pr.ours);
      const refData = await enc(pr.ref);
      const write = (d, f) => writeFile(f, Buffer.from(d.split(',')[1], 'base64'));
      await write(oursData, path.join(dir, `${pr.id}-${pr.oursIsA ? 'a' : 'b'}.jpg`));
      await write(refData, path.join(dir, `${pr.id}-${pr.oursIsA ? 'b' : 'a'}.jpg`));
    }
    await browser.close();
    // One mtime for every file in the trial, so ls tells you nothing.
    const stamp = new Date(1700000000000);
    for (const f of await readdir(dir)) await utimes(path.join(dir, f), stamp, stamp);
  }

  await writeFile(path.join(keyDir, `${trial}.json`), JSON.stringify(key, null, 2));
  await writeFile(path.join(dir, 'QUESTIONS.md'),
`# Blind A/B trial: ${trial}

Look at each pair. One image is a frame from the real Subnautica; the other is our render.

For each pair, answer: which is the REAL game, and what specifically gave it away?

${lines.join('\n')}

Do not look in \`blind/.keys/\` — that is the answer key and reading it invalidates the trial.

Report as: \`${'`'}001:a, 002:b, ...${'`'}\` plus, for each, the single visual cue that decided it.
`);
  console.log(`[blind] trial ${trial}: ${n} pairs -> blind/${trial}/  (answer with: node tools/blind.mjs score --trial=${trial} --answers=...)`);
  if (unjudgeable.length) {
    console.log(`[blind] SKIPPED ${unjudgeable.length} shot(s) with no fair reference plate: ${unjudgeable.join(', ')}`);
    console.log('[blind] These cannot be blind-tested until a matching plate exists. See reference/PLATES.md.');
  }
  if (!n) console.log('[blind] no pairs built — check that reference/subnautica/index.json has matching categories');
}

async function score() {
  const trial = argv.trial;
  const key = JSON.parse(await readFile(path.join(ROOT, 'blind', '.keys', `${trial}.json`), 'utf8'));
  const ans = Object.fromEntries(String(argv.answers || '').split(',').map((p) => p.trim().split(':')));
  let right = 0, total = 0;
  const rows = key.map((k) => {
    const given = (ans[k.id] || '').toLowerCase();
    if (!given) return { ...k, given: '(none)', correct: null };
    total++; const correct = given === k.real; if (correct) right++;
    return { ...k, given, correct };
  });
  for (const r of rows) {
    console.log(`  ${r.id} ${String(r.shot).padEnd(18)} answered=${r.given} real=${r.real} ${r.correct === null ? '-' : r.correct ? 'CORRECT' : 'FOOLED'}`);
  }
  const acc = total ? right / total : 0;
  console.log(`\n[blind] critic identified the real game ${right}/${total} (${Math.round(acc * 100)}%).`);
  console.log(acc <= 0.6
    ? '[blind] AT OR NEAR PARITY — critic is close to guessing.'
    : `[blind] DISTINGUISHABLE — ${Math.round(acc * 100)}% detection, keep iterating.`);
  await writeFile(path.join(ROOT, 'blind', '.keys', `${trial}.result.json`),
    JSON.stringify({ trial, right, total, accuracy: acc, rows }, null, 2));
}

if (cmd === 'make') await make();
else if (cmd === 'score') await score();
else console.error('usage: blind.mjs make|score');
