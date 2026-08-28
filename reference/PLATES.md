# Reference plates — what each one actually is, and which shot it may judge

> **WARNING added after round 27: `deep-void-2` contains NO CLEAN WATER WINDOW.**
> It is listed below as deep-void's verified primary, and for hue axes it is. But it has no region
> containing only water: its single water-only candidate has a larger HORIZONTAL spread (1.65) than
> vertical (1.39), because that window is a lit cave mouth plus a Seaglide lamp. An elevation term is
> rotationally symmetric and produces zero left-right structure, so **no vertical medium target can
> be derived from this plate in either direction.**
> Two consecutive rounds were spent on targets from it — round 26 chasing an inverted gradient, round
> 27 chasing a flattened one — and both were refused by the builder, correctly. Use it for hue
> (saturation and relative red, where our water hits it: 0.780 vs 0.774, R% 22 vs 23) and nothing
> spatial.

Every plate in `reference/subnautica/` was opened and looked at, and every number below came from
`node tools/measure.mjs`. Nothing here is inferred from a filename or from `index.json`'s `desc`.

The audit exists because `index.json` used to record only `{ file, category, desc, source }`. A brief
that wanted a target for a shot took whichever plate the index listed first for that category, and the
categories turn out to mix depths, framings, lighting conditions and vehicles freely. Three wrong
targets reached critics that way: `surface-pod-1` is a lifepod *interior* with no water in it;
`cave-1`/`cave-2` are a 209 m Jellyshroom cavern and a ~1200 m magma-lit lava zone; `godrays-1` is a
~150 m horizontal frame that was used to set a brightness target for a 40 m up-look. Every brief built
on a mismatched plate wastes a round.

`index.json` now carries `depth`, `framing`, `lighting`, `fromVehicle`, `hasHud`, `hasWatermark` and
`matchesShots` per entry. **`matchesShots` is the whitelist**: the shots that plate may judge *as a
whole-frame target*. An empty `matchesShots` does not mean the plate is useless — several of the most
valuable plates in the set (`godrays-1`, `misc-1`, `cave-3`, `school-1`) have an empty or narrow list
because no shot matches them on all three axes, while each remains the best reference in the game for
one specific property. Those partial uses are named per-shot below.

`fromVehicle` is `false`, or the name of the craft or structure the camera sits inside
(`seamoth`, `cyclops`, `prawn`, `base`, `lifepod`, `camera drone`).

---

## How to use this — which metrics survive a partial mismatch

A plate that differs from our shot on depth, framing or lighting can still judge *some* things. The
split is not a matter of taste; it follows from what each metric physically measures.

**Fair across a depth mismatch** (the relationship holds at every depth):

- **Hue path and channel ordering.** R crushed to near zero, and whether G > B (100–200 m) or B > G
  (0–20 m and 300 m+). `redPct` and `bandGB` compare honestly between a 110 m plate and a 40 m render.
- **Saturation** (`sat`) as a *floor* rather than a target — LOOK.md's 0.70 applies to any
  water-dominated frame. Do not apply it to a frame that is mostly sand, hull or interior panel.
- **Contrast falloff with distance** — near geometry dark and textured, far geometry flat and
  converging toward the fog colour *from both directions*. Never toward black.
- **Detail and texture presence** (`detailRMS`, `tileContrast`) on surfaces at comparable screen size.

**Fair only when depth AND lighting match:**

- **Absolute black level** (`p0.1`, `p1`). The most abused number in this set. `grand-reef-1` reads
  p0.1 = 0.2, but those pixels are the dive-mask *vignette corners*, not the scene; its scene floor is
  around 9. `grand-reef-2` never goes below 8.4 anywhere in frame. A black-level target taken from
  either is measuring the wrong thing.
- **Median / mean luminance and `range`.** `shallows-floor-1` (median 141.7) and `shallows-floor-2`
  (median 19.3) are the same biome and the same category, six-fold apart, because one is noon and one
  is night.
- **`topBottom`.** It encodes where the light is relative to the camera. `godrays-1` reads 8.62 only
  because it is a horizontal frame with the surface far above and out of shot; an up-look or a
  down-look cannot produce that number and must not be asked to.
- **`clipPct` and highlight behaviour** — set by whether a lamp, the sun or a magma pool is in frame.

**Never fair across a framing or vehicle mismatch:**

- Any whole-frame statistic from a plate carrying a **dive-mask vignette** (the rounded orange rim in
  most promo shots), a **cockpit interior**, a **HUD**, or a **watermark**. Those pixels are UI and
  hull, not world. Measure a water-only or surface-only patch with `--crop=` instead — that is how the
  depth estimates in the table below were produced.
- Composition and aspect from the stitched or cropped plates: `misc-3` is a 1941x2262 portrait crop,
  `misc-4` a 3760x934 panorama, `surface-above-2` a 3000x1205 ultrawide, `night-shallows-3` a
  3440x1440 ultrawide.

**Two build caveats.** `wreck-1` and `shallows-reef-4` are early-access builds (visible EA watermarks,
old horizontal-bar HUD); their water is brighter and more cyan at depth than the shipped ramp, so take
structure from them, never colour. Promo plates (`hasWatermark: true`) carry a lifted, gallery-friendly
grade — `grand-reef-1` sits at median 122.5 where the shipped 200 m band is far darker.

---

## Every plate, measured

`p0.1 / med / p99.9` are luminance percentiles; `sat` is mean per-pixel saturation; `R%` is the red
mean as a percentage of the largest channel mean; `t:b` is the top-third / bottom-third luminance
ratio. `HUD` / `WM` flag an in-game HUD and a watermark. Depths marked `(HUD)` were read off the
in-game depth readout; the rest are estimated from a cropped water sample against LOOK.md section 1.

| plate | depth | framing | lighting | from | flags | p0.1 | med | p99.9 | sat | R% | t:b | may judge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `surface-pod-1` | 0m (HUD) | interior | dim interior | lifepod | HUD | 8.5 | 40.3 | 250.8 | 0.265 | 100 | 1.14 | **none** |
| `surface-above-1` | 0m (HUD) | horizontal-waterline | daylight | - | HUD | 23.8 | 91.7 | 249.3 | 0.532 | 51 | 1.94 | surface-pod, surface-above |
| `surface-above-2` | 0m | above-water horizontal | daylight | - | - | 6 | 122.7 | 252.6 | 0.529 | 60 | 2.09 | surface-above, surface-pod |
| `surface-above-3` | 0m | above-water horizontal | dusk | - | - | 1.1 | 22.8 | 219.3 | 0.81 | 100 | 0.75 | **none** |
| `surface-above-4` | 0m (HUD, shore) | above-water horizontal | sunset | - | HUD | 2.5 | 53 | 244 | 0.422 | 99 | 1.56 | **none** |
| `surface-above-5` | 0m (HUD) | waterline split through glass | daylight | seamoth | HUD | 9.6 | 115.8 | 250.2 | 0.378 | 63 | 1.29 | **none** |
| `shallows-reef-1` | ~12m (est; water #2C9BC8-class) | horizontal, slight up | daylight | - | - | 6.4 | 122 | 235.3 | 0.734 | 25 | 1.52 | shallows-reef, hud |
| `shallows-reef-2` | 9m (HUD) | horizontal | night + base/vehicle lamp | - | HUD | 0 | 18.7 | 239.2 | 0.316 | 64 | 0.25 | night-shallows |
| `shallows-reef-3` | ~15m (est) | horizontal, slight down | daylight | - | WM | 1.8 | 68.7 | 230.8 | 0.679 | 36 | 2.33 | shallows-reef |
| `shallows-reef-4` | 7m (HUD) | down-look | daylight | - | HUD+WM | 3 | 66.3 | 234.9 | 0.48 | 89 | 1.08 | **none** |
| `shallows-floor-1` | ~8m (est) | down-look (straight down) | daylight | - | - | 7.1 | 141.7 | 252.9 | 0.281 | 100 | 1.09 | shallows-floor |
| `shallows-floor-2` | ~40-60m (est) | horizontal over floor | night/low light | - | - | 0.7 | 19.3 | 211.9 | 0.768 | 51 | 0.47 | **none** |
| `godrays-1` | ~150m (water measures #00B8AA = the 140-160m band) | horizontal | daylight (shafts from above frame) | - | - | 0 | 53.7 | 151.9 | 0.965 | 0 | 8.62 | **none** |
| `godrays-2` | 29m (HUD) | horizontal | daylight (kelp biome) | - | HUD | 0.9 | 38.2 | 237.3 | 0.79 | 27 | 1.44 | kelp-forest |
| `kelp-forest-1` | ~15-25m (est) | up-look | daylight | - | - | 0.7 | 39.8 | 233 | 0.837 | 25 | 3.5 | kelp-forest |
| `kelp-forest-2` | ~25-40m (est) | horizontal | daylight | - | WM | 0.2 | 63.3 | 237.3 | 0.703 | 51 | 1.45 | kelp-forest |
| `kelp-forest-3` | ~20-30m (est) | horizontal, slight down | daylight | - | - | 26.9 | 111.9 | 254.1 | 0.475 | 55 | 1.25 | kelp-forest |
| `kelp-forest-4` | ~25-40m (est) | horizontal | daylight | - | WM | 3.6 | 67.1 | 225.1 | 0.653 | 46 | 1.2 | kelp-forest |
| `dropoff-1` | 253m (HUD) | horizontal | unlit (bioluminescence only) | - | HUD | 0 | 7.1 | 244.6 | 0.346 | 61 | 1.78 | **none** |
| `dropoff-2` | ~250m-class or night (water measures #030A15) | horizontal, floor lower half | night/unlit + distant vehicle lamp | - | - | 2.3 | 10.7 | 99 | 0.714 | 41 | 0.32 | **none** |
| `grand-reef-1` | ~200m (water measures #56848D) | horizontal, slight up | daylight (promo grade) | - | WM | 0.2 | 122.5 | 222 | 0.442 | 72 | 1.84 | **none** |
| `grand-reef-2` | ~280-345m (water measures #172443) | horizontal, slight down | deep ambient + local glow | - | - | 8.4 | 36.7 | 107.2 | 0.44 | 56 | 0.66 | grand-reef |
| `deep-void-1` | 8148m (HUD) | horizontal | seaglide lamp (nothing in range) | - | HUD | 0 | 3 | 239.8 | 0.134 | 88 | 0.26 | **none** |
| `deep-void-2` | 589m (HUD) | horizontal | seaglide lamp + biolum | - | HUD | 0 | 6.1 | 249.5 | 0.526 | 34 | 0.52 | deep-void |
| `deep-void-3` | 919m (HUD) | interior looking out | interior + exterior lamps | base | HUD | 0 | 6.7 | 224.2 | 0.737 | 30 | 0.56 | **none** |
| `deep-void-4` | 893m (HUD) | down-look | base floodlight/interior glow | - | HUD | 5.1 | 48.9 | 250.5 | 0.613 | 54 | 0.58 | **none** |
| `wreck-1` | 111m (HUD) | horizontal | daylight ambient | - | HUD+WM | 1.5 | 52 | 228.5 | 0.599 | 50 | 1.86 | wreck |
| `wreck-2` | 42m (HUD) | interior (inside the Aurora) | unlit + emergency strips + fire | - | HUD | 0 | 14.4 | 239.7 | 0.283 | 71 | 1.38 | **none** |
| `wreck-3` | ~100-150m (est) | horizontal, from cockpit | daylight ambient | seamoth | WM | 8.2 | 65.6 | 225.5 | 0.713 | 29 | 0.89 | wreck, seamoth-cockpit |
| `cave-1` | 209m (HUD) | horizontal (cavern interior) | biolum (jellyshroom) + seaglide lamp | - | HUD | 0 | 21.5 | 237.2 | 0.729 | 67 | 0.99 | cave |
| `cave-2` | ~1000-1400m ILZ (est) | horizontal (lava cave) | magma glow | prawn | WM | 0.2 | 33.4 | 254.3 | 0.677 | 100 | 0.39 | **none** |
| `cave-3` | ~150-300m (est, enclosed) | horizontal (cave mouth) | unlit + biolum | - | - | 0 | 5 | 163.1 | 0.346 | 53 | 0.15 | cave |
| `creature-close-1` | ~200-300m (est) | horizontal | biolum + dim ambient | - | WM | 0 | 41.1 | 252.4 | 0.79 | 33 | 0.6 | **none** |
| `creature-close-2` | ~10-20m (est) | horizontal, slight up | daylight | - | - | 0.2 | 76.4 | 239.9 | 0.583 | 56 | 1.23 | **none** |
| `creature-close-3` | 110m (HUD) | horizontal | daylight ambient | - | HUD | 1.8 | 70.1 | 250.1 | 0.856 | 20 | 1.32 | **none** |
| `creature-close-4` | 103m (HUD) | horizontal | daylight ambient | seamoth | HUD | 0.1 | 83.4 | 249 | 0.549 | 56 | 1.36 | seamoth-cockpit |
| `school-1` | 345m (HUD) | horizontal, from cockpit | deep ambient + biolum | cyclops | HUD | 0.2 | 30.8 | 249 | 0.772 | 31 | 0.64 | **none** |
| `seamoth-1` | ~15-25m (est) | horizontal, slight down | daylight | - | WM | 2.8 | 62.9 | 243.5 | 0.527 | 62 | 1.04 | seamoth |
| `seamoth-2` | 12m (HUD) | horizontal, slight up | daylight | - | HUD | 0.6 | 87.3 | 247.1 | 0.663 | 40 | 1.8 | seamoth, hud |
| `seamoth-cockpit-1` | 110m (HUD) | horizontal, from cockpit | daylight ambient | seamoth | HUD | 0.7 | 81.5 | 248.9 | 0.522 | 51 | 1.35 | seamoth-cockpit |
| `seamoth-cockpit-2` | 145m (HUD) | horizontal, slight down, from cockpit | deep ambient | seamoth | HUD | 3.2 | 65.3 | 239.7 | 0.729 | 29 | 0.89 | seamoth-cockpit |
| `base-interior-1` | ~20-40m (est; creepvine outside) | interior looking out through viewport | interior lights | base | - | 0.7 | 71.2 | 210.9 | 0.261 | 88 | 1.03 | base-interior |
| `base-interior-2` | 15m (HUD) | interior | interior lights | base | HUD | 0 | 112.3 | 252.4 | 0.156 | 89 | 1.25 | base-interior |
| `base-interior-3` | 0m | interior, glass ceiling to sky | interior lights + daylight | base | - | 0 | 82.5 | 209.1 | 0.297 | 88 | 0.97 | **none** |
| `base-interior-4` | 14m (HUD) | interior up-look with viewport | interior lights | base | HUD | 3.5 | 113.7 | 255 | 0.128 | 91 | 0.69 | base-interior |
| `hud-1` | 0m (HUD), above water | above-water horizontal/up | daylight | - | HUD | 11.9 | 138.5 | 251.8 | 0.368 | 70 | 1.14 | **none** |
| `hud-2` | 32m (HUD) | horizontal, camera-drone POV | night + drone lamp | camera drone | HUD | 0 | 9.5 | 236.9 | 0.684 | 48 | 0.31 | **none** |
| `hud-3` | n/a (PDA) | interior, PDA overlay | interior lights | base | HUD | 7.8 | 93.1 | 251.6 | 0.399 | 94 | 1.03 | **none** |
| `hud-4` | n/a (PDA) | interior, PDA overlay | interior lights | base | HUD | 15.7 | 68.4 | 251.2 | 0.407 | 65 | 1.24 | **none** |
| `night-shallows-1` | ~40-60m (est) | down-look | night + base lights | - | - | 21.3 | 37.6 | 151.3 | 0.808 | 18 | 0.61 | **none** |
| `night-shallows-2` | 88m (HUD) | horizontal, slight down | night + base lights | - | HUD | 0 | 20.7 | 219.9 | 0.846 | 18 | 0.91 | **none** |
| `night-shallows-3` | ~100-250m (est) | down-look | base floodlight | - | - | 1.9 | 33.6 | 253 | 0.755 | 52 | 0.8 | **none** |
| `misc-1` | ~100-200m Dunes (est; fog measures #725D49) | horizontal down-slope | daylight ambient | - | - | 12.2 | 98.2 | 168 | 0.413 | 100 | 0.7 | **none** |
| `misc-2` | ~600-900m Lost River (est) | horizontal (free camera) | brine haze + biolum | - | WM | 1 | 70 | 210.5 | 0.864 | 15 | 1.09 | **none** |
| `misc-3` | unknown (night/deep) | composed portrait crop | biolum only | - | - | 0.4 | 6.5 | 194.9 | 0.93 | 13 | 0.52 | **none** |
| `misc-4` | ~200-300m Bulb Zone (est) | stitched panorama | biolum + distant lamp | - | - | 0.5 | 7.6 | 253.9 | 0.819 | 30 | 0.59 | **none** |
| `misc-5` | ~150-250m Koosh (est; water measures #3C568C) | horizontal | dim ambient | - | - | 15.5 | 81.6 | 185.4 | 0.529 | 48 | 0.85 | **none** |
| `misc-6` | ~100-200m (est) | horizontal | base lights + dim ambient | - | WM | 0.3 | 64.9 | 251 | 0.513 | 54 | 0.99 | **none** |

### Plate-by-plate notes (things the `desc` field does not say)

- `surface-pod-1` — Lifepod 5 interior, Turkish HUD (O2 45). NO water anywhere in frame.
- `surface-above-1` — Treading water, eye at the waterline; burning Aurora on the horizon.
- `surface-above-2` — Ultrawide 3000x1205 daylight panorama; sky top / sea bottom.
- `surface-above-3` — Sunset + gas giant + Aurora explosion. No HUD (the index desc wrongly says O2=135).
- `surface-above-4` — Floating Island shore at sunset; this is the O2=135 HUD the index attributes to `-3`.
- `surface-above-5` — Shot through a cockpit canopy; Aurora hull fills the left half.
- `shallows-reef-1` — Clean modern-build frame: surface + shafts at top, reef floor in the lower third, a diver arm at right.
- `shallows-reef-2` — Filed under shallows-reef, but it is the best NIGHT-shallows plate in the set.
- `shallows-reef-3` — Promo: seabase + Gasopod, dive-mask vignette, SUBNAUTICA watermark.
- `shallows-reef-4` — Seaglide screen + old horizontal-bar HUD, early-access watermark (Sep-2016), planted growbeds.
- `shallows-floor-1` — Dive-mask vignette and both hands in frame; player and fish shadows fall into the caustic field. The frame is ~90% sand.
- `shallows-floor-2` — Sparse Reef cobbles + acid mushrooms; median 19.3 against `shallows-floor-1`'s 141.7.
- `godrays-1` — The cleanest plate in the set: no HUD, no vignette, no watermark, no vehicle. The surface itself is NOT in frame.
- `godrays-2` — Diver + Seaglide, dive-mask vignette; creepvine silhouettes, shafts raking from upper right.
- `kelp-forest-1` — Surface underside visible at the top; the only clean up-look with shafts in the whole set.
- `kelp-forest-2` — Promo, dive-mask vignette, SUBNAUTICA watermark, a hand holding a Peeper.
- `kelp-forest-3` — Alien Containment + base among creepvine. Brightest kelp plate (p0.1 = 26.9: no blacks at all).
- `kelp-forest-4` — Promo, dive-mask vignette, SUBNAUTICA EARLY ACCESS watermark, two Stalkers.
- `dropoff-1` — Blood Kelp. Black except bioluminescent points and a distant sub. Biome, not depth, sets that.
- `dropoff-2` — The entire frame lives below luma 99 (p99.9 = 99, range 97). Nothing bright exists in it.
- `grand-reef-1` — Cyclops overhead. p0.1 = 0.2 comes from the dive-mask vignette CORNERS, not from the scene.
- `grand-reef-2` — The whole frame lives inside luma 8.4–107.2. No absolute black, no highlight.
- `deep-void-1` — Diver + Seaglide (the index says Cyclops — wrong). Pure black plus marine snow; median 3.0.
- `deep-void-2` — A wall barely picked out by the lamp; cold blue-green cast. The usable deep plate.
- `deep-void-3` — Right framing for base-interior, wrong depth by 30x: the exterior is black.
- `deep-void-4` — Median 48.9 is the BASE, not the water; the water itself is near-black.
- `wreck-1` — Early-access build (Jan-2017 watermark, old bar HUD, dive-mask vignette): its 111 m water is brighter and more cyan than the shipped ramp.
- `wreck-2` — A ship interior, not a seabed wreck exterior.
- `wreck-3` — Promo from the Seamoth helm (the index says Cyclops); sand floor, Sand Sharks, long-range fog.
- `cave-1` — Diver + Seaglide (the index says Seamoth — wrong). Violet biome tint overrides the depth ramp.
- `cave-2` — R% = 100. Red-dominant and magma-lit: the exact inverse of LOOK.md rule 1.
- `cave-3` — p0.1 = 0, median 5.0: the reference for how black Subnautica lets unlit rock go.
- `creature-close-1` — Promo Crabsquid, dive-mask vignette, watermark, Seamoth in frame.
- `creature-close-2` — A Peeper held at arm's length; the creature and the mask vignette own the frame.
- `creature-close-3` — Diver + Seaglide. Best fog-falloff reference in the set, but 110 m, not 40 m.
- `creature-close-4` — Reaper head-on from the Seamoth helm; hull/energy/temperature block at right.
- `school-1` — The school is legible ONLY because the fish self-illuminate at 345 m.
- `seamoth-1` — Promo diver POV with a scanner, dive-mask vignette, watermark; default orange-and-white hull.
- `seamoth-2` — Full modern HUD over a daylight underwater frame. The hull is a CUSTOM blue/green player paint — not a colour target.
- `seamoth-cockpit-1` — Canonical cockpit geometry: canopy arch, two green holo consoles, depth ring, right-hand vehicle block.
- `seamoth-cockpit-2` — Same cockpit, deeper: debris reads blue-on-blue at low contrast.
- `base-interior-1` — The only plate in the set showing a habitat interior WITH water through the glass.
- `base-interior-2` — Fabricator + HUD + resource chips. No window, so no water reference.
- `base-interior-3` — Surface Multipurpose Room, heavily player-decorated. Sky, not water, through the glass.
- `base-interior-4` — Good for the interior-bright / exterior-dark ratio through a viewport.
- `hud-1` — Modern HUD reference, but the frame is the Neptune rocket against a blue sky. No water optics in it.
- `hud-2` — Camera-drone overlay: a different UI language from the survival HUD.
- `hud-3` — PDA Photo Manager page. UI-only plate.
- `hud-4` — PDA Databank page. UI-only plate.
- `night-shallows-1` — p0.1 = 21.3: even at night nothing in frame reaches black. Pale fog banks lie over the seabed.
- `night-shallows-2` — The base is a distant cluster of points; six times our night-shallows depth.
- `night-shallows-3` — Ultrawide 3440x1440; enclosed and deep, not shallows.
- `misc-1` — Brown fog, R% = 100. Proof that biome fog overrides the blue ramp. Histogram 12–168.
- `misc-2` — Promo; the Prawn is seen from outside, so it is not a first-person framing.
- `misc-3` — 1941x2262 portrait wallpaper crop — aspect and composition are not gameplay framings.
- `misc-4` — 3760x934 stitched panorama; useful for glow-point density only.
- `misc-5` — B > G navy at close range; p0.1 = 15.5, no blacks.
- `misc-6` — Promo, dive-mask vignette, watermark; large modular base with warm viewports.

**Four `index.json` descriptions are wrong about the camera.** The `desc` strings were left in place
rather than rewritten, so the corrections live here: `deep-void-1` and `cave-1` are a **diver holding a
Seaglide**, not a Cyclops and not a Seamoth (in both, the bottom console reads *toggle lights / toggle
map / power*, in Finnish and Russian respectively); `wreck-3` is the **Seamoth helm**, geometrically
identical to `seamoth-cockpit-1` and `creature-close-4`, not the Cyclops; and `surface-above-3` has
**no HUD at all** — the O2=135 HUD it claims belongs to `surface-above-4`.

**One recurring misread worth naming.** The rounded orange rim that frames many plates is the
**diver's dive mask**, not a Seamoth canopy. Plates with hands, a knife, a scanner or a Seaglide in
frame are first-person *diver* shots: `shallows-reef-3`, `shallows-floor-1`, `kelp-forest-2`,
`kelp-forest-4`, `godrays-2`, `grand-reef-1`, `seamoth-1`, `seamoth-2`, `creature-close-1..3`,
`dropoff-1`, `deep-void-1`, `deep-void-2`, `cave-1`, `wreck-1`, `misc-6`. The real Seamoth interior is
a pale grey shell with two green holo consoles and a right-hand hull/energy/temperature block
(`seamoth-cockpit-1`, `seamoth-cockpit-2`, `creature-close-4`, `wreck-3`); the Cyclops is the dark teal
double window frame with purple ability icons (`school-1`).

---

## Per-shot targets

Each section gives the shot's own camera (from `src/core/shots.js`), then the plate a critic may score
it against, the acceptable alternates, and the plates that must **not** be used, with the reason.
"PRIMARY: none" is a real answer and appears four times; forcing a plate into those slots is what has
been costing rounds.

### `surface-pod` — cam [12, 1.2, 18], 1.2 m *above* the waterline, pitch -4, tod 0.42

- **PRIMARY — `surface-above-1`.** 0 m, eye at the waterline, horizontal, daylight, HUD present. The
  only plate that frames the sea from a swimmer's head height in daylight.
- **Alternate — `surface-above-2`** (same condition, no HUD, ultrawide: compare band ratios and hue,
  not composition).
- **REJECTED — `surface-pod-1`**, the plate this shot is named after and was pointed at for three
  rounds. It is the *interior* of Lifepod 5 at 0 m: curved brown hull panels, a damaged radio, no
  water, no sky, no horizon. Measured sat 0.265, R% 100, median 40.3 — an unlit warm-brown box. Every
  LOOK.md rule (red dies first, saturation ≥ 0.70, hue path through green) is inverted by it. It
  cannot judge an open-water surface frame on any axis.
- **REJECTED — `surface-above-3` / `-4`** (dusk and sunset against our tod 0.42),
  **`surface-above-5`** (shot through a cockpit canopy; Aurora hull fills the left half),
  **`hud-1`** (0 m, but the frame is a rocket against sky).

### `surface-above` — cam [0, 6, 0], 6 m above the water, pitch -8, tod 0.38

- **PRIMARY — `surface-above-2`.** Daylight, above the waterline, sky over sea, and no HUD to
  contaminate the statistics. Caveat: 3000x1205, so use `bandLum` / `bandGB` and hue, not framing.
- **Alternate — `surface-above-1`** (lower eye height, more foam, HUD present).
- **REJECTED — `surface-above-3`, `-4`** (dusk and sunset: their warm sky drives R% to 100 and 99,
  which would push our daytime grade red), **`surface-above-5`** (the lower half is water seen
  *through glass*), **`surface-pod-1`** (interior).

### `shallows-reef` — cam [30, -12, 40], pitch -6, tod 0.42

- **PRIMARY — `shallows-reef-1`.** ~12 m, near-horizontal with the surface and shafts at the top of
  frame, daylight, modern build, no vignette and no HUD. The clean shallow-blue plate: sat 0.734,
  R% 25, median 122.
- **Alternate — `shallows-reef-3`** (~15 m promo; dive-mask vignette and watermark, so crop before
  measuring).
- **REJECTED — `shallows-reef-2`** (9 m but **night**: median 18.7 against `shallows-reef-1`'s 122 — a
  six-fold exposure gap inside one category), **`shallows-reef-4`** (7 m **down-look** through a
  Seaglide screen, early-access build, base growbeds dominating the frame).

### `shallows-floor` — cam [-40, -18, 25], pitch -12, snapped 3.5 m above terrain, tod 0.42

- **PRIMARY — `shallows-floor-1`, for caustics only.** ~8 m, straight-down look, daylight, with the
  player's own shadow in frame for scale. Judge against it: caustic cell size (0.5–1.5 m), the
  connected polygonal net, roughly 2:1 peak-to-shadow contrast, and occlusion — bodies and grass cast
  real shadows *into* the caustic field.
- **Do not** take water colour, saturation or R% from it. About 90% of that frame is tan sand, which
  is why it measures sat 0.281 and R% 100. Take the water column from `shallows-reef-1` instead.
- **REJECTED — `shallows-floor-2`** (night / low-light Sparse Reef, median 19.3 against 141.7, and
  40–60 m rather than shallows).

### `godrays` — cam [0, -40, 0], pitch **+40 (up-look)**, tod 0.42

- **PRIMARY: none.** There is no daylight up-look at 40 m with terrain silhouetted anywhere in this set.
- `godrays-1` is the canonical shaft plate, but it is a **horizontal ~150 m frame**: its open water
  measures `#00B8AA` (R = 0), squarely LOOK.md's 140–160 m band, and its `topBottom` of 8.62 exists
  only because the surface is far above and out of shot. Use it for shaft geometry (near-vertical,
  soft-edged, spanning the full frame height), for R% = 0 and sat 0.965 in mid-water, and for the
  spire-by-spire contrast falloff — nearest spire near-black and textured, sixth spire barely separable
  from the water. **Do not** take median, `range`, `topBottom` or any brightness target from it; a
  critic has already refused one, correctly.
- `kelp-forest-1` is the only genuine up-look with the surface in frame and shafts descending. Use it
  for the *shape* of an up-look (bright ceiling, silhouetted verticals), never for colour — it is the
  kelp biome, which LOOK.md says overrides the depth ramp entirely.
- **REJECTED — `godrays-2`** (29 m, horizontal, kelp-green, with a Seaglide, a mask vignette and a HUD
  in frame).
- *Shot-level note for whoever owns this framing:* if the intent is to be scored against `godrays-1`,
  the camera needs to be a horizontal frame at 100–150 m with a terrain ridge across the middle, not a
  40 m up-look. Until one or the other moves, this shot is unscoreable against this plate set.

### `kelp-forest` — cam [130, -55, -90], pitch +8, tod 0.42

- **PRIMARY — `kelp-forest-1`.** Up-look, black creepvine against green-teal water, orange seed
  clusters, clean frame (sat 0.837, R% 25, `topBottom` 3.5). Depth caveat: ~15–25 m against our 55 m,
  but LOOK.md's biome-override rule makes the *green* the dominant term here rather than the depth
  ramp, so hue, saturation and the silhouette-against-bright-water relationship all transfer.
  Absolute brightness does not.
- **Alternates — `kelp-forest-3`** (clean, horizontal, no watermark; note p0.1 = 26.9, it contains no
  blacks at all), **`kelp-forest-2` / `-4`** (promo, mask vignette + watermark: crop before measuring),
  **`godrays-2`** (29 m kelp with shafts; HUD in frame).

### `dropoff` — cam [-160, -74, 150], pitch -14, snapped 7 m above the lip, tod 0.42

- **PRIMARY: none.** Both plates in this category are night or unlit deep frames, while our shot is a
  daylight 74 m look over a lit shelf into a void. Nothing in the set matches all three axes.
- **REJECTED — `dropoff-1`** (253 m, unlit, bioluminescence only, median 7.1 — and it is Blood Kelp,
  whose blackness is a *biome* property, not a depth one), **`dropoff-2`** (night; its entire frame
  lives below luma 99, so it cannot supply a highlight or even a mid-tone for a daylight shot).
- Closest partials, one property each: **`godrays-1`** for the "lit water above, terrain silhouetted,
  contrast dying with distance" relationship; **`creature-close-3`** for mid-depth fog falloff;
  **`misc-1`** for how a lit slope reads against a void with a compressed histogram (12–168) — its fog
  is Dunes brown, so structure only, never hue.

### `grand-reef` — cam [340, -280, -260], pitch -8, tod 0.42

- **PRIMARY — `grand-reef-2`.** Its open water measures `#172443`, matching the ramp's ~345 m navy;
  horizontal-to-slightly-down over a floor; deep ambient with local glow. Fair targets: the navy hue
  with B > G, the compressed histogram, the low `tileContrast` (6.42), and the way plateaus fade out
  *behind* rather than fading to black.
- **The black-level target previously assigned here is invalid.** `grand-reef-2` runs p0.1 = 8.4 to
  p99.9 = 107.2 — the whole frame lives inside 8–107. `grand-reef-1` appears to reach 0.2 only because
  its dive-mask vignette corners are black; its scene floor is around 9. Neither plate contains
  absolute black, so neither can set one.
- **Alternate — `misc-5`** (Koosh at ~150–250 m, water `#3C568C`) for the B > G deep-blue hue at close
  range.
- **REJECTED — `grand-reef-1`** (promo grade: water measures `#56848D` at median 122.5, roughly three
  times brighter than a shipped 280 m frame, plus a mask vignette and a watermark), **`school-1`**
  (right depth band, wrong framing — see below).

### `deep-void` — cam [-420, -678, 380], 18 m above the seabed, pitch -10, tod 0.42

- **PRIMARY — `deep-void-2`.** 589 m, horizontal, a rock wall just barely picked out by the vehicle
  lamp, cold blue-green cast, marine snow. Same regime as our 678 m: lamp-only, 10–15 m of usable
  visibility.
- **Alternates — `misc-3` / `misc-4`** for bioluminescent point density against black (both are crops
  or panoramas, so density only), **`deep-void-3`** for how black the exterior goes at depth.
- **REJECTED — `deep-void-1`** (8148 m Void: median 3.0, no terrain in frame at all — scoring our
  18-m-above-seabed shot against it penalises having any geometry present, which is exactly the
  failure the shot's own comment says it was repositioned to fix), **`deep-void-4`** (893 m, but its
  median 48.9 is a lit seabase filling the frame, not water).

### `wreck` — cam [210, -95, 60], pitch -8, tod 0.42

- **PRIMARY — `wreck-1`.** 111 m, horizontal, wreck exterior on the seabed under daylight ambient.
  Build caveat: early access (EA watermark, old bar HUD, mask vignette), so its 111 m water is brighter
  and more cyan than the shipped ramp — take structure, silhouette and fog behaviour from it, not the
  water value.
- **Alternate — `wreck-3`** (promo from the Seamoth helm: sand floor, wreck section, long-range fog;
  crop out the cockpit before measuring).
- **REJECTED — `wreck-2`** (42 m, but it is *inside* the Aurora: an enclosed hall lit by green
  emergency strips and a fire, median 14.4, R% 71 — an interior, not a seabed exterior).

### `cave` — cam [-90, -190, -180], pitch 0, snapped 9 m above the floor, tod 0.42

- **PRIMARY — `cave-3`.** Unlit cave interior, horizontal at the mouth, rock crushed to black
  (p0.1 = 0, median 5.0) with a teal opening and purple-and-gold bioluminescence on pale sand. This is
  the plate for "hard darkness beyond the light", which is what the shot exists to test.
- **Alternate — `cave-1`, for the depth band only** (209 m against our 190 m, horizontal, diver with a
  Seaglide). Its violet Jellyshroom tint is a biome fog colour: unless our cave is jellyshroom, take
  the "large soft glowing shapes readable inside a dark cavern" relationship and leave the hue alone.
- **REJECTED — `cave-2`.** Lava Castle from a Prawn Suit at roughly 1000–1400 m, lit by magma. It
  measures **R% = 100** with `bandGB` [1.28, 1.48, 1.26] — red-dominant, the exact inverse of LOOK.md
  rule 1. Any hue, channel or brightness target derived from it actively breaks the look.

### `creature-close` — cam [60, -40, -60], pitch 0, tod 0.42

- **PRIMARY: none.** No plate shows a large creature at close range in the 25–40 m band; the two
  candidates sit at 110 m and ~15 m.
- Closest partials: **`creature-close-3`** (110 m) for the property that actually matters here — a
  creature reading as a *soft-contrast silhouette converging toward the fog colour*, with a fish school
  behind it already fog-washed. Its `bandGB` around 0.85 and sat 0.856 transfer; its median 70.1 and
  its fog distance do not. **`creature-close-2`** (~15 m, daylight) for how a creature's albedo and eye
  read at close range in bright shallow water. **`creature-close-4`** for a Reaper silhouette at 103 m,
  though that frame is a cockpit.
- **REJECTED — `creature-close-1`** (promo, ~200–300 m bioluminescent zone, watermark: its creature is
  legible by its own glow, which is not available to ours at 40 m in daylight).

### `school` — cam [-20, -26, 70], pitch -4, tod 0.42

- **PRIMARY: none**, and this is the worst framing mismatch that had gone unflagged. The only plate in
  the category, `school-1`, is at **345 m from inside a Cyclops** — thirteen times our depth, with
  vehicle window frames down both sides and a full vehicle HUD. Its school is legible *only* because
  the fish self-illuminate at that depth; at 26 m in daylight ours must read by albedo and silhouette
  instead. Copying `school-1` would mean giving shallow-water fish emissive flanks.
- Usable partials: **`school-1`** for school *geometry* alone — density, diagonal streaming, spacing,
  the way a shoal reads as a texture rather than as individuals. **`shallows-reef-1`** for the water
  and exposure envelope at a shallow daylight depth (it also contains small fish).
  **`shallows-floor-2`** for a distant shoal glinting in low light.

### `seamoth` — cam [10, -45, 90], pitch -6, tod 0.42

- **PRIMARY — `seamoth-1`.** Diver POV looking at a parked Seamoth over a reef in daylight, with the
  default orange-and-white hull. Depth caveat: ~15–25 m against our 45 m, so our water should be one
  band darker and greener than the plate; hull read, lamp behaviour and framing transfer directly.
  Dive-mask vignette and watermark: crop before measuring.
- **Alternate — `seamoth-2`** (12 m, full HUD, exterior) — but its hull is a **custom blue-and-green
  player paint job**, so it is not a hull-colour target.
- **REJECTED — `shallows-reef-2`** (a Seamoth exterior at 9 m, but at night in near-black water).

### `seamoth-cockpit` — cam [10, -45, 90], pitch -4, tod 0.42

- **PRIMARY — `seamoth-cockpit-1`.** Canonical cockpit geometry: canopy arch, two green holo consoles,
  depth ring with compass arc at top centre, hull/energy/temperature block at right.
- **Alternates — `seamoth-cockpit-2`** (145 m, same cockpit), **`creature-close-4`** (103 m, same
  cockpit with a creature in frame), **`wreck-3`** (same helm, promo).
- **Split the judgement.** All four plates sit at 100–145 m while our shot is at 45 m. The *cockpit* —
  geometry, holo-panel colour, HUD block placement, canopy occlusion — is fairly judged by any of them.
  The *water outside the canopy* is not: at 45 m it should be brighter and more cyan than in any of
  these. Score the two separately, with a crop for the water.

### `base-interior` — cam [-60, -30, -30], yaw 180, pitch 0, tod 0.42, `ui { pda: false, hud: true }`

- **PRIMARY — `base-interior-1`.** The only plate in the set showing a habitat interior *with water
  visible through the viewport* — white curved panels, a rounded window onto teal water and creepvine.
  That is precisely this shot's stated intent.
- **Alternates — `base-interior-4`** (14 m; use it for the interior-bright / exterior-dark ratio
  through a viewport), **`base-interior-2`** (15 m; interior palette plus the HUD this shot now
  requests).
- **REJECTED — `base-interior-3`** (a *surface* Multipurpose Room with a glass ceiling onto blue sky
  and heavy player decoration — no water, wrong depth, wrong exterior), **`deep-void-3`** (right
  framing, but 919 m: the exterior is black, which inverts the interior/exterior relationship this
  shot is testing).

### `hud` — cam [30, -20, 40], pitch -8, tod 0.42

- **PRIMARY — `seamoth-2`.** 12 m, daylight, underwater, carrying the complete modern survival HUD:
  depth ring and compass arc top centre, health/O2/food/water cluster bottom left, five quickslots
  bottom centre, resource-requirement chips top right. It is the only plate with both the right HUD and
  a correct underwater frame behind it.
- **Alternates — `hud-1`** for HUD *geometry* only (crisp, uncluttered, full widget set) and
  **`shallows-reef-1`** for the scene the HUD ought to be sitting over at this depth.
- **REJECTED as a whole-frame target — `hud-1`.** It is at 0 m **above** the water, facing the Neptune
  rocket against a blue sky: median 138.5, sat 0.368, R% 70. Nothing about its exposure, hue or fog can
  judge a -20 m underwater frame. **`hud-3` / `hud-4`** are PDA pages and this shot deliberately does
  not open the PDA. **`hud-2`** is a night camera-drone overlay — a different UI language entirely.

### `night-shallows` — cam [30, -14, 40], pitch -6, **tod 0.88 (night)**

- **PRIMARY — `shallows-reef-2`**, despite its filename. 9 m, night, shallows, near-black water with a
  lamp pool on the reef below, full HUD, `topBottom` 0.25 (dark above, lit below — exactly what a
  flashlight cone in shallow night water does). Depth, framing and lighting all match our 14 m night
  dive.
- **Alternates — `night-shallows-1`** for the useful negative result that even at night the water does
  not reach black (p0.1 = 21.3), **`hud-2`** for lamp-lit rock at 32 m at night.
- **REJECTED — `night-shallows-2`** (88 m, six times our depth; the base is a distant point cluster),
  **`night-shallows-3`** (deep or enclosed and base-floodlit, ultrawide).

---

## Coverage summary

| shot | primary | status |
|---|---|---|
| `surface-pod` | `surface-above-1` | verified |
| `surface-above` | `surface-above-2` | verified |
| `shallows-reef` | `shallows-reef-1` | verified |
| `shallows-floor` | `shallows-floor-1` | verified — caustics only; water from `shallows-reef-1` |
| `godrays` | — | **none** — no daylight up-look exists in the set |
| `kelp-forest` | `kelp-forest-1` | verified — biome override covers the depth gap |
| `dropoff` | — | **none** — both plates are night/unlit |
| `grand-reef` | `grand-reef-2` | verified — no black-level target available |
| `deep-void` | `deep-void-2` | verified |
| `wreck` | `wreck-1` | verified — early-access build: structure, not colour |
| `cave` | `cave-3` | verified — `cave-1` for the depth band only |
| `creature-close` | — | **none** — candidates sit at 110 m and ~15 m |
| `school` | — | **none** — the only plate is 345 m from inside a Cyclops |
| `seamoth` | `seamoth-1` | verified — our water should be one band darker than the plate |
| `seamoth-cockpit` | `seamoth-cockpit-1` | verified for the cockpit; water judged separately |
| `base-interior` | `base-interior-1` | verified |
| `hud` | `seamoth-2` | verified — `hud-1` for widget geometry only |
| `night-shallows` | `shallows-reef-2` | verified — cross-category |

58 plates audited. 14 of the 18 shots have a verified primary; 4 have none.
