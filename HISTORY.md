# Development log

Every commit from the private development repo, newest first — the real messages,
unedited. They are included because the story they tell is the interesting part of
this project: roughly half of all rounds were spent discovering that the measuring
apparatus was wrong, not the game.

---

## Round 35: terrain 57->68, watersurface 53->57, tools 41->47; two core bugs of mine fixed

TWO BUGS IN MY OWN CORE CODE, both found by the terrain critic while it was
trying to prove its own work:

1. ?nocaustocc=1 GATED ONLY THE PLAYER. main.js pushed the player behind the
   flag but left the modules.values() causticOccluders loop ungated, so the
   ablation could not empty the list and could not turn the mechanism off. Sixth
   inert ablation flag in this project — the class of bug that has cost more
   rounds here than any other. Now verified to move the frame.

2. PENUMBRA SCALED WITH RADIUS, NOT DISTANCE. underwaterMaterial.js smoothstepped
   o.w*0.45..o.w*1.35, so a pebble and a whale threw equally crisp shadows and
   neither softened with range. Now widens with distance to the occluder.

ROUND RESULTS. terrain 68: caustic occlusion is genuinely live and verified by
in-page A/B, and its refusal was upheld on both halves. watersurface 57: the
black tail is largely closed (under-L45 57.06% -> 0.00%, every octave moved
toward the plate) and its wave-table refusal reproduced exactly — four pairs
within 3 degrees of orthogonal, ratios 1.396-1.405 against sqrt2. tools 47: the
torch finally reveals the world (cave window L 6.35e-3 -> 2.23e-2) and five real
defects were fixed at source, including a stale copy of postfx's near-gain
constants that had drifted from the live uniform.

WHAT THE CRITICS REFUSED TO PASS. tools: the multiplicative pool term scales the
medium's own colour, so switching the torch on drops hueVar 0.323 -> 0.258 and
relative red 50.2 -> 39.6 — it worsens the project's #1 named defect, while the
additive pass alone holds 0.317 / 47.8. watersurface: both plates carry a
near-to-far chroma ramp of 28-44% in gbLinear and ours moves under 3%; the
builder's hue defence tested within-band variance, which is the wrong axis.
terrain: a 45-degree comb in the sand, anisotropy 1.537 diagonal against 1.168
in x/y where the plate reads 1.05-1.25, now unmasked by the quieter grain.

flora's critic died on a StructuredOutput retry cap, so flora's builder work is
in the tree UNJUDGED.

Independently corroborated: watersurface's critic measured a MAX frame of
9,232.7 ms from two shader-compile stalls of 36 and 35 programs, none of them its
own — the same defect perfprobe found, confirmed by an agent that was not
looking for it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## perfprobe: cold shader cache by default; a 4th stall fix failed and was reverted

MEASUREMENT FIX. Chrome persists compiled programs to a GPU shader disk cache
that survives launches, so every probe run warmed the cache for the next one and
back-to-back A/Bs compared a cold arm against a warm one instead of the change
under test. perfprobe now passes --disable-gpu-shader-disk-cache by default
(--warmcache=1 for the repeat-launch case), because a player's first launch after
a reboot is the cold case.

FIX #4, REVERTED. A warm-up that forced visible=true for the duration of
compileAsync and restored it immediately after. The reasoning was sound —
compile() only walks and compiles, it never draws, so forcing visibility has no
visual effect and reaches the culled geometry that defeated attempts 1-3. It is
simply inert:

    cold, warm-up ON    108.5 / 106.7 fps    MAX 8,206 / 8,771 ms
    cold, warm-up OFF   104.7 fps            MAX 7,960 ms

WHAT THE NUMBERS ACTUALLY SAY NOW. Moving, the game holds ~105 fps with p50 under
7 ms, and still throws single frames of 6-9 SECONDS. The earlier 18 fps / 26,692
ms reading does not reproduce in eight subsequent runs and should be treated as
an outlier, not the baseline — the real, repeatable defect is an ~8 s freeze, not
a 27 s one.

RULED OUT SO FAR: the shadow map (?noshadows=1 changes nothing), the per-second
enableShadows pass, the shader disk cache, and all four warm-up strategies. The
world has ~94 distinct program variants (48 MeshStandard configurations, 21
Lambert, 15 depth, plus creature animation modes) and they compile lazily and
synchronously as content streams in.

Four fixes have now failed, which by the debugging rule this project follows means
the architecture is the problem rather than the patch: either the program variety
has to come down, or compilation has to be moved off the frame entirely. Handing
that judgement to Beka rather than attempting a fifth guess overnight.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## perfprobe: swim like a player — the stall is 10x worse than the static probe showed

Beka asked whether him running the game would help. It did: the probe sat with a
STATIC camera and saw one or two compile stalls in 110 s, while he — swimming
around — called the game almost unplayable. Moving drags new species, biomes,
terrain and structures into view continuously, and every first draw of an
uncompiled material variant is another synchronous compile.

    static camera   90 fps   worst frame  2,520 ms   2 programs per stall
    swimming        18 fps   worst frame 26,692 ms  31 programs per stall

Three separate freezes of 16, 25 and 26 SECONDS in a 100 s run, each compiling
about thirty shader programs at once. The static measurement was of a strictly
easier case than the one a player experiences, and it under-reported the severity
by an order of magnitude.

perfprobe now holds KeyW and steers through a set of legs by default
(--move=0 restores the old static behaviour).

RULED OUT: the shadow map. With ?noshadows=1 and the map fully disabled while
moving, it still reads 17.6 fps with a 24,803 ms worst frame — so the depth
variants visible in the compile logs are a symptom, not the cause. main.js gains
?noshadows=1 and ?noshadowloop=1 as declared godMode ablations for the ongoing
investigation.

Still open: ~30 enormous programs compile lazily and synchronously as the world
streams in. This is architectural — either the program variety has to come down,
or every variant has to be warmed before it can be drawn, and the obvious warming
route is blocked because modules range-cull with visible=false while three.js
compile() walks with traverseVisible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Add perfprobe.mjs — measure the REAL rAF loop, which nothing ever did

Beka reported the game hitching every ~30s in actual play. Every fps number in
35 rounds came from capture.mjs, which FREEZES the loop and steps it manually
(fpsSource 'step'). That measures engine.render() on an already-warm program set
and never runs simulate() at all, so this class of defect was structurally
invisible to the whole loop.

perfprobe.mjs runs the game the way a player does — real requestAnimationFrame,
no capture flag, no freezing — and reports a per-second series (a periodic stall
averages away over a short window), per-module update/preRender cost, browser
longtasks, and the shader programs that compile mid-play.

FOUND, with the loop running: p50 is a healthy 10-11 ms, but single frames hit
2,200-4,300 ms. The stall is inside engine.render() (worst render call 4,257 ms
against a 4.9 ms average), and it compiles two programs as it happens:

    depth,CN_MODE,1,...
    physical,CN_MODE,1,...

CN_MODE is creatures.js's per-animation-mode #define. three.js compiles a
program lazily and synchronously on first draw; our materials carry the shared
underwater injection plus surface microstructure and are enormous, so a creature
mode arriving mid-play costs ~2.5 s of frozen main thread, plus its depth variant
for the shadow pass (creatures.js:5544 sets castShadow = true).

TWO FIXES ATTEMPTED AND BOTH REVERTED, recorded so nobody repeats them:
 1. A precompile guard that set visible = false before compileAsync. Useless:
    compile() walks with traverseVisible (three.core.js:15596), so hiding the
    object skips the exact material being warmed.
 2. The same guard parking the mesh on an undrawn layer instead. Also useless,
    for a deeper reason: creatures are range-culled with visible = false by their
    own module, so compileAsync skips them regardless of what this guard does —
    while the guard had already marked the material "seen" and would never retry.

That second failure is the real finding: precompiling through an API keyed on
scene visibility cannot work for objects whose visibility another module owns.
The fix is architectural and belongs in creatures.js — collapse CN_MODE from a
compile-time define to a uniform so there is one program instead of one per mode,
or instantiate and warm every mode at boot behind the loading screen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Point sync-public.sh at the renamed public repo

The public repo is now sepivip/ClaudeNautica and this private one is
sepivip/ClaudeNautica-private, so the clean name belongs to the shareable
repository.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Add sync-public.sh: push the tree (not the history) to the public repo

The two repos deliberately do not share history — reference/subnautica/ holds
copyrighted Subnautica frames and node_modules/ was committed before the
gitignore existed, and both are permanently in this repo's history. The script
copies the current tree instead, regenerates HISTORY.md from the commit log,
refuses to run if the build does not render, and aborts if excluded content
somehow reaches the index.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## flora: separate core's surface gains from flora's own; retract the r35 grain premise

Round 35's brief told flora that FLORA_SURFACE's grain of 0.25 was burying the
new blade geometry, and cited floraiso=1&flnosurf=1 as proof (detail 20.69 ->
11.53, finest octave 11.30 -> 7.18 against the plate's 6.45).

flnosurf does not ablate FLORA_SURFACE. It zeroes this module's own uSurf vec4
and leaves uSurfGrain exactly where applyUnderwater put it, so the ablation moved
a different field from the one the instruction blamed. ?flcore=<k> now scales
core's sfApply gains independently, making ?flcore=0 the clean ablation of the
core half.

The underlying observation may still stand — near-plant octave energy really is
about twice the plate's — but the proof of WHICH field causes it was invalid.
Seventh false premise, and the first caught before any work was built on it.

The builder that found this was cut off by a session limit before it could act.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 34: caustic occlusion in core; the reference plates can be clipped too

CORE — uwCaustics() had no occlusion term and no parameter that could carry one,
so nothing could cast a shadow into the caustic field. Added uwCausticOcclusion()
and uwCausticsOccluded() plus 8 published occluder spheres (globals.js
setCausticOccluders), player seeded by main.js, ablatable with ?nocaustocc=1.
Measured honestly: still bit-identical on shallows-floor, because terrain samples
caustics itself and flora/watersurface call the un-occluded entry point. The
capability is real; adoption is outstanding.

TOOLS — capture.mjs purges the tag directory before capturing and fails on zero
shots. It was observed printing FATAL and "0 shots" while leaving the PREVIOUS
run's PNGs in place, so measurements read the old build as the new one. Round 17
hit the same trap. Fifth instrument bug here to manufacture false evidence.

REFERENCE — SYSTEMATIC.md section 5: THE PLATES THEMSELVES CAN BE CLIPPED. Every
clipping rule so far was aimed at our frames. A tools critic screened the window
that produced my round-33 hull target and found seamoth-1 (1250,572) 110x34 at
35.7% railed, R/G 1.046. The "plate sits at 3.8x" instruction described a ceiling,
not Subnautica's art. The builder refused to build to it and was right — sixth
false premise, and the first sourced from a plate rather than my own instruments.

Scores: tools 38->41 (scanner shell genuinely repaired), watersurface 53, flora
52 (grass rewrite verified at 9x), sky 48->58 (the night "unlit black cutouts"
defect is CLOSED — base hull went from 0.95x the water it stands in to 2.52x with
a 6.4:1 top-to-underside ramp).

Still open and now measured: the flashlight lights nothing (+0.31% cave floor
against +134% on the tool's own head, correct cone at 8x gain, so the pass runs
~8x too dim); watersurface's far band is a regular diagonal corduroy with
near-black dashes (4.32% under L60 vs plate 0.625%) and the sea is monochromatic
(hueVar 0.006 vs 0.017); flora's own grain of 0.25 carries ~2x the reference's
octave energy and buries the new blade geometry, by its own ablation.

terrain never ran — its builder died on a StructuredOutput retry cap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 32: 14/14 on the fair subset — the pairing was never the leak

Round 13 scored 18/18 on a set including four pairs with no fair plate. Removing
them changed nothing: 14/14, with twelve decided in about a second at 1024x576
without magnification. The plate audit was still worth doing, but it was not
what was holding the score.

Category tally, r13 (of 18) -> r32 (of 14): water surface 3 -> 4 (now the
largest single category), material/microstructure 5 -> 4, water medium 0 -> 2,
content 4 -> 1, silhouette 2 -> 1, UI 0 -> 1, emitter 4 -> 1.

The medium coming back from zero after nine rounds of medium work is the
uncomfortable part, and both instances are concrete: kelp reads as a single flat
green from foreground to horizon with no depth separation, and seamoth has a
razor-sharp full-width horizontal luminance step in an otherwise flat teal frame.

New, specific and visible defects found:
- A hard black/cyan BINARY surface mask across the top of base-interior, hud and
  shallows-reef — confirmed at 3x as hard aliased edges, two values, no
  intermediate.
- Sun glitter is a perfectly regular orthogonal lattice, ~12 identical columns.
- Grass cards rendering pure black or pure MAGENTA — a two-sided lighting bug.
- Fish and base structure as unlit black cutouts at night, nothing with a lit face.

Scores: tools 34 -> 38, creatures 50 -> 44, structures 46 -> 39.

The fps collapse the critic reported (kelp-forest 21.0, seamoth 18.9,
surface-above 26.3) DOES NOT REPRODUCE — on an idle machine those read 149.1,
80.4 and 131.2. It was contention from concurrent captures, the same class of
error I made in round 9. verify.mjs now fails hard below half the fps budget
anyway, since nothing in the loop was watching for real regressions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 31: the "6x hue-drift gap" was the sRGB encoder; measure.mjs now works in linear light

Fourth instrument bug, and the deepest. measure.mjs computed G/B, relative red
and saturation on MEANS OF 8-BIT sRGB CODES. Those are not chromaticity
statistics: sRGB's -0.055 offset carries weight that falls as the code rises, so
the effective exponent is a function of level and differs between the two
channels being divided. A pixel of exactly constant chromaticity reports a
drifting G/B — upward below 1, downward above 1.

Our water sits below 1 and the plates above it, so they were biased in OPPOSITE
directions and every ours-vs-plate difference was inflated by the sum. Verified
with no renderer: scaling one window in linear light holds linear G/B at 0.5779
to four digits while code G/B moves +0.0106 on ours and -0.0071 on a plate.

Decomposed, %/octave: godrays G/B measured +2.57, encoder +1.59, real +0.98
against the plate's real +1.51 — WE ARE ALREADY FLATTER THAN THE PLATE.
grand-reef G/B measured +7.07, encoder +6.66, real +0.41. grand-reef relative red
measured +4.26, encoder +6.76, real MINUS 2.50 — the sign was inverted.

measure.mjs now decodes to linear before averaging and reports sat, redPct and
gbLinear from linear light, keeping satCode/redPctCode for continuity. Every
colour comparison written before this round carries the old bias.

The builder also shipped two real fixes that survived its own scrutiny: the
whitening ramp shared by the ACES ceiling and chroma recovery was a brightness
test alone, which cannot tell a blown highlight from an over-driven saturated
pixel (the same defect round 30 found one function away), and the ?nopostfx
bypass now honours ?exposure= because it was railing 79-80% clipAny on the one
shot this round was about. It built, measured and THREW AWAY a third change, and
refuted its own first hypothesis before shipping it.

Also corrected in AGENT_BRIEF: the claim that two runs give identical draw and
triangle counts is false (godrays 244 vs 245, kelp-forest 205 vs 192, deep-void
306 vs 266). Whole-PNG md5 is not a valid A/B instrument; window statistics are.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 30: premise retracted; measure.mjs was blind to per-channel clipping

I set round 30 on "the reference water changes chromaticity with brightness",
citing kelp-forest-1 going relative red 2.64 -> 44.06 with "0% clipping anywhere
in the range". The builder refused, changed nothing, and demolished it:

- The bright endpoint is 98.63% GREEN-RAILED. It reported 0% clipping because
  measure.mjs counted only pixels with LUMINANCE >= 250, and (117,254,219) has
  luminance 224. Verified after fixing: clipPct 0.00, clipAny 98.63, all green.
- The reference medium holds ONE chromaticity. godrays-1 — the cleanest plate in
  the set — gives five pure-water windows at 0% clipping in every channel over a
  1.61x level range: G/B moves 1.7%, red stays 0.07-0.19%, saturation stays
  0.998-0.999. Water drifting toward white would show saturation falling.
- Ours already drifts ~6x MORE than the reference, in the direction I asked to
  add: G/B 10.0%, red 6.85 -> 9.55, saturation 0.932 -> 0.905 over a matched
  range. The requested change would have made the gap worse in both directions.
- By ablation about three quarters of our level-dependent hue is the GRADE.

measure.mjs now counts per-channel clipping and reports clipAny and clipRGB. Any
colour statistic in this project cleared as "unclipped" on a bright window needs
re-checking — including ungraded frames, since the same builder found the
?nopostfx bypass rails 68.73% green and 35.72% blue on a bright shot while the
old metric called it clean.

That is the eighth builder refusal in a row to be vindicated, and the third time
a broken instrument of mine produced the false premise it refused.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 29: the tonemapper was manufacturing red, derived from the matrices

ACES_OUT * ACES_IN is not a round trip. Multiplied out, the red row picks up
7.675% of the green and 0.736% of the blue. Row sums are unity, so every "the
matrices map white to white" check ever run here passes — but with NO CURVE AT
ALL a green-cyan whose red is exactly zero comes out at display R% 32. Modelled
on the kelp chromaticity the sandwich predicts R% 37 at saturation 0.626,
reproducing a measured (89.4, 37%, 0.626) out of a medium red of 4e-5 to three
digits.

Twenty-eight rounds never saw it because below the crossing the residual is
NEGATIVE and clamp(o,0,1) deletes it — dark windows were clean, bright ones were
measuring the curve.

Fixed at source with a per-channel ceiling inside acesFitted() at maxc times the
scene's own channel ratios. Being a min(), the toe's chroma expansion that the
deep frames depend on is inert under it by construction rather than by sweep.
The builder also reported honestly that this takes 15 of the 81 manufactured
counts, not all 81 — the rest is round 26's separate mechanism and the two are
not additive.

The audit of which past red findings survive is now the second section of
SYSTEMATIC.md. Round 24's grand-reef/cave/deep-void figures survive (p90 30-153).
Round 24's "the curve is a red remover" survives AND is explained as the same
residual on the other side of the crossing. Rounds 25 and 26's kelp red numbers
were the artefact (47.4% of that window at 243+). Round 24's shallows-reef delta
is suspect because the BYPASS clips there.

And the builder RETRACTED ITS OWN round-28 handoff: the plate window it had told
biomes to chase is p90 255 with 71.6% of pixels at 250+ — a blown highlight in
the reference JPEG, the same defect on the reference side. The readable window
reads 3.6%, not 16.5%.

Tool fix: capture.mjs retries a shot that loses its execution context instead of
aborting the whole battery and leaving a partial directory.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 28: both water-window defects fixed by derivation; core clamp softened

biomes fixed both handoffs with derived rather than dialled numbers:

- grand-reef water was 1.31x too bright, and the hexes were NOT the problem
  (saturation 0.652 vs 0.669, relative red 35 vs 33, G/B 0.673 against LOOK.md's
  345m #0C283E at 0.645 were already hits). The error was the light budget:
  ambientFloor 0.300 asserted that half of surface daylight survives to 280m and
  that 56% of that is the reef's own glow. Solved through the sRGB curve (noting
  the naive 0.76^2.4 = 0.52 is wrong) to 0.092. After: 36.55 and 38.87 on two
  windows against the plate's 34.81-38.85 — 0.7% and 0.05% off. The frame now
  reads (19,39,60) against LOOK.md's measured (12,40,62).
- kelp green was pinned at 249/255 with 99.2% of the window above 240. Added a
  `level` field applied before pre-compensation so the eyedropped hexes stay
  checkable against LOOK.md while the level becomes a measured number.

It also REFUSED part of the brief with proof: the kelp water's blue is not
biomes' to set. That camera resolves to kelp 0.886 / safe_shallows 0.110, and
safe_shallows is ~10x brighter in blue, so 91% of the medium's fog-blue there is
a BLEND LEAK. Setting kelp's blue to zero recovers G/B only from 1.087 to 1.146
against 1.166 before the change, and lowering scatterStrength makes it worse.

CORE FIX, from its report: uwInscatter clamped the up-look integral with min(),
which gives the limit a KNEE — every ray past it returns the same value. On a
kelp up-look (uSkyAtten 2.529, b negative above ~23 degrees) rows 0-100, 100-200
and 200-300 read G 249.1 / 249.8 / 249.8, flat across 28% of frame height, and
no authored colour could fix it because the clamp is geometric. Replaced with
x/(1+x/limit): same asymptote, no knee. Verified: those bands now read
240.1 / 234.2 / 217.4, a real gradient.

Also reported and not yet acted on: postfx's tonemapper was MANUFACTURING the
kelp water's red — the window read R 89.4 at R% 37 while the medium's actual
source was uFogColor.r = 0.00004, i.e. channel crosstalk desaturating a
near-clipped green toward white. Any relative-red figure taken on a near-clipped
window has been measuring the tonemapper, not the medium.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 27: the recovery I asked for was unphysical, and the builder proved it

underwater refused to restore k=3.3 at grand-reef and changed no numbers. On
water-only windows the shipped ramp ALREADY reproduces the plate — vertical
1.109 vs 1.098, octave tilt 0.70 vs 0.69 — and k=3.32 pushes those to 1.346 and
1.24 while taking the upper water window to 2.6x the plate and the lower to
0.43x. Its phrase: "correct average, no correct pixel".

The decisive measurement is horizon invariance, measured rather than argued:
gain(rd.y=0) = 1 by construction, and the 90px band straddling our grand-reef
horizon reads 48-50 ungraded at BOTH k values. So no setting of that ramp can
move the level of level-ray water — the "recovery" I asked for was arithmetically
impossible.

It also found that deep-void-2 has NO CLEAN WATER WINDOW: its single water-only
candidate has a larger horizontal spread (1.65) than vertical (1.39) because that
window is a lit cave mouth plus a Seaglide lamp, and an elevation term is
rotationally symmetric. So rounds 26 AND 27 were both spent on targets derived
from a plate that cannot set a vertical target in either direction — one
inverted, one flattened. PLATES.md now carries that warning at the top.

Three handoffs it derived instead, each with the window it came from:
- biomes: grand-reef water LEVEL is 1.31x the plate (ungraded 47.7 vs 36.3), and
  LOOK.md agrees independently (#0C283E at 345m is luminance 35.7). Every other
  medium axis there is already a hit ungraded.
- biomes: kelp-forest water green is effectively PINNED — G = 249.0 mean ungraded
  with p90 luminance 214.5, against the plate's 216.6 / 182.4, and ours is at 55m
  against the plate's 15-25m so it should be darker, not 1.16x brighter with a
  channel at 98% of full scale.
- postfx: at grand-reef the grade costs 13% of the water's saturation and adds 9
  points of relative red on the same window.

That is the fifth builder in a row to refuse a wrong instruction of mine and be
vindicated by measurement.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 26: the target was a content artefact, and PLATES.md already said so

I sent two agents to fix deep-void's "inverted vertical structure" — our
topBottom 2.64 against the plate's 0.54. A critic measured what that 0.54 is:
an opaque rock ceiling filling the top third, HUD elements covering 12.4% of
pixels mostly in the bottom third, and a bioluminescent stalk. Masking the HUD
alone moves the plate to 0.956; adding the stalk, 1.053. The row profile is a
hump, not a gradient, and no medium anisotropy term can produce that shape.

The decisive test: windowing the WATER ONLY gives 39.4 falling to 26.5 top to
bottom — ratio ~1.4 in the SAME direction our medium already produces.

grand-reef's 0.67 is likewise a lit sand floor filling two thirds of frame, while
our shot is open water with no floor at all.

PLATES.md already listed whole-frame statistics from HUD-carrying plates as
"never fair" and topBottom as fair only when depth AND lighting match. I derived
targets from them anyway and spent a round on it. The underwater builder refused
to invert its elevation term and was right — reached from LOOK.md rather than
from the plate.

SYSTEMATIC.md now opens with this, and with the rule that follows: derive a
target from a WINDOW containing only the material being measured. Its median and
topBottom columns must not be used as targets.

Scores: postfx 64 -> 70, underwater 72 -> 68. grand-reef lost all three exact
axes — the skyAtten rewrite cut k at 280m from 3.32 to 0.758 and took the median
with it. That is a real regression and it was bought for a target that was not
real.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 25: underwater 72, postfx 64; fixed a bug my own warm-up fix introduced

postfx measured all three columns (ungraded / graded / plate) on five shots and
shipped exactly ONE change, refusing three others because its delta was already
the right size and correcting further is this round's named failure. That is the
third builder in a row to refuse a fix and be right.

The one change: the open-loop exposure ceiling bound on exactly one frame whose
ungraded value was already on its plate — cave ungraded 22.6 against cave-1's
22.9, graded 16.1, so the grade took 30% off a landed frame. The ceiling had been
solved in round 22 against cave-3, the wrong plate for a Jellyshroom Cavern.
After: median 16.1 -> 21.0 (plate 22.9), flat black 7.17% -> 2.22% (plate 4.34%).

It also answered the open ACES question and reported that the principled fix is a
REGRESSION: the textbook gamut return takes grand-reef from exact (34.3/.465/57
against 34.0/.461/56) to 33.8/.610/44. And with it on, ?crec=0 is bit-identical
to shipped — the two are the same job, and the pair that lands is clip+recovery,
because recovery reconstructs from scene chroma taken BEFORE the curve while a
gamut map only knows what survived it. Kept behind a switch, default off.

MY OWN BUG, from my round-22 warm-up fix: the isolate reload was skipped for
shot #1 (report.shots.length > 0), so the warm-up render left position 1 on a
page that had already drawn it while shots 2..n each got a fresh one. On
kelp-forest that is 1.7x: position 1 read median 49.3 / sat 0.674, positions 2
and 5 read 28.4 / 0.759 and were bit-identical to each other. Now reloads before
every shot; verified consistent.

Also: SYSTEMATIC's cave TABLE still disagreed with PLATES.md even after I fixed
the narrative — a table is what a brief quotes. Annotated inline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 24: the two stages stopped fighting; postfx 40->62

The grade was adding saturation and removing red on 5 of 5 shots, on frames
where the ungraded value was ALREADY at the plate. That is now scatter about
zero, and grand-reef lands exact on all three axes (34.2/0.457/58 against the
plate's 34.0/0.461/56).

The named lever was not the culprit. ?zonesat=0 reached only 30% of the delta.
The builder added six ablation switches and isolated the rest: the biggest single
contributor was the ACES TONE CURVE, which no knob could reach — +0.115 sat /
-6 R% on grand-reef and +0.109/-22 on deep-void, larger than the entire rest of
the grade. ACES_OUT's negative off-diagonals expand chroma along the input's
lean, and its closing per-channel clamp can zero a red channel the medium left
alive.

Chroma recovery exists to answer exactly that and measured 0.000, because its
ramp-in band was quoted in ABSOLUTE scene-linear (0.22, 1.10) while a 280m crop
lives under 0.10 — it never fired anywhere the curve did its damage. Now quoted
in multiples of the frame's own metered middle.

Also closed: deep-void flat black 4.87% -> 0.48% against the plate's 0.60%.

TWO MORE OF MY PLATE COLUMNS WERE WRONG, found by the same builder:
- SYSTEMATIC quoted cave-1 while PLATES.md names cave-3 primary. They give
  opposite verdicts: 0.70x too dark against one, 3.2x too bright against the
  other. cave-1 is correct here (our shot is a Jellyshroom Cavern) but the two
  documents must not disagree silently.
- SYSTEMATIC used shallows-floor-1's median as a LEVEL target when PLATES.md
  lists that plate "for caustics only". Our ungraded median is 99.2 against a
  target of 155.5, so no transparent grade could reach it — the gap is content,
  not grade, and every brief saying "3.4x too dark" pointed postfx at a target it
  could not legitimately hit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 23: underwater 45->71; the redCap unification is dead; the modules were fighting

The underwater builder refuted BOTH levers it was given and found the real one.

- redCap does not bind. Reading live uniforms at draw time, every capRed() call
  site has an order of magnitude of headroom: fog R/max 0.0236 against a 0.268
  cap on shallows-reef, 0.0000 against 0.025 on grand-reef. capRed never fires on
  fog, scatter or ambient. So "findings 1 and 2 are the same constant" — which I
  called the most useful thing established about this project's colour — is
  retracted. A critic confirmed it by direct ablation.
- redRatio moves the wrong half of the frame: halving red extinction moved OPEN
  WATER (already exact at 26 vs 26) by +22% and the LIT FLOOR (10 points short)
  by +4.7%, under the noise floor. Four times more effect on what must not move.
- The real constant is hueTint, which had an ordering bug: warmthOf() was
  evaluated AFTER hueTint ran, so it could never fire on the warm biome it exists
  for. Shipped with a depth-ramped release and a redCap tail rebuilt from
  LOOK.md.
- My own "correction" was half wrong. I said grand-reef's 6-vs-56 was a framing
  artefact and open water must not gain red. The plate's actual open water crops
  to R% 34 at saturation 0.66 against ours at 5/0.955, and LOOK.md's ramp agrees
  the red minimum is the 140-160m band, not the bottom. After the fix: R% 32 vs
  34, saturation 0.686 vs 0.66.

THE ROUND'S FINDING, from the shared critic: underwater added red and dropped
saturation while postfx removed the red and put the saturation back. Having one
critic judge both modules is what surfaced it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 22: a builder refused an inert fix and corrected the whole diagnosis

The biomes agent measured the brief's lever three ways before touching anything,
found it could not move rendered red at all, and shipped documentation plus
resetForShot rather than publish an inert switch as a fix. Verified in source:

- U.uAbsorption and U.uFogColor are VESTIGIAL. 239 of 674 materials expose
  uniforms.uAbsorption and none shares the U object; biomes._driveUniforms is
  false in a real build (that path only runs while underwater.js is a stub).
  Mutating the shared globals changes nothing on screen. My r21 explanation
  ("biomes overwrites it") was wrong too.
- The real lever is underwater.js TUNE.redRatio = 5.2, applied at line 1456 as
  min(0.62, max(a.x, s2*redRatio)) — a floor at 4.472x the surviving channel
  that discards every biome's authored red. Eight of fifteen biomes already
  author inside the derived band; you cannot move a max(). Needs ~1.6-2.4.
- TUNE.redCap imposes a saturation floor of ~(1-redCap), so SYSTEMATIC findings
  1 and 2 are THE SAME CONSTANT seen twice, not two defects.
- Two of my five red numbers were wrong: cave used a non-primary plate and
  already matches its real one; grand-reef 6-vs-56 is a framing artefact where
  the plate is 70% lit sand and our crop is open water.

Tool fixes from the same report:
- capture.mjs now renders and discards a warm-up shot. The first capture of a
  cold session was not comparable to later ones (cave median 3.9 -> 7.7, a 97%
  swing, topBottom 4.5x). Verified: spread now 1.5%.
- verify.mjs no longer reports a vite-HMR navigation from a concurrent edit as a
  broken build; it warns instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Retract the 'we are monochromatic' finding; my core red change was inert

Two corrections to my own work, both caught by measuring instead of assuming.

1. RETRACTED: I claimed we are monochromatic rather than over-saturated, from
   one crop of one pair (hueVar 0.037 vs 0.084). Full-frame across four verified
   pairs it inverts on three: shallows-reef 0.032 vs 0.016, cave 0.156 vs 0.123,
   grand-reef 0.040 vs 0.032 — ours HIGHER. Only wreck matches the claim (0.035
   vs 0.190). The metric is also strongly crop-dependent: the same pair reads
   0.037/0.084 on one crop and 0.059/0.014 on another, so the conclusion flips
   with the window. One crop cannot support a project-wide claim.
   The three findings measured across all 13 pairs on a consistent crop stand;
   only the hue-variety interpretation layered on top does not.

2. My core fix was a no-op. I lowered uAbsorption red 0.185 -> 0.085 in
   globals.js and measured no change, because biomes.js:1808 does
   U.uAbsorption.value.lerp(m.absorption, t) every frame — the core value is only
   a pre-biomes fallback. The change is kept and documented, but the real edit
   has to happen in biomes' authored per-biome absorption.

Caught before it became a fourth wrong brief.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## The monochromatic collapse is one channel, and the target is derivable

I suspected core's compositing was painting near objects the medium's colour.
The arithmetic refutes it: at 2m an object keeps 96% of its green and blue, so
in-scatter does not dominate. What collapses is RED ALONE — 16% left at 10m,
2.5% at 20m, mixing toward a fog colour with almost no red in it. One channel
dying is the entire monochromatic effect.

Nor is it a model bug: clear-ocean Kd(650nm) is about 0.35/m and ours is
0.185/m, already gentler than physics. It is an art-direction call, and the
plates demand gentler still.

Derived: plates show relative red 40-66% on lit geometry; ours reaches 46% at
5m, 21% at 10m, 4% at 20m. Solving for ~55% gives k_red of 0.149/0.089/0.059 at
5/10/20m, so red absorption should fall from 0.185 to roughly 0.06-0.09 — less
than half, and well below physical. Green and blue must not move; they are close
and changing them would break the verified G/B depth ramp.

Recorded so the queued round has an exact target instead of my wrong hypothesis.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Correct finding 1: we are monochromatic, not over-saturated

Comparing a fair pair by eye and then measuring it inverts the prescription I
wrote yesterday. Our frame measures saturation 1.19x the reference but hue
variance 0.44x it — one hue bucket against two. The reference carries teal water,
green algae, brown rock, yellow spot patterns and warm coral in a single image;
ours is one intense cyan.

So 'reduce saturation' was the wrong fix: desaturating a monochrome frame just
makes it a duller monochrome. The instruction is to add hue variety and let
saturation fall out of it — distinct materials in distinct hue families rather
than every surface tinted toward the medium.

measure.mjs now reports hueVar (saturation- and value-weighted circular variance
over the hue wheel, so near-grey and near-black pixels do not vote) and hues
(30-degree buckets holding at least 5% of the weight).

This also unifies findings 1 and 2: red is the hue most missing, and losing it is
what collapses the frame into one cyan family.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Measured three systematic gaps across all verified shot/plate pairs

With the plate audit done, comparing every shot against the plate that may
fairly judge it exposes three patterns that hold across nearly every pair and
are therefore grading/medium problems rather than per-asset ones:

1. Over-saturated on 11 of 13 pairs: ours 0.80-0.97, plates 0.27-0.74.
   grand-reef is 0.956 against 0.461.
2. Too red-dead on 11 of 13: relative red often half the plate's or less
   (cave 30 vs 66, grand-reef 6 vs 56, wreck 3 vs 40). LOOK.md rule 1 is about
   absolute red in open mid-water and has been applied globally, so lit
   surfaces and interiors have had their red removed too.
3. Simultaneously too dark and too busy: detail higher than plate on 8 of 13
   (up to 4x) while median is lower on 9 of 13. That combination reads as noise
   in gloom, which is what blind critics keep describing.

Written to reference/SYSTEMATIC.md for the next round.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Reference plate audit: all 58 plates measured, shot mapping rebuilt

Three of my briefs in a row carried wrong targets because index.json recorded
only file/category/desc/source. Every plate has now been opened, measured and
catalogued with depth, framing, lighting, fromVehicle, hasHud and matchesShots,
and reference/PLATES.md gives per-shot PRIMARY / alternate / REJECTED lists plus
a note on which metrics survive a partial mismatch.

14 of 18 shots have a verified primary. FOUR HAVE NONE — godrays, dropoff,
creature-close, school — which is a more useful answer than a forced match. Two
primaries are cross-category, which is exactly why first-in-category kept
failing: night-shallows is best judged by shallows-reef-2 and hud by seamoth-2.

Two new mismatches nobody had flagged: school-1 is 345m from inside a Cyclops
against our 26m diver frame, a 13x depth error whose fish are only legible
because they self-illuminate at that depth; hud-1 is at 0m ABOVE water facing
the Neptune rocket.

blind.mjs consequently pairs on the verified matchesShots whitelist instead of
the loose category, and reports shots it had to skip. It had been comparing our
40m up-look against a 140-160m frame whose topBottom of 8.62 no up-look can
produce, so part of the recorded 18/18 was measuring category mislabelling
rather than art.

postfx scored 40 -> 70 in the same round, once it had correct targets.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 16 agent work; reference plate mismatch identified as systemic

Three briefs in a row carried wrong targets and critics caught all three. Root
cause: reference/subnautica/index.json records only file/category/desc/source —
no depth, framing, lighting or vehicle. So a 'cave' target could be derived from
a 209m Jellyshroom interior shot from a Seamoth while our cave shot is a
horizontal look at -190m, and surface-pod-1.jpg (a lifepod INTERIOR with no
water in it, saturation 0.265) was wired to an open-water shot and flagged by
three separate critics before I acted on it.

Round 17 audits all 58 plates for depth, framing and lighting and rebuilds the
shot-to-plate mapping into reference/PLATES.md before any brief consumes it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 15 agent work + capture.mjs --params was silently dropping values

--params destructured split('='), so --params="aotoe=0" reached the page as
bare "aotoe" with no value. Every ablation switch an agent passed through that
flag was inert — the third time in this project that a silently-ineffective
switch has corrupted a round's evidence, and every other tool here already
parsed it correctly. Verified: --params="foo=1&bar=2" now arrives intact.

--isolate also died with "Execution context was destroyed" in 2 of 5 runs; the
reload now waits for networkidle with a load fallback.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Shot isolation: batteries were contaminating their own measurements

The same shot measured differently depending only on which shot preceded it:
godrays read saturation 0.879 after cave, 0.958 alone, 0.985 after
seamoth-cockpit — a 0.106 swing on identical build, seed and params, while that
shot's own run-to-run noise is exactly zero. Adaptive exposure, temporal AA
history and streaming state survived the teleport between shots, so every metric
taken from a multi-shot battery carried the previous shot's history.

- capture.mjs --all now runs each shot from a fresh page, and every shot
  including the first gets an identical warm-up settle. Applying the warm-up only
  after a reload made shot #1 the odd one out and merely moved the dependence.
- applyShot calls resetForShot(ctx) on every module so modules with temporal
  state can clear it.

Verified: those three orderings now all read 0.982 / R% 2, spread inside the
noise floor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Harness: stop measuring past death, retry cold boot, detect black frames

Three more harness defects found by round-13 critics:

- play.mjs folded the respawn teleport into distanceTravelled: one route reported
  340.3m travelled of which 232m was the teleport, and depthEnd 0 because the
  player was dead at the surface. Metrics now truncate at the first death and the
  death is reported separately. Verified: pressure now reads 67m travelled and
  'player DIED at t+25.22s at 171.4m'.
- verify.mjs failed on cold starts with a 180s boot timeout and passed on retry.
  A gate that cries wolf gets ignored, which is the one thing this gate cannot
  afford. It now retries the boot once before failing.
- The empty-frame check only fired on drawCalls==0, so geometry drawn into a
  black screen passed. It now samples the framebuffer. Its first run was a false
  positive from my own bug — reading the canvas in a separate evaluate() after
  the WebGL buffer had been composited and cleared. Fixed by rendering and
  reading in the same task.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Rounds 11-13 agent work: movement, creatures, watersurface, vehicles

Committing 3,075 lines that had accumulated uncommitted. A critic found git HEAD
was two rounds behind the working tree (HEAD's movement.js had zero hits for
liftShed) while agents were A/B-ing against HEAD as their baseline — so their
'before' leg was not the previous round at all.

Cause: switching off 'git add -A' to stop sweeping agents' half-written files
mid-round also stopped committing their finished ones. The rule is to stage
explicit paths DURING a round and commit src/ at the END of one, when nothing is
running.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Blind trials were not blind; applyShot threw on every shot

A whole-game critic found tools/blind.mjs leaked the answer through four side
channels before any pixel was examined: our PNGs were 2,374,420 bytes against
the references' 297,275; our mtimes were today and theirs weeks old; ours were
always 1920x1080 and theirs 1280x720 to 3000x1205; and our HUD versus
Subnautica's HUD or watermark identified the frame outright. Every detection
rate this project has recorded is suspect as a result.

Both sides are now centre-cropped away from the HUD margins, resized to one
size, re-encoded at one quality and stamped with one mtime. Verified: identical
dimensions, identical timestamps, and file size no longer correlates with side.
The residual centre-HUD channel is documented in the trial itself and critics
are asked to report when a UI cue rather than art decided a pair.

Separately: applyShot assigned to movement.isSubmerged, which is a getter, so it
threw on every single shot. Position and velocity were set first so range-culling
was fixed, but the submersion forcing never happened — which is the half it was
written for, since ui.js gates its drowning wash on it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Round 11: pressure route was starting inside the terrain

The 144-200m suit-rating band still was not being exercised: the route started
at y=-120 where the seabed is -81.4, so it began 39m INSIDE the terrain and
frame 1 rendered the seabed from underneath with lit water above it. Moved 50m
along the dropoff bearing where the floor falls to about -261, and steepened the
descent. Now 98 timeline samples land in the band and it crosses the 200m rating
into a real crush death.

Note for future rounds: do not 'git add -A' while a round is in flight — it
sweeps agents' half-written files into the commit. Stage explicit paths.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Standing loop instructions: dispatch before summarising

The loop stalled three times because a round would land, I would process and
commit, then end the turn with a user-facing report — and nothing re-invoked me.
progress/LOOP.md makes the ordering explicit and carries the standing queue so
any resumption knows what is next without re-deriving it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Measurement integrity: deterministic captures, empty-frame refusal, player body placement

Three harness bugs found by round-10 critics, all mine, all invalidating past
measurement:

1. capture.mjs measured perf by unfreezing the loop for 1.2s of WALL CLOCK, so
   the simulation advanced by however many frames the machine managed. Two runs
   at one seed gave different md5 and 217 vs 215 draws, and the same unchanged
   build measured detail 10.10 and 21.83 — a 2x spread wider than any claimed
   improvement. Perf is now measured by timing a FIXED 30 steps. Verified:
   identical draws and triangles across runs, metrics reproducible to 0.4%.
2. capture.mjs silently wrote the loading splash as a shot PNG with drawCalls 0,
   fps 0 and exit code 0 — indistinguishable from a real frame to anyone globbing
   the directory. It now flags emptyFrames and fails the run.
3. applyShot teleported the camera but left the player body at spawn, so every
   module that culls or spawns by range to the PLAYER culled itself out of the
   frame it was being judged in. It now places the body, velocity and
   isSubmerged.

AGENT_BRIEF documents the resulting noise floor so nobody publishes a gain
smaller than it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Harness must not change the game: explicit mode, declared god modes, real-gameplay play routes

survival.js keyed a 35 HP god-mode floor off ?capture=1, and tools/play.mjs
hardcoded capture=1 — so every play route ever run measured a game that could
not kill the player. The 'health freezes at exactly 35' defect WAS that floor.
The instrument was altering the subject, and it survived several rounds.

- ctx.harness states the driver explicitly (still / play / none); gameplay may
  branch on harness.still, never on capture.
- ctx.declareGodMode(id, what) registers any suppression; it surfaces in
  status().godModes, in every report.json, and play.mjs prints a loud banner.
- play.mjs now sends harness=play and NO capture flag. Verified: on --route=deep
  health now goes 100 -> 0 with a real death and respawn, godModes empty.
- New 'pressure' route covers the 144-200m suit-rating band, which no route
  reached before (descend topped out at 99.8m, deep starts at 280m past the
  rating), leaving the whole middle of the crush curve unmeasurable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Never again: shader failures are now loud at every layer

The fwidth regression survived a full round because a shader that fails to
compile throws nothing — it just draws nothing, while every module reports OK.
Four independent layers now make that impossible:

1. engine.js hooks renderer.debug.onShaderError, so three.js tells us directly
   which stage, which program and which line failed.
2. window.__CN.status() reports brokenBuild and folds shaderErrors into
   status.failed, so a shader failure is a module failure.
3. tools/verify.mjs is a one-command gate that exits non-zero on any shader or
   module failure or an empty frame. Proven by deliberately reintroducing the
   original bug: it named all 5 failing programs and their line numbers.
4. .githooks/pre-commit runs the gate and refuses the commit (SKIP_VERIFY=1 to
   override deliberately).

AGENT_BRIEF.md section 3 makes the gate the mandatory first and last step, and
documents the four traps that actually bit us: no derivatives in the vertex
stage, varyings are write-only there, guard shared pars against double
declaration, and namespace uniform names.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Fix build-breaking vertex-stage fwidth; gate captures on shader link failure

surface.js called fwidth() from code injected into BOTH shader stages. fwidth is
fragment-only in GLSL ES, so 34-37 programs failed to link while every module
still reported init OK — the game drew flora and HUD over empty water and an
entire critique round scored it as an art problem.

Four distinct faults, each found by re-capturing:
  1. fwidth in the vertex stage        -> footprint from camera distance instead
  2. sfBroadband read a varying        -> world pos threaded through explicitly
  3. pars included twice redeclared    -> #ifndef SF_DECLARED guard
  4. uPixelScale collided with the     -> renamed uSfPixelScale
     point-size uniform every particle
     system already declared

capture.mjs now sets brokenBuild and exits non-zero on VALIDATE_STATUS failures.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## measure.mjs per-octave energy; progress lock staleness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: band-limit surface grain to screen footprint; fix play.mjs fps measurement

A critic measured the surface library producing the opposite of its intent: at
the wreck's ~20px/m only 2-3 of seven octaves landed above a pixel, so a 1/f
rolloff collapsed into a coarse blotch that painted over panel lines. Energy per
octave rose toward coarse where a real hull plate is flat. Octaves now build
downward from fwidth with flat amplitude, and presets are clamped.

play.mjs reported fps 0 on every sample of every route because the rAF counter
is gated on  while the harness drives step() by hand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: shared procedural surface microstructure library

The water medium now decides zero blind pairs; asset surfaces decide nine. Adds
src/core/surface.js — broadband 1/f grain, cavity wear and gravity streaking,
triplanar from world position, modulating roughness as well as albedo — wired
into applyUnderwater as an opt-in { surface } option with per-family presets.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Coherence round: composite 38; loud UI-state failure, deep play routes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Integration round: composite 34/100, harness params passthrough, shot reframes

Whole-game critic scored the composite far below the piece average, correctly
identifying that the modules disagree with each other. Fixed three harness/core
issues it was blocked by: capture.mjs had no URL-param passthrough (so postfx
bypass knobs were unmeasurable), the godrays shot framed no terrain at all (so
the occlusion that IS the god-ray effect could never appear), and base-interior
was covered by the PDA so that slot never tested the base module.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Wave 3: playable half complete + 4 core fixes

Core: first-frame dt=0 (NaN on frame one), depthResponse opt-out for sealed dry
interiors, MeshBasicMaterial normal misdetection (beginnormal_vertex sits inside
an envmap/skinning guard), and composed customProgramCacheKey so wrapping
modules are not served our program.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: fix InstancedMesh world position, exempt emissive from depth darkening, neutralise up-look hue shift

All three found by build agents who were correctly forbidden from editing core.
The instancing bug meant every plant and fish in the game computed its fog and
caustics from instance zero's world position; the emissive bug attenuated
self-lit surfaces as if they were sunlit, which is why bioluminescence was
invisible and nothing ever crossed the bloom threshold.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Fix measure.mjs resolution bug, add crop; match fallback background to medium far-field

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: analytic depth-integrated scattering (shared uwInscatter), measurement tool

Three independent critics measured the medium as isotropic (1.25:1 zenith-to-nadir
vs reference 14.8:1). Root cause was in core: the in-scatter term had no view
elevation dependence at all. Replaced with a closed-form single-scattering
integral, exported as shared GLSL so the geometry path and the fullscreen water
column cannot disagree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: game-wide shadows, probe tool, corrected shot framings from measured terrain

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Core: fallback lighting rig so modules are judgeable while neighbours are stubs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Reference battery (58 frames + measured LOOK.md), motion + playthrough harnesses, corrected colour science

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---

## Foundation: engine, shared underwater shading, GPU capture harness, blind A/B, progress page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

---
