/**
 * SURVIVAL — the loop that turns swimming into a game.
 *
 * OWNER: the "survival" agent.
 *
 * What lives here: the oxygen tank, hunger and thirst on their own clocks,
 * health with real damage sources, pressure/crush depth, water temperature,
 * death and respawn at the lifepod — plus the *feedback* that makes those
 * numbers felt: exhale bubbles, the hypoxia vignette, the damage wash, the
 * warning holograms and the blackout.
 *
 * What does NOT live here: the vitals cluster itself. ui.js renders the discs
 * (LOOK.md section 10) and consumes vitals() wholesale — oxygen, health, food,
 * water, crush depth, temperature, damageFlash, pressureStress and the ranked
 * warning list. ui.js also declares `ownsSurvivalFeedback = true`, which switches
 * our DOM layer off completely so no alert is painted twice; that layer stays in
 * the file as the fallback for a session where ui is absent or has thrown.
 * The exhale bubbles are NOT covered by that claim — they are geometry in the
 * water and no HUD module can draw them.
 *
 * ------------------------------------------------------------------ design
 * THE TANK IS THE REFERENCE'S TANK. reference/subnautica/surface-pod-1.jpg
 * reads "O2 45" at 0 m with the starting tank; hud-1.jpg reads "O2 225" at 0 m
 * with an ultra high-capacity tank fitted. Those two numbers pin the whole
 * scale, so base = 45 and the tanks add 30 / 90 / 180 -> 45 / 75 / 135 / 225.
 * Nothing else in this file is allowed to make the HUD show a number no
 * Subnautica player has ever seen.
 *
 * The one deliberate deviation from Subnautica: oxygen consumption scales with
 * DEPTH. Real regulators deliver gas at ambient pressure, so a breath at 30 m
 * (4 ATA) empties four times the tank volume a breath at the surface does.
 * Straight ATA scaling is unplayable (26x at 250 m) and a 0.42 exponent made
 * the shallows — where the entire early game and 12 of the 17 shots live —
 * cost nothing. The model is consumption ∝ ATA^0.23, which reads as:
 *
 *   surface 45 s    30 m 33 s    100 m 26 s    250 m 21 s    680 m 17 s
 *
 * That is monotonic, still depth-taxed, and never richer than the reference's
 * flat 45 s. Shallow water is exactly as generous as Subnautica's, 100 m is a
 * commitment, and past 250 m the tank stops being the tool for the job. A
 * rebreather flattens the exponent to 0.08 and buys back the deep (32 s at
 * 1364 m against 15 s without).
 *
 * GAUGE AND NUMBER MUST AGREE. `oxygenSeconds` is the time left at the current
 * DEPTH's steady rate, and `oxygenT` — the fill ui.js draws the ring from — is
 * that same number normalised by the surface endurance, so the ring and the
 * digits are two views of one quantity by construction. The raw tank fraction
 * is still published, as `tankT`, for anything that genuinely wants litres.
 *
 * The other deliberate choice: nothing here is instant except drowning. Food
 * and water are 23 and 16 minute clocks that never kill you quickly — they
 * kill you by taking away the health regeneration you were relying on when the
 * stalker showed up.
 *
 * ------------------------------------------------------------------ death
 * DEPTH HAS TO COST SOMETHING, AND IT IS MEASURED. Round 8's play routes
 * reported oxygen reaching zero and health then sitting at EXACTLY 35 for the
 * remaining 20+ seconds of both the descend and the deep route: drowning
 * capped at 65 damage and stopped, there was no death state, and the entire
 * tension pillar of the genre was missing. The cause was the capture health
 * floor (see CAPTURE_FLOOR) applying to play routes as well as to still
 * batteries. It no longer does, and three curves now carry the consequence:
 *
 *   drowning   rate linear in seconds-without-air (so damage is quadratic) and
 *              multiplied by ambient pressure. 6.5 s from full health at the
 *              surface, 4.7 s at 100 m, 2.5 s at 300 m.
 *   pressure   one continuous curve through the suit's rating: the amber rim
 *              starts at 72% of it, damage starts AT it from zero and climbs
 *              with the fraction of overshoot. 280 m in the base 200 m suit is
 *              7.4 HP/s — a 13 s countdown you can still win by climbing.
 *   the swim   above the rating, depth costs you the ascent. When the air left
 *              is less than the seconds needed to reach a breath, the dive has
 *              already failed and the warning list says so. That is what makes
 *              100 m frightening in a suit rated for 200.
 *
 * Feedback is published, not drawn: hypoxia is the vignette closing in,
 * blackout is consciousness going, damageFlash pulses on an accelerating
 * heartbeat, and ui.js builds its wash and its death card out of those plus
 * health, drowning, dead and lastCause. Nothing here paints a pixel of it.
 *
 * Death costs 62 HP of headroom (you wake at 38 against a cap of 72 that takes
 * nearly two minutes to lift), a third of your food and water, and whatever
 * tools.js was carrying. The tank comes back full — you woke up in the pod.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { UNDERWATER_PARS } from '../core/underwaterMaterial.js';
import { SHOTS } from '../core/shots.js';
import { makeRNG } from '../core/rng.js';

// ---------------------------------------------------------------- tuning
const OXY = {
  // 45 = the number in surface-pod-1.jpg. 45 + 180 = 225 = the number in hud-1.jpg.
  base: 45,                  // "surface seconds" — this is the number the HUD shows
  tanks: { none: 0, standard: 30, high: 90, ultra: 180 },
  drain: 1.0,                // units per second at 1 ATA, at rest
  pressureExp: 0.23,         // consumption ∝ ATA^exp — see the header
  rebreatherExp: 0.08,
  refill: 40,                // units/s at an air source: a full basic tank in ~1.1 s
  // Swimming hard costs air, but it may never halve the tank — the reference
  // number at the surface is 45 s and a player who is moving must still see a
  // tank that reads like one. 0.55 exertion (movement's normal swim) = 1.25x.
  exertion: 0.45,
  panic: 0.18,               // + this much when the tank is nearly out
  // The alarm reads whichever is worse, tank fraction or seconds remaining. At
  // the surface those coincide by construction (45 units = 45 s); at depth the
  // seconds run out first, so deep water warns you earlier for the same tank.
  lowT: 0.30, critT: 0.11,
  lowSeconds: 16, critSeconds: 7,
  airDepth: 0.18,            // head this far under the local wave surface still breathes
  // Chop is thicker than airDepth, so a bobbing eye flickers in and out of air
  // and the tank stutters 100 -> 99.8 -> 100. Hold the air for this long after
  // the last breath: a wave over your head is not a dive.
  airLatch: 0.55,
};

const HP = {
  max: 100,
  regen: 0.85,               // per second, fed and watered and not recently hit
  regenDelay: 6.0,
  starve: 1.10,              // per second at food 0
  dehydrate: 1.70,           // per second at water 0 — thirst kills faster than hunger
  // Drowning is the one thing in this file allowed to kill you quickly, and it
  // has to ACCELERATE or it reads as a slow leak rather than as asphyxia. The
  // rate is linear in time-without-air, so the damage is quadratic: the first
  // second is survivable, the sixth is not.  5.5 t + 1.5 t^2 = 100  ->  6.5 s
  // from full health at the surface.
  drownBase: 5.5,
  drownRamp: 3.0,
  drownMax: 26.0,
  // ...and it is worse deep. Hypoxia at 10 ATA is not hypoxia at 1 ATA: the
  // partial pressure of what is left in the blood collapses on the way up, so
  // the same empty tank buys a diver at 100 m about two thirds of the time it
  // buys one at the surface, and at 300 m a third. THIS is what makes 100 m
  // dangerous even though it is well inside the base suit's 200 m rating — the
  // depth is not what crushes you there, it is what makes running out lethal.
  drownDepthK: 0.075,        // multiplier = 1 + k*(ATA-1)
  drownDepthMax: 3.0,
  respawnCap: 72,            // you wake up unable to reach full health for a while
  capRecover: 0.25,          // per second — 112 s back to 100
};

const FOOD = { drain: 100 / (23 * 60), exertion: 0.55, cold: 0.90, night: 0.18 };
const WAT = { drain: 100 / (16 * 60), exertion: 0.35, heat: 1.20 };

/** Crush depth by suit. No suit is 200 m — the shelf and the kelp, nothing more. */
const SUITS = { none: 200, reinforced: 500, mk2: 800, mk3: 1300 };

/**
 * Pressure damage, expressed as a FRACTION of the suit's rating rather than in
 * absolute metres, so 400 m in a 200 m suit bites exactly as hard as 2600 m in
 * a 1300 m one and the escalation reads the same whatever you are wearing.
 *
 * The whole curve is continuous through the rating. The previous version
 * stepped from 0 to 2.0 HP/s the instant you crossed the line while the amber
 * rim ui.js paints simultaneously DROPPED from 0.50 to 0.35 — the frame got
 * calmer at the exact moment the suit started failing, which is the opposite
 * of a readable escalation.
 *
 *   base suit (200 m):  144 m rim starts   200 m damage starts
 *                       220 m  2.6 HP/s    280 m  7.4    300 m  8.6    400 m 14.6
 */
const CRUSH = {
  warnAt: 0.72,   // the hull starts talking at 72% of rating — 144 m in the base suit
  ease: 0.06,     // the first 6% of overshoot eases the rate in, so there is no step
  base: 2.6,      // HP/s just past the rating
  ramp: 12.0,     // + this per full rating of overshoot
  max: 26.0,      // 2x rating and beyond is measured in seconds, not minutes
  failAt: 0.45,   // overshoot fraction where "pressure exceeded" becomes "hull failing"
};

/**
 * Getting back to air is a real, timeable thing, and above the crush depth it
 * is the ONLY thing depth costs you — which is why 100 m has to be frightening
 * in a suit rated for 200. movement cruises at ~4.0 m/s and sprints at 6.5,
 * but nobody sprints a hundred-metre column on an empty tank, so the honest
 * sustained figure is lower, plus a few seconds to find the light and fight
 * through the chop at the top.
 */
const ASCENT = { speed: 3.6, margin: 3.0, warnFactor: 1.35 };

/**
 * THE CAPTURE FLOOR, AND WHY IT MUST NOT APPLY TO A PLAY ROUTE.
 *
 * A shot battery is a camera flythrough: the harness teleports the eye to
 * 678 m and holds it there, and a player who dies mid-battery blanks somebody
 * else's frame. So a still battery keeps a health floor.
 *
 * A PLAY ROUTE is the exact opposite. It is the instrument that measures
 * whether this loop has any teeth, and a floor there is not politeness, it is
 * a lie. Round 8 shipped one and both deep routes duly reported health pinned
 * at exactly 35 — 100 minus the 65 the floor would release — for the last 20+
 * seconds of a drowning that could not kill. Depth carried no consequence
 * whatsoever and the measurement said so.
 *
 * tools/play.mjs is identifiable without any cooperation from it: pointer lock
 * never engages headlessly so it sets ctx.input.locked itself and then drives
 * real key events, and it never calls CN.shot(). capture.mjs, motion.mjs and
 * verify.mjs all go through CN.shot() and never touch input. Input authority
 * plus no shot ever applied is a scripted play session and nothing else.
 *
 *   ?nodeath       forces the floor back on, for an agent who needs a long
 *                  play route to survive to the end for a visual judgement
 *   ?survivallive  takes the floor off a still battery
 */
const CAPTURE_FLOOR = 35;

const TEMP = {
  cold: 8, coldK: 0.10, coldExp: 1.35,     // hypothermia below 8 C
  hot: 45, hotK: 0.35,                     // burns above 45 C (the lava zone reads 78)
  suitCold: 14, suitHot: 25,               // a reinforced suit shifts both thresholds
  nightDrop: 3.5,                          // the sun-warmed top 30 m loses this after dark
};

/**
 * Bite damage per species. Numbers are Subnautica-shaped: a biter is an
 * annoyance, a stalker is a fight, a leviathan is a mistake you only make once.
 * Anything not listed falls back to a length-derived value.
 */
const BITE = {
  biter: 5, blighter: 5, mesmer: 6, cave_crawler: 8, shuttlebug: 4,
  gasopod: 12, stalker: 12, sand_shark: 18, boneshark: 20, ampeel: 22,
  crabsquid: 20, crabsnake: 25, warper: 25, crashfish: 30,
  reaper: 80, ghost_leviathan: 90, sea_dragon: 100,
};

const RESPAWN_DELAY = 4.6;
/**
 * A frame that moves you further than this is a teleport, not a swim. It has to
 * clear movement.js's own collision correction, which caps at +6 m in a single
 * frame when it pushes a body out of terrain — at 6.0 that correction re-armed
 * the settle timer every frame and quietly stretched a 1.4 s hold into ~5 s of
 * immunity. A swimmer tops out around 0.1 m/frame, so 9 m is unreachable.
 */
const TELEPORT_JUMP = 9.0;
const SETTLE_TELEPORT = 0.6;   // after a teleport: ignore pressure/cold/impact this long
const GRACE_RESPAWN = 2.0;     // after a death: real i-frames, and nothing longer
const BUB_MAX = 220;

// Shots where survival state is the subject. Everywhere else the overlay stays
// out of other modules' frames unless ?vitals forces it on.
const OVERLAY_SHOTS = new Set(['hud', 'surface-pod', 'night-shallows']);

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** 0 at noon, 1 in the dead of night. tod: 0 = midnight, 0.5 = noon. */
function nightness(tod) {
  const d = Math.abs((((tod ?? 0.42) % 1) + 1) % 1 - 0.5);
  return smoothstep(0.26, 0.40, d);
}

/** A predator worth being afraid of, right now. */
const isPredator = (a) => !!(a && a.spec && a.spec.ai && a.spec.ai.predator) && a.state !== 'flee';

/** Ask another module whether the player is breathing its air. Never trust it to not throw. */
function moduleAir(m, pos) {
  if (!m || m.stub === true) return false;
  try {
    if (typeof m.hasAirAt === 'function') return !!m.hasAirAt(pos);
    if (typeof m.isInsideAt === 'function') return !!m.isInsideAt(pos);
    if (typeof m.insideAt === 'function') return !!m.insideAt(pos);
    if (typeof m.airAt === 'function') return !!m.airAt(pos);
    if (m.playerInside === true || m.playerInVehicle === true) return true;
  } catch { /* their bug; we keep breathing water */ }
  return false;
}

// ---------------------------------------------------------------- state
const S = {
  oxygen: OXY.base, oxygenCapacity: OXY.base,
  health: HP.max, healthCap: HP.max,
  food: 82, water: 74,

  depth: 0, floorDepth: 0, ata: 1, temperature: 24, biome: 'safe_shallows',
  submerged: false, atAir: true, airSourceId: null, lastAirId: 'surface',
  speed: 0, exertion: 0, night: 0,

  drowning: false, drownT: 0, sinceDamage: 99, lastCause: null,
  // graceT = full invulnerability, and ONLY a respawn grants it. settleT is the
  // separate, shorter hold after a teleport: it suppresses the environmental
  // drains and the fall-impact read (which would otherwise fire on a harness
  // jump) but leaves damage() live, so a scripted or scripted-adjacent hit
  // always lands. Conflating the two was worth ~5 s of immunity after a death.
  dead: false, deathT: 0, deaths: 0, graceT: 0, settleT: 1.5, airLatchT: 0,

  breathPhase: 0, breathRate: 0.22, heart: 0,
  // hypoxia is the frame closing in; blackout is consciousness going. Two
  // different curves on purpose — the vignette starts three seconds before the
  // tank empties, the blackout only once you are actually drowning.
  damageFlash: 0, shake: 0, hypoxia: 0, blackout: 0, pressureStress: 0,
  threat: null,
  lastDeathCost: null,

  // authored overrides
  presetHold: 0, attacksOff: 0,
};

const UP = { tank: 'none', rebreather: false, suit: 'none', fins: false };

let _ctx = null;
let _rng = makeRNG(0x5a17e1);
let _medium = null;
let _bio = null;
let _shotName = null;
/**
 * ui.js is real and paints the vitals cluster, the hurt/drowning vignette, its
 * own low-O2 alarm ribbon AND the warning rows it reads out of vitals(). When
 * it is live our own rows and washes go silent — rendering them as well would
 * show every alert twice.
 */
let _uiLive = false;
let _uiRef = null;
let _overlayOwnedByUI = false;
let _captureMode = false;
let _forceVitals = false;
let _hideVitals = false;
/** See CAPTURE_FLOOR. Latched once and never unlatched — a route cannot become a battery. */
let _playDriven = false;
let _noDeath = false;      // ?nodeath — keep the floor even on a play route
let _forceLive = false;    // ?survivallive — drop the floor even in a still battery
let _floorOff = false;     // kill() suspending the floor for one scripted death

/**
 * The health floor in force right now, in HP. 0 means the player can die.
 * Everything that removes health goes through this.
 */
function godFloor() {
  if (_floorOff) return 0;
  if (_noDeath) return CAPTURE_FLOOR;
  if (!_captureMode || _forceLive) return 0;
  return _playDriven ? 0 : CAPTURE_FLOOR;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lastPos = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

const airSources = [];
const bitten = new Map();       // creature id -> cooldown remaining

// ---------------------------------------------------------------- bubbles
/**
 * Exhale bubbles. They are the only reason the breathing sim is visible in a
 * play contact sheet (tools/play.mjs composites the canvas, not the DOM), and
 * LOOK.md section 6 asks for rising bubble strings as a second particulate
 * population anyway. One instanced draw call, ~5 k triangles.
 */
const bubbles = [];
let bubMesh = null;
let bubMat = null;

/**
 * A bubble is a thin gas SHELL, not a ball of plastic. Shading it as diffuse
 * geometry is what made the first pass read as grey-brown blobs: a mid-grey
 * lambert surface is both darker and less saturated than the bright cyan water
 * behind it, so it punched dull holes in the frame.
 *
 * The physically-right cheap model is a Fresnel shell that takes its colour
 * from the medium itself — mostly transparent face-on, bright at the grazing
 * rim, with a tight sun glint. Because the base colour IS the water's ambient
 * (the same mix(fog, scatter, strength) that uwInscatter resolves to at the far
 * field), a bubble can never disagree with the water it is floating in.
 */
const BUBBLE_VERT = /* glsl */ `
varying vec3 vUwWorldPos;
varying vec3 vUwWorldNormal;
void main() {
  vec4 local = vec4(position, 1.0);
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 world = modelMatrix * local;
  vUwWorldPos = world.xyz;
  vUwWorldNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BUBBLE_FRAG = /* glsl */ `
${UNDERWATER_PARS}
uniform float uBubbleAlpha;
void main() {
  vec3  toCam = uCamPos - vUwWorldPos;
  float dist  = length(toCam);
  vec3  V = toCam / max(dist, 1e-4);
  vec3  N = normalize(vUwWorldNormal);
  float rim = pow(1.0 - abs(dot(N, V)), 2.2);

  // the medium's own colour, so the shell always belongs to this water
  vec3 amb = mix(uFogColor, uScatterColor, uScatterStrength);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0);

  // A faint absolute floor keeps bubbles as teal specks in the black deep,
  // which is what deep-void-1.jpg has in it and nothing else.
  vec3 col = amb * (1.00 + 3.6 * rim)
           + vec3(0.010, 0.038, 0.044) * (0.4 + rim)
           + uSunColor * spec * 2.6 * uDepthDarken;

  // Mostly see-through face-on, near-opaque at the grazing rim: on screen that
  // is a thin bright ring with the water showing through it, which is what a
  // real bubble is and what the reference frames show.
  float a = clamp(0.16 + 0.82 * rim, 0.0, 0.96) * uBubbleAlpha;
  // Near-fade. A diver descending at 4 m/s catches up with their own exhale,
  // and a 3 cm shell at 15 cm from the eye subtends half the screen — it read
  // as a milky grey moon parked in front of the mask in five of nine panels of
  // the descend contact sheet. Dissolve anything that gets inside arm's reach.
  a *= smoothstep(0.26, 0.70, dist);
  col = col * uwTransmittance(dist)
      + uwInscatter(-V, dist, max(0.0, uWaterLevel - uCamPos.y)) * a;
  gl_FragColor = vec4(col, a);
}
`;

function buildBubbles(scene) {
  const geo = new THREE.SphereGeometry(1, 8, 6);
  bubMat = new THREE.ShaderMaterial({
    vertexShader: BUBBLE_VERT,
    fragmentShader: BUBBLE_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uBubbleAlpha: { value: 1.0 },
      // the whole shared medium — UNDERWATER_PARS declares all of these
      uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor,
      uFogColor: U.uFogColor, uScatterColor: U.uScatterColor,
      uScatterStrength: U.uScatterStrength, uAbsorption: U.uAbsorption,
      uMaxVisibility: U.uMaxVisibility, uSkyAtten: U.uSkyAtten,
      uScatterG: U.uScatterG, uGainChroma: U.uGainChroma,
      uCausticsTex: U.uCausticsTex, uCausticsScale: U.uCausticsScale,
      uCausticsStrength: U.uCausticsStrength, uCausticsSpeed: U.uCausticsSpeed,
      uDepthDarken: U.uDepthDarken, uWaterLevel: U.uWaterLevel,
      uUnderwater: U.uUnderwater,
      uMatCaustics: { value: 0 }, uMatFogScale: { value: 1 },
    },
  });
  bubMesh = new THREE.InstancedMesh(geo, bubMat, BUB_MAX);
  bubMesh.name = 'survival:exhale';
  bubMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bubMesh.frustumCulled = false;
  bubMesh.userData.noShadow = true;   // core enables shadows on everything otherwise
  bubMesh.count = 0;
  bubMesh.visible = false;
  scene.add(bubMesh);

  for (let i = 0; i < BUB_MAX; i++) {
    bubbles.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: 0, life: 0, max: 1, seed: _rng() });
  }
}

/**
 * The first pass emitted 3-7 bubbles per 4.6 s breath from 1.05-1.6 m ahead of
 * the eye and dropped the player's velocity after 0.45 s. Live instance count
 * measured 7.5, and on a 4 m/s descent the player outswam their own exhale
 * before the next contact-sheet frame — they were absent from all nine panels.
 *
 * Three changes, all of them what a real exhale does: emit a proper cloud
 * (12-25) in a tight cone right off the mask, keep them alive long enough to
 * climb into frame (4.5-7 s), and let them ride the diver's wake for over a
 * second so a descending player trails a visible column instead of leaving it
 * behind. Still one instanced draw call.
 */
function emitBreath(camera, playerVel, count, strength) {
  const e = camera.matrixWorld.elements;
  _right.set(e[0], e[1], e[2]);
  _up.set(e[4], e[5], e[6]);
  _fwd.set(-e[8], -e[9], -e[10]);
  let made = 0;
  for (const b of bubbles) {
    if (made >= count) break;
    if (b.life > 0) continue;
    // Emitted from the mask: close enough to read as your own breath and to be
    // large on screen, far enough forward that the near plane never clips them.
    // A regulator vents to BOTH SIDES of the mask, not straight ahead, which
    // is also what keeps the middle of the screen clear.
    const side = (made & 1) ? 1 : -1;
    b.p.copy(camera.position)
      .addScaledVector(_fwd, 0.72 + _rng() * 0.34)
      .addScaledVector(_up, -0.28 - _rng() * 0.14)
      .addScaledVector(_right, side * (0.11 + _rng() * 0.15));
    // 16-52 mm across. At 0.72-1.06 m from the eye that is 30-72 px at 1080p,
    // which is a bubble you can see; the previous 16-38 px did not read.
    b.r = lerp(0.008, 0.026, _rng() * _rng()) * (0.85 + strength * 0.45);
    // Bigger bubbles rise faster; all of them carry the diver's wake at first,
    // and vent outward so the cloud opens up behind rather than through you.
    b.v.set(0, 0.34 + b.r * 9.0, 0)
      .addScaledVector(_fwd, 0.10 + _rng() * 0.14)
      .addScaledVector(_right, side * (0.12 + _rng() * 0.16))
      .addScaledVector(playerVel, 0.72);
    b.max = 4.5 + _rng() * 2.5;
    b.life = b.max;
    b.seed = _rng();
    made++;
  }
}

function updateBubbles(dt, t, surfaceY) {
  if (!bubMesh) return;
  let n = 0;
  for (const b of bubbles) {
    if (b.life <= 0) continue;
    b.life -= dt;
    // Drag toward pure buoyant rise, plus the lazy sideways wander of a real
    // bubble. The 1.3 s time constant is what keeps a descending diver's exhale
    // in shot: the cloud follows the wake down, stalls, then climbs past them.
    const rise = 0.34 + b.r * 9.0;
    b.v.x = lerp(b.v.x, Math.sin(t * 1.7 + b.seed * 31.0) * 0.09, dt * 0.8);
    b.v.z = lerp(b.v.z, Math.cos(t * 1.4 + b.seed * 17.0) * 0.09, dt * 0.8);
    b.v.y = lerp(b.v.y, rise, dt * 0.8);
    b.p.addScaledVector(b.v, dt);
    if (b.p.y > surfaceY - 0.04) b.life = 0;   // it pops at the ceiling
    if (b.life <= 0) continue;

    const fade = clamp01(b.life / 0.5) * clamp01((b.max - b.life) / 0.12);
    const s = b.r * (1 + (1 - b.life / b.max) * 0.35) * fade;
    _mat.compose(b.p, _quat.identity(), _scl.set(s, s, s));
    bubMesh.setMatrixAt(n++, _mat);
  }
  bubMesh.count = n;
  bubMesh.visible = n > 0;
  if (n > 0) bubMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- overlay
/**
 * Survival feedback, in the HUD language of LOOK.md section 10: translucent
 * navy fill, light-cyan rim, asymmetric rounded corners, coloured accent bar.
 * Deliberately NOT the vitals cluster — that is ui.js's.
 */
const OV = { root: null, veil: null, flash: null, hypoxia: null, press: null, warn: null, death: null, key: '' };

const CSS = `
#cn-survival{position:absolute;inset:0;pointer-events:none;overflow:hidden;
  font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",sans-serif;
  -webkit-font-smoothing:antialiased;}
#cn-survival .lay{position:absolute;inset:0;opacity:0;will-change:opacity;}
#cn-survival .warnwrap{position:absolute;left:50%;bottom:23%;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:7px;}
#cn-survival .pill{display:flex;align-items:center;gap:10px;
  padding:5px 16px 5px 11px;border-radius:3px 15px 3px 15px;
  background:rgba(14,51,80,.62);border:1.5px solid rgba(143,233,255,.70);
  box-shadow:0 0 14px rgba(20,90,130,.42),inset 0 0 20px rgba(30,120,170,.16);
  backdrop-filter:blur(3px) saturate(1.15);-webkit-backdrop-filter:blur(3px) saturate(1.15);
  color:#eaf8ff;font-size:12.5px;font-weight:500;letter-spacing:.20em;text-transform:uppercase;
  text-shadow:0 1px 3px rgba(0,10,16,.85);white-space:nowrap;}
#cn-survival .pill i{width:5px;height:15px;border-radius:2px;display:block;
  box-shadow:0 0 9px currentColor;}
#cn-survival .pill b{font-weight:600;letter-spacing:.06em;color:#fff;font-size:13px;}
#cn-survival .crit{border-color:rgba(240,85,60,.82);
  box-shadow:0 0 20px rgba(240,85,60,.34),inset 0 0 20px rgba(120,30,20,.26);}
@keyframes cnsvblink{0%,100%{opacity:1}50%{opacity:.45}}
#cn-survival .blink{animation:cnsvblink 1.05s ease-in-out infinite;}
#cn-survival .death{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:16px;opacity:0;}
#cn-survival .death h1{margin:0;font-size:36px;font-weight:200;letter-spacing:.52em;
  text-indent:.52em;color:#f0553c;text-shadow:0 0 30px rgba(240,85,60,.45);}
#cn-survival .death p{margin:0;font-size:12px;font-weight:400;letter-spacing:.34em;
  text-indent:.34em;color:#8fe9ff;opacity:.82;text-transform:uppercase;}
`;

const GRAD_HYPOXIA = 'radial-gradient(ellipse 76% 66% at 50% 50%,'
  + 'rgba(1,10,15,0) 30%,rgba(1,11,17,.50) 68%,rgba(0,4,7,.97) 100%)';
// Kept deliberately faint: the 678 m reference frame is essentially pure black
// and a bright rim there would read as a post-process, not as hull stress.
const GRAD_PRESSURE = 'radial-gradient(ellipse 88% 78% at 50% 50%,'
  + 'rgba(8,34,50,0) 46%,rgba(24,92,124,.14) 80%,rgba(140,205,235,.22) 100%)';
const GRAD_DAMAGE = 'radial-gradient(ellipse 80% 70% at 50% 50%,'
  + 'rgba(88,10,6,0) 26%,rgba(126,18,11,.40) 66%,rgba(168,28,16,.88) 100%)';

function buildOverlay(uiRoot) {
  if (!uiRoot || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.id = 'cn-survival-css';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'cn-survival';

  const mk = (cls, bg) => {
    const d = document.createElement('div');
    d.className = cls;
    if (bg) d.style.background = bg;
    root.appendChild(d);
    return d;
  };
  OV.hypoxia = mk('lay', GRAD_HYPOXIA);
  OV.press = mk('lay', GRAD_PRESSURE);
  OV.flash = mk('lay', GRAD_DAMAGE);
  OV.veil = mk('lay', '#000');

  OV.warn = document.createElement('div');
  OV.warn.className = 'warnwrap';
  root.appendChild(OV.warn);

  OV.death = document.createElement('div');
  OV.death.className = 'death';
  OV.death.innerHTML = '<h1>SIGNAL LOST</h1><p id="cn-sv-cause"></p>';
  root.appendChild(OV.death);

  uiRoot.appendChild(root);
  OV.root = root;
}

function pillHTML(w) {
  return '<div class="pill' + (w.crit ? ' crit' : '') + (w.blink ? ' blink' : '') + '">'
    + '<i style="background:' + w.color + ';color:' + w.color + '"></i>'
    + '<span>' + w.text + '</span>'
    + (w.value !== undefined ? '<b>' + w.value + '</b>' : '')
    + '</div>';
}

// ---------------------------------------------------------------- warnings
const C_RED = '#f0553c', C_AMBER = '#ffa22a', C_ICE = '#a9e4ff', C_BLUE = '#6fdfff';

/**
 * Ranked, not ordered by the sequence I happened to write the checks in. The
 * bug this replaces: with food 0 and water 0 at crush depth the list came back
 * ["Oxygen low", "Hull pressure exceeded", "Extreme heat"] and the two states
 * actually removing 2.8 HP/s were truncated off the end. `sev` is roughly "how
 * fast is this killing me" — everything that is draining health right now
 * outranks everything that is merely a readout, so no lethal state can ever be
 * sliced away by a cosmetic one.
 */
function buildWarnings() {
  const out = [];
  if (S.dead) return out;
  const air = secondsOfAir();
  const secs = Math.max(0, Math.ceil(air));

  if (S.drowning) {
    out.push({ sev: 100, id: 'drown', text: 'Drowning', color: C_RED, crit: true, blink: true });
  } else if (S.submerged && !S.atAir && o2Critical()) {
    out.push({ sev: 95, id: 'o2c', text: 'Oxygen critical', color: C_RED, crit: true, blink: true,
      value: secs + 's' });
  } else if (S.submerged && !S.atAir && o2Alarm() > 0) {
    out.push({ sev: 60, id: 'o2l', text: 'Oxygen low', color: C_AMBER, value: secs + 's' });
  }

  // Pressure, in three readable stages against the suit's printed rating. The
  // value carries both numbers so "128/200m" says how much room is left and
  // "284/200m" says how far past it you are, on the same chip.
  const crush = crushDepth();
  const over = crushOver();
  const dm = Math.round(S.depth) + '/' + crush + 'm';
  if (over > CRUSH.failAt) {
    out.push({ sev: 96, id: 'crushf', text: 'Hull failing', color: C_RED, crit: true, blink: true, value: dm });
  } else if (over > 0) {
    out.push({ sev: 92, id: 'crush', text: 'Hull pressure exceeded', color: C_RED, crit: true, blink: true,
      value: dm });
  } else if (S.depth > crush * CRUSH.warnAt) {
    out.push({ sev: 50, id: 'press', text: 'Pressure warning', color: C_AMBER, value: dm });
  }

  // The 100 m problem. The suit is rated for 200 and the hull is not the thing
  // that kills you there — the swim home is. Nothing on the HUD used to say
  // that a dive had already failed, so a player found out by drowning at 90 m
  // with a healthy-looking amber ring. Compare the air against the ascent.
  // Suppressed once the hull chip is already red: below the rating "no air to
  // surface" is news, past it "hull failing" has already said it louder.
  if (S.submerged && !S.atAir && !S.drowning && S.depth > 12 && over <= 0) {
    const up = ascentSeconds();
    if (air < up) {
      out.push({ sev: 90, id: 'noret', text: 'No air to surface', color: C_RED, crit: true, blink: true,
        value: Math.ceil(up) + 's up' });
    } else if (air < up * ASCENT.warnFactor) {
      out.push({ sev: 58, id: 'ascend', text: 'Ascend now', color: C_AMBER, value: Math.ceil(up) + 's up' });
    }
  }

  const cold = TEMP.cold + (UP.suit !== 'none' ? -TEMP.suitCold : 0);
  const hot = TEMP.hot + (UP.suit !== 'none' ? TEMP.suitHot : 0);
  if (S.temperature < cold) {
    // Hypothermia is a live drain, so it ranks by how hard it is biting.
    const bite = Math.pow(cold - S.temperature, TEMP.coldExp) * TEMP.coldK;
    out.push({ sev: 70 + clamp(bite * 6, 0, 16), id: 'cold', text: 'Hypothermia', color: C_ICE,
      crit: S.temperature < cold - 4, value: Math.round(S.temperature) + '°C' });
  } else if (S.temperature > hot) {
    out.push({ sev: 70 + clamp((S.temperature - hot) * TEMP.hotK * 2, 0, 16), id: 'hot',
      text: 'Extreme heat', color: C_AMBER, crit: true, blink: true,
      value: Math.round(S.temperature) + '°C' });
  }

  if (S.water <= 0.5) out.push({ sev: 88, id: 'dehy', text: 'Dehydrated', color: C_RED, crit: true });
  else if (S.water < 20) out.push({ sev: 30, id: 'watl', text: 'Water low', color: C_BLUE });
  if (S.food <= 0.5) out.push({ sev: 84, id: 'starv', text: 'Starving', color: C_RED, crit: true });
  else if (S.food < 20) out.push({ sev: 28, id: 'foodl', text: 'Food low', color: C_AMBER });

  if (S.threat && S.threat.level > 0.55) {
    out.push({ sev: 74 + (S.threat.apex ? 12 : 0), id: 'threat',
      text: S.threat.apex ? 'Leviathan-class biological' : 'Predator nearby',
      color: C_RED, crit: true, blink: true });
  }

  // Stable sort by severity, then cut. ui.js takes the first three of whatever
  // we hand it, so the ranking has to happen here or not at all.
  out.forEach((w, i) => { w._i = i; w.sev = +w.sev.toFixed(1); });
  out.sort((a, b) => (b.sev - a.sev) || (a._i - b._i));
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- model
function crushDepth() { return SUITS[UP.suit] ?? SUITS.none; }

/** How far past the suit's rating you are, as a fraction of it. 0 = at the rating. */
function crushOver() {
  const c = crushDepth();
  return Math.max(0, (S.depth - c) / Math.max(1, c));
}

/** HP/s the hull is losing right now. Exactly 0 at the rating, continuous above it. */
function crushRate() {
  const over = crushOver();
  if (over <= 0) return 0;
  // Ease the first few per cent of overshoot so crossing the line is a squeeze
  // that grows, not a step onto a 2.6 HP/s conveyor.
  return Math.min(CRUSH.max, (CRUSH.base + CRUSH.ramp * over) * clamp01(over / CRUSH.ease));
}

/**
 * 0..1 for the amber rim ui.js paints from vitals().pressureStress. ONE
 * continuous curve through the rating: the warning band below it and the
 * failure band above it are the same line, so the frame never gets calmer at
 * the moment the suit starts failing.
 */
function pressureRim() {
  const c = crushDepth();
  const f = S.depth / Math.max(1, c);
  if (f <= CRUSH.warnAt) return 0;
  if (f <= 1) return smoothstep(CRUSH.warnAt, 1.0, f) * 0.42;
  return clamp01(0.42 + (f - 1) * 0.72);
}

/**
 * Seconds of swimming between here and a breath. The number that makes 100 m
 * frightening in a suit rated for 200: the hull is fine, the swim home is not.
 */
function ascentSeconds() {
  return S.depth / ASCENT.speed + ASCENT.margin;
}

/**
 * The GAUGE rate: what this depth costs a diver who stops and hovers. Depth
 * only — no exertion, no panic. Every number the player sees is derived from
 * this one function, which is the whole reason the ring and the digits can no
 * longer disagree, and it is stable enough that the ring does not lurch every
 * time the swim key goes down.
 */
function o2GaugeRate() {
  const exp = UP.rebreather ? OXY.rebreatherExp : OXY.pressureExp;
  return OXY.drain * Math.pow(S.ata, exp);
}

/** Seconds of air left at this depth if you stop swimming — a diver's gauge. */
function secondsOfAir() {
  const r = o2GaugeRate();
  return r > 1e-4 ? S.oxygen / r : 999;
}

/**
 * The ring fill ui.js draws: seconds remaining over seconds a full tank buys at
 * the SURFACE. 1.0 with a full tank at 0 m; 0.47 with a full tank at 250 m,
 * because a full tank at 250 m really is only half a dive. Publishing the raw
 * tank fraction here is what put an 86.7% ring over the number 14.
 */
function airT() {
  const surfaceSeconds = S.oxygenCapacity / OXY.drain;
  return clamp01(secondsOfAir() / Math.max(1e-4, surfaceSeconds));
}

/**
 * 0 = comfortable, 1 = empty. Drives the alarm, the breathing rate, the panic
 * multiplier and the hypoxia vignette, so all four escalate together — and it
 * reads the same seconds the HUD prints, so the pill and the vignette and the
 * countdown escalate on one clock.
 */
function o2Alarm() {
  const byTank = S.oxygen / (S.oxygenCapacity * OXY.lowT);
  const bySeconds = secondsOfAir() / OXY.lowSeconds;
  return 1 - clamp01(Math.min(byTank, bySeconds));
}

function o2Critical() {
  return Math.min(S.oxygen / (S.oxygenCapacity * OXY.critT),
    secondsOfAir() / OXY.critSeconds) <= 1;
}

/**
 * Oxygen units actually burned per second, right now — the gauge rate plus what
 * working and panicking cost on top. This is what the tank is debited by; it is
 * deliberately NOT what the gauge projects, because a gauge that jumped every
 * time you kicked would be unreadable.
 */
function o2Rate() {
  return o2GaugeRate() * (1 + OXY.exertion * S.exertion) * (1 + OXY.panic * o2Alarm());
}

function die(cause) {
  if (S.dead) return;
  S.dead = true;
  S.deathT = 0;
  S.deaths++;
  S.lastCause = cause;
  S.health = 0;
  S.drowning = false;
  const ctx = _ctx;
  if (ctx) {
    // Losing what you were carrying is the real cost; tools owns the inventory.
    try { ctx.get('tools')?.onPlayerDeath?.(cause); } catch { /* ignore */ }
    try { ctx.get('ui')?.notify?.('Vital signs lost — ' + causeText(cause)); } catch { /* ignore */ }
  }
}

function causeText(c) {
  switch (c) {
    case 'drowning': return 'asphyxiation';
    case 'crush': return 'hull pressure';
    case 'cold': return 'hypothermia';
    case 'heat': return 'thermal exposure';
    case 'starvation': return 'starvation';
    case 'dehydration': return 'dehydration';
    case 'impact': return 'blunt trauma';
    default: return c ? 'trauma (' + c + ')' : 'unknown';
  }
}

/**
 * The local wave surface at an x/z, from whichever module is authoritative.
 * movement.waterY is only right where the player IS, so a respawn across the
 * map has to ask watersurface directly.
 */
function surfaceYAt(x, z) {
  const ctx = _ctx;
  let y = Number.isFinite(U.uWaterLevel?.value) ? U.uWaterLevel.value : WORLD.seaLevel;
  try {
    const ws = ctx?.get('watersurface');
    if (ws && ws.stub !== true && typeof ws.waterHeightAt === 'function') {
      const h = ws.waterHeightAt(x, z);
      if (Number.isFinite(h)) y = h;
    }
  } catch { /* sea level is a fine answer */ }
  return y;
}

function respawn() {
  const ctx = _ctx;
  _v.set(16.88, 1.15, 24.96);          // the lifepod's authored spot, if structures is out
  try {
    const lp = ctx?.get('structures')?.lifepod;
    if (lp && lp.position) { _v.copy(lp.position); _v.y = lp.position.y + 0.9; }
  } catch { /* fall back to the authored spot */ }
  // The pod's origin sits above its own waterline, so lifepod.y + 0.9 dropped
  // the player in mid-air 3.5 m over the sea. You wake up in the pod at the
  // waterline, breathing — clamp to the local wave surface, not to the prop.
  const sy = surfaceYAt(_v.x, _v.z);
  _v.y = clamp(_v.y, sy - 0.25, sy + 0.35);

  const mv = ctx?.get('movement');
  let placed = false;
  try {
    if (typeof mv?.respawn === 'function') { mv.respawn(_v.clone()); placed = true; }
    else if (typeof mv?.teleport === 'function') { mv.teleport(_v.clone()); placed = true; }
    else if (mv?.position?.isVector3) {
      mv.position.copy(_v);
      if (mv.velocity?.isVector3) mv.velocity.set(0, 0, 0);
      placed = true;
    }
  } catch { placed = false; }
  // Only drive the camera ourselves while movement is a stub — it owns the eye.
  if (!placed && ctx?.camera) ctx.camera.position.copy(_v);

  // THE COST. Death has to be more than a loading screen or the whole loop is
  // decorative: you wake at 38 HP against a cap of 72 that takes nearly two
  // minutes to lift, hungry, thirsty, and without whatever tools.js was
  // carrying for you (die() calls its onPlayerDeath hook before we get here).
  // The tank is the one thing you get back whole — you woke up inside the pod.
  const cost = {
    cause: S.lastCause,
    reviveHealth: 38,
    healthCap: HP.respawnCap,           // and it takes ~112 s to lift back to 100
    food: +(S.food - Math.max(8, S.food - 34)).toFixed(1),
    water: +(S.water - Math.max(6, S.water - 38)).toFixed(1),
    inventory: true,                    // tools.onPlayerDeath() was called by die()
  };
  S.dead = false;
  S.deathT = 0;
  S.health = 38;
  S.healthCap = HP.respawnCap;
  S.oxygen = S.oxygenCapacity;
  S.food = Math.max(8, S.food - 34);
  S.water = Math.max(6, S.water - 38);
  S.lastDeathCost = cost;
  S.drownT = 0;
  S.graceT = GRACE_RESPAWN;
  S.settleT = SETTLE_TELEPORT;
  S.sinceDamage = 0;
  // The cause belongs to the death that just ended. Leaving it set meant
  // vitals().lastCause still reported "crush" minutes later, at the surface,
  // at full health, with an empty warning list.
  S.lastCause = null;
  S.damageFlash = 0;
  S.shake = 0;
  S.hypoxia = 0;
  S.blackout = 0;
  S.pressureStress = 0;
  S.threat = null;
  bitten.clear();
  _lastPos.copy(_v);
  try { ctx?.get('ui')?.setMessage?.('Lifepod 5 — emergency revival. Supplies expended.'); } catch { /* ignore */ }
}

/**
 * Continuous environmental drain: no flash per frame, but it still blocks
 * regeneration. Unlike damage() this also honours settleT, because a harness
 * teleport to 680 m must not bill the player for a frame of crush they did not
 * swim into.
 */
function drain(amount, cause) {
  if (!(amount > 0) || S.dead) return;
  if (S.graceT > 0 || S.settleT > 0) return;
  let a = amount;
  const floor = godFloor();
  if (floor > 0) a = Math.min(a, Math.max(0, S.health - floor));
  if (a <= 0) return;
  S.health = Math.max(0, S.health - a);
  S.sinceDamage = 0;
  S.lastCause = cause;
  if (S.health <= 0) die(cause);
}

// ---------------------------------------------------------------- threat
function creatureThreat(dt, ctx, pos) {
  for (const [id, cd] of bitten) {
    const n = cd - dt;
    if (n <= 0) bitten.delete(id); else bitten.set(id, n);
  }

  const cre = ctx.get('creatures');
  if (!cre || cre.stub === true || typeof cre.nearest !== 'function') { S.threat = null; return; }

  let near = null;
  try { near = cre.nearest(pos, isPredator); } catch { S.threat = null; return; }
  if (!near) { S.threat = null; return; }

  const a = near.agent;
  const spec = a?.spec ?? {};
  const len = (spec.len ?? spec.span ?? (spec.radius ? spec.radius * 2 : 1)) * (near.size ?? 1);
  const night = S.night;

  // Reach is the animal's mouth, not its centre, and creatures.js steers with a
  // separation term that holds a hunting predator off at 2.4-3.2 m from the
  // player however big it is (measured: stalker 2.45 m, biter 3.04, boneshark
  // 3.11 over a 12 s forced chase). A geometric reach derived from body length
  // alone therefore never connects, and the whole threat system reads as decor.
  // Base it on that standoff instead, with a length term for the leviathans
  // whose jaws genuinely arrive from further out. Night widens the envelope.
  // Re-measured against the live AI: with a stalker forced adjacent for 15 s
  // creatures.js's separation term held it at a MINIMUM of 5.2 m from the eye,
  // not the 2.45-3.2 m an earlier pass measured. A 3.6 m reach therefore still
  // never connected and every bite in this file stayed unreachable. Size the
  // reach to the standoff the AI actually keeps: at 5.8 m for a 4.3 m stalker
  // this is a lunge, which is what the animal is visibly doing.
  const reach = (4.2 + Math.min(len, 14) * 0.38) * (1 + 0.25 * night);
  const notice = Math.max(22, len * 3.2);

  // creatures.js only flips a predator to 'hunt' inside its own ai.predator
  // radius (9-80 m by species), so in the shallows — where the nearest predator
  // measured 32 m across 75 s of loitering at three locations — nothing ever
  // committed and this entire subsystem was unreachable in ordinary play. Gate
  // on hunting OR contact instead: an animal that has swum inside its own bite
  // reach is committed whatever its state machine calls itself, because a shark
  // does not consult its AI state before closing its jaws. A drifting bite is
  // a bump rather than a strike, so it lands at 55%.
  const hunting = near.state === 'hunt' || near.state === 'attack' || near.state === 'chase';
  const contact = near.distance <= reach && near.state !== 'flee';
  const committed = hunting || contact || len > 20;

  // Proximity reads for any predator, so the pill can warn you about the thing
  // circling at 12 m instead of only about the one already biting.
  const prox = clamp01(1 - (near.distance - reach) / notice);
  S.threat = {
    name: near.name, distance: +near.distance.toFixed(1), length: +len.toFixed(1),
    state: near.state, apex: len > 18, hunting,
    level: +(committed ? prox : prox * 0.6).toFixed(3),
  };

  if (S.attacksOff > 0 || S.dead || S.graceT > 0) return;
  if (!committed || near.distance > reach) return;
  if (bitten.has(near.id)) return;

  const dmg = (BITE[near.name] ?? clamp(4 + len * 4.2, 4, 95))
    * (1 + 0.15 * night) * (hunting || len > 20 ? 1 : 0.55);
  bitten.set(near.id, (1.2 + len * 0.25) * (1 - 0.2 * night));
  api.damage(dmg, near.name);

  // Being hit should move you. movement owns the body; we only ask for a shove.
  const mv = ctx.get('movement');
  _v2.copy(pos).sub(near.position);
  if (_v2.lengthSq() > 1e-6) {
    _v2.normalize().multiplyScalar(3.0 + len * 0.18);
    _v2.y += 0.8;
    try {
      if (typeof mv?.impulse === 'function') mv.impulse(_v2);
      else if (mv?.velocity?.isVector3) mv.velocity.add(_v2);
    } catch { /* movement's call, not ours */ }
  }
  const label = near.name.replace(/_/g, ' ');
  try { ctx.get('ui')?.notify?.(label + ' attack', 'bad'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- module
const api = {
  id: 'survival',
  order: 110,

  // ---- required interface -------------------------------------------------
  get oxygen() { return +S.oxygen.toFixed(1); },
  get health() { return +S.health.toFixed(1); },
  get food() { return +S.food.toFixed(1); },
  get water() { return +S.water.toFixed(1); },

  /**
   * Take a discrete hit. Returns the health actually removed.
   * `cause` is free text and shows on the death screen.
   */
  damage(amount, cause = 'trauma') {
    if (!(amount > 0) || S.dead) return 0;
    if (S.graceT > 0) return 0;
    let a = amount;
    const floor = godFloor();
    if (floor > 0) a = Math.min(a, Math.max(0, S.health - floor));
    S.health = Math.max(0, S.health - a);
    S.sinceDamage = 0;
    S.lastCause = cause;
    // The flash reads the intended hit even when a capture floor swallowed it.
    S.damageFlash = Math.min(1, S.damageFlash + Math.min(0.9, 0.20 + amount / 55));
    S.shake = Math.min(1.4, S.shake + amount / 70);
    if (S.health <= 0) die(cause);
    return a;
  },

  // ---- the rest of the published state -----------------------------------
  get oxygenCapacity() { return S.oxygenCapacity; },
  // ui.js probes oxygenMax / maxOxygen / o2Max in that order before falling
  // back to its own default; answer all three so its arc scales to our tank.
  get oxygenMax() { return S.oxygenCapacity; },
  get maxOxygen() { return S.oxygenCapacity; },
  get o2Max() { return S.oxygenCapacity; },
  /** Time-remaining fill, normalised to surface endurance. See airT(). */
  get oxygenT() { return +airT().toFixed(4); },
  /** The raw tank fraction, for anything that genuinely wants litres not time. */
  get tankT() { return clamp01(S.oxygen / S.oxygenCapacity); },
  get oxygenSeconds() { return +secondsOfAir().toFixed(1); },
  /** Units actually being burned per second, exertion and panic included. */
  get oxygenRate() { return +o2Rate().toFixed(3); },
  get healthMax() { return HP.max; },
  get healthCap() { return +S.healthCap.toFixed(1); },
  get depth() { return +S.depth.toFixed(1); },
  get crushDepth() { return crushDepth(); },
  get pressureAtm() { return +S.ata.toFixed(2); },
  get temperature() { return +S.temperature.toFixed(1); },
  get isDrowning() { return S.drowning; },
  get isDead() { return S.dead; },
  get deaths() { return S.deaths; },
  /** HP/s the hull is losing to pressure right now; 0 above the suit's rating. */
  get crushRate() { return +crushRate().toFixed(2); },
  /** Seconds of swimming between here and a breath, at an honest sustained ascent. */
  get ascentSeconds() { return +ascentSeconds().toFixed(1); },
  /** True when the air left is less than the swim home. The dive is already lost. */
  get pointOfNoReturn() {
    return S.submerged && !S.atAir && secondsOfAir() < ascentSeconds();
  },
  /** 0..1 consciousness going out. Distinct from hypoxia, which is the vignette. */
  get blackout() { return +S.blackout.toFixed(3); },
  /** What the last death actually cost, for a PDA log or a death card. */
  get lastDeathCost() { return S.lastDeathCost ? { ...S.lastDeathCost } : null; },
  get threat() { return S.threat; },
  get upgrades() { return { ...UP }; },
  /** Camera shake other modules may consume; 0..1.4, decays on its own. */
  get shake() { return +S.shake.toFixed(3); },

  /** Everything ui.js needs to draw the vitals cluster, as plain data. */
  vitals() {
    const cap = S.oxygenCapacity;
    return {
      // oxygenT is TIME remaining (normalised to surface endurance), not tank
      // fraction — ui.js draws the ring from it and the digits from
      // oxygenSeconds, and those two must be the same quantity. tankT is the
      // litres-in-the-cylinder reading for anything that wants it.
      oxygen: +S.oxygen.toFixed(1), oxygenCapacity: cap, oxygenT: +airT().toFixed(4),
      tankT: clamp01(S.oxygen / cap),
      oxygenSeconds: +secondsOfAir().toFixed(1), oxygenRate: +o2Rate().toFixed(3),
      oxygenGaugeRate: +o2GaugeRate().toFixed(3),
      health: +S.health.toFixed(1), healthMax: HP.max, healthCap: +S.healthCap.toFixed(1),
      healthT: clamp01(S.health / HP.max),
      food: +S.food.toFixed(1), foodT: clamp01(S.food / 100),
      water: +S.water.toFixed(1), waterT: clamp01(S.water / 100),
      depth: +S.depth.toFixed(1), floorDepth: +S.floorDepth.toFixed(1),
      crushDepth: crushDepth(), pressureAtm: +S.ata.toFixed(2),
      temperature: +S.temperature.toFixed(1), biome: S.biome, night: +S.night.toFixed(2),
      submerged: S.submerged, atAir: S.atAir, airSource: S.airSourceId,
      breathPhase: +S.breathPhase.toFixed(3), breathRate: +S.breathRate.toFixed(3),
      heart: +S.heart.toFixed(2), exertion: +S.exertion.toFixed(2), speed: +S.speed.toFixed(2),
      drowning: S.drowning, drownT: +S.drownT.toFixed(2),
      dead: S.dead, deaths: S.deaths, respawnIn: S.dead ? +Math.max(0, RESPAWN_DELAY - S.deathT).toFixed(1) : 0,
      damageFlash: +S.damageFlash.toFixed(3), shake: +S.shake.toFixed(3),
      hypoxia: +S.hypoxia.toFixed(3), blackout: +S.blackout.toFixed(3),
      pressureStress: +S.pressureStress.toFixed(3),
      // crushRate is the number behind the amber rim; ascentSeconds and
      // noReturn are the pair that makes 100 m readable in a 200 m suit.
      crushRate: +crushRate().toFixed(2), crushOver: +crushOver().toFixed(3),
      ascentSeconds: +ascentSeconds().toFixed(1),
      noReturn: S.submerged && !S.atAir && secondsOfAir() < ascentSeconds(),
      lastCause: S.lastCause, threat: S.threat, upgrades: { ...UP },
      deathCost: S.lastDeathCost ? { ...S.lastDeathCost } : null,
      grace: +S.graceT.toFixed(2), settle: +S.settleT.toFixed(2),
      warnings: buildWarnings().map((w) => ({ id: w.id, text: w.text, value: w.value, crit: !!w.crit, sev: w.sev })),
    };
  },

  /** Prioritised warnings, for a HUD that wants to render them itself. */
  warnings() { return buildWarnings(); },

  // ---- things the rest of the game does to the player ---------------------
  heal(n) { if (n > 0 && !S.dead) S.health = Math.min(S.healthCap, S.health + n); return S.health; },
  eat(n) { if (n > 0) S.food = clamp(S.food + n, 0, 100); return S.food; },
  drink(n) { if (n > 0) S.water = clamp(S.water + n, 0, 100); return S.water; },
  refillOxygen(n) { S.oxygen = clamp(S.oxygen + (n ?? S.oxygenCapacity), 0, S.oxygenCapacity); return S.oxygen; },
  consume({ food = 0, water = 0, health = 0 } = {}) {
    if (food) this.eat(food);
    if (water) this.drink(water);
    if (health) this.heal(health);
    return this.vitals();
  },

  /**
   * Upgrades. tools/vehicles/base may call this.
   *   setUpgrade('tank', 'standard'|'high'|'ultra'|'none')
   *   setUpgrade('rebreather', true)     removes most of the depth penalty
   *   setUpgrade('suit', 'reinforced'|'mk2'|'mk3')  crush depth + temperature
   */
  setUpgrade(key, value) {
    if (!(key in UP)) return false;
    UP[key] = value;
    if (key === 'tank') {
      const add = OXY.tanks[value] ?? 0;
      S.oxygenCapacity = OXY.base + add;
      S.oxygen = Math.min(S.oxygen, S.oxygenCapacity);
    }
    return true;
  },

  /** Register a breathable pocket. base/vehicles/structures may call this. */
  addAirSource(src) {
    if (!src || !src.position) return null;
    const rec = {
      id: src.id || ('air-' + (airSources.length + 1)),
      position: src.position.isVector3 ? src.position : new THREE.Vector3().fromArray(src.position),
      radius: src.radius ?? 3.0,
      top: src.top ?? Infinity,
    };
    const i = airSources.findIndex((a) => a.id === rec.id);
    if (i >= 0) airSources[i] = rec; else airSources.push(rec);
    return rec.id;
  },
  removeAirSource(id) {
    const i = airSources.findIndex((a) => a.id === id);
    if (i >= 0) airSources.splice(i, 1);
    return i >= 0;
  },
  airSources() { return airSources.map((a) => ({ id: a.id, position: a.position.clone(), radius: a.radius })); },

  /** Debug / scripted: kill, revive, or set state outright. */
  kill(cause = 'debug') {
    _floorOff = true;                         // suspend, do not clobber, the capture floor
    S.graceT = 0; S.settleT = 0; S.health = 0;
    try { die(cause); } finally { _floorOff = false; }
  },
  respawnNow() { respawn(); },
  setState(p = {}) {
    if (p.oxygen !== undefined) S.oxygen = clamp(p.oxygen, 0, S.oxygenCapacity);
    // Both names set the TANK here: this is an authoring hook, and "fill the
    // cylinder to 86%" is what a preset means. The published oxygenT is time.
    if (p.tankT !== undefined) S.oxygen = clamp01(p.tankT) * S.oxygenCapacity;
    if (p.oxygenT !== undefined) S.oxygen = clamp01(p.oxygenT) * S.oxygenCapacity;
    if (p.health !== undefined) S.health = clamp(p.health, 0, HP.max);
    if (p.food !== undefined) S.food = clamp(p.food, 0, 100);
    if (p.water !== undefined) S.water = clamp(p.water, 0, 100);
    if (p.hold !== undefined) S.presetHold = p.hold;
    return this.vitals();
  },

  // ---- lifecycle ----------------------------------------------------------
  async init(ctx) {
    _ctx = ctx;
    _rng = ctx.rng?.fork ? ctx.rng.fork(913) : makeRNG(0x5a17e1);

    _captureMode = !!(ctx.params && (ctx.params.get('capture') === '1' || ctx.params.has('capture')));
    _forceVitals = !!(ctx.params && ctx.params.has('vitals'));
    _hideVitals = !!(ctx.params && ctx.params.has('novitals'));

    // The health floor: on for a still battery, OFF for a play route. See the
    // block comment on CAPTURE_FLOOR — this is the line that used to pin health
    // at exactly 35 for the back half of every deep route.
    _forceLive = !!(ctx.params && ctx.params.has('survivallive'));
    _noDeath = !!(ctx.params && ctx.params.has('nodeath'));
    _playDriven = false;

    _bio = ctx.get('biomes');
    if (_bio && _bio.stub !== true && typeof _bio.createMedium === 'function') {
      try { _medium = _bio.createMedium(); } catch { _medium = null; }
    }

    // ui loads at order 210, after us, so it is resolved lazily in update().
    // ?nohud is ui's courtesy hook for pure-landscape captures; honour it too.
    if (ctx.params && ctx.params.get('nohud') === '1') _hideVitals = true;

    // The lifepod is an air pocket. structures inits before us (order 70 < 110).
    try {
      const lp = ctx.get('structures')?.lifepod;
      if (lp?.position) this.addAirSource({ id: 'lifepod-5', position: lp.position.clone(), radius: (lp.radius ?? 2.6) + 1.2 });
    } catch { /* no structures yet — the surface still works */ }

    buildBubbles(ctx.scene);
    buildOverlay(ctx.uiRoot);

    const cam = ctx.camera?.position;
    _lastPos.copy(cam ?? _v.set(0, 0, 0));
    S.oxygenCapacity = OXY.base + (OXY.tanks[UP.tank] ?? 0);
    S.oxygen = S.oxygenCapacity;

    ctx.provide?.('survival', this);
  },

  update(dt, t, ctx) {
    const d = Math.min(dt, 1 / 20);
    // The sim step is clamped so a hitch cannot kill you in one frame, but the
    // grace timers must expire in WALL time or a slow frame silently multiplies
    // them — that is how a documented 1.4 s hold measured 4.8 s.
    const dReal = clamp(dt, 0, 0.5);

    // Is a human (or tools/play.mjs) actually flying this body? Look control
    // plus no shot ever applied means a scripted play session, where death is
    // the whole point of the measurement. See CAPTURE_FLOOR.
    if (!_playDriven && _captureMode && _shotName === null && ctx.input?.locked === true) {
      _playDriven = true;
    }

    // ---------------------------------------------------------- where we are
    const mvRaw = ctx.get('movement');
    const mv = (mvRaw && mvRaw.stub !== true && mvRaw.position?.isVector3) ? mvRaw : null;
    const pos = mv ? mv.position : ctx.camera.position;

    // A frame that moves the player further than any swimmer could is the capture
    // harness (or a respawn) teleporting the eye. Do not read it as motion, and
    // give the body a moment before pressure and cold start counting again.
    const jump = _lastPos.distanceTo(pos);
    const teleported = jump > TELEPORT_JUMP || ctx.time.frame < 4;
    if (teleported) { S.settleT = Math.max(S.settleT, SETTLE_TELEPORT); S.speed = 0; }

    let instSpeed = 0;
    if (mv?.velocity?.isVector3) instSpeed = mv.velocity.length();
    else if (!teleported && d > 1e-5) instSpeed = jump / d;
    if (!Number.isFinite(instSpeed)) instSpeed = 0;
    S.speed = lerp(S.speed, instSpeed, 1 - Math.exp(-d * 9));
    _lastPos.copy(pos);

    // movement publishes a stamina-aware exertion; prefer it over our estimate
    // so sprinting costs air even when the resulting speed is modest.
    S.exertion = Number.isFinite(mv?.exertion)
      ? clamp(mv.exertion, 0, 1.35) : clamp(instSpeed / 4.5, 0, 1.35);
    S.night = nightness(ctx.time.timeOfDay);

    let surfaceY = Number.isFinite(U.uWaterLevel?.value) ? U.uWaterLevel.value : WORLD.seaLevel;
    if (Number.isFinite(mv?.waterY)) {
      surfaceY = mv.waterY;                        // the same wave sample movement floats on
    } else {
      const ws = ctx.get('watersurface');
      if (ws && ws.stub !== true && typeof ws.waterHeightAt === 'function') {
        try { const h = ws.waterHeightAt(pos.x, pos.z); if (Number.isFinite(h)) surfaceY = h; } catch { /* sea level */ }
      }
    }
    S.depth = Math.max(0, surfaceY - pos.y);
    S.ata = 1 + S.depth / 10;
    // movement's submersion curve is the authority on where the eye is, so the
    // moment you break the surface it and the tank agree.
    S.submerged = mv ? mv.isSubmerged === true : S.depth > OXY.airDepth;

    const terr = ctx.get('terrain');
    if (terr && terr.stub !== true && typeof terr.heightAt === 'function') {
      try { const h = terr.heightAt(pos.x, pos.z); if (Number.isFinite(h)) S.floorDepth = Math.max(0, surfaceY - h); }
      catch { /* keep the last value */ }
    }

    // ---------------------------------------------------------- the medium
    this._bioT = (this._bioT ?? 0) - d;
    if (this._bioT <= 0) {
      this._bioT = 0.25;
      if (_bio && _medium && typeof _bio.at === 'function') {
        try {
          _bio.at(pos.x, pos.y, pos.z, _medium);
          S.biome = _medium.id;
          let temp = _medium.temperature;
          // Only the sun-warmed top of the column has a diurnal signal at all.
          if (S.depth < 30) temp -= TEMP.nightDrop * S.night * (1 - S.depth / 30);
          S.temperature = temp;
        } catch { /* keep the last reading */ }
      }
    }

    // ---------------------------------------------------------- air sources
    let atAir = !S.submerged;
    let airId = atAir ? 'surface' : null;
    if (!atAir) {
      for (const a of airSources) {
        if (pos.distanceToSquared(a.position) <= a.radius * a.radius) { atAir = true; airId = a.id; break; }
      }
    }
    if (!atAir && moduleAir(ctx.get('base'), pos)) { atAir = true; airId = 'base'; }
    if (!atAir && moduleAir(ctx.get('vehicles'), pos)) { atAir = true; airId = 'vehicle'; }
    // Chop hysteresis: a wave breaking over a floating diver's head is not a
    // dive. Without this the tank stuttered 100 -> 99.8 -> 100 twice in 12 s of
    // bobbing at the surface, because the swell is thicker than OXY.airDepth.
    if (atAir) { S.airLatchT = OXY.airLatch; S.lastAirId = airId; }
    else if (S.airLatchT > 0 && S.depth < 1.2) { atAir = true; airId = S.lastAirId ?? 'surface'; }
    S.atAir = atAir;
    S.airSourceId = airId;

    // ---------------------------------------------------------- timers
    S.graceT = Math.max(0, S.graceT - dReal);
    S.settleT = Math.max(0, S.settleT - dReal);
    S.airLatchT = Math.max(0, S.airLatchT - dReal);
    S.sinceDamage += d;
    S.damageFlash = Math.max(0, S.damageFlash - d * 1.9);
    S.shake = Math.max(0, S.shake - d * 2.4);
    if (S.presetHold > 0) S.presetHold -= d;
    if (S.attacksOff > 0) S.attacksOff -= d;
    this._resolveUI(ctx, d);

    // ---------------------------------------------------------- death
    if (S.dead) {
      S.deathT += d;
      S.drowning = false;
      // Death takes the frame all the way out over 1.1 s. ui.js fades its own
      // card on the same clock; this is the value anything else can read.
      S.blackout = Math.max(S.blackout, clamp01(S.deathT / 1.1));
      S.hypoxia = Math.max(S.hypoxia, clamp01(S.deathT / 0.8));
      if (S.deathT >= RESPAWN_DELAY) respawn();
      this._syncOverlay(d, t);
      updateBubbles(d, t, surfaceY);
      return;
    }

    const frozenByPreset = S.presetHold > 0;

    // ---------------------------------------------------------- oxygen
    if (!frozenByPreset) {
      if (atAir) {
        S.oxygen = Math.min(S.oxygenCapacity, S.oxygen + OXY.refill * d);
      } else {
        S.oxygen = Math.max(0, S.oxygen - o2Rate() * d);
      }
    }
    S.drowning = S.oxygen <= 0 && !atAir;

    if (S.drowning) {
      S.drownT += d;
      // Linear in time-without-air, so the damage is quadratic and the curve
      // visibly runs away from you — and multiplied by ambient pressure, so an
      // empty tank at 300 m is a third of the reprieve an empty tank at the
      // surface is. This is what kills you, and it is meant to.
      const depthK = Math.min(HP.drownDepthMax, 1 + HP.drownDepthK * (S.ata - 1));
      const rate = Math.min(HP.drownMax, (HP.drownBase + HP.drownRamp * S.drownT) * depthK);
      if (!frozenByPreset) drain(rate * d, 'drowning');
      // A heartbeat, not a strobe — but a heartbeat that accelerates: 1.1 s
      // apart and shallow when the tank first empties, 0.28 s apart and hard by
      // the time the edges have closed. ui.js builds its vignette out of
      // damageFlash, so this is also how the blackout ramps: we publish the
      // pressure on the pixel and ui.js paints it.
      const panic = clamp01(S.drownT / 4.5);
      this._drownPulse = (this._drownPulse ?? 0) - d;
      if (this._drownPulse <= 0) {
        this._drownPulse = lerp(1.10, 0.28, panic);
        S.damageFlash = Math.min(1, S.damageFlash + lerp(0.22, 0.60, panic));
      }
    } else {
      S.drownT = Math.max(0, S.drownT - d * 2.2);
    }

    // ---------------------------------------------------------- food + water
    if (!frozenByPreset) {
      const cold = TEMP.cold + (UP.suit !== 'none' ? -TEMP.suitCold : 0);
      const hot = TEMP.hot + (UP.suit !== 'none' ? TEMP.suitHot : 0);
      const coldT = clamp01((cold - S.temperature) / 12);
      const heatT = clamp01((S.temperature - hot) / 25);

      S.food = Math.max(0, S.food - FOOD.drain * d
        * (1 + FOOD.exertion * S.exertion + FOOD.cold * coldT + FOOD.night * S.night));
      S.water = Math.max(0, S.water - WAT.drain * d
        * (1 + WAT.exertion * S.exertion + WAT.heat * heatT));

      if (S.food <= 0) drain(HP.starve * d, 'starvation');
      if (S.water <= 0) drain(HP.dehydrate * d, 'dehydration');

      // ---------------------------------------------------------- temperature
      if (S.temperature < cold) {
        drain(Math.pow(cold - S.temperature, TEMP.coldExp) * TEMP.coldK * d, 'cold');
      } else if (S.temperature > hot) {
        drain((S.temperature - hot) * TEMP.hotK * d, 'heat');
      }

      // ---------------------------------------------------------- pressure
      // One continuous curve through the suit's rating: the rim starts building
      // at 72% of it, the damage starts at exactly 100% of it from zero, and
      // both keep climbing together. See the CRUSH block for the numbers and
      // for the discontinuity this replaced.
      S.pressureStress = pressureRim();
      const cr = crushRate();
      if (cr > 0) drain(cr * d, 'crush');

      // ---------------------------------------------------------- impact
      // Measure the fall OURSELVES, from movement's velocity on the frame before
      // it grounded. movement.lastImpactSpeed is published but never cleared, so
      // reading it charged the player for an ancient drop — a teleport onto the
      // seabed billed 3.7 HP for a fall that had already been paid for. A
      // teleport also invalidates both edges, so they are dropped, not carried.
      if (mv && ctx.time.frame > 60) {
        if (teleported || S.settleT > 0) { this._wasGrounded = undefined; this._prevVy = undefined; }
        else {
          const landed = mv.grounded === true && this._wasGrounded === false;
          if (landed) {
            const hit = Number.isFinite(this._prevVy) ? -this._prevVy : 0;
            if (hit > 11) this.damage(Math.min(100, (hit - 11) * 4.5), 'impact');
          }
          this._wasGrounded = mv.grounded === true;
          this._prevVy = mv.velocity?.y ?? 0;
        }
      }

      // ---------------------------------------------------------- regen
      S.healthCap = Math.min(HP.max, S.healthCap + HP.capRecover * d);
      if (!S.drowning && S.sinceDamage > HP.regenDelay && S.food > 35 && S.water > 35) {
        const q = 0.5 + 0.5 * Math.min(S.food, S.water) / 100;
        S.health = Math.min(S.healthCap, S.health + HP.regen * q * d);
      }
      // The cause belongs to a recent event. Ten seconds without anything
      // touching your health and the answer to "what hurt me" is "nothing" —
      // it used to still read 'crush' minutes later, at the surface, unhurt.
      if (S.lastCause && S.sinceDamage > 10) S.lastCause = null;
    } else {
      S.pressureStress = pressureRim();
    }

    // ---------------------------------------------------------- threat
    this._threatT = (this._threatT ?? 0) - d;
    if (this._threatT <= 0) { this._threatT = 0.18; creatureThreat(0.18, ctx, pos); }

    // ---------------------------------------------------------- breathing
    // Rest is a 4.6 s cycle; sprinting and hypoxia drive it to 1.4 s. This is
    // the panic curve made audible-in-the-eyes: bubbles come faster and the
    // vignette pulse quickens well before the tank actually runs out.
    const alarm = o2Alarm();
    const urgency = Math.max(S.exertion * 0.8, alarm);
    const period = lerp(4.6, 1.4, clamp01(urgency));
    S.breathRate = 1 / period;
    S.heart = lerp(1.0, 2.7, clamp01(urgency * 0.85 + (S.drowning ? 1 : 0)));

    const wasPhase = S.breathPhase;
    S.breathPhase = (S.breathPhase + d / period) % 1;
    const breathing = S.submerged && !atAir && this._showWorldFx();
    const vel = mv?.velocity?.isVector3 ? mv.velocity : _v2.set(0, 0, 0);
    if (breathing && S.breathPhase < wasPhase) {
      // 12-25 per exhale. At rest that is ~19 live instances, panicking ~120 —
      // a stream you can see, against the 7.5 the first pass averaged.
      emitBreath(ctx.camera, vel, 12 + Math.round(_rng() * 5 + urgency * 8), 0.5 + urgency * 0.7);
    }
    // A regulator never seals perfectly: a thin trickle between exhales keeps
    // the diver visibly breathing in a still frame instead of only every 4.6 s.
    this._trickleT = (this._trickleT ?? 0) - d;
    if (breathing && this._trickleT <= 0) {
      this._trickleT = lerp(0.70, 0.22, clamp01(urgency));
      emitBreath(ctx.camera, vel, 2, 0.35);
    }
    // Drowning: the body keeps trying to breathe and dumps what is left.
    if (S.drowning && this._showWorldFx() && _rng() < d * 4.0) {
      emitBreath(ctx.camera, _v2.set(0, 0, 0), 10 + Math.round(_rng() * 8), 1.0);
    }

    // The vignette only starts closing well inside the warning band, so "low"
    // is a readout and "critical" is a physical sensation.
    S.hypoxia = Math.max(
      (S.submerged && !atAir) ? clamp01((alarm - 0.58) / 0.42) : 0,
      S.drowning ? clamp01(0.40 + S.drownT * 0.17) : 0,
    );
    // The blackout is the later, separate curve: it opens 1.6 s into a drowning
    // and is total by 4.6 s, which is roughly when the drown rate reaches its
    // cap. It snaps to its target on the way up — losing consciousness is not a
    // lerp — and eases back over about half a second when you reach air.
    const bTarget = S.dead ? clamp01(S.deathT / 1.1)
      : (S.drowning ? clamp01((S.drownT - 1.6) / 3.0) : 0);
    S.blackout = bTarget > S.blackout ? bTarget : lerp(S.blackout, bTarget, 1 - Math.exp(-d * 1.6));

    updateBubbles(d, t, surfaceY);
    this._syncOverlay(d, t);
  },

  // ---- feedback -----------------------------------------------------------
  /** ui.js inits after us (order 210 > 110), so find it lazily. */
  _resolveUI(ctx, dt) {
    this._uiT = (this._uiT ?? 0) - dt;
    if (this._uiT > 0) return;
    this._uiT = 0.5;
    const ui = ctx.get('ui');
    _uiRef = (ui && ui.stub !== true && typeof ui.notify === 'function') ? ui : null;
    _uiLive = !!_uiRef;
    _overlayOwnedByUI = !!(ui && ui.ownsSurvivalFeedback === true);
  },

  /**
   * Politeness gate. A shot battery is somebody else's frame: keep player
   * feedback out of it unless survival is the subject of that framing, or
   * ?vitals forces it on. Live play and play routes are always fair game.
   */
  _inFrame() {
    if (_hideVitals) return false;
    if (!_captureMode) return true;
    if (_forceVitals) return true;
    // No shot has been applied: this is a play route or a free-running session,
    // not a shot battery, so nobody else's frame is at stake.
    if (_shotName === null) return true;
    return OVERLAY_SHOTS.has(_shotName);
  },

  /** DOM feedback. ui.js takes this over completely when it claims ownership. */
  _showOverlay() { return !_overlayOwnedByUI && this._inFrame(); },

  /**
   * World-space feedback — the exhale bubbles. NOT covered by ui's ownership
   * claim: they are geometry in the water, and no HUD module can draw them.
   */
  _showWorldFx() { return this._inFrame(); },

  _syncOverlay(dt, t) {
    if (!OV.root) return;
    const show = this._showOverlay();
    if (!show) {
      if (OV.root.style.display !== 'none') OV.root.style.display = 'none';
      return;
    }
    if (OV.root.style.display === 'none') OV.root.style.display = '';

    // Hypoxia closes the frame in and pulses with the heartbeat — the sign the
    // player is meant to read three seconds before the tank actually empties.
    // ui.js paints its own hurt/drowning vignette, so when it is live we drop
    // ours entirely rather than stack two washes on the same pixels.
    const beat = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * S.heart);
    // The blackout overrides the pulse: once consciousness is going the frame
    // stops breathing with the heart and simply closes.
    OV.hypoxia.style.opacity = _uiLive ? '0'
      : Math.max(S.hypoxia * (0.72 + 0.28 * beat), S.blackout * 0.97).toFixed(3);
    OV.flash.style.opacity = _uiLive ? '0' : (S.damageFlash * 0.85).toFixed(3);
    // Nothing else knows about crush depth, so the pressure rim stays ours.
    OV.press.style.opacity = (S.pressureStress * (0.55 + 0.45 * beat) * 0.55).toFixed(3);

    if (S.dead) {
      const fadeIn = clamp01(S.deathT / 1.3);
      OV.veil.style.opacity = fadeIn.toFixed(3);
      OV.death.style.opacity = clamp01((S.deathT - 0.5) / 0.9).toFixed(3);
      const el = OV.death.querySelector('#cn-sv-cause');
      const txt = 'Cause: ' + causeText(S.lastCause) + '  ·  Reviving at Lifepod 5';
      if (el && el.textContent !== txt) el.textContent = txt;
      if (OV.warn.innerHTML !== '') { OV.warn.innerHTML = ''; OV.key = ''; }
      return;
    }
    // After a respawn the veil lifts over the i-frame window.
    const post = clamp01(1 - S.graceT / GRACE_RESPAWN);
    OV.veil.style.opacity = (S.graceT > 0 && S.deaths > 0 ? (1 - post) * 0.9 : 0).toFixed(3);
    if (OV.death.style.opacity !== '0') OV.death.style.opacity = '0';

    if (_uiLive) {
      // ui.js reads vitals().warnings and paints the rows itself in its own
      // HUD language. Rendering ours as well would show every alert twice.
      if (OV.key !== '') { OV.key = ''; OV.warn.innerHTML = ''; }
      return;
    }
    const warns = buildWarnings();
    const key = warns.map((w) => w.id + (w.value ?? '')).join('|');
    if (key !== OV.key) {
      OV.key = key;
      OV.warn.innerHTML = warns.map(pillHTML).join('');
    }
  },

  /**
   * Per-shot presets. We register a hook for every canonical framing so we
   * always know which shot is on screen and can keep the overlay out of the
   * frames that belong to other modules. Where survival IS the subject, the
   * state is authored so the capture shows a specific, deliberate reading
   * rather than whatever the sim happened to drift to.
   */
  shots: (() => {
    const presets = {
      // surface-pod-1.jpg reads O2 45 at 0 m. So does this.
      'surface-pod': { tankT: 1, health: 100, food: 68, water: 55, hold: 6 },
      // one amber pill, nothing more: the vitals cluster is ui.js's frame to own
      hud: { tankT: 0.62, health: 84, food: 55, water: 17, hold: 6 },
      // a night dive with the tank going: this is the panic curve on screen
      'night-shallows': { tankT: 0.09, health: 71, food: 44, water: 33, hold: 6 },
      // 678 m in a suit rated for 200: pressure is the story, so leave the tank
      // nearly full — at that depth 39 units is still only 15 seconds of air,
      // and the ring now shows 0.33 to say exactly that instead of 0.86.
      'deep-void': { tankT: 0.86, health: 62, food: 38, water: 29, hold: 8, noAttacks: 10 },
      'grand-reef': { tankT: 0.78, health: 78, food: 46, water: 38, hold: 8, noAttacks: 10 },
    };
    const out = {};
    for (const name of Object.keys(SHOTS)) {
      out[name] = (ctx) => {
        _shotName = name;
        const p = presets[name];
        if (!p) return;
        api.setState(p);
        if (p.noAttacks) S.attacksOff = p.noAttacks;
        // A shot hook is a camera cut, so let the body settle — but do not grant
        // invulnerability, which is what graceT would have meant here.
        S.settleT = Math.max(S.settleT, 0.8);
        S.dead = false;
        S.deathT = 0;
        // A cut must not inherit the drowning the previous shot was three
        // seconds into — that carried its damage rate and its blackout across
        // into the next framing.
        S.drownT = 0;
        S.blackout = 0;
        S.hypoxia = 0;
        S.damageFlash = 0;
      };
    }
    return out;
  })(),
};

export default api;
