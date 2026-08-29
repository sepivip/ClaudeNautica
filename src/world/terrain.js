/**
 * TERRAIN — the seabed.
 *
 * OWNER: the "terrain" agent.
 *
 * Design notes (the *why*, since shape language is the whole job):
 *
 *  - The floor is NOT a noise heightmap. It is a hand-authored radial *profile*
 *    (spawn shelf -> bench -> kelp slope -> plateau -> THE drop-off -> terraced
 *    reef -> abyssal plain) that noise decorates, plus named landmarks — the
 *    spawn basin, the sinkhole, the mesa, the Grand Reef pinnacles — you can
 *    navigate by. A continental domain warp breaks every contour so nothing
 *    reads as a circle.
 *  - reference/LOOK.md §7: Subnautica rock is "rounded and blobby… like melted
 *    candles", never faceted (§11.23). So the ridge stack uses sqrt-smoothed
 *    ridged noise (rounded crests, not creases), only three octaves, and the
 *    plateau lips are rolled over rather than cut square.
 *  - The seabed is a *patchwork*: flat sediment basins with rock breaking
 *    through, at a 60-140 m patch scale so sand and rock share every frame.
 *  - §11.25 "bare untextured rock reads as unfinished": rock here is mostly
 *    overgrown — algae, turf and coral crust from the biome's own accent colour.
 *  - LOD is a quadtree with skirts. Every transition sits well past the biome's
 *    usable visibility (40-60 m in the shallows), so LOD changes are not
 *    "hidden", they are physically unresolvable.
 *  - Colour comes from world/biomes.js: its per-biome `terrain.{sand,rock,accent}`
 *    palettes are baked into vertex attributes through a 32 m palette lattice,
 *    so the ground under the kelp is olive and the ground in the lava zone is
 *    burnt umber, without a single hardcoded colour in the shader.
 *
 * Exports other modules depend on: heightAt(x,z), normalAt(x,z[,out]),
 * biomeAt(x,z) — plus sampleAt, slopeAt, raycast, floorPaletteAt as extras.
 * All of them are pure and safe to call thousands of times per frame.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { applyUnderwater } from '../core/underwaterMaterial.js';
import { makeRNG } from '../core/rng.js';

// ============================================================== math helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
function sstep(a, b, x) {
  if (b === a) return x < a ? 0 : 1;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** rises a->b, holds, falls c->d */
const band = (x, a, b, c, d) => sstep(a, b, x) * (1 - sstep(c, d, x));

// ============================================================== noise
// Gradient (Perlin-style) noise on a shuffled permutation table. Seeded from a
// constant so heightAt() is identical before init() and in a headless tool.
const TERRAIN_SEED = 20240817;
const _perm = new Uint8Array(512);
const _gx = new Float32Array(256);
const _gy = new Float32Array(256);
(function buildNoiseTables() {
  const r = makeRNG(TERRAIN_SEED);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    _gx[i] = Math.cos(a); _gy[i] = Math.sin(a);
  }
})();

/** Gradient noise, roughly [-1,1]. */
function gn(x, y) {
  const X = Math.floor(x), Y = Math.floor(y);
  const xf = x - X, yf = y - Y;
  const xi = X & 255, yi = Y & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const A = _perm[xi] + yi, B = _perm[xi + 1] + yi;
  const aa = _perm[A], ab = _perm[A + 1], ba = _perm[B], bb = _perm[B + 1];
  const n00 = _gx[aa] * xf + _gy[aa] * yf;
  const n10 = _gx[ba] * (xf - 1) + _gy[ba] * yf;
  const n01 = _gx[ab] * xf + _gy[ab] * (yf - 1);
  const n11 = _gx[bb] * (xf - 1) + _gy[bb] * (yf - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41;
}

function fbm(x, y, oct) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * gn(x * f, y * f);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return s / norm;
}

/**
 * Ridged noise with a ROUNDED crest. |n| creases at the ridge line, which is
 * exactly the faceted look LOOK.md §11.23 calls an amateur tell; sqrt(n²+e)
 * rolls the top over instead. Returns [0,1].
 */
function ridgedSoft(x, y, oct, e = 0.022) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = gn(x * f, y * f);
    const nn = 1 - Math.sqrt(n * n + e);
    s += amp * nn * nn;
    norm += amp; amp *= 0.55; f *= 2.17;
  }
  return s / norm;
}

// ============================================================== radial profile
// depth (positive metres) vs warped radius. Authored to give a shelf -> bench ->
// slope -> plateau -> CLIFF -> terrace -> abyss silhouette, and cross-checked so
// every camera in core/shots.js clears the floor by 6 m or more *and* has
// readable geometry inside its biome's visibility.
//
// The shelf depths are the biome table's own `floor` values (safe_shallows 26,
// kelp 78, grassy plateaus 105) rather than an invented ramp: a diver at the
// shallows shot must be at ~20 m, not 34 m, or caustics and sunlight are already
// half gone and every frame reads as one flat olive slab.
//
// r=250..268 is deliberately left as a near-vertical face; see CLIFF below. The
// table only carries the shelf above it and the terrace below it.
//
// The r=58..98 lip is softened (34/45/55/61 -> 32/42/53/60): the basin used to
// fall 35 m in the first 40 m of run, so the Safe Shallows framings looked
// across empty water at a floor already below their own sightline. It cannot be
// softened much more than this — the seamoth / creature-close / school /
// base-interior cameras all sit at r=67..91 and need the floor 8 m below them —
// so what actually fills those frames is the named reef knolls below, which
// stand 16-38 m off this floor and are placed on the sightlines by hand.
const PROFILE = [
  [0, 44], [22, 39], [36, 30], [48, 27], [58, 26], [66, 32], [74, 42],
  [86, 53], [98, 60], [114, 65], [136, 69], [162, 78], [188, 85], [214, 90],
  [240, 94], [258, 100],
  [280, 116], [310, 142], [350, 172], [400, 204], [440, 236], [470, 258],
  [500, 330], [570, 600], [660, 830], [780, 1070], [900, 1255], [1050, 1370],
  [1250, 1400], [4600, 1400],
];

function profileDepth(r) {
  if (r <= 0) return PROFILE[0][1];
  let lo = 0, hi = PROFILE.length - 1;
  if (r >= PROFILE[hi][0]) return PROFILE[hi][1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (PROFILE[mid][0] <= r) lo = mid; else hi = mid;
  }
  const [r0, d0] = PROFILE[lo], [r1, d1] = PROFILE[hi];
  const t = (r - r0) / (r1 - r0);
  // smoothstep between control points: every control point becomes a soft bench
  return d0 + (d1 - d0) * (t * t * (3 - 2 * t));
}

// ============================================================== landmarks
const FEATURES = [
  // The spawn basin: a wide sandy bowl with a low rim. Shallow on purpose — a
  // 30 m pit here put the Safe Shallows shots at 34 m depth, where caustics and
  // sunlight are already half dead and the sand cannot read as sand.
  { type: 'crater', x: 0, z: 0, R: 54, depth: 8, rim: 2.0 },
  // "The Sinkhole" — a collapsed bowl chewed into the grassy plateau.
  { type: 'crater', x: -262, z: 58, R: 150, depth: 78, rim: 16 },
  { type: 'crater', x: 96, z: -214, R: 74, depth: 34, rim: 9 },
  // The crash basin under the wreck shot: a wide gouge in the outer shelf. It
  // also gives that camera (y=-95 at r=218) a floor to stand on.
  { type: 'crater', x: 214, z: 56, R: 96, depth: 34, rim: 7 },
  // Flat-topped mesa off the plateau edge, visible from a long way out.
  { type: 'mesa', x: 126, z: 236, R: 78, height: 58, top: 0.62 },
  // The Grand Reef terrace: a stacked shelf hanging off the cliff face at
  // ~290 m, the "flat-topped grass-covered plateau with steep rounded sides"
  // of LOOK.md §7. Everything in the grand-reef shot stands on this.
  { type: 'mesa', x: 322, z: -258, R: 150, height: 30, top: 0.70 },
  // Grand-Reef pinnacles — LOOK.md §7 "tapered rounded fingers 20-40 m tall,
  // wider at the base, like melted candles". These sell scale. The near five
  // sit 14-70 m off the grand-reef camera so the shot has a *subject*; the
  // rest are horizon landmarks.
  { type: 'spire', x: 316, z: -266, R: 15, height: 26 },
  { type: 'spire', x: 300, z: -246, R: 21, height: 41 },
  { type: 'spire', x: 285, z: -272, R: 26, height: 58 },
  { type: 'spire', x: 262, z: -244, R: 30, height: 72 },
  { type: 'spire', x: 268, z: -292, R: 34, height: 88 },
  { type: 'spire', x: 232, z: -258, R: 44, height: 104 },
  { type: 'spire', x: 330, z: -160, R: 40, height: 122 },
  { type: 'spire', x: -318, z: -300, R: 46, height: 132 },
  { type: 'spire', x: -120, z: 372, R: 44, height: 118 },
  // Reef towers just inside the drop-off — landmarks you steer by. These two sit
  // on the shallows sightlines, so they are deliberately SQUAT: at R=34/h=46 the
  // (214,132) tower read as a 1.4:1 cone on the shallows-reef skyline, which is
  // the one silhouette in the frame that breaks LOOK.md §7's rounded shape
  // language. Below 1:1 the same profile reads as a knoll.
  { type: 'spire', x: -196, z: 176, R: 52, height: 44 },
  { type: 'spire', x: 214, z: 132, R: 56, height: 38 },
  // Safe-Shallows reef masses: the big rounded outcrops that stand up out of the
  // sand in shallows-reef-1.jpg. They are what the shallows cameras look AT, so
  // they are placed on the actual sightlines at 25-90 m — inside the shallows'
  // 40-60 m visibility, in three depth layers, because a frame with only one
  // distance plane is flat however well it is lit (LOOK.md §11.8).
  { type: 'knoll', x: 58, z: 56, R: 24, height: 30 },     // shallows-reef, 32 m
  { type: 'knoll', x: 44, z: 78, R: 18, height: 22 },     // ..and its left wing
  { type: 'knoll', x: 80, z: 66, R: 30, height: 36 },     // ..mid ground, 55 m
  { type: 'knoll', x: 104, z: 96, R: 38, height: 42 },    // ..far ground, 87 m
  { type: 'knoll', x: 64, z: 20, R: 21, height: 20 },     // ..right of the axis
  { type: 'knoll', x: -62, z: 8, R: 22, height: 18 },     // shallows-floor, 28 m
  { type: 'knoll', x: -92, z: -16, R: 27, height: 32 },   // ..mid ground, 63 m
  { type: 'knoll', x: -116, z: -44, R: 34, height: 40 },  // ..far ground, 100 m
  { type: 'knoll', x: -46, z: 62, R: 17, height: 23 },    // ..right shoulder
  { type: 'knoll', x: 140, z: 60, R: 38, height: 40 },
  { type: 'knoll', x: 66, z: 150, R: 42, height: 42 },
  { type: 'knoll', x: -134, z: 98, R: 44, height: 40 },
  { type: 'knoll', x: 22, z: -134, R: 40, height: 38 },
  // Trench mouth swallowing the shelf right where the drop-off camera looks:
  // LOOK.md §7 "sinkholes whose bottoms are simply not visible".
  { type: 'shaft', x: -139, z: 196, R: 34, depth: 120 },
  // The cave-mouth shaft: a wide vertical throat, not a corridor (LOOK.md §7).
  { type: 'shaft', x: -96, z: -186, R: 52, depth: 108 },
];
for (const f of FEATURES) f.R2 = f.R * f.R;

// ============================================================== terrain sample
export const SAMPLE_PROTO = () => ({ h: 0, ao: 1, rock: 0, coral: 0, mottle: 0 });
const _s0 = SAMPLE_PROTO();
const _s1 = SAMPLE_PROTO();

/**
 * The one function that defines the seabed. Height plus the shading channels the
 * mesh builder bakes into vertex attributes. ~22 noise taps, ~0.5 us.
 */
export function sampleAt(x, z, o = _s0) {
  // ---- 1. continental domain warp: radial features must never read as circles
  const r0 = Math.sqrt(x * x + z * z);
  const wAmp = 20 + 200 * sstep(70, 950, r0);
  const wx = x + wAmp * gn(x * 0.00058 + 11.3, z * 0.00058 - 4.1);
  const wz = z + wAmp * gn(x * 0.00058 - 27.7, z * 0.00058 + 19.4);
  const r = Math.sqrt(wx * wx + wz * wz);

  let d = profileDepth(r);
  let ao = 1, rock = 0;

  const mottle = gn(x * 0.0031 + 4.4, z * 0.0031 - 2.9);
  const macro = gn(x * 0.0016 - 8.2, z * 0.0016 + 5.5);

  // ---- 1b. THE DROP-OFF, as a wall rather than a ramp.
  // Spreading 200 m of depth over 200 m of run gives a 45 deg slope, and at
  // 40-50 m of visibility a 45 deg slope can only ever be "ground receding into
  // fog" — never the near-vertical face LOOK.md §7 asks for. So the shelf edge
  // is a separate hard step: the profile above holds the shelf at 80 m and the
  // terrace at 178 m, and this term carries the 94 m between them across ~16 m
  // of run (80 deg). The edge radius wanders +-34 m with bearing so the rim is
  // a ragged coastline in plan, not a circle, and 8 % of bearings get a re-entrant
  // notch (a canyon cut back into the shelf).
  const az = Math.atan2(wz, wx);
  const edge = 251
    + 30 * gn(Math.cos(az) * 2.1 + 31.7, Math.sin(az) * 2.1 - 12.4)
    + 12 * gn(Math.cos(az) * 5.3 - 8.8, Math.sin(az) * 5.3 + 22.1);
  const face = sstep(edge - 7, edge + 7, r);
  const faceW = face * (1 - face) * 4;               // 1 at mid-face, 0 at both lips
  if (faceW > 0.008) {
    // the face is bare rock and the foot of it sits in its own shadow
    ao -= 0.24 * faceW;
    rock += 2.4 * faceW;
  }
  d += 112 * face;
  // BUTTRESSES AND CHUTES. A 94 m wall generated purely by a radial step is a
  // vector wedge — one smooth surface with a single normal, which is exactly what
  // measured rms 4.8/255 on the drop-off face. A real cliff is a comb of vertical
  // ribs and gullies, and their *silhouette* and their mutual shadowing are what
  // give a drop-off its vertical scale. The rib phase is per-bearing (so ribs run
  // straight down the fall line rather than wandering) and their amplitude peaks
  // mid-face and vanishes at both lips so the shelf above stays flat.
  if (faceW > 0.008) {
    const ribP = Math.cos(az) * 13.0, ribQ = Math.sin(az) * 13.0;
    const rib = gn(ribP + 5.1, ribQ - 9.3) + 0.55 * gn(ribP * 2.7 - 2.2, ribQ * 2.7 + 6.4);
    d -= rib * 17 * faceW;
    ao -= 0.14 * faceW * clamp01(-rib);
    // a bench two thirds of the way down: a wall with one break in it reads far
    // taller than a wall without, because the break gives the eye a scale ruler
    const ben = Math.exp(-Math.pow((face - 0.62) / 0.10, 2));
    d -= ben * (5 + 3 * mottle);
  }

  // ---- 2. stacked shelves. Quantising depth, then rolling the lip over with a
  //         smoothstep, is what makes flat benches ending in a rounded plateau
  //         edge instead of a staircase of hard corners.
  const terrW = band(r, 120, 190, 430, 620) * clamp01(0.30 + 0.70 * macro) * 0.8;
  if (terrW > 0.02) {
    const step = 15 + 12 * (0.5 + 0.5 * mottle);
    const f = d / step;
    const fi = Math.floor(f), ff = f - fi;
    const shaped = (fi + sstep(0.52, 1.0, ff)) * step;
    d += (shaped - d) * terrW;
    ao -= 0.16 * terrW * sstep(0.62, 0.95, ff);      // the bench lip is shadowed
  }

  // ---- 3. broad relief — genuinely flat near spawn, real topography outside.
  // The Safe Shallows in the reference frames are a *basin*: a near-level sand
  // floor with reef outcrops standing on it. +-15 m of dune here is what turned
  // the shallows shots into a featureless green dune field with no horizon and
  // nothing at player scale.
  const rough = 0.10 + 0.90 * sstep(70, 300, r0);
  d -= fbm(x * 0.0042, z * 0.0042, 4) * (2.2 + 13 * rough);
  d -= fbm(x * 0.0135 + 9.1, z * 0.0135 - 3.3, 3) * (0.8 + 3.5 * rough);

  // ---- 4. the outcrop patchwork. 60-140 m patches, so sand and rock are both
  //         in every frame the way the reference frames always are.
  const rockF = sstep(0.24, 0.64, gn(x * 0.0072 + 3.1, z * 0.0072 - 7.4) * 0.5 + 0.5
    + 0.28 * gn(x * 0.0195 - 1.7, z * 0.0195 + 4.2));
  const reefW = band(r, 16, 46, 560, 830) * rockF;

  // gentle 30-50 m swells everywhere so the sand flats still have a horizon
  d -= (ridgedSoft(x * 0.021 + 1.7, z * 0.021 - 4.4, 2) - 0.508) * 20.0
     * band(r, 12, 60, 700, 1050) * (0.30 + 0.70 * sstep(60, 190, r0));

  let rise = 0;
  if (reefW > 0.015) {
    // domain warp so ridge lines meander rather than forming a lattice
    const qx = x + 34 * gn(x * 0.0033 + 5.1, z * 0.0033 - 2.2);
    const qz = z + 34 * gn(x * 0.0033 - 9.7, z * 0.0033 + 6.3);
    // Three scales only (45 / 21 / 9.5 m). More octaves and the seabed turns
    // into an alpine range; Subnautica's rock is chunky at two or three sizes.
    // Divide by the measured 0.21 spread so `amp` is honest half-swing metres —
    // ±17 m over a 45 m feature is a reef wall, ±5 m is a sand dune.
    // e=0.20 rounds each crest over ~22% of its wavelength — a 45 m ridge gets a
    // 10 m dome on top. At 0.025 the crest is a point and the skyline reads as a
    // mountain range, which is the opposite of LOOK.md §7's "melted candles".
    // amp is then honest half-swing metres (sd measured at 0.048).
    // Two octaves, not three. The third sat at 9.6 m wavelength carrying ~6 m of
    // relief — a 1.25 slope, i.e. a spike — and where it landed on a crest of the
    // 45 m octave the sum came to a point on the skyline. Subnautica's rock is
    // chunky at two sizes and rounded at both (LOOK.md §7); the metre-scale relief
    // belongs to the cobble field and to the shader, not to the ridge stack.
    // mean and sd measured numerically over the reef domain: 0.2293 / 0.0556 for
    // two octaves at e=0.20, so `amp` stays honest half-swing metres.
    const rr = ridgedSoft(qx * 0.022, qz * 0.022, 2, 0.20);
    const amp = lerp(17, 33, sstep(95, 340, r));
    rise = (rr - 0.2293) * (amp / 0.150) * reefW;
    d -= rise;
    // Rock is tied to the actual rise in metres, not to the noise value, so the
    // material change lands exactly where the geometry changes.
    rock += sstep(0.5, 4.5, rise) * 1.1;
    ao -= 0.22 * sstep(-1.0, -8.0, rise) * reefW;      // shadowed sand channels
  }

  // ---- 4b. REEF HEADS. The Safe Shallows in every reference frame is a sand
  // basin with rounded coral-crusted knolls standing 6-16 m out of it — that is
  // what a horizontal shot at 12 m depth actually looks at. Without them the
  // shallows shots point across a basin whose far side is past the fog and the
  // frame is an empty blue card with a skyline in the bottom quarter.
  // The band starts at r=48 so the shot cameras that sit on the basin floor are
  // never inside one, and the knolls rise in front of them instead.
  // Held inside r=168: past that is the Kelp Forest, whose camera sits at -55 on
  // a floor near -66, and tall reef heads there put the camera inside rock.
  const headW = band(r, 46, 80, 118, 168);
  if (headW > 0.02) {
    // TWO scales of reef mass — 140 m banks with 60 m knolls riding on them.
    // One scale gives a field of interchangeable bumps; two gives the frame a
    // near mass, a mid mass and a far skyline, which is what a shallows frame
    // needs to have any depth at all.
    const hb = gn(x * 0.0071 + 4.7, z * 0.0071 + 8.1);
    const bs = sstep(0.02, 0.50, hb);
    const b2 = bs * bs * (3 - 2 * bs);
    d -= b2 * 8.0 * headW;

    const hn = gn(x * 0.0165 + 21.3, z * 0.0165 - 13.7)
             + 0.34 * gn(x * 0.038 - 7.1, z * 0.038 + 3.3);
    // smoothstep TWICE: a raw gn peak driven through a threshold gives a cone,
    // and LOOK.md 11.23 rejects sharp silhouette corners by name. Two shapings
    // flatten the crown and roll the shoulder over into a melted dome.
    const hs = sstep(0.14, 0.64, hn);
    const h2 = hs * hs * (3 - 2 * hs);
    d -= h2 * 12.0 * headW;
    rock += (h2 * 1.4 + b2 * 0.7) * headW;
    ao -= 0.14 * headW * h2 * (1 - h2) * 4;
  }

  // ---- 5. boulder scale: 3-12 m knuckles on the rock
  if (rock > 0.12) {
    // Driven straight, this 19 m ridged field puts a POINT wherever two crests
    // cross — and one sharp cone on a skyline is enough to break the whole
    // "melted candle" shape language of LOOK.md §7/§11.23. Pushing it through a
    // smoothstep first flattens each crown and rolls its shoulder over, the same
    // shaping the reef heads use, at the cost of nothing but a multiply.
    const b1 = clamp01((ridgedSoft(x * 0.052 + 4.1, z * 0.052 - 8.3, 2) - 0.508) * 0.95 + 0.5);
    d -= (b1 * b1 * (3 - 2 * b1) - 0.5) * 11.0 * clamp01(rock);
  }

  // ---- 5b. sand-buried boulder mounds. NOT cobbles — the heightfield's finest
  // leaf cell is 1 m, so by Nyquist nothing under ~2 m can live here at all; the
  // 0.2-2 m cobble population that gives the floor its scale is instanced
  // geometry (see COBBLE FIELD below). What belongs in the heightfield is the
  // 5-9 m half-buried boulder these cobbles have obviously fallen off, at an
  // honest 1.6 m of relief instead of the 4.4 m that made them 7 m erratics.
  const cob = gn(x * 0.135 + 7.7, z * 0.135 - 2.1) + 0.5 * gn(x * 0.31 - 4.4, z * 0.31 + 9.2);
  if (cob > 0.52) {
    const w = sstep(0.52, 0.92, cob) * band(r, 18, 55, 900, 1300);
    d -= w * w * 1.6;
    rock += w * 1.15;
    ao -= 0.10 * w;
  }

  // ---- 5c. SEDIMENTARY LEDGES on the drop-off face. A stack of beds where the
  // harder ones stand proud by a metre; shading alone cannot fake it, because a
  // ledge has to notch the silhouette and shadow the bed under it.
  //
  // ONLY on the face. A perturbation that is a function of depth draws the
  // terrain's own contour lines, and on anything that is not a wall those
  // contours are closed rings — which turned every reef knoll into a stack of
  // terraces, the single most recognisable heightfield tell there is. The face
  // is the one place we know a priori is steep, so it is the one place this is
  // safe without paying for a slope evaluation per sample.
  // The 5.5 m period against 0.9 m of amplitude sits just under the fold point
  // (A*k ~ 1), which is what makes a bed contact a near-vertical step.
  const ledgeW = clamp01(faceW * 1.3) * (0.55 + 0.45 * macro);
  if (ledgeW > 0.02) {
    const lw = gn(x * 0.013 + 6.1, z * 0.013 - 2.7) * 2.6;
    d += Math.sin(d * 1.14 + lw) * 0.9 * ledgeW;
  }

  // ---- 6. crevasses. The zero-crossing of a low frequency field is a long
  //         meandering line — a trench, not "some subtracted noise".
  const cf = gn(x * 0.00131 + 3.3, z * 0.00131 - 8.8) + 0.45 * gn(x * 0.0037, z * 0.0037);
  const cAbs = Math.abs(cf);
  if (cAbs < 0.062) {
    const crev = 1 - cAbs / 0.062;
    const cm = band(r, 130, 210, 900, 1300);
    const c2 = crev * crev;
    d += c2 * 62 * cm;
    ao -= 0.62 * c2 * cm;
    rock += 0.7 * c2 * cm;
  }

  // ---- 7. the drop-off lip: a raised reef rim along the plateau edge
  const lip = Math.exp(-Math.pow((r - 246) / 26, 2));
  if (lip > 0.01) { d -= lip * (11 + 8 * mottle); rock += lip * 0.5; }

  // ---- 8. named landmarks
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    const dx = x - f.x, dz = z - f.z;
    const dd = dx * dx + dz * dz;
    if (dd > f.R2) continue;
    const t = Math.sqrt(dd) / f.R;
    if (f.type === 'crater') {
      const b = 1 - t * t;
      d += f.depth * b * b * (0.72 + 0.28 * b);
      d -= f.rim * Math.exp(-Math.pow((t - 0.84) / 0.13, 2));
      ao -= 0.30 * b * b;
      rock += 0.35 * sstep(0.45, 0.95, t);
    } else if (f.type === 'mesa') {
      // rounded sides, flat top (LOOK §7 "stacked plateaus with steep ROUNDED sides")
      const top = sstep(1.0, f.top, t);
      d -= f.height * top;
      rock += sstep(0.05, 0.55, top) * (1 - top) * 1.4;
      ao -= 0.22 * sstep(1.0, 0.86, t) * (1 - sstep(0.9, 0.6, t));
    } else if (f.type === 'shaft') {
      // A hole punched clean through the shelf: near-vertical walls (the mouth
      // is a 0.16-wide ring), a lip that is *not* raised, and a floor deep
      // enough that fog eats it — LOOK.md §7 "bottoms simply not visible".
      const k = 1 - sstep(0.62, 0.90, t);
      d += f.depth * k * k;
      ao -= 0.58 * k;
      rock += 1.2 * sstep(0.55, 0.95, t) * k;
    } else if (f.type === 'knoll') {
      // A Safe-Shallows reef mass: a melted, lopsided dome. Two smoothsteps give
      // a flat crown and a rolled shoulder (LOOK.md §7/§11.23), and the azimuthal
      // lobing keeps the plan outline from being a circle.
      const ang = Math.atan2(dz, dx);
      const lobe = 1 + 0.30 * Math.sin(ang * 3 + f.x * 0.11) + 0.18 * Math.sin(ang * 5 - f.z * 0.07);
      const tt = clamp01(t / clamp(lobe, 0.55, 1.5));
      const u = 1 - tt;
      const k = u * u * (3 - 2 * u);
      const k2 = k * k * (3 - 2 * k);
      d -= f.height * k2 * (0.80 + 0.34 * ridgedSoft(dx * 0.048, dz * 0.048, 2));
      rock += sstep(0.04, 0.42, k2) * 1.5;
      // the sand collar around the base sits in the knoll's own shadow
      ao -= 0.26 * sstep(0.02, 0.22, k2) * (1 - sstep(0.22, 0.55, k2));
    } else if (f.type === 'spire') {
      // smoothstep profile: steep flanks, zero slope at the tip, so the summit is
      // a rounded crown and never a one-vertex needle
      const u = 1 - t;
      const k = u * u * (3 - 2 * u);
      const ang = Math.atan2(dz, dx);
      const flute = 1 + 0.14 * Math.sin(ang * 7 + gn(f.x * 0.1, f.z * 0.1) * 3)
                  * sstep(0.06, 0.34, t);
      d -= f.height * k * flute * (0.82 + 0.32 * ridgedSoft(dx * 0.03, dz * 0.03, 2));
      rock += sstep(0.02, 0.35, k) * 1.6;
      ao -= 0.18 * sstep(0.9, 0.35, t) * (1 - sstep(0.35, 0.05, t));
    }
  }

  // ---- 9. surface detail, kept small: props bed into this
  d -= fbm(x * 0.058 + 2.2, z * 0.058 - 6.6, 2) * 0.7;
  d -= gn(x * 0.19, z * 0.19) * 0.14;

  // ---- 10. shelf ceiling. Two scales of reef head plus a named knoll plus the
  // ridge stack can all land on the same square metre, and their sum was
  // breaking the surface — which puts the shallows cameras inside solid rock.
  // A hard clamp would slice every crown off at one plane; this exponential
  // soft-min asymptotes to 15 m depth while compressing rather than truncating
  // the relief, so the crowns stay rounded and each one keeps its own height.
  if (d < 24) d = 24 - 9 * (1 - Math.exp(-(24 - d) / 9));
  if (d > 1400) d = 1400;
  o.h = -d;
  o.ao = clamp(ao, 0.17, 1);
  o.mottle = mottle * 0.5 + 0.5;
  o.rock = clamp01(rock);
  // coral / turf crust: shallow, up on the reef, patchy
  o.coral = clamp01(sstep(0.10, 0.55, o.rock) * (1 - sstep(55, 130, d))
    * sstep(-0.35, 0.40, gn(x * 0.021 + 3.7, z * 0.021 - 1.1)));
  return o;
}

// ------------------------------------------------------------------ public API
let _mx = NaN, _mz = NaN, _mh = 0;
/** Seabed height at a world XZ. Exact, allocation-free, memoised for repeats. */
export function heightAt(x, z) {
  if (x === _mx && z === _mz) return _mh;
  _mx = x; _mz = z;
  _mh = sampleAt(x, z, _s1).h;
  return _mh;
}

const _n = new THREE.Vector3();
/** Surface normal at a world XZ. Central differences; LOD independent. */
export function normalAt(x, z, out) {
  const e = 0.6;
  const hl = sampleAt(x - e, z, _s1).h, hr = sampleAt(x + e, z, _s1).h;
  const hd = sampleAt(x, z - e, _s1).h, hu = sampleAt(x, z + e, _s1).h;
  _mx = NaN;                                    // the memo is stale after this
  const v = out || new THREE.Vector3();
  return v.set(-(hr - hl) / (2 * e), 1, -(hu - hd) / (2 * e)).normalize();
}

/** 0 = flat, 1 = vertical. */
export function slopeAt(x, z) { return 1 - normalAt(x, z, _n).y; }

/** Depth of the seabed below the surface at XZ, positive metres. */
export function depthAt(x, z) { return -heightAt(x, z); }

// ---------------------------------------------------------------- biome map
// Ids match world/biomes.js exactly, because biomes.groundAt() asks us to name
// the rock and then looks the name up in its own table. The site layout is read
// from that module at init; this table is only the fallback for when it is a
// stub, and it mirrors the same layout so the world does not move.
const FALLBACK_SITES = [
  { id: 'safe_shallows', x: 0, z: 0, r: 120, f: 70 },
  { id: 'safe_shallows', x: -140, z: 55, r: 80, f: 50 },
  { id: 'kelp_forest', x: 165, z: -130, r: 110, f: 60 },
  { id: 'kelp_forest', x: -230, z: -230, r: 100, f: 55 },
  { id: 'grassy_plateaus', x: -200, z: 200, r: 120, f: 65 },
  { id: 'grassy_plateaus', x: 250, z: 265, r: 130, f: 70 },
  { id: 'mushroom_forest', x: -330, z: -40, r: 150, f: 80 },
  { id: 'crash_zone', x: 300, z: 20, r: 140, f: 80 },
  { id: 'sparse_reef', x: 0, z: 320, r: 160, f: 90 },
  { id: 'dunes', x: -40, z: -450, r: 190, f: 105 },
  { id: 'bulb_zone', x: -420, z: -380, r: 140, f: 75 },
];
// depth (m) -> biome, for ground no site claims. Same ladder biomes.js uses.
// The grand_reef threshold is 285 rather than 395 because biomes.js declares
// grand_reef as depth [250,500]: with the terrace at -292 the grand-reef shot
// has to actually *be* in the Grand Reef, or it renders in Dunes tan-brown.
const DEPTH_LADDER = [
  [0, 'safe_shallows'], [55, 'safe_shallows'], [130, 'sparse_reef'],
  [205, 'dunes'], [285, 'grand_reef'], [620, 'lost_river'],
  [1085, 'inactive_lava_zone'],
];
const VOID_R0 = 1250, VOID_R1 = 1750;

let SITES = FALLBACK_SITES;

function depthLadder(depth) {
  let id = DEPTH_LADDER[0][1];
  for (let i = 0; i < DEPTH_LADDER.length; i++) if (depth >= DEPTH_LADDER[i][0]) id = DEPTH_LADDER[i][1];
  return id;
}

/**
 * Which biome owns the *rock* at (x,z) — the ground, not the water column above
 * it. world/biomes.js calls this to name the seabed, so it must never call back
 * into biomes or the two modules deadlock on each other.
 */
export function biomeAt(x, z) {
  if (Math.hypot(x, z) > (VOID_R0 + VOID_R1) * 0.5) return 'void';
  let bestW = 0, bestId = null;
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const w = 1 - sstep(s.r, s.r + s.f, dist);
    if (w > bestW) { bestW = w; bestId = s.id; }
  }
  if (bestW > 0.5) return bestId;
  return depthLadder(-heightAt(x, z));
}

// ---------------------------------------------------------------- ray march
/** Ray/terrain intersection by marching + bisection. Returns Vector3 or null. */
export function raycast(origin, dir, maxDist = 400, out) {
  const p = out || new THREE.Vector3();
  if (origin.y - heightAt(origin.x, origin.z) < 0) return p.copy(origin);
  const step = Math.max(0.5, maxDist / 220);
  for (let t = step; t < maxDist; t += step) {
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    if (y - heightAt(x, z) < 0) {
      let lo = t - step, hi = t;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) * 0.5;
        if (origin.y + dir.y * m - heightAt(origin.x + dir.x * m, origin.z + dir.z * m) < 0) hi = m;
        else lo = m;
      }
      return p.set(origin.x + dir.x * hi, origin.y + dir.y * hi, origin.z + dir.z * hi);
    }
  }
  return null;
}

// ============================================================== biome palette
// A 32 m lattice of blended terrain colours. Biome colour varies over hundreds
// of metres, so sampling it per vertex would be pure waste — bilinear off a
// lattice is both smoother (no hard boundary between palettes) and ~free.
const PAL_STEP = 32;
const PAL_N = Math.round(WORLD.worldSize / PAL_STEP) + 1;
const PAL_ORIGIN = -WORLD.worldSize / 2;
const palData = new Float32Array(PAL_N * PAL_N * 9);   // sand, rock, accent

// Fallback palettes, used only when world/biomes.js is a stub. Linear.
const FALLBACK_PAL = {
  safe_shallows:      [0.69, 0.58, 0.37, 0.25, 0.23, 0.16, 0.72, 0.15, 0.10],
  kelp_forest:        [0.47, 0.44, 0.23, 0.15, 0.19, 0.11, 0.60, 0.31, 0.04],
  grassy_plateaus:    [0.61, 0.51, 0.30, 0.21, 0.22, 0.17, 0.14, 0.42, 0.07],
  mushroom_forest:    [0.51, 0.45, 0.29, 0.15, 0.18, 0.14, 0.68, 0.13, 0.26],
  crash_zone:         [0.47, 0.35, 0.23, 0.19, 0.14, 0.10, 0.42, 0.08, 0.02],
  sparse_reef:        [0.59, 0.52, 0.34, 0.20, 0.21, 0.18, 0.20, 0.50, 0.62],
  dunes:              [0.56, 0.47, 0.31, 0.18, 0.18, 0.14, 0.35, 0.26, 0.15],
  bulb_zone:          [0.32, 0.38, 0.18, 0.10, 0.14, 0.09, 0.26, 0.74, 0.07],
  grand_reef:         [0.33, 0.36, 0.27, 0.10, 0.13, 0.13, 0.10, 0.46, 0.52],
  lost_river:         [0.28, 0.33, 0.20, 0.07, 0.09, 0.07, 0.21, 0.74, 0.35],
  inactive_lava_zone: [0.15, 0.07, 0.04, 0.05, 0.02, 0.02, 1.00, 0.17, 0.02],
  void:               [0.07, 0.09, 0.12, 0.04, 0.05, 0.07, 0.15, 0.39, 0.63],
};
let PALETTES = FALLBACK_PAL;

const _pw = [];
function paletteNode(x, z, out, oi) {
  // accumulate site weights per biome, then fill the remainder from the depth
  // ladder, then fade the whole thing into the void palette at the world edge
  _pw.length = 0;
  let total = 0;
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const w = 1 - sstep(s.r, s.r + s.f, Math.sqrt(dx * dx + dz * dz));
    if (w <= 1e-3) continue;
    const e = _pw.find((q) => q.id === s.id);
    if (e) { if (w > e.w) { total += w - e.w; e.w = w; } }
    else { _pw.push({ id: s.id, w }); total += w; }
  }
  if (total < 1) {
    const id = depthLadder(-heightAt(x, z));
    const e = _pw.find((q) => q.id === id);
    if (e) e.w += 1 - total; else _pw.push({ id, w: 1 - total });
    total = 1;
  }
  const voidness = sstep(VOID_R0, VOID_R1, Math.hypot(x, z));
  if (voidness > 1e-3) {
    for (const e of _pw) e.w *= 1 - voidness;
    _pw.push({ id: 'void', w: voidness * total });
    total = _pw.reduce((s2, e) => s2 + e.w, 0);
  }
  const inv = 1 / Math.max(total, 1e-6);
  for (let k = 0; k < 9; k++) out[oi + k] = 0;
  for (const e of _pw) {
    const p = PALETTES[e.id] || PALETTES.safe_shallows || FALLBACK_PAL.safe_shallows;
    const w = e.w * inv;
    for (let k = 0; k < 9; k++) out[oi + k] += p[k] * w;
  }
}

function buildPaletteLattice() {
  for (let j = 0; j < PAL_N; j++) {
    const z = PAL_ORIGIN + j * PAL_STEP;
    for (let i = 0; i < PAL_N; i++) {
      paletteNode(PAL_ORIGIN + i * PAL_STEP, z, palData, (j * PAL_N + i) * 9);
    }
  }
}

/** Bilinear sample of the blended biome terrain palette. out gets 9 floats. */
export function floorPaletteAt(x, z, out, oi = 0) {
  const fx = clamp((x - PAL_ORIGIN) / PAL_STEP, 0, PAL_N - 1.001);
  const fz = clamp((z - PAL_ORIGIN) / PAL_STEP, 0, PAL_N - 1.001);
  const i0 = fx | 0, j0 = fz | 0;
  const tx = fx - i0, tz = fz - j0;
  const a = (j0 * PAL_N + i0) * 9, b = a + 9;
  const c = ((j0 + 1) * PAL_N + i0) * 9, d = c + 9;
  const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz);
  const w01 = (1 - tx) * tz, w11 = tx * tz;
  for (let k = 0; k < 9; k++) {
    out[oi + k] = palData[a + k] * w00 + palData[b + k] * w10
                + palData[c + k] * w01 + palData[d + k] * w11;
  }
  return out;
}

// ============================================================== material
const VERT = /* glsl */ `
#include <common>
attribute vec4 aTerr;      // x skyAO   y rockiness   z coral/turf   w cavity
attribute vec4 aHorA;      // baked horizon-elevation sine, as a Fourier series in
attribute vec3 aHorB;      // azimuth: (mean, c1, s1, c2) and (s2, c3, s3)
attribute vec3 aSand;
attribute vec3 aRock;
attribute vec3 aGrow;
varying vec4 vTerr;
varying vec4 vHorA;
varying vec3 vHorB;
varying vec3 vSand;
varying vec3 vRock;
varying vec3 vGrow;
void main() {
  vTerr = aTerr; vSand = aSand; vRock = aRock; vGrow = aGrow;
  vHorA = aHorA; vHorB = aHorB;
  vec3 objectNormal = normal;
  vec3 transformed = position;
  #include <project_vertex>
}
`;

// ---------------------------------------------------------------- ablation
/**
 * THIS MODULE'S OWN ABLATION SWITCHES, and why it needs them.
 *
 * Round 35's brief asked me to prove the caustic-occlusion adoption with core's
 * `?nocaustocc=1`, on the rule "if the frame is still bit-identical you have not
 * wired it". That rule is not sound, and the ablation is not a complete one.
 * `src/main.js` gates only the PLAYER push behind the flag:
 *
 *     if (_pp && !NO_CAUSTIC_OCCL) _occl.push({ pos: _pp, radius: 1.1 });
 *     for (const m of modules.values()) { ... _occl.push(o) ... }   // ungated
 *
 * so with the flag set the shallows-floor pose still publishes three live
 * occluders from creatures, and the one it does remove — the diver, pinned to
 * the camera — throws its shadow BEHIND the near clip at that pose (the shadow
 * point is 0.87 m behind the camera plane along the view axis). A term can
 * therefore be perfectly wired, measurably strong, and still leave that
 * particular A/B bit-identical. Ours does: see the numbers in the round report.
 *
 * So the switches below are mine, they ablate the terms at the point of use, and
 * they are what any claim in this module should be measured with.
 *
 *   ?tabl=net:0,occ:0        named, any subset, each 0..1 (and above 1 is legal:
 *                            it is how this round previewed a retune before
 *                            editing a single shader constant)
 *   ?tabl=1,1,0.5,1          positional, in ABL_KEYS order
 *   ?tnocaustocc=1           shorthand for occ:0 — the complete occlusion ablation
 *
 * Every multiplier is exactly 1.0 unless a parameter says otherwise, and every
 * site is written so that 1.0 is algebraically the previous expression, so the
 * shipped path is a no-op. `terrain.ablation` publishes what the uniforms
 * actually hold rather than what was asked for, because a switch that silently
 * does nothing has manufactured false evidence in this project five times.
 *
 * They are uniforms, not defines, so they add no shader program variant: the
 * world already carries ~94 of those and each one costs a multi-second stall the
 * first time it is drawn. Verified: 174 programs with them and without.
 */
const uAbl  = { value: new THREE.Vector4(1, 1, 1, 1) };  // ripple, mineral, grain, broadband
const uAbl2 = { value: new THREE.Vector4(1, 1, 1, 1) };  // net, occlusion, drift, grainN
const ABL_KEYS = ['ripple', 'mineral', 'grain', 'broad', 'net', 'occ', 'drift', 'grainN'];

// ---------------------------------------------------------------- shared glsl
// The cobble field (below) has to be shaded by exactly the same sand and the
// same light as the seabed it is bedded into, or its contact apron reads as a
// disc pasted on the floor. So the sand, the noise and the lighting are one
// source of truth, included by both fragment shaders.
const NOISE_GLSL = /* glsl */ `
uniform vec4 uAbl;   // ablation, all 1.0 in the game — see the note above
uniform vec4 uAbl2;
float thash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z) * 2.0 - 1.0;
}
float h11(float n) { return fract(sin(n * 78.233 + 1.7) * 43758.5453); }

// value noise + analytic derivative: one tap gives colour *and* bump
vec3 nd(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = thash(i);
  float b = thash(i + vec2(1.0, 0.0));
  float c = thash(i + vec2(0.0, 1.0));
  float d = thash(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
              du.x * (k1 + k3 * u.y),
              du.y * (k2 + k3 * u.x));
}
float n1(vec2 x) { return nd(x).x; }
`;

// ---------------------------------------------------------------- detail LOD
// The previous build measured its pixel footprint as
//     length(vec2(fwidth(P.x), fwidth(P.z)))
// which is essentially the footprint's LONG axis, so grain, strata bump and rock
// detail all switched off the moment ONE screen axis was compressed. A swimmer
// looks at the seabed at a shallow pitch essentially all the time, and that
// compresses the vertical axis while leaving the horizontal one perfectly sharp —
// so the floor lost its entire surface signal in exactly the framing a player
// spends the game in, and the ripples degenerated into flat painted stripes.
//
// Anisotropic mip selection solves the identical problem for textures by
// following the MINOR axis and capping the major/minor ratio. This does the same
// with the surface's own 3-space derivatives (3-space, not XZ, so a vertical
// cliff face is measured across its face and not across its footprint).
const LOD_GLSL = /* glsl */ `
#define UW_ANISO 6.0
float uwFootprint(vec3 P) {
  vec3 ddx = dFdx(P), ddy = dFdy(P);
  float a = length(ddx), b = length(ddy);
  return max(min(a, b), max(a, b) / UW_ANISO);
}
// A single noise octave carrying its OWN band limit, in cycles per pixel.
//
// This is the other half of the detail problem. A frame of Subnautica seabed
// measures a Laplacian rms of 15-21 and 53 in the near field; ours measured 2.2
// even in a 6 m top-down where the medium removes almost nothing. The Laplacian
// only sees structure a few pixels wide, and this module's finest sand octave
// was 0.12 m — sixteen pixels at that range, i.e. invisible to the metric and
// nearly invisible to the eye. Real sand photographed at ANY distance carries
// grain right down to the resolution limit, so the octave stack has to run down
// to ~2 px and each octave has to switch itself off at its own Nyquist rather
// than the whole stack switching off together at one distance.
// Every octave is ROTATED by its own irrational-ish angle. Value noise is built
// on an axis-aligned integer lattice, and once its amplitude is high enough to
// matter the lattice itself becomes visible: stacking octaves at 3.6 / 8.5 / 21
// cycles per metre with no rotation quilts the sand into a grid of squares,
// which is LOOK.md §11.22's "tiling noise with visible grid frequency" in its
// purest form. Rotating each octave puts the lattices out of register so only
// their sum is visible.
vec2 uwRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
float uwOct(vec2 p, float f, float ang, float mpp) {
  return n1(uwRot(p, ang) * f) * (1.0 - smoothstep(0.20, 0.44, f * mpp));
}
// ROTATION IS NOT ENOUGH ON ITS OWN.
//
// A rotated lattice still has straight cell walls; rotate it and you get a
// diagonal grid instead of an upright one. What actually removes the grid is
// bending the coordinate before the lattice is sampled, so the cell walls
// become curves and no two neighbouring cells share an edge direction. The
// previous build rotated its octaves and still shipped a near field of 1.2 m
// dark RECTANGLES, because the layer carrying most of the contrast was a single
// hard-thresholded octave and a threshold across one lattice draws that
// lattice's own cells.
//
// The cheap warp is to displace each octave by the value of a coarser one that
// has already been sampled: a spatially varying shear costs a multiply-add and
// bends the lattice exactly where it matters. The offset is in LATTICE units, so keep
// it near a third of a cell — much more and the octave simply decorrelates into
// a different noise instead of the same noise with curved cells.
vec2 uwBend(vec2 p, float v, vec2 d) { return p + v * d; }
`;

// ---------------------------------------------------------------- sun occlusion
// buildGeometry sweeps the heightfield in 8 compass directions at every vertex
// and records the SINE of the elevation of the highest thing in each direction.
// Those 8 numbers are stored as a mean plus three azimuthal harmonics — 7 floats,
// and a Fourier reconstruction is smooth in azimuth where a nearest-of-8 lookup
// would snap every shadow edge round in 45 degree steps.
//
// Comparing that horizon against the sun's own elevation is a REAL cast shadow:
// a reef knoll darkens the sand behind it, the drop-off throws its own foot into
// shade, a crevasse wall shades its floor. It is exact at vertex resolution, has
// none of a shadow map's bias/acne/resolution problems, costs one attribute
// fetch, and because the horizon is stored for all azimuths it follows the sun
// across the day instead of being baked to one time.
const OCC_GLSL = /* glsl */ `
float uwSunVis(vec4 hA, vec3 hB, vec3 sunDir) {
  vec2 sxz = sunDir.xz;
  float l = length(sxz);
  if (l < 1e-4) return 1.0;
  vec2 u = sxz / l;
  float c1 = u.x, s1 = u.y;
  float c2 = c1 * c1 - s1 * s1, s2 = 2.0 * c1 * s1;
  float c3 = c1 * c2 - s1 * s2, s3 = s1 * c2 + c1 * s2;
  float h = hA.x + hA.y * c1 + hA.z * s1 + hA.w * c2 + hB.x * s2 + hB.y * c3 + hB.z * s3;
  h = clamp(h, 0.0, 1.0);
  // The underwater sun is a broad source smeared by the surface and by forward
  // scattering, so its penumbra is wide; a hard step here reads as a stencil.
  return smoothstep(h - 0.05, h + 0.18, sunDir.y);
}
`;

// The sand. One function, world-space, so the seabed and every cobble apron
// agree pixel for pixel.
//
// The ripples are the point. LOOK.md §7 asks for 1.5-3 m directional ripples;
// the previous build had the right *frequency* but spent its whole contrast
// budget on three octaves of 12/3.7/0.9 m noise, so the ripple never rose above
// the fuzz and an autocorrelation of the near field found no period at all.
// Here the ripple owns the sand: +-40 % of albedo and a 0.19 surface gradient,
// with an asymmetric crest (winnowed pale sand on top, heavy dark grains in the
// trough) because a plain sine reads as corrugation rather than as sediment.
const SAND_GLSL = /* glsl */ `
vec3 uwSand(vec3 Pw, vec3 Ng, vec3 pal, float mpp, out vec2 grad, out float rocc) {
  // Takes the full world position now, not just XZ: the screen-locked broadband
  // term at the bottom needs a 3D point and the camera distance to it.
  vec2 su = Pw.xz;
  float m1 = n1(su * 0.0035);
  float m2 = n1(su * 0.019 + 17.0);

  // two broad octaves only — the old 1.10 (0.9 m) octave was the combed fuzz
  vec3 s1 = nd(su * 0.085);
  vec3 s2 = nd(su * 0.30 + 5.0);
  grad = s1.yz * (0.085 * 0.42) + s2.yz * (0.30 * 0.16);

  // ONE direction, turning over ~240 m. The previous build steered the crests
  // into the local slope direction, which makes the level sets of the phase the
  // contour lines of the terrain: the floor filled with concentric rings and
  // herringbone chevrons that read instantly as a shader bug. Real ripples run
  // straight across a whole shot (LOOK.md §7) — so they do here, and the only
  // thing the surface normal is allowed to do is fade them out on steep ground.
  float rang = n1(su * 0.0042) * 3.2;
  vec2  pdir = vec2(cos(rang), sin(rang));
  float slopeW = smoothstep(0.14, 0.62, length(Ng.xz));
  float phase = dot(su, pdir) * 2.86 + n1(su * 0.052) * 2.1;   // 2.20 m crests
  float pw = max(fwidth(phase), 1e-5);
  // Band-limit: once a whole period is inside ~2 px the ripple has to go, or it
  // beats against the pixel grid into moire across the entire mid-ground. The
  // coefficient is set so the crests are full strength inside ~20 m, half by
  // 30 m and gone by 45 m at a 3.5 m eye height — which is exactly how far the
  // reference floor's ripples stay readable.
  float aa  = 1.0 / (1.0 + pw * pw * 1.4);
  float aa2 = 1.0 / (1.0 + pw * pw * 9.0);
  // 0.58, not 0.75, of the ripple removed on slopes. The shallows floor shots
  // look mostly at the FLANK of a reef knoll rather than at level basin, so the
  // old fade left the one 1.5-3 m feature LOOK.md §7 asks for by name at a
  // quarter strength over most of the frame — and with the mineral layers now
  // halved there is nothing else in that band except the caustic net.
  float ripA = (0.66 + 0.34 * (m2 * 0.5 + 0.5)) * (1.0 - 0.58 * slopeW) * aa * uAbl.x;
  float crest = pow(0.5 + 0.5 * sin(phase), 2.2);              // mean ~0.38
  float phase2 = phase * 3.35 + n1(su * 0.26) * 1.6;
  float crest2 = (0.5 + 0.5 * sin(phase2)) * aa2;

  grad += cos(phase) * (2.86 * 0.072 * ripA) * pdir
        + cos(phase2) * (9.6 * 0.0060 * ripA * aa2) * pdir;

  // ---- ripple SELF-OCCLUSION.
  // Modulating albedo alone gives "painted corduroy": regular parallel stripes
  // with no relief, because nothing about them responds to where the light is.
  // A real ripple field darkens asymmetrically. The flank turned away from the
  // sun loses its lambert term (that part is the gradient above) AND is partly
  // occluded by the crest upwind of it, with the deepest shade sitting in the
  // trough — and that second part no normal perturbation can produce, because
  // occlusion is not a function of the local normal. Both are driven by
  // dot(pdir, sunDir.xz): with the sun running ALONG the crests there is no
  // asymmetry at all, which is exactly right, and the lee goes 35-40% dark when
  // it runs across them.
  vec2 sxz = uSunDir.xz;
  float sl = length(sxz);
  float along  = sl > 1e-4 ? dot(pdir, sxz / sl) : 0.0;
  float cotEl  = sl / max(uSunDir.y, 1e-3);                  // 0 overhead, 1 at 45 deg
  float lowSun = smoothstep(0.04, 0.50, cotEl);
  float flank  = clamp(cos(phase) * along, 0.0, 1.0);        // 1 on the lee wall
  float trough = 0.5 - 0.5 * sin(phase);                     // 1 in the trough
  rocc = 1.0 - 0.30 * ripA * lowSun * flank * (0.28 + 0.72 * trough);

  // ---- THE CONTRAST BUDGET, AND WHY IT SHRANK.
  // Every coefficient from here down was cut this round, and the reason is a
  // measurement rather than a preference. Band-limited against the reference sand
  // crop of shallows-floor-1.jpg, our floor carried 8.3 % of its own mean at the
  // 0.5-3 m scale against the reference's 5.1 %, and a 95th/5th luminance ratio
  // of 2.06:1 against the reference's 1.31:1 — while its FINEST band (1-2 px,
  // what tools/measure.mjs calls detailRMS) was already spot on at 9.9 % against
  // 9.0 %. So the excess is not grain, it is the 0.3-3 m mineral and drift
  // layers, and they sit in precisely the band LOOK.md §3 reserves for the
  // caustic net. Cutting them is what lets the net become the loudest thing at
  // its own scale instead of the second loudest, which is the whole of blind
  // pair 014. The fine grain is left nearly alone, because that is the half we
  // already match.
  vec3 c = pal;
  c *= 1.0 + uAbl2.z * (-0.10 + 0.16 * (m1 * 0.5 + 0.5) + 0.05 * m2);
  // broad 10 m pale/dark drifts — the sand is never one value across a frame
  c *= 1.0 + uAbl2.z * (-0.11 + 0.22 * (n1(uwRot(su, 1.05) * 0.092 + 23.0) * 0.5 + 0.5));
  // THE RIPPLE GIVES UP THE BAND. 1.5-3 m directional crests are named in
  // LOOK.md §7 and must be there — but at 1.75 of albedo on top of a 22 degree
  // normal perturbation and a 42 % lee occlusion, they were not a ripple field,
  // they were CORDUROY: heavy parallel stripes owning the whole 1-3 m band. That
  // matters more than it sounds, because 1-3 m is exactly where LOOK.md §3 puts
  // the caustic net, and a net cannot read as a polygonal net while a set of
  // parallel bars is drawing four times its contrast on top of it. Look at
  // shallows-floor-1.jpg: the ripples in the reference are barely visible and the
  // net is the loudest thing on the sand. So the albedo share drops to a third,
  // the relief to two thirds, the lee occlusion to 0.30 — the ripple is still a
  // ripple, it is just no longer the subject.
  c *= 1.0 + ripA * ((crest - 0.38) * 0.55 + (crest2 - 0.5) * 0.10);
  // ---- HEAVY MINERAL: the dark patches and the black trails that cover the
  // reference shallows floor. Pure albedo, no gradient — they are a mineral, not
  // a bump — and they carry a large part of the near field's measured detail
  // (shallows-floor-1.jpg runs luminance 40 in a trail to 230 on clean sand).
  //
  // THE PREVIOUS BUILD DREW THEM AS A LATTICE. The blotch layer was one hard-thresholded
  // axis-aligned value-noise octave at 0.85 cycles/m, and a threshold across a
  // single lattice traces that lattice's own cells: the near field filled with
  // 1.2 m dark RECTANGLES in two perpendicular families, which is LOOK.md
  // §11.22's "repeating tiled texture with a visible grid frequency" in its
  // purest form. The streak layer added a 9:1 stretch of a second unbent lattice, which
  // is where the axis-aligned dashes came from.
  //
  // Three things fix it, and all three are needed. (1) The domain is BENT before
  // it is sampled — a shear that varies over 3-12 m, taken free from the ripple
  // octaves already in hand — so cell walls become curves. (2) Each layer is
  // rotated by its own angle so no two residual lattices are in register.
  // (3) The threshold runs across a SUM of three frequencies rather than one, so
  // there is no single cell size for the eye to lock onto.
  // The bend field, in metres, built for free out of the two ripple octaves that
  // have already been sampled. The coefficients are bounded by the JACOBIAN, not
  // by taste: d(bend)/d(su) has to stay well under 1 or the warp folds the
  // domain back on itself and pinches the noise into cusps, which is a worse
  // artifact than the lattice it is removing. s1 runs at 0.085 cycles/m (|d| <=
  // 0.32/m) and s2 at 0.30 (|d| <= 1.14/m), so these weights cap the worst-case
  // stretch at 0.67 and the map stays one-to-one everywhere.
  vec2 wv = vec2(s1.x * 1.30 + s2.x * 0.22, s1.x * -0.85 + s2.x * 0.30);
  vec2 bu = su + wv;
  // ...and each layer additionally bends the NEXT one, the same progressive warp
  // the rock uses. The single shared bend above curves all three lattices the
  // same way, which removes the axis but can still leave the 1.2 m layer drawing
  // recognisable right-angled cells; bending it again by the layer above breaks
  // the corners themselves.
  float b1 = n1(uwRot(bu, 0.53) * 0.30);
  float b2 = n1(uwBend(uwRot(bu, 1.91) * 0.83, b1, vec2( 0.36, -0.24)) + 31.0);
  float b3 = n1(uwBend(uwRot(bu, 2.74) * 2.10, b2, vec2(-0.30,  0.33)) - 9.0)
           * (1.0 - smoothstep(0.30, 0.52, 2.10 * mpp));
  float bl = b1 + 0.72 * b2 + 0.46 * b3;
  float blot = smoothstep(-0.22, 0.70, bl);
  // The trails in the reference are long CURVED filaments that cluster and fan
  // out, not dashes. So the anisotropic field is sampled in a domain that has
  // already been bent (which turns a straight 9:1 stretch into a meander), two
  // stretches of different length are summed, and the bearing turns over ~120 m
  // so no two parts of a frame share a direction.
  float tang = n1(su * 0.0083 + 5.0) * 3.14159;
  vec2  tu   = uwRot(su + wv * 0.9, tang);
  float trail = smoothstep(0.02, 0.72, n1(uwBend(vec2(tu.x * 4.4, tu.y * 0.55), b1, vec2(0.9, -0.4)) + 47.0)
                                     + 0.55 * n1(vec2(tu.x * 1.6, tu.y * 0.21) - 3.0))
              * smoothstep(-0.28, 0.46, n1(uwRot(bu, 1.10) * 0.55 - 12.0))
              * (1.0 - smoothstep(0.30, 0.52, 4.4 * mpp));
  // 0.15 / 0.17, down from 0.30 / 0.32. These two layers are the single largest
  // contributor to the 0.5-3 m band, which is the band the caustic net has to own
  // (LOOK.md §3, and blind pair 014 by name). Halving them is what moved the
  // floor's band-limited contrast from 1.65x the reference's toward parity — and
  // the mineral is still visibly there, because at 15 % of albedo a dark trail on
  // pale sand is still a dark trail, it is just no longer the loudest structure
  // in a frame that is supposed to be about light on sand.
  // 0.085 / 0.105, down from 0.15 / 0.17. Re-measured this round against the
  // reference sand on THREE independent 154x86 px patches of each image, the
  // laplacian-pyramid profile (tools/measure.mjs "octaves", RMS per band as a
  // percentage of crop mean, corrected for the sRGB offset's level bias):
  //
  //     reference   1.75-2.53 / 1.52-2.52 / 1.60-2.74 / 1.96-3.28   tilt 1.1-1.4
  //     ours        2.69-5.75 / 3.49-8.35 / 4.47-10.24 / 5.36-9.90  tilt 1.7-2.1
  //
  // The reference sand is SPECTRALLY FLAT and stays flat under an 8x resampling
  // sweep (its coarsest band reads 4.36 at native and 4.80 at 1/8 scale), so the
  // comparison survives not knowing its exact metres-per-pixel. Ours is flat
  // NOWHERE: level-corrected, our finest band is already at parity (5.3 % against
  // the plate's 3.9-5.7 %) while the 8-32 px band runs about 2x, and
  // tileContrast/mean is 8.5-19.5 % against the plate's 4.0-6.2 %. So the excess
  // is entirely mid-scale and the fine end must NOT be cut with it - which is the
  // error the round-7 critique names ("r7 lowered fine, mid, net AND coarse bands
  // together instead of trading hard-edged contrast for broadband grain").
  c *= (1.0 - 0.085 * blot * uAbl.y) * (1.0 - 0.105 * trail * uAbl.y);
  // Grain, five octaves, each band-limited on its own.
  //
  // Every one of these numbers is roughly twice what it would be in air, and
  // deliberately so. Two things flatten surface contrast here before it reaches
  // the eye: the medium keeps only ~50 % of green and ~20 % of red over 8 m in
  // the shallows, and the shared caustic term is ADDITIVE and lands at a third
  // of the surface's own diffuse. Between them a textbook +-20 % stipple arrives
  // on screen at +-6 %, which is the difference between sand and a plastic
  // sheet. The stack runs to 52 cycles/m (a 2 cm grain) because that is what is
  // still a couple of pixels wide at arm's length, and each octave carries its
  // own Nyquist cutoff so the fine ones simply are not sampled once they stop
  // being resolvable — no crawling, no need to switch the whole stack off.
  // Anisotropy is deliberately weaker here (mpp is already the minor axis) since
  // grain, unlike a ripple, has no direction to be sharp along.
  float mg = mpp * 1.35;
  // Weighted DOWN at the two coarse octaves and up at the two fine ones. Value
  // noise lives on a square lattice, and at 0.27 m a strong octave reads as a
  // field of dark rectangles — a texture tell — while at 0.02-0.05 m the same
  // energy reads as grain and is also what the Laplacian metric actually sees.
  // THIS OCTAVE STACK WAS THE LATTICE, and it took isolating every other layer
  // to prove it. The mineral layers were rendered on their own and were near
  // zero across the patch that showed the dashes; the baked per-vertex ao,
  // cavity and sun visibility rendered perfectly smooth; hiding the cobbles
  // changed nothing; zeroing the caustics changed nothing. What was left was the
  // 3.7 cycles/m octave — 0.27 m cells, about 18 px at the range the shallows
  // camera looks at the floor, which is exactly the size of the "rectangular
  // dashes" — running unbent on the value-noise integer lattice at 20 % weight.
  //
  // A bend only breaks a lattice if the bend field VARIES over about a cell.
  // Sharing the mineral layers' 3-12 m bend field with a 0.27 m lattice slides
  // it bodily and leaves every cell wall exactly as straight as it was, which is
  // why rotating and warping the stack the first time changed nothing here. So
  // each octave is bent by the octave directly above it — never more than ~3x
  // apart in frequency — and the coarsest gets a dedicated 0.7 m bend source,
  // the one extra tap in this function.
  vec2 gu = su + wv * 0.60;
  float wg4 = 1.0 - smoothstep(0.30, 0.52,  3.7 * mg);
  float wg9 = 1.0 - smoothstep(0.30, 0.52,  9.1 * mg);
  float wg22 = 1.0 - smoothstep(0.30, 0.52, 22.3 * mg);
  float wg55 = 1.0 - smoothstep(0.30, 0.52, 54.7 * mg);
  float gw = n1(uwRot(gu, 2.05) * 1.45 + 3.0);
  float g1 = n1(uwBend(uwRot(gu, 0.47) *  3.7, gw, vec2( 0.40, -0.28)) +  7.0) * wg4;
  float g2 = n1(uwBend(uwRot(gu, 1.31) *  9.1, g1, vec2(-0.32,  0.36)) +  2.0) * wg9;
  float g3 = n1(uwBend(uwRot(gu, 2.29) * 22.3, g2, vec2( 0.30,  0.26)) -  5.0) * wg22;
  float g4 = n1(uwBend(uwRot(gu, 0.79) * 54.7, g3, vec2(-0.27,  0.33)) + 13.0) * wg55;
  // and weighted DOWN at 3.7: 0.27 m is the worst possible size for a lattice
  // artifact — big enough to read as a shape, small enough to repeat many times
  // in a frame — so the energy moves to where it reads as grain instead.
  // 0.07, down from 0.20 before this round. A bend cannot fully hide a lattice,
  // only curve it, so the last of the fix is to stop asking that band to carry
  // contrast at all: the 0.3-1 m tonal variation belongs to the mineral layers
  // above, which are bent at their own scale and read as sediment rather than as
  // texture, and the grain proper starts at 9 cycles/m where a cell is 2-3 px.
  // g1 0.05 -> 0.02 and g2 0.28 -> 0.15, THE FINE PAIR LEFT ALONE.
  //
  // This is the "0.1-0.25 m camouflage mottle with no grain" the round-7
  // critique measured, and the mechanism is the band limiting directly above.
  // At the shallows-floor pose the mid-ground floor sits at mpp ~= 0.022 m/px,
  // so mg = 0.030 and the two FINE octaves are switched off outright
  // (22.3*0.030 = 0.66 and 54.7*0.030 = 1.64, both past the 0.52 cutoff) while
  // g1 at 0.27 m and g2 at 0.11 m survive at full weight. What the eye is shown
  // beyond ~10 m is therefore not this stack's grain, it is this stack's two
  // COARSEST members with nothing left to sit under - a 5-12 px blotch field.
  // Cutting them is what flattens the profile; the octaves they leave behind at
  // close range are g3 and g4, which are the ones that actually read as sand.
  // 0.15 -> 0.075 and 0.35 -> 0.175 AT THE TWO MIDDLE OCTAVES ONLY, with the
  // finest RAISED. This is a spectral change, not a contrast cut, and the
  // difference matters: every previous attempt here scaled the whole stack,
  // which is the error round 7 names by name.
  //
  // Measured this round on shallows-floor with an in-page A/B (one boot, one
  // geometry state, the ablation uniforms toggled between renders, so streaming
  // and LOD cannot move; three identical baselines agreed to four significant
  // figures on every statistic). Laplacian-pyramid RMS as a percentage of window
  // mean, fine -> coarse, on 200x160 sand-only windows, clipAny 0.00 on ours and
  // 0.006-0.77 on all five reference windows so neither side is railed:
  //
  //     ours  (300,890)          5.75  10.05  15.51  18.74  14.95
  //     plate, loudest window    4.11   4.47   4.84   5.38   6.84
  //     plate, cleanest window   1.88   1.68   1.73   2.20   2.70
  //
  // So we are 1.40x the reference's LOUDEST sand at 1-2 px — call that parity —
  // and 3.20x / 3.48x at 4-8 and 8-16 px. The reference sand is flat in pixels
  // at every window (tilt 1.44-1.66) and stays flat under resampling; ours rises
  // 3.3x from the finest band to the fourth. The defect is a HUMP at 4-16 px,
  // which at this pose's 180 px/m is 2-9 cm - exactly where g2 (9.1 cycles/m)
  // and g3 (22.3) sit. Halving those two and lifting g4 moves energy out of the
  // hump without touching the one band we already match.
  //
  // Ablation, same window, showed why a scalar cannot work: scaling the WHOLE
  // stack to 0.45 gave 3.72 / 6.40 / 10.24 / 13.77 / 12.73 - the finest band
  // falls to 0.91x the plate's loudest (under it) while 4-16 px is still at
  // 2.1-2.6x. The stack has to be reshaped, not turned down.
  float grain = g1 * 0.02 + g2 * 0.075 + g3 * 0.175 + g4 * 0.38;
  // 1.02, down only from 1.20, and deliberately barely touched. The finest band
  // is the one place we already MATCH the reference (detailRMS 9.9 % of mean
  // against 9.0 %), so the cut here is 15 % where the 0.5-3 m layers took 50 %.
  // Cutting grain to fix a mid-scale problem is how a floor ends up plastic.
  c *= 1.0 + 1.02 * grain * uAbl.z;
  // ...and the fine grain is relief as well as albedo, which is what makes it
  // survive the additive caustic term instead of being washed out by it.
  // Rotated and bent like everything else, because an unrotated lattice driving
  // the NORMAL is just as visible as one driving the albedo.
  //
  // 9.5 -> 21.0 CYCLES/METRE, AND HALF THE TILT. THIS ONE TAP WAS THE LARGEST
  // SINGLE THING WRONG WITH THE SAND, and it survived every previous contrast
  // budget because those only ever adjusted albedo layers.
  //
  // The comment it replaces claimed 0.105 m is "a few pixels across in the near
  // field". Measured, it is not: raycast through the shallows-floor frame puts
  // the near sand 3.7-6 m away at 139-215 px per metre, so 0.105 m cells land at
  // 15-23 px - dead centre of the 16-32 px band, and 20x the size the comment
  // assumed. Ablated at runtime (identical build, same frozen frame, this tap
  // zeroed) on the sand window 0.401,0.756,0.481,0.836:
  //
  //     octaves  6.84 / 12.17 / 20.27 / 25.31  ->  4.53 / 7.23 / 11.55 / 14.04
  //     tileContrast 17.93 -> 11.16      luminance range 135.8 -> 69.4
  //
  // i.e. it alone carries 42 % of the band-limited energy at 8-17 cm and 38 % of
  // the 32 px local contrast on open sand. That is the "0.1-0.25 m camouflage
  // mottle with no grain" the round-7 critique measured, and it is a NORMAL
  // perturbation, which is why isolating albedo layers never found it.
  //
  // It is moved rather than deleted: relief is what keeps the grain alive
  // through the caustic multiplier, and a surface with none reads as a decal.
  // At 21 cycles/m the cells are 4.8 cm - 7-10 px in the near field, where an
  // eye reads them as grain - and the tap now dies past about 9 m instead of
  // 37 m, which is correct: the screen-locked broadband term below is what is
  // supposed to carry the mid field, and it does so at a flat spectrum.
  // 0.0072 -> 0.0036. The frequency is right and stays; the amplitude was set
  // last round to be "the largest single thing wrong with the sand" and it
  // still is, only now in the other direction. 21 cycles/m is a 4.8 cm cell,
  // which at this pose lands at 8-9 px - the 8-16 px band that measures 3.48x
  // the reference. Ablated on its own with ?tabl=grainN:0 it carries 14 % of the
  // window's 32 px local contrast and 9.54 of the 18.74 in that band (in
  // quadrature), more than any other single tap in the module. Halving it is
  // worth ~2.6 points of that band and costs the 1-2 px band almost nothing,
  // because a 4.8 cm cell is not in the 1-2 px band to begin with.
  vec3 gg = nd(uwBend(uwRot(su, 1.83) * 21.0, gw, vec2(0.30, -0.35)) + 21.0);
  grad += gg.yz * (21.0 * 0.0036 * uAbl2.w * (1.0 - smoothstep(0.30, 0.52, 21.0 * mg)));

  // ---- SCREEN-LOCKED BROADBAND. The other half of the trade, and the half the
  // stack above physically cannot make.
  //
  // Every octave up there is world-locked, so each one has to die at its own
  // Nyquist or it aliases - which is correct, and which is also why the mid
  // field goes smooth: past ~10 m there is nothing left under 0.1 m and the
  // surface is carried by whatever coarse members survive. core/surface.js's
  // sfBroadband() is built the other way round: it walks octaves DOWNWARD from
  // the finest that still resolves at this fragment (~2.5 px per cycle, derived
  // from camera distance, not fwidth - it is stage-safe), at FLAT amplitude per
  // octave. So it lands 6 bands from 2.5 px to ~130 px at every distance, which
  // is exactly the spectrum the reference sand measures and exactly the shape a
  // fixed-frequency stack cannot hold as it recedes.
  //
  // 0.16 here, and it is NOT the whole amount: makeMaterial() passes
  // surface.grain 0.105 to applyUnderwater, and core's sfApply() drives the same
  // sfBroadband field from the same world point, so the two are COHERENT and the
  // sand carries about 0.265 of it in total. Sized rather than chosen:
  // sfBroadbandAt returns the MEAN of its 6 octaves, so each band contributes
  // sigma ~ 0.35/6 of the amplitude - roughly 1.5 % of albedo per band, laid
  // flat. Deliberately UNDER the plate's 4-6 % per band, because our own finest
  // band already measures at parity once the sRGB offset's level bias is taken
  // out (5.3 % against the plate's 3.9-5.7 %); this term exists to hold the
  // profile FLAT as the world-locked octaves drop out with distance, not to add
  // contrast on top of them. It was measured at 0.26 first and that overshot the
  // 1-2 px band by about 50 %.
  //
  // sfBroadbandAt() and an explicitly computed footprint, NOT the 2-argument
  // sfBroadband() wrapper: that one divides by uSurfScale, which is a
  // per-MATERIAL uniform and is 2.4 on the seabed against 0.9 on the cobble
  // material. Every cobble carries a flat apron that re-derives the seabed's own
  // sand through this very function and is meant to be pixel-identical to the
  // ground it lies on - only the contact shadow may distinguish it - so a term
  // whose octave ladder depends on which material happens to be drawing would
  // have ringed every stone in the field with a patch of differently-grained
  // sand. In metres, at 1 m per unit, both materials get the same field.
  // Pw is passed rather than read from a varying because varyings are
  // write-only in the vertex stage and this header is shared with one.
  float sfMpp = max(length(Pw - uCamPos), 0.05) / max(uSfPixelScale, 1.0);
  c *= 1.0 + 0.16 * uAbl.w * sfBroadbandAt(Pw, sfMpp);
  return c;
}
`;

const LIGHT_GLSL = /* glsl */ `
// The one gain the caustic net is applied at, shared by the shaded path and by
// the ?tdbg=1 view so the debug frame cannot flatter the real one. The previous
// build's debug view ran at 0.62 against a shaded path at 1.00, which is exactly
// the kind of quietly-wrong instrument the brief warns about.
// 1.70 -> 0.95, AND THE 1.70 WAS NEVER MEASURED ON SCREEN.
//
// The comment this replaces claimed 1.70 "lands at 2.9:1 in the shader, which is
// LOOK.md section 3's about 2:1 ON SCREEN once the water column has taken its
// third". That inference was extrapolated from a sweep run at gains 0.62 and
// 1.30 and never re-checked at the gain that shipped, and it is wrong in the
// direction nobody tested: the medium and the tone curve do not take a third
// off, they EXPAND it slightly at these levels.
//
// Measured directly, round 35. Two frames from one boot and one geometry state,
// identical but for this term (?tabl=net:0), differenced per pixel in LINEAR
// luminance over the near-sand window (300,890) 200x160 — that ratio map IS the
// net's own on-screen amplitude, with the sand, the medium and the grade divided
// out. The instrument's own noise floor on a null pair is 1.043:1.
//
//     gain 1.70:  p05 0.525   p50 0.745   p95 2.243   ->  p95/p05 = 4.27:1
//
// LOOK.md section 3 measures the reference at about 2:1 and "+30-45 % over local
// diffuse"; ours peaked at +124 %. The plate PLATES.md names as the ONE fair
// judge of our caustics, shallows-floor-1, measures 1.23-1.97:1 peak-to-shadow
// over five sand-only windows (clipAny 0.006-0.77 %, so none of them railed),
// and LOOK.md's own quoted swatches — peaks #CEB895 over cells #5D5752 — are
// 2.11:1. So the net was carrying more contrast on its own than the whole
// reference image carries in total.
//
// The relation is very close to linear in the shaped net's own spread: at gain g
// the on-screen ratio tracks (1 + 0.62 k)/(1 - 0.31 k) with k = cAmt ~ 0.94 g,
// which puts 2:1 at g ~ 0.92. 0.95 is that, and it is verified rather than
// derived — see the round report for the re-measured ratio.
//
// This does NOT re-open "the seabed has no caustic net". That diagnosis was made
// when the term was core's ADDITIVE one at a median of +1.1 % of local diffuse;
// this one is a mean-neutral multiplier and at 0.95 it still spans 0.7x to 1.6x.
// And the sand's own mid-band contrast comes down with it this round, so the
// net's SHARE of the 0.5-3 m band goes up while its absolute contrast comes
// down — which is exactly what blind pair 014 asked for and what turning the
// gain up could never deliver.
const float CAUS_GAIN = 0.95;

// ============================================================== THE CAUSTIC NET
//
// Sampled here rather than through core's uwCaustics(), and applied as a
// MULTIPLIER on the direct sun rather than as an addition. Both changes are the
// fix for "the seabed at 25 m has no caustic net at all", and neither of the
// obvious suspects was the cause: uCausticsTex is bound (render/underwater.js
// writes it at order 20), uCausticsStrength is 1.0 in safe_shallows,
// applyUnderwater is passed caustics: 0 deliberately because this module
// re-applies the term occluded, and the up-face factor is exactly 1.0 on a flat
// seabed. What was wrong was the amplitude, by a factor of about fifteen.
//
// 1. AMPLITUDE. core's transfer is pow(min(a,b) * 2, 1.6) over a tile whose mean
//    is 0.165 (render/underwater.js TUNE.causticsMean). That tile is heavily
//    right-skewed - median 0.108, 99th percentile at the 0.62 clamp - so min()
//    of two independent layers lands in their shared LOW tail, and the 1.6 power
//    then crushes what survives. Evaluated numerically over the actual wave set,
//    uwCaustics() returns a field with median 0.046 and mean 0.086. Carried
//    through the old depth fade and the old 0.80 coefficient, that arrived on
//    25 m sand as +1.1 % of local diffuse at the median and +4.2 % at the 90th
//    percentile, against LOOK.md section 3's +30-45 %. Only the top 1 % of
//    pixels ever reached +16 %. It was not switched off anywhere; it was too
//    small to see, which on screen is the same thing.
//
// 2. SIGN. An additive term can only brighten, and LOOK.md's own measurement is
//    a 2:1 ratio between the bright loops (#CEB895) and the cell INTERIORS
//    (#5D5752) about a sand mean of #96846E - the interiors are darker than
//    plain lit sand. Caustics do not add light to the seabed, they redistribute
//    the light already falling on it. So the net is mean-neutral: the loops take
//    their brightness out of the cells they enclose, the frame's average
//    luminance does not move (which matters - the shallows colour match is the
//    one thing this module was told not to disturb), and the contrast is real
//    rather than a lift.
float uwCausticNet(vec3 P) {
  // LOOK.md section 3: the pattern is stretched along the swell direction. A
  // 1.28:1 stretch on a fixed bearing, which is also what stops the two layers
  // below from ever agreeing on an axis. It was 1.45:1, which put the long axis
  // of every cell at 2.9 m - outside LOOK.md's 0.5-1.5 m by a factor of two, and
  // a cell that large stops reading as a net and starts reading as a light patch.
  vec2 q = vec2(0.8525 * P.x + 0.5227 * P.z, -0.5227 * P.x + 0.8525 * P.z);
  q.x *= 0.78;
  // 1.20x on top of the shared uCausticsScale. The bound tile (render/underwater.js)
  // carries swell frequencies of 9-15 cycles across the 1/uCausticsScale = 18.2 m
  // it is mapped over, so its folds land at 1.21-2.02 m along the short axis and
  // 1.76-2.93 m along the stretched one. That is the WHOLE of LOOK.md section 3's
  // band and then some, and the coarse half of it was carrying most of the energy.
  // At 1.20x the tile covers 15.2 m, the cells land at 1.01-1.68 m short and
  // 1.30-2.16 m long, and the mode of the distribution sits inside 0.5-1.5 m.
  // NOTE FOR THE NEXT AGENT: uCausticsScale itself is NOT wrong and neither is
  // the tile. See the diagnosis note under uwLight for what actually was.
  vec2 uv = q * (uCausticsScale * 1.20);
  float t = uTime * uCausticsSpeed;
  // TWO SCALES, AVERAGED - not min()ed. The mean of a weighted sum is the
  // weighted sum of the means, so the normalisation below stays exact for
  // whatever tile is bound; min() does not commute with anything and is half of
  // why the shared version came out fifteen times too weak. The second layer is
  // only 1.31x finer now, not 1.45x, and carries 0.36 rather than 0.45: two
  // layers a long way apart in scale sum to mush, two layers close together with
  // the coarse one dominant sum to a CONNECTED net, which is the word LOOK.md
  // uses. The counter-scrolling offsets are what make the net swim and re-form
  // instead of sliding rigidly.
  float a = texture2D(uCausticsTex, uv + vec2(t, t * 0.63)).r;
  vec2 uvB = mat2(0.47422, 1.22092, -1.22092, 0.47422) * uv;
  float b = texture2D(uCausticsTex, uvB + vec2(-t * 0.71, t * 0.52)).r;
  // Normalised by the tile's OWN mean, read from its top mip: one texel, the
  // same texel for every pixel on screen, free. This is what makes the term
  // exactly mean-neutral against whichever module ends up owning
  // U.uCausticsTex, instead of against a constant copied out of another
  // module's tuning table and silently wrong the day that table changes.
  // Clamped, not merely guarded against zero. If the tile ever loses its mip
  // chain this fetch degrades to a single arbitrary texel anywhere in 0.03-0.62,
  // and an unclamped divide by that would swing the whole seabed's brightness
  // by a factor of four. The band is wide enough to track a genuine retune of
  // render/underwater.js's TUNE.causticsMean (0.165 today) and narrow enough
  // that a broken fetch degrades to roughly the right answer instead.
  float mean = clamp(texture2DLodEXT(uCausticsTex, vec2(0.5), 20.0).r, 0.08, 0.34);
  float n = (0.64 * a + 0.36 * b) / mean;

  // ---- SHAPE IT. THIS IS THE ACTUAL ANSWER TO BLIND PAIR 014.
  //
  // A caustic field is 1/|det(I + cH)|, so it has an UNBOUNDED bright tail at the
  // fold lines and a floor at the tile's own low clamp. Replicating
  // render/underwater.js's exact wave set offline and sampling this function over
  // 400k world positions, the value coming out of the line above measures
  //
  //     mean 1.000   p01 0.270   p05 0.330   p50 0.786   p95 2.488   max 3.723
  //
  // — a p95/p05 of 7.5:1, applied to the sun term at unity gain, i.e. about 5:1
  // on the sand. LOOK.md §3 measures the reference at 2:1 (peaks #CEB895 over
  // cells #5D5752), and "blinding white caustics are wrong" is in the same
  // paragraph. So the term was not too weak, as this module's own notes assumed
  // for two rounds: it was carrying two and a half times too much contrast, and
  // ALL of the excess sat in the thin fold spikes. Thin bright spikes over dark
  // cells is the definition of speckle, which is exactly the phrase the blind
  // pair used — "fine speckle at 2.50:1 where the reference has a connected
  // polygonal net at 1.54:1". Turning the gain up (which the previous round did)
  // made the spikes brighter and the cells DARKER, and at gain 1.3 the multiplier
  // went negative in the cell interiors.
  //
  // A soft-knee about the mean fixes both halves at once, because it is exactly
  // the wrong-shaped part of the distribution that it removes: it compresses the
  // spikes hard, barely touches the mid-range where the loop BODIES live, and
  // lifts the floor off zero. Measured over the same 400k samples at k = 1.45:
  //
  //     p05 0.690   p50 0.875   p95 1.539   max 1.621   -> p95/p05 = 2.23:1
  //
  // which is LOOK.md's 2:1 to two significant figures. And because the spikes no
  // longer dominate, the structure the eye locks onto is the 1.0-2.0 m loop
  // rather than the 10 cm filament — the feature size goes UP by the order of
  // magnitude the blind pair asked for WITHOUT changing a single frequency.
  //
  // 1.0459 is 1 / 0.9561, the measured mean of the shaped field: the knee is odd
  // in (n-1) but the input is right-skewed, so shaping alone would have darkened
  // every lit sand pixel in the game by 4.4 %. Renormalising keeps the promise
  // the rest of this block is built on — that the net redistributes light and
  // never adds or removes any.
  n = 1.0 + (n - 1.0) / (1.0 + 1.45 * abs(n - 1.0));
  return n * 1.0459;
}

// Half-lambert: underwater the sun arrives through a diffusing surface and a
// scattering column, so faces turned away from it are dim, never black.
//
// The 0.31 exposure is the load-bearing number. In-scattered shallows fog sits
// at ~0.36 luminance; biomes' sand albedo is 0.59 and its rock 0.20. Sunlit
// sand must land ABOVE that fog value and rock BELOW it, so distant geometry
// converges on the water from both directions (LOOK.md §2) instead of every
// surface being brighter than the fog and the frame flattening to one tone.
vec3 uwLight(vec3 albedo, vec3 N, vec3 P, float ao, float gloss, float sunVisH, float cav) {
  // ---- DYNAMIC SUN OCCLUSION, from core's published occluder list.
  //
  // sunVisH is the BAKED horizon sweep: a heightfield property, exact for reef
  // knolls and the drop-off and blind to everything that moves. The reference
  // shallows-floor plate's subject is the other half - the diver's own shadow
  // and a fish's shadow falling across the caustic net - and until round 33 the
  // engine had no parameter that could carry it. core now publishes up to eight
  // world-space spheres per frame and uwCausticOcclusion() resolves them, so it
  // is multiplied in here, ONCE, and everything downstream that reads sun
  // visibility picks it up: the direct term, the specular lobe, and the caustic
  // net's own amplitude.
  //
  // The net has to take it too, not just the sun. LOOK.md section 3 rules out
  // "caustics painting over shadowed areas" by name, and this module deliberately
  // routes 55 % of the net through the AMBIENT term (forward-scattered sunlight
  // off the same rippled surface), which would otherwise carry a full-strength
  // filament straight across a body shadow.
  float cOcc   = mix(1.0, uwCausticOcclusion(P), uAbl2.y);
  float sunVis = sunVisH * cOcc;
  // Sunlight has already crossed pointDepth metres of water before it lands here.
  // The shared injection in core scales the lit surface by ONE scalar derived
  // from the blue channel, which is right for level but leaves the colour of
  // the downwelling light untouched — so a warm sand albedo (0.72 red) arrives
  // at the eye still warm and the frame measures R=70 against LOOK.md Rule 1's
  // R=0..15. This is the per-channel part of that path, renormalised to the
  // brightest channel so it only tilts the HUE and does not darken the scene a
  // second time. It is what turns lit sand from warm grey into the reference's
  // pale green-teal, and it is what carries the shallows->green->navy ramp of
  // LOOK.md Rule 2 onto the geometry as well as into the water.
  vec3 downT = exp(-uAbsorption * max(0.0, uWaterLevel - P.y) * 0.42);
  downT /= max(max(downT.r, downT.g), max(downT.b, 1e-4));
  float ndl  = max(dot(N, uSunDir), 0.0);
  float wrap = ndl * 0.72 + 0.28 * (dot(N, uSunDir) * 0.5 + 0.5);
  // Shadow depth. Water is a dense forward-scattering medium, so a shadow down
  // here is a 5:1 fall and not the 50:1 of a shadow in air — but 5:1 is still the
  // single largest signal on a seabed, and having NONE of it is what made a
  // stone measure the same luminance as the sand it sits on.
  //
  // The floor said 0.04, which is 25:1 — six times deeper than the comment above
  // it claims and deeper than air-shadow-in-daylight has any right to be under
  // 80 m of scattering water. It is why every face turned from the sun rendered
  // at ambient only, and with the medium off the drop-off mass came back BLACK:
  // its own radiance was a fifth of the in-scattered water in front of it, so
  // whatever texture it carried arrived on screen divided by five. 0.16 is the
  // ~6:1 this was always meant to be, and it is what lets a shaded face converge
  // on the fog colour from below the way LOOK.md §2 requires instead of falling
  // away from it into black.
  // 0.26 is where the REFERENCE puts it. In godrays-1.jpg the nearest rock
  // spire — unlit, backlit, in its own shade — measures median luminance 28
  // against water at 121, a 4.3:1 step. Ours measured 11 against 96, i.e. 8.7:1,
  // twice as dark as the thing Subnautica actually renders, and at luminance 11
  // no amount of surface contrast can produce a readable Laplacian because the
  // sRGB encoding scales absolute contrast with the level it sits on. This is
  // the "distant unlit geometry gets BRIGHTER, not darker" rule (LOOK.md §2)
  // applied to shadow instead of to distance: both converge on the water.
  float sv   = mix(0.26, 1.0, sunVis);
  // ao is *sky* occlusion, so it now weighs mostly on ambient; the directional
  // part of the occlusion is carried properly by sunVis and must not be counted
  // a second time here.
  vec3  sun  = uSunColor * downT * (uSunIntensity * wrap * mix(0.42, 1.0, ao) * sv * 0.45);
  // ao squared, not cubed, at a lower coefficient. Cubing crushed occluded
  // ground (ao 0.7 -> 0.34) while barely touching open ground, so crevices, the
  // foot of the drop-off and the gullies down its face all fell out of the
  // frame's readable range entirely. The pair lifts occluded surfaces ~23 % and
  // trims fully open ones ~14 %: the frame compresses toward the water value
  // from both directions, which is the behaviour LOOK.md §2 measures, instead of
  // the shaded half of every surface simply going away.
  // The sky term is steeper in N.y than a plain hemisphere lerp. Downwelling
  // light underwater is strongly top-heavy — that is the whole reason LOOK.md's
  // vertical gradient exists — so an up-tilted micro-facet really is several
  // times brighter than a down-tilted one. Making the lerp steeper is what lets
  // the perturbed normal say anything at all on a face the sun cannot reach:
  // measured at the drop-off pose the near mass is in cast shadow, so ambient is
  // the ONLY light on it, and with the old 0.5+0.5*N.y ramp every bump on it was
  // worth under 3 % of the pixel.
  float sky  = clamp(N.y * 0.80 + 0.46, 0.0, 1.0);
  vec3  amb  = mix(uAmbBottom, uAmbTop, sky) * (ao * ao * cav) * 0.38;
  vec3  V    = normalize(uCamPos - P);
  vec3  Hv   = normalize(uSunDir + V);
  // GLOSS IS NOT UNIFORM. core/surface.js's headline point is that "a surface
  // uniform in gloss reads as plastic however good its colour is", and a seabed
  // is the clearest case of it: wet bare rock, a dry-looking algal mat and a
  // silt-covered shelf are three different sheens over a metre of ground. One
  // sfBroadband tap — seven octaves at a 1/f roll-off, so it has no
  // characteristic frequency for the eye to lock onto — spreads the sheen from
  // 0.4x to 1.6x over ~0.5 m. It costs one noise call and it is the only part of
  // this fix that adds contrast the water column CANNOT flatten, because a
  // specular lobe is view-dependent and therefore survives being averaged with
  // in-scattered fog. Broadened from 28 to 18 for the same reason the underwater
  // sun is a broad source: a tight lobe on a rough seabed is a glitter, not a
  // sheen, and it aliases.
  float sfGloss = 0.40 + 1.20 * (sfBroadband(P * 1.9) * 0.5 + 0.5);
  float spec = pow(max(dot(N, Hv), 0.0), 22.0) * gloss * sfGloss
             * mix(0.25, 1.0, ao) * sunVis;

  // CAUSTICS ARE SUNLIGHT, so they ride on the sun term and on nothing else.
  // The shared injection in core adds them after the fact and unoccluded, which
  // means a caustic filament paints straight across a stone's contact shadow and
  // across the lee of every ripple — LOOK.md §3 rules that out by name
  // ("caustics do not paint over shadowed areas"). Both of this module's
  // materials therefore opt out (applyUnderwater with caustics: 0) and the term
  // is applied here instead, multiplying the sun term, which already carries
  // sunVis, the ripple lee occlusion and the ao weighting. It is evaluated off the
  // ripple-perturbed normal N, so the net wraps over the relief rather than
  // lying flat on top of it, and off world XZ, which is the correct projection
  // for light arriving straight down: on a steep face the cells stretch
  // vertically exactly as projected light does.
  float pd   = max(0.0, uWaterLevel - P.y);
  float upF  = clamp(N.y * 0.5 + 0.5, 0.0, 1.0); upF *= upF;
  // LOOK.md §3 depth persistence: strong and legible 0-25 m, clearly weaker by
  // 40 m, essentially gone past 60-80 m. The old exp(-pd*0.020) still had a
  // third of its amplitude left at 60 m and a fifth at 80 m, so it never
  // actually went away; a smoothstep reaches zero where the reference does.
  // At 25 m this holds 90 % of full strength, at 40 m 59 %, at 60 m 17 %.
  float cFade = 1.0 - smoothstep(14.0, 78.0, pd);
  // ---- WHY BLIND PAIR 014 SAW "FINE SPECKLE, NO NET", AND WHAT WAS ACTUALLY
  // WRONG. Three suspects were checked and all three are innocent: the tile is
  // a real fold set with cells of the right size (?tdbg=1 draws it alone on flat
  // grey and it is unmistakably a connected polygonal net), uCausticsScale is
  // 0.055 which maps that tile over 18 m, and this material does not override
  // any of it. What was wrong is SIGNAL TO NOISE. Measured on the shallows-floor
  // pose, our floor crop carried a band-limited contrast of 8.3 % of its own
  // mean at the 8-32 px (0.5-3 m) scale where the net lives, against the
  // reference sand crop's 5.1 % — and almost all of ours came from this module's
  // OWN sand albedo (heavy-mineral blotches, trails, broad drifts), which sit in
  // exactly the same band and were roughly 2.5x the net's on-screen amplitude.
  // The net was there the whole time and was simply the second-loudest thing in
  // its own frequency band, which on screen is the same as being absent.
  //
  // So the fix is two-sided and the ALBEDO side is the bigger half: uwSand()
  // above gives up most of its 0.3-3 m mineral contrast, and the net takes the
  // band over. Peak-to-shadow measured on the whole floor crop has to come DOWN
  // (2.06:1 measured against the reference sand's 1.31:1) while the net's share
  // of what is left goes UP.
  //
  // CAUS_GAIN is a MEASURED number, not a taste one, and it is deliberately far
  // above what the surface arithmetic alone would suggest, because most of the
  // amplitude is spent before the pixel reaches the eye. Swept on the
  // shallows-floor pose against an identical build with this term zeroed, the
  // on-screen luminance ratio over near sand came out
  //     gain 0.62 -> p05 0.79  p95 1.25  peak/shadow 1.58
  //     gain 1.30 -> p05 0.60  p95 1.46  peak/shadow 2.43
  // so ~1.2 lands just under LOOK.md §3's "2:1 peak-to-shadow, about +30-45 %
  // over local diffuse", on screen, after the water column and the tonemapper
  // have both taken their cut. Anything tuned to look right in the shader is off
  // by a factor of two by the time it is a pixel.
  float cAmt = CAUS_GAIN * cFade * upF * uCausticsStrength * uUnderwater
             * mix(0.55, 1.0, ao) * cOcc;
  float net  = 1.0 + cAmt * uAbl2.x * (uwCausticNet(P) - 1.0);
  // The fold structure belongs to the direct beam, but underwater the ambient
  // term is itself forward-scattered sunlight off the same rippled surface, so
  // it carries a BLURRED copy of the same pattern rather than none of it. At
  // 25 m on ground the sun only half reaches, the direct term is barely half
  // the surface radiance; netting the sun alone put the whole effect inside
  // that half and the pattern died wherever the ground tilted away. 0.55 rather
  // than 0.34: on a knoll flank — which is most of what the shallows floor shots
  // actually look at — the sun term falls off with the cosine and the net went
  // with it, so the net survived only on dead-level sand. It stays exactly
  // mean-neutral at any share, because the net averages 1.
  return albedo * (sun * net + amb * (1.0 + 0.55 * (net - 1.0)))
       + uSunColor * (spec * uSunIntensity * 0.10);
}
`;

// NOTE: vUwWorldPos / vUwWorldNormal and every medium uniform are declared by
// UNDERWATER_PARS, which applyUnderwater() injects after <common>. We read them
// rather than redeclaring, so this shader only compiles once patched.
const FRAG = /* glsl */ `
#include <common>
uniform float uSunIntensity;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform float uDetailAmt;
uniform float uDbg;
varying vec4 vTerr;
varying vec4 vHorA;
varying vec3 vHorB;
varying vec3 vSand;
varying vec3 vRock;
varying vec3 vGrow;
${NOISE_GLSL}
${LOD_GLSL}
${OCC_GLSL}
${SAND_GLSL}
${LIGHT_GLSL}

// One planar slice of the rock: value in .x, d/du d/dv in .yz, and the part of
// the value that lives above 1 cycle/m in the out parameter.
//
// SEVEN octaves from an 18 m boulder down to a 2 cm pit, each cut off at its own
// Nyquist, each rotated by its own angle, and each BENT by the octave above it.
//
// THE AMPLITUDE STACK IS THE FIX FOR THE FLAT DROP-OFF FACE. It used to fall as
// 0.42/0.24/0.14/0.10/0.07/0.05 — a textbook 1/f spectrum, which puts 84 % of
// its energy at 18 m and 5.8 m and leaves the octaves the eye and the Laplacian
// actually see (2-10 px) carrying under 2 % of albedo. Measured at the drop-off
// pose the near face sits 5 m from the camera at 0.006 m/px, so every one of
// these octaves is live and unclipped — the detail was not being switched off,
// it was never given any amplitude in the first place. Rock photographed close
// up is nearly white-spectrum in albedo; this stack is flat enough to say so.
//
// Their GRADIENT is still deliberately held back — a 16 cycles/m gradient at
// full weight tilts the normal 60 degrees and the surface boils.
vec3 rockPlane(vec2 uv, float mpp, out float fine) {
  vec3 a = nd(uv * 0.055);
  vec3 b = nd(uwBend(uwRot(uv, 1.31) * 0.173, a.x, vec2( 0.34, -0.21)) + 2.7);
  vec3 c = nd(uwBend(uwRot(uv, 0.44) * 0.62,  b.x, vec2(-0.28,  0.36)) + 9.1);
  vec3 d = nd(uwBend(uwRot(uv, 2.55) * 1.90,  c.x, vec2( 0.30,  0.25)) + 4.3);
  vec3 e = nd(uwBend(uwRot(uv, 0.90) * 5.60,  d.x, vec2(-0.33,  0.18)) + 1.9);
  vec3 f = nd(uwBend(uwRot(uv, 2.10) * 16.0,  e.x, vec2( 0.22, -0.31)) + 7.3);
  vec3 g = nd(uwBend(uwRot(uv, 1.62) * 44.0,  f.x, vec2(-0.26,  0.24)) + 3.1);
  // The cutoff runs to 0.30..0.52 cycles/px, not 0.20..0.44. mpp is already the
  // MINOR axis of the footprint, so 0.44 on the minor axis was throwing away the
  // top third of an octave that the sharp screen axis could still resolve — and
  // the Laplacian the critic measures only ever sees 2-4 px structure, which at
  // 8 mm/px (the drop-off pose's actual footprint) means 30-60 cycles/m. Every
  // octave still dies before its own Nyquist at 0.5.
  float w4 = 1.0 - smoothstep(0.30, 0.52, 1.90 * mpp);
  float w5 = 1.0 - smoothstep(0.30, 0.52, 5.60 * mpp);
  float w6 = 1.0 - smoothstep(0.30, 0.52, 16.0 * mpp);
  float w7 = 1.0 - smoothstep(0.30, 0.52, 44.0 * mpp);
  float v = a.x * 0.30 + b.x * 0.21 + c.x * 0.17
          + d.x * 0.15 * w4 + e.x * 0.14 * w5 + f.x * 0.14 * w6 + g.x * 0.13 * w7;
  fine    = d.x * 0.14 * w4 + e.x * 0.16 * w5 + f.x * 0.18 * w6 + g.x * 0.18 * w7;
  vec2  q = a.yz * (0.055 * 0.30) + b.yz * (0.173 * 0.21) + c.yz * (0.62 * 0.17)
          + d.yz * (1.90 * 0.10 * w4) + e.yz * (5.60 * 0.032 * w5)
          + f.yz * (16.0 * 0.013 * w6) + g.yz * (44.0 * 0.0060 * w7);
  return vec3(v, q);
}

void main() {
  vec3  P    = vUwWorldPos;
  vec3  Ng   = normalize(vUwWorldNormal);
  // Detail LOD in SCREEN space and ANISOTROPIC — see LOD_GLSL. mpp is the minor
  // axis of the pixel's footprint on this surface, capped at 1/6 of the major,
  // so a floor seen at a shallow pitch keeps the detail the eye can still
  // resolve across it instead of switching all of it off.
  float mpp = uwFootprint(P);
  float detF  = uDetailAmt * (1.0 - smoothstep(0.55, 2.60, mpp));
  float fineF = uDetailAmt * (1.0 - smoothstep(0.09, 0.46, mpp));
  float depth = max(0.0, -P.y);

  // real cast shadow from the baked horizon profile
  float sunVis = uwSunVis(vHorA, vHorB, uSunDir);

  float ao     = vTerr.x;
  float rockN  = vTerr.y;
  float coralM = vTerr.z;
  float cav    = vTerr.w;

  // variation at three decades so no single tiling frequency ever reads
  float m1 = n1(P.xz * 0.0035);
  float m2 = n1(P.xz * 0.019 + 17.0);
  float m3 = n1(P.xz * 0.11  + 3.0);

  // ------------------------------------------------------------------ sand
  vec2 sandG; float rippleOcc;
  vec3 sandCol = uwSand(P, Ng, vSand, mpp, sandG, rippleOcc);

  // ------------------------------------------------------------------ rock
  vec3 an = abs(Ng);
  vec3 bw = an * an; bw *= bw;
  bw /= (bw.x + bw.y + bw.z + 1e-5);
  float rockBump = 0.0;
  float rockFine = 0.0;
  vec3  rockG = vec3(0.0);
  float fw = 0.0;
  if (bw.x > 0.012) { vec3 rx = rockPlane(P.zy, mpp, fw); rockBump += rx.x * bw.x; rockFine += fw * bw.x; rockG += vec3(0.0, rx.z, rx.y) * bw.x; }
  if (bw.y > 0.012) { vec3 ry = rockPlane(P.xz, mpp, fw); rockBump += ry.x * bw.y; rockFine += fw * bw.y; rockG += vec3(ry.y, 0.0, ry.z) * bw.y; }
  if (bw.z > 0.012) { vec3 rz = rockPlane(P.xy, mpp, fw); rockBump += rz.x * bw.z; rockFine += fw * bw.z; rockG += vec3(rz.y, rz.z, 0.0) * bw.z; }

  // Stratification as BEDS, not as lines. The previous build tinted a single
  // 2.4 m sawtooth, so every bed contact read as one hard bright wire on an
  // otherwise uniform face. A sedimentary sequence is bands of *differing
  // value and grain*: each 3.3 m bed draws its own tone and its own bump
  // amplitude from a per-bed hash, and the contact between two beds is a thin
  // recessed parting line — a boundary between two materials, not a stripe.
  float warpY = n1(P.xz * 0.021) * 1.7 + n1(P.xz * 0.0045) * 5.0;
  // BEDS DIP. Perfectly level bedding draws a set of exactly horizontal lines,
  // and on a rounded reef knoll seen from a low camera those project as long
  // straight bands right across the dome — which reads as a contour artifact,
  // not as rock. A few degrees of regional dip wandering over a couple of
  // hundred metres is both what real sedimentary rock does and what stops the
  // eye from reading them as contours.
  vec2 dipA = vec2(n1(P.xz * 0.0021 + 61.0), n1(P.xz * 0.0021 - 17.0)) * 0.44;
  float bcC = (P.y + dot(P.xz, dipA)) * 0.30;      // the clean, unwarped bed axis
  float bc = bcC + warpY;
  float bi = floor(bc), bf = fract(bc);
  float bedTone  = 0.60 + 0.86 * h11(bi);
  float bedGrain = 0.45 + 1.15 * h11(bi + 37.0);
  // Bed edges are only visible on a face steep enough to cut across them. Let
  // this bleed onto gentle slopes and the bands become contour lines of the
  // terrain height — a chevron moire that reads instantly as a shader bug.
  // 0.92..0.42 rather than 0.86..0.40: the drop-off face measures an.y ~ 0.55-0.7
  // over most of its area (it is a 55 deg wall, not a cliff), so the old window
  // was handing it strataW ~ 0.4 and the beds arrived at 12% contrast — under
  // the water column's own noise floor and therefore invisible.
  // 0.74..0.30 (i.e. only past ~42 deg, full past 73 deg). Wider than that and
  // the beds fire on rounded reef knolls, where a horizontal bed contact
  // projects as a long straight sash right across the dome and reads as a
  // contour artifact rather than as rock. A wall is where bedding belongs.
  float strataW = smoothstep(0.74, 0.30, an.y);
  // the parting itself is a thin hard line, so it is held back further still:
  // on a 25 deg slope a 20 cm parting is half a metre wide on the ground and
  // stops reading as a contact and starts reading as a painted stripe
  float parting = (smoothstep(0.075, 0.0, bf) + smoothstep(0.925, 1.0, bf))
                * smoothstep(0.70, 0.34, an.y);
  // The bed contact is a RECESS: it needs the surface gradient (so it catches a
  // rim of light and throws a line of shade) and an occlusion, not just a dark
  // stripe. Driven by detF, not fineF, so it survives to the far side of the
  // drop-off instead of dying two metres from the camera.
  rockG += vec3(0.0, (cos(bc * 6.2831) * 0.30
                     + (smoothstep(0.10, 0.0, bf) - smoothstep(0.90, 1.0, bf)) * 0.55)
                     * strataW * detF, 0.0);
  // LAMINATION — the near-field half of the same structure. A 3.3 m bed is the
  // right scale for a wall read at 40 m, but at the 5 m the drop-off camera
  // actually stands from rock, ONE bed fills the frame and the face carries no
  // bedding signal at all. Real beds are laminated at 0.2-0.5 m and only resolve
  // once you are close, so this rides the CLEAN bed axis (bc's own metre-scale
  // warp would turn a 0.44 m period into noise) and band-limits itself away
  // before it can alias.
  float lamW = strataW * (1.0 - smoothstep(0.045, 0.16, mpp));
  float lam  = sin((bcC * 7.6 + n1(P.xz * 0.62) * 1.3) * 6.2831);
  rockG += vec3(0.0, lam * 0.50 * lamW, 0.0);

  // biomes' authored rock sits only ~3:1 under its sand. Wet, algae-shadowed
  // reef rock in the reference frames is nearer 4:1, and that extra stop is what
  // survives the water column far enough to still read as a second material.
  // Deep biomes are already near-black in the table, so the darkening tapers
  // off with depth or the Grand Reef spires never converge back up to the fog.
  vec3 rockCol = vRock * mix(0.78, 1.0, smoothstep(120.0, 300.0, depth));
  // 0.46 + 1.02 rather than 0.58 + 0.78: same mean, 31 % more swing. Combined
  // with the flattened octave stack in rockPlane this roughly doubles the albedo
  // modulation the fine octaves deliver, which is the half of the flat-face fix
  // that survives even where there is no directional light at all.
  rockCol *= 0.34 + 1.26 * (rockBump * bedGrain * 0.5 + 0.5);
  rockCol *= 1.0 + 0.30 * lam * lamW;
  rockCol *= mix(1.0, bedTone, strataW);
  rockCol *= 1.0 - 0.55 * parting * strataW;

  // ---- VERTICAL GRAVITY STREAKING ON THE WALL.
  //
  // The drop-off face has measured a Laplacian of 2.05-2.13 across six crops in
  // two consecutive rounds — statistically identical to blank fog — and every
  // previous attempt to fix it added structure the face could not SHOW: a
  // perturbed normal says nothing where the sun does not reach, and this face is
  // in its own shade for most of the day. What survives on an unlit surface is
  // albedo, and the one albedo pattern a 94 m underwater wall genuinely has is
  // the stuff that has run DOWN it: silt trails, biofilm curtains, mineral
  // staining. core/surface.js draws exactly that, and its 6:1 vertical stretch
  // gives it a frequency (metres tall, tens of centimetres wide) that the fog
  // does not average away the moment the wall is 20 m off.
  //
  // Applied at 0.42, an order above what the injected preset alone delivers
  // (which arrives at ~2 % on a 55 deg face, under the water column's own noise
  // floor), and gated on strataW so it costs one broadband tap only on ground
  // steeper than ~42 deg — nothing on the seabed, which is most of every frame.
  // Divided back out by sideFacing so the field is exactly mean-neutral: sfStreak
  // returns raw01 * sideFacing, so on a 55 deg face it would otherwise be a
  // constant darkening with a little variation on top rather than variation.
  if (strataW > 0.02) {
    float sideF   = max(1.0 - abs(Ng.y), 1e-3);
    float streakC = clamp(sfStreak(P, Ng) / sideF, 0.0, 1.0) - 0.5;
    rockCol *= 1.0 + 0.42 * streakC * strataW;
  }

  // LOOK.md §11.25: bare rock reads as unfinished — nearly every surface in the
  // reference is turfed over. Growth follows light: heavy on up-faces in the lit
  // band, gone on overhangs, gone with depth, and it uses the BIOME's accent so
  // kelp ground is olive and bulb-zone ground is acid green.
  float lit = smoothstep(0.15, 0.72, an.y) * (1.0 - smoothstep(90.0, 260.0, depth));
  float turf = lit * smoothstep(-0.35, 0.45, m2 + 0.5 * m3) * ao;
  // growth sits ON the rock, so it keeps some of the rock underneath it —
  // a pure accent wash reads as painted-on decal
  vec3 turfCol = mix(vRock * 0.7, vGrow * 0.55, 0.45 + 0.35 * (m3 * 0.5 + 0.5));
  // Turf gets its own clumping at 0.4-3 m. Without it the growth layer is a flat
  // wash that erases whatever rock detail is underneath — which is most of why a
  // reef knoll at 40 m measured a Laplacian rms of 2.5: it was not the water
  // flattening the rock, it was the moss.
  float tclump = uwOct(P.xz + 1.0, 0.13, 1.72, mpp) * 0.55
               + uwOct(P.xz + 3.0, 0.42, 0.61, mpp) * 0.42
               + uwOct(P.xz - 8.0, 1.30, 1.11, mpp) * 0.30
               + uwOct(P.xz + 5.0, 3.90, 2.35, mpp) * 0.22
               + uwOct(P.xz - 2.0, 11.5, 0.94, mpp) * 0.16;
  turfCol *= 0.52 + 1.24 * (tclump * 0.5 + 0.5);
  rockCol = mix(rockCol, turfCol * (0.60 + 0.40 * (rockBump * 0.5 + 0.5)),
                turf * 0.72 * (0.45 + 0.55 * smoothstep(-0.30, 0.35, tclump)));

  // coral / encrusting crust on shallow reef rock, in the biome accent
  float crust = coralM * smoothstep(0.0, 0.5, an.y * 0.55 + rockBump * 0.6 + 0.25)
              * (1.0 - smoothstep(45.0, 120.0, depth));
  rockCol = mix(rockCol, vGrow * (0.7 + 0.5 * (m3 * 0.5 + 0.5)), crust * 0.7);
  rockCol *= 0.88 + 0.24 * (m1 * 0.5 + 0.5);

  // ------------------------------------------------------------------ blend
  // This decision has to be nearly binary. A soft blend puts every pixel at a
  // 50/50 sand-rock mix, which is another spelling of "no contrast" — the frame
  // then carries nothing the water column cannot erase.
  // Keep the *sand* honest: the outcrop decision used to take +-0.44 of noise on
  // top of the authored rockiness, which turned half of an open sand basin into
  // turfed rock and left the ripples and grain nowhere to appear.
  float rn = rockN + 0.13 * m2 + 0.07 * m3 + 0.06 * n1(P.xz * 0.09);
  float outcrop   = smoothstep(0.34, 0.56, rn);
  float slopeSand = smoothstep(0.58, 0.76, Ng.y + 0.10 * m3);
  float sandMask  = slopeSand * (1.0 - outcrop);

  vec3 albedo = mix(rockCol, sandCol, sandMask);
  vec3 grad   = mix(rockG, vec3(sandG.x, 0.0, sandG.y), sandMask);

  // surface-gradient normal perturbation (correct for any projection)
  vec3 gp = grad - Ng * dot(Ng, grad);
  vec3 N  = normalize(Ng - gp * (1.7 * detF));

  // Cavity occlusion: the tight concavity term baked per vertex, sharpened on
  // rock (crevices between reef knolls, the gullies down the drop-off face) and
  // softened on open sand where there is nothing to trap light. Ambient-only,
  // because a crevice loses the whole sky but keeps whatever sun still reaches
  // straight down it.
  float cavity = mix(mix(1.0, cav, 0.55), cav, 1.0 - sandMask);
  // the parting line between two beds is a real notch and holds its own shade
  cavity *= 1.0 - 0.30 * parting * strataW * (1.0 - sandMask);
  // MICRO-CAVITY — the other half of the flat-face fix, and the half that has to
  // exist because of how the drop-off is lit.
  //
  // A face turned away from the sun keeps almost none of the directional term,
  // so the only light left on it is ambient — and ambient barely depends on the
  // normal. That means the perturbed normal, which is where nearly all of this
  // module's fine rock detail lives, is MUTE on exactly the surface that most
  // needs it. Measured with the medium switched off, the near drop-off mass
  // rendered essentially black: its own radiance was ~20 % of the pixel and the
  // in-scattered water supplied the rest, so any contrast it did carry arrived
  // divided by five.
  //
  // Occlusion does not care which way a surface faces: a pit loses sky whatever
  // its normal. Driving a cavity term off the SAME fine octaves therefore puts
  // pixel-scale structure onto shaded rock, where a bump map cannot, and it
  // reinforces the albedo term rather than fighting it — a hollow in rock really
  // is both darker and more occluded.
  //
  // Shaped through a smoothstep rather than used raw: a cavity field is not
  // symmetric, it is mostly open surface with occasional deep pits, and the
  // shaping is what gives the near field the RANGE it was missing. Measured on
  // the reference (godrays-1.jpg, the closest floor in frame) close geometry
  // spans luminance 0.3 to 50 about a median of 14 and scores a Laplacian of
  // 5.17; ours spanned 4 to 20 about a median of 11 and scored 2.0. Same median,
  // a third of the range — the missing thing is deep small shadows, not light.
  // Both halves are MEAN-NEUTRAL by construction (mo averages 0.5, so the mix
  // averages 1.0). An occlusion term that also dims the surface on average just
  // trades the contrast it adds back against a lower luminance to carry it on,
  // and the first attempt at this darkened the near mass 20 % and netted nothing.
  float mo = clamp(0.5 + 1.35 * rockFine, 0.0, 1.0);
  mo = mo * mo * (3.0 - 2.0 * mo);
  cavity *= mix(1.0, mix(0.40, 1.60, mo), 1.0 - sandMask);
  // ripple lee shadow: an occlusion, so it belongs on the light, not the albedo
  float sVis = sunVis * mix(1.0, rippleOcc, sandMask);
  float aoUse = ao * mix(1.0, 0.62 + 0.38 * rippleOcc, sandMask);
  // a pit is shaded from the sun as well as from the sky, but far less — the sun
  // is one direction and reaches down most of them, so this side of it is held
  // to a third of the ambient response
  aoUse *= mix(1.0, mix(0.76, 1.24, mo), 1.0 - sandMask);

  vec3 outC = uwLight(albedo, N, P, aoUse, 0.16 - 0.09 * sandMask, sVis, cavity);

  // ---- DEBUG VIEWS (?tdbg=N). Whenever uDbg is non-zero init() also zeroes
  // this material's uMatFogScale and uMatDepthResponse, so what these draw is
  // the surface's own signal with the entire water column removed. A previous
  // critic built a headline conclusion on a bypass flag that silently did
  // nothing, so each of these is deliberately loud: mode 1 replaces the frame
  // with grey, and if the frame is not grey the switch did not take.
  if (uDbg > 0.5) {
    float pdD = max(0.0, uWaterLevel - P.y);
    float upD = clamp(N.y * 0.5 + 0.5, 0.0, 1.0); upD *= upD;
    // uwCausticOcclusion() is in here for the same reason CAUS_GAIN is shared:
    // a debug view that draws the net UNoccluded while the shaded path draws it
    // occluded is a quietly-wrong instrument, and this module has already been
    // bitten once by exactly that (the old hardcoded 0.62 gain).
    float amtD = CAUS_GAIN * (1.0 - smoothstep(14.0, 78.0, pdD)) * upD
               * uCausticsStrength * mix(0.55, 1.0, aoUse) * uwCausticOcclusion(P);
    if (uDbg < 1.5) {
      // 1 — the caustic net alone on flat mid-grey, at the exact gain the
      //     shaded frame uses. Grey 0.25 in, so 1.0 reads back as 0.25.
      //     It really is the same constant now: it used to be hardcoded 0.62
      //     against a shaded path running at 1.00, so this view understated the
      //     effect by 40 % and any conclusion drawn from it was off.
      outC = vec3(0.25) * (1.0 + amtD * (uwCausticNet(P) - 1.0));
    } else if (uDbg < 2.5) {
      // 2 — the ALBEDO detail term alone: what the procedural texture does to
      //     the flat per-vertex palette colour, centred on mid-grey. Anything
      //     that is not 0.25 here is surface texture the medium is free to
      //     erase later; a flat card here means there was never anything to
      //     erase. This is the drop-off face question, asked directly.
      vec3 baseC = mix(vRock, vSand, sandMask);
      outC = vec3(0.25) * (albedo / max(baseC, vec3(1e-3)));
    } else if (uDbg < 3.5) {
      // 3 — the NORMAL perturbation alone, as its own lambert term against the
      //     sun, centred on mid-grey. This is the half of the detail that dies
      //     on a face the sun cannot reach.
      outC = vec3(0.25) * (1.0 + 4.0 * dot(N - Ng, uSunDir));
    } else if (uDbg < 4.5) {
      // 4 — the occlusion channels: sun visibility (baked horizon sweep TIMES
      //     the published dynamic occluders, which is what the shaded path
      //     actually uses), sky ao, cavity.
      outC = vec3(sunVis * uwCausticOcclusion(P), ao, cav) * 0.5;
    } else {
      // 5 — OWNERSHIP. Flat magenta, no shading, no medium: every pixel this
      //     module draws and nothing else. It exists because settling "is that
      //     white slab in the cave terrain or is it somebody else's?" took an
      //     afternoon of raycasts and half-working ?nostruct switches, and the
      //     answer should cost one capture. Anything NOT magenta under ?tdbg5
      //     is not terrain.
      outC = vec3(1.0, 0.0, 0.85);
    }
  }
  gl_FragColor = vec4(outC, 1.0);
}
`;

/**
 * Caustics for the shared medium. render/underwater.js owns U.uCausticsTex; we
 * only fill it if nobody has, so the seabed still gets its light net while that
 * module is a stub. Built from integer-frequency waves so it tiles with no seam;
 * LOOK.md §3 wants a connected polygonal net of 0.5-1.5 m cells at ~2:1
 * peak-to-shadow, which at uCausticsScale 0.055 (an 18 m tile) means integer
 * frequencies around 10-22.
 */
function ensureCaustics() {
  if (U.uCausticsTex.value) return false;
  const N = 256;
  const data = new Uint8Array(N * N);
  const rng = makeRNG(51423);
  const waves = [];
  for (let i = 0; i < 6; i++) {
    waves.push({
      a: rng.sign() * rng.int(9, 21), b: rng.sign() * rng.int(9, 21),
      p: rng() * Math.PI * 2, m: 0.6 + rng() * 0.7,
    });
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      let f = 0, norm = 0;
      for (const w of waves) {
        f += w.m * Math.sin(2 * Math.PI * (w.a * u + w.b * v) + w.p);
        norm += w.m;
      }
      f /= norm;
      // the zero set of the wave sum is a curved connected web
      const c = Math.pow(clamp01(1 - Math.abs(f) / 0.60), 1.8);
      const mod = 0.6 + 0.4 * Math.sin(2 * Math.PI * (2 * u + v) + 1.1)
                          * Math.sin(2 * Math.PI * (u - 2 * v) - 0.4);
      data[j * N + i] = Math.round(clamp01(c * mod * 0.40 + 0.10) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // A 1 m caustic cell is ~2 px at 50 m and viewed at a grazing angle from a
  // low camera; without anisotropy the two counter-scrolling layers beat against
  // the pixel grid into a chevron moire across the whole mid-ground.
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  U.uCausticsTex.value = tex;
  return true;
}

/**
 * Debug view selector, shared by both of this module's materials. 0 is the game;
 * see the DEBUG VIEWS block in FRAG for what each mode draws. Driven from
 * ?tdbg=N in init(), which also switches this module's fog and depth response
 * off so a debug frame carries no medium at all.
 */
const uDbg = { value: 0 };

function makeMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uSunIntensity: U.uSunIntensity,
      uAmbTop: U.uAmbientTop,
      uAmbBottom: U.uAmbientBottom,
      uAbl, uAbl2,
      uDetailAmt: { value: 1.0 },
      uDbg,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
  });
  m.name = 'terrain';
  // caustics: 0 — this material applies them itself, occluded (see uwLight).
  //
  // SURFACE MICROSTRUCTURE, and why the amplitudes are UNDER the `rock`/`sand`
  // presets rather than at them. core/surface.js exists because most of the game
  // "reads as moulded vinyl": one flat colour with painted line art. The seabed
  // has the opposite problem — measured, our floor carried 1.65x the reference
  // sand's band-limited contrast — so taking the rock preset's grain 0.14 whole
  // would push the exact number this round is trying to bring down. What this
  // module actually wants from core is the two things its own noise stack cannot
  // do:
  //   - WEAR, which is a function of the world-space normal and so keeps saying
  //     something on a face the sun never reaches (the drop-off), where a
  //     perturbed normal is mute;
  //   - STREAK, vertical gravity streaking on near-vertical faces. That is the
  //     one structure a 94 m wall has that a heightfield derivative cannot
  //     invent, and it runs at a frequency the fog does not erase. It is held
  //     highest of the three for exactly that reason.
  // Grain is set to a third of the preset because seven octaves at 1/f is
  // broadband by construction and lands on top of a stack that is already
  // measured at reference level in its finest band. scale 2.4 m sits between the
  // presets' rock 3.5 and sand 1.4 — one material draws both here.
  // grain 0.050 -> 0.105. The round-7 critique measured the wired-in
  // microstructure at 1.12:1 on sand and 1.01:1 on the drop-off rock - i.e.
  // inaudible on both, which is the one thing a broadband term must never be.
  // 0.050 was set when the amplitude was believed to be coarse-dominated; core
  // has since rebuilt sfBroadband to walk octaves DOWNWARD from the fragment's
  // own footprint at flat amplitude, so it no longer competes with this module's
  // 0.3-3 m layers for the same band and the reason for the discount is gone.
  // Still under the rock preset's 0.14 because the ROCK's own seven-octave
  // stack is already near-flat; what it lacks is something that survives past
  // its per-octave Nyquist, and 0.105 is that and nothing more.
  applyUnderwater(m, {
    caustics: 0,
    surface: { grain: 0.105, wear: 0.30, streak: 0.36, scale: 2.4 },
  });
  return m;
}

// ============================================================== COBBLE FIELD
/**
 * The 0.2-3 m stone population.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT IN THE HEIGHTFIELD.
 * The finest quadtree leaf is 64 m at res 64, so the heightfield's Nyquist limit
 * is 2 m: it physically cannot carry anything smaller. Without a separate
 * population there is therefore no geometry at all between 0.3 m and 7 m, which
 * means nothing in a player-height frame has a knowable size and the entire
 * floor smears into one evenly-lit slab. `shallows-floor-2.jpg` is the proof of
 * the other direction: it is dense with 0.2-1 m cobbles casting soft contact
 * shadows into the ripples, and that population is the only reason the reference
 * floor has a scale.
 *
 * TWO THINGS MATTER MORE THAN THE STONES THEMSELVES.
 *  1. Bedding. LOOK.md rejects "geometry that meets the sand at a hard
 *     intersection line". So a cobble is not a sphere pushed into the ground: it
 *     is a dome whose profile is y = (1-u^3)^1.35, which has *zero height and
 *     zero slope* at its rim. It therefore lands flush on the tangent plane no
 *     matter how it is scaled — there is no intersection line to see.
 *  2. The contact shadow. Every stone carries a flat apron ring past its rim,
 *     shaded by the SAME uwSand() the seabed uses (so it is invisible as
 *     geometry) times an occlusion ramp offset away from the sun. That is what
 *     gives the horizon-sweep AO something to darken and what makes the ripples
 *     read as a surface rather than as a pattern.
 *
 * Instancing is hand-rolled (InstancedBufferGeometry + a quaternion attribute on
 * a plain Mesh) rather than InstancedMesh, because core's applyUnderwater()
 * writes vUwWorldPos from modelMatrix*transformed and knows nothing about
 * instanceMatrix — every stone would take the fog of the group origin. Folding
 * the instance transform into `transformed` before <project_vertex> keeps the
 * shared medium exactly correct, which is the whole point of the injection.
 */
const COB_VERT = /* glsl */ `
#include <common>
attribute vec3 aIPos;
attribute vec4 aIQuat;
attribute vec4 aIScale;       // xyz scale, w the seabed's own baked AO here
attribute vec4 aISand;        // rgb ground sand colour, w the seabed rockiness
attribute vec3 aIRock;
attribute vec3 aIOcc;         // x seabed sun visibility  y instance hash  z seabed cavity
attribute vec2 aCob;          // x: apron t (<0 on the stone itself)   y: rim u
varying vec2 vCob;
varying vec3 vCen;
varying vec4 vSandC;
varying vec3 vRockC;
varying vec3 vLocal;
varying vec3 vShadow;         // xy local-space shadow shift, z stone aspect
varying vec3 vOcc;
varying float vGao;

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 qrotInv(vec4 q, vec3 v) { return qrot(vec4(-q.xyz, q.w), v); }

void main() {
  vCob = aCob; vCen = aIPos; vSandC = aISand; vRockC = aIRock; vGao = aIScale.w;
  vOcc = aIOcc;
  vLocal = position;
  // The sun brought into the stone's OWN frame. Local space is the only space
  // where every stone is a unit dome standing on a unit annulus, so one
  // expression for the contact shadow serves a 0.15 m pebble and a 2 m boulder
  // identically, and it stays correct on sloping ground because the stone's
  // frame is already aligned to the seabed normal.
  vec3 Sl = qrotInv(aIQuat, uSunDir);
  float sxz = length(Sl.xz);
  vec2 sdirL = sxz > 1e-4 ? Sl.xz / sxz : vec2(0.0, 1.0);
  float rad = max(0.5 * (aIScale.x + aIScale.z), 1e-4);
  float aspect = aIScale.y / rad;
  // displacement of the dome's apex shadow: height / tan(elevation), in radii
  vShadow = vec3(-sdirL * min(aspect * sxz / max(Sl.y, 0.20), 2.6), aspect);
  vec3 objectNormal = normalize(qrot(aIQuat, normal / max(aIScale.xyz, vec3(1e-3))));
  vec3 transformed  = qrot(aIQuat, position * aIScale.xyz) + aIPos;
  #include <project_vertex>
  // ---- CORE INTERACTION BUG, worked around here; see coreBugs in the report.
  // applyUnderwater() injects its vUwWorldNormal write immediately after
  // <project_vertex>, and it chooses between objectNormal and the raw 'normal'
  // attribute by testing whether the vertex source contains the literal string
  // '#include <beginnormal_vertex>'. A hand-rolled instanced ShaderMaterial like
  // this one never contains that string, so it silently took the RAW dome normal
  // — no per-instance quaternion, no inverse scale. Every cobble in the game was
  // therefore lit as if it had never been spun or squashed: the crown's bright
  // side pointed in a random direction per stone, and the apron's up-normal was
  // world up rather than the seabed's. Our own write here runs after the
  // injected block and puts it right. (The position is already the full
  // instance transform, so vUwWorldPos was correct all along — only the normal
  // was wrong, which is exactly why it survived so many rounds.)
  vUwWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
}
`;

const COB_FRAG = /* glsl */ `
#include <common>
uniform float uSunIntensity;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform float uDbg;
varying vec2 vCob;
varying vec3 vCen;
varying vec4 vSandC;
varying vec3 vRockC;
varying vec3 vLocal;
varying vec3 vShadow;
varying vec3 vOcc;
varying float vGao;
${NOISE_GLSL}
${LOD_GLSL}
${SAND_GLSL}
${LIGHT_GLSL}

void main() {
  vec3 P  = vUwWorldPos;
  vec3 Ng = normalize(vUwWorldNormal);
  float mpp = uwFootprint(P);
  float fineF = 1.0 - smoothstep(0.09, 0.46, mpp);
  float detF  = 1.0 - smoothstep(0.55, 2.60, mpp);
  vec3 albedo; vec3 N; float ao; float gloss; float sVis; float cav;

  // ---- THE CONTACT SHADOW, in local radii.
  // A dome lit from elevation e casts the swept union of its own outline and that
  // outline displaced by h/tan(e) — a capsule, not a symmetric ring, and the
  // asymmetry is what tells the eye where the light is. This is the single
  // largest piece of signal on a real seabed photograph: without it a stone
  // measures the same luminance as the sand it is lying on, which is precisely
  // what was measured off this module (stone 119.2, sand 112-125).
  vec2 pq = vLocal.xz;
  vec2 sv2 = vShadow.xy;
  float tcap = clamp(dot(pq, sv2) / max(dot(sv2, sv2), 1e-5), 0.0, 1.0);
  float dCap = length(pq - sv2 * tcap);
  // hard dark core AT the contact line (dCap = 1 is the stone's own outline),
  // releasing over ~0.5 radii — about 0.3 m under a typical 0.6 m stone
  float umbra = 1.0 - smoothstep(0.88, 1.50, dCap);
  // ...plus the wider bowl of lost sky the stone digs around itself. Keyed to
  // the APRON parameter, not to a radius, so it reaches exactly zero exactly
  // where the geometry ends: any occlusion still alive at the last triangle is
  // a visible disc edge, and any patch of apron that is *brighter* than the
  // seabed is the pale halo that made every stone look pasted on.
  float aprT = max(vCob.x, 0.0);
  float bowl  = (1.0 - aprT) * (1.0 - aprT);

  if (vCob.x >= 0.0) {
    // ---- contact apron: this IS the seabed's sand, shaded by the same
    // function, so the only thing that distinguishes it is the shadow.
    // Where the ground under a stone is rock rather than sand, the apron has to
    // follow it — painting sand on a rock face rings every boulder with a
    // bright halo, which is worse than having no contact shadow at all. So the
    // apron re-derives the seabed's OWN sand/rock decision from the same world
    // position, the same noise and the same thresholds the terrain shader uses,
    // with the authored rockiness carried in on vSandC.w. Anything less exact
    // and the boundary lands in a different place for the apron than for the
    // ground it is lying on, which is a visible plate however subtle the shade.
    float m2 = n1(P.xz * 0.019 + 17.0);
    float m3 = n1(P.xz * 0.11 + 3.0);
    float rn = vSandC.w + 0.13 * m2 + 0.07 * m3 + 0.06 * n1(P.xz * 0.09);
    float sandM = smoothstep(0.58, 0.76, Ng.y + 0.10 * m3) * (1.0 - smoothstep(0.34, 0.56, rn));
    vec2 g; float rocc;
    // Erring DARK on the rock side. The apron cannot reproduce the terrain
    // shader's strata, turf and triplanar rock, so wherever it does land on rock
    // the residual mismatch has to read as extra occlusion and never as a pale
    // plate — a bright disc around a stone is the single most visible way for
    // this whole contact-shadow scheme to fail.
    albedo = mix(vRockC * 0.95, uwSand(P, Ng, vSandC.rgb, mpp, g, rocc), sandM);
    vec3 grad = vec3(g.x, 0.0, g.y) * sandM;
    vec3 gp = grad - Ng * dot(Ng, grad);
    N = normalize(Ng - gp * (1.7 * detF));
    // Forced to nothing before the geometric rim. Without this the anti-sun side
    // of the apron is still in shadow when the triangles run out and every stone
    // gets a hard polygonal collar — a far worse artifact than no shadow at all.
    // It also makes overlapping aprons invisible to each other: where two aprons
    // cross, both are unshadowed sand shaded by the same uwSand() at the same
    // world position, so whichever wins the depth test draws the same pixel.
    float edgeFade = 1.0 - smoothstep(0.55, 0.95, aprT);
    // a contact shadow is a close-range detail; past a metre or so per pixel it
    // is only a ring of aliasing, so it dissolves back into plain ground
    float near = 1.0 - smoothstep(0.34, 1.15, mpp);
    float sh = umbra * near * edgeFade;
    // vOcc.x is the seabed's own cast-shadow state here: a stone standing in the
    // shade of a reef knoll must not paint a lit apron under itself.
    // 0.96, not 0.90: uwLight's shadow floor was raised from 25:1 to 6:1 (which
    // is what an underwater shadow actually is), and this apron is the one place
    // in the module that was relying on the old floor. Taking the last 6 % of the
    // sun out here keeps the umbra at the same measured ~2:1 against open sand
    // that a critic verified, without re-deepening every other shadow in frame.
    sVis = vOcc.x * rocc * (1.0 - 0.98 * sh);
    // vGao and vOcc.z are the seabed's OWN sky occlusion and cavity at this
    // spot, computed by the same horizon sweep and the same curvature radius the
    // chunk builder uses. Approximating them with a constant is what made every
    // apron a pale plate: the terrain around it was sitting at ao 0.86 under its
    // own horizon while the apron was flat 0.93, and a 7% bright disc around
    // every stone reads as a halo long before it reads as a number.
    // the umbra is a loss of SKY as well as of sun — it is the patch of ground
    // the stone is standing on — so it darkens the ambient too, or the shadow
    // bottoms out at whatever the ambient happens to be and reads as a smudge
    // The sh coefficients carry more of the umbra than they used to (0.34 -> 0.46
    // and 0.46 -> 0.60). uwLight's shadow floor is now 0.26 rather than 0.04, so
    // the sun-side of this shadow can no longer go as deep on its own; moving the
    // difference onto the ambient side keeps the contact shadow at the measured
    // -50% against open sand that a critic verified, and it is the more correct
    // place for it anyway — the umbra under a stone is mostly lost SKY.
    ao  = vGao * (1.0 - 0.50 * bowl * near - 0.46 * sh);
    cav = (1.0 - 0.55 * (1.0 - vOcc.z)) * (1.0 - 0.44 * bowl * near - 0.60 * sh);
    gloss = 0.05;
  } else {
    // ---- the stone. Texture is in LOCAL space so it does not swim, offset by a
    // per-instance hash so a field of stones is not a field of clones, and the
    // rim darkens because a half-buried stone is shadowed by its own socket.
    // The stone's texture lives in LOCAL space (so it does not swim as the
    // stone is scaled or spun), which means its band limit has to be measured
    // there too: dFdx of the local position IS the pixel footprint in units of
    // the stone's own radius, so a 0.15 m pebble and a 2 m boulder each get the
    // octaves they can actually resolve rather than one world-space guess.
    vec3 llx = dFdx(vLocal), lly = dFdy(vLocal);
    float la = length(llx), lb = length(lly);
    float lmpp = max(min(la, lb), max(la, lb) / 4.0);
    float sd = vOcc.y * 37.0;
    float b0 = n1(vLocal.xz * 1.15 + sd);                   // 2-3 blotches per stone
    float b1 = n1(vLocal.xz * 5.5 + vLocal.y * 3.0 + sd) * (1.0 - smoothstep(0.20, 0.44, 5.5 * lmpp));
    float b2 = n1(vLocal.zy * 13.0 + 4.0 + sd) * (1.0 - smoothstep(0.20, 0.44, 13.0 * lmpp));
    float b3 = n1(vLocal.xy * 31.0 + 9.0 + sd) * (1.0 - smoothstep(0.20, 0.44, 31.0 * lmpp));
    float b4 = n1(vLocal.zx * 74.0 + 17.0 + sd) * (1.0 - smoothstep(0.20, 0.44, 74.0 * lmpp));
    float bump = b1 * 0.38 + b2 * 0.24 + b3 * 0.14 + b4 * 0.08 + b0 * 0.16;
    // per-instance value AND a coarse mottle: overhead, an unmottled dome is a
    // flat disc however well it is lit, because a sphere's lambert term barely
    // moves across the top 60% of its own silhouette
    albedo = vRockC * (0.60 + 0.76 * (bump * 0.5 + 0.5)) * (0.84 + 0.32 * (b0 * 0.5 + 0.5));
    // A pale wash of encrusting algae, on the CROWN only. Keyed to the rim
    // parameter rather than to Ng.y, because on a tilted stone an up-facing
    // brightener lights exactly the outline and draws the bright hairline round
    // every stone that the brief calls out as a hard intersection line inverted.
    albedo *= 1.0 + 0.30 * (1.0 - smoothstep(0.20, 0.80, vCob.y)) * (0.5 + 0.5 * b2);
    N = Ng;
    // the lower flank of a bedded stone sits in its own socket and in its own
    // shadow — this is the dark rim the crown falls off to. 0.72 rather than
    // 0.62 for the same reason the apron went to 0.96: the shared shadow floor
    // in uwLight is shallower now, so the socket has to take a little more.
    sVis = vOcc.x * (1.0 - 0.72 * smoothstep(0.52, 1.0, vCob.y));
    ao  = vGao * mix(0.26, 1.0, smoothstep(0.99, 0.28, vCob.y));
    cav = 1.0;
    gloss = 0.20;
  }
  vec3 outC = uwLight(albedo, N, P, ao, gloss, sVis, cav);
  // The stones follow the seabed's debug views so a contact shadow and the sand
  // it is cast onto are never measured under different rules (see FRAG).
  if (uDbg > 0.5) {
    float upD = clamp(N.y * 0.5 + 0.5, 0.0, 1.0); upD *= upD;
    float amtD = CAUS_GAIN * (1.0 - smoothstep(14.0, 78.0, max(0.0, uWaterLevel - P.y)))
               * upD * uCausticsStrength * mix(0.55, 1.0, ao) * uwCausticOcclusion(P);
    if (uDbg < 1.5)      outC = vec3(0.25) * (1.0 + amtD * (uwCausticNet(P) - 1.0));
    else if (uDbg < 2.5) outC = vec3(0.25) * (albedo / max(vRockC, vec3(1e-3)));
    else if (uDbg < 3.5) outC = vec3(0.25) * (1.0 + 4.0 * dot(N - Ng, uSunDir));
    else if (uDbg < 4.5) outC = vec3(sVis * uwCausticOcclusion(P), ao, cav) * 0.5;
    else                 outC = vec3(1.0, 0.0, 0.85);          // 5 — ownership
  }
  gl_FragColor = vec4(outC, 1.0);
}
`;

/**
 * A bedded stone: dome of revolution y = (1-u^3)^1.35 over radius u, plus a flat
 * apron out to `apron`. Zero slope at u=1 is what makes it sit *in* the sand.
 */
function makeStoneGeo(seed, rings, lon, apron, aprRings, lumpAmp) {
  const rng = makeRNG(seed);
  const waves = [];
  for (let i = 0; i < 4; i++) {
    waves.push({ kt: 1 + i + (rng() < 0.5 ? 0 : 1), ku: 0.7 + rng() * 2.4, p: rng() * 6.283, a: (rng() * 2 - 1) });
  }
  const lump = (th, u) => {
    let s = 0;
    for (const w of waves) s += w.a * Math.sin(w.kt * th + w.ku * u + w.p);
    return s / waves.length;
  };

  const pos = [], nor = [], cob = [], idx = [];
  const push = (x, y, z, ap, u) => { pos.push(x, y, z); nor.push(0, 0, 0); cob.push(ap, u); };
  // one azimuthal outline shared by the stone's rim and by its apron, so the
  // two agree exactly and the joint is invisible while the outline is not a
  // circle — a field of perfect discs is its own kind of tell
  const rimR = (th) => 1 + 0.26 * lump(th, 4.0);

  push(0, 1, 0, -1, 0);                                    // pole
  const domeRows = [];
  for (let k = 1; k <= rings; k++) {
    const u = k / rings;
    const row = [];
    for (let j = 0; j < lon; j++) {
      const th = (j / lon) * Math.PI * 2;
      const L = lump(th, u * 3.0) * lumpAmp * (1.0 - u * u * u);
      const r = u * (1 + 0.30 * L) * (1 + (rimR(th) - 1) * u * u);
      // (1-u^2)^1.15 rather than (1-u^3)^1.35. Both hold zero slope at the rim
      // (which is what beds the stone into the sand with no intersection line),
      // but the cubic one holds its crown FLAT over the inner 60% of the radius,
      // and a flat crown under a 60 deg sun is a uniform disc however good the
      // material is. This profile is already at 25 deg of tilt by mid-radius, so
      // the dome reads as a dome: bright crown, shoulder falling away, dark rim.
      const y = Math.pow(Math.max(0, 1 - u * u), 1.15) * (1 + 0.30 * L);
      row.push(pos.length / 3);
      push(Math.cos(th) * r, Math.max(y, 0), Math.sin(th) * r, -1, u);
    }
    domeRows.push(row);
  }
  // duplicated rim so the stone/sand normal break is hard, as it is in life.
  // The apron sinks slightly as it goes out so its outer edge finishes BELOW the
  // seabed and is clipped by it: the stone is lifted a couple of centimetres to
  // keep the shadow visible, and without the taper that lift would show as a
  // floating plate edge at grazing angles.
  const aprRows = [];
  for (let a = 0; a <= aprRings; a++) {
    const t = a / aprRings;
    const rr = 1 + (apron - 1) * t;
    const row = [];
    for (let j = 0; j < lon; j++) {
      const th = (j / lon) * Math.PI * 2;
      row.push(pos.length / 3);
      const r = rr * rimR(th);
      // flat out to 45% of the apron, then diving hard: the stone is lifted a
      // few centimetres so its contact shadow is not z-fought away, and if the
      // apron's outer rim finishes at that same height it grazes the seabed and
      // the intersection draws a hard polygonal line round every stone — the
      // exact artifact LOOK.md forbids. Diving under the ground buries the
      // crossing inside the apron, where both surfaces shade identically.
      const t2 = Math.max(0, (t - 0.45) / 0.55);
      push(Math.cos(th) * r, -0.95 * t2 * t2, Math.sin(th) * r, t, 1);
    }
    aprRows.push(row);
  }

  for (let j = 0; j < lon; j++) idx.push(0, domeRows[0][(j + 1) % lon], domeRows[0][j]);
  for (let k = 0; k < rings - 1; k++) {
    const a = domeRows[k], b = domeRows[k + 1];
    for (let j = 0; j < lon; j++) {
      const j2 = (j + 1) % lon;
      idx.push(a[j], b[j2], b[j], a[j], a[j2], b[j2]);
    }
  }
  for (let k = 0; k < aprRings; k++) {
    const a = aprRows[k], b = aprRows[k + 1];
    for (let j = 0; j < lon; j++) {
      const j2 = (j + 1) % lon;
      idx.push(a[j], b[j2], b[j], a[j], a[j2], b[j2]);
    }
  }

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aCob', new THREE.Float32BufferAttribute(cob, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the apron is sand: force it dead flat so it shades exactly like the seabed
  const n = g.getAttribute('normal');
  for (const row of aprRows) for (const v of row) n.setXYZ(v, 0, 1, 0);
  n.needsUpdate = true;
  return g;
}

// Two grids. Small stones only matter within ~36 m (a 0.3 m stone is 6 px at
// 36 m at 720p); boulders stay legible to ~110 m and are what keeps the
// mid-ground from being empty once the cobbles have faded out.
// lon 12/14 was the reason every boulder in a 1080p frame read as a flat
// hexagon with a lit polygon edge; at 20/26 the silhouette is a curve and the
// crown shades as a dome. We have ~500 fps and 130 draw calls of headroom, so
// this is the cheapest quality per unit of budget anywhere in the module.
const COB_TIERS = [
  { cell: 16, radius: 40, per: 300, max: 2600, small: 0.14, large: 0.54, rings: 5, lon: 20, apron: 1.95, aprRings: 3, lump: 0.42 },
  { cell: 44, radius: 78, per: 26, max: 340, small: 0.50, large: 1.60, rings: 8, lon: 26, apron: 1.85, aprRings: 3, lump: 0.46 },
];

// Sun-visibility march for a single point, in metres. Same idea as the per-vertex
// horizon sweep in buildGeometry but for one direction only: a cobble needs to
// know whether it is standing in the shade of the reef knoll behind it, and
// nothing else. Baked when the cell is generated, so it follows the sun at the
// resolution the cobble cache is rebuilt at rather than per frame.
// Same radii as AO_RADII below (declared separately because that constant lives
// in the chunk-builder section and would be in its temporal dead zone here).
const SUN_MARCH = [1.5, 3, 6, 10, 16];
/**
 * The seabed's own shading state at one point, on exactly the terms
 * buildGeometry bakes into the mesh: the sun visibility from a horizon march
 * along the sun's bearing, the sky occlusion from the same 8-direction sweep,
 * and the 3 m cavity curvature. The cobble apron has to reproduce the ground it
 * is lying on to within a couple of percent — anything more and the apron reads
 * as a plate rather than as the sand it is pretending to be — and the only way
 * to be that close is to run the same computation rather than approximate it.
 * ~40 height taps; paid once per cell, cached, and budgeted.
 */
function groundShadeAt(x, z, h, ao, out) {
  const S = U.uSunDir.value;
  const sl = Math.hypot(S.x, S.z);
  const sdx = sl > 1e-4 ? S.x / sl : 0, sdz = sl > 1e-4 ? S.z / sl : 0;
  let occ2 = 0, sunT = 0;
  for (let d = 0; d < 8; d++) {
    const dx = AO_DIRS[d][0], dz = AO_DIRS[d][1];
    const dl = (dx && dz) ? 0.70710678 : 1;      // unit-length step direction
    let mt = 0;
    for (let i = 0; i < SUN_MARCH.length; i++) {
      const r = SUN_MARCH[i];
      const t = (heightAt(x + dx * dl * r, z + dz * dl * r) - h) / r;
      if (t > mt) mt = t;
    }
    occ2 += (mt * mt) / (1 + mt * mt);
  }
  for (let i = 0; i < SUN_MARCH.length; i++) {
    const r = SUN_MARCH[i];
    const t = (heightAt(x + sdx * r, z + sdz * r) - h) / r;
    if (t > sunT) sunT = t;
  }
  const hs = sunT / Math.sqrt(1 + sunT * sunT);
  out.sun = sl < 1e-4 ? 1 : clamp01((S.y - hs + 0.05) / 0.23);
  const c3 = h - 0.25 * (heightAt(x + 3, z) + heightAt(x - 3, z)
                       + heightAt(x, z + 3) + heightAt(x, z - 3));
  out.cav = clamp(1 + (c3 / 3) * 1.35, 0.30, 1.0);
  out.ao = clamp(ao * Math.pow(clamp01(1 - occ2 * 0.125), 1.25), 0.05, 1.0);
  return out;
}
const _gs = { sun: 1, cav: 1, ao: 1 };

const _cobQ = new THREE.Quaternion();
const _cobQ2 = new THREE.Quaternion();
const _cobUp = new THREE.Vector3();
const _cobY = new THREE.Vector3(0, 1, 0);
const _cobPal = new Float32Array(9);

function cellStones(tier, ci, cj) {
  const rng = makeRNG((ci * 73856093) ^ (cj * 19349663) ^ (tier.cell * 83492791));
  const out = [];
  const x0 = ci * tier.cell, z0 = cj * tier.cell;
  for (let i = 0; i < tier.per; i++) {
    const x = x0 + rng() * tier.cell, z = z0 + rng() * tier.cell;
    // drifts: stones pile in lanes and leave the flats bare, exactly as in
    // shallows-floor-2 where a dense band of cobble runs across bare sand
    const drift = gn(x * 0.041 + 12.7, z * 0.041 - 5.5) * 0.62
                + gn(x * 0.0105 - 3.1, z * 0.0105 + 8.8);
    if (rng() > sstep(-0.62, 0.55, drift)) continue;
    const s = sampleAt(x, z, _sb);
    if (s.h < -520) continue;                         // nothing to light down there
    normalAt(x, z, _cobUp);
    if (_cobUp.y < 0.62) continue;                    // stones roll off steep ground
    // how sandy the seabed is here, on the same terms the terrain shader uses,
    // so the apron can shade as whatever it is actually lying on
    // CLEARLY sandy, with margin. The terrain shader decides sand-vs-rock with
    // `smoothstep(0.34, 0.56, rockiness + 0.26 of noise)`, so ground at rockiness
    // 0.3 can render as either depending on which side of the noise a given pixel
    // falls. A stone bedded there paints its apron as sand over rock — a bright
    // plate round the stone, and measurably so: the shaded side of a cobble read
    // 4.6% BRIGHTER than open ground on exactly those patches. Requiring
    // rockiness under ~0.12 keeps the apron over ground the shader also calls
    // sand, whatever the noise does, and it is also where cobbles belong.
    const sandy = clamp01((1 - sstep(0.26, 0.50, s.rock)) * sstep(0.58, 0.78, _cobUp.y));
    if (sandy < 0.60) continue;                       // outcrops carry their own
    const u = rng();
    const size = tier.small + (tier.large - tier.small) * u * u * (u < 0.90 ? 1 : 1.35);
    floorPaletteAt(x, z, _cobPal);
    // Stones are the rock of the place but distinctly DARKER than the sand they
    // lie on — in the reference shallows floor they read as near-black shapes on
    // pale sand, and that 4:1 albedo step is the only contrast the water column
    // cannot erase at close range. A tenth of them are pale so the field is
    // never one flat value.
    const pale = rng() < 0.11 ? 2.3 : 1.0;
    const v = (0.26 + 0.34 * rng()) * pale;
    // The apron has to sit at the same occlusion as the seabed triangles it is
    // lying on, or it is a pale plate — an apron a shade too dark disappears, an
    // apron a shade too bright outlines every stone in the field. So run the
    // chunk builder's own horizon sweep, curvature and sun march right here.
    const ce = 1.4;
    const cN = s.h - 0.25 * (heightAt(x + ce, z) + heightAt(x - ce, z)
                           + heightAt(x, z + ce) + heightAt(x, z - ce));
    groundShadeAt(x, z, s.h, s.ao, _gs);
    const gao = _gs.ao * (1 - clamp(-(cN / ce) * 1.6, 0, 0.26));
    out.push({
      // lifted a couple of centimetres so the contact shadow is never z-fought
      // away by the seabed triangle it is lying on; the apron's outward taper
      // hides the lift by finishing below ground level.
      x, y: s.h + 0.022 + 0.030 * size, z,
      nx: _cobUp.x, ny: _cobUp.y, nz: _cobUp.z,
      // 0.22-0.58 of its own width was a pebble pressed flat: a dome that low
      // has a normal within 12 deg of straight up across its whole crown, which
      // is a uniform disc under any light. Half-buried cobbles read at 0.34-0.78.
      size, ry: size * (0.34 + 0.44 * rng()),
      sun: _gs.sun, cav: _gs.cav, hash: rng(),
      ex: 0.76 + 0.50 * rng(), spin: rng() * 6.283,
      // Only a whisker of tilt. The apron is rigidly attached to the stone, so
      // any tilt lifts one side of a flat plate off ground it is meant to be
      // lying flush against, and it reads as a paving slab.
      tilt: (rng() * 2 - 1) * 0.045, tiltA: rng() * 6.283, rockN: s.rock, gao,
      sr: _cobPal[0], sg: _cobPal[1], sb: _cobPal[2],
      rr: _cobPal[3] * v, rg: _cobPal[4] * v * 1.02, rb: _cobPal[5] * v * 1.06,
    });
  }
  return out;
}

class CobbleTier {
  constructor(tier) {
    this.t = tier;
    this.cells = new Map();
    this.geo = makeStoneGeo(4400 + tier.cell, tier.rings, tier.lon, tier.apron, tier.aprRings, tier.lump);
    const N = tier.max;
    this.aPos = new Float32Array(N * 3);
    this.aQuat = new Float32Array(N * 4);
    this.aScale = new Float32Array(N * 4);
    this.aSand = new Float32Array(N * 4);
    this.aRock = new Float32Array(N * 3);
    this.aOcc = new Float32Array(N * 3);
    const add = (name, arr, n) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      return a;
    };
    this.bPos = add('aIPos', this.aPos, 3);
    this.bQuat = add('aIQuat', this.aQuat, 4);
    this.bScale = add('aIScale', this.aScale, 4);
    this.bSand = add('aISand', this.aSand, 4);
    this.bRock = add('aIRock', this.aRock, 3);
    this.bOcc = add('aIOcc', this.aOcc, 3);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(this.geo, null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `terrain:cobbles${tier.cell}`;
    // Opt out of core's game-wide shadow pass, and ONLY here. The instancing is
    // hand-rolled (the transform is folded into `transformed` in our own vertex
    // shader so applyUnderwater's vUwWorldPos stays exact), and three.js renders
    // shadow casters with its own MeshDepthMaterial, whose stock vertex shader
    // has never heard of aIPos/aIQuat/aIScale. Every instance would therefore be
    // drawn at the group origin in the shadow map: 2600 copies of one dome
    // stacked at world (0,0,0), throwing a phantom shadow blob over the spawn
    // basin for every module that does receive shadows. The stones' own contact
    // shadows are computed analytically above, at a resolution no 2048 map
    // covering 320 m could reach anyway.
    this.mesh.userData.noShadow = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.count = 0;
  }

  /** Build any missing cells in range; returns ms spent. */
  prime(cx, cz, budgetMs) {
    const t0 = performance.now();
    const t = this.t;
    const c0 = Math.floor((cx - t.radius) / t.cell), c1 = Math.floor((cx + t.radius) / t.cell);
    const d0 = Math.floor((cz - t.radius) / t.cell), d1 = Math.floor((cz + t.radius) / t.cell);
    for (let j = d0; j <= d1; j++) {
      for (let i = c0; i <= c1; i++) {
        const k = i * 65536 + j;
        if (this.cells.has(k)) continue;
        this.cells.set(k, cellStones(t, i, j));
        if (performance.now() - t0 > budgetMs) return -1;    // more to do
      }
    }
    if (this.cells.size > 900) {
      // drop the cells we are furthest from; cheap and rare
      const keep = new Map();
      for (const [k, v] of this.cells) {
        const i = Math.floor(k / 65536), j = k - i * 65536;
        if (Math.abs(i * t.cell - cx) < t.radius * 3 && Math.abs(j * t.cell - cz) < t.radius * 3) keep.set(k, v);
      }
      this.cells = keep;
    }
    return performance.now() - t0;
  }

  refresh(cx, cz) {
    const t = this.t;
    let n = 0;
    const c0 = Math.floor((cx - t.radius) / t.cell), c1 = Math.floor((cx + t.radius) / t.cell);
    const d0 = Math.floor((cz - t.radius) / t.cell), d1 = Math.floor((cz + t.radius) / t.cell);
    // nearest cell first: if the instance budget runs out it has to run out at
    // the far edge of the field, never under the player's own feet
    const order = this._order || (this._order = []);
    order.length = 0;
    for (let j = d0; j <= d1; j++) {
      for (let i = c0; i <= c1; i++) {
        const dx = (i + 0.5) * t.cell - cx, dz = (j + 0.5) * t.cell - cz;
        order.push(dx * dx + dz * dz, i, j);
      }
    }
    const cellN = order.length / 3;
    const perm = this._perm || (this._perm = []);
    perm.length = cellN;
    for (let k = 0; k < cellN; k++) perm[k] = k;
    perm.sort((a, b) => order[a * 3] - order[b * 3]);

    for (let p = 0; p < cellN && n < t.max; p++) {
      {
        const i = order[perm[p] * 3 + 1], j = order[perm[p] * 3 + 2];
        const list = this.cells.get(i * 65536 + j);
        if (!list) continue;
        for (let q = 0; q < list.length && n < t.max; q++) {
          const s = list[q];
          const dx = s.x - cx, dz = s.z - cz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          // cull radius scales with size: a stone is dropped once it is below
          // ~6 px, so the budget is spent where the eye can still resolve it
          const cull = Math.min(t.radius, 12 + 62 * s.size);
          if (dist > cull) continue;
          // and it shrinks away over the last 5 m rather than popping
          const fade = clamp01((cull - dist) / 5);
          if (fade <= 0.02) continue;

          _cobUp.set(s.nx, s.ny, s.nz);
          if (s.tilt) {
            _cobUp.x += Math.cos(s.tiltA) * s.tilt;
            _cobUp.z += Math.sin(s.tiltA) * s.tilt;
            _cobUp.normalize();
          }
          _cobQ.setFromUnitVectors(_cobY, _cobUp);
          _cobQ2.setFromAxisAngle(_cobY, s.spin);
          _cobQ.multiply(_cobQ2);

          const o3 = n * 3;
          this.aPos[o3] = s.x; this.aPos[o3 + 1] = s.y; this.aPos[o3 + 2] = s.z;
          this.aRock[o3] = s.rr; this.aRock[o3 + 1] = s.rg; this.aRock[o3 + 2] = s.rb;
          const o4 = n * 4;
          this.aScale[o4] = s.size * s.ex * fade;
          this.aScale[o4 + 1] = s.ry * fade;
          this.aScale[o4 + 2] = s.size / s.ex * fade;
          this.aScale[o4 + 3] = s.gao;
          this.aSand[o4] = s.sr; this.aSand[o4 + 1] = s.sg;
          this.aSand[o4 + 2] = s.sb; this.aSand[o4 + 3] = s.rockN;
          this.aQuat[o4] = _cobQ.x; this.aQuat[o4 + 1] = _cobQ.y;
          this.aQuat[o4 + 2] = _cobQ.z; this.aQuat[o4 + 3] = _cobQ.w;
          const o2b = n * 3;
          this.aOcc[o2b] = s.sun; this.aOcc[o2b + 1] = s.hash;
          this.aOcc[o2b + 2] = s.cav;
          n++;
        }
      }
    }
    this.count = n;
    this.geo.instanceCount = n;
    this.bPos.needsUpdate = this.bQuat.needsUpdate = this.bScale.needsUpdate = true;
    this.bSand.needsUpdate = this.bRock.needsUpdate = this.bOcc.needsUpdate = true;
  }
}

function makeCobbleMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uSunIntensity: U.uSunIntensity,
      uAmbTop: U.uAmbientTop,
      uAmbBottom: U.uAmbientBottom,
      uAbl, uAbl2,
      uDbg,
    },
    vertexShader: COB_VERT,
    fragmentShader: COB_FRAG,
    side: THREE.FrontSide,
    // the apron is coplanar with the seabed by construction; nudge it toward
    // the eye so it wins the depth test instead of dithering against the sand
    // Units only, NO slope factor: a slope-scaled offset explodes where a dome
    // turns tangent to the view, which pulled a hairline of apron sand in front
    // of every stone's silhouette and outlined the whole field in white.
    polygonOffset: true,
    polygonOffsetFactor: 0.0,
    polygonOffsetUnits: -4.0,
  });
  m.name = 'terrain-cobbles';
  // Same reasoning as the seabed material, at a stone's own scale: 0.9 m rather
  // than 2.4, because a 0.4 m cobble under a 2.4 m grain field is one flat value
  // and the whole population comes out as clones of a single tone. Almost no
  // streak — a cobble is a rounded lump, it has no near-vertical face for rust
  // and biofilm to run down.
  applyUnderwater(m, {
    caustics: 0,
    surface: { grain: 0.055, wear: 0.34, streak: 0.08, scale: 0.9 },
  });
  return m;
}

// ============================================================== chunk builder
const LEAF = 64;                 // finest chunk edge, metres
// Split a node when the camera is within size*K. K sets both the LOD transition
// distance (LEAF*K = 93 m, already past the shallows' 40-60 m usable visibility)
// and the leaf count, which grows as ~9.4*K^2 per level — K=2.25 costs 300
// chunks for transitions nobody can see.
const SPLIT_K = 1.45;
const MARGIN = 16;               // extra grid ring for seamless normals + horizon AO
// Horizon sweep: 8 compass directions IN AZIMUTH ORDER (atan2(dz,dx) = k*45 deg),
// which is what lets the result be packed as a Fourier series in azimuth below.
// Curvature alone only finds the centimetre dish a vertex sits in; what actually
// darkens a Subnautica frame is a rock face standing between the sand and the
// sky — and what casts a *shadow* is that face standing between the sand and the
// sun, which needs a real horizon search out to tens of metres.
const AO_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// radii in METRES, converted to cells per chunk, so the occlusion a surface gets
// does not change when its LOD does
// Capped at MARGIN metres so the reach is the SAME in metres at every LOD (16 m
// at the 1 m leaf, 16 m at the 2 m tier, ~21 m at the coarsest). Occlusion that
// changes with LOD draws a hard line along every chunk boundary.
const AO_RADII = [1.5, 3, 6, 10, 16];
// cos(n*az) / sin(n*az) at the 8 sweep azimuths, n = 1..3. Three harmonics
// resolve an occluder down to ~60 deg of azimuth, which is about the angular
// softness of the sun seen from under a rippling surface anyway.
const HARM = (() => {
  const c = [[], [], []], s = [[], [], []];
  for (let n = 1; n <= 3; n++) {
    for (let k = 0; k < 8; k++) {
      const a = (n * k * Math.PI) / 4;
      c[n - 1][k] = Math.cos(a); s[n - 1][k] = Math.sin(a);
    }
  }
  return { c, s };
})();
const _hsin = new Float64Array(8);

// Cell size by tier: 1 / 2 / 4.6 / 10.7 / 32-64 m. The mid tiers matter more
// than they look — a 20 m reef ridge at 150 m sampled on a 5 m grid turns into a
// faceted triangle on the skyline, which LOOK.md §11.23 calls out by name. We
// have ~2000 fps of headroom at 68 draw calls, so spend it here.
function resFor(size) {
  if (size <= 128) return 64;
  if (size <= 256) return 56;
  if (size <= 512) return 48;
  return 32;
}

const _sb = SAMPLE_PROTO();
const _pal = new Float32Array(9);

function buildGeometry(x0, z0, size) {
  const res = resFor(size);
  const cell = size / res;
  const G = res + 1 + MARGIN * 2;
  const hh = new Float32Array(G * G);
  const aa = new Float32Array(G * G);
  const rk = new Float32Array(G * G);
  const co = new Float32Array(G * G);

  for (let j = 0; j < G; j++) {
    const wz = z0 + (j - MARGIN) * cell;
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      sampleAt(x0 + (i - MARGIN) * cell, wz, _sb);
      hh[k] = _sb.h; aa[k] = _sb.ao; rk[k] = _sb.rock; co[k] = _sb.coral;
    }
  }

  const n = res + 1;
  const vCount = n * n + 4 * n;              // grid + four skirt strips
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const ter = new Float32Array(vCount * 4);
  const horA = new Float32Array(vCount * 4);
  const horB = new Float32Array(vCount * 3);
  const sndA = new Float32Array(vCount * 3);
  const rckA = new Float32Array(vCount * 3);
  const grwA = new Float32Array(vCount * 3);
  const inv2c = 1 / (2 * cell);
  const aoK = [...new Set(AO_RADII.map((m) => clamp(Math.round(m / cell), 1, MARGIN)))];
  const cavK = clamp(Math.round(3.0 / cell), 1, MARGIN);

  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < n; j++) {
    const wz = z0 + j * cell;
    for (let i = 0; i < n; i++) {
      const gi = (j + MARGIN) * G + (i + MARGIN);
      const h = hh[gi];
      const vi = j * n + i;
      pos[vi * 3] = i * cell; pos[vi * 3 + 1] = h; pos[vi * 3 + 2] = j * cell;
      if (h < minY) minY = h; if (h > maxY) maxY = h;

      const nx = -(hh[gi + 1] - hh[gi - 1]) * inv2c;
      const nz = -(hh[gi + G] - hh[gi - G]) * inv2c;
      const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nor[vi * 3] = nx * il; nor[vi * 3 + 1] = il; nor[vi * 3 + 2] = nz * il;

      // Horizon sweep: for each of 8 azimuths take the steepest rise within
      // reach and convert it to the SINE of that horizon's elevation. The mean
      // of sin^2 is the cosine-weighted fraction of sky the point has lost (the
      // AO); the full 8-vector, packed as a Fourier series, is what the shader
      // compares against the sun's own elevation to get a real cast shadow.
      let occ2 = 0;
      for (let dI = 0; dI < 8; dI++) {
        const dx = AO_DIRS[dI][0], dz = AO_DIRS[dI][1];
        const off = dz * G + dx;
        const dl = (dx && dz) ? 1.41421356 : 1;
        let mt = 0;
        for (let sI = 0; sI < aoK.length; sI++) {
          const k = aoK[sI];
          const t = (hh[gi + off * k] - h) / (k * cell * dl);
          if (t > mt) mt = t;
        }
        const sn = mt / Math.sqrt(1 + mt * mt);
        _hsin[dI] = sn;
        occ2 += sn * sn;
      }
      let f0 = 0, fc1 = 0, fs1 = 0, fc2 = 0, fs2 = 0, fc3 = 0, fs3 = 0;
      for (let k = 0; k < 8; k++) {
        const v = _hsin[k];
        f0 += v;
        fc1 += v * HARM.c[0][k]; fs1 += v * HARM.s[0][k];
        fc2 += v * HARM.c[1][k]; fs2 += v * HARM.s[1][k];
        fc3 += v * HARM.c[2][k]; fs3 += v * HARM.s[2][k];
      }
      horA[vi * 4] = f0 * 0.125;
      horA[vi * 4 + 1] = fc1 * 0.25; horA[vi * 4 + 2] = fs1 * 0.25;
      horA[vi * 4 + 3] = fc2 * 0.25;
      horB[vi * 3] = fs2 * 0.25;
      horB[vi * 3 + 1] = fc3 * 0.25; horB[vi * 3 + 2] = fs3 * 0.25;

      const aoH = Math.pow(clamp01(1 - occ2 * 0.125), 1.25);
      // plus a tight curvature term for the dish a vertex sits in
      const cN = h - 0.25 * (hh[gi + 1] + hh[gi - 1] + hh[gi + G] + hh[gi - G]);
      const aoC = 1 - clamp(-(cN / cell) * 1.6, 0, 0.26);
      // ...and a 3 m cavity term, which is the scale of the crevices BETWEEN reef
      // knolls and of the gullies down the drop-off face. The horizon sweep can
      // only see what stands above the local plane; a concavity two metres wide
      // and one deep hides its own floor from the whole sky and the sweep barely
      // registers it, so it is measured directly as curvature instead.
      const cW = h - 0.25 * (hh[gi + cavK] + hh[gi - cavK]
                           + hh[gi + G * cavK] + hh[gi - G * cavK]);
      ter[vi * 4] = clamp(aa[gi] * aoH * aoC, 0.05, 1.0);
      ter[vi * 4 + 1] = rk[gi];
      ter[vi * 4 + 2] = co[gi];
      ter[vi * 4 + 3] = clamp(1 + (cW / (cavK * cell)) * 1.35, 0.30, 1.0);

      floorPaletteAt(x0 + i * cell, wz, _pal);
      sndA[vi * 3] = _pal[0]; sndA[vi * 3 + 1] = _pal[1]; sndA[vi * 3 + 2] = _pal[2];
      rckA[vi * 3] = _pal[3]; rckA[vi * 3 + 1] = _pal[4]; rckA[vi * 3 + 2] = _pal[5];
      grwA[vi * 3] = _pal[6]; grwA[vi * 3 + 1] = _pal[7]; grwA[vi * 3 + 2] = _pal[8];
    }
  }

  // ---- skirts. Cheaper and more robust than stitching, and every LOD seam is
  // well past the biome's usable visibility anyway.
  // Skirt depth has to scale with the LOCAL slope, not just with the cell size.
  // The skirt is raked inward by a fraction of a cell so it hides under the
  // surface it patches — but on a 70 deg flank, moving a quarter cell inward is
  // already most of a cell DOWN, so a fixed 2.2 m drop leaves the skirt quad
  // lying almost flat just under the surface and it pokes out as a long straight
  // shelf along every chunk edge. Reef knolls now reach 40 m over a 30 m radius,
  // so this is no longer a corner case.
  const drop0 = Math.max(1.4, cell * 2.2);
  const TUCK = 0.25;
  let maxDrop = drop0;
  const edges = [
    { base: n * n + 0 * n, get: (t) => t, ix: 0, iz: 1 },                   // j = 0    (-Z)
    { base: n * n + 1 * n, get: (t) => (n - 1) * n + t, ix: 0, iz: -1 },    // j = res  (+Z)
    { base: n * n + 2 * n, get: (t) => t * n, ix: 1, iz: 0 },               // i = 0    (-X)
    { base: n * n + 3 * n, get: (t) => t * n + (n - 1), ix: -1, iz: 0 },    // i = res  (+X)
  ];
  for (const e of edges) {
    for (let t = 0; t < n; t++) {
      const src = e.get(t), dst = e.base + t;
      // Tuck the skirt INWARD as well as down. A dead-vertical curtain hanging
      // off the chunk edge shows up as a hard faceted shard the moment the
      // camera drops to or below the terrain surface; raked back under the
      // chunk it stays hidden by the surface it is patching.
      const sy = nor[src * 3 + 1];
      const slope = Math.hypot(nor[src * 3], nor[src * 3 + 2]) / Math.max(sy, 0.08);
      const drop = Math.max(drop0, cell * (0.6 + 3.2 * slope));
      if (drop > maxDrop) maxDrop = drop;
      pos[dst * 3] = pos[src * 3] + e.ix * cell * TUCK;
      pos[dst * 3 + 1] = pos[src * 3 + 1] - drop;
      pos[dst * 3 + 2] = pos[src * 3 + 2] + e.iz * cell * TUCK;
      for (let k = 0; k < 3; k++) {
        nor[dst * 3 + k] = nor[src * 3 + k];
        sndA[dst * 3 + k] = sndA[src * 3 + k];
        rckA[dst * 3 + k] = rckA[src * 3 + k];
        grwA[dst * 3 + k] = grwA[src * 3 + k];
      }
      for (let k = 0; k < 4; k++) horA[dst * 4 + k] = horA[src * 4 + k];
      for (let k = 0; k < 3; k++) horB[dst * 3 + k] = horB[src * 3 + k];
      ter[dst * 4] = ter[src * 4] * 0.7; ter[dst * 4 + 1] = ter[src * 4 + 1];
      ter[dst * 4 + 2] = 0; ter[dst * 4 + 3] = ter[src * 4 + 3] * 0.8;
    }
  }

  const triCount = res * res * 2 + res * 8;
  const idx = vCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let p = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }
  const E = edges;
  for (let t = 0; t < res; t++) {
    let e0 = E[0].get(t), e1 = E[0].get(t + 1), s0 = E[0].base + t, s1 = E[0].base + t + 1;
    idx[p++] = e0; idx[p++] = e1; idx[p++] = s0;          // -Z, outward -Z
    idx[p++] = e1; idx[p++] = s1; idx[p++] = s0;
    e0 = E[1].get(t); e1 = E[1].get(t + 1); s0 = E[1].base + t; s1 = E[1].base + t + 1;
    idx[p++] = e0; idx[p++] = s0; idx[p++] = e1;          // +Z, outward +Z
    idx[p++] = e1; idx[p++] = s0; idx[p++] = s1;
    e0 = E[2].get(t); e1 = E[2].get(t + 1); s0 = E[2].base + t; s1 = E[2].base + t + 1;
    idx[p++] = e0; idx[p++] = s0; idx[p++] = e1;          // -X, outward -X
    idx[p++] = e1; idx[p++] = s0; idx[p++] = s1;
    e0 = E[3].get(t); e1 = E[3].get(t + 1); s0 = E[3].base + t; s1 = E[3].base + t + 1;
    idx[p++] = e0; idx[p++] = e1; idx[p++] = s0;          // +X, outward +X
    idx[p++] = e1; idx[p++] = s1; idx[p++] = s0;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aTerr', new THREE.BufferAttribute(ter, 4));
  g.setAttribute('aHorA', new THREE.BufferAttribute(horA, 4));
  g.setAttribute('aHorB', new THREE.BufferAttribute(horB, 3));
  g.setAttribute('aSand', new THREE.BufferAttribute(sndA, 3));
  g.setAttribute('aRock', new THREE.BufferAttribute(rckA, 3));
  g.setAttribute('aGrow', new THREE.BufferAttribute(grwA, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const hs = size * 0.5;
  const cy = (minY + maxY) * 0.5;
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(hs, cy, hs),
    Math.sqrt(hs * hs * 2 + Math.pow((maxY - minY) * 0.5 + maxDrop, 2)),
  );
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, minY - maxDrop, 0),
    new THREE.Vector3(size, maxY, size),
  );
  return g;
}

// ============================================================== streaming
const HALF = WORLD.worldSize / 2;
const chunks = new Map();
const pending = [];
const pendingKeys = new Set();
let desired = new Map();
let group = null;
let material = null;
let cobMaterial = null;
let cobTiers = [];
let lastCobX = Infinity, lastCobZ = Infinity;
let frameNo = 0;

const key = (s, x, z) => `${s}|${x}|${z}`;

function collectLeaves(cx, cz, out) {
  out.length = 0;
  const stack = [-HALF, -HALF, WORLD.worldSize];
  while (stack.length) {
    const s = stack.pop(), z = stack.pop(), x = stack.pop();
    const dx = Math.max(x - cx, 0, cx - (x + s));
    const dz = Math.max(z - cz, 0, cz - (z + s));
    if (s > LEAF && Math.sqrt(dx * dx + dz * dz) < s * SPLIT_K) {
      const h = s * 0.5;
      stack.push(x, z, h, x + h, z, h, x, z + h, h, x + h, z + h, h);
    } else {
      out.push(x, z, s);
    }
  }
}

const _leaves = [];

function refresh(cx, cz) {
  collectLeaves(cx, cz, _leaves);
  const next = new Map();
  for (let i = 0; i < _leaves.length; i += 3) {
    const x = _leaves[i], z = _leaves[i + 1], s = _leaves[i + 2];
    const k = key(s, x, z);
    const c = chunks.get(k);
    next.set(k, { x, z, s, k, chunk: c || null });
    if (c) { c.used = frameNo; continue; }
    if (pendingKeys.has(k)) continue;
    const dx = x + s * 0.5 - cx, dz = z + s * 0.5 - cz;
    pending.push({ x, z, s, k, d: dx * dx + dz * dz });
    pendingKeys.add(k);
  }
  desired = next;

  for (let i = pending.length - 1; i >= 0; i--) {
    if (!desired.has(pending[i].k)) { pendingKeys.delete(pending[i].k); pending.splice(i, 1); }
  }
  pending.sort((a, b) => b.d - a.d);   // nearest last: pop() takes the closest
}

function buildOne(job) {
  const mesh = new THREE.Mesh(buildGeometry(job.x, job.z, job.s), material);
  mesh.position.set(job.x, 0, job.z);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = `terrain:${job.k}`;
  group.add(mesh);
  const c = { mesh, x: job.x, z: job.z, size: job.s, used: frameNo, k: job.k };
  chunks.set(job.k, c);
  const d = desired.get(job.k);
  if (d) d.chunk = c;
  return c;
}

function drain(budgetMs) {
  const t0 = performance.now();
  let built = 0;
  while (pending.length) {
    const job = pending.pop();
    pendingKeys.delete(job.k);
    if (!desired.has(job.k)) continue;
    buildOne(job);
    built++;
    if (performance.now() - t0 > budgetMs) break;
  }
  return built;
}

/**
 * A chunk stays on screen until whatever is meant to replace it has actually
 * been built, so streaming never punches a hole in the seabed.
 */
const _blocking = new Set();
function updateVisibility() {
  _blocking.clear();
  for (const d of desired.values()) {
    if (d.chunk) continue;
    let s = d.s, x = d.x, z = d.z;
    while (s < WORLD.worldSize) {
      s *= 2; x = Math.floor(x / s) * s; z = Math.floor(z / s) * s;
      _blocking.add(key(s, x, z));
    }
  }
  for (const c of chunks.values()) {
    let vis;
    if (desired.has(c.k)) vis = true;
    else if (_blocking.has(c.k)) vis = true;
    else {
      vis = false;
      let s = c.size, x = c.x, z = c.z;
      while (s < WORLD.worldSize) {
        s *= 2; x = Math.floor(x / s) * s; z = Math.floor(z / s) * s;
        const d = desired.get(key(s, x, z));
        if (d) { vis = !d.chunk; break; }
      }
    }
    c.mesh.visible = vis;
    if (vis) c.used = frameNo;
  }
}

const MAX_CACHED = 190;
function evict() {
  if (chunks.size <= MAX_CACHED) return;
  const list = [...chunks.values()].filter((c) => !desired.has(c.k) && !c.mesh.visible);
  list.sort((a, b) => a.used - b.used);
  const drop = Math.min(list.length, chunks.size - MAX_CACHED);
  for (let i = 0; i < drop; i++) {
    const c = list[i];
    group.remove(c.mesh);
    c.mesh.geometry.dispose();
    chunks.delete(c.k);
  }
}

// ============================================================== module
let lastCx = Infinity, lastCz = Infinity;

export default {
  id: 'terrain',
  heightAt, normalAt, biomeAt, sampleAt, slopeAt, depthAt, raycast, floorPaletteAt,

  /**
   * Measurement hook: the cobble instances currently uploaded, in world space.
   * Exists so a capture script can project a known stone to screen and read the
   * luminance of the sand on its sunward and its shaded side — the one number
   * that says whether the contact shadow is actually there. Cheap and read-only.
   */
  debugStones() {
    const out = [];
    for (const ct of cobTiers) {
      for (let i = 0; i < ct.count; i++) {
        out.push({
          x: ct.aPos[i * 3], y: ct.aPos[i * 3 + 1], z: ct.aPos[i * 3 + 2],
          r: ct.aScale[i * 4], h: ct.aScale[i * 4 + 1],
        });
      }
    }
    return out;
  },

  async init(ctx) {
    group = new THREE.Group();
    group.name = 'terrain';
    ctx.scene.add(group);

    // ---- take the world's colour and layout from world/biomes.js if it exists.
    // Guarded: a stub leaves us on the built-in fallback tables.
    try {
      const B = ctx.get('biomes');
      const list = B?.list?.();
      if (Array.isArray(list) && list.length) {
        const sites = [], pal = {};
        for (const b of list) {
          const t = b.terrain;
          if (t?.sand && t?.rock && t?.accent) {
            pal[b.id] = [
              t.sand.r, t.sand.g, t.sand.b,
              t.rock.r, t.rock.g, t.rock.b,
              t.accent.r, t.accent.g, t.accent.b,
            ];
          }
          if (b.interior || !Array.isArray(b.sites)) continue;
          for (const s of b.sites) sites.push({ id: b.id, x: s.x, z: s.z, r: s.r, f: s.f });
        }
        if (sites.length) SITES = sites;
        if (Object.keys(pal).length) PALETTES = { ...FALLBACK_PAL, ...pal };
        this.usingBiomePalettes = true;
      }
    } catch { /* biomes is a stub or a different shape: our fallbacks stand */ }

    buildPaletteLattice();
    this.filledCaustics = ensureCaustics();
    material = makeMaterial();
    cobMaterial = makeCobbleMaterial();

    // ---- debug views. ?tdbg=1..4, see the DEBUG VIEWS block in FRAG.
    // The medium is switched off through the per-material uniforms
    // applyUnderwater() hands back, so a debug frame is this module's own
    // radiance and nothing else — no fog, no depth darkening. `this.debug` is
    // published so a caller can assert the switch actually took rather than
    // arguing from a flag that silently did nothing.
    // Accepts ?tdbg=2 AND the valueless ?tdbg2, because tools/capture.mjs
    // truncates --params at the SECOND '=': its arg parser does
    // `a.replace(/^--/,'').split('=')` and destructures only [k, v], so
    // --params="tdbg=1" arrives as the bare key `tdbg` with no value and every
    // module knob reached that way silently does nothing. (That is the same
    // failure the brief warns about, and it also breaks --params="novm=1".)
    let dbg = 0;
    for (const [k, v] of (ctx.params || [])) {
      const m = /^tdbg(\d)?$/.exec(k);
      if (m) dbg = Number(v) || Number(m[1]) || 1;
    }
    uDbg.value = Number.isFinite(dbg) ? dbg : 0;

    // ---- ablation switches (see the note above NOISE_GLSL). Two spellings, for
    // the same reason tdbg takes two: a harness that mangles '=' must still be
    // able to reach them, and a switch that silently does nothing has corrupted
    // a round's evidence here five times.
    //   ?tabl=1,1,0,1,1,1,1   positional, in ABL_KEYS order
    //   ?tabl=grain:0,net:0   named
    //   ?tnocaustocc=1        the complete occlusion ablation this module owns
    const ablV = [1, 1, 1, 1, 1, 1, 1, 1];
    const spec = (ctx.params?.get?.('tabl') || '').trim();
    let pos = 0;
    for (const part of (spec ? spec.split(',') : [])) {
      const c = part.indexOf(':');
      if (c < 0) { if (pos < ablV.length) ablV[pos] = Number(part); pos++; }
      else {
        const i = ABL_KEYS.indexOf(part.slice(0, c).trim());
        if (i >= 0) ablV[i] = Number(part.slice(c + 1));
      }
    }
    for (const [k] of (ctx.params || [])) if (/^tnocaustocc$/.test(k)) ablV[5] = 0;
    const fin = (v, d) => (Number.isFinite(v) ? v : d);
    uAbl.value.set(fin(ablV[0], 1), fin(ablV[1], 1), fin(ablV[2], 1), fin(ablV[3], 1));
    uAbl2.value.set(fin(ablV[4], 1), fin(ablV[5], 1), fin(ablV[6], 1), fin(ablV[7], 1));
    const ablAll = [uAbl.value.x, uAbl.value.y, uAbl.value.z, uAbl.value.w,
      uAbl2.value.x, uAbl2.value.y, uAbl2.value.z, uAbl2.value.w];
    this.ablation = Object.fromEntries(ABL_KEYS.map((k, i) => [k, ablAll[i]]));
    if (uDbg.value > 0) {
      for (const m of [material, cobMaterial]) {
        const uu = m.userData.uwUniforms;
        if (uu) { uu.uMatFogScale.value = 0; uu.uMatDepthResponse.value = 0; }
      }
    }
    this.debug = {
      mode: uDbg.value,
      fogScale: material.userData.uwUniforms?.uMatFogScale.value,
      depthResponse: material.userData.uwUniforms?.uMatDepthResponse.value,
    };

    const cam = ctx.camera;
    lastCx = cam.position.x; lastCz = cam.position.z;
    refresh(lastCx, lastCz);
    // The first frame must not show a hole, and at init there are no coarse
    // ancestors to fall back on, so this budget has to actually cover the set
    // (~170 chunks). The horizon sweep widened the sample margin from 7 cells to
    // 16, which is +50% of build cost per chunk and buys every cast shadow in
    // the module, so the budget grew with it. Every later rebuild is incremental.
    drain(5200);
    updateVisibility();

    cobTiers = COB_TIERS.map((t) => new CobbleTier(t));
    for (const ct of cobTiers) {
      ct.mesh.material = cobMaterial;
      group.add(ct.mesh);
      ct.prime(lastCx, lastCz, 110);
      ct.refresh(lastCx, lastCz);
    }
    lastCobX = lastCx; lastCobZ = lastCz;

    this.chunkCount = chunks.size;
    this.cobbleCount = cobTiers.reduce((s, c) => s + c.count, 0);
  },

  update(dt, t, ctx) {
    frameNo++;
    const cam = ctx.camera;
    const moved = Math.abs(cam.position.x - lastCx) + Math.abs(cam.position.z - lastCz);
    if (moved > LEAF * 0.25 || pending.length || frameNo < 3) {
      lastCx = cam.position.x; lastCz = cam.position.z;
      refresh(lastCx, lastCz);
    }
    if (pending.length) {
      // Play never queues more than a couple of chunks at a time; a big queue
      // only happens on a teleport (a capture shot), where a bigger slice of
      // frame time is the right trade.
      drain(pending.length > 20 ? 11 : 3.5);
      updateVisibility();
    } else if ((frameNo & 31) === 0) {
      updateVisibility();
      evict();
    }

    // Cobbles: cell generation is the only expensive part and it is cached, so
    // a walking player pays for one new 16 m cell every few seconds. A teleport
    // (a capture shot) pays for the whole disc, hence the fatter budget while
    // anything is still missing.
    const cobMoved = Math.hypot(cam.position.x - lastCobX, cam.position.z - lastCobZ);
    if (cobTiers.length && (cobMoved > 4 || frameNo < 3)) {
      let done = true;
      for (const ct of cobTiers) if (ct.prime(cam.position.x, cam.position.z, 2.5) < 0) done = false;
      for (const ct of cobTiers) ct.refresh(cam.position.x, cam.position.z);
      if (done) { lastCobX = cam.position.x; lastCobZ = cam.position.z; }
      this.cobbleCount = cobTiers.reduce((s, c) => s + c.count, 0);
    }

    this.chunkCount = chunks.size;
  },
};
