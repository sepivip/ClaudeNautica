# Subnautica — Visual Identity Spec

Derived by measuring 58 real Subnautica screenshots in `reference/subnautica/` (see `index.json`).
Every hex value below was **sampled from actual pixels** in those frames (headless-Chrome canvas
readback, 5x3 grid means + luminance percentiles), not recalled from memory. Values come from JPEG
screenshots so treat them as ±3-4 per channel, but the *relationships* between channels are solid
and those relationships are what make the look.

Sources are Steam official promo screenshots (appid 264710 / 848450) and publicly posted Steam
Community gameplay screenshots.

---

## 1. Water colour ramp by depth

### The measured ramp (open ocean, away from terrain)

| Depth | Upper water column | Lower water column | Notes |
|---|---|---|---|
| above surface | `#5F6779` – `#82B9EA` | — | sea seen from above; sky-driven |
| 0–3 m (horizontal) | `#295F5E` | `#1B4D53` | dark, *desaturated* teal — the surface layer is NOT bright when you look sideways through it |
| 5–15 m | `#42BAF3` / `#2A9DC9` | `#1E6C78` / `#218184` | brightest, most cyan band in the game |
| 25–40 m (open) | `#14636F` | `#0F4A52` | |
| 25–40 m (kelp biome) | `#164619` | `#0B3710` | biome overrides the ramp entirely — hard green |
| 100–120 m | `#066F80` / `#0A5C6B` | `#0A5465` | fully saturated teal, **R channel is 5–15** |
| 140–160 m | `#00AA9C` (top) | `#004C5C` → `#011434` (bottom) | strongest vertical gradient in the game |
| 200 m | `#458887` / `#456F7D` | `#3C5251` | starting to desaturate toward grey-blue |
| 250 m | `#0A1317` | `#080B0E` | effectively black |
| 345 m | `#0C283E` | `#0B2429` | navy |
| 500–600 m | `#013842` / `#022A30` | `#030505` | only lamp-lit surfaces read |
| 800–950 m | `#17262F` (lit) | `#040612` | |
| Void (8000 m+) | `#000000` | `#000000` | pure black + particulate only |

### The three rules that actually matter

**Rule 1 — the red channel dies first and dies completely.**
In every mid-water frame measured, R sits at 0–15 while G and B sit at 60–170. At ~150 m
(`godrays-1.jpg`) the open water is literally `#00AA9C` — **R = 0**. If your water has a red
channel above ~10% at 100 m you have already lost.

**Rule 2 — the hue path goes THROUGH green, then comes back to blue.**
This is the single most-missed property.

```
0–20 m    B > G       cyan-blue     #2C9BC8   (G=155, B=200)
100–200 m G ≈ B or G > B   green-teal    #00AA9C   (G=170, B=156)   <-- green overtakes blue
300 m+    B > G       navy blue     #16436F   (G=67,  B=111)
600 m+    —           black         #030505
```

A straight lerp from blue to black skips the teal-green middle band and instantly reads as a
generic underwater shader.

**Rule 3 — saturation is HIGH, not "realistic".**
Mean per-pixel saturation on water-dominated frames measured **0.70 – 0.97**. `godrays-1.jpg`
measured **0.966**. This is a saturated, near-monochromatic field — one hue, crushed red, with
small very-saturated accents (orange seeds, magenta coral, cyan bioluminescence) punched into it.
A desaturated "grounded" grade is wrong.

### Biome fog tints override the depth ramp

The fog colour is the *biome's* ambient colour, not a global blue:

- Safe Shallows / open ocean — cyan-blue `#2C9BC8`
- Kelp Forest — green `#0B3710` … `#329C7C` in the light shafts
- Grand Reef / Underwater Islands — teal `#00AA9C` over navy `#011434`
- **Dunes — warm tan-brown `#6B5845` / `#A28458`** (see `misc-1.jpg` — a Reaper in *brown* fog)
- Jellyshroom Cave — violet `#251438` / `#441D60`
- Lost River — brine green-teal `#013842`
- Blood Kelp — near-black with cyan/green points only

A single ocean colour everywhere is a tech-demo tell.

---

## 2. Visibility, fog distance, and how objects fade

| Depth band | Usable visibility | Character |
|---|---|---|
| 0–30 m | 40–60 m | terrain texture legible far out; full colour |
| 50–100 m | 35–45 m | colour draining, silhouettes still crisp |
| 100–200 m | 25–35 m | mid-ground goes flat; far ground is fog-coloured |
| 200–300 m | 15–25 m *with a light*; ~0 without | only self-illuminated things read |
| 300–500 m | 15–20 m, lamp cone only | |
| 500 m+ | 10–15 m even with vehicle lights | |

**Objects lose contrast before they lose brightness.** They converge *toward the fog colour from
both directions* — dark things get lighter, bright things get darker, and both meet at the water
value. `godrays-1.jpg` is the proof: the nearest rock spire is near-black with visible surface
variation, the fourth spire back is a flat mid-tone, the sixth is barely separable from the water.
Nothing fades to black.

**Fading distant geometry to black is the classic amateur error.** In Subnautica distant terrain
gets *brighter*, not darker, because the fog is brighter than the unlit rock.

**Fog compresses the histogram.** Measured on the Dunes frame (`misc-1.jpg`): 0.1st-percentile
luminance = 13, 1st = 45, 99th = 154, 99.9th = 168. The entire frame lives inside 45–168 — no true
blacks and no highlights at all. That compression *is* the fog. Compare an unlit close-range frame
(`cave-3.jpg`) where the 0.1st percentile is **0**.

---

## 3. Caustics

Reference: `shallows-floor-1.jpg` (looking down at sand from ~8 m, with the player's own shadow in
frame for scale), plus hull caustics in `surface-above-5.jpg`.

- **Scale:** individual caustic cells are roughly **0.5–1.5 m across** on the floor — comparable to
  a human torso, clearly readable as individual shapes. About 10–14 cells span the near-field.
  They are not fine-grained noise.
- **Shape:** a *connected polygonal net* of interlocking bright loops — sharp bright lines with
  soft dim interiors. Not separate blobs, not a Voronoi cell-fill.
- **Contrast:** measured on tan sand averaging `#96846E`: caustic peaks `#CEB895`, shadowed cells
  `#5D5752`. That is roughly **2:1 peak-to-shadow**, i.e. about +30–45% over local diffuse.
  Blinding white caustics are wrong.
- **Projection:** they wrap correctly over 3D surfaces — rocks, the Seamoth hull, creature backs,
  the player's own arms. They are projected light, not a decal on the floor plane.
- **Occlusion:** the player's body and grass clumps cast real dark shadows *into* the caustic
  field. Caustics do not paint over shadowed areas.
- **Anisotropy:** the pattern is stretched along the swell direction and warps slowly and lazily.
  Not a fast strobe.
- **Depth persistence:** strong and legible 0–25 m, clearly weaker by 40 m, essentially gone past
  **60–80 m**. Kelp Forest frames at 29 m show only subtle caustics. Below ~100 m: none.
- **Lamps do not cast caustics.** Vehicle and base lights produce no caustic pattern at any depth.

---

## 4. God rays

Reference: `godrays-1.jpg` (the definitive frame), `godrays-2.jpg`, `kelp-forest-1.jpg`,
`shallows-reef-1.jpg`.

- **Angle:** near-vertical, tilted about **10–25° off vertical**, and all shafts are essentially
  **parallel**. They do not radiate from a point at wide angles.
- **Width and count:** each shaft is many metres wide; you can count roughly 6–10 broad overlapping
  shafts across a ~60 m-wide view. They are soft gradients, not hard cones.
- **Contrast:** subtle. Measured in `godrays-1.jpg`, shaft interiors `#009B8E` vs between-shaft
  `#007E75` — only about **10–15% brighter**. In shallower, more particulate-rich water they read
  a little stronger.
- **Terrain interaction — this is what sells them.** Shafts are *occluded* by terrain silhouettes.
  In `godrays-1.jpg` you can see soft dark shadow columns projected downward behind each rock
  spire; in `kelp-forest-1.jpg` the creepvine stalks slice the shafts. Rays that pass through rock
  instantly read as a screen-space hack.
- **Vertical falloff:** rays are brightest near the surface end and fade out before reaching the
  floor in deep scenes. They do not run at constant intensity top to bottom.
- **Depth range:** visible 0 m to roughly 200 m, strongest 5–60 m. None below ~250 m.

---

## 5. Sun and surface seen from below

- **0–2 m** (`surface-above-5.jpg`): the waterline through a canopy is a **hard, straight, sharp
  line** — the top half bright blue sky and white-capped chop, the bottom half flat olive-green
  water. Almost no blend zone. Looking up, you get Snell's window: a bright disc of compressed sky
  in the middle, mirror-like total internal reflection outside it showing the seabed reflected back.
- **5–10 m** (`kelp-forest-1.jpg`): the surface reads as a continuous rippling silvery-green
  *ceiling* with bright directional wave-crest streaks. Individual ripples are clearly resolved.
  The sun is a diffuse elongated blob, never a hard disc.
- **~30 m** (`shallows-reef-1.jpg`, `godrays-2.jpg`): the surface stops being readable as a
  surface. It becomes a smooth bright gradient across the top of frame, with the sun a soft glow.
  No individual ripples survive.
- **60 m+:** the surface is gone entirely. The top of frame is simply the brightest part of the fog
  gradient — which is why the vertical gradient in `godrays-1.jpg` runs `#00AA9C` at the top to
  `#011434` at the bottom with no visible surface at all.

---

## 6. Marine snow / particulate

- **Present at every depth — including total darkness.** `deep-void-1.jpg` at 8148 m is a pure
  black frame containing nothing but faint teal specks. This is a signature. Empty water is the
  fastest way to look fake.
- **Size:** 2–5 px at 1080p. Sub-centimetre. They do not scale like snowflakes and never become
  readable shapes.
- **Density:** sparse in the shallows (roughly 20–60 visible specks per frame), noticeably heavier
  in mid-water, caves and brine zones.
- **Lighting response:** they take the colour and intensity of *local* light. In a vehicle lamp
  cone they twinkle brightly; outside it they nearly vanish. Constant-white particles that glow
  against black and disappear against bright water are the giveaway.
- **Motion:** slow drift, mostly downward and sideways, with genuine parallax — near particles
  move visibly faster than far ones.
- **Two populations:** falling snow *and* rising bubble strings, plus occasional larger drifting
  seeds/spores. Having both directions of motion matters.

---

## 7. Terrain — what reads as Subnautica

- **Rounded and blobby.** Almost nothing has a sharp edge or a flat plane. The Grand Reef spires in
  `godrays-1.jpg` are tapered rounded fingers roughly 20–40 m tall, wider at the base — like melted
  candles, not rock formations.
- **Stacked plateaus and mesas:** flat-topped, grass-covered shelves with steep rounded sides,
  layered at several heights (`grand-reef-2.jpg`).
- **Crevasses and sinkholes:** the floor is punched through by dark holes and long trenches whose
  bottoms are simply not visible (`dropoff-2.jpg`, `grand-reef-2.jpg`).
- **Drop-offs:** near-vertical walls where a lit shelf ends and the water below is unresolved.
- **Sand ripples:** broad and directional, wavelength roughly **1.5–3 m**, running consistently
  across the shot, with a finer secondary ripple on top. Not tiling noise.
- **Boulder and cobble scatter** at shelf edges (`shallows-floor-2.jpg`).
- **Rock arches and natural bridges** (`kelp-forest-4.jpg`).
- **Caves have wide mouths**, not corridor tunnels (`cave-3.jpg`).
- **Bare rock is rare.** Nearly every surface is covered in grass, coral, tube growths, algae or
  moss. Exposed untextured rock reads as unfinished.

---

## 8. Flora silhouettes and scale (player ≈ 1.8 m)

| Plant | Size | Silhouette |
|---|---|---|
| Creepvine (kelp) | **25–40 m tall** — 15–25× player height | thin (0.3–0.5 m) twisted stalk with regular paired thorn-blades, soft crown; reads as pure black vertical silhouette |
| Creepvine seed pods | ~0.4 m each, clusters of 5–10 | glowing yellow-orange, the only warm colour in a green frame |
| Coral tubes | 3–8 m | hollow trumpets, flaring at the mouth, cream/pink, in clusters |
| Table / brain coral | 5–15 m across | flat discs and folded masses |
| Acid mushrooms | 1–2 m | yellow umbrellas on thin stalks, clumps of 5–15 |
| Grass / blood grass mats | 0.3–1 m | dense red, magenta or green carpets covering whole plateaus |
| Koosh spheres | 4–8 m diameter | blue-violet balls studded with cyan glow points on a short trunk |
| Jellyshroom caps | 8–20 m | translucent magenta domes lit from within |
| White branching coral | 2–4 m | pale cream, antler-like, in stands |

**The scale rule:** a good Subnautica frame contains flora at *two orders of scale at once* —
knee-height mats **and** 30 m towers. That contrast is what makes the player feel small. Flora all
at one size instantly reads as a demo.

---

## 9. Colour grading

- **Contrast curve:** high and clean, close to plain exposure plus a gentle highlight rolloff.
  There is no heavy filmic S-curve. Colours stay saturated as they get bright rather than
  desaturating toward white.
- **Black level — NOT lifted.** Unlit frames measured a 0.1st-percentile luminance of **0** and a
  median of **6–7** (`cave-3.jpg`, `deep-void-2.jpg`, `dropoff-1.jpg`). Subnautica lets huge areas
  of frame sit at true black. Do not apply a lifted-black "cinematic" LUT.
- **Where blacks *do* appear lifted, fog is the cause, not the grade.** Measured: fogged Dunes
  frame floor = 13/45, unfogged close-range frame floor = 0. Lift blacks with atmosphere in front
  of the object, never with a curve behind it.
- **Not afraid of black.** At 250 m+ over 90% of the frame sits below luminance 20
  (`dropoff-1.jpg`: median luminance **7**). Resist the urge to add ambient fill.
- **Highlights:** there is always a small bright tail — 99.9th percentile lands at 233–253 in lit
  frames (sun through surface, caustic peak, bioluminescent point, HUD). But the 99th percentile is
  only 148–220, so that tail is **a few percent of pixels at most**. In deep fogged frames nothing
  clips at all (`godrays-1.jpg` peaks at 152, `misc-1.jpg` at 168).
- **Bloom:** moderate, threshold set high — roughly the top 1–2% of luminance. Soft halo of about
  20–60 px radius at 1080p. It fires on the sun/surface, bioluminescence, lamps, HUD elements and
  fires — **not** on ordinary bright sand.
- **Chromatic aberration: effectively absent.** Do not add visible RGB fringing; it reads instantly
  as an off-the-shelf post stack.
- **Vignette:** mild, and it mostly comes from *geometry* — the diving mask border when swimming
  (`seamoth-1.jpg`) or the vehicle canopy rim (`seamoth-cockpit-1.jpg`, `creature-close-2.jpg`) —
  rather than a post-process darkening.
- **No lens dirt, no heavy grain, no letterbox.**

---

## 10. HUD

Reference: `hud-1.jpg` (full HUD), `hud-2.jpg`, `hud-3.jpg` / `hud-4.jpg` (PDA),
`seamoth-cockpit-2.jpg` (vehicle HUD).

### Language

Everything is a **translucent cyan-blue hologram**: a dark navy translucent fill with a bright
light-cyan 2 px outline, generous rounded corners, and often an asymmetric slightly organic
"sheet" shape with a curved tab rather than a plain rectangle. Panels sit around **70–85% opacity**
and *tint* the scene behind them blue rather than masking it.

A signature detail: **panels are wired together with thin 1–2 px curved cyan connector strokes**
linking a readout to its anchor point. Elements are not independent floating rectangles.

### Palette

| Role | Hex |
|---|---|
| Panel rim / stroke | `#6FDFFF` – `#8FE9FF` |
| Panel fill | `#0E3350` at ~65% |
| Primary text | `#FFFFFF` with soft shadow |
| Accent / buttons / unread / food | `#FFA22A` |
| O₂ and charge arcs | `#9BE55A` |
| Health / missing resources | `#F0553C` |
| Energy | `#FFD23F` |

### Layout

- **Depth — top centre.** Large white number (~48–64 px at 1080p) with a small lowercase `m`,
  sitting inside a shallow open arc. Directly beneath it a **curved compass tick strip** with
  N/NE/E letters and a yellow tick marking heading.
- **Vitals — bottom left, an organic cluster, not a row.** One large O₂ disc (~72 px) reading
  `O₂` over a number, plus three smaller discs (~44 px): health (red heart), food (orange apple),
  water (blue drop). Each is a dark disc with a **coloured progress arc around its rim**, arranged
  in a diamond/blob cluster.
- **Quick slots — bottom centre.** Five circles (~52 px), dark fill, cyan rim, white item glyph,
  partial coloured arc for charge/durability.
- **Resource chips — top right.** Small rounded-rect groups of item icons with `0/1` in red
  beneath, paired with a larger circular icon of the thing being built.
- **Vehicle HUD adds:** right-side stacked pills for hull integrity (wrench + number), energy
  (yellow bolt + %), temperature (thermometer + °C); left-side a wireframe outline of the vehicle
  with a segmented yellow/green arc gauge.
- **World markers:** tiny cyan glyphs with a thin label and a metre distance (`Neptune 806 m`),
  drawn small and low-contrast, with a chevron when off-screen.
- **Reticle:** a single small white ring, ~28 px diameter, with one tiny centre dot. Extremely
  minimal. Contextual prompts (`Exit (E)`, `Use (RMB)`) appear as small white text below it with
  the key in a rounded cyan key-cap.
- **Font:** clean humanist/geometric sans, no serifs, medium weight, slightly wide. Numbers are the
  loudest element on screen.

### The PDA

A large tablet-shaped translucent blue panel filling roughly the middle 65% of the screen with a
bright cyan border. A horizontal row of tab icons across the top, a left-hand index list with small
orange bullet markers on active/unread entries, and body text in white on blue glass. The scene
behind is visibly blurred and darkened but still readable. Corners are generously rounded with
small notch and tab details.

---

## 11. What makes an amateur underwater demo look fake

The checklist. Every item is something measurably true of the reference frames.

**Water and colour**

1. **Grey-blue fog instead of a hue.** Amateurs reach for `#4A6B80`. Subnautica's mid-water is
   R = 0–15 with G/B at 100–170 and 70–97% saturation. If R is above ~10% at 100 m, it's wrong.
2. **A monotonic blue → black ramp.** Real ramp is cyan-blue → **green-teal (G exceeds B around
   100–200 m)** → navy → black. Skipping the teal middle is the single most common tell.
3. **One fog colour everywhere.** Subnautica's fog is per-biome — tan-brown in the Dunes, green in
   the kelp, violet in the jellyshroom caves, teal in open water.
4. **Desaturated "realistic" grading.** The reference sits at 0.70–0.97 mean saturation.

**Fog and distance**

5. **Visibility too far.** 40–60 m in the shallows, 25–35 m at 150 m, 10–20 m below 300 m. If the
   whole scene is visible, it's fake.
6. **Distant objects fading to black.** They fade *toward the fog colour*, which means distant
   unlit terrain gets **brighter**, not darker.
7. **Losing brightness before losing contrast.** Objects must go flat and textureless first while
   holding roughly their average brightness, then dissolve.
8. **A single depth plane.** Every good Subnautica frame has a near silhouette, a mid subject and a
   fogged far layer.

**Caustics**

9. **A flat scrolling texture on the floor only.** They must project onto rocks, hulls, creatures
   and the player's own arms, and be occluded by geometry and by the player's shadow.
10. **Too bright, too small, too fast.** Target ~2:1 peak-to-shadow, 0.5–1.5 m cells, and a slow
    lazy warp — not a strobe and not fine noise.
11. **Caustics that survive to 300 m, or lamps that cast them.** Gone by 60–80 m; lamps never cast
    them.

**God rays**

12. **Hard-edged radial cones from a point.** They are broad, soft, near-parallel, tilted 10–25°
    off vertical, and only 10–15% brighter than the surrounding water.
13. **No occlusion.** Rays passing through solid rock instantly read as a screen-space hack. The
    soft shadow columns behind terrain are what sell the effect.
14. **Rays at constant intensity top to bottom.** They fade out before reaching the floor.

**Particulate**

15. **No particulate at all.** The fastest way to look fake. Marine snow exists at *every* depth,
    including a pure-black 8148 m frame.
16. **Particles that ignore lighting.** Constant-white snow glows against black and vanishes
    against bright water. It must take local light and twinkle inside lamp cones.
17. **Only one population.** You need falling snow *and* rising bubbles.

**Grading**

18. **Lifted blacks from a LUT.** Unlit Subnautica blacks measure 0. Lift comes from fog in front
    of the object, never a curve.
19. **Being afraid of black.** At 250 m+, over 90% of the frame is below luminance 20. Adding
    ambient fill destroys the look.
20. **Global bloom on everything.** Only the top 1–2% of luminance blooms. Bright sand does not.
21. **Visible chromatic aberration.** Subnautica essentially has none.

**Geometry and dressing**

22. **A flat sand plane with a tiling noise normal.** Needs 1.5–3 m directional ripples, boulder
    scatter, and heavy flora coverage.
23. **Hard-edged faceted rocks.** Everything is rounded and blobby with no flat planes and no sharp
    silhouette corners.
24. **Flora all at one scale.** Knee-high mats *and* 30 m towers must share the frame.
25. **Bare untextured rock.** Nearly every surface is overgrown.

**Deep scenes**

26. **Nothing self-illuminated.** Below 200 m the only visible things are bioluminescent or
    lamp-lit. A dark scene with no glow has nothing to look at.
27. **Bioluminescence as a uniform emissive surface.** It is *clusters of discrete small points*
    with bloom, sitting on an otherwise black object.

**Surface and HUD**

28. **A flat mirror surface from below.** It should be a rippling silvery ceiling with Snell's
    window at shallow depth, a smooth bright gradient by 30 m, and gone by 60 m.
29. **A hard sun disc underwater.** It is a soft elongated bloomed smear.
30. **A grey/white modern game HUD.** Subnautica's is cyan-blue holographic, translucent, rounded,
    wired together with thin curved connector strokes, and arranged in *organic clusters* rather
    than aligned bars. Panels tint the scene rather than masking it. The reticle is one small white
    ring with a dot.
