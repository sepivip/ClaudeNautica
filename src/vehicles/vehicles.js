/**
 * VEHICLES — the Seamoth and the Seaglide.
 *
 * OWNER: the "vehicles" agent.
 *
 * Design notes (the *why*):
 *
 *  - The Seamoth is ONE parametric surface. `surfacePoint(u, theta)` defines an
 *    egg 4.67 m long, and every part of the vehicle that has to line up with
 *    every other part is generated from it: the opaque hull is that surface
 *    masked by NOT-canopy, the glass is the same surface masked by canopy, the
 *    cockpit interior is the same surface inset 75 mm with the winding flipped,
 *    and the canopy rim is a swept section following the exact mask boundary.
 *    Four pieces that can never disagree, because they are one equation. That is
 *    also why the rim reads as a real frame: it sits on the seam it is hiding.
 *
 *  - The interior is EMISSIVE, not lit. core/underwaterMaterial.js multiplies
 *    every shaded pixel by mix(0.06, 1, sunT.b) * uDepthDarken — at 145 m that
 *    is about 0.06, so a cabin lit only by lamps would be black exactly where
 *    the reference (seamoth-cockpit-2.jpg, 145 m) shows white panels at sRGB
 *    ~200. Emissive is exempt from that term, which is correct: cabin light does
 *    not come down the water column. Same reason structures.js pre-multiplies by
 *    its EMIT table.
 *
 *  - For the SAME reason the headlights are boosted by 1/(depth response) each
 *    frame (see `lampBoost`). A SpotLight is ordinary direct lighting, so the
 *    medium's depth term crushes it too; without the correction a 200 m lamp
 *    lands 2 % of its shallow-water value and the beam paints on nothing.
 *    reference/LOOK.md §2 says 15–25 m of visibility *with a light* below 200 m,
 *    so the lamp has to keep working when the sun does not.
 *
 *  - The beams are a real analytic volume, not a card. Each headlight owns a
 *    cone proxy whose fragment shader intersects the view ray with the light
 *    cone, clips the segment against render/underwater.js's published scene
 *    depth texture, and integrates in-scattering along what is left with the
 *    medium's own uwTransmittance. So the shaft is occluded by terrain, gets
 *    shorter as absorption rises, and is genuinely absent above water.
 *
 *  - LOOK.md §3 and §11.11: lamps never cast caustics. Every lamp material and
 *    the beams use caustics: 0.
 *
 *  - The canopy refracts. Not screen-space — the engine's HDR target is MSAA and
 *    cannot be grabbed mid-pass — but physically: the glass bends the view ray
 *    with refract(), evaluates the medium along BOTH the bent and the unbent
 *    ray with the shared uwInscatter, and adds the difference. Because the water
 *    column has a real vertical gradient, that difference is a visible shift
 *    that grows toward the rim, exactly where a curved canopy bends most.
 *
 * Controls
 *   E  enter / exit the Seamoth (docking animation both ways)
 *   F  headlights (Seamoth when piloting, Seaglide otherwise)
 *   Q  deploy / stow the Seaglide
 *   WASD + Space/Shift + mouse   pilot the Seamoth
 *
 * Published API (ctx.get('vehicles')):
 *   piloting            bool — the player is inside the Seamoth
 *   seamoth             {position, quaternion, velocity, depth, power, hull, ...}
 *   seaglide            {active, power, speedScale, fovBonus}
 *   swimSpeedScale()    multiplier player/movement.js should apply to swim speed
 *   swimHandling()      {speedScale, accelScale, fovBonus, drag} for movement.js
 *   playerLocked()      true while the player is inside a vehicle or docking
 *   enter() / exit()    programmatic docking
 *   nearest(v3)         the closest boardable vehicle, or null
 */
import * as THREE from 'three';
import { applyUnderwater, UNDERWATER_PARS } from '../core/underwaterMaterial.js';
import { U, WORLD } from '../core/globals.js';
import { SHOTS } from '../core/shots.js';
import { makeRNG } from '../core/rng.js';

// ============================================================== small math
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
function sstep(a, b, x) { const t = clamp01((x - a) / (b - a || 1e-9)); return t * t * (3 - 2 * t); }
/** Catmull-Rom over a uniform array, clamped at the ends. */
function crom(arr, u) {
  const n = arr.length - 1;
  const f = clamp01(u) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const t = f - i;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
/** Piecewise smoothstep through [x, y] keyframes. */
function keyed(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (x <= b[0]) return lerp(a[1], b[1], sstep(a[0], b[0], x));
  }
  return last[1];
}

// ============================================================== tuning
const SEA = {
  // hull, metres
  z0: -2.35, z1: 2.32,
  rx: [0.00, 0.30, 0.55, 0.75, 0.880, 0.950, 0.965, 0.930, 0.845, 0.700, 0.440, 0.00],
  ry: [0.00, 0.26, 0.48, 0.665, 0.790, 0.860, 0.875, 0.850, 0.780, 0.635, 0.400, 0.00],
  // The nose DROOPS. It used to lift (0.100, 0.130, 0.15), which put the tip of
  // the hull 3.3 deg below the pilot's eyeline — dead centre of frame — and
  // since every longitudinal feature on a lathed body converges at the tip, the
  // canopy rim and both ribs met there too and became the black bar across the
  // middle of every cockpit frame. Dropping the last three stations sends the
  // tip to about 9 deg below, which is also the reference silhouette: the
  // Seamoth's snout points slightly down, it does not point up.
  /**
   * ...and it now droops HARD over the last metre.
   *
   * With the tip only 0.33 m below the eyeline the nose crested at 63 % of frame
   * height, so the pilot's forward view was a solid ridge of hull running up the
   * middle of the picture. seamoth-cockpit-1.jpg is open water down the centre to
   * about 86 % — the Seamoth's console is what fills the bottom of frame, never
   * its own snout. Raking the last three stations to -0.42 puts the tip ~24 deg
   * below the eye, which clears it out of the centre and is also the reference
   * silhouette from outside: the fuselage tapers DOWN into the bow, it does not
   * run level into a point.
   */
  cy: [0.12, 0.10, 0.06, 0.020, -0.010, -0.020, -0.010, 0.015, 0.020, -0.030, -0.175, -0.42],

  // canopy boundary: half-angle from straight up, as a function of z.
  // Tuned against seamoth-cockpit-1/2.jpg: the rim crosses the eyeline at about
  // -12 deg out at the shoulders and dips to about -20 deg over the nose, so the
  // pilot looks DOWN through the front of the bubble and the side rails frame
  // the shot. Getting that relationship backwards is what makes a canopy read
  // as a hole cut in a sphere.
  /**
   * ...and it must not be so wide that there is no opaque hull left to look at.
   * The old profile reached 2.78 rad — 159 deg — through the nose and 78 deg at
   * midships, which meant the canopy owned nearly the whole cross-section: with
   * the engine pods occluding everything past about 87 deg, the painted flank
   * had a two-degree window to be seen through and the vehicle read as a glass
   * egg. Pulled in to 60 deg at midships and 112 deg forward, the shell keeps a
   * 27 deg strip of readable flank on each side while the pilot's forward and
   * lower view stays open — the sill still crosses the frame edge about 30 %
   * below the eyeline, which is where seamoth-cockpit-1.jpg puts it.
   */
  glass: [[-0.34, 0.00], [0.10, 0.86], [0.62, 1.24], [1.05, 1.52], [1.45, 1.80],
    [1.75, 1.98], [2.00, 1.88], [2.20, 1.34], [2.32, 0.72]],

  /**
   * Pilot's eye in BODY space (nose +Z), used for aiming the console at them.
   * Raised 4 cm and moved 6 cm aft of where it was: the whole cockpit read sits
   * on this one point, and the reference puts the nose, the sill and both sonar
   * screens comfortably below the eyeline rather than crowding it.
   */
  eye: new THREE.Vector3(0, 0.32, 0.62),
  /** The same point in VEHICLE space, where the bow is -Z. See buildSeamoth. */
  eyeRoot: new THREE.Vector3(0, 0.32, -0.62),

  // physics
  thrust: 10.6,          // m/s^2 forward
  reverse: 5.2,
  strafe: 5.6,
  vertical: 5.4,
  dragFwd: 0.075,        // quadratic, per metre
  dragLat: 0.46,
  /**
   * Vertical drag used to be 0.40, which is 8.8 g of deceleration at 14 m/s:
   * a sub dropped at the seabed stopped 19.75 m short of it and NOTHING in the
   * game could ever reach the impact-damage path. 0.19 still bleeds a dive
   * (terminal ~4.6 m/s under thrust alone) but lets a nose-down run actually
   * arrive, which is what makes the seabed a hazard rather than scenery.
   */
  dragVert: 0.19,
  linDrag: 0.55,
  buoyancy: 0.0,         // ballasted neutral: it holds the depth you leave it at
  yawRate: 1.25,         // rad/s at full stick
  pitchRate: 0.95,
  angDamp: 2.9,
  bank: 0.62,            // roll per unit yaw rate
  crushDepth: 200,
  /**
   * Battery capacity in cell-units, NOT percent — the dash and the HUD both
   * divide by this.
   *
   * At 100 the measured endurance was 30.4 s: full throttle from the surface
   * flattened the cells at 87.9 m, which is 300 m of travel, is short of the
   * 200 m crush depth, and made the crush damage, the hull stress, the milky
   * canopy and the whole temperature system dead code no player could ever
   * see. 900 buys ~250 s (~2.5 km) at full thrust with the lights on — an
   * expedition rather than a lap of the lifepod — while the drain rates below
   * stay untouched, so the *feel* of the throttle costing you something is
   * unchanged and the crush band is now genuinely reachable.
   */
  maxPower: 900,
  maxHull: 100,
  boardRange: 6.0,
  /** Impact speed (m/s) the hull shrugs off before it starts taking damage. */
  impactFloor: 3.2,
};

/**
 * The yoke pedestal and the apron it stands on, hoisted out of buildSeamoth
 * because `consoleGeometry` now has to land its skirt ON the apron rather than
 * beside it — see the knee valance note there.
 *
 * APRON is the ellipsoid the moulded centre mass is built from, stated once so
 * the geometry that has to meet it can solve against the same numbers instead of
 * being eyeballed against a literal repeated in three places.
 */
const PED_EL = 25 * DEG, PED_D = 0.92;
const PED_Y = SEA.eye.y - Math.sin(PED_EL) * PED_D;
const PED_Z = SEA.eye.z + Math.cos(PED_EL) * PED_D;
const PED_R = 0.072, PED_L = 0.258;
const APRON = {
  c: new THREE.Vector3(0, PED_Y - 0.44, PED_Z + 0.04),
  r: new THREE.Vector3(0.47, 0.25, 0.40),
};
/**
 * The point where a ray from the apron's centre through `p` leaves its surface,
 * plus the outward normal there. Solved in the ellipsoid's own unit space, which
 * is one divide rather than an iterative closest-point and is exact.
 */
const _apA = new THREE.Vector3(), _apB = new THREE.Vector3();
function apronPoint(p, outP, outN) {
  _apA.copy(p).sub(APRON.c).divide(APRON.r);
  const l = _apA.length() || 1e-6;
  _apA.divideScalar(l);
  outP.copy(_apA).multiply(APRON.r).add(APRON.c);
  // gradient of (x/rx)^2+(y/ry)^2+(z/rz)^2 is 2*(x/rx^2, ...), i.e. u / r
  if (outN) outN.copy(_apA).divide(APRON.r).normalize();
  return outP;
}

/**
 * THE CENTRE STACK — the mass the yoke grows out of, and the fix for the
 * crushed-black region that three rounds have now failed to light.
 *
 * The measurement that decides the shape. Raycast through the black crescents on
 * the shipping frame, then read postfx's own AO buffer at the same pixels
 * (`?pfxdebug=1`): the buffer's MEDIAN there is 0 — not small, zero — while the
 * same crop with the AO term ablated reads median 58, which is already inside
 * the reference's range for that surface (seamoth-cockpit-1/2.jpg's darkest
 * console-region cell is 74). The surfaces are lit. `col *= ao` then multiplies
 * them by nothing.
 *
 * Why it is exactly zero, from the estimator in postfx.js:
 *
 *     occ += clamp(1 - |v|^2/R^2) * max(0, dot(v,N) - bias*viewDist*0.004)
 *                                 / (|v|^2 + 0.02)
 *     ao   = max(0, 1 - 3.1 * occ/10)
 *
 * At cockpit range the sample ring clamps in TEXELS, so the disc is 0.137 m
 * wide, and `bias*viewDist*0.004` is 0.010 m. Relief under about 2.3 cm
 * therefore contributes nothing at all, and relief over 0.62 m is cut by the
 * range term — but anything BETWEEN drives occ past the 0.32 that zeroes ao. Our
 * yoke crown is a 7 cm bar standing 0.11-0.27 m proud of everything behind it,
 * i.e. squarely in the middle of that band, and the crescents are its 128 px
 * sample disc. That is why the region is shaped like the yoke.
 *
 * So the yoke must stop being a bar in front of a hole and become the crest of a
 * moulded mass, which is also what both reference plates show: one continuous
 * pale hump filling the bottom centre of frame, running out to each console with
 * no visible joint and no footwell behind it. A ramp — however steep — is free
 * to the estimator, because on a plane dot(v,N) is 0; only STEPS cost anything.
 * This is a plateau at the crown's own height, held flat past the grip horns,
 * then ramped out to the console's fascia foot and skirted forward onto the
 * apron. Nothing in it steps more than about 2 cm.
 */
const GLIDE = {
  speedScale: 1.80,
  // Acceleration added to movement's own thrust. Its cruise settles where
  // aSwim (8.8) balances dragLin*v + dragQuad*v^2, i.e. ~4.0 m/s; +13 lands
  // ~7.2 m/s, comfortably past its 6.5 m/s fin-kick sprint, which is the right
  // relationship — a seaglide should beat swimming flat out and cost power.
  accel: 13.0,
  fovBonus: 6.0,
  maxPower: 100,
  drain: 0.85,
  lampDrain: 0.55,
};

// Pre-multipliers for self-lit surfaces, mirroring structures.js's EMIT table.
// A cockpit at 145 m and a lamp lens at 600 m are both a metre from the eye and
// must not be dimmed by a water column they are not behind.
// `sonar` is far below `screen` because the sonar canvas is now a LIT FIELD
// rather than a dark one (see makeSonar): the same multiplier that made a
// mostly-black texture readable would drive a mostly-emerald one straight
// through the top of the tone curve and out the other side as white.
/**
 * `sonar` is 5.4, not 3.6, and that is a measurement rather than a preference.
 *
 * Point-sampled at matched positions, seamoth-cockpit-1.jpg's sonar pane reads
 * (3,173,98) — luminance 132 with the red channel essentially off — while ours
 * came back (34,86,45), luminance 58. It is the brightest object in the
 * reference cockpit and it was rendering at 44 % of it, which is the difference
 * between an instrument that is switched on and one that is switched off.
 *
 * Calibrated with `--params=ao=0`, NOT against the shipping frame, and that
 * distinction is the whole reason this number is 4.8 rather than 7. postfx's
 * SSAO multiplies this entire cockpit down by 5-10x (see the report — the
 * estimator's world-space radii are authored for terrain and saturate on
 * anything 0.5-1.2 m from the lens), so tuning any interior level against the
 * frame as it currently ships means tuning against a bug and overshooting by
 * that factor the moment it is fixed. At 4.8 the pane measures 193 against the
 * reference's 196 with AO off; with AO on it is still an improvement, but the
 * frame it is right in is the corrected one.
 */
const EMIT = { cabin: 1.0, screen: 3.2, sonar: 4.8, lens: 21.0, glow: 6.0, strip: 2.2 };
/**
 * INTERIOR PHOTOMETRY, in one place and LIVE.
 *
 * Every previous round tuned the cockpit by editing an emissive constant, taking
 * a fifteen-minute capture, and looking at it. That is why the levels drifted:
 * each family was moved on its own against a frame where the other five had also
 * moved, and nobody could see the resulting HISTOGRAM until the round was over.
 *
 * The measurement that forced this: masked against a render with the vehicle
 * hidden, 80.5 % of this shot's lower third IS the cockpit and the remaining
 * 19.5 % is near-black water (median 12). So "the lower third's histogram" and
 * "the interior's histogram" are the same object, and the interior was a
 * top-heavy plateau — with postfx's SSAO ablated, half the vehicle's pixels sat
 * above 111 and a quarter above 204, against seamoth-cockpit-1/2.jpg's p75 of
 * 97-116. The frame was not under-lit, it was over-lit and un-modelled: one flat
 * fill term worth more than everything else put together.
 *
 * These six numbers ARE the interior's exposure, they are read every frame, and
 * `api.cab` publishes them so a calibration pass can sweep all six in ONE boot
 * instead of spending a boot per constant.
 *
 *   fill    the flat normal-weighted cabin fill (`cabinFill`)
 *   lining  the moulded shell: tub, console fascia and crest, coaming top
 *   dark    the floor under the fittings that are meant to READ dark — the
 *           coaming's inboard flank, the bezels, the seat. Raising this while
 *           `fill` falls is what compresses the range instead of dimming it.
 *   panel   the instruments: both sonar panes and the dash readout
 *   guide   the visible light guides and button rings
 *   emit    the eight analytic cabin emitters (`vehCabIrradiance`)
 *   bounce  the constant interior bounce — see its own note below
 */
const CAB = {
  /**
   * The shipping values, and every one of them came off the histogram rather
   * than off an opinion. Swept in one boot against the lower third of the
   * seamoth-cockpit framing, measured twice per point, both with postfx's SSAO
   * live and with it ablated (`postfx.k.ao = 0`).
   *
   *   fill   1.00 -> 0.42   the flat term was the plateau; it is now a third of
   *                         the interior's light instead of nearly all of it
   *   lining 1.00 -> 0.50   with it
   *   dark   1.00 -> 1.70   the coaming flank, the bezels and the seat hold
   *                         their level while everything above them comes down,
   *                         which is what closes the range rather than dimming it
   *   guide  1.00 -> 0.80   the light guides no longer have to carry the room
   *   emit   1.00 -> 0.55   the 1/r^2 emitters were blowing the yoke crown to
   *                         240 from 15 cm away; they model now, they do not light
   *   bounce 0    -> 3.40   the term that did not exist. See its note below.
   *
   * WHAT IT BUYS, on the lower third, A/B'd in ONE boot by writing this table
   * live — same frame, same seed, same everything else — each leg run twice and
   * reproducing to 0.1-0.5 %. Reference plates: seamoth-cockpit-1/2.jpg at
   * p25 26.8-29.6 / median 68.1-73.9 / p75 97-116 / p90 135.7-139.1.
   *
   *   shipping frame  p90     175.2 -> 145.4   -17 %, into the 130-145 band
   *                   p75      98.1 ->  79.9   -19 %
   *                   median   36.3 ->  32.0   -12 %  (still far short of 60-90)
   *                   crushed   5.87 %-> 5.97 %  held, inside run-to-run noise
   *   SSAO ablated    p25      24.1 ->  30.3   +26 %, ON the reference
   *                   median   72.1 ->  82.5   +14 %, inside the 60-90 band
   *                   p75     203.2 -> 178.7   -12 %
   *                   p90     214.1 -> 195.6    -9 %  (reference 136-139)
   *
   * WHAT IT CANNOT BUY, and the reason is not in this file. Ablating postfx's
   * SSAO on the SAME frame moves this crop's median from 32.0 to 82.5 and its
   * p25 from 13.7 to 30.3 — a factor of 2.6 and 2.2 — so the two frames want
   * opposite interior levels and no single one lands both p90s in 130-145.
   * Measured: an interior tuned to put the ABLATED p90 at 145 puts the shipping
   * p90 at 100 and takes the crushed fraction from 6 % to 11 %. This setting is
   * the one that moves the shipping frame toward the reference on every axis it
   * moves at all, and regresses none of them outside noise.
   */
  fill: 0.42, lining: 0.50, dark: 1.70, panel: 1.00, guide: 0.80,
  /**
   * emit 0.55 -> 0.90, and this number is a RECALIBRATION, not a look change.
   *
   * `vehCabIrradiance` was re-authored this round (see the note on it). Swept in
   * one boot against the previous build's own capture, 0.90 puts every statistic
   * of the lower third back on it: p10 4.2 vs 4.3, p25 14.5 vs 14.0, median 34.1
   * vs 34.5, p75 69.9 vs 71.4, p90 130.8 vs 131.7, p99 191.2 vs 191.2, crushed
   * 6.27 % vs 6.19 %, G/B 0.850 vs 0.856. That the whole distribution lands with
   * ONE scalar is the evidence the new panel term has the same shape as the old
   * one and only differed in level.
   *
   * ...and then 0.90 -> 1.30, which is a CORRECTION, not a gain.
   *
   * With the footwell rebuilt (see STACK) the interior's own p90 fell to 127.3,
   * BELOW the 130-145 band the plates sit in, because the geometry that used to
   * carry the bright end was a near-lens surface that has gone. Swept in one
   * boot: 1.30 puts p90 at 134.9 against seamoth-cockpit-2.jpg's 135.7 and
   * -1.jpg's 139.1, and p10 at 7.6 against their 9.7-10.7. It is an emitter
   * term — eight analytic panel lights with a 1/r^2 falloff — not a post effect;
   * bloom is untouched and this module cannot reach it. Pushed further it keeps
   * buying crushed fraction (bounce 7.0 reaches 0.95 %) but at p90 184.6, which
   * is exactly the trade the brief forbids, so it stops here.
   */
  emit: 1.30,
  /**
   * BOUNCE — the term that was missing, and the reason the cockpit could only
   * ever be blown or crushed.
   *
   * Every other term here has a shape: `fill` is normal-weighted, `emit` falls
   * off as 1/r^2, each material's own emissive is modulated by its albedo map.
   * None of them puts a FLOOR under a surface that faces away from everything.
   * But the Seamoth's cabin is a 1.4 m white box with a lamp in it, and in a box
   * that small and that pale the multiply-scattered component is very nearly
   * uniform — it is most of what you actually see in a real cockpit's recesses.
   *
   * Measured, that absence is what pinned the histogram. With postfx's SSAO
   * ablated the interior ran p25 53 / median 123 / p75 206 against
   * seamoth-cockpit-1/2.jpg's 27 / 71 / 106, and dimming it to bring the p75
   * down took the p25 with it (at fill 0.42: p25 38, p75 129) — the whole
   * distribution slid instead of compressing, because every term in it is
   * multiplicative. A constant added to a scene-referred image before an ACES
   * curve lifts the dark end far more than the light end in display terms, so
   * this is the one lever that closes the range from BELOW.
   *
   * It is NOT a handle on the crushed fraction, and round 13 proved that by
   * measuring postfx's AO buffer directly (`?pfxdebug=1`): over the crushed
   * region its median is 0, not 0.05. `col *= ao` then annihilates the pixel
   * whatever this term is worth. See the STACK note — that region is geometry,
   * and the only fix inside this module was to stop making the shape that
   * saturates the estimator.
   */
  bounce: 3.40,
  rev: 0,
};
/**
 * The cabin's flat fill spectrum, in linear radiance, before `fill`.
 *
 * Sampled at matched positions on seamoth-cockpit-1.jpg the reference console
 * face reads (59,108,142) — G/B 0.76 — where ours came back G/B 0.92, i.e. a
 * neutral grey-teal box against a distinctly BLUE one. ACES walks a bright
 * colour toward white, so the source has to be bluer than the target by about
 * as much as the curve will take out of it.
 */
const CAB_FILL_C = [2.60, 3.36, 4.16];
/** The bounce spectrum: lamp light off white plastic, so cooler still. */
const CAB_BOUNCE_C = [0.34, 0.50, 0.72];
const cabAmb = { value: new THREE.Color(0, 0, 0) };
/**
 * The coaming's share of it.
 *
 * The sill is the one cabin material with an OUTBOARD face — it is the canopy
 * rim, and half of it is in the ocean. A cabin bounce term applied to it at full
 * strength would light the outside of the vehicle from inside, which shows up on
 * the exterior framing as a glowing ring round the canopy. 0.45 is the fraction
 * of its surface that faces into the tub.
 */
const cabAmbRim = { value: new THREE.Color(0, 0, 0) };
/**
 * Materials whose authored emissive is scaled by one of the CAB families,
 * registered as they are built so the authored value stays the source of truth
 * and the multiplier is never baked in.
 */
const cabTune = [];
let _cabRev = -1;
function registerCab(mat, group) {
  cabTune.push({ mat, group, base: mat.emissive.clone() });
  return mat;
}
/** Re-apply the family multipliers. Cheap, and only when a level actually moved. */
function applyCabLevels() {
  if (_cabRev === CAB.rev) return;
  _cabRev = CAB.rev;
  for (let i = 0; i < cabTune.length; i++) {
    const e = cabTune[i];
    e.mat.emissive.copy(e.base).multiplyScalar(CAB[e.group] ?? 1);
  }
}


/**
 * Surface microstructure per material family — see `surfaceInject`.
 *
 * These are NOT core's presets. core/surface.js is authored for terrain-scale
 * objects: `hull` there is scale 2.2 m, which on a 4.7 m vehicle puts barely two
 * cycles of the base octave across the whole fuselage and reads as a stain
 * rather than as a material. Everything here is scaled to the size of the part
 * it sits on — 1.15 m of paint, 0.55 m of moulding, 0.22 m of seat vinyl — and
 * the amplitudes are pulled DOWN from core's, because the measurement that
 * started this says we already carry 4.7x the reference's local contrast. The
 * job is to move signal from hard-edged decal into low-amplitude broadband, not
 * to add signal.
 */
const SURF = {
  paint:   { grain: 0.072, wear: 0.42, streak: 0.34, scale: 1.15 },
  pod:     { grain: 0.062, wear: 0.36, streak: 0.30, scale: 0.80 },
  fitting: { grain: 0.055, wear: 0.34, streak: 0.26, scale: 0.55 },
  rim:     { grain: 0.040, wear: 0.28, streak: 0.16, scale: 0.42 },
  /**
   * The interior amplitudes are the ones that had to come UP.
   *
   * Measured at matched angular sampling — the reference cockpit frame is 4K, so
   * its crop must be resampled to our pixel scale before a laplacian means the
   * same thing — seamoth-cockpit-2.jpg's console face carries detailRMS 5.5-8.0
   * and tileContrast 14.8-19.8. Ours came back 2.1 and 10.6: the cockpit was not
   * carrying too much signal, it was carrying too little of the broadband kind
   * and all of what it had in hard strokes. Hence: line art down (see
   * consoleTexture / cabinTexture) and grain up.
   */
  lining:  { grain: 0.082, wear: 0.26, streak: 0.09, scale: 0.62 },
  molding: { grain: 0.092, wear: 0.30, streak: 0.07, scale: 0.34 },
  vinyl:   { grain: 0.098, wear: 0.22, streak: 0.04, scale: 0.18 },
};

/**
 * Per-frame downwelling skylight radiance on the exterior shell, written by
 * `updateSkylight()` and consumed by `applyUnderwaterSkylight()`. Declared here
 * because the materials capture it at build time and it must stay the same
 * uniform object for the lifetime of the module.
 */
const skyFill = { value: new THREE.Color(0, 0, 0) };
/**
 * The same idea one room in: daylight that reaches the cockpit lining through
 * the canopy, plus a floor from the cabin lamp so the tub never goes to black.
 */
const cabinFill = { value: new THREE.Color(0, 0, 0) };
/**
 * The sill's own fill, and it exists because the sill is the one part of this
 * vehicle that is lit from BOTH rooms.
 *
 * The coaming's outboard top face looks up into the water column; its inboard
 * face looks down into a lit cabin 40 cm from the pilot's eye. Riding it on
 * skyFill alone gave it the exterior's level everywhere, and measured with a
 * vertical scan through the rim the whole section came back flat at 9-16
 * luminance — a black noodle. seamoth-cockpit-1.jpg's runs 38-42 across its top
 * face and 10-16 on the inboard flank, i.e. a 3:1 step, and that step is the
 * only thing that tells you the rail is a solid object rather than a line drawn
 * on the picture. Mixing the two fills gives it the interior's level; `up = 1`
 * on applyUnderwaterSkylight turns that level into the step, because the
 * normal-weighted term already spans 0.18..1.73 — 3.05:1, which is the measured
 * ratio almost exactly.
 */
const rimFill = { value: new THREE.Color(0, 0, 0) };
/**
 * Chromaticity filter applied to DIRECT light landing on the exterior shell.
 *
 * three's DirectionalLight is spectrally white at every depth, and core's medium
 * only ever multiplies the shaded result by an ACHROMATIC depth term — so the
 * sun's contribution to the hull kept a full red channel 45 m down, which is the
 * one thing LOOK.md rule 1 says can never happen. This carries the same
 * per-channel Beer-Lambert the ambient term uses, normalised on its own peak so
 * it changes the HUE of the direct light without changing its level. Written by
 * updateSkylight(), consumed at <lights_fragment_end>.
 */
const dirFilter = { value: new THREE.Color(1, 1, 1) };

// ============================================================== hull surface
/**
 * The eight analytic cabin emitters.
 *
 * Each one is a small PANEL — a light guide, a screen, the overhead strip — so
 * it carries its own normal and radiates into the hemisphere in front of it. A
 * point light cannot do that: a strip 3 cm behind a bezel would light the bezel
 * and the aft bulkhead as brightly as the dashboard they are mounted on, and the
 * reference cockpit is plainly lit from above and in front — brightest on the
 * dashboard, dimmer up under the coaming, dimmest in the footwell.
 *
 * `w` in uVehCabP is a softening radius SQUARED, added to r^2 so a fragment two
 * centimetres off a guide does not divide by nothing.
 */
const CAB_LIGHTS = 8;
const cabLightPos = { value: [] };   // xyz world position, w = softening r^2
const cabLightCol = { value: [] };   // radiant intensity, already colour-weighted
const cabLightAxis = { value: [] };  // world-space panel normal
for (let i = 0; i < CAB_LIGHTS; i++) {
  cabLightPos.value.push(new THREE.Vector4(0, 0, 0, 1));
  cabLightCol.value.push(new THREE.Vector3(0, 0, 0));
  cabLightAxis.value.push(new THREE.Vector3(0, 1, 0));
}
/**
 * Guarded with #ifndef, and namespaced.
 *
 * applyUnderwaterSkylight injects this into every cabin material, and shared
 * pars included twice REDECLARE every uniform in them — which is a link failure,
 * and a link failure here draws nothing and reports nothing. See the brief.
 */
const CAB_LIGHT_PARS = /* glsl */ `
#ifndef VEH_CAB_LIGHTS
#define VEH_CAB_LIGHTS
uniform vec4 uVehCabP[${CAB_LIGHTS}];
uniform vec3 uVehCabC[${CAB_LIGHTS}];
uniform vec3 uVehCabA[${CAB_LIGHTS}];
vec3 vehCabIrradiance(vec3 wp, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${CAB_LIGHTS}; i++) {
    vec3 d = uVehCabP[i].xyz - wp;
    float r2 = dot(d, d);
    vec3 l = d * inversesqrt(max(r2, 1e-8));
    // receiver cosine x emitter cosine: the panel only radiates forward, which
    // is what stops a guide under the coaming lighting the coaming above it
    float nl = max(dot(n, l), 0.0);
    float el = max(-dot(uVehCabA[i], l), 0.0);
    sum += uVehCabC[i] * (nl * el / (r2 + uVehCabP[i].w));
  }
  return sum;
}
#endif
`;

const _sp = new THREE.Vector3();
function surfacePoint(u, th, out) {
  const p = out || _sp;
  const z = lerp(SEA.z0, SEA.z1, clamp01(u));
  const rx = crom(SEA.rx, u), ry = crom(SEA.ry, u), cy = crom(SEA.cy, u);
  p.set(rx * Math.sin(th), cy + ry * Math.cos(th), z);
  return p;
}
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3();
const _du = new THREE.Vector3(), _dv = new THREE.Vector3();
function surfaceNormal(u, th, out) {
  const n = out || new THREE.Vector3();
  const eu = 0.004, ev = 0.006;
  const uu = clamp(u, eu, 1 - eu);
  surfacePoint(uu - eu, th, _pa); surfacePoint(uu + eu, th, _pb);
  _du.copy(_pb).sub(_pa);
  surfacePoint(uu, th - ev, _pa); surfacePoint(uu, th + ev, _pc);
  _dv.copy(_pc).sub(_pa);
  // dU x dV, in that order: at the spine dU is +Z and dV is +X, and Z x X = +Y,
  // which is the outward normal. The other order points the whole hull inside
  // out — it lights as if lit from within and `inset` pushes the cockpit tub
  // out through the shell instead of into it.
  n.copy(_du).cross(_dv);
  if (n.lengthSq() < 1e-12) n.set(0, 0, u < 0.5 ? -1 : 1);
  return n.normalize();
}
/**
 * Tessellate a band of the hull surface between two angular limits that are
 * functions of u.
 *
 * The obvious way to cut a canopy out of a shell is a uniform grid plus a
 * per-quad mask, and it does not work: the seam comes out as a stair-step one
 * quad deep, and the opaque hull, the glass and the inset cockpit tub each show
 * their own copy of it. Widening the rim rail only hides two of the three.
 *
 * Parametrising the SECOND axis by the boundary instead makes the seam exact by
 * construction — every band's first and last rings lie on the curve — and it
 * spends no triangles on quads that get thrown away.
 */
function bandGeometry({ thetaLo, thetaHi, uMin = 0, uMax = 1, uSegs = 92, vSegs = 44,
  inset = 0, flip = false }) {
  const nv = (uSegs + 1) * (vSegs + 1);
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  const uvs = new Float32Array(nv * 2);
  // Normalised distance across the band: 0 at its middle, 1 at either boundary.
  // The canopy's boundary IS the sill seam, so this is the only cheap way for the
  // glass shader to know where the rim is — the angular uv cannot say, because
  // the boundary is a function of u.
  const edge = new Float32Array(nv);
  const idx = [];
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  const insetFn = typeof inset === 'function' ? inset : () => inset;
  for (let i = 0; i <= uSegs; i++) {
    const u = lerp(uMin, uMax, i / uSegs);
    const t0 = thetaLo(u), t1 = thetaHi(u);
    // Inset may vary along u. It has to: the surface radius goes to zero at the
    // nose, so a constant 75 mm offset turns inside out there and produced a
    // hard-edged white blob sitting in the exact centre of every cockpit frame.
    const ins = insetFn(u);
    for (let j = 0; j <= vSegs; j++) {
      const th = lerp(t0, t1, j / vSegs);
      surfacePoint(u, th, P);
      surfaceNormal(u, th, N);
      if (ins) P.addScaledVector(N, -ins);
      const k = i * (vSegs + 1) + j;
      pos[k * 3] = P.x; pos[k * 3 + 1] = P.y; pos[k * 3 + 2] = P.z;
      const s = flip ? -1 : 1;
      nor[k * 3] = N.x * s; nor[k * 3 + 1] = N.y * s; nor[k * 3 + 2] = N.z * s;
      uvs[k * 2] = u; uvs[k * 2 + 1] = th / TAU + 0.5;
      edge[k] = Math.abs(2 * (j / vSegs) - 1);
    }
  }
  for (let i = 0; i < uSegs; i++) {
    for (let j = 0; j < vSegs; j++) {
      const a = i * (vSegs + 1) + j, b = a + vSegs + 1;
      if (flip) idx.push(a, b + 1, b, a, a + 1, b + 1);
      else idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** The canopy half-angle at a given u, optionally dilated. */
const glassEdge = (u, bias = 0) =>
  clamp(keyed(SEA.glass, lerp(SEA.z0, SEA.z1, u)) + bias, 0, Math.PI);

/** Opaque shell: everything outside the canopy, on both sides of the keel. */
function shellBands(opts) {
  const bias = opts.bias || 0;
  return mergeGeos([
    bandGeometry({ ...opts, thetaLo: (u) => glassEdge(u, bias), thetaHi: () => Math.PI }),
    bandGeometry({ ...opts, thetaLo: () => -Math.PI, thetaHi: (u) => -glassEdge(u, bias) }),
  ]);
}

/**
 * The exact canopy seam, as a closed 3D loop lying on the shell, with the
 * surface normal at every point. The rim rail is swept along this and needs the
 * normals: a parallel-transported frame twists as the loop runs round the nose,
 * which lifts the rail off the hull exactly where it is supposed to be hiding
 * the mask's stair-step.
 */
function canopyBoundary(steps = 116, offset = 0.010) {
  const pts = [], nors = [], zs = [];
  const add = (z, th) => {
    const u = clamp01((z - SEA.z0) / (SEA.z1 - SEA.z0));
    const p = surfacePoint(u, th, new THREE.Vector3());
    const n = surfaceNormal(u, th, new THREE.Vector3());
    pts.push(p.addScaledVector(n, offset));
    nors.push(n);
    zs.push(z);
  };
  const zA = SEA.glass[0][0], zB = SEA.glass[SEA.glass.length - 1][0];
  for (let i = 0; i <= steps; i++) add(lerp(zA, zB, i / steps), keyed(SEA.glass, lerp(zA, zB, i / steps)));
  for (let i = steps - 1; i > 0; i--) add(lerp(zA, zB, i / steps), -keyed(SEA.glass, lerp(zA, zB, i / steps)));
  return { points: pts, normals: nors, zs };
}

/**
 * Sweep a 2D section along a polyline. Section x runs along the given normal's
 * in-surface perpendicular and section y along the normal itself, so a rail
 * swept over a shell lies flat on it. Without explicit normals it falls back to
 * parallel transport, which is right for a free-standing tube.
 */
function sweep(points, section, closed = true, normals = null, scales = null) {
  const n = points.length;
  const m = section.length;
  const pos = [], nor = [], uvs = [], idx = [];
  const T = new THREE.Vector3(), Nn = new THREE.Vector3(), B = new THREE.Vector3();
  const prevN = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const sc = scales ? scales[i] : 1;
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    T.copy(b).sub(a);
    if (T.lengthSq() < 1e-10) T.set(0, 0, 1);
    T.normalize();
    if (normals) {
      Nn.copy(normals[i]).addScaledVector(T, -normals[i].dot(T));
      if (Nn.lengthSq() < 1e-8) Nn.copy(normals[i]);
      Nn.normalize();
    } else {
      // parallel transport: project the previous normal onto the new normal plane
      Nn.copy(prevN).addScaledVector(T, -prevN.dot(T));
      if (Nn.lengthSq() < 1e-8) {
        Nn.set(0, 1, 0).addScaledVector(T, -T.y);
        if (Nn.lengthSq() < 1e-8) Nn.set(1, 0, 0).addScaledVector(T, -T.x);
      }
      Nn.normalize();
    }
    prevN.copy(Nn);
    B.copy(T).cross(Nn).normalize();
    for (let j = 0; j < m; j++) {
      const s = section[j];
      tmp.copy(p).addScaledVector(B, s[0] * sc).addScaledVector(Nn, s[1] * sc);
      pos.push(tmp.x, tmp.y, tmp.z);
      // section normal, carried in the same frame
      const sn = section[(j + 1) % m], sp = section[(j - 1 + m) % m];
      const dx = sn[0] - sp[0], dy = sn[1] - sp[1];
      tmp.set(0, 0, 0).addScaledVector(B, dy).addScaledVector(Nn, -dx).normalize();
      nor.push(tmp.x, tmp.y, tmp.z);
      uvs.push(i / (n - 1), j / m);
    }
  }
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i0 = i * m, i1 = ((i + 1) % n) * m;
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      idx.push(i0 + j, i1 + j, i1 + j1, i0 + j, i1 + j1, i0 + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Rounded rectangle section, for rails and struts. */
function boxSection(w, h, r, seg = 4) {
  const pts = [];
  const cx = w * 0.5 - r, cy = h * 0.5 - r;
  const corners = [[cx, cy, 0], [-cx, cy, Math.PI * 0.5], [-cx, -cy, Math.PI], [cx, -cy, Math.PI * 1.5]];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI * 0.5) * (i / seg);
      pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
  }
  return pts;
}
/**
 * Chamfered slab section, for the canopy sill.
 *
 * The reference sill is a broad slab with real thickness and a clean engineered
 * sweep — you can see the flat top face, the chamfer down its outboard edge and
 * the shadow line under it. A rounded tube gives you none of those, which is why
 * the old rim read as a "wobbly noodle": it had no plane anywhere on it for the
 * light to break across, so the only shading cue was the silhouette.
 *
 * x runs across the hull surface, y along its normal. Wound clockwise so the
 * sweep's own normal derivation points outward.
 */
function slabSection(w, h, c) {
  const x = w * 0.5, y = h * 0.5;
  return [
    [x, -y + c * 0.8],
    [x, y - c],
    [x - c, y],
    [-x + c, y],
    [-x, y - c],
    [-x, -y + c * 0.8],
    [-x + c * 0.8, -y],
    [x - c * 0.8, -y],
  ];
}
function circleSection(r, seg = 10) {
  const pts = [];
  for (let i = 0; i < seg; i++) { const a = TAU * i / seg; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return pts;
}

/** Minimal geometry merge — avoids depending on three/examples. */
/**
 * Merge a list of geometries into one buffer.
 *
 * It carries a COLOUR attribute when any input has one, and fills the slice of
 * every input that does not with 1. That is not a convenience: consoleMat is the
 * one material here with `vertexColors`, and a merged geometry with no `color`
 * attribute leaves WebGL handing the shader the default attribute (0,0,0,1). The
 * console then multiplies its entire albedo by zero, which kills the cabin fill,
 * the bounce and the emitters all at once and leaves only the raw emissive map —
 * a whole console 3x under, unresponsive to every lighting knob, and then taken
 * to literal black by postfx's AO. Measured that way: median 26 against 74 with
 * the AO ablated on both.
 */
function mergeGeos(list) {
  let vTotal = 0, iTotal = 0, anyColor = false;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    if (g.attributes.color) anyColor = true;
  }
  const pos = new Float32Array(vTotal * 3), nor = new Float32Array(vTotal * 3);
  const uvs = new Float32Array(vTotal * 2);
  const col = anyColor ? new Float32Array(vTotal * 3).fill(1) : null;
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, nAt = g.attributes.normal, uvAt = g.attributes.uv;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (nAt) nor.set(nAt.array.subarray(0, p.count * 3), vo * 3);
    if (uvAt) uvs.set(uvAt.array.subarray(0, p.count * 2), vo * 2);
    if (col && g.attributes.color) {
      col.set(g.attributes.color.array.subarray(0, p.count * 3), vo * 3);
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; }
    else { for (let i = 0; i < p.count; i++) idx[io++] = i + vo; }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
function xform(g, { pos, rot, scale }) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
  m.compose(new THREE.Vector3(...(pos || [0, 0, 0])), q,
    new THREE.Vector3(...(scale || [1, 1, 1])));
  g.applyMatrix4(m);
  return g;
}

const STACK = {
  /**
   * The crest sits ON the crown's own axis line, 19 mm under its top, so the
   * yoke EMERGES from the hump instead of hovering over a shelf. The previous
   * shape had a flat lip plate beside the bar with its normal pointing straight
   * up at it: `dot(v,N)` there is the bar's full 0.144 m of relief and the
   * estimator returned 2.6 per sample against the 0.32 that zeroes ao. On a
   * convex hump the normal tilts away from the crest, the crown falls below the
   * local horizon, and dot goes to zero on its own — no lighting involved.
   */
  crest: -0.088,
  crestZ: PED_Z - 0.045,
  /**
   * The outboard ramp starts INSIDE the crown's span (its ends are at 0.201) and
   * finishes ON the console's own fascia foot, which is at x = 0.208. Running it
   * out to 0.325 at a fixed z put the ridge 0.166 m in FRONT of the console
   * valance instead of merging with it — measured by raycast, and the crushed
   * band simply moved onto the valance behind the ridge.
   */
  x0: 0.205, x1: 0.250,
  /**
   * How far outboard the shelf runs — separate from the RAMP's end, because past
   * x1 the ridge simply IS the console's fascia foot, 18 mm under it.
   *
   * 18 mm is the number that matters: postfx's estimator subtracts
   * `uBias * viewDist * 0.004` = 10 mm at this range and divides by
   * (separation^2 + 0.02), so relief under about 23 mm cannot occlude at all.
   * A shelf that tucks under the dashboard by less than that is invisible to it,
   * where the 0.23 m trough it replaces was squarely in the band that goes to
   * zero. It is also the reference silhouette: seamoth-cockpit-1/2.jpg show one
   * continuous pale moulded mass from the yoke out to each console with a shadow
   * LINE under the dashboard, not a trench behind it.
   */
  xMax: 0.44,
  /**
   * Cross-section as (dy, dz) from the crest, forward negative.
   *
   * Forward of the crest it steepens continuously to 57 deg and lands on the
   * apron. Aft it must stay SHALLOWER than the sightline — 26.5 deg from this
   * eye — or the pilot looks straight over the crest into the tub 0.7 m behind,
   * which is the same step one station further back.
   */
  sect: [
    [0.00, -0.235, -0.250, 1],
    [0.16, -0.120, -0.175, 0],
    [0.34, -0.030, -0.082, 0],
    [0.50, 0.000, 0.000, 0],
    [0.68, -0.040, 0.170, 0],
    [0.84, -0.115, 0.390, 0],
    [1.00, -0.215, 0.620, 0],
  ],
};
/**
 * Where the hump's crest is at |x|: a plateau at the crown's height across the
 * yoke, then a ramp that lands ON the console's fascia foot.
 *
 * `foot` is consoleGeometry's own Fa polyline, so the two surfaces meet by
 * construction rather than by a literal that has to be re-tuned every time the
 * console moves. Below the console's inboard end there is no console to meet, so
 * the curve is clamped to its inboard station.
 */
const _stF = new THREE.Vector3();
function stackFoot(ax, foot, out) {
  const n = foot.length;
  // Fa runs OUTBOARD (large x) to inboard (small x); walk it to bracket ax
  let i = n - 1;
  while (i > 0 && Math.abs(foot[i - 1].x) < ax) i--;
  if (i >= n - 1) return out.set(ax, foot[n - 1].y, foot[n - 1].z);
  const a = foot[i], b = foot[i - 1];
  const t = clamp01((ax - Math.abs(a.x)) / (Math.abs(b.x) - Math.abs(a.x) || 1e-6));
  return out.set(ax, lerp(a.y, b.y, t), lerp(a.z, b.z, t));
}
function stackRidge(ax, foot, out) {
  stackFoot(ax, foot, _stF);
  const s = sstep(STACK.x0, STACK.x1, ax);
  return out.set(ax, lerp(STACK.crest, _stF.y - 0.018, s),
    lerp(STACK.crestZ, _stF.z, s));
}
/**
 * A point on the hump. `v` runs 0 at the front skirt foot to 1 at the aft edge,
 * 0.5 on the crest; the section is interpolated linearly between its rows, which
 * is enough because the rows themselves are the curvature.
 */
const _stP = new THREE.Vector3(), _stQ = new THREE.Vector3();
function stackPoint(x, v, foot, out) {
  const S = STACK.sect;
  let i = 0;
  while (i < S.length - 2 && v > S[i + 1][0]) i++;
  const f = clamp01((v - S[i][0]) / (S[i + 1][0] - S[i][0] || 1));
  const dy = lerp(S[i][1], S[i + 1][1], f), dz = lerp(S[i][2], S[i + 1][2], f);
  stackRidge(Math.abs(x), foot, _stP);
  out.set(x, _stP.y + dy, _stP.z + dz);
  if (S[i][3] && f < 0.5) {
    // the front skirt foot lands ON the apron, so the two masses share a
    // surface rather than stepping across the gap between them
    apronPoint(out, _stQ, null);
    out.lerp(_stQ, 0.85 * (1 - 2 * f));
  }
  return out;
}
/**
 * The hump as one lofted skin per side.
 *
 * Only the top is ever seen — the pilot's eye is 0.4 m above the crest — so a
 * closed volume would only add a silhouette edge below the frame's bottom margin
 * for the estimator to find.
 */
function centreStackGeometry(side, foot) {
  const J = 24, R = 12;
  const pts = [], uvs = [], idx = [];
  const q = new THREE.Vector3();
  for (let j = 0; j <= J; j++) {
    const ax = (j / J) * STACK.xMax;
    for (let r = 0; r <= R; r++) {
      const v = r / R;
      stackPoint(side * ax, v, foot, q);
      pts.push(q.x, q.y, q.z);
      // consoleTexture's own v: the hump is the same moulding as the console
      // face, so it takes the pale panel band, not the navy skirt.
      uvs.push(0.18 + 0.64 * (j / J), 0.30 + 0.34 * v);
    }
  }
  const W = R + 1;
  for (let j = 0; j < J; j++) {
    for (let r = 0; r < R; r++) {
      const a = j * W + r, b = a + W;
      if (side > 0) idx.push(a, b, b + 1, a, b + 1, a + 1);
      else idx.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The pilot's console, authored in EYE-RELATIVE SPHERICAL COORDINATES.
 *
 * This is the shape that makes seamoth-cockpit-1.jpg read as a cockpit, and it
 * cannot be derived from the hull: measured off the reference, the port console's
 * crest runs from 12 deg off-axis / 10 deg below the eyeline at its inboard end
 * out to about 50 deg / 17 deg at the frame edge — a point 23 cm inboard and only
 * 18 cm below the eye at a metre. Our cockpit lining is the hull's own wall, which
 * at that station is 70 cm away and 25 deg lower, so no amount of texturing on it
 * could put a surface where the reference has one. The Seamoth's consoles are
 * moulded structures standing inboard of the wall, so that is what these are.
 *
 * Authoring them by bearing rather than by body coordinates means the layout is
 * stated in the same units the reference was measured in, and it stays correct if
 * the seat ever moves again.
 *
 * Returns { face, crest } — the white moulding and the dark cap that tops it, so
 * the caller can merge each into the mesh that already carries that material.
 */
/**
 * ...and it now has a FASCIA: an iso-distance face that looks the pilot in the
 * eye, which is where the instruments live.
 *
 * The skirt used to drop straight down from the crest at constant z, so the
 * sonar bezel — placed on its own bearing 24 deg below the eyeline — floated
 * 8.4 cm in front of it with nothing between. Two things came out of that gap.
 * Visually it is why the screens read as plates hanging in the dark rather than
 * as instruments set into a dashboard. Measurably it is the black L: postfx's
 * SSAO estimator divides by (separation^2 + 0.02) and is un-biased at close
 * range, so an 8 cm step at 1 m evaluates to occ = 1.84 per sample against the
 * 0.65 it takes to reach ao = 0, and the halo is 128 px wide because the sample
 * radius is clamped in TEXELS. (The estimator is core's and the fix belongs
 * there — see the report — but a 1.4 cm step instead of an 8.4 cm one is inside
 * its distance-scaled bias either way, and a recessed instrument is what the
 * reference has.)
 *
 * `D[i]` is the drop direction: straight down, with the component along the
 * eye-ray projected out. That makes the fascia perpendicular to the sightline —
 * A is 1.024 m from the eye and its fascia foot 1.077 m — so a bezel lying flat
 * on it is flat to the pilot as well, and can be flush.
 */
function consoleGeometry(side) {
  const N = 18;
  const A = [], B = [], C = [], Fa = [], Dd = [], W = [];
  const a0 = 53 * DEG, a1 = 11.5 * DEG;
  const e0 = -18.5 * DEG, e1 = -10.0 * DEG;
  const d0 = 0.70, d1 = 1.12;
  const _e = new THREE.Vector3(), _d = new THREE.Vector3();
  const _ap = new THREE.Vector3(), _an = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // ease the sweep so the crest curves like a moulding instead of a ruler
    const k = t * t * (3 - 2 * t);
    const az = lerp(a0, a1, k), el = lerp(e0, e1, k), d = lerp(d0, d1, k);
    const ce = Math.cos(el);
    const p = new THREE.Vector3(
      side * Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce)
      .multiplyScalar(d).add(SEA.eye);
    A.push(p);
    // fascia drop: down, orthogonalised against the eye ray (see the note above)
    _e.copy(SEA.eye).sub(p).normalize();
    _d.set(0, -1, 0).addScaledVector(_e, _e.y).normalize();
    // Deeper inboard than outboard: the fascia is a dashboard by the pilot's
    // knee and a shallow lip out at the frame edge, where a 34 cm face would
    // simply be a wall across the corner of the picture.
    Fa.push(p.clone().addScaledVector(_d, lerp(0.155, 0.345, k)));
    Dd.push(_d.clone());
    /**
     * Outboard chamfer, 11 cm — not the 26 cm roof it was.
     *
     * That face slopes AWAY from the pilot, so from the seat it is a backface in
     * shadow, and at 26 cm it subtended enough to read as a dark band running the
     * whole length of the console immediately under the coaming. Ablation-tested
     * by flattening the material: the band was this strip. seamoth-cockpit-2.jpg
     * has a thin shadow LINE there, not a band, because its console meets the
     * coaming almost square.
     */
    B.push(p.clone().add(new THREE.Vector3(side * 0.11, -0.085 - 0.03 * k, -0.01)));
    /**
     * The skirt foot, which INBOARD now lands on the yoke apron instead of
     * hanging over it.
     *
     * Raycast through the crushed region on the previous build, station by
     * station: the console's inboard skirt sits 1.150 m from the eye and the
     * surface 60 px further in sits at 0.878 — a 0.27 m depth cliff with open
     * tub visible through the gap above it. `w` ramps the foot onto the apron
     * over the inboard half of the sweep, where the apron actually is; outboard
     * of that it keeps its old free drop into the tub, which measured clean.
     */
    const w = sstep(0.30, 0.92, k);
    W.push(w);
    const free = Fa[i].clone().add(new THREE.Vector3(
      -side * 0.055, lerp(-0.34, -0.40, k), 0.055));
    apronPoint(Fa[i], _ap, _an);
    _ap.addScaledVector(_an, 0.014);   // skin it, do not z-fight inside it
    C.push(free.lerp(_ap, w));
  }
  const strip = (P, Q, v0, v1) => {
    const pos = [], uvs = [], idx = [];
    for (let i = 0; i <= N; i++) {
      pos.push(P[i].x, P[i].y, P[i].z, Q[i].x, Q[i].y, Q[i].z);
      uvs.push(i / N, v0, i / N, v1);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  // The fore cap closes the wedge so it does not read as a sheet of paper.
  const cap = (() => {
    const pos = [], uvs = [], idx = [];
    const q = [B[N], A[N], C[N], C[N].clone().add(new THREE.Vector3(side * 0.13, 0, 0))];
    for (const p of q) { pos.push(p.x, p.y, p.z); uvs.push(0.5, 0.62); }
    idx.push(0, 1, 2, 0, 2, 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  })();
  /**
   * v = 0.5 ON THE CREST, 1 outboard, 0 down the inboard skirt — the console's
   * OWN uv, not a window onto the hull lining's.
   *
   * It used to be given cabinTexture, whose v is the hull's angular coordinate,
   * and 0.74-0.90 there lands on that texture's recessed instrument slots and its
   * "tub turns under" shadow gradient. Ablation-tested by hiding this one mesh:
   * the large near-black L wrapping both sonar screens in every cockpit frame was
   * that painted slot, stretched two-thirds of a metre across a moulding it was
   * never drawn for. A separately-authored panel is also the only way to put the
   * fastener line where the reference has it, since the reference's runs ALONG the
   * console rather than around the hull.
   */
  /**
   * The knee valance: the skirt as a CURVE rather than a single quad.
   *
   * A one-quad skirt meets the fascia at a hard crease, and a crease is itself a
   * depth discontinuity to a screen-space estimator working from a 0.137 m disc,
   * so closing the cliff at the foot while leaving a 20 deg break at the top only
   * moves the black up. Each rib is a quadratic Bezier that leaves the fascia
   * along the fascia's own drop direction, so the normal turns continuously from
   * the dashboard to the apron and the run reads as one moulded mass.
   */
  const VR = [0, 0.28, 0.56, 0.80, 1.0];
  const ribs = VR.map(() => []);
  {
    const c0 = new THREE.Vector3(), q = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const L = C[i].distanceTo(Fa[i]);
      c0.copy(Fa[i]).addScaledVector(Dd[i], 0.55 * L);
      for (let r = 0; r < VR.length; r++) {
        const v = VR[r], u = 1 - v;
        q.copy(Fa[i]).multiplyScalar(u * u)
          .addScaledVector(c0, 2 * u * v)
          .addScaledVector(C[i], v * v);
        ribs[r].push(q.clone());
      }
    }
  }
  const valance = [];
  for (let r = 0; r < VR.length - 1; r++) {
    valance.push(strip(ribs[r], ribs[r + 1],
      lerp(0.16, 0.0, VR[r]), lerp(0.16, 0.0, VR[r + 1])));
  }
  const face = mergeGeos([
    strip(A, B, 0.5, 1.0),
    strip(A, Fa, 0.5, 0.16),
    ...valance,
    cap,
  ]);
  // the crest bead: the navy cap the reference puts on top of every console edge
  const crest = sweep(A, boxSection(0.085, 0.052, 0.020, 3), false);
  /**
   * A frame the caller can mount things on: `at(k, v)` is a point on the fascia
   * (v = 0 at the crest, 1 at its lower edge) plus the fascia's own outward
   * normal there. Everything bolted to the dashboard is placed through this, so
   * a bezel cannot drift off the surface it is supposed to be recessed into —
   * which is exactly the failure the last three rounds shipped.
   */
  const at = (k, v) => {
    const f = clamp01(k) * N;
    const i = Math.min(N - 1, Math.floor(f)), fr = f - i;
    const top = _lerpV(A[i], A[i + 1], fr, new THREE.Vector3());
    const bot = _lerpV(Fa[i], Fa[i + 1], fr, new THREE.Vector3());
    const p = top.clone().lerp(bot, v);
    // tangent along the console, drop direction across it; the face normal is
    // their cross product, signed so it points back at the pilot.
    const tan = A[i + 1].clone().sub(A[i]).normalize();
    const drop = bot.clone().sub(top).normalize();
    const n = new THREE.Vector3().crossVectors(tan, drop).normalize();
    if (n.dot(_e.copy(SEA.eye).sub(p)) < 0) n.negate();
    return { p, n, drop, tan };
  };
  return { face, crest, at, Fa };
}
const _lerpV = (a, b, t, out) => out.copy(a).lerp(b, t);

/**
 * Right-handed basis on a fascia frame: +Z is the face normal (out at the
 * pilot), +Y is up the face, +X follows from the cross product.
 *
 * Derived rather than assumed, because taking +X straight from the console
 * tangent gives a MIRRORED basis on one side of the cockpit — the two consoles
 * are mirror images of each other — and three flips the effective winding of
 * every geometry pushed through a negative-determinant matrix. One sonar bezel
 * would be backface-culled and the other would not, which is the kind of bug
 * that reads as "the left screen is missing" and takes a round to find.
 */
function faceBasis(fr, out) {
  const z = fr.n.clone().normalize();
  const y = fr.drop.clone().negate();
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-8) y.set(0, 1, 0).addScaledVector(z, -z.y);
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return (out || new THREE.Matrix4()).makeBasis(x, y, z).setPosition(fr.p);
}

/** Teardrop capsule used for the engine pods. */
function podGeometry(len, r0, r1, seg = 26, ring = 20) {
  const pos = [], nor = [], uvs = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const z = lerp(-len * 0.5, len * 0.5, u);
    // fat aft, tapered fore, rounded caps
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.80)), 0.55);
    const r = lerp(r1, r0, u) * shape;
    for (let j = 0; j <= ring; j++) {
      const a = TAU * (j / ring);
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(r * sa, r * ca * 0.88, z);
      nor.push(sa, ca * 0.88, 0);
      uvs.push(u, j / ring);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * (ring + 1) + j, b = a + ring + 1;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ============================================================== textures
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return { tex: t, cv, ctx2d: g };
}

/**
 * Sobel a height canvas into a tangent-space normal map.
 *
 * This is what actually makes a hull read as MANUFACTURED rather than painted:
 * a panel line drawn only into the albedo is a dark pencil stroke that stays
 * dark from every bearing, whereas a groove with real relief flips from a bright
 * lip to a dark shadow as the light crosses it, and rivets pop as tiny specular
 * beads. It costs one texture fetch and no draw calls, which is the cheapest
 * hard-surface signal available.
 */
function normalFromHeight(cv, strength = 2.6) {
  const w = cv.width, h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const og = out.getContext('2d');
  const img = og.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const k = (y * w + x) * 4;
      d[k] = (nx * 0.5 + 0.5) * 255;
      d[k + 1] = (ny * 0.5 + 0.5) * 255;
      d[k + 2] = (nz * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** A row of rivets along a line, in whatever channel the caller is painting. */
function rivetRun(g, x0, y0, x1, y1, n, r, fill) {
  g.fillStyle = fill;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    g.beginPath();
    g.arc(lerp(x0, x1, t), lerp(y0, y1, t), r, 0, TAU);
    g.fill();
  }
}

/**
 * Engine-pod / secondary-structure skin, in its OWN uv space.
 *
 * The pods used to share the fuselage texture, and they are bodies of revolution
 * whose angular uv converges at the tapered nose — so the fuselage's four
 * horizontal colour bands wrapped into a bullseye of concentric arcs sitting on
 * the most visible part of the silhouette. Measured against seamoth-1.jpg, the
 * reference pods are almost entirely cream with ONE navy crown stripe and a dark
 * aft shroud; the banding was pure noise. v = 0 and v = 1 are the pod crown,
 * v = 0.5 is its belly, which is what this paints against.
 */
function podTextures(rng) {
  const W = 512, H = 256;
  const paint = (g, mode) => {
    const albedo = mode === 'albedo', height = mode === 'height';
    // Same cool pearl as the fuselage — the pods are the second-largest painted
    // area on the vehicle, so a warm white here would have re-introduced the
    // green cast the fuselage just lost.
    g.fillStyle = albedo ? '#e9eef8' : height ? '#808080' : 'rgb(0,150,10)';
    g.fillRect(0, 0, W, H);
    const band = (v0, v1, fill) => {
      const y0 = (1 - v1) * H, y1 = (1 - v0) * H;
      g.fillStyle = fill; g.fillRect(0, y0, W, y1 - y0);
    };
    if (!height) {
      const navy = albedo ? '#35497c' : 'rgb(0,116,34)';
      const gold = albedo ? '#e2913a' : 'rgb(0,78,24)';
      // crown stripe (v wraps at 0/1) and a dark belly shadow strip
      band(0.895, 1.0, navy); band(0.0, 0.105, navy);
      band(0.868, 0.895, gold); band(0.105, 0.132, gold);
      band(0.44, 0.56, albedo ? '#aebdd4' : 'rgb(0,138,24)');
      // the aft third is the thruster shroud: dark all the way round
      g.fillStyle = albedo ? '#1f2e52' : 'rgb(0,108,40)';
      g.fillRect(0, 0, W * 0.13, H);
    }
    if (height) {
      // circumferential panel rings + a longitudinal seam, as grooves
      g.strokeStyle = '#3a3a3a'; g.lineWidth = 3;
      for (const u of [0.15, 0.34, 0.56, 0.78]) {
        g.beginPath(); g.moveTo(W * u, 0); g.lineTo(W * u, H); g.stroke();
      }
      g.strokeStyle = '#464646'; g.lineWidth = 2;
      for (const v of [0.30, 0.70]) {
        g.beginPath(); g.moveTo(0, (1 - v) * H); g.lineTo(W, (1 - v) * H); g.stroke();
      }
      for (const u of [0.15, 0.34, 0.56, 0.78]) {
        rivetRun(g, W * u - 6, 0, W * u - 6, H, 42, 2.0, '#c8c8c8');
      }
    } else if (albedo) {
      g.strokeStyle = 'rgba(74,82,94,0.5)'; g.lineWidth = 2;
      for (const u of [0.15, 0.34, 0.56, 0.78]) {
        g.beginPath(); g.moveTo(W * u, 0); g.lineTo(W * u, H); g.stroke();
      }
      rivetRun(g, W * 0.34 - 6, 0, W * 0.34 - 6, H, 42, 1.6, 'rgba(150,158,170,0.55)');
      rivetRun(g, W * 0.78 - 6, 0, W * 0.78 - 6, H, 42, 1.6, 'rgba(150,158,170,0.55)');
      // hazard chevrons on the intake, and a small stencil
      g.save();
      g.beginPath(); g.rect(W * 0.20, (1 - 0.62) * H, W * 0.10, H * 0.09); g.clip();
      for (let i = -4; i < 10; i++) {
        g.fillStyle = i % 2 ? 'rgba(232,150,58,0.90)' : 'rgba(31,46,82,0.88)';
        g.beginPath();
        g.moveTo(W * 0.20 + i * 9, (1 - 0.62) * H);
        g.lineTo(W * 0.20 + i * 9 + 9, (1 - 0.62) * H);
        g.lineTo(W * 0.20 + i * 9 + 20, (1 - 0.53) * H);
        g.lineTo(W * 0.20 + i * 9 + 11, (1 - 0.53) * H);
        g.closePath(); g.fill();
      }
      g.restore();
      g.fillStyle = 'rgba(52,62,78,0.75)';
      g.font = 'bold 13px "Arial",sans-serif';
      g.fillText('THRUST 02', W * 0.44, (1 - 0.60) * H);
      // salt wear streaking down from the crown seam
      for (let i = 0; i < 90; i++) {
        const x = rng() * W, y = (1 - (0.10 + rng() * 0.28)) * H;
        g.fillStyle = `rgba(120,128,120,${0.03 + rng() * 0.06})`;
        g.fillRect(x, y, 1 + rng() * 2, 6 + rng() * 26);
      }
    }
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * (albedo ? 11 : height ? 6 : 18);
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n * 0.6, 0, 255);
    }
    g.putImageData(img, 0, 0);
  };
  const albedo = canvasTex(W, H, (g) => paint(g, 'albedo'), true);
  const orm = canvasTex(W, H, (g) => paint(g, 'orm'), false);
  const hgt = canvasTex(W, H, (g) => paint(g, 'height'), false);
  const nrm = normalFromHeight(hgt.cv, 2.2);
  hgt.tex.dispose();
  return { map: albedo.tex, orm: orm.tex, normal: nrm };
}

/**
 * Hull skin. UV space is (axial u, angular v) with v = 0.5 on the spine, so a
 * band drawn at a constant v wraps the hull as a stripe running nose to tail —
 * which is how the reference's dark flank panels and gold pinstripe read.
 */
function hullTextures(rng) {
  const W = 1024, H = 512;
  // ORM packs r = unused, g = roughness, b = metalness — the channels three's
  // roughnessMap and metalnessMap read, so one canvas drives both.
  const paint = (g, mode) => {
    const albedo = mode === 'albedo';
    const height = mode === 'height';
    if (height) {
      // ---- relief only: grooves for panel seams, beads for rivets, a raised
      // spine fairing. Mid-grey is "flat"; darker cuts in, lighter stands proud.
      g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
      const seamU = [0.185, 0.28, 0.42, 0.55, 0.68, 0.80, 0.90];
      g.lineCap = 'butt';
      for (const uu of seamU) {
        g.strokeStyle = '#3c3c3c'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(W * uu, 0); g.lineTo(W * uu - 12, H); g.stroke();
        g.strokeStyle = '#a6a6a6'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(W * uu + 3, 0); g.lineTo(W * uu - 9, H); g.stroke();
        rivetRun(g, W * uu - 11, 0, W * uu - 23, H, 34, 2.4, '#d2d2d2');
      }
      // longitudinal seams either side of the flank band
      g.strokeStyle = '#464646'; g.lineWidth = 3;
      for (const v of [0.700, 0.790, 0.300, 0.210, 0.432, 0.568]) {
        g.beginPath(); g.moveTo(W * 0.14, (1 - v) * H); g.lineTo(W * 0.97, (1 - v) * H); g.stroke();
      }
      for (const v of [0.700, 0.300]) {
        rivetRun(g, W * 0.16, (1 - v) * H - 6, W * 0.95, (1 - v) * H - 6, 46, 2.2, '#cfcfcf');
      }
      // louvred vents cut deep
      g.fillStyle = '#2a2a2a';
      for (const v of [0.848, 0.152]) {
        for (let k = 0; k < 6; k++) {
          g.fillRect(W * (0.215 + k * 0.021), (1 - v) * H - 13, W * 0.011, 26);
        }
      }
      // access hatches: a raised plate with a bevelled edge
      for (const [uu, v] of [[0.36, 0.62], [0.36, 0.38], [0.62, 0.66], [0.62, 0.34]]) {
        const x = W * uu, y = (1 - v) * H;
        g.fillStyle = '#8e8e8e'; g.fillRect(x, y, 84, 46);
        g.strokeStyle = '#4a4a4a'; g.lineWidth = 3; g.strokeRect(x, y, 84, 46);
        rivetRun(g, x + 7, y + 7, x + 77, y + 7, 6, 2.2, '#d8d8d8');
        rivetRun(g, x + 7, y + 39, x + 77, y + 39, 6, 2.2, '#d8d8d8');
      }
      const im = g.getImageData(0, 0, W, H);
      const dd = im.data;
      for (let i = 0; i < dd.length; i += 4) {
        const n = (rng() - 0.5) * 7;
        dd[i] = clamp(dd[i] + n, 0, 255);
        dd[i + 1] = dd[i]; dd[i + 2] = dd[i];
      }
      g.putImageData(im, 0, 0);
      return;
    }
    // Composite skin: bright, rough, barely metallic. Metalness costs diffuse
    // and buys a specular lobe, and there is no scene environment map down here
    // for that lobe to pick anything up — so a "shiny" hull is simply a darker
    // one. 0.03 on the cream, 0.12 on the painted alloy.
    //
    // The cream is near-white on purpose. Measured, our flank sat at luminance
    // 40.7 against the reference Seamoth's 115.2: the shell that carries the
    // vehicle's entire identity was DIMMER than the water behind it, which is
    // LOOK.md non-negotiable #4 inverted. Albedo alone cannot fix that (see
    // hullSkylight) but starting from a genuinely pearl-cream base is half of it.
    //
    // ...and the pearl is COOL, not cream. #f6f3ea is a warm white: linear
    // B/G = 0.93, so it pushed an already green-biased skylight another 7 %
    // greener and the shell measured #baf4c7. Every white surface on the
    // reference Seamoth is a cool blue-white — seamoth-1.jpg's brightest hull
    // patches run #8fbce7 to #a3d1d9, never once above G on the blue channel.
    // Alterra paints its hulls the colour of the sky, and down here that is the
    // only paint choice that survives the water.
    g.fillStyle = albedo ? '#e9eef8' : 'rgb(0,148,8)';
    g.fillRect(0, 0, W, H);

    const band = (v0, v1, fill) => {
      const y0 = (1 - v1) * H, y1 = (1 - v0) * H;
      g.fillStyle = fill; g.fillRect(0, y0, W, y1 - y0);
    };
    /**
     * The navy is a real NAVY, not near-black.
     *
     * The reference's identity is three flat colour zones a player can read at
     * 30 m: pearl shell ~200, navy band ~60, gold pinstripe. #2b374a sits at
     * 3.6 % of the cream in linear light, so once the medium took its cut the
     * band was indistinguishable from the shadowed hull and the vehicle read as
     * one dark mass. #3a4d70 is 8 % of the cream, which is the reference ratio,
     * and it still reads as blue rather than as grey.
     */
    const dark = albedo ? '#35497c' : 'rgb(0,112,30)';
    const deep = albedo ? '#1f2e52' : 'rgb(0,104,38)';   // keel + tail, one step down
    // dark keel + dark pod tops (podGeometry wraps v=0 onto the pod's crown)
    band(0.945, 1.0, deep); band(0.0, 0.055, deep);
    // tail section goes dark all the way round
    g.fillStyle = deep;
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(W * 0.155, 0); g.lineTo(W * 0.115, H); g.lineTo(0, H);
    g.closePath(); g.fill();

    /**
     * ---- the flank band, which HUGS THE CANOPY RIM.
     *
     * v maps to hull angle as theta = (v - 0.5) * 360 deg: v = 0.5 is the spine,
     * 0.75 the starboard beam, 1.0 the keel. A band at constant v is a straight
     * stripe, and that is where two earlier attempts went wrong in opposite
     * directions. Put it low (92-139 deg) and the pods occlude it from every
     * level bearing, so the vehicle reads as one pale mass. Track the rim with
     * no limits and it swings from the shoulder all the way to the keel over the
     * hull's length, and the whole thing reads dark.
     *
     * Track the rim CLAMPED. The canopy edge runs 50 deg at the aft bulkhead to
     * 133 deg over the nose; clamping the band's own upper edge to 0.88-1.78 rad
     * keeps it tucked immediately under the sill through the shoulders — where
     * seamoth-1.jpg puts it, and where a level 8 m bearing actually looks —
     * without ever letting it slide onto the belly.
     */
    // v 0.665..0.760 is theta 59..94 deg, and that window is chosen by what is
    // physically visible: the canopy now stops at 60 deg through the midships
    // and the engine pods occlude everything past about 87 deg, so this is the
    // ONLY strip of painted hull a level 8 m bearing can see. Put the band
    // anywhere else and it is a texture detail rather than one of the three
    // colour zones the reference silhouette is made of.
    band(0.700, 0.790, dark);
    band(0.210, 0.300, dark);
    // The dorsal saddle: navy over the spine. Everywhere the canopy exists this
    // is under glass and never rasterised, so it costs nothing there and gives
    // the aft deck behind the bubble the dark zone seamoth-1.jpg has. Without it
    // a broadside view is one continuous pale field from keel to spine, because
    // the flank band alone sits low enough that the engine pods eat half of it.
    band(0.432, 0.568, dark);
    // The pinstripe has to survive a mip chain seen at 8 m: 12 px of a 512 px
    // wrap is a quarter of a degree of hull and vanished into the band above it.
    // 22 px is ~8 cm of real hull, which is what a painted stripe is.
    //
    // It is ORANGE now, not gold. The reference silhouette is white-and-orange
    // over navy, and orange is the one hue the medium cannot manufacture: with
    // R = 0-15 everywhere in the water, a warm stripe is unambiguously PAINT.
    // That is the cheapest signal available that this object was built rather
    // than grown, and it is why the eye finds a Seamoth instantly in a reef.
    const gold = albedo ? '#e2913a' : 'rgb(0,74,22)';
    band(0.790, 0.814, gold);
    band(0.186, 0.210, gold);
    // A second, thinner service stripe above the saddle, so the paint scheme has
    // a rhythm rather than one lonely line.
    if (albedo) {
      band(0.582, 0.592, 'rgba(226,145,58,0.85)');
      band(0.408, 0.418, 'rgba(226,145,58,0.85)');
    }

    if (!albedo) {
      // seams read as a roughness break too, which is most of why a panel line
      // is visible on a real hull at all
      g.strokeStyle = 'rgb(0,200,20)'; g.lineWidth = 3;
      for (const uu of [0.28, 0.42, 0.55, 0.68, 0.80]) {
        g.beginPath(); g.moveTo(W * uu, 0); g.lineTo(W * uu - 12, H); g.stroke();
      }
    }

    if (albedo) {
      // panel seams: a dark cut with a lighter lip on its lit side, which is
      // what a pressed panel edge actually looks like at 8 m
      for (const uu of [0.185, 0.28, 0.42, 0.55, 0.68, 0.80, 0.90]) {
        g.strokeStyle = 'rgba(58,64,74,0.30)'; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(W * uu, 0); g.lineTo(W * uu - 12, H); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(W * uu + 3, 0); g.lineTo(W * uu - 9, H); g.stroke();
        rivetRun(g, W * uu - 11, 0, W * uu - 23, H, 34, 1.7, 'rgba(126,136,150,0.26)');
      }
      g.strokeStyle = 'rgba(60,66,74,0.22)'; g.lineWidth = 2;
      for (const v of [0.30, 0.70, 0.432, 0.568]) {
        g.beginPath(); g.moveTo(W * 0.14, (1 - v) * H); g.lineTo(W * 0.97, (1 - v) * H); g.stroke();
      }
      for (const v of [0.700, 0.300]) {
        rivetRun(g, W * 0.16, (1 - v) * H - 6, W * 0.95, (1 - v) * H - 6, 46, 1.6,
          'rgba(210,218,228,0.22)');
      }
      // access hatches with a stencilled ident
      for (const [uu, v] of [[0.36, 0.62], [0.36, 0.38], [0.62, 0.66], [0.62, 0.34]]) {
        const x = W * uu, y = (1 - v) * H;
        g.strokeStyle = 'rgba(64,72,84,0.30)'; g.lineWidth = 2; g.strokeRect(x, y, 84, 46);
        g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x + 2, y + 2, 80, 42);
        rivetRun(g, x + 7, y + 7, x + 77, y + 7, 6, 1.7, 'rgba(120,130,144,0.30)');
        rivetRun(g, x + 7, y + 39, x + 77, y + 39, 6, 1.7, 'rgba(120,130,144,0.30)');
      }
      // louvred vents, on the pale belly just under the pinstripe
      g.fillStyle = 'rgba(40,50,64,0.48)';
      for (const v of [0.848, 0.152]) {
        for (let k = 0; k < 6; k++) {
          g.fillRect(W * (0.215 + k * 0.021), (1 - v) * H - 13, W * 0.011, 26);
        }
      }
      // stencil block + hull number, sitting on the dark flank band
      g.textAlign = 'center';
      g.fillStyle = 'rgba(240,244,248,0.66)';
      g.font = 'bold 28px "Arial","Helvetica",sans-serif';
      for (const v of [0.745, 0.255]) g.fillText('SM-04', W * 0.44, (1 - v) * H + 10);
      g.font = 'bold 16px "Arial",sans-serif';
      g.fillStyle = 'rgba(196,212,232,0.44)';
      for (const v of [0.716, 0.284]) g.fillText('ALTERRA  MK1', W * 0.68, (1 - v) * H + 6);
      // hazard chevrons across the aft quarter — the one warm-vs-navy accent that
      // reads as signage rather than as paint from 8 m out
      for (const v of [0.760, 0.240]) {
        g.save();
        g.beginPath(); g.rect(W * 0.185, (1 - v) * H - 12, W * 0.075, 24); g.clip();
        for (let i = -3; i < 12; i++) {
          g.fillStyle = i % 2 ? 'rgba(232,150,58,0.62)' : 'rgba(28,38,58,0.56)';
          g.beginPath();
          const bx = W * 0.185 + i * 11;
          g.moveTo(bx, (1 - v) * H - 12); g.lineTo(bx + 11, (1 - v) * H - 12);
          g.lineTo(bx + 24, (1 - v) * H + 12); g.lineTo(bx + 13, (1 - v) * H + 12);
          g.closePath(); g.fill();
        }
        g.restore();
      }
      // Alterra roundel on the shoulder
      for (const v of [0.640, 0.360]) {
        const cx = W * 0.50, cy = (1 - v) * H;
        g.strokeStyle = 'rgba(53,73,124,0.58)'; g.lineWidth = 3.4;
        g.beginPath(); g.arc(cx, cy, 21, 0, TAU); g.stroke();
        g.fillStyle = 'rgba(232,150,58,0.60)';
        g.beginPath(); g.moveTo(cx - 11, cy + 9); g.lineTo(cx, cy - 12);
        g.lineTo(cx + 11, cy + 9); g.closePath(); g.fill();
      }
      /**
       * Bow service placards.
       *
       * Straight lines with LEGIBLE TEXT on them are the single fastest way for
       * an eye to classify an object as manufactured — no organism in this world
       * carries a rectangle with letters in it. They sit forward of the roundel,
       * on the strip of pale flank a three-quarter bearing actually resolves.
       */
      for (const v of [0.665, 0.335]) {
        const y = (1 - v) * H;
        g.strokeStyle = 'rgba(53,73,124,0.34)'; g.lineWidth = 2;
        g.strokeRect(W * 0.735, y - 15, 118, 30);
        g.fillStyle = 'rgba(233,238,248,0.34)'; g.fillRect(W * 0.735 + 2, y - 13, 114, 26);
        g.fillStyle = 'rgba(46,62,96,0.60)';
        g.font = 'bold 13px "Arial",sans-serif';
        g.fillText('CAUTION', W * 0.735 + 8, y - 2);
        g.font = '10px "Arial",sans-serif';
        g.fillText('BALLAST VENT', W * 0.735 + 8, y + 11);
      }
      g.textAlign = 'left';

      // Wear: salt streaking below every seam, and scuffing round the vents and
      // the keel where a hull actually gets touched. Organic worlds have no
      // straight edges; a manufactured object earns its read by having straight
      // edges that are DIRTY, not by having clean ones.
      for (let i = 0; i < 150; i++) {
        const x = rng() * W;
        const v = 0.16 + rng() * 0.68;
        const y = (1 - v) * H;
        g.fillStyle = `rgba(96,104,104,${0.015 + rng() * 0.030})`;
        g.fillRect(x, y, 1 + rng() * 2.4, 8 + rng() * rng() * 60);
      }
      for (let i = 0; i < 44; i++) {
        const x = W * (0.18 + rng() * 0.78), y = rng() * H;
        g.strokeStyle = `rgba(210,218,228,${0.03 + rng() * 0.07})`;
        g.lineWidth = 0.7 + rng() * 1.1;
        g.beginPath(); g.moveTo(x, y);
        g.lineTo(x + (rng() - 0.5) * 60, y + (rng() - 0.5) * 14); g.stroke();
      }

      // Grime toward the keel. It was 0.42 alpha, which pulled the pale belly
      // down into the same value as the navy band and collapsed the three-zone
      // read into two. 0.20 still beds the underside without eating a zone.
      const gr = g.createLinearGradient(0, H * 0.5, 0, H);
      gr.addColorStop(0, 'rgba(30,40,44,0)'); gr.addColorStop(1, 'rgba(24,34,38,0.20)');
      g.fillStyle = gr; g.fillRect(0, H * 0.5, W, H * 0.5);
      const gr2 = g.createLinearGradient(0, H * 0.5, 0, 0);
      gr2.addColorStop(0, 'rgba(30,40,44,0)'); gr2.addColorStop(1, 'rgba(24,34,38,0.20)');
      g.fillStyle = gr2; g.fillRect(0, 0, W, H * 0.5);
    }

    // micro speckle so nothing is a flat plastic field
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * (mode === 'albedo' ? 13 : 22);
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n * 0.6, 0, 255);
    }
    g.putImageData(img, 0, 0);
  };

  const albedo = canvasTex(W, H, (g) => paint(g, 'albedo'), true);
  const orm = canvasTex(W, H, (g) => paint(g, 'orm'), false);
  const hgt = canvasTex(W, H, (g) => paint(g, 'height'), false);
  const nrm = normalFromHeight(hgt.cv, 2.8);
  hgt.tex.dispose();
  return { map: albedo.tex, orm: orm.tex, normal: nrm };
}

/**
 * Cockpit lining. Same UV space as the hull, so the panel runs follow the
 * cabin's curvature. Without this the tub is a single flat value filling the
 * bottom third of every cockpit frame, which is what makes a first-person
 * vehicle interior read as a grey card rather than as a moulded shell.
 */
function cabinTexture(rng) {
  const W = 1024, H = 512;
  return canvasTex(W, H, (g) => {
    /**
     * NEAR-WHITE, not light grey.
     *
     * Measured across the lower third of seamoth-cockpit-1/2.jpg the reference
     * cockpit runs 0.62-0.63 mean saturation with the red channel at 44-45 % of
     * peak; ours measured 0.34 and 78 %. That difference is the whole "is this a
     * moulded white shell lit by a cool cabin lamp, or a grey card" question. The
     * albedo goes white and the *light* carries the blue (see cabinFill), which is
     * how the reference gets a saturated frame without a tinted plastic look.
     */
    g.fillStyle = '#eef3fa'; g.fillRect(0, 0, W, H);
    // long panel runs along the hull, split by a darker seam
    /**
     * The line art is deliberately FAINT now.
     *
     * These runs were at alpha 0.52 and 0.32 on a 1024 px wrap, which on the
     * rendered console is a 3-4 px black stroke every 60 px — the vertical smears
     * that made our cockpit read as a dirty grey card. Measured against
     * seamoth-cockpit-2.jpg's console face, the reference carries detailRMS 3.7-4.0
     * and tileContrast 8.0-11.6 on a surface whose seams you can barely find; ours
     * carried the same tileContrast with a fifth of the brightness, i.e. all of our
     * signal was in the strokes. Drop them to a whisper and let the octave stack in
     * surfaceInject() carry the material read instead.
     */
    g.strokeStyle = 'rgba(96,116,142,0.20)'; g.lineWidth = 2.4;
    for (const v of [0.62, 0.70, 0.78, 0.88, 0.38, 0.30, 0.22, 0.12]) {
      g.beginPath(); g.moveTo(0, (1 - v) * H); g.lineTo(W, (1 - v) * H); g.stroke();
    }
    g.strokeStyle = 'rgba(96,116,142,0.12)'; g.lineWidth = 2;
    for (let k = 0; k < 9; k++) {
      const x = W * (0.10 + k * 0.098);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x - 14, H); g.stroke();
    }
    /**
     * Fastener rows down every panel seam.
     *
     * An interior moulding with nothing but flat paint on it is the giveaway
     * that it was extruded rather than built. seamoth-cockpit-1.jpg shows the
     * bolt line along the top of the port console clearly enough to count. At
     * this uv density each bead is about 12 mm of real shell, which is a bolt.
     */
    for (const v of [0.700, 0.752, 0.300, 0.248]) {
      rivetRun(g, W * 0.03, (1 - v) * H - 7, W * 0.97, (1 - v) * H - 7, 62, 1.9,
        'rgba(120,140,172,0.30)');
    }
    for (let k = 0; k < 9; k += 2) {
      const x = W * (0.10 + k * 0.098);
      rivetRun(g, x - 3, H * 0.02, x - 11, H * 0.98, 22, 1.7, 'rgba(126,146,176,0.20)');
    }
    /**
     * The console face, placed where the PILOT actually sees it.
     *
     * v maps to hull angle as theta = (v - 0.5) * 2pi. The canopy seam runs from
     * theta 1.24 rad at the shoulders to 1.98 over the nose, i.e. v 0.70 to 0.82,
     * and everything the pilot reads as "the console" is the strip immediately
     * below that. Detail painted at v 0.87 (an earlier guess) is 145 deg round the
     * hull, on a part of the lining hidden behind the seat.
     */
    const trim = (v0, v1, a, b) => {
      const gr = g.createLinearGradient(0, (1 - v1) * H, 0, (1 - v0) * H);
      gr.addColorStop(0, a); gr.addColorStop(1, b);
      g.fillStyle = gr; g.fillRect(0, (1 - v1) * H, W, (v1 - v0) * H);
    };
    // shadow under the sill, fading down the console face
    trim(0.700, 0.760, 'rgba(52,70,96,0.34)', 'rgba(52,70,96,0.0)');
    trim(0.240, 0.300, 'rgba(52,70,96,0.0)', 'rgba(52,70,96,0.34)');
    // recessed black slots, one per console, exactly where the reference has them
    g.fillStyle = 'rgba(10,16,26,0.80)';
    for (const v of [0.772, 0.228]) {
      for (const uu of [0.44, 0.70]) {
        g.beginPath();
        g.roundRect(W * uu, (1 - v) * H - 10, W * 0.052, 20, 6);
        g.fill();
      }
    }
    // cyan trim strip: the one bit of colour in a Subnautica interior
    g.fillStyle = 'rgba(130,226,255,0.70)';
    g.fillRect(0, (1 - 0.742) * H, W, 4);
    g.fillRect(0, (1 - 0.258) * H, W, 4);
    // vents on the lower console face
    g.fillStyle = 'rgba(88,102,120,0.46)';
    for (const v of [0.815, 0.185]) {
      for (let k = 0; k < 16; k++) g.fillRect(W * (0.30 + k * 0.013), (1 - v) * H - 8, 5, 16);
    }
    // a moulded shadow where the tub turns under, so the white is not one value
    trim(0.860, 0.960, 'rgba(40,56,78,0.32)', 'rgba(40,56,78,0.0)');
    trim(0.040, 0.140, 'rgba(40,56,78,0.0)', 'rgba(40,56,78,0.32)');
    // Stencilled service labels on the console face. Legible type inside a
    // vehicle is the interior's half of the manufactured read.
    g.font = 'bold 13px "Arial",sans-serif';
    for (const v of [0.756, 0.244]) {
      g.fillStyle = 'rgba(64,84,116,0.52)';
      g.fillText('BALLAST', W * 0.14, (1 - v) * H + 5);
      g.fillText('TRIM', W * 0.235, (1 - v) * H + 5);
      g.fillText('PWR', W * 0.815, (1 - v) * H + 5);
      g.fillStyle = 'rgba(226,145,58,0.50)';
      g.fillRect(W * 0.135, (1 - v) * H + 9, 46, 3);
      g.fillRect(W * 0.230, (1 - v) * H + 9, 30, 3);
    }
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * 9;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    g.putImageData(img, 0, 0);
  }, true).tex;
}

/**
 * The pilot's console skin, in the console's OWN uv (u along the sweep, v across).
 *
 * Everything here is deliberately low-amplitude. Measured on seamoth-cockpit-2.jpg
 * the reference console face carries detailRMS 3.7-4.0 and tileContrast 8.0-11.6
 * on a surface whose panel seams you have to hunt for — its signal is a broad
 * shading gradient plus a dotted fastener line, and nothing else. So: a near-white
 * top face, ONE bolt run, two hairline seams, a navy skirt below the crest that
 * matches the reference's lower trim, and a single cyan strip. The material read
 * comes from surfaceInject()'s octave stack, not from paint.
 */
function consoleTexture(rng) {
  const W = 512, H = 256;
  return canvasTex(W, H, (g) => {
    const yOf = (v) => (1 - v) * H;
    g.fillStyle = '#eef3fa'; g.fillRect(0, 0, W, H);
    // outboard top face falls off slightly toward the hull wall it dies into
    let gr = g.createLinearGradient(0, yOf(1.0), 0, yOf(0.55));
    gr.addColorStop(0, 'rgba(58,78,106,0.13)'); gr.addColorStop(1, 'rgba(58,78,106,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, yOf(0.55));
    // the navy skirt: the reference's console sits on a dark lower trim, and the
    // step between them is what gives the moulding its thickness from the seat
    g.fillStyle = '#8496ad'; g.fillRect(0, yOf(0.22), W, yOf(0) - yOf(0.22));
    gr = g.createLinearGradient(0, yOf(0.32), 0, yOf(0.22));
    gr.addColorStop(0, 'rgba(132,150,173,0)'); gr.addColorStop(1, 'rgba(132,150,173,1)');
    g.fillStyle = gr; g.fillRect(0, yOf(0.32), W, yOf(0.22) - yOf(0.32));
    // cyan strip along the crest — the one colour accent a Subnautica interior has
    g.fillStyle = 'rgba(130,226,255,0.62)'; g.fillRect(0, yOf(0.475), W, 3);
    // hairline seams
    g.strokeStyle = 'rgba(96,116,142,0.18)'; g.lineWidth = 2;
    for (const v of [0.86, 0.66, 0.42]) {
      g.beginPath(); g.moveTo(0, yOf(v)); g.lineTo(W, yOf(v)); g.stroke();
    }
    g.strokeStyle = 'rgba(96,116,142,0.13)'; g.lineWidth = 2;
    for (const u of [0.22, 0.47, 0.72]) {
      g.beginPath(); g.moveTo(W * u, yOf(1.0)); g.lineTo(W * u, yOf(0.32)); g.stroke();
    }
    // THE fastener line, the detail blind pair 012 asked for by name
    rivetRun(g, W * 0.04, yOf(0.775), W * 0.96, yOf(0.775), 52, 2.0, 'rgba(118,138,170,0.44)');
    rivetRun(g, W * 0.04, yOf(0.735), W * 0.96, yOf(0.735), 52, 1.5, 'rgba(118,138,170,0.22)');
    // a recessed vent and a stencil, well forward so they do not crowd the screens
    g.fillStyle = 'rgba(12,19,30,0.72)';
    for (let k = 0; k < 7; k++) g.fillRect(W * (0.075 + k * 0.019), yOf(0.70), 5, 22);
    g.fillStyle = 'rgba(64,84,116,0.48)';
    g.font = 'bold 12px "Arial",sans-serif';
    g.fillText('TRIM', W * 0.30, yOf(0.61));
    g.fillStyle = 'rgba(226,145,58,0.44)';
    g.fillRect(W * 0.298, yOf(0.585), 32, 3);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * 8;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    g.putImageData(img, 0, 0);
  }, true).tex;
}

/**
 * Seat upholstery: quilting and a stitch line.
 *
 * The one place in the vehicle where a REPEATING pattern is correct rather than
 * a tell — stitching is manufactured repetition, and the eye reads it as such
 * instantly. It is drawn at very low contrast on purpose: the pads are a dark
 * material, the thread is barely lighter than the vinyl, and what actually makes
 * the quilt read is the relief in the normal map, not the paint. That is the same
 * trade the hull's panel lines make.
 */
function padTexture(rng) {
  const W = 512, H = 512;
  const paint = (g, height) => {
    g.fillStyle = height ? '#808080' : '#39465c';
    g.fillRect(0, 0, W, H);
    // quilt: a diamond lattice pressed INTO the foam, so the cells dome up
    const cell = 64;
    g.lineCap = 'round';
    g.strokeStyle = height ? '#5c5c5c' : 'rgba(22,29,42,0.55)';
    g.lineWidth = height ? 6 : 4;
    for (let k = -H / cell; k < (W + H) / cell; k++) {
      g.beginPath(); g.moveTo(k * cell, 0); g.lineTo(k * cell + H, H); g.stroke();
      g.beginPath(); g.moveTo(k * cell, 0); g.lineTo(k * cell - H, H); g.stroke();
    }
    if (height) {
      // dome each cell so the quilt has volume rather than just scored lines
      for (let y = 0; y < H; y += cell) {
        for (let x = 0; x < W; x += cell) {
          const gr = g.createRadialGradient(x + cell * 0.5, y + cell * 0.5, 2,
            x + cell * 0.5, y + cell * 0.5, cell * 0.62);
          gr.addColorStop(0, 'rgba(190,190,190,0.55)');
          gr.addColorStop(1, 'rgba(128,128,128,0)');
          g.fillStyle = gr; g.fillRect(x - 4, y - 4, cell + 8, cell + 8);
        }
      }
    }
    // stitch dashes ON the quilt seams
    g.setLineDash([5, 7]);
    g.strokeStyle = height ? '#a8a8a8' : 'rgba(126,140,164,0.34)';
    g.lineWidth = height ? 2.4 : 1.6;
    for (let k = -H / cell; k < (W + H) / cell; k++) {
      g.beginPath(); g.moveTo(k * cell, 0); g.lineTo(k * cell + H, H); g.stroke();
      g.beginPath(); g.moveTo(k * cell, 0); g.lineTo(k * cell - H, H); g.stroke();
    }
    g.setLineDash([]);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * (height ? 5 : 9);
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    g.putImageData(img, 0, 0);
  };
  const albedo = canvasTex(W, H, (g) => paint(g, false), true);
  const hgt = canvasTex(W, H, (g) => paint(g, true), false);
  const nrm = normalFromHeight(hgt.cv, 1.7);
  hgt.tex.dispose();
  albedo.tex.repeat.set(2.5, 2.5);
  nrm.repeat.set(2.5, 2.5);
  return { map: albedo.tex, normal: nrm };
}

/** Fine directional scratches and salt spotting for the canopy glass. */
function glassDetail(rng) {
  const S = 512;
  return canvasTex(S, S, (g) => {
    g.fillStyle = '#000000'; g.fillRect(0, 0, S, S);
    g.lineCap = 'round';
    for (let i = 0; i < 220; i++) {
      const x = rng() * S, y = rng() * S;
      const a = (rng() - 0.5) * 0.55 + (rng() < 0.5 ? 0 : Math.PI * 0.5);
      const len = 6 + rng() * rng() * 90;
      g.strokeStyle = `rgba(255,255,255,${0.05 + rng() * 0.14})`;
      g.lineWidth = 0.6 + rng() * 1.2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
    }
    for (let i = 0; i < 130; i++) {
      const x = rng() * S, y = rng() * S, r = 0.8 + rng() * rng() * 4.5;
      g.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.18})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
  }, false).tex;
}

// ---------------------------------------------------------- live instruments
/**
 * The console sonar. Both cockpit screens share one texture and one material:
 * they show the same picture in the reference, and one 9 Hz canvas upload is
 * cheaper than two.
 *
 * IT IS BACKLIT, NOT A PHOSPHOR TUBE — this was the single largest measured
 * error in the cockpit frame. The old panel was a near-black field with thin
 * bright traces on it, which grid-sampled at #040b02: sRGB luminance 9, i.e. two
 * black rectangles in the middle of the console. seamoth-cockpit-1.jpg's screens
 * measure #03e07b — luminance 169, saturation 0.986, G/B 1.82 — and they are the
 * brightest thing below the waterline in the whole frame. Its screens are lit
 * panes with DARK graphics burned into them, the way a real backlit LCD works,
 * so the ink and the light swap: the field goes emerald and every ring, tick,
 * glyph and contact is drawn in near-black green on top of it.
 *
 * That inversion also fixes the thing a still cannot show: a dark screen with
 * bright traces flickers as the trace crosses a pixel, while a lit panel holds
 * its value and only the graphics move.
 */
function makeSonar() {
  const W = 320, H = 224;
  const t = canvasTex(W, H, () => {}, true);
  t.tex.wrapS = t.tex.wrapT = THREE.ClampToEdgeWrapping;
  const INK = 'rgba(0,40,46,';        // the "off" pixels of the panel
  /**
   * ...and a LIT ink for the graticule, which is the read the pane was missing.
   *
   * Cropped side by side at matched scale, seamoth-cockpit-1.jpg's pane is a
   * mid-emerald field with rings, ticks and blips that are BRIGHTER than the
   * field — a phosphor trace on a backlight. Ours drew every one of those in
   * dark ink, so the instrument read as a green card with pencil on it. The
   * decay sweep stays dark (that is genuinely a fade, not a trace); everything
   * a real sonar draws is lit.
   */
  const LIT = 'rgba(96,255,242,';
  const draw = (time, contacts, depth, heading) => {
    const g = t.ctx2d;
    // --- the backlight. A real panel is not one flat value: the diffuser is
    // brightest at the middle and falls off into the bezel, and that gradient is
    // most of why it reads as a lit sheet rather than as a coloured rectangle.
    const bl = g.createRadialGradient(W * 0.5, H * 0.46, H * 0.10, W * 0.5, H * 0.5, W * 0.62);
    /**
     * The emerald is authored TEAL, and that is a pre-compensation.
     *
     * The frame tonemaps in ACEScg, and sRGB green converts into AP1 with a
     * negative blue coefficient, so a saturated emissive green loses most of its
     * blue on the way through and lands chartreuse. Measured end to end on the
     * real chain, and identically with ?nopostfx=1 so it is the colour-space
     * transform rather than the grade: canvas #12dd7a (G/B 1.81) rendered at
     * G/B 4.7, and #3ce0a4 (G/B 1.37) rendered at G/B 3.0 — a consistent gain of
     * about 2.2 on that ratio. seamoth-cockpit-1.jpg's screens measure G/B 1.82,
     * so the pane is authored around G/B 1.1 to land near it. Pushing a greener
     * source only drives it further out of gamut and further toward yellow.
     *
     * Red is authored at ZERO for the same reason. Measured, the transform also
     * amplifies R/G by about 2.1 on the way through, so canvas #40e0cc (R/G
     * 0.29) rendered at R/G 0.60 and the pane washed out to a pale sage —
     * saturation 0.40 against the reference's 0.986. A pane with no red in it at
     * all still comes back with some, and lands near the reference instead.
     */
    /**
     * ...and the authored ratio moves from G/B 1.11 to 0.95, by measurement
     * rather than by the estimate above it. Region-averaged over the whole pane
     * at matched crops, an authored 1.11 rendered at 1.89 where
     * seamoth-cockpit-1.jpg's two panes measure 1.43 and 1.49 — so the gain on
     * this chain is about 1.70, not the 2.2 first estimated, and the source has
     * to come down with it.
     */
    bl.addColorStop(0, '#0af0e6');
    bl.addColorStop(0.55, '#00dcda');
    bl.addColorStop(1, '#00a6a8');
    g.fillStyle = bl; g.fillRect(0, 0, W, H);
    const cx = W * 0.58, cy = H * 0.5, R = H * 0.40;
    // LCD row structure: dark scan gaps, not bright scanlines
    g.fillStyle = `${INK}0.13)`;
    for (let y = 1; y < H; y += 3) g.fillRect(0, y, W, 1);
    // rings + crosshair, burned dark into the backlight
    g.strokeStyle = `${LIT}0.95)`; g.lineWidth = 1.9;
    for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(cx, cy, R * k / 3, 0, TAU); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    // bearing ticks round the outer ring
    g.strokeStyle = `${LIT}0.80)`; g.lineWidth = 1.4;
    for (let k = 0; k < 24; k++) {
      const a = k * TAU / 24, r0 = R * (k % 6 === 0 ? 0.88 : 0.94);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
    }
    // sweep: the swept sector is the part that has NOT decayed, so it stays
    // clear while the rest of the disc fills back in with ink
    const a = (time * 1.35) % TAU;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, `${INK}0.00)`);
    grad.addColorStop(1, `${INK}0.20)`);
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a, a + TAU - 0.6); g.closePath(); g.fill();
    // The trace, and its red is authored at 30 rather than 228: postfx's near
    // zone gain is the reciprocal of the fog chromaticity, so the one channel
    // the water has none of is the one it multiplies hardest on near geometry.
    // Region-averaged, the pane came back R 37-53 against the reference's 3.
    g.strokeStyle = 'rgba(30,255,238,0.92)'; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
    // contacts: dark blips, freshest ones darkest
    for (const c of contacts) {
      const fade = clamp01(1 - (((a - c.a) % TAU + TAU) % TAU) / 2.4);
      g.fillStyle = `${LIT}${(0.45 + 0.55 * fade).toFixed(2)})`;
      g.beginPath();
      g.arc(cx + Math.cos(c.a) * R * c.r, cy + Math.sin(c.a) * R * c.r, 2.6 + 2.4 * fade, 0, TAU);
      g.fill();
    }
    // left rail readouts
    g.fillStyle = `${LIT}0.96)`;
    g.font = 'bold 15px "Consolas","Menlo",monospace';
    g.fillText('SONAR', 8, 20);
    g.font = '13px "Consolas",monospace';
    g.fillText(`${depth.toFixed(0)}m`, 8, 44);
    g.fillText(`${heading.toFixed(0)}°`, 8, 62);
    g.fillStyle = `${LIT}0.85)`;
    for (let k = 0; k < 7; k++) {
      const w = 10 + 22 * (0.5 + 0.5 * Math.sin(time * 1.7 + k * 1.3));
      g.fillRect(8, 82 + k * 13, w, 7);
    }
    // bezel shadow: the pane sits a few millimetres inside its frame
    g.strokeStyle = `${INK}0.55)`; g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    t.tex.needsUpdate = true;
  };
  draw(0, [], 0, 0);
  return { tex: t.tex, draw };
}

/**
 * The diegetic dash: depth, crush limit, power and hull integrity, drawn in the
 * HUD language of LOOK.md section 10 (dark navy fill, #8FE9FF rim, #FFD23F
 * energy, #F0553C damage) but living on a physical panel inside the cockpit.
 */
function makeDash() {
  const W = 640, H = 176;
  const t = canvasTex(W, H, () => {}, true);
  t.tex.wrapS = t.tex.wrapT = THREE.ClampToEdgeWrapping;
  const rr = (g, x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  };
  const draw = (s) => {
    const g = t.ctx2d;
    // Opaque, edge to edge: the panel now sits inside a machined rim with a back
    // plate, so its own corners are no longer what shapes it — and a transparent
    // canvas was the mechanism by which it multiplied the cockpit down to black.
    g.fillStyle = '#0d2c47'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#123b5e'; rr(g, 6, 6, W - 12, H - 12, 20); g.fill();
    g.strokeStyle = 'rgba(143,233,255,0.85)'; g.lineWidth = 3; g.stroke();

    // depth, the loudest element on the panel
    g.fillStyle = '#ffffff';
    g.font = 'bold 78px "Segoe UI","Helvetica Neue",Arial,sans-serif';
    g.textAlign = 'right';
    g.fillText(String(Math.round(s.depth)), 232, 96);
    g.font = '26px "Segoe UI",Arial,sans-serif';
    g.textAlign = 'left';
    g.fillText('m', 240, 96);
    const over = s.depth > s.crush;
    g.fillStyle = over ? '#f0553c' : '#ffa22a';
    g.font = 'bold 26px "Segoe UI",Arial,sans-serif';
    g.fillText(String(Math.round(s.crush)), 240, 58);
    g.fillStyle = 'rgba(143,233,255,0.72)';
    g.font = '15px "Segoe UI",Arial,sans-serif';
    g.fillText('CRUSH', 240, 36);

    // energy + hull bars
    const bar = (x, y, w, frac, col, label, val) => {
      g.fillStyle = 'rgba(6,26,42,0.85)'; rr(g, x, y, w, 22, 11); g.fill();
      g.fillStyle = col; rr(g, x + 2, y + 2, Math.max(4, (w - 4) * clamp01(frac)), 18, 9); g.fill();
      g.fillStyle = 'rgba(230,248,255,0.92)';
      g.font = 'bold 16px "Segoe UI",Arial,sans-serif';
      g.fillText(label, x, y - 6);
      g.textAlign = 'right';
      g.fillText(val, x + w, y - 6);
      g.textAlign = 'left';
    };
    // s.power arrives in cell-units; the dash speaks percent, like the HUD pill
    const pct = clamp01(s.power / SEA.maxPower);
    bar(330, 44, 280, pct, pct < 0.20 ? '#f0553c' : '#ffd23f',
      'ENERGY', `${Math.round(pct * 100)}%`);
    bar(330, 112, 280, s.hull / SEA.maxHull, s.hull < 40 ? '#f0553c' : '#9be55a',
      'HULL', `${Math.round(s.hull)}%`);

    // status line
    g.font = 'bold 20px "Segoe UI",Arial,sans-serif';
    if (s.hull <= 0) { g.fillStyle = '#f0553c'; g.fillText('HULL FAILURE', 26, 148); }
    else if (over) { g.fillStyle = '#f0553c'; g.fillText('CRUSH DEPTH', 26, 148); }
    else if (s.power <= 0) { g.fillStyle = '#f0553c'; g.fillText('NO POWER', 26, 148); }
    else if (s.charging) { g.fillStyle = '#9be55a'; g.fillText('SOLAR CHARGE', 26, 148); }
    else { g.fillStyle = 'rgba(143,233,255,0.75)'; g.fillText('NOMINAL', 26, 148); }
    t.tex.needsUpdate = true;
  };
  draw({ depth: 0, crush: SEA.crushDepth, power: SEA.maxPower, hull: SEA.maxHull, charging: false });
  return { tex: t.tex, draw };
}

/** Seaglide holographic terrain map: contour rings sampled from the real seabed. */
function makeHoloMap() {
  const S = 256;
  const t = canvasTex(S, S, () => {}, true);
  t.tex.wrapS = t.tex.wrapT = THREE.ClampToEdgeWrapping;
  const N = 17, SPAN = 90;
  const grid = new Float32Array(N * N);
  const draw = (terrain, px, pz, yaw, depth) => {
    const g = t.ctx2d;
    g.clearRect(0, 0, S, S);
    let lo = 1e9, hi = -1e9;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = px + (i / (N - 1) - 0.5) * SPAN;
        const z = pz + (j / (N - 1) - 0.5) * SPAN;
        let h = -40;
        try { h = terrain?.heightAt ? terrain.heightAt(x, z) : -40; } catch { h = -40; }
        if (!Number.isFinite(h)) h = -40;
        grid[j * N + i] = h;
        if (h < lo) lo = h; if (h > hi) hi = h;
      }
    }
    const span = Math.max(4, hi - lo);
    const cell = S / (N - 1);
    // filled height bands, brightest where the floor is shallowest
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const h = (grid[j * N + i] + grid[j * N + i + 1] + grid[(j + 1) * N + i]
          + grid[(j + 1) * N + i + 1]) * 0.25;
        const k = clamp01((h - lo) / span);
        g.fillStyle = `rgba(${Math.round(30 + 60 * k)},${Math.round(150 + 90 * k)},${Math.round(190 + 55 * k)},${0.10 + 0.42 * k})`;
        g.fillRect(i * cell, j * cell, cell + 1, cell + 1);
      }
    }
    // contour grid
    g.strokeStyle = 'rgba(143,233,255,0.28)'; g.lineWidth = 1;
    for (let i = 0; i < N; i += 2) {
      g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, S); g.stroke();
      g.beginPath(); g.moveTo(0, i * cell); g.lineTo(S, i * cell); g.stroke();
    }
    // range rings + heading needle
    g.strokeStyle = 'rgba(143,233,255,0.55)'; g.lineWidth = 1.6;
    for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(S / 2, S / 2, S * 0.155 * k, 0, TAU); g.stroke(); }
    g.save();
    g.translate(S / 2, S / 2); g.rotate(-yaw);
    g.fillStyle = 'rgba(255,162,42,0.95)';
    g.beginPath(); g.moveTo(0, -22); g.lineTo(9, 12); g.lineTo(0, 6); g.lineTo(-9, 12); g.closePath(); g.fill();
    g.restore();
    g.fillStyle = 'rgba(230,250,255,0.92)';
    g.font = 'bold 15px "Consolas",monospace';
    g.fillText(`${depth.toFixed(0)}m`, 8, 20);
    g.font = '12px "Consolas",monospace';
    g.fillStyle = 'rgba(143,233,255,0.8)';
    g.fillText('90m', 8, S - 9);
    t.tex.needsUpdate = true;
  };
  return { tex: t.tex, draw };
}

// ============================================================== shared uniforms
function uwUniforms(extra = {}) {
  return Object.assign({
    uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor,
    uFogColor: U.uFogColor, uScatterColor: U.uScatterColor,
    uScatterStrength: U.uScatterStrength, uAbsorption: U.uAbsorption,
    uMaxVisibility: U.uMaxVisibility, uSkyAtten: U.uSkyAtten, uScatterG: U.uScatterG,
    uGainChroma: U.uGainChroma, uCausticsTex: U.uCausticsTex,
    uCausticsScale: U.uCausticsScale, uCausticsStrength: U.uCausticsStrength,
    uCausticsSpeed: U.uCausticsSpeed, uDepthDarken: U.uDepthDarken,
    uWaterLevel: U.uWaterLevel, uUnderwater: U.uUnderwater,
    uMatCaustics: { value: 0 }, uMatFogScale: { value: 1 },
  }, extra);
}

// The shared varyings UNDERWATER_PARS declares must exist in both stages or the
// program fails to link, so every custom shader below writes them even when it
// only calls uwInscatter/uwTransmittance.
const UW_VERT_HEAD = /* glsl */ `
void uwSetVaryings(vec3 wp, vec3 wn) { vUwWorldPos = wp; vUwWorldNormal = wn; }
`;

// ============================================================== microstructure
/**
 * Surface microstructure, evaluated in the VEHICLE'S OWN SPACE.
 *
 * core/surface.js is the right model — seven octaves at a 1/f roll-off so there
 * is no characteristic frequency, cavity/edge wear, gravity streaking, and a
 * ROUGHNESS delta as well as an albedo one. But `applyUnderwater({surface})`
 * feeds it `vUwWorldPos`, and this is the one module whose geometry moves: on a
 * hull that translates and rolls, a world-space field makes the grain crawl
 * across the paint, which is a worse artefact than having no grain at all.
 *
 * So: the same GLSL, the same uniforms — applyUnderwater declares uSurfGrain /
 * uSurfWear / uSurfStreak / uSurfScale on EVERY material it patches and hands
 * them back on `userData.uwUniforms` whether or not a preset was requested —
 * sampled at the vertex's object position instead. `vUwWorldNormal` is still the
 * right normal for the up-facing and side-facing weights, because those are
 * about gravity and gravity does not rotate with the sub.
 *
 * It also lands EARLIER in the shader than core's does: on `diffuseColor` and
 * `roughnessFactor`, ahead of the lighting, rather than on the final colour.
 * That is what lets the grain modulate the specular lobe. A surface uniform in
 * gloss reads as moulded plastic however good its albedo is, and a modulation
 * applied after the lighting cannot fix that — it only re-tints the answer.
 *
 * And it shares ONE octave stack between the grain and the cavity field.
 * `sfApply` evaluates `sfBroadband` four times — grain, micro, wear, streak —
 * which is 4 x 7 x 8 = 224 inlined hash blocks per fragment. Measured: switching
 * seven of this module's materials on that way took headless boot from under
 * 180 s to 215+ and cost a capture run to a renderer crash, because ANGLE has to
 * put every one of those blocks through FXC for every program variant. The
 * spectrum core is asking for is one 1/f stack; the wear field is simply its
 * bottom two octaves and the grain is the rest, so taking both out of a single
 * eight-octave pass is the same signal for 96 blocks instead of 224. Only the
 * streak needs its own sample, because it is the one field that is anisotropic.
 */
const SF_FIELD = /* glsl */ `
  vec3 sfP = vSfPos * (1.0 / uSurfScale);
  float sfA = 1.0, sfF = 0.35, sfLo = 0.0, sfHi = 0.0, sfHn = 0.0;
  // Nine octaves, not eight. Measured on the cockpit console face, eight put us at
  // detailRMS 2.18 against seamoth-cockpit-2.jpg's 3.7-4.0 while tileContrast was
  // already inside the reference band at 10.2 vs 8.0-11.6 — i.e. the spectrum was
  // right but the top of it stopped one octave short of the pixel, so the laplacian
  // had nothing to find. The ninth octave lands at ~1 cm on interior mouldings.
  for (int i = 0; i < 9; i++) {
    float v = sfNoise(sfP * sfF) * 2.0 - 1.0;
    if (i < 2) sfLo += sfA * v; else { sfHi += sfA * v; sfHn += sfA; }
    sfA *= 0.62; sfF *= 2.17;
  }
  float sfGrain = sfHi / max(sfHn, 1e-4);
  float sfCav = clamp(sfLo * (1.0 / 1.62) * 0.5 + 0.5, 0.0, 1.0);
  float sfA2 = 1.0, sfF2 = 1.0, sfS2 = 0.0, sfN2 = 0.0;
  vec3 sfSp = vec3(sfP.x * 3.0, sfP.y * 0.17, sfP.z * 3.0);
  for (int i = 0; i < 4; i++) {
    sfS2 += sfA2 * (sfNoise(sfSp * sfF2) * 2.0 - 1.0);
    sfN2 += sfA2; sfA2 *= 0.62; sfF2 *= 2.17;
  }
`;
const glf = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
/** Every material carrying microstructure, so ?vehsurf=0 can ablate all of it. */
const surfaceMats = [];

function surfaceInject(mat, p, offset = [0, 0, 0]) {
  const u = mat.userData.uwUniforms;
  if (!u) {
    console.warn('[vehicles] surfaceInject() before applyUnderwater() — skipped');
    return mat;
  }
  u.uSurfGrain.value = p.grain;
  u.uSurfWear.value = p.wear;
  u.uSurfStreak.value = p.streak;
  u.uSurfScale.value = p.scale;
  surfaceMats.push(mat);
  // Double-sided lofts get their shading normal flipped per fragment by three,
  // but vUwWorldNormal is the raw geometric one — so wear would collect on the
  // wrong face of every console strip. Same fix applyUnderwaterSkylight uses.
  const twoSided = mat.side === THREE.DoubleSide;
  const prev = mat.onBeforeCompile;
  const off = `vec3(${offset.map(glf).join(', ')})`;
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vSfPos;\nvoid main() {')
      // `transformed` rather than `position`: it already carries morph and skin
      // displacement, and it is in scope from <begin_vertex> onward.
      .replace('#include <project_vertex>',
        `vSfPos = transformed + ${off};\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying vec3 vSfPos;\nvoid main() {')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + '{\n'
        + `  vec3 sfNn = normalize(${twoSided
          ? 'gl_FrontFacing ? vUwWorldNormal : -vUwWorldNormal' : 'vUwWorldNormal'});\n`
        + SF_FIELD
        // Wear collects on flats and up-facing surfaces; coatings survive least
        // where the coarse field is high. Streaks only run on near-vertical faces
        // because that is the only place gravity has anything to pull down.
        + '  float sfW = (sfCav * mix(0.55, 1.0, clamp(sfNn.y * 0.5 + 0.5, 0.0, 1.0))\n'
        + '               - 0.5) * uSurfWear;\n'
        + '  float sfSt = (clamp(sfS2 / max(sfN2, 1e-4) * 0.5 + 0.5, 0.0, 1.0)\n'
        + '               * (1.0 - abs(sfNn.y)) - 0.5) * uSurfStreak;\n'
        + '  diffuseColor.rgb *= 1.0 + sfGrain * uSurfGrain + sfW * 0.35 - sfSt * 0.30;\n'
        + '  float sfL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n'
        + '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(sfL),\n'
        + '    clamp(sfSt * 0.5 + sfW * 0.12, 0.0, 0.45));\n'
        + '  roughnessFactor = clamp(roughnessFactor + sfGrain * uSurfGrain * 1.6\n'
        + '    + sfW * 0.45 + sfSt * 0.30, 0.045, 1.0);\n'
        + '}');
  };
  mat.needsUpdate = true;
  return mat;
}

/**
 * Downwelling skylight on the shell — the fix for the tonal inversion.
 *
 * core/underwaterMaterial.js multiplies the FULLY SHADED colour by
 * mix(0.06, 1, sunT.b) * uDepthDarken, and then separately applies the view
 * ray's own transmittance and in-scattering. The first term is the water column
 * ABOVE the object; the second is the water between the object and the eye.
 * Applying both is right. Applying the first one twice is not, and uDepthDarken
 * is a second copy of it: measured at 76 m the product lands near 0.22, so a
 * pearl-cream hull 8 m from the camera came out at luminance 40.7 while the
 * water behind it sat at 60-70. That is LOOK.md non-negotiable #4 exactly
 * inverted — the brightest thing in the reference frame became the darkest
 * thing in ours, and the blind A/B was called 2/2 off that alone.
 *
 * Rather than fight it with a flat emissive glow (which would light the hull
 * identically at 600 m and at midnight — LOOK.md section 9's "afraid of black"),
 * put the missing irradiance back where it belongs: as a HEMISPHERIC term that
 * is proportional to the albedo, follows the surface normal, and decays with
 * real Beer-Lambert depth and sun elevation. At the surface in daylight it is
 * strong; at 300 m or at night it is gone and the hull is a silhouette carrying
 * two lamps, which is what dropoff-2.jpg shows.
 *
 * It rides on totalEmissiveRadiance because that is the one channel core
 * deliberately exempts from the depth term, and it still receives the view-ray
 * extinction and in-scatter below it — so the hull still converges toward the
 * fog colour with distance. structures.js hand-derives the same correction from
 * its measured geomK; two modules solving this independently is the core issue
 * flagged in the report.
 *
 * @param {THREE.Material} mat
 * @param {{value:THREE.Color}} fill  per-frame skylight radiance
 * @param {number} up  0 = flat fill, 1 = fully normal-weighted
 * @param {object} [opts]  forwarded to applyUnderwater
 * @param {{value:THREE.Color}} [dirTint]  hue filter for DIRECT light (see dirFilter)
 * @param {string} [key]  program-cache discriminator; see the note at the bottom
 * @param {boolean} [cab]  add the cabin emitter set (see CAB_LIGHT_PARS)
 */
function applyUnderwaterSkylight(mat, fill, up = 0.62, opts = undefined, dirTint = null,
  key = '', cab = false) {
  applyUnderwater(mat, opts);
  const twoSided = mat.side === THREE.DoubleSide;
  const uwCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    uwCompile(shader, renderer);
    shader.uniforms.uSkyFill = fill;
    shader.uniforms.uSkyUp = { value: up };
    if (cab) {
      shader.uniforms.uVehCabP = cabLightPos;
      shader.uniforms.uVehCabC = cabLightCol;
      shader.uniforms.uVehCabA = cabLightAxis;
      shader.uniforms.uCabAmb = cab === 'rim' ? cabAmbRim : cabAmb;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uSkyFill;\nuniform float uSkyUp;'
        + (dirTint ? '\nuniform vec3 uDirFilter;' : '')
        + (cab ? 'uniform vec3 uCabAmb;\n' + CAB_LIGHT_PARS : ''))
      // after emissivemap_fragment so diffuseColor is the final albedo and
      // totalEmissiveRadiance already holds whatever the material itself emits
      /**
       * gl_FrontFacing, and it is not a nicety.
       *
       * The console mouldings are lofted quad strips on a DOUBLE-SIDED material,
       * so three flips the shading normal per fragment — but `vUwWorldNormal` is
       * the raw geometric normal from the vertex stage and is NOT flipped. Half
       * those strips happen to be wound the other way, so the console's outboard
       * TOP face — the surface the reference lights brightest, because it faces
       * the canopy — was being handed the fill of a downward-facing one. Measured,
       * that band came back at median 39 against the reference's 93. Flipping to
       * the normal that actually faces the eye makes the term agree with what the
       * material is already shading.
       */
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + '{\n'
        + `  vec3 uwN = ${twoSided
          ? 'gl_FrontFacing ? vUwWorldNormal : -vUwWorldNormal' : 'vUwWorldNormal'};\n`
        + '  float uwUp = clamp(uwN.y * 0.5 + 0.5, 0.0, 1.0);\n'
        + '  float uwW = mix(1.0, uwUp * uwUp * 1.55 + 0.18, uSkyUp);\n'
        + '  totalEmissiveRadiance += diffuseColor.rgb * uSkyFill * uwW;\n'
        + (cab
          ? '  totalEmissiveRadiance += diffuseColor.rgb'
            + ' * (vehCabIrradiance(vUwWorldPos, uwN) + uCabAmb);\n'
          : '')
        + '}');
    if (dirTint) {
      shader.uniforms.uDirFilter = dirTint;
      // <lights_fragment_end> is the one anchor where reflectedLight is fully
      // accumulated and still separable from the emissive above — filtering the
      // final colour instead would re-tint the skylight term, which already
      // carries this spectrum, and square the effect.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n'
          + 'reflectedLight.directDiffuse *= uDirFilter;\n'
          + 'reflectedLight.directSpecular *= uDirFilter;');
    }
  };
  /**
   * applyUnderwater stamps every patched material with the same cache key, so a
   * second variant of the same material class MUST declare its own or three
   * hands it the program compiled for the first one.
   *
   * `key` is now required in practice rather than merely available: with
   * microstructure injected per material, two materials of the same class that
   * differ ONLY in whether they carry a surface produce different programs from
   * identical three-side parameters, and the shared 'uw+skyfill+dir' string was
   * exactly the collision that guarantees. Every caller passes its own.
   */
  mat.customProgramCacheKey = () =>
    (dirTint ? 'uw+skyfill+dir' : 'uw+skyfill') + (twoSided ? '+2s' : '')
    + (cab ? '+cab' : '') + key;
  mat.needsUpdate = true;
  return mat;
}

// ============================================================== canopy glass
function makeGlassMaterial(detailTex) {
  return new THREE.ShaderMaterial({
    uniforms: uwUniforms({
      uDetail: { value: detailTex },
      uTint: { value: new THREE.Color(0.15, 0.36, 0.44) },
      uRefract: { value: 1.0 },
      uCabin: { value: new THREE.Color(0.42, 0.62, 0.78) },
      uScreenGlow: { value: new THREE.Color(0.10, 0.85, 0.36) },
      uStress: { value: 0 },
    }),
    vertexShader: /* glsl */ `
      ${UNDERWATER_PARS}
      ${UW_VERT_HEAD}
      attribute float aEdge;
      varying vec3 vWPos;
      varying vec3 vWNor;
      varying vec2 vGuv;
      varying vec3 vLocal;
      varying float vEdge;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vWNor = normalize(mat3(modelMatrix) * normal);
        vGuv = uv;
        vLocal = position;
        vEdge = aEdge;
        uwSetVaryings(vWPos, vWNor);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${UNDERWATER_PARS}
      uniform sampler2D uDetail;
      uniform vec3 uTint;
      uniform vec3 uCabin;
      uniform vec3 uScreenGlow;
      uniform float uRefract;
      uniform float uStress;
      varying vec3 vWPos;
      varying vec3 vWNor;
      varying vec2 vGuv;
      varying vec3 vLocal;
      varying float vEdge;

      void main() {
        vec3 I = normalize(vWPos - uCamPos);
        float dist = length(vWPos - uCamPos);
        vec3 N = normalize(vWNor);
        vec3 Nf = dot(N, I) < 0.0 ? N : -N;
        float ndv = clamp(-dot(Nf, I), 0.0, 1.0);

        // Schlick against water (n 1.333) -> acrylic (n 1.49). R0 is 0.0033, two
        // orders of magnitude below glass in air, and that is the whole reason a
        // submerged canopy is nearly invisible instead of a mirror. Inflating it
        // is what turned the rim of the bubble into an opaque black band, since
        // the reflection has almost nothing bright to pick up down here.
        float R0 = 0.0033;
        float fres = clamp(R0 + (1.0 - R0) * pow(1.0 - ndv, 5.0), 0.0, 1.0);

        // --- true refraction of the medium. The water column has a real
        // vertical gradient, so bending the ray changes the colour it resolves
        // to; the difference IS the visible distortion, and it grows toward the
        // rim exactly where a curved shell bends most.
        float camDepth = max(0.0, uWaterLevel - uCamPos.y);
        vec3 bent = refract(I, Nf, 0.955);
        if (dot(bent, bent) < 1e-6) bent = I;
        bent = normalize(mix(I, bent, uRefract));
        float far = uMaxVisibility * 2.2;
        vec3 dScatter = uwInscatter(bent, far, camDepth) - uwInscatter(I, far, camDepth);

        // --- absorption through the pane, thicker at grazing angles. This, not
        // the fresnel term, is what makes the rim of the bubble read.
        float thick = 1.0 / max(ndv, 0.20);
        float absorb = clamp(0.082 * thick, 0.0, 0.48);

        // --- micro detail: scratches and salt take the light and are what makes
        // a canopy read as a real object rather than a hole
        vec2 duv = vGuv * vec2(3.0, 1.6);
        float scratch = texture2D(uDetail, duv).r;

        // --- the pane is NOT uniformly clear. A moulded acrylic canopy that has
        // been in seawater for years hazes in broad soft patches, and a perfectly
        // even sheet of glass is one more surface with no material read. Three
        // octaves of core's own noise, sampled in the pane's OBJECT space so it
        // cannot crawl as the sub moves, at an amplitude small enough that it
        // shows as a variation in clarity rather than as a stain.
        float hz = 0.0, ha = 1.0, hf = 2.4, hn = 0.0;
        for (int i = 0; i < 3; i++) {
          hz += ha * (sfNoise(vLocal * hf) * 2.0 - 1.0);
          hn += ha; ha *= 0.60; hf *= 2.30;
        }
        hz /= hn;
        absorb *= 1.0 + 0.32 * hz;
        scratch = clamp(scratch * (1.0 + 0.60 * hz) + 0.05 * max(hz, 0.0), 0.0, 1.0);
        float sun = pow(clamp(dot(reflect(I, Nf), uSunDir), 0.0, 1.0), 220.0);
        float sheen = pow(clamp(dot(reflect(I, Nf), uSunDir), 0.0, 1.0), 6.0);

        // --- cockpit reflected in the pane. Two sources only: the pale cabin
        // shell below, and the green console screens, which is what you actually
        // see in seamoth-cockpit-1.jpg.
        vec3 R = reflect(I, Nf);
        float down = clamp(-R.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 cabinRefl = uCabin * pow(down, 2.2);
        float screenLobe = pow(clamp(dot(normalize(R), normalize(vec3(0.0, -0.55, 0.83))), 0.0, 1.0), 34.0);
        cabinRefl += uScreenGlow * screenLobe * 2.4;
        // grazing internal reflection: the sheet of cabin light smeared along the
        // rim is the single most recognisable thing about a canopy from inside
        float graze = pow(1.0 - ndv, 3.0);

        float alpha = clamp(absorb + graze * 0.14 + scratch * 0.09, 0.0, 0.58);

        // premultiplied: the tint darkens by exactly what it absorbs, and every
        // glint is additive on top so a low alpha never crushes the view out.
        //
        // THE GAINS ON fres AND graze ARE THE VEHICLE'S SINGLE LOUDEST TELL and
        // they are deliberately small now. fres goes to 1.0 at the silhouette of
        // a curved bubble from EVERY bearing, so a x26 gain on it lit the canopy
        // outline to a clipped 255 from directly astern where no light source
        // exists — the "white glowing crescent" that decided the blind A/B. The
        // reference canopy is a dark navy ring with one small specular lobe on
        // it, and it is never the brightest thing on the vehicle: it has to sit
        // BELOW the shell value, not six times above it. Everything the rim now
        // reads by is the sharp sun lobe and the scratch field.
        /**
         * The rim.
         *
         * aEdge is 0 down the centreline of the pane and 1 exactly on the sill
         * seam, so this is the one place the shader can put a highlight that
         * follows the canopy's real boundary instead of a guessed uv. Two terms:
         * a thin bright line where the pane meets the frame — light piped along
         * the acrylic edge, the single most recognisable thing about looking out
         * of a moulded canopy — and a soft darkening just inboard of it, which is
         * the geometric vignette LOOK.md section 9 says the reference gets from
         * the canopy rather than from a post filter.
         */
        float rimLine = smoothstep(0.81, 0.995, vEdge);
        float rimSoft = smoothstep(0.40, 0.99, vEdge);
        vec3 rimCol = mix(vec3(0.34, 0.68, 0.92), uCabin, 0.42);

        vec3 col = uTint * absorb * 1.5;
        col += cabinRefl * (fres * 2.1 + graze * 0.10);
        col += uSunColor * (sun * 3.4 + sheen * 0.05) * (fres * 5.0 + graze * 0.10);
        col += scratch * (0.06 + 0.5 * sheen) * vec3(0.55, 0.80, 0.92) * (0.22 + 0.45 * graze);
        // Refraction. The bend is worth more toward the rim because that is
        // where a moulded bubble actually has curvature, and because the water
        // column has a real vertical gradient the bent ray resolves to a
        // measurably different colour there — which is the distortion.
        col += dScatter * 1.15 * (0.22 + 0.78 * (1.0 - ndv));
        // The edge-lit line where the pane meets its frame. It is the one thing
        // that says "you are looking through a canopy" rather than "the bottom
        // of the screen is dark", and at 0.55 it was below the noise floor of a
        // 45 m frame.
        col += rimCol * rimLine * 0.95;
        // hull stress: the pane flexes and goes milky-white at the seams
        col += vec3(0.9, 0.95, 1.0) * uStress * (0.10 + 0.9 * graze);
        alpha = clamp(alpha + rimSoft * 0.14 + rimLine * 0.22 + uStress * 0.22, 0.0, 0.82);

        // premultiplied output, so the additive glints survive a low alpha
        vec3 T = mix(vec3(1.0), uwTransmittance(dist), uUnderwater);
        col = col * T + mix(vec3(0.0), uwInscatter(I, dist, camDepth), uUnderwater) * alpha;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
}

// ============================================================== lamp volume
/**
 * A headlight's shaft of lit water.
 *
 * The proxy is a closed cone drawn back-face-only with depth testing off, so it
 * covers its own screen footprint whether the camera is outside it or sitting
 * inside it in the pilot's seat. The shader does the real work: intersect the
 * view ray with the spot cone analytically, clip the far end against
 * render/underwater.js's scene depth so terrain occludes the beam, then
 * integrate scattering along what survives using the medium's own absorption.
 */
function makeBeamMaterial(depthUniforms) {
  const hasDepth = !!depthUniforms;
  return new THREE.ShaderMaterial({
    uniforms: uwUniforms({
      uLightPos: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0, 0, -1) },
      uCosOuter: { value: Math.cos(0.42) },
      uCosInner: { value: Math.cos(0.20) },
      uRange: { value: 60 },
      uBeamColor: { value: new THREE.Color(0.80, 0.94, 1.0) },
      uPower: { value: 1.0 },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
      tDepth: depthUniforms ? depthUniforms.tDepth : { value: null },
      uNear: depthUniforms ? depthUniforms.uNear : { value: 0.08 },
      uFar: depthUniforms ? depthUniforms.uFar : { value: 6000 },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uJitter: { value: 0 },
    }),
    defines: hasDepth ? { USE_SCENE_DEPTH: '' } : {},
    vertexShader: /* glsl */ `
      ${UNDERWATER_PARS}
      ${UW_VERT_HEAD}
      varying vec3 vWPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        uwSetVaryings(vWPos, normalize(mat3(modelMatrix) * normal));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${UNDERWATER_PARS}
      uniform vec3  uLightPos;
      uniform vec3  uLightDir;
      uniform float uCosOuter;
      uniform float uCosInner;
      uniform float uRange;
      uniform vec3  uBeamColor;
      uniform float uPower;
      uniform vec3  uCamFwd;
      uniform sampler2D tDepth;
      uniform float uNear;
      uniform float uFar;
      uniform vec2 uResolution;
      uniform float uJitter;
      varying vec3 vWPos;

      // matches three's packing chunk, which is what MeshDepthMaterial wrote
      float unpackDepth(vec4 v) {
        vec4 f = (255.0 / 256.0) / vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
        return dot(v, f);
      }
      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      // Grain in the beam, for the price of three sines. A proper value noise
      // costs eight hashes per sample; at ten samples across two cones that is
      // 160 hashes for every pixel of a near-fullscreen quad, and it measured
      // 14 ms of frame time on its own. Beam texture is a texture, not a
      // simulation — the cheap version is indistinguishable at this contrast.
      float grain3(vec3 p) {
        return 0.5 + 0.5 * sin(p.x * 1.7 + p.z * 0.9) * sin(p.y * 2.1 - p.z * 1.3)
          * sin(p.z * 1.1 + p.x * 0.6);
      }

      void main() {
        vec3 ro = uCamPos;
        vec3 rd = normalize(vWPos - ro);

        // ---- analytic ray vs spot cone
        float k = uCosOuter * uCosOuter;
        vec3 co = ro - uLightPos;
        float dv = dot(rd, uLightDir);
        float cv = dot(co, uLightDir);
        float a = dv * dv - k;
        float b = 2.0 * (dv * cv - k * dot(rd, co));
        float c = cv * cv - k * dot(co, co);
        float t0 = 0.0, t1 = -1.0;
        if (abs(a) < 1e-5) {
          if (abs(b) > 1e-6) { float t = -c / b; t0 = t; t1 = t + 0.001; }
        } else {
          float disc = b * b - 4.0 * a * c;
          if (disc <= 0.0) discard;
          float sq = sqrt(disc);
          float ta = (-b - sq) / (2.0 * a);
          float tb = (-b + sq) / (2.0 * a);
          t0 = min(ta, tb); t1 = max(ta, tb);
          // reject the mirror lobe behind the apex
          if (dot(ro + rd * t0 - uLightPos, uLightDir) < 0.0) t0 = t1 > 0.0 ? t1 : t0;
          if (dot(ro + rd * t1 - uLightPos, uLightDir) < 0.0) t1 = t0;
        }
        // clip against the cone's flat end cap
        float dn = dot(rd, uLightDir);
        float capT = (uRange - cv) / (abs(dn) < 1e-5 ? 1e-5 : dn);
        if (dn > 0.0) t1 = min(t1, capT); else t0 = max(t0, capT);
        t0 = max(t0, 0.0);
        if (t1 <= t0) discard;

        // ---- clip against the scene
        #ifdef USE_SCENE_DEPTH
        vec2 suv = gl_FragCoord.xy / uResolution;
        float dz = unpackDepth(texture2D(tDepth, suv));
        if (dz < 0.9999) {
          float viewZ = (uNear * uFar) / ((uFar - uNear) * dz - uFar);
          float sceneT = -viewZ / max(dot(rd, uCamFwd), 1e-3);
          t1 = min(t1, sceneT);
        }
        #endif
        if (t1 <= t0) discard;

        // ---- integrate
        const int STEPS = 6;
        float seg = (t1 - t0) / float(STEPS);
        float jitter = fract(hash13(vec3(gl_FragCoord.xy, 1.0)) + uJitter);
        vec3 acc = vec3(0.0);
        vec3 sigma = uAbsorption;
        for (int i = 0; i < STEPS; i++) {
          float t = t0 + seg * (float(i) + jitter);
          vec3 p = ro + rd * t;
          vec3 lv = p - uLightPos;
          float ld = length(lv);
          if (ld > uRange) continue;
          float ca = dot(lv / max(ld, 1e-4), uLightDir);
          float spot = smoothstep(uCosOuter, uCosInner, ca);
          if (spot <= 0.0) continue;
          // Inverse square, floored so the first metre out of the lamp does not
          // blow out under a 10-step march. LOOK.md section 4 measures real
          // shafts at only 10-15% over the surrounding water, so this integral
          // is deliberately quiet — what sells a beam is its SHAPE and the fact
          // that terrain cuts it, not its brightness.
          float fall = smoothstep(0.0, 3.2, ld) / (3.0 + ld * ld * 1.15);
          fall *= 1.0 - smoothstep(uRange * 0.45, uRange, ld);
          // grain in the beam: real lit water is never a clean gradient
          float grain = 0.72 + 0.55 * grain3(p * 0.55 + vec3(0.0, 0.0, uTime * 0.35));
          vec3 tr = exp(-sigma * (ld + t));
          acc += uBeamColor * spot * fall * grain * tr * seg;
        }
        acc *= uPower * 0.22 * uUnderwater;
        gl_FragColor = vec4(acc, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
}

// ============================================================== the Seamoth
function buildSeamoth(rng) {
  const root = new THREE.Group();
  root.name = 'seamoth';
  /**
   * The hull is authored nose-forward along +Z because that is the natural
   * direction for a lathe, but three's cameras look down -Z. Piloting means the
   * camera takes the vehicle's own orientation, so the whole body hangs off a
   * group turned 180 deg: inside it every part keeps its authored coordinates,
   * and outside it the vehicle's -Z is the bow, which is what the camera, the
   * thrust axis and the compass all already assume. Getting this wrong put the
   * pilot's seat facing out of the back of the sub.
   */
  const body = new THREE.Group();
  body.name = 'seamoth.body';
  body.rotation.y = Math.PI;
  root.add(body);

  const skins = hullTextures(rng.fork(3));
  // The shell carries NO constant self-glow: at night and at depth a Seamoth is
  // a dark silhouette holding a lit cockpit and two lamps (dropoff-2.jpg), and
  // an ambient glow would be exactly the "afraid of black" error LOOK.md §9
  // calls out. What it does carry is the depth- and sun-driven skylight term
  // (see applyUnderwaterSkylight), which is zero at night and zero in the deep.
  const hullMat = new THREE.MeshStandardMaterial({
    map: skins.map, roughnessMap: skins.orm, metalnessMap: skins.orm,
    normalMap: skins.normal, normalScale: new THREE.Vector2(0.85, 0.85),
    color: 0xffffff, roughness: 1.0, metalness: 1.0,
  });
  hullMat.map.repeat.set(1, 1);
  applyUnderwaterSkylight(hullMat, skyFill, 0.80, undefined, dirFilter, '+hull');
  surfaceInject(hullMat, SURF.paint);

  // Secondary structure — pods, pylons, fairings, mast, coaming — in its own uv
  // space so the fuselage's colour bands stop wrapping into a bullseye on the
  // pod noses. Costs no extra draw call: the greeble was already its own mesh.
  const podSkin = podTextures(rng.fork(5));
  const podMat = new THREE.MeshStandardMaterial({
    map: podSkin.map, roughnessMap: podSkin.orm, metalnessMap: podSkin.orm,
    normalMap: podSkin.normal, normalScale: new THREE.Vector2(0.75, 0.75),
    color: 0xffffff, roughness: 1.0, metalness: 1.0,
  });
  applyUnderwaterSkylight(podMat, skyFill, 0.80, undefined, dirFilter, '+pod');
  // Offset the noise field so the pods do not share the fuselage's blotches at
  // the seam where they meet it — the one place a triplanar field can betray
  // itself is two parts that happen to sample the same lattice cell.
  surfaceInject(podMat, SURF.pod, [7.3, -2.1, 4.8]);

  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x2a3950, roughness: 0.44, metalness: 0.30,
  });
  // No octave stack on trimMat, sealMat or boltMat: they are bezels, nozzle
  // shrouds, a 14 mm rubber bead and 9 mm bolt heads — nothing wider than a hand,
  // and every material carrying the stack costs real FXC time at boot on ANGLE.
  // The thruster wear trimMat would have carried is geometry instead.
  applyUnderwaterSkylight(trimMat, skyFill, 0.80, undefined, dirFilter, '+trim');

  // Cabin surfaces are self-lit — see the header note on uDepthDarken. The
  // lining measured 50.1 against the reference's 87.6, i.e. dim grey rather
  // than the moulded white shell of seamoth-cockpit-2.jpg, so the base emissive
  // is raised and the cabin lamp now adds a soft normal-weighted fill on top of
  // it rather than one blown ellipse (see cabinFill / the overhead fixture).
  const cabinSkin = cabinTexture(rng.fork(9));
  /**
   * `color` is deliberately DARK while `emissive` carries the level.
   *
   * The lining is inside a sealed hull, but nothing occludes the sun for it: the
   * shell casts a shadow and every mesh on this vehicle has receiveShadow forced
   * off (see noReceive — a 16 cm/texel cascade on a smooth 4.7 m hull is textbook
   * self-shadow acne). So the DirectionalLight was landing on the cockpit floor
   * unattenuated, and wherever the tub's normal happened to face the sun it
   * produced a clipped white ellipse about 130x200 px sitting in the exact centre
   * of frame. Knocking the albedo down 17x removes the hotspot and keeps a gentle
   * directional model on the moulding; the emissive is what actually sets the
   * value, which is the same split screenMat and dashMat already use.
   */
  const cabinMat = new THREE.MeshStandardMaterial({
    map: cabinSkin, emissiveMap: cabinSkin,
    color: 0xa3aebb, roughness: 0.72, metalness: 0.04,
    emissive: new THREE.Color(0.118, 0.202, 0.286).multiplyScalar(EMIT.cabin),
  });
  /**
   * depthResponse 0.4 — the pressurised, DRY volume opts most of the way out of
   * the ocean's depth term. Running the tub at full response meant its diffuse
   * shading was worth 6 % of itself at 145 m, so the only thing carrying the
   * cockpit was a flat emissive and the moulding had no form at all. At 0.4 the
   * cabin lamp and the light coming through the canopy still model the shell,
   * the way they do in seamoth-cockpit-2.jpg where the console is plainly LIT
   * from above-left rather than uniformly glowing.
   */
  const CABIN_UW = { caustics: 0, fogScale: 0.1, depthResponse: 0.4 };
  applyUnderwaterSkylight(cabinMat, cabinFill, 0.44, CABIN_UW, null, '+cabin', true);
  registerCab(cabinMat, 'lining');
  surfaceInject(cabinMat, SURF.lining, [2.6, 5.1, -1.3]);

  /**
   * The canopy sill / rim.
   *
   * The reference rim is a DARK NAVY ring measuring about 60 luminance with a
   * specular highlight on it — darker than the shell it sits in, never brighter.
   * Ours was reading near-black from inside (the critic's "unlit black wavy
   * noodles") because at 145 m core's depth term leaves a diffuse-only material
   * with essentially nothing, so it needs enough self-lit floor to land on 60
   * and no more.
   */
  /**
   * ...and the ALBEDO is 3x what it was, while the self-lit floor is down 2x.
   *
   * Those two moves are one change, and it is about the STEP rather than the
   * level. Scanned vertically through the rail, seamoth-cockpit-1.jpg goes 38-42
   * across the coaming's top face and 10-16 down its inboard flank — a 3:1 step,
   * and that step is the only thing that says the rail is a solid object rather
   * than a line drawn on the picture. Ours came back 12-16 top to bottom. The
   * normal-weighted skylight term already spans 0.18..1.73 (3.05:1, the measured
   * ratio almost exactly) but it is proportional to ALBEDO, and a flat emissive
   * floor is not — so with a near-black albedo and a large floor the varying
   * term was worth a third of the constant one and the step could not appear.
   * Trading floor for albedo keeps the darkest flank on the reference and lets
   * the top face climb.
   */
  const sillMat = new THREE.MeshStandardMaterial({
    color: 0x2c4a72, roughness: 0.34, metalness: 0.26,
    // Measured: our sill crop read median 15 against the reference's 26 at the
    // same bearing. The exterior skyFill this material rides on is a WATER-column
    // term and is nearly zero inside a lit cabin, so the interior value has to
    // come from the sill's own floor or the frame's most recognisable structural
    // line reads as a black bar drawn across the picture.
    //
    // The floor is NAVY, not teal. Grid-sampled, our coaming came back #012522 —
    // G/B 1.09, i.e. a green-black bar — where seamoth-cockpit-1.jpg's is
    // #0a2a44 at its darkest and #2c536f on its lit top face, G/B 0.62-0.79. The
    // ratio here is 1:2.3:5.4, which holds that blue through the tone curve even
    // where the level is only 30.
    //
    // Level doubled and RED PUT BACK. Restaged into open water the sill crop
    // measured median 37 with the red channel at 1 % of peak, against the
    // reference's 68 at 33 % — i.e. a black bar drawn across the most
    // recognisable structural line in the frame. #2c536f is R/B 0.40, G/B 0.75,
    // and a navy that carries some red is what stops it reading as a hole.
    /**
     * x1.55 on the floor, calibrated with --params=ao=0 and NOT on the shipping
     * frame — see the report for why the shipping frame is not a valid target
     * for an interior level right now.
     *
     * Matched-fraction crops of the cockpit's lower third, ours with AO disabled
     * against seamoth-cockpit-2.jpg: mean (63.8,102.6,108.6) vs (54.8,95.8,101.4),
     * G/B 0.945 vs 0.945, R/G 0.622 vs 0.572, saturation 0.583 vs 0.534 — the
     * spectrum is on the reference. What is not is the MEDIAN: 58.7 against 92.8.
     * The bright panels match and the dark end is 30 levels low, which is a
     * contrast fault, not a brightness one, so it is closed here at the dark end
     * (the coaming, the fittings) rather than by lifting everything.
     */
    /**
     * ...and the RED is up 1.8x on the floor alone, which is the one thing an
     * ID pass proved was a material fault rather than a medium one.
     *
     * A vertical scan through the rail — taken off a flat-colour ID render, so
     * the pixels are certainly this material and not the water behind it —
     * reads 10 / 21 / 43 luminance with the red channel at 0-2 against
     * seamoth-cockpit-1.jpg's 11 / 36 / 74 at red 3-50. The level is close; the
     * red is not there at all.
     *
     * It is NOT the view-ray fog. That was the first hypothesis and it is
     * disproved: forcing this material's fogScale from 1.0 to 0.14 — the cabin's
     * own value — changed 0.001 % of the frame by more than 4 levels, because at
     * 1.5 m of water the red channel's transmittance is 0.79 either way. The red
     * was never being eaten, it was never emitted. A navy that carries no red at
     * all is a hole in the picture whatever its luminance, so it goes in here,
     * at the source, where it can be pointed at.
     */
    emissive: new THREE.Color(0.140, 0.150, 0.196).multiplyScalar(EMIT.cabin),
  });
  // up = 1.0: fully normal-weighted, so the sill outboard top face catches a
  // highlight while the inboard faces the pilot actually sees stay near the
  // reference 26 luminance instead of glowing at 57.
  //
  // ...on rimFill, not skyFill. Measured with a vertical scan through the rail
  // at x = 420, ours was flat 9-16 top to bottom where the reference steps
  // 38-42 down to 10-16: the exterior fill it was riding is a water-column term
  // and is nearly nothing inside a lit cabin, so the weighting had nothing to
  // weight. See the rimFill declaration.
  applyUnderwaterSkylight(sillMat, rimFill, 1.0, { caustics: 0 }, dirFilter, '+sill', 'rim');
  registerCab(sillMat, 'dark');
  surfaceInject(sillMat, SURF.rim, [-6.1, 3.3, 2.2]);

  /**
   * The same navy, but for the fittings that are only ever seen from INSIDE:
   * the seat, the screen bezels, the yoke.
   *
   * They used to share sillMat, which rides the exterior skyFill and takes the
   * ocean's full depth response — so at 145 m the seat and both bezels were
   * unlit black shapes while the console 40 cm from them was a lit white one,
   * and the cockpit read as two objects photographed under different lights.
   * A dry interior fitting belongs on the cabin's own light, at the cabin's own
   * depth response. Costs no draw call: these were already separate meshes.
   */
  /**
   * The floor is raised, and it is the other half of the contrast fix.
   *
   * Grid-sampled 12x7 across the lower third, the reference cockpit's darkest
   * console-region cell is 74 and its brightest is 202 — a 2.7:1 spread with no
   * holes in it. Ours was bimodal: 0-11 on the bezels, the yoke fittings and the
   * gaps, 160-205 on the mouldings. A fitting 40 cm from the pilot's eye inside a
   * lit cabin cannot be at luminance 0, whatever its albedo, and every one of
   * those zeros is a hole the eye reads as missing geometry.
   */
  /**
   * ...and it is NOT the dark end any more. Point-sampled against
   * seamoth-cockpit-1.jpg at matched positions, the reference's screen surround
   * measures (43,83,112) — luminance 76, a mid slate-blue that plainly catches
   * the cabin lamp — while ours came back (0,2,4), luminance 2. The bezel is the
   * frame around the single brightest element in the cockpit, so at luminance 2
   * it is not a dark fitting, it is a hole with a green rectangle floating in
   * it. Albedo up 2.6x (the fill term is proportional to it) and the self-lit
   * floor up with it; the recess shading still comes from the four bars' own
   * normals, so the instrument keeps reading as sunk rather than flat.
   */
  const trimInMat = new THREE.MeshStandardMaterial({
    color: 0x47597a, roughness: 0.40, metalness: 0.20,
    // x1.25, same dark-end argument as the sill above. These are the bezels, the
    // structural rib and the instrument bay rim — the fittings the reference
    // shows plainly catching the cabin lamp at luminance 76.
    emissive: new THREE.Color(0.210, 0.315, 0.410).multiplyScalar(EMIT.cabin),
  });
  applyUnderwaterSkylight(trimInMat, cabinFill, 0.45, CABIN_UW, null, '+trimin', true);
  registerCab(trimInMat, 'dark');
  surfaceInject(trimInMat, SURF.molding, [4.4, -7.2, 1.1]);

  /**
   * Seat upholstery. Matte — roughness 0.88 with no metalness at all — because
   * the one thing that separates fabric from moulded plastic at a glance is that
   * it has no specular lobe to catch the cabin lamp, and every other surface in
   * here does. The quilt relief is carried by the normal map rather than the
   * albedo, so it survives being seen through a canopy at 8 m as a shading break
   * instead of dissolving into a grey wash.
   */
  const padSkin = padTexture(rng.fork(13));
  const padMat = new THREE.MeshStandardMaterial({
    map: padSkin.map, normalMap: padSkin.normal,
    normalScale: new THREE.Vector2(0.62, 0.62),
    color: 0xb9c6d8, roughness: 0.88, metalness: 0.0,
    emissive: new THREE.Color(0.052, 0.086, 0.122).multiplyScalar(EMIT.cabin),
  });
  applyUnderwaterSkylight(padMat, cabinFill, 0.40, CABIN_UW, null, '+pad', true);
  registerCab(padMat, 'dark');
  surfaceInject(padMat, SURF.vinyl, [-8.3, 4.6, -2.7]);

  const sonar = makeSonar();
  /**
   * roughness 0.98, and that is a colour fix rather than a gloss preference.
   *
   * The pane sits under the sun with nothing shadowing the cockpit, and at
   * roughness 0.3 its GGX lobe put a warm white sheen on it: authoring the
   * canvas with a red channel of literally ZERO still measured R/G 0.50 in
   * frame, i.e. the red was additive specular, not the texture. That sheen is
   * what desaturated the emerald to 0.50 against the reference's 0.986. A matte
   * anti-glare pane is also what an instrument screen actually has.
   */
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.98, metalness: 0,
    emissiveMap: sonar.tex, emissive: new THREE.Color(1, 1, 1).multiplyScalar(EMIT.sonar),
  });
  applyUnderwater(screenMat, { caustics: 0, fogScale: 0.1, depthResponse: 0.4 });
  registerCab(screenMat, 'panel');

  const dash = makeDash();
  /**
   * OPAQUE now, and single-sided.
   *
   * It used to be a translucent plane hanging in mid-air, and translucency is
   * exactly wrong for it: alpha 0.8 over a black cockpit floor multiplied an
   * already-dark navy down to a measured luminance of 0-5 across the middle of
   * every cockpit frame. It is a physical instrument sitting in a machined bay
   * with a back plate behind it (see the dash bay below), so it occludes, writes
   * depth, and carries its level in `emissive` — which core exempts from depth
   * darkening, so it still reads at 200 m.
   */
  const dashMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.36, metalness: 0,
    map: dash.tex, emissiveMap: dash.tex,
    emissive: new THREE.Color(1, 1, 1).multiplyScalar(EMIT.screen),
  });
  applyUnderwater(dashMat, { caustics: 0, fogScale: 0.1, depthResponse: 0.4 });
  registerCab(dashMat, 'panel');

  /**
   * The headlight lens has INTERNAL STRUCTURE and a real rolloff.
   *
   * It was a flat disc of emissive at 26x, which is by definition a blown-out
   * white blob: every texel of it clips, so the lamp has no shape at all, only an
   * outline, and bloom smears that outline into a halo. That is the "clipped
   * emitter" failure mode, and it was decided on in five of eighteen blind pairs
   * this round. A real sealed-beam unit is a small very bright filament sitting in
   * a stepped parabolic reflector: bright core, three concentric reflector rings
   * at descending brightness, a dim outer flange, and a hard dark bezel shadow at
   * the rim. Peak brightness is barely reduced — the lamp still reads at 200 m —
   * but the CLIPPED AREA collapses to the filament, and everything around it now
   * carries readable structure into the bloom instead of a solid white pool.
   */
  const lensTex = canvasTex(160, 160, (g, w, h) => {
    const cx = w * 0.5, cy = h * 0.5, R = w * 0.5;
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    const disc = (r, col) => { g.fillStyle = col; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill(); };
    // stepped reflector: each ring a little dimmer than the one inside it
    disc(R * 0.97, '#12181c');
    disc(R * 0.90, '#3d4b57');
    disc(R * 0.74, '#6f8794');
    disc(R * 0.56, '#9db6c2');
    disc(R * 0.38, '#c8dce6');
    // filament: the only part allowed to clip, and it is 5 % of the lens area
    const fg = g.createRadialGradient(cx, cy - R * 0.05, 1, cx, cy, R * 0.22);
    fg.addColorStop(0, '#ffffff'); fg.addColorStop(0.55, '#e8f6ff');
    fg.addColorStop(1, 'rgba(200,220,230,0)');
    g.fillStyle = fg; g.beginPath(); g.arc(cx, cy, R * 0.22, 0, TAU); g.fill();
    // the filament's support cross, in shadow against it
    g.strokeStyle = 'rgba(20,28,34,0.75)'; g.lineWidth = w * 0.022;
    g.beginPath(); g.moveTo(cx - R * 0.30, cy); g.lineTo(cx + R * 0.30, cy);
    g.moveTo(cx, cy - R * 0.30); g.lineTo(cx, cy + R * 0.30); g.stroke();
    // reflector step edges, so the rings read as machined rather than as a blur
    g.strokeStyle = 'rgba(255,255,255,0.30)'; g.lineWidth = 1.5;
    for (const k of [0.38, 0.56, 0.74, 0.90]) {
      g.beginPath(); g.arc(cx, cy, R * k, 0, TAU); g.stroke();
    }
    // sRGB, deliberately: the ring steps are authored by eye, and decoding them
    // as sRGB is what turns a visually-even ramp into the steep radiometric
    // rolloff a parabolic reflector actually has.
  }, true).tex;
  lensTex.wrapS = lensTex.wrapT = THREE.ClampToEdgeWrapping;
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.2, metalness: 0,
    emissiveMap: lensTex,
    emissive: new THREE.Color(0.85, 0.95, 1.0).multiplyScalar(EMIT.lens),
  });
  applyUnderwater(lensMat, { caustics: 0 });
  /**
   * ONE material for every small self-lit fitting on the boat, tinted per vertex.
   *
   * Port nav light, starboard nav light and the three underside markers used to
   * be three MeshStandardMaterials and therefore three meshes and three draw
   * calls — for 44 triangles of coloured bead in total, all of them static in
   * body space and all of them differing ONLY in the colour of their emissive.
   * A per-vertex tint is exactly the right way to say "same material, different
   * colour", and it collapses them into one draw. The same material then also
   * carries the cockpit's light guides and the overhead fixture (see `glowGeo`
   * below), so what used to be five draws is one.
   *
   * `vColor` multiplies `totalEmissiveRadiance`, not just the albedo. three's
   * built-in vertex colour only touches diffuseColor, which on a near-black
   * self-lit bead does nothing at all.
   */
  const emitTintMat = new THREE.MeshStandardMaterial({
    color: 0x02060a, roughness: 0.3, metalness: 0,
    emissive: new THREE.Color(1, 1, 1).multiplyScalar(EMIT.glow),
    vertexColors: true,
  });
  applyUnderwater(emitTintMat, { caustics: 0 });
  {
    const prev = emitTintMat.onBeforeCompile;
    emitTintMat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb;');
    };
    emitTintMat.customProgramCacheKey = () => 'uw+emittint';
  }
  /**
   * Nozzle glow, with a hole in the middle.
   *
   * A flat emissive disc is the same clipped-blob failure the lens had, one size
   * down. A jet nozzle is dark at the throat and hottest in the annulus where the
   * flow scrubs the liner, so the map is a ring: dim core, bright annulus,
   * shadowed lip. It also carries the vane shadows, which is structure the bloom
   * can pick up instead of a solid pool.
   */
  const nozzleTex = canvasTex(96, 96, (g, w, h) => {
    const cx = w * 0.5, cy = h * 0.5, R = w * 0.5;
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(cx, cy, R * 0.10, cx, cy, R);
    rg.addColorStop(0, '#28414f'); rg.addColorStop(0.42, '#9fd6f2');
    rg.addColorStop(0.72, '#5f97b4'); rg.addColorStop(0.94, '#101a20');
    rg.addColorStop(1, '#000000');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = w * 0.035;
    for (let k = 0; k < 6; k++) {
      const a = k * TAU / 6;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.16, cy + Math.sin(a) * R * 0.16);
      g.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86); g.stroke();
    }
  }, true).tex;
  nozzleTex.wrapS = nozzleTex.wrapT = THREE.ClampToEdgeWrapping;
  const thrustMat = new THREE.MeshStandardMaterial({
    color: 0x02060a, roughness: 0.3, metalness: 0,
    emissiveMap: nozzleTex,
    emissive: new THREE.Color(0.35, 0.72, 1.0).multiplyScalar(EMIT.glow * 0.62),
  });
  applyUnderwater(thrustMat, { caustics: 0 });
  /**
   * The cockpit's own light guides, the yoke's button rings and the overhead
   * fixture — all on ONE vertex-tinted material, all in one mesh.
   *
   * These are the interior's visible LIGHT SOURCES: a 12 mm ribbon washing each
   * console fascia from under the crest, a surround guide round each instrument
   * bezel, a lip strip under the yoke crown, and the recessed strip on the aft
   * coaming. Every one of them is something a real cockpit has and something
   * seamoth-cockpit-1/2.jpg shows — the reference's panel rims and the cyan
   * ringing on its button wells are exactly this — and between them they are why
   * the reference interior reads as LIT rather than as a cave with a window.
   *
   * They also feed the six-emitter set above, so the light you can see is the
   * same light the mouldings are shaded by rather than a decal that glows.
   *
   * depthResponse 0.4 with the rest of the cabin: this is a dry pressurised
   * volume, not open ocean at 145 m.
   */
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x03080b, roughness: 0.32, metalness: 0,
    emissive: new THREE.Color(1, 1, 1).multiplyScalar(EMIT.strip),
    vertexColors: true,
  });
  applyUnderwater(glowMat, { caustics: 0, fogScale: 0.1, depthResponse: 0.4 });
  registerCab(glowMat, 'guide');
  {
    const prev = glowMat.onBeforeCompile;
    glowMat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb;');
    };
    glowMat.customProgramCacheKey = () => 'uw+glowvc';
  }
  /** Geometry destined for that one mesh, tinted as it is pushed. */
  const glowGeo = [];
  const _tintC = new THREE.Color();
  /** Stamp a constant vertex colour onto a geometry and queue it. */
  const glow = (g, r, gr, b) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gr; c[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    glowGeo.push(g);
    return g;
  };
  /**
   * The emitter table the shader loop reads, in BODY space. Filled as the
   * geometry that emits is built, so a light can never end up somewhere its
   * fixture is not. Transformed to world once per frame in updateCabinLights().
   */
  const cabEmit = [];
  const pushEmit = (p, n, col, intensity, soft, gate) => {
    if (cabEmit.length >= CAB_LIGHTS) return;
    cabEmit.push({
      p: p.clone(), n: n.clone().normalize(),
      c: _tintC.copy(col).clone(), i: intensity, r2: soft * soft, gate,
    });
  };

  // ---------------------------------------------------------------- hull
  /**
   * Panel plating as GEOMETRY, not as a pencil line.
   *
   * A seam drawn only into the albedo is a dark stroke that stays dark from every
   * bearing and at every distance — which is the "painted-on line art" half of the
   * critic's complaint, and it is also why our tileContrast sat so far above the
   * reference's: a hard stroke is pure local contrast and carries no shading.
   * A real pressed plate stands ~9 mm proud of the shell with a 2 cm chamfer at
   * its edge, so the edge flips from a bright lip to a dark shadow as the light
   * crosses it, and it disappears honestly with distance instead of aliasing.
   *
   * It is built out of the SAME parametric surface as everything else, with a
   * u-dependent negative inset, so it can never float off the hull or crease it —
   * and it is merged into the hull mesh, so a plated fuselage costs no draw call.
   * computeVertexNormals() afterwards is the whole point: bandGeometry hands back
   * the analytic surface normal, which would shade the chamfer as if it were not
   * there.
   */
  const platePlan = [[0.300, 0.418], [0.556, 0.672]];
  const plates = platePlan.map(([uA, uB]) => {
    const g = shellBands({
      bias: -0.055, uSegs: 60, vSegs: 26, uMin: uA - 0.002, uMax: uB + 0.002,
      inset: (u) => -0.009 * (sstep(uA, uA + 0.0055, u) - sstep(uB - 0.0055, uB, u)),
    });
    g.computeVertexNormals();
    return g;
  });
  const hull = new THREE.Mesh(
    mergeGeos([shellBands({ bias: -0.055, uSegs: 96, vSegs: 40 }), ...plates]), hullMat);
  hull.name = 'seamoth.hull';
  body.add(hull);
  /**
   * Cast, but do not receive.
   *
   * core enables both flags on every mesh once a second, and the sun's shadow
   * map is a 2048 map spanning 320 m — about 16 cm per texel, on a smoothly
   * curved 4.7 m hull. That is textbook self-shadow acne: measured, it was
   * costing the sunward flank most of its value and turning a cream hull into
   * mottled grey. A convex shell has nothing legitimate to receive from itself,
   * so refusing the receive is free, and the sub still lays a real shadow on the
   * sand underneath it.
   */
  const noReceive = [];

  const glassDet = glassDetail(rng.fork(7));
  const glassMat = makeGlassMaterial(glassDet);
  const glass = new THREE.Mesh(bandGeometry({
    thetaLo: (u) => -glassEdge(u), thetaHi: (u) => glassEdge(u), uSegs: 88, vSegs: 40,
  }), glassMat);
  glass.name = 'seamoth.canopy';
  glass.renderOrder = 2;
  glass.userData.noShadow = true;
  body.add(glass);

  // cockpit tub: same surface, inset, wound inside-out, only under the canopy
  const uOf = (z) => clamp01((z - SEA.z0) / (SEA.z1 - SEA.z0));
  /**
   * Dilated 0.10 rad into the canopy so its lip tucks under the rim rail from
   * inside; inset 75 mm so it reads as a lining rather than as the hull itself.
   *
   * The inset TAPERS TO ZERO over the last 40 cm. It has to: the parametric
   * radius goes to zero at the nose, so pushing a constant 75 mm inward past
   * that point turns the surface inside out and leaves a pinched, back-lit,
   * hard-edged white ellipse hanging in the middle of the pilot's view — which
   * is exactly the artefact the critic measured at 130x200 px at 1080p. Letting
   * the lining converge onto the shell at the tip closes the tub cleanly with no
   * extra bulkhead and no z-fighting anywhere it is more than a millimetre from
   * the hull.
   */
  /**
   * The tub and the bulkhead that closes it are ONE mesh.
   *
   * They were two, sharing cabinMat and both static in body space, which is a
   * draw call spent on nothing. The bulkhead's own uv is a unit disc and the
   * lining's is the hull's angular parametrisation, so the disc is squeezed onto
   * a clean patch of the lining sheet first — otherwise it wears the texture's
   * instrument slots as a bullseye behind the pilot's head.
   */
  const bulkhead = (() => {
    const uB = uOf(-1.05);
    const rx = crom(SEA.rx, uB), ry = crom(SEA.ry, uB), cy = crom(SEA.cy, uB);
    const g = new THREE.CircleGeometry(1, 28);
    xform(g, { pos: [0, cy, -1.04], scale: [rx * 0.93, ry * 0.93, 1] });
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, 0.18 + 0.10 * uv.getX(i), 0.30 + 0.10 * uv.getY(i));
    }
    uv.needsUpdate = true;
    return g;
  })();
  /**
   * 50 mm of inset, not 75, and it is an occlusion fix as much as a modelling
   * one.
   *
   * The sill slab is 86 mm tall on a boundary offset 8 mm outward, so its
   * inboard face sits 35 mm INSIDE the shell. At a 75 mm inset the lining was a
   * further 40 mm behind that — a 40 mm cliff running the entire length of the
   * most prominent line in the cockpit, which is four times postfx's AO bias at
   * this range and is why the coaming shipped as a black bar rather than as the
   * navy roll the reference shows. At 50 mm the step is 15 mm, inside the bias at
   * 1.4 m, and the lining still clears the shell by twice any z-fighting margin.
   */
  const interior = new THREE.Mesh(mergeGeos([shellBands({
    bias: -0.10, flip: true, uSegs: 72, vSegs: 34,
    inset: (u) => 0.050 * (1 - sstep(0.905, 0.998, u)),
    uMin: uOf(-1.05), uMax: 1.0,
  }), bulkhead]), cabinMat);
  interior.name = 'seamoth.cabin';
  interior.userData.noShadow = true;
  body.add(interior);

  // ---------------------------------------------------------------- rim
  /**
   * The canopy sill.
   *
   * Two jobs at once, and they pull in opposite directions. Seen from OUTSIDE
   * it has to be wide enough to bury the shell mask's stair-step (about one quad
   * of the grid, 6 cm, in each direction) and to read as the reference's dark
   * navy ring around the bubble. Seen from INSIDE it is the pilot's shoulder
   * sill, and it must not become a bar across the eyeline — the hull is a lathed
   * body, so both halves of the loop converge on the nose tip, which is 1.9 m
   * dead ahead of the eye.
   *
   * So the section tapers along z: a full 30 cm chamfered slab through the
   * shoulders, shrinking to a 5 cm bead by the time it reaches the snout, where
   * it subtends about 1.5 deg and reads as a moulding rather than a girder.
   */
  const rimB = canopyBoundary(116, 0.008);
  /**
   * The forward taper is now 0.12, not 0.38, and that is a MEASURED fix.
   *
   * A lathed body converges at its tip, so both halves of the canopy boundary
   * meet on the centreline ahead of the pilot: grid-sampled, the sill's forward
   * loop crossed frame centre at y = 875/1080 as a 46 px black wavy bar, exactly
   * where seamoth-cockpit-2.jpg shows open water down to the yoke. The bar is not
   * a lighting problem — it is a 21 cm structural slab seen from 1.6 m. Collapse
   * it to a 2.5 cm bead over the last metre and it subtends 0.9 deg, which reads
   * as the moulding it is; the slab is kept where the pilot's shoulders are and
   * where it caps the console, which is the only place the reference has one.
   */
  const rimScale = rimB.zs.map((z) => 1 - 0.88 * sstep(0.55, 1.80, z));
  const consoleL = consoleGeometry(-1), consoleR = consoleGeometry(1);
  /**
   * ...and the slab is 60 mm WIDER, all of it inboard.
   *
   * Measured across the coaming in seamoth-cockpit-1/2.jpg the navy roll is
   * 90-110 px thick at 1080p. Ours was 86 mm tall at 1.4 m — 3.3 deg, about 62
   * px — and a 62 px bar reads as a line drawn on the picture, not as the
   * padded structural roll the pilot's shoulder rests against. Height cannot go
   * up (the inboard face would drop below the lining and poke through it), so
   * the WIDTH goes up instead and the corner radius with it: from the seat you
   * see the inner face plus a foreshortened top face, and 60 mm more top face at
   * a 46 mm radius is another 40 px of rounded, lit moulding. Shifted rather
   * than centred so the outboard edge stays exactly where it was and keeps
   * burying the shell mask's stair-step.
   */
  const rim = new THREE.Mesh(mergeGeos([
    sweep(rimB.points, slabSection(0.270, 0.086, 0.046).map(([x, y]) => [x + 0.030, y]),
      true, rimB.normals, rimScale),
    consoleL.crest, consoleR.crest,
  ]), sillMat);
  rim.name = 'seamoth.rim';
  /**
   * It does not cast. The sill is a ring standing on the canopy opening, i.e.
   * entirely inside the shell's own silhouette from every sun elevation this
   * game has — so its 4.9 k triangles bought a second pass over geometry whose
   * shadow the hull was already drawing. Same reasoning as the seat below and
   * the tub above: core arms shadows on everything by default (main.js), which
   * is right for the world and wrong for a sealed vehicle whose interior nobody
   * can see a shadow of.
   */
  rim.userData.noShadow = true;
  body.add(rim);

  /**
   * The canopy SEAL and the sill BOLTS — blind pair 012's "no canopy rim, bolts
   * or a seal", answered as geometry rather than as line art.
   *
   * Both ride the same boundary curve the sill does, so they cannot drift off it.
   * sweep() builds its frame as B = T x N, and traversing the starboard half
   * forward and the port half backward flips T on both, which flips B on both —
   * so +B is "toward the glass" on either side and one offset does both edges.
   *
   * The seal is a compressed elastomer bead tucked between the pane and the
   * frame: matte, near-black, and the one surface in the cockpit with no specular
   * at all, which is what makes the polished frame beside it read as polished.
   * The bolts are 18 mm heads on 11 cm centres, standing 4 mm proud of the sill's
   * top face — at a metre that is 1 deg apiece, countable, which is precisely the
   * signal that says a person assembled this.
   */
  const sealMat = new THREE.MeshStandardMaterial({
    color: 0x16212f, roughness: 0.94, metalness: 0.0,
    emissive: new THREE.Color(0.052, 0.086, 0.118).multiplyScalar(EMIT.cabin),
  });
  // 'rim', not true: the bead and the bolt heads sit ON the canopy coaming, so
  // like the sill they are half in the ocean and take the reduced cabin bounce.
  applyUnderwaterSkylight(sealMat, cabinFill, 0.30, CABIN_UW, null, '+seal', 'rim');
  const boltMat = new THREE.MeshStandardMaterial({
    color: 0x5c6c86, roughness: 0.38, metalness: 0.62,
    emissive: new THREE.Color(0.086, 0.132, 0.180).multiplyScalar(EMIT.cabin),
  });
  applyUnderwaterSkylight(boltMat, cabinFill, 0.60, CABIN_UW, null, '+bolt', 'rim');
  // Hoisted: the seat harness further down is the same rubber on the same static
  // transform, and it merges into this mesh rather than costing its own draw.
  let seal;
  {
    // Seal: a 14 mm half-round tucked against the inboard face of the slab.
    // 0.150, not 0.086: the slab's inboard edge moved out to 0.165 when it was
    // widened, and a seal buried under the frame it is supposed to be sealing
    // against is just 4.9 k triangles of nothing.
    const sealSec = circleSection(0.014, 9).map(([x, y]) => [x + 0.150, y + 0.018]);
    const sealScale = rimScale.slice();
    seal = new THREE.Mesh(
      sweep(rimB.points, sealSec, true, rimB.normals, sealScale), sealMat);
    seal.name = 'seamoth.canopySeal';
    seal.userData.noShadow = true;
    body.add(seal);

    // Bolts: only through the shoulders, where the sill is still a slab and where
    // the pilot's eye is close enough to resolve one. Forward of z = 1.5 the rail
    // is a bead and a bolt on it would be a speck on the centreline.
    const T = new THREE.Vector3(), B = new THREE.Vector3(), N = new THREE.Vector3();
    const heads = [];
    const n = rimB.points.length;
    for (let i = 2; i < n - 2; i += 4) {
      const z = rimB.zs[i];
      if (z < -0.20 || z > 1.50) continue;
      T.copy(rimB.points[i + 1]).sub(rimB.points[i - 1]).normalize();
      N.copy(rimB.normals[i]).addScaledVector(T, -rimB.normals[i].dot(T)).normalize();
      B.copy(T).cross(N).normalize();
      const sc = rimScale[i];
      const g = new THREE.CylinderGeometry(0.0092, 0.0104, 0.010, 6);
      // stand the head along the sill's own normal, on the top face
      const m = new THREE.Matrix4().makeBasis(B, N, T);
      m.setPosition(rimB.points[i].clone()
        .addScaledVector(N, 0.086 * 0.5 * sc + 0.004)
        .addScaledVector(B, 0.030 * sc));
      heads.push(g.applyMatrix4(m));
    }
    if (heads.length) {
      const bolts = new THREE.Mesh(mergeGeos(heads), boltMat);
      bolts.name = 'seamoth.rimBolts';
      bolts.userData.noShadow = true;
      body.add(bolts);
    }
  }

  // The console mouldings themselves. DoubleSide because the strips are lofted
  // from a spherical parametrisation rather than a closed solid, and three flips
  // the shading normal per-face for a double-sided material — which is cheaper
  // and far more robust than hand-auditing the winding of six quad strips.
  const consoleSkin = consoleTexture(rng.fork(17));
  consoleSkin.wrapS = consoleSkin.wrapT = THREE.ClampToEdgeWrapping;
  const consoleMat = new THREE.MeshStandardMaterial({
    map: consoleSkin, emissiveMap: consoleSkin,
    color: 0xb2bdc9, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide,
    // x1.20: the console now carries a pilot-facing FASCIA as well as a crest,
    // and a face whose normal is horizontal gets neither the skylight weighting's
    // up-lobe nor the crest's specular, so it was the darkest large area in the
    // cockpit at exactly the place the reference is mid-grey.
    emissive: new THREE.Color(0.161, 0.257, 0.348).multiplyScalar(EMIT.cabin),
  });
  // up 0.16, not 0.22: a fascia that looks the pilot in the eye has uwN.y near
  // zero, so a strongly normal-weighted fill drives the one surface the
  // instruments are mounted on toward the bottom of its own range.
  applyUnderwaterSkylight(consoleMat, cabinFill, 0.16, CABIN_UW, null, '+console', true);
  registerCab(consoleMat, 'lining');
  surfaceInject(consoleMat, SURF.molding, [-5.2, 1.9, 6.4]);
  const consoleMesh = new THREE.Mesh(mergeGeos([consoleL.face, consoleR.face]), consoleMat);
  consoleMesh.name = 'seamoth.console';
  consoleMesh.userData.noShadow = true;
  body.add(consoleMesh);

  /**
   * NO frame ribs across the bubble.
   *
   * There used to be two, sweeping at 62 % of the canopy half-angle. Traced into
   * the pilot's view they enter frame at the upper corners and run down toward
   * the middle — at z = 1.05 the starboard rib sits 43 deg right and 18 deg ABOVE
   * the eyeline — so what the reference shows as clear water was crossed by two
   * dark ribbons, which was the biggest single thing separating our cockpit from
   * seamoth-cockpit-1.jpg. There is no framing member anywhere in the reference's
   * forward hemisphere: the bubble is one unbroken pane and the only structure is
   * the sill along its bottom edge. So the sill carries all of it, and the ribs
   * are gone rather than moved — anywhere they fit inside the canopy is inside
   * the pilot's view, because that is what a canopy is for.
   */

  // ---------------------------------------------------------------- pods
  // The pods must clear the cockpit tub: the shell reaches x = 0.965 and the tub
  // is inset 75 mm inside that, so a pod whose inner wall crosses 0.89 pokes
  // through the cabin floor and shows the hull decal INSIDE the cockpit. Sitting
  // them properly outboard is also what makes the silhouette read as a Seamoth
  // rather than as one smooth egg.
  const greeble = [];
  /**
   * POD_Y used to be -0.34, and that single number was hiding the paint job.
   * A pod of radius 0.55 centred there spans world y -0.89..+0.21, and the
   * fuselage crosses y = +0.21 at theta = 76 deg — so from any level bearing
   * the pods occluded every degree of hull past 76, which is exactly where the
   * flank band lives. Dropped to -0.52 they clear 87 deg instead, which opens
   * the 27 deg window the band is painted into, and it is also where the
   * reference carries them: low, on the hips, not on the waist.
   */
  const POD_X = 1.56, POD_Y = -0.62, POD_R = 0.55;
  for (const s of [-1, 1]) {
    const pod = podGeometry(3.15, 0.30, POD_R, 26, 18);
    xform(pod, { pos: [s * POD_X, POD_Y, -0.10], rot: [0, s * 0.055, s * -0.09] });
    greeble.push(pod);
    // pylon joining the pod to the hull, starting outside the shell
    const py = new THREE.BoxGeometry(0.70, 0.44, 0.92, 1, 1, 1);
    xform(py, { pos: [s * 1.24, -0.34, -0.06], rot: [0, 0, s * -0.30] });
    greeble.push(py);
    // forward fairing on the pod nose
    const fair = new THREE.CylinderGeometry(0.16, 0.28, 0.46, 20, 1, false);
    xform(fair, { pos: [s * (POD_X + 0.04), POD_Y, 1.38], rot: [Math.PI * 0.5, 0, 0] });
    greeble.push(fair);
  }
  // dorsal spine + mast, straight off seamoth-1.jpg
  {
    const fin = new THREE.BoxGeometry(0.10, 0.42, 1.05);
    xform(fin, { pos: [0, 0.72, -1.28], rot: [0.22, 0, 0] });
    greeble.push(fin);
    const mast = new THREE.CylinderGeometry(0.026, 0.034, 1.05, 7);
    xform(mast, { pos: [0.0, 1.32, -0.72] });
    greeble.push(mast);
    const ball = new THREE.SphereGeometry(0.095, 10, 8);
    xform(ball, { pos: [0.0, 1.86, -0.72] });
    greeble.push(ball);
    const ball2 = new THREE.SphereGeometry(0.07, 10, 8);
    xform(ball2, { pos: [0.20, 1.24, -0.98] });
    greeble.push(ball2);
    // hatch coaming behind the canopy
    const coam = new THREE.CylinderGeometry(0.36, 0.40, 0.10, 18, 1, true);
    xform(coam, { pos: [0, 0.72, -1.00] });
    greeble.push(coam);
  }
  const greebleMesh = new THREE.Mesh(mergeGeos(greeble), podMat);
  greebleMesh.name = 'seamoth.greeble';
  body.add(greebleMesh);

  // thruster housings (dark trim) + nozzles
  const housings = [];
  for (const s of [-1, 1]) {
    const h = new THREE.CylinderGeometry(0.32, 0.38, 0.44, 14, 1, false);
    xform(h, { pos: [s * POD_X, POD_Y, -1.72], rot: [Math.PI * 0.5, 0, 0] });
    housings.push(h);
  }
  {
    const h = new THREE.CylinderGeometry(0.30, 0.36, 0.46, 16, 1, false);
    xform(h, { pos: [0, -0.02, -2.10], rot: [Math.PI * 0.5, 0, 0] });
    housings.push(h);
  }
  // (the lamp bezels are pushed into this same array below and the mesh is built
  // once, after them — one trim draw for every dark fitting on the vehicle)

  const nozzles = [];
  for (const [x, y, z, r] of [[-POD_X, POD_Y, -1.91, 0.24], [POD_X, POD_Y, -1.91, 0.24],
    [0, -0.02, -2.31, 0.25]]) {
    const g = new THREE.CircleGeometry(r, 16);
    xform(g, { pos: [x, y, z], rot: [0, Math.PI, 0] });
    nozzles.push(g);
  }
  const thrusterGlow = new THREE.Mesh(mergeGeos(nozzles), thrustMat);
  thrusterGlow.userData.noShadow = true;
  thrusterGlow.renderOrder = 1;
  body.add(thrusterGlow);

  // ---------------------------------------------------------------- lamps
  const lampRoot = new THREE.Group();
  body.add(lampRoot);
  const lampPos = [new THREE.Vector3(-0.80, -0.30, 1.62), new THREE.Vector3(0.80, -0.30, 1.62)];
  // Housings: a bezel around each lens so the lamp reads as a fitted unit rather
  // than as two glowing discs painted on the bow. Merged into the trim mesh, so
  // they cost nothing.
  for (const p of lampPos) {
    const c = new THREE.CylinderGeometry(0.185, 0.205, 0.13, 14, 1, true);
    xform(c, { pos: [p.x, p.y, p.z - 0.03], rot: [Math.PI * 0.5, 0, 0] });
    housings.push(c);
    const r = new THREE.TorusGeometry(0.180, 0.024, 6, 16);
    xform(r, { pos: [p.x, p.y, p.z + 0.035] });
    housings.push(r);
    // Reflector throat behind the lens. Without it the lamp is a disc pasted on
    // the bow; with it there is a shaded funnel visible round the rim from every
    // off-axis bearing, which is what gives a lamp depth in a still.
    const th = new THREE.CylinderGeometry(0.152, 0.055, 0.115, 16, 1, true);
    xform(th, { pos: [p.x, p.y, p.z - 0.035], rot: [-Math.PI * 0.5, 0, 0] });
    housings.push(th);
  }
  /**
   * Thruster wear.
   *
   * Everything on this hull is wear the octave stack applies uniformly; the one
   * place a real submersible wears DIFFERENTLY is around a jet, where the flow
   * strips coating in a ring. A raised scorch collar at each nozzle mouth reads as
   * that from any bearing and costs nothing — it merges into the trim mesh that
   * already carries the housings.
   */
  for (const [x, y, z, r] of [[-POD_X, POD_Y, -1.84, 0.30], [POD_X, POD_Y, -1.84, 0.30],
    [0, -0.02, -2.24, 0.31]]) {
    const collar = new THREE.TorusGeometry(r, 0.030, 6, 18);
    xform(collar, { pos: [x, y, z] });
    housings.push(collar);
    const lip = new THREE.CylinderGeometry(r - 0.01, r + 0.02, 0.055, 18, 1, true);
    xform(lip, { pos: [x, y, z - 0.035], rot: [Math.PI * 0.5, 0, 0] });
    housings.push(lip);
  }
  body.add(new THREE.Mesh(mergeGeos(housings), trimMat));
  const lenses = [];
  for (const p of lampPos) {
    const g = new THREE.CircleGeometry(0.150, 16);
    xform(g, { pos: [p.x, p.y, p.z + 0.03] });
    lenses.push(g);
  }
  const lampLens = new THREE.Mesh(mergeGeos(lenses), lensMat);
  lampLens.userData.noShadow = true;
  lampLens.renderOrder = 3;
  lampRoot.add(lampLens);

  /**
   * ONE SpotLight for two lamps.
   *
   * three evaluates every visible light in every lit fragment in the scene, so
   * the second lamp costs a full extra light's worth of shading across the whole
   * frame to move the pool 1.7 m sideways. The twin-beam read comes from the two
   * volumetric cones and the two lens flares, which are free by comparison — the
   * pool on the seabed only has to be in the right place, not doubled.
   */
  const spots = [(() => {
    /**
     * penumbra 0.86, not 0.55.
     *
     * The pool measured as a HARD-EDGED oval, and a hard edge on a light cone in
     * water is impossible: the beam is scattering the whole way out, so its own
     * shaft blurs the boundary long before the ground sees it. A wide penumbra
     * is the cheapest honest approximation of that, and it also stops the cone
     * angle from drawing a readable ellipse on flat sand.
     */
    const sp = new THREE.SpotLight(0xd6ecff, 0, 90, 0.42, 0.86, 1.8);
    /**
     * z = 2.40 puts the emitter 8 cm PAST the tip of the hull.
     *
     * It used to sit at z = 1.72 on the centreline, which is 40 cm inside a
     * shell whose nose reaches 2.32 — so with the headlights on (which is every
     * cockpit framing) a lamp boosted up to 42x for depth was firing straight
     * into the forward wall of the cockpit lining from 30 cm away. That is the
     * hard-edged white ellipse in the middle of the cockpit shot: not emissive,
     * not the sun, the vehicle's own headlight lighting the inside of its nose.
     * Ablation confirmed it — killing the emissive and the sun changed the patch
     * by 3/255, hiding the lining removed it entirely.
     */
    sp.position.set(0, -0.34, 2.46);
    /**
     * Aimed 5 deg DOWN, not level.
     *
     * A dead-level beam from a sub hovering 3 m over the seabed does not meet the
     * ground for 200 m, so the lamp lit the water and nothing else and the pool
     * the brief asks for never existed. 3.7 m of drop over 42 m puts the hot spot
     * about 35 m ahead at typical hover altitude — far enough that the cone still
     * reads as a shaft, close enough that terrain is inside it.
     */
    sp.target.position.set(0, -4.05, 42.4);
    lampRoot.add(sp); lampRoot.add(sp.target);
    return sp;
  })()];

  // running lights: port red / starboard green, plus underside markers.
  // One mesh, three colours, carried per vertex — see emitTintMat.
  {
    const tint = (g, r, gr, b) => {
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gr; c[i * 3 + 2] = b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    };
    const beads = [];
    beads.push(tint(xform(new THREE.SphereGeometry(0.055, 8, 6),
      { pos: [-(POD_X + 0.30), POD_Y, 0.20] }), 1.0, 0.10, 0.05));
    beads.push(tint(xform(new THREE.SphereGeometry(0.055, 8, 6),
      { pos: [POD_X + 0.30, POD_Y, 0.20] }), 0.12, 1.0, 0.35));
    for (const [x, z] of [[-0.55, -0.9], [0.55, -0.9], [0, 1.35]]) {
      beads.push(tint(xform(new THREE.SphereGeometry(0.045, 8, 6),
        { pos: [x, -0.78, z] }), 0.143, 0.258, 0.34));
    }
    const nav = new THREE.Mesh(mergeGeos(beads), emitTintMat);
    nav.name = 'seamoth.navLights';
    nav.userData.noShadow = true;
    nav.renderOrder = 1;
    body.add(nav);
  }

  // ---------------------------------------------------------------- cockpit
  const cockpit = new THREE.Group();
  cockpit.name = 'seamoth.cockpit';
  body.add(cockpit);

  /**
   * Console screens, placed by ANGLE FROM THE EYE, measured off the reference.
   *
   * In seamoth-cockpit-1.jpg the two sonar screens sit at +/-21 deg horizontally
   * and 24 deg below the eyeline, each subtending about 9 deg — small enough to
   * frame the view and never sit in it. They were previously authored in body
   * coordinates, which is why they drifted every time the cockpit moved; anchoring
   * them to a spherical bearing means the layout survives any change to where the
   * pilot sits.
   *
   * Both bezels, both stalks and both faces are baked into two meshes rather than
   * five: they share materials, the transforms are static, and five draws for
   * something that occupies 3 % of the frame is not a trade worth making.
   */
  /**
   * ...and the bezel is now a FRAME WITH A HOLE IN IT, not a slab with a decal
   * on the front.
   *
   * seamoth-cockpit-2.jpg's screens sit visibly BELOW the plane of their surround:
   * the top and left inner walls of the frame are in shadow, the bottom inner
   * wall catches the panel's own green light, and that pair of opposite-signed
   * edges is the whole reason it reads as an instrument rather than as a sticker.
   * Four bars around an 18 mm-deep opening buy both for 24 triangles.
   */
  /**
   * ...and it is SET INTO THE DASHBOARD, not hung in front of it on a stalk.
   *
   * Everything in this block is placed through `console.at(k, v)`, the fascia
   * frame built in consoleGeometry, so the bezel lies on the panel it is recessed
   * into by construction. Concretely:
   *
   *   bay floor   +4 mm proud of the fascia (it hides the fascia behind it, so
   *               the recess needs no hole cut in the panel)
   *   pane        +5 mm, i.e. 3 mm behind the bezel's front face
   *   bezel       a swept rounded-rect moulding whose front face is +8 mm
   *
   * That is a real recess — the reference's top and left inner walls in shadow,
   * the bottom one catching the panel's own green light — bought for 8 mm of
   * depth-buffer relief instead of the 46 mm box plus a 22 cm stalk standing off
   * a panel 8 cm further back. See the consoleGeometry note for why the depth
   * step, not the shading, was the thing that had to shrink.
   *
   * 8 mm, not the 16 it was, and the same halving went onto the structural rib
   * (19 -> 10) and its vent cover (19 -> 11). MEASURED, by masking the crushed
   * pixels of the shipping frame: postfx's SSAO paints a soft ~128 px band on
   * the fascia AROUND every proud fitting, because its contact ring's radius is
   * clamped in TEXELS (64 half-res) and therefore stops being 0.62 m and becomes
   * about 9 cm once the surface is a metre from the lens — while the 1/(d^2+0.02)
   * denominator keeps the gain it was given for a 0.62 m disc. On the sonar
   * bezel that band drove the fascia under and inboard of both screens to
   * literally zero. The recess reads off the SHADING of its four inner walls,
   * which is a function of their normals and not of their depth, so halving the
   * step costs the instrument nothing and halves what the estimator sees.
   * The estimator itself is core's and is reported as a bug: nothing a module
   * can do to its own geometry fixes an occlusion term that saturates on any
   * relief over about a centimetre at a metre.
   */
  const bezelGeo = [], faceGeo = [];
  const SCR_K = 0.775, SCR_V = 0.56;
  const _o = new THREE.Object3D();
  const _m = new THREE.Matrix4();
  const screenAnchors = [];
  const OW = 0.236, OH = 0.176, DP = 0.010;
  for (const s of [-1, 1]) {
    const con = s < 0 ? consoleL : consoleR;
    const fr = con.at(SCR_K, SCR_V);
    faceBasis(fr, _m);

    // The bezel: one closed sweep, so the moulding has a rounded outer profile
    // and a square inner wall the way a machined frame does.
    const path = [], nors = [];
    const hx = OW * 0.5, hy = OH * 0.5, cr = 0.030;
    const RS = 7;
    for (const [ox, oy, a0] of [[hx - cr, hy - cr, 0], [-(hx - cr), hy - cr, Math.PI * 0.5],
      [-(hx - cr), -(hy - cr), Math.PI], [hx - cr, -(hy - cr), Math.PI * 1.5]]) {
      for (let i = 0; i < RS; i++) {
        const a = a0 + (Math.PI * 0.5) * (i / RS);
        path.push(new THREE.Vector3(ox + Math.cos(a) * cr, oy + Math.sin(a) * cr, 0)
          .applyMatrix4(_m));
        nors.push(fr.n.clone());
      }
    }
    // section x = across the frame, y = out along the fascia normal
    bezelGeo.push(sweep(path, boxSection(0.030, DP, 0.006, 2).map(([x, y]) => [x, y + 0.003]),
      true, nors));
    const IW = OW - 0.030, IH = OH - 0.030;
    // bay floor: the back of the recess, and the thing that occludes the fascia
    bezelGeo.push(xform(new THREE.BoxGeometry(IW + 0.004, IH + 0.004, 0.008),
      { pos: [0, 0, 0.000] }).applyMatrix4(_m));
    // +5 mm, NOT +3: the bay floor is an 8 mm slab centred on the fascia, so it
    // spans -4..+4 and a pane at +3 is INSIDE it. Shipped that way for exactly one
    // capture and both sonar screens went out.
    const f = new THREE.PlaneGeometry(IW - 0.006, IH - 0.006);
    f.translate(0, 0, 0.005);
    faceGeo.push(f.applyMatrix4(_m));
    screenAnchors.push(fr.p.clone());

    /**
     * A LIGHT GUIDE round the bezel, and it is the reference's own detail.
     *
     * Point-sampled, seamoth-cockpit-1.jpg's screen surround reads (43,83,112)
     * and its lower inner wall is visibly greener than its upper one, because a
     * recessed panel throws its own light onto the frame around it. We had the
     * recess and none of the light. This states the same fact as a physical part
     * — the edge-lit acrylic surround these instruments are actually mounted in
     * — so it survives being looked at from 40 cm.
     *
     * It sits OUTSIDE the moulding rather than inside the recess, which is where
     * the veil it produces is worth most: the bezel is the single worst-affected
     * region of the frame under postfx's near-field SSAO (see the report), and
     * postfx adds bloom after the AO multiply.
     */
    {
      const gp = [], gn = [];
      const ghx = hx + 0.016, ghy = hy + 0.016, gcr = cr + 0.014;
      for (const [ox, oy, a0] of [[ghx - gcr, ghy - gcr, 0],
        [-(ghx - gcr), ghy - gcr, Math.PI * 0.5],
        [-(ghx - gcr), -(ghy - gcr), Math.PI], [ghx - gcr, -(ghy - gcr), Math.PI * 1.5]]) {
        for (let i = 0; i < RS; i++) {
          const a = a0 + (Math.PI * 0.5) * (i / RS);
          gp.push(new THREE.Vector3(ox + Math.cos(a) * gcr, oy + Math.sin(a) * gcr, 0)
            .applyMatrix4(_m));
          gn.push(fr.n.clone());
        }
      }
      glow(sweep(gp, boxSection(0.019, 0.007, 0.003, 2).map(([x, y]) => [x, y + 0.005]),
        true, gn), 0.200, 0.520, 0.480);
    }
    /**
     * The pane itself as an EMITTER. 0.30 W-ish at a 12 cm softening radius: at
     * the 4 cm from pane to bezel that lands the frame near the reference's 76
     * luminance, and by the coaming 60 cm away it has fallen to a wash.
     */
    pushEmit(fr.p.clone().addScaledVector(fr.n, 0.008), fr.n,
      new THREE.Color(0.13, 1.0, 0.62), 0.235, 0.12, 'screen');

    /**
     * The structural rib — "a frame with visible thickness", which is the one
     * thing seamoth-cockpit-1.jpg has that we had nothing at all of.
     *
     * In the reference a broad navy member runs from the coaming down across the
     * dashboard just outboard of the sonar, carrying a recessed vent panel, and
     * it is what tells you the white shell is a skin over a structure. Ours rides
     * the same fascia frame at k = 0.575 (about 29 deg off axis, clear of the
     * bezel's outboard edge by 4 cm) and runs from 30 % up the crest to 20 %
     * below the fascia foot, so it visibly passes UNDER the dashboard lip rather
     * than stopping at it. 85 mm wide, 16 mm proud: wide enough to read as a
     * member at a metre, shallow enough to stay inside the AO estimator's
     * distance-scaled bias.
     */
    const RIB_K = 0.575;
    const rpath = [], rnors = [];
    for (let i = 0; i <= 8; i++) {
      const rf = con.at(RIB_K, lerp(0.03, 1.22, i / 8));
      rpath.push(rf.p); rnors.push(rf.n);
    }
    const ribSec = boxSection(0.085, 0.010, 0.005, 2).map(([x, y]) => [x, y + 0.0035]);
    bezelGeo.push(sweep(rpath, ribSec, false, rnors));
    // Cap both ends. An open sweep is a tube, and from the pilot's seat you look
    // straight down the top of it — the crest bead hides the upper end, but a
    // 19 x 85 mm hole under the dashboard lip is visible and reads as damage.
    for (const rv of [0.03, 1.22]) {
      const cf = con.at(RIB_K, rv);
      faceBasis(cf, _m);
      bezelGeo.push(xform(new THREE.BoxGeometry(0.085, 0.005, 0.010),
        { pos: [0, 0, 0.0035] }).applyMatrix4(_m));
    }
    /**
     * The vent panel on it: a raised hatch outline with three louvre slats.
     *
     * seamoth-cockpit-1.jpg has a recessed rectangular slot through this member,
     * dark-lined, immediately above the sonar. A slot needs a hole in the rib and
     * a hole needs the rib to be a solid rather than a sweep, so this states the
     * same fact the other way up — a fastened cover plate over the aperture, six
     * millimetres proud, with the louvres in it. Same signal at a metre: somebody
     * bolted a serviceable part onto a structural member.
     */
    {
      const vf = con.at(RIB_K, 0.285);
      faceBasis(vf, _m);
      const put = (w, h, x, y, z) => bezelGeo.push(
        xform(new THREE.BoxGeometry(w, h, 0.008), { pos: [x, y, z] }).applyMatrix4(_m));
      const vw = 0.064, vh = 0.054, t = 0.007;
      put(vw, t, 0, (vh - t) * 0.5, 0.011);
      put(vw, t, 0, -(vh - t) * 0.5, 0.011);
      put(t, vh, (vw - t) * 0.5, 0, 0.011);
      put(t, vh, -(vw - t) * 0.5, 0, 0.011);
      for (let i = 0; i < 3; i++) put(vw - 0.022, 0.0055, 0, (i - 1) * 0.0135, 0.0095);
    }
  }
  /**
   * The dashboard wash: a 13 mm light guide running the whole length of each
   * console, tucked just under the crest bead.
   *
   * This is the interior's PRIMARY source and the reason the fascia now has a
   * gradient down it instead of one value. It is also the answer to the thing
   * the reference makes obvious and we never had: in seamoth-cockpit-1/2.jpg the
   * console face is brightest at the top and falls off toward the footwell, i.e.
   * it is lit from a line along its own upper edge. A flat fill cannot do that
   * at any level, which is why raising the flat fill kept over-brightening the
   * panels while leaving the skirt black.
   *
   * The bead above it hides the emitter from the pilot's eye at the seat, so
   * what is visible is the wash rather than the lamp — which is how a real
   * cove light is installed and why it does not read as neon.
   */
  for (const s of [-1, 1]) {
    const con = s < 0 ? consoleL : consoleR;
    const gp = [], gn = [];
    const NK = 14;
    for (let i = 0; i <= NK; i++) {
      const f2 = con.at(lerp(0.06, 0.96, i / NK), 0.085);
      gp.push(f2.p.clone().addScaledVector(f2.n, 0.004));
      gn.push(f2.n.clone());
    }
    glow(sweep(gp, boxSection(0.020, 0.007, 0.003, 2).map(([x, y]) => [x, y + 0.005]),
      false, gn), 0.400, 0.560, 0.660);
    // Two emitters would be better than one on a 70 cm run, but the budget is
    // eight and the screens have first call. Sampled at the middle of the run,
    // which is where the console's own curvature puts it closest to the whole
    // fascia rather than to one end of it.
    /**
     * i = 0.32 at a 0.28 m softening radius, and both halves of that are set by
     * one measurement rather than by eye.
     *
     * Crop the near console (x 0.155-0.28, y 0.80-0.98) and compare like for
     * like: seamoth-cockpit-1.jpg runs median 85 / p90 104, -2.jpg runs 105 /
     * 137. At i = 0.44 and a 0.20 m radius ours came back 98 / 189 — the median
     * landed exactly between the two references and the p90 was 40-80 % over
     * them, i.e. a cove light that had become a blown streak down the panel.
     * Cutting the intensity and WIDENING the source together is what fixes that
     * shape specifically: 1/(r^2 + s^2) at 0.3 m drops to 0.56 of what it was
     * while at 0.8 m it only drops to 0.69, so the near end comes down twice as
     * hard as the far end. A cove light really is 0.7 m of lit acrylic and not a
     * point, so the wider source is also the more honest one.
     */
    const mid = con.at(0.52, 0.085);
    pushEmit(mid.p.clone().addScaledVector(mid.n, 0.012), mid.n,
      new THREE.Color(0.60, 0.80, 0.96), 0.32, 0.28, 'lamp');
  }
  // The two bezels and the dash bay all ride trimInMat and are all static in
  // cockpit space, so the mesh is not built here — bezelGeo stays open until the
  // instrument bay below has pushed its rim into it, and the whole fitting set
  // ships as one draw. See the note where `fittings` is added.
  const screenFaces = new THREE.Mesh(mergeGeos(faceGeo), screenMat);
  screenFaces.userData.noShadow = true;
  cockpit.add(screenFaces);
  const screens = screenAnchors;

  /**
   * The centre console — a moulded crown, not a floating panel.
   *
   * What used to be here was a 0.46 x 0.13 m transparent plane of dark navy
   * hanging in mid-air on the eyeline's lower third. Grid-sampled against
   * seamoth-cockpit-2.jpg it was the single darkest thing in the frame: our
   * centre band measured luminance 0-5 where the reference's yoke crown measures
   * 74-131 and is plainly a lit, moulded, three-dimensional object with a rounded
   * top, a shadow line under it and four button wells across it. A flat card can
   * never read that way however it is shaded, so the card is gone and the object
   * it was pretending to be is built.
   *
   * Placed by bearing from the eye, like everything else in here: the reference's
   * crown breaks the frame at 27 deg below the eyeline and fills to the bottom
   * edge, which is 7 deg of picture. Ours breaks at 25 and is 0.80 m away.
   */
  /**
   * NARROW. The first build of this was 0.68 m across at 0.80 m, which subtends
   * +/-23 deg — and the sonar screens live at +/-21, so the crown ate both of
   * them and the cockpit lost its two brightest elements. Measured off
   * seamoth-cockpit-2.jpg the reference crown spans +/-11.5 deg; 0.40 m at 0.92 m
   * is 12.3, which clears the screens with 9 deg to spare.
   */
  const pedY = PED_Y, pedZ = PED_Z;
  {
    const parts = [], mass = [];
    const crown = new THREE.CylinderGeometry(PED_R, PED_R, PED_L, 16, 1, false);
    crown.rotateZ(Math.PI * 0.5);
    parts.push(xform(crown, { pos: [0, pedY - PED_R, pedZ - 0.045] }));
    for (const s of [-1, 1]) {
      parts.push(xform(new THREE.SphereGeometry(PED_R, 14, 10),
        { pos: [s * PED_L * 0.5, pedY - PED_R, pedZ - 0.045] }));
      /**
       * Grip horns, 105 mm not 185.
       *
       * At 185 mm their tops stood 52 mm above the surround, and 52 mm is inside
       * postfx's AO death band (3 mm to 0.62 m at this range) — masked, the last
       * crushed crescents were their silhouettes exactly. Stubbed to 105 mm they
       * stand 18 mm proud, under the estimator's own bias, and they are also
       * closer to the reference: seamoth-cockpit-1/2.jpg show the Seamoth's grips
       * as short moulded horns on a rounded mass, not sticks.
       */
      parts.push(xform(new THREE.CylinderGeometry(0.030, 0.039, 0.105, 10),
        { pos: [s * 0.152, pedY - 0.098, pedZ + 0.050], rot: [-0.62, 0, s * 0.26] }));
    }
    /**
     * The column into the footwell, and the lip that gives the crown its shadow.
     *
     * The column is 0.72 m across, not 0.235, and it is now a CENTRE CONSOLE that
     * reaches the two side consoles rather than a stalk standing in a void.
     *
     * Masked on the shipping frame, the largest single region of pure black in
     * the cockpit was a V between each console's inboard skirt and this column —
     * a 0.2 m depth cliff with nothing bridging it, which is squarely inside the
     * band postfx's AO estimator turns into a hard shadow (see the report: below
     * 0.03 m it falls under the bias, above 0.62 m the range term kills it, and
     * everything between goes to zero). Filling it is also what the reference
     * does: seamoth-cockpit-1/2.jpg both show one continuous pale moulded mass
     * about a third of frame wide from the yoke out to each console, not a
     * pedestal with air beside it.
     */
    /**
     * ...and the box is now a ROUNDED APRON that reaches the consoles, which is
     * the single largest remaining fix in this frame.
     *
     * Masked at max(RGB) <= 3 on the r10 build, then again after halving every
     * proud fitting's relief, the crushed region collapsed to one shape: a pair
     * of wedges between each console's inboard skirt foot and this column. The
     * box stopped at x = +/-0.36 and z = pedZ+0.055 while the console's inboard
     * foot is at x = +/-0.17, z = pedZ+0.24 — a 0.19 m depth trough with a
     * concave corner running its whole length, which is the one shape an
     * ambient-occlusion estimator is built to darken and this one drives to
     * literally zero.
     *
     * A scaled sphere rather than a bigger box, for two reasons that agree. It
     * is convex and smooth, so the depth-derived normals the estimator works
     * from vary continuously instead of stepping; and seamoth-cockpit-1/2.jpg
     * both show one continuous pale moulded mass from the yoke out to each
     * console with a rounded top and no visible joint, not a pedestal with a
     * pair of slots beside it. Its top clears the inboard fascia foot by 45 mm
     * everywhere, so the dashboard still overhangs it and still casts the shadow
     * line that gives the console its edge.
     */
    mass.push(xform(new THREE.SphereGeometry(0.5, 22, 14),
      { pos: APRON.c.toArray(), scale: [APRON.r.x * 2, APRON.r.y * 2, APRON.r.z * 2] }));
    // the column into the footwell, inside the apron's own silhouette
    mass.push(xform(new THREE.BoxGeometry(0.56, 0.42, 0.28),
      { pos: [0, pedY - 0.62, pedZ - 0.085] }));
    for (const sd of [-1, 1]) mass.push(centreStackGeometry(sd, consoleL.Fa));
    // (the flat lip plate that used to sit here is gone — see STACK: a horizontal
    // face 7 cm under a 14 cm bar is the exact geometry postfx's AO estimator
    // drives to zero, and masked on the previous build it WAS the crushed region)
    /**
     * Merged into the console mesh: same material, static transform, and a
     * separate draw for it would be a draw call spent on nothing.
     *
     * Its uv has to be remapped first. consoleTexture is authored in the console's
     * own v — 0 at the footwell, 0.5 on the crest, 1 outboard — and a cylinder's
     * or a sphere's own v sweeps the whole range, so an unremapped crown would
     * wear the navy skirt as a band round its middle. Squeeze it into 0.72-0.94,
     * which is clean panel carrying one seam and the fastener run.
     */
    /**
     * ...and the yoke is moulded in a DARKER plastic than the console it sits
     * between, carried per-vertex so it still costs no draw.
     *
     * Point-sampled at matched positions, seamoth-cockpit-1.jpg's yoke mass
     * reads 51-60 luminance and -2.jpg's 18-20, against its own console face at
     * 100-137 — the centre column is the DARKEST large object in the reference
     * cockpit and ours was the brightest, at 185-211. Every lighting term in
     * here is proportional to albedo (the bounce, the fill and the emitters all
     * multiply diffuseColor), so a vertex tint is the one handle that moves this
     * one mass without touching the two consoles it is merged with, and it is
     * also the honest description: the yoke is a different part in a different
     * colour, not the same panel in a shadow.
     *
     * Measured on the shipping capture, the crown goes 211 -> 74.9 against
     * seamoth-cockpit-1.jpg's 51-60, and it takes the whole lower third's p90
     * from 145.4 down to 129.9 against the plates' 135.7 and 139.1 — this tint
     * is the last third of that move, not a detail. It COSTS crushed fraction:
     * 6.0 % -> 8.6 %, because a correctly-dark near-lens surface is exactly what
     * postfx's SSAO takes to zero. With the SSAO ablated the same frame crushes
     * 0.007 %, which is where that number actually comes from.
     */
    /**
     * TWO tints, because the yoke and the apron are two different parts and the
     * previous round painted them as one.
     *
     * The 0.34 tint was derived from the reference's YOKE — seamoth-cockpit-1.jpg
     * reads 51-60 there and -2.jpg 18-20 — and that reading is right for the
     * crown, the grip horns and the lip under them. It was then applied to the
     * apron as well, and the apron is not the yoke: in both plates the mass
     * running from the column out to each console is the same pale moulding as
     * the console face, at 100-137. Its own note records the cost of getting
     * that wrong — "6.0 % -> 8.6 %" crushed — which is 41 % of this round's
     * regression, and it is the largest near-lens surface in the frame.
     *
     * So the crown keeps the dark plastic and the apron joins the moulding it is
     * continuous with. It is also the half of the fix the valance cannot do on
     * its own: closing the depth cliff stops ao being IDENTICALLY zero, and only
     * then does the surface's own radiance decide the pixel.
     */
    const YOKE_TINT = 0.34;
    /**
     * 0.78, swept and measured on the lower third:
     *
     *   0.70   p90 131.9   crushed 2.50 %
     *   0.85   p90 143.2   crushed 2.30 %
     *   0.95   p90 144.8   crushed 2.21 %
     *
     * 0.85 and 0.95 are both inside the 130-145 band but sit ABOVE both
     * reference plates (135.7 and 139.1) for a crush gain of a tenth of a point,
     * which is inside the run-to-run floor. 0.78 lands p90 between the plates and
     * keeps almost all of it. It is albedo on the one large surface the crushed
     * region sits on, which is the honest lever: every lighting term in here
     * multiplies diffuseColor, so this raises that surface's floor without
     * touching the grade and without going anywhere near bloom.
     */
    const APRON_TINT = 0.78;
    const tint = (list, k) => {
      for (const g of list) {
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setY(i, 0.72 + 0.22 * uv.getY(i));
        uv.needsUpdate = true;
        const n = g.attributes.position.count;
        g.setAttribute('color',
          new THREE.BufferAttribute(new Float32Array(n * 3).fill(k), 3));
      }
    };
    tint(parts, YOKE_TINT);
    tint(mass, APRON_TINT);
    // mergeGeos fills the console faces' own slice with 1, so only the yoke is
    // tinted; vertexColors has to be on for three to read the attribute at all.
    consoleMat.vertexColors = true;
    consoleMat.needsUpdate = true;
    consoleMesh.geometry = mergeGeos([consoleMesh.geometry, ...parts, ...mass]);
  }

  /**
   * The instrument bay, RECESSED into that crown.
   *
   * The dash is a real readout the player uses, so it stays — but it is now sunk
   * 14 mm behind a metal rim standing on the crown's upper face, which is how
   * every instrument in the reference cockpit is mounted, and it is opaque, so
   * there is no longer a translucent black rectangle multiplying the water behind
   * it down to nothing.
   */
  const BAY_EL = 27.5 * DEG, BAY_D = 0.855, BAY_W = 0.216, BAY_H = 0.060;
  const dashPanel = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - 0.020, BAY_H - 0.018), dashMat);
  {
    _o.position.set(0, SEA.eye.y - Math.sin(BAY_EL) * BAY_D,
      SEA.eye.z + Math.cos(BAY_EL) * BAY_D);
    _o.lookAt(SEA.eye);
    _o.updateMatrix();
    /**
     * 18 mm of rim, not 42.
     *
     * The recess reads off the SHADING of the four inner walls, which is a
     * function of their normals and not of their depth — but the depth is what
     * postfx's AO estimator sees, and at 0.86 m from the lens a 42 mm step is
     * four times its distance-scaled bias and paints a black band round the whole
     * instrument. 18 mm still puts the pane 13 mm behind the rim's front face,
     * which at this range is 0.9 deg of parallax: visible as a recess, invisible
     * to the bias.
     */
    const rim = [];
    const rw = 0.013, rd = 0.018;
    for (const [w, h, x, y] of [
      [BAY_W, rw, 0, (BAY_H + rw) * 0.5], [BAY_W, rw, 0, -(BAY_H + rw) * 0.5],
      [rw, BAY_H, (BAY_W + rw) * 0.5, 0], [rw, BAY_H, -(BAY_W + rw) * 0.5, 0],
    ]) {
      rim.push(xform(new THREE.BoxGeometry(w, h, rd), { pos: [x, y, 0] })
        .applyMatrix4(_o.matrix));
    }
    // The bay floor stays where it was. Moving it forward with the rim put it
    // through the dash pane — the readout shipped as a black rectangle for
    // exactly one capture — and it has no reason to move: it is the back of the
    // recess, and the recess is measured from the rim's FRONT face.
    rim.push(xform(new THREE.BoxGeometry(BAY_W, BAY_H, 0.008), { pos: [0, 0, -0.020] })
      .applyMatrix4(_o.matrix));
    for (const g of rim) bezelGeo.push(g);
    dashPanel.position.copy(_o.position);
    dashPanel.quaternion.copy(_o.quaternion);
    dashPanel.translateZ(rd * 0.5 - 0.013);
    // The readout is a lit panel 85 cm from the eye and it lit nothing. Its own
    // spill is what puts the highlight on the top of the crown and on the inner
    // faces of the bay rim, which is the pair of shading cues that says the
    // instrument is SET INTO something.
    pushEmit(dashPanel.position.clone(),
      _v1.copy(SEA.eye).sub(_o.position).normalize(),
      new THREE.Color(0.86, 0.90, 0.98), 0.070, 0.10, 'screen');
  }
  dashPanel.userData.noShadow = true;
  dashPanel.renderOrder = 3;
  cockpit.add(dashPanel);

  /**
   * Every trimInMat fitting in one mesh: both screen bezels, both stalks, both
   * bay floors and the instrument bay rim.
   *
   * They were two draws (bezels, then the bay) for 244 triangles of navy plastic
   * sharing one material and one static transform. Nothing about them varies at
   * runtime, so there was never a reason for them to be separable.
   */
  const fittings = new THREE.Mesh(mergeGeos(bezelGeo), trimInMat);
  fittings.name = 'seamoth.fittings';
  fittings.userData.noShadow = true;
  cockpit.add(fittings);

  // four button wells across the crown, cyan-rimmed, straight off the reference
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(0.021, 0.0050, 6, 14);
    g.rotateX(-0.5);
    xform(g, { pos: [(i - 1.5) * 0.058, pedY - 0.048, pedZ + 0.058] });
    glow(g, 0.100, 0.285, 0.350);
  }
  /**
   * The lip strip under the yoke crown.
   *
   * The crown's own lip already casts the shadow line that gives it mass; a
   * light guide tucked under it is what a real console does with that lip, and
   * it is the only source anywhere near the footwell — which, masked on the
   * shipping frame, is the largest continuous dark region in the cockpit.
   */
  {
    const lip = xform(new THREE.BoxGeometry(0.560, 0.010, 0.014),
      { pos: [0, pedY - 0.196, pedZ + 0.070] });
    glow(lip, 0.300, 0.520, 0.620);
    /**
     * ...and a second run following the apron's own shoulder, which is where
     * the black actually is.
     *
     * Masked after the apron went in, the crushed region did not shrink, it
     * MOVED: it is now a smooth arc hugging the junction where the apron meets
     * the yoke pedestal, because postfx's near-field SSAO finds whatever
     * junction is nearest the lens and saturates on it. Geometry cannot win that
     * argument — the third attempt at it (halved fittings, then a convex apron)
     * moved the shape twice and the fraction barely at all. What CAN reach those
     * pixels is bloom, which postfx adds after the AO multiply, so the answer is
     * a real light in the place the frame is black. seamoth-cockpit-2.jpg has
     * one there: a lit cyan bar across the bottom of the yoke.
     *
     * Thirteen segments rather than a swept arc because the run lies on the
     * apron's own ellipsoid, and stepping x while solving the ellipsoid for the
     * other two axes puts every segment ON the surface by construction.
     */
    for (let i = 0; i <= 12; i++) {
      const x = (-1 + 2 * i / 12) * 0.395;
      const k = Math.sqrt(Math.max(0, 1 - (x / 0.47) ** 2));
      glow(xform(new THREE.BoxGeometry(0.070, 0.009, 0.013), {
        pos: [x, pedY - 0.44 + 0.25 * k * 0.90, pedZ + 0.04 + 0.40 * k * 0.62],
        rot: [-0.62, 0, 0],
      }), 0.285, 0.470, 0.560);
    }
    pushEmit(new THREE.Vector3(0, pedY - 0.24, pedZ + 0.16),
      new THREE.Vector3(0, 0.42, 0.91), new THREE.Color(0.34, 0.60, 0.74),
      0.150, 0.22, 'lamp');
  }

  /**
   * The seat is UPHOLSTERED.
   *
   * It was five boxes, which through the canopy read as a stack of crates — and
   * blind pair 012 named the padding specifically. A real pilot's seat is a set
   * of foam rolls separated by seam channels, with a stitched centre panel and
   * bolsters that stand proud of it; that silhouette survives being 8 m away and
   * behind glass, which is where this object is actually judged from. Each roll
   * is a rounded box, the seams are the gaps between them, and padTexture()
   * carries the quilting and the stitch line.
   */
  {
    const parts = [];
    const roll = (w, h, d, x, y, z, rx) => {
      const g = new THREE.SphereGeometry(0.5, 12, 8);
      g.scale(w, h, d);
      return xform(g, { pos: [x, y, z], rot: [rx || 0, 0, 0] });
    };
    // squab: three transverse rolls with 12 mm seam channels between them
    for (let i = 0; i < 3; i++) {
      parts.push(roll(0.44, 0.115, 0.150, 0, -0.605 + i * 0.008, 0.185 + i * 0.163, 0));
    }
    // backrest: three stacked rolls, raked back 10 deg
    for (let i = 0; i < 3; i++) {
      parts.push(roll(0.40, 0.170, 0.105, 0, -0.475 + i * 0.185, 0.070 - i * 0.032, -0.18));
    }
    // side bolsters, standing proud of the centre panel
    for (const s of [-1, 1]) {
      parts.push(roll(0.095, 0.145, 0.470, s * 0.245, -0.575, 0.330, 0));
      parts.push(roll(0.085, 0.400, 0.115, s * 0.205, -0.310, 0.045, -0.18));
    }
    // headrest
    parts.push(roll(0.255, 0.155, 0.105, 0, 0.115, -0.020, -0.18));
    const seat = new THREE.Mesh(mergeGeos(parts), padMat);
    seat.name = 'seamoth.seat';
    seat.userData.noShadow = true;   // inside a sealed hull; see the rim note
    cockpit.add(seat);
    // harness anchors: two dark straps over the backrest, in the seal rubber.
    // Merged into the canopy seal — same material, same static body space (the
    // cockpit group carries no transform of its own), so a separate mesh here
    // bought a draw call for 24 triangles of webbing.
    const straps = [];
    for (const s of [-1, 1]) {
      straps.push(xform(new THREE.BoxGeometry(0.055, 0.44, 0.016),
        { pos: [s * 0.105, -0.245, 0.128], rot: [-0.18, 0, s * 0.10] }));
    }
    seal.geometry = mergeGeos([seal.geometry, ...straps]);
  }

  /**
   * Cabin lighting: a visible fixture plus a soft fill.
   *
   * The lamp is a recessed strip on the aft coaming, BEHIND and above the
   * pilot's head, which is where a real one goes and — more to the point —
   * outside the eyeline. Decay 1 instead of 2 and a 5.2 m range spread the
   * falloff out over the whole tub instead of concentrating it into a clipped
   * ellipse 30 cm across; the lining's own raised emissive now carries most of
   * the level and this only shapes it.
   */
  {
    glow(xform(new THREE.BoxGeometry(0.34, 0.030, 0.10),
      { pos: [0, 0.545, -0.60], rot: [0.42, 0, 0] }), 0.620, 0.720, 0.830);
    // Two shoulder wash-lamps forward of the pilot's head, aimed down and
    // inboard at the consoles. The reference's dashboard is plainly lit from
    // above-left; one aft strip cannot produce that, and a source you can see is
    // the only honest way to explain a highlight.
    for (const s of [-1, 1]) {
      glow(xform(new THREE.BoxGeometry(0.075, 0.026, 0.075),
        { pos: [s * 0.31, 0.40, 0.32], rot: [0.2, 0, s * 0.3] }), 0.560, 0.660, 0.760);
      pushEmit(new THREE.Vector3(s * 0.31, 0.385, 0.32),
        new THREE.Vector3(-s * 0.34, -0.90, 0.27), new THREE.Color(0.62, 0.79, 0.96),
        0.155, 0.30, 'lamp');
    }
  }
  /**
   * Everything self-lit and small inside the tub, in one draw.
   *
   * Button rings, four light guides, the crown lip strip and the overhead
   * fixture: seven separate objects, one material, one static transform, one
   * draw call. It used to be two (buttons, fixture) and the light guides would
   * have been two or three more.
   */
  {
    const glowMesh = new THREE.Mesh(mergeGeos(glowGeo), glowMat);
    glowMesh.name = 'seamoth.lightGuides';
    glowMesh.userData.noShadow = true;
    glowMesh.renderOrder = 2;
    cockpit.add(glowMesh);
  }
  // 1.0, not 1.5: with the flat cabin fill raised, the point light only has to
  // shape the moulding, and at 1.5 it was most of the console's 2.5:1 spread.
  const cabinLight = new THREE.PointLight(0x7cc4ee, 1.0, 5.2, 1);
  cabinLight.position.set(0, 0.50, -0.52);
  cockpit.add(cabinLight);

  // hatch on the coaming, hinged for the docking animation
  const hatchPivot = new THREE.Group();
  hatchPivot.position.set(0, 0.74, -1.34);
  {
    const g = new THREE.CylinderGeometry(0.36, 0.36, 0.07, 18);
    xform(g, { pos: [0, 0, 0.34] });
    hatchPivot.add(new THREE.Mesh(g, podMat));
  }
  body.add(hatchPivot);

  body.traverse((o) => { if (o.isMesh) noReceive.push(o); });

  return {
    root, body, hull, greeble: greebleMesh, glass, glassMat, interior, cockpit,
    lampRoot, lampLens, spots,
    thrusterGlow, thrustMat, hatchPivot, cabinLight, screens, dashPanel,
    sonar, dash, lampPos, noReceive, cabEmit,
    materials: [hullMat, podMat, trimMat, cabinMat, consoleMat, sillMat, trimInMat,
      sealMat, boltMat, padMat,
      screenMat, dashMat, lensMat, emitTintMat, thrustMat, glowMat],
  };
}

// ============================================================== the Seaglide
function buildSeaglide(rng, holo) {
  const root = new THREE.Group();
  root.name = 'seaglide';
  root.visible = false;

  // Cool pearl, same paint as the Seamoth's shell — a warm cream here read as a
  // green tool in a green frame for exactly the reason the hull did.
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xd9e2ef, roughness: 0.52, metalness: 0.10,
    emissive: new THREE.Color(0.092, 0.122, 0.170),
  });
  applyUnderwater(shellMat, { caustics: 0.35, fogScale: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x22303c, roughness: 0.42, metalness: 0.35,
    emissive: new THREE.Color(0.040, 0.052, 0.064),
  });
  applyUnderwater(darkMat, { caustics: 0.35, fogScale: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x1a0d02, roughness: 0.4, metalness: 0.1,
    emissive: new THREE.Color(1.0, 0.48, 0.10).multiplyScalar(1.6),
  });
  applyUnderwater(accentMat, { caustics: 0 });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.2, metalness: 0,
    emissive: new THREE.Color(0.88, 0.96, 1.0).multiplyScalar(EMIT.lens * 0.08),
  });
  applyUnderwater(lensMat, { caustics: 0 });
  // A projected hologram is self-lit, so it goes through the emissive channel —
  // a MeshBasicMaterial would have been dimmed by core's depth response and the
  // map would have gone out exactly where a diver most needs it.
  const holoMat = new THREE.MeshStandardMaterial({
    color: 0x000000, map: holo.tex, emissiveMap: holo.tex,
    emissive: new THREE.Color(1, 1, 1).multiplyScalar(2.1),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  applyUnderwater(holoMat, { caustics: 0, fogScale: 0.05 });

  // body: a fat lozenge with a handgrip under it
  const body = [];
  body.push(xform(podGeometry(0.46, 0.075, 0.105, 16, 14), { pos: [0, 0, -0.04] }));
  body.push(xform(new THREE.BoxGeometry(0.075, 0.155, 0.115), { pos: [0, -0.115, -0.06], rot: [0.22, 0, 0] }));
  body.push(xform(new THREE.SphereGeometry(0.052, 10, 8), { pos: [0, -0.195, -0.045] }));
  root.add(new THREE.Mesh(mergeGeos(body), shellMat));

  const dark = [];
  // shroud ring around the propeller
  dark.push(xform(new THREE.TorusGeometry(0.105, 0.020, 8, 22), { pos: [0, 0, 0.185] }));
  dark.push(xform(new THREE.CylinderGeometry(0.105, 0.098, 0.075, 20, 1, true), { pos: [0, 0, 0.185], rot: [Math.PI * 0.5, 0, 0] }));
  // spine rails
  for (const s of [-1, 1]) {
    dark.push(xform(new THREE.BoxGeometry(0.016, 0.030, 0.30), { pos: [s * 0.098, 0.005, 0.07] }));
  }
  root.add(new THREE.Mesh(mergeGeos(dark), darkMat));

  // propeller, spun in update()
  const prop = new THREE.Group();
  prop.position.set(0, 0, 0.185);
  {
    const blades = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BoxGeometry(0.082, 0.012, 0.030);
      xform(g, { pos: [0.048, 0, 0], rot: [0, 0, 0] });
      const q = new THREE.Matrix4().makeRotationZ(i * TAU / 3);
      g.applyMatrix4(q);
      blades.push(g);
    }
    blades.push(xform(new THREE.CylinderGeometry(0.024, 0.024, 0.05, 8), { rot: [Math.PI * 0.5, 0, 0] }));
    prop.add(new THREE.Mesh(mergeGeos(blades), darkMat));
  }
  root.add(prop);

  // orange trim ring + lamp
  root.add(new THREE.Mesh(
    xform(new THREE.TorusGeometry(0.088, 0.007, 6, 20), { pos: [0, 0, 0.045] }), accentMat));
  const glideLens = new THREE.Mesh(
    xform(new THREE.CircleGeometry(0.030, 14), { pos: [0.0, 0.050, 0.225] }), lensMat);
  glideLens.userData.noShadow = true;
  glideLens.renderOrder = 3;
  root.add(glideLens);

  const glideSpot = new THREE.SpotLight(0xd8eeff, 0, 55, 0.44, 0.86, 1.7);
  glideSpot.position.set(0, 0.055, 0.22);
  glideSpot.target.position.set(0, 0.0, 30);
  root.add(glideSpot); root.add(glideSpot.target);

  // holographic map, floating above the body
  const holoPanel = new THREE.Mesh(new THREE.PlaneGeometry(0.135, 0.135), holoMat);
  holoPanel.position.set(0, 0.118, 0.02);
  holoPanel.rotation.x = -0.72;   // tipped up toward the diver, not laid flat
  holoPanel.userData.noShadow = true;
  holoPanel.renderOrder = 4;
  root.add(holoPanel);

  // a faint projector cone linking the body to the map
  {
    const g = new THREE.ConeGeometry(0.060, 0.10, 14, 1, true);
    xform(g, { pos: [0, 0.068, 0.01] });
    const m = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: new THREE.Color(0.05, 0.20, 0.28),
      transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    applyUnderwater(m, { caustics: 0, fogScale: 0.05 });
    const cone = new THREE.Mesh(g, m);
    cone.userData.noShadow = true;
    cone.renderOrder = 4;
    root.add(cone);
  }

  // exhaust bubbles from the shroud
  const bubbleCount = 22;
  const bg = new THREE.SphereGeometry(1, 6, 5);
  const bm = new THREE.MeshStandardMaterial({
    color: 0xbfe6f6, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.30,
    emissive: new THREE.Color(0.30, 0.55, 0.70),
  });
  applyUnderwater(bm, { caustics: 0 });
  const bubbles = new THREE.InstancedMesh(bg, bm, bubbleCount);
  bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bubbles.frustumCulled = false;
  bubbles.userData.noShadow = true;
  bubbles.renderOrder = 2;
  const bubbleState = [];
  for (let i = 0; i < bubbleCount; i++) {
    bubbleState.push({ t: rng(), x: (rng() - 0.5) * 0.08, y: (rng() - 0.5) * 0.08, s: 0.0022 + rng() * 0.0045 });
  }
  root.add(bubbles);

  // A first-person view model has no arm attached to it, so a cast shadow would
  // be a tool hovering unsupported over the sand.
  root.traverse((o) => { o.userData.noShadow = true; });

  return { root, prop, glideSpot, glideLens, holoPanel, bubbles, bubbleState, materials: [shellMat, darkMat, accentMat, lensMat] };
}

// ============================================================== module state
let ctxRef = null;
let group = null;
let sm = null;             // seamoth parts
let sg = null;             // seaglide parts
let holo = null;
let beams = [];            // {mesh, mat, index}
let glideBeam = null;
let terrain = null, movement = null, underwater = null, uwResolved = false;
let rngRoot = null;

const state = {
  // seamoth
  pos: new THREE.Vector3(16, -3.2, 26),
  vel: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  ang: new THREE.Vector3(),          // body-space angular velocity
  power: SEA.maxPower,
  hull: SEA.maxHull,
  lights: false,
  piloting: false,
  dock: 0,                            // 0 = out, 1 = in
  dockDir: 0,                         // +1 entering, -1 leaving
  dockFrom: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
  throttle: 0, strafe: 0, rise: 0,
  yawIn: 0, pitchIn: 0,
  camQuat: new THREE.Quaternion(),
  camPos: new THREE.Vector3(),
  gLean: new THREE.Vector3(),
  stress: 0,
  charging: false,
  temperature: 22,
  hintOn: false,
  contact: 0,                         // 0..1 how hard we are against the seabed
  lastImpactT: -1e9,
  // incoherent phases for the parked-hull drift, seeded in init()
  drift0: 0.0, drift1: 2.1, drift2: 4.3,
  shotHold: false,
  /** ?vehstage=<m>: forced on-axis standoff for surface measurement. 0 = search. */
  stageDist: 0,
  holdPos: new THREE.Vector3(),
  holdQuat: new THREE.Quaternion(),
  bornAt: 0,
  // seaglide
  glide: false,
  glidePower: GLIDE.maxPower,
  glideLight: true,
  glideBlend: 0,
  glideSpin: 0,
  glideThrust: 0,
  deferGlide: false,
  fov0: 68,
  // bookkeeping
  screenT: 0, dashT: 0, mapT: 0,
  contacts: [],
};

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _m1 = new THREE.Matrix4();
const FWD = new THREE.Vector3(0, 0, -1);   // the bow, in vehicle space
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

function playerPosition(ctx, out) {
  const p = out || _v1;
  const mv = movement;
  if (mv && mv.position && mv.position.isVector3 && !mv.stub) return p.copy(mv.position);
  return p.copy(ctx.camera.position);
}

function groundAt(x, z) {
  if (!terrain || !terrain.heightAt) return WORLD.maxDepth + 20;
  const h = terrain.heightAt(x, z);
  return Number.isFinite(h) ? h : WORLD.maxDepth + 20;
}

const _gn = new THREE.Vector3(0, 1, 0);
/** Seabed normal at a world XZ, flat-up if terrain is a stub. */
function groundNormal(x, z, out) {
  const n = out || _gn;
  if (terrain && terrain.normalAt) {
    try {
      const r = terrain.normalAt(x, z, n);
      if (r && Number.isFinite(r.x) && r.lengthSq() > 0.25) return r;
    } catch { /* terrain is someone else's module */ }
  }
  return n.set(0, 1, 0);
}

/**
 * How much core's depth response is about to dim ordinary direct lighting.
 * See the header: a lamp is not sunlight and must not be attenuated as if the
 * water column were in front of it.
 */
function lampBoost() {
  const depth = Math.max(0, U.uWaterLevel.value - state.pos.y);
  const sunT = Math.exp(-U.uAbsorption.value.z * depth * 0.42);
  const k = lerp(0.06, 1.0, sunT) * Math.max(0.02, U.uDepthDarken.value);
  return clamp(1 / Math.max(k, 0.012), 1, 42);
}

/**
 * THE LIGHT POOL HAS TO BE IN THE WATER TOO.
 *
 * A three.js SpotLight is spectrally constant: whatever colour it is at the lens
 * is the colour that lands 35 m away. Core's medium can only correct the path
 * from the lit SURFACE to the eye — it knows nothing about the path from the
 * LAMP to the surface — so a white lamp on tan sand painted a warm grey-tan oval
 * on a teal seabed, measured as a light pool visibly not participating in the
 * medium. It is the same class of bug as the green hull: a spectrally white
 * source inside a per-channel medium.
 *
 * Thirty metres of this water passes 49 % of green, 40 % of blue and 0.3 % of
 * red, so the light that actually arrives is cyan whatever the lamp is doing.
 * Renormalise on the peak channel rather than scaling by it: level is already
 * owned by lampBoost() and by the inverse-square falloff, and this only has any
 * business setting the HUE. LOOK.md section 3 also applies — lamps cast no
 * caustics — and every lamp material here is already caustics: 0.
 */
const _lamp = new THREE.Vector3();
const LAMP_MEDIUM_K = 0.82;
function mediumLampColor(out, base, dist) {
  const a = U.uAbsorption.value;
  _lamp.set(
    base.r * Math.exp(-a.x * dist),
    base.g * Math.exp(-a.y * dist),
    base.b * Math.exp(-a.z * dist),
  );
  const mx = Math.max(_lamp.x, _lamp.y, _lamp.z, 1e-6);
  const k = U.uUnderwater.value * LAMP_MEDIUM_K;
  return out.setRGB(
    lerp(base.r, _lamp.x / mx, k),
    lerp(base.g, _lamp.y / mx, k),
    lerp(base.b, _lamp.z / mx, k),
  );
}
const LAMP_BASE = new THREE.Color(0.84, 0.93, 1.0);

/**
 * Downwelling skylight at the hull, written into `skyFill` once a frame.
 *
 * Per-channel Beer-Lambert on the SAME 0.42 exponent core uses for its own
 * sunT, so the shell dims on exactly the curve the terrain under it does and
 * red is dead by 30 m without a special case. Sun elevation gates it, so a
 * night dive gets a silhouette; uDepthDarken enters at a low power so a cave
 * or a brine pool still swallows the hull without re-imposing the full double
 * attenuation this exists to undo.
 *
 * Gated on uUnderwater and on the vehicle's own depth: above the waterline core
 * applies no depth response at all, so adding the compensation there would
 * double-brighten a surfaced sub into a white blob.
 */
/**
 * 2.45, and the sign of one inequality is the whole argument.
 *
 * Point-sampled on the shipping frame, the Seamoth's lit flank measured
 * luminance 77-85 against the water immediately around it at 96-107 — the hull
 * was DARKER than the ocean it floats in. seamoth-1.jpg's white hull measures
 * 198 against water at 36-60, i.e. three to five times brighter, and LOOK.md
 * non-negotiable #4 is explicit that a bright object converges DOWN toward the
 * fog value with distance: it cannot start below it. A manufactured hull being
 * the brightest, least saturated thing in a saturated green frame is most of
 * why it reads as manufactured at all.
 *
 * This is the shell's whole irradiance budget, so it is the right knob: the
 * spectrum (SKY_CHROMA), the red floor and the direct-light filter all stay put
 * and only the level moves.
 */
const SKY_GAIN = 2.45;
/**
 * THE DOWNWELLING SOURCE IS NOT WHITE, AND THAT WAS THE WHOLE BUG.
 *
 * The old model was pure transmittance on a white source: exp(-a*z) per channel
 * with a = (0.185, 0.0225, 0.0290). Green is the LEAST absorbed channel through
 * the mid band by design (globals.js explains why), so a white source through
 * that filter comes out green — G/B = 1.13 at 45 m — and multiplying it by a
 * cream albedo made it 1.21. Measured on the shipping frame, the hull read
 * #baf4c7: a pale MINT vehicle floating in blue-teal water, G/B 1.19 against the
 * water's 0.90. The reference is the exact inverse. seamoth-1.jpg's hull
 * measures #94c2ee — pale periwinkle, G/B 0.815 — against water at G/B 1.15.
 * The manufactured object is the BLUEST, brightest, least saturated thing in a
 * green frame; that contrast is most of why it reads as manufactured at all.
 *
 * The missing physics is that the light falling on a hull 45 m down is not a
 * white beam, it is the DOWNWELLING FIELD: a sun that has been forward-scattered
 * into diffusion plus the whole sky hemisphere, and the sky is blue before the
 * water ever touches it. So the spectrum is skyChroma * transmittance, not
 * transmittance alone, and it is the same spectrum for the ambient term and for
 * the direct term (dirFilter) — one downwelling colour, so the shell can never
 * disagree with itself about what is lighting it.
 */
const SKY_CHROMA = new THREE.Vector3(0.31, 0.415, 1.28);
/**
 * Red on the SHELL, unlike red in the water, does not go to zero.
 *
 * LOOK.md rule 1 is about the medium: mid-water measures R = 0-15. A painted
 * hull one metre from the lens is not the medium, and the reference proves it —
 * seamoth-1.jpg's hull sits at R = 148 against G = 194, i.e. R/G = 0.76, and
 * that near-neutrality is exactly what makes it read as the least saturated
 * thing in frame (measured sat 0.378 against the water's 0.581). Floor red at a
 * fraction of green so the shell stays a three-channel object; the medium in
 * front of it still kills the red on the way to the eye.
 */
/**
 * 0.62, not 0.30, and the argument is a measurement on the SHIPPED frame rather
 * than on a point sample.
 *
 * Cropped to the hull in shots/veh-r10-base/seamoth.png and to the hull in
 * reference/subnautica/seamoth-1.jpg with the same tool:
 *
 *              ours (r9)     seamoth-1.jpg
 *   R/G          0.200          0.552      (whole-hull crop)
 *   R/G          0.323          0.724      (bright painted panel only)
 *   sat          0.853          0.550
 *   G/B          0.885          0.922
 *
 * So G/B was already right — the axis the last critic named is the one axis that
 * was NOT broken. What is broken is red, and saturation follows it: a hull at
 * R/G 0.20 has nowhere to be except on the water's own hue line, which is
 * exactly the "tinted like the medium" reading. At 0.30 the floor was set from a
 * point sample of one bright pixel; measured across the whole painted flank the
 * reference holds R at 55-72 % of green, so the floor has to be near the middle
 * of that band, not below the bottom of it.
 *
 * This is the shell's IRRADIANCE, not its albedo, and that distinction is why it
 * is legitimate: LOOK.md rule 2 is about the medium (mid-water R = 0-15), and a
 * downwelling field that has been forward-scattered and re-emitted by the whole
 * column is not a pencil beam through 45 m of red-absorbing water. The medium
 * between the hull and the lens still applies its own per-channel extinction on
 * top of this, unchanged.
 */
/**
 * ...and 0.62 was measured to move the rendered hull by 2 %, which is the most
 * useful number in this file. Here is why, and what it bounds.
 *
 * The live medium at the seamoth framing reads uAbsorption = (0.1657, 0.0319,
 * 0.0328) and uFogColor = (0.0007, 0.1884, 0.3669). Over the 18 m the sub was
 * staged at, transmittance is (0.051, 0.563, 0.554) — red is down 95 % — and the
 * in-scattered term that replaces it has a red channel of SEVEN TEN-THOUSANDTHS.
 * So the rendered hull's red is 5 % of whatever the shell reflects, plus nothing,
 * and doubling the shell's red doubles 5 % of it. The shading model cannot get
 * there either: outgoing R/G is a blend of the sun's own 1.088 and this floor, so
 * it is bounded ABOVE by about 1.03 no matter what this constant says.
 *
 * That bound is worth stating because it is the honest limit of this file. The
 * measurement that actually explains the critic's finding is that OUR WATER has
 * no red in it: sampled off open water beside the hull we read R/G 0.126-0.154 at
 * saturation 0.86-0.89, where seamoth-1.jpg's water at the same framing reads
 * R/G 0.294-0.447 at saturation 0.56-0.68. Our hull already beats its own water
 * by 2.4x on R/G where the reference's beats its water by 1.7x — the hull is not
 * the thing tinted like the medium, the medium is missing two thirds of its red.
 * That belongs to render/underwater.js and world/biomes.js and is reported.
 *
 * IT IS THEREFORE LEFT AT 0.30, and that is a result rather than an omission.
 * A/B captured at matched staging — 0.95 with a matching red floor on the direct
 * filter against 0.30 with none — the hull crop came back R/G 0.243 and 0.249.
 * Raising the shell's own red irradiance by 53 % moved the rendered hull by
 * -2 %, i.e. by less than the capture noise, and in the wrong direction. Solving
 * back through the composite for what the surface is actually doing:
 *
 *   rendered_linear = surface * T + inscatter
 *   red    T = 0.051, inscatter = 0.0007  ->  surface_R = 0.237
 *   green  T = 0.573, inscatter = 0.0804  ->  surface_G = 0.187
 *
 * The shell is ALREADY reflecting 1.27 red for every 1.0 green — warmer than the
 * reference hull's own albedo — and it renders at R/G 0.24 because 95 % of that
 * red is absorbed in 17.5 m and the green it loses is handed back as fog. To
 * reach seamoth-1.jpg's R/G the shell would have to reflect 8.5x more red than
 * green. No shading change in this file can do it, and shipping a knob that
 * moves the picture by 2 % while claiming it fixed the hue is the exact failure
 * this round was warned about. The gap is the medium's and is reported as such;
 * the one lever this file does own is standoff, and that is now taken.
 */
/**
 * ...0.42, not 0.30, and it is the one HULL-HUE number this round can defend.
 *
 * Crops matched by hand off the exterior framing: our shell reads mean
 * (25, 123, 130) against the water 40 cm beside it at (10, 101, 118), i.e.
 * R/G 0.204 on the hull and 0.100 on the water. seamoth-1.jpg reads (64, 110,
 * 121) on the hull against (34, 126, 123) on its water — R/G 0.584 and 0.267.
 * The RATIO is right (we separate the hull from its medium by 2.0x, the
 * reference by 2.2x); the absolute red is a third of it. Some of that gap is
 * honest depth — the reference frame is an 8 m shallows shot and ours is 45 m —
 * but the floor is what decides how much of its own paint a white hull keeps
 * when the column has taken the red out, and 0.30 was set before there was a
 * measurement to set it against.
 *
 * It is proportional to the GREEN channel, not absolute, so it cannot resurrect
 * red on a 300 m hull: green dies too and the floor goes with it.
 *
 * G/B is NOT claimed. Ours measures 0.941 against the reference's 0.907, which
 * is 3.7 % — inside the documented noise band for this kind of crop and
 * confounded by the depth difference above. It is left alone deliberately.
 */
const SHELL_RED_FLOOR = 0.42;
/** How much of the downwelling chromaticity the DIRECT light picks up. */
// 0.36: the same argument one term over. This filters the DIRECT sun's
// chromaticity, and it is the lit panel — the reference's (168,206,242) at
// R/G 0.815 — that carries a painted hull's identity.
const DIR_FILTER_K = 0.36;
const _sky = new THREE.Vector3();
function updateSkylight() {
  applyCabLevels();
  const depth = Math.max(0, U.uWaterLevel.value - state.pos.y);
  const a = U.uAbsorption.value;
  const sun = clamp01(U.uSunDir.value.y * 2.4 + 0.05);
  const gate = U.uUnderwater.value * sstep(0.0, 1.4, depth)
    * Math.pow(clamp01(U.uDepthDarken.value), 0.35) * sun * SKY_GAIN;
  // downwelling spectrum = sky colour * per-channel Beer-Lambert on the column
  _sky.set(
    Math.exp(-a.x * depth * 0.42) * SKY_CHROMA.x,
    Math.exp(-a.y * depth * 0.42) * SKY_CHROMA.y,
    Math.exp(-a.z * depth * 0.42) * SKY_CHROMA.z,
  );
  _sky.x = Math.max(_sky.x, _sky.y * SHELL_RED_FLOOR);
  skyFill.value.setRGB(_sky.x * gate, _sky.y * gate, _sky.z * gate);
  // Same spectrum, renormalised on its own peak: the direct light changes hue,
  // not level, so the sun still models the form of the shell.
  const mx = Math.max(_sky.x, _sky.y, _sky.z, 1e-5);
  dirFilter.value.setRGB(
    lerp(1, _sky.x / mx, DIR_FILTER_K),
    lerp(1, _sky.y / mx, DIR_FILTER_K),
    lerp(1, _sky.z / mx, DIR_FILTER_K),
  );

  /**
   * The cockpit lining is inside, so it gets a fraction of that daylight through
   * the canopy PLUS a floor from the cabin lamp — which is what keeps it at the
   * reference's ~126 luminance at 45 m and still a legible ~110 at 145 m, rather
   * than the dim grey 50 it measured.
   *
   * The floor is COLD. Measured across the lower third of the reference cockpit
   * frames, mean saturation is 0.62-0.63 with red at 44-45 % of peak; ours came
   * back 0.34 and 78 %, i.e. a neutral grey box. The albedo is white (see
   * cabinTexture) and this is where the colour lives, so the moulding still reads
   * as white plastic under a cyan cabin lamp rather than as tinted plastic.
   *
   * ...AND IT IS QUIETER THAN IT WAS. The console faces measured #a4d2d0 — sRGB
   * luminance 200, right against the shoulder of the tone curve — where the
   * reference's brightest console panel is #7f95aa, luminance 147. Blowing the
   * lining out did not just make it too bright: ACES walks a clipping colour
   * toward white, so the blue the lamp was carrying was destroyed on the way
   * through the curve and the tub came back neutral teal (G/B 1.01) instead of
   * the reference's cool slate (G/B 0.876). Half the level, and a bluer ratio,
   * lands the panel inside the curve where its hue survives.
   *
   * ...AND IT WAS THEN CUT TOO FAR. Restaged into open water the cockpit frame
   * is no longer a dark one, so postfx's auto-exposure pulls down and the
   * interior goes with it: measured on that frame the lower third came back at
   * median 11-27 against seamoth-cockpit-1.jpg's 68-93, while the water above it
   * matched at 76 against 86. The reference's interior-to-water ratio is 0.80;
   * ours was 0.36. Level restored at 2.2x, and the SPECTRUM warmed at the same
   * time — the reference interior measures 44 % red and 0.62 saturation where
   * ours measured 30 % and 0.75, because a lamp at R/G 0.49 is a stage light,
   * not a cabin light. 0.66 keeps the moulding cool without draining it.
   *
   * The level is set by the RATIO to the water, not by an absolute target,
   * because the absolute target is not ours: postfx owns exposure and the grade
   * moved twice inside this round. Measured on seamoth-cockpit-1.jpg the cockpit
   * lower third sits at 0.80 of the open water above it; two consecutive grades
   * of ours put us at 0.45 and 0.59 of it. A ratio survives a grade change; a
   * luminance target does not.
   */
  /**
   * ...AND THE SPECTRUM IS WARMER AGAIN, by measurement.
   *
   * Grid-sampled 12x7 across the lower third, seamoth-cockpit-2.jpg's console
   * face runs (108,129,148) / (117,137,161) / (96,115,132) — R/G 0.84-0.86,
   * B/G 1.13-1.15. Ours, on the parts of the console that were lit at all, came
   * back R/G 0.72-0.77 at the right B/G and the right level. The fill was mixing
   * at R/G 0.67; 0.77 puts the rendered ratio on the reference after the tone
   * curve's own desaturation, without touching the level the ratio-to-water
   * argument above fixed.
   */
  const lamp = state.piloting || state.dock > 0 ? 1.0 : 0.22;
  cabinFill.value.copy(skyFill.value).multiplyScalar(0.10)
    /**
   * ...and the LEVEL is up 1.4x, which is a contrast fix rather than a brightness
   * one.
   *
   * The fill term is nearly flat — uwW spans 0.82-1.16 on the console — so almost
   * all of the interior's tonal range comes from the direct lights. Measured on
   * the console crop, ours ran median 47.6 against seamoth-cockpit-2.jpg's 114.2
   * while the lit band of the same moulding matched the reference at 115-126: the
   * problem was never the peak, it was a 2.5:1 spread across one panel where the
   * reference has about 1.3:1. Raising the flat term lifts the shadowed two thirds
   * far more than the lit third and compresses that spread. It also puts the
   * microstructure back above the noise floor — a +/-9 % grain on a surface sitting
   * at level 47 is +/-4 levels, which measured as literally no change in detailRMS
   * with the octave stack ablated.
   *
   * 1.19x, not the 1.40x it was first set to: at 1.40 the grid came back with the
   * lit console at 160-205 against the reference's 74-131, which trades one kind
   * of wrong spread for another. 1.19 lands the lit band near 140 and keeps the
   * compression; the rest of the spread is closed from the DARK end instead, by
   * raising the fittings' own floor below.
   */
    .add(_fillTmp.setRGB(CAB_FILL_C[0] * lamp, CAB_FILL_C[1] * lamp, CAB_FILL_C[2] * lamp))
    // ...and the whole thing rides CAB.fill. See the CAB note: the flat term was
    // worth more than every modelled term put together, which is what made the
    // tub a plateau rather than a lit shell.
    .multiplyScalar(CAB.fill);
  // See the rimFill declaration: the coaming is lit from the cabin on one face
  // and from the water column on the other, so it carries a blend of both and
  // lets its own normal weighting resolve which is which per fragment.
  cabAmb.value.setRGB(CAB_BOUNCE_C[0] * lamp, CAB_BOUNCE_C[1] * lamp, CAB_BOUNCE_C[2] * lamp)
    .multiplyScalar(CAB.bounce);
  cabAmbRim.value.copy(cabAmb.value).multiplyScalar(0.45);
  rimFill.value.copy(cabinFill.value).multiplyScalar(0.62)
    .add(_rimTmp.copy(skyFill.value).multiplyScalar(0.45));
}
const _rimTmp = new THREE.Color();
const _fillTmp = new THREE.Color();

const _cabP = new THREE.Vector3();
const _cabN = new THREE.Vector3();
const _cabM = new THREE.Matrix3();
/**
 * Push the cabin emitter table into world space for this frame.
 *
 * The table is authored in BODY space, beside the geometry that emits, so a
 * light cannot drift off its fixture. The shader needs world space because
 * `vUwWorldPos` is the only position varying UNDERWATER_PARS guarantees, and
 * inventing a second object-space one on seven materials to save a matrix
 * multiply per frame would be a poor trade.
 *
 * `updateWorldMatrix(true, false)` rather than `updateMatrixWorld(true)`: it
 * walks the two parents up to the scene and stops, instead of re-deriving every
 * mesh under the hull for a matrix nothing else reads yet this frame.
 */
function updateCabinLights() {
  if (!sm || !sm.cabEmit) return;
  sm.body.updateWorldMatrix(true, false);
  const bodyM = sm.body.matrixWorld;
  // The body carries rotation only (root is position + quaternion, body is a
  // fixed yaw), so the upper 3x3 is orthonormal and safe as a normal matrix.
  _cabM.setFromMatrix4(bodyM);
  // Same gate cabinFill uses: a cockpit nobody is sitting in runs its panel
  // lighting down, and a flat battery runs the instruments out entirely.
  const lamp = state.piloting || state.dock > 0 ? 1.0 : 0.22;
  const powered = state.power > 0.5 ? 1.0 : 0.06;
  for (let i = 0; i < CAB_LIGHTS; i++) {
    const C = cabLightCol.value[i];
    const e = sm.cabEmit[i];
    if (!e) { C.set(0, 0, 0); continue; }
    _cabP.copy(e.p).applyMatrix4(bodyM);
    cabLightPos.value[i].set(_cabP.x, _cabP.y, _cabP.z, e.r2);
    cabLightAxis.value[i].copy(_cabN.copy(e.n).applyMatrix3(_cabM).normalize());
    const g = e.i * CAB.emit * (e.gate === 'screen' ? powered : lamp * powered);
    C.set(e.c.r * g, e.c.g * g, e.c.b * g);
  }
}

// ---------------------------------------------------------------- physics
function stepSeamoth(dt, ctx) {
  const submerged = state.pos.y < U.uWaterLevel.value - 0.25;
  const powered = state.power > 0.5 && state.hull > 0;

  // --- angular: mouse drives rate targets, with real inertia both ways
  const tYaw = powered ? state.yawIn * SEA.yawRate : 0;
  const tPitch = powered ? state.pitchIn * SEA.pitchRate : 0;
  const respond = submerged ? 2.6 : 1.1;
  state.ang.y += (tYaw - state.ang.y) * clamp01(dt * respond);
  state.ang.x += (tPitch - state.ang.x) * clamp01(dt * respond);
  // bank into the turn, then bleed the roll back out
  const tRoll = -state.ang.y * SEA.bank;
  state.ang.z += (tRoll - state.ang.z) * clamp01(dt * 2.1);
  state.ang.multiplyScalar(Math.max(0, 1 - SEA.angDamp * dt * 0.12));

  _e1.set(state.ang.x * dt, state.ang.y * dt, state.ang.z * dt, 'YXZ');
  _q1.setFromEuler(_e1);
  state.quat.multiply(_q1).normalize();

  // self-righting: an unpiloted sub rolls level, and roll authority is limited
  if (!state.piloting || Math.abs(state.yawIn) < 0.02) {
    _v1.copy(UP).applyQuaternion(state.quat);
    const tilt = Math.atan2(Math.hypot(_v1.x, _v1.z), Math.max(1e-4, _v1.y));
    if (tilt > 0.01) {
      _v2.set(_v1.z, 0, -_v1.x).normalize().applyQuaternion(_q2.copy(state.quat).invert());
      _q1.setFromAxisAngle(_v2, -tilt * clamp01(dt * 0.9));
      state.quat.multiply(_q1).normalize();
    }
  }

  // --- linear
  const acc = _v1.set(0, 0, 0);
  if (powered) {
    const t = state.throttle;
    acc.addScaledVector(_v2.copy(FWD).applyQuaternion(state.quat),
      t > 0 ? t * SEA.thrust : t * SEA.reverse);
    acc.addScaledVector(_v2.copy(RIGHT).applyQuaternion(state.quat), state.strafe * SEA.strafe);
    acc.addScaledVector(_v2.copy(UP).applyQuaternion(state.quat), state.rise * SEA.vertical);
  }
  // Buoyancy trim. The hull is ballasted NEUTRAL when fully wet — a Seamoth
  // holds the depth you leave it at, which is what makes it a place you can
  // park rather than a balloon — and the restoring force only appears as the
  // shell emerges and stops displacing water. That single lerp gives both
  // behaviours and a stable float line with the canopy just clear of the swell.
  {
    const top = state.pos.y + 0.86;
    const sub = clamp01((U.uWaterLevel.value - top) / 1.6 + 1);
    acc.y += lerp(WORLD.gravity, SEA.buoyancy, sub);
    if (sub < 0.999) acc.y -= state.vel.y * 1.1 * (1 - sub);   // wave damping
  }

  /**
   * A parked Seamoth is a two-tonne mass in moving water, not a prop.
   *
   * Measured with no input, position was constant to three decimals across
   * 2.5 s and a flat battery left the sub hanging motionless forever. Every
   * other mass in this world drifts — the swell reaches down, there is current
   * at every depth — so an unpiloted hull gets a slow incoherent push from
   * three beat frequencies plus a lazy yaw. The amplitudes are chosen against
   * linDrag so it sways roughly +/-0.4 m about where you left it and never
   * wanders: 0.022 m/s^2 at 0.23 rad/s integrates to ~0.1 m/s of velocity.
   * Wave motion also attenuates with depth, which is why it is strongest just
   * under the surface.
   */
  if (!state.piloting) {
    const tt = ctxRef ? ctxRef.time.t : 0;
    const depth = Math.max(0, U.uWaterLevel.value - state.pos.y);
    const swell = 0.55 + 0.45 * Math.exp(-depth / 55);
    acc.x += (Math.sin(tt * 0.23 + state.drift0) * 0.022
      + Math.sin(tt * 0.71 + state.drift1) * 0.009) * swell;
    acc.z += (Math.cos(tt * 0.19 + state.drift1) * 0.022
      + Math.sin(tt * 0.63 + state.drift2) * 0.009) * swell;
    acc.y += Math.sin(tt * 0.31 + state.drift2) * 0.030 * swell;
    state.ang.y += Math.sin(tt * 0.13 + state.drift0) * 0.030 * dt;
    state.ang.x += Math.sin(tt * 0.27 + state.drift1) * 0.022 * dt;
  }

  // anisotropic drag in body space — a submarine slides forward far more
  // easily than sideways, and that ratio is most of what "handling" means
  _v2.copy(state.vel).applyQuaternion(_q2.copy(state.quat).invert());
  _v3.set(
    -_v2.x * (SEA.dragLat * Math.abs(_v2.x) + SEA.linDrag),
    -_v2.y * (SEA.dragVert * Math.abs(_v2.y) + SEA.linDrag),
    -_v2.z * (SEA.dragFwd * Math.abs(_v2.z) + SEA.linDrag * 0.55),
  );
  _v3.applyQuaternion(state.quat);
  acc.add(_v3);

  state.vel.addScaledVector(acc, dt);
  state.pos.addScaledVector(state.vel, dt);

  resolveTerrain(dt);

  // --- keep it inside the world
  const r = Math.hypot(state.pos.x, state.pos.z);
  const lim = WORLD.worldSize * 0.48;
  if (r > lim) {
    state.pos.x *= lim / r; state.pos.z *= lim / r;
    state.vel.x *= 0.3; state.vel.z *= 0.3;
  }
  state.pos.y = Math.max(state.pos.y, WORLD.maxDepth + 4);
}

function damageHull(n) {
  state.hull = clamp(state.hull - n, 0, SEA.maxHull);
}

/**
 * Terrain collision — surface-resolved, not floor-tested.
 *
 * The old version dropped five VERTICAL probes, compared each against
 * groundAt(x, z) and wrote `pos.y += push * 0.55`. That is a floor test wearing
 * a collision's clothes, and against a 30 m cliff it fails completely: every
 * probe reports "ground above me", so the correction is entirely upward and the
 * sub levitates up the wall. Measured, driving into a cliff at 10 m/s moved it
 * 22.8 m upward in 0.67 s — 15.94 m in a single 0.33 s sample — with
 * velocity.y still reporting 0.00 and hull still 100, because nothing was ever
 * written into velocity and nothing ever tested laterally.
 *
 * Resolve against the SURFACE instead. world/terrain.js publishes normalAt(),
 * which on a cliff face returns a near-horizontal normal, so the same three
 * lines that lift the sub off flat sand push it sideways off a wall. For a
 * heightfield the distance from a point to the surface along the normal is the
 * vertical penetration scaled by n.y, which is what turns "I am 20 m below the
 * top of this cliff" into "I am 1.2 m inside its face".
 *
 * Then: write the resolve into VELOCITY (kill the inbound component, keep the
 * tangential one so the hull slides along rock), add friction, and cap the
 * positional correction per frame so no single bad sample can ever teleport.
 */
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _push = new THREE.Vector3();
// probes in body space: nose, tail, both beams, centre, keel
const CONTACT_PROBES = [
  [0, 0, 2.05], [0, 0, -2.05], [-1.72, -0.30, 0], [1.72, -0.30, 0],
  [0, 0, 0], [0, -0.72, 0.6], [0, -0.72, -0.6],
];
const CONTACT_R = 0.95;
function resolveTerrain(dt) {
  let hits = 0;
  _push.set(0, 0, 0);
  for (let i = 0; i < CONTACT_PROBES.length; i++) {
    const pr = CONTACT_PROBES[i];
    _cp.set(pr[0], pr[1], pr[2]).applyQuaternion(state.quat).add(state.pos);
    // 5 cm of slop, so a hull resting against a slope reaches an equilibrium
    // with a sliver of overlap instead of being pushed out every frame forever
    const pen = (groundAt(_cp.x, _cp.z) + CONTACT_R) - _cp.y - 0.05;
    if (pen <= 0) continue;
    groundNormal(_cp.x, _cp.z, _cn);
    // vertical penetration -> perpendicular penetration
    _push.addScaledVector(_cn, pen * Math.max(_cn.y, 0.10));
    hits++;
  }
  state.contact += ((hits ? 1 : 0) - state.contact) * clamp01(dt * 6);
  if (!hits) return;

  _push.divideScalar(hits);
  const d = _push.length();
  if (d < 1e-5) return;
  _cn.copy(_push).divideScalar(d);

  // Extraction is rate-limited: 0.4 m per step is 24 m/s of push-out, plenty to
  // clear any real overlap and far too slow to read as a teleport.
  state.pos.addScaledVector(_cn, Math.min(d, 0.40 + state.vel.length() * dt));

  const vn = state.vel.dot(_cn);
  if (vn < 0) {
    // the impact is what the hull actually felt: the closing speed along the
    // contact normal, so a glancing scrape costs nothing and a head-on does
    const impact = -vn;
    state.vel.addScaledVector(_cn, impact * 1.15);   // stop, plus a small bounce
    if (impact > SEA.impactFloor) {
      damageHull((impact - SEA.impactFloor) * 5.5);
      // one toast per collision, not one per contact frame
      const now = ctxRef ? ctxRef.time.t : 0;
      if (impact > SEA.impactFloor + 1.5 && now - state.lastImpactT > 2.0) {
        state.lastImpactT = now;
        notifyUI(ctxRef, 'Seamoth: hull impact');
      }
    }
  }
  // sliding friction: rock does not let a hull keep its tangential speed either
  state.vel.multiplyScalar(Math.max(0, 1 - 2.4 * dt));
}

function stepSystems(dt, ctx) {
  const depth = Math.max(0, U.uWaterLevel.value - state.pos.y);

  // --- hull temperature. survival.js already models the water column, so read
  // it rather than inventing a second thermocline that disagrees with it.
  let temp = null;
  try {
    const sv = ctx.get('survival');
    if (sv && !sv.stub && Number.isFinite(sv.temperature)) temp = sv.temperature;
  } catch { /* survival may be a stub */ }
  if (temp === null) temp = 24 - 20 * clamp01(depth / 260) + 4 * clamp01((depth - 900) / 400);
  state.temperature += (temp - state.temperature) * clamp01(dt * 0.5);

  // --- power
  let drain = 0.10;
  if (state.piloting) {
    drain += (Math.abs(state.throttle) + Math.abs(state.strafe) * 0.7 + Math.abs(state.rise) * 0.7) * 1.35;
    drain += Math.abs(state.yawIn) * 0.25;
  }
  if (state.lights) drain += 1.15;
  state.power = clamp(state.power - drain * dt, 0, SEA.maxPower);

  // Solar trickle: only near the surface, only in daylight. It is the reason a
  // shallow sub is a safe sub and a deep one is on a clock. Scaled with the
  // capacity so it is still ~1.9 %/s — a full recharge in a bit under a minute
  // of floating, which keeps the surface a place you actually want to return to.
  const solar = clamp01(1 - depth / 30) * clamp01(U.uSunDir.value.y * 2.2);
  state.charging = solar > 0.02 && state.power < SEA.maxPower;
  if (state.charging) {
    state.power = clamp(state.power + solar * SEA.maxPower * 0.019 * dt, 0, SEA.maxPower);
  }
  if (state.power <= 0.5) state.lights = false;

  // --- crush depth. Overshoot rate is deliberately steep: the reference HUD
  // prints the limit in yellow next to the depth precisely so you can watch it
  // coming, and a soft penalty would make that number meaningless.
  const over = depth - SEA.crushDepth;
  if (over > 0) {
    damageHull((0.9 + over * 0.055) * dt);
    state.stress = clamp01(state.stress + dt * 1.6);
  } else {
    state.stress = Math.max(0, state.stress - dt * 0.9);
  }
  if (sm) sm.glassMat.uniforms.uStress.value = state.stress * (0.55 + 0.45 * Math.sin(ctx.time.t * 7.3));

  // --- hull failure ejects the pilot rather than deleting the player
  if (state.hull <= 0 && state.piloting && state.dockDir === 0) {
    beginUndock(ctx);
    const survival = ctx.get('survival');
    try { survival?.damage?.(18); } catch { /* survival may be a stub */ }
  }
}

// ---------------------------------------------------------------- docking
function eyeWorld(out) {
  return (out || _v1).copy(SEA.eyeRoot).applyQuaternion(state.quat).add(state.pos);
}

function beginDock(ctx) {
  if (state.piloting || state.dockDir !== 0) return false;
  state.dockFrom.pos.copy(ctx.camera.position);
  state.dockFrom.quat.copy(ctx.camera.quaternion);
  state.dockDir = 1;
  state.dock = 0;
  state.piloting = true;
  state.shotHold = false;
  // face the hatch: the sub swings level as the pilot climbs in
  notifyUI(ctx, 'Seamoth: piloting');
  return true;
}
const EXIT_LOCAL = new THREE.Vector3(0, 1.45, 1.55);
/** Where the pilot ends up: clear above the hatch, never inside the seabed. */
function exitPoint(out) {
  const p = (out || _v1).copy(EXIT_LOCAL).applyQuaternion(state.quat).add(state.pos);
  const g = groundAt(p.x, p.z) + 1.3;
  if (p.y < g) p.y = g;
  return p;
}
function beginUndock(ctx) {
  if (!state.piloting || state.dockDir !== 0) return false;
  state.dockDir = -1;
  state.dock = 1;
  state.shotHold = false;
  notifyUI(ctx, 'Seamoth: disembarked');
  return true;
}
function notifyUI(ctx, text) {
  try { ctx.get('ui')?.notify?.(text); } catch { /* ui may be a stub */ }
}

/**
 * The boarding affordance.
 *
 * nearest() already reported boardable:true at 4.29 m and nothing ever said so
 * on screen, which made the Seamoth undiscoverable in play — LOOK.md §10 lists
 * contextual prompts as part of the HUD language and seamoth-cockpit-1.jpg
 * literally shows "Salir (E)" under the reticle. ui.js owns the slot, so only
 * ever clear a string we put there ourselves: player/tools.js writes the same
 * one for scanning and picking up, and stomping it would be worse than silence.
 */
const BOARD_HINT = 'Enter [E]';
function updateBoardHint(ctx) {
  let ui = null;
  try { ui = ctx.get('ui'); } catch { return; }
  if (!ui || ui.stub || typeof ui.setReticleHint !== 'function') return;
  const near = !state.piloting && state.dockDir === 0 && state.dock === 0
    && !state.shotHold && state.hull > 0
    && playerPosition(ctx, _v1).distanceTo(state.pos) < SEA.boardRange;
  if (near === state.hintOn) return;
  state.hintOn = near;
  try {
    if (near) ui.setReticleHint(BOARD_HINT);
    else if (typeof ui._hint !== 'string' || ui._hint === BOARD_HINT) ui.setReticleHint('');
  } catch { /* ui is someone else's module */ }
}

function stepDock(dt, ctx) {
  if (state.dockDir === 0) return;
  const speed = dt / 1.05;
  state.dock = clamp01(state.dock + state.dockDir * speed);
  if (state.dockDir > 0 && state.dock >= 1) { state.dockDir = 0; state.dock = 1; }
  if (state.dockDir < 0 && state.dock <= 0) {
    state.dockDir = 0; state.dock = 0; state.piloting = false;
    // Hand the camera over in the state movement expects to inherit: at the
    // exit point, level (its euler decode drops our bank anyway), and back at
    // the base FOV — movement re-bases its own FOV spring on whatever it finds,
    // so leaving it inflated would ratchet the player's field of view upward.
    exitPoint(_v1);
    ctx.camera.position.copy(_v1);
    _e1.setFromQuaternion(state.quat, 'YXZ'); _e1.z = 0;
    ctx.camera.quaternion.setFromEuler(_e1);
    ctx.camera.fov = state.fov0;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.updateMatrixWorld(true);
    setMovementLock(false);
    // carry a little of the sub's momentum out with the swimmer
    try { movement?.impulse?.(_v2.copy(state.vel).multiplyScalar(0.30)); } catch { /* stub */ }
  }
  if (state.dockDir !== 0 || state.dock > 0) setMovementLock(true);
}

/**
 * Ask player/movement.js to stand down while the player is inside a vehicle.
 * movement.setEnabled(false) is its published hook for exactly this, and on the
 * way back in it re-seats the body on wherever we left the camera — so the
 * camera must already be at the exit point before we hand control back.
 * Guarded throughout: a stub movement leaves us driving the camera unopposed,
 * which works because vehicles is order 130 and movement is 100.
 */
function setMovementLock(on) {
  const mv = movement;
  if (!mv || mv.stub) return;
  try {
    if (typeof mv.setEnabled === 'function') mv.setEnabled(!on);
    else if (typeof mv.enabled === 'boolean') mv.enabled = !on;
    mv.inVehicle = on;
  } catch { /* movement is someone else's module; never let it break ours */ }
}

/**
 * player/tools.js also carries a seaglide in its craftable table and can equip
 * a view model for it. Two seaglides in one frame is a bug the player sees, so
 * whichever module is actually presenting one wins and the other stands down —
 * the same handshake biomes.js and underwater.js use over the U.* medium.
 */
function toolsEquippedId(ctx) {
  const t = ctx.get?.('tools');
  if (!t || t.stub === true) return null;
  try {
    let cur = typeof t.equipped === 'function' ? t.equipped() : t.equipped;
    if (cur === undefined) cur = t.current;
    if (cur === undefined) cur = t.activeTool;
    if (cur === undefined) cur = t.held;
    const id = typeof cur === 'string' ? cur : (cur && cur.id);
    return id || null;
  } catch { return null; }
}
function toolsHoldingSeaglide(ctx) {
  const id = toolsEquippedId(ctx);
  return id === 'seaglide' || id === 'glide';
}

// ---------------------------------------------------------------- camera
/** Docking waypoint in VEHICLE space: clear of the canopy, above the sill. */
const DOCK_WAY = new THREE.Vector3(0, 1.62, -0.30);
const _dockC = new THREE.Vector3();
function driveCamera(dt, ctx) {
  const cam = ctx.camera;
  eyeWorld(_v1);

  // g-force lean: the pilot's head keeps its own momentum for a moment
  _v2.copy(state.vel);
  const acc = _v3.copy(_v2).sub(state.gLean);
  state.gLean.lerp(_v2, clamp01(dt * 3.2));
  _v2.copy(acc).applyQuaternion(_q2.copy(state.quat).invert()).multiplyScalar(-0.0075);
  _v2.x = clamp(_v2.x, -0.05, 0.05);
  _v2.y = clamp(_v2.y, -0.05, 0.05);
  _v2.z = clamp(_v2.z, -0.05, 0.05);
  _v2.applyQuaternion(state.quat);

  if (state.dockDir !== 0 || (state.piloting && state.dock < 1)) {
    // Leaving: the far end of the arc tracks the hull, so climbing out of a
    // drifting sub still puts you beside it rather than where it used to be.
    if (state.dockDir < 0) {
      exitPoint(state.dockFrom.pos);
      _e1.setFromQuaternion(state.quat, 'YXZ'); _e1.z = 0;
      state.dockFrom.quat.setFromEuler(_e1);
    }
    /**
     * The docking arc, as a quadratic Bezier through a waypoint that is
     * OUTSIDE the shell.
     *
     * A straight lerp plus a sine hump ran the camera through the opaque hull
     * for about half a second, which is 2 of 16 frames of near-black in the
     * middle of the animation. The control point sits above and just forward of
     * the canopy, so the swimmer rises alongside the bubble and then drops
     * through the GLASS into the seat — which is both what Subnautica does and
     * the one surface on this vehicle you can legitimately see through.
     */
    const k = state.dock * state.dock * (3 - 2 * state.dock);
    _dockC.copy(DOCK_WAY).applyQuaternion(state.quat).add(state.pos);
    const om = 1 - k;
    _v3.copy(state.dockFrom.pos).multiplyScalar(om * om)
      .addScaledVector(_dockC, 2 * om * k)
      .addScaledVector(_v1, k * k);
    cam.position.copy(_v3);
    _q1.copy(state.quat);
    cam.quaternion.copy(state.dockFrom.quat).slerp(_q1, k * k);
    state.camQuat.copy(cam.quaternion);
    // Belt and braces for the last stretch, where the eye is genuinely inside
    // the envelope: a single-sided shell seen from within contributes nothing
    // but occlusion, so drop it and the greeble that hangs off it.
    const hide = k > 0.58 && k < 0.995;
    if (sm && sm.hull.visible === hide) {
      sm.hull.visible = !hide;
      sm.greeble.visible = !hide;
      sm.hatchPivot.visible = !hide;
    }
  } else {
    cam.position.copy(_v1).add(_v2);
    // The cockpit swings a little before the pilot's head follows it — the
    // single biggest reason a vehicle feels like a mass rather than a camera
    // rig. dt is 0 on the preRender re-assert, which must not advance the lag.
    if (dt > 0) state.camQuat.slerp(state.quat, clamp01(dt * 7.5));
    cam.quaternion.copy(state.camQuat);
  }
  cam.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- seaglide
function stepSeaglide(dt, t, ctx) {
  if (!sg) return;
  if (state.deferGlide) {
    sg.root.visible = false;
    sg.glideSpot.intensity = 0;
    if (glideBeam) glideBeam.mesh.visible = false;
    return;
  }
  const wantOn = state.glide && !state.piloting && state.glidePower > 0.5;
  state.glideBlend += ((wantOn ? 1 : 0) - state.glideBlend) * clamp01(dt * 6.0);
  sg.root.visible = state.glideBlend > 0.01;
  if (!sg.root.visible) {
    if (glideBeam) glideBeam.mesh.visible = false;
    sg.glideSpot.intensity = 0;
    return;
  }

  if (wantOn) {
    state.glidePower = clamp(state.glidePower - (GLIDE.drain
      + (state.glideLight ? GLIDE.lampDrain : 0)) * dt, 0, GLIDE.maxPower);
    if (state.glidePower <= 0) state.glide = false;

    // ---- propulsion, delivered THROUGH movement.impulse().
    //
    // This is the coordination the brief asks for and it matters that it is an
    // impulse rather than a speed multiplier: movement's drag is linear plus
    // quadratic, so adding thrust lets ITS model find the new top speed (about
    // 7.2 m/s against a 4.0 m/s swim), keeps the coast, and drives its own
    // speed-linked FOV breathe and camera roll for free. A multiplier on the
    // output would have deleted all three and read as a fast-forward button.
    const thrusting = !!ctx.input?.down?.('KeyW') && ctx.input?.enabled !== false;
    if (thrusting && movement && !movement.stub && typeof movement.impulse === 'function') {
      const f = movement.forward;
      if (f && f.isVector3) {
        _v1.copy(f).normalize().multiplyScalar(GLIDE.accel * dt);
        try { movement.impulse(_v1); } catch { /* movement is not ours to break */ }
      }
    }
    state.glideThrust += ((thrusting ? 1 : 0) - state.glideThrust) * clamp01(dt * 5);
  } else {
    state.glideThrust *= Math.max(0, 1 - dt * 3);
  }
  state.glideSpin += dt * (state.glideBlend * (14 + 46 * state.glideThrust) + 2);
  sg.prop.rotation.z = state.glideSpin;

  const boost = lampBoost();
  const on = state.glideLight && wantOn;
  sg.glideSpot.intensity = on ? 1.6 * boost : 0;
  if (on) mediumLampColor(sg.glideSpot.color, LAMP_BASE, 16);
  sg.glideLens.visible = on;
  if (glideBeam) {
    glideBeam.mesh.visible = on;
    if (on) updateBeamUniforms(glideBeam, ctx, 26, 0.40, 0.16, 0.55);
  }

  // bubbles streaming out of the shroud, in the view model's own space
  const bs = sg.bubbleState;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    b.t += dt * (0.9 + i * 0.004) * (wantOn ? 1.9 : 0.5);
    if (b.t > 1) b.t -= 1;
    const k = b.t;
    _m1.makeTranslation(
      b.x * (0.4 + k * 2.6) + 0.02 * Math.sin(k * 9 + i),
      0.02 + k * 0.55 + b.y * 0.3,
      0.20 - k * 0.75,
    );
    const s = b.s * (0.5 + k * 1.7) * state.glideBlend;
    _m1.scale(_v1.set(s, s, s));
    sg.bubbles.setMatrixAt(i, _m1);
  }
  sg.bubbles.instanceMatrix.needsUpdate = true;

  // hologram: contour map of the seabed the player is actually over
  state.mapT += dt;
  if (state.mapT > 0.34 && holo) {
    state.mapT = 0;
    playerPosition(ctx, _v1);
    _e1.setFromQuaternion(ctx.camera.quaternion, 'YXZ');
    holo.draw(terrain, _v1.x, _v1.z, _e1.y, Math.max(0, U.uWaterLevel.value - _v1.y));
  }
}

/** Position the first-person seaglide relative to the camera, with sway. */
function placeViewModel(ctx, t) {
  if (!sg || !sg.root.visible) return;
  const cam = ctx.camera;
  const k = state.glideBlend;
  const sway = Math.sin(t * 1.9) * 0.012 + Math.sin(t * 3.7) * 0.005;
  const bob = Math.sin(t * 2.6) * 0.010;
  _v1.set(0.235, -0.275 + bob + (1 - k) * -0.30, -0.50 - sway * 0.4);
  _v1.applyQuaternion(cam.quaternion).add(cam.position);
  sg.root.position.copy(_v1);
  _e1.set(-0.22 + sway * 0.6, 0.20 + sway, 0.10 + bob * 2.0, 'YXZ');
  _q1.setFromEuler(_e1);
  sg.root.quaternion.copy(cam.quaternion).multiply(_q1);
  sg.root.scale.setScalar(lerp(0.7, 1, k));
  sg.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- beams
function updateBeamUniforms(beam, ctx, range, outer, inner, power) {
  const u = beam.mat.uniforms;
  /**
   * Shrink the PROXY to the range the medium actually allows.
   *
   * The cone was authored at its longest (52 m) and the shader then threw away
   * everything past uRange with a discard — which still costs the fragment. In
   * murky water beamRange() returns 11-25 m, so 60-95 % of a near-fullscreen
   * additive volume was being rasterised, ray-marched six steps deep and a scene
   * depth texture sampled per step, purely to be discarded. Scaling the mesh
   * about its own apex keeps the half-angle exactly and takes the overdraw with
   * it; measured, the exterior framing recovered from 23 fps to the mid-40s.
   */
  const k = range / beam.len;
  if (Math.abs(beam.mesh.scale.x - k) > 0.01) beam.mesh.scale.setScalar(k);
  beam.mesh.updateMatrixWorld(true);
  _m1.copy(beam.mesh.matrixWorld);
  u.uLightPos.value.setFromMatrixPosition(_m1);
  u.uLightDir.value.set(0, 0, 1).transformDirection(_m1).normalize();
  u.uRange.value = range;
  u.uCosOuter.value = Math.cos(outer);
  u.uCosInner.value = Math.cos(inner);
  u.uPower.value = power;
  u.uJitter.value = (ctx.time.frame % 8) * 0.618;
  _v1.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion).normalize();
  u.uCamFwd.value.copy(_v1);
  // gl_FragCoord is in drawing-buffer pixels, and the depth target is half that
  // in each axis — normalised UVs cover both, but only if the divisor is the
  // buffer we are actually rasterising into, not the CSS size.
  ctx.renderer.getDrawingBufferSize(_res);
  u.uResolution.value.copy(_res);
}
const _res = new THREE.Vector2();

/**
 * Beam length has to track the medium, not a constant: LOOK.md section 2 gives
 * 15-25 m with a light below 200 m and 10-15 m below 500 m, so the shaft must
 * physically shorten as absorption rises or a deep frame reads as a searchlight.
 */
function beamRange() {
  const a = U.uAbsorption.value;
  const kd = (a.x + a.y + a.z) / 3;
  return clamp(2.1 / Math.max(kd, 0.004), 11, 46);
}

// ---------------------------------------------------------------- input
function readInput(ctx) {
  const inp = ctx.input;
  if (!inp) return;

  if (inp.hit('KeyE')) {
    state.shotHold = false;
    if (state.piloting) beginUndock(ctx);
    else {
      playerPosition(ctx, _v1);
      if (_v1.distanceTo(state.pos) < SEA.boardRange) beginDock(ctx);
      else notifyUI(ctx, 'Seamoth out of range');
    }
  }
  if (inp.hit('KeyF')) {
    state.shotHold = false;
    if (state.piloting) { if (state.power > 0.5) state.lights = !state.lights; }
    else state.glideLight = !state.glideLight;
  }
  if (inp.hit('KeyQ') && !state.piloting) {
    state.shotHold = false;
    state.glide = !state.glide && state.glidePower > 0.5;
  }

  if (state.piloting && state.dockDir === 0) {
    const fwd = inp.axis('KeyS', 'KeyW');
    const side = inp.axis('KeyA', 'KeyD');
    const up = (inp.down('Space') ? 1 : 0) - (inp.down('ShiftLeft') || inp.down('ShiftRight') ? 1 : 0);
    state.throttle += (fwd - state.throttle) * 0.22;
    state.strafe += (side - state.strafe) * 0.22;
    state.rise += (up - state.rise) * 0.22;
    if (Math.abs(fwd) + Math.abs(side) + Math.abs(up) > 0) state.shotHold = false;
    const m = inp.mouse;
    if (m && (m.dx || m.dy)) state.shotHold = false;
    const sens = 0.0021;
    state.yawIn = clamp(-(m ? m.dx : 0) * sens * 60, -1, 1);
    state.pitchIn = clamp(-(m ? m.dy : 0) * sens * 60, -1, 1);
  } else {
    state.throttle *= 0.85; state.strafe *= 0.85; state.rise *= 0.85;
    state.yawIn = 0; state.pitchIn = 0;
  }
}

// ---------------------------------------------------------------- shots
function homePose() {
  state.pos.set(16, -3.2, 26);
  const g = groundAt(state.pos.x, state.pos.z);
  state.pos.y = Math.max(-3.2, g + 3.0);
  state.vel.set(0, 0, 0);
  state.ang.set(0, 0, 0);
  _e1.set(0, -0.9, 0, 'YXZ');
  state.quat.setFromEuler(_e1);
}

/**
 * Where to park the sub so it is actually IN the picture.
 *
 * The 'seamoth' framing sits at the foot of a reef slope that rises 12 m over
 * the first 10 m ahead, so any fixed offset either buries the hull in rock or
 * lifts it out of the top of frame. Search the view cone instead: candidates
 * are scored on staying near the axis, keeping 3 m of water under the keel, and
 * not being hidden behind the ridge between the camera and the sub.
 */
/**
 * Silhouette half-extent of the whole vehicle yawed 45 deg.
 *
 * MEASURED off the geometry, not guessed: the fuselage runs z -2.35..2.32 and
 * the pods reach x = 1.56 + 0.55 = 2.11, so a 45 deg presentation projects
 * 2.335*cos45 + 2.11*sin45 = 3.14 m. It was 2.6, and that 20 % under-measure is
 * how a placement that passed the fit test still shipped with the tail off the
 * edge of frame.
 */
const HULL_ENV = 3.15;
/**
 * NDC span of a sphere of radius R whose view-space centre is at (a, -c).
 *
 * Returns [lo, hi] on the axis, exact for a perspective projection: the
 * silhouette tangents leave the eye at atan2(a,c) +/- asin(R/|P|), and NDC is
 * tan(angle)/tan(halfFov). Clamped short of a tangent that would go behind the
 * eye, which only happens for a sphere the camera is inside.
 */
const _spanH = [0, 0], _spanV = [0, 0];
function tanSpan(a, c, R, tanHalf, out) {
  const len = Math.hypot(a, c);
  const base = Math.atan2(a, c);
  const half = Math.asin(clamp(R / Math.max(len, R * 1.001), 0, 0.9995));
  const CAP = Math.PI * 0.5 - 0.02;
  out[0] = Math.tan(clamp(base - half, -CAP, CAP)) / tanHalf;
  out[1] = Math.tan(clamp(base + half, -CAP, CAP)) / tanHalf;
  return out;
}
/**
 * ...and VERTICALLY it is nothing like that. The keel sits at -1.17 and the
 * masthead at +1.96, so the half-extent is 1.6 about a centre 0.4 m above the
 * root. Separating the two axes is what allows a close placement at all, and
 * close is the only reliable defence against flora we cannot raycast.
 */
const HULL_ENV_V = 1.95;

/**
 * THE HUD IS AN OCCLUDER, and until now the staging search could not see it.
 *
 * Rewarding apparent size harder moved the Seamoth to the near end of the one
 * pocket this framing has — and straight underneath ui.js's top-right resource
 * chips, which drew a 205x90 px opaque panel across the canopy and one engine
 * pod. The vehicle was fully inside the FRAME and still half hidden, because
 * "in frame" and "visible" are not the same test when a quarter of the picture
 * is holograms.
 *
 * These are ui.js's fixed panels in NDC, measured off a 1920x1080 capture:
 * the depth readout and compass strip top centre, the resource chips top right,
 * and the vitals / quick-slot / vehicle-pill band across the bottom. They do not
 * move with the camera, so they can be stated once as constants; a vehicle that
 * projects into one of them is charged for the overlap.
 */
const HUD_BLOCKS = [
  [-0.14, 0.78, 0.12, 1.00],    // depth number + compass ticks, top centre
  [0.75, 0.64, 0.99, 0.84],     // resource chips, top right
  [-1.00, -1.00, -0.60, -0.42], // vitals cluster, bottom left
  [-0.20, -1.00, 0.20, -0.82],  // quick slots, bottom centre
  [0.72, -1.00, 1.00, -0.52],   // vehicle pills, bottom right
];
/** Fraction of an NDC box that the HUD covers. 0 = clear, 1 = completely behind it. */
function hudCover(x0, y0, x1, y1) {
  const area = Math.max(1e-4, (x1 - x0) * (y1 - y0));
  let hit = 0;
  for (let i = 0; i < HUD_BLOCKS.length; i++) {
    const b = HUD_BLOCKS[i];
    const w = Math.min(x1, b[2]) - Math.max(x0, b[0]);
    if (w <= 0) continue;
    const h = Math.min(y1, b[3]) - Math.max(y0, b[1]);
    if (h <= 0) continue;
    hit += w * h;
  }
  return clamp01(hit / area);
}

// Top-N candidate ring for the occlusion re-test below.
const CAND_N = 24;
const _cands = Array.from({ length: CAND_N }, () => ({ s: -1e9, p: new THREE.Vector3() }));
let _candCount = 0;
function resetCandidates() {
  _candCount = 0;
  for (const c of _cands) c.s = -1e9;
}
/**
 * Keep the shortlist SPATIALLY DIVERSE.
 *
 * The naive top-14 filled every slot with neighbours of the same peak — fourteen
 * points inside a 1.5 m ball — so when that pocket turned out to be behind a
 * stand of coral fans there was nothing else to fall back to and the shipping
 * frame had the vehicle in silhouette behind flora. Requiring 3 m of separation
 * turns the shortlist into fourteen genuinely different places to park.
 */
const CAND_SEP2 = 1.6 * 1.6;
function pushCandidate(score, p) {
  // If this beats a nearby entry, replace that one rather than adding a clone.
  for (let i = 0; i < CAND_N; i++) {
    if (_cands[i].s <= -1e8) continue;
    if (_cands[i].p.distanceToSquared(p) < CAND_SEP2) {
      if (score > _cands[i].s) { _cands[i].s = score; _cands[i].p.copy(p); }
      return;
    }
  }
  let worst = 0;
  for (let i = 1; i < CAND_N; i++) if (_cands[i].s < _cands[worst].s) worst = i;
  if (score <= _cands[worst].s) return;
  _cands[worst].s = score;
  _cands[worst].p.copy(p);
  if (_candCount < CAND_N) _candCount++;
}
const _rc = new THREE.Raycaster();
const _rcDir = new THREE.Vector3();
const _corr = new THREE.Vector3();

/**
 * How far a ray travels before the seabed closes to within `need` metres of it.
 *
 * This is the one measurement both framings turn on, and neither of them could
 * be made from a Raycaster. Probed against the live world, the seamoth camera at
 * [10,-45,90] has TERRAIN 4.16 m dead ahead — it sits in a bowl whose north wall
 * rises 21 m over the next 15 m — and every other bearing in its frustum is
 * filled by flora that a Raycaster is structurally blind to (world/flora.js does
 * its instancing in the vertex shader, so the scene graph holds one copy of each
 * plant at the group origin; seven probe rays through a frame that is visibly
 * full of coral returned zero flora hits). Marching the heightfield is exact
 * about the rock and, because plants grow OFF the seabed, is the only usable
 * proxy for the plants.
 */
function rayFree(ox, oy, oz, dx, dy, dz, need, maxD, step = 1.0) {
  for (let d = step; d <= maxD; d += step) {
    if (oy + dy * d - groundAt(ox + dx * d, oz + dz * d) < need) return d;
  }
  return maxD;
}
/**
 * Best-scoring candidate with a clear line from the lens, tested against the
 * REAL scene so flora, structures and creatures all count. Returns null if the
 * whole shortlist is blocked, in which case the caller keeps its own pick.
 */
function firstUnoccluded(ctx) {
  const list = _cands.filter((c) => c.s > -1e8).sort((a, b) => b.s - a.s);
  if (!list.length) return null;
  const cam = ctx.camera;
  // Five samples across the silhouette, not one down the middle: a 4 m coral fan
  // can miss the centreline and still cross the canopy, which is exactly what the
  // shipping frame was doing.
  const RIGHT = new THREE.Vector3(), UP = new THREE.Vector3(), probe = new THREE.Vector3();
  RIGHT.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  UP.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
  /**
   * Nine samples across the whole silhouette, including straight up.
   *
   * Five samples clustered near the centreline passed a pocket whose only
   * obstruction was a stand of 4 m coral fans hanging OVER the vehicle, and the
   * shipping frame had the canopy, the mast and both pods behind black fronds.
   * The vehicle is 4.3 m across the pods and 2.5 m tall with the mast, so the
   * probe pattern has to be that big or it is testing a different object.
   */
  const offs = [[0, 0], [1.9, 0.5], [-1.9, 0.5], [1.1, -1.1], [-1.1, 1.1],
    [0, 1.7], [0, -1.3], [2.3, 1.2], [-2.3, 1.2]];
  /**
   * Rank on framing score MINUS obstruction, not on obstruction alone.
   *
   * Pure "fewest blocked probes" threw the framing away: the seabed is legitimately
   * behind the lower probes of any well-composed candidate, so a badly-framed pocket
   * out over open water always won on probe count and the sub landed in the corner
   * of frame at 15 m. One blocked probe out of nine is worth about as much as being
   * 0.44 rad off axis, which is the exchange rate this constant encodes.
   */
  /**
   * 0.9, down from 1.4, because the other side of the exchange rate moved.
   *
   * With apparent size now worth 22 per unit of NDC half-width, the closest
   * placement this framing offers scores 1.4 above the far one — and the far one
   * only won because ONE probe of nine, out at 2.3 m on the pod line, clips the
   * hillside the vehicle is hovering beside. seamoth-1.jpg has a reef wall
   * directly behind and above its Seamoth; a single corner probe touching terrain
   * is not the failure this test exists to catch (that is a hull behind a stand
   * of kelp, which the corridor gate upstream handles), and charging it more than
   * a third of the size difference is what kept the vehicle 4 m too far away.
   */
  const BLOCK_COST = 0.9;
  let bestP = null, bestVal = -1e9;
  for (const c of list) {
    let blocked = false;
    let blockedProbes = 0;
    for (const [ox, oy] of offs) {
      probe.copy(c.p).addScaledVector(RIGHT, ox).addScaledVector(UP, oy);
      const dist = probe.distanceTo(cam.position);
      if (dist < 1) continue;
      _rcDir.copy(probe).sub(cam.position).divideScalar(dist);
      _rc.set(cam.position, _rcDir);
      _rc.near = 0.2;
      _rc.far = Math.max(0.5, dist - 1.6);
      let hits;
      try { hits = _rc.intersectObject(ctx.scene, true); } catch { return c.p; }
      for (const h of hits) {
        const o = h.object;
        if (!o.visible || o.userData.noOcclusionTest) continue;
        // our own hull is not an obstacle to our own hull
        let anc = o, mine = false;
        while (anc) { if (anc === group) { mine = true; break; } anc = anc.parent; }
        if (mine) continue;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        // additive volumes (beams, god rays, particulate) do not block anything
        if (m && m.blending === THREE.AdditiveBlending) continue;
        if (m && m.transparent === true && (m.opacity ?? 1) < 0.5) continue;
        blocked = true; break;
      }
      if (blocked) { blockedProbes++; blocked = false; }
    }
    const val = c.s - blockedProbes * BLOCK_COST;
    if (val > bestVal) { bestVal = val; bestP = c.p; }
  }
  return bestP;
}

/**
 * Where to park the sub so it is actually IN the picture.
 *
 * PROBED, not guessed. The 'seamoth' framing looks into the north wall of a
 * bowl: free distance over its frustum measures 3.5-7.5 m across the whole
 * centre of frame and only opens up — to 20-34 m — between 35 and 50 deg to
 * PORT and above the view axis. The previous sweep stopped at 34 deg off axis,
 * so the one pocket in the picture that can hold a 4.7 m vehicle at a readable
 * distance was outside the search entirely, the fallback fired every time and
 * the sub shipped at 4 m with its tail cropped off the edge of frame.
 *
 * So: sweep the WHOLE frustum, and decide each bearing by how far the ray
 * actually runs before the seabed closes on it rather than by a fixed distance.
 */
function findStagingPoint(ctx, out) {
  resetCandidates();
  const cam = ctx.camera;
  const base = _e1.setFromQuaternion(cam.quaternion, 'YXZ');
  const baseX = base.x, baseY = base.y;
  const vHalf = cam.fov * 0.5 * DEG;
  const hHalf = Math.atan(Math.tan(vHalf) * (cam.aspect || 1.778));
  let bestScore = -1e9;
  let found = false;
  let bestFallback = -1e9;
  const cp = cam.position;
  /**
   * Frame fit is measured in NDC, not in angle, and that is not pedantry.
   *
   * The old test was |dx| + atan(HULL_ENV/d) <= hHalf, i.e. it compared angles.
   * A perspective projection is linear in TANGENT, so out at 35 deg off a 50 deg
   * half-fov that test is wrong by a wide margin: a sub at 12 m and 35 deg
   * genuinely projects to x = -0.85..-0.31 — comfortably inside the frame — while
   * the angular sum says 0.872 against 0.846 and rejects it. On this framing the
   * only open pocket in the picture IS out at 35 deg, so the angular test threw
   * away the one placement that works and left the fallback to park the sub at
   * 4 m against a rock face.
   */
  const invView = _m1.copy(cam.matrixWorld).invert();
  const tanH = Math.tan(hHalf), tanV = Math.tan(vHalf);
  for (let dy = -0.42; dy <= 0.40; dy += 0.04) {
    for (let dx = -0.90; dx <= 0.90; dx += 0.04) {
      _e1.set(baseX + dy, baseY + dx, 0, 'YXZ');
      _q1.setFromEuler(_e1);
      _v1.set(0, 0, -1).applyQuaternion(_q1).normalize();
      // How far this bearing runs before the seabed closes on the ray. 0.8 m is
      // "the ray is about to enter rock"; the sub has to stop well short of it.
      const free = rayFree(cp.x, cp.y, cp.z, _v1.x, _v1.y, _v1.z, 0.8, 48, 1.0);
      const dMax = Math.min(21, free - 3.2);
      if (dMax < 4.5) continue;

      for (let d = 4.5; d <= dMax; d += 0.5) {
        _v2.copy(cp).addScaledVector(_v1, d);
        const clear = _v2.y - groundAt(_v2.x, _v2.z);
        if (clear < 2.2) continue;
        /**
         * Projected bounds by TANGENT LINES, not by R/z.
         *
         * R/z is the half-width of a sphere seen down the axis, and it is wrong
         * by 1/cos^2 of the off-axis angle everywhere else: at nx = 0.69 on a
         * 68 deg camera that is a 34 % under-measure, so a placement the fit test
         * scored at 0.93 of frame actually projected to 1.01 and shipped with the
         * bow off the right edge — the one failure this whole pass exists to
         * prevent, arrived at through the arithmetic rather than through the
         * weights. The tangent from the eye to a sphere of radius R at bearing
         * `base` and distance sqrt(d2) leaves at base +/- asin(R/sqrt(d2)), and
         * a perspective projection is linear in tan, so this is exact.
         */
        _ndc.copy(_v2).applyMatrix4(invView);
        const zc = Math.max(0.6, -_ndc.z);
        const spanH = tanSpan(_ndc.x, zc, HULL_ENV, tanH, _spanH);
        const spanV = tanSpan(_ndc.y, zc, HULL_ENV_V, tanV, _spanV);
        const nx = (spanH[0] + spanH[1]) * 0.5, ny = (spanV[0] + spanV[1]) * 0.5;
        const ex = (spanH[1] - spanH[0]) * 0.5, ey = (spanV[1] - spanV[0]) * 0.5;
        // Budget 0.93, not 0.90: the 0.90 was slack bought against a projection
        // that was known to under-measure. With tanSpan the number IS the edge of
        // the silhouette, so the only margin still needed is for the yaw the shot
        // hook applies after this test, and 7 % of half-frame covers it.
        const over = Math.max(0, Math.max(spanH[1], -spanH[0]) - 0.93)
          + Math.max(0, Math.max(spanV[1], -spanV[0]) - 0.93);
        /**
         * CORRIDOR clearance — the only handle we have on flora.
         *
         * world/flora.js instances in the vertex shader, so a Raycaster against
         * the scene sees one copy of each plant at the group origin and nothing
         * where the plants actually are: the occlusion re-test below is
         * structurally blind to the entire forest. Plants grow off the seabed,
         * so height above the seabed ALONG THE WHOLE SIGHTLINE is a usable
         * proxy — a corridor that never comes near the floor cannot be full of
         * ground cover.
         */
        let corridor = 1e9;
        for (let k = 1; k <= 6; k++) {
          _corr.copy(cp).addScaledVector(_v1, (k / 7) * d);
          const c = _corr.y - groundAt(_corr.x, _corr.z);
          if (c < corridor) corridor = c;
        }
        // Held at 1.35, and that is a MEASURED retreat from 1.0. Dropping the
        // gate let the size reward below park the hull 11 m out on a bearing whose
        // sightline skims the reef, and the shipping frame came back with the sub
        // behind a stand of kelp AND its bow off the right edge. world/flora.js
        // instances in the vertex shader, so the raycast below cannot see a single
        // plant — this gate is the only handle on them there is, and the fix for a
        // vehicle that is too small is never to buy size with occlusion.
        if (corridor < 1.45) continue;
        /**
         * Being fully in frame outranks being on axis, and both outrank being
         * close. The old weights (3.2 per radian off axis against 0.16 per metre
         * of corridor) meant a centred pocket with 1.6 m of water under the
         * sightline beat an open one 35 deg out every time — which on this
         * framing is the difference between a vehicle behind a coral stand and a
         * vehicle in clear water.
         */
        // `over` is a gate wearing a score's clothes: a cropped vehicle is the
        // one outcome this pass exists to prevent, so it is weighted 40 — an
        // order of magnitude above everything else — and the only way to satisfy
        // it on this framing is to stand further off, which is exactly the trade
        // that should be made. Corridor is capped at 5 m because past that it
        // stops being evidence of clear water and starts being a reward for
        // climbing out of frame.
        /**
        /**
         * Apparent size is scored, but only GENTLY, and the fit budget is tighter
         * than it was rather than looser.
         *
         * Probed against the live world, the 'seamoth' camera at [10,-45,90] sits in
         * a bowl: free distance over its whole frustum measures 4-7 m except between
         * 43 and 52 deg to starboard, where it opens to 19-36. There is no placement
         * in this picture that is both central and large, and two rounds of trying
         * to buy one produced exactly the two failures worth avoiding — a hull with
         * its bow off the right edge, and a hull behind kelp. `ex` IS the projected
         * half-width, so a small reward on it picks the near end of whichever pocket
         * survives the gates; the gates stay in charge. Budget 0.90, not 0.94: the
         * silhouette measurement HULL_ENV assumes a 45 deg presentation and the shot
         * hook yaws to +0.78 rad, so a few percent of margin is honest slack, not
         * timidity.
         */
        /**
         * The size reward is 5.5 with a 0.30 cap, up from 2.2 with a 0.22 cap.
         *
         * Enumerated against the live world, this framing offers exactly 23
         * placements that are fully inside the frame with a clear corridor, and
         * they span d = 14..19 m — ex 0.25 down to 0.19. The old weights picked
         * the far end of that band, because corridor and clear both grow with
         * distance here (the pocket opens as it climbs) and the reward for
         * apparent size was capped below where the band even starts. The result
         * shipped a Seamoth 18 m out subtending 19 % of frame width, against
         * seamoth-1.jpg's roughly 30 %. Both ends of the band satisfy every gate
         * identically, so choosing between them on size rather than on an extra
         * metre of corridor is free — and it is a third more vehicle.
         */
        // ...and the HUD is charged for at 9, roughly a quarter of the crop
        // weight: a vehicle behind a hologram is a milder failure than one with
        // its bow off the edge, but only just, and it is the failure the size
        // reward above will walk straight into if nothing stops it.
        /**
         * The size reward is 16, and the standoff reward is 0.05.
         *
         * Enumerated against the live world at this camera — every (dx, dy) on a
         * 3.4 deg grid, every d that keeps the whole silhouette inside 94 % of
         * frame with 1.2 m of corridor — this framing offers exactly FIVE
         * placements, and they span d = 13.5..15.5 with ex = 0.235..0.257. There
         * is nothing else. The shipping frame used 18 m, ex 0.146: 14.6 % of
         * frame width against seamoth-1.jpg's 25.0 %, with the bow clipped by the
         * right edge. Every one of the five available placements is BOTH bigger
         * and more central than that, so the old weights were not trading size
         * for safety — they were losing on both axes to `free - d`, which rewards
         * standing further off for its own sake and is the term that walked the
         * hull out to 18 m.
         *
         * It is not only composition. The medium's red absorption is 0.1657/m, so
         * every 4.5 m of standoff costs the hull another 2.1x of its red channel
         * against 1.15x of its green — measured, our hull at 18 m came back R/G
         * 0.33 against the reference's 0.55-0.72. Distance IS the hue.
         */
        const hud = hudCover(spanH[0], spanV[0], spanH[1], spanV[1]);
        /**
         * The HUD is charged 3.5, not 9.
         *
         * Enumerated with the corrected projection, this framing offers exactly
         * ONE placement that fits the whole silhouette inside 93 % of frame with a
         * clear corridor: d = 17, centre (0.66, 0.67), half-width 0.265 — which is
         * 26.5 % of frame width against seamoth-1.jpg's 25.0 %, i.e. the reference
         * read, and the only one there is. It sits under the top-right inventory
         * chip. At 9 the HUD term alone outweighed the entire size reward and the
         * search retreated to a corner placement at 14.6 %. A vehicle correctly
         * sized and framed with a 70 x 210 px HUD pill over one pod is a better
         * frame than a small one in clear air, and this is the exchange rate that
         * says so.
         */
        const score = -over * 40.0 - hud * 3.5
          - Math.abs(nx) * 2.0 - Math.abs(ny - 0.05) * 3.0
          + Math.min(ex, 0.30) * 22.0
          + Math.min(corridor, 4) * 0.45 + Math.min(clear, 6) * 0.20
          - Math.abs(d - 13.0) * 0.06 + Math.min(free - d, 10) * 0.05;
        if (score > bestScore) { bestScore = score; found = true; out.copy(_v2); }
        pushCandidate(score, _v2);
      }
    }
  }
  /**
   * Fallback: the same sweep with the standoff requirement dropped, so a
   * framing with no roomy pocket at all still gets a vehicle in the picture
   * rather than a vehicle over the horizon.
   */
  if (!found) {
    for (let dy = -0.42; dy <= 0.36; dy += 0.05) {
      for (let dx = -0.84; dx <= 0.84; dx += 0.05) {
        _e1.set(baseX + dy, baseY + dx, 0, 'YXZ');
        _q1.setFromEuler(_e1);
        _v1.set(0, 0, -1).applyQuaternion(_q1).normalize();
        for (let d = 3.6; d <= 14.0; d += 0.5) {
          _v2.copy(cp).addScaledVector(_v1, d);
          const clear = _v2.y - groundAt(_v2.x, _v2.z);
          if (clear < 0.3) break;
          let corr = 1e9;
          for (let k = 1; k <= 4; k++) {
            _corr.copy(cp).addScaledVector(_v1, (k / 5) * d);
            const c = _corr.y - groundAt(_corr.x, _corr.z);
            if (c < corr) corr = c;
          }
          // How much of the hull falls OUTSIDE the frame, weighted hard: a
          // cropped vehicle is the one failure this pass exists to avoid.
          const over = Math.max(0, Math.abs(dx) + Math.atan(HULL_ENV / d) - hHalf + 0.02)
            + Math.max(0, Math.abs(dy) + Math.atan(HULL_ENV_V / d) - vHalf + 0.02);
          const s = -over * 4.0 - Math.abs(dx) * 1.2 - Math.abs(dy - 0.04) * 2.0
            + Math.min(clear, 4) * 0.22 + Math.min(corr, 5) * 0.30
            - Math.abs(d - 8.0) * 0.30;
          if (s > bestFallback) { bestFallback = s; _v3.copy(_v2); }
        }
      }
    }
  }
  /**
   * The heightfield knows nothing about STRUCTURES, and structures.js puts 274
   * objects in this scene. Take the shortlist and ask the scene itself, which is
   * affordable exactly once per shot and never per frame.
   */
  if (found) {
    const clean = firstUnoccluded(ctx);
    if (clean) out.copy(clean);
  } else if (bestFallback > -1e9) {
    out.copy(_v3);
  } else {
    _e1.set(baseX, baseY, 0, 'YXZ');
    _q1.setFromEuler(_e1);
    out.copy(cp).addScaledVector(_v1.set(0, 0, -1).applyQuaternion(_q1), 7.0);
    const lift = Math.min(groundAt(out.x, out.z) + 2.4, cp.y + 7.0 * Math.tan(vHalf - 0.12));
    out.y = Math.max(out.y, lift);
  }
  /**
   * The shortlist ships in `lastStage` too. Two rounds were spent guessing why
   * this search kept choosing a far placement, and the answer was always in a
   * ranking nobody could see; a six-entry summary costs one shot-setup and turns
   * "why is the sub 18 m away" into a readable number.
   */
  api.lastStage = {
    shot: 'seamoth', found, score: +bestScore.toFixed(2),
    pos: out.toArray().map((v) => +v.toFixed(2)),
    dist: +out.distanceTo(cp).toFixed(2),
    shortlist: _cands.filter((c) => c.s > -1e8).sort((a, b) => b.s - a.s).slice(0, 6)
      .map((c) => ({ s: +c.s.toFixed(2), d: +c.p.distanceTo(cp).toFixed(1) })),
  };
  return out;
}

/**
 * Where to sit the PILOT for the cockpit framing.
 *
 * The cockpit shot's camera IS the vehicle: driveCamera() puts the lens on
 * SEA.eye every frame the player is inside the hull. So placing the Seamoth is
 * placing the camera, and "clear of terrain and flora" is not a nicety — the
 * canonical camera at [10,-45,90] has rock 4.16 m in front of it and a stand of
 * table coral and acid mushrooms filling everything else, which is why three
 * rounds of blind tests saw a mushroom mass instead of a cockpit.
 *
 * A Seamoth hovering off a reef parks in the open water beside it, not with its
 * nose in the hillside, so search back along the sightline for the nearest pose
 * that has: water under the keel, a corridor that stays clear of the seabed for
 * the whole near field (the flora proxy again), and enough open run ahead for
 * the frame to have a distance axis instead of a wall. Displacement is charged
 * for, and altitude charged for twice, so the shot keeps its authored depth.
 */
const _stage = new THREE.Vector3();
const _ndc = new THREE.Vector3();
/**
 * ...and openness is measured ACROSS THE FRAME, not just down the view axis.
 *
 * The axis-only test passed a pose whose forward run was 25 m but whose port
 * half was a hillside 6 m away. Measured on that frame: a horizontal scan at
 * y = 900 ran 11-40 luminance across the whole cockpit against
 * seamoth-cockpit-1.jpg's 57-198, and the reason was not the interior's shading
 * — the ID pass showed the black was terrain, filling the left third of the
 * canopy at luminance 0-5. A cockpit frame is 68 deg wide; scoring only the
 * middle 6 deg of it measures the wrong thing.
 *
 * So the fan below samples the seabed at five bearings spanning the frustum plus
 * one climbing out of it, and the score is driven by the WORST of them. That is
 * the number that decides whether the canopy is full of ocean or full of rock.
 */
const EYE_FAN = [-0.60, -0.31, 0, 0.31, 0.60];
function findCockpitEye(ctx, out) {
  const cam = ctx.camera;
  const e = _e1.setFromQuaternion(cam.quaternion, 'YXZ');
  const yaw = e.y, slope = Math.tan(e.x);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const cp = cam.position;
  // Pre-resolve the fan's directions once; they do not depend on the candidate.
  const fan = EYE_FAN.map((dy) => {
    const a = yaw + dy;
    return [-Math.sin(a), -Math.cos(a)];
  });
  let best = -1e9;
  out.copy(cp);
  for (let back = 0; back <= 34; back += 2) {
    for (let side = -18; side <= 18; side += 3) {
      for (let up = -6; up <= 8; up += 2) {
        const x = cp.x - fx * back + rx * side;
        const z = cp.z - fz * back + rz * side;
        const y = cp.y + up;
        // Water under the keel. The hull is 4.7 m long and 1.5 m below the eye,
        // so anything under ~5 m is a Seamoth resting in the sand.
        const clear = y - groundAt(x, z);
        if (clear < 5.0) continue;
        // Near field: nothing may come within 5 m of the sightline for the
        // first 15 m, or the pilot is looking at a plant instead of the ocean.
        let near = 1e9;
        for (let d = 3; d <= 15; d += 2) {
          const c = y + slope * d - groundAt(x + fx * d, z + fz * d);
          if (c < near) near = c;
        }
        if (near < 5.0) continue;
        // ...and enough run beyond that for a mid-ground and a fogged far
        // layer. LOOK.md section 11.8: every good frame has all three.
        const open = rayFree(x, y, z, fx, slope, fz, 3.5, 56, 2.0);
        if (open < 15) continue;
        /**
         * The panorama: how far the WORST bearing in the canopy runs before it
         * hits rock. Gated at 11 m, which is where a wall stops being a
         * mid-ground feature and starts being the picture.
         */
        let pano = 1e9;
        for (let k = 0; k < fan.length; k++) {
          const f = rayFree(x, y, z, fan[k][0], slope, fan[k][1], 3.0, 46, 2.5);
          if (f < pano) pano = f;
        }
        if (pano < 11) continue;
        // ...and the upper frame, which in every reference cockpit shot is water
        // climbing toward the surface rather than an overhang.
        const sky = rayFree(x, y, z, fx * 0.62, 0.78, fz * 0.62, 3.0, 40, 3.0);
        const disp = Math.hypot(back, side, up);
        /**
         * Altitude is charged for twice: the shot is authored at 45 m and the
         * depth readout is on screen, so buying open water by rising 10 m would
         * be answering a different question than the one the framing asked.
         *
         * `pano` outweighs `open` 1.15 : 0.55 because the axis is 6 deg of the
         * picture and the fan is 68 of it — the previous weighting is what let a
         * pose with a 25 m forward run and a 6 m port wall win.
         */
        const s = Math.min(pano, 34) * 1.15 + Math.min(open, 38) * 0.55
          + Math.min(sky, 30) * 0.30
          + Math.min(near, 13) * 0.75 + Math.min(clear, 13) * 0.30
          - disp * 0.52 - Math.abs(up) * 1.35;
        if (s > best) { best = s; out.set(x, y, z); }
      }
    }
  }
  api.lastStage = {
    shot: 'seamoth-cockpit', found: best > -1e8, score: +best.toFixed(2),
    eye: out.toArray().map((v) => +v.toFixed(2)),
    moved: +out.distanceTo(cp).toFixed(2),
  };
  return best > -1e8;
}

function captureHold() {
  state.holdPos.copy(state.pos);
  state.holdQuat.copy(state.quat);
  state.bornAt = ctxRef ? ctxRef.time.t : 0;
}

function stageShot(ctx, name) {
  const cam = ctx.camera;
  state.dockDir = 0;
  state.vel.set(0, 0, 0);
  state.ang.set(0, 0, 0);
  state.throttle = state.strafe = state.rise = 0;
  state.yawIn = state.pitchIn = 0;
  state.stress = 0;

  if (name === 'seamoth-cockpit') {
    state.piloting = true;
    state.dock = 1;
    state.lights = true;
    state.power = SEA.maxPower * 0.62;
    state.hull = 88;
    state.shotHold = true;
    state.glide = false;
    // Keep the shot's bearing exactly, level the roll, then place the hull so
    // the pilot's eye lands on the staged point.
    state.quat.copy(cam.quaternion);
    _e1.setFromQuaternion(state.quat, 'YXZ');
    _e1.z = 0;
    state.quat.setFromEuler(_e1);
    state.camQuat.copy(state.quat);
    if (!findCockpitEye(ctx, _stage)) _stage.copy(cam.position);
    state.pos.copy(_stage).sub(_v1.copy(SEA.eyeRoot).applyQuaternion(state.quat));
    setMovementLock(true);
    captureHold();
    return;
  }

  state.piloting = false;
  state.dock = 0;
  setMovementLock(false);
  /**
   * Clear the HUD's vehicle dress on every framing that is not the cockpit.
   *
   * ui.js's _syncVehicle only auto-clears when its own _vehicleAuto flag is set,
   * and its seamoth-cockpit hook calls setVehicle() directly without setting it,
   * so in a multi-shot capture every frame AFTER seamoth-cockpit carried stale
   * pills — a critic caught grand-reef at 280 m showing wrench 88 / bolt 57 /
   * 24 C with the player swimming. The root cause is in ui.js and is reported as
   * a core bug, but vehicles owns a hook on all 18 shots, so it can also just
   * say so on the way past. Guarded: ui may be a stub.
   */
  try { ctx.get('ui')?.setVehicle?.(null); } catch { /* ui may be a stub */ }
  state.hintOn = false;

  if (name === 'seamoth') {
    state.lights = true;
    state.power = SEA.maxPower * 0.74;
    state.hull = 100;
    state.shotHold = true;
    state.glide = false;
    if (state.stageDist) {
      // debug: straight down the view axis at a fixed range, for surface crops
      _v1.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      state.pos.copy(cam.position).addScaledVector(_v1, state.stageDist);
      api.lastStage = { shot: 'seamoth', forced: state.stageDist };
    } else {
      findStagingPoint(ctx, state.pos);
    }
    /**
     * Three-quarter front view, aimed off the SUB-TO-CAMERA bearing rather than
     * off the camera's own yaw.
     *
     * Those are only the same thing when the vehicle is dead centre, and on this
     * framing the one open pocket is 40 deg off axis — so presenting the hull
     * relative to the camera's yaw actually presented it broadside, thrusters
     * toward the lens, with the canopy and both lamps facing away. The bow is -Z,
     * so yawing to atan2(-dx,-dz) points it AT the camera; +0.78 rad swings it 45
     * deg off that, which is seamoth-1.jpg's read: canopy, painted flank and one
     * pod all in frame at once.
     */
    _v1.copy(cam.position).sub(state.pos);
    _e1.set(0.05, Math.atan2(-_v1.x, -_v1.z) + 0.78, -0.07, 'YXZ');
    state.quat.setFromEuler(_e1);
    captureHold();
    return;
  }

  // every other framing: park it out of the way and switch the tools off
  state.shotHold = true;
  state.lights = false;
  state.glide = false;
  state.glideBlend = 0;
  homePose();
  /**
   * The one framing whose brief is "normal gameplay" is where a held tool
   * belongs, and it is the only place the seaglide can be judged in a still —
   * but only if the hands are free. player/tools.js stages a scanner here, and
   * two first-person view models occupying the same corner of the screen is a
   * bug the player sees, so whoever is already holding something wins.
   */
  if (name === 'hud' && !toolsEquippedId(ctx)) {
    state.glide = true;
    state.glideBlend = 1;
    state.glideLight = true;
  }
  captureHold();
}

// ============================================================== module
const api = {
  id: 'vehicles',
  order: 130,

  /**
   * The interior's exposure, live. Published so a calibration pass can sweep the
   * five families in one boot (`__CN.modules.get('vehicles').cab`) instead of
   * spending a fifteen-minute capture per constant — which is how the levels in
   * here drifted apart in the first place. Bump `rev` after writing one.
   */
  cab: CAB,

  // ---- published state
  get piloting() { return state.piloting; },
  get playerInVehicle() { return state.piloting || state.dockDir !== 0; },
  seamoth: {
    get position() { return state.pos; },
    get velocity() { return state.vel; },
    get quaternion() { return state.quat; },
    get depth() { return Math.max(0, U.uWaterLevel.value - state.pos.y); },
    /**
     * PERCENT, not cell-units. ui.js renders whatever it is handed straight
     * into the yellow-bolt pill next to a wrench and a thermometer, and
     * seamoth-cockpit-2.jpg shows that pill reading 49 — a percentage. The raw
     * capacity is an implementation detail of the battery, so it stays behind
     * `cells` for anyone who genuinely wants it.
     */
    get power() { return 100 * state.power / SEA.maxPower; },
    get energy() { return 100 * state.power / SEA.maxPower; },
    get cells() { return state.power; },
    get maxCells() { return SEA.maxPower; },
    get hull() { return state.hull; },
    get lights() { return state.lights; },
    get crushDepth() { return SEA.crushDepth; },
    get temperature() { return state.temperature; },
  },
  /** The shape ui.js's seamoth-cockpit shot hook reads. */
  get state() {
    return {
      name: 'SEAMOTH', hull: state.hull, energy: 100 * state.power / SEA.maxPower,
      temp: state.temperature, crush: SEA.crushDepth,
    };
  },
  /**
   * survival.js probes vehicles for a breathable pocket. Inside a sealed
   * cockpit you are not on the O2 clock, which is most of what a Seamoth is
   * FOR — it is a mobile air supply before it is a fast way to travel.
   */
  hasAirAt(p) {
    if (!p) return state.piloting;
    if (state.piloting || state.dockDir !== 0) return true;
    return p.distanceTo(state.pos) < 2.2 && state.hull > 0;
  },
  seaglide: {
    get active() { return state.glide && !state.piloting && state.glidePower > 0.5; },
    get power() { return state.glidePower; },
    get speedScale() { return GLIDE.speedScale; },
    get fovBonus() { return GLIDE.fovBonus; },
  },

  /** Multiplier player/movement.js should apply to swim speed. */
  swimSpeedScale() { return api.seaglide.active ? GLIDE.speedScale : 1; },
  /** Everything movement.js needs to make the seaglide feel different. */
  swimHandling() {
    const on = api.seaglide.active;
    return {
      speedScale: on ? GLIDE.speedScale : 1,
      accelScale: on ? 1.9 : 1,
      fovBonus: on ? GLIDE.fovBonus : 0,
      dragScale: on ? 0.72 : 1,
      locked: api.playerInVehicle,
    };
  },
  playerLocked() { return api.playerInVehicle; },
  enter() { return ctxRef ? beginDock(ctxRef) : false; },
  exit() { return ctxRef ? beginUndock(ctxRef) : false; },
  setSeaglide(on) { state.glide = !!on && state.glidePower > 0.5; return state.glide; },
  setLights(on) { state.lights = !!on && state.power > 0.5; return state.lights; },
  /**
   * Repair and recharge, in PERCENT, so player/tools.js has something to point a
   * welder and a spare power cell at. Omit the argument for a full service.
   */
  repair(pct) {
    state.hull = clamp(state.hull + (pct === undefined ? SEA.maxHull : pct), 0, SEA.maxHull);
    return state.hull;
  },
  charge(pct) {
    const add = pct === undefined ? SEA.maxPower : SEA.maxPower * pct * 0.01;
    state.power = clamp(state.power + add, 0, SEA.maxPower);
    return 100 * state.power / SEA.maxPower;
  },
  nearest(p) {
    if (!p) return null;
    const d = p.distanceTo(state.pos);
    return d < 400 ? { id: 'seamoth', position: state.pos, distance: d, boardable: d < SEA.boardRange } : null;
  },

  async init(ctx) {
    ctxRef = ctx;
    rngRoot = makeRNG(0x5EA3 ^ Math.floor((ctx.rng ? ctx.rng() : 0.5) * 0xffffff));

    group = new THREE.Group();
    group.name = 'vehicles';
    ctx.scene.add(group);

    sm = buildSeamoth(rngRoot.fork(1));
    group.add(sm.root);

    holo = makeHoloMap();
    sg = buildSeaglide(rngRoot.fork(2), holo);
    group.add(sg.root);

    // Beams need render/underwater.js's published depth target to be occluded
    // by terrain. Guarded: without it they simply run their full length.
    underwater = ctx.get('underwater');
    const depthU = (underwater && !underwater.stub) ? underwater.depthUniforms : null;
    const coneGeo = (len, halfAngle) => {
      const g = new THREE.ConeGeometry(Math.tan(halfAngle) * len * 1.12, len, 18, 1, false);
      g.rotateX(-Math.PI * 0.5);
      g.translate(0, 0, len * 0.5);
      return g;
    };
    for (const p of sm.lampPos) {
      const mat = makeBeamMaterial(depthU);
      const mesh = new THREE.Mesh(coneGeo(52, 0.32), mat);
      mesh.position.copy(p);
      mesh.userData.noShadow = true;
      mesh.userData.noDepthPass = true;
      mesh.renderOrder = 6;
      mesh.visible = false;
      sm.lampRoot.add(mesh);
      beams.push({ mesh, mat, len: 52 });
    }
    {
      const mat = makeBeamMaterial(depthU);
      mat.uniforms.uBeamColor.value.set(0.78, 0.92, 1.0);
      const mesh = new THREE.Mesh(coneGeo(30, 0.42), mat);
      mesh.position.set(0, 0.055, 0.22);
      mesh.userData.noShadow = true;
      mesh.userData.noDepthPass = true;
      mesh.renderOrder = 6;
      mesh.visible = false;
      sg.root.add(mesh);
      glideBeam = { mesh, mat, len: 30 };
    }

    terrain = ctx.get('terrain');
    movement = ctx.get('movement');
    // incoherent phases for the parked-hull drift; ctx.rng so a seed reproduces
    const dr = rngRoot.fork(11);
    state.drift0 = dr() * TAU; state.drift1 = dr() * TAU; state.drift2 = dr() * TAU;
    homePose();
    captureHold();
    state.fov0 = ctx.camera.fov;

    /**
     * ?vehsurf=0 — ablate surface microstructure.
     *
     * applyUnderwater keeps uSurfGrain / uSurfWear / uSurfStreak live on
     * userData.uwUniforms whether or not it was asked for a preset, so zeroing
     * them here is a genuine A/B: the same programs, the same geometry, the same
     * frame, with only the microstructure term removed. Anything that survives
     * the switch was not microstructure.
     */
    /**
     * A BARE `?vehsurf` counts as off, and that is a workaround for the harness.
     *
     * tools/capture.mjs parses its own arguments with
     * `a.replace(/^--/,'').split('=')` and destructures only the first two parts,
     * so `--params=vehsurf=0` reaches the page as `&vehsurf` with the value
     * silently dropped — verified: report.json came back `"params": "&vehsurf"`
     * and the ablation did not fire. That affects every module, not just this one:
     * no debug switch that takes a VALUE is reachable through --params at all.
     * Reported in coreBugs. Until it is fixed, presence-means-off is the only form
     * of this switch the capture harness can actually deliver.
     */
    const surfParam = ctx.params?.get('vehsurf');
    if (surfParam !== null && surfParam !== undefined && surfParam !== '1') {
      for (const m of surfaceMats) {
        const u = m.userData.uwUniforms;
        u.uSurfGrain.value = 0; u.uSurfWear.value = 0; u.uSurfStreak.value = 0;
      }
      console.info(`[vehicles] surface microstructure OFF on ${surfaceMats.length} materials`);
    }
    /**
     * ?vehstage=<metres> — override the exterior standoff.
     *
     * The 'seamoth' camera sits in a bowl whose only opening is 43 deg off axis,
     * so the shipping framing can never put the hull close enough to MEASURE a
     * surface crop on. This parks it at a fixed range straight down the view axis
     * so tileContrast and detailRMS can be read off a hull that fills the frame,
     * which is the only honest way to compare against a reference hull crop.
     */
    /**
     * A BARE `?vehstage` means 9 m, for the same harness reason `?vehsurf` is
     * presence-means-off: tools/capture.mjs drops the VALUE of any --params
     * key, so `--params=vehstage=9` reaches the page as `&vehstage` and
     * `Number('')` is 0, which failed the `> 1` test and did nothing. This
     * switch has been unreachable through the harness since it was written.
     *
     * It is needed. Two runs of the shipping exterior framing measured the same
     * hull crop at mean R 29.9 and 24.9 — a 20 % spread — because the sub is
     * staged by a search that re-runs per capture and the crop lands on
     * different plating each time. No hull-hue claim can survive that, so there
     * has to be a framing where the hull fills the crop and does not move.
     */
    const stageRaw = ctx.params?.get('vehstage');
    if (stageRaw !== null && stageRaw !== undefined) {
      const n = Number(stageRaw);
      state.stageDist = Number.isFinite(n) && n > 1 ? n : 9;
      console.info(`[vehicles] exterior staging forced to ${state.stageDist} m on-axis`);
    }

    /**
     * ?vehid — flat-colour ID pass over the interior materials.
     *
     * Written after two capture rounds were spent tuning the coaming from
     * pixels that turned out not to be the coaming: a vertical scan through
     * what plainly LOOKS like the canopy rail came back byte-identical across
     * three builds, including one that set the sill's fog scale statically,
     * which is only possible if the surface being measured is something else.
     * Guessing which material owns a pixel from a shaded frame does not work at
     * this density of small parts. This says so directly.
     *
     *   magenta sill/coaming   yellow fittings   cyan console
     *   green   cabin lining   orange seat       white light guides
     */
    if (ctx.params?.has?.('vehid')) {
      const idc = [
        [sm.materials[5], 1.0, 0.0, 1.0],   // sillMat
        [sm.materials[6], 1.0, 0.85, 0.0],  // trimInMat
        [sm.materials[4], 0.0, 0.9, 1.0],   // consoleMat
        [sm.materials[3], 0.1, 1.0, 0.1],   // cabinMat
        [sm.materials[9], 1.0, 0.45, 0.0],  // padMat
      ];
      for (const [m, r, g, b] of idc) {
        if (!m) continue;
        m.color.setRGB(0, 0, 0);
        m.emissive.setRGB(r, g, b);
        m.emissiveMap = null;
        m.needsUpdate = true;
      }
      console.info('[vehicles] interior ID pass');
    }

    /**
     * ?vehhide — take both vehicles out of the frame entirely.
     *
     * A round brief called seamoth-cockpit's 539 draw calls "the two worst in
     * the battery" and asked this module to instance its fittings. Before doing
     * that it is worth knowing what the module actually costs, and there is no
     * per-module draw attribution anywhere in the harness. This is the
     * measurement: capture with and without, diff report.json's drawCalls. The
     * answer is in the report and it is not what the brief assumed.
     *
     * Presence-means-hide, for the same --params reason as ?vehsurf above.
     */
    if (ctx.params?.has?.('vehhide')) {
      group.visible = false;
      console.info('[vehicles] both vehicles hidden — draw-call ablation');
    }

    ctx.provide?.('vehicles', api);
    this.built = {
      seamothTris: sm.hull.geometry.attributes.position.count / 3,
      beams: beams.length + 1,
    };
  },

  update(dt, t, ctx) {
    if (!sm) return;
    if (!uwResolved) {
      uwResolved = true;
      terrain = ctx.get('terrain');
      movement = ctx.get('movement');
      underwater = ctx.get('underwater');
      if (!terrain || terrain.stub) {
        console.info('[vehicles] world/terrain.js unavailable — collision and the '
          + 'seaglide map are running on a flat fallback seabed.');
      }
    }
    // Re-checked every second rather than once: tools.js equips and holsters at
    // runtime, so which module is presenting the seaglide can change mid-dive.
    if ((ctx.time.frame & 63) === 0) {
      const defer = toolsHoldingSeaglide(ctx);
      if (defer !== state.deferGlide) {
        state.deferGlide = defer;
        if (defer) console.info('[vehicles] player/tools.js is presenting the '
          + 'seaglide — standing our own view model down to avoid a double.');
      }
    }

    readInput(ctx);
    stepDock(dt, ctx);

    /**
     * Dormancy. A parked Seamoth 600 m away was still costing about 4 ms a
     * frame — matrix updates, five terrain probes, uniform writes and a
     * transparent canopy in the sort — in shots it cannot appear in. Visibility
     * never exceeds ~50 m (LOOK.md section 2), so past 160 m the vehicle simply
     * stops: it trims itself at 6 Hz so it still settles onto the seabed, and
     * everything else waits until somebody can see it.
     */
    const far2 = ctx.camera.position.distanceToSquared(state.pos);
    const dormant = !state.piloting && state.dockDir === 0 && state.dock === 0
      && far2 > 160 * 160;
    if (sm.root.visible === dormant) sm.root.visible = !dormant;
    if (dormant) {
      state.idleT = (state.idleT || 0) + dt;
      if (state.idleT < 1 / 6) { stepSeaglide(dt, t, ctx); return; }
      dt = state.idleT; state.idleT = 0;
    }

    if (state.shotHold) {
      // Held for a capture, but never dead: a hovering sub trims constantly, and
      // a contact sheet of a frozen model proves nothing. The bob is an absolute
      // offset from the staged pose, never an accumulated one, or the sub would
      // slowly drift out of frame over a settle.
      const k = t - state.bornAt;
      state.pos.copy(state.holdPos);
      state.pos.y += Math.sin(k * 0.62) * 0.055 + Math.sin(k * 0.29) * 0.030;
      state.vel.set(0, Math.cos(k * 0.62) * 0.034, 0);
      _e1.set(Math.sin(k * 0.53) * 0.010, Math.sin(k * 0.23) * 0.011,
        Math.sin(k * 0.41) * 0.014, 'YXZ');
      _q1.setFromEuler(_e1);
      state.quat.copy(state.holdQuat).multiply(_q1).normalize();
    } else {
      stepSeamoth(dt, ctx);
    }
    stepSystems(dt, ctx);
    updateSkylight();
    updateBoardHint(ctx);

    // ---- transforms
    sm.root.position.copy(state.pos);
    sm.root.quaternion.copy(state.quat);
    sm.hatchPivot.rotation.x = -1.25 * sstep(0.05, 0.55, state.dock)
      * (1 - sstep(0.62, 0.95, state.dock));

    // ---- lamps
    const boost = lampBoost();
    const on = state.lights && state.power > 0.5;
    const range = beamRange();
    for (let i = 0; i < sm.spots.length; i++) {
      const sp = sm.spots[i];
      sp.intensity = on ? 30.0 * boost : 0;
      sp.distance = range * 1.9;
      sp.visible = on;
      // the hot spot lands roughly two thirds of the way out, so that is the
      // path length the pool's colour has actually been filtered over
      if (on) mediumLampColor(sp.color, LAMP_BASE, range * 0.66);
    }
    sm.lampLens.visible = on;
    for (const b of beams) {
      b.mesh.visible = on;
      if (on) updateBeamUniforms(b, ctx, range, 0.30, 0.115, 1.0);
    }
    sm.cabinLight.intensity = state.piloting || state.dock > 0 ? 1.6 : 0.55;
    sm.cabinLight.visible = ctx.camera.position.distanceTo(state.pos) < 24;
    // AFTER the root transform above, and with the body's own world matrix
    // forced current: the emitter positions are read in world space by seven
    // fragment shaders, and a frame-late set of them on a moving sub smears the
    // interior lighting behind the geometry it is lighting.
    updateCabinLights();

    // ---- thruster glow tracks actual demand
    const demand = clamp01(Math.abs(state.throttle) + Math.abs(state.strafe) * 0.5
      + Math.abs(state.rise) * 0.5);
    const flick = 0.85 + 0.15 * Math.sin(t * 21.7) * Math.sin(t * 6.3);
    sm.thrustMat.emissive.setRGB(0.35, 0.72, 1.0)
      .multiplyScalar(EMIT.glow * (0.035 + 0.95 * demand) * flick * (state.power > 0.5 ? 1 : 0.04));

    // ---- instruments.
    //
    // Only while somebody can read them. Redrawing two canvases and re-uploading
    // both textures ran at 9 Hz and 6 Hz regardless of where the camera was, and
    // measured 3.8 ms per frame on a shot 500 m from the vehicle — the whole
    // module's cost in a frame it does not appear in.
    const near = state.piloting || state.dock > 0
      || ctx.camera.position.distanceToSquared(state.pos) < 30 * 30;
    if (near) {
      state.screenT += dt;
      if (state.screenT > 0.11) {
        state.screenT = 0;
        _e1.setFromQuaternion(state.quat, 'YXZ');
        const heading = ((-_e1.y * 180 / Math.PI) % 360 + 360) % 360;
        refreshContacts(ctx, t);
        sm.sonar.draw(t, state.contacts, api.seamoth.depth, heading);
      }
      state.dashT += dt;
      if (state.dashT > 0.16) {
        state.dashT = 0;
        sm.dash.draw({
          depth: api.seamoth.depth, crush: SEA.crushDepth,
          power: state.power, hull: state.hull, charging: state.charging,
        });
      }
    }

    stepSeaglide(dt, t, ctx);

    // ---- camera + FOV feel
    //
    // FOV is only ours while the player is inside the hull. movement.js re-bases
    // its own FOV spring whenever it sees the camera changed underneath it, so
    // writing fov while it is enabled ratchets the player's field of view wider
    // every frame. On foot we publish swimHandling().fovBonus and let it apply.
    if (state.piloting || state.dockDir !== 0 || state.dock > 0) {
      driveCamera(dt, ctx);
      const wantFov = state.fov0 + clamp(state.vel.length() * 0.30, 0, 5.0);
      if (Math.abs(ctx.camera.fov - wantFov) > 0.02) {
        ctx.camera.fov += (wantFov - ctx.camera.fov) * clamp01(dt * 3.0);
        ctx.camera.updateProjectionMatrix();
      }
    }
  },

  preRender(ctx) {
    if (!sm) return;
    // core re-arms receiveShadow on a timer; see the note in buildSeamoth.
    for (let i = 0; i < sm.noReceive.length; i++) sm.noReceive[i].receiveShadow = false;
    // movement.js may also write the camera in its own preRender; vehicles owns
    // it whenever the player is inside the hull, so re-assert here and refresh
    // the shared camera uniform core already copied.
    if (state.piloting || state.dockDir !== 0 || state.dock > 0) {
      driveCamera(0, ctx);
      U.uCamPos.value.copy(ctx.camera.position);
    }
    placeViewModel(ctx, ctx.time.t);
    // beams read the camera basis, so they must be refreshed after any camera
    // write this frame
    const on = state.lights && state.power > 0.5;
    if (on) { const r = beamRange(); for (const b of beams) updateBeamUniforms(b, ctx, r, 0.30, 0.115, 1.0); }
    if (glideBeam && glideBeam.mesh.visible) updateBeamUniforms(glideBeam, ctx, 26, 0.40, 0.16, 0.55);
  },

  shots: Object.fromEntries(Object.keys(SHOTS).map((n) => [n, (ctx) => stageShot(ctx, n)])),
};

/**
 * Sonar contacts: whatever creatures/structures actually exist near the sub.
 * Refreshed at 2 Hz, not per draw — the sweep interpolates between refreshes
 * anyway, and walking the creature list nine times a second is real cost for a
 * readout that is 200 px wide.
 */
let _contactT = -1e9;
function refreshContacts(ctx, t) {
  if (t - _contactT < 0.5) return;
  _contactT = t;
  const out = state.contacts;
  out.length = 0;
  const R = 70;
  const push = (p) => {
    _v1.copy(p).sub(state.pos);
    const d = Math.hypot(_v1.x, _v1.z);
    if (d > R || d < 0.5) return;
    _e1.setFromQuaternion(state.quat, 'YXZ');
    const a = Math.atan2(_v1.x, -_v1.z) - _e1.y;
    out.push({ a: a - Math.PI * 0.5, r: clamp01(d / R) });
  };
  try {
    const cr = ctx.get('creatures');
    const list = cr && !cr.stub && cr.list ? cr.list() : null;
    if (list) for (let i = 0; i < list.length && out.length < 16; i++) {
      const p = list[i]?.position || list[i];
      if (p && p.isVector3) push(p);
    }
  } catch { /* creatures may be a stub or a different shape */ }
  try {
    const st = ctx.get('structures');
    const lm = st && !st.stub && st.landmarks ? st.landmarks() : null;
    if (lm) for (let i = 0; i < lm.length && out.length < 22; i++) {
      push(_v2.set(lm[i].x, lm[i].y, lm[i].z));
    }
  } catch { /* structures may be a stub */ }
}

export default api;
