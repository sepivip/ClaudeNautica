/**
 * SKY — atmosphere, day/night cycle, celestial bodies, volumetric clouds, and the
 * light every other module in the game inherits.
 *
 * OWNER: the "sky" agent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS
 * ---------------------------------------------------------------------------
 * The sky is not a gradient texture. It is a single-scattering atmosphere model
 * (Rayleigh + Mie + an ozone layer) evaluated with two LUTs, in the style of
 * Bruneton 2008 / Hillaire 2020:
 *
 *   1. TRANSMITTANCE LUT   256x64 RGBA16F, built once on the CPU.
 *      Parameterised (r, mu) with Bruneton's mapping so the horizon band gets
 *      the texel density it needs. Gives exp(-optical depth) from any altitude
 *      to space along any above-horizon ray.
 *
 *   2. SKY-VIEW LUT        128x128 RGBA16F, re-marched on the GPU each frame.
 *      Parameterised (azimuth-relative-to-sun, view elevation) with a sqrt
 *      elevation warp that packs ~half the rows into the 2 degrees around the
 *      horizon. 32 raymarch steps per texel with the phase functions already
 *      applied, so the screen pass is one texture fetch.
 *
 * That is why the sunset comes out of the model: the reddening is the sun's own
 * transmittance through 38 air masses, the "second sunset" band above the sun is
 * the planet's shadow climbing the atmosphere (sunOcclusion() below), and the
 * deep blue overhead at dusk is ozone absorption, not a colour key.
 *
 * On top of the atmosphere: a limb-darkened sun disc, a phase-lit cratered moon,
 * a banded gas giant we orbit (fixed low in the sky, phase driven by the real sun
 * direction), a procedural alien starfield with a galactic band, and a raymarched
 * volumetric cloud layer at 1.1-3.6 km lit with a 3-octave multiple-scattering
 * approximation.
 *
 * ---------------------------------------------------------------------------
 * WHAT OTHER MODULES GET FROM IT   — ctx.get('sky')
 * ---------------------------------------------------------------------------
 *   U.uSunDir / U.uSunColor / U.uSunIntensity   the KEY LIGHT — sun while it is
 *        up, moon once it sets, always pointing into the upper hemisphere so
 *        god rays and caustics still have a source at night. uSunIntensity runs
 *        3.30 at the zenith (3.15 at the shots' tod 0.42, matching the core
 *        default terrain was tuned against). At night, SUBMERGED, it carries
 *        NIGHT_LIGHT_GAIN on top of the moon's own 0.61 — see the long note at
 *        NIGHT_LIGHT_GAIN before reading that number as an irradiance. It is
 *        the light that survives the night multiply, not the light before it.
 *        sky.moonIrradiance is the uncompensated figure if you need one.
 *   U.uSkyDay            registered uniform, 1 = full day .. 0 = astronomical night
 *   U.uMoonDir           registered uniform, unit vector toward the moon
 *
 *   sky.dayFactor        the same 0..1 as a JS number
 *   sky.sunDir/.moonDir/.giantDir   unit Vector3s, world space
 *   sky.sunColor/.sunIntensity      the published key light (night-compensated)
 *   sky.moonIrradiance              the key BEFORE the night compensation
 *   sky.nightLightGain              the compensation itself, 1 above water
 *   sky.ambientColor/.ambientIntensity  hemispheric sky irradiance, linear
 *   sky.cloudCover       0..1 cloud in front of the sun right now
 *   sky.cloudCoverAt(x,z)  cloud cover over a world point
 *   sky.sunLight         THREE.DirectionalLight tracking the key light (shadowed)
 *   sky.skyLight         THREE.HemisphereLight carrying the sky/sea ambient
 *   sky.envCube          CubeTexture of the sky — for water and hull reflections
 *   sky.sunDirAt(tod) / sky.moonDirAt(tod) / sky.setTimeOfDay(t)
 *   ctx.time.timeOfDay   0..1, 0=midnight 0.25=sunrise 0.5=noon 0.75=sunset
 *
 * The sky quad also paints the BACKGROUND of every underwater frame, using the
 * exact in-scatter expression from core/underwaterMaterial.js so distant terrain
 * dissolves into it instead of silhouetting against a black void.
 *
 * NOTE ON applyUnderwater(): the sky is the medium, not geometry in the medium,
 * so it is deliberately not patched — it computes the water background itself
 * from the same U.* uniforms and the same maths.
 *
 * TEMPORARY: neither world/biomes.js nor render/underwater.js knows what time it
 * is — both publish the medium at full daylight, and underwater.js's medium pass
 * rewrites every submerged pixel's in-scatter from private uniforms at the very
 * end of the frame, which also cancels any scaling of the shared uFogColor
 * exactly. So the night is applied as one per-channel MULTIPLY over the
 * submerged frame, drawn after that pass (renderOrder 9500). One operator, no
 * boundary anywhere in frame, off entirely while the sun is up and above water
 * always. See GLSL_NIGHTBG_FRAG and _onBeforeRender(). Delete it — and the
 * ambient/visibility/caustic scaling next to it — the day underwater.js reads
 * sky.dayFactor itself; ?nodaynight=1 turns it off now.
 *
 * Debug: ?nocloud=1 ?nostars=1 ?noenv=1 ?nodaynight=1 ?skyenv=1 (PMREM env)
 *        ?cloudsun=N ?cloudamb=N — scale the two halves of the cloud radiance
 *        independently; either at 0 renders the other alone, which is how the
 *        crown/base levels were solved against the reference frames.
 *        ?nightgain=N ?nightmul=N ?nightvis=N ?skyms=N — the night light budget,
 *        the night multiply, the night visibility trim and the sky's
 *        multiple-scattering floor. ?nightgain=0 removes every light this module
 *        publishes, which is the ablation that found round 33's defect.
 */
import * as THREE from 'three';
import { U, WORLD, registerUniform } from '../core/globals.js';
import { makeRNG } from '../core/rng.js';

// ===========================================================================
// atmosphere constants (metres, 1/m)
// ===========================================================================
const Rg = 6360e3;                 // planet radius
const Rt = 6420e3;                 // top of atmosphere
const Hr = 8000;                   // Rayleigh scale height
const Hm = 1200;                   // Mie scale height
const H_ATM = Math.sqrt(Rt * Rt - Rg * Rg);   // 875671.2

/**
 * Rayleigh scattering at 680/550/440 nm. Earth's sea-level values are
 * (5.8, 13.5, 33.1)e-6. This atmosphere is denser in the short end: round 1
 * measured our clear sky at rgb(92,119,158) against the reference's
 * rgb(93,144,206) — red matched to within 3 units while GREEN was 21 low and
 * BLUE 47 low. The sky was never too red, it was too dim in the blue-green, so
 * the amplitude goes up in G and B (not down in R) and the ratio stays honest.
 */
const BETA_R = [4.55e-6, 14.60e-6, 38.40e-6];
/**
 * Mie is spectrally flat, so it is the term that DESATURATES a sky. Earth's
 * clear-day figure is ~4e-6 and Bruneton's hazy default is 21e-6; round 1 sat at
 * 16.5e-6, which is a permanent light haze over the whole dome and cost ~0.1 of
 * mean saturation. The aureole around the sun is still explicit in celestial().
 */
const BETA_M = 10.5e-6;            // Mie scattering
const MIE_ALBEDO = 0.9;
const BETA_M_EXT = BETA_M / MIE_ALBEDO;
const MIE_G = 0.76;
// Ozone: pure absorption, tent profile centred at 25 km. This is what keeps the
// twilight zenith deep blue instead of muddy grey.
const BETA_O = [0.650e-6, 1.881e-6, 0.085e-6];

// Isotropic multiple-scattering approximation, in phase-function units
// (1/4pi = 0.0796). Skewed blue because that is the channel that scatters most
// and therefore multiply-scatters most; it is what keeps the anti-solar sky and
// the twilight band from collapsing to black without a full MS LUT.
const MS_ISO = [0.0030, 0.0125, 0.0310];
/**
 * Relative spectral irradiance of this system's star. Round 1 used
 * (1, 0.965, 0.905) — a star REDDER than the Sun, which quietly suppressed the
 * blue end of every scattering integral. The real solar spectrum peaks in the
 * blue-green (ASTM E490 at 440/550/680 nm is roughly 1.25/1.28/1.0 relative), so
 * this is both bluer *and* more physical. It feeds the sky, the sun disc and the
 * cloud deck; the KEY LIGHT published to the rest of the world is derived from
 * atmospheric transmittance alone and is deliberately untouched by it.
 */
const SUN_IRR = [1.0, 1.15, 1.25];
const SOLAR_SCALE = 8.0;             // sets absolute sky brightness in linear HDR
const SUN_PEAK_I = 3.30;              // U.uSunIntensity at the zenith (core default is 3.2 at tod .42)

// ===========================================================================
// orbital geometry
// ===========================================================================
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
/** azimuth convention used everywhere here: phi = atan2(dir.x, -dir.z) */
const azVec = (a) => new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));

const SUN_AZ_RISE = -45 * DEG;        // where the sun comes up
const SUN_TILT = 20 * DEG;            // orbit tilt, so noon is not dead overhead
const E_AX = azVec(SUN_AZ_RISE);
const N_AX = azVec(SUN_AZ_RISE + Math.PI / 2);

// The moon runs a slightly slower orbit on its own node, so its phase evolves
// across days instead of being locked full. Constants chosen so it is high and
// ~93% lit at tod 0.88 (the night-shallows framing) and rises full at dusk.
const MOON_RATE = 0.928;
const MOON_OFFSET = 3.72;
const MOON_TILT = -13 * DEG;

// We are a moon of the gas giant, so it sits almost fixed in the sky. Placed low
// and to the left of the surface-above framing; its phase is driven by the real
// sun direction, which makes it a thin blazing crescent at midday and a near-full
// disc opposite the setting sun.
const GIANT_AZ = -63 * DEG;
const GIANT_EL = 21 * DEG;
const GIANT_ANG_R = 0.240;            // 13.7 deg — 27 deg across, the scale surface-above-4 gives it
const MOON_ANG_R = 0.0350;            // 2.0 deg — 4.0 deg across, ~64 px at 1080p/68deg
const SUN_ANG_R = 0.0155;             // 0.89 deg — a touch larger than real so it reads

const DAY_LENGTH = 1200;              // seconds per full cycle

// ===========================================================================
// clouds
// ===========================================================================
const CLOUD_BOT = 1350;
const CLOUD_TOP = 3600;
/**
 * The deck is faded out over the last stretch of its own extent, and the march
 * stops entirely at CLOUD_CUT. Without this, a 2.3 km-thick deck seen from 1-6 m
 * above sea level ALWAYS presents edge-on as a solid white band welded to the
 * horizon — round 1 had exactly that across all 1920 px, and a 100% overcast
 * ceiling from the lifepod. Every reference surface frame instead has an
 * unbroken band of clear saturated blue 4-10 deg tall between the waterline and
 * the lowest cloud. atan(1350 / 16000) = 4.8 deg, which is that band.
 */
const CLOUD_FADE0 = 6500;
const CLOUD_FADE1 = 16000;
const CLOUD_CUT = 21000;
const CLOUD_OFFSET_X = 7200;
const CLOUD_OFFSET_Z = -5400;
/**
 * Scale on the DIRECT sunlight reaching the deck.
 *
 * Round 2 ran this at 0.115 against sky-ambient weights of ~1.0, i.e. it lit the
 * deck almost entirely with our own (bright, saturated) sky. Measured on
 * sky-r3a/surface-above, that put the top 40% of frame at median L 192 / p90 225
 * with B-R 79-95 everywhere — a luminous cyan haze with no neutral value in it
 * and no headroom left for a lit crown. The same band in surface-above-2
 * measures median 134 / p90 177, and its bins go NEUTRAL as they brighten:
 *   L 100-139 (clear sky)  B-R 75-84
 *   L 160-179              B-R 41
 *   L 200-219              B-R 27
 *   L 220-239              B-R 20
 * i.e. brightness comes from the sun (neutral) and blueness from the sky, and a
 * cloud that is 90% sky-lit can only ever be a blue smear. Real numbers: direct
 * normal irradiance is ~900 W/m2 against ~100 W/m2 of diffuse sky, so the deck
 * is sun-dominated by roughly 9:1 and round 2 had it backwards.
 *
 * Solved for a crown at (224,233,237) — the reference's own 220-239 bin is
 * (225,228,245) — with the shaded flank falling to ~(113,124,133).
 */
const CLOUD_SUN_K = 0.185;
const SHAPE_N = 48;                   // 3D shape noise resolution
const DETAIL_N = 32;
const SHAPE_TILE = 7200;              // metres per shape-noise tile
const DETAIL_TILE = 760;
const WEATHER_N = 256;
const WEATHER_TILE = 26000;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// ===========================================================================
// CPU atmosphere — used for the transmittance LUT, the published sun colour,
// the sky ambient, and the cloud-deck sun colour.
// ===========================================================================

/** Optical depths (Rayleigh, Mie, ozone) from radius r along a ray with cos(zenith)=mu. */
function opticalDepth(r, mu, steps = 40) {
  const disc = r * r * (mu * mu - 1);
  if (mu < 0 && disc + Rg * Rg > 0) return null;      // ray is blocked by the planet
  const tMax = -r * mu + Math.sqrt(Math.max(disc + Rt * Rt, 0));
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const a0 = i / steps, a1 = (i + 1) / steps;
    const t0 = tMax * a0 * a0, t1 = tMax * a1 * a1;
    const ds = t1 - t0;
    const tm = 0.5 * (t0 + t1);
    const rr = Math.sqrt(Math.max(r * r + 2 * tm * r * mu + tm * tm, Rg * Rg));
    const h = rr - Rg;
    odR += Math.exp(-h / Hr) * ds;
    odM += Math.exp(-h / Hm) * ds;
    odO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * ds;
  }
  return [odR, odM, odO];
}

/** exp(-tau) to space. Returns [r,g,b]; all zero if the planet is in the way. */
function transmittance(r, mu, steps = 24) {
  const od = opticalDepth(r, mu, steps);
  if (!od) return [0, 0, 0];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = Math.exp(-(BETA_R[c] * od[0] + BETA_M_EXT * od[1] + BETA_O[c] * od[2]));
  }
  return out;
}

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
/** IEEE binary32 -> binary16 bits (WebGL2 guarantees linear filtering on half-float). */
function toHalf(val) {
  _f32[0] = val;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) { bits |= 0x7c00; bits |= (e === 255 ? 0 : 1) && (x & 0x007fffff); return bits; }
  if (e < 113) { m |= 0x0800; bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1); return bits; }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

const TRANS_W = 256, TRANS_H = 64;
function buildTransmittanceLUT() {
  const data = new Uint16Array(TRANS_W * TRANS_H * 4);
  for (let j = 0; j < TRANS_H; j++) {
    const xr = (j + 0.5) / TRANS_H;
    const rho = xr * H_ATM;
    const r = Math.sqrt(rho * rho + Rg * Rg);
    const dMin = Rt - r, dMax = rho + H_ATM;
    for (let i = 0; i < TRANS_W; i++) {
      const xmu = (i + 0.5) / TRANS_W;
      const d = dMin + xmu * (dMax - dMin);
      // invert d(r,mu) -> mu; the mapping spans mu = +1 down to the horizon exactly
      const mu = d < 1e-3 ? 1 : Math.max(-1, Math.min(1, (H_ATM * H_ATM - rho * rho - d * d) / (2 * r * d)));
      const t = transmittance(r, mu, 40);
      const o = (j * TRANS_W + i) * 4;
      data[o] = toHalf(t[0]); data[o + 1] = toHalf(t[1]);
      data[o + 2] = toHalf(t[2]); data[o + 3] = toHalf(1);
    }
  }
  const tex = new THREE.DataTexture(data, TRANS_W, TRANS_H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const rayleighPhase = (c) => 0.05968310365 * (1 + c * c);
function miePhase(c, g) {
  const g2 = g * g;
  const d = Math.max(1 + g2 - 2 * g * c, 1e-4);
  return 0.11936620731 * (1 - g2) * (1 + c * c) / ((2 + g2) * Math.pow(d, 1.5));
}

/**
 * Single-scattered sky radiance along one direction. Used sparingly on the CPU
 * (5 directions/frame) to derive the hemispheric ambient the whole world sees,
 * so the ambient goes orange at dusk and blue-black at night for free.
 */
function skyRadianceCPU(dx, dy, dz, sx, sy, sz, steps = 10) {
  const r0 = Rg + 1;
  const disc = r0 * r0 * (dy * dy - 1);
  const tGround = dy < 0 && disc + Rg * Rg > 0 ? -r0 * dy - Math.sqrt(disc + Rg * Rg) : -1;
  let tMax = -r0 * dy + Math.sqrt(Math.max(disc + Rt * Rt, 0));
  if (tGround > 0) tMax = Math.min(tMax, tGround);
  const cosT = dx * sx + dy * sy + dz * sz;
  const pr = rayleighPhase(cosT), pm = miePhase(cosT, MIE_G);
  const L = [0, 0, 0], T = [1, 1, 1];
  for (let i = 0; i < steps; i++) {
    const a0 = i / steps, a1 = (i + 1) / steps;
    const t0 = tMax * a0 * a0, t1 = tMax * a1 * a1;
    const ds = t1 - t0;
    if (ds <= 0) continue;
    const tm = 0.5 * (t0 + t1);
    const px = dx * tm, py = r0 + dy * tm, pz = dz * tm;
    const rr = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(0, rr - Rg);
    const dR = Math.exp(-h / Hr), dM = Math.exp(-h / Hm);
    const dO = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    const mus = (px * sx + py * sy + pz * sz) / rr;
    const muH = -Math.sqrt(Math.max(0, 1 - (Rg * Rg) / (rr * rr)));
    const vis = smoothstep(muH - 0.007, muH + 0.007, mus);
    const Ts = vis > 0 ? transmittance(rr, Math.max(mus, muH), 16) : [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const ext = BETA_R[c] * dR + BETA_M_EXT * dM + BETA_O[c] * dO;
      const scat = BETA_R[c] * dR * pr + BETA_M * dM * pm;
      // MS_ISO must be compared against the PHASE functions (~0.06-0.12), not
      // against 1 — an isotropic phase is 1/4pi = 0.0796, and multiple scattering
      // carries roughly a third of that in a clear sky.
      const S = (scat * Ts[c] * vis + (BETA_R[c] * dR + BETA_M * dM) * MS_ISO[c]) * SUN_IRR[c] * SOLAR_SCALE;
      const sT = Math.exp(-ext * ds);
      L[c] += T[c] * S * (1 - sT) / Math.max(ext, 1e-12);
      T[c] *= sT;
    }
  }
  return L;
}

// ===========================================================================
// procedural 3D noise for the clouds (tileable Worley + value-noise fbm)
// ===========================================================================
function worleyPoints(cells, rng) {
  const n = cells * cells * cells;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = rng(); p[i * 3 + 1] = rng(); p[i * 3 + 2] = rng(); }
  return p;
}

/** Inverted, tiling Worley over a size^3 grid. 1 = cell centre (billowy). */
function worleyVolume(size, cells, rng) {
  const pts = worleyPoints(cells, rng);
  const out = new Float32Array(size * size * size);
  const c2 = cells * cells;
  const wrap = (v) => ((v % cells) + cells) % cells;
  const scale = cells / size;
  for (let z = 0; z < size; z++) {
    const fz = (z + 0.5) * scale, iz = Math.floor(fz);
    for (let y = 0; y < size; y++) {
      const fy = (y + 0.5) * scale, iy = Math.floor(fy);
      for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) * scale, ix = Math.floor(fx);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++) {
          const cz = wrap(iz + dz) * c2;
          const qzB = iz + dz;
          for (let dy = -1; dy <= 1; dy++) {
            const cy = wrap(iy + dy) * cells;
            const qyB = iy + dy;
            for (let dx = -1; dx <= 1; dx++) {
              const o = (cz + cy + wrap(ix + dx)) * 3;
              const ex = (ix + dx + pts[o]) - fx;
              const ey = (qyB + pts[o + 1]) - fy;
              const ez = (qzB + pts[o + 2]) - fz;
              const d = ex * ex + ey * ey + ez * ez;
              if (d < best) best = d;
            }
          }
        }
        out[(z * size + y) * size + x] = 1 - Math.min(1, Math.sqrt(best));
      }
    }
  }
  return out;
}

function ihash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);

/** Tiling 3D value noise with integer period. */
function valueNoise3(x, y, z, period, seed) {
  const fx = x * period, fy = y * period, fz = z * period;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fade(fx - x0), ty = fade(fy - y0), tz = fade(fz - z0);
  const w = (v) => ((v % period) + period) % period;
  const X0 = w(x0), X1 = w(x0 + 1), Y0 = w(y0), Y1 = w(y0 + 1), Z0 = w(z0), Z1 = w(z0 + 1);
  const c000 = ihash3(X0, Y0, Z0, seed), c100 = ihash3(X1, Y0, Z0, seed);
  const c010 = ihash3(X0, Y1, Z0, seed), c110 = ihash3(X1, Y1, Z0, seed);
  const c001 = ihash3(X0, Y0, Z1, seed), c101 = ihash3(X1, Y0, Z1, seed);
  const c011 = ihash3(X0, Y1, Z1, seed), c111 = ihash3(X1, Y1, Z1, seed);
  const a = lerp(lerp(c000, c100, tx), lerp(c010, c110, tx), ty);
  const b = lerp(lerp(c001, c101, tx), lerp(c011, c111, tx), ty);
  return lerp(a, b, tz);
}

const remap = (v, a, b, c, d) => c + (v - a) * (d - c) / Math.max(b - a, 1e-5);

/**
 * Signed TILING 2D fbm, built on the same integer-period value noise the cloud
 * volume uses. core/rng.js's fbm2 does not tile, and the weather map is sampled
 * with RepeatWrapping over a 26 km tile — so round 1's map had a hard
 * discontinuity down its wrap edge, which rendered as a dead-straight vertical
 * plane slicing a cloud in half (a weather-map boundary is a vertical plane in
 * the world, so it projects to a vertical line on screen). Visible in
 * surface-above at x=1420 and in surface-pod at x=1640.
 */
function tileFbm2(u, v, octaves, period, seed) {
  let s = 0, amp = 1, norm = 0, p = period;
  for (let i = 0; i < octaves; i++) {
    s += amp * (valueNoise3(u, v, 0.317, p, seed + i * 7919) * 2 - 1);
    norm += amp; amp *= 0.5; p *= 2;
  }
  return s / norm;
}

/**
 * Cloud shape volume. R = Perlin-Worley (the billowy base), GBA = Worley fbm at
 * rising frequencies used to erode the base into cauliflower edges.
 */
function buildShapeNoise(seed) {
  const rng = makeRNG(seed);
  const n = SHAPE_N;
  const w3 = worleyVolume(n, 3, rng);
  const w6 = worleyVolume(n, 6, rng);
  const w12 = worleyVolume(n, 12, rng);
  const data = new Uint8Array(n * n * n * 4);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (z * n + y) * n + x;
        const u = (x + 0.5) / n, v = (y + 0.5) / n, s = (z + 0.5) / n;
        const p = 0.55 * valueNoise3(u, v, s, 4, 991)
                + 0.28 * valueNoise3(u, v, s, 8, 173)
                + 0.17 * valueNoise3(u, v, s, 16, 57);
        const wf = 0.625 * w3[i] + 0.25 * w6[i] + 0.125 * w12[i];
        // Perlin-Worley: keeps Perlin's connectedness with Worley's puffy edges
        const pw = clamp01(remap(p, wf - 1, 1, 0, 1));
        const o = i * 4;
        data[o] = Math.round(pw * 255);
        data[o + 1] = Math.round(clamp01(wf) * 255);
        data[o + 2] = Math.round(clamp01(0.7 * w6[i] + 0.3 * w12[i]) * 255);
        data[o + 3] = Math.round(clamp01(w12[i]) * 255);
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildDetailNoise(seed) {
  const rng = makeRNG(seed);
  const n = DETAIL_N;
  const a = worleyVolume(n, 4, rng);
  const b = worleyVolume(n, 8, rng);
  const c = worleyVolume(n, 16, rng);
  const data = new Uint8Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    const o = i * 4;
    data[o] = Math.round(clamp01(a[i]) * 255);
    data[o + 1] = Math.round(clamp01(b[i]) * 255);
    data[o + 2] = Math.round(clamp01(c[i]) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A 64^2 blue-noise tile for the raymarch start offset.
 *
 * Void-and-cluster in spirit, swap-annealed in practice (Georgiev & Fajardo):
 * start from a shuffled uniform ramp and swap pairs whenever the swap lowers the
 * local energy sum exp(-|dp|^2/sigma^2 - k|dv|). Both falloffs are table lookups
 * so 120k trials cost a few milliseconds, not a second.
 *
 * Why it has to be blue and not interleaved-gradient noise: IGN is a regular
 * lattice, and at one raymarch step of amplitude it prints a visible half-tone
 * screen along every soft edge in the frame. White noise removes the screen and
 * replaces it with confetti. Blue noise has neither a visible period nor
 * low-frequency clumping, which is exactly the property a per-pixel offset needs.
 */
function buildBlueNoise(size, rng, iters = 120000) {
  const n = size, N = n * n;
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = (i + 0.5) / N;
  for (let i = N - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = v[i]; v[i] = v[j]; v[j] = t;
  }
  const R = 3, sig2 = 2.1 * 2.1;
  const spatial = new Float32Array((2 * R + 1) * (2 * R + 1));
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      spatial[(dy + R) * (2 * R + 1) + (dx + R)] =
        (dx === 0 && dy === 0) ? 0 : Math.exp(-(dx * dx + dy * dy) / sig2);
    }
  }
  const VT = 33, vt = new Float32Array(VT);
  for (let k = 0; k < VT; k++) vt[k] = Math.exp(-3.0 * (k / (VT - 1)));
  const m = n - 1;   // n is a power of two, so & is the wrap
  const energyAt = (x, y, val) => {
    let e = 0;
    for (let dy = -R; dy <= R; dy++) {
      const row = ((y + dy) & m) * n;
      const srow = (dy + R) * (2 * R + 1);
      for (let dx = -R; dx <= R; dx++) {
        const w = spatial[srow + dx + R];
        if (w === 0) continue;
        const d = val - v[row + ((x + dx) & m)];
        e += w * vt[((d < 0 ? -d : d) * (VT - 1)) | 0];
      }
    }
    return e;
  };
  for (let k = 0; k < iters; k++) {
    const x1 = (rng() * n) | 0, y1 = (rng() * n) | 0;
    const x2 = (rng() * n) | 0, y2 = (rng() * n) | 0;
    if (x1 === x2 && y1 === y2) continue;
    const i1 = y1 * n + x1, i2 = y2 * n + x2;
    const a = v[i1], b = v[i2];
    const before = energyAt(x1, y1, a) + energyAt(x2, y2, b);
    const after = energyAt(x1, y1, b) + energyAt(x2, y2, a);
    if (after < before) { v[i1] = b; v[i2] = a; }
  }
  const data = new Uint8Array(N);
  for (let i = 0; i < N; i++) data[i] = Math.min(255, (v[i] * 256) | 0);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Weather map: R = coverage, G = cloud type (0 stratus .. 1 cumulus),
 * B = a slow density multiplier that breaks up any regularity in the coverage.
 * Sampled identically on the CPU for the cloud-shadow dimming of the sun.
 */
function buildWeather(seed) {
  const n = WEATHER_N;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n, v = (y + 0.5) / n;
      const cov = clamp01(tileFbm2(u, v, 5, 5, 991) * 0.62 + 0.5);
      const typ = clamp01(tileFbm2(u, v, 3, 3, 173) * 0.90 + 0.55);
      const den = clamp01(tileFbm2(u, v, 4, 9, 613) * 0.45 + 0.68);
      const o = (y * n + x) * 4;
      data[o] = Math.round(cov * 255);
      data[o + 1] = Math.round(typ * 255);
      data[o + 2] = Math.round(den * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, data, n };
}

// ===========================================================================
// GLSL
// ===========================================================================
/**
 * NOTE ON PRECISION: everything here is written in terms of ALTITUDE, never
 * radius. In fp32 the planet radius is 6.36e6, so `r*r - Rg*Rg` cancels down to
 * ~30% error at sea level and the horizon lands in the wrong place. Every such
 * expression below is factored to keep the small quantity small:
 *     r^2 - Rg^2  ->  alt * (2*Rg + alt)
 *     Rt^2 - r^2  ->  (ATM_H - alt) * (Rt + r)
 */
const GLSL_ATMOS = /* glsl */ `
#define PI 3.141592653589793

const float Rg    = ${Rg.toFixed(1)};
const float Rt    = ${Rt.toFixed(1)};
const float ATM_H = ${(Rt - Rg).toFixed(1)};
const float Hr    = ${Hr.toFixed(1)};
const float Hm    = ${Hm.toFixed(1)};
const float Hatm  = ${H_ATM.toFixed(3)};
const vec3  BR    = vec3(${BETA_R.map((v) => v.toExponential(6)).join(', ')});
const float BM    = ${BETA_M.toExponential(6)};
const float BMe   = ${BETA_M_EXT.toExponential(6)};
const vec3  BO    = vec3(${BETA_O.map((v) => v.toExponential(6)).join(', ')});

uniform sampler2D uTrans;
uniform vec3 uSunIrr;

float rayleighPhase(float c) { return 0.05968310365 * (1.0 + c * c); }
float miePhase(float c, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * c, 1e-4);
  return 0.11936620731 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(d, 1.5));
}

void densities(float h, out float dr, out float dm, out float dz) {
  float hh = max(h, 0.0);
  dr = exp(-hh / Hr);
  dm = exp(-hh / Hm);
  dz = max(0.0, 1.0 - abs(hh - 25000.0) / 15000.0);
}

float rhoOf(float alt) { return sqrt(max(alt * (2.0 * Rg + alt), 0.0)); }

vec2 transUV(float alt, float mu) {
  float r    = Rg + alt;
  float rho  = rhoOf(alt);
  float disc = (ATM_H - alt) * (Rt + r) + r * r * mu * mu;
  float sq   = sqrt(max(disc, 0.0));
  // for upward rays the naive form cancels 6.42e6 - 6.36e6; use the conjugate
  float d    = mu > 0.0 ? ((ATM_H - alt) * (Rt + r)) / max(r * mu + sq, 1.0)
                        : (-r * mu + sq);
  float dMin = ATM_H - alt;
  float dMax = rho + Hatm;
  return vec2(clamp((d - dMin) / max(dMax - dMin, 1.0), 0.0, 1.0), clamp(rho / Hatm, 0.0, 1.0));
}
vec3 transToTop(float alt, float mu) {
  return textureLod(uTrans, transUV(clamp(alt, 0.0, ATM_H), clamp(mu, -1.0, 1.0)), 0.0).rgb;
}

/** How much of the sun's disc clears the planet's limb, seen from this altitude. */
float sunOcclusion(float alt, float mus) {
  float muH = -rhoOf(alt) / (Rg + alt);
  return smoothstep(muH - 0.007, muH + 0.007, mus);
}

/** Altitude at distance t along a ray leaving altitude camAlt with vertical dir rdy. */
float altAt(float camAlt, float rdy, float t) {
  float r = Rg + camAlt;
  float n = t * t + 2.0 * t * r * rdy + camAlt * (2.0 * Rg + camAlt);   // |p|^2 - Rg^2
  return n / (sqrt(max(n, 0.0) + Rg * Rg) + Rg);
}

/** Ray/shell intersections, again in altitude space so nothing cancels. */
float shellFar(float camAlt, float rdy, float shellAlt) {
  float b = (Rg + camAlt) * rdy;
  float c = (camAlt - shellAlt) * (2.0 * Rg + camAlt + shellAlt);
  float h = b * b - c;
  return h < 0.0 ? -1.0 : -b + sqrt(h);
}
float shellNear(float camAlt, float rdy, float shellAlt) {
  float b = (Rg + camAlt) * rdy;
  float c = (camAlt - shellAlt) * (2.0 * Rg + camAlt + shellAlt);
  float h = b * b - c;
  return h < 0.0 ? -1.0 : -b - sqrt(h);
}
`;

/** Sky-view LUT: one raymarch per texel, phases pre-applied. */
const GLSL_LUT_FRAG = /* glsl */ `
precision highp float;
${GLSL_ATMOS}
uniform vec2  uSunEl;      // (cos, sin) of the sun's elevation
uniform float uCamAlt;
uniform vec3  uMsColor;    // isotropic multiple-scattering approximation
varying vec2 vUv;

void main() {
  float s   = vUv.y * 2.0 - 1.0;
  float el  = sign(s) * s * s * (0.5 * PI);
  float phi = vUv.x * PI;
  float ce  = cos(el);
  vec3 rd = vec3(ce * cos(phi), sin(el), ce * sin(phi));
  vec2 sd = uSunEl;                       // canonical frame: the sun lies in x-y

  float tMax = shellFar(uCamAlt, rd.y, ATM_H);
  float tG   = shellNear(uCamAlt, rd.y, 0.0);
  if (tG > 0.0) tMax = min(tMax, tG);
  tMax = max(tMax, 0.0);

  float cosT = rd.x * sd.x + rd.y * sd.y;
  float pr = rayleighPhase(cosT);
  float pm = miePhase(cosT, ${MIE_G});
  float msVis = smoothstep(-0.16, 0.10, uSunEl.y);

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float a0 = float(i) / float(N);
    float a1 = float(i + 1) / float(N);
    float t0 = tMax * a0 * a0;
    float t1 = tMax * a1 * a1;
    float ds = t1 - t0;
    if (ds <= 0.0) continue;
    float t = 0.5 * (t0 + t1);
    float alt = altAt(uCamAlt, rd.y, t);
    float dr, dm, dz;
    densities(alt, dr, dm, dz);
    vec3 ext = BR * dr + vec3(BMe) * dm + BO * dz;
    vec3 sT  = exp(-ext * ds);

    // local up at the sample, then the sun's zenith cosine there
    float inv = 1.0 / (Rg + alt);
    float mus = (t * rd.x) * inv * sd.x + (Rg + uCamAlt + t * rd.y) * inv * sd.y;
    vec3 Tsun = transToTop(alt, mus) * sunOcclusion(alt, mus);

    vec3 scat = BR * dr * pr + vec3(BM * dm * pm);
    vec3 ms   = (BR * dr + vec3(BM * dm)) * uMsColor * msVis;
    vec3 S    = (scat * Tsun + ms) * uSunIrr;

    L += T * S * (1.0 - sT) / max(ext, vec3(1e-12));
    T *= sT;
    if (max(T.r, max(T.g, T.b)) < 0.002) break;
  }
  gl_FragColor = vec4(max(L, vec3(0.0)), 1.0);
}
`;

/** Everything the screen pass and the env pass share. */
const GLSL_SKY_BODY = /* glsl */ `
precision highp float;
${GLSL_ATMOS}

uniform sampler2D uSkyView;
uniform sampler2D uWeather;
uniform sampler3D uShape;
uniform sampler3D uDetail;

uniform vec3  uSunDirSky;      // true sun (not the blended key light)
uniform vec3  uMoonDir;
uniform vec3  uMoonRight;
uniform vec3  uMoonUp;
uniform vec3  uGiantDir;
uniform vec3  uGiantRight;
uniform vec3  uGiantUp;
uniform vec3  uGiantAxis;
uniform vec3  uGiantSpotT;
uniform vec2  uGiantSpot;
uniform vec2  uSunHoriz;       // normalized (sun.x, sun.z)
uniform mat3  uSkyRot;
uniform vec3  uSunDiscCol;
uniform vec3  uMoonLight;
uniform vec3  uGiantLight;
uniform vec3  uNightSky;       // airglow + integrated starlight
uniform vec3  uMoonSky;        // moonlight scattered by the air
uniform float uNight;          // 0 day .. 1 astronomical night
uniform float uCamAlt;
uniform float uSkyTime;

uniform vec2  uCloudWind;
uniform float uCloudEvolve;
uniform vec2  uCloudCoverage;  // (scale, bias)
uniform float uCloudDensity;
uniform vec3  uCloudSun;       // sunlight reaching the cloud deck
uniform vec3  uCloudAmb;
uniform vec3  uSeaColor;

uniform vec2  uCloudAmbK;      // (crown, base) weights on the sampled sky ambient
uniform float uCloudTau;       // optical depth per unit light-march density

#ifdef ENV_PASS
  #define CLOUD_STEPS 20
  #define LIGHT_STEPS 3
  #define SUN_R_MUL 3.0
  #define SUN_L_MUL 0.11
#else
  // The far clamp below cut the worst-case span from 190 km to 21 km, which is
  // what makes a step budget this fine affordable: the near field now gets
  // 40-60 m steps instead of 400 m, and that — not the dither — is what stops
  // cloud silhouettes breaking into stipple.
  #define CLOUD_STEPS 160
  #define LIGHT_STEPS 5
  #define SUN_R_MUL 1.0
  #define SUN_L_MUL 1.0
#endif

// ------------------------------------------------------------------ sky view
vec2 skyViewUV(vec3 rd) {
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float v  = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  vec2 hv  = vec2(rd.x, rd.z);
  float hl = length(hv);
  float u  = hl < 1e-5 ? 0.0 : acos(clamp(dot(hv / hl, uSunHoriz), -1.0, 1.0)) / PI;
  return vec2(u, clamp(v, 0.0015, 0.9985));
}
vec3 skyView(vec3 rd) { return textureLod(uSkyView, skyViewUV(rd), 0.0).rgb; }

// ------------------------------------------------------------------ hashes
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ------------------------------------------------------------------ stars
vec3 starField(vec3 d) {
  vec3 sd = uSkyRot * d;
  vec3 a = abs(sd);
  vec2 uv; float face;
  if (a.x >= a.y && a.x >= a.z)      { uv = sd.zy / a.x; face = sd.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z)               { uv = sd.xz / a.y; face = sd.y > 0.0 ? 2.0 : 3.0; }
  else                               { uv = sd.xy / a.z; face = sd.z > 0.0 ? 4.0 : 5.0; }

  vec3 col = vec3(0.0);
  /*
   * THREE magnitude classes over a power-law brightness distribution.
   *
   * Round 2 had two classes with pow(mag, 12): that exponent is so steep that
   * everything except the top 2% of cells falls below the visible floor, so the
   * sky ended up sparse AND uniform — a scatter of same-sized dots. A real sky
   * is the opposite: a few dozen first-magnitude stars you can name, a few
   * hundred at second and third, and a carpet of thousands below that, which is
   * roughly a factor ~2.5 in count per magnitude. pow(mag, 7) reproduces that
   * ratio, and the three grid frequencies give the carpet its density without
   * ever putting two bright stars in the same cell.
   */
  float scale = 92.0;
  float gain = 1.0;
  for (int k = 0; k < 3; k++) {
    vec2 g  = uv * scale;
    vec2 gi = floor(g);
    vec2 gf = g - gi;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 o = vec2(float(ox), float(oy));
        vec3 cell = vec3(gi + o, face * 31.0 + float(k) * 7.0);
        vec3 h = hash33(cell);
        float mag = hash13(cell + 2.7);
        float bright = pow(mag, 7.0);
        if (bright < 0.0016) continue;
        vec2 pos = o + h.xy;
        float dd = length(gf - pos);
        // The point spread stays small for faint stars and opens up for bright
        // ones — that size difference is most of what reads as "magnitude".
        float rad = 0.030 + 0.105 * pow(bright, 0.55);
        float ii = exp(-dd * dd / (rad * rad));
        float ct = h.z;
        vec3 sc = mix(vec3(0.60, 0.75, 1.0), vec3(1.0, 0.82, 0.58), smoothstep(0.30, 0.92, ct));
        if (ct > 0.962) sc = vec3(0.32, 1.0, 0.92);   // alien colour accents
        if (ct < 0.030) sc = vec3(1.0, 0.42, 0.86);
        // Scintillation is an airmass effect: strong near the horizon, almost
        // absent at the zenith, and faster for the fainter stars.
        float air = clamp(0.22 + 0.78 * (1.0 - abs(d.y)), 0.0, 1.0);
        float tw = 1.0 - air * (0.30 * (1.0 - 0.5 * bright))
                 * (0.5 + 0.5 * sin(uSkyTime * (1.1 + 3.4 * h.x) + h.y * 47.0));
        col += sc * (bright * ii * tw * gain);
      }
    }
    scale *= 2.45;
    gain *= 0.40;
  }
  return col * 11.0;
}

/** Galactic band — reuses the cloud shape volume as a cheap 3D fbm. */
vec3 galactic(vec3 d) {
  vec3 sd = uSkyRot * d;
  float b = 1.0 - clamp(abs(sd.z) * 4.4, 0.0, 1.0);
  b *= b * b;
  if (b < 0.004) return vec3(0.0);
  float n0 = textureLod(uShape, sd * 0.55 + 0.13, 0.0).r;
  float n1 = textureLod(uShape, sd * 1.70 + 0.37, 0.0).g;
  float n2 = textureLod(uShape, sd * 4.10 + 0.71, 0.0).b;
  float dust = clamp(n0 * 1.8 - 0.62, 0.0, 1.0);
  float glow = clamp(n1 * 0.75 + n2 * 0.45, 0.0, 1.0);
  vec3 c = mix(vec3(0.22, 0.34, 0.55), vec3(0.42, 0.32, 0.52), glow);
  c += vec3(0.08, 0.44, 0.40) * pow(glow, 3.0);
  return c * b * dust * 0.017;
}

// ------------------------------------------------------------------ moon
vec3 moonDisc(vec3 rd, out float cover) {
  cover = 0.0;
  float c = dot(rd, uMoonDir);
  if (c < 0.9993) return vec3(0.0);
  vec3 v = rd - uMoonDir * c;
  float x = dot(v, uMoonRight) / ${MOON_ANG_R};
  float y = dot(v, uMoonUp) / ${MOON_ANG_R};
  float r2 = x * x + y * y;
  if (r2 > 1.0) return vec3(0.0);
  float z = sqrt(max(0.0, 1.0 - r2));
  vec3 n = normalize(uMoonRight * x + uMoonUp * y - uMoonDir * z);

  float m0 = textureLod(uShape, n * 1.90 + 11.3, 0.0).r;
  float m1 = textureLod(uShape, n * 6.30 + 3.10, 0.0).b;
  float mare = smoothstep(0.40, 0.64, m0);
  float alb = mix(0.90, 0.48, mare) * (0.80 + 0.38 * m1);

  // crater relief: perturb the normal with the gradient of the fine layer
  float e = 0.010;
  float hx = textureLod(uShape, (n + uMoonRight * e) * 6.30 + 3.10, 0.0).b - m1;
  float hy = textureLod(uShape, (n + uMoonUp * e) * 6.30 + 3.10, 0.0).b - m1;
  vec3 nn = normalize(n - (uMoonRight * hx + uMoonUp * hy) * 5.0);

  float ndl = max(dot(nn, uSunDirSky), 0.0);
  float ndv = max(z, 0.03);
  float bs  = ndl / (ndl + ndv);            // Lommel-Seeliger: the Moon reads flat, not Lambertian
  vec3 col = uMoonLight * alb * bs * 2.4;
  col += uMoonLight * alb * 0.012 * (1.0 - ndl);   // planetshine on the dark limb
  cover = smoothstep(1.0, 0.984, sqrt(r2));
  return col * cover;
}

// ------------------------------------------------------------------ gas giant
vec3 giantDisc(vec3 rd, out float cover) {
  cover = 0.0;
  float c = dot(rd, uGiantDir);
  if (c < 0.965) return vec3(0.0);
  vec3 v = rd - uGiantDir * c;
  float x = dot(v, uGiantRight) / ${GIANT_ANG_R};
  float y = dot(v, uGiantUp) / ${GIANT_ANG_R};
  float r2 = x * x + y * y;
  if (r2 > 1.0) return vec3(0.0);
  float z = sqrt(max(0.0, 1.0 - r2));
  vec3 n = normalize(uGiantRight * x + uGiantUp * y - uGiantDir * z);

  float lat = dot(n, uGiantAxis);
  // turbulent warp so the bands shear and curl instead of running as straight rings
  float w1 = textureLod(uShape, n * 1.25 + 5.70, 0.0).r - 0.5;
  float w2 = textureLod(uShape, n * 3.60 + 1.30, 0.0).g - 0.5;
  float w3 = textureLod(uShape, n * 8.50 + 7.10, 0.0).b - 0.5;
  float b  = lat + w1 * 0.105 + w2 * 0.042 + w3 * 0.013;

  float band  = sin(b * 15.0) * 0.5 + 0.5;
  float band2 = sin(b * 37.0 + 1.7) * 0.5 + 0.5;
  float band3 = sin(b * 71.0 + 4.1) * 0.5 + 0.5;
  // Cream zones over umber belts. The albedo range is deliberately WIDE
  // (0.20 -> 0.95): round 2 spanned 0.30-0.97 but spent most of the disc in the
  // middle of it, and the body measured L 193-241 against a sky of L 180 —
  // 13 levels of separation over most of its area, which is what "translucent
  // soap bubble" means. Jupiter's belts and zones differ by nearly 2:1 in
  // albedo and that contrast is most of what reads as structure at this size.
  vec3 alb = mix(vec3(0.30, 0.23, 0.17), vec3(0.95, 0.86, 0.68), smoothstep(0.16, 0.84, band));
  alb = mix(alb, vec3(1.00, 0.96, 0.88), smoothstep(0.46, 0.97, band2) * 0.55);
  alb = mix(alb, vec3(0.44, 0.33, 0.25), smoothstep(0.52, 0.96, band3) * 0.34);   // fine belt ruling
  alb = mix(alb, vec3(0.74, 0.71, 0.66), smoothstep(0.70, 0.99, abs(lat)));   // polar haze

  float sLat = lat - uGiantSpot.x;
  float sLon = dot(n, uGiantSpotT) - uGiantSpot.y;
  float oval = exp(-(sLat * sLat * 140.0 + sLon * sLon * 26.0));
  alb = mix(alb, vec3(0.80, 0.40, 0.28), oval * 0.80);

  float ndl = dot(n, uSunDirSky);
  /*
   * The terminator has to be HARD. Round 1 spread it over 35 deg of surface
   * normal in the name of a thick atmosphere, which on a disc 21 deg across is
   * most of the visible face — the body came out as one soft even wash with no
   * shape to it. A real gas giant's terminator is a few degrees of forward
   * scattering wide, and in surface-above-3/-4 it is unmistakably a hard edge.
   */
  float lit  = smoothstep(-0.030, 0.060, ndl);
  float twi  = smoothstep(-0.22, 0.02, ndl) * (1.0 - lit);   // thin sunset band on the limb
  float limb = 0.58 + 0.42 * pow(max(z, 0.0), 0.55);          // gentle limb darkening
  /*
   * The unlit half is 7.5% of the lit half, not 50%.
   *
   * Round 2 ran it at 0.50 "because a deep hydrogen atmosphere carries light
   * around the limb". It does — but half a stop, not one stop short of full sun.
   * At 0.50 there is no terminator at all: the disc is one even wash, and with
   * the round-2 rim term on top of it the whole body read as a soap bubble with
   * a white edge. The night side of Jupiter is 2-4% of its day side.
   *
   * It stays WARM because what light does reach it has been forward-scattered
   * through thousands of km of hydrogen — the same reddening that paints the
   * Moon during a total eclipse.
   *
   * There is deliberately NO rim/limb-haze term. On a disc 27 deg across, a
   * pow(1-z, 5) ring is 2 deg of bright outline all the way round the body,
   * which is precisely the "white rim" read.
   */
  vec3 col = uGiantLight * alb * lit * limb
           + uGiantLight * alb * vec3(1.20, 1.00, 0.68) * (1.0 - lit) * 0.075 * (0.55 + 0.45 * z);
  col += uGiantLight * alb * twi * vec3(0.34, 0.21, 0.12);   // dusk band along the terminator

  cover = smoothstep(1.0, 0.9925, sqrt(r2));
  return col * cover;
}

// ------------------------------------------------------------------ clouds
/** type 0 = a thin stratus slab low in the layer, 1 = a tall cumulus tower. */
float cloudHeightGradient(float h, float type) {
  float stratus = smoothstep(0.0, 0.05, h) * smoothstep(0.30, 0.13, h);
  float cumulus = smoothstep(0.0, 0.11, h) * smoothstep(0.98, 0.60, h);
  return mix(stratus, cumulus, type);
}

float cloudDensity(vec3 p, float alt, float lod, float mip) {
  float h = (alt - ${CLOUD_BOT}.0) * ${(1 / (CLOUD_TOP - CLOUD_BOT)).toFixed(9)};
  if (h < 0.0 || h > 1.0) return 0.0;
  vec2 wuv = (p.xz + uCloudWind) * ${(1 / WEATHER_TILE).toExponential(8)};
  // explicit mip: the march is dynamic control flow, so implicit derivatives are
  // undefined here, and a 100 m weather texel aliases badly at 80 km
  vec3 w = textureLod(uWeather, wuv, mip).rgb;
  float coverage = clamp(w.r * uCloudCoverage.x + uCloudCoverage.y, 0.0, 1.0);
  // Tie cloud type to coverage as well as to the weather map: a cumulus field
  // builds its towers where the air is already loaded, and without this the
  // whole deck is one flat slab at a single altitude.
  // Biased hard toward the cumulus profile: the stratus slab occupies the bottom
  // 30% of the layer and reads as a flat shelf, and round 1's field was mostly
  // that. Every reference surface frame is a cumulus field with vertical
  // development and blue between the puffs.
  float grad = cloudHeightGradient(h, clamp(w.g * 1.70 - 0.05 + coverage * 0.55, 0.0, 1.0));
  if (coverage <= 0.002 || grad <= 0.0) return 0.0;

  vec3 sp = (p + vec3(uCloudWind.x, uCloudEvolve, uCloudWind.y)) * ${(1 / SHAPE_TILE).toExponential(8)};
  vec4 n = textureLod(uShape, sp, 0.0);
  float wfbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  // Perlin-Worley eroded by its own Worley fbm, then cut by coverage. The
  // density multiplier has to come AFTER the coverage cut, not before, or it
  // eats the whole field and leaves nothing but wisps.
  float base = clamp((n.r - (wfbm - 1.0)) / max(2.0 - wfbm, 1e-4), 0.0, 1.0);
  // A 48^3 tile over 5.6 km is a 117 m texel, and the isosurface of a trilinear
  // field has visible facets at that scale — cloud silhouettes came out
  // stair-stepped. A second zero-mean octave off the same volume breaks them
  // for one extra fetch, and only on the near clouds where it is visible.
  if (lod < 0.55) {
    float pw2 = textureLod(uShape, sp * 2.37 + 0.41, 0.0).r;
    base = clamp(base + (pw2 - 0.5) * 0.34 * (1.0 - lod), 0.0, 1.0);
  }
  base *= grad;
  float d = clamp((base - (1.0 - coverage)) / max(coverage, 1e-4), 0.0, 1.0);
  if (d <= 0.0) return 0.0;

  // lod is the detail fade: 1 = drop the high-frequency erosion entirely.
  // A 19 m detail texel is far below a pixel past ~10 km, so keeping it there
  // buys nothing but raymarch aliasing.
  if (lod < 0.98) {
    vec3 dp = (p + vec3(uCloudWind.x * 1.7, uCloudEvolve * 2.3, uCloudWind.y * 1.7)) * ${(1 / DETAIL_TILE).toExponential(8)};
    vec3 dn = textureLod(uDetail, dp, 0.0).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // wispy at the base, cauliflower on top
    float er = mix(dfbm, 1.0 - dfbm, clamp(h * 4.0, 0.0, 1.0)) * 0.48 * (1.0 - lod);
    d = clamp((d - er) / max(1.0 - er, 1e-4), 0.0, 1.0);
  }
  return d * (0.50 + 0.80 * w.b) * uCloudDensity;
}

// Fixed cone kernel. A per-pixel RANDOM offset here is fatal: it turns the
// shadow term into per-pixel noise and sands the whole cloud deck with grain.
const vec3 LIGHT_CONE[5] = vec3[5](
  vec3( 0.28,  0.35, -0.20), vec3(-0.31,  0.12,  0.36), vec3( 0.10, -0.38,  0.28),
  vec3(-0.25, -0.19, -0.34), vec3( 0.38,  0.05,  0.15));

float cloudLightDepth(vec3 p, float alt, vec3 ld, float mip) {
  float t = 0.0, step = 110.0, sum = 0.0;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    t += step;
    vec3 off = LIGHT_CONE[i] * (t * 0.22);
    vec3 sp = p + ld * t + off;
    sum += cloudDensity(sp, alt + ld.y * t + off.y, 1.0, mip) * step;
    step *= 1.75;
  }
  // long-range shadowing: without this, thick decks self-light like cotton wool
  sum += cloudDensity(p + ld * 2900.0, alt + ld.y * 2900.0, 1.0, mip + 1.0) * 900.0;
  return sum;
}

/** Henyey-Greenstein, normalised so an isotropic phase is exactly 1.0. */
float hgPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
/**
 * Forward peak (the silver lining) plus a backscatter lobe (the lit face).
 *
 * Clamped: an un-truncated g=0.72 lobe reaches 4.6x isotropic within 25 deg of
 * the sun, and the surface-above framing looks almost straight into it — that
 * peak alone put 1% of the frame at a flat 255. Multiple scattering flattens
 * the real forward lobe long before it gets that sharp, so the clamp is closer
 * to the physics than the raw single-scatter phase is.
 */
float cloudPhase(float c, float k) {
  return min(mix(hgPhase(c, 0.72 * k), hgPhase(c, -0.32 * k), 0.38), 0.90);
}

/** rgb = in-scattered light, a = transmittance through the deck. */
vec4 renderClouds(vec3 ro, vec3 rd, float dither, int nStepsMax) {
  int nSteps = nStepsMax;
  if (rd.y <= 0.004) return vec4(0.0, 0.0, 0.0, 1.0);
  float camAlt = max(ro.y, 0.0);
  float t0 = shellFar(camAlt, rd.y, ${CLOUD_BOT}.0);
  float t1 = shellFar(camAlt, rd.y, ${CLOUD_TOP}.0);
  if (t1 <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  t0 = max(t0, 0.0);
  t1 = min(t1, ${CLOUD_CUT}.0);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  float cosT = dot(rd, uSunDirSky);

  /*
   * THE SKY'S OWN LIGHT ON THE DECK — as an IRRADIANCE, not a horizon tap.
   *
   * This is the relationship that separates a volume from a cut-out: a cumulus
   * crown is sunlit and reads near-neutral, its base sits in its own shadow and
   * is lit only by the sky and the sea, so the base is DARK. That dark underside
   * is the most recognisable single feature of a cumulus and it is where the
   * cloud's internal dynamic range comes from.
   *
   * Round 2 had it inverted. It weighted the CROWN at 0.95x a zenith/horizon mix
   * and the BASE at 1.05x a HORIZON-weighted mix — the horizon ring is the
   * brightest, most saturated part of our sky (it measures L 222 against the
   * zenith's 160), so the underside of every cloud was lit harder than its top,
   * with cyan. The whole deck came out at L 200-255, B-R 60-95, flat.
   *
   * What actually falls on a crown is the COSINE-WEIGHTED dome, which is
   * dominated by the upper sky, not by the ring at the horizon: weighting by
   * sin(2*el) puts ~45% of the irradiance above 45 degrees and only ~16% in the
   * lowest band. What falls on a base is the sea (albedo ~0.06) plus a grazing
   * sliver of that ring, which is a small fraction of the same number.
   */
  vec3 skyZen = skyView(vec3(0.0, 1.0, 0.0));
  vec2 hxz = vec2(rd.x, rd.z);
  float hl = length(hxz);
  hxz = hl > 1e-5 ? hxz / hl : vec2(1.0, 0.0);
  vec3 skyMid = skyView(normalize(vec3(hxz.x, 0.60, hxz.y)));   // 31 deg
  vec3 skyHor = skyView(normalize(vec3(hxz.x, 0.045, hxz.y)));  // 2.6 deg
  vec3 domeE  = skyZen * 0.40 + skyMid * 0.44 + skyHor * 0.16;
  vec3 ambTop = domeE * uCloudAmbK.x + uCloudAmb;
  vec3 ambBot = (domeE * 0.30 + uSeaColor * 0.90) * uCloudAmbK.y + uCloudAmb;

  vec3 scat = vec3(0.0);
  float T = 1.0;
  float span = t1 - t0;
  float distSum = 0.0, wSum = 0.0;

  /*
   * The slab is 2.25 km deep overhead and 21 km long at the far clamp, so a
   * fixed step distribution cannot serve both. Solve the warp exponent per ray
   * for an ~80 m first step: span * (1/N)^p = 80. Too flat and the near field
   * under-samples and the cloud silhouettes break into stipple; too steep and
   * the far band aliases instead.
   */
  nSteps = min(clamp(int(span / 150.0) + 40, 40, 200), nStepsMax);
  float p = clamp(log(80.0 / span) / log(1.0 / float(nSteps)), 1.0, 2.1);

  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (i >= nSteps) break;
    float a0 = (float(i) + dither) / float(nSteps);
    float a1 = (float(i) + 1.0 + dither) / float(nSteps);
    float s0 = t0 + span * pow(clamp(a0, 0.0, 1.0), p);
    float s1 = t0 + span * pow(clamp(a1, 0.0, 1.0), p);
    float ds = s1 - s0;
    if (ds <= 0.0) continue;
    float s = 0.5 * (s0 + s1);
    vec3 p = ro + rd * s;
    // curvature matters: at 20 km the deck is 30 m "above" the flat p.y, and
    // the low cloud band is entirely made of grazing rays
    float alt = altAt(camAlt, rd.y, s);
    // Weather texel is ~100 m; a pixel footprint is ~s * 1.6e-3 / 100 texels, so
    // the honest mip only leaves 0 past ~30 km. The previous 0.0016 slope put
    // 1.6 km texels on a 5 km cloud and stair-stepped every silhouette.
    float mip = clamp(log2(1.0 + s * 3.0e-5), 0.0, 4.0);
    /*
     * Detail-erosion fade. Round 1 dropped the high-frequency erosion past
     * 4.5 km, and the entire visible deck lives BEYOND that: a base at 1350 m
     * seen at 15 deg elevation is already 5 km away and at 5 deg it is 15 km. So
     * every cloud in frame rendered as a smooth melted blob with no cauliflower
     * anywhere. The finest detail octave is a 47 m feature, which still subtends
     * ~3 px at 15 km, so it earns its fetch all the way out to the far clamp.
     */
    float lod = smoothstep(9000.0, 26000.0, s);
    // The deck thins out over its last few km instead of ending on a wall.
    float far = 1.0 - smoothstep(${CLOUD_FADE0}.0, ${CLOUD_FADE1}.0, s);
    if (far <= 0.002) continue;
    float dens = cloudDensity(p, alt, lod, mip) * far;
    if (dens <= 0.001) continue;

    // Optical depth per metre. Round 1's 0.016 left a cumulus thin enough that
    // the sky behind it read through its own base, which put a floor under how
    // dark the shadow side could ever get — the base measured 34 luminance over
    // the reference's. A real cumulus has an optical depth in the tens, and the
    // deck has to be OPAQUE for a shaded flank to exist at all.
    float ext = dens * 0.040;
    float ld = cloudLightDepth(p, alt, uSunDirSky, mip + 1.0);

    /*
     * A real cumulus has an optical depth of 20-100, so single scattering along
     * the light ray is exactly zero inside it and the cloud would render black.
     * What actually lights a cloud is multiple scattering. Approximate it with
     * three energy octaves (Wrenninge/Schneider): each successive octave sees a
     * fraction of the extinction and a flatter phase, which is what a photon
     * that has bounced a few times experiences. Normalised by the octave weights
     * so a wisp reads ~1x the incident light and a deep body ~0.09x — round 1
     * left that floor at 0.26x, which is most of why the shadow side never
     * appeared: the sun alone still lit the base to within a quarter-stop of
     * the crown before the ambient was even added.
     */
    float tau = ld * uCloudTau;
    float sun = 0.0;
    float ea = 1.0, eb = 1.0, ec = 1.0;
    for (int o = 0; o < 3; o++) {
      sun += ea * exp(-tau * eb) * cloudPhase(cosT, ec);
      ea *= 0.55; eb *= 0.42; ec *= 0.55;
    }
    sun *= 0.5405;                                  // 1 / (1 + 0.55 + 0.3025)
    /*
     * MULTIPLE-SCATTERING FLOOR — this is what makes a cloud GREY.
     *
     * The octave stack above decays to numerically zero at the optical depths a
     * real cumulus carries (tau runs 40-120 here), so anything buried inside the
     * deck was lit by the sky and by nothing else — and our sky is a saturated
     * blue. Measured, that put our cloud shadow sides at B-R 77, i.e. exactly as
     * blue as the sky beside them, where surface-above-2's cloud bodies measure
     * B-R 38-52 against a sky of 78-85. A cloud that is only sky-lit cannot land
     * in that range no matter how its level is scaled.
     *
     * A real cumulus base sits at 8-15% of its crown and is neutral, because the
     * light that reaches it is sunlight that has bounced a dozen times inside the
     * cloud rather than skylight. One clamp buys that, and it is the term that
     * makes the deck read as opaque neutral material.
     */
    sun = max(sun, 0.135);
    // powder: thin edges facing the light stay dark, the volumetric giveaway
    float powder = 1.0 - exp(-dens * 3.4);
    float hN = clamp((alt - ${CLOUD_BOT}.0) * ${(1 / (CLOUD_TOP - CLOUD_BOT)).toFixed(9)}, 0.0, 1.0);
    // The sky is occluded too. A sample buried under a kilometre of cloud sees
    // only a fraction of the dome, and without this the base sits at whatever
    // the horizon ring is worth no matter how much cloud is stacked above it —
    // which is a floor under how dark the shadow side can get. Reusing the sun
    // light-depth as the proxy costs nothing and is close: with the sun 43 deg
    // up, "deep along the sun ray" and "deep under the cloud" are nearly the
    // same set of samples.
    float ambOcc = 0.55 + 0.45 * exp(-tau * 0.6);
    vec3 S = uCloudSun * sun * mix(0.35, 1.0, powder)
           + mix(ambBot, ambTop, smoothstep(0.0, 0.72, hN)) * ambOcc;

    float sT = exp(-ext * ds);
    float w = T * (1.0 - sT);
    scat += w * S;
    distSum += w * s; wSum += w;
    T *= sT;
    if (T < 0.008) break;
  }

  /*
   * Aerial perspective, against the sky this cloud is actually seen in front of
   * — weighted by where the scattering happened rather than by a fixed fraction
   * of the span, so a near cumulus stays crisp while the low band dissolves into
   * its own background instead of into a separate horizon colour.
   */
  float dMean = wSum > 1e-5 ? distSum / wSum : t0;
  float haze = 1.0 - exp(-dMean / 21000.0);
  vec3 hz = skyView(rd);
  scat = mix(scat, hz * (1.0 - T), haze);
  T = mix(T, 1.0, haze * 0.60);
  return vec4(scat, T);
}

// ------------------------------------------------------------------ assembly
/**
 * occ reports how much of the AIRLIGHT the caller should hide behind an opaque
 * celestial disc.
 *
 * Strictly this should be zero. A body outside the atmosphere is seen through
 * the entire scattering column, so the airlight in front of it is exactly the
 * sky's own radiance and the correct composite is additive — which means a
 * planet's night side is mathematically invisible in a daylight sky. That is
 * what round 2 rendered, and the critic read it, correctly, as a soap bubble:
 * measured, the disc sat at L 193-241 against a sky of L 180.
 *
 * Subnautica does not do that. In surface-above-3 and -4 the planet is an
 * unambiguously opaque body whose unlit limb is DARKER than the sky beside it,
 * with a hard terminator across it. So the disc is composited as an occluder and
 * only part of the column is re-added in front of it. This is the one place in
 * this module where the reference frame overrules the radiative transfer, and it
 * is confined to the solid angle of the disc.
 */
vec3 celestial(vec3 rd, out float occ) {
  vec3 col = vec3(0.0);
  if (uNight > 0.002) col += (starField(rd) + galactic(rd)) * uNight;

  float cg = 0.0, cm = 0.0;
  vec3 g = giantDisc(rd, cg);
  col = col * (1.0 - cg) + g;
  vec3 m = moonDisc(rd, cm);
  col = col * (1.0 - cm) + m;
  /*
   * How much of the atmosphere's own in-scatter a disc replaces.
   *
   * The gas giant ran at 0.62, i.e. 38% of the full sky-view radiance was still
   * ADDED over an opaque body 27 degrees across, and the LUT's radiance in that
   * direction is the whole air column. Measured on surface-above: the sunlit
   * crown came out rgb(205,220,236), B-R = +31 — a BLUE-WHITE crown on a body
   * whose authored albedo is cream (0.95, 0.86, 0.68), which is B-R = -69. The
   * veil was worth 100 points of B-R on its own, and a body wearing the sky's
   * colour with the sky's clouds crossing it is exactly the "translucent soap
   * bubble" read. 0.90 leaves a tenth of the column as honest aerial
   * perspective on a body low in the sky and lets the disc keep its own hue.
   */
  occ = clamp(cg * 0.90 + cm * 0.55, 0.0, 1.0);

  float cs = dot(rd, uSunDirSky);
  float ang = acos(clamp(cs, -1.0, 1.0));
  float rr = ang / (${SUN_ANG_R} * SUN_R_MUL);
  if (rr < 1.0) {
    float mu = sqrt(max(0.0, 1.0 - rr * rr));
    float limb = 1.0 - 0.56 * (1.0 - pow(mu, 0.5));
    col += uSunDiscCol * SUN_L_MUL * limb * smoothstep(1.0, 0.965, rr);
  }
  // the Mie aureole the LUT cannot resolve
  float f = max(cs, 0.0);
  col += uSunDiscCol * (0.0020 * pow(f, 2600.0) + 0.00013 * pow(f, 240.0));
  return col;
}

vec3 nightAir(vec3 rd) {
  // airglow lifts the horizon; moonlight scatters into a soft blue dome
  float am = 1.0 / max(rd.y + 0.16, 0.05);
  vec3 c = uNightSky * mix(0.55, 1.0, clamp(am * 0.16, 0.0, 1.0));
  float cm = dot(rd, uMoonDir);
  c += uMoonSky * (0.55 + 2.6 * rayleighPhase(cm)) * clamp(am * 0.22, 0.05, 1.0);
  return c * uNight;
}

vec3 skyColourN(vec3 ro, vec3 rd, float dither, int nSteps) {
  vec3 Tv = transToTop(max(uCamAlt, 0.0), rd.y);
  float occ = 0.0;
  vec3 cel = celestial(rd, occ);
  vec3 col = cel * Tv + (skyView(rd) + nightAir(rd)) * (1.0 - occ);
  vec4 cl = renderClouds(ro, rd, dither, nSteps);
  return col * cl.a + cl.rgb;
}
vec3 skyColour(vec3 ro, vec3 rd, float dither) {
  return skyColourN(ro, rd, dither, CLOUD_STEPS);
}

/**
 * Analytic sea, used only until render/watersurface.js puts real geometry here.
 * Deep body colour + a Fresnel sky reflection + the sun's glitter road, hazed
 * into the horizon so the sky and the sea meet exactly.
 */
vec3 seaColour(vec3 ro, vec3 rd, float dither) {
  float camH = max(ro.y, 0.06);
  float dist = camH / max(-rd.y, 1e-4);
  vec3 refl = vec3(rd.x, -rd.y, rd.z);

  vec3 sky = skyColourN(ro, refl, dither, CLOUD_STEPS / 3);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(-rd.y, 0.0, 1.0), 5.0);

  // sun road: narrow in azimuth, long in elevation, broken up by chop
  vec2 hz = normalize(vec2(refl.x, refl.z) + 1e-6);
  float az = clamp(dot(hz, uSunHoriz), 0.0, 1.0);
  float dv = refl.y - uSunDirSky.y;
  vec3 wp = ro + rd * min(dist, 4000.0);
  float chop = 0.55 + 0.45 * sin(wp.x * 0.21 + uSkyTime * 1.7) * sin(wp.z * 0.17 - uSkyTime * 1.3);
  float road = pow(az, 760.0) * exp(-dv * dv * 22.0) * chop;
  road += pow(az, 90.0) * exp(-dv * dv * 60.0) * 0.10;

  vec3 sea = mix(uSeaColor, sky * 0.92, F) + uSunDiscCol * road * 0.0075;
  float haze = 1.0 - exp(-dist / 9000.0);
  sea = mix(sea, skyView(vec3(rd.x, 0.0012, rd.z)), haze);
  return sea;
}
`;

const GLSL_SKY_FRAG = /* glsl */ `
${GLSL_SKY_BODY}

uniform mat4  uInvProj;
uniform mat3  uCamBasis;
uniform vec3  uCamPos;
uniform float uUnderwater;
uniform vec3  uSunDir;         // the blended key light (sun or moon)
uniform vec3  uSunColor;
uniform vec3  uFogColor;
uniform vec3  uScatterColor;
uniform float uScatterStrength;
uniform vec3  uAbsorption;
uniform float uMaxVisibility;
uniform float uWaterLevel;
uniform sampler2D uBlue;
varying vec2 vScreen;

/**
 * The water background. This is the exact limit of the in-scatter term in
 * core/underwaterMaterial.js as viewDist -> infinity, so terrain does not
 * silhouette against a void: it dissolves into this.
 */
vec3 waterBackground(vec3 rd) {
  float farY = uCamPos.y + rd.y * uMaxVisibility * 1.35;
  float pd = max(0.0, uWaterLevel - farY);
  vec3 sunT = exp(-uAbsorption * pd * 0.42);
  float sunAmount = max(dot(rd, uSunDir), 0.0);
  vec3 col = mix(uFogColor, uScatterColor, uScatterStrength)
           * mix(0.55, 1.0, sunT.b)
           * (1.0 + 0.85 * pow(sunAmount, 4.0));
  // The sun through the surface: a soft elongated smear, never a hard disc.
  // Faded in across the horizon rather than switched on by a rd.y > 0 branch —
  // a branch there puts a dead-straight full-width step across the frame at
  // exactly eye level, which is the last thing an underwater shot needs.
  float camDepth = max(0.0, uWaterLevel - uCamPos.y);
  float g = pow(sunAmount, 70.0) * max(uSunDir.y, 0.0) * smoothstep(0.0, 0.03, rd.y);
  col += uSunColor * g * exp(-camDepth * 0.030) * 0.75;
  return col;
}

void main() {
  vec4 c = uInvProj * vec4(vScreen, -1.0, 1.0);
  vec3 rd = normalize(uCamBasis * (c.xyz / c.w));

  vec3 col;
  if (uUnderwater > 0.5) {
    col = waterBackground(rd);
  } else {
    /*
     * Raymarch start offset from a 64^2 void-and-cluster BLUE NOISE tile.
     *
     * Round 1 used interleaved gradient noise, and IGN is a regular lattice: at
     * 3x zoom it laid a visible half-tone hex screen along every soft cloud edge
     * and around the planet's limb. A plain hash goes the other way and turns
     * the same edges into per-pixel confetti. Blue noise is the one that reads
     * as film grain at worst, and with the finer march the residual amplitude is
     * a fraction of a step anyway.
     */
    float dither = texelFetch(uBlue, ivec2(gl_FragCoord.xy) & ivec2(63), 0).r;
    col = rd.y > 0.0 ? skyColour(uCamPos, rd, dither) : seaColour(uCamPos, rd, dither);
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/**
 * THE NIGHT GRADE — a per-channel multiply over the submerged frame.
 *
 * render/underwater.js owns the water's in-scatter and its medium pass rewrites
 * every pixel's in-scatter from private uniforms, subtracting the shared-U
 * constant back off and substituting its own integral. That integral is a
 * function of depth and biome only: nothing in it knows the sun has set, so it
 * renders full daylight at 3am, and — because the subtraction cancels exactly —
 * scaling the shared U.* medium no longer changes the water at all. Round 1
 * cross-faded a second backdrop in underneath, which stopped working the moment
 * that pass landed, and left a visible depth-test seam besides.
 *
 * What is left is one honest operator: after the medium pass has written the
 * frame, multiply it. Physically that is what night is — the same water lit by
 * ~1/50 the light with a different spectrum — and doing it as a straight
 * per-channel gain on the whole submerged frame means there is no boundary
 * anywhere for an eye to catch, which the depth-tested version could not
 * promise. Green is pulled down about 2.5x harder than blue, which is what
 * walks the water from daytime teal to night navy.
 *
 * Delete this the day render/underwater.js reads sky.dayFactor itself; it is
 * off entirely while the sun is up, and above water always.
 */
const GLSL_NIGHTBG_FRAG = /* glsl */ `
precision highp float;
uniform vec3  uNightMul;
uniform float uWeight;
uniform float uUnderwater;
varying vec2 vScreen;

void main() {
  float w = clamp(uWeight * uUnderwater, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), uNightMul, w), 1.0);
}
`;

const GLSL_ENV_FRAG = /* glsl */ `
#define ENV_PASS
${GLSL_SKY_BODY}

uniform mat3 uFaceBasis;
uniform vec3 uCamPos;
varying vec2 vUv;

void main() {
  vec3 d = normalize(uFaceBasis * vec3(vUv * 2.0 - 1.0, -1.0));
  vec3 ro = vec3(0.0, max(uCamPos.y, 0.6), 0.0);
  vec3 col = d.y > 0.0 ? skyColour(ro, d, 0.5) : seaColour(ro, d, 0.5);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

const VERT_SCREEN = /* glsl */ `
varying vec2 vScreen;
void main() { vScreen = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;
const VERT_UV = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ===========================================================================
// module
// ===========================================================================
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _rotM = new THREE.Matrix4();
const _seaFloorTint = new THREE.Color(0.03, 0.08, 0.10);
const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();
const _giantDir = new THREE.Vector3();
const _keyDir = new THREE.Vector3();
const _c = new THREE.Color();

/** Cube-face view bases, +X -X +Y -Y +Z -Z, matching WebGL cube map order. */
const FACE_BASES = [
  [[0, 0, -1], [0, -1, 0], [1, 0, 0]],
  [[0, 0, 1], [0, -1, 0], [-1, 0, 0]],
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]],
].map((m) => new THREE.Matrix3().set(
  m[0][0], m[1][0], m[2][0],
  m[0][1], m[1][1], m[2][1],
  m[0][2], m[1][2], m[2][2],
));

const sky = {
  id: 'sky',
  order: 10,

  // ---- published state, read by anything that wants the cycle -------------
  timeOfDay: 0.42,
  dayLength: DAY_LENGTH,
  /** 0 = astronomical night, 1 = full day */
  dayFactor: 1,
  sunDir: new THREE.Vector3(0, 1, 0),
  moonDir: new THREE.Vector3(0, -1, 0),
  giantDir: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  sunIntensity: SUN_PEAK_I,
  /** hemispheric sky irradiance colour (linear) and its scalar strength */
  ambientColor: new THREE.Color(0.3, 0.45, 0.7),
  ambientIntensity: 1,
  /** 0..1 how much of the sun the cloud deck is covering right now */
  cloudCover: 0,

  sunLight: null,
  skyLight: null,
  envCube: null,

  async init(ctx) {
    this._ctx = ctx;
    this.timeOfDay = ctx.time.timeOfDay ?? 0.42;
    const seed = 90210;

    this._trans = buildTransmittanceLUT();
    this._shape = buildShapeNoise(seed);
    this._detail = buildDetailNoise(seed + 7);
    this._blue = buildBlueNoise(64, makeRNG(seed + 29));
    const weather = buildWeather(seed + 13);
    this._weather = weather.tex;
    this._weatherData = weather.data;

    // ---- sky-view LUT target + pass
    this._skyRT = new THREE.WebGLRenderTarget(128, 128, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this._lutMat = new THREE.ShaderMaterial({
      uniforms: {
        uTrans: { value: this._trans },
        uSunIrr: { value: new THREE.Vector3(...SUN_IRR).multiplyScalar(SOLAR_SCALE) },
        uSunEl: { value: new THREE.Vector2(1, 0) },
        uCamAlt: { value: 1 },
        uMsColor: { value: new THREE.Vector3(...MS_ISO) },
      },
      vertexShader: VERT_UV,
      fragmentShader: GLSL_LUT_FRAG,
      depthTest: false, depthWrite: false,
    });
    this._quadScene = new THREE.Scene();
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._lutMat);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    // ---- shared celestial/cloud uniforms (one object, two materials)
    const su = {
      uTrans: { value: this._trans },
      uSunIrr: { value: new THREE.Vector3(...SUN_IRR).multiplyScalar(SOLAR_SCALE) },
      uSkyView: { value: this._skyRT.texture },
      uWeather: { value: this._weather },
      uShape: { value: this._shape },
      uDetail: { value: this._detail },
      uSunDirSky: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
      uMoonUp: { value: new THREE.Vector3(0, 0, 1) },
      uGiantDir: { value: new THREE.Vector3(0, 1, 0) },
      uGiantRight: { value: new THREE.Vector3(1, 0, 0) },
      uGiantUp: { value: new THREE.Vector3(0, 0, 1) },
      uGiantAxis: { value: new THREE.Vector3(0, 1, 0) },
      uGiantSpotT: { value: new THREE.Vector3(1, 0, 0) },
      uGiantSpot: { value: new THREE.Vector2(0.26, 0.32) },
      uSunHoriz: { value: new THREE.Vector2(1, 0) },
      uSkyRot: { value: new THREE.Matrix3() },
      uSunDiscCol: { value: new THREE.Vector3() },
      uMoonLight: { value: new THREE.Vector3() },
      uGiantLight: { value: new THREE.Vector3() },
      uNightSky: { value: new THREE.Vector3(0.0012, 0.0026, 0.0034) },
      uMoonSky: { value: new THREE.Vector3() },
      uNight: { value: 0 },
      uCamAlt: { value: 1 },
      uSkyTime: { value: 0 },
      uCloudWind: { value: new THREE.Vector2() },
      uCloudEvolve: { value: 0 },
      uCloudCoverage: { value: new THREE.Vector2(1.35, -0.42) },
      uCloudDensity: { value: 1.0 },
      uCloudSun: { value: new THREE.Vector3() },
      uCloudAmb: { value: new THREE.Vector3() },
      // (crown, base) weights on the cosine-weighted dome irradiance. The base
      // is the SMALLER of the two once the dome term above has been scaled by
      // 0.30 for it — see renderClouds.
      uCloudAmbK: { value: new THREE.Vector2(0.30, 0.46) },
      uCloudTau: { value: 0.024 },
      uSeaColor: { value: new THREE.Vector3(0.008, 0.055, 0.10) },
    };
    this._su = su;

    this._skyMat = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, su, {
        uInvProj: { value: new THREE.Matrix4() },
        uCamBasis: { value: new THREE.Matrix3() },
        uCamPos: U.uCamPos,
        uUnderwater: U.uUnderwater,
        uSunDir: U.uSunDir,
        uSunColor: { value: new THREE.Vector3(1, 0.93, 0.78) },
        uFogColor: U.uFogColor,
        uScatterColor: U.uScatterColor,
        uScatterStrength: U.uScatterStrength,
        uAbsorption: U.uAbsorption,
        uMaxVisibility: U.uMaxVisibility,
        uWaterLevel: U.uWaterLevel,
        uBlue: { value: this._blue },
      }),
      vertexShader: VERT_SCREEN,
      fragmentShader: GLSL_SKY_FRAG,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false,
    });
    this._skyMat.name = 'sky';

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._skyMat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;     // the background: first thing drawn, writes no depth
    this.mesh.name = 'sky';
    this.mesh.onBeforeRender = () => this._onBeforeRender();
    ctx.scene.add(this.mesh);

    this._nightMat = new THREE.ShaderMaterial({
      uniforms: {
        uNightMul: { value: new THREE.Vector3(...NIGHT_MUL) },
        uWeight: { value: 0 },
        uUnderwater: U.uUnderwater,
      },
      vertexShader: VERT_SCREEN,
      fragmentShader: GLSL_NIGHTBG_FRAG,
      /*
       * MULTIPLY blend: dst * src, with nothing added. renderOrder 9500 puts it
       * after underwater.js's medium pass (9000), which is the pass that has the
       * last word on the water, and depthTest off means it covers geometry,
       * particulate and open water alike — one uniform operator over the frame
       * with no boundary in it. See GLSL_NIGHTBG_FRAG.
       */
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.nightBackdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._nightMat);
    this.nightBackdrop.frustumCulled = false;
    this.nightBackdrop.renderOrder = 9500;
    this.nightBackdrop.name = 'sky-night-grade';
    this.nightBackdrop.visible = false;
    ctx.scene.add(this.nightBackdrop);

    // ---- environment cube (sky reflections for water, hulls, glass)
    this._envOn = ctx.params?.get('noenv') !== '1';
    if (this._envOn) {
      try {
        this._cubeRT = new THREE.WebGLCubeRenderTarget(128, {
          type: THREE.HalfFloatType, format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          generateMipmaps: false, depthBuffer: false,
          colorSpace: THREE.LinearSRGBColorSpace,
        });
        this._envMat = new THREE.ShaderMaterial({
              uniforms: Object.assign({}, su, {
            uFaceBasis: { value: new THREE.Matrix3() },
            uCamPos: U.uCamPos,
          }),
          vertexShader: VERT_UV,
          fragmentShader: GLSL_ENV_FRAG,
          depthTest: false, depthWrite: false, toneMapped: false,
        });
        this.envCube = this._cubeRT.texture;
        // PMREM (-> scene.environment for PBR materials) is opt-in for now:
        // ?skyenv=1. The raw cube is always published for anyone who wants to
        // sample it themselves, which is what watersurface actually needs.
        this._pmremOn = ctx.params?.get('skyenv') === '1';
        if (this._pmremOn) this._pmrem = new THREE.PMREMGenerator(ctx.renderer);
        this._envDirty = 0;
      } catch (e) {
        console.warn('[sky] environment cube unavailable:', e.message);
        this._envOn = false;
      }
    }

    // ---- scene lights
    this.sunLight = new THREE.DirectionalLight(0xffffff, SUN_PEAK_I);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const sc = this.sunLight.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
    sc.near = 1; sc.far = 620;
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.55;
    ctx.scene.add(this.sunLight);
    ctx.scene.add(this.sunLight.target);

    this.skyLight = new THREE.HemisphereLight(0x86b6dc, 0x11343f, 1.0);
    ctx.scene.add(this.skyLight);

    // ---- shared uniforms other modules can read without importing us
    this.uDay = registerUniform('uSkyDay', { value: 1 });
    this.uMoonDirU = registerUniform('uMoonDir', { value: new THREE.Vector3(0, -1, 0) });

    ctx.provide?.('sky', this);

    // debug switches: ?nocloud=1 ?nostars=1 (isolate a layer), and
    // ?cloudsun= / ?cloudamb= to sweep the two halves of the cloud radiance
    // independently — setting either to 0 renders the other on its own, which
    // is how the crown/base levels below were solved against the reference
    // instead of guessed.
    this._noCloud = ctx.params?.get('nocloud') === '1';
    this._noStars = ctx.params?.get('nostars') === '1';
    const num = (k) => {
      const raw = ctx.params?.get(k);
      const v = raw == null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(v) ? v : null;
    };
    this._cloudSunK = num('cloudsun') ?? 1;
    const dbgA = num('cloudamb');
    if (dbgA !== null) su.uCloudAmbK.value.multiplyScalar(dbgA);
    /*
     * The night light budget, sweepable the same way — and this is the sweep
     * that found round 33's defect. ?nightgain= scales the whole compensated
     * night light budget (key + both ambients), ?nightmul= the whole-frame
     * night gain, ?nightvis= the night visibility trim. Setting nightgain=0
     * removes every light this module publishes, which is the ablation that
     * proved the frame was 96% in-scatter. See NIGHT_LIGHT_GAIN.
     */
    const dbgMs = num('skyms');
    if (dbgMs !== null) this._lutMat.uniforms.uMsColor.value.multiplyScalar(dbgMs);
    this._nightGainK = num('nightgain') ?? 1;
    this._nightMulK = num('nightmul') ?? 1;
    this._visK = num('nightvis') ?? 1;

    // biomes/underwater own the medium's hue and depth response; we only fold
    // the day/night factor into it, and only once the sun is actually down.
    // Disable with ?nodaynight=1 once render/underwater.js reads sky.dayFactor
    // itself (see the note in _onBeforeRender).
    this._driveMedium = ctx.params?.get('nodaynight') !== '1';
    this._out = { dd: -1, vis: -1 };

    this._t = 0;
    this._sunDim = 1;
    this._nightW = 0;
    this.nightLightGain = 1;
    this.update(0, 0, ctx);
    this._renderSkyView(ctx);
  },

  // ---------------------------------------------------------------- cycle
  /** Sun direction for a time of day, in the world frame. */
  sunDirAt(tod, out = new THREE.Vector3()) {
    const a = (tod - 0.25) * Math.PI * 2;
    return out.copy(E_AX).multiplyScalar(Math.cos(a))
      .addScaledVector(UP, Math.sin(a) * Math.cos(SUN_TILT))
      .addScaledVector(N_AX, Math.sin(a) * Math.sin(SUN_TILT))
      .normalize();
  },
  moonDirAt(tod, out = new THREE.Vector3()) {
    const b = (tod - 0.25) * Math.PI * 2 * MOON_RATE + MOON_OFFSET;
    return out.copy(E_AX).multiplyScalar(Math.cos(b))
      .addScaledVector(UP, Math.sin(b) * Math.cos(MOON_TILT))
      .addScaledVector(N_AX, Math.sin(b) * Math.sin(MOON_TILT))
      .normalize();
  },

  setTimeOfDay(t) {
    this.timeOfDay = ((t % 1) + 1) % 1;
    if (this._ctx) this._ctx.time.timeOfDay = this.timeOfDay;
  },

  /** Cloud cover directly above a world point, 0..1. Sampled from the weather map. */
  cloudCoverAt(x, z) {
    const d = this._weatherData;
    if (!d) return 0;
    const n = WEATHER_N;
    const wx = (x + this._windX) / WEATHER_TILE * n;
    const wz = (z + this._windZ) / WEATHER_TILE * n;
    const i0 = ((Math.floor(wx) % n) + n) % n;
    const j0 = ((Math.floor(wz) % n) + n) % n;
    const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    const fx = wx - Math.floor(wx), fz = wz - Math.floor(wz);
    const g = (i, j) => d[(j * n + i) * 4] / 255;
    const a = lerp(g(i0, j0), g(i1, j0), fx);
    const b = lerp(g(i0, j1), g(i1, j1), fx);
    const cov = lerp(a, b, fz);
    return clamp01(cov * this._su.uCloudCoverage.value.x + this._su.uCloudCoverage.value.y);
  },

  // ---------------------------------------------------------------- update
  update(dt, t, ctx) {
    this._t = t;
    // ctx.time.timeOfDay is the authority — the capture harness writes it directly
    if (ctx.time.timeOfDay !== undefined && ctx.time.timeOfDay !== this._lastTod) {
      this.timeOfDay = ctx.time.timeOfDay;
    }
    this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;
    if (this.timeOfDay < 0) this.timeOfDay += 1;
    ctx.time.timeOfDay = this.timeOfDay;
    this._lastTod = this.timeOfDay;

    const tod = this.timeOfDay;
    this.sunDirAt(tod, _sunDir);
    this.moonDirAt(tod, _moonDir);

    // the gas giant we orbit: nearly fixed, with a slow libration
    const gAz = GIANT_AZ + Math.sin(t / 6000) * 6 * DEG;
    const gEl = GIANT_EL + Math.sin(t / 8300 + 1.2) * 3 * DEG;
    _giantDir.set(Math.cos(gEl) * Math.sin(gAz), Math.sin(gEl), -Math.cos(gEl) * Math.cos(gAz)).normalize();

    this.sunDir.copy(_sunDir);
    this.moonDir.copy(_moonDir);
    this.giantDir.copy(_giantDir);
    this.uMoonDirU.value.copy(_moonDir);

    // ---- sun colour + intensity from real transmittance at the surface
    const sunUp = smoothstep(-0.045, 0.055, _sunDir.y);
    const Ts = transmittance(Rg + 1, Math.max(_sunDir.y, -0.02), 32);
    // 0.72 exponent: the disc is half a degree wide and multiple scattering fills
    // the shadowed limb, so the pure single-scatter value is too red to be true.
    const soft = [Math.pow(Ts[0], 0.72), Math.pow(Ts[1], 0.72), Math.pow(Ts[2], 0.72)];
    const sunLum = 0.2126 * soft[0] + 0.7152 * soft[1] + 0.0722 * soft[2];
    const sunI = SUN_PEAK_I * (sunLum / 0.8586) * sunUp;

    const moonUp = smoothstep(-0.035, 0.06, _moonDir.y) * (1 - sunUp);
    const moonPhase = clamp01((1 + _moonDir.dot(_sunDir) * -1) * 0.5);   // 1 = full
    const Tm = transmittance(Rg + 1, Math.max(_moonDir.y, -0.02), 24);
    /*
     * THE MOON AS A KEY LIGHT.
     *
     * Round 2 published 0.090 here, which resolved to U.uSunIntensity = 0.063 at
     * the night-shallows framing — 1/50 of the daylight key. Nothing in the world
     * was shaped by it: the frame measured a 0.1-99.9 percentile range of 3-53
     * with a tile contrast of 1.02, i.e. a flat navy wash. The reference night
     * frames run a median of 21-37 with a 99.9th percentile of 148-252 and a tile
     * contrast of 5.8-13.3, so the light is dim but it is DIRECTIONAL and it puts
     * highlights on things. At 0.26 the key resolves to ~0.17, about 1/18 of day,
     * which is the ratio those frames read at.
     */
    const moonI = 0.750 * moonUp * (0.30 + 0.70 * moonPhase)
      * (0.2126 * Tm[0] + 0.7152 * Tm[1] + 0.0722 * Tm[2]);

    // ---- clouds passing over the sun dim the whole world, slowly
    const cam = ctx.camera.position;
    // Fixed offset into the weather field: the deck drifts at 38 m/s, so a
    // capture only ever sees ~100 m of that. Where the field sits relative to
    // the canonical framings is therefore a composition choice, not weather —
    // this one keeps the gas giant clear of the deck in surface-above.
    this._windX = CLOUD_OFFSET_X + Math.cos(0.8) * 38 * t;
    this._windZ = CLOUD_OFFSET_Z + Math.sin(0.8) * 38 * t;
    const lift = 2200 / Math.max(_sunDir.y, 0.18);
    const cov = this.cloudCoverAt(cam.x + _sunDir.x * lift, cam.z + _sunDir.z * lift);
    this.cloudCover = cov;
    const target = lerp(1.0, 0.80, clamp01(cov * 1.4));
    this._sunDim = dt > 0 ? lerp(this._sunDim, target, Math.min(1, dt * 0.8)) : target;

    const keyI = sunI * this._sunDim + moonI + 0.010;
    const skyGlow = [0.16, 0.30, 0.52];
    const moonCol = [0.60, 0.74, 1.0];
    const kc = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      kc[i] = (soft[i] * sunI * this._sunDim + moonCol[i] * moonI + skyGlow[i] * 0.010) / Math.max(keyI, 1e-5);
    }
    const kmax = Math.max(kc[0], kc[1], kc[2], 1e-5);
    this.sunColor.setRGB(kc[0] / kmax, kc[1] / kmax, kc[2] / kmax);
    this.sunIntensity = keyI * kmax;

    // ---- key direction: the sun while it is up, then the moon, never below us
    const wS = sunUp, wM = moonUp, wU = Math.max(0.0, 1 - wS - wM) + 0.02;
    _keyDir.copy(_sunDir).multiplyScalar(wS)
      .addScaledVector(_moonDir, wM)
      .addScaledVector(UP, wU);
    if (_keyDir.lengthSq() < 1e-6) _keyDir.copy(UP);
    _keyDir.normalize();
    if (_keyDir.y < 0.06) { _keyDir.y = 0.06; _keyDir.normalize(); }

    this.dayFactor = smoothstep(-0.10, 0.09, _sunDir.y);
    this.uDay.value = this.dayFactor;
    const night = 1 - smoothstep(-0.26, -0.035, _sunDir.y);

    /*
     * THE NIGHT COMPENSATION. See NIGHT_LIGHT_GAIN at the foot of this file for
     * the measurement that forced it. In one line: the night multiply below
     * already carries the ENTIRE day-to-night level change, and it lands on the
     * medium and on geometry alike — so any dimming of the light budget on top
     * of it is applied to geometry twice and to the water once, and geometry
     * loses the difference. This gain undoes that second application.
     *
     * It is gated on exactly the same product the multiply's own shader uses,
     * `uWeight * uUnderwater`, so the two cancel term for term: wherever the
     * multiply is at full strength the compensation is too, and above water,
     * where the multiply does nothing, this is exactly 1.
     */
    this._nightW = smoothstep(0.02, 0.55, 1 - this.dayFactor);
    const gain = lerp(1, NIGHT_LIGHT_GAIN * this._nightGainK,
      this._nightW * clamp01(U.uUnderwater.value));
    this.nightLightGain = gain;
    this.moonIrradiance = this.sunIntensity;
    this.sunIntensity *= gain;

    U.uSunDir.value.copy(_keyDir);
    U.uSunColor.value.copy(this.sunColor);
    U.uSunIntensity.value = this.sunIntensity;

    // ---- hemispheric sky ambient, sampled from the same scattering model
    const sd = _sunDir;
    const amb = [0, 0, 0];
    const dirs = [
      [0, 1, 0, 0.34],
      [sd.x, 0.55, sd.z, 0.20],
      [-sd.x, 0.55, -sd.z, 0.20],
      [sd.z, 0.42, -sd.x, 0.13],
      [-sd.z, 0.42, sd.x, 0.13],
    ];
    for (const d of dirs) {
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      const L = skyRadianceCPU(d[0] / l, d[1] / l, d[2] / l, sd.x, sd.y, sd.z, 8);
      amb[0] += L[0] * d[3]; amb[1] += L[1] * d[3]; amb[2] += L[2] * d[3];
    }
    // starlight/airglow floor so a moonless night is dark but not featureless
    amb[0] += 0.0016 * (1 - this.dayFactor);
    amb[1] += 0.0030 * (1 - this.dayFactor);
    amb[2] += 0.0052 * (1 - this.dayFactor);
    amb[0] += moonCol[0] * moonI * 0.30;
    amb[1] += moonCol[1] * moonI * 0.30;
    amb[2] += moonCol[2] * moonI * 0.30;
    const ambMax = Math.max(amb[0], amb[1], amb[2], 1e-6);
    this.ambientColor.setRGB(amb[0] / ambMax, amb[1] / ambMax, amb[2] / ambMax);
    this.ambientIntensity = ambMax;

    // ---- drive the three.js lights
    this.sunLight.color.copy(this.sunColor);
    this.sunLight.intensity = this.sunIntensity;
    this.sunLight.position.copy(cam).addScaledVector(_keyDir, 260);
    this.sunLight.target.position.copy(cam);
    this.sunLight.target.updateMatrixWorld();
    this.skyLight.color.copy(this.ambientColor);
    _c.copy(this.ambientColor).multiplyScalar(0.35).lerp(_seaFloorTint, 0.7);
    this.skyLight.groundColor.copy(_c);
    // The 1.6 ceiling is a DAYLIGHT rig limit — it exists so a bright noon sky
    // does not wash the scene flat. Clamp first, then compensate, or the ceiling
    // eats the night gain and the hemisphere stays at its daylight value while
    // everything around it is multiplied down by NIGHT_MUL.
    this.skyLight.intensity = Math.min(1.6, this.ambientIntensity * 3.0) * gain;

    // ---- shader uniforms
    const su = this._su;
    su.uSunDirSky.value.copy(_sunDir);
    su.uMoonDir.value.copy(_moonDir);
    su.uGiantDir.value.copy(_giantDir);
    basis(_moonDir, su.uMoonRight.value, su.uMoonUp.value);
    basis(_giantDir, su.uGiantRight.value, su.uGiantUp.value);
    su.uGiantAxis.value.set(0.16, 0.972, 0.17).normalize();
    su.uGiantSpotT.value.copy(su.uGiantRight.value);
    const sh = Math.hypot(_sunDir.x, _sunDir.z);
    if (sh > 1e-4) su.uSunHoriz.value.set(_sunDir.x / sh, _sunDir.z / sh);
    su.uCamAlt.value = Math.max(0.5, cam.y);
    su.uSkyTime.value = t;
    su.uNight.value = night;
    this._lutMat.uniforms.uSunEl.value.set(Math.sqrt(Math.max(0, 1 - _sunDir.y * _sunDir.y)), _sunDir.y);
    this._lutMat.uniforms.uCamAlt.value = su.uCamAlt.value;

    // celestial radiances: unfiltered starlight, our own air reddens them on the way in
    const S = SOLAR_SCALE;
    su.uSunDiscCol.value.set(SUN_IRR[0] * S * 16, SUN_IRR[1] * S * 16, SUN_IRR[2] * S * 16);
    /*
     * The moon has to be the brightest thing in a night frame by a wide margin.
     * Round 2 ran this at 0.060, which put a full disc at a scene value of ~0.45
     * — display luminance ~163, below the bloom threshold, so the "moon" was a
     * grey coin. The reference night frames peak at 148-252 and every one of
     * them has something genuinely hot in it. A full moon is a sunlit rock at
     * one AU: it is a highlight, not a mid-tone.
     */
    const ml = S * 0.560;
    su.uMoonLight.value.set(SUN_IRR[0] * ml, SUN_IRR[1] * ml * 0.99, SUN_IRR[2] * ml * 0.97);
    /*
     * The giant is lit by the star's LUMINANCE, not by its spectrum.
     *
     * SUN_IRR is deliberately blue-skewed (1.00, 1.15, 1.25) because that is
     * what feeds the scattering integral, and for the sky and the grey moon that
     * is right. Multiplying giantDisc()'s AUTHORED albedo by it is a different
     * operation: cream (0.95, 0.86, 0.68) comes out (0.95, 0.99, 0.85), i.e.
     * neutral, and umber belts flatten the same way. The disc's whole structure
     * is that zone/belt chroma contrast, and the star's spectrum was quietly
     * cancelling it. Light it white and let the albedo carry the colour.
     */
    const gl = S * 0.235 * (0.2126 * SUN_IRR[0] + 0.7152 * SUN_IRR[1] + 0.0722 * SUN_IRR[2]);
    su.uGiantLight.value.set(gl, gl, gl);
    su.uMoonSky.value.set(moonCol[0], moonCol[1], moonCol[2])
      .multiplyScalar(moonI * 0.075 * (1 - this.dayFactor));

    // celestial sphere rotation about the orbital pole (the stars turn with the sun)
    _v2.copy(UP).multiplyScalar(Math.cos(SUN_TILT)).addScaledVector(N_AX, Math.sin(SUN_TILT));
    _pole.copy(E_AX).cross(_v2).normalize();
    su.uSkyRot.value.setFromMatrix4(_rotM.makeRotationAxis(_pole, -(tod - 0.25) * Math.PI * 2));

    // clouds
    su.uCloudDensity.value = this._noCloud ? 0.0 : 1.0;
    su.uNight.value = this._noStars ? 0.0 : su.uNight.value;
    su.uCloudWind.value.set(this._windX, this._windZ);
    su.uCloudEvolve.value = t * 4.5;
    // Coverage: every reference surface frame has blue visible BETWEEN the puffs
    // and a cloud field over ~25-40% of the sky, not a ceiling.
    const covBase = 0.32 + 0.07 * Math.sin(t / 520);
    su.uCloudCoverage.value.set(1.55, covBase - 0.76);
    const Tc = transmittance(Rg + 2400, Math.max(_sunDir.y, -0.02), 24);
    const ck = CLOUD_SUN_K * (this._cloudSunK ?? 1);
    su.uCloudSun.value.set(
      SUN_IRR[0] * S * Tc[0] * ck,
      SUN_IRR[1] * S * Tc[1] * ck,
      SUN_IRR[2] * S * Tc[2] * ck,
    );
    /*
     * Daylight ambient on the deck is sampled from the sky-view LUT inside the
     * shader (see renderClouds), because that is the term that gives a cloud a
     * shadow side and it has to be the sky's own colour to do it. What is left
     * for the CPU is only the floor the LUT cannot carry — moonlight and
     * airglow — so a night cloud is a readable silhouette instead of a hole.
     */
    const nf = 1 - this.dayFactor;
    su.uCloudAmb.value.set(
      moonCol[0] * moonI * 0.055 + 0.0016 * nf,
      moonCol[1] * moonI * 0.055 + 0.0028 * nf,
      moonCol[2] * moonI * 0.055 + 0.0046 * nf,
    );
    su.uNightSky.value.set(0.0016, 0.0031, 0.0048);

    // the sea body colour tracks the biome fog so the backdrop stays in family
    _c.copy(U.uFogColor.value);
    su.uSeaColor.value.set(
      _c.r * 0.16 + 0.002,
      _c.g * 0.18 + 0.006,
      _c.b * 0.24 + 0.012,
    ).multiplyScalar(0.35 + 1.35 * this.ambientIntensity);

    this._skyMat.uniforms.uSunColor.value.set(this.sunColor.r, this.sunColor.g, this.sunColor.b);
  },

  // ---------------------------------------------------------------- render
  preRender(ctx) {
    this._renderSkyView(ctx);
    if (this._envOn && (ctx.time.frame % 12 === 0 || this._envDirty < 2)) {
      this._renderEnv(ctx);
      this._envDirty++;
    }
  },

  _renderSkyView(ctx) {
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    this._quad.material = this._lutMat;
    r.setRenderTarget(this._skyRT);
    r.render(this._quadScene, this._quadCam);
    r.setRenderTarget(prev);
  },

  _renderEnv(ctx) {
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    this._quad.material = this._envMat;
    for (let i = 0; i < 6; i++) {
      this._envMat.uniforms.uFaceBasis.value.copy(FACE_BASES[i]);
      r.setRenderTarget(this._cubeRT, i);
      r.render(this._quadScene, this._quadCam);
    }
    r.setRenderTarget(prev);
    this._quad.material = this._lutMat;
    if (!this._pmremOn) return;
    try {
      this._envPM = this._pmrem.fromCubemap(this._cubeRT.texture, this._envPM);
      ctx.scene.environment = this._envPM.texture;
      if ('environmentIntensity' in ctx.scene) {
        ctx.scene.environmentIntensity = U.uUnderwater.value > 0.5 ? 0.20 : 0.55;
      }
    } catch (e) {
      console.warn('[sky] PMREM failed, using the raw cube only:', e.message);
      this._pmremOn = false;
    }
  },

  /**
   * Runs when the sky quad draws — after every module's preRender, so this is
   * the last word on the frame's uniforms. Camera matrices land here (the
   * capture harness moves the camera after preRender), and the day/night scale
   * is applied to the medium here so world/biomes.js cannot lerp it away.
   */
  _onBeforeRender() {
    const ctx = this._ctx;
    const cam = ctx.camera;
    this._skyMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
    this._skyMat.uniforms.uCamBasis.value.setFromMatrix4(cam.matrixWorld);
    this._su.uCamAlt.value = Math.max(0.5, cam.position.y);

    if (!this._driveMedium) return;
    /*
     * THE NIGHT RESPONSE.
     *
     * biomes and render/underwater.js publish the medium at FULL DAYLIGHT — the
     * ramps in both are functions of depth and biome only. Nothing in them knows
     * the sun has set, so without this the 0.88 night shots render as noon.
     *
     * We are the only module that knows what time it is, so we apply the day
     * factor here, in the sky quad's onBeforeRender — after every preRender, so
     * nothing can lerp it away later in the frame.
     *
     * At dayFactor == 1 this touches NOTHING: the daylight look those modules
     * tuned is theirs, untouched. It only fades in as the sun goes down.
     */
    const k = this.dayFactor;
    const w = 1 - k;

    // Object.visible is read during scene traversal, i.e. before any
    // onBeforeRender fires, so this always lands one frame later. Set it first
    // and unconditionally so it also switches back off at dawn.
    const nw = this._nightW;
    this.nightBackdrop.visible = nw > 0.005 && U.uUnderwater.value > 0.5;
    this._nightMat.uniforms.uWeight.value = nw;
    this._nightMat.uniforms.uNightMul.value.set(
      NIGHT_MUL[0] * this._nightMulK, NIGHT_MUL[1] * this._nightMulK, NIGHT_MUL[2] * this._nightMulK);

    if (w < 0.004) return;

    /*
     * The magnitude of the night lives in the multiply pass (the medium pass
     * cancels any scaling of uFogColor/uScatterColor exactly, so touching them
     * here would be a no-op that could only ever go wrong). What IS still ours
     * is everything the multiply cannot express: the hue of the ambient a shaded
     * surface picks up, how far you can see, and the fact that the moon does not
     * cast a readable caustic net.
     *
     * The guard below is what makes post-scaling safe. The owners write these
     * absolutely from their own smoothed state every frame, so scaling their
     * write has no feedback path — but if one ever skips a frame we would scale
     * our own output twice, compounding. Comparing against exactly what we
     * emitted last frame detects that and stands down for that frame.
     */
    const o = this._out;
    if (U.uDepthDarken.value === o.dd && U.uMaxVisibility.value === o.vis) return;

    /*
     * uAmbientTop/uAmbientBottom is not "our" ambient — it is the ambient
     * terrain.js, flora.js and schooling.js each read directly, i.e. the light
     * budget for the seabed, the kelp and every fish in frame. Round 12 trimmed
     * it 2-6% at night while NIGHT_MUL took 9.3x off the same pixels, so the
     * seabed and the fish were dimmed twice and the water once. It carries the
     * night compensation for the same reason the key and the hemisphere do; the
     * small residual tilt below is the only part that is a look choice, and it
     * cools the ambient a few percent as the sun goes down.
     */
    const g = this.nightLightGain;
    const ar = lerp(1, 0.94, w) * g, ag = lerp(1, 0.96, w) * g, ab = lerp(1, 0.98, w) * g;
    scaleRGB(U.uAmbientTop.value, ar, ag, ab);
    scaleRGB(U.uAmbientBottom.value, ar, ag, ab);
    U.uDepthDarken.value *= lerp(1, 0.95, w);
    /*
     * Visibility: round 12 cut it 18% at night. Nothing in the plates supports
     * that — night-shallows-2 resolves a full seabase and the terrain behind it
     * from what its HUD reads as long range, and every metre of extra haze is
     * in-scatter piled in front of geometry that is already losing to it. Held
     * at 0.95 so the night still closes in slightly, which is a look choice.
     */
    U.uMaxVisibility.value *= lerp(1, 0.95, w) * lerp(1, this._visK, w);
    // A full moon casts a real, if faint, caustic net — night-shallows-1 and -3
    // both show one on the sand. Round 2 cut it to 5%, which removed the last bit
    // of structure the seabed had at night (tile contrast 1.02 against the
    // reference's 8.6). LOOK.md 8's "lamps never cast caustics" is about lamps.
    U.uCausticsStrength.value *= lerp(1, 0.35 + 0.65 * Math.pow(k, 1.4), w);

    o.dd = U.uDepthDarken.value;
    o.vis = U.uMaxVisibility.value;
  },
};

/**
 * THE NIGHT LIGHT GAIN — why the night light budget is multiplied UP.
 *
 * A blind critic decided the night-shallows pair on this module: "every fish and
 * the entire base structure render as unlit black cutouts with hard alpha edges
 * and no rim light — nothing in the frame has a lit face." That is exactly what
 * the frame showed, and the cause was not a light that was too dim to see. It
 * was a light that had been dimmed TWICE.
 *
 * NIGHT_MUL below is a per-channel multiply over the whole submerged frame. Its
 * luminance weight is 0.2126*0.210 + 0.7152*0.079 + 0.0722*0.097 = 0.108, so it
 * already carries the entire day-to-night level change on its own — 9.3x — and
 * it lands on geometry and on the water column alike. On top of that the moon
 * key ran at 0.19x the daylight key and the hemisphere at 0.56x. So geometry
 * came out at 0.32 * 0.108 = 0.035 of its daylight radiance while the water
 * behind it came out at 1.00 * 0.108 = 0.108 of its own. Every solid object in
 * the frame lost a factor of 3 against the medium it was standing in, which is
 * the definition of a silhouette: darker than its background.
 *
 * MEASURED, at 1920x1080, night-shallows, base hull window (0.585,0.275)-
 * (0.885,0.455) and the open water beside it at (0.30,0.28)-(0.46,0.42):
 *
 *   |                        | hull med | water med | hull/water | hull tileC |
 *   | ours, round 12         |     16.1 |      23.2 |   **0.69** |       3.84 |
 *   | night-shallows-1 plate |     54.6 |      34.3 |   **1.59** |      16.07 |
 *
 * The plate's base is 1.59x BRIGHTER than the water in front of it. Ours was
 * 0.69x — darker — a 2.3x inversion, and no amount of local contrast can rescue
 * an object that is dimmer than the haze it sits in.
 *
 * THE ABLATION THAT SETTLED IT. Publishing near-zero lights was NOT the cause,
 * and the brief for this round said it was: the live uniforms read uSunIntensity
 * 0.606 with the key pointing at the moon and the hemisphere at 0.90, i.e. about
 * 1/5 of day, not 1/50. Multiplying the key by 6 moved the hull from 16.1 to
 * 16.4 and the fish not at all. Setting the moon key AND the sky ambient to
 * ZERO — every light this module publishes, gone — moved the hull from 16.1 to
 * 15.4, the seabed ridge 7.5 to 7.5 and the fish 24.1 to 24.1. The night frame
 * was 96% in-scatter. It rendered essentially the same with no moon and no sky
 * at all, which is why nine rounds of tuning the moon changed nothing.
 *
 * So the fix is not "a brighter moon". It is to stop applying the night twice:
 * the light budget is divided back out by the multiply that is about to land on
 * it, which restores geometry to the same relationship with the medium it has
 * at noon. The remaining headroom over that neutral point is deliberate — the
 * plates put objects ABOVE the water at night, not merely level with it, and a
 * moon has to model form, not just raise a level.
 *
 * The gain is gated on `nightW * uUnderwater`, the exact product the multiply's
 * own shader uses, so above water it is exactly 1 and nothing outside the water
 * ever sees it. ?nightgain=N sweeps it; ?nightgain=0 reproduces the ablation.
 *
 * WHERE 32 CAME FROM, AND WHY IT IS NOT 3.1.
 *
 * Undoing the double count exactly would be 1/0.32 = 3.1x — the reciprocal of
 * the old night/day light ratio — and that restores the relationship geometry
 * has with the medium at noon. It is nowhere near enough, and the ablation says
 * why: with every sky light switched off the base hull still renders at 15.4
 * against 16.1 with them on, so the lights were 4% of that pixel and the medium
 * 96%. A lit object at 38 m in this water is almost entirely the haze in front
 * of it. To put objects ABOVE the water the way the plates do, the light budget
 * has to out-run that haze, and 3.1x moves the hull by about one code level.
 *
 * So the honest description of this constant is: 3.1x of it is the double count,
 * and the remaining ~10x is compensating a medium whose in-scatter dominates
 * every lit surface at mid range. That second part is not a night problem and
 * it is not fixable from this file — it is the same in-scatter-over-albedo
 * balance in render/underwater.js that makes our daytime base read at 0.89x the
 * water it stands in front of (measured with ?nodaynight=1, which renders this
 * framing at the daylight medium). If that balance is ever corrected, this
 * constant must come down with it, and ?nightgain= is here to re-sweep it.
 *
 * Swept and measured at 1920x1080 on night-shallows, isolated captures:
 *
 *   | gain | frame tileC | frame med | hull tileC | hull p99.9 |
 *   |    1 |        4.09 |      21.0 |       3.48 |       46.1 |  round 12
 *   |    8 |        4.92 |      22.5 |       5.03 |       47.2 |
 *   |   24 |        7.57 |      24.4 |       9.92 |       72.6 |
 *   |**32**|    **8.89** |  **25.0** |  **12.35** |   **88.1** |
 *   |   48 |       10.97 |      26.5 |      16.91 |      114.4 |
 *   |   96 |       15.75 |      29.3 |      27.52 |      151.0 |
 *   | plate|   6.11-9.54 | 20.7-37.6 |      16.07 |      204.3 |
 *
 * (The gain-1 row is round 12's build, which also cut visibility 18% at night;
 * every other row carries the 5% cut below, worth about 4 code levels on the
 * hull on its own.)
 *
 * 48 puts the hull's local contrast exactly on the plate but takes the whole
 * frame past all three plates, and by eye the seabed algae comes up almost
 * daytime green. 32 lands the frame statistic between night-shallows-1 (7.78)
 * and night-shallows-3 (9.54) and leaves the base, the seabed and every fish
 * with a lit face and a shaded one, which is the defect this was raised
 * against. The hull is still short of the plate's local contrast and will stay
 * short while our hull albedo is dark grey against the plate's pale blue-white
 * with a lit interior behind its windows — that half is base.js's.
 */
const NIGHT_LIGHT_GAIN = 32.0;

/**
 * Per-channel gain applied to the submerged frame at astronomical night.
 * Solved against night-shallows-1: open water rgb(15,37,69) at B/G = 1.86,
 * frame median luminance 38 and a floor of 21, from a daylight medium that
 * currently renders rgb(28,150,182) at B/G = 1.21. Green falls ~2.5x harder
 * than blue in display terms, which is the hue half of the fix — round 1 got
 * the level wrong AND kept the daytime teal.
 */
const NIGHT_MUL = [0.210, 0.079, 0.097];

function scaleRGB(c, r, g, b) { c.r *= r; c.g *= g; c.b *= b; return c; }

/** Orthonormal tangent basis for a direction on the celestial sphere. */
function basis(dir, right, up) {
  const a = Math.abs(dir.y) > 0.98 ? _v.set(1, 0, 0) : _v.set(0, 1, 0);
  right.crossVectors(a, dir).normalize();
  up.crossVectors(dir, right).normalize();
}

export default sky;
