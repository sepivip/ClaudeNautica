# The loop — standing instructions

**The loop does not stop.** It runs until the user says stop, or until a whole-game critic
cannot beat chance in a blind A/B against real Subnautica frames.

## The rule that was being broken

A round would finish, I would process the results, commit, and then *end the turn with a report*.
Nothing re-invoked me, so the loop stalled until the user asked "are you working?". Three times.

**Dispatch the next round BEFORE writing the user-facing summary.** The summary is the last thing
in the turn, never the thing that replaces the dispatch. If a round has just landed and no workflow
is running, a round is overdue.

## Each round

1. `node tools/verify.mjs` — if the build is broken, fixing it IS the round.
2. Read the critic results from the workflow journal.
3. Fix anything in `src/core/**` or `tools/**` the agents reported — they are forbidden from
   touching those, so core bugs only get fixed if I do it. Fifteen have come back this way.
4. Publish scores to the progress page, commit.
5. **Dispatch the next round from the queue below.**
6. Then, and only then, summarise for the user.

## Standing queue

Priority is by measured leverage, not by score. A piece with a low score but a cheap fix outranks a
hard one. The whole-game blind trial runs every third round; the last was round 7 (composite 43).

- **creatures 45** — leviathan has no readable surface (ablation ON/OFF indistinguishable);
  pure-black fin wedges at luminance 1/255; flank saturation 0.92 at R% 8 = no albedo, pure fog
  colour; jellyfish bells now clipped crazy-paving
- **movement 61** — uphill on a 34° slope decays 4.6 → 0.54 m/s, grounded 100% of frames
- **vehicles 62** — cockpit median luminance 29.0 vs references' 68.4/92.8, ~12% of lower third
  crushed to black; 539 draws, worst in battery; hull carries the water's hue (G/B 0.90)
- **watersurface 63** — bright signal is one connected web (7,964px component) vs reference's
  discrete flecks
- **postfx 52** — three-zone grade never leaves the mid band
- **terrain 50** — drop-off face laplacian at the empty-fog noise floor; near sand lattice
- **structures 62**, **flora 51**, **schooling 56**, **underwater 45**, **sky 48**, **biomes 58**,
  **base 55**, **tools 34** (lamp overcorrected 9.2× weak at 681m), **ui 66**, **audio 65**
- **survival 74** — PASSED. Remaining: 100m carries no signal on a full tank.

## Every third round

Full 18-shot battery + blind A/B + `play.mjs` on all six routes, judged as one product.
Composite history: 34 → 38 → 41 → 43.
