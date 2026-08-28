/**
 * Shared underwater shading injected into EVERY material in the world.
 * OWNER: core. This is the single biggest reason the world reads as one place.
 *
 * Physical model (approximate but stable):
 *   - Per-channel Beer-Lambert extinction along the view ray (red dies first).
 *   - Sunlight is separately extinguished on its way down to the shaded point,
 *     so deep geometry goes blue then black without any per-module hacks.
 *   - In-scattering blends toward the biome fog colour, brightened toward the sun.
 *   - Two-layer animated caustics on up-facing surfaces, fading out with depth.
 *
 * USAGE (all world-geometry modules):
 *     import { applyUnderwater } from '../core/underwaterMaterial.js';
 *     applyUnderwater(myMaterial);              // once, after material creation
 *     applyUnderwater(myMaterial, { caustics: 0.0 });  // e.g. for cave interiors
 */
import * as THREE from 'three';
import { U } from './globals.js';
import { SURFACE_PARS, SURFACE_FRAG, SURFACE_PRESETS } from './surface.js';

const UW_PARS_BASE = /* glsl */ `
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uFogColor;
uniform vec3  uScatterColor;
uniform float uScatterStrength;
uniform vec3  uAbsorption;
uniform float uMaxVisibility;
uniform float uSkyAtten;
uniform float uScatterG;
uniform float uGainChroma;
uniform sampler2D uCausticsTex;
uniform float uCausticsScale;
uniform float uCausticsStrength;
uniform vec4 uCausticOccluders[8];
uniform float uCausticsSpeed;
uniform float uDepthDarken;
uniform float uWaterLevel;
uniform float uUnderwater;
uniform float uMatCaustics;
uniform float uMatFogScale;
uniform float uMatDepthResponse;
varying vec3 vUwWorldPos;
varying vec3 vUwWorldNormal;

// Self-lit output must be exempt from depth darkening. applyUnderwater() defines
// this as totalEmissiveRadiance on materials that have one; a custom
// ShaderMaterial that includes UNDERWATER_PARS directly gets the safe default and
// may #define its own before including.
#ifndef UW_EMISSIVE
#define UW_EMISSIVE vec3(0.0)
#endif

/**
 * Depth-integrated single scattering — THE shared medium model.
 *
 * Geometry pixels reach this through the material injection below; open-water
 * pixels (where there is no geometry to shade) must reach it through
 * render/underwater.js's fullscreen pass. Both call this same function, because
 * when they disagreed the horizon showed a seam and the water column stayed
 * isotropic while lit geometry did not.
 *
 *   rd        unit ray direction, camera -> scene
 *   sEnd      distance to the shaded point, metres (use a large value for sky/void)
 *   camDepth  camera depth below the surface, metres, >= 0
 *
 * Returns in-scattered radiance, normalised so a HORIZONTAL far-field ray
 * resolves exactly to the biome's authored fog colour.
 */
vec3 uwInscatter(vec3 rd, float sEnd, float camDepth) {
  vec3 sigmaT = uAbsorption;
  vec3 kd     = uAbsorption * uSkyAtten;

  // An upward ray leaves the water at the surface; past that it is sky, not medium.
  float s = sEnd;
  if (rd.y > 1e-4) s = min(s, camDepth / rd.y);

  // b goes negative looking up (the ray climbs into brighter water). The closed
  // form stays valid through zero, so evaluate sEnd*(1-exp(-x))/x and cover the
  // removable singularity with its Taylor series. Clamping b positive would cap
  // the up-look and flatten the very gradient this exists to create.
  vec3 b = sigmaT - kd * rd.y;
  vec3 x = b * s;
  vec3 series = 1.0 - 0.5 * x + x * x * (1.0 / 6.0);
  vec3 exact  = (1.0 - exp(-x)) / (x + vec3(1e-9));
  vec3 ratio  = mix(exact, series, step(abs(x), vec3(1e-3)));
  /**
   * SOFT-CLAMP, NOT min().
   *
   * b goes negative looking up, so the integral grows without bound and needs a
   * limit. A hard min() gives that limit a KNEE: every ray past it returns
   * exactly the same value, producing a dead-flat plateau on screen. A biomes
   * builder measured it on a kelp up-look, where uSkyAtten is 2.529 and b turns
   * negative above about 23 degrees of elevation: rows 0-100, 100-200 and 200-300
   * read G 249.1 / 249.8 / 249.8 — flat across 28% of frame height, where the
   * reference plate has a real gradient. No authored colour can fix that, because
   * the clamp is geometric: lowering the biome's level only lowers the plateau.
   *
   * x / (1 + x/limit) has the same asymptote and no knee, so the gradient
   * survives all the way up while the bound still holds.
   */
  vec3 limit = vec3(6.0) / max(sigmaT, vec3(1e-5));
  vec3 raw = s * ratio;
  vec3 integral = raw / (1.0 + max(raw, vec3(0.0)) / limit);

  // gain is 1 for a horizontal ray, >1 climbing, <1 descending. Per channel it
  // rises fastest for the MOST absorbed channel, which tinted the up-look toward
  // red — the one colour that must stay dead. uGainChroma blends the per-channel
  // gain toward its luminance so the vertical axis stays a brightness effect and
  // biomes.js keeps ownership of hue.
  vec3 gain = sigmaT * integral;
  float gainL = dot(gain, vec3(0.2126, 0.7152, 0.0722));
  gain = mix(vec3(gainL), gain, uGainChroma);
  integral = gain / max(sigmaT, vec3(1e-5));

  // Normalising by sigmaT anchors the horizontal far field on biomes.js.
  // There is deliberately no exp(-kd*camDepth) term: biomes.at() already returns
  // a depth-appropriate fog colour and depthDarken, and applying vertical
  // attenuation twice crushed a 74m drop-off frame to a median luminance of 0.
  vec3 ambient = mix(uFogColor, uScatterColor, uScatterStrength);
  vec3 inscatter = ambient * sigmaT * integral;

  // Forward scattering about the sun (Henyey-Greenstein) — this is what makes the
  // water glow toward the sun and gives god rays something to sit inside.
  float cosT = dot(rd, uSunDir);
  float g = uScatterG;
  float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
  float sunReach = exp(-uAbsorption.b * camDepth * 0.42);
  return inscatter * (1.0 + 0.55 * hg * mix(0.15, 1.0, sunReach));
}

// Per-channel transmittance over a path of dist metres.
vec3 uwTransmittance(float dist) { return exp(-uAbsorption * dist); }

// Two counter-rotating layers kill the obvious grid tiling of a single sample.
float uwCaustics(vec3 wp) {
  vec2 uv = wp.xz * uCausticsScale;
  float t = uTime * uCausticsSpeed;
  float a = texture2D(uCausticsTex, uv + vec2(t, t * 0.63)).r;
  float b = texture2D(uCausticsTex, uv * 1.71 - vec2(t * 0.81, -t * 0.44)).r;
  // min() of two layers gives the sharp caustic filaments instead of mush
  return pow(min(a, b) * 2.0, 1.6);
}

/**
 * How much of the sun reaches wp through the published occluders, 0..1.
 *
 * Ray-sphere against the sun direction, softened by the ratio of the miss
 * distance to the radius so the edge reads as a diffuse underwater shadow
 * rather than a stencil. Branchless on purpose: a break or continue on a
 * uniform condition is not reliably legal across the GLSL ES versions three.js
 * emits, and this file has already cost a round by failing to LINK in 34-37
 * programs while every module still reported init OK.
 */
float uwCausticOcclusion(vec3 wp) {
  float vis = 1.0;
  for (int i = 0; i < 8; i++) {
    vec4 o = uCausticOccluders[i];
    float live = step(0.001, o.w);
    vec3 d = o.xyz - wp;
    float t = dot(d, uSunDir);              // distance along the ray to closest approach
    float perp = length(d - uSunDir * t);   // miss distance
    // Only occluders BETWEEN the point and the sun cast anything.
    float ahead = step(0.0, t);
    float shade = 1.0 - smoothstep(o.w * 0.45, o.w * 1.35, perp);
    // Contact softening: a distant occluder throws a weaker, vaguer shadow.
    shade *= exp(-max(t, 0.0) * 0.055);
    vis *= 1.0 - live * ahead * shade * 0.92;
  }
  return clamp(vis, 0.0, 1.0);
}

// Caustics with the sun's path to wp taken into account.
float uwCausticsOccluded(vec3 wp) { return uwCaustics(wp) * uwCausticOcclusion(wp); }
`;
/**
 * VERTEX-SAFE half. The surface helpers call fwidth(), which does not exist in
 * the vertex stage in GLSL ES — injecting them there silently failed to LINK
 * 34-37 programs (terrain, structures, vehicles, base, schooling, marine snow,
 * the medium pass, every lamp and every held tool), while every module still
 * reported init OK. The game rendered flora and HUD over empty water for a whole
 * round and was scored as an art problem. Vertex gets this; fragment gets both.
 */
export const UNDERWATER_PARS_VERT = UW_PARS_BASE;

/** Fragment-stage pars: medium + surface microstructure. */
export const UNDERWATER_PARS = UW_PARS_BASE + SURFACE_PARS;

/**
 * three.js's project_vertex applies instanceMatrix to a COPY of `transformed`,
 * never to `transformed` itself. Reading `transformed` here therefore gave every
 * InstancedMesh in the game the position of instance zero — so all flora, all
 * fish and every school computed fog, caustics and depth from the wrong world
 * point. Two separate agents found this independently; it was silent because a
 * single instance at the origin looks correct.
 */
const uwVert = (normalExpr, instanced) => /* glsl */ `
  {
    vec4 uwLocal = vec4(transformed, 1.0);
    ${instanced ? 'uwLocal = instanceMatrix * uwLocal;' : ''}
    vUwWorldPos = (modelMatrix * uwLocal).xyz;
    ${normalExpr
      ? `vec3 uwN = ${normalExpr};
    ${instanced ? 'uwN = mat3(instanceMatrix) * uwN;' : ''}
    vUwWorldNormal = normalize(mat3(modelMatrix) * uwN);`
      : 'vUwWorldNormal = vec3(0.0, 1.0, 0.0);'}
  }
`;

export const UNDERWATER_FRAG = /* glsl */ `
{
  vec3  toCam    = uCamPos - vUwWorldPos;
  float viewDist = length(toCam);
  vec3  viewDir  = toCam / max(viewDist, 1e-4);

  // --- depth of the shaded point below the surface (metres, >=0)
  float pointDepth = max(0.0, uWaterLevel - vUwWorldPos.y);

  // --- sunlight extinguished on the way down: deep geometry loses red, then all
  vec3 sunT = exp(-uAbsorption * pointDepth * 0.42);

  // --- caustics: only up-facing, only where light still reaches
  float upFace = clamp(vUwWorldNormal.y * 0.5 + 0.5, 0.0, 1.0);
  upFace = upFace * upFace;
  float causticFade = exp(-pointDepth * 0.020);
  float caus = uwCausticsOccluded(vUwWorldPos) * upFace * causticFade
             * uCausticsStrength * uMatCaustics * uUnderwater;
  gl_FragColor.rgb += uSunColor * sunT * caus * 0.55;

  // --- ambient falls off with depth so nothing floats in a flat lit void.
  // EMISSIVE MUST BE EXEMPT: this runs after the material is fully shaded, so
  // dimming the final colour attenuated self-lit surfaces as if they were
  // sunlit — a factor of ~35 at 200m, which killed every bioluminescent plant
  // and meant nothing built by structures/ could ever cross postfx's bloom
  // threshold. Split the emissive out, dim only the lit part, then add it back.
  // (Emissive still gets view-ray extinction below, which is correct.)
  // uMatDepthResponse lets a sealed, pressurised, dry interior opt out: a ceiling
  // lamp two metres away inside a habitat should not be attenuated by 200m of
  // ocean above the roof. 1 = full ocean response, 0 = none.
  {
    vec3 uwEmis = UW_EMISSIVE;
    vec3 uwLit = max(gl_FragColor.rgb - uwEmis, vec3(0.0));
    float uwDark = mix(1.0, mix(0.06, 1.0, sunT.b) * uDepthDarken, uUnderwater);
    uwLit *= mix(1.0, uwDark, uMatDepthResponse);
    gl_FragColor.rgb = uwLit + uwEmis;
  }

${SURFACE_FRAG}

  // ---------------------------------------------------------------------
  // View-ray extinction + DEPTH-INTEGRATED in-scattering.
  //
  // The old form used a single constant in-scatter colour, so a pixel looking
  // up and a pixel looking down at the same distance came out identical. That
  // measured 1.25:1 zenith-to-nadir against the reference's 14.8:1 and is why
  // every frame read as one flat plane of colour with no distance axis.
  //
  // Instead, integrate single scattering along the ray analytically. Radiance
  // reaching the eye from the medium is
  //
  //     L = integral(0..S) sigma_s * E(z(s)) * exp(-sigma_t * s) ds
  //
  // with the ray's depth z(s) = z0 - rd.y * s and downwelling irradiance
  // E(z) = E0 * exp(-kd * z). Both exponentials are in s, so it collapses to a
  // closed form with b = sigma_t - kd * rd.y:
  //
  //     L = sigma_s * E0 * exp(-kd*z0) * (1 - exp(-b*S)) / b
  //
  // Looking up, rd.y > 0 shrinks b and the integral grows; looking down it
  // shrinks. That single sign flip is the whole vertical gradient, and it comes
  // out of the physics rather than being painted on.
  // ---------------------------------------------------------------------
  float d  = min(viewDist, uMaxVisibility * 3.0) * uMatFogScale;
  vec3  rd = -viewDir;                            // camera -> shaded point
  float z0 = max(0.0, uWaterLevel - uCamPos.y);   // camera depth, metres

  vec3 T = mix(vec3(1.0), uwTransmittance(d), uUnderwater);
  vec3 inscatter = mix(vec3(0.0), uwInscatter(rd, d, z0), uUnderwater);

  gl_FragColor.rgb = gl_FragColor.rgb * T + inscatter;
}
`;

/**
 * Patch a material so it participates in the shared underwater medium.
 * @param {THREE.Material} material
 * @param {{caustics?:number, fogScale?:number}} [opts]
 *        caustics  0..1 multiplier (0 for cave/base interiors)
 *        fogScale  0..1 multiplier on view-ray fog (use <1 inside habitats)
 */
export function applyUnderwater(material, opts = {}) {
  if (!material || material.userData.__uw) return material;
  material.userData.__uw = true;
  material.fog = false; // we own atmospherics entirely

  const uMatCaustics = { value: opts.caustics ?? 1.0 };
  const uMatFogScale = { value: opts.fogScale ?? 1.0 };
  const uMatDepthResponse = { value: opts.depthResponse ?? 1.0 };
  // Surface microstructure: pass { surface: 'hull' } for a preset, or an object.
  const sp = typeof opts.surface === 'string'
    ? (SURFACE_PRESETS[opts.surface] || null)
    : (opts.surface || null);
  // Clamp to the documented range. A census of the live scene found six materials
  // running grain 0.30-0.90 against a documented 0..0.25 and two at wear 1.10-1.15,
  // which is how the microstructure became a blotch that painted over panel lines.
  const clamp01 = (v, hi) => Math.max(0, Math.min(hi, v ?? 0));
  const uSurfGrain  = { value: clamp01(sp?.grain,  0.25) };
  const uSurfWear   = { value: clamp01(sp?.wear,   1.0) };
  const uSurfStreak = { value: clamp01(sp?.streak, 1.0) };
  const uSurfScale  = { value: sp?.scale  ?? 1.5 };
  material.userData.uwUniforms = { uMatCaustics, uMatFogScale, uMatDepthResponse,
    uSurfGrain, uSurfWear, uSurfStreak, uSurfScale };
  material.userData.uwSurface = !!sp;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir,
      uSunColor: U.uSunColor, uFogColor: U.uFogColor,
      uScatterColor: U.uScatterColor, uScatterStrength: U.uScatterStrength,
      uAbsorption: U.uAbsorption, uMaxVisibility: U.uMaxVisibility,
      uSkyAtten: U.uSkyAtten, uScatterG: U.uScatterG, uGainChroma: U.uGainChroma,
      uCausticsTex: U.uCausticsTex, uCausticsScale: U.uCausticsScale,
      uCausticsStrength: U.uCausticsStrength, uCausticsSpeed: U.uCausticsSpeed,
      uCausticOccluders: U.uCausticOccluders,
      uDepthDarken: U.uDepthDarken, uWaterLevel: U.uWaterLevel,
      uUnderwater: U.uUnderwater, uMatCaustics, uMatFogScale, uMatDepthResponse,
      uSurfGrain, uSurfWear, uSurfStreak, uSurfScale, uSfPixelScale: U.uSfPixelScale,
    });

    // Which normal expression is actually in scope?
    //
    // Searching for '<beginnormal_vertex>' is NOT sufficient: three's meshbasic
    // vertex shader contains that include INSIDE an
    // `#if defined(USE_ENVMAP) || defined(USE_SKINNING)` guard, so objectNormal is
    // frequently undeclared in exactly the material that appears to declare it.
    // Three separate modules reported broken MeshBasicMaterials because of this.
    //
    // Decide by material class instead, which is unambiguous: mesh materials get
    // three's `normal` attribute declared in the program prefix; points, lines and
    // sprites do not get one at all.
    const noNormalAttr = material.isPointsMaterial || material.isLineBasicMaterial
      || material.isLineDashedMaterial || material.isSpriteMaterial;
    const objectNormalInScope = !noNormalAttr && !material.isMeshBasicMaterial
      && shader.vertexShader.includes('#include <beginnormal_vertex>');
    const hasNormal = !noNormalAttr;
    // objectNormal carries skinning/morphing; the raw attribute does not, but it is
    // always present, and it only feeds the caustic up-face term.
    const normalExpr = objectNormalInScope ? 'objectNormal' : 'normal';

    // three applies instanceMatrix to a copy of `transformed`, so we must apply it
    // ourselves or every instance reports the position of instance zero.
    const instanced = /\bUSE_INSTANCING\b|\binstanceMatrix\b/.test(shader.vertexShader);

    // totalEmissiveRadiance only exists on materials that actually have emissive
    // (standard/phong/lambert). Basic/points/line get the vec3(0.0) default from
    // the #ifndef in UNDERWATER_PARS.
    const emissiveDefine = (/totalEmissiveRadiance/.test(shader.fragmentShader)
      ? '#define UW_EMISSIVE totalEmissiveRadiance\n' : '')
      // Surface microstructure is opt-in per material, so the sfApply() call in
      // UNDERWATER_FRAG sits behind #ifdef UW_SURFACE and costs nothing unless
      // a preset was requested.
      + (sp ? '#define UW_SURFACE\n' : '');

    shader.vertexShader = shader.vertexShader
      // VERTEX-SAFE half only — the surface helpers call fwidth(), which does not
      // exist in the vertex stage and silently fails to link the whole program.
      .replace('#include <common>', '#include <common>\n' + UNDERWATER_PARS_VERT)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + uwVert(hasNormal ? normalExpr : null, instanced));

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + emissiveDefine + UNDERWATER_PARS);

    // Preferred anchor is dithering_fragment; fall back to the end of main().
    if (shader.fragmentShader.includes('#include <dithering_fragment>')) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <dithering_fragment>', UNDERWATER_FRAG + '\n#include <dithering_fragment>');
    } else {
      const i = shader.fragmentShader.lastIndexOf('}');
      shader.fragmentShader = shader.fragmentShader.slice(0, i) + UNDERWATER_FRAG + '\n}'
        + shader.fragmentShader.slice(i + 1);
    }
  };

  // Compose rather than overwrite. A module that wraps the onBeforeCompile we
  // install, to add its own shader chunks, MUST also compose its own key on top of
  // this one — otherwise three hands it the program compiled for a different
  // variant. Overwriting with a bare constant caused exactly that collision.
  const priorKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () =>
    'uw|' + (sp ? 'sf' : '') + (priorKey ? priorKey.call(material) : material.type || '');
  material.needsUpdate = true;
  return material;
}

/** Convenience: patch every material on an Object3D subtree. */
export function applyUnderwaterDeep(root, opts) {
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => applyUnderwater(m, opts));
  });
  return root;
}
