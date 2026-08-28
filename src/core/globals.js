/**
 * Global shared uniforms + world constants.
 * OWNER: core (do not restructure from feature modules — add fields via registerUniform).
 *
 * Every material in the game reads from `U` so the underwater look is unified.
 * A module that renders geometry MUST call `applyUnderwater(material)` from
 * core/underwaterMaterial.js, or it will visually detach from the world.
 */
import * as THREE from 'three';

export const WORLD = {
  seaLevel: 0,
  // Safe Shallows floor ~ -40, Kelp ~ -80, Grand Reef ~ -300, Lost River ~ -600, Lava ~ -1200
  maxDepth: -1400,
  worldSize: 4096,      // metres across the playable disc
  gravity: -9.81,
  waterDensity: 1025,
};

/** Shared uniform objects. Mutate `.value`, never reassign the object. */
export const U = {
  uTime:            { value: 0 },
  uCamPos:          { value: new THREE.Vector3() },
  uSunDir:          { value: new THREE.Vector3(0.35, 0.86, 0.37).normalize() },
  uSunColor:        { value: new THREE.Color(1.0, 0.93, 0.78) },
  uSunIntensity:    { value: 3.2 },

  // ---- underwater medium (biome/depth blended each frame by render/underwater.js)
  uFogColor:        { value: new THREE.Color().setHex(0x2c9bc8, THREE.SRGBColorSpace) },
  uFogDensity:      { value: 0.021 },   // extinction per metre
  uFogHeightFalloff:{ value: 0.0 },
  uScatterColor:    { value: new THREE.Color().setHex(0x42baf3, THREE.SRGBColorSpace) },
  uScatterStrength: { value: 0.55 },
  /**
   * Per-channel extinction, 1/metre. Red dies first and dies completely — measured
   * mid-water in the reference frames has R=0..15 against G/B of 60..170.
   *
   * NOTE: this is deliberately NOT open-ocean physics. Real seawater passes blue
   * deepest, but Subnautica's ramp goes cyan-blue -> GREEN-TEAL (green overtakes
   * blue around 100-200m, measured #00AA9C) -> navy -> black. So green must be the
   * *least* absorbed channel through the mid band, and blue takes over again below
   * ~300m. A monotonic blue->black ramp is the single most common amateur tell.
   * RED WAS 0.185 AND IS NOW 0.085 — derived, not guessed. The verified plates
   * show relative red of 40-66% on lit geometry (cave 66, grand-reef 56,
   * seamoth 52, wreck 40). At 0.185 ours reached only 46% at 5m, 21% at 10m and
   * 4% at 20m: red died and took the whole frame's hue variety with it, which is
   * why every blind critic described a single intense cyan. Solving the
   * transmittance ratio for a ~55% target gives k_red 0.149/0.089/0.059 at
   * 5/10/20m, so ~0.085 sits in the band.
   *
   * Note this is now WELL BELOW physical — clear-ocean Kd(650nm) is about 0.35/m
   * and even the old 0.185 was already gentler than that. Subnautica deliberately
   * keeps red alive far longer than real seawater does, and matching it means
   * going further from physics, not closer.
   *
   * GREEN AND BLUE ARE UNCHANGED on purpose: they measure close to the plates
   * already, and moving them would break the verified G/B depth ramp.
   *
   * See reference/LOOK.md section 1 and reference/SYSTEMATIC.md section 0b.
   * Biomes override these per region.
   */
  uAbsorption:      { value: new THREE.Vector3(0.085, 0.0225, 0.0290) },
  // Usable visibility, metres: ~50 in the shallows down to ~12 in the deep.
  uMaxVisibility:   { value: 52.0 },

  // ---- caustics
  /**
   * CAUSTIC OCCLUDERS — world-space spheres that cast a shadow into the caustic
   * field. xyz = centre, w = radius (w <= 0 disables the slot).
   *
   * Until round 33 `uwCaustics()` took only a world position and returned two
   * texture taps, with no occlusion term and no parameter that could carry one,
   * so NO caller in the game could occlude caustics: a fully shadowed surface
   * received the identical caustic pattern as a fully lit one. A blind critic
   * decided the shallows-floor pair on exactly this — the reference plate shows
   * broad caustics interrupted by the diver's and a fish's shadow, and ours had
   * caustics that nothing could ever cast into.
   *
   * A shadow map is the general answer but is far more than this needs: the
   * things that visibly break a caustic field are the player, nearby creatures
   * and a parked vehicle. Modules publish those through setCausticOccluders().
   */
  uCausticOccluders:{ value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uCausticsTex:     { value: null },
  uCausticsScale:   { value: 0.055 },
  uCausticsStrength:{ value: 0.85 },
  uCausticsSpeed:   { value: 0.06 },

  // ---- ambient / depth response
  uAmbientTop:      { value: new THREE.Color(0.16, 0.42, 0.55) },
  uAmbientBottom:   { value: new THREE.Color(0.02, 0.07, 0.11) },
  uDepthDarken:     { value: 1.0 },     // 1 at surface -> ~0.05 in the deep
  uWaterLevel:      { value: 0.0 },
  uUnderwater:      { value: 1.0 },     // 1 submerged, 0 above surface

  /**
   * Vertical attenuation of downwelling light, as a multiple of uAbsorption.
   * This is what creates the up-vs-down brightness axis: three independent
   * critics measured our medium at 1.25-1.38:1 zenith-to-nadir where the
   * reference 140-160m band measures 14.8:1 (#00AA9C L=133 over #011434 L=9,
   * "the strongest vertical gradient in the game"). Raise toward 1.0 for a
   * stronger axis; render/underwater.js may drive it per biome.
   */
  uSkyAtten:        { value: 0.9 },
  /**
   * How much of the vertical-gain effect stays per-channel (1) versus becoming a
   * pure brightness change (0). Per-channel gain rises fastest for the most
   * absorbed channel, which tinted the up-look red — the one colour that must
   * stay dead at depth. render/underwater.js may tune this per biome.
   */
  uGainChroma:      { value: 0.35 },
  /** Henyey-Greenstein asymmetry for forward scatter around the sun. */
  uScatterG:        { value: 0.72 },

  /** Pixels per radian: screenHeight / (2*tan(fov/2)). Lets shaders derive a
   *  screen footprint without fwidth(), which is fragment-stage only. */
  uSfPixelScale:      { value: 540 },

  // ---- exposure / grading handoff to postfx
  uExposure:        { value: 1.0 },
};

/**
 * Publish the spheres that occlude caustics this frame, nearest first.
 * Pass [{ pos: Vector3, radius: number }]; extras beyond 8 are dropped.
 */
export function setCausticOccluders(list) {
  const slots = U.uCausticOccluders.value;
  for (let i = 0; i < slots.length; i++) {
    const o = list && list[i];
    if (o && o.radius > 0) slots[i].set(o.pos.x, o.pos.y, o.pos.z, o.radius);
    else slots[i].w = 0;
  }
}

const _extra = new Map();
/** Register an extra global uniform (namespaced by owner module). */
export function registerUniform(name, uniform) {
  if (U[name]) return U[name];
  U[name] = uniform; _extra.set(name, uniform); return uniform;
}

/** Depth in metres below the surface (positive number). */
export function depthAt(y) { return Math.max(0, WORLD.seaLevel - y); }

/** 0..1 how deep we are, for biome/lighting blends. */
export function depthT(y) { return Math.min(1, depthAt(y) / -WORLD.maxDepth); }
