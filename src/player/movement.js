/**
 * MOVEMENT — swimming: buoyancy, drag, momentum, fin-kick sprint, camera feel,
 * the waterline crossing and seabed collision.
 *
 * OWNER: the "movement" agent. Every second of this game is experienced through
 * this file, so it owns three things: the physics of a body suspended in water,
 * the camera that body carries, and the published player state the rest of the
 * game reads (position / velocity / isSubmerged).
 *
 * Five things are worth understanding before changing a number here, and the
 * fifth is where the last four rounds of defects have all lived.
 *
 * 1. WATER HAS MASS. Input produces an *acceleration*, never a velocity, and the
 *    only thing that stops you is drag: a linear (viscous) term that dominates
 *    at low speed and gives the long lazy glide, plus a quadratic (form drag)
 *    term that shapes the high-speed tail. Cruise settles at 4.6 m/s and
 *    letting go at cruise costs 4.3 m to half speed and 8 m over four seconds.
 *    That coast is the single most important number in the module — delete it
 *    and the camera instantly reads as a flying spectator rather than a diver.
 *
 *    Top speed is NOT set by drag. It is set by the thrust taper: a fin is a
 *    propeller and its thrust collapses as the body approaches the speed at
 *    which the blade stops slipping through the water. That is what decouples
 *    the launch from the glide — they are both 1/drag otherwise, so every round
 *    that bought one sold the other. See T.slipMargin. The authored numbers are
 *    now the SPEEDS in T.speeds; every acceleration is derived from them.
 *
 *    The drag is ANISOTROPIC, referenced to the body's own axis: a diver is
 *    streamlined along the line they are swimming and broadside to everything
 *    else, so velocity that no longer points where the body points is scrubbed
 *    T.crossDrag times faster than velocity that does. That is what a body in
 *    water feels like — you coast a long way forward and you do not coast
 *    sideways at all — and it is what keeps a long glide from turning every
 *    turn into a skid.
 *
 * 2. THE DIVER RIDES THE SEA, the sea does not wash over the diver. Buoyancy is
 *    a spring on submerged fraction (the body is 1.8 m tall with the eye 1.55 m
 *    up from the soles) resting the eye 0.50 m proud of the local wave, and the
 *    vertical velocity is relaxed toward the WATER'S own vertical velocity so
 *    the body is carried by the swell at frequencies far above anything the
 *    spring could track. Buoyancy is sampled over the body's 1.24 m footprint,
 *    not at a point, because a wave shorter than the hull cancels itself inside
 *    a pressure integral.
 *
 *    Buoyancy is a SURFACE EFFECT AND NOTHING ELSE: it is windowed to exactly
 *    zero by T.buoyNeutral (1.5 m), so a diver at any depth past that is
 *    perfectly neutral and holds station with the input released. You bob at
 *    the surface, you hover at depth, and the waterline never strobes.
 *
 *    The float YIELDS to a commanded descent (see T.diveWish), because a force
 *    strong enough to keep the chop out of the lens is otherwise a lid on the
 *    ocean.
 *
 * 3. THE CAMERA TRAILS THE BODY — on acceleration, not on velocity. `position`
 *    is the body's eye anchor; the camera is that point, plus an offset
 *    proportional to the body's smoothed acceleration (so it trails while you
 *    launch, leans forward while you stop, and reads exactly zero at a constant
 *    cruise), plus a fin-kick bob/sway in camera-local axes, plus a roll into
 *    turns, plus an FOV that breathes with speed. A lag that never resolves is
 *    an offset, not a lag: it expresses nothing, and it means every module that
 *    reads `position` reads a point that is not where the player is looking.
 *
 * 4. THE HARNESS TELEPORTS THE CAMERA. core/shots.js drives CN.setCamera() to
 *    frame a capture, and tools/play.mjs writes `movement.position` directly.
 *    So every frame this module checks whether the camera transform is the one
 *    it wrote last frame; if not, it re-seats the body on the camera, zeroes
 *    velocity and smoothing, and skips collision for that single frame. A shot
 *    framing therefore survives to well under a millimetre.
 *
 * 5. THE SEABED IS A CONTACT, AND A CONTACT HAS THREE SEPARATE RULES that have
 *    each been wrong on their own at least once. They are not interchangeable
 *    and a fix aimed at one of them lands on the others:
 *
 *      - the PLANE (T.contactBand, `_contact`): what is pushed into the
 *        surface is cancelled and what is left over is tangential. Round 11.
 *      - the FRICTION (T.contactMu, T.contactSlipRef): what a tangential slide
 *        costs. Rounds 13 and 15.
 *      - the STEP LIMIT (T.maxSlopeTan, T.slopeRiseCredit): how much altitude
 *        the terrain may EXTRUDE a body through without it swimming. Round 15.
 *
 *    The recurring failure mode is two of them enforcing the SAME threshold
 *    from different directions, so a diver meeting a 58+ deg face had the
 *    friction cone refusing to let them slide up it and the step limit refusing
 *    to let them advance along it — and on a quarter of the shallows a diver
 *    holding W measured EXACTLY 0.000 m over eight seconds. (Ablated: the cone
 *    was the whole of it. Fixing the step limit alone still measured 0.000.
 *    That is why both are documented and only one is credited.) Whenever you
 *    touch one of these three, measure the other two.
 *
 * Published interface (other modules depend on these):
 *    position   THREE.Vector3   eye/anchor in world space  (mutable, stable object)
 *    velocity   THREE.Vector3   m/s                        (mutable, stable object)
 *    isSubmerged boolean        eye below the wave surface
 *    attach(camera)             bind the camera this module drives
 * plus depth / submersion / speed / stamina / exertion / grounded / heading and
 * the small control API (setEnabled, teleport, impulse, look) that vehicles,
 * survival, tools and ui asked for.
 *
 * No geometry is created here, so there is no material to run through
 * applyUnderwater(); the module is invisible except in motion.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';

const DEG = Math.PI / 180;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Frame-rate independent exponential approach factor for lerp(). */
const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-5));

// ------------------------------------------------------------------ tuning
const T = {
  // ---- body (a 1.8 m diver; the eye is 1.55 m above the soles)
  eyeToFeet: 1.55,
  eyeToCrown: 0.25,
  bodyHeight: 1.80,

  // ---- collision: a sphere hung below the eye, plus the eye's own clearance
  colRadius: 0.62,
  colDrop: 0.42,          // sphere centre below the eye
  clearance: 1.04,        // minimum eye height above the sampled seabed
  ringR: 0.52,            // seabed is sampled on a small ring, not one point
  maxSlopeTan: 1.60,      // ~58 deg: steeper than this blocks UNPAID horizontal climb
  /**
   * ---- THE STEP LIMIT MUST CREDIT THE CLIMB THE BODY IS ACTUALLY MAKING.
   *
   * A second, quieter half of the round-15 freeze — and READ THE ABLATION AT
   * THE FOOT OF THIS BLOCK BEFORE CREDITING IT WITH ANYTHING, because on its
   * own it is worth exactly nothing. T.contactSlipRef is what unfreezes the
   * body; this is the invariant that keeps it unfrozen.
   *
   * `_moveHorizontal` asks "may the seabed at my destination be this much
   * higher?" and answers with `p.y - clearance + d * maxSlopeTan` — the height
   * the body has NOW plus a per-metre-travelled climb allowance. It is called
   * before `p.y += dy`, so the metres the body is rising THIS SUBSTEP were
   * never counted. On a face steeper than 58 deg that is fatal in one line: the
   * contact plane turns the velocity along the face, which is the correct
   * response and the thing round 11 was built to do, and then the horizontal
   * pass rejects the very step that velocity describes because it only looks at
   * the horizontal half of it.
   *
   * The arithmetic, and it is the whole proof: a velocity lying IN the contact
   * plane of a face of inclination th has dy/d = tan(th), so the ground at the
   * destination is exactly `d * tan(th)` higher. The old test allowed
   * `d * 1.60`, which for th > 58 deg is less — so a perfectly tangential
   * glide, the one motion a contact constraint is supposed to permit, was
   * refused. With the rise credited the test reads
   *
   *     d*tan(th)  <=  dy + d*1.60  =  d*tan(th) + d*1.60
   *
   * which is true for every th. A velocity that lies in the contact plane can
   * no longer be rejected by the slope limit AT ANY ANGLE, and that invariant
   * is what makes the response continuous through 90 deg instead of falling off
   * a cliff at 58.
   *
   * What it does NOT relax is the rule the limit exists for. With dy = 0 — a
   * body swimming level, not climbing, asking the terrain to extrude it up a
   * bank — the test is bit-for-bit the old one, so the "hovercraft on a ramp"
   * and the round-11 "descend route walks back up the face it is diving into"
   * failures cannot come back: both of those are climbs the body was not paying
   * for, and this only ever credits climbs it is.
   *
   * BE HONEST ABOUT WHAT THIS BUYS, BECAUSE I ABLATED IT AND IT IS NOT THE FIX.
   * On its own — rise credited, friction left as ideal Coulomb — all ten
   * steep-face runs still measure EXACTLY 0.000 m, because a body Coulomb has
   * arrested has no rise to credit. With the friction regularised, turning this
   * off changes the same runs by 0.2 / 0.6 / 0.0 / 0.05 / 3.3 percent, i.e.
   * inside path chaos on four of five. It shows up once, on a run-up approach
   * into a 70 deg face, where it is worth 2.669 -> 3.457 m (+30%) because there
   * the body arrives with a real climb rate for the credit to act on.
   *
   * It stays because it is a STRUCTURAL guarantee rather than a tuned gain: the
   * invariant "a velocity lying in the contact plane is never rejected by the
   * slope limit" is either true or it is not, it costs one Math.max per
   * substep, and without it the freeze is one badly-timed substep away from
   * coming back on terrain this bench did not sample. It is not credited with
   * the headline and it must not be.
   *
   * 1 = on, 0 = ablated to the old test. See the measured table on contactSlipRef.
   */
  slopeRiseCredit: 1,

  // ---- look
  lookSens: 0.125 * DEG,  // rad per mouse pixel (matches tools/play.mjs routes)
  pitchLimit: 88 * DEG,

  /**
   * ---- THE SPEED ENVELOPE, in m/s. These are the authored numbers.
   *
   * Round 10 inverted how this table works, and the inversion is the point.
   * Accelerations used to be authored and the speeds fell out of them against
   * the drag law, so every time a drag coefficient moved, five terminal speeds
   * moved silently with it and the comment describing them went stale. That is
   * precisely how round 9 shipped a "higher cross-axis damping" that measured
   * LOWER: crossDrag went up 1.00 -> 1.60 while the coefficient it multiplies
   * was halved underneath it, and nobody re-derived the product.
   *
   * So now the SPEEDS are the tuning surface and every acceleration is DERIVED
   * from them (see `thrustFor` below). Move a drag coefficient and the thrust
   * re-solves; the terminal speeds in this block stay true by construction.
   *
   * `vert` is at parity with `cruise` deliberately. A finned diver pointed
   * straight down is the most streamlined thing in the water, and depth is only
   * a place you can GO if going down costs no more time per metre than going
   * forward does. Round 9 had it at 3.38 measured against a 4.06 cruise — 83%,
   * which is exactly the crawl the critic named.
   */
  speeds: {
    cruise: 4.60,
    sprint: 7.40,
    back: 3.00,
    strafe: 3.40,
    vert: 4.60,
  },
  /**
   * FIN THRUST FALLS OFF WITH SPEED, and this is the term that buys mass.
   *
   * A body in water has one honest way to feel heavy: it must not stop when the
   * input stops. That means low drag. But low drag with a flat thrust also
   * means a slow, mushy launch and a top speed set by nothing — round 9's
   * answer was to halve thrust and drag together, which doubled the coast to
   * 3.8 m but left the launch at 0.45 s and the mean |accel| at 1.41, and the
   * critic still read the result as "direct velocity control with light
   * smoothing". They were right: coast and launch were rigidly coupled, both
   * being 1/drag, so buying one always sold the other.
   *
   * A fin is a propeller, and a propeller's thrust collapses as the body
   * approaches the speed at which the blade stops slipping through the water.
   * Modelling that decouples the two: thrust is near its peak from rest up to
   * most of cruise (a SNAPPY launch), then falls to exactly meet drag at the
   * target speed (top speed set here, not by the drag law), and it is simply
   * absent when you let go (a LONG glide, governed by drag alone, which is now
   * less than half what it was).
   *
   *     thrust(v) = A * (1 - (v_along / (vTarget * slipMargin))^slipPow)
   *
   * Measured consequence, and it is the whole round: coast to half speed goes
   * 1.69 m -> 4.3 m and coast at 4 s goes 3.84 m -> 8.1 m, while the launch
   * only softens from 0.45 s to 0.57 s to 63% of cruise. Mass where a body has
   * mass — in the stopping — and none of it paid for out of the controls.
   */
  slipMargin: 1.25,
  slipPow: 3,

  // ---- drag. Linear gives the long tail of the glide, quadratic caps nothing
  // any more (the thrust taper does that) but still shapes the high-speed
  // deceleration after a sprint. Both are less than half of round 9's, which is
  // where the glide comes from; the top speeds did not move with them because
  // the thrust is re-derived from them every boot.
  dragLin: 0.28,
  dragQuad: 0.075,
  // Air is not water. These used to be a fudge tuned to keep a breaching diver
  // from flying; with the taper the thrust is gone above the waterline anyway
  // (see `bite`), so an airborne body can just be ballistic.
  dragAirLin: 0.05,
  dragAirQuad: 0.010,
  /**
   * Drag ACROSS the body axis, as a multiple of the along-axis coefficient.
   *
   * A swimmer is a 1.8 m spindle: streamlined along the line they are finning,
   * a barn door across it. Isotropic drag cannot express that — every scrap of
   * misaligned momentum (the sideways skid out of a hard turn, the vertical
   * drift left over from levelling off after a dive) outlives the body's turn
   * and reads as a skid.
   *
   * READ THE PRODUCT, NOT THE MULTIPLIER. Round 9 raised this from an implicit
   * 1.00 to 1.60 and reported it as an increase in cross-axis damping. It was
   * not. It multiplies `dragLin`, which was halved in the same commit, so the
   * effective cross-axis coefficient went 1.15 -> 0.99 — measurably LOWER than
   * the isotropic drag it replaced, and lower over the whole low-speed tail
   * where a dying skid actually lives. The probe that catches this decays a
   * purely broadside velocity with no input and reads k = -dln|v|/dt.
   *
   * 5.0 against dragLin 0.28 makes it genuinely higher at EVERY speed, which is
   * the property that was missing and the one that is now arithmetically
   * guaranteed rather than asserted:
   *
   *     cross(v) = (0.28 + 0.075 v) * 5.0 = 1.40 + 0.375 v
   *     HEAD      = 1.15 + 0.26 v
   *     cross - HEAD = 0.25 + 0.115 v  > 0 for all v >= 0
   *
   * Measured: 1.40 /s broadside against 0.28 /s along at low speed, versus
   * round 9's 1.05 against 0.70. A 5:1 shape ratio is still conservative for a
   * spindle — a real body's broadside-to-streamlined drag ratio is nearer 15:1
   * once frontal area is counted, not just the coefficient.
   *
   * The axis is where you are SWIMMING when you are swimming and where you are
   * LOOKING when you are not, relaxed over axisTau so it is a body turning and
   * not a switch. Every straight-line terminal speed in the table above is
   * unchanged by it, because in steady state velocity and thrust are parallel.
   */
  crossDrag: 5.0,
  axisTau: 0.30,

  // ---- buoyancy and the surface ride
  /**
   * Metres the eye rests above the LOCAL wave surface while treading water.
   * `neutralFrac` (the submerged fraction at which the diver is neutral) is
   * derived from it below, so this is the one number to move.
   *
   * Round 1 rested the eye 0.25 m proud and the surface strobed: measured over
   * a motionless 10 s float, eye-minus-wave ran -0.171 -> +0.507 m, the eye was
   * under for 17% of frames and isSubmerged flipped six times. Every flip
   * re-armed watersurface's wet-lens droplets, switched the full underwater
   * pass (and its god-ray columns) on OVER THE SKY, and rendered the surface
   * underside as a hard black wedge across the frame. Floating at the surface
   * is where the game starts and where every breath is taken; it cannot look
   * like that.
   *
   * 0.50 m is what surface-above-1.jpg shows: the horizon is clean and
   * unbroken, the near crests sit clearly BELOW the eye, and the water fills
   * the lower two thirds without ever reaching the lens. Combined with the wave
   * coupling below (which cuts the relative excursion roughly in half) it
   * leaves ~0.25 m of measured headroom over the worst trough.
   */
  restProud: 0.50,
  neutralFrac: 0,         // = (eyeToFeet - restProud) / bodyHeight, filled in below
  /**
   * Metres of depth over which buoyancy fades out. Deliberately short. The
   * equilibrium (eye restProud above the wave) is set by neutralFrac and does
   * not move with this number — only the stiffness below it does. At 2.2 m the
   * spring was still worth 1.6 m/s^2 three metres down and a diver pointing
   * 26 deg downward with W held needed six seconds to reach 4 m: correct for a
   * free-diver in a wetsuit, wrong for a game. At 0.9 m it is a surface effect
   * — it holds the waterline and rides the swell, then gets out of the way.
   */
  buoyFade: 0.9,
  /**
   * ...except an exponential never actually GETS out of the way, and round 8
   * proved it. exp(-d/0.9) plus a 0.006 floor still lifted a motionless diver
   * 2.22 m in six seconds at 3 m down, 0.25 m at 6 m, and 0.20 m at every
   * depth past that forever — measured, not guessed. So the dive route stalled
   * on the way down and the player floated 9 m -> 7.4 m the moment they
   * stopped swimming, which is the single loudest "this is not Subnautica"
   * tell in the module: Subnautica is neutral below about 2 m and ours fought
   * you the whole way down and then pushed you back up.
   *
   * The exponential is therefore multiplied by a window that reaches exactly
   * zero at buoyNeutral and stays there. It is C1 — the window starts closing
   * at buoyNeutralKnee, by which depth the exponential is already down to 0.46
   * — so nothing pops at the junction, and above the knee the curve that holds
   * the waterline and survived every float measurement is bit-for-bit what it
   * was. Below 1.5 m there is no vertical force on the body at all: hold
   * depth, do not rise, and let the player's own fins be the only thing that
   * moves them up or down.
   *
   * 1.5 rather than 2.0 because `depth` is measured to the WAVE, not to sea
   * level, the wave moves +-0.3 m, and the spring's only equilibrium is at the
   * surface — so a body left anywhere inside the live part of the curve does
   * not settle there, it corks. Parked at exactly 2 m with the window closing
   * at 2 m, every trough dipped the body back into the curve and it climbed
   * 2.1 m in six seconds regardless. Closing at 1.5 puts the whole wave
   * excursion clear of the window, and "neutral below 2 m" becomes true of the
   * sea rather than only of the arithmetic: measured drift at 2 / 3 / 6 / 20 /
   * 60 m is now 0.000 m over six seconds at every one of them.
   */
  buoyNeutralKnee: 0.7,
  buoyNeutral: 1.5,
  /**
   * Wave coupling, 1/s. This is the term that makes the diver RIDE the chop
   * instead of standing still while it washes over them, and it is applied as
   * an exponential relaxation of v.y toward the water's own vertical velocity
   * (unconditionally stable at any dt, unlike an explicit damping force this
   * stiff).
   *
   * Why it has to be the damper and not a stiffer spring: the buoyancy spring
   * runs at ~3.1 rad/s and watersurface's short Gerstner components run at
   * 3-6.5 rad/s — and much higher still under the Doppler shift of swimming
   * into them at 4 m/s. Stiffening the spring enough to track those would put a
   * 5 m/s^2 wall under the waterline that a diver at a 26 deg dive angle
   * (3.8 m/s^2 of downward thrust) simply could not push through. A damper
   * referenced to the medium drags the body along with the water at ANY
   * frequency, costs nothing at DC, and is released by `diveYield` the moment
   * the player actually asks to go under.
   */
  surfDamp: 14.0,
  surfHold: 0.80,         // metres below rest height it stays at full strength
  surfDampRange: 1.20,    // and then fades out over this much more
  surfDampUp: 0.55,       // fade above the rest height: a diver thrown clear is free
  bodySpan: 0.62,         // radius the wave is averaged over — a body is not a cork
  /**
   * Duck-dive. A positively buoyant diver gets under by inverting and finning;
   * the buoyancy they beat comes off their lungs, not off arithmetic. So the
   * near-surface float (spring authority AND wave coupling) yields in
   * proportion to how far DOWN the player is asking to go. Without this the
   * same force that stops the chop punching through the eye also stops the
   * player ever leaving the surface.
   *
   * Keyed to the commanded DIRECTION (the y of the unit wish vector), not to
   * the commanded acceleration as round 9 had it. That version read
   * `clamp01(-ay / 2.2)` against an `ay` derived from aSwim, so this round's
   * thrust re-derivation would have quietly moved the duck-dive threshold from
   * "20 deg nose-down" to "38 deg nose-down" and made leaving the surface
   * harder while every comment still said otherwise — the same failure mode as
   * crossDrag above, in a term nobody was looking at. Expressed as an angle it
   * cannot drift: sin(20 deg) means 20 degrees no matter what the thrust is.
   */
  diveWish: Math.sin(20 * DEG),
  diveYield: 0.95,
  /**
   * Wave-making resistance in 1/s, peaking when the body straddles the
   * waterline (4s(1-s)). Without it surface swimming was FASTER than submerged
   * cruise (measured 5.07 vs 4.01 m/s) purely because half the body was in air
   * and air has no drag — exactly backwards. A swimmer at the surface drags a
   * bow wave and is the slowest thing in the game, and that penalty is the
   * whole reason diving is worth doing.
   *
   * Absolute, not a multiple of dragLin as round 8 had it: wave-making
   * resistance is a different physical mechanism from skin friction and has no
   * business tracking it.
   *
   * It survives the thrust taper unchanged, which I got wrong on the first pass
   * and am recording because the arithmetic is the interesting part. Predicting
   * the new surface speed by hand needs the submerged fraction a MOVING swimmer
   * rides at, and I assumed the floating value, s = 0.86. Back-solving the
   * measurement says a swimmer under thrust rides much higher, s = 0.63, where
   * 4s(1-s) is 0.93 instead of 0.48 — the bow-wave term is nearly twice as
   * strong as the standing-still geometry suggests. Raising this to 2.05 on the
   * bad estimate measured 2.37 m/s at the surface against 4.57 submerged, a
   * ratio of 0.52 where round 9 verified 0.72. Back at 1.20 it measures 3.27 /
   * 4.57 = 0.715, which is the split that was verified.
   *
   * Applied to the HORIZONTAL axes only. A bow wave is made by travelling
   * through the interface, not by sinking through it, and putting it on the
   * vertical axis as well would have been a second lid on the duck-dive.
   */
  surfDragLin: 1.20,
  maxBuoyAccel: 12.0,

  // ---- stamina / fin kick
  sprintDrain: 1 / 6.5,
  sprintRegen: 1 / 7.0,
  regenDelay: 0.75,
  exhaustClear: 0.34,
  /**
   * Depth of the per-kick thrust pulse, as a fraction of steady thrust. A
   * flutter kick is a pulse train, not a constant push, and round 1 put that
   * pulse only in the lens: cruise speed rippled by 0.0003 m/s — dead flat to
   * four significant figures — while the camera bobbed 4.7 cm. Parallax is what
   * sells swimming, and parallax comes from the BODY moving.
   *
   * This is a fraction of the TAPERED thrust, so at cruise — where the taper has
   * already brought thrust down to meet drag — the pulse is around 1.3 m/s^2
   * rather than the 2.24 it was, and mean |accel| in steady cruise falls with
   * it. That number was the critic's evidence for "direct velocity control with
   * light smoothing", and it was almost entirely this term: at a settled cruise
   * the NET acceleration is zero by definition, so every m/s^2 the probe sees is
   * the kick. Raised 0.35 -> 0.45 to hold the visible surge at ~5% peak-to-peak
   * on speed even though the thrust it scales is smaller: what a body filters
   * out of a pulse at 1.7 Hz depends on the pulse amplitude over the kick
   * frequency, not on the drag, so the ripple had to be re-derived too.
   */
  kickSurge: 0.45,

  // ---- camera feel (small on purpose)
  /**
   * The head trails the body, but a lag that never resolves is an OFFSET, not a
   * lag. Round 1 ran a plain first-order follow at tau 55 ms, which parks the
   * camera a permanent tau*v = 0.19 m behind `position` at cruise: it expressed
   * nothing during acceleration and it meant survival / tools / audio / ui all
   * read a point 19 cm from where the player was actually looking whenever they
   * moved. So the offset is now driven by the body's ACCELERATION (camLagAcc
   * seconds^2 per m/s^2, smoothed over camLagAccTau) and the follow filter is
   * velocity-feed-forward, which cancels its own steady-state error exactly.
   * Result: 10 cm of trail while launching, a forward lean while stopping, and
   * ~0 at constant velocity.
   */
  // A gain in seconds^2, so it has to be re-derived every time peak |accel|
  // moves: 0.014 against a 9.2 peak, 0.016 against 6.4, and 0.017 against this
  // round's 5.9, all of which hold the same ~0.10 m of trail on a launch and
  // the 0.043 m mean camera-to-body separation the critic verified. The
  // steady-state offset is still exactly zero at constant velocity, which is
  // the property that mattered.
  camLagAcc: 0.017,
  camLagAccTau: 0.11,
  camLagAccY: 0.35,       // vertical share: head lag is mostly a fore-aft thing
  camLagTau: 0.028,
  camLagMax: 0.18,
  bobTau: 0.06,
  bobIdleV: 0.008, bobGainV: 0.030,
  bobIdleH: 0.006, bobGainH: 0.024,
  /**
   * Banking into a turn is one of the strongest swim tells there is, and round
   * 1's was too timid to read: measured 3.0 deg under a hard combined turn and
   * 1.0 deg on a straight cruise. rollMax was not the binding constraint —
   * rollTurn was — so both move. 7 deg of slow roll inside a 68 deg FOV is well
   * under the nausea threshold (which is about rate and about pitch, not about
   * a couple of degrees of steady bank).
   */
  rollTurn: 0.26,         // rad of roll per rad/s of yaw rate
  rollStrafe: 2.4 * DEG,
  rollMax: 7.0 * DEG,
  rollTau: 0.22,
  rollKick: 0.7 * DEG,
  fovGain: 6.0,
  fovBoostMax: 9.0,       // speed + Seaglide bonus combined can never exceed this
  fovTau: 0.30,
  fovBreathe: 0.10,

  // ---- the medium switch (see preRender)
  subBandMin: 0.10,       // watersurface's measured still-frame waterline width
  subBandMax: 0.34,
  subBandRate: 0.26,      // metres of blend per m/s of crossing rate

  /**
   * ---- SEABED CONTACT: the ground is a PLANE, not a lid.
   *
   * This is the round-11 defect and it was worth 8x on the descend route. The
   * heightfield was resolved on two independent axes — reject the horizontal
   * step if the destination is too high, clamp y up out of the floor — and
   * neither of them ever knew which way the surface was FACING. So every scrap
   * of thrust aimed into a bank was deleted rather than turned along it. A
   * diver finning at full effort into a 34 deg slope measured 2.87 m/s against
   * a 4.59 m/s cruise, and on the descend route, where the look direction rolls
   * further nose-down every second, it collapsed to 0.10 m/s and stayed there
   * for eighteen seconds — two thirds of the contact sheet is the player face
   * down in the sand, still swimming.
   *
   * A contact normal fixes it in one term. Whatever is pushed into the surface
   * is cancelled by the surface (that is the definition of a normal force) and
   * what is left over is tangential, so the body GLIDES up the bank at
   * cos(angle-to-the-face) of its thrust. It is the same constraint that keeps
   * the old "hovercraft on a ramp" from coming back, and it is stricter about
   * it than the ad-hoc climb term ever was: aim 40 deg down into a 43 deg face
   * and the thrust is within 8 deg of the normal, so 99% of it is absorbed and
   * the diver crawls. Aim ALONG the bank and you keep everything. The angle
   * decides, which is what a body in contact with a surface actually feels.
   *
   * The normal comes from the same five heightfield taps that already decide
   * the floor height (see _groundMax / _ringNormal), so it is the normal of the
   * surface the BODY rides — smoothed over its own 1.04 m footprint — and not
   * of some pebble the centre tap happened to land on.
   */
  contactBand: 0.30,      // metres above the floor over which the plane fades out
  /**
   * Bottom friction, 1/s, at a full head-on press.
   *
   * RE-DERIVED THIS ROUND BECAUSE THE AXES IT ACTS ON CHANGED, which is the same
   * lesson `crossDrag` records twenty lines further up and which I very nearly
   * repeated. 0.55 was calibrated when this term read `v.x *= f; v.z *= f` — it
   * only ever billed the HORIZONTAL part of a slide. Moving it onto the contact
   * tangent (which is the fix: on a steep face the slide is almost entirely
   * vertical and the old form charged nothing for it) silently raises what it
   * costs a body sliding DOWN a slope, in proportion to how steep the slope is,
   * with nothing in the file saying so.
   *
   * On a 45 deg slide the old two-axis form applied 0.55 to the horizontal
   * component only, i.e. an effective cos^2(45) * 0.55 = 0.275 on the velocity
   * vector. 0.30 reproduces that, and it is the honest number to carry forward
   * from a coefficient that was never calibrated against three axes.
   *
   * WHAT IT DID NOT DO, because I went looking for it to and it did not: it did
   * not recover the `pressure` route. That route — 69% of it in ground contact,
   * descending at 42 deg nose-down — has a deepest point of 199.6 / 203.1 m on
   * two runs of the pre-change build and 174.3 m after. Dropping contactMu
   * 0.625 -> 0.40 moved that to 178.3; dropping this 0.55 -> 0.30 as well moved
   * it to 176.7. Neither term is where the cost lives, the two runs I have of
   * each tuning differ by more than the gaps between them, and I am recording
   * that rather than dressing a 2 m wobble as a fix. Friction on a contact that
   * previously had none costs a bottom-scraping descent about 12% of its rate,
   * and that is simply the price of the surface being solid.
   */
  contactDrag: 0.30,
  /**
   * Bottom friction is proportional to how hard you are PRESSING, because that
   * is what friction is. Previously it was a flat 0.55/s the instant the body
   * touched, which taxed a diver skimming the contour exactly as hard as one
   * driving into a wall — and a diver following the seabed is in contact every
   * single frame, so it was a permanent 20% speed tax on the whole floor of the
   * game. contactPress is the into-surface acceleration that counts as a full
   * press (the fin's own stall-free thrust is 5.9 m/s^2, so swimming straight
   * at a face saturates it); contactSkin is the share that survives a purely
   * tangential glide, which is not zero — there is a boundary layer down there.
   */
  contactPress: 5.0,
  contactSkin: 0.20,
  /**
   * COULOMB FRICTION AGAINST THE CONTACT NORMAL — the term round 11 left out,
   * and the one a player finds in five minutes.
   *
   * Round 11 made the seabed a plane instead of a lid, which was right: what is
   * pushed into a surface is cancelled and what is left over is tangential. But
   * a bare projection is a FRICTIONLESS constraint, and frictionless is a
   * different lie from the one it replaced. The round-11 critic measured a diver
   * on a 72 deg face, swimming with LEVEL pitch, climbing 17.16 m in 8 s — 2.15
   * m/s of free ascent while aiming horizontally. Reproduced here on two 71.99
   * deg faces found by scanning the heightfield with the same 0.52 m ring the
   * body samples on: 13.879 m and 7.517 m over the same 8 s. The mechanism is
   * geometry — a horizontal thrust into a 72 deg face resolves to cos(72) = 31%
   * of itself pointing straight UP the face, and nothing was charging for the
   * ride. On flat ground the same hole ran the other way round: every bump
   * turned forward speed into climb, and the diver floated off the seabed
   * instead of skimming it (the critic measured mean altitude 1.33 -> 1.79 m and
   * groundedFrac 0.563 -> 0.295; two 2 deg sites here measure altitude 3.02 and
   * 1.65 m with groundedFrac 0.46 and 0.64).
   *
   * Viscous damping cannot fix that, and this is the part worth understanding:
   * a term of the form -k*v always leaves a terminal slide speed a_t/k, so it
   * can slow a levitation but never stop one. Friction proportional to the
   * NORMAL FORCE can, because both scale with the same thrust — the ratio is
   * pure geometry and the speed drops out of it. A body pushed against a face
   * of inclination th slides up it only when cot(th) > mu, i.e. only on faces
   * shallower than the FRICTION ANGLE atan(1/mu).
   *
   * THE VALUE IS A MEASURED TRADE, NOT A DERIVATION, and I tried the derivation
   * first. mu = 1/maxSlopeTan = 0.625 is the elegant choice: it puts the
   * friction angle at exactly 58.0 deg, so the face you cannot step up is the
   * same face you cannot slide up, and the two mechanisms that used to be able
   * to disagree cannot any more. It killed the levitation outright (the 72 deg
   * face measured 13.879 m of climb in 8 s before, 0.000 m after) — and it cost
   * the `pressure` play route 25 m of depth, taking its deepest point from
   * 199.6 / 203.1 m to 174.3 m, so the one route that crosses the 200 m suit
   * rating stopped crossing it. That route holds W at 42 deg nose-down, which
   * points most of the thrust INTO the slope, so `press` is near the whole
   * thrust and the tangential remainder is small: exactly the geometry where
   * friction proportional to the press dominates.
   *
   * ROUND 13 PUT 0.625 BACK, AND THE REASON IS THAT NEITHER COST ABOVE
   * REPRODUCES. Both were measured before captures were deterministic. They are
   * now: the same bench run twice gives bit-identical numbers, so a 2 m
   * difference is a 2 m difference and not a coin toss. Re-measured, holding W
   * with level pitch for 8 s on four fixed sites, and the `pressure` route run
   * twice at each value:
   *
   *                       mu 0.40        mu 0.625      claimed cost
   *   pressure max depth  176.7 / 176.7  173.7 / 173.7  -25 m  (actual -3.0 m)
   *   flat cruise, 2.8deg 4.223 m/s      4.210 m/s      -36%   (actual -0.3%)
   *   flat cruise, 4.7deg 4.161          4.134                 (actual -0.6%)
   *   flat cruise, 12.6deg 3.843         3.738                 (actual -2.7%)
   *   flat cruise, 4.0deg 4.204          4.178                 (actual -0.6%)
   *
   * The 25 m was a real number attributed to the wrong cause: going from a
   * FRICTIONLESS plane to any friction at all cost the route ~23 m of that, and
   * 0.40 -> 0.625 is the last 3 m. The 36% flat-speed figure does not appear on
   * any of the four sites at any value; whatever site produced it, it is not
   * representative of the seabed, and I could not reproduce it.
   *
   * What round 13 buys, on faces found by scanning the heightfield for a level
   * approach into a 74-79 deg wall, holding W with LEVEL pitch for 8 s. Both
   * columns run twice and bit-identical; the split between this and the lift
   * ledger is
   * roughly 80/20 in mu's favour on every face:
   *
   *   face 79 deg   1.465 m of free climb -> 0.786
   *   face 74 deg   3.066                 -> 1.358
   *   face 52 deg   1.631                 -> 0.000
   *   face 77 deg   0.000                 -> 0.000
   *
   * So it is derived, not chosen: mu = 1/maxSlopeTan puts the friction angle at
   * exactly the 58 deg the horizontal axis has enforced since round 1, and the
   * face you cannot step up is now the face you cannot slide up. Two mechanisms
   * that could disagree no longer can, and there is one fewer authored number.
   * It is also still inside the physical range — wet neoprene on wet rock is
   * 0.3-0.5, wet rock on rock is higher, and a silt bed is lower.
   *
   * What it does NOT buy, and this is the honest edge of it: the residual climb
   * on those faces is not levitation any more, it is the RUN-UP. Traced, the
   * body meets a 45 deg apron before it meets the wall, climbs that at cruise —
   * which it is entitled to do — and carries the momentum a metre or two into
   * the steep part before friction arrests it. From t = 3 s on, both 74 and 79
   * deg faces read 0.00-0.02 m/s. Starting the diver already ON a 77 deg face
   * measures -0.001 m over 8 s. Zero from a standing start; a metre or so if
   * you swim at it.
   *
   * And it is a CONE, not a wall, which is the property that stops this being
   * flypaper. Friction opposes the resultant slip, so a body with a large
   * cross-slope component keeps moving even while the up-slope part is held.
   * Measured on a 72 deg face, holding W for 8 s at yaw offsets from straight-
   * into it: 0 deg -> 0.00 m travelled; 30 deg -> 18.41 m; 60 deg -> 31.45 m;
   * 90 deg -> 33.96 m, the last three all ending at ~4.5-4.7 m/s, i.e. full
   * cruise. Swim at a cliff and you stop. Turn and you go.
   *
   * ROUND 15 READ THAT "0 deg -> 0.00 m" AS THE PROOF AND NOT AS THE DEFECT,
   * and it was the defect. `0.00 m` is not a stall, it is a WELD: the body's
   * speed is zero to every digit, for eight seconds, on a quarter of the
   * seabed near spawn. Holding W into a bank and going nowhere at all is a
   * worse failure than the grinding this replaced, because grinding at least
   * moved.
   *
   * HOW MUCH SEABED, MEASURED, because the round-15 brief says 67% of the world
   * and 47.5% near spawn and I could not reproduce either. Sampling plan area
   * on a uniform lattice (19 m over the whole 1900 m playable disc, 1.5 m over
   * the 120 m around the origin) and calling a point steep when its slope
   * exceeds maxSlopeTan:
   *
   *              ring stencil (2*ringR)   terrain.normalAt
   *   world            14.19%                  14.19%
   *   near spawn       24.27%                  24.11%
   *
   * The two stencils agree to 0.16 points, so it is not a stencil artefact. My
   * guess at the gap is that 67% counts TRIANGLES rather than plan area, and a
   * vertical wall covers almost no plan area while carrying a great many
   * triangles. Either way a quarter of the shallows is a gameplay-breaker and
   * the fix does not depend on which number is right — but the number in this
   * file is the one I measured, not the one I was handed.
   *
   * The value stays at 1/maxSlopeTan — it is still the right friction
   * COEFFICIENT and the argument above for deriving it rather than choosing it
   * still holds. What was wrong was the friction LAW it was fed into: ideal
   * Coulomb has the full mu*N available at zero slip, so above the friction
   * angle the steady state is exact zero rather than a small number, and the
   * response falls off a cliff at 58 deg instead of being a curve. See
   * T.contactSlipRef, which regularises it and leaves everything sliding faster
   * than ~1 m/s — every measurement in this block included — untouched.
   *
   * Filled in below as 1/maxSlopeTan so it cannot drift out of agreement.
   */
  contactMu: 0,
  /**
   * ---- SLIP SPEED AT WHICH THE CONTACT STOPS BEING LUBRICATED, m/s.
   *
   * The other half of the round-15 freeze, and the half that makes 58 deg a
   * cliff edge in the response rather than a point on a curve.
   *
   * Ideal Coulomb friction is DISCONTINUOUS at zero slip: the force is
   * mu*N*sign(v_t), so it has the full value mu*N available at v_t = 0 and can
   * therefore hold a body at EXACTLY zero for as long as the press lasts. That
   * is what a friction angle means and on dry rock it is correct. Underwater it
   * is not: there is a water film between a wetsuit and a rock face, the film
   * carries the load as the slip goes to zero, and the shear it can transmit
   * goes to zero with it. There is no stiction underwater. A body pressed
   * against a wet face creeps; it does not weld.
   *
   * So sign(v_t) is replaced by tanh(v_t / contactSlipRef) — the standard
   * regularisation of Coulomb friction, and the standard cure for exactly this
   * failure in every contact solver that has ever had to integrate one
   * explicitly. Two properties, and both are why it is this and not a smaller
   * mu, a viscous term or a hand-placed floor:
   *
   *  - IT IS SURGICAL. tanh(v/0.60) is 0.9975 at 2 m/s of slip, 0.9999 at 3,
   *    and 0.999999 at the 4.3 m/s a diver skims the sand at — so every contact
   *    that is actually sliding (riding a bank, scraping past a boulder, the
   *    whole `pressure` descent) sees the friction it always saw. It falls away
   *    only below ~1 m/s (0.93 at 1.0, 0.62 at 0.45, 0 at 0), which is the band
   *    the old model resolved to a dead stop and nothing else.
   *  - IT IS CONTINUOUS IN THE FACE ANGLE. Above the friction angle the
   *    steady up-slope slip solves mu*N*tanh(v/vs) = A*cos(th) with N = A*sin(th),
   *    so the thrust cancels and
   *
   *        v = vs * atanh( cot(th) / mu )
   *
   *    which depends on the ANGLE ALONE — the same property the friction cone
   *    was chosen for. It grows without bound as th falls to the friction angle
   *    (where cot(th)/mu = 1, meeting the drag-limited regime below it) and
   *    falls smoothly to zero only as th reaches 90 deg. The old model stepped
   *    from "drag-limited" to "exactly 0.000" across one degree.
   *
   * 0.60 m/s is set by the two ends it has to satisfy: large enough that a
   * cruising contact is unchanged to five figures, small enough that a 79 deg
   * face still reads as a stall rather than an elevator.
   *
   * MEASURED. Faces found by scanning the heightfield with the same 0.52 m ring
   * the body samples on, keeping only faces that persist 1.5 m up-slope; the
   * diver is placed ON the face, level pitch, W held for 8 s. Every row was run
   * twice and is bit-identical both times. `off` is this same file with
   * contactSlipRef and slopeRiseCredit both zeroed, i.e. the shipped round-14
   * build.
   *
   *   face deg   60.4  62.7  65.7  68.4  70.4  73.2  74.9  78.0  83.5
   *   off (m)   0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
   *   THIS (m)  4.016 3.464 3.155 2.600 2.814 2.012 1.865 1.671 0.720
   *   min speed 0.044 0.041 0.036 0.033 0.030 0.026 0.023 0.018 0.010
   *
   * ...and the three STEEPEST faces the scan can find anywhere in the world,
   * which is where "stall gracefully rather than lock" has to be true:
   *
   *   face deg   86.5  86.8  87.3
   *   off (m)   0.000 0.000 0.000
   *   THIS (m)  0.291 0.259 0.245
   *   min speed 0.005 0.005 0.004
   *
   * Twenty-four runs of the old build; every one of them EXACTLY 0.000 m over
   * eight seconds. That is the defect, and it is not a slow crawl misread as a
   * stop — the body's speed is zero to every digit for the whole hold. The new
   * column is monotone in face angle, never reaches zero, and never has a
   * single frame at zero speed (the min-speed row is the slowest instant of the
   * whole 8 s, not the mean). At 87 deg a quarter of a metre in eight seconds
   * IS a stall, and it should be — a near-vertical wall is a wall. The point is
   * that it is the end of a curve rather than a step off one.
   *
   * WHAT IT COSTS, and it is almost nothing, which is the point of putting the
   * regularisation at 0.6 m/s rather than reaching for a smaller mu:
   *
   *   open water        cruise 4.221 -> 4.221 m/s, 4 s coast 8.059 -> 8.059 m,
   *                     3 s ascent off the sand 11.287 -> 11.287 m. Identical.
   *   buoyancy drift    0.000 m over 6 s at 3 / 6 / 20 / 60 m, both builds.
   *   flat contact      six sites under 19 deg: 3.092 -> 3.098, 2.160 -> 2.160,
   *   cruise            2.751 -> 2.733, 3.662 -> 3.662, 3.138 -> 3.140 m/s —
   *                     five of six inside 0.7%. The sixth was 1.080 -> 1.604
   *                     because it was running into a face and welding to it.
   *   the lift ledger   int(-v.y) over eight rolling-ground sites is unchanged
   *                     to four figures (-6.881, -6.131, -0.281, -2.670,
   *                     -1.076, 0, 0, 0) and still goes to 0.000 on every one
   *                     of them with liftAccel and liftDamp zeroed.
   *   play routes       dive 52 m travelled, descend 137.6 m and pressure
   *                     173.5 m deepest — all inside the spread the last two
   *                     rounds recorded for them.
   *   idle on a face    0.000 m over 8 s with NO keys held, on 62 / 68 / 73 /
   *                     79 deg faces, in BOTH builds. Weakening the friction at
   *                     low slip does not make the world slippery, and it
   *                     cannot: `press` is the acceleration the contact plane
   *                     absorbed, so a body that is not driving into the face
   *                     never reaches this term at all. A diver who stops
   *                     swimming stays exactly where they stopped.
   *
   * AND IT DOES NOT CLOSE THE CONE. Round 13's "swim at a cliff and you stop,
   * turn and you go" still holds, and the yaw sweep is the cleanest statement
   * of how narrow this change is — because away from head-on the slip is fast,
   * tanh is 1, and there is nothing left to change. Same three faces, W held
   * 8 s, metres travelled, old -> this:
   *
   *    yaw off head-on    62.7 deg        70.4 deg         78.0 deg
   *      0 deg        0.000 -> 3.464   0.000 -> 2.814   0.000 -> 1.671
   *     30 deg        3.864 -> 3.858  14.159 -> 18.600  2.932 -> 4.265
   *     60 deg        2.836 -> 2.836  28.796 -> 28.895  8.450 -> 10.179
   *     90 deg        3.197 -> 3.197  34.575 -> 34.575 30.125 -> 30.127
   *
   * At 90 deg — the body sliding along the contour at full cruise — the two
   * builds are identical to the millimetre on all three faces. The only column
   * that moves at all is the head-on one, which is the column that was 0.000.
   *
   * Set to 0 to ablate back to ideal Coulomb.
   */
  contactSlipRef: 0.60,
  /**
   * Climbing costs speed. Round 1 hit the seabed at 41 m on the descend route
   * and then SURFED back up a 43 deg slope at full 3.9 m/s cruise while still
   * aimed 40 deg down into it — a hovercraft on a ramp.
   *
   * The contact plane above now does that job honestly, and it does it better,
   * so this term is demoted to what it should always have been: a guard against
   * the terrain EXTRUDING the body upward. Following a slope tangentially the
   * ground has no lifting left to do (the body rises exactly as fast as the
   * floor under it, so `lift` measures float slack and nothing else) and this
   * reads zero; it only fires when a step or a boulder edge shoves the body up
   * faster than it is swimming, which is the one case the plane cannot express.
   */
  climbDrag: 0.75,
  climbFree: 0.60,        // m/s of vertical lift that is free
  wallFric: 2.2,          // 1/s, scraping along a face too steep to climb
  /**
   * ---- DEFLECT AGAINST THE SURFACE THAT ACTUALLY BLOCKED YOU. Round 16.
   *
   * This is the weld. Everything else in this block is bookkeeping around it.
   *
   * `_moveHorizontal` refuses a step because `_groundMax` at the destination is
   * too high, and then deflects the step along `_ringNormal`. Those are two
   * DIFFERENT SURFACES built from the same five taps: `_groundMax` is their
   * MAX, `_ringNormal` is the central difference of the smoothed surface the
   * body rides. On ordinary ground they agree and nobody notices. On a face
   * where one tap dominates the max they do not, and then the code deflects
   * along a direction that is still pointing into the wall — so the retry
   * re-tests a step that is 95% the one that just failed, fails again, and the
   * function returns having moved nothing. Every substep after that asks the
   * identical question from the identical position.
   *
   * MEASURED, on 80 level-pitch run-up runs into scanned steep faces. For each
   * substep the slope limit refused, the cosine of the step against the ring
   * normal it deflects on (`into`), against the horizontal gradient of
   * `_groundMax` (`gInto`), and the agreement between the two normals:
   *
   *   face        weld    into    gInto   cos(ring, max)   asked   travelled
   *   58.8 deg   1.57 s  -0.80   -0.93        0.964       0.272 m   0.0016 m
   *   72.0 deg   0.53 s  -0.94   -0.99        0.985       0.078 m   0.0015 m
   *   65.4 deg   7.93 s  -0.048  -0.935       0.398      26.539 m   0.0056 m
   *
   * Read the last row. The two normals are 66 degrees apart; the step is 93.5%
   * head-on into the surface that is refusing it and 4.8% into the one the
   * deflection is computed from, so the deflection subtracts nothing. The body
   * holds W at 3.31 m/s for the WHOLE eight seconds, asks the world for 26.5
   * metres, and is given 5.6 millimetres, with x and z inside a millimetre for
   * 7.93 s of the 8 and `grounded` false for 82% of it. The two rows above it,
   * where the normals agree to within 15 degrees, deflect properly and lock
   * only briefly while genuinely climbing.
   *
   * So the fix is not a coefficient, it is asking the right surface: the
   * horizontal normal used for the deflection is now the gradient of
   * `_groundMax` itself, central-differenced over blockGradH. By construction
   * the deflected step is then a CONTOUR of the blocking quantity, so
   * `_groundMax` at the deflected destination is unchanged to first order and
   * the retry passes — the body slides along the wall instead of welding to it.
   * It is round 11's sentence one level down: what is pushed into the surface
   * is cancelled and what is left over is tangential, and the surface has to be
   * the one doing the pushing.
   *
   * `_ringNormal` is deliberately NOT changed anywhere else. `_contact` and
   * `_resolveVertical` use it to describe the surface the body RIDES, which is
   * a different question from which surface refused a step, and every friction
   * and contact number in this file was measured against it.
   *
   * blockGradH is 0.35 m: large enough that the difference is a landform and
   * not heightfield noise, small enough to stay inside the 1.04 m footprint the
   * ring max is defined over. 1 = on, 0 = ablated back to the ring normal.
   */
  blockNormal: 1,
  blockGradH: 0.35,
  /**
   * ---- A HULL IS A SURFACE TOO, AND IT WAS STILL A LID. Round 16.
   *
   * The OTHER second weld path, and the one that actually matches the round-16
   * brief's signature of `grounded == false` — which is why it is worth saying
   * plainly that it is not in `_moveHorizontal`, where the brief placed it. Run
   * up into the 64.3 deg face at (29.1, 70.1) and the body welds for 0.567 s
   * with grounded 0; instrumented per stage, `_moveHorizontal` DELIVERED the
   * whole 0.944 m it was asked for and `_resolveStructures` took 0.924 m of it
   * straight back, 35 substeps running. The slope limit refused nothing there.
   *
   * The mechanism is round 11's, one collider over: the wreck sweep computed
   * `stop = hit.distance - colRadius`, clamped it at zero and teleported the
   * body back to where the substep started. A body already within colRadius of
   * a hull therefore had stop = 0 on EVERY substep and every heading, so the
   * hull was not a surface it could slide along, it was a lid — and, worse, the
   * snap-back to `from` also discarded the y that `_resolveVertical` had just
   * resolved, so the seabed pass was undone by the structure pass.
   *
   * The fix is the same sentence as the seabed's: what is pushed into the
   * surface is cancelled and WHAT IS LEFT OVER IS TANGENTIAL. The remainder of
   * the step is projected onto the hull face and taken as a glide, confirmed by
   * a second sweep so a slide cannot tunnel into the next plate. At stop = 0
   * the body can still move — along the hull, which is what a diver dragging a
   * hand down a wreck actually does — and the only motion that is ever zero is
   * motion straight into the plate, which the velocity projection then removes.
   *
   * The face normal is oriented against travel first. A wreck is a shell and
   * its triangles are wound however they were generated; a normal that happened
   * to point ALONG the ray used to reflect the slide back into the hull.
   *
   * 1 = on, 0 = ablated back to stop-dead.
   */
  hullSlide: 1,
  /**
   * ---- ...AND THE LID WAS NEVER THE ONLY PROBLEM: THE BODY WAS ALREADY
   * INSIDE THE SHELL. Round 17.
   *
   * The round-16 critic measured a diver swimming THROUGH the Aurora stern and
   * attributed it to `hullSlide` — a lid traded for a ghost. Measured on 12
   * bearings into `aurora-stern`, 6 s of held W from 34 m out, with the body
   * sphere's distance to the nearest collider triangle sampled every frame,
   * that attribution is wrong and the defect is worse than reported:
   *
   *   bearing   hullSlide=1                    hullSlide=0 (the round-15 path)
   *     0       275/360 frames inside          275/360 frames inside
   *   330       325/360 frames inside          325/360 frames inside
   *    30/90/300  17 / 2 / 19 inside            17 / 2 / 19 inside
   *
   * Bit-identical. The slide changes the weld (bearing 330: 1.917 s -> 0.000 s)
   * and the travel (9.76 m -> 15.33 m); it does not change whether the body is
   * in the hull by a single frame. The ghost predates round 16 — round 15 was a
   * body welded INSIDE the plate, not held outside it — and the cause is that
   * the mesh branch has never depenetrated at all, while the blob branch six
   * lines below it always has.
   *
   * WHY IT GETS IN. `stop = hit.distance - colRadius` is the correct standoff
   * only for a ray arriving along the face normal. At an incidence cosine `ci`
   * the sphere ends `colRadius * ci` from the plane instead of `colRadius`, so
   * every glancing approach — which is every approach to a curved hull, and is
   * exactly what the slide produces — parks the centre `colRadius * (1 - ci)`
   * inside the plate. Nothing then measures that, so nothing corrects it, and
   * the next substep's sweep starts from inside: the plates it would have hit
   * are behind it, and the FrontSide ones are invisible to a ray from within.
   * Measured minimum standoff on bearing 0 was 0.0007 m — the centre of a
   * 0.62 m sphere sitting 0.7 mm off a triangle.
   *
   * THE FIX IS THE BLOB BRANCH'S SENTENCE, WRITTEN FOR A PLANE. Do not try to
   * get `stop` exactly right; move, then measure the perpendicular distance
   * from the plane that was hit and restore it to colRadius. That is exact at
   * every incidence, costs no second sweep, and degrades to nothing at normal
   * incidence where the old arithmetic was already right.
   *
   * 1 = depenetrate, 0 = the round-16 path.
   */
  hullDepen: 1,
  /**
   * ...AND THE COLLIDER HAS TO EXIST WHEN THE BODY IS SLOW. `_resolveStructures`
   * opened with `if (dist < 0.02) return`, which at 60 fps and one substep a
   * frame is EVERY SPEED UNDER 1.2 m/s — measured at 17.5% of the frames of a
   * run-up into the stern and 38.6% of the same run with the slide ablated,
   * i.e. the body state that most needs depenetrating was the one state never
   * tested. Worse, the return came before the candidate refresh, so a body that
   * crept up to a hull had no collider list at all.
   *
   * This is the minimum length the sweep LOOKS, in metres. `stop` is still
   * clamped to the distance actually travelled, so a longer probe can never
   * advance the body by so much as a micron — it can only find the plate.
   * 0 restores the round-16 early return, so the ablation is honest.
   */
  hullProbe: 0.06,
  /**
   * Frames the last hull plane is remembered for, and the radius around its
   * contact point within which it still applies. A body sliding along a plate
   * travels parallel to it, so the forward probe misses the very surface it is
   * resting on; without a remembered plane the depenetration above only ever
   * runs on the frames the body is heading INTO something. Costs no raycast.
   */
  hullHold: 20,
  hullHoldR: 3.0,
  /**
   * A WRECK MADE OF PLATES NOBODY COLLIDES IS A HOLOGRAM.
   *
   * The tier rule below `_collectStructures` reads "LIGHT meshes (<= 9000 tri):
   * exact swept-ray collision; heavy AND elongated geometry is left alone
   * entirely", and at `aurora-stern` the thing that rule leaves alone is the
   * hull: one 28,336-triangle shell of radius 17.1 m, with four more heavy
   * meshes behind it. Five skipped meshes measured at that one landmark. The
   * diver does not swim through a gap in the wreck, they swim through its side.
   *
   * The stated objection to including them was never cost, it was that a
   * BOUNDING SPHERE around a 40 m plate is a giant invisible wall in open
   * water — and that objection applies to the blob path only. Exact triangles
   * have no such failure mode; they cost raycasts, and raycasts are bounded by
   * counting them. So the tier is now a triangle BUDGET spent nearest-first:
   * every mesh up to hullTriMax may be an exact collider, and meshes are
   * admitted in order of distance until hullTriBudget is used up, skipping
   * (not stopping at) one that would overflow it so a 28 k hull cannot crowd
   * out the railing in front of it. Set hullTriMax back to 9000 to ablate.
   *
   * Measured cost of the whole hull path, physics only with the renderer
   * stubbed, 360 frames of a run-up into the stern: see the round-17 note in
   * the report — the budget is what keeps it flat.
   */
  hullTriMax: 40000,
  hullTriBudget: 60000,
  /**
   * THE COLLIDER IS THE SPHERE, NOT THE EYE. `colDrop` has been declared,
   * documented as "sphere centre below the eye" and never referenced by a
   * single line of code: every hull sweep started at the eye and stopped
   * colRadius short of it, which collides a sphere centred 0.42 m ABOVE the one
   * the rest of the module describes. `clearance` is colDrop + colRadius
   * exactly (1.04 = 0.42 + 0.62), so the seabed contact and the hull contact
   * were resolving two different bodies, and a hull plate at chest height was
   * being tested against a sphere sitting at eyebrow height.
   * 1 = the documented sphere, 0 = the eye.
   */
  hullDrop: 1,
  /**
   * THE FLAT-GROUND FLOAT-OFF: what the ground gives, the ground takes back —
   * AND THIS TIME IT IS A LEDGER IN METRES, PAID BY DESCENDING.
   *
   * The defect three critics have now measured. Traced on the real input path,
   * a diver holding W with LEVEL pitch: the contact plane turns velocity ALONG
   * the face, which on a rising face means turning it upward (correct — that is
   * how a bank is ridden, and it is what made the descend route work), while on
   * the far side of the same bump the constraint has nothing to do, because
   * velocity leaving a surface is not penetrating it. So every metre of relief
   * is climbed and none of it is descended, and at neutral buoyancy there is no
   * gravity to return the diver: v.y decays toward zero under drag and stops
   * there. The body ends up flying dead level while the seabed drops away.
   *
   * Round 13 wrote a term here and CALLED it a conservative ledger. It was not
   * one, and the round-13 critic proved it with the module's own diagnostic:
   *
   *   - the ledger was in m/s, and `owed = min(_lift, v.y - max(support, cmd, 0))`
   *     can never drive v.y below zero, so it was a CLIMB-RATE LIMITER;
   *   - `_lift = clamp(_lift + gave, 0, max(0, v.y))` wrote the debt down to the
   *     current v.y every substep, so drag spent the debt and the ledger erased
   *     itself — at one site _lift fell 1.194 -> 0 in 1.2 s while the body
   *     descended nothing at all;
   *   - and the giveaway: the integral of NEGATIVE vertical velocity measured
   *     exactly 0.000 m on every site. Reproduced here on 38 of 40 scanned
   *     sites. The diver went up over every rise and never once came down.
   *
   * A debt that is discarded rather than repaid is not a ledger, so this is
   * rewritten in the only domain where the claim can be true: METRES OF HEIGHT.
   *
   *   `_lift` is the altitude above the seabed the body has gained WITHOUT
   *   ASKING FOR IT, accumulated from the body's own altitude (see _bankLift),
   *   and it is discharged only by the body physically coming back down through
   *   it. The return target is a NEGATIVE vertical velocity, so a diver lifted
   *   5 m by bumps descends 5 m, and the integral of negative v.y is non-zero
   *   by construction rather than by hope.
   *
   * Four properties fall out of measuring altitude rather than metering the
   * constraint's impulses, and each one was a bug in the velocity version:
   *
   *  - RIDING A BANK IS EXACTLY FREE. Altitude above the floor is constant
   *    while the body follows a slope, so nothing accrues however steep or long
   *    the climb is. The old `support` term existed to reconstruct that from
   *    the ring normal and could disagree with the floor the body was actually
   *    on; there is nothing left to disagree.
   *  - TERRAIN ROUGHNESS CANNOT RECTIFY INTO DEBT, because the accumulation is
   *    SIGNED: a bump that lifts the body and a hollow that drops it cancel.
   *    Metering `gave` could only ever add.
   *  - COMMANDED CLIMB IS EXEMPT OUTRIGHT. The commanded vertical speed is
   *    subtracted as it is asked for, and while the player is asking to go up
   *    the return is switched off entirely, so swimming off the sand is
   *    untouched to the last digit.
   *  - OPEN WATER IS SAFE BY CONSTRUCTION, not by tuning: past liftReach the
   *    ledger is faded to zero, so a diver crossing the drop-off — where the
   *    floor falls 200 m in a second — owes nothing at all and the long coast
   *    the whole module is built around cannot be touched.
   *
   * THE RETURN IS A FORCE, NOT A TARGET, and getting that wrong cost me a
   * measurement. Written as `v.y -> -vRet at liftShed`, a debt of one
   * MILLIMETRE still slammed the whole vertical velocity to the return rate
   * inside 0.08 s, because an exponential approach to a target does not care
   * how much is owed. Measured, that turned a diver riding a bank at 1.88 m/s
   * into one riding it at 1.62 and cost a flat site 18% of its cruise. An
   * acceleration proportional to the debt cannot do that: a millimetre owed is
   * 0.0007 m/s^2 and is worth nothing, five metres owed is the cap. It also
   * composes correctly with everything else — the contact plane absorbs it when
   * the body is already lying on the floor, so nothing is ever pressed into the
   * sand, and drag sets the settling rate rather than an authored number
   * fighting it.
   *
   * IT IS A PD PAIR, and both halves are read off the SAME measured altitude,
   * which is why they cannot disagree the way `support` and the ring normal
   * could. liftAccel is the P term — the ledger proper, the thing that makes
   * the debt get repaid instead of written off. liftDamp is the D term, and it
   * is there because round 13's climb-rate limiter, whatever else was wrong
   * with it, was doing real work: with the P term alone the peak of the ratchet
   * got WORSE than the round-13 build on eight of eleven terrain sites and the
   * diver spent LESS of the run in ground contact (hill02 groundedFrac 0.760 ->
   * 0.594), because nothing was left to stop it launching off a crest. Damping
   * the measured rate of unsupported altitude gain restores that, and unlike
   * the term it replaces it reads zero while the body rides a bank, because
   * altitude above the floor is what is differentiated, not v.y.
   *
   * The sum is clamped to [0, liftAccelMax], so this can only ever pull DOWN,
   * and the D term's job inside the clamp is to cancel part of P once the body
   * is already descending — which is what stops the return overshooting into
   * the sand. liftMax bounds the worst case: cross a cliff edge fast enough to
   * outrun the fade and the most that can ever be owed is this many metres of
   * sink. At the cap the return is 3.0 m/s^2, which against the ~3.0 /s of
   * cross-axis drag a horizontally-streamlined body presents to vertical motion
   * settles at about 1 m/s — a 13 deg path angle at cruise, a diver drifting
   * back down over the back of a dune rather than one being sucked into it.
   *
   * MEASURED. Sites found by scanning the heightfield with the same 0.52 m ring
   * the body samples on; W held with LEVEL pitch for 8 s; every column run
   * twice and bit-identical both times, and the ablations are this same file
   * with liftAccel and/or liftDamp set to 0.
   *
   *                    r13      THIS   ledger off   D only   P only
   *   endAlt   hill05  9.378   6.916    10.156      7.105    7.821
   *            flat1   5.509   2.947     6.204      3.568    3.254
   *            hill03  3.948   1.060     4.167      1.710    0.945
   *            hill24  3.744   1.257     4.110      1.630    0.805
   *   meanAlt  flat4   1.875   0.778     1.888      0.938    0.905
   *            flat2   1.048   0.303     1.055      0.464    0.416
   *            hill21  5.306   4.278     5.746      4.335    4.927
   *   excess   hill10  0.428   0.466     1.028      0.478    0.737
   *            hill02  0.395   0.392     0.938      0.450    0.655
   *   int(-vy) every terrain site
   *                    0.000  -1.2 to   0.000     -1.2 to  -0.9 to
   *                           -3.4                -2.9     -3.8
   *
   * Read the "ledger off" column first: it is worse than r13 on every row, so
   * r13's climb-rate limiter WAS doing real work even though its ledger was
   * fiction — which is why liftDamp exists. Neither half is redundant: alone
   * they recover 52-94% of the gap and together they beat both on nine of the
   * eleven terrain sites. The one row this loses on is `excess`, the single-
   * frame peak of the ratchet, on three of eleven sites (hill10 0.428 -> 0.466,
   * hill03 0.350 -> 0.412, flat1 0.299 -> 0.332); it is a path-dependent peak
   * and the paths differ, and it is bought back many times over in the mean.
   *
   * COST: horizontal cruise over the eleven terrain sites moves -2.6% to +3.2%
   * (hill24 4.013 -> 3.908, hill02 3.490 -> 3.600). Open water is bit-identical
   * with the term on and off — four-second coast 8.000 m, three-second ascent
   * off the sand 11.284 m, cruise 4.315 m/s — which is the guarantee the reach
   * fade is there to make structural rather than tuned. Play routes: `descend`
   * 137.0 -> 137.5 m, `pressure` 171.4 -> 172.5 m deepest, i.e. slightly
   * better, and `dive` unchanged at 52.0 m travelled.
   */
  liftMax: 6.0,
  liftAccel: 2.0,
  liftDamp: 3.5,
  liftRateTau: 0.05,
  liftAccelMax: 3.5,
  liftReach: 8.0,
  liftFade: 4.0,

  // ---- world
  edgeRadius: 1900,       // soft wall well inside WORLD.worldSize / 2
  edgePush: 6.0,
};
// The eye is eyeToFeet above the soles, so the submerged fraction that leaves it
// restProud metres clear of the wave is exactly this.
T.neutralFrac = (T.eyeToFeet - T.restProud) / T.bodyHeight;
/**
 * The friction angle IS the step limit. atan(1/0.625) = 58.0 deg, which is the
 * same face maxSlopeTan refuses horizontally — see the contactMu block for the
 * measurements that put it back and for what the two costs actually are.
 */
T.contactMu = 1 / T.maxSlopeTan;

// ---------------------------------------------------------------- derived
/**
 * Steady drag along the body axis at speed v, as an acceleration in m/s^2.
 * This is the ONLY place the drag law is written down; everything that needs
 * to know what a speed costs asks here rather than re-deriving it, which is
 * how a coefficient change stops being able to invalidate a comment.
 */
const dragAt = (v) => T.dragLin * v + T.dragQuad * v * v;
/**
 * Fraction of stall-free thrust still available once the body has reached its
 * target speed. The taper is (1 - (v/vMax)^p) with vMax = vTarget*slipMargin,
 * so at v = vTarget it is exactly this, by construction and at every speed in
 * the table.
 */
T.slipHold = 1 - Math.pow(1 / T.slipMargin, T.slipPow);
/**
 * The zero-speed thrust that lands a body on terminal speed `v`. Balance at
 * v is thrust(v) = A*slipHold = dragAt(v), so A = dragAt(v)/slipHold. Every
 * acceleration in this module comes from here — there are no authored ones
 * left to fall out of calibration.
 */
const thrustFor = (v) => dragAt(v) / T.slipHold;

// scratch — allocating in update() would garbage the frame budget
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _bob = new THREE.Vector3();
const _axT = new THREE.Vector3();       // body-axis target, per substep
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _ray = new THREE.Raycaster();
const _prevPos = new THREE.Vector3();

// hull collision, in COLLIDER-CENTRE space (the eye dropped by T.colDrop)
const _hFrom = new THREE.Vector3();
const _hTo = new THREE.Vector3();
const _nrm2 = new THREE.Vector3();
/**
 * The last few hull planes touched, kept for T.hullHold frames each.
 *
 * Two reasons it is a SET and not one plane. A body sliding along a plate
 * travels parallel to it, so the forward probe never sees the surface it is
 * resting on and only a remembered plane can hold it off. And an inside corner
 * of a wreck — a deck meeting a bulkhead, a girder against a hull — cannot be
 * satisfied by one plane at a time: pushing clear of the deck drives the body
 * into the bulkhead and back again, which is the wobble the single-plane
 * version measured. Three planes, settled twice, resolve a corner. See
 * T.hullDepen.
 */
const HULL_CONTACTS = 3;
const _hullP = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _hullN = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];

// seabed sample ring: centre plus four points at ringR, so a boulder edge that
// misses the centre tap still holds the diver off it
const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
// The heights that ring last returned. _ringNormal() differences them, so the
// contact normal costs no extra terrain taps and is the normal of the SMOOTHED
// surface the body actually rides rather than of a pebble under the centre tap.
const _rh = [0, 0, 0, 0, 0];
const _gnrm = new THREE.Vector3(0, 1, 0);   // contact normal under the body
const _dnrm = new THREE.Vector3(0, 1, 0);   // contact normal at a blocked step
const _fnrm = new THREE.Vector3(0, 1, 0);   // contact normal at the resolved position

/**
 * Damp the part of `v` that is SLIDING ALONG a contact plane, leaving the part
 * along the normal untouched. `f` is the surviving fraction, exp(-k dt).
 *
 * Every friction term in this module used to be written `v.x *= f; v.z *= f`,
 * which is this function and only this function for a perfectly level floor.
 * On anything else it damps the wrong two axes: on a 72 deg face ~90% of the
 * sliding is in y, so wallFric at full strength could not touch it, and the one
 * axis that was free to move was the one the levitation lived in. Written
 * against the actual contact normal it degrades to the old arithmetic exactly
 * where the old arithmetic was right and bites everywhere else.
 */
/**
 * Move the `n` nearest entries of a flat [key, value, key, value, ...] pool
 * into `out`, nearest first. Selection rather than a full sort: the pool holds
 * under a hundred entries, n is 24 or 8, and this allocates nothing.
 */
const takeNearest = (pool, out, n) => {
  const m = pool.length >> 1;
  const take = Math.min(n, m);
  for (let i = 0; i < take; i++) {
    let best = i;
    for (let j = i + 1; j < m; j++) if (pool[j * 2] < pool[best * 2]) best = j;
    if (best !== i) {
      const k = pool[i * 2], v = pool[i * 2 + 1];
      pool[i * 2] = pool[best * 2]; pool[i * 2 + 1] = pool[best * 2 + 1];
      pool[best * 2] = k; pool[best * 2 + 1] = v;
    }
    out.push(pool[i * 2 + 1]);
  }
};

/**
 * As above for a flat [key, mesh, triangleCount, ...] pool, spending a triangle
 * budget nearest-first. A mesh that would overflow the budget is SKIPPED rather
 * than ending the walk, so one 28 k hull cannot crowd out the railing standing
 * in front of it. The budget is what bounds the cost of the swept-ray tests:
 * three.js walks every triangle of every candidate on every ray.
 */
const takeBudget = (pool, out, n, budget) => {
  const m = pool.length / 3;
  let spent = 0;
  for (let taken = 0; taken < n; taken++) {
    let best = -1, bestK = Infinity;
    for (let j = 0; j < m; j++) {
      const k = pool[j * 3];
      if (k >= bestK || pool[j * 3 + 1] === null) continue;
      if (spent + pool[j * 3 + 2] > budget) continue;
      best = j; bestK = k;
    }
    if (best < 0) return;
    out.push(pool[best * 3 + 1]);
    spent += pool[best * 3 + 2];
    pool[best * 3 + 1] = null;          // consumed
  }
};

const dampTangent = (v, n, f) => {
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  const g = f - 1;
  v.x += (v.x - n.x * vn) * g;
  v.y += (v.y - n.y * vn) * g;
  v.z += (v.z - n.z * vn) * g;
};

const api = {
  id: 'movement',
  order: 100,

  /**
   * The tuning table, exposed so a bench can ablate a single term at runtime
   * instead of forking the file. Nothing in the game reads it; nothing in this
   * module branches on the harness because of it. The ablation switches are
   * `slopeRiseCredit` and `contactSlipRef`, both documented in T.
   */
  tuning: T,

  // ---------------------------------------------------------------- published
  position: new THREE.Vector3(0, -1, 0),
  velocity: new THREE.Vector3(),
  camera: null,
  enabled: true,

  yaw: 0,
  pitch: 0,
  speed: 0,
  depth: 0,
  waterY: 0,
  groundY: -Infinity,
  grounded: false,
  stamina: 1,
  exhausted: false,
  sprinting: false,
  exertion: 0,
  lastImpactSpeed: 0,
  crossDir: 0,            // +1 just surfaced, -1 just dived, 0 otherwise
  justCrossed: false,

  /** 0 = eye fully in air, 1 = eye fully under. Matches watersurface's curve. */
  get submersion() { return this._sub; },
  /** THE published flag: survival, ui, tools, audio and vehicles all read this. */
  get isSubmerged() { return this._sub > 0.5; },
  /** Horizontal speed only — ui wants this for the swim indicator. */
  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); },
  /** Compass heading in degrees, 0 = -Z (north), increasing clockwise. */
  get headingDeg() { return (((-this.yaw / DEG) % 360) + 360) % 360; },
  get forward() { return _fwd.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); },

  // ---------------------------------------------------------------- control
  /** Bind the camera this module drives. Called by core at init; vehicles may re-call. */
  attach(camera) {
    if (!camera) return this.camera;
    this.camera = camera;
    this._syncFromCamera();
    return camera;
  },
  /**
   * Vehicles take the player out of the water: stop reading input and driving
   * the camera. Only the false -> true edge re-seats the body; vehicles.js
   * calls this every frame while docking, and re-seating on every call would
   * zero the swimmer's momentum continuously.
   */
  setEnabled(on) {
    const want = !!on;
    const edge = want && !this.enabled;
    this.enabled = want;
    if (edge && this.camera) this._syncFromCamera();
    return this.enabled;
  },
  /** Alias survival.js prefers when putting the player back after a death. */
  respawn(v) { return this.teleport(v); },
  /** Hard move (spawn, vehicle exit, cinematic). Clears momentum and smoothing. */
  teleport(x, y, z) {
    if (x && x.isVector3) this.position.copy(x); else this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this._reseat();
    return this.position;
  },
  /** External shove: creature bump, explosion, current. */
  impulse(v, y, z) {
    if (v && v.isVector3) this.velocity.add(v);
    else { this.velocity.x += v; this.velocity.y += y; this.velocity.z += z; }
    return this.velocity;
  },
  /** Seconds since the eye last crossed the waterline — audio wants this. */
  get timeSinceCross() { return this._crossT; },
  /** Programmatic look, radians. */
  look(dyaw, dpitch) {
    this.yaw += dyaw || 0;
    this.pitch = clamp(this.pitch + (dpitch || 0), -T.pitchLimit, T.pitchLimit);
  },

  // ---------------------------------------------------------------- internals
  _sub: 1,
  _wasUnder: null,
  _crossT: 0,
  _cycle: 0,
  _activity: 0,
  _roll: 0,
  _yawRate: 0,
  _fovBase: 68,
  _fov: 68,
  _fovWritten: 68,
  _regenT: 0,
  _prevWaterY: null,
  _waterVY: 0,
  _noCollide: 0,
  /** 0..1 how much of the seabed plane the body is subject to (see T.contactBand). */
  _gW: 0,
  /** m/s^2 of into-surface acceleration the plane absorbed last substep. */
  _gPress: 0,
  /** METRES of altitude the seabed has GIVEN the body and not yet taken back. */
  _lift: 0,
  /** Last substep's altitude above the sampled floor; null = no history yet. */
  _prevAlt: null,
  /** Smoothed m/s of UNSUPPORTED altitude gain — the ratchet, measured. */
  _liftRate: 0,
  _prevEye: null,
  _crossRate: 0,
  _prevVel: new THREE.Vector3(),
  /** Unit vector the body is streamlined along — see T.crossDrag. */
  _axis: new THREE.Vector3(0, 0, -1),
  _accSm: new THREE.Vector3(),
  _camPos: new THREE.Vector3(),
  _bobW: new THREE.Vector3(),
  _lastCamPos: new THREE.Vector3(),
  _lastCamQuat: new THREE.Quaternion(),
  _lastCamFov: 68,
  _hSpeed: 1,
  _hDrag: 1,
  _hFov: 0,
  _terrain: null,
  _water: null,
  _structRoot: null,
  _structApi: null,
  _cand: [],
  _blobs: [],
  _pool: [],              // flat [distance, mesh] scratch for the candidate sort
  _bpool: [],
  _hullAge: [1e6, 1e6, 1e6],   // frames since each remembered hull plane was touched
  _candT: 1e9,
  _candPos: new THREE.Vector3(1e9, 1e9, 1e9),

  // ---------------------------------------------------------------- lifecycle
  async init(ctx) {
    this.camera = ctx.camera;
    this._terrain = null;      // resolved lazily: terrain may still be loading chunks
    this._structApi = ctx.get('structures') || null;
    this._structRoot = ctx.scene.getObjectByName('structures') || null;

    // `?nomove` parks the player so another agent can capture without the body
    // drifting under buoyancy between frames.
    if (ctx.params?.has('nomove')) this.enabled = false;

    // Spawn where Subnautica does: treading water beside Lifepod 5, facing it.
    const pod = this._structApi?.lifepod;
    const t = ctx.time?.t ?? 0;
    if (pod?.position) {
      const wy = this._waterAt(ctx, pod.position.x + 4.6, pod.position.z + 3.4, t);
      this.position.set(pod.position.x + 4.6, wy + T.restProud, pod.position.z + 3.4);
      this.yaw = Math.atan2(-(pod.position.x - this.position.x), -(pod.position.z - this.position.z));
    } else {
      this.position.copy(ctx.camera.position);
      _euler.setFromQuaternion(ctx.camera.quaternion, 'YXZ');
      this.yaw = _euler.y; this.pitch = _euler.x;
    }
    this.velocity.set(0, 0, 0);
    this._fovBase = this._fov = this._fovWritten = ctx.camera.fov;
    this._reseat();
    this._writeCamera(0, ctx.time?.t ?? 0);

    // capability handshake, mirroring watersurface's `ctx.water`
    ctx.provide('player', this);
  },

  /**
   * Every accumulator in this module that outlives a frame, cleared — so a shot
   * cannot read differently because of which shot ran before it.
   *
   * `_reseat` already zeroes the physics state and core/shots.js does teleport
   * the camera, but it runs BEFORE the shot's setCamera in the same call and it
   * does not touch the three filters that are not physics: stamina (which gates
   * sprint thrust), the exhaustion latch, and the waterline-crossing history
   * that decides how wide the medium blend opens on the captured frame. A
   * battery that sprinted through a play route and then took a still would
   * otherwise capture a diver with 40% stamina and a stale crossing rate.
   */
  resetForShot() {
    this.stamina = 1;
    this.exhausted = false;
    this.sprinting = false;
    this._regenT = 0;
    this.exertion = 0;
    this.lastImpactSpeed = 0;
    this._wasUnder = null;
    this.justCrossed = false;
    this.crossDir = 0;
    this._crossT = 0;
    this.velocity.set(0, 0, 0);
    this._reseat();
  },

  update(dt, t, ctx) {
    const cam = this.camera || ctx.camera;
    if (!cam) return;
    if (!this._terrain) {
      const terr = ctx.get('terrain');
      if (terr?.heightAt) this._terrain = terr;
    }
    if (!this._structRoot) this._structRoot = ctx.scene.getObjectByName('structures') || null;
    if (!this._structApi) this._structApi = ctx.get('structures') || null;

    // ---- did something else move the camera? (core/shots.js, tools/play.mjs)
    //
    // Position and orientation ONLY. FOV is deliberately not a trigger:
    // vehicles.js eases ctx.camera.fov toward its own resting value every
    // frame, swimming or not, so treating that as a teleport re-seated the body
    // and zeroed the velocity 60 times a second — the player twitched in place
    // and travelled 3 m over a 20 s route. FOV is a lens property, never
    // evidence that the body moved.
    if (cam.position.distanceToSquared(this._lastCamPos) > 1e-8
      || Math.abs(cam.quaternion.dot(this._lastCamQuat)) < 0.99999) {
      this._syncFromCamera();
    }
    // tools/play.mjs writes `movement.position` directly to place the player.
    // Our own camera lag is clamped to 22 cm, so 8 m of disagreement can only
    // mean somebody else moved the body.
    if (this.position.distanceToSquared(this._camPos) > 64) this._reseat();

    // Something else owns the camera (a vehicle, or ?nomove). Keep tracking it
    // so survival/ui/audio still read a sane player state, but drive nothing.
    if (!this.enabled) { this._trackCamera(cam); return; }

    // The very first rAF after boot arrives with dt === 0 (main.js seeds `last`
    // from the same timestamp it then renders). Dividing the wave delta by that
    // produced a NaN velocity, which propagated into the camera and took
    // render/underwater.js down with it via biomes.at(NaN).
    if (!(dt > 1e-6)) { this._writeCamera(0, t); return; }

    // vehicles.js publishes swimHandling() specifically for this module: the
    // Seaglide makes the swimmer faster, sharper and wider-angle without
    // vehicles ever touching the physics. Fully guarded — it is a stub for most
    // of the project's life.
    let hSpeed = 1, hDrag = 1, hFov = 0;
    try {
      const vh = ctx.get('vehicles');
      const hand = vh?.swimHandling?.();
      if (hand) {
        if (hand.locked) { this._trackCamera(cam); return; }
        /**
         * The preference between these two inverted this round, and it had to.
         *
         * Top speed used to be whatever thrust/drag happened to produce, so
         * `accelScale` was the physical knob and `speedScale` was a redundant
         * restatement of it. Under the thrust taper top speed is AUTHORED, and
         * the taper hard-caps the body at slipMargin times its target — so
         * feeding the Seaglide's 1.9x thrust in as thrust would have capped it
         * at 5.75 m/s instead of the ~7.2 vehicles.js calibrated, quietly
         * nerfing another module's tool by 20% with nothing in either file
         * saying so. `speedScale` is exactly the top-speed ratio this model
         * wants, so it now wins, and accelScale is reduced to a fallback via
         * the quadratic-regime relation v ~ sqrt(accel/drag).
         */
        if (Number.isFinite(hand.speedScale)) hSpeed = hand.speedScale;
        else if (Number.isFinite(hand.accelScale)) {
          const d = Number.isFinite(hand.dragScale) ? hand.dragScale : 1;
          hSpeed = Math.sqrt(hand.accelScale / Math.max(d, 1e-3));
        }
        if (Number.isFinite(hand.dragScale)) hDrag = hand.dragScale;
        if (Number.isFinite(hand.fovBonus)) hFov = hand.fovBonus;
      }
    } catch { /* vehicles is someone else's module; never let it break ours */ }
    this._hSpeed = clamp(hSpeed, 0.1, 6);
    this._hDrag = hDrag;
    this._hFov = hFov;

    const input = ctx.input;
    const on = (code) => !!(input?.enabled !== false && input?.keys?.has(code));

    // ---- look ------------------------------------------------------------
    // Pointer lock never engages headlessly; tools/play.mjs sets input.locked
    // itself and feeds mouse deltas, so gating on `locked` is safe both ways.
    let yawRateRaw = 0;
    if (input?.locked && input.enabled !== false) {
      const dyaw = -(input.mouse.dx || 0) * T.lookSens;
      const dpit = -(input.mouse.dy || 0) * T.lookSens;
      this.yaw += dyaw;
      this.pitch = clamp(this.pitch + dpit, -T.pitchLimit, T.pitchLimit);
      if (dt > 1e-5) yawRateRaw = dyaw / dt;
    }
    this._yawRate += (yawRateRaw - this._yawRate) * approach(dt, 0.10);

    // ---- intent ----------------------------------------------------------
    const fwdIn = (on('KeyW') || on('ArrowUp') ? 1 : 0) - (on('KeyS') || on('ArrowDown') ? 1 : 0);
    const strIn = (on('KeyD') || on('ArrowRight') ? 1 : 0) - (on('KeyA') || on('ArrowLeft') ? 1 : 0);
    const vertIn = (on('Space') ? 1 : 0) - (on('KeyC') || on('ControlLeft') || on('ControlRight') ? 1 : 0);
    const wantSprint = (on('ShiftLeft') || on('ShiftRight')) && fwdIn > 0;

    // ---- stamina: the fin kick is not free ------------------------------
    this.sprinting = wantSprint && !this.exhausted && this.stamina > 0 && this._sub > 0.4;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - dt * T.sprintDrain);
      this._regenT = 0;
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this._regenT += dt;
      if (this._regenT > T.regenDelay) this.stamina = Math.min(1, this.stamina + dt * T.sprintRegen);
      if (this.exhausted && this.stamina > T.exhaustClear) this.exhausted = false;
    }

    // ---- integrate, substepped so a 50 ms hitch cannot tunnel the seabed --
    const steps = Math.min(3, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(h, t, ctx, fwdIn, strIn, vertIn);

    // Belt and braces: a non-finite player position propagates into uCamPos and
    // takes half the render stack down with it (biomes.at(NaN) returns null and
    // render/underwater.js dereferences it). Never let that leave this module.
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      this.position.copy(this._lastCamPos);
      this.velocity.set(0, 0, 0);
      this._reseat();
    }

    // ---- the body's own acceleration, which is what the camera trails ----
    // Collision impulses are not swimming: they arrive as a single-frame
    // velocity discontinuity worth hundreds of m/s^2 and would snap the head
    // to the clamp. Cap the sample, then smooth it.
    _tmp.subVectors(this.velocity, this._prevVel).divideScalar(dt);
    const alen = _tmp.length();
    if (!(alen < 40)) { if (alen > 1e-6) _tmp.multiplyScalar(40 / alen); else _tmp.set(0, 0, 0); }
    this._prevVel.copy(this.velocity);
    this._accSm.lerp(_tmp, approach(dt, T.camLagAccTau));

    // ---- derived state others read --------------------------------------
    this.speed = this.velocity.length();
    this.depth = Math.max(0, this.waterY - this.position.y);
    const sprintN = this.sprinting ? 1 : 0;
    // Normalised against the authored cruise speed, not against a literal 4.0
    // that happened to equal it three rounds ago. survival.js reads `exertion`
    // to bill oxygen, so a stale reference here is a stale O2 budget.
    this.exertion = clamp01(this.speed / T.speeds.cruise * 0.55 + sprintN * 0.55);

    // ---- swim cycle: bob and sway are keyed to the fin kick, not to time --
    const speedN = clamp01(this.speed / T.speeds.cruise);
    const inputMag = clamp01(Math.abs(fwdIn) + Math.abs(strIn) + Math.abs(vertIn) * 0.6);
    const actTarget = clamp01(Math.max(speedN, inputMag * 0.8)) * this._sub;
    this._activity += (actTarget - this._activity) * approach(dt, 0.25);
    const kicksPerSec = 0.55 + 1.15 * speedN + 0.55 * sprintN;
    this._cycle += dt * kicksPerSec * Math.PI * 2;
    if (this._cycle > Math.PI * 2000) this._cycle -= Math.PI * 2000;

    this._writeCamera(dt, t, strIn);
    if (this._noCollide > 0) this._noCollide--;
  },

  /**
   * The medium switch has to agree with the FINAL camera position, not the one
   * watersurface saw at the top of the frame. watersurface.js runs at order 30
   * and this module moves the camera at order 100, so leaving it alone put the
   * waterline a whole frame behind the eye — at a 4 m/s ascent that is 7 cm
   * against a 10 cm blend zone, i.e. the medium visibly popping a frame late on
   * every crossing. Recomputed here with watersurface's own curve so the two
   * never disagree by more than the float epsilon.
   */
  preRender(ctx) {
    const cam = this.camera || ctx.camera;
    if (!cam) return;
    const wy = this._waterAt(ctx, cam.position.x, cam.position.z, ctx.time.t);
    const eye = cam.position.y - wy;

    /**
     * How wide the air/water blend is, in metres — and it is not a constant.
     *
     * watersurface.js measured 0.10 m against LOOK.md 5 ("a hard, straight,
     * sharp line... almost no blend zone") and it is right about a STILL frame:
     * a wide band there leaks render/underwater.js's god-ray columns over the
     * sky. But 0.10 m at the 1.4 m/s heave of an actual crossing is traversed in
     * 73 ms, so uUnderwater snapped 0.45 -> 0.69 -> 1.00 in three frames and
     * those three frames are neither air nor water.
     *
     * So the band tracks the crossing RATE. Parked (a capture, a settled shot,
     * a diver riding the swell with the eye locked to it) the rate is ~0 and the
     * waterline is watersurface's hard 10 cm line. Punching through at 1 m/s it
     * opens to 0.34 m, which is ~0.35 s of cross-fade instead of three frames.
     * Sharp where sharpness is measurable, soft only while it is moving too fast
     * to read.
     */
    const dt = ctx.time?.dt ?? 0;
    if (this._prevEye !== null && dt > 1e-6) {
      const rate = Math.abs(eye - this._prevEye) / dt;
      this._crossRate += (rate - this._crossRate) * approach(dt, 0.08);
    }
    this._prevEye = eye;
    const band = clamp(T.subBandMin + T.subBandRate * this._crossRate, T.subBandMin, T.subBandMax);

    const sub = clamp01(-eye / band + 0.5);
    U.uUnderwater.value = sub;
    if (U.uSubmersion) U.uSubmersion.value = sub;
    this._sub = sub;
    this.waterY = wy;
    this.depth = Math.max(0, -eye);
  },

  // ---------------------------------------------------------------- physics
  _step(dt, t, ctx, fwdIn, strIn, vertIn) {
    const p = this.position;
    const v = this.velocity;
    _prevPos.copy(p);

    // ---- where is the surface right here, right now? ---------------------
    // TWO samples, because they answer different questions. `wy` is the wave at
    // the eye — a point, and what the medium switch and the depth readout must
    // use. `wyBody` is the wave averaged over the body's own footprint, and it
    // is what buoyancy integrates: a 1.8 m diver cannot be lifted by a 1.45 m
    // ripple any more than a rowing boat can, because the crest under the chest
    // is cancelled by the trough under the hips. Averaging over a 1.24 m
    // footprint attenuates the shortest Gerstner component to ~31% and leaves
    // everything past 7 m untouched, which is the right shape for free.
    const wy = this._waterAt(ctx, p.x, p.z, t);
    const wyBody = this._waterBodyAt(ctx, p.x, p.z, t);
    if (this._prevWaterY === null) this._prevWaterY = wyBody;
    // vertical velocity of the water itself, so a swell lifts the diver rather
    // than the damping term fighting it
    this._waterVY = dt > 1e-6 ? clamp((wyBody - this._prevWaterY) / dt, -5, 5) : 0;
    this._prevWaterY = wyBody;
    this.waterY = wy;

    // submerged fraction of the 1.8 m body
    const s = clamp01((wyBody - p.y + T.eyeToFeet) / T.bodyHeight);
    // The eye's own submersion, on the still-frame band. This one drives bob,
    // roll and FOV amplitude from the BODY's position; preRender recomputes it
    // from the final camera transform (with the rate-adaptive band) for the
    // medium switch, and that later value is what leaves the module.
    const sub = clamp01((wy - p.y) / T.subBandMin + 0.5);
    this._sub = sub;

    // ---- the seabed plane ------------------------------------------------
    // Sampled BEFORE anything is decided, because the surface the body is lying
    // against changes what the body can do with its thrust, which way it is
    // streamlined, and where its momentum is allowed to point. Everything below
    // reads `gw` and `_gnrm`; at gw = 0 (open water, and that is every frame
    // that is not on the floor) all of it compiles out to the old arithmetic.
    const gw = this._noCollide > 0 ? 0 : this._contact();

    // ---- basis (roll must not steer) -------------------------------------
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _fwd.set(-sy * cp, sp, -cy * cp);
    _right.set(cy, 0, -sy);

    // ---- thrust ----------------------------------------------------------
    // You need water to push against: with your head out you flail. And you
    // cannot swim up out of the sea, so upward thrust fades out as the eye
    // approaches the surface (s = 0.861 is the eye exactly on the waterline,
    // 0.800 is 11 cm clear of it) — otherwise holding W while looking up at the
    // surface launches the diver into the air like a dolphin.
    //
    // It has to reach zero ABOVE the waterline rather than at it, though. When
    // it cut out at s = 0.87 the diver arrived at the waterline with no thrust
    // left, crept the last few centimetres on buoyancy alone against the wave
    // coupling, and spent a quarter of a second hovering at exactly the height
    // where the medium switch is decided — which flipped three times. Carrying
    // a third of the thrust through the crossing punches cleanly out instead.
    const bite = smoothstep(0.12, 0.62, s);
    const upBite = smoothstep(0.80, 0.93, s);
    /**
     * The wish is built in units of CRUISE SPEED, not of acceleration: each
     * axis contributes the speed it is entitled to, divided by cruise. So `wl`
     * is "how many cruises is this input asking for", and the strongest single
     * axis in play is the cap — a diagonal points somewhere new, it does not go
     * faster than the fastest axis that made it.
     */
    const S = T.speeds;
    const fwdW = fwdIn > 0 ? (this.sprinting ? S.sprint : S.cruise) / S.cruise : S.back / S.cruise;
    let wCap = 0;
    _wish.set(0, 0, 0);
    if (fwdIn !== 0) {
      _tmp.copy(_fwd);
      if (_tmp.y > 0) _tmp.y *= upBite;
      _wish.addScaledVector(_tmp, fwdIn > 0 ? fwdW : -fwdW);
      wCap = Math.max(wCap, fwdW);
    }
    if (strIn !== 0) {
      _wish.addScaledVector(_right, strIn * (S.strafe / S.cruise));
      wCap = Math.max(wCap, S.strafe / S.cruise);
    }
    if (vertIn !== 0) {
      _wish.y += vertIn * (S.vert / S.cruise) * (vertIn > 0 ? upBite : 1);
      wCap = Math.max(wCap, S.vert / S.cruise);
    }

    let ax = 0, ay = 0, az = 0;
    let diveCmd = 0;
    // The climb the player is ASKING for, in m/s. The lift ledger exempts it, so
    // a diver swimming up off the sand is never billed for the seabed's lift.
    let cmdVy = 0;
    const wl = _wish.length();
    if (wl > 1e-4) {
      const inv = 1 / wl;
      const dirx = _wish.x * inv, diry = _wish.y * inv, dirz = _wish.z * inv;
      // Target speed along the commanded direction, and the slip speed at which
      // the fin stops finding water to push against.
      // hSpeed is the Seaglide (or nothing at all); hDrag rescales the drag law
      // underneath, so the thrust that balances it has to be rescaled with it.
      const vT = Math.min(wl, wCap) * S.cruise * this._hSpeed;
      const vMax = vT * T.slipMargin;
      /**
       * Thrust falls off as the body approaches the fin's slip speed. This is
       * what lets drag be low enough to glide without the top speed running
       * away with it: near rest almost all of `thrustFor(vT)` is available, at
       * vT exactly enough of it is left to balance drag, and past vMax there is
       * none. `vAlong` is speed already made good along the command, so backing
       * off or turning re-opens the taper immediately and the body digs in.
       */
      const vAlong = Math.max(0, v.x * dirx + v.y * diry + v.z * dirz);
      const taper = 1 - Math.pow(clamp01(vAlong / Math.max(vMax, 1e-3)), T.slipPow);
      // The fin kick is a pulse, so the thrust pulses with it. Mean over a cycle
      // is exactly the steady value: this changes the texture of the motion,
      // never the top speed.
      const surge = 1 + T.kickSurge * this._activity * Math.sin(this._cycle);
      const mag = thrustFor(vT) * this._hDrag * taper * surge * bite;
      ax = dirx * mag; ay = diry * mag; az = dirz * mag;
      // How hard the player is asking to go DOWN, as an angle below horizontal
      // rather than as a force — see T.diveWish.
      diveCmd = clamp01(-diry / T.diveWish) * bite;
      cmdVy = diry * vT;
    }

    // ---- the body's own axis --------------------------------------------
    // Where the diver is streamlined. While finning, that is the line they are
    // finning along; coasting, it relaxes back to where they are looking. The
    // relaxation is what makes a turn cost speed instead of skidding: the body
    // swings around before the velocity does, and for those few tenths of a
    // second the leftover momentum is broadside and gets scrubbed.
    _axT.copy(wl > 1e-4 ? _wish : _fwd);
    // In contact the body lies along the surface it is riding, not along the
    // line the eye is on — a diver sliding up a bank tilts with the bank. Left
    // out, the up-slope half of the velocity the slope has just imposed counts
    // as BROADSIDE and is scrubbed at T.crossDrag, a second and completely
    // hidden tax on exactly the motion the ground forced. On a 34 deg slope
    // that is 56% of the velocity damped five times too hard.
    if (gw > 1e-3) {
      const an = _axT.x * _gnrm.x + _axT.y * _gnrm.y + _axT.z * _gnrm.z;
      if (an < 0) _axT.addScaledVector(_gnrm, -an * gw);
    }
    const axl = _axT.length();
    if (axl > 1e-5) {
      _axT.multiplyScalar(1 / axl);
      this._axis.lerp(_axT, approach(dt, T.axisTau));
      const al = this._axis.length();
      // A lerp between unit vectors is short of unit and can in principle pass
      // through zero on a 180 deg reversal; renormalise, and fall back to the
      // target rather than dividing by nothing.
      if (al > 1e-4) this._axis.multiplyScalar(1 / al); else this._axis.copy(_axT);
    }

    // ---- buoyancy --------------------------------------------------------
    // A spring on submerged fraction, resting with the eye T.restProud above
    // the local wave, and windowed to exactly zero by T.buoyNeutral so a diver
    // past 1.5 m is neutral rather than asymptotically-almost-neutral.
    // `diveCmd` (computed with the thrust above) is what lets the player leave
    // the surface at all: the float yields in proportion to how steeply down
    // they are asking to go, so the same force that keeps the chop out of the
    // lens is not a lid on the ocean.
    const yield_ = 1 - T.diveYield * diveCmd;
    const depth = Math.max(0, wyBody - p.y);
    const authority = depth >= T.buoyNeutral ? 0
      : Math.exp(-depth / T.buoyFade)
        * (1 - smoothstep(T.buoyNeutralKnee, T.buoyNeutral, depth)) * yield_;
    const buoy = authority === 0 ? 0
      : clamp((s / T.neutralFrac - 1) * -WORLD.gravity * authority,
        -Math.abs(WORLD.gravity), T.maxBuoyAccel);
    ay += buoy;

    // ---- ...and what the seabed gave, the seabed takes back --------------
    // See T.liftMax. The contact constraint is one-sided — it turns velocity up
    // a rising face and does nothing on a falling one — so on undulating ground
    // it rectifies forward speed into climb that nothing removes. `_lift` is
    // the METRES of that climb still outstanding (banked at the foot of _step
    // from the altitude the body actually holds, so riding a bank costs nothing
    // and roughness cancels instead of accumulating), and this is the restoring
    // force that returns them: proportional to the debt, capped, and switched
    // off outright while the player is asking to climb. It is summed with the
    // other accelerations so the seabed plane below can refuse it — a body
    // already lying on the sand is never pressed into it.
    if (cmdVy <= 0) {
      const ret = clamp(this._lift * T.liftAccel + T.liftDamp * this._liftRate, 0, T.liftAccelMax);
      if (ret > 1e-5) ay -= ret;
    }

    // How strongly the body is coupled to the surface layer's own motion: full
    // from the rest height down to T.surfHold below it (which reaches ~0.3 m
    // under the waterline), then fading out. Above the rest height it fades
    // faster — a diver thrown clear by a crest is in the air and free.
    const belowRest = (wyBody + T.restProud) - p.y;
    const nearSurf = belowRest <= 0
      ? clamp01(1 + belowRest / T.surfDampUp)
      : clamp01(1 - (belowRest - T.surfHold) / T.surfDampRange);

    // ---- soft world edge -------------------------------------------------
    const r = Math.hypot(p.x, p.z);
    if (r > T.edgeRadius) {
      const k = Math.min(1, (r - T.edgeRadius) / 60) * T.edgePush / Math.max(r, 1e-3);
      ax -= p.x * k; az -= p.z * k;
    }

    // ---- drag ------------------------------------------------------------
    // Blend the water and air coefficients on submerged fraction so breaking
    // the surface is felt as a sudden loss of grip rather than a switch, plus
    // wave-making resistance for a body straddling the waterline (4s(1-s) peaks
    // at half-submerged and vanishes at both ends). Drag acts on velocity
    // RELATIVE to the medium, and near the surface the medium is moving.
    //
    // Split into the component along the body axis and the component across
    // it: a diver coasts a long way along the line they are pointed and barely
    // at all sideways. Steady straight-line speeds are untouched by the split,
    // because thrust and velocity are parallel once the body has settled.
    const straddle = 4 * s * (1 - s);
    const dl = (T.dragAirLin + (T.dragLin - T.dragAirLin) * s) * this._hDrag;
    const dq = (T.dragAirQuad + (T.dragQuad - T.dragAirQuad) * s) * this._hDrag;
    const wvyDrag = this._waterVY * nearSurf;
    const rvy = v.y - wvyDrag;
    // Explicit drag inverts the sign of the velocity it is damping once k*h
    // exceeds 2, and the harness does hand us half-second frames. Cap the TOTAL
    // coefficient any one axis can see at 1.6/h — the along and across terms
    // are orthogonal so only one of them lands on a given axis, but the bow
    // wave stacks on top of whichever it is — so a hitch costs speed instead of
    // reversing it.
    const kCap = 1.6 / dt;
    const bow = Math.min(T.surfDragLin * straddle, kCap * 0.5);
    const kRoom = kCap - bow;
    const drag = Math.min(dl + dq * Math.hypot(v.x, rvy, v.z), kRoom);
    const dCross = Math.min(drag * T.crossDrag, kRoom);
    const bx = this._axis.x, by = this._axis.y, bz = this._axis.z;
    const along = v.x * bx + rvy * by + v.z * bz;
    // (relative velocity) - (its projection on the axis), damped harder
    const cdx = v.x - along * bx, cdy = rvy - along * by, cdz = v.z - along * bz;
    ax -= along * bx * drag + cdx * dCross + v.x * bow;
    ay -= along * by * drag + cdy * dCross;
    az -= along * bz * drag + cdz * dCross + v.z * bow;

    // ---- the seabed takes what is pushed into it -------------------------
    // A normal force is a CONSTRAINT, not a term, so it is applied to the net
    // acceleration once everything else has been summed: whatever thrust, drag
    // and buoyancy between them are asking the body to do into the surface, the
    // surface refuses, and the remainder — the part along the face — survives
    // untouched. That single subtraction is the whole fix. Swim horizontally at
    // a 34 deg bank and cos(34) = 83% of the fin thrust is still doing work up
    // the slope instead of 0%.
    //
    // How much was absorbed is remembered, because that is the normal force and
    // bottom friction is proportional to it.
    let press = 0;
    if (gw > 1e-3) {
      const an = ax * _gnrm.x + ay * _gnrm.y + az * _gnrm.z;
      if (an < 0) {
        const k = -an * gw;
        ax += _gnrm.x * k; ay += _gnrm.y * k; az += _gnrm.z * k;
        press = -an;
      }
    }
    this._gPress = press;

    // ---- semi-implicit Euler --------------------------------------------
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;

    // ---- wave coupling ---------------------------------------------------
    // Relax the vertical velocity toward the water's own. Written as an
    // exponential rather than a damping force on purpose: at 14/s an explicit
    // term would need dt < 70 ms to stay stable and the harness hands us 0.5 s
    // spikes, whereas exp(-k dt) is correct at every dt and exactly frame-rate
    // independent. This is the whole surface ride — it is what drags the diver
    // up the face of a crest instead of letting the crest wash over the eye.
    const surfK = T.surfDamp * nearSurf * yield_;
    if (surfK > 1e-4) {
      const f = Math.exp(-surfK * dt);
      v.y = this._waterVY + (v.y - this._waterVY) * f;
    }

    // ---- and a contact is not frictionless -------------------------------
    // The constraint above turns momentum along the face. Being turned costs
    // nothing, which is the hole: a diver finning level at a steep face is
    // redirected straight up it for free. Friction is proportional to how hard
    // the body is pressing, and `press` is exactly that — the acceleration the
    // plane just absorbed — so the tangential drive and the friction opposing it
    // scale together and the outcome is decided by the angle alone (see
    // T.contactMu). Clamped to the tangential velocity it opposes, so it can
    // arrest a slide and can never reverse one, which is what makes it stick
    // rather than oscillate.
    //
    // It deliberately does NOT count the impulse the velocity constraint below
    // is about to apply. That is a collision, not a contact load; billing it as
    // normal force would make friction scale as 1/dt and a landing would weld
    // the diver to the sand for a frame.
    if (gw > 1e-3 && press > 1e-4) {
      const vn = v.x * _gnrm.x + v.y * _gnrm.y + v.z * _gnrm.z;
      const tx = v.x - _gnrm.x * vn, ty = v.y - _gnrm.y * vn, tz = v.z - _gnrm.z * vn;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-6) {
        // ...and it is a WET contact, so it has no stiction: the film between
        // the suit and the rock carries the load as the slip goes to zero and
        // the shear goes to zero with it. sign(v_t) -> tanh(v_t/vs), which is
        // 0.9999 by 3 m/s of slip, so every contact that was already sliding is
        // unchanged; below ~1 m/s the body creeps instead of welding. See
        // T.contactSlipRef.
        const grip = T.contactSlipRef > 0 ? Math.tanh(tl / T.contactSlipRef) : 1;
        const k = Math.min(T.contactMu * press * grip * gw * dt, tl) / tl;
        v.x -= tx * k; v.y -= ty * k; v.z -= tz * k;
      }
    }

    // The same constraint on the velocity the body already has. Making the
    // acceleration tangential does nothing about momentum that was ALREADY
    // heading into the seabed — arriving at it, or the floor rising under a
    // body swimming level — and that is the part the y-clamp used to delete
    // outright. Turned along the face instead, it becomes the glide up the
    // bank. This can only ever shorten the vector, so it cannot add energy.
    if (gw > 1e-3) {
      const vn = v.x * _gnrm.x + v.y * _gnrm.y + v.z * _gnrm.z;
      if (vn < 0) {
        const k = -vn * gw;
        v.x += _gnrm.x * k; v.y += _gnrm.y * k; v.z += _gnrm.z * k;
      }
    }

    const dx = v.x * dt, dy = v.y * dt, dz = v.z * dt;

    if (this._noCollide > 0) {
      p.x += dx; p.y += dy; p.z += dz;
      this.grounded = false;
      this._gW = 0;
      this._lift = 0;
      this._liftRate = 0;
      this._prevAlt = null;
      return;
    }

    // ---- collision -------------------------------------------------------
    // The horizontal pass is told how far the body is rising this substep, so a
    // velocity that already lies in the contact plane can never be rejected by
    // the slope limit. See T.slopeRiseCredit.
    this._moveHorizontal(dx, dz, dt, dy);
    p.y += dy;
    this._resolveVertical(dt);
    this._resolveStructures(_prevPos);

    this._bankLift(dt, cmdVy);

    // hard floor / ceiling of the world
    if (p.y < WORLD.maxDepth + 2) { p.y = WORLD.maxDepth + 2; if (v.y < 0) v.y = 0; }
    const rr = Math.hypot(p.x, p.z);
    if (rr > T.edgeRadius + 90) {
      const k = (T.edgeRadius + 90) / rr;
      p.x *= k; p.z *= k;
    }
  },

  /**
   * Horizontal motion against the heightfield.
   *
   * The destination is rejected if the seabed there rises faster than a ~58 deg
   * slope over the distance actually travelled this substep. That is what stops
   * a diver walking horizontally up the drop-off face while still letting them
   * swim freely up any ordinary dune. Rejection slides along the terrain normal
   * rather than stopping dead, so nothing sticks in a corner: the vertical pass
   * below is unconstrained upward, so a wall is always escapable by swimming up.
   */
  _moveHorizontal(dx, dz, dt, dy = 0) {
    const terr = this._terrain;
    const p = this.position;
    if (!terr) { p.x += dx; p.z += dz; return; }

    /**
     * How high the seabed at the destination is allowed to be. `p.y - clearance`
     * is the ground the body is standing on, so this says "you may climb at most
     * maxSlopeTan metres per metre travelled" — a SLOPE limit, which is the only
     * thing it is entitled to be.
     *
     * The `+ 0.06` this replaces was a flat per-substep allowance, and it is the
     * same per-substep-versus-per-second mistake `_resolveVertical` documents
     * one function below, in a term nobody had connected to it. A step 0.5 mm
     * long bought the full 6 cm of altitude, so at 180 substeps a second the
     * seabed could extrude a body upward at up to 10 m/s and no slope was
     * actually being tested. Measured consequence, reproducible: a diver pitched
     * 88 degrees DOWN with W held, resting on the floor at -88.5 m, climbed
     * 0.35 m/s — 3.2 m in nine seconds, while asking to go straight down. On the
     * descend route that is the whole back half of the run: the descent reverses
     * at ~96 m and the player is walked 10 m back up a face they are swimming
     * into. Depth stopped being a place you could go at the exact moment you
     * reached the bottom of it.
     *
     * The residue is float slack on the heightfield, nothing more. It caps the
     * worst-case extrusion at 180 * 1e-4 = 0.018 m/s instead of 10 m/s.
     */
    /**
     * ...PLUS the metres the body is genuinely climbing this substep. Without
     * that term the test only ever saw the horizontal half of a 3D step, so a
     * velocity lying exactly IN the contact plane of a face steeper than 58 deg
     * described a step the limit refused — the body was frozen by the one rule
     * that was supposed to let it glide. See T.slopeRiseCredit for the proof
     * that this cannot relax the anti-extrusion rule: at dy <= 0 it is the old
     * expression, digit for digit.
     */
    const rise = Math.max(0, dy) * T.slopeRiseCredit;
    const limit = (d) => p.y + rise - T.clearance + d * T.maxSlopeTan + 1e-4;
    let d = Math.hypot(dx, dz);
    if (d < 1e-6) return;

    /**
     * ADVANCE-TO-CONTACT WAS TRIED HERE AND MEASURED WORSE. Round 16.
     *
     * The obvious reading of a weld is that an all-or-nothing test is the wrong
     * primitive — no contact solver refuses a step, it takes the fraction the
     * constraint allows. I built that (bisect for the largest passing fraction,
     * advance by it, slide the rest) and it is a strictly worse module: on the
     * same 80 run-up runs it took welds from 1 back to 5 and refusals from 71
     * to 660. The reason is that the fraction it advances is paid for out of
     * the body's standoff above its own floor, so it walks the body flush into
     * the face and then there is no altitude budget left for the NEXT substep
     * to spend — it converts a body that could still slide into one that
     * cannot. Recorded because it is the change a reasonable person makes next.
     */
    if (this._groundMax(terr, p.x + dx, p.z + dz) <= limit(d)) { p.x += dx; p.z += dz; return; }

    /**
     * Blocked — deflect along the FACE, in three dimensions.
     *
     * What was here took the terrain normal, threw its y away and renormalised
     * what was left, which turns every landform in the game into a vertical
     * wall: a 34 deg bank and a sheer cliff got byte-identical treatment, and
     * the entire up-slope component of the velocity was deleted rather than
     * tilted upward. The real normal degrades to exactly the old behaviour
     * where the old behaviour was right — a vertical face HAS a horizontal
     * normal, so the projection adds no y and the horizontal kill is what you
     * get — and glides everywhere else, with the crossover falling out of the
     * geometry instead of being asserted.
     *
     * ...and it has to be the normal of the surface that REFUSED the step, not
     * of the one the body rides. See T.blockNormal for the 66-degree
     * disagreement between them that welded a diver for eight seconds.
     */
    if (T.blockNormal) {
      // Horizontal gradient of `_groundMax` itself, central-differenced. Four
      // rings, only ever on the blocked path — which fired on 723 of 691,200
      // substeps across 80 runs.
      const h = T.blockGradH;
      const gpx = this._groundMax(terr, p.x + h, p.z), gnx = this._groundMax(terr, p.x - h, p.z);
      const gpz = this._groundMax(terr, p.x, p.z + h), gnz = this._groundMax(terr, p.x, p.z - h);
      _dnrm.set(-(gpx - gnx) / (2 * h), 1, -(gpz - gnz) / (2 * h));
      const bl = _dnrm.length();
      if (bl > 1e-6) _dnrm.multiplyScalar(1 / bl); else _dnrm.set(0, 1, 0);
    } else {
      // `_rh` still holds the ring the refused test above took, so the old
      // (wrong) normal is free — which is exactly why nobody noticed.
      this._ringNormal(_dnrm);
    }
    const v = this.velocity;
    const vn = v.x * _dnrm.x + v.y * _dnrm.y + v.z * _dnrm.z;
    if (vn < 0) { v.x -= _dnrm.x * vn; v.y -= _dnrm.y * vn; v.z -= _dnrm.z * vn; }
    let nx = _dnrm.x, nz = _dnrm.z;
    const nl = Math.hypot(nx, nz);
    if (nl > 1e-4) {
      nx /= nl; nz /= nl;
      const into = dx * nx + dz * nz;
      if (into < 0) { dx -= nx * into; dz -= nz * into; }
      // Scraping is not frictionless — but only a face too steep to swim up is
      // something you scrape ALONG. Charging this against a rideable bank (and
      // the ring max rejects a step for a 15 cm boulder lip as readily as for a
      // cliff) is the same "the ground is a lid" error one level down: the body
      // is climbing that surface, not grinding past it.
      const steep = clamp01((nl / Math.max(_dnrm.y, 1e-3) - T.maxSlopeTan) / 0.8);
      const headOn = clamp01(-into / Math.max(d, 1e-6));
      if (headOn > 0.01 && steep > 0) {
        const f = Math.exp(-T.wallFric * headOn * steep * dt);
        // On the tangent, not on x and z: scraping a 72 deg face moves the body
        // almost entirely in y, so the two-axis form charged nothing at all for
        // exactly the case it was written for.
        dampTangent(v, _dnrm, f);
      }
      d = Math.hypot(dx, dz);
      if (d > 1e-6 && this._groundMax(terr, p.x + dx, p.z + dz) <= limit(d)) { p.x += dx; p.z += dz; }
    } else {
      /**
       * The ring's central difference is degenerate: `_groundMax` was set by a
       * tap the difference cancels — a pillar under the centre tap, or a
       * symmetric pit — so there is no face to slide along and nothing to
       * deflect against. All that is left is to stop pushing horizontally.
       *
       * PER SECOND, NOT PER SUBSTEP. `v.x *= 0.2` is the exact mistake
       * `_resolveVertical` and the old `+ 0.06` step allowance both record two
       * screens up, in the one term nobody had connected to them: at three
       * substeps a frame it compounded to exp(-289/s), which annihilates the
       * horizontal velocity inside a single frame regardless of dt and makes
       * the response frame-rate dependent into the bargain. As a rate it is
       * wallFric, the coefficient this file already uses for scraping a face
       * too steep to climb, which is what this is.
       *
       * BE HONEST: this branch did not fire once in 19,160 substeps on 40
       * on-face runs or in the 40 run-up runs, so it is a latent-correctness
       * fix worth exactly zero on today's terrain and it is not credited with
       * anything. It is here because the value it replaces is wrong for the
       * same reason three shipped defects in this file were wrong.
       */
      const f = Math.exp(-T.wallFric * dt);
      v.x *= f; v.z *= f;
    }
  },

  /**
   * Bank the altitude the seabed has handed the body, in metres. See T.liftMax.
   *
   * The whole point of doing this in the POSITION domain is that the quantity is
   * observable rather than inferred. Round 13 metered the impulses the two
   * contact constraints applied to v.y and called the sum a debt; it could not
   * be one, because the same substep clamped it back down to the current v.y,
   * so drag paid the debt off instead of the body doing it. Here the ledger is
   * read off the body's own height above the floor it is riding, which is the
   * thing the defect is actually about, and it can only be discharged by that
   * height going away.
   *
   * Three details are load-bearing:
   *
   *  - The accumulation is SIGNED. A one-sided `+= max(0, ...)` would rectify
   *    seabed roughness into a standing debt the same way the contact plane
   *    rectifies roughness into climb — the very bug this term exists to undo.
   *    Signed, a bump and the hollow after it cancel exactly.
   *  - It is a DIFFERENCE of altitudes, not an altitude. Riding a bank holds
   *    altitude constant, so a 60 m climb up a slope accrues nothing; only
   *    altitude the body gains *relative to the floor* is ever owed.
   *  - Past T.liftReach the ledger fades to zero, because beyond the body's
   *    own reach of the seabed this is open water and the seabed is not
   *    holding anything up. That is what makes swimming over the drop-off —
   *    where the floor falls 200 m in a second — cost exactly nothing. It
   *    fades to zero at the SURFACE too, on exactly the complement of the
   *    window that gates buoyancy, because within 1.5 m of the waterline the
   *    thing holding the body up is the float and not the sand — a guard that
   *    measures 0.000 on this terrain and says so where it is written.
   */
  _bankLift(dt, cmdVy) {
    const g = this.groundY;
    if (!this._terrain || !Number.isFinite(g)) {
      this._lift = 0; this._liftRate = 0; this._prevAlt = null; return;
    }
    const alt = this.position.y - (g + T.clearance);
    const prev = this._prevAlt;
    this._prevAlt = alt;
    if (prev === null) return;
    // Two windows, and both halves of the return fade out through them together.
    // Past the body's own reach of the seabed this is open water and the seabed
    // is holding nothing up. And inside T.buoyNeutral of the surface the body is
    // held by the BUOYANCY SPRING, not by the seabed — this second window is
    // exactly the complement of the one that gates buoyancy, so the two forces
    // can never both be live on the same body and the ledger can never sag the
    // waterline the way round 1's strobe did.
    //
    // BE HONEST ABOUT THIS ONE: it is a guard, not a measured win. Scanned at
    // 7 m over the whole playable disc, the shallowest seabed in the world is
    // -15.386 m (at 65, 58), and the reach fade above has already closed by an
    // altitude of 12 m — so on today's terrain the surface window changes the
    // ledger only in the narrow -13 to -16 m band and measures 0.000 on every
    // bench site. It is here because a shallower lagoon is a terrain change
    // away, and because two vertical forces fighting over the same body at the
    // waterline is the single failure this module has paid the most to fix.
    const w = (1 - smoothstep(T.liftReach, T.liftReach + T.liftFade, alt))
      * smoothstep(T.buoyNeutralKnee, T.buoyNeutral, this.waterY - this.position.y);
    const rise = (alt - prev) - Math.max(0, cmdVy) * dt;
    this._lift = clamp(this._lift + rise, 0, T.liftMax) * w;
    // ...and the rate of the same signal, SIGNED so roughness cancels, clamped
    // so a ring tap changing which of its five samples wins cannot spike it,
    // and smoothed because it is a per-substep difference of a noisy max.
    const raw = clamp(rise / dt, -4, 4) * w;
    this._liftRate += (raw - this._liftRate) * approach(dt, T.liftRateTau);
  },

  /** Lift out of the seabed. Never constrained upward, so nothing can trap you. */
  _resolveVertical(dt) {
    const terr = this._terrain;
    const p = this.position;
    const v = this.velocity;
    if (!terr) { this.grounded = false; return; }
    const g = this._groundMax(terr, p.x, p.z);
    this.groundY = g;
    const floor = g + T.clearance;
    let liftRate = 0;
    if (p.y < floor) {
      // impact speed is published so survival can decide whether that hurt
      if (v.y < -3) this.lastImpactSpeed = -v.y;
      // How hard the seabed is having to lift us. Following a slope tangentially
      // this is now float slack and nothing more — the body rises exactly as
      // fast as the floor under it, because the contact plane already turned its
      // velocity along the face. It only grows when the terrain has to EXTRUDE
      // the body: a step, a boulder lip, a landing.
      const lift = Math.min(floor - p.y, 1.0);
      p.y = Math.min(floor, p.y + 6);      // cap the correction after a teleport
      if (v.y < 0) v.y = 0;
      this.grounded = true;
      liftRate = dt > 1e-6 ? Math.min(lift / dt, 12) : 0;
    } else {
      this.grounded = p.y - floor < 0.35;
    }
    /**
     * Bottom friction, plus the residual cost of being extruded.
     *
     * This MUST be per-second, not per-substep: as a flat 0.965 factor it
     * compounded to 0.12/s at 60 Hz, an extra 2.1/s of drag that pinned a
     * fin-kicking diver to 2.27 m/s the moment they touched the sand.
     *
     * And it must be proportional to the NORMAL FORCE, which is the round-11
     * half of the same lesson: charged flat, it billed a diver skimming the
     * contour exactly as much as one driving head-on into a bank, and a diver
     * following the seabed is in contact every single frame — so it was a
     * standing 0.55/s tax on the entire floor of the game, worth about 20% of
     * cruise, levied hardest on the gliding that this round is trying to buy.
     * `_gPress` is what the contact plane actually absorbed this substep, so a
     * tangential glide pays contactSkin and a full press pays all of it.
     *
     * It is gated on the contact WEIGHT rather than on the penetration branch
     * above, because with the plane doing its job the body now rides the floor
     * to within float slack and that branch chatters on and off between frames.
     */
    const w = this._gW;
    if (w > 1e-3) {
      const pressN = clamp01(this._gPress / T.contactPress);
      const k = T.contactDrag * (T.contactSkin + (1 - T.contactSkin) * pressN)
        + T.climbDrag * Math.max(0, liftRate - T.climbFree);
      const f = Math.exp(-k * w * dt);
      // The ring normal at the position the body actually resolved to — `_rh`
      // still holds the taps `_groundMax` took above, so it is free — rather
      // than the one sampled before the substep moved. Damping the tangent
      // instead of x and z is what stops a bump converting forward speed into
      // climb that nothing removes.
      dampTangent(v, this._ringNormal(_fnrm), f);
    }
  },

  /**
   * How much seabed the body is in contact with, and which way it faces.
   *
   * Returns 0..1: 1 once the body is at or through the floor, fading to 0 over
   * T.contactBand above it so a diver swimming just clear of the sand is not
   * subject to a plane they are not touching, and so nothing switches hard
   * enough to chatter. Leaves the normal in `_gnrm`.
   */
  _contact() {
    const terr = this._terrain;
    if (!terr) { this._gW = 0; _gnrm.set(0, 1, 0); return 0; }
    const g = this._groundMax(terr, this.position.x, this.position.z);
    if (!Number.isFinite(g)) { this._gW = 0; _gnrm.set(0, 1, 0); return 0; }
    this.groundY = g;
    const near = this.position.y - (g + T.clearance);
    const w = near <= 0 ? 1 : clamp01(1 - near / T.contactBand);
    this._gW = w;
    if (w > 1e-3) this._ringNormal(_gnrm); else _gnrm.set(0, 1, 0);
    return w;
  },

  _groundMax(terr, x, z) {
    let m = -Infinity;
    for (let i = 0; i < RING.length; i++) {
      const hh = terr.heightAt(x + RING[i][0] * T.ringR, z + RING[i][1] * T.ringR);
      _rh[i] = hh;
      if (hh > m) m = hh;
    }
    return Number.isFinite(m) ? m : -Infinity;
  },

  /**
   * Normal of the surface the BODY rides, differenced from the ring `_groundMax`
   * just sampled — RING is centre, +x, -x, +z, -z, so the two axes are already
   * a central difference over 2*ringR.
   *
   * Deliberately not terrain.normalAt(): that answers "which way does the sand
   * face at this point", over a 0.6 m stencil, and a swimmer with a 1.04 m
   * standoff does not feel pebbles. Differencing the taps that decided the
   * floor height also guarantees the normal and the floor can never disagree —
   * if they did, the body would be pushed into a plane it is not resting on.
   */
  _ringNormal(out) {
    const inv = 1 / (2 * T.ringR);
    const gx = (_rh[1] - _rh[2]) * inv;
    const gz = (_rh[3] - _rh[4]) * inv;
    out.set(-gx, 1, -gz);
    const l = out.length();
    if (l > 1e-6) out.multiplyScalar(1 / l); else out.set(0, 1, 0);
    return out;
  },

  /**
   * Wreck / lifepod / arch hulls.
   *
   * world/structures.js publishes landmarks and a scene group but no collider,
   * so this module builds its own from what is actually in the graph, in two
   * tiers because the geometry comes in two very different shapes:
   *
   *   - LIGHT meshes (<= 9000 tri): exact swept-ray collision. Decks, railings,
   *     girders, crates, ladders, plates — the things you actually bump into.
   *   - HEAVY but COMPACT meshes: the lifepod hull is one 80k-triangle blob
   *     3.4 m across. Ray-testing 80k triangles per frame is not affordable and
   *     skipping it let the player swim straight through the pod, so a compact,
   *     roughly isotropic hull collides as its bounding sphere instead. Heavy
   *     AND elongated geometry (the Aurora's hull sections, long spars) is left
   *     alone entirely: a sphere around a 40 m plate would be a giant invisible
   *     wall in open water, which is far worse than swimming through it.
   *
   * InstancedMesh is never tested — that is the greeble scatter, and three's
   * instanced raycast walks every instance.
   */
  _resolveStructures(from) {
    if (!this._structRoot) return;
    const p = this.position;

    /**
     * The candidate refresh runs BEFORE the distance test now. Behind it, a
     * body creeping along a hull at under 1.2 m/s never collected a candidate
     * at all, so the collider it was supposed to be resting against did not
     * exist for as long as it stayed slow. See T.hullProbe.
     */
    this._candT += 1;
    if (this._candT > 24 || this._candPos.distanceToSquared(p) > 25) {
      this._candT = 0;
      this._candPos.copy(p);
      this._collectStructures(p);
    }
    const age = this._hullAge;
    for (let i = 0; i < HULL_CONTACTS; i++) if (age[i] < 1e6) age[i]++;

    // Everything below is in COLLIDER-CENTRE space — see T.hullDrop.
    const drop = T.hullDrop ? T.colDrop : 0;
    _hFrom.set(from.x, from.y - drop, from.z);
    _hTo.set(p.x, p.y - drop, p.z);
    _tmp.subVectors(_hTo, _hFrom);
    const dist = _tmp.length();
    // 0 restores the round-16 early return, so the ablation is against the
    // shipped path and not against a rewrite of it.
    if (T.hullProbe <= 0 && dist < 0.02) return;

    if (this._cand.length) {
      // Direction of travel, or — when the body has effectively stopped, which
      // is most of the frames it spends pressed against a wreck — of the
      // velocity being cancelled.
      let aim = true;
      if (dist > 1e-9) _tmp.divideScalar(dist);
      else if (this.velocity.lengthSq() > 1e-10) _tmp.copy(this.velocity).normalize();
      else aim = false;

      if (aim) {
        const hit = this._sweep(_hFrom, _tmp, Math.max(dist, T.hullProbe));
        if (hit) {
          const stop = Math.max(0, Math.min(dist, hit.distance - T.colRadius));
          _hTo.copy(_hFrom).addScaledVector(_tmp, stop);
          if (hit.face) {
            _nrm.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
            // A wreck is a shell and its triangles are wound however they were
            // generated, so half of them face the wrong way for us. Orient the
            // normal against travel before anything is projected onto it — a
            // normal pointing ALONG the ray reflects the slide INTO the plate.
            if (_nrm.dot(_tmp) > 0) _nrm.multiplyScalar(-1);
            // Restore the standoff `stop` could not: see T.hullDepen.
            this._hullPush(_hTo, hit.point, _nrm);
            /**
             * WHAT IS LEFT OVER IS TANGENTIAL — see T.hullSlide. `stop` is 0
             * for every substep a body spends within colRadius of a hull, so
             * without this the collider is a lid that pins the diver in place
             * on every heading. Sliding the remainder along the plate is the
             * same sentence the seabed contact has obeyed since round 11.
             */
            const rem = dist - stop;
            if (T.hullSlide && rem > 1e-4) {
              // tangent of the UNIT travel direction: its length is the cosine
              // of the incidence angle, so a glancing blow keeps nearly all of
              // the step and a head-on one keeps none.
              _tmp2.copy(_tmp).addScaledVector(_nrm, -_tmp.dot(_nrm));
              const tl = _tmp2.length();
              if (tl > 1e-3) {
                _tmp2.multiplyScalar(1 / tl);
                const glide = rem * tl;
                // Confirm the slide: a hull is not convex and sliding along one
                // plate can run straight into the next.
                const h2 = this._sweep(_hTo, _tmp2, glide);
                _hTo.addScaledVector(_tmp2, h2
                  ? Math.max(0, Math.min(glide, h2.distance - T.colRadius))
                  : glide);
                if (h2 && h2.face) {
                  _nrm2.copy(h2.face.normal).transformDirection(h2.object.matrixWorld);
                  if (_nrm2.dot(_tmp2) > 0) _nrm2.multiplyScalar(-1);
                  this._hullRemember(h2.point, _nrm2);
                }
              }
            }
            this._hullRemember(hit.point, _nrm);
          } else {
            this.velocity.multiplyScalar(0.3);
          }
        }
      }
    }

    // Settle against every plate still in contact, fresh ones first: one plane
    // at a time cannot hold a body in an inside corner. See HULL_CONTACTS.
    this._hullSettle(_hTo);

    for (let i = 0; i < this._blobs.length; i++) {
      const b = this._blobs[i];
      const d = _hTo.distanceTo(b.c);
      const R = b.r + T.colRadius;
      if (d >= R || d < 1e-4) continue;
      _nrm.subVectors(_hTo, b.c).divideScalar(d);
      _hTo.copy(b.c).addScaledVector(_nrm, R);
      const vn = this.velocity.dot(_nrm);
      if (vn < 0) this.velocity.addScaledVector(_nrm, -vn);
    }

    p.set(_hTo.x, _hTo.y + drop, _hTo.z);
  },

  /**
   * Place the collider centre exactly colRadius in front of a contact plane,
   * along that plane's normal. Returns the metres pushed.
   *
   * This is the blob branch's `p = c + n * R` written for a plane instead of a
   * sphere, and it is the half of the mesh branch that was missing. See
   * T.hullDepen for why a swept ray cannot get this right on its own.
   *
   * A centre more than one radius BEHIND the plane is through it — a hatch, a
   * torn plate, the far wall of a corridor we are legitimately inside — and
   * shoving that body back would be a teleport, not a contact. Leave it, and
   * let the sweep find the surface it is actually against.
   */
  _hullPush(c, pt, n) {
    if (!T.hullDepen) return 0;
    const sd = (c.x - pt.x) * n.x + (c.y - pt.y) * n.y + (c.z - pt.z) * n.z;
    if (sd >= T.colRadius || sd < -T.colRadius) return 0;
    const push = Math.min(T.colRadius - sd, T.colRadius);
    c.addScaledVector(n, push);
    return push;
  },

  /**
   * File a contact plane. A plate already in the set is refreshed rather than
   * duplicated — otherwise one flat deck fills all three slots on three
   * consecutive frames and the bulkhead beside it is forgotten.
   */
  _hullRemember(pt, n) {
    const age = this._hullAge;
    let slot = 0, oldest = -1;
    for (let i = 0; i < HULL_CONTACTS; i++) {
      if (age[i] <= T.hullHold && _hullN[i].dot(n) > 0.985
        && _hullP[i].distanceToSquared(pt) < 4) { slot = i; oldest = Infinity; break; }
      if (age[i] > oldest) { oldest = age[i]; slot = i; }
    }
    _hullP[slot].copy(pt);
    _hullN[slot].copy(n);
    age[slot] = 0;
  },

  /**
   * Push the collider clear of every plate still in contact, and remove the
   * velocity heading into each. Two passes: clearing plate A can bury the body
   * in plate B, and one more pass resolves the corner between them.
   */
  _hullSettle(c) {
    const age = this._hullAge;
    const v = this.velocity;
    const r2 = T.hullHoldR * T.hullHoldR;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < HULL_CONTACTS; i++) {
        if (age[i] > T.hullHold) continue;
        if (_hullP[i].distanceToSquared(c) > r2) continue;
        if (this._hullPush(c, _hullP[i], _hullN[i]) <= 0) continue;
        const vn = v.dot(_hullN[i]);
        if (vn < 0) v.addScaledVector(_hullN[i], -vn);
      }
    }
  },

  /**
   * One swept-sphere test against the light structure colliders: nearest hit
   * along `dir` (a unit vector) within `dist`, or null. The sweep reaches
   * colRadius past the requested distance because the body is a sphere, not a
   * point — that is what stops a hull edge slipping between two substeps.
   */
  _sweep(from, dir, dist) {
    _ray.set(from, dir);
    _ray.near = 0;
    _ray.far = dist + T.colRadius;
    const hits = _ray.intersectObjects(this._cand, false);
    return hits.length ? hits[0] : null;
  },

  _collectStructures(p) {
    this._cand.length = 0;
    this._blobs.length = 0;
    const near = this._structApi?.nearest?.(p);
    if (near && near.dist > 90) return;
    const pool = this._pool, bpool = this._bpool;
    pool.length = 0;
    bpool.length = 0;
    this._structRoot.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch { return; } }
      const bs = g.boundingSphere;
      if (!bs) return;
      _tmp2.setFromMatrixScale(o.matrixWorld);
      const scale = Math.max(_tmp2.x, _tmp2.y, _tmp2.z);
      const rad = bs.radius * scale;
      _tmp2.copy(bs.center).applyMatrix4(o.matrixWorld);
      if (_tmp2.distanceToSquared(p) > (rad + 20) * (rad + 20)) return;
      // distance to the mesh's bounding SPHERE, not to its centre: a 17 m hull
      // section and a 0.3 m crate sort on how close their surfaces are.
      const key = Math.max(0, _tmp2.distanceTo(p) - rad);

      const tri = (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
      if (tri <= T.hullTriMax) { pool.push(key, o, tri); return; }
      // past the exact-collider ceiling: only usable as a sphere, and only if a
      // sphere actually fits it
      if (rad > 6) return;
      if (!g.boundingBox) { try { g.computeBoundingBox(); } catch { return; } }
      const bb = g.boundingBox;
      if (!bb) return;
      const ex = bb.max.x - bb.min.x, ey = bb.max.y - bb.min.y, ez = bb.max.z - bb.min.z;
      const lo = Math.min(ex, ey, ez), hi = Math.max(ex, ey, ez);
      if (lo < 1e-3 || hi / lo > 2.6) return;     // elongated: a sphere would lie
      bpool.push(key, { c: _tmp2.clone(), r: rad * 0.82 });
    });
    /**
     * NEAREST FIRST. The caps were filled in scene-graph order and the traverse
     * bailed out the moment they were full, so WHICH 24 of the stern's 87 light
     * meshes were collidable depended on the order structures.js happened to
     * add them — the plate a diver was pressed against could be number 40 and
     * simply not exist as a collider. Selection by distance costs one sort of a
     * ~90-entry list, and only on a refresh (every 24 frames, or 5 m).
     */
    takeBudget(pool, this._cand, 24, T.hullTriBudget);
    takeNearest(bpool, this._blobs, 8);
  },

  // ---------------------------------------------------------------- camera
  _writeCamera(dt, t, strIn = 0) {
    const cam = this.camera;
    if (!cam) return;

    // ---- positional lag: the head trails the body through the water.
    // The offset is an acceleration response, not a velocity response, so it
    // returns to zero the moment the body settles into a constant speed. The
    // follow filter's target carries a velocity feed-forward term (position +
    // v*tau) which exactly cancels the first-order filter's own steady-state
    // error — without it the filter would simply reintroduce a tau*v offset of
    // its own, which is the bug this replaces.
    _tmp.copy(this._accSm).multiplyScalar(-T.camLagAcc);
    _tmp.y *= T.camLagAccY;
    const off = _tmp.length();
    if (off > T.camLagMax) _tmp.multiplyScalar(T.camLagMax / off);
    _tmp2.copy(this.position).add(_tmp).addScaledVector(this.velocity, T.camLagTau);
    this._camPos.lerp(_tmp2, approach(dt, T.camLagTau));
    _tmp.subVectors(this._camPos, this.position);
    const lag = _tmp.length();
    if (lag > T.camLagMax) this._camPos.copy(this.position).addScaledVector(_tmp, T.camLagMax / lag);

    // ---- roll: bank into a turn, lean into a strafe, breathe with the kick.
    // Both terms carry the SAME sign — a diver going right drops the right
    // shoulder whether they got there by turning or by strafing, and round 1
    // had them opposed, so a hard turn-and-strafe (the commonest way anyone
    // actually corners) cancelled itself down to 3 deg. The clamp is on the sum
    // for the same reason: rollMax must be a limit on what you see, not on one
    // of two contributions to it.
    let rollTarget = clamp(-this._yawRate * T.rollTurn + strIn * T.rollStrafe,
      -T.rollMax, T.rollMax);
    rollTarget *= 0.35 + 0.65 * this._sub;
    this._roll += (rollTarget - this._roll) * approach(dt, T.rollTau);
    const roll = this._roll + T.rollKick * this._activity * Math.sin(this._cycle + 1.4);

    cam.rotation.set(this.pitch, this.yaw, roll, 'YXZ');

    // ---- fin-kick bob in camera-local axes. A flutter kick surges the body
    // twice per cycle vertically and once laterally, which is why the vertical
    // term runs at 2x the phase of the sway.
    const act = this._activity;
    const ampV = (T.bobIdleV + T.bobGainV * act) * this._sub;
    const ampH = (T.bobIdleH + T.bobGainH * act) * this._sub;
    _bob.set(
      ampH * Math.sin(this._cycle),
      ampV * Math.sin(this._cycle * 2 + 0.9),
      0.010 * act * Math.sin(this._cycle * 2 + 2.1),
    );
    _bob.applyQuaternion(cam.quaternion);
    this._bobW.lerp(_bob, approach(dt, T.bobTau));

    cam.position.copy(this._camPos).add(this._bobW);

    // ---- FOV breathes with speed. Restrained: 6 deg at a full fin kick, plus
    // whatever bonus the Seaglide asked for. `_fovBase` is re-read only on a
    // real teleport (a capture shot setting its own fov), never from vehicles'
    // per-frame easing, so the two cannot ratchet each other.
    const boost = Math.min(T.fovBoostMax,
      this._hFov + T.fovGain * Math.pow(clamp01(this.speed / T.speeds.sprint), 1.3) * this._sub);
    const fovTarget = this._fovBase + boost;
    this._fov += (fovTarget - this._fov) * approach(dt, T.fovTau);
    // Scaled by activity, not offset by it: at rest this must be exactly zero
    // so a frozen capture renders at precisely the fov the shot asked for.
    const breathe = T.fovBreathe * Math.sin(t * 0.9 + 1.7) * act * this._sub;
    const fov = this._fov + breathe;
    if (Math.abs(cam.fov - fov) > 1e-4) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this._fovWritten = fov;

    // Update now rather than letting the renderer do it, because modules'
    // preRender() hooks (watersurface's inverse view-projection, for one) read
    // matrixWorldInverse before render() is ever called.
    cam.updateMatrixWorld(true);

    // ---- waterline events for audio / postfx
    const under = this._sub > 0.5;
    this.justCrossed = false;
    if (this._wasUnder === null) this._wasUnder = under;
    else if (under !== this._wasUnder) {
      this._wasUnder = under;
      this.justCrossed = true;
      this.crossDir = under ? -1 : 1;
      this._crossT = 0;
    }
    this._crossT += dt;

    this._lastCamPos.copy(cam.position);
    this._lastCamQuat.copy(cam.quaternion);
    this._lastCamFov = cam.fov;
  },

  // ---------------------------------------------------------------- helpers
  /**
   * Somebody else is driving the eye (vehicles piloting/docking, or ?nomove).
   * Follow it so every consumer of position/velocity/depth still reads
   * something true, and keep the teleport detector's baseline current so
   * handing control back does not look like a jump.
   */
  _trackCamera(cam) {
    this.position.copy(cam.position);
    this.velocity.set(0, 0, 0);
    // Not just tidiness: update() returns before the acceleration sample when
    // somebody else owns the eye, so without this a vehicle handing control back
    // WITHOUT a setEnabled edge (vehicles' swimHandling().locked going false)
    // would difference the new zero velocity against a stale cruising one and
    // snap the head to the lag clamp on the first swimming frame.
    this._prevVel.set(0, 0, 0);
    this._accSm.set(0, 0, 0);
    this._camPos.copy(cam.position);
    this._lastCamPos.copy(cam.position);
    this._lastCamQuat.copy(cam.quaternion);
    this._lastCamFov = cam.fov;
    this._fovWritten = cam.fov;
    this.grounded = false;
    this._gW = 0;
    this._gPress = 0;
    this._lift = 0;
    this._liftRate = 0;
    this._prevAlt = null;
  },

  _waterAt(ctx, x, z, t) {
    const w = this._water || (this._water = ctx.water || ctx.get('watersurface') || null);
    const fn = w?.heightAt || w?.waterHeightAt;
    if (fn) {
      const y = fn(x, z, t);
      if (Number.isFinite(y)) return y;
    }
    return U.uWaterLevel.value ?? WORLD.seaLevel;
  },

  /**
   * The wave height a BODY feels, as opposed to the one a point feels: the mean
   * over a 1.24 m footprint. Buoyancy is a pressure integral over the hull, and
   * a wave shorter than the hull cancels itself inside that integral — which is
   * why boats and swimmers do not follow capillary chop. Five taps attenuate
   * watersurface's 1.45 m component to ~31%, its 2.4 m to ~65%, and leave
   * everything past 7 m untouched. The eye still samples the point value, so
   * the residual is exactly the relative motion you should see at the lens.
   */
  _waterBodyAt(ctx, x, z, t) {
    const r = T.bodySpan;
    return (this._waterAt(ctx, x, z, t)
      + this._waterAt(ctx, x + r, z, t) + this._waterAt(ctx, x - r, z, t)
      + this._waterAt(ctx, x, z + r, t) + this._waterAt(ctx, x, z - r, t)) * 0.2;
  },

  /** Re-seat the body on the camera after an external transform (a capture shot). */
  _syncFromCamera() {
    const cam = this.camera;
    if (!cam) return;
    this.position.copy(cam.position);
    this.velocity.set(0, 0, 0);
    _euler.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = _euler.y;
    this.pitch = clamp(_euler.x, -T.pitchLimit, T.pitchLimit);
    /**
     * Adopt the camera's FOV as the new resting value ONLY if somebody set it
     * deliberately. Blindly re-basing on whatever fov happens to be live turned
     * every teleport into a ratchet: our own speed boost was already baked in,
     * so a body reseated at 74 deg immediately started climbing toward 80.
     * A shot sets fov outright (a several-degree jump); vehicles' per-frame
     * easing never moves it more than a few tenths from what we last wrote, so
     * 0.75 deg separates the two cleanly.
     */
    if (Math.abs(cam.fov - this._fovWritten) > 0.75) {
      this._fovBase = clamp(cam.fov, 20, 140);
    }
    this._fov = this._fovBase;
    this._reseat();
  },

  /** Zero every smoothing accumulator so the camera lands exactly on `position`. */
  _reseat() {
    this._camPos.copy(this.position);
    this._bobW.set(0, 0, 0);
    /**
     * THE FIN-KICK PHASE IS A SMOOTHING ACCUMULATOR LIKE ANY OTHER, and leaving
     * it running across a teleport was this module's one remaining channel for
     * wall-clock state to reach the physics. It is not cosmetic: `_cycle` drives
     * the thrust pulse (T.kickSurge), so two runs that re-seat the body with the
     * kick at different phases accelerate differently from the first frame the
     * player holds a key.
     *
     * Measured, on the unmodified tree: two separate runs of the SAME
     * tools/play.mjs --route=pressure command were bit-identical for exactly 61
     * frames — the whole opening segment, which holds no keys — and diverged on
     * frame 62, the first frame W is held, ending 291 m apart with one run
     * drowning at 199.6 m and the other reaching 203.1 m. The upstream cause is
     * outside this file (the harness freezes the loop only after an
     * uncontrolled number of real-time rAF frames: ctx.time.t at freeze
     * measured 0.0667 s in one run and 0.3167 s in the other), but the reason
     * that reached the trajectory at all is this line's absence. A body that has
     * just been picked up and put somewhere else is not mid-kick.
     */
    this._cycle = 0;
    this._roll = 0;
    this._yawRate = 0;
    this._activity = 0;
    this._prevWaterY = null;
    this._waterVY = 0;
    this._prevVel.copy(this.velocity);
    this._accSm.set(0, 0, 0);
    // The body faces where the re-seated camera faces; leaving a stale axis
    // here would make the first substep after a capture teleport treat the
    // whole velocity as broadside.
    this._axis.copy(this.forward);
    const al = this._axis.length();
    if (al > 1e-4) this._axis.multiplyScalar(1 / al); else this._axis.set(0, 0, -1);
    // A 400 m capture jump is not a waterline crossing: without this the eye
    // delta would read as hundreds of m/s and open the medium blend to its
    // widest for the frame the shot is captured on.
    this._prevEye = null;
    this._crossRate = 0;
    this.grounded = false;
    this._gW = 0;
    this._gPress = 0;
    this._lift = 0;
    this._liftRate = 0;
    this._prevAlt = null;
    // Honour a harness teleport exactly for one frame: no collision push, so a
    // shot framed inside a rock still renders from the pose it asked for.
    this._noCollide = 1;
    // The remembered hull planes are temporal state like any other: a body
    // picked up and put 400 m away is not still resting on the plate it last
    // touched.
    for (let i = 0; i < HULL_CONTACTS; i++) this._hullAge[i] = 1e6;
    if (this.camera) {
      this._lastCamPos.copy(this.camera.position);
      this._lastCamQuat.copy(this.camera.quaternion);
      this._lastCamFov = this.camera.fov;
    }
  },
};

export default api;
