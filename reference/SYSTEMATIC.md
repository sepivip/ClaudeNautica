# READ FIRST (6): "flnosurf proves flora's grain is burying the geometry" is RETRACTED

Round 35's brief told flora that its own `FLORA_SURFACE` grain of 0.25 was burying the blade geometry,
citing an ablation: `floraiso=1&flnosurf=1` takes detail 20.69 -> 11.53 and the finest octave
11.30 -> 7.18, near the plate's 6.45.

**`flnosurf` does not ablate `FLORA_SURFACE`.** It zeroes flora's own uSurf vec4 and leaves
`uSurfGrain` exactly where `applyUnderwater` put it — so the measurement moved a DIFFERENT field from
the one the instruction blamed. The two halves were not separable at all when the brief was written.
`?flcore=<k>` now scales core's sfApply gains independently, so `?flcore=0` is the clean ablation of
the core half and the attribution can finally be tested.

The underlying observation may still hold — our near-plant octave energy really is about twice the
plate's. But the specific proof offered for WHICH field causes it was invalid, and no work should be
built on it until `?flcore=0` says so. Seventh false premise, caught before anything was built on it.

---

# READ FIRST (5): THE REFERENCE PLATES THEMSELVES CAN BE CLIPPED

Every clipping rule in this document was aimed at OUR frames. Round 34 found the reference is not
exempt. A tools critic screened the plate window that produced the round-33 brief's hull target and
measured **seamoth-1 at (1250,572) 110x34 = 35.7% of pixels railed, R/G 1.046**. The "our shell sits
at 0.64x its own water where the plate sits at 3.8x" instruction was derived from that window, so the
target was a property of the clipping, not of Subnautica's art. The builder refused to build to it and
was right.

**Screen the PLATE with clipAny before deriving any target from it, exactly as you would screen ours.**
A railed reference window produces a target no renderer can hit, because the number does not describe
a material — it describes a ceiling. This is the sixth false premise in this project and the first
that came from a reference plate rather than from one of my own instruments.

---

# READ FIRST (4): the "6x hue-drift gap" was the sRGB ENCODER, not the renderer

Round 31 was set on ours drifting 10.0%/octave in G/B against a reference at 1.7%. A builder refused,
decomposed it, and showed most of it is the measurement.

sRGB encodes as `1.055*x^(1/2.4) - 0.055`. The power term is harmless — a channel ratio becomes
ratio^(1/2.4), level-independent. **The -0.055 offset is not**: its weight relative to the code falls
as the code rises, so the effective exponent is a function of level, and differently for the two
channels being divided. A pixel of exactly constant chromaticity therefore reports a drifting
code-space G/B — **upward when G/B < 1, downward when G/B > 1.**

Our water sits below 1 and the plates above it, so the two are biased in OPPOSITE directions and the
difference was inflated by the sum. Verified with no renderer: scale one real window in linear light
and linear G/B holds at 0.5779 to four digits while code G/B moves +0.0106 on ours, -0.0071 on a plate.

**Decomposed (%/octave):**

| axis | measured | encoder | real | plate, same correction |
|---|---|---|---|---|
| godrays G/B | +2.57 | +1.59 | **+0.98** | **+1.51** |
| grand-reef G/B | +7.07 | +6.66 | **+0.41** | — |
| grand-reef relative red | +4.26 | +6.76 | **−2.50** | — |

**On G/B we are already FLATTER than the plate**, and grand-reef's real red *falls* with level while
the old metric reported it rising. In linear light our G/B slope is within 5% of the plate's; the
residual genuinely ours is +0.61 points of red per octave.

`measure.mjs` now reports `sat`, `redPct` and `gbLinear` in linear light. **Every colour comparison
in this document written before round 31 used code-space statistics and carries this bias.**

---

# READ FIRST (3): "the reference water changes hue with brightness" is RETRACTED

I set round 30 on that premise, citing kelp-forest-1's pure water going relative red 2.64 -> 44.06
and saturation 0.974 -> 0.560 "with 0% clipping anywhere in the range". The builder refused, changed
nothing, and showed why:

- **The bright endpoint is 98.63% GREEN-RAILED.** It reported 0% clipping because `measure.mjs`
  counted only pixels with LUMINANCE >= 250, and a green-teal pixel of (117,254,219) has luminance
  224. Verified after fixing the metric: that window reads clipPct 0.00 and **clipAny 98.63, all in
  green**. Its "p90 255" reads 255 precisely *because* green is railed.
- **The reference medium holds ONE chromaticity.** On godrays-1 — the cleanest plate in the set, no
  HUD, no vignette, no watermark, no vehicle — five pure-water windows with 0% clipping in every
  channel, over a 1.61x level range: G/B moves **1.7%**, red never leaves 0.07-0.19%, saturation
  never leaves 0.998-0.999. Water drifting toward white would show saturation falling. It does not.
- **Ours already drifts about 6x MORE than the reference**, and in the direction I asked to add: over
  a matched 1.59x range our G/B moves 10.0%, red rises 6.85 -> 9.55, saturation falls 0.932 -> 0.905.
  Building the requested change would have made the measured gap worse in both directions.
- By ablation, roughly **three quarters of our level-dependent hue is the grade, not the medium.**

## The metric bug, and what it invalidates

`clipPct` was luminance-only, so **any colour statistic in this project cleared as "unclipped" on a
bright window needs re-checking.** `measure.mjs` now reports `clipAny` and `clipRGB`; read clipAny.

The same builder found the `?nopostfx=1` bypass rails **68.73% green and 35.72% blue** on a bright
shot while the old metric called it clean — so ungraded frames have been trusted as ground truth in
places where they were clamp artefacts. An ungraded frame is not automatically a valid reference.

---

# READ FIRST (2): WHICH RED FINDINGS SURVIVE — audited round 29

The tonemapper was **manufacturing red**. `ACES_OUT * ACES_IN` is not a round trip: multiplied out,
the red row picks up **7.675% of the green** and 0.736% of the blue. The row sums are unity, so every
"the matrices map white to white" check ever run here passes — but with **no curve at all** a
green-cyan whose red is exactly zero comes out at display R% 32. Modelled on the kelp chromaticity it
predicts R% 37 at saturation 0.626, reproducing a measured (R 89.4, 37%, 0.626) out of a medium red
of 4e-5, to three digits.

Twenty-eight rounds never saw it because **below the crossing the residual is NEGATIVE and
`clamp(o,0,1)` deletes it.** Dark windows were clean; bright ones were measuring the curve.

**The audit, by the builder that found it:**

| finding | verdict |
|---|---|
| Round 24 grand-reef, cave, deep-void red figures | **SURVIVE** — windows at p90 30-153, far under the ceiling |
| Round 24 "the tone curve is a red REMOVER, -6 R%, deep-void -22" | **SURVIVES, and is now explained** — the same residual on the other side of the crossing, where ACES_OUT's red goes negative and clamp() deletes it |
| Round 25 item 5, Round 26 item 2 (kelp red) | **ARTEFACT** — measured on a window with 47.4% of pixels at or over display 243. The round-26 *operator* was right and its fix measured correctly; only the *attribution* was wrong |
| Round 24 shallows-reef grade delta | **SUSPECT** — the BYPASS clips there (p90 249, 25.3% at 243+ ungraded against 0.0% graded), so that delta was measured against a clipped reference |
| Round 28's own handoff, "kelp water has no red, 0.1% vs the plate's 16.5%" | **RETRACTED BY ITS OWN AUTHOR** — that plate window is p90 255 with 71.6% of pixels at 250+, a blown highlight in the reference JPEG. The same defect on the reference side. The plate's *readable* water window reads 3.6%, not 16.5%, so the gap is 10x, not 130x, in a channel measuring 1.19% of the largest |

**Rule: quote a window's p90 with every colour statistic.** If p90 is near 240, the number is about
the curve — on our side or the plate's.

---

# READ FIRST: whole-frame statistics from these plates are mostly INVALID

**Round 26 established that several targets in this document are content artefacts, not properties
of the water — and PLATES.md already forbade using them.**

I sent two agents to fix deep-void's "inverted vertical structure" because our topBottom read 2.64
against the plate's 0.54. A critic then measured what that 0.54 actually is:

- an **opaque rock ceiling** filling the top third (47.7% of the top band is under luminance 8)
- **HUD elements** covering 12.4% of pixels, most of them in the bottom third
- a **bioluminescent stalk** in the bottom third

Masking the HUD alone moves the plate's topBottom from 0.520 to **0.956**. Adding the biolum stalk
takes it to **1.053**. Mask sensitivity across tight/loose variants: 0.795 to 1.128 — every variant
lands far from 0.52. The row profile is a **hump, not a gradient** (7.4, 8.3, 8.7, 11.2, 18.1, 19.4,
19.6, 18.1, 17.5, 20.0, 17.6, 13.3), and no medium anisotropy term can produce that shape.

The decisive test: windowing the **water only** — no rock, no HUD, no bioluminescence — gives 39.4
falling to 26.5 top to bottom, a ratio of about **1.4 in the SAME DIRECTION our medium already
produces**. The water in that plate gets darker downward, exactly as ours does.

Same for grand-reef: its 0.67 is a **lit sand floor** occupying two thirds of frame, while our shot
is open water with no floor in it at all.

**PLATES.md already said this.** Whole-frame statistics from a HUD-carrying plate are listed there as
"never fair", and topBottom is fair only when depth AND lighting match. I derived targets from those
statistics anyway, wrote them into this file, and spent a round on them. The underwater builder
refused to invert its elevation term and was right — and reached that from LOOK.md rather than from
the plate.

## The rule that follows

**Derive a target from a WINDOW containing only the material you are measuring.** Water targets come
from a water-only window. Rock targets come from rock. Never from a whole frame that contains a HUD,
a vehicle interior, a floor, or a light source, unless the axis is one PLATES.md lists as fair for
that plate.

Every whole-frame number below is suspect until re-derived that way. The per-axis findings measured
on the consistent crop (relative red, saturation) are less affected because they are ratios over the
whole crop rather than a spatial structure — but the **median and topBottom columns should not be
used as targets at all**.

---

# Three systematic gaps, measured across all 13 verified shot/plate pairs

Produced by comparing every shot in an isolated 18-shot battery against the PRIMARY plate that
`reference/PLATES.md` says may fairly judge it, on one crop (`--crop=0.05,0.10,0.60,0.85`, chosen to
exclude HUD margins). These are not per-asset defects — they hold across nearly every shot, which
makes them grading and medium problems, and they are worth more than another round of asset polish.

| shot | ours med/sat/R%/detail | plate med/sat/R%/detail |
|---|---|---|
| surface-pod | 156.1 / 0.438 / 65 / 23.9 | 95.8 / 0.500 / 53 / 16.4 |
| surface-above | 124.1 / 0.519 / 59 / 21.8 | 95.8 / 0.500 / 53 / 16.4 |
| shallows-reef | 131.9 / 0.800 / 24 / 20.8 | 134.2 / 0.695 / 27 / 6.2 |
| hud | 82.7 / 0.861 / 17 / 28.6 | 134.2 / 0.695 / 27 / 6.2 |
| night-shallows | 16.9 / 0.840 / 20 / 13.5 | 14.1 / 0.315 / 67 / 12.9 |
| shallows-floor | 46.0 / 0.834 / 23 / 28.5 | 155.5 / 0.271 / 100 / 19.5 — **level target INVALID, see note** |
| kelp-forest | 21.4 / 0.898 / 18 / 23.9 | 41.0 / 0.785 / 25 / 17.8 |
| grand-reef | 21.3 / 0.956 / 6 / 16.0 | 34.0 / 0.461 / 56 / 8.0 |
| deep-void | 16.2 / 0.914 / 14 / 20.1 | 15.9 / 0.735 / 25 / 23.1 |
| wreck | 51.0 / 0.974 / 3 / 19.0 | 65.2 / 0.654 / 40 / 20.5 |
| seamoth-cockpit | 28.7 / 0.930 / 14 / 13.0 | 69.9 / 0.714 / 31 / 22.2 |
| cave | 7.7 / 0.936 / 30 / 24.2 | 22.9 / 0.736 / 66 / 9.6 — **cave-1, NOT the cave-3 that PLATES.md calls primary. See note below; cave-1 is correct here because our shot is a Jellyshroom Cavern, and the two plates disagree by 3x on level.** |
| seamoth | 24.6 / 0.947 / 20 / 21.1 | 67.1 / 0.575 / 52 / 19.4 |

## 0-RETRACTED. "We are monochromatic" does NOT hold up — I over-generalised from one crop

**Read this before section 0.** I claimed below that we are monochromatic rather than
over-saturated, on the strength of one crop of one pair (hueVar 0.037 vs 0.084). Measured
full-frame across four verified pairs, it inverts on three of them:

| pair | ours hueVar | plate hueVar |
|---|---|---|
| shallows-reef | 0.032 | 0.016 |
| cave | 0.156 | 0.123 |
| grand-reef | 0.040 | 0.032 |
| wreck | 0.035 | **0.190** |

So ours carries MORE hue variance than the plate on three of four, and only `wreck` shows the
pattern I described. Worse, the metric is strongly crop-dependent: the same shallows-reef pair reads
0.037/0.084 on the blind centre-crop and 0.059/0.014 on the shot crop — the conclusion flips with the
window. A single-crop comparison cannot support a project-wide claim, and I should not have written
one.

**What survives:** the three findings in sections 1-3 below were each measured across all 13 pairs on
one consistent crop, so they stand — over-saturation on 11/13, relative red low on 11/13, median low
on 9/13 with detail high on 8/13. **What does not survive:** the interpretation that the saturation
excess is really a hue-variety deficit. Treat hueVar as an unvalidated metric until someone measures
it across all 13 pairs on several crops and shows it is stable.

## 0. SUPERSEDED — the "one colour" reading (kept for the record)

Finding 1 below says we are 1.2x-3.1x too saturated and implies the fix is to desaturate. Looking at
a fair pair (shallows-reef, ours vs shallows-reef-1) shows that reading is wrong, and a new metric
confirms it:

|  | ours | real | ratio |
|---|---|---|---|
| mean saturation | 0.814 | 0.682 | 1.19x |
| **hue variance** | **0.037** | **0.084** | **0.44x** |
| hue buckets >=5% weight | 1 | 2 | — |

The reference frame carries teal water, green algae, brown rock, yellow spot patterns, and purple and
orange coral — five or six distinct hues in one image. Ours is a single intense cyan. So the real
difference is **monochromatic-but-intense versus polychromatic-but-moderate**, and desaturating a
monochrome frame just makes it a duller monochrome. The instruction is:

> **Add hue variety, and let the saturation fall out of that.** Distinct materials must sit in
> distinct hue families — rock brown, algae green, coral warm, water teal — instead of every surface
> being tinted toward the medium's colour.

`tools/measure.mjs` now reports `hueVar` (saturation- and value-weighted circular variance over the
hue wheel, so near-grey and near-black pixels do not vote) and `hues` (30-degree buckets holding at
least 5% of the weight). Target hueVar at or above the plate's, not below it.

This also explains why the red finding (#2) and this one are the same defect seen twice: red is the
hue most missing, and losing it is what collapses the frame to one cyan family.

## 0b. Red IS low across 11 of 13 pairs, and the target is derivable — but the fix belongs to biomes

(The framing below survives the retraction above: the relative-red finding was measured across all
13 pairs, not one crop. Only the "hue variety" interpretation was unsupported.)

**MY EXPLANATION FOR WHY MY CORE CHANGE WAS INERT WAS ALSO WRONG.** I said biomes overwrites
`U.uAbsorption` every frame. A builder proved otherwise by reading the live uniform at draw time and
censusing all 674 materials: 239 expose `uniforms.uAbsorption`, every one holding a correctly-shaped
per-biome value, and **none of them shares the `U` object**. `biomes._driveUniforms` is `false` in a
real build — that path only runs while `render/underwater.js` is a stub. So the shared globals block
is **vestigial**: the live medium reaches the shaders through underwater.js's own uniform objects,
and mutating `U.uAbsorption` or `U.uFogColor` changes nothing on screen. Verified by mutation:
setting uAbsorption to (0.002,0.002,0.002) and uFogColor to pure red left every metric unmoved.

**THE ONLY PLACE THE RED FINDING CAN BE FIXED IS `render/underwater.js`:**
- `TUNE.redRatio = 5.2` (line 257), applied at line 1456 as
  `min(0.62, max(a.x, s2 * redRatio))` — a FLOOR at 4.472x the surviving channel that discards every
  biome's authored red. Eight of fifteen biomes already author values inside the derived 0.06-0.09
  band; it cannot move a `max()`. Landing that band needs redRatio around **1.6-2.4**, not 5.2.
- `TUNE.redCap` (line 197), applied at 1508-1511, caps the in-scatter source term's relative red and
  thereby imposes a FLOOR on frame saturation of roughly `1 - redCap`. Measured: shallows-reef floor
  0.732 against 0.791 actual; cave 0.971 against 0.936; grand-reef 0.975 against 0.954.

**RETRACTED — THE UNIFICATION IS DEAD.** I called this "the most useful thing this project has
established about its own colour". It is wrong, and two agents killed it independently.

A builder read the live uniforms at draw time and compared each capRed() call site's pre-cap R/max
against the ceiling actually in force:

| shot | fog R/max vs cap | ambientTop vs cap |
|---|---|---|
| shallows-reef | 0.0236 vs 0.268 | 0.297 vs 0.456 |
| kelp-forest | 0.0009 vs 0.122 | 0.016 vs 0.208 |
| grand-reef | 0.0000 vs 0.025 | 0.000 vs 0.043 |
| cave | 0.0000 vs 0.029 | 0.000 vs 0.049 |

**An order of magnitude of headroom on every one — capRed never fires** on fog, scatter or ambient on
any of the four shots. A cap that does not bind cannot impose a floor. The predicted floors
(0.732/0.971/0.975) were also already violated by two of the three measured saturations, which the
builder correctly identified as "what a non-binding constraint looks like". A critic then confirmed
it by direct ablation.

The real constant removing red is `hueTint`, and it had an ordering bug: `warmthOf()` was evaluated
on the colour AFTER hueTint ran, so it could never fire on the warm biome it exists for.

**And my "correction" about grand-reef was itself half wrong.** I said the 6-vs-56 gap was a framing
artefact and that open water must NOT gain red. The 56 is indeed sand — but cropping the plate's
actual open water in two independent windows gives R% 34 at saturation 0.66, against ours at R% 5 /
0.955. LOOK.md's own ramp agrees: #16436F at 300m is R/max 0.198 and #458887 at 200m is 0.507, so the
red MINIMUM is the 140-160m green-teal band, not the bottom. **Deep open water must gain red.**
After the fix, grand-reef water reads R% 32 against the plate's 34 and saturation 0.686 against 0.66.

(Superseded text follows.) ~~SO FINDINGS 1 AND 2 ARE THE SAME CONSTANT SEEN TWICE.~~ "Over-saturated on 11/13" and "relative red
low on 11/13" are not two defects — they are `redCap` measured from two directions. That unification
is the most useful thing this project has established about its own colour.

**AND TWO OF MY FIVE RED NUMBERS DO NOT SURVIVE CHECKING:**
- "cave 30 vs 66" used `cave-1`, which PLATES.md does not list as cave's primary. Against the
  verified primary `cave-3` on the required crop it reads 22-30 against 28 — already matching.
- "grand-reef 6 vs 56" is a framing artefact: that plate is ~70% lit sand plus a warm cave mouth,
  while our shot looks into open water with no floor in the crop. The plate's own floor strip reads
  R% 90 at saturation 0.128 — that is sand, not water. Authoring water red to 56 would contradict
  LOOK.md rule 2 and godrays-1, whose open water measures R=0.

(Original, now-superseded text follows.) **MY CORE CHANGE FOR IT WAS INERT.** I lowered `uAbsorption` red from 0.185 to 0.085 in
`src/core/globals.js`, then measured no change at all. The reason is `biomes.js:1808`:
`U.uAbsorption.value.lerp(m.absorption, t)` — biomes overwrites the core default every frame with
its own per-biome vector. The core value is only a fallback before biomes loads. **The real change
has to be made in biomes' authored absorption**, and the number below is what it needs to be.

## 0c. The derivation

I suspected the cause was core's compositing — that in-scatter overwhelms albedo at short range, so
every near object gets painted the medium's colour. **That hypothesis is wrong**, and the arithmetic
of core's own `colour * T + inscatter` settles it:

| distance | albedo share kept (transmittance) |
|---|---|
| 1 m | R 0.831 · G 0.978 · B 0.971 |
| 2 m | R 0.691 · G 0.956 · B 0.944 |
| 5 m | R 0.397 · G 0.894 · B 0.865 |
| 10 m | R 0.157 · G 0.799 · B 0.748 |
| 20 m | R 0.025 · G 0.638 · B 0.560 |

At 2 m an object keeps **96% of its green and blue**. In-scatter does not dominate. What collapses is
**red alone**: 16% left at 10 m, 2.5% at 20 m — mixing toward a fog colour that has almost no red in
it. One channel dying is the entire monochromatic effect.

And this is not a bug in the model. Clear-ocean Kd at 650 nm is about **0.35/m**; ours is **0.185/m**,
already gentler than physics. It is an art-direction call, and the plates say it must be gentler still.

### The derived target

Plates show relative red of 40–66% on lit geometry (cave 66, grand-reef 56, seamoth 52, wreck 40).
Ours reaches 46% at 5 m, 21% at 10 m and 4% at 20 m. Solving for a ~55% target:

| at | required k_red | currently |
|---|---|---|
| 5 m | 0.149 /m | 0.185 |
| 10 m | 0.089 /m | 0.185 |
| 20 m | 0.059 /m | 0.185 |

**Red absorption needs to fall from 0.185 to roughly 0.06–0.09 /m — less than half.** That is well
below physical, which is exactly the point: Subnautica keeps red alive far longer than real seawater
does. This is `biomes`' authored value (and `core/globals.js`' default), not a shader defect.

Green and blue should NOT be changed — they are already close, and moving them would break the
verified G/B depth ramp.

### Two plate columns in the table above are wrong — corrected by a builder

**cave.** This table quotes cave-1 (22.9/0.736/66) while PLATES.md names **cave-3** as cave's
primary. The two give OPPOSITE verdicts on the same build: against cave-1 we are 0.70x too dark;
against cave-3 (median 5.0) we are 3.2x too BRIGHT. Our cave shot renders a Jellyshroom Cavern — the
in-frame biome label says so — which is cave-1's content, and PLATES.md's own conditional ("unless
our cave is jellyshroom") therefore selects cave-1. So cave-1 is the right plate here, but SYSTEMATIC
and PLATES.md must not disagree silently, and the "cave 7.7 vs 22.9, 3x too dark" instruction in
several briefs inherited the ambiguity.

**shallows-floor.** This table used shallows-floor-1's whole-frame median (155.5) as a LEVEL target.
PLATES.md explicitly forbids that: it lists that plate as "PRIMARY — for caustics only". It is an 8m
straight-down look at ~90% tan sand; our shot is a -12 degree pitch at 24m over dark green
vegetation. Our UNGRADED median is 99.2, so no transparent grade could reach 155.5 — **the gap is
content, not grade**, and every brief that told postfx "shallows-floor is 3.4x too dark" was pointing
it at a target it could not legitimately hit.

## 1. Over-saturated, everywhere

Ours runs **0.80–0.97** on every underwater shot. The plates run **0.27–0.74**. That is 1.2x to 3.1x
too saturated, on 11 of 13 pairs, with no exception once you are below the surface.

This is the opposite of what LOOK.md section 9 has been read as saying. That section measures
saturation 0.70–0.97 across *its* sample and calls the look "high saturation" — but the verified
plates for our specific framings do not support pushing to the top of that band. `grand-reef` is the
extreme: ours 0.956 against its plate's 0.461.

## 2. Too red-dead, everywhere

`R%` here is mean red as a percentage of the strongest channel — relative, not absolute. Ours is
**lower than the plate on 11 of 13 pairs**, often by half or more: cave 30 vs 66, grand-reef 6 vs 56,
wreck 3 vs 40, seamoth 20 vs 52, night-shallows 20 vs 67.

LOOK.md rule 1 ("red dies first and dies completely", absolute R 0–15 in mid-water) is about absolute
channel values in *open mid-water*. It has been applied as a global instruction, and the result is
that lit surfaces, near-field geometry and interiors have had their red removed too. Red should be
dead in the medium, not in the objects.

## 3. Too much high-frequency detail, while being too dark

Detail is *higher* than the plate on 8 of 13 pairs, sometimes by 3-4x (shallows-reef 20.8 vs 6.2,
hud 28.6 vs 6.2, cave 24.2 vs 9.6) — consistent with the "hard-edged decal rather than broadband"
and "crumpled foil aliasing" findings from earlier rounds. At the same time the median is *lower*
than the plate on 9 of 13 (shallows-floor 46 vs 155, seamoth 24.6 vs 67.1, cockpit 28.7 vs 69.9).

So the frames are simultaneously **too dark and too busy**. That combination reads as noise in gloom,
which is exactly what a blind critic keeps describing.

## What this implies for ownership

None of these three is a single module's defect:
- saturation and level are `postfx`'s grade plus `biomes`' authored colours
- the relative-red loss is `core`'s absorption model plus `biomes`' per-biome absorption
- the detail/level combination spans `terrain`, `flora`, `structures` and `watersurface`

A round aimed at all three at once, with these plate targets, is worth more than another asset pass.
