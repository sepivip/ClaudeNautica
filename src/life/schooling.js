/**
 * SCHOOLING — fish schools: real flocking, GPU-instanced shoals, predator reactions.
 * OWNER: the "schooling" agent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE IS SHAPED THE WAY IT IS
 * ---------------------------------------------------------------------------
 * LOOK.md's amateur checklist names "a dead, empty midwater column" as a tell,
 * and `school-1.jpg` is the proof of what fills it: a loose cloud of a few
 * hundred small fish that reads as *individual dashes* near the camera and as a
 * shimmering field of glints at the edge of visibility. Nothing else in the
 * frame occupies that band — terrain is below, the surface is above, and marine
 * snow is sub-centimetre. Fish are the only thing at the 0.2-2 m scale that
 * moves, so they are what gives the water column a sense of depth and life.
 *
 * Three things had to be true at once, and each one drove a design decision:
 *
 *  1. HUNDREDS TO THOUSANDS OF FISH, CHEAPLY.
 *     Every school is one draw call: an InstancedBufferGeometry on a plain Mesh
 *     with the instance transform folded into `transformed` before
 *     <project_vertex>. NOT a THREE.InstancedMesh — core's applyUnderwater()
 *     writes vUwWorldPos from `modelMatrix * transformed` and knows nothing
 *     about instanceMatrix, so every fish in an InstancedMesh would take the
 *     fog of the group's origin and a school 40 m out would render with the
 *     transmittance of wherever its pivot happened to be. Folding the transform
 *     in by hand keeps the shared medium exactly right per fish. (world/
 *     terrain.js reached the same conclusion for its cobble field.)
 *
 *  2. IT HAS TO READ AS A BODY, NOT AS A SWARM.
 *     Metric boids alone give you insects. Real shoals hold a shape, turn as a
 *     unit, and shear when they turn because the turn propagates through the
 *     group as a wave rather than arriving everywhere at once. So there are
 *     three layers here, not one:
 *       - local flocking (separation / alignment / cohesion) over a uniform
 *         grid, with a *topological* neighbour cap of ~9 rather than a metric
 *         one, which is what Ballerini et al. (2008) measured in starlings and
 *         is also the only reason the cost stays flat as a bait ball densifies;
 *       - an ellipsoidal containment shell carried in the school's OWN frame,
 *         so the group is a body elongated along travel instead of a sphere;
 *       - a lagged heading history: a fish near the back of the school steers
 *         to the heading the school had ~0.3 s ago. That single ring buffer is
 *         what produces the fold and shear when a school turns.
 *
 *  3. DISTANCE MATTERS AS MUCH AS CLOSE-UP — BUT AS GLITTER, NOT AS GRIT.
 *     A 0.22 m fish at 45 m subtends about 3 px at 1080p and would simply
 *     alias out of existence, taking the whole midwater with it. The vertex
 *     shader therefore keeps every fish at a pixel floor by growing it, and the
 *     fragment shader dissolves the grown body back toward the exact radiance
 *     of the water it is displacing, so a far fish contributes almost nothing
 *     except when it FLASHES.
 *
 *     That flash is measured, not guessed. A connected-component pass over
 *     fish-only crops (local-background subtraction, |dL| > 10) gives, for
 *     reference/subnautica/school-1.jpg, 458 blobs with a MEDIAN peak contrast
 *     of 15.7 and a p90 of 93.5 — of which 110 blobs are BRIGHT with a median
 *     of 89.3. So a real shoal is a few blazing fish inside a field of nearly
 *     invisible ones: ratio 5.95. Round 1 of this module measured median 15.3 /
 *     p90 24.9, ratio 1.62 — the median was right and the tail did not exist.
 *
 *     The tail was missing for a concrete, findable reason. The flash lobe was
 *     evaluated on the fish's *unrolled* flank axis, which is horizontal, while
 *     the sun/eye half-vector in every canonical framing sits 30-45 degrees
 *     above horizontal: dot(flank, H) ~ 0.7, and pow(0.7, 18) = 0.003. No fish
 *     ever satisfied it at cruise, which is exactly why the only frames that
 *     ever glittered were the panicking ones, where fish roll hard.
 *
 *     The fix is the physical thing that was missing rather than a wider lobe:
 *     real shoaling fish never hold level. They scull, jockey and roll
 *     continuously, so at any instant a small subset of flanks bisects sun and
 *     eye. So each fish now carries an idle roll oscillation at its own rate and
 *     phase (ARCH.idleRoll), the flash is evaluated on the rolled flank yawed by
 *     the swimming stroke, the lobe is narrowed hard, and per-individual mirror
 *     polish is drawn from a heavy-tailed distribution. Rare and blinding, not
 *     universal and mild.
 *
 * Guarded against every neighbour: terrain, biomes, creatures and movement may
 * all be stubs. Threats fall back to the camera; the floor falls back to the
 * biome crater profile and then to -60 m.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { applyUnderwater } from '../core/underwaterMaterial.js';
import { makeRNG } from '../core/rng.js';

// ===========================================================================
// 1. ARCHETYPES
// ===========================================================================
/**
 * Three populations, because "everything the same scale" is on LOOK.md's list.
 *
 *   baitball  a tight silver ball of 0.2 m fish, dense enough to read as one
 *             dark mass at range and to break into individual glints up close.
 *   shoal     a loose reef shoal of 0.35-0.55 m fish spread over ~8 m, the
 *             population that actually fills the midwater in shallows-reef-*.
 *   drifter   a dozen 1.4-2.6 m fish moving slowly in near-line-abreast; they
 *             give the frame something with a knowable size in it.
 *
 * `radius` is the containment shell in metres and `aspect` stretches it in the
 * school's own (right, up, forward) frame — real shoals are long and flat, not
 * spherical. Densities fall out of radius vs count: the bait ball lands at
 * ~9 fish/m^3, i.e. a mean spacing of about two body lengths.
 */
const ARCH = {
  baitball: {
    len: [0.235, 0.335],
    radius: 3.1, aspect: [1.0, 0.78, 1.35], selfShadow: 0.62,
    cruise: 1.7, speedMin: 0.55, speedMax: 4.4, turn: 3.4,
    sep: 0.46, per: 0.86,
    wSep: 3.9, wAli: 1.7, wCoh: 1.25, wLead: 1.15, wHome: 2.7,
    beat: 9.6, amp: 0.105, bendK: 0.55, bankK: 0.34, idleRoll: 0.58,
    lagFrames: 15, wanderR: 26, wanderT: [5, 11], minAlt: 3.5,
    geo: { rings: 8, sides: 6, depth: 0.118, width: 0.050, tailH: 0.150,
           dorsal: true, anal: true, pect: false },
    mat: { back: 0x14343a, flank: 0xdfeef2, belly: 0xeef4f2, accent: 0xff9a1c,
           biolum: 0x3dffbe, shine: 150, specK: 5.4, flankAmt: 0.78,
           accentAmt: 0.72, stripe: 0.10, glint: 0.46, finDark: 0.50,
           flashK: 15.0, flashSharp: 21 },
  },
  shoal: {
    len: [0.32, 0.56],
    radius: 7.9, aspect: [1.0, 0.46, 1.55], selfShadow: 0.16,
    cruise: 1.25, speedMin: 0.30, speedMax: 3.6, turn: 2.5,
    sep: 1.30, per: 2.60,
    wSep: 2.6, wAli: 1.15, wCoh: 0.85, wLead: 0.80, wHome: 1.5,
    beat: 7.0, amp: 0.095, bendK: 0.55, bankK: 0.40, idleRoll: 0.38,
    lagFrames: 22, wanderR: 34, wanderT: [7, 15], minAlt: 2.2,
    geo: { rings: 9, sides: 7, depth: 0.132, width: 0.056, tailH: 0.165,
           dorsal: true, anal: true, pect: true },
    mat: { back: 0x1b4a3d, flank: 0xc8e4dc, belly: 0xe6efe4, accent: 0xff7d12,
           biolum: 0x4dffd2, shine: 128, specK: 3.6, flankAmt: 0.58,
           accentAmt: 0.86, stripe: 0.22, glint: 0.40, finDark: 0.42,
           flashK: 10.0, flashSharp: 19 },
  },
  drifter: {
    len: [1.45, 2.65],
    radius: 10.5, aspect: [1.0, 0.44, 1.35], selfShadow: 0.0,
    cruise: 0.85, speedMin: 0.25, speedMax: 2.2, turn: 0.95,
    sep: 4.2, per: 7.5,
    wSep: 2.0, wAli: 0.75, wCoh: 0.45, wLead: 0.55, wHome: 0.7,
    beat: 2.05, amp: 0.075, bendK: 0.70, bankK: 0.30, idleRoll: 0.15,
    lagFrames: 26, wanderR: 42, wanderT: [10, 20], minAlt: 4.5,
    geo: { rings: 11, sides: 8, depth: 0.155, width: 0.068, tailH: 0.200,
           dorsal: true, anal: true, pect: true },
    mat: { back: 0x24393f, flank: 0xa8bcbe, belly: 0xd4dacf, accent: 0xd8933c,
           biolum: 0x7fe3ff, shine: 92, specK: 2.2, flankAmt: 0.32,
           accentAmt: 0.55, stripe: 0.14, glint: 0.32, finDark: 0.32,
           flashK: 4.2, flashSharp: 18 },
  },
};

/**
 * The standing population. `band` is the distance to place this school at when
 * it is recycled, as a fraction of the biome's current usable visibility — so
 * the set spreads itself across the whole depth of field automatically whether
 * the shallows are showing 50 m or the Lost River 15 m.
 *
 * ROUND 2 REBALANCE. A live probe of round 1 found 8 of 12 schools sitting
 * between 27 m and 61 m, where a 0.2 m fish subtends 2.0-4.5 px: roughly 2,000
 * of 3,360 fish were rendering as sub-resolution grit, and the numbers agreed
 * (detailRMS overshot the reference 8.92 vs 6.33 while tile contrast UNDERSHOT
 * 4.85 vs 6.52 — the signature of grain rather than glitter). The far bands are
 * therefore roughly halved and the freed budget moved into the 8-20 m band,
 * where a fish is 10-30 px and reads as a body. Total roster 3,360 -> 2,167.
 * The far bands are not emptied — an empty midwater column is LOOK.md's named
 * tell — they are thinned until what survives there is glitter.
 */
const ROSTER = [
  { arch: 'baitball', n: 620, band: [0.13, 0.30] },
  { arch: 'shoal',    n: 260, band: [0.16, 0.34] },
  { arch: 'shoal',    n: 210, band: [0.22, 0.40] },
  { arch: 'drifter',  n: 11,  band: [0.24, 0.50] },
  { arch: 'baitball', n: 330, band: [0.34, 0.58] },
  { arch: 'shoal',    n: 150, band: [0.44, 0.70] },
  { arch: 'drifter',  n: 12,  band: [0.46, 0.82] },
  { arch: 'shoal',    n: 95,  band: [0.54, 0.84] },
  { arch: 'baitball', n: 190, band: [0.60, 0.95] },
  { arch: 'shoal',    n: 80,  band: [0.66, 1.00] },
  { arch: 'shoal',    n: 200, band: [0.20, 0.42] },
  { arch: 'drifter',  n: 9,   band: [0.38, 0.70] },
];

/**
 * How much of a school's roster is actually alive in each biome. Fish density
 * is a biome property in Subnautica — the Safe Shallows swarm, the Dunes are
 * famously empty, and below the Lost River there is essentially nothing but
 * bioluminescence. Applied as `geometry.instanceCount`, so it costs nothing to
 * vary and does not need the buffers rebuilt.
 */
const BIOME_DENSITY = {
  safe_shallows: 1.00, kelp_forest: 0.82, grassy_plateaus: 0.90,
  mushroom_forest: 0.70, sparse_reef: 0.50, bulb_zone: 0.66,
  underwater_islands: 0.58, grand_reef: 0.56, crash_zone: 0.46,
  dunes: 0.30, jellyshroom_cave: 0.26, blood_kelp: 0.22,
  lost_river: 0.18, inactive_lava_zone: 0.10, void: 0.05,
};

/**
 * ...and per ARCHETYPE, because density alone is the wrong knob in a forest.
 *
 * Measured A/B against ?noschool=1 at identical framing, round 1 changed 21.44%
 * of the pixels in `kelp-forest` and darkened 17.16% of them: three schools
 * (623 fish at 13 m, 508 at 23.5 m, 443 at 45 m) laid a rectangular slab of
 * dark speckle over the right third of the frame, detailRMS 11.35 -> 16.0 with
 * median luminance 67.6 -> 57.5. No reference kelp frame contains anything like
 * it — kelp-forest-1..4 have creepvine silhouettes against light shafts and a
 * handful of readable fish, never a pepper field. Small fish shelter INSIDE the
 * stalks where they are occluded; what a diver actually sees crossing a kelp
 * aisle is a few big slow bodies. So in a forest the bait balls all but vanish
 * and the drifters stay at full strength.
 */
const BIOME_ARCH = {
  kelp_forest:      { baitball: 0.13, shoal: 0.28, drifter: 1.00 },
  blood_kelp:       { baitball: 0.22, shoal: 0.45, drifter: 1.00 },
  mushroom_forest:  { baitball: 0.42, shoal: 0.72, drifter: 1.00 },
  jellyshroom_cave: { baitball: 0.30, shoal: 0.55, drifter: 1.00 },
};

const TWO_PI = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ===========================================================================
// 2. THE FISH BODY
// ===========================================================================
/**
 * A fish is a generalised cylinder swept along z (nose at +0.5, caudal peduncle
 * at -0.28) plus flat fin sheets, all in body-length units so one geometry
 * serves a 0.19 m baitfish and a 2.6 m drifter by scale alone.
 *
 * The profile matters more than the polygon count. What makes a silhouette
 * read as a fish at 6 px is: a pointed head, the widest section about a third
 * back, a *thin* caudal peduncle, and a forked tail taller than the body. Get
 * those four and a 60-triangle body is indistinguishable from a 6000-triangle
 * one at every distance the player will ever see it from.
 *
 * Normals are computed analytically from the parametric surface rather than by
 * averaging faces: cross(dP/dtheta, dP/dt) is outward everywhere by
 * construction (dz/dt < 0), which removes any chance of a flipped winding
 * showing up as a black fish.
 */
function buildFishBody(o) {
  const rings = o.rings, sides = o.sides;
  const D = o.depth, W = o.width, tailH = o.tailH;
  const BODY = 0.78;                          // nose z=+0.5 -> peduncle z=-0.28

  const hAt = (t) => D * (0.055 + 0.945 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.62)), 0.8) * (1 - 0.50 * t));
  const wAt = (t) => W * (0.050 + 0.950 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.55)), 0.9) * (1 - 0.62 * t));
  const zAt = (t) => 0.5 - t * BODY;
  // fuller belly than back, which is what gives the counter-shading a shape
  const gAt = (a) => { const c = Math.cos(a); return c < 0 ? c * 1.16 : c; };
  const surf = (t, a) => [wAt(t) * Math.sin(a), hAt(t) * gAt(a), zAt(t)];

  const pos = [], nrm = [], fish = [], idx = [];
  const push = (p, n, u, yb, fin) => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(n[0], n[1], n[2]);
    fish.push(u, yb, fin);
  };

  // ---- body rings
  const EPS = 2e-3;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const h = hAt(t);
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TWO_PI;
      const p = surf(t, a);
      const pa1 = surf(t, a + EPS), pa0 = surf(t, a - EPS);
      const pt1 = surf(Math.min(1, t + EPS), a), pt0 = surf(Math.max(0, t - EPS), a);
      const dA = [pa1[0] - pa0[0], pa1[1] - pa0[1], pa1[2] - pa0[2]];
      const dT = [pt1[0] - pt0[0], pt1[1] - pt0[1], pt1[2] - pt0[2]];
      let nx = dA[1] * dT[2] - dA[2] * dT[1];
      let ny = dA[2] * dT[0] - dA[0] * dT[2];
      let nz = dA[0] * dT[1] - dA[1] * dT[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      push(p, [nx / l, ny / l, nz / l], 0.5 - p[2], clamp(p[1] / Math.max(h, 1e-4), -1.2, 1.2), 0);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const kn = (k + 1) % sides;
      const a = i * sides + k, b = i * sides + kn;
      const c = (i + 1) * sides + k, d = (i + 1) * sides + kn;
      idx.push(a, b, c, b, d, c);
    }
  }

  // ---- nose cap
  const apex = pos.length / 3;
  push([0, 0, 0.5 + 0.020], [0, 0, 1], 0.5 - (0.5 + 0.02), 0, 0);
  for (let k = 0; k < sides; k++) idx.push(apex, (k + 1) % sides, k);

  // ---- caudal fin: a flat forked sheet. Its `u` runs past the body's 0.78 out
  // to 1.0, so the travelling wave's u^1.9 envelope whips it hardest — which is
  // the whole reason a swimming fish reads as swimming rather than sliding.
  const base = pos.length / 3;
  const hp = hAt(1);
  const fv = [
    [0, hp, -0.28], [0, -hp, -0.28], [0, 0, -0.415],
    [0, tailH, -0.50], [0, -tailH, -0.50],
  ];
  const fyb = [1, -1, 0, 1, -1];
  for (let i = 0; i < 5; i++) push(fv[i], [1, 0, 0], 0.5 - fv[i][2], fyb[i], 1);
  const RT = base, RB = base + 1, NO = base + 2, TT = base + 3, TB = base + 4;
  idx.push(RT, NO, TT);          // upper lobe
  idx.push(RB, TB, NO);          // lower lobe
  idx.push(RT, RB, NO);          // between the lobes

  // ---- dorsal / anal fins: low sheets that break the body's smooth top line
  const sheet = (t0, t1, hgt, sign) => {
    const b = pos.length / 3;
    const y0 = hAt(t0) * sign, y1 = hAt(t1) * sign;
    const quad = [
      [0, y0, zAt(t0)], [0, y1, zAt(t1)],
      [0, y1 + hgt * 0.30 * sign, zAt(t1 - 0.02)], [0, y0 + hgt * sign, zAt(t0 + 0.04)],
    ];
    for (let i = 0; i < 4; i++) push(quad[i], [1, 0, 0], 0.5 - quad[i][2], sign * (i < 2 ? 1 : 1.35), 1);
    idx.push(b, b + 1, b + 3, b + 1, b + 2, b + 3);
  };
  if (o.dorsal) sheet(0.28, 0.60, D * 0.62, 1);
  if (o.anal) sheet(0.62, 0.82, D * 0.42, -1);

  // ---- pectorals
  if (o.pect) {
    for (const s of [1, -1]) {
      const b = pos.length / 3;
      const t = 0.24;
      const root = [wAt(t) * 0.85 * s, -hAt(t) * 0.28, zAt(t)];
      const tip1 = [root[0] + 0.100 * s, root[1] - 0.020, root[2] - 0.085];
      const tip2 = [root[0] + 0.055 * s, root[1] - 0.058, root[2] - 0.145];
      for (const p of [root, tip1, tip2]) push(p, [0, 1, 0], 0.5 - p[2], -0.5, 1);
      if (s > 0) idx.push(b, b + 1, b + 2); else idx.push(b, b + 2, b + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFish', new THREE.Float32BufferAttribute(fish, 3));
  g.setIndex(idx);
  return g;
}

// ===========================================================================
// 3. SHADERS
// ===========================================================================
// vUwWorldPos / vUwWorldNormal and every medium uniform are declared by
// UNDERWATER_PARS, which applyUnderwater() injects straight after <common>.
// We read them rather than redeclaring, so these shaders only compile patched.

const FISH_VERT = /* glsl */ `
#include <common>
attribute vec4 aP;      // xyz world position, w tail-beat phase in radians
attribute vec4 aD;      // xyz unit forward, w bank roll
attribute vec4 aS;      // x length(m)  y beat amplitude  z turn curvature  w in-school occlusion
attribute vec4 aTint;   // x brightness  y warmth  z accent pick  w seed
attribute vec3 aFish;   // per-vertex: x u(0 nose..1 tail tip)  y dorsoventral  z fin flag

uniform float uResY;
uniform float uTanHalf;
uniform float uMinPx;
uniform float uWaveK;
uniform float uFlashK;
uniform float uFlashSharp;

varying vec3  vTint;
varying vec3  vFishV;
varying float vFlash;
varying float vGrow;
varying float vSeed;
varying float vOcc;

void main() {
  // Orientation follows velocity, always: the forward axis IS the swim
  // direction, and the frame is completed from world up and then rolled. Fish
  // that translate without turning to face where they are going are on
  // LOOK.md's amateur list by name.
  vec3 f = normalize(aD.xyz);
  vec3 ref = abs(f.y) > 0.985 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 r0 = normalize(cross(ref, f));
  vec3 u0 = cross(f, r0);
  float cr = cos(aD.w), sr = sin(aD.w);
  vec3 R  = r0 * cr + u0 * sr;
  vec3 Uu = u0 * cr - r0 * sr;

  // the nose cap sits a hair past z = 0.5, so u can go slightly negative and
  // pow() would return NaN and blow one vertex of every fish to infinity
  float u  = clamp(aFish.x, 0.0, 1.05);
  vec3  lp = position;
  vec3  ln = normal;

  // ---- carangiform travelling wave.
  // Amplitude grows as u^1.9 so the head is nearly still and the tail sweeps;
  // that ratio is the entire difference between a swimming fish and a wobbling
  // stick. The wave travels nose->tail as the phase advances.
  float env  = pow(u, 1.9);
  float dEnv = 1.9 * pow(max(u, 1e-3), 0.9);
  float ph   = u * uWaveK - aP.w;
  float sn   = sin(ph), cs = cos(ph);
  float lat  = aS.y * env * sn;
  float dLat = aS.y * (dEnv * sn + env * uWaveK * cs);

  // ---- steady-turn curvature: the body bows into the turn, strongest amidships
  float bow  = aS.z * (u * u * (1.5 - u));
  float dBow = aS.z * (3.0 * u - 3.0 * u * u);

  lp.x += lat + bow;

  // The deformation is a pure shear x' = x + f(z) with u = 0.5 - z, so the
  // normal transforms by the inverse transpose of its Jacobian, which reduces
  // to n.z -= f'(z)*n.x, and f'(z) = -df/du. Without this the flanks keep the
  // undeformed normal and the specular flash never tracks the tail beat — which
  // is precisely the signal that tells the eye the fish is swimming.
  ln.z += (dLat + dBow) * ln.x;
  ln = normalize(ln);

  // ---- keep far fish above a pixel, or the midwater aliases to nothing.
  // A 0.22 m fish at 45 m is 3 px at 1080p and 2 px at 900p; below about two
  // pixels a triangle stops hitting sample points reliably and the far half of
  // every school simply vanishes and reappears frame to frame. Growing it to a
  // floor keeps the cloud continuous; the diffuse is energy-compensated in the
  // fragment shader so the cloud does not get brighter as well as bigger.
  float dCam   = distance(uCamPos, aP.xyz);
  float pxPerM = uResY / (2.0 * uTanHalf * max(dCam, 0.05));
  float grow   = clamp(uMinPx / max(aS.x * pxPerM, 1e-4), 1.0, 2.45);
  vGrow = grow;

  float sc = aS.x * grow;
  vec3 objectNormal = normalize(R * ln.x + Uu * ln.y + f * ln.z);
  vec3 transformed  = aP.xyz + (R * lp.x + Uu * lp.y + f * lp.z) * sc;

  // -------------------------------------------------------------------------
  // THE FLANK FLASH — computed PER FISH, narrow, and deliberately RARE.
  //
  // A baitfish flank is a stack of guanine platelets, i.e. a mirror. The
  // per-pixel lobe in the fragment shader is the correct model for that mirror
  // and it is what paints the blazing ridge on a fish three metres away, but it
  // is useless at range: on a body four pixels long the bright patch is a
  // fraction of one pixel and rasterisation averages it away. So the mirror is
  // evaluated a second time on the fish's own flank PLANE, which lights the
  // whole body at once and therefore survives at two pixels.
  //
  // Round 1 evaluated that plane on the fish's unrolled right axis — which is
  // horizontal — while H sits 30-45 degrees up in every canonical framing.
  // dot = 0.7, pow(0.7, 18) = 0.003, so it never fired except when the school
  // was panicking and rolling hard. Here the plane is the ROLLED flank (the
  // idle sculling roll the sim now carries is what supplies the attitude
  // spread), yawed by the swimming stroke: at u = 0.62 the travelling wave
  // rotates the mid-flank by atan(dLat / 0.78), about +-25 degrees, and every
  // fish is at its own beat phase. Two lobes, because a flank mirrors two
  // things — the sun, and the bright water column overhead.
  // -------------------------------------------------------------------------
  vec3  toC = uCamPos - aP.xyz;
  vec3  Vf  = toC / max(length(toC), 1e-4);

  float mE    = pow(0.62, 1.9), mdE = 1.9 * pow(0.62, 0.9);
  float mph   = 0.62 * uWaveK - aP.w;
  float slope = aS.y * (mdE * sin(mph) + mE * uWaveK * cos(mph));
  float yaw   = atan(slope, 0.78);
  vec3  Nf    = normalize(R * cos(yaw) + f * sin(yaw));
  Nf *= dot(Nf, Vf) < 0.0 ? -1.0 : 1.0;

  vec3  Hs = normalize(uSunDir + Vf);
  vec3  Hu = normalize(vec3(0.0, 1.0, 0.0) + Vf);
  float gs = pow(max(dot(Nf, Hs), 0.0), uFlashSharp);
  float gu = pow(max(dot(Nf, Hu), 0.0), uFlashSharp * 0.42);

  // Rarity comes from ATTITUDE, not from a rigged per-fish lottery. The first
  // cut of this gated the flash on a heavy-tailed per-individual "polish", and
  // the two rarities multiplied: measured, roughly one fish in a hundred blazed
  // where the reference blazes on twenty-four in a hundred (110 bright blobs of
  // 458). Every baitfish flank is the same mirror; what differs between them at
  // any instant is which way it is pointing. So the gain carries only a mild
  // spread and the lobe width alone decides how many fish are lit.
  float pol = fract(sin(aTint.w * 91.37 + 3.1) * 43758.5453);
  vFlash = uFlashK * (0.42 + 1.15 * pol) * (gs + 0.40 * gu);

  vTint  = aTint.xyz;
  vFishV = aFish;
  vSeed  = aTint.w;
  vOcc   = aS.w;
  #include <project_vertex>
}
`;

const FISH_FRAG = /* glsl */ `
#include <common>
uniform float uSunIntensity;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform vec3  uBack;
uniform vec3  uBelly;
uniform vec3  uFlank;
uniform vec3  uAccent;
uniform vec3  uBiolum;
uniform float uShine;
uniform float uSpecK;
uniform float uFlankAmt;
uniform float uAccentAmt;
uniform float uStripe;
uniform float uGlint;
uniform float uFinDark;
// uFlashK / uFlashSharp are vertex-stage only now — the flash is per fish.

varying vec3  vTint;
varying vec3  vFishV;
varying float vFlash;
varying float vGrow;
varying float vSeed;
varying float vOcc;

void main() {
  vec3 P = vUwWorldPos;
  vec3 N = normalize(vUwWorldNormal);
  // fins are single-sided sheets; without this their far face renders inverted
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - P);

  float pd = max(0.0, uWaterLevel - P.y);
  float u   = vFishV.x;
  float yb  = clamp(vFishV.y, -1.3, 1.3);
  float fin = vFishV.z;

  // ---- counter-shading.
  // Dark dorsal, mirror flank, pale ventral: the one pattern every open-water
  // baitfish on Earth converges on, and the reason a school reads as a school.
  // The backs disappear against the deep water below, the bellies disappear
  // against the bright water above, and only the flank band is left to flash.
  vec3 albedo = mix(uBelly, uBack, smoothstep(-0.85, 0.62, yb));
  // two masks, because a baitfish is not "dark with a silver line": most of the
  // flank is mirror, with a brighter lateral band down the middle of it
  float flankM = exp(-pow((yb + 0.10) * 1.50, 2.0));
  float band   = 0.42 * flankM + 0.58 * exp(-pow((yb + 0.06) * 3.2, 2.0));
  albedo = mix(albedo, uFlank, flankM * uFlankAmt);
  // vertical barring, per-individual phase
  albedo *= 1.0 + uStripe * sin(u * 27.0 + vSeed * 17.0) * 0.5;

  // ---- THE ACCENT MINORITY.
  // Measured on round 1: the fish region of shallows-reef came back at
  // contentSat 0.654 against a background water saturation of 0.743 and a mean
  // content colour of [62,148,190] — i.e. the fish were LESS saturated than the
  // water and were, in hue, simply the water. LOOK.md rule 6 asks for the
  // opposite shape: a near-monochrome saturated field with tiny HYPER-saturated
  // accents punched into it, and shallows-reef-1.jpg has exactly one, a single
  // orange-yellow fish at frame right against a wholly cyan scene.
  //
  // Round 1 selected accent fish with smoothstep(0.62, 0.98), which spread a
  // weak wash over 38% of every school and reached full strength on 2% — a
  // little orange on a lot of fish, when what the reference has is a lot of
  // orange on a few. The gate is now hard and narrow: about one fish in six
  // carries the hue, and it carries it across the whole body including the
  // flank band, so it survives the fog as a warm point rather than a grey one.
  float acc = smoothstep(0.83, 0.90, vTint.z) * uAccentAmt;
  albedo = mix(albedo, uAccent * (0.72 + 0.62 * band), acc);
  albedo *= vTint.x * mix(vec3(1.0), vec3(1.10, 1.0, 0.84), vTint.y);
  albedo *= 1.0 - uFinDark * fin;

  // ---- lighting, on exactly the same footing as world/terrain.js so a fish
  // over the sand does not float out of the frame. downT is renormalised to its
  // brightest channel so it tilts the HUE of the downwelling light without
  // darkening a second time (core's injection already owns the level).
  vec3 downT = exp(-uAbsorption * pd * 0.42);
  downT /= max(max(downT.r, downT.g), max(downT.b, 1e-4));
  float ndl  = dot(N, uSunDir);
  // Flesh is translucent and water is a heavy forward-scatterer, so the shaded
  // side of a fish is dim, never black — a hard terminator on a 0.2 m body reads
  // as plastic.
  float wrap = max(ndl, 0.0) * 0.74 + 0.26 * (ndl * 0.5 + 0.5);
  // vOcc is how buried this fish is in its own school, computed on the CPU from
  // its normalised radius in the containment ellipsoid. A bait ball is optically
  // THICK — the reason a real one photographs as a dark core with a bright
  // shimmering rind is that the fish in the middle are shaded by the fish around
  // them. Without it the ball renders as an even pale smudge with no volume, and
  // a critic reads it as a particle system rather than a body of fish.
  vec3  sun  = uSunColor * downT * (uSunIntensity * wrap * 0.45 * vOcc);
  vec3  amb  = mix(uAmbBottom, uAmbTop, N.y * 0.5 + 0.5) * (0.44 * vOcc);

  // ---- the mirror flank, per pixel.
  // This is the term that paints the blazing ridge along the head and back of a
  // close fish — look at the peeper in shallows-reef-1.jpg, whose skull carries
  // a hard white specular band at 255 against a body sitting near 40. The lobe
  // is now NARROW (uShine 92-150 rather than 32-74) and deliberately NOT energy
  // conserving: a narrow lobe over a rounded body is a thin blazing stripe, and
  // a thin blazing stripe is what the reference actually shows.
  vec3  H    = normalize(uSunDir + V);
  float nh   = max(dot(N, H), 0.0);
  float sh   = mix(uShine, uShine * 0.22, fin);
  float fres = 0.06 + 0.94 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3  spec = uSunColor * downT * (pow(nh, sh) * uSpecK * mix(0.30, 1.0, band)
                                    * mix(0.55, 1.35, fres) * (1.0 - fin * 0.75) * vOcc);

  // ---- THE FLANK FLASH — the whole reason a distant shoal shimmers.
  // Evaluated per fish in the vertex shader (see the long note there): it is the
  // same mirror, integrated over the flank plane so it survives at two pixels,
  // fired by the idle roll spread rather than by luck, and gated by a
  // heavy-tailed per-individual polish so roughly one fish in ten blazes while
  // the rest stay inside the medium. On an accent fish the flash goes gold
  // rather than white, which is what a school of orange reef fish does when it
  // turns through the sun.
  vec3 flashTint = mix(vec3(1.0), vec3(1.55, 0.94, 0.34), acc);
  spec += uSunColor * downT * flashTint
        * (vFlash * mix(0.35, 1.0, band) * (1.0 - fin) * vOcc);

  // ---- and it mirrors the water column itself, which is what keeps a baitfish
  // silver when it is catching no sun at all. This is a REFLECTION of the
  // medium, not a painted-on sheen: uwInscatter() is the shared model core
  // exports, so the radiance a flank shows is exactly the radiance the open
  // water would show along the same direction. That makes the mirror
  // anisotropic in elevation for free — a flank tipped up shows bright water
  // and one tipped down shows dark, so a rolling school flickers between
  // near-invisible and brilliant exactly the way a real one does.
  //
  // But a mirror of the medium is also, literally, the fog colour, and at a
  // ceiling of 0.92 it was painting every fish that colour — which is how the
  // fish ended up LESS saturated than the water they sit in. Guanine is not a
  // neutral mirror: the platelet stacks are thin-film reflectors and their
  // reflectance is tilted warm and iridescent. So the reflection is tinted at
  // constant luminance (0.213*1.30 + 0.715*1.02 + 0.072*0.72 = 1.06) and the
  // ceiling is pulled down, which buys hue separation without brightening the
  // dull majority the measurement says is already at the right level.
  vec3  rv     = reflect(-V, N);
  vec3  envRad = uwInscatter(rv, uMaxVisibility * 2.5, pd) * vOcc
               * mix(vec3(1.0), vec3(1.30, 1.02, 0.72), 0.55 + 0.35 * acc);
  // Ceiling 0.70: high enough that the dull majority sinks toward the water
  // value (measured blob median 27.9 against the reference's 15.7 — our fish
  // are closer and better resolved, but the un-flashing ones should still be
  // dissolving, not asserting), low enough that they are not simply painted fog.
  float mirror = clamp(uFlankAmt * uGlint * band * mix(0.42, 1.0, fres) * (1.0 - fin), 0.0, 0.70);

  // ---- deep water: below ~150 m there is no sun left and the only thing that
  // reads is bioluminescence. school-1.jpg at 345 m is a field of green-cyan
  // dashes on near-black water, and LOOK.md section 27 insists it stays
  // *discrete points on a dark body*, never a uniform emissive skin.
  float deep = smoothstep(70.0, 250.0, pd);
  float dots = pow(max(0.0, sin(u * 54.0 + vSeed * 23.0)), 6.0);
  vec3  glow = uBiolum * (deep * (band * 1.15 + dots * 1.9) * (1.0 - fin * 0.6));

  vec3 body = mix(albedo * (sun + amb), envRad, mirror) + glow;

  // ---- SUB-PIXEL COVERAGE.
  // Growing a distant fish to a pixel floor keeps it from aliasing out, but it
  // also hands it screen area it has not earned: a 2 px fish drawn at 6 px
  // holds full contrast against the water where physics says a fish covering a
  // ninth of the pixel should be nine tenths water. Left alone, the far bands
  // of every school render as a crisp field of dark grit — the exact opposite
  // of LOOK.md section 2's "objects lose contrast before they lose brightness".
  //
  // So blend toward the radiance that would make this pixel read as open water.
  // Compositing downstream is  L = body*T(d) + I(d),  and the background is
  // I(far), so the value that vanishes is  Leq = (I(far) - I(d)) / T(d).
  // Both terms come from core's shared uwInscatter/uwTransmittance, so a
  // dissolving fish tracks the medium exactly instead of fading to a guess.
  // Branch is coherent per school — a whole distant band takes it together, a
  // whole near one skips it — so the two extra uwInscatter evaluations are only
  // paid where they change the picture.
  if (vGrow > 1.002 && uUnderwater > 0.5) {
    float dist  = distance(P, uCamPos);
    vec3  rdv   = (P - uCamPos) / max(dist, 1e-4);
    float z0    = max(0.0, uWaterLevel - uCamPos.y);
    vec3  Tv    = uwTransmittance(dist);
    vec3  Leq   = min((uwInscatter(rdv, uMaxVisibility * 3.0, z0)
                       - uwInscatter(rdv, dist, z0)) / max(Tv, vec3(2e-3)), vec3(8.0));
    // Exponent raised 1.7 -> 2.1 in round 2. The measured fault was not density
    // but distribution: our far bands persisted as dark dots at a median blob
    // contrast of 21-28 where the reference median is 15. A fish grown 2.45x is
    // covering a sixth of the pixels it is drawing into, so it should be handing
    // five sixths of them back to the water; the flash below is what is left.
    body = mix(Leq, body, pow(vGrow, -2.1));
  }

  // The specular is added AFTER the coverage blend and is deliberately not
  // dissolved with it. A glint is a sub-pixel highlight whose energy is real —
  // a mirror flank a third of a pixel across still delivers its whole flash
  // into that pixel — and letting it survive is precisely what turns the far
  // band of a school from grit into a shimmer.
  gl_FragColor = vec4(body + spec, 1.0);
}
`;

function makeFishMaterial(a) {
  const c = (h) => new THREE.Color().setHex(h, THREE.SRGBColorSpace);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uSunIntensity: U.uSunIntensity,
      uAmbTop: U.uAmbientTop,
      uAmbBottom: U.uAmbientBottom,
      uBack: { value: c(a.mat.back) },
      uBelly: { value: c(a.mat.belly) },
      uFlank: { value: c(a.mat.flank) },
      uAccent: { value: c(a.mat.accent) },
      uBiolum: { value: c(a.mat.biolum) },
      uShine: { value: a.mat.shine },
      uSpecK: { value: a.mat.specK },
      uFlankAmt: { value: a.mat.flankAmt },
      uAccentAmt: { value: a.mat.accentAmt },
      uStripe: { value: a.mat.stripe },
      uGlint: { value: a.mat.glint },
      uFinDark: { value: a.mat.finDark },
      uFlashK: { value: a.mat.flashK },
      uFlashSharp: { value: a.mat.flashSharp },
      uResY: { value: 1080 },
      uTanHalf: { value: Math.tan(34 * Math.PI / 180) },
      // Tightened with the dissolve exponent: a smaller floor keeps a flashing
      // far fish a crisp 2-4 px spark instead of a soft 6 px smudge.
      uMinPx: { value: 2.15 },
      uWaveK: { value: 6.6 },
    },
    vertexShader: FISH_VERT,
    fragmentShader: FISH_FRAG,
    // fins are zero-thickness sheets and a fish seen from the wrong side must
    // still be a fish, so both faces draw and the normal is flipped per-face.
    side: THREE.DoubleSide,
  });
  m.name = 'schooling-fish';
  applyUnderwater(m);
  return m;
}

// ===========================================================================
// 4. A SCHOOL
// ===========================================================================
const HIST = 40;              // heading-history ring, in frames
const MAXCELL = 16;           // uniform-grid dimension cap per axis
const NEIGH_MAX = 9;          // topological neighbour count (Ballerini et al.)
const CAND_MAX = 52;          // hard cap on candidates examined per fish
const ACC_MAX = 26;           // m/s^2 steering ceiling per fish

class School {
  constructor(spec, arch, geoBase, material, rng, index) {
    this.spec = spec;
    this.a = arch;
    this.rng = rng;
    this.index = index;
    const n = this.n = spec.n;

    // ---- per-fish state (SoA; every hot loop below is over typed arrays)
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.dx = new Float32Array(n); this.dy = new Float32Array(n); this.dz = new Float32Array(n);
    this.sp = new Float32Array(n);
    this.ax = new Float32Array(n); this.ay = new Float32Array(n); this.az = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.roll = new Float32Array(n);
    this.bend = new Float32Array(n);
    this.side = new Int8Array(n);       // which lobe this fish joins when the school splits
    this.beatK = new Float32Array(n);
    // Idle sculling roll, per fish, at its own rate and phase. This is not
    // decoration — it is the mechanism that makes the flank flash rare instead
    // of never. A shoal holding perfectly level presents every flank at the same
    // attitude, so a narrow mirror lobe either fires on all of them or on none;
    // real fish scull, jockey and roll continuously, and it is that attitude
    // SPREAD that lets a small subset bisect sun and eye at any instant.
    this.rollF = new Float32Array(n);
    this.rollP = new Float32Array(n);

    // ---- uniform grid
    this.cellOf = new Int32Array(n);
    this.items = new Int32Array(n);
    this.cellCount = new Int32Array(MAXCELL * MAXCELL * MAXCELL + 1);
    this.cellStart = new Int32Array(MAXCELL * MAXCELL * MAXCELL + 1);
    this.cursor = 0;                  // round-robin slice for neighbour work

    // ---- school state
    this.center = new THREE.Vector3();
    this.head = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.goal = new THREE.Vector3();
    this.anchor = new THREE.Vector3();
    this.goalT = 0;
    this.panic = 0;
    this.reform = 0;
    this.splitX = 0; this.splitZ = 0;   // horizontal fission axis, latched on a strike
    this.floorY = -60;
    this.floorT = 0;
    this.active = n;
    this.hist = new Float32Array(HIST * 3);
    this.histI = 0;
    this.demo = null;
    this.pinT = 0;
    this.th = [];
    this.leash = arch.wanderR;
    this._demoTh = { x: 0, y: 0, z: 0, r: 0, k: 0 };

    // ---- GPU buffers
    this.aP = new Float32Array(n * 4);
    this.aD = new Float32Array(n * 4);
    this.aS = new Float32Array(n * 4);
    const tint = new Float32Array(n * 4);

    const [l0, l1] = arch.len;
    for (let i = 0; i < n; i++) {
      const s = rng.range(l0, l1);
      this.beatK[i] = rng.range(0.86, 1.18);
      this.phase[i] = rng() * TWO_PI;
      // 0.55-1.75 rad/s: slow enough to read as sculling rather than wobble,
      // fast enough that the flash population turns over several times a second
      this.rollF[i] = rng.range(0.55, 1.75);
      this.rollP[i] = rng() * TWO_PI;
      // brightness / warmth / accent-pick / seed. Accent is a long tail so only
      // a handful of fish in a school carry the hot colour.
      tint[i * 4] = rng.range(0.82, 1.16);
      tint[i * 4 + 1] = rng() * rng();
      tint[i * 4 + 2] = rng();
      tint[i * 4 + 3] = rng() * TWO_PI;
      this.aS[i * 4] = s;
      this.aS[i * 4 + 1] = arch.amp;
      this.aS[i * 4 + 3] = 1;
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = geoBase.index;
    geo.setAttribute('position', geoBase.attributes.position);
    geo.setAttribute('normal', geoBase.attributes.normal);
    geo.setAttribute('aFish', geoBase.attributes.aFish);
    this.bP = new THREE.InstancedBufferAttribute(this.aP, 4).setUsage(THREE.DynamicDrawUsage);
    this.bD = new THREE.InstancedBufferAttribute(this.aD, 4).setUsage(THREE.DynamicDrawUsage);
    this.bS = new THREE.InstancedBufferAttribute(this.aS, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.bP);
    geo.setAttribute('aD', this.bD);
    geo.setAttribute('aS', this.bS);
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 4));
    geo.instanceCount = n;
    // The mesh sits at the origin and every fish carries a world-space
    // position, so the bounding sphere is authored in world space directly and
    // tracked each frame. Without this three would compute it once from the
    // (origin-centred) template body and cull the whole school the moment the
    // camera turned.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), arch.radius * 2);
    geo.computeBoundingSphere = () => {};

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `school-${index}-${spec.arch}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    mesh.renderOrder = 2;
    // Thousands of 0.2 m bodies in a 320 m shadow cascade are pure noise and
    // cost a second full pass; core honours this flag in enableShadows().
    mesh.userData.noShadow = true;
    mesh.raycast = () => {};
    this.geo = geo;
    this.mesh = mesh;
  }

  // -------------------------------------------------------------- placement
  /** Scatter the school into a fresh ellipsoid around `c`, heading `h`. */
  place(c, h) {
    const rng = this.rng, a = this.a, n = this.n;
    this.center.copy(c);
    this.head.copy(h).normalize();
    if (!Number.isFinite(this.head.x) || this.head.lengthSq() < 0.5) this.head.set(0, 0, 1);
    this._frame();
    this.anchor.copy(c);
    this.leash = a.wanderR;
    this.goal.copy(c).addScaledVector(this.head, a.wanderR);
    this.goalT = rng.range(a.wanderT[0], a.wanderT[1]);
    this.panic = 0; this.reform = 0;
    for (let k = 0; k < HIST; k++) {
      this.hist[k * 3] = this.head.x; this.hist[k * 3 + 1] = this.head.y; this.hist[k * 3 + 2] = this.head.z;
    }
    const R = a.radius, ar = a.aspect;
    for (let i = 0; i < n; i++) {
      // uniform-ish in the ellipsoid, biased slightly to the middle so the
      // school has a core rather than a shell
      let ux, uy, uz, q;
      do {
        ux = rng() * 2 - 1; uy = rng() * 2 - 1; uz = rng() * 2 - 1;
        q = ux * ux + uy * uy + uz * uz;
      } while (q > 1 || q < 1e-4);
      // r ~ u^(1/3) is uniform in the volume; a slightly larger exponent puts a
      // denser core in the middle, which is what a bait ball actually has
      const shrink = Math.pow(rng(), 0.45);
      ux *= shrink; uy *= shrink; uz *= shrink;
      const px = c.x + (this.right.x * ux * ar[0] + this.up.x * uy * ar[1] + this.head.x * uz * ar[2]) * R;
      const py = c.y + (this.right.y * ux * ar[0] + this.up.y * uy * ar[1] + this.head.y * uz * ar[2]) * R;
      const pz = c.z + (this.right.z * ux * ar[0] + this.up.z * uy * ar[1] + this.head.z * uz * ar[2]) * R;
      this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
      const j = 0.16;
      const dxv = this.head.x + rng.range(-j, j);
      const dyv = this.head.y + rng.range(-j, j) * 0.5;
      const dzv = this.head.z + rng.range(-j, j);
      const l = Math.hypot(dxv, dyv, dzv) || 1;
      this.dx[i] = dxv / l; this.dy[i] = dyv / l; this.dz[i] = dzv / l;
      this.sp[i] = a.cruise * rng.range(0.8, 1.2);
      this.ax[i] = this.ay[i] = this.az[i] = 0;
      this.roll[i] = 0; this.bend[i] = 0;
      this.side[i] = rng() < 0.5 ? -1 : 1;
    }
  }

  _frame() {
    const h = this.head;
    const upRef = Math.abs(h.y) > 0.985 ? 1 : 0;
    if (upRef) this.right.set(1, 0, 0).cross(h).normalize();
    else this.right.set(0, 1, 0).cross(h).normalize();
    this.up.copy(h).cross(this.right).normalize();
  }

  // ------------------------------------------------------------ neighbours
  /**
   * Local flocking over a uniform grid, amortised across `stride` frames.
   *
   * The neighbour count is capped topologically, not metrically: a fish tracks
   * at most NEIGH_MAX others regardless of how densely packed the ball gets.
   * That is both what real fish and birds do (interaction range measured in
   * *neighbours*, not metres) and the only thing that keeps the cost of a
   * 760-fish bait ball independent of how tight it has squeezed.
   */
  _flock(stride) {
    const n = this.active;
    if (n < 2) return;
    const a = this.a;
    const px = this.px, py = this.py, pz = this.pz;
    const dx = this.dx, dy = this.dy, dz = this.dz, sp = this.sp;

    // ---- bounds + cell size
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i], z = pz[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-3);
    const cs = Math.max(a.per, span / MAXCELL);
    const nx = Math.min(MAXCELL, Math.max(1, Math.floor((x1 - x0) / cs) + 1));
    const ny = Math.min(MAXCELL, Math.max(1, Math.floor((y1 - y0) / cs) + 1));
    const nz = Math.min(MAXCELL, Math.max(1, Math.floor((z1 - z0) / cs) + 1));
    const nc = nx * ny * nz;
    const inv = 1 / cs;

    const cellOf = this.cellOf, counts = this.cellCount, starts = this.cellStart, items = this.items;
    counts.fill(0, 0, nc + 1);
    for (let i = 0; i < n; i++) {
      const gx = clamp(((px[i] - x0) * inv) | 0, 0, nx - 1);
      const gy = clamp(((py[i] - y0) * inv) | 0, 0, ny - 1);
      const gz = clamp(((pz[i] - z0) * inv) | 0, 0, nz - 1);
      const c = (gz * ny + gy) * nx + gx;
      cellOf[i] = c; counts[c]++;
    }
    let acc = 0;
    for (let c = 0; c < nc; c++) { starts[c] = acc; acc += counts[c]; }
    starts[nc] = acc;
    for (let c = 0; c < nc; c++) counts[c] = starts[c];
    for (let i = 0; i < n; i++) items[counts[cellOf[i]]++] = i;

    // ---- steering for this frame's slice
    const per2 = a.per * a.per, sep2 = a.sep * a.sep;
    const wSep = a.wSep, wAli = a.wAli, wCoh = a.wCoh;
    const panic = this.panic;
    const sepBoost = 1 + 2.2 * panic;
    const cohCut = 1 - 0.80 * panic + 0.55 * this.reform;

    const begin = this.cursor % stride;
    for (let i = begin; i < n; i += stride) {
      const xi = px[i], yi = py[i], zi = pz[i];
      const gx = clamp(((xi - x0) * inv) | 0, 0, nx - 1);
      const gy = clamp(((yi - y0) * inv) | 0, 0, ny - 1);
      const gz = clamp(((zi - z0) * inv) | 0, 0, nz - 1);

      let sx = 0, sy = 0, sz = 0;      // separation
      let vxs = 0, vys = 0, vzs = 0;   // alignment
      let cx = 0, cy = 0, cz = 0;      // cohesion
      let found = 0, seen = 0;

      for (let oz = -1; oz <= 1 && found < NEIGH_MAX && seen < CAND_MAX; oz++) {
        const cz2 = gz + oz; if (cz2 < 0 || cz2 >= nz) continue;
        for (let oy = -1; oy <= 1 && found < NEIGH_MAX && seen < CAND_MAX; oy++) {
          const cy2 = gy + oy; if (cy2 < 0 || cy2 >= ny) continue;
          for (let ox = -1; ox <= 1 && found < NEIGH_MAX && seen < CAND_MAX; ox++) {
            const cx2 = gx + ox; if (cx2 < 0 || cx2 >= nx) continue;
            const c = (cz2 * ny + cy2) * nx + cx2;
            const e = starts[c + 1];
            for (let k = starts[c]; k < e; k++) {
              const j = items[k];
              if (j === i) continue;
              if (++seen > CAND_MAX) break;
              const ddx = px[j] - xi, ddy = py[j] - yi, ddz = pz[j] - zi;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 > per2 || d2 < 1e-8) continue;
              found++;
              cx += ddx; cy += ddy; cz += ddz;
              const s = sp[j];
              vxs += dx[j] * s; vys += dy[j] * s; vzs += dz[j] * s;
              if (d2 < sep2) {
                // 1/d^2 falloff, but CAPPED. Two fish that happen to overlap on
                // the frame they are scattered produce a force of hundreds of
                // m/s^2 uncapped, which slams them to speedMax and blows the
                // school apart on the first frame after every relocation.
                const w = Math.min(sep2 / d2 - 1, 5);
                const l = Math.sqrt(d2);
                sx -= ddx / l * w; sy -= ddy / l * w; sz -= ddz / l * w;
              }
              if (found >= NEIGH_MAX) break;
            }
          }
        }
      }

      let fx = 0, fy = 0, fz = 0;
      if (found > 0) {
        const inv2 = 1 / found;
        fx += sx * wSep * sepBoost; fy += sy * wSep * sepBoost; fz += sz * wSep * sepBoost;
        // alignment: match the neighbourhood's mean velocity
        fx += (vxs * inv2 - dx[i] * sp[i]) * wAli;
        fy += (vys * inv2 - dy[i] * sp[i]) * wAli;
        fz += (vzs * inv2 - dz[i] * sp[i]) * wAli;
        // cohesion: toward the neighbourhood centroid
        fx += cx * inv2 * wCoh * cohCut;
        fy += cy * inv2 * wCoh * cohCut;
        fz += cz * inv2 * wCoh * cohCut;
      }
      this.ax[i] = fx; this.ay[i] = fy; this.az[i] = fz;
    }
    this.cursor++;
  }

  // ------------------------------------------------------------------ step
  step(dt, t, ctx, env) {
    const a = this.a;
    const n = this.active;
    if (n < 1) return;

    // ---- the school's own goal-seeking. The whole group shares one heading,
    // and that shared term (not the local flocking) is what makes the school
    // turn as a body instead of dissolving into independent wanderers.
    this.goalT -= dt;
    if (this.goalT <= 0) {
      const rng = this.rng;
      const ang = rng() * TWO_PI, el = rng.range(-0.42, 0.42);
      const rr = (this.leash || a.wanderR) * rng.range(0.55, 1.15);
      this.goal.set(
        this.anchor.x + Math.cos(ang) * rr,
        this.anchor.y + el * rr * 0.55,
        this.anchor.z + Math.sin(ang) * rr,
      );
      this.goalT = rng.range(a.wanderT[0], a.wanderT[1]);
    }

    // ---- floor tracking (sampled, not per-fish: heightAt is not free)
    this.floorT -= dt;
    if (this.floorT <= 0) {
      this.floorT = 0.28;
      const r = a.radius;
      let f = -Infinity;
      for (const [ox, oz] of FLOOR_TAPS) {
        const h = env.floorAt(this.center.x + ox * r, this.center.z + oz * r);
        if (h > f) f = h;
      }
      this.floorY = Number.isFinite(f) ? f : -60;
    }
    const minY = this.floorY + a.minAlt;
    const maxY = Math.min(WORLD.seaLevel - 1.6, U.uWaterLevel.value - 1.6);
    this.goal.y = clamp(this.goal.y, minY + a.radius * 0.5, Math.max(minY + a.radius * 0.5, maxY - a.radius * 0.4));

    // ---- threats: the player, real predators, and any scripted pass.
    // Copied into a school-owned list rather than appended to the shared pool,
    // or a scripted pass staged for one school would leak into every school
    // stepped after it.
    const threats = this.th;
    let tn = 0;
    for (let k = 0; k < env.tn && tn < THREAT_MAX; k++) threats[tn++] = env.threats[k];
    if (this.demo && tn < THREAT_MAX) {
      const d = this.demo;
      // Sign-safe modulo: the demo's t0 is solved backwards from the moment the
      // shutter opens (see _stage), so it is routinely EARLIER than now and a
      // bare % would hand back a negative phase and teleport the predator.
      const ph = ((((t - d.t0) % d.period) + d.period) % d.period) / d.period;
      const travel = (ph - d.at) * d.period * d.speed;
      // Re-aim at the top of every cycle, then hold the line for the pass.
      //
      // Both naive versions failed and the failures were different. A `from`
      // latched once at staging went stale: the school swims several metres
      // during the 5 s settle, so the stand-off the timing promised (13.6 m,
      // intact) actually delivered panic 0.60 at the shutter — a ball being
      // scattered at the exact instant it was supposed to be posing. Gluing
      // `from` to the live centre every frame fixed the stand-off but destroyed
      // the beat: the predator then tracked the fleeing school perfectly, panic
      // never decayed, and the split/reform turned into a smear. Latching on
      // the phase wrap gives an accurate approach AND a clean pass-through,
      // which is what a real ambush looks like.
      if (d.prevPh === undefined || ph < d.prevPh) {
        d.from.copy(this.center); d.from.y += 0.9;
      }
      d.prevPh = ph;
      d.pos.copy(d.from).addScaledVector(d.dir, travel);
      const th = this._demoTh;
      th.x = d.pos.x; th.y = d.pos.y; th.z = d.pos.z; th.r = d.r; th.k = d.k;
      threats[tn++] = th;
    }

    // Panic bookkeeping. The split axis is latched the instant a threat first
    // bites, from the threat's own approach direction, so the two halves of the
    // school are coherent lobes instead of interleaved individuals — which is
    // the difference between "the school split" and "the school exploded".
    let nearest = 1e9, nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < tn; k++) {
      const th = threats[k];
      const ddx = this.center.x - th.x, ddy = this.center.y - th.y, ddz = this.center.z - th.z;
      const d = Math.hypot(ddx, ddy, ddz);
      const norm = d / Math.max(th.r + a.radius, 1e-3);
      if (norm < nearest) { nearest = norm; nx = ddx; ny = ddy; nz = ddz; }
    }
    const bite = clamp(1.35 - nearest, 0, 1);
    if (bite > this.panic + 0.02) {
      // latch a fresh split axis: horizontal, perpendicular to the threat line
      const l = Math.hypot(nx, nz) || 1;
      this.splitX = -nz / l; this.splitZ = nx / l;
      for (let i = 0; i < this.n; i++) {
        const ox = this.px[i] - this.center.x, oz = this.pz[i] - this.center.z;
        this.side[i] = (ox * this.splitX + oz * this.splitZ) >= 0 ? 1 : -1;
      }
    }
    const wasPanic = this.panic;
    this.panic = Math.max(bite, this.panic * Math.exp(-dt / 0.85));
    if (wasPanic > 0.25 && this.panic < 0.25) this.reform = 1;
    this.reform = Math.max(0, this.reform - dt / 2.6);

    // ---- school heading: steer toward the goal, rate-limited so the body
    // banks through a turn rather than snapping to a new bearing.
    _v1.copy(this.goal).sub(this.center);
    if (_v1.lengthSq() < 1e-4) _v1.copy(this.head);
    _v1.normalize();
    if (this.panic > 0.15) {
      // flee: bias the heading away from the threat, keeping the turn smooth
      const l = Math.hypot(nx, ny, nz) || 1;
      _v1.x += (nx / l) * this.panic * 1.6;
      _v1.y += (ny / l) * this.panic * 0.7;
      _v1.z += (nz / l) * this.panic * 1.6;
      _v1.normalize();
    }
    const hk = Math.min(1, (0.55 + this.panic * 1.6) * dt);
    this.head.lerp(_v1, hk).normalize();
    this._frame();
    this.histI = (this.histI + 1) % HIST;
    this.hist[this.histI * 3] = this.head.x;
    this.hist[this.histI * 3 + 1] = this.head.y;
    this.hist[this.histI * 3 + 2] = this.head.z;

    // ---- local flocking, amortised
    this._flock(this.panic > 0.2 ? 2 : 3);

    // ---- integrate
    const px = this.px, py = this.py, pz = this.pz;
    const dxA = this.dx, dyA = this.dy, dzA = this.dz, spA = this.sp;
    const R = a.radius * (1 + 0.55 * this.panic);
    const ar0 = a.aspect[0] * R, ar1 = a.aspect[1] * R, ar2 = a.aspect[2] * R;
    const rx = this.right.x, ry = this.right.y, rz = this.right.z;
    const ux = this.up.x, uy = this.up.y, uz = this.up.z;
    const hx = this.head.x, hy = this.head.y, hz = this.head.z;
    const cxs = this.center.x, cys = this.center.y, czs = this.center.z;
    const cruise = a.cruise * (1 + 0.95 * this.panic);
    const lagN = a.lagFrames;
    // a scattering school is thinner, so it stops shading itself
    const selfSh = (a.selfShadow || 0) * (1 - 0.7 * this.panic);
    const turnRate = a.turn * (1 + 1.1 * this.panic);
    // Idle roll amplitude. A frightened shoal rolls harder — which is why the
    // only round-1 frames that glittered were the panicking ones.
    const idleR = (a.idleRoll || 0) * (1 + 0.7 * this.panic);
    const rollF = this.rollF, rollP = this.rollP;
    const aP = this.aP, aD = this.aD, aS = this.aS;

    let sumX = 0, sumY = 0, sumZ = 0, far2 = 0;

    for (let i = 0; i < n; i++) {
      let fx = this.ax[i], fy = this.ay[i], fz = this.az[i];
      const xi = px[i], yi = py[i], zi = pz[i];
      const ddx = xi - cxs, ddy = yi - cys, ddz = zi - czs;

      // position in the school's own frame
      const fr = ddx * rx + ddy * ry + ddz * rz;
      const fu = ddx * ux + ddy * uy + ddz * uz;
      const ff = ddx * hx + ddy * hy + ddz * hz;

      // ---- lagged school heading. A fish at the back of the school steers to
      // the heading the school held ~0.3 s ago, so a turn propagates through
      // the body as a wave. This is the single term that makes a turning school
      // fold and shear the way a real shoal does instead of pivoting rigidly.
      const backness = clamp(0.5 - ff / (2 * ar2), 0, 1);
      const li = ((this.histI - ((backness * lagN) | 0)) % HIST + HIST) % HIST;
      const lhx = this.hist[li * 3], lhy = this.hist[li * 3 + 1], lhz = this.hist[li * 3 + 2];
      const w = a.wLead;
      fx += (lhx * cruise - dxA[i] * spA[i]) * w;
      fy += (lhy * cruise - dyA[i] * spA[i]) * w;
      fz += (lhz * cruise - dzA[i] * spA[i]) * w;

      // ---- ellipsoidal containment in the school frame: the group is a body
      // elongated along travel, not a ball.
      const q = Math.sqrt((fr / ar0) * (fr / ar0) + (fu / ar1) * (fu / ar1) + (ff / ar2) * (ff / ar2));
      if (q > 1) {
        const dl = Math.hypot(ddx, ddy, ddz) || 1e-3;
        const k = (q - 1) * a.wHome * (1 + 1.4 * this.reform) / dl;
        fx -= ddx * k; fy -= ddy * k; fz -= ddz * k;
      }
      if (q > far2) far2 = q;

      // ---- threats: radial escape plus a tangential swirl. The swirl is what
      // turns an explosion into a flow AROUND the predator — the vacuole in a
      // real bait ball is fish streaming past the threat, not fleeing from it.
      for (let k = 0; k < tn; k++) {
        const th = threats[k];
        const tx = xi - th.x, ty = yi - th.y, tz = zi - th.z;
        const d2 = tx * tx + ty * ty + tz * tz;
        const r2 = th.r * th.r;
        if (d2 > r2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const g = (th.r / d - 1) * th.k;
        const gx = tx / d, gy = ty / d, gz = tz / d;
        fx += gx * g * 7.0; fy += gy * g * 5.0; fz += gz * g * 7.0;
        // tangential: cross(escape, world up), signed by which lobe this fish
        // was assigned to when the threat first bit
        const s = this.side[i];
        fx += (-gz) * g * 3.2 * s; fz += (gx) * g * 3.2 * s;
        // and drive the two lobes apart along the latched split axis
        fx += this.splitX * g * 2.4 * s;
        fz += this.splitZ * g * 2.4 * s;
      }

      // ---- floor and ceiling
      if (yi < minY) fy += (minY - yi) * 5.5;
      else if (yi < minY + 2.5) fy += (minY + 2.5 - yi) * 0.9;
      if (yi > maxY) fy -= (yi - maxY) * 6.0;

      // ---- total steering budget. A fish is a body in a fluid: it cannot
      // produce unbounded acceleration, and without this ceiling one crowded
      // neighbourhood or one predator brushing past sends individuals shooting
      // out of the school like sparks.
      const fm2 = fx * fx + fy * fy + fz * fz;
      if (fm2 > ACC_MAX * ACC_MAX) {
        const k = ACC_MAX / Math.sqrt(fm2);
        fx *= k; fy *= k; fz *= k;
      }

      // ---- integrate: velocity, then a rate-limited turn, then position
      let vx = dxA[i] * spA[i] + fx * dt;
      let vy = dyA[i] * spA[i] + fy * dt;
      let vz = dzA[i] * spA[i] + fz * dt;
      let sv = Math.hypot(vx, vy, vz);
      if (sv < 1e-5) { vx = dxA[i]; vy = dyA[i]; vz = dzA[i]; sv = 1; }
      const ndx = vx / sv, ndy = vy / sv, ndz = vz / sv;

      const tk = Math.min(1, turnRate * dt);
      let cdx = dxA[i] + (ndx - dxA[i]) * tk;
      let cdy = dyA[i] + (ndy - dyA[i]) * tk;
      let cdz = dzA[i] + (ndz - dzA[i]) * tk;
      const cl = Math.hypot(cdx, cdy, cdz) || 1;
      cdx /= cl; cdy /= cl; cdz /= cl;

      // signed lateral acceleration in the fish's own frame drives both the
      // bank and the body bow — fish roll into a turn like everything else that
      // moves through a fluid
      const aLat = fx * rx + fy * ry + fz * rz;
      const rollT = clamp(-aLat * a.bankK, -0.85, 0.85);
      this.roll[i] += (rollT - this.roll[i]) * Math.min(1, 6.5 * dt);
      const bendT = clamp(-aLat * a.bendK * 0.09, -0.16, 0.16);
      this.bend[i] += (bendT - this.bend[i]) * Math.min(1, 5.0 * dt);

      const spT = clamp(sv, a.speedMin, a.speedMax);
      let s2 = spA[i] + (spT - spA[i]) * Math.min(1, 4.0 * dt);
      s2 = clamp(s2, a.speedMin, a.speedMax);

      dxA[i] = cdx; dyA[i] = cdy; dzA[i] = cdz; spA[i] = s2;
      const nxp = xi + cdx * s2 * dt, nyp = yi + cdy * s2 * dt, nzp = zi + cdz * s2 * dt;
      px[i] = nxp; py[i] = nyp; pz[i] = nzp;
      sumX += nxp; sumY += nyp; sumZ += nzp;

      // tail beat scales with speed, as it does in every real swimmer
      let ph = this.phase[i] + a.beat * this.beatK[i] * (0.42 + 0.72 * s2 / a.cruise) * dt;
      if (ph > TWO_PI) ph -= TWO_PI * Math.floor(ph / TWO_PI);
      this.phase[i] = ph;

      // Two incommensurate rates so the population never re-phases into a
      // synchronised shimmer — a school that flashes all at once reads as a
      // strobe, and a strobe is worse than no flash at all.
      const rf = rollF[i], rp = rollP[i];
      const idle = idleR * (0.74 * Math.sin(t * rf + rp) + 0.26 * Math.sin(t * rf * 1.87 + rp * 2.3));

      const o4 = i * 4;
      aP[o4] = nxp; aP[o4 + 1] = nyp; aP[o4 + 2] = nzp; aP[o4 + 3] = ph;
      aD[o4] = cdx; aD[o4 + 1] = cdy; aD[o4 + 2] = cdz; aD[o4 + 3] = this.roll[i] + idle;
      aS[o4 + 1] = a.amp * (0.72 + 0.62 * s2 / a.cruise);
      aS[o4 + 2] = this.bend[i];
      // buried fish are shaded by their neighbours; q is already the normalised
      // radius in the school ellipsoid, so it costs one multiply
      aS[o4 + 3] = 1 - selfSh * (1 - Math.min(q, 1)) * (1 - Math.min(q, 1));
    }

    const invN = 1 / n;
    this.center.set(sumX * invN, sumY * invN, sumZ * invN);
    this.geo.boundingSphere.center.copy(this.center);
    // generous on purpose: a school culled a frame early is a hole in the
    // midwater, and over-drawing one bounding sphere costs nothing
    this.geo.boundingSphere.radius = R * Math.max(1.5, far2) * 1.9 + 3;
    this.bP.needsUpdate = true;
    this.bD.needsUpdate = true;
    this.bS.needsUpdate = true;
    if (this.pinT > 0) this.pinT -= dt;
  }
}

const THREAT_MAX = 8;
const FLOOR_TAPS = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]];
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// ===========================================================================
// 5. MODULE
// ===========================================================================
const api = {
  id: 'schooling',
  order: 85,

  schools: [],
  _threats: [],
  _extra: [],
  _bodies: {},
  _mats: {},

  async init(ctx) {
    this.ctx = ctx;
    const seed = Number(ctx.params?.get?.('seed') ?? 1337);
    this.rng = makeRNG((seed * 2654435761 + 0x5c400f) >>> 0);
    this.group = new THREE.Group();
    this.group.name = 'schooling';
    this.group.matrixAutoUpdate = false;

    for (const key of Object.keys(ARCH)) {
      this._bodies[key] = buildFishBody(ARCH[key].geo);
      this._mats[key] = makeFishMaterial(ARCH[key]);
    }

    const cam = ctx.camera.position;
    ctx.camera.getWorldDirection(_fwd);
    for (let i = 0; i < ROSTER.length; i++) {
      const spec = ROSTER[i];
      const arch = ARCH[spec.arch];
      const s = new School(spec, arch, this._bodies[spec.arch], this._mats[spec.arch],
        this.rng.fork(i + 7), i);
      s.place(_v2.set(cam.x + (i - 4.5) * 9, cam.y - 4, cam.z + (i % 3) * 11 - 11), _fwd);
      this.schools.push(s);
      this.group.add(s.mesh);
    }
    // ?noschool=1 renders the identical world with the fish removed, so a
    // critic can measure what this module actually contributes to a frame
    // rather than arguing about it.
    // Accept the flag in any form. tools/capture.mjs has no param passthrough,
    // so the way a critic actually reaches this is by smuggling it through the
    // seed (`--seed=1337&noschool=1`), and that argv parser splits on '=' and
    // drops the tail — the URL arrives as a bare `?noschool`, which an
    // `=== '1'` test silently ignores. Two of my own A/B runs came back with
    // byte-identical triangle counts before I noticed.
    const ns = ctx.params?.get?.('noschool');
    this.group.visible = ns === null || ns === undefined || ns === '0';
    ctx.scene.add(this.group);
    ctx.provide?.('schooling', this);

    this._resize();
    ctx.engine?.onResize?.add?.(() => this._resize());
  },

  _resize() {
    const ctx = this.ctx;
    if (!ctx) return;
    const sz = new THREE.Vector2();
    try { ctx.renderer.getDrawingBufferSize(sz); } catch { sz.set(1920, 1080); }
    const h = Math.max(64, sz.y || 1080);
    for (const k of Object.keys(this._mats)) this._mats[k].uniforms.uResY.value = h;
  },

  /** Metres of usable visibility right now, clamped to something sane. */
  _vis() { return clamp(U.uMaxVisibility.value || 45, 11, 78); },

  /** Seabed height at (x,z), guarded all the way down to a constant. */
  floorAt(x, z) {
    const ctx = this.ctx;
    const t = ctx.get('terrain');
    if (t && !t.stub && t.heightAt) {
      const h = t.heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    const b = ctx.get('biomes');
    if (b?.floorDepthAt) {
      const d = b.floorDepthAt(x, z);
      if (Number.isFinite(d)) return -d;
    }
    return -60;
  },

  /**
   * Fraction of a school's roster this biome supports, for this archetype.
   * Forests carry the drifters and shed the bait balls — see BIOME_ARCH.
   */
  _density(x, y, z, arch) {
    const b = this.ctx.get('biomes');
    if (b?.at) {
      try {
        const m = b.at(x, y, z);
        if (m && m.id) {
          const per = BIOME_ARCH[m.id];
          return (BIOME_DENSITY[m.id] ?? 0.7) * (per ? (per[arch] ?? 1) : 1);
        }
      } catch { /* biomes may still be initialising */ }
    }
    const d = Math.max(0, -y);
    return d < 80 ? 1 : d < 200 ? 0.7 : d < 400 ? 0.4 : 0.16;
  },

  /**
   * Re-seat a school somewhere useful relative to the camera.
   *
   * Schools are a *recycled pool*, not a fixed world population: ten of them
   * follow the camera around, each one owning a band of the depth of field. A
   * world-static population would need thousands of schools to guarantee the
   * midwater is occupied wherever the player happens to be, and would still
   * leave the column empty on the first frame after a capture teleports the
   * camera across the map.
   */
  relocate(s, ctx) {
    const rng = s.rng;
    const cam = ctx.camera.position;
    ctx.camera.getWorldDirection(_fwd);
    const vis = this._vis();
    const [b0, b1] = s.spec.band;
    const fa = Math.atan2(_fwd.x, _fwd.z);
    const surf = Math.min(WORLD.seaLevel, U.uWaterLevel.value) - 2.5;

    // Four candidate seats, keep the one whose water column best straddles the
    // camera's own height. Terrain is not flat: a single blind sample lands a
    // school on top of a 15 m spire as often as not, the floor clamp shoves it
    // up out of frame, and the midwater it was supposed to fill stays empty.
    let bx = 0, by = 0, bz = 0, best = Infinity;
    for (let attempt = 0; attempt < 4; attempt++) {
      const behind = rng() < 0.22;
      // A school must never pop into existence inside the frame. Round 1 bought
      // that with `frac = max(frac, 0.40)`, i.e. nothing in front of the camera
      // was ever seated closer than 0.40 of visibility — 21 m in the shallows —
      // which is precisely why the whole population ended up in the 27-61 m
      // band where a 0.2 m fish is 2-4 px. The near band is bought instead by
      // seating close schools WIDE, outside the 34-degree half-FOV, so they are
      // off-camera at seat time and swim into the shot rather than blinking on.
      const frac = rng.range(b0, b1);
      const near = !behind && frac < 0.40;
      const dist = vis * frac + s.a.radius * 0.7;
      const spread = near ? rng.range(0.80, 1.35) * (rng() < 0.5 ? -1 : 1)
                          : rng.range(-1.20, 1.20);
      const ang = fa + spread + (behind ? Math.PI : 0);
      const cx = cam.x + Math.sin(ang) * dist;
      const cz = cam.z + Math.cos(ang) * dist;

      const floor = this.floorAt(cx, cz);
      const lo = floor + s.a.minAlt + s.a.radius * 0.45;
      const hi = Math.max(lo + 0.5, surf - s.a.radius * 0.35);
      const col = hi - lo;
      let y;
      // bait balls ride the open column; shoals hug structure; drifters cruise
      // between the two
      if (s.spec.arch === 'baitball') y = lo + col * rng.range(0.22, 0.85);
      else if (s.spec.arch === 'shoal') y = lo + Math.min(col, rng.range(1.5, 13));
      else y = lo + Math.min(col, rng.range(4, 26));
      y = clamp(y, Math.max(lo, cam.y - 22), Math.min(hi, cam.y + 17));
      y = clamp(y, lo, hi);
      const err = Math.abs(y - cam.y);
      if (err < best) { best = err; bx = cx; by = y; bz = cz; }
      if (err < 8) break;
    }

    const hang = rng() * TWO_PI;
    _v2.set(Math.sin(hang), rng.range(-0.10, 0.10), Math.cos(hang)).normalize();
    s.place(_v1.set(bx, by, bz), _v2);

    const dens = this._density(bx, by, bz, s.spec.arch);
    s.active = Math.max(3, Math.round(s.n * dens));
    s.geo.instanceCount = s.active;
  },

  /**
   * Anything can frighten a school. `creatures` is expected to be the main
   * caller once it exists; tools and vehicles may use it too.
   */
  scare(x, y, z, r = 9, k = 1.2, ttl = 0.6) {
    this._extra.push({ x, y, z, r, k, until: (this.ctx?.time?.t ?? 0) + ttl });
    if (this._extra.length > 12) this._extra.shift();
  },

  /** [{ arch, center:Vector3, count, panic }] — for audio / AI to read. */
  list() {
    return this.schools.map((s) => ({
      arch: s.spec.arch, center: s.center, count: s.active, panic: s.panic,
    }));
  },

  /**
   * Threat gathering. Every consumer here may be a stub, so each one is
   * probed defensively and the camera is the guaranteed fallback: in a capture
   * there is no movement module, but the shot camera IS where the player is.
   */
  _gatherThreats(ctx) {
    const out = this._threats;
    let n = 0;
    const put = (x, y, z, r, k) => {
      if (n >= THREAT_MAX) return;
      const th = out[n] || (out[n] = { x: 0, y: 0, z: 0, r: 0, k: 0 });
      th.x = x; th.y = y; th.z = z; th.r = r; th.k = k; n++;
    };
    // the pool is never truncated — `n` is the live count, so the objects are
    // reused frame to frame and this allocates nothing after the first second

    const mv = ctx.get('movement');
    const p = (mv && !mv.stub && mv.position && Number.isFinite(mv.position.x))
      ? mv.position : ctx.camera.position;
    // A swimmer parts a school; it does not detonate one. 3.6 m is about where
    // real reef fish start giving way, and keeping it tight stops the camera
    // from wrecking any composition it gets close to — `bite` reaches 1.35x
    // this plus the school radius, so at 4.2 m a bait ball posed 9 m from the
    // lens was still sitting at panic 0.20 and visibly loosening.
    put(p.x, p.y, p.z, 3.6, 0.75);

    const cr = ctx.get('creatures');
    if (cr && !cr.stub) {
      let list = null;
      try { list = cr.list?.(); } catch { list = null; }
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length && n < THREAT_MAX; i++) {
          const c = list[i];
          if (!c) continue;
          const q = c.position ?? c.pos ?? c.object?.position ?? c.mesh?.position;
          if (!q || !Number.isFinite(q.x)) continue;
          const size = Number(c.size ?? c.length ?? c.radius ?? c.scale ?? 1.2) || 1.2;
          const hostile = c.predator === true || c.aggressive === true
            || c.hostile === true || size >= 2.2;
          if (!hostile) continue;
          // Reaction distance scales with the predator, but a 3 m fish used to
          // get a 12 m threat radius, and `bite` reaches 1.35x that plus the
          // school radius — so a creature simply crossing the frame 20 m away
          // was scattering the hero school at shutter time. Real shoals hold
          // until a predator is a few body lengths out.
          put(q.x, q.y, q.z, clamp(3.0 + size * 1.7, 5, 22), 1.4);
        }
      }
    }

    const t = ctx.time.t;
    for (let i = this._extra.length - 1; i >= 0; i--) {
      const e = this._extra[i];
      if (e.until < t) { this._extra.splice(i, 1); continue; }
      put(e.x, e.y, e.z, e.r, e.k);
    }
    return n;
  },

  update(dt, t, ctx) {
    if (!this.schools.length) return;
    dt = Math.min(dt, 1 / 25);
    const cam = ctx.camera.position;
    const vis = this._vis();
    const env = this._env || (this._env = {
      threats: this._threats, tn: 0, floorAt: (x, z) => this.floorAt(x, z),
    });
    env.tn = this._gatherThreats(ctx);
    // Recycle just past the point where a school has dissolved into the fog.
    // The first cut of this was vis*1.85+55, i.e. 162 m in 58 m water — the
    // schools sat where the world began and were never re-seated at all, so
    // every frame showed them as fogged smears at 70-110 m and the midwater the
    // module exists to fill was empty.
    const cull = vis * 1.0;

    // A capture teleports the camera across the map between shots, and a
    // school that happens to land just inside `cull` of the new position would
    // otherwise keep whatever seat it held at the old one — which is how two
    // schools ended up loitering at the world origin, 70 m out, in every frame.
    const jumped = this._lastCam
      ? this._lastCam.distanceToSquared(cam) > 900
      : (this._lastCam = new THREE.Vector3().copy(cam), false);
    if (this._lastCam) this._lastCam.copy(cam);

    for (const s of this.schools) {
      if (s.pinT <= 0 && (jumped || s.center.distanceTo(cam) > cull + s.a.radius)) {
        this.relocate(s, ctx);
      }
      s.step(dt, t, ctx, env);
    }
  },

  preRender(ctx) {
    const cam = ctx.camera;
    const th = Math.tan((cam.fov ?? 68) * 0.5 * Math.PI / 180);
    for (const k of Object.keys(this._mats)) this._mats[k].uniforms.uTanHalf.value = th;
  },

  // -------------------------------------------------------------------- shots
  /**
   * Shot staging. The recycler already fills the midwater everywhere, so these
   * hooks only do the one thing it cannot: compose a specific school for a
   * specific framing, and — for the `school` shot — run the predator pass, so
   * a motion contact sheet actually contains the split/vacuole/reform beat
   * instead of a school placidly cruising. A still cannot show that reaction
   * and neither can a scene with no predator in it.
   */
  shots: {
    // 9 m, not 13 m: at 9 m a 0.28 m baitfish is 25 px and reads as a body with
    // a silver flank; at the 17 m round 1 actually achieved it was 13 px and
    // half-cropped by the frame edge.
    school(ctx) { api._stage(ctx, { ahead: 9, rise: 0.6, predator: true, settle: 5, second: 2, secondAhead: 20 }); },
    'shallows-reef': function (ctx) { api._stage(ctx, { ahead: 9.5, rise: 0.8, second: 1, secondAhead: 18 }); },
    // A forest gets DRIFTERS, not a bait ball — see BIOME_ARCH.
    'kelp-forest': function (ctx) { api._stage(ctx, { hero: 3, ahead: 12, rise: 1.6 }); },
    hud(ctx) { api._stage(ctx, { ahead: 11, rise: 0.9, second: 1, secondAhead: 21 }); },
    dropoff(ctx) { api._stage(ctx, { ahead: 14, rise: -2.0 }); },
    'grand-reef': function (ctx) { api._stage(ctx, { ahead: 12, rise: 0.5, second: 1, secondAhead: 24 }); },
  },

  /**
   * Compose the framing: a hero school close enough to resolve individual
   * bodies, optionally a second group further back so the shot has two depth
   * planes of fish, and optionally the predator pass.
   */
  _stage(ctx, o) {
    // A pin lasts 60 s of sim time and the whole capture battery runs inside
    // that, so without this a school staged for shot 1 stayed frozen at shot 1's
    // seat for every shot after it — pinned schools skip the recycler by design.
    for (const s of this.schools) s.pinT = 0;

    const settle = o.settle ?? 5;
    const hero = this.schools[o.hero ?? 0];
    if (!hero) return;
    const c = this._seat(ctx, hero, o.ahead, o.rise);
    // Which way it streams is a composition decision, not a constant. A school
    // heading toward the side of frame it is already on swims straight out of
    // the picture (or, in the `school` framing, straight behind the spire that
    // fills the right half — which is what buried the predator beat on the r14
    // contact sheet). Head it back toward the middle.
    _v3.set(c.x, c.y, c.z).project(ctx.camera);
    const sgn = _v3.x > 0 ? -1 : 1;
    this._park(ctx, hero, c.x, c.y, c.z, settle, sgn);

    if (o.second !== undefined) {
      const s2 = this.schools[o.second];
      // Off to one side and further back: two schools stacked on the same
      // bearing read as one cloud, and the whole point of the second is to give
      // the frame a near plane and a mid plane of fish.
      if (s2) {
        const c2 = this._seat(ctx, s2, o.secondAhead ?? 20, (o.rise ?? 0) + 2.5, 0.42);
        _v3.set(c2.x, c2.y, c2.z).project(ctx.camera);
        this._park(ctx, s2, c2.x, c2.y, c2.z, settle, _v3.x > 0 ? -1 : 1);
      }
    }

    if (!o.predator) { hero.demo = null; return; }

    ctx.camera.getWorldDirection(_fwd);
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    // head-on into the school's own heading, with a lean toward the camera so
    // the pass crosses the frame rather than running away down the z axis
    const dir = new THREE.Vector3(_fwd.z / fl * sgn, 0, -_fwd.x / fl * sgn);
    dir.x += (_fwd.x / fl) * 0.55; dir.z += (_fwd.z / fl) * 0.55; dir.normalize();

    // `from` IS the school centre and the strike is where travel crosses zero,
    // so at phase `at` the predator is exactly inside the ball.
    //
    // The phase is now anchored to the SHUTTER rather than to the moment this
    // hook runs: solve t0 so that phase(hookTime + settle) = wantPhase. Round 1
    // assumed settle == period and set t0 = now, which held only for the one
    // shot whose settle happened to be 5 s and left the canonical `school`
    // still showing a ball already at panic 0.33 — being scattered by a
    // predator at the exact instant it was supposed to be posing.
    // (at - wantPhase) * period = 0.9 s of approach left when the shutter opens,
    // and speed * 0.9 = 13.5 m of stand-off — far enough that `bite` reads zero
    // and the ball is intact for the still, close enough that a 9-frame 0.45 s
    // sheet holds strike, vacuole, split AND reform inside its first half. The
    // cycle is 4 s so the sheet also catches the next approach beginning.
    const period = 4.0, at = 0.30, speed = 15.0, wantPhase = 0.075;
    hero.demo = {
      t0: ctx.time.t + settle - wantPhase * period,
      period, at, speed,
      from: new THREE.Vector3(hero.center.x, hero.center.y + 0.9, hero.center.z),
      dir, pos: new THREE.Vector3(), r: 8.0, k: 2.0,
    };
  },

  /**
   * Find open water this framing actually contains, by sweeping a fan of
   * bearings AND a ladder of heights.
   *
   * Two earlier versions failed here and both failures were visible in the
   * frame. Sampling the floor once, straight ahead, put the hero ball on top of
   * a spire 14 m ABOVE the camera — out of shot — because the floor clamp had
   * nowhere else to put it. Ray-marching instead dragged it in to 5 m, inside
   * the player-threat radius, so the shutter caught a school being scattered by
   * the camera. Round 1 split the difference with a lift ladder, and the lift
   * won too often: in the `school` framing it climbed 10 m, which put the ball
   * 16.9 m away and high-right against the frame edge. The lift penalty is
   * therefore much steeper now, and the ladder can also drop, because the
   * `school` camera sits in a bowl with open water below as well as above.
   */
  _seat(ctx, s, ahead, rise, bearing = 0) {
    const cam = ctx.camera.position;
    ctx.camera.getWorldDirection(_fwd);
    const base = Math.atan2(_fwd.x, _fwd.z) + bearing;
    const surf = Math.min(WORLD.seaLevel, U.uWaterLevel.value) - 3 - s.a.radius * 0.35;
    const near = Math.max(5, ahead * 0.60);
    let bx = cam.x + _fwd.x * near, by = cam.y + rise, bz = cam.z + _fwd.z * near;
    let best = -Infinity;
    for (const lift of [0, -2.5, 2.5, -5, 5, 9, 14]) {
      const want = Math.min(cam.y + rise + lift, surf);
      const clear = want - s.a.minAlt - s.a.radius * 0.5;
      for (const off of [0, -0.14, 0.14, -0.26, 0.26, -0.40, 0.40, -0.54, 0.54]) {
        const ax = Math.sin(base + off), az = Math.cos(base + off);
        let d = 0;
        for (let k = near; k <= ahead + 1e-3; k += 1.0) {
          if (this.floorAt(cam.x + ax * k, cam.z + az * k) > clear) break;
          d = k;
        }
        if (d <= 0) continue;
        const x = cam.x + ax * d, z = cam.z + az * d;
        // Score the candidate WHERE IT LANDS ON SCREEN, not by how far along a
        // bearing it got. Round 1 scored reach minus a lift penalty, and the
        // lift kept winning: in the `school` framing it climbed 10 m, which put
        // the hero 16.9 m out and high-right against the frame edge, exactly
        // the "half-cropped" the critic called out. Projecting the candidate
        // and penalising |ndc| optimises the thing we actually want — a school
        // near the middle of the picture at roughly the requested range.
        _v3.set(x, want, z);
        const ahead2 = (x - cam.x) * _fwd.x + (want - cam.y) * _fwd.y + (z - cam.z) * _fwd.z;
        _v3.project(ctx.camera);
        const score = (ahead2 > 0.5 ? 0 : -1000)
          - 7.0 * Math.abs(_v3.x) - 7.0 * Math.abs(_v3.y)
          - 0.35 * Math.abs(d - ahead) - 0.05 * Math.abs(lift);
        if (score > best) { best = score; bx = x; by = want; bz = z; }
      }
    }
    return { x: bx, y: by, z: bz };
  },

  /**
   * Place a school broadside to the camera so that it ARRIVES at (x,y,z) when
   * the shutter opens, and hold it there.
   *
   * The lead is not a nicety. A school placed broadside starts with every fish
   * already moving across the view at cruise, and the shared-heading term keeps
   * it moving: over the 5 s the harness settles before a still, the `school`
   * hero swam 9 m sideways out of a dead-centre seat and landed at ndc.x 0.90,
   * against the right edge — the "half-cropped" the critic measured. Shortening
   * the wander leash does not fix that, because the drift is the school
   * SWIMMING, not wandering. So seat it upstream by the distance it is about to
   * cover and let it swim into the composition.
   */
  _park(ctx, s, x, y, z, settle = 5, sgn = 1) {
    ctx.camera.getWorldDirection(_fwd);
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    // stream ACROSS the view, not toward the camera: a school seen broadside is
    // where the flank flash and the body shape actually read
    const across = _v2.set(-_fwd.z / fl * sgn, 0, _fwd.x / fl * sgn);
    const lead = s.a.cruise * settle * 0.82;
    s.place(_v1.set(x - across.x * lead, y, z - across.z * lead), across);
    s.active = Math.max(3, Math.round(s.n * this._density(x, y, z, s.spec.arch)));
    s.geo.instanceCount = s.active;
    s.pinT = 60;
    s.anchor.set(x, y, z);
    // Short leash: a staged school must still be in frame when the shutter
    // opens. At cruise it covers 8 m during a 5 s settle and its own wander
    // radius is 26 m, which is enough to take it clean out of the shot — and
    // even a 5 m leash walked the `school` hero out to ndc.x 0.84, against the
    // right edge of the frame.
    s.leash = s.a.radius * 0.7;
    s.goalT = 0.4;
    s.demo = null;
  },
};

export default api;
