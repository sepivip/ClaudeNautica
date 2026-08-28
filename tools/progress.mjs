#!/usr/bin/env node
/**
 * Live build-progress page. Agents call this to publish their status; it
 * regenerates progress/index.html as a self-contained static page you can open
 * directly from disk.
 *
 *   node tools/progress.mjs set --piece=terrain --status=critiquing --round=2 \
 *        --score=61 --verdict="Cliffs read flat" --gap="No stratified rock layers"
 *   node tools/progress.mjs shots --piece=terrain --tag=terrain-r2
 *   node tools/progress.mjs note --text="wave 1 dispatched"
 *   node tools/progress.mjs render
 */
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const STATE = path.join(ROOT, 'progress', 'state.json');
const OUT = path.join(ROOT, 'progress', 'index.html');

const argv = Object.fromEntries(process.argv.slice(3).map((a) => {
  const i = a.replace(/^--/, ''); const j = i.indexOf('=');
  return j < 0 ? [i, true] : [i.slice(0, j), i.slice(j + 1)];
}));
const cmd = process.argv[2] || 'render';

export const PIECES = [
  ['whole-game',  'WHOLE GAME',          'The composite, judged as one product a player would open', '(all)'],
  ['underwater',  'Underwater Medium',   'Depth/biome fog, absorption, god rays, marine snow', 'render/underwater.js'],
  ['watersurface','Water Surface',       'Waves, refraction, sun glitter, the meniscus from below', 'render/watersurface.js'],
  ['sky',         'Sky & Day/Night',     'Sun, moon, clouds, above-water atmosphere', 'render/sky.js'],
  ['postfx',      'Post & Grading',      'Bloom, tonemap, per-depth grade, DoF, AA, distortion', 'render/postfx.js'],
  ['biomes',      'Biomes',              'Palettes, depth bands, spawn tables', 'world/biomes.js'],
  ['terrain',     'Terrain',             'Seabed, cliffs, drop-offs, LOD streaming', 'world/terrain.js'],
  ['flora',       'Flora',               'Kelp, coral tubes, grass, bioluminescence', 'world/flora.js'],
  ['structures',  'Caves, Wrecks & POIs','Cave systems, wreck interiors, the lifepod', 'world/structures.js'],
  ['creatures',   'Creatures',           'Bodies, swim animation, AI, leviathans', 'life/creatures.js'],
  ['schooling',   'Fish Schools',        'Flocking shoals, predator reactions', 'life/schooling.js'],
  ['movement',    'Swim Feel',           'Buoyancy, drag, momentum, camera feel', 'player/movement.js'],
  ['survival',    'Survival',            'O2, food, water, health, pressure', 'player/survival.js'],
  ['tools',       'Tools & Scanning',    'Scanner, flashlight, knife, inventory, crafting', 'player/tools.js'],
  ['vehicles',    'Vehicles',            'Seamoth, seaglide, cockpit, lights', 'vehicles/vehicles.js'],
  ['base',        'Seabase & Interiors', 'Corridors, rooms, observatory, hatches', 'base/base.js'],
  ['ui',          'HUD & PDA',           'O2/health bars, depth, PDA, scanner UI', 'ui/ui.js'],
  ['audio',       'Audio',               'Biome beds, muffling, creature calls', 'audio/audio.js'],
];

const STATUS = {
  'not-started': ['#3d4a52', 'Not started'],
  'building':    ['#f0a83c', 'Building'],
  'critiquing':  ['#7b8cff', 'Under review'],
  'iterating':   ['#ff7ac6', 'Iterating'],
  'passed':      ['#3ddc97', 'Beats reference'],
  'blocked':     ['#ff5c5c', 'Blocked'],
};

const blankPiece = () => ({
  status: 'not-started', round: 0, score: null, verdict: '', gap: '', history: [], shotTag: null,
});

async function load() {
  try {
    const s = JSON.parse(await readFile(STATE, 'utf8'));
    // Backfill any piece added to PIECES after this state file was written,
    // otherwise `set --piece=<new>` is rejected against an existing run.
    for (const [id] of PIECES) if (!s.pieces[id]) s.pieces[id] = blankPiece();
    return s;
  }
  catch {
    return {
      startedAt: new Date().toISOString(), updatedAt: null, notes: [],
      pieces: Object.fromEntries(PIECES.map(([id]) => [id, {
        status: 'not-started', round: 0, score: null, verdict: '', gap: '', history: [], shotTag: null,
      }])),
    };
  }
}
/** Many agents publish at once — serialise with a lock dir so updates aren't lost. */
const LOCK = path.join(ROOT, 'progress', '.lock');
async function withLock(fn) {
  await mkdir(path.join(ROOT, 'progress'), { recursive: true });
  for (let i = 0; i < 120; i++) {
    try { await mkdir(LOCK); } catch {
      // A killed agent leaves the lock behind and every later writer then stalls
      // for the full retry budget. Break a lock that is clearly abandoned.
      try {
        const { mtimeMs } = await stat(LOCK);
        if (Date.now() - mtimeMs > 60000) { await rm(LOCK, { recursive: true, force: true }); continue; }
      } catch { /* vanished under us; just retry */ }
      await new Promise((r) => setTimeout(r, 100 + i * 5)); continue;
    }
    try { return await fn(); }
    finally { await rm(LOCK, { recursive: true, force: true }); }
  }
  return fn(); // lock is stuck; proceed rather than stall an agent
}

async function save(s) {
  s.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function listShots(tag) {
  if (!tag) return [];
  try {
    const dir = path.join(ROOT, 'shots', tag);
    return (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  } catch { return []; }
}
async function refIndex() {
  try { return JSON.parse(await readFile(path.join(ROOT, 'reference', 'subnautica', 'index.json'), 'utf8')); }
  catch { return []; }
}

function sparkline(history) {
  if (!history.length) return '';
  const pts = history.map((h) => h.score ?? 0);
  const max = 100, w = 132, h = 30;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <line x1="0" y1="${h * 0.1}" x2="${w}" y2="${h * 0.1}" stroke="#3ddc9733" stroke-dasharray="3 3"/>
    <path d="${d}" fill="none" stroke="#4fd8ff" stroke-width="2" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${(h - (p / max) * h).toFixed(1)}" r="2.2" fill="#4fd8ff"/>`).join('')}
  </svg>`;
}

async function render() {
  const s = await load();
  const refs = await refIndex();
  const refByCat = {};
  for (const r of refs) (refByCat[r.category] ||= []).push(r.file);

  const done = PIECES.filter(([id]) => s.pieces[id]?.status === 'passed').length;
  const scores = PIECES.map(([id]) => s.pieces[id]?.score).filter((v) => typeof v === 'number');
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const started = PIECES.filter(([id]) => s.pieces[id]?.status !== 'not-started').length;

  const cards = [];
  for (const [id, title, desc, file] of PIECES) {
    const p = s.pieces[id] || { status: 'not-started', round: 0, history: [] };
    const [col, label] = STATUS[p.status] || STATUS['not-started'];
    const shots = await listShots(p.shotTag);
    const gallery = shots.slice(0, 3).map((f) => {
      const shotName = f.replace(/\.png$/, '');
      const ref = (refByCat[shotName] || [])[0];
      return `<figure class="cmp">
        <div class="pair">
          <div class="half"><img loading="lazy" src="../shots/${esc(p.shotTag)}/${esc(f)}" alt="ours ${esc(shotName)}"><span>ours</span></div>
          ${ref ? `<div class="half"><img loading="lazy" src="../reference/subnautica/${esc(ref)}" alt="reference ${esc(shotName)}"><span>Subnautica</span></div>` : ''}
        </div>
        <figcaption>${esc(shotName)}</figcaption>
      </figure>`;
    }).join('');

    cards.push(`<article class="card ${p.status === 'passed' ? 'won' : ''}">
      <header>
        <span class="dot" style="background:${col}"></span>
        <h3>${esc(title)}</h3>
        <span class="badge" style="color:${col};border-color:${col}44">${esc(label)}</span>
      </header>
      <p class="desc">${esc(desc)}</p>
      <div class="meta"><code>src/${esc(file)}</code><span>round ${p.round || 0}</span></div>
      ${typeof p.score === 'number' ? `<div class="score">
        <div class="bar"><i style="width:${p.score}%;background:${col}"></i><b style="left:90%"></b></div>
        <span class="num">${p.score}<em>/100 vs Subnautica</em></span>
      </div>` : ''}
      ${p.history?.length > 1 ? `<div class="hist">${sparkline(p.history)}<span>${p.history.length} rounds</span></div>` : ''}
      ${p.verdict ? `<div class="quote"><b>Critic:</b> ${esc(p.verdict)}</div>` : ''}
      ${p.gap ? `<div class="gap"><b>Biggest gap:</b> ${esc(p.gap)}</div>` : ''}
      ${gallery ? `<div class="shots">${gallery}</div>` : ''}
    </article>`);
  }

  const notes = (s.notes || []).slice(-14).reverse().map((n) =>
    `<li><time>${esc(new Date(n.ts).toLocaleTimeString())}</time>${esc(n.text)}</li>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClaudeNautica — Build Progress</title>
<meta http-equiv="refresh" content="20">
<style>
  :root{--bg:#04121a;--bg2:#08202e;--line:#12384c;--fg:#cfe9f2;--dim:#7ba7ba;--acc:#4fd8ff}
  *{box-sizing:border-box}
  body{margin:0;background:
      radial-gradient(1200px 700px at 70% -10%, #0d3b52 0%, transparent 60%),
      linear-gradient(#04121a, #020a10 70%);
    color:var(--fg);font:15px/1.55 "Segoe UI",system-ui,sans-serif;min-height:100vh}
  .wrap{max-width:1320px;margin:0 auto;padding:34px 22px 90px}
  h1{font-size:26px;margin:0;letter-spacing:.02em}
  h1 em{font-style:normal;color:var(--acc)}
  .sub{color:var(--dim);margin:6px 0 0;font-size:13.5px}
  .top{display:flex;flex-wrap:wrap;gap:26px;align-items:center;justify-content:space-between;
    border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:26px}
  .stats{display:flex;gap:26px;flex-wrap:wrap}
  .stat b{display:block;font-size:27px;color:var(--acc);font-weight:600;line-height:1.1}
  .stat span{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(400px,1fr))}
  .card{background:linear-gradient(#0a2333,#071a26);border:1px solid var(--line);border-radius:12px;
    padding:16px 17px;display:flex;flex-direction:column;gap:9px}
  .card.won{border-color:#3ddc9755;box-shadow:0 0 0 1px #3ddc9722,0 8px 30px -18px #3ddc97}
  .card header{display:flex;align-items:center;gap:9px}
  .card h3{margin:0;font-size:16px;font-weight:600;flex:1}
  .dot{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 9px currentColor}
  .badge{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;border:1px solid;border-radius:20px;padding:2px 9px}
  .desc{margin:0;color:var(--dim);font-size:13px}
  .meta{display:flex;justify-content:space-between;font-size:11.5px;color:#5b8496}
  .meta code{color:#6ea9bf;background:#0a2a3a;padding:1px 6px;border-radius:4px}
  .score{display:flex;align-items:center;gap:10px}
  .bar{position:relative;flex:1;height:7px;background:#0c2c3d;border-radius:4px;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:4px;transition:width .5s}
  .bar b{position:absolute;top:-3px;width:2px;height:13px;background:#3ddc97aa}
  .num{font-size:15px;font-weight:600;color:var(--acc);white-space:nowrap}
  .num em{font-style:normal;font-size:10.5px;color:var(--dim);margin-left:3px}
  .hist{display:flex;align-items:center;gap:9px;color:var(--dim);font-size:11.5px}
  .quote,.gap{font-size:12.5px;background:#06202e;border-left:2px solid var(--line);
    padding:7px 10px;border-radius:0 6px 6px 0;color:#a9cfdd}
  .gap{border-left-color:#ff7ac6}
  .quote b,.gap b{color:var(--fg)}
  .shots{display:flex;flex-direction:column;gap:9px;margin-top:3px}
  .cmp{margin:0}
  .pair{display:flex;gap:5px}
  .half{position:relative;flex:1;min-width:0}
  .half img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;border:1px solid var(--line);display:block;background:#02090e}
  .half span{position:absolute;left:5px;bottom:5px;font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;
    background:#000a;padding:1.5px 6px;border-radius:3px;color:#cfe9f2}
  figcaption{font-size:11px;color:#5b8496;margin-top:3px}
  .notes{margin-top:34px;border-top:1px solid var(--line);padding-top:20px}
  .notes h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
  .notes ul{list-style:none;margin:0;padding:0;font-size:13px;color:#a9cfdd}
  .notes li{padding:4px 0;border-bottom:1px solid #0d2b3a;display:flex;gap:12px}
  .notes time{color:#4f7a8c;flex:none;font-variant-numeric:tabular-nums}
  footer{margin-top:30px;color:#41697b;font-size:11.5px}
</style></head><body><div class="wrap">
<div class="top">
  <div><h1>Claude<em>Nautica</em></h1>
    <p class="sub">Every subsystem is built by one agent, then torn apart by an independent critic holding real Subnautica frames. Auto-refreshes every 20s.</p></div>
  <div class="stats">
    <div class="stat"><b>${started}<span style="font-size:16px;color:#41697b">/${PIECES.length}</span></b><span>In flight</span></div>
    <div class="stat"><b>${done}</b><span>Beat reference</span></div>
    <div class="stat"><b>${avg}</b><span>Avg vs Subnautica</span></div>
    <div class="stat"><b>${refs.length}</b><span>Reference frames</span></div>
  </div>
</div>
<div class="grid">${cards.join('\n')}</div>
${notes ? `<div class="notes"><h2>Build log</h2><ul>${notes}</ul></div>` : ''}
<footer>updated ${esc(s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—')} · started ${esc(s.startedAt ? new Date(s.startedAt).toLocaleString() : '—')}</footer>
</div></body></html>`;

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, html);
  console.log(`[progress] ${path.relative(ROOT, OUT)} — ${started}/${PIECES.length} started, ${done} passed, avg ${avg}`);
}

await withLock(async () => {
  const s = await load();                 // read inside the lock so we never clobber
  if (cmd === 'set') {
    const id = argv.piece;
    if (!id || !s.pieces[id]) {
      console.error(`unknown --piece (valid: ${PIECES.map((p) => p[0]).join(', ')})`);
      process.exit(1);
    }
    const p = s.pieces[id];
    if (argv.status) p.status = argv.status;
    if (argv.round !== undefined) p.round = Number(argv.round);
    if (argv.verdict) p.verdict = String(argv.verdict);
    if (argv.gap) p.gap = String(argv.gap);
    if (argv.tag) p.shotTag = String(argv.tag);
    if (argv.score !== undefined) {
      p.score = Number(argv.score);
      p.history.push({ round: p.round, score: p.score, ts: new Date().toISOString() });
    }
    await save(s);
  } else if (cmd === 'shots') {
    s.pieces[argv.piece].shotTag = String(argv.tag); await save(s);
  } else if (cmd === 'note') {
    (s.notes ||= []).push({ ts: new Date().toISOString(), text: String(argv.text || '') });
    await save(s);
  } else { await save(s); }
  await render();
});
