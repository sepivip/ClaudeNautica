/**
 * FLORA — everything that grows on the seabed.
 * OWNER: the "flora" agent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS FOR
 * ---------------------------------------------------------------------------
 * LOOK.md §7 ends with "Bare rock is rare. Nearly every surface is covered in
 * grass, coral, tube growths, algae or moss. Exposed untextured rock reads as
 * unfinished", and §11.24 rejects "flora all at one scale". So this module has
 * two jobs that pull in opposite directions:
 *
 *   1. COVER. Thousands of knee-height plants, dense enough that the seabed is
 *      never a bare surface, cheap enough to be nearly free.
 *   2. SCALE. A stand of 18-34 m creepvines in the same frame, because the
 *      contrast between a 0.6 m grass tuft and a 30 m tower is the entire
 *      reason a Subnautica frame feels big (LOOK.md §8, "the scale rule").
 *
 * Both are served by one instanced pipeline: 12 archetype geometries, 34
 * species mapped onto them by colour / size / glow, ~13 draw calls in total.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INSTANCING IS HAND-ROLLED
 * ---------------------------------------------------------------------------
 * Not InstancedMesh. core/underwaterMaterial.js writes the shared medium's
 * world position as `(modelMatrix * vec4(transformed, 1.0)).xyz`, injected
 * AFTER <project_vertex> — and three.js's <project_vertex> applies
 * `instanceMatrix` to a *copy* of `transformed`, never to `transformed` itself.
 * Every instance of an InstancedMesh would therefore be fogged, lit and
 * caustic-mapped as though it stood at the group origin: a kelp stand 60 m away
 * would take the near field's transmittance and the whole biome ramp would come
 * apart. Folding the instance transform into `transformed` ourselves before
 * <project_vertex> keeps the shared medium exact, which is the entire point of
 * the injection. terrain.js's cobble field does the same thing for the same
 * reason — this is the established pattern in the codebase, not a local hack.
 *
 * ---------------------------------------------------------------------------
 * SILHOUETTE — why plants have a per-species light budget
 * ---------------------------------------------------------------------------
 * LOOK.md §8 says the creepvine "reads as pure black vertical silhouette", and
 * round one's read as a pale mint conifer: measured on our own 1920x1080
 * capture, the near vine crop returned luminance 96.8 with a floor of 73
 * against open water at 115 — 1.19:1, where the matching crop of
 * kelp-forest-1.jpg returns a floor of 0.2 against water at 194.7.
 *
 * The albedo was never the cause (0x22391b is linear 0.03). Four
 * albedo-independent or near-independent paths were doing it: a wrap-around
 * diffuse term with a 0.36 floor, hemisphere ambient, the caustic net, and a
 * specular sheen worth up to 0.16 linear on a plant whose albedo is 0.03. So
 * every species now carries `fill`, one number scaling all four; the creepvines
 * run at 0.05 and keep a fifth of direct N.L so a sunlit crown still separates
 * from a shaded one. That single change took the near vine to a floor of 0 and
 * a median of 35 against water at 121, and lifted the crop's local contrast
 * from 7.03 to 15.22 (the reference measures 26.26) with no extra triangles.
 *
 * The other half is DISTANCE. core's uwInscatter contributes roughly 60% of the
 * open-water radiance by ten metres, so a vine at ten metres cannot read darker
 * than about 1.3:1 however black its shading is — a silhouette can only exist
 * in the near field. That is why the vine's near-cull clearance is 1.0 m and
 * the stand's density is 8.6x the biome hint: the frame has to be one you are
 * standing INSIDE, with a stalk two metres off the lens, or the medium erases
 * the contrast before it reaches the film.
 *
 * ---------------------------------------------------------------------------
 * THE CURRENT
 * ---------------------------------------------------------------------------
 * AGENT_BRIEF §4 names "plants that are stiff, or that all sway in identical
 * phase" as an instant amateur tell, and a stand where every stalk leans at the
 * same instant is exactly as wrong as a stand that does not move. So the sway
 * is a TRAVELLING WAVE, not a global oscillator:
 *
 *      phase = omega*t - dot(worldXZ, flowDir) * k + perInstancePhase
 *
 * with lambda ~ 19 m and a phase velocity of ~5 m/s. A gust visibly crosses the
 * forest; two vines 10 m apart are half a wavelength out of step; and the
 * per-instance term means even neighbours at the same wave phase differ. On top
 * of that every frond flutters on its own faster clock keyed to a per-blade
 * random, so no two blades on one stalk move together either.
 *
 * The bend also carries a DC term. A current does not oscillate about vertical,
 * it leans the whole stand downstream and oscillates about THAT — which is why
 * a real kelp forest reads as being in a flow rather than in an earthquake.
 *
 * ---------------------------------------------------------------------------
 * BIOLUMINESCENCE
 * ---------------------------------------------------------------------------
 * LOOK.md §11.26/27: below 200 m the only visible things are self-illuminated,
 * and bioluminescence is "clusters of discrete small points with bloom, sitting
 * on an otherwise black object" — never a uniform emissive surface. So glow is
 * a per-VERTEX mask (spike tips, pod clusters, cap rims, frond ends) times a
 * per-instance colour and intensity, pushed well above 1.0 in linear so postfx's
 * bloom threshold catches it.
 *
 * Two things make it a light SOURCE rather than a bright sticker:
 *   - core's UNDERWATER_FRAG multiplies the whole fragment by
 *     `mix(0.06, 1, sunT.b) * uDepthDarken`, which at 200 m is about 0.03. That
 *     is correct for a sunlit surface and catastrophic for a self-lit one, so
 *     the emissive term is PRE-DIVIDED by exactly that factor. A photon emitted
 *     here does not care how far away the sun is.
 *   - each strong glower drops a terrain-conforming additive light pool on the
 *     seabed under it (see makePoolPatch). That is what makes a dark frame read
 *     as "this plant is lighting the sand", which is what cave-3.jpg shows.
 *
 * ---------------------------------------------------------------------------
 * SURFACE MICROSTRUCTURE — why it is computed in OBJECT space
 * ---------------------------------------------------------------------------
 * AGENT_BRIEF §4 now names the thing that decided 9 of 18 blind pairs: "every
 * asset is a smoothly-shaded solid colour ... so it reads as moulded vinyl", and
 * our own kelp/reef crop measured detailRMS 8.6-11.1 against the matching
 * shallows-floor-2 crops at 28.0-32.3. Flora carried a THIRD of the reference's
 * surface signal, and none of it below the scale of a whole frond.
 *
 * core/surface.js provides the fix, and this module calls its primitive
 * `sfBroadband` DIRECTLY rather than going through applyUnderwater's
 * `surface:` option, for one reason that is specific to plants: everything here
 * MOVES. sfApply keys the pattern off vUwWorldPos, and a creepvine tip travels
 * three metres in a gust — the grain would crawl across the blade every time the
 * current turned, which is worse than having no grain at all. So the noise is
 * evaluated at `position * aIScl + aIPos * 0.31`: the plant's own un-swayed
 * local frame, in METRES (the archetypes are authored in a unit box and scaled
 * by the real size, so a 30 m vine gets 30 m of noise and a 0.6 m tuft gets
 * 0.6 m — physical-scale texture for free), offset per instance so two
 * neighbours are not the same plant twice.
 *
 * Three things come out of the same two noise taps, because the amplitudes have
 * to stay LOW and broadband — the brief's target is to raise broadband content
 * without raising hard-edged local contrast:
 *   - multiplicative albedo variation, so a near-black creepvine stays near-black
 *   - a small hue break-up (G against R), which is separation we were measured
 *     short of and which costs nothing
 *   - a DERIVATIVE BUMP (Mikkelsen), which is the term that actually converts
 *     "painted" into "surfaced": the medium is a strongly anisotropic area
 *     light, so tilting a facet changes what it collects far more than tinting
 *     it does. creatures.js uses the same construction; the NaN rejection is
 *     copied from it because a degenerate sliver makes det ~ 0 and one inf pixel
 *     poisons postfx's exposure average for the entire frame.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT
 * ---------------------------------------------------------------------------
 * Three cell tiers by plant size (near / mid / far), each a deterministic
 * scatter seeded from the cell index so a seed reproduces a frame exactly.
 * Species come from `biomes.spawnTableAt(x, z, 'flora', groundY)` — passing the
 * ground Y matters: it is what makes the cave shot return
 * jellyshroom/pygmy_fan/ghost_weed instead of the open-seabed sparse_reef
 * table, because cavern biomes are only visible to the depth-aware query. Every
 * candidate is snapped with terrain.heightAt / normalAt, rejected on slope, and
 * gated by a coverage fbm so plants grow in patches with bare ground between
 * them instead of an even lawn.
 *
 * Everything degrades gracefully: no terrain -> a flat fallback plane; no
 * biomes -> a built-in depth-banded table.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { applyUnderwater, UNDERWATER_PARS } from '../core/underwaterMaterial.js';
import { makeRNG, fbm2 } from '../core/rng.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const GOLD = 2.39996323;                    // golden angle — phyllotaxis for blades

/** sRGB hex -> linear THREE.Color (the renderer's working space). */
const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ===========================================================================
// 1. SPECIES
// ===========================================================================
/**
 * Every id that appears in any biome's flora table in world/biomes.js, mapped
 * onto one of 12 archetype geometries. Sharing geometry across species is what
 * keeps 34 plant types inside 13 draw calls: two species that differ only in
 * colour, size and glow are two rows here and zero extra buffers.
 *
 *   a      archetype geometry
 *   col    base albedo, sRGB hex (converted to linear at load)
 *   jit    per-instance brightness jitter, +/- this fraction
 *   sway   sway amplitude scale (1.0 = a full creepvine)
 *   trans  translucency — how much light passes THROUGH a frond. Creepvine is
 *          near zero (LOOK.md §8 calls it "pure black vertical silhouette"), a
 *          jellyshroom cap is over 1 ("translucent domes lit from within").
 *   fill   HOW MUCH NON-DIRECT LIGHT THIS PLANT ACCEPTS. 1 = a normal reef
 *          plant, which takes hemisphere ambient, the wrap-around term, the
 *          caustic net and a wet sheen. The creepvines run at 0.05, and that
 *          single number is the difference between kelp-forest-1.jpg and a
 *          fern: measured, our near vine sat at luminance 96.8 against water
 *          115 (1.19:1) where the reference's near stalk floors at 0.2 against
 *          water 194.7. The albedo was never the problem — 0x22391b is linear
 *          0.03 — the light was arriving through ambient, wrap and an
 *          albedo-independent specular. Direct N.L survives at a fifth so a
 *          sunlit crown still separates from a shaded one.
 *   body   how much of the emissive covers the whole body instead of only the
 *          discrete glow points. 0 for everything LOOK.md §11.27 describes as
 *          "clusters of small points on an otherwise black object"; high only
 *          for the jellyshroom, whose entire identity is a "translucent
 *          magenta dome lit from within".
 *   tier   0 near / 1 mid / 2 far — sets the cell size and the cull radius
 *   surf   surface-microstructure amplitude, defaulting to the archetype's.
 *          A calcareous coral is pitted and blotched (1.3-1.5); a translucent
 *          jellyshroom dome genuinely is smooth (0.5); a leaf is in between.
 *   glow   emissive colour; gi its intensity; pool the ground-light radius
 *          multiple (absent = no light pool)
 *   mul    density multiplier on the biome table's hint
 *   slope  max terrain slope (1 - normal.y) this species will grow on
 *   size   overrides the biome table's scale range where we need it to
 *   bias   exponent on the 0..1 size roll. 2 (the default) puts most of a
 *          population at the small end with a few giants, which is what a real
 *          age distribution looks like; 1 is flat and is what the creepvines
 *          want, because a stand of mostly-short kelp is not a forest.
 *
 * ALBEDO NOTE. Every one of these is deliberately DARKER than it looks in a
 * reference screenshot, because the reference has already been through the
 * water. Round one authored coral at linear 0.77 — brighter than biomes.js's
 * own sand albedo of 0.59 — and a stand of coral tubes rendered as pale plastic
 * funnels standing proud of the seabed. Reef growth is roughly as dark as the
 * rock it grows on; what makes it read is hue and silhouette, not value.
 */
const SPECIES = {
  // ---- ground cover -------------------------------------------------------
  // The mats carry ~20x the table's hint. shallows-floor-2.jpg shows a plateau
  // with NO bare sand on it at all, and a matched crop measured our densest
  // patch at laplacian 3.4 against its 28.56 — 8.4x less surface signal. At the
  // table's own number a mat lands at one clump per three square metres, which
  // reads as scattered plants; the reference reads as turf.
  // ROUND 33 — size was [0.55, 1.95]. LOOK.md section 8 measures grass mats at
  // "0.3-1 m, dense red, magenta or green carpets covering whole plateaus", and
  // the geometry reaches h = 0.54-0.98 of its instance scale, so 1.95 put the
  // tallest sea grass at very nearly TWO METRES — twice the top of the measured
  // band, and the reason the shallows-floor crop reads as a stand of separated
  // yuccas rather than as a carpet. [0.42, 1.08] lands the population at
  // 0.23-1.06 m, inside the band, and the tighter `spread` packs a clump into a
  // 1.6 m patch so nine tufts overlap into a mat instead of scattering over the
  // 3.8 m disc the default `1 + 2*sqrt(hi)` was giving them.
  sea_grass:       { a: 'grass', col: 0x479c22, jit: 0.38, sway: 0.55, trans: 0.60, tier: 0, mul: 27.0, slope: 0.88,
                     size: [0.42, 1.08], spread: 1.6, hue: 0.22 },
  blood_grass:     { a: 'grass', col: 0xb01030, jit: 0.28, sway: 0.42, trans: 0.85, tier: 0, mul: 5.20, slope: 0.76, spiky: 1 },
  ash_weed:        { a: 'grass', col: 0x4c473c, jit: 0.30, sway: 0.48, trans: 0.28, tier: 0, mul: 4.20, slope: 0.80 },
  writhing_weed:   { a: 'grass', col: 0x5ea22e, jit: 0.36, sway: 0.95, trans: 0.65, tier: 0, mul: 8.40, slope: 0.84, hue: 0.22 },
  // gi 1.35, not 2.8. A ghost weed sat 3 m off the lens in the shallows-floor
  // frame as a solid white fan — every blade tip clipped, no rolloff, no hue —
  // and clipped area is the one thing LOOK.md §9 is unambiguous about: the 99th
  // percentile of a real frame is 148-220 and only "a few percent of pixels at
  // most" sit in the bright tail. A tuft of 24 blades all glowing over the top
  // third of their length is not a cluster of discrete points, it is a lamp.
  ghost_weed:      { a: 'grass', col: 0x5aa294, jit: 0.20, sway: 0.65, trans: 1.00, tier: 0, mul: 4.20, slope: 0.80,
                     glow: 0x8effe4, gi: 1.35, pool: 1.5 },
  redwort:         { a: 'grass', col: 0x7d101a, jit: 0.24, sway: 0.40, trans: 0.75, tier: 0, mul: 3.60, slope: 0.64,
                     glow: 0xff5236, gi: 2.2, pool: 1.2, spiky: 1 },
  shell_scatter:   { a: 'shell', col: 0xb5a385, jit: 0.42, sway: 0.00, trans: 0.10, tier: 0, mul: 4.60, slope: 0.42,
                     size: [0.09, 0.40] },

  // ---- fans ---------------------------------------------------------------
  purple_fan:      { a: 'fan',   col: 0x7433b4, jit: 0.24, sway: 0.70, trans: 0.90, tier: 0, mul: 3.40, slope: 0.70 },
  pygmy_fan:       { a: 'fan',   col: 0xa64cbe, jit: 0.26, sway: 0.80, trans: 0.95, tier: 0, mul: 3.20, slope: 0.74 },
  veined_nettle:   { a: 'fan',   col: 0xd8542a, jit: 0.26, sway: 0.75, trans: 0.85, tier: 0, mul: 6.00, slope: 0.72 },
  ember_frond:     { a: 'fan',   col: 0xa83716, jit: 0.22, sway: 0.70, trans: 0.90, tier: 0, mul: 1.90, slope: 0.68,
                     glow: 0xff7a1e, gi: 2.4, pool: 1.4 },

  // ---- the small bulbous "melted candle" forms (LOOK.md §7) ---------------
  gel_sack:        { a: 'blob',  col: 0x76a54c, jit: 0.24, sway: 0.22, trans: 0.95, tier: 0, mul: 2.30, slope: 0.52,
                     glow: 0xa9ff7c, gi: 1.5, pool: 1.0 },
  speckled_rattler:{ a: 'blob',  col: 0x9c8843, jit: 0.30, sway: 0.20, trans: 0.35, tier: 0, mul: 2.30, slope: 0.52 },
  deep_shroom:     { a: 'blob',  col: 0x4a2f66, jit: 0.26, sway: 0.18, trans: 0.70, tier: 0, mul: 2.50, slope: 0.54,
                     glow: 0xc07bff, gi: 1.8, pool: 1.5 },
  lava_flower:     { a: 'blob',  col: 0x6b200e, jit: 0.26, sway: 0.18, trans: 0.60, tier: 0, mul: 2.10, slope: 0.54,
                     glow: 0xff8a2a, gi: 2.0, pool: 1.7 },

  // ---- tube growths -------------------------------------------------------
  // shallows-reef-1/3 have a handful of tube clusters on a reef otherwise
  // covered in low turf; shallows-floor-2 has cream-and-orange growths in
  // clear hue separation from the tan rock, which is a cue the blind trial
  // named. Warm hues, mid values — bright enough to separate, dark enough not
  // to read as painted plastic.
  coral_tube:      { a: 'tube',  col: 0xd08350, jit: 0.26, sway: 0.10, trans: 0.45, tier: 1, mul: 1.15, slope: 0.58,
                     size: [1.4, 4.6] },
  slag_coral:      { a: 'tube',  col: 0x5c4a3e, jit: 0.28, sway: 0.08, trans: 0.20, tier: 1, mul: 1.00, slope: 0.60,
                     size: [1.4, 4.2] },
  tube_worm:       { a: 'tube',  col: 0x9e5238, jit: 0.28, sway: 0.30, trans: 0.55, tier: 0, mul: 2.00, slope: 0.58,
                     glow: 0xff9d5c, gi: 2.2, pool: 1.0 },
  sulphur_stalk:   { a: 'tube',  col: 0xac9a34, jit: 0.24, sway: 0.14, trans: 0.40, tier: 1, mul: 1.30, slope: 0.58,
                     glow: 0xffe066, gi: 2.2, pool: 1.2 },

  // ---- reef masses --------------------------------------------------------
  brain_coral:     { a: 'brain', col: 0xcc6b45, jit: 0.24, sway: 0.00, trans: 0.18, tier: 1, mul: 1.70, slope: 0.60,
                     size: [1.1, 3.6] },
  table_coral:     { a: 'table', col: 0xba7448, jit: 0.24, sway: 0.05, trans: 0.35, tier: 2, mul: 0.95, slope: 0.52,
                     size: [3.0, 9.5] },

  // ---- umbrellas ----------------------------------------------------------
  // shallows-floor-2.jpg is one third yellow acid mushrooms by area; ours ran
  // at mul 1.2 and the frame's G-vs-B separation measured [0.97,1.06,1.06]
  // against the reference's [0.98,1.52,2.56]. Hue separation is free and it
  // was simply not being spent.
  acid_mushroom:   { a: 'shroom',col: 0xe4c832, jit: 0.30, sway: 0.30, trans: 0.95, tier: 1, mul: 7.40, slope: 0.66,
                     size: [0.6, 1.75], hue: 0.18 },
  tree_mushroom:   { a: 'shroom',col: 0x7a5638, jit: 0.24, sway: 0.16, trans: 0.55, tier: 2, mul: 1.05, slope: 0.54,
                     size: [5, 14] },
  // LOOK.md §8 gives the jellyshroom cave its whole identity: "caps 8-20 m,
  // translucent magenta domes lit from within", and cave-1.jpg is ~40% covered
  // in them. The isolated flora render of our cave frame contained two or three
  // DARK umbrellas: they were being planted (73 live instances) and then not
  // lit, because gi 1.8 with the emissive confined to the cap rim is a plant
  // with a glowing edge, not a lantern. body:0.9 spreads the emission over the
  // whole dome, which is the one place LOOK.md §11.27's "discrete points only"
  // rule is explicitly overridden by §8.
  // The glow is authored red-dominant for the same reason the creepvine pods
  // are: biomes.js's shapeAbsorption() floors this cave's red extinction at
  // redMax 0.62/m against green and blue at 0.16/m, so over 12 m red transmits
  // 6e-4 where blue transmits 0.14. An authored magenta arrives BLUE, and
  // cave-1.jpg's whole identity is violet. 0xff1a5a resolves to magenta in the
  // near field and to a cool violet at range, which is the closest this medium
  // can be made to come (see the core-bug note in the report).
  jellyshroom:     { a: 'shroom',col: 0x9c2050, jit: 0.20, sway: 0.24, trans: 1.35, tier: 2, mul: 4.60, slope: 0.80,
                     fill: 1.5, body: 0.82, wide: 1.24, surf: 0.45,
                     size: [4.5, 10.5], bias: 1.0, glow: 0xff1a5a, gi: 4.4, pool: 2.2 },

  // ---- studded spheres ----------------------------------------------------
  koosh_sphere:    { a: 'sphere',col: 0x2c2154, jit: 0.22, sway: 0.34, trans: 0.45, tier: 1, mul: 1.10, slope: 0.52,
                     size: [3.0, 6.5], glow: 0x5cf0ff, gi: 2.2, pool: 1.5 },
  bulb_bush:       { a: 'sphere',col: 0x24451c, jit: 0.24, sway: 0.36, trans: 0.60, tier: 1, mul: 1.10, slope: 0.54,
                     size: [2.4, 6.5], glow: 0xaaff5a, gi: 1.8, pool: 1.4 },

  // ---- palms / crowns -----------------------------------------------------
  blue_palm:       { a: 'palm',  col: 0x255990, jit: 0.24, sway: 0.55, trans: 0.85, tier: 1, mul: 1.70, slope: 0.58,
                     glow: 0x63d4ff, gi: 2.0, pool: 1.3 },
  sea_crown:       { a: 'palm',  col: 0x3c7355, jit: 0.24, sway: 0.45, trans: 0.70, tier: 2, mul: 1.40, slope: 0.56,
                     glow: 0x9fffc8, gi: 1.5, pool: 1.1 },
  spike_plant:     { a: 'palm',  col: 0x7d6e46, jit: 0.28, sway: 0.40, trans: 0.45, tier: 1, mul: 1.80, slope: 0.58 },
  brine_lily:      { a: 'palm',  col: 0x2f7a6c, jit: 0.22, sway: 0.50, trans: 0.95, tier: 1, mul: 1.70, slope: 0.58,
                     glow: 0x6effd0, gi: 1.8, pool: 1.6 },
  membrain_tree:   { a: 'palm',  col: 0x1f5049, jit: 0.20, sway: 0.35, trans: 1.10, tier: 2, mul: 1.20, slope: 0.54,
                     glow: 0x7dffe0, gi: 1.7, pool: 2.0 },

  // ---- the towers ---------------------------------------------------------
  // LOOK.md §8: creepvine is 25-40 m, 15-25x player height, a thin twisted stalk
  // with regular paired thorn-blades reading as a black vertical silhouette.
  //
  // THE SIZE BAND IS WHAT MAKES THE BARBS ABSOLUTE. The archetype is authored in
  // a unit box and scaled by the instance height, so a blade authored as a
  // fraction of height is only the same physical size across the stand if the
  // stand's heights are close together. [17,34] gave 1.5 m barbs on a short
  // vine and 3 m on a tall one and the silhouette read as a fir tree; [24,37]
  // with blades at 0.028 of height gives 0.67-1.04 m barbs on every plant in
  // the stand, which is kelp-forest-1's hooked-barb column at zero shader cost.
  //
  // fill 0.05: see the header of this table. This is the single number that
  // turns the signature plant from a pale conifer into a silhouette.
  // trans 0.055, not 0.030: LOOK.md §8's "pure black vertical silhouette" is
  // measured off a stalk at range, and kelp-forest-2 and -4 both show the near
  // blades passing a yellow-green glow at their thin trailing edges. At 0.055
  // the body of the blade is still black to within a percent and only the
  // grazing rim lights, which is what a 3 mm leaf actually does.
  kelp_vine:       { a: 'vine',  col: 0x1b2d14, jit: 0.26, sway: 1.00, trans: 0.055, tier: 2, mul: 8.60, slope: 0.50,
                     fill: 0.050,
                     // THE PODS. Round six authored them nearly pure red at
                     // gi 80 on the theory that they "have to CLIP", and the
                     // blind trial's verdict on the result was exact: "blown-out
                     // white hexagons with a red bloom fringe vs the reference's
                     // discrete warm-orange pods". Measured, our kelp frame put
                     // 0.034% of pixels at luminance >= 250 and 98% of THOSE
                     // were pure 255/255/255; kelp-forest-1.jpg puts 0.0002%
                     // there and its brightest pixels average rgb(250,252,120).
                     // The reference pods are not white. They are amber, they
                     // are DISCRETE, and only one or two in a cluster of a dozen
                     // come near the clip point at all.
                     //
                     // So the authored colour is now solved for the eye rather
                     // than for the buffer. Kelp water resolves to an absorption
                     // near (0.25, 0.049, 0.051)/m, so at the 3-4 m a near
                     // cluster actually hangs at, red transmits ~0.47 against
                     // green's ~0.86. Dividing the reference's body colour
                     // rgb(255,190,80) through that transmittance gives a
                     // linear (1.0, 0.28, 0.044) — which is this hex. It arrives
                     // amber in the near field and drifts to yellow-green far
                     // out, which is exactly what happens to a warm light in
                     // green water and what kelp-forest-2 shows on its far
                     // clusters.
                     //
                     // gi 9, not 80. Nine-tenths of the old number was buying
                     // clipped area, and clipped area is the tell. Brightness is
                     // now spent on ONE OR TWO pods per cluster instead (see the
                     // per-pod spread in FLORA_FRAG), which is what makes a
                     // dozen berries read as a dozen berries.
                     //
                     // gi 1.5, not 2.4 — see the pod block in buildVine and the
                     // limb term in FLORA_FRAG. The brightness that used to buy
                     // a flat clipped middle now buys a small clipped core and
                     // two-thirds of each berry holding its amber.
                     size: [24, 37], bias: 1.0, pods: 1, glow: 0xff913b, gi: 1.5, pool: 1.2, clump: [4, 9], spread: 6.6 },
  blood_vine:      { a: 'vine',  col: 0x211014, jit: 0.24, sway: 0.90, trans: 0.05, tier: 2, mul: 3.60, slope: 0.48,
                     fill: 0.085,
                     size: [24, 38], bias: 1.0, pods: 1, glow: 0xff5a2a, gi: 1.9, pool: 1.1, clump: [3, 6], spread: 7.2 },
  scorched_vine:   { a: 'vine',  col: 0x1d1813, jit: 0.30, sway: 0.70, trans: 0.04, tier: 2, mul: 2.40, slope: 0.52,
                     fill: 0.090,
                     size: [10, 20], bias: 1.2, pods: 0, clump: [2, 5], spread: 7.0 },
};

/** Fallback spawn table, used only if world/biomes.js is a stub. By depth (m). */
const FALLBACK_TABLE = [
  [0,   [{ id: 'sea_grass', density: 240, cluster: 9, scale: [0.5, 1.0] },
         { id: 'coral_tube', density: 20, cluster: 3, scale: [2.6, 7.5] },
         { id: 'brain_coral', density: 6, cluster: 1, scale: [2.5, 8] },
         { id: 'table_coral', density: 7, cluster: 2, scale: [4, 13] },
         { id: 'acid_mushroom', density: 18, cluster: 6, scale: [0.7, 2] }]],
  [45,  [{ id: 'kelp_vine', density: 5.5, cluster: 2, scale: [25, 40] },
         { id: 'sea_grass', density: 120, cluster: 8, scale: [0.5, 1.0] },
         { id: 'blood_grass', density: 34, cluster: 6, scale: [0.4, 0.9] },
         { id: 'coral_tube', density: 8, cluster: 2, scale: [2, 5.5] }]],
  [130, [{ id: 'sea_grass', density: 70, cluster: 7, scale: [0.5, 1.0] },
         { id: 'purple_fan', density: 9, cluster: 3, scale: [0.8, 2.2] },
         { id: 'blue_palm', density: 8, cluster: 3, scale: [1.5, 4] },
         { id: 'koosh_sphere', density: 4, cluster: 2, scale: [4, 8] }]],
  [260, [{ id: 'ghost_weed', density: 14, cluster: 4, scale: [0.6, 1.4] },
         { id: 'purple_fan', density: 11, cluster: 3, scale: [1, 2.4] },
         { id: 'blue_palm', density: 9, cluster: 3, scale: [1.5, 4] },
         { id: 'deep_shroom', density: 8, cluster: 3, scale: [0.5, 1.2] }]],
  [520, [{ id: 'ghost_weed', density: 20, cluster: 4, scale: [0.6, 1.4] },
         { id: 'deep_shroom', density: 16, cluster: 4, scale: [0.5, 1.3] },
         { id: 'blood_vine', density: 6, cluster: 2, scale: [22, 45] },
         { id: 'brine_lily', density: 8, cluster: 3, scale: [1, 2.6] }]],
];

// ===========================================================================
// 2. GEOMETRY
// ===========================================================================
/**
 * Every archetype is authored inside a UNIT box: +Y up, characteristic
 * dimension 1.0, origin at the holdfast. The instance scale is the plant's real
 * size in metres straight off the biome table, so `aIScl.y` doubles as "how big
 * is this plant" for the sway amplitude and nothing has to carry a second
 * length. What "characteristic dimension" means is per-archetype and matches
 * how LOOK.md §8 states the size: HEIGHT for the vines, grasses, tubes, palms
 * and shrooms; DIAMETER for the table and brain corals ("5-15 m across").
 *
 * Per-vertex channels beyond position/normal:
 *   aFlora  x sway weight (0 at the holdfast, 1 at the tip, pre-shaped)
 *           y flutter weight (0 on rigid parts, up to 1 at a frond edge)
 *           z emissive mask — the discrete glow points of LOOK.md §11.27
 *           w baked ambient occlusion / self-shading
 *   aFlora2 x pod flag (see buildVine)
 *           y per-part random, 0..1 — the seed for the flutter phase and for
 *             the per-frond albedo break-up
 *           z EDGE weight — 1 on a blade's rim, 0 on its midrib. A leaf a few
 *             millimetres thick is not a mathematical surface: seen anywhere
 *             near edge-on its rim transmits, and that thin bright line is most
 *             of what separates a real frond from a cardboard cut-out. Every
 *             reference creepvine blade in kelp-forest-4.jpg carries it.
 */
class Build {
  constructor() { this.p = []; this.n = []; this.a = []; this.b = []; this.i = []; }

  v(x, y, z, nx, ny, nz, sw, fw, gl, sh, pod, prt, edge) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z);
    this.n.push(nx / l, ny / l, nz / l);
    this.a.push(sw, fw, gl, sh);
    // Default 0: a lathe, a dome or a coral mass is a closed solid with no thin
    // rim anywhere on it. Only strip()/blade()/the fan membrane opt in.
    this.b.push(pod || 0, prt || 0, edge || 0);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }

  /**
   * A two-vertex-wide strip — the frond, blade and rib primitive. The face
   * normal is computed geometrically as (side x tangent) rather than being
   * authored, so a near-horizontal kelp blade gets a near-vertical normal and a
   * near-vertical grass blade gets a horizontal one without the caller having
   * to think about it. Getting this wrong is what makes procedural foliage
   * shade like a flat card.
   */
  strip(rows) {
    let prev = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const A = rows[Math.max(0, i - 1)].c, Bc = rows[Math.min(rows.length - 1, i + 1)].c;
      const tx = Bc[0] - A[0], ty = Bc[1] - A[1], tz = Bc[2] - A[2];
      const [sx, sy, sz] = r.s;
      const nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      // Rounded cross-section for free. Rotating the two edge normals out of the
      // blade's plane by nb about its own tangent makes a 2-vertex-wide strip
      // shade like a cylindrical leaf instead of a flat card — and the rotation
      // is just n*cos +- s*sin, because (tangent x normal) IS the side vector.
      const nb = r.nb ?? 0.45;
      const c = Math.cos(nb) / nl, s = Math.sin(nb);
      const i0 = this.v(r.c[0] - sx * r.w, r.c[1] - sy * r.w, r.c[2] - sz * r.w,
        nx * c - sx * s, ny * c - sy * s, nz * c - sz * s, r.sw, r.fw, r.gl, r.sh, 0, r.prt, 1);
      const i1 = this.v(r.c[0] + sx * r.w, r.c[1] + sy * r.w, r.c[2] + sz * r.w,
        nx * c + sx * s, ny * c + sy * s, nz * c + sz * s, r.sw, r.fw, r.gl, r.sh, 0, r.prt, 1);
      if (prev) this.quad(prev[0], prev[1], i1, i0);
      prev = [i0, i1];
    }
  }

  /**
   * A RIBBED blade — the same call signature as strip(), three columns wide.
   *
   * strip() makes a two-vertex ribbon, and a two-vertex ribbon is a card: its
   * whole width shades from one interpolated normal, so a creepvine barb and a
   * palm frond both came out as flat coloured polygons. The blind trial named
   * them twice — "giant flat olive polygon fins ... as untextured cards" in the
   * seamoth frame, and the near vine in kelp-forest reading as a corn plant.
   *
   * The fix is the structure a real leaf actually has. Three columns: a MIDRIB
   * standing `rib` proud of the chord and two edges folded slightly BACK, so the
   * cross-section is a shallow lens rather than a plane. That buys four things
   * that all show up in the measurement:
   *
   *   - the two flanks face measurably different directions, so one catches the
   *     downwelling light and the other does not, and a blade carries a value
   *     gradient across its own width instead of one flat tone;
   *   - the midrib is a crease, i.e. a hard line of legitimate geometric origin
   *     running the length of every blade — the vein structure kelp-forest-4
   *     shows on every creepvine frond;
   *   - the edges are DISPLACED off the chord, so the silhouette of a blade seen
   *     near edge-on is a thin lens with thickness, not a zero-width knife;
   *   - the edge vertices carry edge = 1 and the ridge edge = 0, which is what
   *     the fragment shader's rim-transmission term keys off.
   *
   * Four triangles per segment against strip()'s two.
   *
   *   rib  ridge height as a fraction of the half-width (0.45 default)
   */
  blade(rows) {
    let prev = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const A = rows[Math.max(0, i - 1)].c, Bc = rows[Math.min(rows.length - 1, i + 1)].c;
      const tx = Bc[0] - A[0], ty = Bc[1] - A[1], tz = Bc[2] - A[2];
      const [sx, sy, sz] = r.s;
      let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const w = r.w, rib = (r.rib ?? 0.45) * w, back = w * 0.17;
      // flank normal = n*w -/+ s*(rib+back), which is exactly cross(edge->ridge,
      // tangent) for this section — derived, not eyeballed, so the shading and
      // the outline agree.
      const fs = rib + back;
      const i0 = this.v(r.c[0] - sx * w - nx * back, r.c[1] - sy * w - ny * back, r.c[2] - sz * w - nz * back,
        nx * w - sx * fs, ny * w - sy * fs, nz * w - sz * fs, r.sw, r.fw, r.gl, r.sh, 0, r.prt, 1);
      const i1 = this.v(r.c[0] + nx * rib, r.c[1] + ny * rib, r.c[2] + nz * rib,
        nx, ny, nz, r.sw, r.fw, r.gl, r.sh * 0.86, 0, r.prt, 0);
      const i2 = this.v(r.c[0] + sx * w - nx * back, r.c[1] + sy * w - ny * back, r.c[2] + sz * w - nz * back,
        nx * w + sx * fs, ny * w + sy * fs, nz * w + sz * fs, r.sw, r.fw, r.gl, r.sh, 0, r.prt, 1);
      if (prev) {
        this.quad(prev[0], prev[1], i1, i0);
        this.quad(prev[1], prev[2], i2, i1);
      }
      prev = [i0, i1, i2];
    }
  }

  /**
   * A surface of revolution about a wandering axis. `prof` is the meridian:
   * {y, r, cx, cz, sw, sh, gl, fw, prt, rib:[amp, n, phase], ywob:[amp, n, ph]}.
   * Normals come from the radius derivative, so a flaring coral trumpet shades
   * as a cone and not as a cylinder; `rib` adds longitudinal fluting, which is
   * what stops a 4 m coral trumpet at arm's length reading as a smooth plastic
   * cone.
   *
   * `ywob` lifts and drops the row itself with azimuth. A lathe can only make a
   * rim that is a flat circle, and a flat circle seen edge-on is a straight line
   * — which is precisely what the blind trial read off our coral tubes when it
   * called them "flat olive polygons". A real trumpet coral's mouth is FRILLED,
   * so its silhouette is a wave. The normal is re-projected onto the true
   * tangent rather than fudged, because a frill whose shading disagrees with its
   * outline reads as a texture error instead of as shape.
   *
   * A per-row `prt` overrides the call's, which lets one part carry albedo
   * variation ALONG its length instead of being one flat colour end to end.
   */
  lathe(prof, seg, pod, prt, closeTop) {
    const rows = [];
    for (let j = 0; j < prof.length; j++) {
      const P = prof[j];
      const A = prof[Math.max(0, j - 1)], Bp = prof[Math.min(prof.length - 1, j + 1)];
      const dr = Bp.r - A.r, dy = Bp.y - A.y;
      const l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      const rib = P.rib, yw = P.ywob;
      const vprt = P.prt !== undefined ? P.prt : prt;
      const row = [];
      for (let k = 0; k < seg; k++) {
        const ang = (k / seg) * TAU;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const f = rib ? 1 + rib[0] * Math.sin(rib[1] * ang + rib[2]) : 1;
        // the flute's own slope tips the normal tangentially, which is the whole
        // reason it reads as relief rather than as a wobbly outline
        const tang = rib ? -rib[0] * rib[1] * Math.cos(rib[1] * ang + rib[2]) : 0;
        const rr = P.r * f;
        const dyw = yw ? yw[0] * Math.sin(yw[1] * ang + yw[2]) : 0;
        let nx = ca * nr - sa * tang, nyy = ny, nz = sa * nr + ca * tang;
        if (yw) {
          // point = (r cos a, f(a), r sin a); T = (-r sin a, f'(a), r cos a).
          // n . T reduces to ny * f', so one projection restores orthogonality.
          const fp = yw[0] * yw[1] * Math.cos(yw[1] * ang + yw[2]);
          const tx = -rr * sa, ty = fp, tz = rr * ca;
          const k2 = (nyy * fp) / (tx * tx + ty * ty + tz * tz + 1e-9);
          nx -= k2 * tx; nyy -= k2 * ty; nz -= k2 * tz;
        }
        row.push(this.v((P.cx || 0) + ca * rr, P.y + dyw, (P.cz || 0) + sa * rr,
          nx, nyy, nz,
          P.sw, P.fw || 0, P.gl || 0, P.sh, pod, vprt, P.edge || 0));
      }
      rows.push(row);
    }
    for (let j = 0; j < rows.length - 1; j++) {
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        this.quad(rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]);
      }
    }
    if (closeTop) {
      const P = prof[prof.length - 1];
      const c = this.v(P.cx || 0, P.y, P.cz || 0, 0, 1, 0, P.sw, 0, P.gl || 0, P.sh, pod, prt);
      const top = rows[rows.length - 1];
      for (let k = 0; k < seg; k++) this.tri(c, top[k], top[(k + 1) % seg]);
    }
    return rows;
  }

  /**
   * The ENCRUSTING FOOT — how a plant stops being a card stuck in sand.
   *
   * AGENT_BRIEF §4 rejects "geometry that meets the sand at a hard intersection
   * line", and until now only the creepvine had anything at its base. The
   * seamoth frame is the proof: a stand of coral trumpets sliced off by a
   * dead-straight sand line, which the blind trial read as "untextured cards
   * intersecting the ground". A lathe whose base radius equals its stem radius
   * can only ever produce that line.
   *
   * Real reef growth is cemented to the substrate by a spreading calcareous
   * foot, so this is a short skirt that flares out and DOWN through y = 0: the
   * silhouette that meets the sand is a curve, the last centimetres are buried,
   * and the rib term makes the buried rim ragged so the emergence is not a
   * circle either. Four triangles per segment, once per plant.
   *
   *   r      stem radius at the base, in unit-box fractions
   *   flare  rim radius as a multiple of r
   *   rise   how far the foot climbs the stem
   */
  foot(cx, cz, r, flare, seg, prt, rise = 0.070) {
    const lobes = 3 + Math.floor(prt * 5);
    const prof = [];
    // Authored RIM FIRST, climbing inward to the stem, so the meridian's
    // (dr, dy) has the sign lathe() expects and the outward normal comes out
    // pointing up-and-out instead of down-and-in.
    for (let s = 2; s >= 0; s--) {
      const u = s / 2;
      prof.push({
        cx, cz,
        // rise must clear the plant's own sink (0.035 of its size), or the whole
        // foot ends up buried and the hard sand line it exists to hide comes
        // back. At 0.07 the top of the skirt stands a comfortable 3.5% of the
        // plant's height proud of the seabed at every size in the table.
        y: rise * (1 - u) * (1 - u) - rise * 1.05 * u * u,
        r: r * (1 + (flare - 1) * u * u) + 1e-4,
        rib: [0.10 + 0.16 * u, lobes, prt * TAU],
        sw: 0, sh: 0.09 + 0.20 * (1 - u),
      });
    }
    this.lathe(prof, seg, 0, prt, false);
  }

  geo() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aFlora', new THREE.Float32BufferAttribute(this.a, 4));
    g.setAttribute('aFlora2', new THREE.Float32BufferAttribute(this.b, 3));
    g.setIndex(this.i);
    // Instances are scattered over the whole streaming radius, so the geometry's
    // own bounds are meaningless — culling is done per-instance on the CPU by
    // the refill, and the mesh itself must never be culled.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    g.userData.tris = this.i.length / 3;
    return g;
  }
}

// ---------------------------------------------------------------------------
// creepvine
// ---------------------------------------------------------------------------
/**
 * The signature silhouette. kelp-forest-1.jpg and -4.jpg are the reference, and
 * what they show is a ROPE, not a tree: a near-constant-width dark column
 * carrying same-size hooked barbs from the holdfast all the way to a bushy
 * crown, with a glowing seed-pod cluster hanging just under that crown.
 *
 * Round one tapered the stalk (r = R0*(1.02 - 0.42 t^2)) and scaled the blades
 * as a constant fraction of total height, so a 25 m plant carried 1.4-2.6 m
 * basal blades that overlapped into a plume: the isolated render read
 * unmistakably as a fir. Three proportions fix that, all from LOOK.md §8:
 *
 *   - the stalk is 0.3-0.5 m ACROSS on a ~30 m plant, i.e. a radius of ~0.007
 *     of its height, and it barely tapers. 0.0125 with a square taper was 1.9x
 *     too fat at the base and half as wide at the crown — the exact profile of
 *     a conifer trunk.
 *   - the barbs are 0.6-1.0 m whatever the plant's height. They are authored at
 *     0.028 of height and the species' size band is held at [24,37] so that
 *     fraction resolves to 0.67-1.04 m on every vine in the stand (see the
 *     SPECIES comment) — absolute barbs without a per-vertex offset attribute.
 *   - they repeat about every 0.9 m, which is what gives the column its regular
 *     barbed texture instead of a smooth pole. 34 rings over a 30 m plant.
 *
 * The pods are baked into the same geometry rather than being a second pass,
 * because they have to follow the stalk as it sways. A vine that should not
 * carry them collapses them onto the stalk axis (aIPar.z = 0), where an opaque
 * stalk hides them — one attribute instead of a second draw call and a second
 * animation path that could drift out of sync with the first.
 */
function buildVine(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  // 46 rings, not 38. Node spacing is the number that decides whether a stalk
  // reads as a rope or as a corn plant: at 38 rings over 30 m the blades sat
  // 0.81 m apart and 1.08 m long, so the column showed bare smooth stalk
  // between every whorl and the isolated render came back unmistakably as maize.
  // In kelp-forest-4.jpg the blades OVERLAP — you cannot see the stalk at all
  // through the middle third of the plant — which needs spacing shorter than
  // the blade. 46 rings is 0.67 m, against blades of 0.75-1.15 m.
  // SEG 10, because 8 segments cannot resolve a 5-lobe rib: the flute aliased
  // into a smooth polygon and the near stalk read as a moulded pole.
  const RINGS = 46, SEG = 10;
  const R0 = 0.0072;                        // stalk radius as a fraction of height
  const wobA = 0.013 + rng() * 0.011;       // the lazy twist of the centreline
  const wobK = 2.1 + rng() * 1.4;
  // LOOK.md §8 says "thin TWISTED stalk". A smooth 6-gon lathe is neither: it
  // has a polygonal outline and no length-wise structure at all, so the whole
  // column between whorls was a flat value. Five longitudinal ribs whose phase
  // advances with height make it a laid rope — the ribs cross the silhouette
  // diagonally, which is signal in every octave and costs nothing but the
  // two extra lathe segments needed to resolve them.
  const ribN = 5, ribTwist = 5.4 + rng() * 3.2, ribPh = rng() * TAU;

  const axis = [];
  for (let j = 0; j < RINGS; j++) {
    const t = j / (RINGS - 1);
    axis.push({
      t,
      x: Math.sin(t * wobK * TAU * 0.35 + 0.7) * wobA * t,
      z: Math.cos(t * wobK * TAU * 0.29) * wobA * t,
      // a rope, not a trunk: 12% narrower at the crown than at the holdfast
      r: R0 * (1.04 - 0.16 * t),
    });
  }

  const prof = axis.map((A) => ({
    y: A.t, r: A.r, cx: A.x, cz: A.z,
    rib: [0.17, ribN, ribPh + A.t * ribTwist],
    // pow 1.5 is a cantilever's static deflection shape: almost nothing moves
    // near the holdfast and the tip carries the whole excursion.
    sw: Math.pow(A.t, 1.5),
    sh: 0.20 + 0.60 * clamp01(A.t * 1.5),
  }));
  B.lathe(prof, SEG, 0, 0, false);

  // ---- barbs: three per node, phyllotactic, hooked. The hook is the sweep
  // term: the blade leaves the stalk radially, rises, and its last third curls
  // sideways and over. A straight spike reads as a conifer needle; the
  // reference's are unmistakably claws.
  // The blind trial read our vine as "broad flat funnels / palm fronds" against
  // a reference that is a thin twisted stalk with paired THORN blades. The
  // measurement behind that: strip() takes a HALF-width, so a blade authored at
  // len * 0.112 is 22.4% of its own length across — a 4.5:1 leaf, not the ~9:1
  // barb kelp-forest-1 shows. Halving it to 0.056 and spending the triangles on
  // one more segment of hook is the whole species fix: a claw, not a palm leaf.
  // 6 barbs per node and 0.036 of height, against the reference photographed
  // side by side: halving the WIDTH was right and left the column too sparse to
  // read as thorny at range, because in kelp-forest-1 the barbs are dense enough
  // to merge into the stalk silhouette. Density, again, is the read.
  //
  // ROUND EIGHT — the shape is an ARCH, and the blades are ribbed.
  //
  // Two measurements drove this. The isolated flora render put our vine's blades
  // out radially and slightly UP as straight straps, which is a palm; every
  // blade in kelp-forest-1/-4 leaves the stalk, rises for a third of its length
  // and then falls away below its own root, so the stand's silhouette is a
  // column of downward-pointing claws. And the crop spectrum came back at
  // 9.1/11.5/15.7/18.9/22.6 % per octave against the reference plate's
  // 16.2/21.0/24.8/25.7/31.9 — short by 1.7x at the FINE end, which on a
  // near-black silhouette can only be bought with more edges per pixel, not
  // with more grain. Hence: shorter node spacing, blades that overlap, a midrib
  // crease down every one of them (blade(), not strip()) and a ribbed stalk.
  //
  // 7 blades a whorl at 0.027 of height, not 5 at 0.031. The first r8 capture
  // put 5 long straight spikes on each node and the stand read as a THISTLE —
  // you could see bare stalk between the whorls and each node made a symmetric
  // X against the water. kelp-forest-4.jpg's column is a bottle brush: the
  // blades are shorter than they look, there are more of them per whorl than you
  // can count, and they overlap so completely that the stalk is invisible
  // through the middle third of the plant. Density, again, is the read — and
  // the triangles come back out of the segment count, because a 0.7 m blade
  // seen from 10 m is nine pixels long and does not need five rings.
  const BL = 0.027;                          // blade length as a fraction of height
  for (let j = 1; j < RINGS - 1; j++) {
    const A = axis[j];
    const pairs = j > RINGS - 7 ? 9 : 7;
    for (let q = 0; q < pairs; q++) {
      // 0.9 rad of azimuth jitter, not 0.35: at 0.35 a whorl of seven blades is
      // still visibly a regular seven-pointed star, and a column of regular
      // stars is a machined part. Real whorls clump.
      const ang = j * GOLD + q * (TAU / pairs) + rng() * 0.9;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const len = BL * (0.82 + 0.52 * rng());
      const rise = 0.30 + 0.26 * rng();      // how much it climbs on the way out
      // curl > rise, always, and by a lot: the tip has to end well BELOW where
      // the blade left the stalk, so the blade hangs back along the column
      // instead of standing off it. That inequality is the difference between a
      // claw and a spine, and combined with the shorter radial reach below it is
      // what turns a thistle into the reference's bottle brush.
      const curl = rise + 0.92 + 0.62 * rng();
      const hook = (rng() < 0.5 ? -1 : 1) * (0.44 + 0.42 * rng());
      const prt = rng();
      const rows = [];
      const S = 3;
      for (let s = 0; s <= S; s++) {
        const u = s / S;
        const rad = A.r * 0.6 + len * u * (1.0 - 0.36 * u * u);   // it curls back in
        const y = A.t + len * (rise * Math.pow(u, 0.62) - curl * u * u * u) - 0.0025;
        // the sweep is cubic in u, so the barb leaves the stalk almost radially
        // and does nearly all of its turning in the last third — a hook, where a
        // quadratic sweep is a banana
        const swp = len * hook * u * u * (0.45 + 0.55 * u);
        rows.push({
          c: [A.x + ca * rad - sa * swp, y, A.z + sa * rad + ca * swp],
          s: [-sa, 0, ca],
          // a thorn-blade: narrow, widest a third of the way out, drawn to a
          // point. 0.058 of length as a half-width is a ~9:1 barb, which is the
          // reference proportion. The notch harmonic makes the outline TOOTHED,
          // which is what the reference blades are and which is the cheapest
          // fine-octave silhouette energy in the module: the kelp plate measured
          // 13.1 % in the finest band against the reference's 16.2, and on an
          // object whose whole identity is being black against bright water,
          // fine energy can only come from more edge per pixel.
          // 0.095, not 0.058: a 10:1 blade is a spine and reads as a needle, and
          // the capture duly came back looking like a thistle. Measured off
          // kelp-forest-4 at matched apparent scale the reference frond is about
          // 5:1, which is also what the midrib needs to read as a fold rather
          // than as a drawn line.
          w: len * 0.095 * Math.sin(Math.pow(u, 0.50) * Math.PI)
             * (1.0 - 0.34 * Math.abs(Math.sin(u * 7.0 + prt * 5.0))) + 0.0004,
          // the midrib is deepest at the base and flattens toward the tip, the
          // way a real pinna's keel does
          rib: 0.72 - 0.34 * u,
          sw: Math.pow(A.t, 1.5),
          fw: 0.18 + 0.55 * u,               // the tip flutters, the base does not
          gl: 0, sh: 0.28 + 0.50 * clamp01(A.t * 1.4 + u * 0.3), prt,
        });
      }
      B.blade(rows);
    }
  }

  // ---- the crown. Every reference vine ends in a distinct bushy HEAD two or
  // three metres across, not in a gradual taper — it is the single feature that
  // tells you where the top of a 30 m plant is when the stalk itself is only
  // 0.4 m wide, and it is where the pods hang.
  //
  // 22 SHORT straps, not 14 long ones. Round seven's first pass halved the barb
  // width correctly and left the crown alone, and the capture showed why that is
  // half a fix: a dozen 2-3 m straps radiating from one point is a bare tree,
  // where every crown in kelp-forest-1 and -4 is a dense shaggy HEAD of many
  // shorter curled straps you cannot count. Density is the read, not length.
  // Round eight narrows them further and spreads their roots over the top 12%
  // of the stalk instead of one point: a crown whose straps all radiate from a
  // single node is a starburst, and the isolated render read exactly that way.
  for (let k = 0; k < 32; k++) {
    const t0 = 0.870 + rng() * 0.122;
    const A = { t: t0, x: lerp(axis[RINGS - 2].x, axis[RINGS - 1].x, 0.5), z: lerp(axis[RINGS - 2].z, axis[RINGS - 1].z, 0.5), r: R0 * 0.9 };
    const ang = k * GOLD + rng() * 0.4;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const len = BL * (0.90 + 0.86 * rng());
    const rise = 0.40 + 0.50 * rng();
    const curl = rise + 0.70 + 0.72 * rng();
    const hook = (rng() < 0.5 ? -1 : 1) * (0.50 + 0.46 * rng());
    const prt = rng();
    const rows = [];
    const S = 3;
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const rad = A.r * 0.6 + len * u * (1.0 - 0.20 * u * u);
      const y = A.t + len * (rise * Math.pow(u, 0.62) - curl * u * u * u);
      const swp = len * hook * u * u;
      rows.push({
        c: [A.x + ca * rad - sa * swp, y, A.z + sa * rad + ca * swp],
        s: [-sa, 0, ca],
        w: len * 0.062 * Math.sin(Math.pow(u, 0.55) * Math.PI) + 0.0005,
        rib: 0.70 - 0.30 * u,
        sw: Math.pow(A.t, 1.5),
        fw: 0.24 + 0.62 * u,
        gl: 0, sh: 0.34 + 0.52 * clamp01(0.9 + u * 0.3), prt,
      });
    }
    B.blade(rows);
  }

  // ---- holdfast: short roots splayed over the sand. AGENT_BRIEF §4 rejects
  // "geometry that meets the sand at a hard intersection line" and a 25 m pole
  // rising out of a flat floor is the purest form of that. Real kelp anchors
  // with a knot of roots and this is what hides the seam.
  for (let k = 0; k < 7; k++) {
    const ang = k * GOLD + rng() * 0.5;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const len = 0.014 + rng() * 0.016;
    const prt = rng();
    const rows = [];
    for (let s = 0; s <= 3; s++) {
      const u = s / 3;
      rows.push({
        c: [ca * len * u * 1.7, 0.016 * (1 - u) * (1 - u) - 0.003, sa * len * u * 1.7],
        s: [-sa, 0, ca],
        w: len * 0.30 * (1 - u * 0.85) + 0.0007,
        sw: 0, fw: 0, gl: 0, sh: 0.12 + 0.16 * (1 - u), prt,
      });
    }
    B.strip(rows);
  }

  // ---- SEED PODS. LOOK.md §8 puts them at ~0.4 m each in clusters of 5-10 and
  // calls them "the only warm colour in a green frame". The blind trial called
  // ours "blown-out white hexagons with a red bloom fringe". Three separate
  // things were wrong and all three are geometry or spacing, not shading:
  //
  //   SILHOUETTE. A 5-segment lathe is a PENTAGON. At the 150-250 px a near
  //   cluster covers, its facets are 40 px of straight edge each and it reads as
  //   cut card. 12 segments puts the worst radial error at 0.9% of the pod's
  //   radius, i.e. under two pixels at point-blank range, and the whole cluster
  //   costs 1200 triangles on a plant that already carries 2000.
  //
  //   SHAPE. sin(pi*u) is an ellipsoid — symmetric, and symmetric reads as a
  //   ball bearing. Every pod in the reference crop is a TEARDROP: pinched where
  //   its stem attaches at the top, fattest below the middle, round at the free
  //   end. The (0.55 + 0.45u) term is that asymmetry and it is what makes them
  //   read as fruit hanging rather than as spheres floating.
  //
  //   SPACING. The old cluster spread 0.57 m and the pods were 0.4 m across, so
  //   they fused into one blob and the blob is what clipped. In the reference
  //   you can see dark stalk and dark blades BETWEEN every pair of berries —
  //   that separation is most of why the cluster reads as discrete objects. The
  //   spread is now up to ~1.0 m radius on a 30 m vine, and the pods are a
  //   little smaller, so the gaps survive.
  //
  // The two NODE HEIGHTS are the other load-bearing part. Round three hung them
  // at 0.30 and 0.58 of the stalk, which on an 8 m-deep canopy puts every
  // cluster 7-14 m BELOW eye level and behind the understorey: measured against
  // kelp-forest-1.jpg the frame came back with a red channel of literally zero.
  // In the reference every cluster hangs INSIDE or just under a crown.
  //
  // ROUND EIGHT. The capture still showed five or six PALE CREAM eggs, not a
  // dozen amber berries: measured, the pod body was clipping every channel, so
  // only the mottle-darkened parts carried any hue at all and the read was
  // "blown-out" for the third round running. Three numbers move together here,
  // and none of them is the emissive colour, which was already solved for the
  // medium:
  //
  //   COUNT. 8-12 in the upper cluster and 4-6 in the lower, against 5-7 and
  //   3-5. kelp-forest-4.jpg's cluster has twelve berries you can individually
  //   count. Five large ones is a different object.
  //   SIZE. 0.21-0.33 m across on a 30 m vine, not 0.28-0.44. The reference
  //   berries are small against the 0.4 m stalk, and small berries leave the
  //   dark gaps that make a cluster read as a cluster.
  //   BRIGHTNESS. gi 2.4 -> 1.5, with a much harder limb (see FLORA_FRAG).
  //   Nine-tenths of the clipped area was the flat middle of each berry, and
  //   clipped area is the tell the blind trial keeps naming.
  const PSEG = 10, PROWS = 4;
  for (const node of [0.68, 0.89]) {
    const nAx = axis[Math.round(node * (RINGS - 1))];
    // the upper cluster is the big one, as it is in every reference frame:
    // the pods hang just under the crown and thin out down the stalk
    const n = (node > 0.8 ? 8 : 4) + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) {
      const ang = k * GOLD + rng() * 0.4;
      const rad = 0.007 + 0.023 * Math.sqrt(rng());
      const cx = nAx.x + Math.cos(ang) * rad;
      const cz = nAx.z + Math.sin(ang) * rad;
      const cy = node + (rng() - 0.5) * 0.052;
      const pr = 0.0035 + rng() * 0.0020;   // ~0.21-0.33 m across on a 30 m vine
      const len = pr * (2.05 + rng() * 0.55);
      const sw = Math.pow(node, 1.5);
      // prt is the pod's identity: FLORA_FRAG spreads brightness across the
      // cluster with it, so one or two berries approach the clip point and the
      // rest sit well under it, exactly as the reference cluster does.
      const prt = rng();
      const prof2 = [];
      for (let s = 0; s <= PROWS; s++) {
        const u = s / PROWS;
        prof2.push({
          y: cy + len * (0.42 - u), cx, cz,
          r: pr * Math.pow(Math.sin(u * Math.PI), 0.60) * (0.55 + 0.45 * u) + 1e-5,
          sw, sh: 1.0,
          // the emission is not even over the berry either: the fat free end is
          // the brightest part of every pod in the reference cluster and the
          // pinched stem end is nearly dark, which is most of what stops a
          // dozen of them merging into one lamp
          gl: 0.46 + 0.54 * Math.pow(u, 0.8),
        });
      }
      B.lathe(prof2, PSEG, 1, prt, false);
    }
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// grass tuft
// ---------------------------------------------------------------------------
/**
 * ROUND 33 — this archetype is the one a blind trial decided the shallows-floor
 * pair on: "uniform flat two-triangle cards, several rendering pure black".
 * Both halves of that were literally true of the source, and the reason is in
 * the comment this replaces: grass is the largest population in the module
 * (15000 clumps, the pool cap, saturated in all three shots measured this
 * round), so every earlier round spent its triangle budget elsewhere and left
 * this the ONLY foliage archetype still built out of `strip()` — a two-vertex
 * ribbon — and the only ground-rooted archetype in the file with no `foot()`.
 * Every other builder here was moved to `blade()` and given a foot in rounds
 * seven and eight. Grass was skipped, for the budget, twice.
 *
 * What that cost, read off a 3x crop of shots/flora-r33-before/shallows-floor:
 *
 *   CARD        a two-vertex ribbon has one interpolated normal across its whole
 *               width, so a blade is one flat tone with one linear gradient. Its
 *               silhouette is a dead-straight taper to a needle point, which is
 *               exactly what "two triangles seen edge-on" looks like.
 *   BLACK       a near-vertical ribbon has a horizontal normal, so ndl is ~0 and
 *               dot(N, sun) can be negative; wrap collapses to about 0.13 and
 *               the blade lands on the in-scatter floor — measured rgb(10,39,28)
 *               at pixel 1712,410 with lit sand at rgb(60,120,90) beside it.
 *               With one normal per blade there is nothing on it to catch light.
 *   STRAIGHT    three segments over an arc quadratic in u is three straight
 *               chords. At 6 m the blade IS a plank.
 *   FLOATING    24 blades converging on one point at y = 0 with no base mass
 *               ends the tuft in a blunt stub standing clear of the sand.
 *
 * So: `blade()` (midrib plus two flanks folded back off the chord, four
 * triangles a segment instead of two), a real 3D centreline, a per-blade TWIST,
 * a strap width profile, staggered blade origins, and a `foot()`.
 *
 * The twist is the term that answers "vary their orientation so a fraction
 * always catch the light" at the level where it helps. Rotating the tuft does
 * not help: every blade in it rotates together. Rotating each blade about its
 * OWN axis as it rises sweeps its two flank normals through most of a right
 * angle of azimuth over its length, so on any blade, from any camera, some band
 * of it faces the sun. Real seagrass blades twist for the same reason.
 *
 * Sizes are LOOK.md section 8: "Grass / blood grass mats, 0.3-1 m, dense red,
 * magenta or green carpets covering whole plateaus". A carpet, not a stand of
 * yuccas — hence the height cap and the tightened clump spread in SPECIES.
 */
function buildGrass(seed, spiky, lod) {
  const rng = makeRNG(seed);
  const B = new Build();
  // Ten long blades and eight short inner ones, against a flat 24. Fewer,
  // better blades: a ribbed blade carries a value gradient ACROSS its own width
  // and a crease down its length, so it reads as more plant than two flat ones
  // do, and shallows-floor-2 shows ground cover as a dense low bush with a
  // solid middle rather than a spider of long spikes.
  //
  // `lod` builds the FAR variant of the same tuft: the same ten blades on the
  // same centrelines and the same silhouette, but two segments instead of four,
  // half the inner tier and no foot — 96 triangles against 224. This is what
  // pays for the coverage. Grass returned exactly 15000 (the cap) on all three
  // shots before this round, so the turf radius has always been limited by the
  // instance budget, and 224-triangle tufts spent at 40 m on a plant 20 pixels
  // tall is where that budget was going. See ARCHETYPES.grassfar.
  const NL = spiky ? 11 : 10;
  const NS = lod ? (spiky ? 3 : 4) : (spiky ? 6 : 8);

  /**
   * One blade. `long` picks the outer arcing tier; the short tier is the dense
   * upright middle that stops the tuft reading as a starfish from above.
   *
   * The centreline is built first, in 3D, and the frame is derived from it:
   * tangent by central difference (what blade() itself uses), side vector by
   * projecting the tuft tangential direction perpendicular to that tangent and
   * then rotating it about the tangent by the twist angle — Rodrigues, which
   * reduces to s*cos + (T x s)*sin because s is already perpendicular to T.
   */
  const addBlade = (k, long) => {
    const ang = k * GOLD + rng() * 0.55;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // outward and tangential unit vectors of the tuft at this azimuth
    const ex = ca, ez = sa, tx = -sa, tz = ca;
    const lean = long ? (spiky ? 0.09 + rng() * 0.15 : 0.15 + rng() * 0.30)
      : (spiky ? 0.04 + rng() * 0.07 : 0.06 + rng() * 0.13);
    const h = long ? ((spiky ? 0.70 : 0.54) + rng() * 0.44)
      : ((spiky ? 0.26 : 0.20) + rng() * 0.20);
    const wide = (spiky ? 0.020 : 0.030) * (0.72 + rng() * 0.66) * (long ? 1 : 0.85);
    const droop = long ? (spiky ? 0.05 : 0.17 + rng() * 0.26) : 0.05 + rng() * 0.10;
    // sideways bow, signed per blade: without it every centreline lies in the
    // plane containing the tuft axis and its own azimuth, and a set of coplanar
    // arcs radiating from one point IS a starfish however well each one shades
    const bow = (rng() < 0.5 ? -1 : 1) * (long ? 0.06 + rng() * 0.20 : 0.03 + rng() * 0.08);
    const twist = (rng() - 0.5) * (spiky ? 0.9 : 1.9);
    const prt = rng();
    // staggered origin: a tuft is a sheaf of blades leaving the sediment over a
    // few centimetres, not 20 blades sharing one vertex
    const r0 = (long ? 0.016 : 0.008) + rng() * (long ? 0.040 : 0.022);
    const ox = ex * r0, oz = ez * r0, oy = -0.012 - rng() * 0.030;

    const S = lod ? (long ? 2 : 1) : (long ? 4 : 2);
    const cs = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      // u^1.55, not u^2: the blade leaves the sheath vertical and turns outward
      // over its upper half, which is what kelp-forest-3 tufts do.
      const rad = lean * h * Math.pow(u, 1.55);
      const bw = bow * h * u * u;
      cs.push([
        ox + ex * rad + tx * bw + (rng() - 0.5) * 0.004,
        oy + h * u - droop * h * u * u * u,
        oz + ez * rad + tz * bw + (rng() - 0.5) * 0.004,
      ]);
    }
    const rows = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const A = cs[Math.max(0, s - 1)], C = cs[Math.min(S, s + 1)];
      let Tx = C[0] - A[0], Ty = C[1] - A[1], Tz = C[2] - A[2];
      const tl = Math.hypot(Tx, Ty, Tz) || 1;
      Tx /= tl; Ty /= tl; Tz /= tl;
      // side = the tuft tangential direction with the tangent component removed,
      // so the cross-section stays square to the blade as it arcs
      let sx = tx, sy = 0, sz = tz;
      const d = sx * Tx + sy * Ty + sz * Tz;
      sx -= d * Tx; sy -= d * Ty; sz -= d * Tz;
      let sl = Math.hypot(sx, sy, sz);
      if (sl < 1e-4) { sx = ex; sy = 0; sz = ez; sl = 1; }   // blade runs along t
      sx /= sl; sy /= sl; sz /= sl;
      // and now rotate it about the blade own axis
      const th = twist * u;
      const cth = Math.cos(th), sth = Math.sin(th);
      const bx = Ty * sz - Tz * sy, by = Tz * sx - Tx * sz, bz = Tx * sy - Ty * sx;
      const wx = sx * cth + bx * sth, wy = sy * cth + by * sth, wz = sz * cth + bz * sth;
      // STRAP, not needle. A seagrass blade holds near its full width for most
      // of its length and tapers over the last third; w * (1 - u*u * 0.96) is a
      // triangle, and a triangle is what a card looks like. The basal ramp is
      // the sheath the blade emerges from.
      const wProf = Math.min(1, 0.42 + u * 5.0) * (1 - Math.pow(u, 2.8) * 0.93);
      rows.push({
        c: cs[s],
        s: [wx, wy, wz],
        w: wide * wProf + 0.0007,
        // the midrib stands proud through the middle and flattens at both ends,
        // which is where a real leaf keel actually goes
        rib: 0.22 + 0.46 * Math.sin(Math.PI * Math.min(1, u * 1.05)),
        sw: Math.pow(u, 1.35),
        fw: 0.25 * u,
        // glowing species light their tips only — a whole glowing tuft is the
        // "uniform emissive surface" LOOK.md §11.27 rules out. A blade that
        // glows over its top third is a strip light; the shallows-floor frame
        // came back with a ghost weed reading as one solid white fan because 24
        // blades x a third of their length is an area source, not a cluster.
        gl: spiky ? Math.pow(u, 3.4) : Math.pow(u, 5.0) * 0.85,
        sh: 0.28 + 0.72 * u, prt,
      });
    }
    B.blade(rows);
  };

  for (let k = 0; k < NL; k++) addBlade(k, true);
  for (let k = 0; k < NS; k++) addBlade(k + 0.5, false);
  // and the sediment collar. Grass has no calcareous holdfast, but it does sit
  // in a low mound of the silt its own rhizomes trap, and that mound is what
  // turns the hard sand line into a curve. Small — 5 cm of a unit tuft, so 5 cm
  // on a 1 m plant — and ribbed, so the emergence is not a circle either. The
  // far variant drops it: at the 16 m switch it is under two pixels across.
  if (!lod) B.foot(0, 0, 0.050, 2.4, 6, rng(), 0.052);
  return B.geo();
}

// ---------------------------------------------------------------------------
// coral tube bouquet
// ---------------------------------------------------------------------------
/**
 * LOOK.md §8: "hollow trumpets, flaring at the mouth, cream/pink, in clusters".
 * The brief asks for fat organic bouquets, so this is 5-7 tubes leaning out of
 * one holdfast at different heights, each with a real hollow mouth — an inner
 * wall folded back down inside the rim. The hollow is what stops them reading
 * as painted cones: you can see darkness inside the near ones.
 *
 * ROUND SEVEN — this archetype is one of the two the blind trial decided on:
 * "giant flat olive polygon fins mid-frame intersecting the ground as untextured
 * cards". Every word of that is a separate, fixable property:
 *
 *   FLAT      the flare was pow(u, 2.6) over 8 rows, so rows 7 and 8 carried
 *             the entire mouth and the wall between them was one long planar
 *             band metres across. 12 rows with a pow(u, 2.1) opening plus a
 *             recurve spreads the curvature over the whole upper half, so there
 *             is nowhere left that is planar.
 *   POLYGON   a 14-segment circular rim seen edge-on IS a polygon, and its
 *             silhouette is a straight line. 18 segments plus a frilled rim
 *             (ywob) makes the outline a wave instead of a chord.
 *   OLIVE / UNTEXTURED  one prt for the whole tube meant vCol was a single
 *             constant over three square metres of surface. prt now runs along
 *             the meridian, and the fragment microstructure does the rest.
 *   INTERSECTING THE GROUND   there was nothing at the base at all. foot().
 */
function buildTube(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  // 4-6 tubes, not 5-7. The new mouth costs more triangles per tube than the
  // old one did and a cluster reads as a cluster at four.
  const n = 4 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const ang = k * GOLD + rng() * 0.6;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const h = (k === 0 ? 1.0 : 0.42 + rng() * 0.52);
    const lean = 0.10 + rng() * 0.30;
    const base = 0.055 + rng() * 0.030;
    const mouth = base * (1.9 + rng() * 1.05);
    const off = k === 0 ? 0 : 0.05 + rng() * 0.13;
    const prt = rng();
    const ribN = 6 + Math.floor(rng() * 6), ribPh = rng() * TAU;
    const rib2 = 2 + Math.floor(rng() * 3), rib2Ph = rng() * TAU;
    // the frill: how far the rim rises and falls around its own circumference,
    // and on how many lobes. Small — 8-16% of the mouth radius — because a rim
    // that waves more than that stops reading as a coral and starts reading as a
    // torn paper cup.
    const frill = mouth * (0.10 + rng() * 0.10);
    const SEG = 16, S = 10;
    const radAt = (u) => lerp(base, mouth, Math.pow(u, 2.1)) * (1 + 0.10 * Math.sin(u * 5.1 + prt * 6.0));
    const prof = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      // a trumpet, but the last 15% RECURVES: the lip rolls back outward and
      // slightly down, which is the single silhouette feature that separates a
      // living coral mouth from a funnel primitive
      const roll = clamp01((u - 0.86) / 0.14);
      const r = radAt(u) * (1 + 0.16 * roll);
      const y = h * (u - 0.055 * roll * roll);
      prof.push({
        y, r,
        cx: ca * (off + lean * h * u * u), cz: sa * (off + lean * h * u * u),
        // fluting builds toward the mouth, like a real trumpet coral's ribs, and
        // carries a second much lower harmonic so the section is not a rosette
        rib: [0.070 + 0.135 * u, ribN, ribPh],
        ywob: u > 0.55 ? [frill * Math.pow((u - 0.55) / 0.45, 2.0), rib2, rib2Ph] : null,
        // prt walks the meridian, so the tube is not one flat colour end to end
        prt: (prt + u * 0.63 + 0.17 * Math.sin(u * 9.3 + prt * 5.0)) % 1,
        sw: Math.pow(u, 1.6) * 0.7, sh: 0.32 + 0.62 * u,
      });
    }
    B.lathe(prof, SEG, 0, prt, false);
    // the inner wall, dark, folded back down the throat
    const inner = [];
    for (let s = S; s >= 5; s--) {
      const u = s / S;
      const roll = clamp01((u - 0.86) / 0.14);
      const r = radAt(u) * (s === S ? (1 + 0.16 * roll) * 0.95 : 0.66);
      inner.push({
        y: h * (u - 0.055 * roll * roll) - (s === S ? 0 : 0.028), r,
        cx: ca * (off + lean * h * u * u), cz: sa * (off + lean * h * u * u),
        rib: [0.070 + 0.135 * u, ribN, ribPh],
        ywob: s === S ? [frill, rib2, rib2Ph] : null,
        prt: (prt + u * 0.41) % 1,
        sw: Math.pow(u, 1.6) * 0.7, sh: 0.07 + 0.13 * u,
      });
    }
    B.lathe(inner, SEG, 0, prt, false);
    if (k === 0 || off < 0.10) B.foot(ca * off, sa * off, base, 2.3, 10, prt, 0.078);
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// brain coral
// ---------------------------------------------------------------------------
/** A folded mass, authored at DIAMETER 1.0: meandering grooves over a dome. */
function buildBrain(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  // The grooves have to be DEEP. Round one used a 8.5% radial modulation and a
  // 4 m brain coral at arm's length rendered as a smooth grey potato; a real
  // brain coral's meanders are a fifth of its radius and it is entirely those
  // ridges that identify it. LON is up to 30 because a 20% modulation at 18
  // segments aliases into a polygon.
  const LAT = 11, LON = 30;
  const ph1 = rng() * TAU, ph2 = rng() * TAU, ph3 = rng() * TAU;
  const rows = [];
  for (let j = 0; j <= LAT; j++) {
    const v = j / LAT;
    const th = v * Math.PI * 0.52;              // a squat dome, not a hemisphere
    const row = [];
    for (let k = 0; k < LON; k++) {
      const ang = (k / LON) * TAU;
      // the "brain": interfering sinusoids in (azimuth, elevation) whose sum's
      // ridges wander instead of forming a grid
      const g = Math.sin(ang * 5 + th * 9 + ph1) * Math.sin(ang * 2.3 - th * 11 + ph2)
              + 0.55 * Math.sin(ang * 9 - th * 5 + ph3);
      const rr = 0.5 * (1 + 0.17 * g) * Math.sin(th + 0.06);
      const y = 0.55 * (1 + 0.15 * g) * Math.cos(th * 0.92) - 0.02;
      // the groove walls are near-vertical, so the normal has to be dominated by
      // the modulation's own slope rather than by the underlying dome
      row.push(B.v(Math.cos(ang) * rr, y, Math.sin(ang) * rr,
        Math.cos(ang) * (Math.sin(th) + g * 0.85),
        Math.cos(th) * 0.75,
        Math.sin(ang) * (Math.sin(th) + g * 0.85),
        0, 0, 0, clamp(0.22 + 0.62 * clamp01(Math.cos(th)) + 0.24 * g, 0.10, 1.0), 0, k / LON));
    }
    rows.push(row);
  }
  for (let j = 0; j < LAT; j++) {
    for (let k = 0; k < LON; k++) {
      const k2 = (k + 1) % LON;
      B.quad(rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]);
    }
  }
  // The dome's last latitude sits at y ~ 0.04 with radius 0.5, i.e. a 3 m brain
  // coral was a ball cut off by a perfectly circular line in the sand. A wide
  // shallow skirt turns that line into a curve and buries its rim.
  B.foot(0, 0, 0.48, 1.30, 14, rng(), 0.078);
  return B.geo();
}

// ---------------------------------------------------------------------------
// table coral
// ---------------------------------------------------------------------------
/** LOOK.md §8: "flat discs", 5-15 m across. Authored at DIAMETER 1.0. */
function buildTable(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const tiers = 2 + Math.floor(rng() * 2);
  const st = [];
  for (let s = 0; s <= 4; s++) {
    const u = s / 4;
    st.push({ y: u * 0.20, r: lerp(0.085, 0.045, u), sw: 0, sh: 0.28 + 0.3 * u });
  }
  B.lathe(st, 8, 0, 0, false);
  B.foot(0, 0, 0.085, 2.2, 10, rng(), 0.056);

  for (let t = 0; t < tiers; t++) {
    const y = 0.13 + t * (0.13 + rng() * 0.07);
    const rad = 0.5 * (1 - t * (0.24 + rng() * 0.14));
    const thick = 0.020 + rng() * 0.014;
    const wob = rng() * TAU;
    const SEG = 22;
    const top = [], bot = [], rim = [];
    const cen = B.v(0, y + thick, 0, 0, 1, 0, 0, 0, 0, 0.95, 0, 0);
    for (let k = 0; k < SEG; k++) {
      const ang = (k / SEG) * TAU;
      // a scalloped, slightly cupped plate — a perfect circle reads as a poker chip
      const rr = rad * (1 + 0.10 * Math.sin(ang * 5 + wob) + 0.05 * Math.sin(ang * 11 - wob));
      const dy = -0.045 * rad * Math.cos(ang * 3 + wob);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const prt = k / SEG;
      top.push(B.v(ca * rr, y + thick + dy, sa * rr, ca * 0.18, 1, sa * 0.18, 0.35, 0.35, 0, 0.82, 0, prt));
      bot.push(B.v(ca * rr, y + dy, sa * rr, ca * 0.18, -1, sa * 0.18, 0.35, 0.35, 0, 0.22, 0, prt));
      rim.push(B.v(ca * rr * 1.005, y + thick * 0.5 + dy, sa * rr * 1.005, ca, 0, sa, 0.35, 0.35, 0, 0.52, 0, prt));
    }
    for (let k = 0; k < SEG; k++) {
      const k2 = (k + 1) % SEG;
      B.tri(cen, top[k], top[k2]);
      B.quad(top[k], rim[k], rim[k2], top[k2]);
      B.quad(rim[k], bot[k], bot[k2], rim[k2]);
    }
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// fan
// ---------------------------------------------------------------------------
/**
 * Scalloped membranes with a cupped, CORRUGATED face, on a short stem.
 *
 * Round six authored every vertex of a fan with the identical constant normal
 * (nx, 0.16, nz) — a literal untextured card, which is the second half of the
 * blind trial's "flat polygon" verdict and the reason a fan lit identically
 * across its whole width however it was turned. The surface is now differenced
 * numerically from its own parameterisation, so the cup, the corrugation and
 * the scalloped edge all shade, and a sea fan catches the sun along its ribs the
 * way grand-reef-1's do.
 */
function buildFan(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const blades = 2 + Math.floor(rng() * 3);
  for (let f = 0; f < blades; f++) {
    const yaw = f * (TAU / blades) + rng() * 0.7;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const h = 0.62 + rng() * 0.38;
    const wid = h * (0.55 + rng() * 0.35);
    const cup = 0.10 + rng() * 0.16;
    const prt = rng();
    const nx = -sa, nz = ca;                       // the fan's face direction
    // Radial corrugation: a fan membrane is stiffened by ribs running out from
    // the holdfast, and those ribs are what a real one reads by.
    //
    // ROUND EIGHT — the fan is the LAST of the "flat polygon fins" the blind
    // trial named, and the isolated render of the shallows-floor frame found it:
    // three 1.3 m sheets at the left edge of frame, smooth enough across their
    // whole width to read as painted card even with the numerically-differenced
    // normals round six gave them. A 0.02-0.046 corrugation on a 1.3 m membrane
    // is a 3% wobble — invisible. A real gorgonian is PLEATED: its ribs are a
    // tenth of its width deep, and its edge is cut into lobes rather than
    // scalloped by a few per cent. Both amplitudes go up by a factor of three,
    // and RIB goes to 13 so the deeper flutes are actually resolved instead of
    // aliasing into a wobbly outline.
    const ribN = 5 + Math.floor(rng() * 5), ribA = 0.058 + rng() * 0.062;
    const RIB = 13, RAD = 6;
    const edgeAt = (w) => 1 - 0.30 * Math.abs(Math.sin(w * 4.5 + prt * 6))
                            - 0.11 * Math.abs(Math.sin(w * 9.7 - prt * 4));
    // p(w, u) — the membrane as an explicit surface, so its normal can be
    // differenced instead of guessed
    const P = (w, u) => {
      const rr = u * edgeAt(w);
      const bulge = cup * rr * rr * (0.4 + 0.6 * Math.abs(w))
                  + ribA * rr * Math.sin(w * ribN * Math.PI + prt * 4.0);
      return [
        ca * (w * wid * rr * 0.9) + nx * bulge,
        0.06 + h * rr * (1 - 0.30 * w * w),
        sa * (w * wid * rr * 0.9) + nz * bulge,
      ];
    };
    const rows = [];
    for (let j = 0; j <= RAD; j++) {
      const u = j / RAD;
      const row = [];
      for (let k = 0; k <= RIB; k++) {
        const w = (k / RIB) * 2 - 1;
        const rr = u * edgeAt(w);
        const p = P(w, u);
        const e = 0.02;
        const pw = P(clamp(w + e, -1, 1), u), pu = P(w, clamp(u + e, 0, 1));
        const aw = [pw[0] - p[0], pw[1] - p[1], pw[2] - p[2]];
        const au = [pu[0] - p[0], pu[1] - p[1], pu[2] - p[2]];
        let vnx = aw[1] * au[2] - aw[2] * au[1];
        let vny = aw[2] * au[0] - aw[0] * au[2];
        let vnz = aw[0] * au[1] - aw[1] * au[0];
        // a degenerate row (u = 0, or w clamped at the edge) leaves a null
        // cross product; fall back to the face direction rather than to NaN
        if (!(vnx * vnx + vny * vny + vnz * vnz > 1e-14)) { vnx = nx; vny = 0.16; vnz = nz; }
        row.push(B.v(p[0], p[1], p[2], vnx, vny, vnz, Math.pow(rr, 1.3), 0.20 + 0.7 * rr,
          Math.pow(rr, 3.0), 0.28 + 0.68 * rr, 0,
          (prt + 0.29 * rr + 0.21 * Math.abs(w)) % 1,
          // a fan is a membrane: its free rim (u -> 1) and its two side edges
          // (|w| -> 1) are the parts light passes through
          Math.max(Math.pow(u, 3.0), Math.pow(Math.abs(w), 4.0))));
      }
      rows.push(row);
    }
    for (let j = 0; j < RAD; j++) {
      for (let k = 0; k < RIB; k++) {
        B.quad(rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]);
      }
    }
    if (f === 0) B.foot(0, 0, 0.042, 2.4, 9, prt, 0.058);
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// bulbous "melted candle" blob
// ---------------------------------------------------------------------------
/**
 * LOOK.md §7 describes the reference spires as "tapered rounded fingers ... like
 * melted candles", and the same language covers the small bulbous growths that
 * cover them. A lathe whose radius profile is a decaying stack of bulges gives
 * exactly that dripping-wax stack for the price of one surface.
 */
function buildBlob(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const lobes = 2 + Math.floor(rng() * 2);
  for (let q = 0; q < lobes; q++) {
    const ang = q * GOLD + rng() * 0.5;
    const off = q === 0 ? 0 : 0.11 + rng() * 0.16;
    const cx = Math.cos(ang) * off, cz = Math.sin(ang) * off;
    const h = q === 0 ? 1.0 : 0.42 + rng() * 0.44;
    const bulbs = 2 + Math.floor(rng() * 3);
    const fat = 0.20 + rng() * 0.13;
    const ph = rng() * TAU;
    const prof = [];
    const S = 10;
    const prt0 = rng();
    const ribN = 5 + Math.floor(rng() * 4), ribPh = rng() * TAU;
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const stack = 0.62 + 0.38 * Math.abs(Math.sin(u * bulbs * Math.PI + ph * 0.1));
      const taper = Math.pow(1 - u, 0.42) * Math.min(1, u * 7);
      prof.push({
        y: h * u, r: fat * h * stack * taper + 1e-4, cx, cz,
        // A gel sack at 3 m was an 8-gon of perfectly even colour — the exact
        // "moulded vinyl" the whole-game critic named. 11 segments kills the
        // faceted outline, a shallow warty rib gives it a section that is not a
        // circle, and prt walking the meridian gives it colour that is not one
        // number.
        rib: [0.030 + 0.045 * Math.sin(u * 3.1 + ph), ribN, ribPh + u * 1.7],
        prt: (prt0 + u * 0.71 + 0.2 * Math.sin(u * 7.7)) % 1,
        sw: Math.pow(u, 1.6) * 0.5,
        sh: 0.26 + 0.68 * u,
        // the glow lives on the upper bulbs only, so it reads as points on a
        // dark body rather than as a lit lampshade
        gl: clamp01((u - 0.60) / 0.30) * (0.42 + 0.38 * Math.sin(u * bulbs * Math.PI + ph)),
      });
    }
    B.lathe(prof, 11, 0, prt0, true);
    if (q === 0) B.foot(cx, cz, fat * h * 0.55, 2.6, 10, prt0, 0.070);
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// mushroom / jellyshroom
// ---------------------------------------------------------------------------
/** A thin stalk under a domed cap with a drooping rim and gills beneath. */
function buildShroom(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const capY = 0.66 + rng() * 0.14;
  const capR = 0.34 + rng() * 0.14;
  const lean = (rng() - 0.5) * 0.14;
  const st = [];
  for (let s = 0; s <= 6; s++) {
    const u = s / 6;
    st.push({
      y: capY * u, r: lerp(0.062, 0.030, Math.pow(u, 0.6)),
      cx: lean * u * u, cz: lean * 0.4 * u * u,
      sw: Math.pow(u, 1.5) * 0.7, sh: 0.24 + 0.5 * u,
    });
  }
  B.lathe(st, 8, 0, 0, false);
  B.foot(0, 0, 0.062, 2.5, 10, rng(), 0.066);

  const SEG = 30, RAD = 7;
  const rows = [];
  const wob = rng() * TAU;
  for (let j = 0; j <= RAD; j++) {
    const u = j / RAD;
    const row = [];
    for (let k = 0; k < SEG; k++) {
      const ang = (k / SEG) * TAU;
      // Deep radial fluting, deepening toward the rim. A smooth dome 2 m across
      // at arm's length is a plastic parasol; what makes a cap read organic is
      // that its ribs run out to a scalloped edge, so both the radius and the
      // height are modulated and the normal is tilted by the rib's own slope.
      const rib = Math.sin(ang * 7 + wob), rib2 = Math.sin(ang * 15 - wob * 1.7);
      const flute = 0.075 + 0.19 * u;
      const scal = 1 + flute * rib + flute * 0.35 * rib2;
      const rr = capR * Math.sin(u * 1.44) * scal;
      const y = capY + capR * (0.54 * Math.cos(u * 1.44) - 0.13) - 0.40 * capR * u * u * u
              + capR * flute * 0.55 * rib * u;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // tangential normal tilt from d(scal)/d(ang) — this is the whole ridge
      const tg = -(flute * 7 * Math.cos(ang * 7 + wob) + flute * 0.35 * 15 * Math.cos(ang * 15 - wob * 1.7));
      const nr = Math.sin(u * 1.44);
      row.push(B.v(lean + ca * rr, y, lean * 0.4 + sa * rr,
        ca * nr - sa * tg, Math.cos(u * 1.44) * 0.62, sa * nr + ca * tg,
        0.55, 0.15 + 0.4 * u,
        Math.pow(u, 2.6),                       // the rim is where the light sits
        clamp(0.30 + 0.58 * (1 - u * 0.5) + 0.18 * rib, 0.10, 1.0), 0,
        (k / SEG + u * 0.53 + 0.11 * rib2) % 1,
        // a cap thins to nothing at its drooping rim, which is why every real
        // mushroom edge glows against a light behind it
        Math.pow(u, 3.5)));
    }
    rows.push(row);
  }
  for (let j = 0; j < RAD; j++) {
    for (let k = 0; k < SEG; k++) {
      const k2 = (k + 1) % SEG;
      B.quad(rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]);
    }
  }
  // gills: a darker under-plate so the cap is not a paper-thin shell edge-on
  const hub = B.v(lean, capY + capR * 0.30, lean * 0.4, 0, -1, 0, 0.55, 0, 0.15, 0.13, 0, 0);
  const under = rows[RAD - 1];
  for (let k = 0; k < SEG; k++) B.tri(hub, under[(k + 1) % SEG], under[k]);
  return B.geo();
}

// ---------------------------------------------------------------------------
// koosh sphere
// ---------------------------------------------------------------------------
/**
 * LOOK.md §8: "blue-violet balls studded with cyan glow points on a short
 * trunk". The glow points must be DISCRETE (§11.27), so they are the tips of
 * ~46 short spikes whose emissive mask only reaches 1.0 at the very end — a
 * uniformly emissive ball is the exact failure that section names.
 */
function buildSphere(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const R = 0.42, CY = 0.52;
  const trunk = [];
  for (let s = 0; s <= 4; s++) {
    const u = s / 4;
    trunk.push({ y: u * CY, r: lerp(0.075, 0.042, u), sw: u * 0.4, sh: 0.22 + 0.34 * u });
  }
  B.lathe(trunk, 8, 0, 0, false);
  B.foot(0, 0, 0.075, 2.3, 10, rng(), 0.072);

  const LAT = 8, LON = 14;
  const rows = [];
  for (let j = 0; j <= LAT; j++) {
    const th = (j / LAT) * Math.PI;
    const row = [];
    for (let k = 0; k < LON; k++) {
      const ang = (k / LON) * TAU;
      const lump = 1 + 0.06 * Math.sin(ang * 3 + th * 5);
      const sx = Math.sin(th) * Math.cos(ang), sy = Math.cos(th), sz = Math.sin(th) * Math.sin(ang);
      row.push(B.v(sx * R * lump, CY + R + sy * R * lump, sz * R * lump, sx, sy, sz,
        0.75, 0.05, 0, 0.28 + 0.5 * (sy * 0.5 + 0.5), 0, k / LON));
    }
    rows.push(row);
  }
  for (let j = 0; j < LAT; j++) {
    for (let k = 0; k < LON; k++) {
      const k2 = (k + 1) % LON;
      B.quad(rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]);
    }
  }
  const N = 46;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * i + 1) / N;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const ang = i * GOLD;
    const sx = rr * Math.cos(ang), sz = rr * Math.sin(ang);
    const bx = sx * R, by = CY + R + y * R, bz = sz * R;
    const len = 0.055 + rng() * 0.055;
    const tipx = bx + sx * len, tipy = by + y * len, tipz = bz + sz * len;
    const ux = -Math.sin(ang), uz = Math.cos(ang);
    const w = 0.012 + rng() * 0.008;
    const a = B.v(bx + ux * w, by, bz + uz * w, sx, y, sz, 0.8, 0.2, 0.0, 0.5, 0, i / N);
    const b = B.v(bx - ux * w, by, bz - uz * w, sx, y, sz, 0.8, 0.2, 0.0, 0.5, 0, i / N);
    const c = B.v(tipx, tipy, tipz, sx, y, sz, 0.9, 0.5, 1.0, 1.0, 0, i / N);
    B.tri(a, b, c);
    const d = B.v(bx, by + w, bz, sx, y, sz, 0.8, 0.2, 0.05, 0.5, 0, i / N);
    const e = B.v(bx, by - w, bz, sx, y, sz, 0.8, 0.2, 0.05, 0.5, 0, i / N);
    B.tri(d, e, c);
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// palm / crown
// ---------------------------------------------------------------------------
/**
 * A slim stalk crowned with drooping fronds — blue palm, sea crown, spike plant.
 *
 * ROUND EIGHT — this is the archetype the blind trial called "giant flat olive
 * polygon fins mid-frame intersecting the ground as untextured cards", and the
 * isolated flora render of the seamoth frame confirmed it exactly: 6-9 straps
 * radiating from one point, each of them 1.5 m across on a 4 m plant, every
 * vertex of a strap sharing one interpolated normal, and every plant in the
 * field the identical starburst.
 *
 * Four changes, in the order they matter:
 *
 *   WIDTH. A half-width of 0.10-0.19 of the unit box against a length of
 *   0.34-0.60 is a 2.6:1 leaf — a fin. 0.045-0.085 is 6:1, which is what
 *   seamoth-1.jpg's reef growth and grand-reef-1's crowns actually are.
 *   COUNT. 11-17 fronds, not 6-9. Halving the width and holding the count
 *   would just make the plant sparse; the read is a full crown of narrow
 *   leaves, and it costs the same triangles as the fins did.
 *   SECTION. blade(), so each frond has a midrib and two flanks that shade
 *   apart, and edges with thickness. That is the whole "untextured card" note.
 *   SERRATION. The width carries a notch harmonic, so the outline of a frond is
 *   toothed rather than a pair of smooth arcs — free silhouette octaves.
 *
 * The crown also sits on TWO whorls at different heights with different lengths,
 * because a single ring of equal-length leaves is the starburst.
 */
function buildPalm(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const stalkH = 0.44 + rng() * 0.20;
  const bendX = (rng() - 0.5) * 0.16, bendZ = (rng() - 0.5) * 0.16;
  const ribN = 5 + Math.floor(rng() * 4), ribPh = rng() * TAU;
  const st = [];
  for (let s = 0; s <= 6; s++) {
    const u = s / 6;
    st.push({
      y: stalkH * u, r: lerp(0.048, 0.024, u),
      cx: bendX * u * u, cz: bendZ * u * u,
      rib: [0.10 + 0.06 * u, ribN, ribPh + u * 2.1],
      sw: Math.pow(u, 1.5) * 0.75, sh: 0.22 + 0.52 * u,
    });
  }
  B.lathe(st, 9, 0, 0, false);
  B.foot(0, 0, 0.048, 2.4, 9, rng(), 0.062);

  const n = 11 + Math.floor(rng() * 7);
  for (let f = 0; f < n; f++) {
    const ang = f * GOLD + rng() * 0.35;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // two whorls: the inner one shorter and steeper, the outer longer and
    // flatter, so the crown has depth instead of being one flat fan
    const inner = (f % 3) === 0;
    const len = (inner ? 0.22 : 0.34) + rng() * 0.22;
    const wide = (inner ? 0.038 : 0.048) + rng() * 0.037;
    const rise = (inner ? 0.80 : 0.36) + rng() * 0.42;
    const droop = 0.75 + rng() * 0.70;
    const notch = 4 + Math.floor(rng() * 5);
    const y0 = stalkH * (inner ? 1.0 : 0.90 - rng() * 0.10);
    const prt = rng();
    const rows = [];
    const S = 5;
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const rad = 0.02 + len * u;
      const y = y0 + len * (rise * Math.pow(u, 0.72) - droop * u * u * u);
      rows.push({
        c: [bendX + ca * rad, y, bendZ + sa * rad],
        s: [-sa, 0, ca],
        w: wide * Math.sin(Math.pow(u, 0.55) * Math.PI)
           * (1.0 - 0.30 * Math.abs(Math.sin(u * notch * Math.PI + prt * 3.0))) + 0.001,
        rib: 0.80 - 0.35 * u,
        sw: 0.72 + 0.28 * u,
        fw: 0.20 + 0.60 * u,
        gl: Math.pow(u, 4.2),          // the frond tips carry the light
        sh: 0.38 + 0.56 * u, prt,
      });
    }
    B.blade(rows);
  }
  return B.geo();
}

// ---------------------------------------------------------------------------
// shell / pebble scatter
// ---------------------------------------------------------------------------
/**
 * The smallest population in the module and the only one not on a biome table.
 * terrain.js's cobble field bottoms out at 0.14 m; below that there is nothing,
 * and shallows-floor-2.jpg has the near sand littered with shells and chips at
 * exactly that size. They cost almost nothing and they are what gives the first
 * two metres of sand a scale.
 */
function buildShell(seed) {
  const rng = makeRNG(seed);
  const B = new Build();
  const RIB = 9;
  const cen = B.v(0, 0.02, 0, 0, 1, 0, 0, 0, 0, 0.55, 0, 0);
  const ring = [];
  const open = 1.9 + rng() * 0.8;
  for (let k = 0; k <= RIB; k++) {
    const u = k / RIB;
    const ang = -open * 0.5 + u * open;
    const rr = 0.5 * (1 + 0.10 * Math.sin(u * 9));
    ring.push(B.v(Math.cos(ang) * rr, 0.02 + 0.065 * Math.sin(u * Math.PI), Math.sin(ang) * rr,
      Math.cos(ang) * 0.30, 1, Math.sin(ang) * 0.30, 0, 0, 0, 0.72 + 0.2 * Math.sin(u * 9), 0, u));
  }
  for (let k = 0; k < RIB; k++) B.tri(cen, ring[k], ring[k + 1]);
  return B.geo();
}

/**
 * cull  base cull radius in metres (scaled by the plant's own size)
 * fade  metres over which it shrinks away instead of popping
 * max   instance budget
 * cast  render into the sun's shadow map
 * surf  default surface-microstructure amplitude for everything on this
 *       geometry, overridable per species. It is a MATERIAL property, so it
 *       belongs to the archetype: calcareous growths (tube, brain, table) are
 *       pitted and blotchy, flesh (blob, sphere) is mottled, a leaf is fairly
 *       even, and the creepvine is kept low because it has to survive as a
 *       silhouette and grain is signal that competes with black.
 */
const ARCHETYPES = {
  // vine casts no shadow, and that is a measurement rather than an oversight:
  // 460 creepvines at ~1.7k tris each is 780k triangles in the shadow pass, a
  // third of the whole frame, and the only materials in the game that sample a
  // shadow map are structures.js and creatures.js — neither of which is ever
  // under a kelp stand. The customDepthMaterial below is still wired to the
  // smaller archetypes, where the cost is 200k and a wreck or a Seamoth CAN be
  // standing in the shade of a coral table. Flip this to true the day the
  // seabed itself receives shadows.
  // near 1.0, not 2.2: kelp-forest-1 is a frame you are STANDING IN, with a
  // stalk two metres off the lens. That is also the only place the medium lets
  // a silhouette exist — core's in-scattering over 10 m of kelp water already
  // contributes ~60% of the open water's radiance, so a vine at 10 m cannot
  // read darker than about 1.3:1 however black it is, while a vine at 2 m can
  // reach 8:1. Letting the stand come to the lens is half of the contrast fix.
  // canopy [0.93, 0.075]: the crown, not the holdfast. A creepvine's crown is a
  // 2-3 m shaggy head at the very top of a 30 m plant, and the r8 capture put
  // one of them a metre off the lens, filling a quarter of the frame with
  // point-blank straps — which is what made the near plant read as an agave
  // rather than as kelp. A holdfast radius cannot express that, because the
  // holdfast is thirty metres below the thing you are inside. The sphere is
  // deliberately small: the stalks still come to within a metre, which is the
  // whole reason kelp-forest-1 has a silhouette at all.
  // near 2.6, not 1.0. Round seven's argument for 1.0 was sound as far as it
  // went — the medium erases a silhouette by ten metres, so the stand has to
  // come to the lens — but a 0.8 m blade seen from one metre is a 400 px strap,
  // and the r8 capture put two of them across a quarter of the frame. The
  // reference's nearest stalk is two to four metres out and reads as a rope. At
  // 2.6 m the in-scattered path is still under a tenth of the far field's, so
  // essentially all of the contrast survives and the plant reads as a plant.
  vine:   { build: buildVine,                cull: 118, fade: 22, max: 1250, near: 2.6, nearK: 0.02, cast: false, surf: 0.80, canopy: [0.93, 0.075] },
  // ROUND 33 — max 20000, not 15000, and it is not a wish: `stats()` returns
  // grass = 15000 exactly on shallows-floor, kelp-forest AND shallows-reef, so
  // the cap has been the binding constraint on turf coverage in every shot, not
  // the density in the biome tables. With the tuft height brought inside
  // LOOK.md's 0.3-1 m band the same 15000 clumps covered a visibly smaller
  // radius (each one is smaller and `cullRadius` scales with size), and the far
  // hillside went bare — which trades one LOOK.md rule for another, since "bare
  // rock is rare, nearly every surface is covered". Paying for the radius in
  // instances rather than in oversized plants is the honest trade. The new
  // clump is 224 triangles against the old 144, so 20000 of them is 4.48M
  // against 2.16M; measured cost is in the report.
  // cull 74/64, not 60/52, and this is a correction rather than a reach.
  // `cullRadius` is `arch.cull * clamp(0.45 + size * 0.55, 0.45, 1) + size*1.6`,
  // so it scales with the plant. Bringing the tuft inside LOOK.md's height band
  // therefore ALSO shortened its draw distance, from about 62 m to about 44 m —
  // measured as grass falling off its 15000 cap to 15720 unconstrained on
  // shallows-floor, i.e. the radius, not the cap, became the limit. 74 puts the
  // radius back where it was for the new size distribution.
  //
  // THE TWO-LEVEL POOL. `lodFar` routes every instance past `lodD` metres into
  // a second pool holding the 96-triangle variant of the same tuft (see
  // buildGrass), so the near pool only ever has to hold what is inside 16 m.
  // The arithmetic is the whole reason the turf can be dense at all: at the
  // measured ~2.6 clumps/m2 the near disc is about 2100 tufts and the rest of a
  // 59 m radius is about 26000, so 2100*224 + 24000*96 = 2.8M triangles for
  // 26100 clumps, against 4.5M for 20000 with no LOD and 2.2M for the 15000
  // flat-card tufts this round started from. More cover, better plants, and
  // between the two earlier numbers on cost.
  grass:  { build: (s) => buildGrass(s, 0, 0),  cull: 74, fade: 9, max: 3400, cast: false, surf: 0.90,
            lodFar: 'grassfar', lodD: 16 },
  grassfar: { build: (s) => buildGrass(s, 0, 1), cull: 74, fade: 9, max: 24000, cast: false, surf: 0.90 },
  spike:  { build: (s) => buildGrass(s, 1, 0),  cull: 64, fade: 9, max: 1400, cast: false, surf: 0.90,
            lodFar: 'spikefar', lodD: 16 },
  spikefar: { build: (s) => buildGrass(s, 1, 1), cull: 64, fade: 9, max: 6000, cast: false, surf: 0.90 },
  tube:   { build: buildTube,                cull: 82,  fade: 12, max: 560,  near: 0.4, nearK: 0.30, cast: true, canopy: [0.62, 0.34], surf: 1.55 },
  brain:  { build: buildBrain,               cull: 86,  fade: 12, max: 340,  near: 0.3, nearK: 0.35, cast: true, canopy: [0.30, 0.55], surf: 1.50 },
  table:  { build: buildTable,               cull: 118, fade: 18, max: 260,  near: 0.6, nearK: 0.38, cast: true, canopy: [0.26, 0.56], surf: 1.45 },
  fan:    { build: buildFan,                 cull: 50,  fade: 8,  max: 2600, cast: false, canopy: [0.55, 0.62], surf: 1.10 },
  blob:   { build: buildBlob,                cull: 52,  fade: 8,  max: 2000, cast: false, canopy: [0.52, 0.42], surf: 1.35 },
  // nearK 0.28, not 0.55: a 15 m jellyshroom needed 8.9 m of clearance, which
  // culled exactly the caps the camera was standing under in the cave shot. The
  // cap itself hangs at 0.7 of the plant's height, so the lens is never inside
  // it at 4-5 m and the frame keeps its foreground domes.
  shroom: { build: buildShroom,              cull: 104, fade: 14, max: 900,  near: 0.5, nearK: 0.22, cast: true, canopy: [0.76, 0.52], surf: 1.20 },
  sphere: { build: buildSphere,              cull: 88,  fade: 12, max: 380,  near: 0.5, nearK: 0.25, cast: true, canopy: [0.94, 0.56], surf: 1.30 },
  palm:   { build: buildPalm,                cull: 72,  fade: 10, max: 1200, near: 0.4, nearK: 0.18, cast: false, canopy: [0.76, 0.66], surf: 1.00 },
  shell:  { build: buildShell,               cull: 24,  fade: 4,  max: 3400, cast: false, surf: 1.40 },
};

/** blood grass and redwort take the stiff variant of the grass tuft. */
function archOf(id) {
  const s = SPECIES[id];
  if (!s) return null;
  return (s.a === 'grass' && s.spiky) ? 'spike' : s.a;
}

// ===========================================================================
// 3. SHADERS
// ===========================================================================
/** Shared by the colour pass and the shadow-depth pass, so they cannot drift. */
const SWAY_GLSL = /* glsl */ `
attribute vec4 aFlora;      // x sway weight  y flutter weight  z glow mask  w baked AO
attribute vec3 aFlora2;     // x pod flag     y per-part random  z blade-edge weight
attribute vec3 aIPos;
attribute vec4 aIQ;
attribute vec3 aIScl;
attribute vec3 aICol;
attribute vec4 aIGlow;      // rgb colour, a intensity
attribute vec4 aIPar;       // x phase  y sway scale  z pod scale  w translucency
attribute vec3 aIPar2;      // x indirect-light acceptance ("fill")  y body glow
                            // z surface-microstructure amplitude

uniform vec4  uCurrent;     // xy flow direction (world XZ), z wave number, w omega*t
uniform vec2  uSwayAmp;     // x stalk amplitude, y frond flutter amplitude

vec3 fl_qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

/**
 * The travelling-wave bend. Returns the local-space, instance-scaled vertex.
 *
 * The phase is  omega*t - dot(worldXZ, flowDir)*k + perInstancePhase, so a gust
 * crosses the stand at omega/k m/s instead of every plant leaning at once, and
 * the per-instance term breaks up even the plants that share a wave phase.
 * The 0.42 in the bend is a DC lean: a current pushes a stand permanently
 * downstream and oscillates about that, which is why real kelp looks like it is
 * in a flow rather than in an earthquake.
 */
vec3 fl_local() {
  vec3 p = position * aIScl;
  float sw = aFlora.x;
  float hsh = fract(aIPar.x * 0.15915494 + 0.371);

  vec2 fdir = uCurrent.xy;
  vec2 fperp = vec2(-fdir.y, fdir.x);
  float ph  = uCurrent.w - dot(aIPos.xz, fdir) * uCurrent.z + aIPar.x;
  // a second, much longer and slower swell so the motion never reads as one sine
  float ph2 = uCurrent.w * 0.37 - dot(aIPos.xz, fdir) * uCurrent.z * 0.34 + aIPar.x * 0.63;
  float s1 = sin(ph);
  float s2 = sin(ph * 2.31 + hsh * 6.2831);
  float s3 = sin(ph2);
  vec2 bend = fdir * (0.42 + 0.58 * s1 + 0.20 * s3) + fperp * (0.30 * s2 + 0.22 * s3);

  float amp = uSwayAmp.x * aIPar.y * sw * aIScl.y;
  vec2 d = bend * amp;
  // arc length: a bent stalk cannot also be as tall as a straight one, and
  // without this the whole stand visibly grows as it leans
  p.y -= sw * dot(d, d) / max(2.0 * aIScl.y, 1.0);
  p.xz += d;

  // Frond flutter on its own faster clock, keyed to a per-blade random so no two
  // blades on one stalk ever move together.
  //
  // The amplitude SATURATES with plant height. A blade is a blade: the creepvine
  // barbs are ~0.9 m whatever the vine's 24-37 m, so scaling their flutter by
  // the full instance height gave a 0.62 m excursion on a 0.9 m barb and the
  // motion contact sheet came back looking like a gale rather than a current —
  // the near stand re-composed the frame every 0.3 s. Ground cover is unaffected
  // because it is well under the cap.
  p += normal * (sin(uTime * 3.05 + aFlora2.y * 41.7 + ph * 0.55)
                 * aFlora.y * uSwayAmp.y * min(aIScl.y, 3.5));

  // pods collapse onto the stalk axis on the instances that should not carry
  // them; an opaque stalk hides them and no second draw call is needed
  p.xz = mix(p.xz, vec2(0.0), aFlora2.x * (1.0 - aIPar.z));
  return p;
}
`;

const FLORA_VERT = /* glsl */ `
#include <common>
${SWAY_GLSL}
varying vec3  vCol;
varying vec4  vGlow;
varying vec3  vAux;         // x glow mask  y baked AO  z translucency
varying vec3  vAux2;        // x fill  y body glow  z surface amplitude
varying vec3  vPodPrt;      // x pod flag  y per-part random  z blade-edge weight
varying vec3  vSurfP;       // material-space sample point for the microstructure
void main() {
  vec3 p = fl_local();
  // The surface noise is sampled HERE, before the sway and before the instance
  // rotation, so the grain is nailed to the plant instead of swimming through it
  // as the current turns. position * aIScl is metres of the real plant, which is
  // what makes the texture the same physical size on a 0.6 m tuft and a 30 m
  // vine; the aIPos term only decorrelates neighbours (0.31 keeps two plants a
  // metre apart out of phase at the grain scale without stretching anything).
  vSurfP = position * aIScl + aIPos * 0.31;
  // a cheap per-part albedo break-up: a stand of identically-coloured fronds
  // reads as one repeated object however good the silhouette is
  // A wider swing than round one's 0.86-1.16. Laplacian detail RMS is dominated
  // by local value steps, and a mat of identically-coloured tufts has none
  // inside it however many tufts there are: our densest floor crop measured 3.4
  // against shallows-floor-2's 28.56.
  vCol = aICol * (0.76 + 0.50 * fract(sin(aFlora2.y * 91.7 + aIPar.x) * 4371.13));
  vGlow = aIGlow;
  vAux = vec3(aFlora.z, aFlora.w, aIPar.w);
  vAux2 = aIPar2;
  vPodPrt = aFlora2;
  vec3 objectNormal = fl_qrot(aIQ, normal);
  vec3 transformed  = fl_qrot(aIQ, p) + aIPos;
  #include <project_vertex>
}
`;

// NOTE: vUwWorldPos / vUwWorldNormal and every medium uniform are declared by
// UNDERWATER_PARS, which applyUnderwater() injects after <common> — we read
// them rather than redeclaring, exactly as world/terrain.js does.
const FLORA_FRAG = /* glsl */ `
#include <common>
uniform float uSunIntensity;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform float uCausticsOn;
uniform vec4  uSurf;        // x albedo amp  y hue amp  z bump amp  w emitter mottle
varying vec3  vCol;
varying vec4  vGlow;
varying vec3  vAux;
varying vec3  vAux2;
varying vec3  vPodPrt;
varying vec3  vSurfP;

// How much surface microstructure this fragment gets, 0..1. Set in main() and
// read by flSurfApply() below, which core's SURFACE_FRAG calls for us.
float gSfFade;

/**
 * FLAT-SPECTRUM SURFACE FIELD, anchored in METRES ON THE PLANT.
 *
 * core's sfBroadband now builds its octaves DOWNWARD from the fragment's own
 * screen footprint, which makes it exactly scale-invariant: sfBroadband(k*p) has
 * the same spectrum for every k, so this module's old "coarse" and "fine" taps
 * were the same screen-space field sampled twice, and nothing in the texture had
 * a physical size any more. For a hull plate that is fine. For a plant it is
 * not, for two reasons this module already had to solve once: a 30 m creepvine
 * and a 0.6 m grass tuft would carry identical texture, and — because the field
 * is keyed to the screen, not to the object — every blade's grain crawls as the
 * current turns.
 *
 * So flora keeps core's sfNoise, which is the actual primitive, and builds its
 * own octaves in material space at FLAT amplitude — which is the brief's
 * instruction stated precisely: equal energy per octave, no characteristic
 * frequency, no 1/f roll-off. Octaves finer than the pixel are faded out rather
 * than dropped (a dropped octave pops as you swim toward a plant), and the sum
 * is renormalised by sqrt(sum of the surviving weights squared), NOT by their
 * sum — dividing by the sum makes a distant plant with two surviving octaves
 * noisier than a near one with five, which is backwards.
 *
 *   f0    coarsest frequency, cycles per metre on the plant
 *   fpx   metres per pixel in the same space
 *   out coarse   the two coarsest octaves alone, for the relief and mottle
 *                terms, which must not be keyed to anything near pixel scale
 */
float flFbm(vec3 p, float f0, float fpx, out float coarse) {
  float fNy = 1.0 / max(fpx * 2.6, 1e-6);
  float s = 0.0, wr = 0.0, cs = 0.0, cwr = 0.0, f = f0;
  for (int i = 0; i < 6; i++) {
    float k = clamp(fNy / f, 0.0, 1.0);
    k *= k;                                  // fade in over one octave, no pop
    float v = sfNoise(p * f) * 2.0 - 1.0;
    s += v * k; wr += k * k;
    if (i < 2) { cs += v * k; cwr += k * k; }
    f *= 2.0;
  }
  coarse = cs * inversesqrt(max(cwr, 1e-4));
  return s * inversesqrt(max(wr, 1e-4));
}

/**
 * What core's SURFACE_FRAG calls instead of sfApply(), by a string substitution
 * in makeFloraMaterial(). Two corrections, both specific to things that MOVE:
 *
 *   - the sample point is the plant's own material space, not vUwWorldPos. A
 *     creepvine tip travels three metres in a gust and the grain would swim
 *     across the blade every time the current turned.
 *   - it is faded with distance and skipped entirely past the range where a
 *     plant is a silhouette, because sfApply costs three broadband evaluations
 *     and a kelp forest fills the frame with them.
 */
vec3 flSurfApply(vec3 c, vec3 p, vec3 n, out float rough) {
  rough = 0.0;
  if (gSfFade < 0.02) return c;
  vec3 s = sfApply(c, p, n, rough);
  return mix(c, s, gSfFade);
}

void main() {
  vec3 P = vUwWorldPos;
  vec3 N = normalize(vUwWorldNormal);
  vec3 V = normalize(uCamPos - P);
  // fronds are single-sided sheets: flip the normal to whichever face we see
  if (dot(N, V) < 0.0) N = -N;
  float viewDist = distance(uCamPos, P);

  // =========================================================================
  // SURFACE MICROSTRUCTURE
  // =========================================================================
  // Measured before this existed: our shallows-floor flora crops returned
  // detailRMS 8.6 and 11.1 where the matching shallows-floor-2 crops return
  // 28.0 to 32.3. Flora carried a third of the reference's surface signal and
  // none of it below the scale of a whole frond, which is the "smoothly-shaded
  // solid colour ... moulded vinyl" the whole-game critic named.
  //
  // Two taps of core's sfBroadband cover 1.2 m down to 1.3 mm continuously:
  // seven octaves each at a 1/f roll-off and a lacunarity of 2.17, so there is
  // no characteristic frequency anywhere in that range. That is the whole point
  // — the brief's instruction is to RAISE broadband content while LOWERING
  // hard-edged contrast, and a decal or a stripe would do the opposite.
  //
  // vSurfP is material space, not world space: see FLORA_VERT.
  float sA = vAux2.z;
  // The pixel footprint, in the same space the noise lives in. dFdx of vSurfP is
  // a rigid transform of the world footprint, so this is metres per pixel ON THE
  // PLANT, whatever its size or how far away it is.
  float fpx = max(length(dFdx(vSurfP)), length(dFdy(vSurfP)));

  // Six flat octaves from 67 cm down to 2.1 cm on the plant. nC is the two
  // coarsest alone — the algal blotching that a reef plant carries at the scale
  // of a whole frond, and the only band the relief term may be keyed to.
  //
  // f0 was 0.75 (a 1.33 m base) for one capture and that was measurably wrong in
  // both directions at once: the shallows-floor plate came back at
  // 23/31/38/41/38 % per octave against the reference plate's 22/24/27/32/31 —
  // right in total, but sloping 1.8:1 fine-to-coarse where the reference slopes
  // 1.4:1 — and the frame showed why, as broad light-and-dark zebra bands across
  // every mushroom cap. Starting an octave higher deletes the band that was
  // making the stripes AND adds a 4 cm octave at the other end, which is the
  // half of the spectrum both plates were short of.
  float nC;
  float nS = flFbm(vSurfP, 1.5, fpx, nC);
  // A gentle amplitude fade with distance, because past ~40 m the plant is a
  // silhouette and surface signal on it is noise competing with the medium.
  // 0.0009, not 0.0022: at the old rate a stalk 30 m out kept only a third of
  // its texture, and the reference plate's mid-distance stalks are visibly
  // textured — half the octave energy we were measured short of lives out there.
  float dFade = 1.0 / (1.0 + viewDist * viewDist * 0.0009);
  float sFar = sA * dFade;
  gSfFade = clamp(sFar * 0.85, 0.0, 1.0);

  float pd = max(0.0, uWaterLevel - P.y);
  vec3 sunT = exp(-uAbsorption * pd * 0.42);
  // renormalised so it only tilts the HUE of the downwelling light and does not
  // darken a second time — the same split terrain.js uses, and what carries
  // LOOK.md rule 2's cyan -> green-teal -> navy ramp onto the plants as well as
  // into the water.
  vec3 downT = sunT / max(max(sunT.r, sunT.g), max(sunT.b, 1e-4));

  // ---- FILL: how much NON-DIRECT light this species accepts -----------------
  // Round one gave every plant the same generous fill — a wrap-around term with
  // a 0.36 floor, hemisphere ambient, the caustic net and an albedo-independent
  // specular — and the signature creepvine came out at luminance 96.8 against
  // water at 115. Measured on the reference, kelp-forest-1's near stalk floors
  // at 0.2 with water at 194.7 in the same column. Its albedo was never the
  // problem; ours is linear 0.03 already. Everything above was arriving through
  // the paths this multiplier now closes, and only direct N.L survives at a
  // fifth strength so a sunlit crown still separates from a shaded one.
  float fill = vAux2.x;

  float ao   = vAux.y;

  // ---- the microstructure, applied ----------------------------------------
  // ALBEDO first, multiplicatively: a near-black creepvine has to stay
  // near-black (its whole species identity is being a silhouette), so grain
  // must scale what is there rather than add to it.
  //
  // The max() is not decoration. 1.0 + grain went NEGATIVE at the amplitudes
  // this shipped with first, and a negative albedo is a black pixel — which is
  // what the pepper was.
  float grain = nS * (0.30 * sFar) + nC * (0.08 * sFar);
  vec3 alb = vCol * max(1.0 + uSurf.x * grain, 0.20);
  // A small HUE break-up on top. Reef growth is patchy in pigment as well as in
  // value, and our densest floor crop measured bandGB [0.97,1.06,1.06] against
  // shallows-floor-2's [0.98,1.52,2.56] — channel separation we simply were not
  // spending. Kept small enough that LOOK.md rule 6's high saturation survives.
  alb *= vec3(1.0 - uSurf.y * 0.13 * nC,
              1.0 + uSurf.y * 0.10 * nC,
              1.0 - uSurf.y * 0.13 * nS * dFade);
  // and cavity dirt: the coarse field darkens where the baked AO says the
  // geometry already folds in on itself, which is where grime actually collects
  ao *= 1.0 - uSurf.x * 0.20 * sA * (1.0 - ao) * (0.5 - 0.5 * nC);

  // ---- RELIEF ---------------------------------------------------------------
  // The term that actually converts "painted" into "surfaced". The medium is a
  // strongly anisotropic area light, so tilting a facet changes what it collects
  // far more than tinting it does — the same reasoning creatures.js gives for
  // its armour plating, and the same Mikkelsen derivative construction, which
  // needs no tangent frame and no UVs (this module has neither).
  //
  // The guard is copied from creatures.js because the failure it prevents is
  // real and catastrophic: a silver-thin blade quad makes det ~ 0, the gradient
  // goes non-finite, and ONE such pixel poisons postfx's exposure average for
  // the whole frame. Reject rather than rescale, written so NaN and inf both
  // fail the test.
  float bumpAmp = uSurf.z * sFar;
  if (bumpAmp > 0.002) {
    // COARSE-dominant on purpose. The relief term differentiates its height
    // field in screen space, so it is the term most sensitive to the field
    // going sub-pixel; nC bottoms out at 67 cm features on the plant where nS
    // reaches 8 cm, and the visible difference is relief against dither. This is
    // why flFbm returns the coarse band separately rather than the caller
    // guessing at a second frequency.
    float h = nC * 0.60 + nS * 0.40;
    vec3 dpx = dFdx(P), dpy = dFdy(P);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    float sgn = det < 0.0 ? -1.0 : 1.0;
    vec3 gradH = (r1 * dFdx(h) + r2 * dFdy(h)) * sgn / max(abs(det), 1e-5);
    if (dot(gradH, gradH) < 64.0) {
      vec3 n2 = N - gradH * bumpAmp;
      float nn = dot(n2, n2);
      if (nn > 1e-4) N = n2 * inversesqrt(nn);
    }
  }

  float ndl  = max(dot(N, uSunDir), 0.0);
  float wrap = ndl * mix(0.20, 0.64, fill) + 0.36 * fill * (dot(N, uSunDir) * 0.5 + 0.5);
  vec3  sun  = uSunColor * downT * (uSunIntensity * wrap * 0.45 * mix(0.45, 1.0, ao));
  vec3  amb  = mix(uAmbBottom, uAmbTop, N.y * 0.5 + 0.5) * (ao * ao * 0.52 * fill);

  // TRANSLUCENCY. A frond is a leaf a few millimetres thick and light coming
  // from behind passes through it. Without this a kelp stand is a wall of black
  // cardboard; with it the near fronds glow at their edges exactly as they do in
  // kelp-forest-2/4. Creepvine's value is near zero (LOOK.md §8 calls it a pure
  // black silhouette); a jellyshroom cap is over 1.
  float back = max(dot(-N, uSunDir), 0.0);
  vec3  thru = uSunColor * downT * (uSunIntensity * pow(back, 2.2) * 0.36 * vAux.z * ao);

  // ---- EDGE ----------------------------------------------------------------
  // A frond is a leaf a few millimetres thick, and the optical path through it
  // is shortest where the line of sight grazes the surface — which is exactly
  // the sliver the eye sees as the blade's outline. So every blade in
  // kelp-forest-4.jpg carries a thin bright hairline all the way round its rim,
  // and ours carried none: our blades were mathematical surfaces with no
  // thickness and no edge term, which is half of what "untextured card" means.
  //
  // aFlora2.z is 1 on a blade's rim and 0 along its midrib (see Build.blade),
  // so this fires on the outline of every frond, cap and fan in the module and
  // nowhere on a lathe or a coral mass. Squaring the grazing factor keeps it a
  // hairline rather than a general brightening — and a hairline on a near-black
  // creepvine is fine-octave energy where the reference has it and we did not.
  float graze = 1.0 - abs(dot(N, V));
  float rim   = vPodPrt.z * graze * graze * graze;
  // it takes the light from BEHIND preferentially, the way real transmission
  // does, but never falls to zero: a rim in shadow still catches the ambient
  //
  // The fill coefficient is 0.30, not 0.13, and that is deliberate on the one
  // species it matters for. A creepvine accepts fill 0.05 precisely so it stays
  // black, which also means the surface grain — multiplicative on a linear 0.03
  // albedo — can put no measurable signal on it at all. The rim is the ONLY term
  // that can, and the fine octave band is exactly where the kelp plate was
  // measured short. A hairline on the outline of every blade is both the
  // physically right answer and the only one that survives being a silhouette.
  vec3  rimL = uSunColor * downT * (uSunIntensity * rim * mix(0.45, 1.4, back)
                                    * (0.34 * vAux.z + 0.30 * fill) * mix(0.5, 1.0, ao));
  thru = thru * (1.0 + 1.6 * rim) + rimL;

  // Caustics are applied here rather than by the shared injection (which is
  // opted out of with caustics:0) for the reason terrain.js gives: they are
  // incident LIGHT, so they must be multiplied by albedo. Added flat they flood
  // a near-black creepvine to the value of the pale sand behind it.
  float upF  = clamp(N.y * 0.5 + 0.5, 0.0, 1.0); upF *= upF;
  float caus = uwCaustics(P) * upF * exp(-pd * 0.020) * uCausticsStrength
             * uUnderwater * uCausticsOn * mix(0.25, 1.0, ao) * fill;
  vec3  caustic = uSunColor * sunT * (caus * 0.70);

  vec3 c = alb * (sun + amb + caustic + thru);

  // A wet sheen — small, but it is what stops a frond looking like felt. It is
  // albedo-INDEPENDENT, which is exactly why it had to come under fill: at
  // 0.05 * 3.2 it added up to 0.16 linear to a plant whose albedo was 0.03, and
  // that alone made the near creepvine fronds paler than the water behind them.
  //
  // ROUGHNESS IS NOT UNIFORM. AGENT_BRIEF §4 is explicit that "a surface uniform
  // in gloss reads as plastic however good its colour is", and one exponent and
  // one weight over an entire reef is exactly that. The same broadband field
  // that varies the albedo varies the specular lobe: worn patches go broad and
  // dim, smooth wet patches stay tight and bright. It costs two multiplies and
  // it is the difference between wet flesh and vinyl.
  float gloss = 1.0 + uSurf.x * 1.20 * (nS * 0.6 + nC * 0.4) * sA;
  vec3 H = normalize(uSunDir + V);
  c += uSunColor * (pow(max(dot(N, H), 0.0), 24.0 * gloss)
                    * 0.035 * gloss * uSunIntensity * ao * fill);

  // ---- BIOLUMINESCENCE -----------------------------------------------------
  // core's UNDERWATER_FRAG multiplies this whole fragment by
  //     mix(0.06, 1.0, sunT.b) * uDepthDarken
  // which is right for a sunlit surface and wrong by a factor of ~35 for a
  // self-lit one: at 200 m it would leave a jellyshroom dimmer than the water it
  // is meant to be lighting. Pre-dividing by exactly that factor means the
  // emissive survives the injection untouched, which is the physical claim — a
  // photon emitted here does not care how far away the sun is.
  //
  // The guard floor is 0.0015, not 0.012. In the jellyshroom cave the real
  // factor is about 0.003, so a 0.012 floor under-compensated by 4x and the
  // caps — 73 live instances, correctly placed — rendered as dark umbrellas in
  // a frame whose reference (cave-1.jpg) is 40% glowing dome by area.
  //
  // The body term widens the emissive from the discrete points of LOOK.md
  // §11.27 to the whole surface, which §8 asks for on exactly one plant: the
  // jellyshroom, a "translucent magenta dome lit from within".
  float dim = mix(1.0, mix(0.06, 1.0, sunT.b) * uDepthDarken, uUnderwater);
  float emis = vAux.x + vAux2.y * (1.0 - vAux.x) * 0.62;

  // ---- and why a self-lit surface needs STRUCTURE, not just a value ---------
  // Display clipping is the measurement the brief singles out, and ours was
  // pathological: 0.034% of the kelp frame at luminance >= 250 with 98% of THOSE
  // pixels at a literal 255/255/255, against kelp-forest-1.jpg's 0.0002% whose
  // brightest pixels average rgb(250,252,120). A real emitter never produces a
  // flat plate of white, for two reasons that are both cheap to model:
  //
  //   LIMB. It is a VOLUME. A line of sight that grazes the surface leaves
  //   through less glowing material than one down the middle, so the edge of a
  //   berry is dimmer than its centre. On a closed lathe (pods, sacks, caps)
  //   this alone turns a clipped disc into a ball. On a two-sided blade strip
  //   dot(N,V) is pinned near 1 by the flip above, which is correct: a leaf a
  //   few millimetres thick genuinely has no limb.
  //
  //   GRAIN. Bioluminescence is produced by cells, not by a light bulb, and it
  //   is never even. Reusing the fine broadband tap costs nothing here.
  //
  // The limb exponent is 2.8, not 1.75, and the floor is 0.06. Measured on the
  // r7 capture the pods were still reading as pale cream EGGS: every channel of
  // the berry's middle was clipping, so the only hue left in the object came
  // from the mottle's dark side, which is precisely inside-out. A harder limb
  // spends the same peak brightness over a much smaller part of each berry, so
  // the core clips and the surrounding two-thirds keeps its amber.
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float limb = 0.06 + 0.94 * pow(nv, 2.8);
  // COARSE-weighted: keyed to the fine band the mottle became pixel-scale gold
  // glitter on a berry instead of the soft internal gradient the reference
  // cluster shows. nC is fixed in metres on the plant, so on a 0.3 m pod its
  // base octave is a quarter of a cycle — one smooth gradient across the berry.
  float mottle = 1.0 + uSurf.w * (nC * 0.82 + nS * 0.18);
  // PER-EMITTER SPREAD. The reference cluster has one or two berries near the
  // clip point and a dozen at half that; a cluster where every pod is equally
  // bright fuses into one blob however good each pod is. vPodPrt.y is the
  // per-part random the geometry already carries, so this is free. The spread is
  // wider than round seven's 0.40-1.35: a factor of four between the dimmest
  // and brightest berry is what the reference cluster actually measures.
  float spread = mix(1.0, 0.32 + 1.10 * vPodPrt.y * vPodPrt.y, vPodPrt.x);
  c += vGlow.rgb * (vGlow.a * emis * limb * mottle * spread / max(dim, 0.0015));

  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Terrain-conforming additive light pools under the strong bioluminescent
 * plants. This is the half of "bioluminescent flora must light its
 * surroundings" that an emissive material cannot do on its own: world/terrain.js
 * is a raw ShaderMaterial with its own analytic lighting and no light list, so a
 * THREE.PointLight would not touch the seabed at all. A projected pool does,
 * costs one draw call for the entire field, and is what cave-3.jpg actually
 * shows — a plant sitting in its own puddle of light on the sand.
 */
const POOL_VERT = /* glsl */ `
attribute vec3 aPoolCol;
attribute float aPoolA;
varying vec3 vPC;
varying float vPA;
void main() {
  vPC = aPoolCol; vPA = aPoolA;
  vec3 transformed = position;
  vUwWorldPos = transformed;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  #include <project_vertex>
}
`;
const POOL_FRAG = /* glsl */ `
varying vec3 vPC;
varying float vPA;
void main() {
  // additive, so the medium contributes transmittance but no in-scatter of its
  // own — the water's in-scatter is already in the pixel underneath us
  vec3 T = uwTransmittance(distance(uCamPos, vUwWorldPos));
  vec3 add = vPC * (vPA * vPA) * T;
  // POOLS OVERLAP, and additively. A dense ghost-weed patch put a dozen of them
  // on the same square metre of seabed and their sum clipped to a flat white
  // polygon with a hard rim where the disc met the terrain — measured as one of
  // the worst clipping offenders in the seamoth frame. One pool per clump (see
  // makeCell) is the structural fix; this is the one that holds whatever the
  // density turns out to be. Scaling by the peak channel rather than clamping
  // per channel keeps the hue: a cyan pool that clamps channel-wise turns white
  // on its way to saturating, which is exactly the tell.
  float pk = max(max(add.r, add.g), add.b);
  gl_FragColor = vec4(add / (1.0 + pk * 1.7), 1.0);
}
`;

// ===========================================================================
// 4. MATERIALS
// ===========================================================================
const uCurrent = { value: new THREE.Vector4(1, 0, 0.33, 0) };
const uSwayAmp = { value: new THREE.Vector2(0.088, 0.030) };
const uCausticsOn = { value: 0 };
/**
 * Surface microstructure master gains: albedo, hue, relief, emitter mottle.
 *
 * These were tuned by measurement, not by eye, exactly as AGENT_BRIEF §4 asks.
 * The crop is the reef growth in the shallows-floor framing against the matching
 * plants in shallows-floor-2.jpg, and the target is the brief's: RAISE broadband
 * content toward the reference's detailRMS ~28-32 while keeping 32 px local
 * contrast at or under the reference's ~18-20 rather than overshooting it with
 * hard-edged decal (the failure the wreck hull was measured making at 43.15
 * against 9.2). Debug overrides below let each gain be zeroed independently, so
 * the contribution of each is separable in a capture rather than argued about.
 */
const uSurf = { value: new THREE.Vector4(1.0, 1.0, 0.38, 0.26) };

/**
 * The shared preset, declared through applyUnderwater's `surface:` option so
 * this material is one of the ones the scene census counts — round seven's
 * census found only 35 of 179 materials opted in, and flora was one of the ones
 * that had wired the microstructure in BY HAND and therefore did not register.
 * Calling the primitive directly was a defensible choice when sfApply keyed off
 * vUwWorldPos and everything here moves; the honest fix is to opt in properly
 * and redirect the sample point (see below), not to opt out and reimplement.
 *
 * Amplitudes are inside the documented clamps (grain <= 0.25, wear/streak <= 1).
 * Streak is near zero: gravity streaking is what a hull that has sat in water
 * for years does, and a living plant sheds. grain 0.20 was chosen by measuring
 * the kelp plate spectrum, not by eye — see the report.
 */
const FLORA_SURFACE = { grain: 0.25, wear: 0.45, streak: 0.08, scale: 0.9 };

/**
 * DEFENSIVE — see coreBugs in the round-8 report.
 *
 * core/surface.js's sfBroadband() calls fwidth(), and core/underwaterMaterial.js
 * injects UNDERWATER_PARS (which contains SURFACE_PARS) into the VERTEX shader
 * as well as the fragment shader. fwidth/dFdx/dFdy do not exist in the vertex
 * stage in GLSL ES, so as committed EVERY material in the game fails to compile
 * its vertex program: a capture taken against it reports healthy draw counts and
 * writes an empty blue PNG, which is the worst possible failure mode because it
 * looks like a lighting bug. Measured on the r8 battery: 35 failed programs
 * including uw.backdrop, terrain, terrain-cobbles and flora.
 *
 * That is core's to fix and this module does not touch it. What this module CAN
 * do is stop its own three materials from being collateral damage: flora's
 * vertex shaders never call sfBroadband, so the derivative in the vertex copy of
 * the shared pars is dead code and can be replaced with a constant. If core
 * makes the pars vertex-safe, the anchor stops matching and this is a no-op.
 */
function stripVertexDerivatives(src) {
  return src.replace('float mpp = max(length(fwidth(p)), 1e-6);',
    'float mpp = 1e-3; // flora: fwidth() is fragment-only (see coreBugs)');
}

function makeFloraMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uSunIntensity: U.uSunIntensity,
      uAmbTop: U.uAmbientTop,
      uAmbBottom: U.uAmbientBottom,
      uCausticsOn, uCurrent, uSwayAmp, uSurf,
    },
    vertexShader: FLORA_VERT,
    fragmentShader: FLORA_FRAG,
    side: THREE.DoubleSide,
  });
  m.name = 'flora';
  // caustics: 0 — applied inside the shader instead, times albedo (see FRAG)
  applyUnderwater(m, { caustics: 0, surface: FLORA_SURFACE });

  // Redirect core's SURFACE_FRAG from world space to the plant's own material
  // space, and give it the distance fade. Everything in this module MOVES: a
  // creepvine tip travels three metres in a gust, and a world-keyed pattern
  // swims across the blade every time the current turns — which is worse than
  // having no grain at all. Composing onBeforeCompile is the documented way to
  // add to a material core has already patched; the cache key composes too, or
  // three hands us the program compiled for the other variant.
  const prior = m.onBeforeCompile;
  const NEEDLE = 'sfApply(gl_FragColor.rgb, vUwWorldPos,';
  m.onBeforeCompile = (sh, renderer) => {
    prior.call(m, sh, renderer);
    sh.vertexShader = stripVertexDerivatives(sh.vertexShader);
    if (sh.fragmentShader.includes(NEEDLE)) {
      sh.fragmentShader = sh.fragmentShader.replace(
        NEEDLE, 'flSurfApply(gl_FragColor.rgb, vSurfP,');
    } else {
      // Loud, because the silent failure mode is grain that crawls over a
      // swaying plant, which reads as a shimmer rather than as a bug.
      console.warn('[flora] core SURFACE_FRAG changed shape — microstructure is '
        + 'running in world space and will swim with the sway');
    }
  };
  const priorKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => 'floraSf|' + priorKey.call(m);
  m.needsUpdate = true;
  return m;
}

/**
 * The shadow-pass twin. Three.js renders shadow casters with its own
 * MeshDepthMaterial, whose stock vertex shader has never heard of aIPos/aIQ, so
 * without this every instance would be drawn at the group origin — 620 stacked
 * creepvines throwing one phantom blob over the spawn basin. Patching the depth
 * material with the SAME fl_local() keeps the shadow on the swaying plant.
 */
function makeDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.uTime, uCurrent, uSwayAmp });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\n' + SWAY_GLSL)
      .replace('#include <begin_vertex>',
        'vec3 transformed = fl_qrot(aIQ, fl_local()) + aIPos;');
  };
  m.customProgramCacheKey = () => 'floraDepth';
  return m;
}

function makePoolMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {},
    // stripVertexDerivatives: the pool's vertex shader includes the shared pars
    // for uwTransmittance, and the shared pars currently carry a fragment-only
    // fwidth() call that fails to compile in the vertex stage. See coreBugs.
    vertexShader: stripVertexDerivatives('#include <common>\n' + UNDERWATER_PARS + POOL_VERT),
    fragmentShader: '#include <common>\n' + UNDERWATER_PARS + POOL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  // The medium uniforms the pool shader reads. It deliberately does NOT go
  // through applyUnderwater, because an additive pass must not also add
  // in-scatter; it calls uwTransmittance directly, which is what the module
  // contract in AGENT_BRIEF asks a custom ShaderMaterial to do.
  Object.assign(m.uniforms, {
    uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor,
    uFogColor: U.uFogColor, uScatterColor: U.uScatterColor,
    uScatterStrength: U.uScatterStrength, uAbsorption: U.uAbsorption,
    uMaxVisibility: U.uMaxVisibility, uSkyAtten: U.uSkyAtten, uScatterG: U.uScatterG,
    uCausticsTex: U.uCausticsTex, uCausticsScale: U.uCausticsScale,
    uCausticsStrength: U.uCausticsStrength, uCausticsSpeed: U.uCausticsSpeed,
    uDepthDarken: U.uDepthDarken, uWaterLevel: U.uWaterLevel, uUnderwater: U.uUnderwater,
    uMatCaustics: { value: 0 }, uMatFogScale: { value: 1 },
  });
  m.name = 'flora:pool';
  return m;
}

// ===========================================================================
// 5. INSTANCE POOLS
// ===========================================================================
class Pool {
  constructor(name, arch, geo, material, depthMaterial) {
    this.name = name;
    this.arch = arch;
    this.geo = geo;
    const N = arch.max;
    this.max = N;
    this.aPos = new Float32Array(N * 3);
    this.aQ = new Float32Array(N * 4);
    this.aScl = new Float32Array(N * 3);
    this.aCol = new Float32Array(N * 3);
    this.aGlow = new Float32Array(N * 4);
    this.aPar = new Float32Array(N * 4);
    this.aPar2 = new Float32Array(N * 3);
    const add = (nm, arr, n) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(nm, a);
      return a;
    };
    this.bufs = [
      [add('aIPos', this.aPos, 3), 3],
      [add('aIQ', this.aQ, 4), 4],
      [add('aIScl', this.aScl, 3), 3],
      [add('aICol', this.aCol, 3), 3],
      [add('aIGlow', this.aGlow, 4), 4],
      [add('aIPar', this.aPar, 4), 4],
      [add('aIPar2', this.aPar2, 3), 3],
    ];
    geo.instanceCount = 0;

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `flora:${name}`;
    if (arch.cast) {
      this.mesh.customDepthMaterial = depthMaterial;
    } else {
      // Ground cover casts a shadow a few centimetres long, which no 2048 map
      // covering hundreds of metres can resolve — a full extra pass over
      // thousands of instances to render nothing. Opt out, as terrain.js's
      // cobble field does for the same reason.
      this.mesh.userData.noShadow = true;
      this.mesh.castShadow = false;
    }
    this.count = 0;
  }

  reset() { this.count = 0; }

  push(pl, scale, fade) {
    const i = this.count;
    if (i >= this.max) return false;
    this.aPos[i * 3] = pl.x; this.aPos[i * 3 + 1] = pl.y; this.aPos[i * 3 + 2] = pl.z;
    this.aQ[i * 4] = pl.qx; this.aQ[i * 4 + 1] = pl.qy;
    this.aQ[i * 4 + 2] = pl.qz; this.aQ[i * 4 + 3] = pl.qw;
    this.aScl[i * 3] = pl.sx * scale;
    this.aScl[i * 3 + 1] = pl.sy * scale;
    this.aScl[i * 3 + 2] = pl.sz * scale;
    this.aPar2[i * 3] = pl.fill; this.aPar2[i * 3 + 1] = pl.body;
    this.aPar2[i * 3 + 2] = pl.surf;
    this.aCol[i * 3] = pl.cr; this.aCol[i * 3 + 1] = pl.cg; this.aCol[i * 3 + 2] = pl.cb;
    this.aGlow[i * 4] = pl.gr; this.aGlow[i * 4 + 1] = pl.gg;
    this.aGlow[i * 4 + 2] = pl.gb; this.aGlow[i * 4 + 3] = pl.gi * fade;
    this.aPar[i * 4] = pl.phase; this.aPar[i * 4 + 1] = pl.sway;
    this.aPar[i * 4 + 2] = pl.pod; this.aPar[i * 4 + 3] = pl.trans;
    this.count = i + 1;
    return true;
  }

  upload() {
    const n = this.count;
    this.geo.instanceCount = n;
    for (const [b, k] of this.bufs) {
      b.clearUpdateRanges();
      b.addUpdateRange(0, n * k);
      b.needsUpdate = true;
    }
  }
}

// ===========================================================================
// 6. THE FIELD — cell generation, streaming, refill
// ===========================================================================
const TIERS = [
  { cell: 15, radius: 48 },     // tier 0: ground cover and small growths
  { cell: 32, radius: 96 },     // tier 1: 1.5-9 m corals, palms, spheres
  { cell: 60, radius: 158 },    // tier 2: the towers
];

let terrain = null, biomes = null;
let WORLD_SEED = 1337;
let group = null, material = null, depthMaterial = null, poolMaterial = null;
const pools = new Map();
let cells = [new Map(), new Map(), new Map()];
const _n = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const SP_COL = new Map();       // species id -> linear THREE.Color, baked once
const SP_GLOW = new Map();

function bakeColours() {
  for (const [id, s] of Object.entries(SPECIES)) {
    SP_COL.set(id, srgb(s.col));
    if (s.glow) SP_GLOW.set(id, srgb(s.glow));
  }
}

const heightAt = (x, z) => {
  if (!terrain?.heightAt) return -30;
  const h = terrain.heightAt(x, z);
  return Number.isFinite(h) ? h : -30;
};
const normalAt = (x, z, out) => {
  if (!terrain?.normalAt) return out.set(0, 1, 0);
  const r = terrain.normalAt(x, z, out);
  return (r && Number.isFinite(r.y)) ? r : out.set(0, 1, 0);
};

function tableAt(x, z, groundY) {
  if (biomes?.spawnTableAt) {
    try {
      // groundY matters: it is what lets cavern biomes (jellyshroom, lava zone)
      // answer for the seabed under them. Without it the cave shot plants a
      // sparse-reef lawn 200 m down instead of a bioluminescent cavern floor.
      const t = biomes.spawnTableAt(x, z, 'flora', groundY);
      if (t && t.length) return t;
    } catch { /* fall through to the built-in table */ }
  }
  const d = Math.max(0, WORLD.seaLevel - groundY);
  let row = FALLBACK_TABLE[0][1];
  for (const [dd, r] of FALLBACK_TABLE) if (d >= dd) row = r;
  return row;
}

/** Scale range for a species: its own override, else the biome table's hint. */
function sizeRange(id, row) {
  const s = SPECIES[id];
  if (s.size) return s.size;
  if (row?.scale && row.scale.length === 2) return row.scale;
  return [0.6, 1.2];
}

/**
 * The pool's radial profile. Round six ran five rings at [1, .74, .44, .18, 0]
 * and squared the alpha in the shader, which put the whole inner 30% of the disc
 * above 0.55 — a flat plateau, and the seamoth frame duly came back with a
 * hard-edged white blob on the sand with grass blades silhouetted against it.
 * A pool of light does not have a plateau. Seven rings, bunched toward the
 * centre so the peak is a point rather than a shelf, and a peak alpha of 0.80
 * so that even head-on the additive term cannot on its own carry a pixel to
 * clipping.
 */
const POOL_SEG = 18;
const POOL_RINGS = [0.0, 0.13, 0.28, 0.45, 0.63, 0.82, 1.0];
const POOL_A = [0.80, 0.75, 0.63, 0.46, 0.28, 0.12, 0.0];
const POOL_VERTS = 1 + POOL_SEG * (POOL_RINGS.length - 1);

/**
 * One terrain-conforming light patch, baked at cell-generation time so the
 * refill only ever copies floats. Sampling heightAt per vertex is what makes it
 * lie ON the seabed over a ripple instead of slicing through it.
 */
function makePoolPatch(x, y, z, R, glowColor, intensity) {
  const pos = new Float32Array(POOL_VERTS * 3);
  const col = new Float32Array(POOL_VERTS * 3);
  const alp = new Float32Array(POOL_VERTS);
  // a plant lights the sand with its own colour times the sand's albedo; 0.34 is
  // a mid seabed reflectance and keeps the pool from reading as paint
  // 0.22, not 0.34. A pool is the plant lighting the sand — a SECONDARY bounce,
  // dimmer than the plant by definition — and the seamoth frame had it clipping
  // to white with a visible polygonal rim while the weed casting it was a
  // silhouette against its own light. That is backwards in every reference frame
  // there is.
  const k = 0.19 * intensity;
  let v = 0;
  const put = (px, pz, a, own) => {
    const py = own ? y : heightAt(px, pz);
    // A patch that spans a ledge used to render as a saturated wedge with two
    // dead-straight edges — visible bottom-left of the isolated cave render.
    // Its rim vertices sat on a shelf metres below the centre, so the triangles
    // between them cut through the terrain instead of lying on it. Fading with
    // the height difference kills the pool at the lip, which is also what a real
    // pool of light does: it does not wrap around a corner.
    const fall = Math.exp(-Math.abs(py - y) * 0.55);
    // The sand under a glowing plant is not a smooth gradient: it is ripples and
    // grains taking a grazing light, so the pool is mottled at the same 1-3 m
    // scale terrain.js gives its ripples. Baked once per patch, not per frame.
    const mott = 0.72 + 0.56 * fbm2(px * 0.55 + 11.3, pz * 0.55 - 4.1, 3);
    // 0.17 above the sampled height, not 0.12: the patch is a triangulated
    // disc through heightAt samples and the true surface bulges above the
    // chords between them, so too small an offset lets the terrain punch
    // hard-edged bites out of the pool.
    pos[v * 3] = px; pos[v * 3 + 1] = py + 0.17; pos[v * 3 + 2] = pz;
    col[v * 3] = glowColor.r * k; col[v * 3 + 1] = glowColor.g * k; col[v * 3 + 2] = glowColor.b * k;
    alp[v] = a * fall * mott;
    v++;
  };
  put(x, z, POOL_A[0], true);
  for (let ri = 1; ri < POOL_RINGS.length; ri++) {
    const rr = POOL_RINGS[ri] * R;
    for (let s = 0; s < POOL_SEG; s++) {
      const a = (s / POOL_SEG) * TAU;
      // a ragged rim: a perfect disc of light on a seabed is a spotlight decal
      const wob = 1 + 0.20 * Math.sin(a * 3 + x * 0.7) + 0.12 * Math.sin(a * 5 - z * 0.6);
      put(x + Math.cos(a) * rr * wob, z + Math.sin(a) * rr * wob, POOL_A[ri], false);
    }
  }
  return { pos, col, alp, x, z };
}

const POOL_INDEX = (() => {
  const idx = [];
  for (let s = 0; s < POOL_SEG; s++) idx.push(0, 1 + s, 1 + ((s + 1) % POOL_SEG));
  for (let ri = 1; ri < POOL_RINGS.length - 1; ri++) {
    const a0 = 1 + (ri - 1) * POOL_SEG, b0 = 1 + ri * POOL_SEG;
    for (let s = 0; s < POOL_SEG; s++) {
      const s2 = (s + 1) % POOL_SEG;
      idx.push(a0 + s, b0 + s, b0 + s2, a0 + s, b0 + s2, a0 + s2);
    }
  }
  return idx;
})();

/**
 * Generate one cell's plants. Deterministic in (tier, ci, cj), so the same seed
 * always produces the same forest and an A/B comparison stays valid.
 */
function makeCell(tierIdx, ci, cj) {
  const T = TIERS[tierIdx];
  const rng = makeRNG(((ci * 73856093) ^ (cj * 19349663) ^ ((tierIdx + 1) * 83492791) ^ WORLD_SEED) >>> 0);
  const x0 = ci * T.cell, z0 = cj * T.cell;
  const cx = x0 + T.cell * 0.5, cz = z0 + T.cell * 0.5;
  const plants = [];
  const lights = [];

  const cy = heightAt(cx, cz);
  if (cy > WORLD.seaLevel - 1.5) return { plants, lights };
  let table = tableAt(cx, cz, cy + 0.5);
  const area = T.cell * T.cell;

  // The shell/pebble litter is not on any biome table — it is our own
  // population, gated on the ground being the kind of soft sandy floor those
  // tables put sea grass on, so it never appears on a bare rock face.
  if (tierIdx === 0) {
    const sandy = table.find((r) => r.id === 'sea_grass');
    if (sandy && sandy.density > 25) {
      table = table.concat([{ id: 'shell_scatter', density: sandy.density * 0.30, cluster: 7 }]);
    }
  }

  for (const row of table) {
    const sp = SPECIES[row.id];
    if (!sp || sp.tier !== tierIdx) continue;
    const arch = archOf(row.id);
    if (!arch) continue;

    const expect = row.density * (sp.mul ?? 1) * area / 1000;
    if (expect <= 0) continue;
    const clumpN = sp.clump || [Math.max(1, Math.round((row.cluster ?? 4) * 0.6)),
      Math.max(2, Math.round(row.cluster ?? 4))];
    const meanClump = (clumpN[0] + clumpN[1]) * 0.5;
    const groups = expect / meanClump;
    let nGroups = Math.floor(groups) + (rng() < (groups - Math.floor(groups)) ? 1 : 0);
    if (nGroups <= 0) continue;
    nGroups = Math.min(nGroups, 110);

    const [lo, hi] = sizeRange(row.id, row);
    const base = SP_COL.get(row.id);
    const glow = SP_GLOW.get(row.id);
    const spread = sp.spread ?? (1.0 + 2.0 * Math.sqrt(hi));

    for (let g = 0; g < nGroups; g++) {
      const gx = x0 + rng() * T.cell, gz = z0 + rng() * T.cell;
      // Coverage: plants grow in patches with bare ground between them. Without
      // this the seabed becomes an even lawn, which is a stronger "generated"
      // signal than having no plants at all would be.
      //
      // The MATS are gated much more loosely than the big growths. The patchy
      // gate is what gives a reef its structure at the scale of a coral head,
      // but shallows-floor-2.jpg's plateau has no bare sand on it at all, and
      // running the turf through a 0.62 gate was throwing away nearly 40% of
      // the very population whose job is to leave no gaps.
      const cover = fbm2(gx * 0.014 + row.id.length * 3.1, gz * 0.014 - 7.3, 3);
      const gate = tierIdx === 0 ? 0.84 + cover * 0.80 : 0.62 + cover * 1.15;
      if (rng() > clamp01(gate)) continue;

      const k = clumpN[0] + Math.floor(rng() * (clumpN[1] - clumpN[0] + 1));
      for (let m = 0; m < k; m++) {
        const a = rng() * TAU, r = spread * Math.sqrt(rng());
        const px = gx + Math.cos(a) * r, pz = gz + Math.sin(a) * r;
        const py = heightAt(px, pz);
        if (py > WORLD.seaLevel - 1.0) continue;
        normalAt(px, pz, _n);
        if (1 - _n.y > (sp.slope ?? 0.5)) continue;

        // bias 2 (the default) is a real age distribution: mostly young plants
        // with a few giants. The creepvines override it to 1, because a stand of
        // mostly-short kelp has no towers in it and the frame loses its scale.
        const size = lo + (hi - lo) * Math.pow(rng(), sp.bias ?? 2.0);
        // Plants stand up; they only partly follow the ground. Aligning fully to
        // the normal turns a slope into a hairbrush.
        _axis.copy(_up).lerp(_n, 0.55).normalize();
        _q.setFromUnitVectors(_up, _axis);
        _q2.setFromAxisAngle(_axis, rng() * TAU);           // spin about its own stem
        _q.premultiply(_q2);
        const ta = rng() * TAU;
        _axis.set(Math.cos(ta), 0, Math.sin(ta));
        _q3.setFromAxisAngle(_axis, (rng() - 0.5) * (sp.a === 'vine' ? 0.34 : 0.20));
        _q.premultiply(_q3);

        const jit = 1 + (rng() * 2 - 1) * (sp.jit ?? 0.25);
        // G-vs-B separation costs nothing and was going unspent: our densest
        // floor crop measured bandGB [0.97,1.06,1.06] against
        // shallows-floor-2's [0.98,1.52,2.56]. `hue` widens the per-instance
        // swing on the species that carry a frame's colour variety — the green
        // mats and the yellow acid mushrooms — so a mat is not one flat hue.
        const hueJ = 1 + (rng() * 2 - 1) * (sp.hue ?? 0.10);
        const gi = glow ? (sp.gi ?? 1) * (0.7 + 0.6 * rng()) : 0;
        const wide = (sp.wide ?? 1) * (0.90 + rng() * 0.22);
        plants.push({
          // sunk a little so nothing meets the sand at a hard intersection line
          x: px, y: py - size * (sp.a === 'grass' ? 0.05 : 0.035), z: pz,
          qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w,
          sx: size * wide, sy: size, sz: size * (sp.wide ?? 1) * (0.90 + rng() * 0.22),
          cr: base.r * jit, cg: base.g * jit * hueJ, cb: base.b * jit / hueJ,
          gr: glow ? glow.r : 0, gg: glow ? glow.g : 0, gb: glow ? glow.b : 0, gi,
          phase: rng() * TAU,
          sway: (sp.sway ?? 0.5) * (0.72 + 0.56 * rng()),
          pod: sp.pods ? (rng() < 0.80 ? 0.75 + rng() * 0.5 : 0) : 0,
          trans: sp.trans ?? 0.5,
          fill: sp.fill ?? 1.0, body: sp.body ?? 0.0,
          // Surface amplitude jitters per plant as well as per species: two
          // corals of one species that are equally pitted is itself a pattern.
          surf: (sp.surf ?? ARCHETYPES[arch].surf ?? 1.0) * (0.74 + rng() * 0.52),
          arch, size,
        });

        // ONE POOL PER CLUMP, not one per plant. A clump of nine glowing weeds
        // dropped nine overlapping additive discs on the same patch of sand and
        // the sum was a white polygon; and physically it is wrong anyway — the
        // light pool under a clump is the clump's, not a sum of nine identical
        // ones. The cap comes down with it, because 24 was a number chosen when
        // each one was much dimmer.
        if (glow && sp.pool && m === 0 && lights.length < 12) {
          // and the clump lights a patch a little wider than one plant would
          const R = clamp(size * sp.pool * 2.1, 1.2, 9.5);
          // The pool is the plant lighting the sand, not the plant itself, so it
          // saturates: a glow bright enough to punch 30 m of Grand Reef water
          // would otherwise paint a floodlit white disc under a 1 m weed.
          lights.push(makePoolPatch(px, py, pz, R, glow, Math.min(gi, 3.2)));
        }
      }
    }
  }
  return { plants, lights };
}

// ---------------------------------------------------------------------------
// the merged light-pool mesh
// ---------------------------------------------------------------------------
const MAX_POOLS = 128;
let poolMesh = null, poolGeo = null, poolPos = null, poolCol = null, poolAlp = null;

function buildPoolMesh() {
  poolGeo = new THREE.BufferGeometry();
  poolPos = new Float32Array(MAX_POOLS * POOL_VERTS * 3);
  poolCol = new Float32Array(MAX_POOLS * POOL_VERTS * 3);
  poolAlp = new Float32Array(MAX_POOLS * POOL_VERTS);
  const idx = new Uint16Array(MAX_POOLS * POOL_INDEX.length);
  for (let p = 0; p < MAX_POOLS; p++) {
    for (let i = 0; i < POOL_INDEX.length; i++) {
      idx[p * POOL_INDEX.length + i] = POOL_INDEX[i] + p * POOL_VERTS;
    }
  }
  poolGeo.setAttribute('position', new THREE.BufferAttribute(poolPos, 3).setUsage(THREE.DynamicDrawUsage));
  poolGeo.setAttribute('aPoolCol', new THREE.BufferAttribute(poolCol, 3).setUsage(THREE.DynamicDrawUsage));
  poolGeo.setAttribute('aPoolA', new THREE.BufferAttribute(poolAlp, 1).setUsage(THREE.DynamicDrawUsage));
  poolGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  poolGeo.setDrawRange(0, 0);
  poolGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  poolMesh = new THREE.Mesh(poolGeo, poolMaterial);
  poolMesh.frustumCulled = false;
  poolMesh.matrixAutoUpdate = false;
  poolMesh.renderOrder = 4;
  poolMesh.userData.noShadow = true;
  poolMesh.castShadow = false;
  poolMesh.receiveShadow = false;
  poolMesh.name = 'flora:lightpools';
  return poolMesh;
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------
const _order = [];
const _perm = [];
const _lights = [];

/** Build any missing cells in range inside a time budget. Returns cells built. */
function prime(cx, cz, budgetMs) {
  const t0 = performance.now();
  let built = 0;
  for (let ti = 0; ti < TIERS.length; ti++) {
    const T = TIERS[ti];
    const c0 = Math.floor((cx - T.radius) / T.cell), c1 = Math.floor((cx + T.radius) / T.cell);
    const d0 = Math.floor((cz - T.radius) / T.cell), d1 = Math.floor((cz + T.radius) / T.cell);
    const map = cells[ti];
    // nearest-first, so a budget that runs out runs out at the far edge of the
    // field and never under the camera
    _order.length = 0;
    for (let j = d0; j <= d1; j++) {
      for (let i = c0; i <= c1; i++) {
        if (map.has(i * 131072 + j)) continue;
        const dx = (i + 0.5) * T.cell - cx, dz = (j + 0.5) * T.cell - cz;
        _order.push(dx * dx + dz * dz, i, j);
      }
    }
    const n = _order.length / 3;
    _perm.length = n;
    for (let k = 0; k < n; k++) _perm[k] = k;
    _perm.sort((a, b) => _order[a * 3] - _order[b * 3]);
    for (let p = 0; p < n; p++) {
      const i = _order[_perm[p] * 3 + 1], j = _order[_perm[p] * 3 + 2];
      map.set(i * 131072 + j, makeCell(ti, i, j));
      built++;
      if (performance.now() - t0 > budgetMs) return built;
    }
    if (map.size > 1300) {
      const keep = new Map();
      for (const [k, v] of map) {
        const i = Math.floor(k / 131072), j = k - i * 131072;
        if (Math.abs(i * T.cell - cx) < T.radius * 2.5 && Math.abs(j * T.cell - cz) < T.radius * 2.5) {
          keep.set(k, v);
        }
      }
      cells[ti] = keep;
    }
  }
  return built;
}

/** Cull radius for one plant: big things stay legible much further out. */
function cullRadius(arch, size) {
  return arch.cull * clamp(0.45 + size * 0.55, 0.45, 1.0) + size * 1.6;
}

/** Refill every instance buffer from the cell cache, nearest cell first. */
function refill(cx, cz, cy) {
  for (const p of pools.values()) p.reset();
  _lights.length = 0;

  for (let ti = 0; ti < TIERS.length; ti++) {
    const T = TIERS[ti];
    const c0 = Math.floor((cx - T.radius) / T.cell), c1 = Math.floor((cx + T.radius) / T.cell);
    const d0 = Math.floor((cz - T.radius) / T.cell), d1 = Math.floor((cz + T.radius) / T.cell);
    const map = cells[ti];
    _order.length = 0;
    for (let j = d0; j <= d1; j++) {
      for (let i = c0; i <= c1; i++) {
        const dx = (i + 0.5) * T.cell - cx, dz = (j + 0.5) * T.cell - cz;
        _order.push(dx * dx + dz * dz, i, j);
      }
    }
    const n = _order.length / 3;
    _perm.length = n;
    for (let k = 0; k < n; k++) _perm[k] = k;
    _perm.sort((a, b) => _order[a * 3] - _order[b * 3]);

    for (let p = 0; p < n; p++) {
      const i = _order[_perm[p] * 3 + 1], j = _order[_perm[p] * 3 + 2];
      const rec = map.get(i * 131072 + j);
      if (!rec) continue;
      for (let q = 0; q < rec.plants.length; q++) {
        const pl = rec.plants[q];
        const pool = pools.get(pl.arch);
        if (!pool) continue;
        const dx = pl.x - cx, dz = pl.z - cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const cull = cullRadius(pool.arch, pl.size);
        if (dist > cull) continue;
        // and it grows in over the last few metres rather than popping into
        // existence at full size
        let f = clamp01((cull - dist) / pool.arch.fade);
        // ...and the big plants fade out again at point-blank range, over a
        // clearance that SCALES WITH THE PLANT. The player occupies that volume,
        // so nothing grows in it.
        // The near clearance shrinks the plant but must NOT dim it: a
        // bioluminescent cap is the light source the frame is lit by, and
        // fading its emissive as it approaches is how the cave shot ended up
        // with its whole near band dark while the caps sat 25 m out in fog that
        // had already eaten 99% of them.
        let nf = 1;
        const nr = (pool.arch.near || 0) + (pool.arch.nearK || 0) * pl.size;
        if (nr > 0) nf = clamp01((dist - nr * 0.42) / (nr * 0.58));

        // THE CANOPY TEST. A horizontal distance measured to the holdfast is the
        // wrong quantity for anything whose widest part hangs above your head. A
        // 12 m jellyshroom carries a 17 m disc nine metres up; when the camera
        // sits nine metres off the cave floor, a plant whose base is a
        // comfortable seven metres away has its cap centred exactly on the lens,
        // and the frame came back as a flat magenta wall — twice, at two
        // different clearances, because no holdfast radius can express it.
        // Testing the camera against the canopy SPHERE is the quantity that
        // actually decides whether you are inside the plant, and it lets the
        // ramp be short: everything outside the sphere is legitimately in view.
        const ca = pool.arch.canopy;
        if (ca) {
          const wr = pl.sx / Math.max(pl.sy, 1e-4);      // the species' width factor
          const dyy = (pl.y + pl.size * ca[0]) - cy;
          const cr = pl.size * ca[1] * wr;
          const d3 = Math.sqrt(dx * dx + dyy * dyy + dz * dz);
          if (d3 < cr * 1.30) continue;
          nf = Math.min(nf, clamp01((d3 - cr * 1.30) / Math.max(cr * 0.50, 0.6)));
        }
        if (f <= 0.02 || nf <= 0.02) continue;
        // LOD LAST, not first: every cull, fade and canopy decision above is a
        // property of the PLANT and must not change with which mesh happens to
        // draw it, or the two pools would disagree about where a tuft stops
        // existing and the switch would pop. All this does is pick the geometry.
        // The cap test moves down here with it, so a full near pool spills into
        // the far one instead of dropping the plant.
        let dst = pool;
        if (pool.arch.lodFar && (dist > pool.arch.lodD || pool.count >= pool.max)) {
          dst = pools.get(pool.arch.lodFar) || pool;
        }
        if (dst.count >= dst.max) continue;
        dst.push(pl, (0.45 + 0.55 * f) * (0.62 + 0.38 * nf), f);
      }
      for (let q = 0; q < rec.lights.length; q++) {
        if (_lights.length >= MAX_POOLS) break;
        const L = rec.lights[q];
        const dx = L.x - cx, dz = L.z - cz;
        if (dx * dx + dz * dz > 60 * 60) continue;
        _lights.push(L);
      }
    }
  }

  for (const p of pools.values()) p.upload();

  const nL = _lights.length;
  for (let p = 0; p < nL; p++) {
    const L = _lights[p];
    poolPos.set(L.pos, p * POOL_VERTS * 3);
    poolCol.set(L.col, p * POOL_VERTS * 3);
    poolAlp.set(L.alp, p * POOL_VERTS);
  }
  poolGeo.setDrawRange(0, nL * POOL_INDEX.length);
  poolGeo.attributes.position.needsUpdate = true;
  poolGeo.attributes.aPoolCol.needsUpdate = true;
  poolGeo.attributes.aPoolA.needsUpdate = true;
}

// ===========================================================================
// 7. MODULE
// ===========================================================================
let lastCx = Infinity, lastCz = Infinity, lastCy = Infinity, needRefill = false;
let isolate = false;
// lambda ~ 19 m and omega/k = 5 m/s: a gust crosses a 40 m stand in 8 s — slow
// enough to read as water, fast enough to be visible inside the 2.4 s a 9-frame
// motion contact sheet spans.
// 3.6 m/s, not 5.0. The r8 motion sheet showed the near stalk swinging through
// most of its excursion inside one 0.28 s frame step — about 4.6 m/s of tip
// travel, which reads as wind in a storm rather than as a swell. At 3.6 a gust
// still crosses a 40 m stand in 11 s, which is visible across a 2.4 s sheet as a
// clear progression without any single stalk re-composing the frame.
const WAVE_K = TAU / 19.0;
const WAVE_OMEGA = 3.6 * WAVE_K;
let flowAngle = 0.7;

export default {
  id: 'flora',
  order: 60,

  async init(ctx) {
    // Honour the capture harness seed rather than a private constant, so ?seed=N
    // reproduces the same forest and a blind A/B stays valid.
    WORLD_SEED = (Number(ctx.params?.get?.('seed') ?? 1337) | 0) >>> 0;

    // ---- debug switches ------------------------------------------------------
    // Every gain in the surface microstructure is separately zeroable from the
    // capture harness, because "does the grain actually do anything" is a
    // question that should be answered by differencing two PNGs rather than by
    // reading the shader. ?flsurf=0&flhue=0&flbump=0&flmot=0 renders the round-six
    // surface exactly; ?flbump=0 alone isolates the relief term from the albedo
    // term. ?podgi= sweeps the creepvine pod emissive without an edit.
    const num = (k, d) => {
      const raw = ctx.params?.get?.(k);
      if (raw === null || raw === undefined || raw === '') return d;
      const v = Number(raw);
      return Number.isFinite(v) ? v : d;
    };
    // BARE FLAGS. tools/capture.mjs parses --params=a=b by splitting on '=' and
    // keeping the SECOND field, so `--params=floraiso=1` reaches the page as
    // `?floraiso` with no value and every `?k=v` switch below was unreachable
    // from the harness — which is how three rounds of "difference two captures
    // to prove what the grain does" quietly never happened. A bare key is the
    // only thing that survives that parser, so the switches that matter as
    // on/off are readable as presence.
    const flag = (k) => {
      const raw = ctx.params?.get?.(k);
      return raw === '' || raw === '1' || raw === 'true';
    };
    // Defaults come from the uniform's own authored value, NOT from repeated
    // literals. Written the other way, this line silently overrode two tuned
    // gains with the numbers they had had two iterations earlier, and the
    // capture that was supposed to prove the tuning proved the old values
    // instead. A debug switch that changes the thing it is meant to observe is
    // worse than no debug switch.
    const s0 = uSurf.value.clone();
    uSurf.value.set(num('flsurf', s0.x), num('flhue', s0.y), num('flbump', s0.z), num('flmot', s0.w));
    if (flag('flnosurf')) uSurf.value.set(0, 0, 0, 0);
    if (flag('flnobump')) uSurf.value.z = 0;
    SPECIES.kelp_vine.gi = num('podgi', SPECIES.kelp_vine.gi);
    SPECIES.blood_vine.gi = num('podgi2', SPECIES.blood_vine.gi);
    if (flag('flnoglow')) for (const s of Object.values(SPECIES)) if (s.glow) s.gi = 0;
    // ?floraiso=1 hides everything in the scene that is not flora. Judging a
    // species SILHOUETTE against a reference is impossible in a frame where a
    // creature and a wreck are in front of it, and the alternative — reasoning
    // about the shape from the source — is exactly the mistake that shipped a
    // creepvine reading as a palm for three rounds. It only ever sets .visible,
    // it is gated on a parameter, and it owns nothing it touches.
    isolate = flag('floraiso');
    this.debug = { uSurf: uSurf.value.toArray(), podgi: SPECIES.kelp_vine.gi, isolate };

    bakeColours();
    terrain = ctx.get('terrain');
    if (terrain?.stub) terrain = null;
    biomes = ctx.get('biomes');
    if (biomes?.stub) biomes = null;
    if (!terrain) console.warn('[flora] terrain unavailable — planting on a flat fallback plane');
    if (!biomes) console.warn('[flora] biomes unavailable — using the built-in depth-banded table');

    group = new THREE.Group();
    group.name = 'flora';
    ctx.scene.add(group);

    material = makeFloraMaterial();
    // ?flcore=<k> scales core's OWN sfApply gains (FLORA_SURFACE), which
    // `flnosurf` does NOT touch: flnosurf zeroes this module's uSurf vec4 and
    // leaves uSurfGrain exactly where applyUnderwater put it. Round 35's brief
    // cited a flnosurf ablation as proof that FLORA_SURFACE's grain was the
    // thing burying the geometry; the two fields have to be separable before
    // that attribution can be checked, and now they are. ?flcore=0 is the
    // clean ablation of the core half alone.
    {
      const k = num('flcore', 1);
      if (k !== 1) {
        const uu = material.userData.uwUniforms;
        uu.uSurfGrain.value *= k;
        uu.uSurfWear.value *= k;
        uu.uSurfStreak.value *= k;
      }
    }
    depthMaterial = makeDepthMaterial();
    poolMaterial = makePoolMaterial();

    let seed = (20250 + WORLD_SEED * 7) >>> 0;
    let tris = 0;
    for (const [name, arch] of Object.entries(ARCHETYPES)) {
      const geo = arch.build(seed += 977);
      tris += geo.userData.tris;
      const pool = new Pool(name, arch, geo, material, depthMaterial);
      pools.set(name, pool);
      group.add(pool.mesh);
    }
    // ?flpool=0 drops the ground light pools entirely — the only way to prove
    // by differencing whether a bright patch on the seabed is one of ours.
    if (num('flpool', 1) > 0 && !flag('flnopool')) group.add(buildPoolMesh());
    else buildPoolMesh();

    const cam = ctx.camera;
    lastCx = cam.position.x; lastCz = cam.position.z; lastCy = cam.position.y;
    // The first frame must not be a bare seabed, and a capture teleports the
    // camera straight into a shot, so the initial fill has to actually cover the
    // set rather than trickle in. Every later rebuild is incremental.
    prime(lastCx, lastCz, 2600);
    refill(lastCx, lastCz, cam.position.y);

    this.speciesCount = Object.keys(SPECIES).length;
    this.archetypeTris = tris;
    this.instanceCount = [...pools.values()].reduce((s, p) => s + p.count, 0);
  },

  update(dt, t, ctx) {
    // The current itself drifts slowly in direction, so the forest never settles
    // into one repeating figure.
    flowAngle += dt * 0.021;
    const fa = flowAngle + Math.sin(t * 0.043) * 0.30;
    uCurrent.value.set(Math.cos(fa), Math.sin(fa), WAVE_K, t * WAVE_OMEGA);
    // caustics only exist once terrain has uploaded the shared texture
    uCausticsOn.value = U.uCausticsTex.value ? 1 : 0;

    if (isolate) {
      for (const o of ctx.scene.children) {
        if (o === group || o.isLight || o.isCamera) continue;
        // render/underwater.js's fullscreen medium pass and postfx's chain stay,
        // because a plant judged out of the water is not the plant we ship
        o.visible = /underwater|fog|medium|scatter|snow/i.test(o.name || '');
      }
    }

    const cam = ctx.camera.position;
    const dx = cam.x - lastCx, dz = cam.z - lastCz;
    // Vertical movement counts too, now that the near cull tests the camera
    // against each canopy sphere: rising four metres can take you out of a
    // jellyshroom cap without moving a metre horizontally.
    const dy = cam.y - lastCy;
    const moved = Math.sqrt(dx * dx + dz * dz + dy * dy);
    // A teleport (applyShot, or a capture jumping between framings) is the one
    // case where a long frame is the right trade: nothing is being played, and a
    // half-planted forest is a WRONG frame rather than a slow one.
    const teleport = moved > 60;
    if (prime(cam.x, cam.z, teleport ? 1200 : 3.0) > 0) needRefill = true;

    // The refill walks every cached plant in range (10-15k) and re-uploads six
    // instance buffers, so it is throttled to every other frame while the
    // stream is catching up. A one-frame-old field is invisible; doing it twice
    // as often is 1-2 ms of every frame while swimming.
    if (moved > 4 || teleport || ctx.time.frame < 4 || (needRefill && (ctx.time.frame & 1) === 0)) {
      lastCx = cam.x; lastCz = cam.z; lastCy = cam.y;
      needRefill = false;
      refill(cam.x, cam.z, cam.y);
      this.instanceCount = [...pools.values()].reduce((s, p) => s + p.count, 0);
    }
  },

  /**
   * Live surface gains, so the cost of the microstructure can be A/B'd inside
   * ONE process. Measuring it across two captures is worthless on a machine
   * where other agents are rendering at the same time: the same shot measured
   * 25, 61, 91 and 155 fps in four consecutive runs of the same build.
   */
  setSurf(x, y, z, w) {
    uSurf.value.set(x, y, z, w);
    return uSurf.value.toArray();
  },

  /** Debug / measurement hook: what is actually planted right now. */
  stats() {
    const out = { lightPools: _lights.length };
    for (const [k, p] of pools) out[k] = p.count;
    return out;
  },
};
