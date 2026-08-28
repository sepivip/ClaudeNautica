# ClaudeNautica — Agent Brief

We are building a playable underwater survival game that stands next to **Subnautica**
visually and experientially. Not "inspired by". Next to it.

Read this fully before writing code. Then read `reference/LOOK.md` — the written spec of
Subnautica's visual identity — and look at the real frames in `reference/subnautica/`.

---

## 1. How the project is organised

Everything is a **module** with one owner. You own exactly one file. Never edit another
module's file, and never edit `src/core/*` or `src/main.js` unless you are told you own core.

```
src/main.js                bootstrap, game loop, the window.__CN capture harness   [core]
src/core/globals.js        shared uniforms `U`, WORLD constants                    [core]
src/core/underwaterMaterial.js   the shared underwater shading injection           [core]
src/core/engine.js         renderer, HDR target, frame graph                       [core]
src/core/shots.js          the canonical A/B camera framings                       [core]
src/core/rng.js            deterministic noise + RNG                               [core]
src/core/modules.js        the module manifest                                     [core]

src/render/sky.js          sky, sun/moon, clouds, above-water atmosphere
src/render/underwater.js   the water medium: fog/absorption per depth+biome, god rays, marine snow
src/render/watersurface.js the air/water interface from both sides
src/render/postfx.js       HDR post chain: bloom, tonemap, grade, DoF, AA, distortion
src/world/biomes.js        biome data: palettes, depth bands, spawn tables
src/world/terrain.js       the seabed
src/world/flora.js         kelp, coral, grass, bioluminescence
src/world/structures.js    caves, wrecks, the lifepod, POIs
src/life/creatures.js      creature bodies, swim animation, AI
src/life/schooling.js      fish schools
src/player/movement.js     swimming feel
src/player/survival.js     O2, food, water, health, pressure
src/player/tools.js        scanner, flashlight, knife, inventory, crafting
src/vehicles/vehicles.js   Seamoth, Seaglide
src/base/base.js           seabase building + interiors
src/ui/ui.js               HUD, PDA, menus
src/audio/audio.js         ambience, muffling, creature calls
```

### Module contract

```js
export default {
  id: 'terrain',
  async init(ctx) { /* build objects, ctx.scene.add(...) */ },
  update(dt, t, ctx) { /* per-frame sim */ },
  preRender(ctx) { /* last-moment uniform writes */ },
  shots: { 'dropoff': (ctx) => { /* optional per-shot setup */ } },
};
```

`ctx` = `{ engine, renderer, scene, camera, U, WORLD, input, rng, time, uiRoot, params,
get(id), has(id), provide(k,v) }`.

`ctx.get('terrain')` returns another module's exported object — that is how you consume
someone else's work. **Always guard it**: other modules may still be stubs.

```js
const terrain = ctx.get('terrain');
const y = terrain?.heightAt ? terrain.heightAt(x, z) : -30;
```

A module that throws during `init` or `update` is disabled and reported, and the rest of
the game keeps running. That is deliberate — it means your work can be judged before the
world around it exists.

### Published interfaces other modules rely on

If you own one of these, you **must** export it — other agents are depending on it:

| Module | Must export |
|---|---|
| `terrain` | `heightAt(x,z) -> number`, `normalAt(x,z) -> Vector3`, `biomeAt(x,z) -> string` |
| `biomes` | `get(name)`, `atDepth(y)`, `at(x,y,z)`, `list()` — each biome has fog colour, absorption, visibility, palette, spawn table |
| `underwater` | writes the shared `U.*` medium uniforms each frame |
| `postfx` | `render(srcTarget, dstTarget)`, and sets `ctx.engine.postfx = this` |
| `movement` | `position`, `velocity`, `isSubmerged`, `attach(camera)` |
| `survival` | `oxygen`, `health`, `food`, `water`, `damage(n)` |
| `creatures` | `spawnAt(name,pos)`, `list()`, `nearest(pos)` |
| `ui` | `setMessage(text)`, `notify(text)` |

### The shared underwater look — non-negotiable

Every material on world geometry **must** be patched:

```js
import { applyUnderwater, applyUnderwaterDeep } from '../core/underwaterMaterial.js';
applyUnderwater(myMaterial);                    // one material
applyUnderwaterDeep(myGroup);                   // whole subtree
applyUnderwater(mat, { caustics: 0, fogScale: 0.25 });  // inside a base/cave
```

This injects per-channel Beer-Lambert extinction, depth-attenuated sunlight, in-scattering
and caustics. Anything unpatched will visibly float out of the water and will be rejected
by the critic immediately. If you write a fully custom `ShaderMaterial`, import
`UNDERWATER_PARS` / `UNDERWATER_FRAG` and integrate them by hand.

Read the medium from `U` (`src/core/globals.js`) — never hardcode a fog colour.

### The shared medium model — call it, do not reimplement it

`UNDERWATER_PARS` exports GLSL functions that **any** shader may call, including your own
`ShaderMaterial` or fullscreen pass. Geometry pixels reach them through `applyUnderwater()`;
open-water pixels (where there is no geometry to shade) must reach them through
`render/underwater.js`'s fullscreen pass. Both paths **must** use these, or the water column and
the lit geometry disagree and the horizon shows a seam:

```glsl
vec3 uwInscatter(vec3 rd, float sEnd, float camDepth);  // in-scattered radiance
vec3 uwTransmittance(float dist);                       // per-channel transmittance
float uwCaustics(vec3 worldPos);                        // caustic filaments, 0..~1
```

`uwInscatter` integrates single scattering analytically along the ray, so it is **anisotropic in
elevation**: looking up climbs into brighter water and the integral grows, looking down it shrinks.
That sign flip is the entire vertical gradient — the thing three separate critics measured us
failing at (1.25:1 zenith-to-nadir against the reference's 14.8:1). It is normalised so a
*horizontal* far-field ray resolves exactly to the biome's authored fog colour, which keeps
`biomes.js` the single source of truth. `U.uSkyAtten` scales the strength of that axis.

To composite a pixel:

```glsl
vec3 T = uwTransmittance(dist);
color = color * T + uwInscatter(rayDir, dist, cameraDepth);
```

---

## 2. Rendering rules

- The scene renders into an **HDR half-float target**. Keep colours **linear** and let
  values exceed 1.0 for bright things; `postfx` owns tonemapping and grading. Do not
  tonemap in your own shader.
- Use `THREE.SRGBColorSpace` on colour/albedo textures; **linear** for data textures
  (normal, roughness, noise, masks).
- Instance aggressively (`InstancedMesh`) — thousands of plants and fish, not thousands of
  draw calls. Budget: the whole game should hold **≥60 fps at 1920×1080 on an RTX 5070**,
  with **< 900 draw calls** in a typical frame.
- Generate textures **procedurally in code** (canvas or data textures) or with shader math.
  We have no art pipeline and no binary assets. This is a constraint on *method*, not on
  quality — the output still has to look photoreal.
- Prefer one well-authored shader over five stacked hacks.

---

## 3. THE BUILD GATE — run this first, and run it last

```bash
node tools/verify.mjs          # ~40s: boot, render a shot, all shader + module checks
node tools/verify.mjs --full   # all 18 shots + fps budget
```

**Run it before you start and before you report done. If it fails, nothing else you do
this round counts.**

Why it is mandatory: a vertex-stage `fwidth()` once failed to LINK 34-37 shader programs.
Nothing threw. Every module reported init OK. The game drew flora and a HUD over empty
water — and six builders and six critics spent an entire round grading a game that was not
rendering. Five subsystem scores had to be thrown away. **A shader that fails to compile
does not raise an error; it just silently draws nothing.**

`window.__CN.status()` now reports `brokenBuild` and lists `shaderErrors` alongside module
failures, and `tools/capture.mjs` refuses the run and exits non-zero when any program fails
to link. **A report.json with `brokenBuild: true` is not evidence about art — do not score
it, do not compare against it, say so and stop.** A git pre-commit hook runs the gate too.

If you write shader code that others include, remember what actually bit us:
- `fwidth`/`dFdx`/`dFdy` do not exist in the **vertex** stage in GLSL ES.
- Varyings are **write-only** in the vertex stage — never read one in shared code.
- Shared pars included twice **redeclare** every uniform; guard with `#ifndef`.
- Generic uniform names **collide**: `uPixelScale` clashed with the point-size uniform
  every particle system here already had. Namespace anything you add.

### The harness must never change the game

`ctx.harness` tells you who is driving: `.still` (a screenshot battery), `.play` (a scripted
playthrough — **real gameplay**), `.none` (a human).

**Branch gameplay on `harness.still` only. NEVER on `capture`.** `?capture=1` means "render
deterministically" and nothing else. survival.js once inferred "we're in a screenshot battery, so
don't let the player die" from it — and `tools/play.mjs` also sent `capture=1`, so every play route
ever run measured a game with a 35 HP god-mode floor that **could not kill the player**. The defect
"health freezes at exactly 35" *was* that floor. It survived several rounds because the instrument
was altering the subject.

If you suppress or override anything for the harness, you **must** declare it:

```js
ctx.declareGodMode('survival', 'health floored at 35 during still captures');
```

It then appears in `window.__CN.status().godModes`, in every `report.json`, and `play.mjs` prints
a **GOD MODES ACTIVE — THIS IS NOT THE REAL GAME** banner. A critic who sees a non-empty
`godModes` should treat the measurement as suspect and say so.

## 4. How you verify your own work — do this before you report done

Never claim it looks good without looking at it.

```bash
node tools/capture.mjs --tag=<piece>-r<round> --shots=godrays,shallows-reef --w=1920 --h=1080
node tools/capture.mjs --tag=<piece>-r<round> --all          # the full 17-shot battery
```

Writes `shots/<tag>/<shot>.png` and `shots/<tag>/report.json`.

1. **Read `report.json` first.** `status.failed` lists modules that threw. `consoleErrors`
   catches shader compile failures. A black or empty PNG almost always means an exception,
   not a lighting problem.
2. **Open the PNGs with the Read tool and actually look at them.**
3. **Open the matching `reference/subnautica/` frame and look at it in the same message.**
   Name the differences out loud, then fix them and capture again.
4. Confirm `fps`, `drawCalls` and `triangles` in the report are within budget.

Available shots are listed in `src/core/shots.js`.

### Shot isolation — batteries no longer contaminate each other

The same shot used to measure differently depending on which shot ran before it. Reproduced:
godrays came out saturation **0.879** after `cave`, **0.958** alone, and **0.985** after
`seamoth-cockpit` — a 0.106 swing on an identical build, seed and params, while that shot's own
run-to-run noise is exactly **zero**. Adaptive exposure, temporal AA history and streaming state all
survived the teleport between shots, so every metric taken from a multi-shot battery carried the
previous shot's history.

Two fixes, and both matter to you:

1. `capture.mjs --all` now runs each shot from a **fresh page**, and every shot (including the
   first) gets an identical warm-up settle. Verified: those same three orderings now all read
   0.982 / R% 2, spread inside the noise floor. Use `--isolate=false` only for quick iteration,
   never for a number you intend to publish or compare.
2. **If your module has temporal state — adaptive exposure, TAA history, current accumulators,
   spawn timers — implement `resetForShot(ctx)` and clear it there.** `applyShot` calls it on every
   module before settling. Without it your module is the reason someone else's measurement moved.

### Hue variety, not saturation

`measure.mjs` reports `hueVar` and `hues`. On a fair pair our frame measured saturation **1.19x** the
reference but hue variance **0.44x** it — one hue bucket against two. The reference carried teal
water, green algae, brown rock, yellow spots and warm coral in one image; ours was a single intense
cyan.

So "we are too saturated" is a misreading. **We are monochromatic.** Desaturating a monochrome frame
only makes it duller. Distinct materials must sit in distinct hue families — rock brown, algae green,
coral warm, water teal — rather than every surface being tinted toward the medium. Target hueVar at
or above the plate's.

### The measurement noise floor — know what counts as a real delta

Captures are deterministic in the GRADE but **not in geometry**. A builder measured two runs of the
same build, seed and params giving godrays 244 vs 245 draws, kelp-forest 205 vs 192, deep-void 306 vs
266, wreck 327 vs 310 — so **whole-PNG md5 is not a valid A/B instrument.** Window statistics on the
same water WERE bit-identical run to run, so the variation is in geometry and streaming, not in
colour. Measure windows, not whole frames, and never A/B on a file hash.

**Chromaticity must be read in LINEAR light.** `measure.mjs` reports `sat`, `redPct` and `gbLinear`
decoded to linear, plus `satCode`/`redPctCode` kept only for continuity with pre-round-31 reports.
sRGB's -0.055 offset makes code-space G/B drift with level — upward below 1, downward above 1 — so
our water and the plates were biased in opposite directions and a whole round was set on a "6x gap"
that decomposed almost entirely into that. Also read `clipAny`, not `clipPct`: the old metric counted
only luminance >= 250 and cleared a window that was 98.63% green-railed. They used to not be, because capture.mjs unfroze the loop for a 1.2s
wall-clock perf window, so a faster machine advanced the simulation further before the screenshot.
A critic correctly identified that as the reason fixed-crop A/B here was unsound — it measured the
same unchanged build at detail 10.10 and 21.83, a **2x spread**, which is wider than almost any
improvement anyone has claimed.

Re-measured after the fix, two runs of the same shot at the same seed:

| metric | spread |
|---|---|
| detailRMS, tileContrast | **0.4%** |
| octaves, fine bands | **0.1%** |
| octaves, coarsest band | **3.4%** |
| pixels differing by >3 | 11.9% (particles and TAA jitter) |

**So: a change under ~1% on detail/tileContrast/fine octaves is noise. Under ~4% on the coarse
octave is noise.** Anything larger is real. Do not publish a headline gain smaller than the floor,
and if you cannot reproduce your own number across two runs, do not report it.

### Judging motion, not just stills

A still cannot show whether kelp sways plausibly, whether a fish undulates as it turns, or whether
swimming has weight. Capture a **contact sheet** — one PNG holding N frames across time — and read
it in a single Read call:

```bash
node tools/motion.mjs --tag=flora-r1 --shot=kelp-forest --frames=9 --interval=0.28
node tools/motion.mjs --tag=x --shot=hud --frames=12 --interval=0.2 --dolly=0,0,-14   # camera moves
```

Writes `shots/<tag>/motion-<shot>.png` plus the individual frames. Any module with movement —
flora, creatures, schooling, movement, watersurface, vehicles — must be verified this way, and any
critic reviewing one of those must look at a contact sheet before scoring.

### Judging whether it *plays*

Screenshots prove it renders. A scripted playthrough drives the game through its real input path
and reports what a player would have experienced:

```bash
node tools/play.mjs --list                              # available routes
node tools/play.mjs --route=dive --tag=movement-r1      # surface -> 40m descent
node tools/play.mjs --route=descend --tag=x             # long descent, tests the depth ramp + O2
node tools/play.mjs --route=surface --tag=x             # breaking the waterline
```

Writes a contact sheet plus a JSON timeline of position, depth, speed, oxygen, health and fps. If
`moved: false` comes back, the player did not actually go anywhere — fix that before anything else.
Anyone owning movement, survival, tools, vehicles or ui must verify with this, not just with stills.

### Blind A/B

```bash
node tools/blind.mjs make --tag=<capture tag> --shots=godrays,shallows-reef
# read blind/<trial>/QUESTIONS.md, look at each NNN-a.png / NNN-b.png pair, decide which is real
node tools/blind.mjs score --trial=<trial> --answers=001:a,002:b
```

Never read `blind/.keys/` — that is the answer key and reading it invalidates the trial.

### Publish your status to the live progress page

```bash
node tools/progress.mjs set --piece=terrain --status=building --round=1
node tools/progress.mjs set --piece=terrain --status=critiquing --round=1 \
  --tag=terrain-r1 --score=54 --verdict="..." --gap="..."
node tools/progress.mjs note --text="terrain: added stratified cliff banding"
```

Statuses: `not-started` `building` `critiquing` `iterating` `passed` `blocked`.

---

## 5. The bar

The question is never "is this good for a browser game". It is:

> Put our frame next to a real Subnautica frame. Would a Subnautica player be able to tell
> which is which — and would they prefer ours?

### Surface microstructure — every asset needs one

A whole-game critic, after the water medium stopped deciding blind trials, named what replaced it:

> "Nothing in this game has a surface. Hull plating, cockpit interior, base lockers, fish flanks,
> jellyshroom caps, the lifepod, kelp blades — every asset is a smoothly-shaded solid colour with
> painted-on line art and zero sub-object albedo, wear, pore or grain variation, so it reads as
> moulded vinyl."

It decided **9 of 18 blind pairs on its own**. The measurement that matters: our wreck hull crop has
tileContrast **43.15** against the real hull's **9.2** — we carry 4.7× *more* local contrast than the
reference, and all of it is hard-edged decal. The reference carries its signal as **low-amplitude
broadband** texture. So the fix is not "more detail", it is detail of the right kind.

`src/core/surface.js` provides it, and `applyUnderwater` wires it in:

```js
applyUnderwater(mat, { surface: 'hull' });      // preset
applyUnderwater(mat, { surface: { grain: 0.09, wear: 0.5, streak: 0.4, scale: 2.2 } });
```

Presets: `hull`, `rock`, `sand`, `organic`, `skin`, `interior`, `glass`. It gives you seven octaves
at a 1/f roll-off (no dominant frequency), cavity/edge wear, and vertical gravity streaking for
things that have sat in water for years — all triplanar from world position, so nothing tiles or
stretches. It also modulates **roughness**, not just albedo: a surface uniform in gloss reads as
plastic no matter how good its colour is.

The GLSL is callable directly too: `sfApply(color, worldPos, normal, out roughDelta)`,
`sfBroadband(p)`, `sfWear(wp, n)`, `sfStreak(wp, n)`.

**Tune it by measuring, not by eye.** Amplitudes are deliberately subtle — the target is to *lower*
hard-edged contrast toward ~9 while raising broadband content. Verify with
`tools/measure.mjs --crop=<your surface>` against the matching reference crop.

### Measured non-negotiables

These are not opinions. They were sampled off 58 real Subnautica frames with a pixel-readback
script; the full tables are in `reference/LOOK.md` and you are expected to read them.

1. **The hue path is not blue→black.** It is cyan-blue `#2C9BC8` (0–20 m, B>G) → **green-teal
   `#00AA9C` at 100–200 m, where green OVERTAKES blue and red measures 0** → navy `#16436F`
   (300 m+) → black `#030505` (600 m+). A monotonic blue→black ramp is the #1 amateur tell.
2. **Red is gone.** Mid-water measures R = 0–15 against G/B of 60–170. If your water has a
   meaningful red channel below 30 m, it is wrong.
3. **Fog is per-biome and overrides the depth ramp.** Kelp is *green* `#0B3710`, the Dunes are
   *warm tan-brown* `#6B5845`, Jellyshroom is *violet* `#251438`, Lost River is brine `#013842`.
   One global blue fog is wrong.
4. **Distant unlit geometry gets BRIGHTER, not darker** — it converges toward the fog colour from
   both directions. Dark things lighten, bright things darken, both meet at the water value. Fading
   distant terrain to black is the classic error.
5. **Blacks are lifted by atmosphere, never by a curve.** A fogged frame's entire histogram
   compresses into luminance 45–168 — no true blacks, no highlights. An unlit close-range frame
   still hits 0. Do not lift blacks in the grade; let fog do it.
6. **Saturation is high** — 0.70–0.97 mean. A near-monochrome saturated field with tiny
   hyper-saturated accents. Do not "ground" it with desaturation.
7. **Visibility by depth:** 40–60 m at 0–30 m deep; 35–45 m at 50–100 m; 25–35 m at 100–200 m;
   15–25 m *only with a light* below 200 m; 10–15 m below 500 m.
8. **Caustics are big and gentle:** 0.5–1.5 m cells, only ~2:1 peak-to-shadow (+30–45% over local
   diffuse), gone by 60–80 m depth. Lamps never cast them.
9. **God rays are broad, soft, near-parallel (10–25° off vertical), and only 10–15% brighter than
   the surrounding water.** What sells them is being *occluded by terrain* into soft shadow columns
   — not their brightness.
10. **Marine snow exists at every depth, including a pure-black 8148 m frame.** 2–5 px, and it must
    take local light so it twinkles inside a lamp cone and vanishes outside it.

Things that instantly mark an amateur underwater scene, all of which we must avoid:

- Uniform blue fog with no per-channel absorption — real water kills red first, so distant
  objects go blue-grey and lose *contrast* before they lose brightness.
- Flat, evenly-lit terrain with no caustics, no light shafts, and no ambient occlusion.
- Repeating tiled textures with visible grid frequency.
- Geometry that meets the sand at a hard intersection line instead of bedding into it.
- Plants that are stiff, or that all sway in identical phase.
- Fish that translate without their bodies undulating, or that face the wrong way.
- A dead, empty midwater column — Subnautica always has particulate, small fish, and
  something moving at the edge of visibility.
- Sterile colour: real frames have strong colour separation between the lit foreground,
  the mid-ground haze and the deep background.
- Everything the same scale. Subnautica sells scale with huge terrain features and
  creatures far larger than the player.

---

## 6. Working style

- Write real, complete implementations. No TODOs, no placeholder cubes left behind, no
  "in a full version this would…". If it is in the frame, it is finished.
- Match the surrounding code's style. Comment the *why* for non-obvious math, not the what.
- Keep your module self-contained; put anything genuinely shared in a proposal back to core
  rather than editing core yourself.
- Determinism matters: use `ctx.rng` / `src/core/rng.js`, never bare `Math.random()`, so a
  seed reproduces a frame and A/B comparisons stay valid.
- If you are blocked by another module still being a stub, build against a guarded
  fallback and say so in your report — do not stall.
