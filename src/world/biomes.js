/**
 * BIOMES — the colour science and the spawn economy of the whole planet.
 * OWNER: the "biomes" agent.
 *
 * This module renders nothing. It is the single source of truth every other
 * module asks "what does the water look like here, and what lives in it".
 *
 *   const biomes = ctx.get('biomes');
 *   const m = biomes?.at ? biomes.at(x, y, z) : null;      // ALWAYS guard
 *
 * ---------------------------------------------------------------------------
 * 1. WHERE THE ABSORPTION NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * Water does not "get foggy" — it eats the spectrum from the red end inwards.
 * The tabulated diffuse attenuation coefficients Kd (m^-1) for Jerlov's water
 * types, sampled near 650 / 550 / 475 nm (Jerlov 1976, as tabulated in Mobley,
 * "Light and Water", 1994), are:
 *
 *      type            red      green     blue      character
 *      I   open ocean  0.360    0.063     0.021     clearest blue water on Earth
 *      IB              0.370    0.070     0.030
 *      II              0.390    0.089     0.060
 *      III             0.430    0.140     0.120
 *      C1  coastal     0.460    0.190     0.200     green window opens
 *      C3              0.510    0.270     0.320
 *      C5              0.630    0.420     0.550     harbour murk
 *
 * Two facts fall straight out of that table and both are load-bearing here:
 *
 *   a) Red is killed first, always, in every water type. In clear ocean it goes
 *      ~17x faster than blue. That is why distant geometry loses *contrast and
 *      warmth* before it loses brightness.
 *   b) Whether GREEN or BLUE survives longest flips with turbidity. Clear ocean
 *      passes blue (Kd_blue 0.021 < Kd_green 0.063) — the open sea is blue.
 *      Coastal water full of dissolved organics passes green (0.19 < 0.20 and
 *      the gap widens with load) — kelp forests and river mouths are green.
 *      So "green kelp water" is not an art choice, it is the CDOM absorption
 *      band eating blue. Each biome below picks a Jerlov type for that reason.
 *
 * HOW Kd BECOMES OUR ABSORPTION — and why the old version was wrong.
 *
 * Kd is the sum of two physically different things:
 *
 *      Kd(lambda)  =  a_water(lambda)  +  b_particulate
 *
 * the water's own strongly spectral absorption, plus scattering off suspended
 * particles. Particles much larger than the wavelength scatter GREY — that is
 * the same reason fog, cloud and milk are white rather than blue. So:
 *
 *      the LEVEL of Kd (how far you see)  is mostly the flat particulate term;
 *      the DIFFERENCES between channels   are purely the spectral term.
 *
 * That split is the whole derivation. A biome's authored `visibility` sets the
 * flat level; the Jerlov type contributes only its channel *differences*:
 *
 *      a_survivor = K_VIS / visibility            K_VIS = 1.85
 *      a_i        = a_survivor + DISP_i * (Kd_i - Kd_survivor)
 *
 * i.e. **maxVisibility is the range at which the surviving channel has fallen
 * to e^-1.85 ~= 16%** — deeply hazed but still readable. At 3x that distance
 * (the clamp core/underwaterMaterial.js applies) transmittance is 0.0015 and
 * geometry has fully dissolved into the in-scattered fog.
 *
 * The previous version instead raised Kd to a power, normalised the resulting
 * triple on the survivor, and rescaled the whole ratio by visibility. That is
 * monotone, so it kept the channel ORDER — but it destroyed the channel
 * MARGINS, which are the only part that does any visible work. Jerlov C1's
 * green/blue margin of 0.010/m came out at 0.0023/m after the gamma and the
 * rescale: three percent apart, with 250 m of depth to act over. A medium with
 * no margin has no chromatic dispersion, and a medium with no dispersion cannot
 * bend with depth at all — which is exactly what the frames showed. It also
 * made a_red swing 7x across the table purely with turbidity, which forced an
 * arbitrary RED_MIN/RED_MAX clamp on top; in the additive form the red margin
 * comes out nearly constant on its own (Jerlov's Kd_red spans only 1.75:1 from
 * clearest ocean to harbour murk, because red is eaten by the water and there
 * is the same water in all of it) and the clamp is simply not needed.
 *
 * The two compression gains are the only free parameters:
 *
 *      HUE_DISP  green/blue margin. Clear ocean's real 0.042/m lands at
 *                0.011/m — the per-metre rotation that reproduces godrays-1's
 *                top-to-bottom hue sweep over a ~100 m frame.
 *      RED_DISP  red margin. The real ~0.34/m would extinguish every warm
 *                surface inside 3 m and LOOK.md's shallows-floor frame reads
 *                warm tan at 8 m; compressed it holds the near field warm
 *                through the first 10-15 m and has red under 10% of frame max
 *                by 25 m, which is the measured behaviour.
 *
 * The authored visibilities come straight off LOOK.md section 2 — 40-60 m at
 * 0-30 m deep, 35-45 m at 50-100 m, 25-35 m at 100-200 m, 15-25 m at 200-300 m,
 * 15-20 m to 500 m, 10-15 m below that. Water you can see 90 m through is the
 * single loudest "this is a tech demo" signal in an underwater scene, so no
 * biome in the table is allowed to exceed its band.
 *
 * ---------------------------------------------------------------------------
 * 1b. THE NUMBERS HAVE TO SURVIVE TO THE SCREEN, NOT JUST TO THE TABLE
 * ---------------------------------------------------------------------------
 * A biome's fog hex is NOT what renders. render/underwater.js reshapes our
 * absorption triple and then multiplies fog, scatter and ambient by a spectral
 * tint derived from it:
 *
 *      tint_i(d) = exp( -(a'_i - min(a'_g, a'_b)) * min(d, hueCap) * hueK )
 *
 * That tint is an exponential in DEPTH, so a margin that is invisible at 15 m
 * is annihilating at 200 m. Measured on the shipped table, at the biome's own
 * depth it was multiplying the Dunes' red by 6e-5 and its authored tan-brown
 * `#6a5446` was rendering `#00523e` — a green frame in the one biome
 * AGENT_BRIEF names as warm. The Lava Zone rendered G/B 12, Blood Kelp 5.6,
 * the Lost River 1.37, and the Jellyshroom Cave's violet came out navy-black.
 * Every one of those is the same bug: an authored colour multiplied by a
 * transform the table did not account for.
 *
 * So the bake PRE-COMPENSATES. `screenTint()` below is a deliberate mirror of
 * the downstream transform, and every colour is divided by it at the biome's
 * `refDepth` — the depth its hex was eyedropped at. The table therefore holds
 * the colour you should MEASURE ON SCREEN, and the compensation is derived, not
 * eyeballed. update() re-reads the live constants off `underwater.params` on
 * the first frame and re-bakes if they have moved, so the two modules cannot
 * silently drift apart.
 *
 * COMP_MAX bounds the lift. A channel needing more than that is not recoverable
 * from here: the compensation and the tint only cancel exactly at refDepth with
 * that biome's own absorption, and during a crossfade the medium interpolates
 * colour and absorption independently — a 10^4 lift on one side of a boundary
 * would flash across the transition. See the note on `dunes`.
 *
 * NOTE ON HUE: absorption sets how fast the *near field* desaturates and how
 * far you can see. The far field's actual COLOUR is carried by fogColor /
 * scatterColor (see UNDERWATER_FRAG: as T -> 0 the pixel becomes pure
 * in-scatter). Both halves have to agree or the biome fights itself: the Lost
 * River used to claim green in a comment while its fog hex carried R = 31 and
 * its water type bent blue, and the far field is where a biome is read from.
 *
 * WHAT THE FOG HEXES ARE FOR. The single most-cited amateur tell in LOOK.md is
 * a monotonic blue->black depth ramp, and the fix for it is not in any shader —
 * it is COLUMN, plus the hexes it points at. Every fog/scatter pair below was
 * checked by resolving mix(fog, scatter, scatterStrength) in linear space
 * (which is exactly what uwInscatter evaluates), converting back to sRGB, and
 * comparing R-as-%-of-max and G/B against the corresponding LOOK.md sample.
 * Authoring the two hexes separately by eye does not work: the far field is the
 * mix, never the fog alone.
 *
 * ---------------------------------------------------------------------------
 * 1c. HUE IS EYEDROPPED, LEVEL IS MEASURED — `level` is the seam between them
 * ---------------------------------------------------------------------------
 * A fog/scatter hex answers two questions at once and they have different
 * evidence behind them. WHICH COLOUR the water is comes from eyedropping a
 * reference frame, and LOOK.md section 1 tabulates those per depth and per
 * biome. HOW BRIGHT that water is on screen is a different quantity: it is the
 * pair, mixed at scatterStrength, times depthDarken/aureole, and only a
 * water-only window measured in BOTH images can settle it.
 *
 * Round 28 measured the two apart for the first time and they disagreed:
 * kelp_forest's pair is LOOK.md's own #0B3710 fog and its #329C7C shaft colour
 * verbatim — the hue is right, and R%/saturation measure as hits — while the
 * level those two resolve to is 2.5x what the same reference frames show. So
 * `level` scales the pair AT BAKE TIME, before the pre-compensation, and does
 * nothing else. It is a pure linear multiply on both halves of the in-scatter
 * source, so every ratio the hexes encode — G/B, R as a fraction of max, the
 * per-pixel saturation — is preserved exactly, and the hexes stay the measured
 * colours a critic can check against LOOK.md rather than becoming derived
 * numbers nobody can trace.
 *
 * It deliberately does NOT touch ambientTop/ambientBottom. Those light
 * geometry, and core/underwaterMaterial.js already scales geometry by
 * uDepthDarken; folding a water-level correction into them would darken the
 * kelp twice and pull the silhouette-against-bright-water relationship the
 * wrong way.
 *
 * WHEN NOT TO USE IT. If the level error is in how much light the biome claims
 * to have rather than in the colour of its water, fix that instead — see
 * grand_reef, whose ambientFloor was asserting that a 280 m reef self-
 * illuminates at 30% of surface daylight. `level` would have hidden that.
 *
 * ---------------------------------------------------------------------------
 * 2. THE RETURN SHAPE  (designed to drop straight into U.*)
 * ---------------------------------------------------------------------------
 * `at(x, y, z)` returns a Medium. render/underwater.js can lerp field-for-field:
 *
 *      medium.fogColor        -> U.uFogColor          (THREE.Color, LINEAR)
 *      medium.scatterColor    -> U.uScatterColor
 *      medium.scatterStrength -> U.uScatterStrength
 *      medium.absorption      -> U.uAbsorption        (THREE.Vector3)
 *      medium.fogDensity      -> U.uFogDensity
 *      medium.maxVisibility   -> U.uMaxVisibility
 *      medium.ambientTop      -> U.uAmbientTop
 *      medium.ambientBottom   -> U.uAmbientBottom
 *      medium.depthDarken     -> U.uDepthDarken
 *      medium.caustics        -> U.uCausticsStrength
 *      medium.causticsScale   -> U.uCausticsScale
 *      medium.causticsSpeed   -> U.uCausticsSpeed
 *
 * plus godrays / particulate / bioluminescence / temperature / hostility /
 * exposure / ambience for the modules that want them. `applyToUniforms(U, m, k)`
 * does the whole write with a smoothing factor if you want it for free.
 *
 * The returned object is a REUSED SCRATCH. Copy it, or pass your own via
 * `at(x, y, z, createMedium())`, if you need to keep it across frames.
 *
 * ---------------------------------------------------------------------------
 * 3. SPAWN TABLE UNITS
 * ---------------------------------------------------------------------------
 * `density` is expected instances per 1000 m^2 of seabed, for both flora and
 * creatures (creatures are simply 2-3 orders of magnitude sparser). Multiply by
 * patch area / 1000. `cluster` is the mean clump size for flora, `group` the
 * min/max shoal size for creatures. Everything is a hint, not a contract —
 * flora/creatures own their own placement.
 */
import * as THREE from 'three';
import { WORLD } from '../core/globals.js';

// ---------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** sRGB hex -> linear-srgb THREE.Color (the renderer's working space). */
const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ---------------------------------------------------------------------------
// water optics
// ---------------------------------------------------------------------------

/** Jerlov Kd (m^-1) near 650 / 550 / 475 nm. See the header for provenance. */
export const JERLOV_KD = {
  I:   [0.360, 0.063, 0.021],
  IB:  [0.370, 0.070, 0.030],
  II:  [0.390, 0.089, 0.060],
  III: [0.430, 0.140, 0.120],
  C1:  [0.460, 0.190, 0.200],
  C3:  [0.510, 0.270, 0.320],
  C5:  [0.630, 0.420, 0.550],
};

/**
 * One entry that is NOT a Jerlov type, kept separate so the table above stays
 * honest. Jerlov measured *daylight* penetrating open and coastal water, where
 * absorption dominates. Four of our biomes are not that: the Dunes is carbonate
 * sand held in permanent suspension, the Inactive Lava Zone is ash and mineral
 * precipitate lit from below by magma, the Jellyshroom Cave and the Lost River
 * are roofed and lit entirely by what grows in them. All four are dominated by
 * large-particle (Mie) scattering, which is spectrally FLAT — the same reason
 * fog, cloud and milk are grey rather than blue.
 *
 * EXACTLY flat, all three channels equal, and that is deliberate. The
 * downstream tint is exp(-(a_i - survivor) * depth * k): any residual spread,
 * multiplied by 200-1200 m of depth, bleaches a biome to its surviving channel.
 * The old MIE entry carried a 5% spread and that alone was enough to render the
 * Lava Zone at G/B 12 and the Dunes green. There is also nothing to model: the
 * tint represents daylight filtered on its way down, and none of these four
 * biomes is lit by daylight at all. The correct spectral filter for light that
 * was emitted three metres away is the identity, and a flat medium is how this
 * table says so.
 */
const MIE_KD = [0.545, 0.545, 0.545];

const WATER_TYPES = { ...JERLOV_KD, MIE: MIE_KD };

/** maxVisibility is the range where the SURVIVING channel falls to e^-K_VIS. */
const K_VIS = 1.85;

/**
 * Compression applied to the Kd *differences* — see the header. These are the
 * only two free parameters in the derivation and each has one job.
 *
 * HUE_DISP 0.26 puts clear ocean's real green/blue margin of 0.042/m at
 * 0.0109/m — the per-metre rotation that would carry godrays-1's measured
 * top-to-bottom sweep (G/B 1.09 at the top of frame, 0.83 where the water meets
 * the spires) over the ~100 m of depth that frame spans.
 *
 * Two things downstream currently eat most of that, and it is worth being
 * precise rather than claiming the frame result: render/underwater.js
 * compresses the green/blue gap by a power of 0.42 before use, and caps the
 * tint's depth at 60 m, so below 60 m the rotation is a per-frame constant and
 * contributes no in-frame gradient at all. What this margin still does buy is
 * the direction — the column rotates back toward blue below 155 m instead of
 * further green — and the geometry's convergence: green transmits further than
 * blue in the kelp and the reverse in open water, so distant terrain drifts the
 * right way. The rest of the in-frame vertical gradient is the other module's
 * uwBright/uwZenith, which is brightness only.
 *
 * RED_DISP 0.115 puts clear ocean's red margin of 0.339/m at 0.039/m. Red then
 * still dies ~4x faster than the surviving channel — a rock at 40 m keeps 4% of
 * its red against 23% of its green — but tan sand three metres under the camera
 * is still tan, which is what shallows-floor-1 shows at 8 m and what a margin
 * of 0.16/m (the old table's) made impossible. NOTE that underwater.js floors
 * a_red at 5.2x the survivor regardless of what we ask for; see `dunes`.
 *
 * MEASURED r22 — THAT FLOOR BINDS ON ALL 15 BIOMES, SO RED_DISP IS INERT.
 *
 * screenAbsorption() below is an exact mirror of underwater.js: red reaches the
 * shaders as min(0.62, max(a_red, min(a_g,a_b) * visGain * redRatio)). Evaluated
 * over the whole table, a_red is BELOW that floor in every single row, so the
 * red we author is discarded and the red that renders is always
 * 4.472 x the surviving channel. Verified against the live uniform, not just
 * the mirror: grand_reef authors 0.1384/m and the shaders receive 0.4596/m,
 * which is the floor to four decimals; safe_shallows authors 0.0681 and receives
 * 0.1655, likewise the floor.
 *
 * The consequence for anyone briefed to "lower red absorption in biomes": there
 * is no such knob here. Lowering a_red cannot move a max(), and the floor is
 * built from min(a_g,a_b), which may not move. Rendered relative red is
 * exp(-(redRatio-1) * visGain * K_VIS * d / visibility) — a function of
 * distance over visibility and of redRatio ALONE. It is controllable from
 * render/underwater.js (redRatio) and, separately and effectively, from the
 * authored fog/scatter colours below; it is not controllable from this triple.
 */
const HUE_DISP = 0.26;
const RED_DISP = 0.115;

/**
 * Per-channel Beer-Lambert extinction for a water type at a target visibility.
 * Level from the visibility (the flat particulate term), margins from the
 * Jerlov differences (the spectral term). See section 1 of the header.
 * @param {string} type  key into WATER_TYPES
 * @param {number} visibility  metres at which the surviving channel falls to ~16%
 */
export function deriveAbsorption(type, visibility) {
  const kd = WATER_TYPES[type] || WATER_TYPES.I;
  const surv = Math.min(kd[1], kd[2]);
  const base = K_VIS / Math.max(1, visibility);
  return new THREE.Vector3(
    base + RED_DISP * (kd[0] - surv),
    base + HUE_DISP * (kd[1] - surv),
    base + HUE_DISP * (kd[2] - surv),
  );
}

/** The channel a biome sees distance through — green in coastal water. */
const survivorAbsorption = (a) => Math.min(a.y, a.z);

// ---------------------------------------------------------------------------
// the downstream mirror
// ---------------------------------------------------------------------------
/**
 * A copy of the constants render/underwater.js applies to our medium before it
 * reaches a pixel. Kept here so the bake can cancel them, and re-read off the
 * live module on our first frame (see update()) so an edit over there cannot
 * silently invalidate this table.
 *
 *   visGain/spread/redRatio  its shapeAbsorption(): the surviving channel is
 *                            scaled, the gap to the other of green/blue is
 *                            compressed by a power, and red is floored at
 *                            redRatio x the survivor.
 *   hueK/hueCap              its hueTint(): exp(-rel * min(depth, cap) * k).
 */
const DOWNSTREAM = {
  hueK: 0.58, hueCap: 60.0,
  visGain: 0.86, spread: 0.42, redRatio: 5.2, redMax: 0.62,
};

/** Bound on the pre-compensation lift — see the header, and `dunes`. */
const COMP_MAX = 4.0;

/** Mirror of underwater.js shapeAbsorption(): what the shaders actually get. */
function screenAbsorption(a) {
  const D = DOWNSTREAM;
  const s = Math.min(a.y, a.z), o = Math.max(a.y, a.z);
  const s2 = s * D.visGain;
  const o2 = s2 * Math.pow(o / Math.max(s, 1e-6), D.spread);
  const greenSurvives = a.y <= a.z;
  return {
    r: Math.min(D.redMax, Math.max(a.x, s2 * D.redRatio)),
    g: greenSurvives ? s2 : o2,
    b: greenSurvives ? o2 : s2,
  };
}

/**
 * The spectral tint the medium will be multiplied by at `depth`, per channel.
 * Mirror of underwater.js hueTint() composed with its absorption reshaping.
 * @returns {{r:number,g:number,b:number}} each in (0, 1]
 */
export function screenTint(a, depth) {
  const D = DOWNSTREAM;
  const s = screenAbsorption(a);
  const surv = Math.min(s.g, s.b);
  const k = Math.min(Math.max(depth, 0), D.hueCap) * D.hueK;
  return {
    r: Math.exp(-Math.max(0, s.r - surv) * k),
    g: Math.exp(-Math.max(0, s.g - surv) * k),
    b: Math.exp(-Math.max(0, s.b - surv) * k),
  };
}

/**
 * Divide an authored colour by the tint it will be multiplied by, so the hex in
 * the table is the colour that lands on screen at `refDepth`. Bounded by
 * COMP_MAX: past that the channel is not recoverable from here (see header).
 */
function precompensate(color, tint) {
  color.r *= Math.min(1 / Math.max(tint.r, 1e-6), COMP_MAX);
  color.g *= Math.min(1 / Math.max(tint.g, 1e-6), COMP_MAX);
  color.b *= Math.min(1 / Math.max(tint.b, 1e-6), COMP_MAX);
  return color;
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------
// `depth`  : [top, bottom] metres BELOW the surface (positive).
// `sites`  : horizontal patches {x, z, r: full-strength radius, f: feather}.
//            A biome with no sites only exists through the open-water column.
//            Patches are laid out as a crater: Safe Shallows at the lifepod,
//            a ring of 78-170 m biomes around it, then 220-480 m biomes, then
//            the void. Surface patches are kept far enough apart that their
//            `floor` values never fight — where they do touch, the blend is a
//            real slope between two plausible seabed depths.
// `floor`  : nominal seabed depth at the site centres — terrain may use
//            floorDepthAt() to shape the crater from this.
// `interior`: roofed. Interior biomes are CAVERN LAYERS that sit underneath
//            surface biomes at the same (x, z) — the Jellyshroom Cave is below
//            the kelp, the Lava Zone is below everything. They are found by
//            at() (which knows your depth) and by cavernsAt(), but they are
//            excluded from the seabed queries groundAt/groundWeights/
//            floorDepthAt, which answer "what is the open sea floor here".
// `visibility` + `jerlov` derive `absorption` / `fogDensity` / `maxVisibility`.
//            `jerlov` keys WATER_TYPES, which is JERLOV_KD plus the one
//            non-Jerlov entry 'MIE' — see MIE_KD for who gets it and why.
// `skylight`: how much of the sky reaches this place at all (0 = roofed cave).
// Colours are authored in sRGB hex, eyedropped against reference/subnautica/,
// and converted to linear at load.

const RAW = [
  {
    id: 'safe_shallows',
    name: 'Safe Shallows',
    ambience: 'shallows-reef',
    depth: [0, 60], floor: 26,
    sites: [{ x: 0, z: 0, r: 120, f: 70 }, { x: -140, z: 55, r: 80, f: 50 }],
    // Clearest water in the game — but "clearest" is 50 m, not 90: LOOK.md
    // section 2 measures 40-60 m at 0-30 m deep and shallows-reef-1.jpg has the
    // reef dissolving well inside the frame.
    //
    // C1, not Jerlov I. The crater's top 60 m is a productive reef shelf: it is
    // the CDOM- and plankton-rich layer that sits over clear oceanic water in
    // every real coastal ocean, and it is what makes G/B climb from 0.78 at
    // 5-15 m to 0.89 at 25-40 m in LOOK.md's own table while the open column
    // below goes the other way.
    //
    // refDepth 15 is not decoration. It is the ONLY reason this biome renders
    // with any red at all: the pre-compensation is exp(rel_red * min(d,60) *
    // hueK), so at 15 m it is 3.2x and lands inside COMP_MAX, where at 30 m it
    // would be 10x and clamp. shallows-reef-1 measures R at 28-35% of frame max
    // in its water; the shipped table rendered 12-18%.
    jerlov: 'C1', visibility: 50, refDepth: 15,
    fog: 0x1a90c4, scatter: 0x4fc9f2, scatterStrength: 0.52,
    ambientTop: 0x5fb6de, ambientBottom: 0x1b4260,
    caustics: 1.0, causticsScale: 0.055, causticsSpeed: 0.06,
    skylight: 1.0, godrays: 1.0, particulate: 0.55,
    ambientFloor: 0.000,
    bioluminescence: 0.06, biolum: 0x59d8ff,
    temperature: 24, hostility: 0.05, exposure: 1.22,
    // The sand is authored WARM — R/G = 1.55 in linear, against the 1.18 it
    // used to carry. shallows-floor-1.jpg is the reference for near-field sand
    // and it measures #89715c with red the largest channel in every band; ours
    // rendered #36706f with red at 48% of max. Part of that is the medium's red
    // absorption (see the note on RED_DISP) and part is simply that a pale
    // cream albedo has no warmth left to lose once the water has taken 40% of
    // it. Sand is a warm tan before the water gets to it.
    terrain: {
      sand: 0xdbb379, sandRough: 0.94,
      rock: 0x8b8570, rockRough: 0.82,
      accent: 0xe0705a, accentRough: 0.55,
      detail: 0xbfa473, slope: 0.55,
    },
    // LOOK.md section 8 measures coral tubes at 3-8 m and table/brain coral at
    // 5-15 m across, and its scale rule demands knee-height mats AND towers in
    // the same frame. This is the biome the player lives in, so the spread here
    // (0.4 m weed to a 13 m coral table, 32x) matters more than anywhere else.
    flora: [
      { id: 'sea_grass',    density: 240, scale: [0.5, 0.9],  cluster: 9 },
      { id: 'coral_tube',   density: 20,  scale: [2.6, 7.5],  cluster: 3 },
      { id: 'table_coral',  density: 7,   scale: [4.0, 13.0], cluster: 2 },
      { id: 'brain_coral',  density: 6,   scale: [2.5, 8.0],  cluster: 1 },
      { id: 'acid_mushroom',density: 18,  scale: [0.7, 2.0],  cluster: 6 },
      { id: 'writhing_weed',density: 22,  scale: [0.4, 0.8],  cluster: 4 },
      { id: 'veined_nettle',density: 9,   scale: [0.6, 1.6],  cluster: 2 },
    ],
    creatures: [
      { id: 'peeper',      density: 3.0,   group: [2, 6] },
      { id: 'boomerang',   density: 2.2,   group: [2, 5] },
      { id: 'holefish',    density: 2.6,   group: [3, 8] },
      { id: 'bladderfish', density: 1.1,   group: [1, 3] },
      { id: 'rabbit_ray',  density: 0.45,  group: [1, 2] },
      { id: 'gasopod',     density: 0.10,  group: [1, 1] },
      { id: 'crashfish',   density: 0.55,  group: [1, 1] },
      { id: 'reefback',    density: 0.006, group: [1, 1] },
    ],
    resources: ['limestone', 'sandstone', 'salt', 'coral_sample'],
  },

  {
    id: 'kelp_forest',
    name: 'Kelp Forest',
    ambience: 'kelp-creak',
    depth: [40, 120], floor: 78,
    sites: [{ x: 165, z: -130, r: 110, f: 60 }, { x: -230, z: -230, r: 100, f: 55 }],
    // Creepvine dumps dissolved organic matter into the column: blue is eaten,
    // the green window opens. Jerlov II was the wrong call — its Kd still has
    // blue surviving (0.060 < 0.089), so the "green" biome bent BLUE with
    // distance. C1 is the first coastal type where green genuinely outlives
    // blue (0.190 < 0.200), which is the whole physical reason kelp water is
    // green. Fog is pulled down to LOOK.md's measured #0B3710 / #164619 family
    // and the light-shaft #329C7C is carried by scatter, where it belongs:
    // the pair resolves to #10704c, G/B 1.47 against a reference that runs
    // 1.21 at the surface to 2.43 at the floor.
    //
    // Measured on kelp-forest-1.jpg with the same readback used on our frames:
    // G/B 1.25 at the top of frame falling to 2.30 at the floor, R at 34% of
    // max up top and 7% at the bottom. godrays-2.jpg, deeper into the canopy,
    // runs G/B 2.7-4.4. So the kelp is far greener than the shipped pair, which
    // rendered a flat 1.23 everywhere.
    //
    // r28 — LEVEL. The pair above is right about hue and was 2.5x too bright.
    // Measured on water-only windows in both images, both UNGRADED:
    //
    //   ours   kelp-forest.png px(640,0)-(800,340)  G 248.9  lum p10/p90 212.9/214.5
    //   plate  kelp-forest-1   px(950,30)-(1075,165) G 227.9  lum p10/p90 179.8/212.6
    //
    // and that plate is 15-25 m against our 55 m, so ours has to be DARKER.
    // A channel at 249/255 inside the medium has no headroom: nothing
    // downstream can add light to it and every operator that touches it clips.
    // 99.2% of that window sits above G = 240 and its top 300 rows are dead
    // flat at G 249.1/249.8/249.8 — the up-look has no gradient left in it.
    //
    // `level` is derived, not dialled. The biome's own far field resolves on
    // screen to mix(fog, scatter, 0.42) x depthDarken/aureole; at this biome's
    // refDepth that is linear-green 0.1018, i.e. sRGB G = 90. LOOK.md section 1
    // measures the kelp column at #164619 (G 70) over #0B3710 (G 55) across
    // 25-40 m, and refDepth 55 is below that band, so the lower value is the
    // honest anchor: 0.40 lands the biome's own far field on G 57.
    //
    // Cross-checked against a second plate that is NOT this shot's primary, on
    // water-only windows: godrays-2 (29 m kelp, HUD cropped out) reads G 59-80
    // at luminance 46-64 in three separate windows. At 55 m we should sit at or
    // under that, and 0.40 puts the blended far field at G 72.
    //
    // NOTE FOR WHOEVER TAKES THIS FURTHER — THIS WINDOW HAS A FLOOR AT G ~127.
    // The shot camera [130,-55,-90] sits 11% inside the Safe Shallows feather
    // (weights kelp 0.886 / safe_shallows 0.110 / crash_zone 0.005), and the
    // shallows pair is far brighter. Driving `level` to 0 here would still
    // leave the window at G 127, because that residue is not ours. Anything
    // below that has to come from the blend or from safe_shallows, and
    // safe_shallows is a verified match.
    jerlov: 'C1', visibility: 38, refDepth: 55, level: 0.40,
    fog: 0x0a3814, scatter: 0x2aa254, scatterStrength: 0.42,
    ambientTop: 0x3f9c74, ambientBottom: 0x102a1e,
    caustics: 0.78, causticsScale: 0.048, causticsSpeed: 0.05,
    skylight: 0.82, godrays: 0.85, particulate: 0.9,
    ambientFloor: 0.012,
    bioluminescence: 0.14, biolum: 0x7cff9e,
    temperature: 20, hostility: 0.35, exposure: 1.28,
    terrain: {
      sand: 0xb8b183, sandRough: 0.93,
      rock: 0x6f7a5e, rockRough: 0.86,
      accent: 0xcf9a3c, accentRough: 0.6,
      detail: 0x8d9067, slope: 0.7,
    },
    // Creepvine is measured at 25-40 m — 15-25x player height (LOOK.md §8).
    flora: [
      { id: 'kelp_vine',     density: 5.5, scale: [25, 40],   cluster: 2 },
      { id: 'sea_grass',     density: 120, scale: [0.5, 1.0], cluster: 8 },
      { id: 'blood_grass',   density: 34,  scale: [0.4, 0.9], cluster: 6 },
      { id: 'acid_mushroom', density: 26,  scale: [0.7, 1.9], cluster: 6 },
      { id: 'coral_tube',    density: 8,   scale: [2.0, 5.5], cluster: 2 },
    ],
    creatures: [
      { id: 'peeper',      density: 2.4,   group: [3, 9] },
      { id: 'hoopfish',    density: 2.0,   group: [4, 10] },
      { id: 'oculus',      density: 0.9,   group: [1, 3] },
      { id: 'stalker',     density: 0.16,  group: [1, 2] },
      { id: 'bladderfish', density: 0.8,   group: [1, 3] },
      { id: 'reefback',    density: 0.004, group: [1, 1] },
    ],
    resources: ['limestone', 'sandstone', 'creepvine_seed', 'silver_ore'],
  },

  {
    id: 'grassy_plateaus',
    name: 'Grassy Plateaus',
    ambience: 'plateau-open',
    depth: [60, 160], floor: 105,
    sites: [{ x: -200, z: 200, r: 120, f: 65 }, { x: 250, z: 265, r: 130, f: 70 }],
    // The 25-60 m rung of the open column as well as a place: LOOK.md's 25-40 m
    // open-water sample is #14636F, R at 18% of max and G/B 0.89 — noticeably
    // darker and more teal than the 5-15 m cyan above it. That step is what the
    // column crossfade from safe_shallows into this biome carries.
    jerlov: 'IB', visibility: 45, refDepth: 55,
    fog: 0x0a5c70, scatter: 0x2e9aa8, scatterStrength: 0.46,
    ambientTop: 0x4ea8a6, ambientBottom: 0x14343f,
    caustics: 0.92, causticsScale: 0.052, causticsSpeed: 0.055,
    skylight: 0.95, godrays: 0.9, particulate: 0.7,
    ambientFloor: 0.004,
    bioluminescence: 0.08, biolum: 0x66e0c8,
    temperature: 18, hostility: 0.3, exposure: 1.12,
    terrain: {
      sand: 0xcdbe95, sandRough: 0.94,
      rock: 0x7f8271, rockRough: 0.84,
      accent: 0x6fae4a, accentRough: 0.7,
      detail: 0xa5a37e, slope: 0.6,
    },
    // Mats cover the plateau tops (LOOK.md §8: 0.3-1 m carpets) but the shelves
    // themselves carry coral towers, or the whole biome reads as a lawn.
    flora: [
      { id: 'sea_grass',      density: 300, scale: [0.6, 1.2], cluster: 12 },
      { id: 'blood_grass',    density: 48,  scale: [0.5, 1.0], cluster: 7 },
      { id: 'gel_sack',       density: 6,   scale: [0.6, 1.3], cluster: 2 },
      { id: 'speckled_rattler',density: 14, scale: [0.6, 1.4], cluster: 3 },
      { id: 'coral_tube',     density: 6,   scale: [2.5, 7.0], cluster: 2 },
      { id: 'table_coral',    density: 3,   scale: [4.0, 11.0],cluster: 1 },
      { id: 'veined_nettle',  density: 10,  scale: [1.2, 3.2], cluster: 3 },
    ],
    creatures: [
      { id: 'peeper',      density: 1.6,   group: [2, 6] },
      { id: 'reginald',    density: 1.1,   group: [1, 4] },
      { id: 'rabbit_ray',  density: 0.6,   group: [1, 3] },
      { id: 'stalker',     density: 0.10,  group: [1, 2] },
      { id: 'sand_shark',  density: 0.22,  group: [1, 2] },
      { id: 'gasopod',     density: 0.14,  group: [1, 3] },
      { id: 'reefback',    density: 0.005, group: [1, 1] },
    ],
    resources: ['limestone', 'sandstone', 'shale', 'copper_ore', 'silver_ore'],
  },

  {
    id: 'mushroom_forest',
    name: 'Mushroom Forest',
    ambience: 'mushroom-hum',
    depth: [80, 250], floor: 150,
    sites: [{ x: -330, z: -40, r: 150, f: 80 }],
    // Tree mushroom caps shed spores into the column all day; green survives.
    jerlov: 'C1', visibility: 36, refDepth: 150,
    fog: 0x0b5a58, scatter: 0x30a08e, scatterStrength: 0.46,
    ambientTop: 0x469c93, ambientBottom: 0x102e30,
    caustics: 0.68, causticsScale: 0.05, causticsSpeed: 0.05,
    skylight: 0.72, godrays: 0.75, particulate: 1.0,
    ambientFloor: 0.030,
    bioluminescence: 0.2, biolum: 0xff8fc2,
    temperature: 16, hostility: 0.3, exposure: 1.02,
    terrain: {
      sand: 0xbfb494, sandRough: 0.92,
      rock: 0x6d7668, rockRough: 0.85,
      accent: 0xd76a8c, accentRough: 0.5,
      detail: 0x8f8e72, slope: 0.75,
    },
    flora: [
      { id: 'tree_mushroom', density: 3.2, scale: [6, 18],    cluster: 2 },
      { id: 'purple_fan',    density: 12,  scale: [0.8, 2.0], cluster: 3 },
      { id: 'gel_sack',      density: 16,  scale: [0.6, 1.4], cluster: 3 },
      { id: 'pygmy_fan',     density: 44,  scale: [0.2, 0.5], cluster: 8 },
      { id: 'acid_mushroom', density: 20,  scale: [0.7, 2.0], cluster: 6 },
    ],
    creatures: [
      { id: 'peeper',      density: 1.2,   group: [2, 5] },
      { id: 'jellyray',    density: 0.35,  group: [1, 2] },
      { id: 'reginald',    density: 0.9,   group: [1, 3] },
      { id: 'mesmer',      density: 0.18,  group: [1, 1] },
      { id: 'shuttlebug',  density: 1.4,   group: [1, 4] },
      { id: 'boneshark',   density: 0.09,  group: [1, 2] },
    ],
    resources: ['limestone', 'sandstone', 'shale', 'gold', 'lithium'],
  },

  {
    id: 'bulb_zone',
    name: 'Bulb Zone',
    ambience: 'bulb-drone',
    depth: [150, 350], floor: 265,
    sites: [{ x: -420, z: -380, r: 140, f: 75 }],
    // Bulb bushes are so dense they act as a second canopy: little sky gets in,
    // and what light there is has already been through 150 m of water. C1
    // rather than III because III's Kd still passes blue faster than green
    // (0.120 vs 0.140) — a green biome on a blue-surviving water type is a
    // biome that unwinds its own colour the further you look into it.
    jerlov: 'C1', visibility: 20, refDepth: 250,
    fog: 0x074628, scatter: 0x229c52, scatterStrength: 0.44,
    ambientTop: 0x3f9c58, ambientBottom: 0x0e2a1c,
    caustics: 0.3, causticsScale: 0.042, causticsSpeed: 0.04,
    skylight: 0.4, godrays: 0.4, particulate: 1.25,
    ambientFloor: 0.090,
    bioluminescence: 0.55, biolum: 0x9cff5a,
    temperature: 12, hostility: 0.55, exposure: 1.08,
    terrain: {
      sand: 0x9aa376, sandRough: 0.9,
      rock: 0x5c6b58, rockRough: 0.88,
      accent: 0x8ce04f, accentRough: 0.45,
      detail: 0x6f7d5c, slope: 0.85,
    },
    flora: [
      { id: 'bulb_bush',     density: 9,   scale: [3, 9],     cluster: 3 },
      { id: 'koosh_sphere',  density: 3.4, scale: [4, 8],     cluster: 2 },
      { id: 'sea_crown',     density: 2.2, scale: [3, 8],     cluster: 1 },
      { id: 'gel_sack',      density: 14,  scale: [0.6, 1.4], cluster: 3 },
      { id: 'purple_fan',    density: 10,  scale: [0.8, 2.0], cluster: 3 },
      { id: 'blue_palm',     density: 6,   scale: [1.5, 3.5], cluster: 2 },
    ],
    creatures: [
      { id: 'ampeel',      density: 0.16,  group: [1, 1] },
      { id: 'boneshark',   density: 0.4,   group: [1, 3] },
      { id: 'blighter',    density: 1.3,   group: [3, 8] },
      { id: 'jellyray',    density: 0.3,   group: [1, 2] },
      { id: 'shuttlebug',  density: 1.0,   group: [1, 4] },
    ],
    resources: ['shale', 'sandstone', 'lithium', 'magnetite', 'nickel_ore'],
  },

  {
    id: 'dunes',
    name: 'Dunes',
    ambience: 'dunes-wind',
    depth: [100, 320], floor: 220,
    sites: [{ x: -40, z: -450, r: 190, f: 105 }],
    // THE WARM BIOME, and a named non-negotiable (AGENT_BRIEF §4.3). misc-1.jpg
    // is a Reaper hanging in TAN-BROWN fog: R is the largest channel at 121-125%
    // of the next, G/B 1.28-1.57, measured #6B5845 / #A28458. Our fog x scatter
    // resolves to #876d4a, dead inside that.
    //
    // The brown is not transmitted daylight — nothing red survives 200 m of
    // water. It is the ALBEDO of carbonate sand held in permanent suspension by
    // the current, which is also why you can only see 24 m here (the Reaper in
    // the reference dissolves at about that range). That makes it a Mie medium,
    // not a Jerlov one — see MIE_KD: a flat spectrum, so the tan is carried all
    // the way to the far field instead of being bleached olive by 200 m of
    // depth-scaled hue shift. In misc-1.jpg every pixel is brown, including the
    // water directly overhead; there is no teal anywhere in that frame.
    //
    // MEASURED STATE, and a blocker to be honest about. misc-1.jpg reads R at
    // 100% of max in every band, G/B 1.28-1.52, median luminance 98. This table
    // now hands render/underwater.js exactly that colour on a perfectly flat
    // medium, so nothing here rotates its hue with depth. It still does not
    // render brown, and the reason is one line in another module:
    // shapeAbsorption() floors the red channel at redRatio (5.2) x the
    // surviving channel before hueTint() runs, so the tint applied to red is
    //     exp(-4.2 * visGain * a_surv * hueCap * hueK)  =  exp(-232/visibility)
    // — 6e-5 here, and under 1% for ANY visibility inside LOOK.md section 2's
    // bands. Red cannot reach the screen through the medium at all. Cancelling
    // it would need a 16000x lift on the fog hex; COMP_MAX stops at 4 because a
    // lift like that only cancels at this biome's own absorption, and the
    // crossfade at the Dunes boundary interpolates colour and absorption
    // independently — it would flash scarlet across the transition.
    // The table is correct and will render correctly the moment redRatio is
    // relaxed or applied after the tint instead of before it.
    jerlov: 'MIE', visibility: 24, refDepth: 220,
    fog: 0x6b5546, scatter: 0xa98a5e, scatterStrength: 0.46,
    ambientTop: 0x9a8055, ambientBottom: 0x2e2418,
    caustics: 0.10, causticsScale: 0.06, causticsSpeed: 0.05,
    skylight: 0.85, godrays: 0.5, particulate: 1.15,
    // A high-albedo scattering medium is BRIGHT — that is why fog is bright and
    // clear air is not. misc-1.jpg has a median luminance of 98 at 200 m+, far
    // above what clear water at that depth would give, and the sediment itself
    // is what is carrying the light.
    ambientFloor: 0.150,
    bioluminescence: 0.05, biolum: 0x4fb8ff,
    temperature: 10, hostility: 0.8, exposure: 0.98,
    terrain: {
      sand: 0xc6b898, sandRough: 0.95,
      rock: 0x79776b, rockRough: 0.83,
      accent: 0xa08c6a, accentRough: 0.7,
      detail: 0xa79b7e, slope: 0.45,
    },
    // Barren, but not featureless — the reference frame still puts a rock mass
    // and a 20 m silhouette in the shot. Sparse sea crowns carry the tall end.
    flora: [
      { id: 'sea_grass',     density: 26,  scale: [0.4, 0.8], cluster: 5 },
      { id: 'blood_grass',   density: 10,  scale: [0.4, 0.9], cluster: 4 },
      { id: 'gel_sack',      density: 3,   scale: [0.6, 1.2], cluster: 1 },
      { id: 'spike_plant',   density: 4,   scale: [1.5, 4.0], cluster: 2 },
      { id: 'sea_crown',     density: 1.2, scale: [3.0, 7.5], cluster: 1 },
    ],
    creatures: [
      { id: 'reginald',    density: 0.6,   group: [1, 3] },
      { id: 'sand_shark',  density: 0.5,   group: [1, 3] },
      { id: 'boneshark',   density: 0.2,   group: [1, 2] },
      { id: 'gasopod',     density: 0.2,   group: [1, 4] },
      { id: 'reaper',      density: 0.0035, group: [1, 1] },
    ],
    resources: ['sandstone', 'limestone', 'quartz', 'magnetite', 'nickel_ore'],
  },

  {
    id: 'crash_zone',
    name: 'Crash Zone',
    ambience: 'crash-groan',
    depth: [60, 220], floor: 130,
    sites: [{ x: 300, z: 20, r: 140, f: 80 }],
    // The Aurora ploughed this trench and it has not settled. Iron oxide and
    // pulverised sediment: Jerlov C1 coastal murk, green-surviving, olive and
    // low-contrast. Warm, but only barely — LOOK.md §11.1 puts the ceiling for
    // a daylight biome's red well under the Dunes', and the Aurora's rust reads
    // on the debris and the terrain accent, not in the water.
    jerlov: 'C1', visibility: 20, refDepth: 130,
    fog: 0x143d36, scatter: 0x458066, scatterStrength: 0.48,
    ambientTop: 0x468272, ambientBottom: 0x18282a,
    caustics: 0.5, causticsScale: 0.05, causticsSpeed: 0.055,
    skylight: 0.8, godrays: 0.7, particulate: 1.8,
    ambientFloor: 0.030,
    bioluminescence: 0.04, biolum: 0xff9a4f,
    temperature: 30, hostility: 0.9, exposure: 0.98,
    terrain: {
      sand: 0xb8a184, sandRough: 0.95,
      rock: 0x7a6a58, rockRough: 0.8,
      accent: 0xb0562c, accentRough: 0.65,
      detail: 0x8f7358, slope: 0.6,
    },
    // Three rows nobody else has. A table that is a strict subset of its
    // neighbours cannot read as its own place however good the fog is — and
    // this one is the most legible story on the map: creepvine that burned when
    // the drive core went, coral fused into slag, ash mats over everything.
    flora: [
      { id: 'scorched_vine', density: 3.5, scale: [8.0, 20.0], cluster: 2 },
      { id: 'slag_coral',    density: 7,   scale: [2.0, 6.0],  cluster: 2 },
      { id: 'ash_weed',      density: 34,  scale: [0.3, 0.9],  cluster: 7 },
      { id: 'blood_grass',   density: 16,  scale: [0.4, 0.9],  cluster: 5 },
      { id: 'acid_mushroom', density: 10,  scale: [0.7, 1.8],  cluster: 4 },
    ],
    creatures: [
      { id: 'biter',       density: 1.6,   group: [2, 6] },
      { id: 'boneshark',   density: 0.3,   group: [1, 3] },
      { id: 'sand_shark',  density: 0.24,  group: [1, 2] },
      { id: 'reaper',      density: 0.006, group: [1, 1] },
      { id: 'cave_crawler',density: 0.9,   group: [1, 4] },
    ],
    resources: ['titanium_scrap', 'copper_ore', 'lead', 'sandstone', 'lithium'],
  },

  {
    id: 'sparse_reef',
    name: 'Sparse Reef',
    ambience: 'sparse-open',
    depth: [80, 260], floor: 170,
    sites: [{ x: 0, z: 320, r: 160, f: 90 }, { x: 450, z: 300, r: 150, f: 85 }],
    // The 100-120 m rung of the open column: LOOK.md measures #066F80 / #0A5C6B
    // there — still B > G, but only just, and red is already at 5. The pair
    // resolves to G/B 0.87 at R under 5%: the last cyan step before green takes
    // over in the Underwater Islands column below.
    //
    // Jerlov I, and here the type is doing real work rather than decorating a
    // comment: this is open oceanic water under the shelf, so blue outlives
    // green by 0.011/m and the column rotates BACK toward navy from here down
    // instead of holding teal all the way to the Grand Reef.
    jerlov: 'I', visibility: 35, refDepth: 105,
    fog: 0x066a7c, scatter: 0x2c9fb0, scatterStrength: 0.48,
    ambientTop: 0x3f96a8, ambientBottom: 0x122f42,
    caustics: 0.8, causticsScale: 0.058, causticsSpeed: 0.055,
    skylight: 0.92, godrays: 0.8, particulate: 0.6,
    ambientFloor: 0.010,
    bioluminescence: 0.09, biolum: 0x5fd0ff,
    temperature: 14, hostility: 0.25, exposure: 1.1,
    terrain: {
      sand: 0xcabf9e, sandRough: 0.93,
      rock: 0x7d8078, rockRough: 0.84,
      accent: 0x7fbfd0, accentRough: 0.5,
      detail: 0x9fa189, slope: 0.65,
    },
    flora: [
      { id: 'sea_grass',    density: 70,  scale: [0.5, 1.0],  cluster: 7 },
      { id: 'table_coral',  density: 6,   scale: [4.0, 12.0], cluster: 2 },
      { id: 'coral_tube',   density: 9,   scale: [2.2, 6.5],  cluster: 3 },
      { id: 'purple_fan',   density: 7,   scale: [0.8, 1.8],  cluster: 2 },
      { id: 'blue_palm',    density: 5,   scale: [1.2, 3.0],  cluster: 2 },
    ],
    creatures: [
      { id: 'peeper',      density: 0.9,   group: [2, 6] },
      { id: 'spadefish',   density: 1.2,   group: [3, 9] },
      { id: 'jellyray',    density: 0.3,   group: [1, 2] },
      { id: 'reginald',    density: 0.7,   group: [1, 3] },
      { id: 'boneshark',   density: 0.1,   group: [1, 2] },
      { id: 'reefback',    density: 0.005, group: [1, 1] },
    ],
    resources: ['limestone', 'sandstone', 'quartz', 'silver_ore', 'gold'],
  },

  {
    id: 'underwater_islands',
    name: 'Underwater Islands',
    ambience: 'islands-teal',
    // THE GREEN-TEAL RUNG. This is the one entry the whole depth ramp was
    // missing. AGENT_BRIEF §4.1 and LOOK.md rule 2 both make the same measured
    // claim: at 100-200 m green OVERTAKES blue and red measures 0 — godrays-1.jpg
    // reads a literal #00AA9C with R = 0 — and skipping that band is called out
    // as the single most common amateur tell. Every other mid-depth biome we
    // own is either locked to one 140 m patch (bulb_zone, lost_river) or is
    // blue (sparse_reef, dunes), so the open column ran cyan -> blue -> navy and
    // never once crossed G/B = 1.
    //
    // Like `void`, this biome has NO sites: it is the open ocean between the
    // crater shelf and the Grand Reef, so it is reached purely through COLUMN.
    // LOOK.md §1 names it directly — "Grand Reef / Underwater Islands, teal
    // #00AA9C over navy #011434" — and that vertical pair is exactly what
    // render/underwater.js's backdrop builds out of fog + ambientBottom.
    depth: [90, 300], floor: 240,
    sites: [],
    // Jerlov I — clear oceanic water, blue outliving green by 0.011/m after
    // HUE_DISP. That is a REVERSAL of the shipped table, which keyed C1 so the
    // medium would bend further green with depth, and it is the single most
    // load-bearing correction in this round.
    //
    // godrays-1.jpg is this depth and this framing, and measured band by band
    // it runs G/B 1.09 at the top of frame -> 1.10 -> 1.07 -> 0.83 where the
    // water meets the spires -> 0.43 -> 0.27 in the shadowed floor. The hue
    // rotates toward BLUE going down, hard. Ours ran 1.20 -> 1.21, i.e. flat
    // and, in the sign that matters, backwards. A green-surviving medium here
    // says the deeper you look the greener it gets, which is the opposite of
    // every mid-water reference frame in the set and is why the column had no
    // way back to the #16436F navy at 300 m except a table interpolation.
    //
    // The pair is authored AT the measured #00AA9C (R = 0, G/B 1.09) rather
    // than at a value chosen to survive a transform — see section 1b.
    jerlov: 'I', visibility: 30, refDepth: 155,
    fog: 0x00887e, scatter: 0x00cdbc, scatterStrength: 0.46,
    ambientTop: 0x2fa596, ambientBottom: 0x061a2c,
    caustics: 0.05, causticsScale: 0.05, causticsSpeed: 0.045,
    // Rays are still visible here — godrays-1.jpg IS this depth — but they fade
    // out well above the floor (LOOK.md §4: none below ~250 m).
    skylight: 0.62, godrays: 0.75, particulate: 1.1,
    ambientFloor: 0.030,
    bioluminescence: 0.22, biolum: 0x6effd8,
    temperature: 11, hostility: 0.45, exposure: 1.15,
    terrain: {
      sand: 0xb5b8a6, sandRough: 0.92,
      rock: 0x606e6a, rockRough: 0.86,
      accent: 0x58c9b4, accentRough: 0.45,
      detail: 0x7d8880, slope: 0.9,
    },
    flora: [
      { id: 'koosh_sphere',  density: 4.5, scale: [4.0, 8.0],  cluster: 2 },
      { id: 'blue_palm',     density: 10,  scale: [1.5, 4.0],  cluster: 3 },
      { id: 'table_coral',   density: 3,   scale: [4.0, 12.0], cluster: 1 },
      { id: 'sea_grass',     density: 55,  scale: [0.5, 1.1],  cluster: 7 },
      { id: 'purple_fan',    density: 9,   scale: [0.8, 2.2],  cluster: 3 },
      { id: 'gel_sack',      density: 7,   scale: [0.6, 1.4],  cluster: 2 },
    ],
    creatures: [
      { id: 'spadefish',   density: 1.0,   group: [4, 11] },
      { id: 'jellyray',    density: 0.4,   group: [1, 3] },
      { id: 'boneshark',   density: 0.22,  group: [1, 3] },
      { id: 'reginald',    density: 0.7,   group: [1, 3] },
      { id: 'crabsquid',   density: 0.05,  group: [1, 1] },
      { id: 'reefback',    density: 0.006, group: [1, 1] },
    ],
    resources: ['shale', 'sandstone', 'quartz', 'lithium', 'magnetite'],
  },

  {
    id: 'jellyshroom_cave',
    name: 'Jellyshroom Cave',
    ambience: 'jelly-cave',
    depth: [105, 270], floor: 215,
    sites: [{ x: -95, z: -185, r: 85, f: 45 }],
    // Roofed. No sky, no caustics — every photon here is bounced or biological,
    // which is why the violet reads so strongly against the rock.
    // LOOK.md §1 measures the cave at #251438 / #441D60 — a genuinely dark
    // violet. The old #3a2a5c was a full stop lighter and sat in the same
    // chromatic slot as Blood Kelp; both biomes read as "the purple one".
    //
    // Mie, for the third time, and for the strongest reason of the three: the
    // per-metre hue shift downstream models DAYLIGHT that has crossed `depth`
    // metres of water. Nothing here has. The roof is solid; every photon in
    // this cave was emitted by a jellyshroom cap a few metres away, through a
    // haze of spores. Filtering it as if it had fallen 140 m collapsed red to
    // 19% of blue and turned the violet navy — the correct spectral filter for
    // locally-emitted light is the identity, and a flat medium is how this
    // table says that.
    // cave-1.jpg, measured: #35184F / #2E1445, R at 63-68% of max, G/B 0.29,
    // luminance 17-34. The violet is a genuinely LIT dark, not a black frame
    // with a hint of purple in it, so ambientFloor carries it — every photon
    // here comes off a jellyshroom cap a few metres away.
    jerlov: 'MIE', visibility: 16, refDepth: 190,
    fog: 0x32174a, scatter: 0x6b2f8c, scatterStrength: 0.42,
    ambientTop: 0x5c3a8c, ambientBottom: 0x150e26,
    caustics: 0.0, causticsScale: 0.04, causticsSpeed: 0.03,
    skylight: 0.1, godrays: 0.05, particulate: 1.35,
    ambientFloor: 0.400,
    bioluminescence: 0.9, biolum: 0xe07ef5,
    temperature: 13, hostility: 0.7, exposure: 1.45,
    interior: true,
    terrain: {
      sand: 0x8a6f86, sandRough: 0.9,
      rock: 0x59415f, rockRough: 0.88,
      accent: 0xc76fe0, accentRough: 0.4,
      detail: 0x5d4f66, slope: 0.95,
    },
    flora: [
      { id: 'jellyshroom',   density: 7,   scale: [8, 20],    cluster: 2 },
      { id: 'purple_fan',    density: 16,  scale: [0.8, 2.0], cluster: 4 },
      { id: 'pygmy_fan',     density: 34,  scale: [0.2, 0.5], cluster: 9 },
      { id: 'ghost_weed',    density: 12,  scale: [0.5, 1.2], cluster: 4 },
    ],
    creatures: [
      { id: 'crabsnake',   density: 0.14,  group: [1, 1] },
      { id: 'oculus',      density: 1.5,   group: [2, 6] },
      { id: 'mesmer',      density: 0.3,   group: [1, 1] },
      { id: 'cave_crawler',density: 0.8,   group: [1, 3] },
    ],
    resources: ['shale', 'lithium', 'magnetite', 'gold', 'diamond'],
  },

  {
    id: 'grand_reef',
    name: 'Grand Reef',
    ambience: 'grand-reef-deep',
    depth: [250, 500], floor: 380,
    sites: [{ x: 430, z: -290, r: 160, f: 90 }, { x: -430, z: 190, r: 140, f: 80 }],
    // Deep but CLEAN — the water here is not murky, it is simply unlit. What
    // makes the Grand Reef read as vast rather than foggy is the collapsed
    // skylight, not the range: LOOK.md §2 allows 15-25 m at 200-300 m and
    // 15-20 m below that even with a lamp, so 18 m it is.
    // The fog hex is the measured 300 m+ navy #16436F verbatim.
    //
    // Jerlov III, not IB: 18 m of usable range IS turbid water, and III is the
    // type whose raw Kd_blue (0.120) independently predicts ~15 m.
    //
    // NOT BLACK. This is the correction the shipped table most needed after the
    // hue bug: depthDarken resolved to 0.171 at 280 m and the whole frame came
    // back inside luminance 0-11. The references at this depth are navy and
    // fully readable — school-1.jpg measures luminance 31-36 in open water at
    // 345 m (#0B283F) and grand-reef-2.jpg 33-51. LOOK.md §9's "over 90% of the
    // frame below luminance 20 at 250 m+" is about the histogram FLOOR of an
    // unlit cave frame (dropoff-1), not about open water over a reef. So
    // skylight comes up and, more importantly, ambientFloor does: the Grand
    // Reef's own light is real — it is the biome with the densest
    // bioluminescent flora in the game outside the Lost River.
    jerlov: 'III', visibility: 18, refDepth: 345,
    // r22 TRIED AND REVERTED: a red-only lift of this pair to grand-reef-2's own
    // measured water hex (#172443, R/B 0.343, against the 0.182 authored here)
    // is NOT the fix for the low-relative-red finding, and the measurement says
    // so. Six captures, --isolate, crop 0.05,0.10,0.60,0.85:
    //
    //            R%        sat                 plate
    //   before   6, 6, 6   0.955 0.956 0.956   56 / 0.461
    //   after    6, 6, 6   0.956 0.956 0.954
    //
    // Relative red did not move at all and saturation did not move at all, on
    // any run of either arm. (Median and bandGB are deliberately NOT quoted
    // here: this shot's own run-to-run median spread is 19.4 / 21.3 / 28.5
    // across builds differing only in comments, and its draw count flips
    // between 398 and 434 with 300k triangles of terrain, so nothing at that
    // magnitude is separable on this shot. See CAPTURE STABILITY below.)
    //
    // The reason is section 1b: precompensate() is bounded by COMP_MAX = 4, and at
    // this biome's refDepth the red tint is exp(-(0.4596-0.0884)*60*0.58) =
    // 2.4e-6, so the lift needed is ~4e5 and 4x of it arrives. Red only becomes
    // controllable from this pair once it is large enough to flip underwater's
    // warmthOf() and lift its redCap — measured by setting this fog to pure red,
    // which took the frame from R% 6 to R% 54. There is no usable linear range
    // between "annihilated" and "no longer this biome".
    //
    // Note also that the 56 in that table is a framing artefact and not a target
    // for the water: grand-reef-2 is ~70% lit sand plus a warm-lit cave mouth,
    // while this shot ([340,-280,-260], pitch -8) looks into open water with no
    // floor inside the crop at all. Authoring water red to reach 56 would paint
    // the column the colour of somebody else's sand and would contradict
    // LOOK.md rule 2 and godrays-1, whose open water measures R = 0 at ~150 m.
    fog: 0x123a63, scatter: 0x2a6e96, scatterStrength: 0.30,
    ambientTop: 0x35729c, ambientBottom: 0x0a1c2e,
    caustics: 0.22, causticsScale: 0.045, causticsSpeed: 0.035,
    skylight: 0.44, godrays: 0.35, particulate: 1.4,
    // r28 — 0.300 -> 0.092, AND THIS IS THE WHOLE LEVEL FIX FOR THIS BIOME.
    //
    // Measured on water-only windows in both images, both UNGRADED:
    //
    //   ours   grand-reef.png px(120,360)-(460,660)   lum 47.81  p10/p90 45.6/50.3
    //   plate  grand-reef-2   px(700,80)-(790,190)    lum 34.97  p10/p90 33.7/36.6
    //                         px(880,80)-(1050,190)   lum 34.92
    //                         px(690,5)-(1080,68)     lum 38.85
    //
    // 1.31x on the pair the round was briefed with (47.7 / 36.3), and it
    // reproduces on every clean window either image has: the plate's water
    // spans 34.9-38.9 and ours spans 46.0-59.6. Neither window contains
    // anything but water — ours excludes the HUD, the flashlight arm, the
    // jellyfish and the mask vignette; the plate's excludes the cliff, the
    // sand, the coral clusters and the algae.
    //
    // The error is not in the hexes. Every other axis on that window is already
    // a hit ungraded — saturation 0.652 vs 0.669, R as a fraction of max 35%
    // vs 33%, and G/B 0.673 against LOOK.md's own 345 m #0C283E at 0.645. It
    // is in the light budget: at 280 m depthDarken resolved to
    // 0.44 x 0.530 + 0.300 = 0.533, which asserts that HALF of surface daylight
    // survives to 280 m and that 56% of that is the reef's own glow. LOOK.md
    // section 2 gives 15-25 m of visibility with a LAMP below 200 m. The 0.300
    // was raised in an earlier round to stop this frame rendering inside
    // luminance 0-11, and it overshot; the sun term never needed touching.
    //
    // 0.092 solves the measured ratio exactly rather than being dialled: the
    // in-scatter source is multiplied by depthDarken/aureole, so the window
    // scales linearly with depthDarken, and 47.81 -> 36.3 needs a linear factor
    // of 0.610 (solved through the sRGB curve, not estimated as 0.76^2.4).
    // 0.533 x 0.610 = 0.325, and 0.325 - 0.233 = 0.092. It leaves the reef its
    // own light — 9.2% of surface, still generous for the biome with the
    // densest bioluminescent flora in the game — instead of letting that term
    // dominate the budget. Independent check: the predicted window lands at
    // sRGB (19, 39, 59) against LOOK.md's measured 345 m upper column #0C283E
    // = (12, 40, 62).
    //
    // The whole-frame median will move AWAY from grand-reef-2's ~34 and that is
    // correct. That average was a bright upper water window and a dark lower
    // one cancelling; the plate's 34 is two thirds lit sand, and this shot has
    // no floor in it at all.
    ambientFloor: 0.092,
    bioluminescence: 0.5, biolum: 0xff5a86,
    temperature: 6, hostility: 0.75, exposure: 1.25,
    terrain: {
      // This sand is authored BLUE — R is the SMALLEST of its three channels, so
      // the grain is red-dead before the water touches it. safe_shallows makes
      // the opposite argument twenty rows up ("sand is a warm tan before the
      // water gets to it") and grand-reef-2's floor is pale warm grey, so the
      // rule was simply not carried down the table. SYSTEMATIC section 2 is
      // explicit that LOOK.md rule 1 is about the MEDIUM: red should die in the
      // water, not be missing from the albedo before the water starts.
      //
      // It is left wrong on purpose, because r22 measured the fix and the switch
      // does not fire. Setting it to 0xa89f8e (warm pale grey, R largest) and
      // detail to 0x77746c produced a frame IDENTICAL TO EVERY DIGIT to the
      // unchanged build — full frame, the shot crop, and a 0,0.80,1,1 strip over
      // the floor itself: R% 46/46, sat 0.691/0.691, detail 22.94/22.94. So
      // grand_reef's terrain palette is not reaching the `grand-reef` shot at
      // all, and correcting the hue here would have been an unverifiable edit
      // dressed up as a fix. Whoever owns terrain should find out which palette
      // that floor is actually drawing from before this row is touched again.
      sand: 0x93a0a6, sandRough: 0.9,
      rock: 0x4e5b66, rockRough: 0.86,
      accent: 0xd84f7a, accentRough: 0.45,
      detail: 0x69737c, slope: 0.9,
    },
    flora: [
      { id: 'blue_palm',     density: 9,   scale: [1.5, 4.0], cluster: 3 },
      { id: 'purple_fan',    density: 11,  scale: [1.0, 2.4], cluster: 3 },
      { id: 'sea_crown',     density: 2.6, scale: [3, 9],     cluster: 1 },
      { id: 'ghost_weed',    density: 14,  scale: [0.6, 1.4], cluster: 4 },
      { id: 'deep_shroom',   density: 8,   scale: [0.5, 1.2], cluster: 3 },
    ],
    creatures: [
      { id: 'ghost_leviathan', density: 0.0015, group: [1, 1] },
      { id: 'crabsquid',   density: 0.09,  group: [1, 1] },
      { id: 'boneshark',   density: 0.25,  group: [1, 3] },
      { id: 'spadefish',   density: 0.8,   group: [3, 9] },
      { id: 'warper',      density: 0.03,  group: [1, 1] },
      { id: 'reefback',    density: 0.004, group: [1, 1] },
    ],
    resources: ['shale', 'magnetite', 'lithium', 'gold', 'diamond', 'nickel_ore'],
  },

  {
    id: 'blood_kelp',
    name: 'Blood Kelp Zone',
    ambience: 'blood-kelp-dread',
    depth: [350, 600], floor: 480,
    sites: [{ x: -490, z: 470, r: 140, f: 80 }, { x: 560, z: -140, r: 120, f: 70 }],
    // Blood oil bleeds into the column. Jerlov C3 is the murkiest water we use
    // anywhere and 11 m is deliberately claustrophobic: the shader clamp puts
    // total dissolution at 33 m, so nothing is ever visible in silhouette.
    //
    // LOOK.md §1 asks for "near-black with cyan/green points only" here. The
    // old #241c3a was a second violet, chromatically indistinguishable from
    // Jellyshroom (both G/B ~0.47, red at ~62%), so the two deep set-pieces
    // collapsed into one. The fog is now effectively black with a cold cast and
    // the entire identity is carried by biolumColor + the red terrain accent on
    // the vines themselves — which is how the reference frames build it: dark
    // field, discrete saturated points, no ambient violet wash.
    jerlov: 'C3', visibility: 11, refDepth: 470,
    fog: 0x06131c, scatter: 0x1a3342, scatterStrength: 0.34,
    ambientTop: 0x24384a, ambientBottom: 0x07090e,
    caustics: 0.0, causticsScale: 0.04, causticsSpeed: 0.03,
    skylight: 0.05, godrays: 0.05, particulate: 2.2,
    ambientFloor: 0.075,
    bioluminescence: 0.8, biolum: 0x35ffbe,
    temperature: 4, hostility: 0.95, exposure: 1.2,
    terrain: {
      sand: 0x4e4a52, sandRough: 0.9,
      rock: 0x38333e, rockRough: 0.9,
      accent: 0xc0392b, accentRough: 0.5,
      detail: 0x453f4c, slope: 0.95,
    },
    flora: [
      { id: 'blood_vine',    density: 6.5, scale: [22, 45],   cluster: 2 },
      { id: 'redwort',       density: 12,  scale: [0.8, 2.2], cluster: 3 },
      { id: 'deep_shroom',   density: 18,  scale: [0.5, 1.3], cluster: 4 },
      { id: 'ghost_weed',    density: 9,   scale: [0.6, 1.4], cluster: 3 },
      { id: 'blood_grass',   density: 22,  scale: [0.5, 1.1], cluster: 6 },
    ],
    creatures: [
      { id: 'crabsquid',   density: 0.18,  group: [1, 1] },
      { id: 'ampeel',      density: 0.12,  group: [1, 1] },
      { id: 'blighter',    density: 1.0,   group: [3, 8] },
      { id: 'warper',      density: 0.04,  group: [1, 1] },
      { id: 'ghost_leviathan', density: 0.001, group: [1, 1] },
    ],
    resources: ['shale', 'lithium', 'nickel_ore', 'uraninite', 'blood_oil'],
  },

  {
    id: 'lost_river',
    name: 'Lost River',
    ambience: 'lost-river-hollow',
    depth: [500, 900], floor: 700,
    sites: [{ x: -120, z: -330, r: 180, f: 100 }, { x: 330, z: 330, r: 150, f: 85 }],
    // A roofed brine canyon. Zero sky. LOOK.md §1 measures the brine at
    // #013842 — R = 1, and blue a shade AHEAD of green (G/B 0.85). The old
    // #1f5a4a carried R = 31 and G/B 1.22, i.e. a green fog: the biome's own
    // comment claimed the green came from in-scatter, but fogColor is exactly
    // where the far field lands, so it was the far field that went wrong. The
    // signature green now comes from where it does in the reference frames —
    // the ghost-weed glow (biolumColor) and the ambient floor, punched into a
    // cold brine haze.
    //
    // MIE, for the same reason as the Jellyshroom Cave and with even less room
    // for argument: this is a roofed canyon 700 m down, skylight 0.04, and the
    // downstream tint models daylight filtered on its way through 700 m of
    // water. Nothing here has been through any water. On C1 the residual 0.003
    // green/blue margin was enough to render the brine at G/B 1.37 — a green
    // fog in the biome whose measured colour is #013842, where blue leads.
    jerlov: 'MIE', visibility: 13, refDepth: 700,
    fog: 0x073a48, scatter: 0x0d6270, scatterStrength: 0.34,
    ambientTop: 0x2c7d78, ambientBottom: 0x0a1e22,
    caustics: 0.0, causticsScale: 0.04, causticsSpeed: 0.03,
    skylight: 0.04, godrays: 0.0, particulate: 1.9,
    ambientFloor: 0.150,
    bioluminescence: 0.85, biolum: 0x74ffb0,
    temperature: 3, hostility: 0.85, exposure: 1.18,
    interior: true,
    terrain: {
      sand: 0x8f9a7c, sandRough: 0.9,
      rock: 0x4c534a, rockRough: 0.88,
      accent: 0x7fe0a0, accentRough: 0.4,
      detail: 0x646b58, slope: 1.0,
    },
    flora: [
      { id: 'ghost_weed',    density: 22,  scale: [0.8, 2.0], cluster: 5 },
      { id: 'brine_lily',    density: 9,   scale: [1.0, 2.6], cluster: 3 },
      { id: 'tube_worm',     density: 16,  scale: [0.4, 1.2], cluster: 6 },
      { id: 'deep_shroom',   density: 10,  scale: [0.5, 1.2], cluster: 3 },
      { id: 'membrain_tree', density: 1.4, scale: [8, 20],    cluster: 1 },
    ],
    creatures: [
      { id: 'river_prowler', density: 0.5,   group: [1, 3] },
      { id: 'ghost_leviathan', density: 0.002, group: [1, 1] },
      { id: 'warper',        density: 0.06,  group: [1, 1] },
      { id: 'crabsquid',     density: 0.12,  group: [1, 1] },
      { id: 'sea_treader',   density: 0.004, group: [1, 3] },
    ],
    resources: ['nickel_ore', 'uraninite', 'magnetite', 'diamond', 'crystalline_sulphur', 'ion_cube'],
  },

  {
    id: 'inactive_lava_zone',
    name: 'Inactive Lava Zone',
    ambience: 'lava-rumble',
    depth: [900, 1400], floor: 1180,
    // A single enormous site under everything — this is the planet's core, not
    // a place on the map.
    sites: [{ x: 0, z: 0, r: 520, f: 240 }],
    // Mie, like the Dunes: ash and mineral precipitate in suspension, and the
    // colour here is what the magma light scatters off, not what has survived a
    // kilometre of daylight. On a Jerlov shape the depth-scaled hue shift
    // multiplies the channel spread by 1200 m and renders the Lava Zone GREEN.
    jerlov: 'MIE', visibility: 12, refDepth: 1150,
    fog: 0x341a12, scatter: 0x8a4520, scatterStrength: 0.46,
    ambientTop: 0x8d4322, ambientBottom: 0x180a06,
    caustics: 0.0, causticsScale: 0.04, causticsSpeed: 0.02,
    skylight: 0.02, godrays: 0.0, particulate: 1.6,
    ambientFloor: 0.300,
    bioluminescence: 0.35, biolum: 0xff8a2a,
    temperature: 78, hostility: 0.9, exposure: 1.15,
    interior: true,
    terrain: {
      sand: 0x6b4a38, sandRough: 0.92,
      rock: 0x3e2c26, rockRough: 0.9,
      accent: 0xff7a2a, accentRough: 0.35,
      detail: 0x53382c, slope: 1.0,
    },
    flora: [
      { id: 'sulphur_stalk', density: 2.2, scale: [3.0, 9.0], cluster: 2 },
      { id: 'ember_frond',   density: 8,   scale: [1.0, 2.6], cluster: 3 },
      { id: 'lava_flower',   density: 10,  scale: [0.6, 1.6], cluster: 3 },
      { id: 'tube_worm',     density: 14,  scale: [0.4, 1.2], cluster: 5 },
      { id: 'deep_shroom',   density: 5,   scale: [0.5, 1.2], cluster: 2 },
    ],
    creatures: [
      { id: 'lava_lizard',   density: 0.6,   group: [1, 3] },
      { id: 'warper',        density: 0.08,  group: [1, 1] },
      { id: 'sea_dragon',    density: 0.0012, group: [1, 1] },
      { id: 'magmarang',     density: 1.1,   group: [3, 7] },
    ],
    resources: ['kyanite', 'diamond', 'nickel_ore', 'crystalline_sulphur', 'ruby'],
  },

  {
    id: 'void',
    name: 'The Void',
    ambience: 'void-abyss',
    // The void has no depth band and no sites: it is selected purely by
    // horizontal distance from the crater, at ANY depth. See VOID_INNER/OUTER.
    depth: [0, 4000], floor: 3000,
    sites: [],
    // Open ocean water — physically the clearest in the game. The horror is
    // that there is nothing in it to see, not that you cannot see. 34 m, not
    // 55: LOOK.md's ceiling anywhere is 60 m in the top 30 metres of water, and
    // the void has none of that light.
    // refDepth 120, not the middle of a 0-4000 m band. The void is selected by
    // horizontal distance at ANY depth, so it is the one biome whose sample
    // depth is unbounded; anchoring the compensation deep would make it wrong
    // everywhere shallow. IB keeps the spread small enough that being wrong by
    // a factor of ten in depth costs almost nothing.
    jerlov: 'IB', visibility: 34, refDepth: 120,
    // Left alone in r22. The same red-only lift was drafted here against misc-5
    // (Koosh at ~150-250 m, water #3C568C, R/B 0.43, against 0.159 authored) and
    // reverted with grand_reef's: no shot in the battery frames this biome, so
    // there was no way to measure it, and the one place the identical edit COULD
    // be measured it came out inert on relative red and negative on median.
    fog: 0x071c2c, scatter: 0x123c5c, scatterStrength: 0.34,
    ambientTop: 0x22496e, ambientBottom: 0x03080f,
    caustics: 0.12, causticsScale: 0.06, causticsSpeed: 0.04,
    skylight: 0.5, godrays: 0.25, particulate: 0.35,
    ambientFloor: 0.012,
    bioluminescence: 0.1, biolum: 0x6fa8d0,
    temperature: 4, hostility: 1.0, exposure: 1.05,
    terrain: {
      sand: 0x4a5560, sandRough: 0.9,
      rock: 0x38414c, rockRough: 0.88,
      accent: 0x6fa8d0, accentRough: 0.5,
      detail: 0x424c57, slope: 0.5,
    },
    flora: [],
    creatures: [
      { id: 'ghost_leviathan', density: 0.004, group: [1, 2] },
    ],
    resources: [],
  },
];

// ---------------------------------------------------------------------------
// bake the table
// ---------------------------------------------------------------------------
/**
 * @type {Record<string, object>} raw biome table, keyed by id.
 * SHARED AND READ-ONLY BY CONVENTION — every module holds the same records and
 * the same THREE.Color instances. Never mutate one; copy what you need.
 */
export const BIOMES = {};
const ORDER = [];

/**
 * Build one biome record from its RAW entry. Split out of the loop because
 * init() re-runs it if render/underwater.js turns out to be using different
 * transform constants than DOWNSTREAM assumes — the pre-compensation is only
 * correct against the transform actually in the pipeline.
 */
function bake(r) {
  const absorption = deriveAbsorption(r.jerlov, r.visibility);
  // The depth the biome's hexes were eyedropped at, and therefore the depth the
  // compensation is exact at. Defaults to the middle of its own band.
  const refDepth = r.refDepth ?? (r.depth[0] + r.depth[1]) * 0.5;
  const tint = screenTint(absorption, refDepth);
  // How much of the eyedropped in-scatter pair actually survives to the water.
  // 1 for every biome that has not been measured against a water-only window.
  const level = r.level ?? 1;

  const b = {
    id: r.id,
    name: r.name,
    ambience: r.ambience,
    depth: r.depth.slice(),
    depthTop: r.depth[0],
    depthBottom: r.depth[1],
    floorDepth: r.floor,
    sites: r.sites.map((s) => ({ ...s })),
    interior: !!r.interior,

    // --- medium (all colours LINEAR, ready for U.*)
    jerlov: r.jerlov,
    absorption,
    maxVisibility: r.visibility,
    refDepth,
    /** what the fog/scatter hexes were divided by — for a critic to check */
    screenTint: tint,
    // the surviving channel — blue in clear water, green in coastal — is the
    // one you actually see distance through, so it sets the far-field reach
    fogDensity: survivorAbsorption(absorption),
    // Colours leave here PRE-COMPENSATED: divided by the tint render/
    // underwater.js will multiply them by at refDepth, so the authored hex is
    // what a screenshot measures. See section 1b of the header.
    // `level` is applied BEFORE the compensation and is a pure linear scale, so
    // it moves brightness and nothing else — see section 1c.
    level,
    fogColor: precompensate(srgb(r.fog).multiplyScalar(level), tint),
    scatterColor: precompensate(srgb(r.scatter).multiplyScalar(level), tint),
    scatterStrength: r.scatterStrength,
    ambientTop: precompensate(srgb(r.ambientTop), tint),
    ambientBottom: precompensate(srgb(r.ambientBottom), tint),
    skylight: r.skylight,
    ambientFloor: r.ambientFloor,

    // --- light behaviour
    caustics: r.caustics,
    causticsScale: r.causticsScale,
    causticsSpeed: r.causticsSpeed,
    godrays: r.godrays,
    particulate: r.particulate,
    bioluminescence: r.bioluminescence,
    biolumColor: srgb(r.biolum),
    exposure: r.exposure,

    // --- gameplay
    temperature: r.temperature,
    hostility: r.hostility,

    // --- content
    terrain: {
      ...r.terrain,
      sand: srgb(r.terrain.sand),
      rock: srgb(r.terrain.rock),
      accent: srgb(r.terrain.accent),
      detail: srgb(r.terrain.detail),
    },
    flora: r.flora.map((f) => ({ ...f })),
    creatures: r.creatures.map((c) => ({ ...c })),
    resources: (r.resources || []).slice(),
  };
  // world/terrain.js reads `biome.palette.sand/.rock` for its ground shader.
  // Same object, both names — do not let a naming difference silently drop the
  // palette handoff (it did exactly that until a cross-check caught it).
  b.palette = b.terrain;
  // total densities, so a caller can size an instance budget in one read
  b.floraDensity = b.flora.reduce((s, f) => s + f.density, 0);
  b.creatureDensity = b.creatures.reduce((s, c) => s + c.density, 0);
  return b;
}

for (const r of RAW) {
  const b = bake(r);
  BIOMES[b.id] = b;
  ORDER.push(b);
}

/**
 * Re-bake every record in place against the transform render/underwater.js is
 * actually running. Called from init() once that module exists. Mutating in
 * place rather than replacing the objects matters: terrain, flora and postfx
 * all hold references to these records from their own init().
 */
function rebake() {
  for (let i = 0; i < RAW.length; i++) {
    const fresh = bake(RAW[i]);
    const old = ORDER[i];
    old.absorption.copy(fresh.absorption);
    old.fogDensity = fresh.fogDensity;
    old.screenTint = fresh.screenTint;
    for (const k of ['fogColor', 'scatterColor', 'ambientTop', 'ambientBottom']) old[k].copy(fresh[k]);
  }
}

/** Display names -> id, so get('Blood Kelp Zone') works. */
const BY_NAME = {};
for (const b of ORDER) BY_NAME[b.name.toLowerCase().replace(/[\s\-]+/g, '_')] = b.id;

/** Friendly aliases so callers can say what they mean. */
const ALIAS = {
  shallows: 'safe_shallows', safeshallows: 'safe_shallows', reef: 'safe_shallows',
  kelp: 'kelp_forest', creepvine: 'kelp_forest',
  grassy: 'grassy_plateaus', plateaus: 'grassy_plateaus',
  mushroom: 'mushroom_forest', mushrooms: 'mushroom_forest',
  bulb: 'bulb_zone', jelly: 'jellyshroom_cave', jellyshroom: 'jellyshroom_cave',
  grandreef: 'grand_reef', deepreef: 'grand_reef',
  bloodkelp: 'blood_kelp', blood: 'blood_kelp',
  lostriver: 'lost_river', river: 'lost_river',
  lava: 'inactive_lava_zone', lavazone: 'inactive_lava_zone', ilz: 'inactive_lava_zone',
  crash: 'crash_zone', aurora: 'crash_zone',
  sparse: 'sparse_reef', dune: 'dunes', abyss: 'void', crateredge: 'void',

  // world/terrain.js owns its own radial biome map and names three regions we
  // do not carry as separate palettes. Map them onto the nearest honest match
  // so get(terrain.biomeAt(x, z)) never returns undefined:
  cragfield: 'dunes',            // barren rock/sand at 100-320 m — Dunes water
  islands: 'underwater_islands', // the green-teal open column at 100-250 m
  underwaterislands: 'underwater_islands',
  deeptrench: 'blood_kelp',      // 500 m+ open trench — the dread palette
};
const normalise = (n) => String(n ?? '').trim().toLowerCase().replace(/[\s\-]+/g, '_');

// ---------------------------------------------------------------------------
// THE OPEN-WATER COLUMN — what the ocean looks like at a depth with no biome
// claiming that spot. Ordered, so atDepth() is a simple 2-key crossfade.
//
// This short list IS the depth ramp of the whole game, and AGENT_BRIEF §4.1 is
// unambiguous about the shape it has to have:
//
//     0-20 m     cyan-blue    #2C9BC8   B > G
//     100-200 m  GREEN-TEAL   #00AA9C   G > B, R = 0     <-- the missed band
//     300 m+     navy         #16436F   B > G
//     600 m+     black        #030505
//
// The hue path therefore goes OUT to green and comes BACK to blue. A ramp that
// runs blue -> bluer -> black is the #1 amateur tell, and that is exactly what
// this list used to describe: sparse_reef (G/B 0.79) at 120 m and dunes (0.82,
// and tan-brown besides) at 230 m were the two bluest rows in the file, so the
// mid column was not merely missing its teal — it ran BACKWARDS through it, and
// the Dunes' sediment brown leaked into open water from 180-300 m as well.
//
// So: dunes is gone from the column entirely (it is a place you go to, not the
// sea you swim through).
//
// The rungs are spaced to reproduce the measured ramp, and the depths are the
// depths those hexes were measured at — which is also each biome's refDepth, so
// a rung renders its own authored colour when you are standing on it and the
// crossfade carries you between them:
//
//   15   #2A9DC9  G/B 0.78  the bright cyan band, brightest water in the game
//   55   #14636F  G/B 0.89  below the reef shelf: darker, more teal
//   110  #066F80  G/B 0.87  the last cyan step
//   155  #00AA9C  G/B 1.09  green-teal, R = 0 — the peak of the excursion
//   300  #16436F  G/B 0.65  navy, blue back in front
//   620  #013842  G/B 0.85  brine, nearly black
//   950  cold             <-- see below
//   1200 warm ash
//
// THE 950 m KEY IS NOT DECORATION. Without it the column ran a single 440 m
// interpolation from the Lost River's cold brine straight into the Lava Zone's
// warm ash, and every depth in between came out as the average of a blue and a
// red: 800 m resolved to #354049 at saturation 0.27, an achromatic grey, and
// the warmth started climbing 250 m above the first lava. LOOK.md's 800-950 m
// band is cold — #17262F lit, #040612 unlit. So the Lost River holds the column
// to 950 m, which is also where its own depth band ends, and the lava only
// starts mixing in below that.
const COLUMN = [
  { id: 'safe_shallows',      d: 0 },
  { id: 'safe_shallows',      d: 18 },
  { id: 'grassy_plateaus',    d: 55 },
  { id: 'sparse_reef',        d: 110 },
  { id: 'underwater_islands', d: 155 },
  { id: 'grand_reef',         d: 275 },
  { id: 'lost_river',         d: 620 },
  { id: 'lost_river',         d: 950 },   // the cold key
  { id: 'inactive_lava_zone', d: 1200 },
  { id: 'inactive_lava_zone', d: 4000 },
];

/** Beyond the crater rim the world is void; full void past VOID_OUTER. */
export const VOID_INNER = 1250;
export const VOID_OUTER = 1750;

/**
 * Membership is raised to this power before normalising. Straight linear
 * feathers make a 60 m transition read as "half of each biome" over its whole
 * width, which washes every boundary into the same grey-teal average. Raising
 * to 2.5 keeps the crossfade C1-continuous but lets the biome you are actually
 * standing in dominate, so a boundary reads as a place, not a smear.
 */
const BLEND_SHARPNESS = 2.5;

// ---------------------------------------------------------------------------
// weighting
// ---------------------------------------------------------------------------
function siteWeight(s, x, z) {
  const d = Math.hypot(x - s.x, z - s.z);
  return 1 - smoothstep(s.r, s.r + s.f, d);
}

/** Horizontal membership of a biome, 0..1 — max over its patches. */
function horizontalWeight(b, x, z) {
  let w = 0;
  for (let i = 0; i < b.sites.length; i++) {
    const s = siteWeight(b.sites[i], x, z);
    if (s > w) w = s;
    if (w >= 1) break;
  }
  return w;
}

/**
 * Vertical membership. Full weight across the authored band, feathered out
 * above and below so a diver crossing a boundary never sees the fog snap.
 *
 * The feathers are wider than they used to be, and deliberately so: the biome
 * palettes now sit much further apart chromatically (cyan-blue shallows against
 * a hard-green kelp against tan-brown Dunes), and a bigger colour delta across
 * the same feather is a steeper gradient per metre. Widening the transition is
 * how you keep BOTH — strong biome identity and a fade a diver reads as
 * atmosphere rather than as a switch.
 *
 * Re-measured on the current table by walking the resolved medium in 0.5 m
 * steps: |d fogColor / d metre| peaks at 1.8e-2 at 36 m (the shallows ->
 * grassy_plateaus column step) vertically and 1.3e-2 on a horizontal traverse
 * across the kelp boundary at 60 m, with |d depthDarken / d metre| under
 * 8.1e-3 everywhere — C1, no kinks anywhere in 0-1400 m. The honest unit is
 * metres-to-cross and it is generous: shallows->kelp
 * is a 113 m horizontal crossfade and a 33 m vertical one, and at swim speed
 * that is ten-plus seconds of fade before render/underwater.js even applies its
 * own 0.55 s ease on top.
 */
function depthWeight(b, depth) {
  const top = b.depthTop, bot = b.depthBottom;
  const span = Math.max(1, bot - top);
  const ft = Math.min(85, span * 0.7);    // feather above the band
  const fb = Math.min(140, span * 0.85);  // and (more generously) below it
  return smoothstep(top - ft, top, depth) * (1 - smoothstep(bot, bot + fb, depth));
}

const _entries = [];   // reused {b, w} pairs — at() must not allocate per frame
for (let i = 0; i < 12; i++) _entries.push({ b: null, w: 0 });
let _n = 0;
const push = (b, w) => {
  if (w <= 1e-4) return;
  if (_n >= _entries.length) _entries.push({ b: null, w: 0 });
  const e = _entries[_n++]; e.b = b; e.w = w;
};

/** Add the open-water column at this depth, sharing `share` between 1-2 keys. */
function pushColumn(depth, share) {
  if (share <= 1e-4) return;
  let i = 1;
  while (i < COLUMN.length - 1 && COLUMN[i].d < depth) i++;
  const a = COLUMN[i - 1], c = COLUMN[i];
  const t = clamp01((depth - a.d) / Math.max(1e-6, c.d - a.d));
  const s = t * t * (3 - 2 * t);          // smooth so the column never kinks
  push(BIOMES[a.id], share * (1 - s));
  push(BIOMES[c.id], share * s);
}

// ---------------------------------------------------------------------------
// the Medium object
// ---------------------------------------------------------------------------
const COLOR_FIELDS = ['fogColor', 'scatterColor', 'ambientTop', 'ambientBottom', 'biolumColor'];
const NUM_FIELDS = [
  'scatterStrength', 'caustics', 'causticsScale', 'causticsSpeed',
  'skylight', 'ambientFloor', 'godrays', 'particulate', 'bioluminescence',
  'exposure', 'temperature', 'hostility',
];

/** Allocate a Medium you own (so you can keep it across frames). */
export function createMedium() {
  const m = {
    /** dominant biome id at the sample point */
    id: 'safe_shallows',
    /** dominant biome record */
    biome: BIOMES.safe_shallows,
    /** [{ id, biome, w }] normalised, strongest first — for spawn blending */
    weights: [],
    /** metres below the surface at the sample point */
    depth: 0,
    /** 0..1 how far into the void this sample is */
    voidness: 0,
    /** ambience tag of the dominant biome, for audio crossfades */
    ambience: 'shallows-reef',
    /** the biome's own non-solar light — see resolve() */
    ambientFloor: 0,
    absorption: new THREE.Vector3(),
    maxVisibility: 90,
    fogDensity: 0.021,
    depthDarken: 1,
  };
  for (const k of COLOR_FIELDS) m[k] = new THREE.Color();
  for (const k of NUM_FIELDS) m[k] = 0;
  return m;
}

const _scratch = createMedium();
const _scratchDepth = createMedium();
const _scratchMix = createMedium();

/** Blend the accumulated `_entries` into `out`. Assumes _n > 0. */
function resolve(out, depth) {
  let total = 0;
  for (let i = 0; i < _n; i++) total += _entries[i].w;
  if (total <= 0) { _entries[_n++] = { b: BIOMES.safe_shallows, w: 1 }; total = 1; }
  const inv = 1 / total;

  for (const k of COLOR_FIELDS) out[k].setRGB(0, 0, 0);
  for (const k of NUM_FIELDS) out[k] = 0;
  out.absorption.set(0, 0, 0);

  let best = null, bestW = -1;
  out.weights.length = 0;

  for (let i = 0; i < _n; i++) {
    const e = _entries[i], w = e.w * inv, b = e.b;
    if (w > bestW) { bestW = w; best = b; }
    if (w > 1e-3) out.weights.push({ id: b.id, biome: b, w });

    for (const k of COLOR_FIELDS) {
      const c = b[k], o = out[k];
      o.r += c.r * w; o.g += c.g * w; o.b += c.b * w;
    }
    for (const k of NUM_FIELDS) out[k] += b[k] * w;
    out.absorption.x += b.absorption.x * w;
    out.absorption.y += b.absorption.y * w;
    out.absorption.z += b.absorption.z * w;
  }
  out.weights.sort((a, b) => b.w - a.w);

  // Visibility and fog density are DERIVED from the blended absorption rather
  // than averaged separately, so the three can never disagree mid-crossfade.
  // Both read the surviving channel, the same quantity deriveAbsorption()
  // anchors on, so authored visibility round-trips exactly for green water too.
  out.fogDensity = survivorAbsorption(out.absorption);
  out.maxVisibility = K_VIS / Math.max(out.fogDensity, 1e-5);

  // How much light is left here. Two terms, because two things light the deep:
  //   skylight * exp(-depth)  the sun, occluded by any roof over your head
  //   ambientFloor            the biome's OWN light — magma, bioluminescence,
  //                           brine glow. Without this the Lava Zone solves to
  //                           0.001 and renders as a black screen with a lamp
  //                           in it, which is not what the reference frames do.
  // core/underwaterMaterial.js applies the per-channel sun extinction on top,
  // so this curve only carries occlusion, range and self-illumination.
  out.depthDarken = out.skylight * (0.035 + 0.965 * Math.exp(-depth / 420))
                  + out.ambientFloor;

  out.depth = depth;
  out.id = best.id;
  out.biome = best;
  out.ambience = best.ambience;
  return out;
}

// ---------------------------------------------------------------------------
// public lookups
// ---------------------------------------------------------------------------

/**
 * @returns {object|undefined} the raw biome record.
 * Accepts ids ('blood_kelp'), display names ('Blood Kelp Zone') and aliases
 * ('blood', 'kelp', 'lava', 'abyss'). Unknown -> undefined; guard it.
 */
export function get(name) {
  const n = normalise(name);
  return BIOMES[n]
    || BIOMES[BY_NAME[n]]
    || BIOMES[ALIAS[n]]
    || BIOMES[ALIAS[n.replace(/_/g, '')]];
}

/** @returns {object[]} every biome record, in table order. */
export function list() { return ORDER.slice(); }

/** @returns {string[]} every biome id. */
export function ids() { return ORDER.map((b) => b.id); }

/**
 * The open ocean at a given world Y — no horizontal biome, just the column.
 * Use this for anything that only knows a depth (UI, audio ducking, fallbacks).
 * @param {number} y world Y (negative below the surface)
 * @param {object} [out] optional Medium to write into
 */
export function atDepth(y, out = _scratchDepth) {
  const depth = Math.max(0, WORLD.seaLevel - y);
  _n = 0;
  pushColumn(depth, 1);
  return resolve(out, depth);
}

/**
 * The blended medium at any world position. This is the function every other
 * module should call. Cross-fades horizontally (site feathers) and vertically
 * (depth-band feathers) and never snaps.
 *
 * @param {number} x @param {number} y @param {number} z
 * @param {object} [out] optional Medium (see createMedium) — otherwise a shared
 *        scratch object is returned and WILL be overwritten by the next call.
 */
export function at(x, y, z, out = _scratch) {
  const depth = Math.max(0, WORLD.seaLevel - y);
  _n = 0;

  let claimed = 0;
  for (let i = 0; i < ORDER.length; i++) {
    const b = ORDER[i];
    if (!b.sites.length) continue;
    const hw = horizontalWeight(b, x, z);
    if (hw <= 1e-4) continue;
    const raw = hw * depthWeight(b, depth);
    if (raw <= 1e-4) continue;
    const w = Math.pow(raw, BLEND_SHARPNESS);
    push(b, w);
    claimed += w;
  }

  // Whatever the biome patches do not claim is open water at this depth.
  if (claimed < 1) pushColumn(depth, 1 - claimed);

  // Past the crater rim everything dissolves into the void, at every depth.
  const voidness = smoothstep(VOID_INNER, VOID_OUTER, Math.hypot(x, z));
  if (voidness > 1e-4) {
    let total = 0;
    for (let i = 0; i < _n; i++) { _entries[i].w *= (1 - voidness); total += _entries[i].w; }
    push(BIOMES.void, voidness * Math.max(total / Math.max(1 - voidness, 1e-4), 1e-3));
  }

  const m = resolve(out, depth);
  m.voidness = voidness;
  return m;
}

/** Convenience: the strongest biome record at a world position. */
export function dominant(x, y, z) { return at(x, y, z).biome; }

/** Surface (non-cavern) biomes only — these are the ones that own seabed. */
const SURFACE = ORDER.filter((b) => b.sites.length && !b.interior);
/** Roofed cavern layers, found by depth rather than by seabed position. */
const CAVERNS = ORDER.filter((b) => b.sites.length && b.interior);

// ---------------------------------------------------------------------------
// terrain hand-off
// ---------------------------------------------------------------------------
// world/terrain.js owns the height field and publishes its own biomeAt(x, z).
// There must be exactly ONE authority on which biome a patch of seabed belongs
// to, and it has to be the module that actually built the rock — otherwise the
// palette says Crash Zone while the geometry says Kelp Forest. So: terrain
// names the ground, this module says what that ground and its water look like.
// The water column is still ours, because it depends on depth and terrain has
// no opinion about the medium.
//
// Resolved lazily, not in init(): terrain is order 50 and we are order 40, so
// it does not exist yet when we initialise.
let _ctx = null, _terrain, _terrainTried = false;
function terrain() {
  if (!_terrainTried && _ctx) {
    const t = _ctx.get?.('terrain');
    if (t) { _terrainTried = true; _terrain = t.stub ? null : t; }
  }
  return _terrain;
}

/**
 * Which biome OWNS the open seabed at (x, z), ignoring the water column above
 * it. This is what terrain/flora want when painting ground: a diver at 10 m
 * over the Grand Reef is in shallow water, but the rock below them is Grand
 * Reef. Cavern biomes are excluded — use cavernsAt() for those.
 * @returns {object} biome record
 */
export function groundAt(x, z) {
  // terrain built the rock, so terrain names it (see the hand-off note above).
  const t = terrain();
  if (t?.biomeAt) {
    const named = get(t.biomeAt(x, z));
    if (named) return named;
  }
  let best = null, bestW = 0;
  for (let i = 0; i < SURFACE.length; i++) {
    const w = horizontalWeight(SURFACE[i], x, z);
    if (w > bestW) { bestW = w; best = SURFACE[i]; }
  }
  const voidness = smoothstep(VOID_INNER, VOID_OUTER, Math.hypot(x, z));
  if (voidness > 0.5) return BIOMES.void;
  if (best && bestW > 0.5) return best;
  // unclaimed ground: the column at the seabed depth we expect here
  return atDepth(-floorDepthAt(x, z)).biome;
}

/**
 * Cavern layers passing under (x, z), strongest first. structures.js can use
 * this to decide where a cave system is allowed to exist and how deep to cut.
 * @returns {Array<{id, biome, w, depth:[top,bottom]}>}
 */
export function cavernsAt(x, z) {
  const outv = [];
  for (let i = 0; i < CAVERNS.length; i++) {
    const b = CAVERNS[i];
    const w = horizontalWeight(b, x, z);
    if (w > 1e-3) outv.push({ id: b.id, biome: b, w, depth: b.depth.slice() });
  }
  return outv.sort((a, b) => b.w - a.w);
}

/** Normalised seabed membership at (x, z) — for blending terrain palettes. */
export function groundWeights(x, z) {
  const outv = [];
  let total = 0;
  for (let i = 0; i < SURFACE.length; i++) {
    const b = SURFACE[i];
    const raw = horizontalWeight(b, x, z);
    if (raw <= 1e-4) continue;
    const w = Math.pow(raw, BLEND_SHARPNESS);
    outv.push({ id: b.id, biome: b, w }); total += w;
  }
  // Terrain's named ground is the anchor of the blend, so a spawn table can
  // never drift off the biome the rock actually is.
  const t = terrain();
  const named = t?.biomeAt ? get(t.biomeAt(x, z)) : null;
  if (named) {
    const hit = outv.find((e) => e.id === named.id);
    if (hit) { total += 1 - hit.w; hit.w = 1; }
    else { outv.push({ id: named.id, biome: named, w: 1 }); total += 1; }
  }
  const voidness = smoothstep(VOID_INNER, VOID_OUTER, Math.hypot(x, z));
  if (total < 1) {
    const fill = 1 - total;
    const col = atDepth(-floorDepthAt(x, z)).biome;
    outv.push({ id: col.id, biome: col, w: fill });
    total += fill;
  }
  if (voidness > 1e-4) {
    for (const e of outv) e.w *= (1 - voidness);
    outv.push({ id: 'void', biome: BIOMES.void, w: voidness * total });
    total = outv.reduce((s, e) => s + e.w, 0);
  }
  const inv = 1 / Math.max(total, 1e-6);
  for (const e of outv) e.w *= inv;
  outv.sort((a, b) => b.w - a.w);
  return outv;
}

/**
 * A seabed-depth HINT in metres for (x, z), blended from the biome patches and
 * falling back to a crater profile: shallow at the lifepod, dropping away to
 * the void. terrain.js is free to ignore this, but if it uses it as the base
 * of its height field the biomes will land where their colours expect to be.
 */
export function floorDepthAt(x, z) {
  // If terrain exists it IS the seabed; our crater profile is only the estimate
  // used before terrain loads (and by tools that import this module standalone).
  const t = terrain();
  if (t?.heightAt) {
    const h = t.heightAt(x, z);
    if (Number.isFinite(h)) return Math.max(0, WORLD.seaLevel - h);
  }
  const r = Math.hypot(x, z);
  // crater profile: 24 m at the centre, past the rim it falls to the void floor
  const base = 24 + 620 * Math.pow(clamp01(r / 1200), 1.6)
             + 1400 * smoothstep(VOID_INNER, VOID_OUTER + 400, r);
  let acc = 0, total = 0;
  for (let i = 0; i < SURFACE.length; i++) {
    const b = SURFACE[i];
    const w = horizontalWeight(b, x, z);
    if (w > 1e-4) { acc += b.floorDepth * w; total += w; }
  }
  if (total <= 1e-4) return base;
  if (total < 1) return lerp(base, acc / total, total);
  return acc / total;
}

/**
 * Interpolate two Media (or two biome records) into `out`.
 * Uses its own scratch by default, so `mix(at(...), someBiome, 0.5)` is safe.
 */
export function mix(a, b, t, out = _scratchMix) {
  const k = clamp01(t);
  for (const f of COLOR_FIELDS) {
    out[f].setRGB(lerp(a[f].r, b[f].r, k), lerp(a[f].g, b[f].g, k), lerp(a[f].b, b[f].b, k));
  }
  for (const f of NUM_FIELDS) out[f] = lerp(a[f], b[f], k);
  out.absorption.set(
    lerp(a.absorption.x, b.absorption.x, k),
    lerp(a.absorption.y, b.absorption.y, k),
    lerp(a.absorption.z, b.absorption.z, k),
  );
  out.fogDensity = survivorAbsorption(out.absorption);
  out.maxVisibility = K_VIS / Math.max(out.fogDensity, 1e-5);
  out.depth = lerp(a.depth ?? 0, b.depth ?? 0, k);
  out.depthDarken = out.skylight * (0.035 + 0.965 * Math.exp(-out.depth / 420))
                  + out.ambientFloor;
  const src = k < 0.5 ? a : b;
  out.id = src.id; out.biome = src.biome || src; out.ambience = src.ambience;
  out.voidness = lerp(a.voidness ?? 0, b.voidness ?? 0, k);
  out.weights.length = 0;
  return out;
}

const _tinted = new THREE.Color();

/**
 * Offered helper for render/underwater.js: write a Medium into the shared
 * uniforms, optionally smoothed (k = 1 snaps, k = 0.08 eases over ~12 frames).
 * biomes never calls this itself while a real underwater module is loaded.
 *
 * @param {boolean} [applyTint] apply the depth tint ourselves. Colours leave
 *        this module PRE-COMPENSATED for the transform render/underwater.js
 *        applies (see section 1b), so a caller that does NOT apply that
 *        transform must ask for it here or every biome renders too warm and
 *        too flat. underwater.js owns the transform, so it passes false (the
 *        default); our own stub-fallback in preRender passes true.
 */
export function applyToUniforms(U, m, k = 1, applyTint = false) {
  const t = clamp01(k);
  const tint = applyTint ? screenTint(m.absorption, m.depth ?? 0) : null;
  const push = (uniform, c) => {
    if (!tint) return uniform.value.lerp(c, t);
    _tinted.setRGB(c.r * tint.r, c.g * tint.g, c.b * tint.b);
    return uniform.value.lerp(_tinted, t);
  };
  push(U.uFogColor, m.fogColor);
  push(U.uScatterColor, m.scatterColor);
  push(U.uAmbientTop, m.ambientTop);
  push(U.uAmbientBottom, m.ambientBottom);
  U.uAbsorption.value.lerp(m.absorption, t);
  U.uScatterStrength.value = lerp(U.uScatterStrength.value, m.scatterStrength, t);
  U.uFogDensity.value = lerp(U.uFogDensity.value, m.fogDensity, t);
  U.uMaxVisibility.value = lerp(U.uMaxVisibility.value, m.maxVisibility, t);
  U.uDepthDarken.value = lerp(U.uDepthDarken.value, m.depthDarken, t);
  U.uCausticsStrength.value = lerp(U.uCausticsStrength.value, m.caustics, t);
  U.uCausticsScale.value = lerp(U.uCausticsScale.value, m.causticsScale, t);
  U.uCausticsSpeed.value = lerp(U.uCausticsSpeed.value, m.causticsSpeed, t);
  return U;
}

// ---------------------------------------------------------------------------
// spawn helpers
// ---------------------------------------------------------------------------

/** Flora table for a biome (id, record or alias). */
export function flora(nameOrBiome) {
  const b = typeof nameOrBiome === 'string' ? get(nameOrBiome) : nameOrBiome;
  return b ? b.flora : [];
}

/** Creature table for a biome. */
export function creatures(nameOrBiome) {
  const b = typeof nameOrBiome === 'string' ? get(nameOrBiome) : nameOrBiome;
  return b ? b.creatures : [];
}

/**
 * Blended spawn table for a position — merges the tables of every biome
 * overlapping it, scaling each density by that biome's share. This is what
 * makes a kelp/shallows boundary read as a gradient of plants rather than a line.
 * @param {number} x @param {number} z
 * @param {'flora'|'creatures'} kind
 * @param {number} [y] pass the seabed Y to include cavern layers (a plant on a
 *        Jellyshroom Cave floor is not a Kelp Forest plant); omit for open seabed.
 * @returns {Array<{id, density, ...}>} sorted by density, densities already blended
 */
export function spawnTableAt(x, z, kind = 'flora', y) {
  const w = y === undefined ? groundWeights(x, z) : at(x, y, z).weights;
  const merged = new Map();
  for (const e of w) {
    for (const row of e.biome[kind]) {
      const cur = merged.get(row.id);
      if (cur) cur.density += row.density * e.w;
      else merged.set(row.id, { ...row, density: row.density * e.w });
    }
  }
  return [...merged.values()].sort((a, b) => b.density - a.density);
}

/**
 * Pick one entry from a spawn table by density. Pass ctx.rng (or any 0..1
 * function) — never Math.random, so a seed reproduces a frame.
 */
export function pick(table, rng) {
  let total = 0;
  for (const r of table) total += r.density;
  if (total <= 0) return null;
  let v = (typeof rng === 'function' ? rng() : 0.5) * total;
  for (const r of table) { v -= r.density; if (v <= 0) return r; }
  return table[table.length - 1];
}

/** Expected instance count for a table over an area in m^2 (densities are /1000 m^2). */
export function expectedCount(table, areaM2) {
  let total = 0;
  for (const r of table) total += r.density;
  return total * areaM2 / 1000;
}

/** Ambience tags + weights at a position, strongest first — for audio crossfades. */
export function ambienceAt(x, y, z) {
  const m = at(x, y, z);
  return m.weights.map((e) => ({ tag: e.biome.ambience, w: e.w }));
}

// ---------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------
const api = {
  id: 'biomes',
  order: 40,

  // ---- required interface
  get, list, ids, at, atDepth,
  /** the raw table, keyed by id */
  table: BIOMES,
  BIOMES,

  // ---- lookups
  dominant, groundAt, groundWeights, cavernsAt, floorDepthAt, ambienceAt,
  mix, createMedium, applyToUniforms,

  // ---- spawn
  flora, creatures, spawnTableAt, pick, expectedCount,

  // ---- optics, exposed so a critic can check the derivation
  deriveAbsorption, screenTint, JERLOV_KD, K_VIS, HUE_DISP, RED_DISP, DOWNSTREAM,
  VOID_INNER, VOID_OUTER, COLUMN,

  async init(ctx) {
    _ctx = ctx;                       // used to resolve terrain lazily
    ctx.provide?.('biomes', api);
    this._medium = createMedium();
    this._checked = false;
  },

  /**
   * Re-read the transform render/underwater.js is actually applying to our
   * medium and re-bake if it has moved off DOWNSTREAM's assumption. The
   * pre-compensation in section 1b is only correct against the transform in the
   * pipeline, and that module is owned by someone else — this is the seam that
   * stops the two tables drifting apart silently, which is exactly how the
   * Dunes came to render green.
   *
   * Runs on the first frame rather than in init(): modules load in `order` and
   * `underwater` may not exist yet when we initialise. Guarded throughout.
   */
  /**
   * No accumulators, no history: `_medium` is recomputed from the camera every
   * frame and the fallback lerp in preRender only runs when underwater.js is a
   * stub. The one thing that persists across a teleport is the one-shot sync
   * latch below, so clear it — a shot that ran after someone poked
   * underwater.params from the console would otherwise keep a stale bake.
   */
  resetForShot() {
    this._synced = false;
    this._checked = false;
  },

  /**
   * CAPTURE STABILITY, measured r22 — read this before trusting a single frame.
   *
   * Two `--isolate` captures of a byte-identical build, same seed, same flags:
   * the FIRST capture of a cold session disagrees with every later one far
   * outside the published 0.4% / 3.4% noise floor — cave median 3.9 then 7.7
   * (97%), cave R% 22 then 30, shallows-reef topBottom 0.37 then 1.68 (4.5x),
   * shallows-reef tileContrast 21.8 then 14.8 (32%). Every capture after the
   * first reproduces to ~0.1% on those two shots. Take a throwaway capture
   * first, or the number you publish is a cold shader cache.
   *
   * `grand-reef` additionally never settles: its draw count flips between 398
   * and 434 and its triangle count between 4.63M and 4.94M on an unchanged
   * build, carrying median between 19.4 and 28.5. Its colour statistics (R%,
   * sat) are stable to the digit; its level and detail statistics are not.
   */

  update(dt, t, ctx) {
    if (this._synced) return;
    this._synced = true;
    const p = ctx.get?.('underwater')?.params;
    if (!p) return;
    let moved = false;
    for (const k of ['hueK', 'hueCap', 'visGain', 'spread', 'redRatio']) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - DOWNSTREAM[k]) > 1e-6) {
        DOWNSTREAM[k] = v; moved = true;
      }
    }
    if (moved) rebake();
  },

  /**
   * biomes renders nothing. The only thing it does per frame is a courtesy
   * fallback: while render/underwater.js is still a stub somebody has to push
   * the biome medium into U.*, or the entire world renders in core's single
   * hardcoded Safe-Shallows default and no biome but the first can be judged.
   * The moment underwater.js is real it owns U.* and we stand down completely.
   * Force it off with ?nobiomefog=1.
   */
  preRender(ctx) {
    // Checked on the first frame, not in init(): modules load in `order`, so
    // `underwater` exists by now whatever the manifest ordering happens to be.
    if (!this._checked) {
      this._checked = true;
      const uw = ctx.get?.('underwater');
      const ws = ctx.get?.('watersurface');
      this._driveUniforms = (!uw || uw.stub === true) && ctx.params?.get('nobiomefog') !== '1';
      // uUnderwater is the water surface's call; only touch it if that is a stub too.
      this._driveSubmersion = this._driveUniforms && (!ws || ws.stub === true);
      if (this._driveUniforms) {
        console.info('[biomes] render/underwater.js is a stub — driving the U.* medium '
          + 'uniforms as a fallback so biome colour is visible. Standing down '
          + 'automatically once underwater is real.');
      }
    }
    if (!this._driveUniforms) return;
    const c = ctx.camera.position;
    at(c.x, c.y, c.z, this._medium);
    // true: nobody downstream is applying the depth tint, so we must — our
    // colours are pre-compensated for it (see applyToUniforms).
    applyToUniforms(ctx.U, this._medium, ctx.time.frame < 3 ? 1 : 0.12, true);
    if (this._driveSubmersion) ctx.U.uUnderwater.value = c.y < WORLD.seaLevel ? 1 : 0;
  },
};

export default api;
