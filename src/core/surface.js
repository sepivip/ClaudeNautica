/**
 * Shared procedural SURFACE MICROSTRUCTURE. OWNER: core.
 *
 * A whole-game critic, having watched the water medium stop deciding blind
 * trials, named what replaced it:
 *
 *   "Nothing in this game has a surface. Hull plating, cockpit interior, base
 *    lockers, fish flanks, jellyshroom caps, the lifepod, kelp blades — every
 *    asset is a smoothly-shaded solid colour with painted-on line art and zero
 *    sub-object albedo, wear, pore or grain variation, so it reads as moulded
 *    vinyl."
 *
 * It decided 9 of 18 blind pairs on its own. The measurement that matters:
 * our wreck hull crop has tileContrast 43.15 against the real hull's 9.2 — we
 * carry 4.7x MORE local contrast than the reference, and it is all hard-edged
 * decal. The reference carries its signal as LOW-AMPLITUDE BROADBAND texture.
 *
 * So the fix is not "more detail", it is detail of the right kind: many octaves,
 * small amplitude, no visible characteristic frequency, triplanar so nothing
 * stretches, and modulating roughness as well as albedo — because a surface that
 * varies only in colour still reads as plastic.
 *
 * USAGE — compose with applyUnderwater, which already injects SURFACE_PARS:
 *
 *     applyUnderwater(mat, { surface: { grain: 0.10, wear: 0.5, streak: 0.35 } });
 *
 * FRAGMENT STAGE ONLY — sfBroadband uses fwidth(), which does not exist in the
 * vertex stage. Import UNDERWATER_PARS_VERT for vertex shaders.
 */

export const SURFACE_PARS = /* glsl */ `
#ifndef SF_DECLARED
#define SF_DECLARED
uniform float uSurfGrain;    // broadband albedo/roughness grain, 0..~0.25
uniform float uSurfWear;     // cavity + edge wear, 0..1
uniform float uSurfStreak;   // vertical gravity streaking (hulls, rock), 0..1
uniform float uSurfScale;    // metres per unit of the base pattern
uniform float uSfPixelScale; // pixels per radian: screenHeight/(2*tan(fov/2)).
                             // NAMESPACED: an earlier uPixelScale collided with the
                             // point-size uniform that every particle system here
                             // already declared, breaking three shaders at once.

// Cheap 3D value noise. No texture fetch, no UVs, so it cannot tile or stretch.
float sfHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float sfNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sfHash(i + vec3(0, 0, 0)), sfHash(i + vec3(1, 0, 0)), f.x),
                 mix(sfHash(i + vec3(0, 1, 0)), sfHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(sfHash(i + vec3(0, 0, 1)), sfHash(i + vec3(1, 0, 1)), f.x),
                 mix(sfHash(i + vec3(0, 1, 1)), sfHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

/**
 * Broadband grain, band-limited to the fragment's own screen footprint.
 *
 * The first version built octaves UPWARD from a fixed world-space base with a
 * 1/f roll-off. A critic measured what that actually produced on the wreck at
 * ~20 px/m: only the first two or three octaves landed above a pixel, so the
 * "seven octaves" collapsed into a 9-33 px blotch that PAINTED OVER the panel
 * lines instead of putting grain on them. Energy per octave came out
 * 4.5/4.5/7.7/9.7/10.4 % (fine->coarse) — RISING toward coarse — against a real
 * hull plate's 0.99/0.68/0.96/1.16/1.28 %, which is FLAT.
 *
 * Two corrections, both from that measurement:
 *   1. Build octaves DOWNWARD from the highest frequency that still resolves at
 *      this fragment (about one cycle per 2.5 px, from fwidth). Detail then lands
 *      at pixel scale at any distance, which is what "broadband" means to an eye.
 *   2. Use FLAT amplitude per octave, not 1/f. The reference spectrum is flat;
 *      a 1/f roll-off is precisely the coarse-dominated blotch we measured.
 */
float sfBroadbandAt(vec3 p, float mpp) {
  float fMax = 1.0 / (max(mpp, 1e-6) * 2.5);   // finest octave ~2.5 px per cycle

  float s = 0.0, f = fMax, n = 0.0;
  for (int i = 0; i < 6; i++) {
    // Flat amplitude: equal energy per octave band.
    s += sfNoise(p * f) * 2.0 - 1.0;
    n += 1.0;
    f *= 0.46;                            // ~1/2.17 — walk down, not up
    if (f < 0.02) break;                  // stop before features exceed the object
  }
  return s / max(n, 1.0);
}

/**
 * Stage-safe wrapper. Derives the screen footprint from CAMERA DISTANCE rather
 * than fwidth(), because fwidth does not exist in the vertex stage in GLSL ES —
 * and this file is shared with modules that include it in their own vertex
 * shaders. Using it there silently failed to LINK 34-37 programs while every
 * module still reported init OK, so the game drew flora and HUD over empty water
 * for an entire round and was critiqued as an art problem. Never reintroduce a
 * derivative here.
 */
float sfBroadband(vec3 p, vec3 wp) {
  // wp is passed in, never read from a varying: varyings are WRITE-ONLY in the
  // vertex stage, so reading vUwWorldPos here was a second, subtler way to make
  // this file fail to compile for any module that includes it in a vertex shader.
  float dist = max(length(wp - uCamPos), 0.05);
  // metres per pixel at that distance, converted into p's own scale
  float mpp = dist / max(uSfPixelScale, 1.0) / max(uSurfScale, 1e-3);
  return sfBroadbandAt(p, mpp);
}

/**
 * Backwards-compatible 1-arg overload. Modules were already calling
 * sfBroadband(p) before the footprint argument existed; changing the signature
 * out from under them is a compile error in THEIR shader, not ours.
 * Uses a fixed mid-range footprint rather than a varying, so it stays stage-safe.
 */
float sfBroadband(vec3 p) { return sfBroadbandAt(p, 0.0035); }

/** Cavity/edge wear: paint and coating survive on flats, not on edges. */
float sfWear(vec3 wp, vec3 n) {
  float coarse = sfBroadband(wp * (0.35 / uSurfScale), wp);
  float upFacing = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  // Wear collects on horizontal surfaces and wherever the coarse field is high.
  return clamp(coarse * 0.5 + 0.5, 0.0, 1.0) * mix(0.55, 1.0, upFacing);
}

/**
 * Vertical streaking — rust and biofouling run DOWN with gravity, which is a
 * strong cue that a surface has been sitting in water for years. Stretched 6x
 * vertically so the streaks are long rather than blobby.
 */
float sfStreak(vec3 wp, vec3 n) {
  vec3 p = wp * (1.0 / uSurfScale);
  float s = sfBroadband(vec3(p.x * 3.0, p.y * 0.17, p.z * 3.0), wp);
  float sideFacing = 1.0 - abs(n.y);        // only on near-vertical faces
  return clamp(s * 0.5 + 0.5, 0.0, 1.0) * sideFacing;
}

/**
 * The one call most materials want. Modulates a shaded colour with broadband
 * grain, wear and streaking, and returns a roughness delta to apply alongside.
 * Amplitudes are deliberately small: the reference's own hull measures 9.2
 * tileContrast, so this must whisper.
 */
vec3 sfApply(vec3 color, vec3 wp, vec3 n, out float roughDelta) {
  // One band-limited call now covers the whole spectrum from pixel scale down;
  // the old two-call fine/micro split double-counted the coarse end.
  float grain  = sfBroadband(wp * (1.0 / uSurfScale), wp) * uSurfGrain;
  float micro  = 0.0;
  float wear   = (sfWear(wp, n) - 0.5) * uSurfWear;
  float streak = (sfStreak(wp, n) - 0.5) * uSurfStreak;

  // Albedo: multiplicative so dark materials stay dark and bright stay bright.
  float lum = 1.0 + grain + micro + wear * 0.35 - streak * 0.30;
  // Streaking also desaturates slightly, the way biofilm does.
  vec3 outc = color * lum;
  float g = dot(outc, vec3(0.2126, 0.7152, 0.0722));
  outc = mix(outc, vec3(g), clamp(streak * 0.5 + wear * 0.12, 0.0, 0.45));

  // Roughness varies with wear and grain — a surface uniform in gloss reads as
  // plastic no matter how good its albedo is.
  roughDelta = grain * 1.6 + wear * 0.45 + streak * 0.30;
  return outc;
}
#endif // SF_DECLARED
`;

/** Injected just before the medium composite in UNDERWATER_FRAG. */
export const SURFACE_FRAG = /* glsl */ `
#ifdef UW_SURFACE
  {
    float sfRough;
    gl_FragColor.rgb = sfApply(gl_FragColor.rgb, vUwWorldPos,
                               normalize(vUwWorldNormal), sfRough);
  }
#endif
`;

/** Default surface character per material family, as a starting point. */
export const SURFACE_PRESETS = {
  hull:     { grain: 0.085, wear: 0.55, streak: 0.45, scale: 2.2 },
  rock:     { grain: 0.140, wear: 0.70, streak: 0.20, scale: 3.5 },
  sand:     { grain: 0.070, wear: 0.25, streak: 0.00, scale: 1.4 },
  organic:  { grain: 0.095, wear: 0.30, streak: 0.10, scale: 0.8 },
  skin:     { grain: 0.060, wear: 0.18, streak: 0.05, scale: 0.35 },
  interior: { grain: 0.045, wear: 0.28, streak: 0.12, scale: 1.6 },
  glass:    { grain: 0.020, wear: 0.10, streak: 0.22, scale: 1.0 },
};
