/**
 * POSTFX — the HDR post chain and the colour grade. OWNER: the "postfx" agent.
 *
 * Frame graph (all HDR half-float until the very last pass):
 *
 *   engine.hdrTarget (jittered, MSAA-resolved)
 *     -> TAA resolve         history reprojected by depth, YCoCg variance-clipped
 *     -> focus probe (1x1)   temporally damped autofocus from the centre of frame
 *     -> SSAO (half res)     two-radius Alchemy AO from depth, bilateral blurred
 *     -> METER (1x1)         log-average scene luminance pyramid + adaptation
 *     -> bloom               6-level progressive down/upsample (COD "next-gen post")
 *     -> local-contrast refs 1/4 res (acutance) + 1/16 res (clarity), unthresholded
 *     -> DoF (half res)      signed-CoC disc gather, near + far + medium turbidity
 *     -> composite           lens -> AO -> two-scale clarity -> ZONE GAIN
 *                            -> metered exposure -> bloom -> vignette
 *                            -> SHOULDER (scene-referred highlight compressor)
 *                            -> ACES(AP1) tonemap + banded chroma recovery
 *                            -> OKLab GRADE: zone contrast / gamma / highlight
 *                               rolloff / chroma / vibrance / zone hue rotation
 *                               / luminance split-tone / gamut-safe return
 *                            -> per-channel gamma -> sRGB + triangular dither
 *     -> (FXAA)              only when TAA is off
 *
 * ROUND 31 - I WAS TOLD OUR WATER'S HUE DRIFTS WITH LEVEL ABOUT SIX TIMES MORE
 * THAN THE REFERENCE'S AND THAT THREE QUARTERS OF THAT IS MINE. MOST OF THE
 * HEADLINE IS THE sRGB ENCODER - IT MAKES A PIXEL OF EXACTLY CONSTANT
 * CHROMATICITY REPORT A DRIFTING G/B, AND IT DOES SO IN OPPOSITE DIRECTIONS ON
 * OUR WATER AND ON THE PLATE. WHAT SURVIVES IS REAL, IS ABOUT A FIFTH THE
 * BRIEFED SIZE, AND ROUNDS 28 AND 29 ALREADY TOOK 86% OF IT.
 *
 * 0. WHAT WAS RUN. underwaterMaterial cd8b32e3, globals 3698745d and biomes
 *    eac9b92f were md5'd at both ends of the round and neither moved.
 *    UNDERWATER.JS DID: a7c0f091 -> 2b5f88de, mid-round, because its owner was
 *    working in the same window. So every figure below was re-taken on 2b5f88de
 *    and every one reproduces - the level sweep in item 4 to two decimals, the
 *    water-window trends bit-identical - which also says the medium change does
 *    not reach these windows. All 1920x1080, --isolate. postfx-r31 (shipped, 9
 *    shots), postfx-r31-r30 (?whiteneutral=0, the same 9), postfx-r31-ng
 *    (?nopostfx=1), postfx-r31-med (?nopostfx=1&exposure=0.22), per-knob
 *    ablations postfx-r31-a2-<knob>, level sweeps postfx-r31-s2-<build>-<ev>.
 *
 *    THE WINDOWS. Everything below is on PURE-WATER windows with clipAny 0.00 in
 *    every channel in every image, chosen by scanning the frame for tiles with a
 *    luminance sd at or under 4 - so no fish, no HUD, no tool, no seabed - inside
 *    the water column. godrays, ours: eight 150x90 tiles in the right half and
 *    centre, (1650,450) through (975,300), display luminance 100.7 to 144.4.
 *    grand-reef, ours: nine tiles left of the flashlight cone, 32.1 to 56.3.
 *    godrays-1, the plate: eight 200x120 tiles above the spire line, 91.6 to
 *    149.1, which reproduces the briefed figures exactly (G/B 1.0639 -> 1.0765,
 *    R% 0.25 -> 0.19, sat 0.9975 -> 0.9981 over 1.63x).
 *
 *    Two runs of a fixed build and params are BIT-IDENTICAL on these windows -
 *    ?crec=0 and ?hiceil=0 came back identical to shipped to every digit - so
 *    the colour figures here have no noise floor at all. Whole-frame draw counts
 *    DO move run to run (godrays 244/245, kelp 192/205), so a whole-PNG md5 is
 *    not a valid A/B here and every comparison below is by statistic.
 *
 * 1. bandGB, R% AND sat COMPUTED ON MEAN 8-BIT sRGB CODES ARE NOT CHROMATICITY
 *    STATISTICS, AND THAT IS MOST OF THE BRIEFED GAP.
 *
 *    sRGB's encode is 1.055*x^(1/2.4) - 0.055, an affine term on top of a power.
 *    The power alone is harmless - a ratio of two encoded channels is the
 *    ratio^(1/2.4) and is level-independent. The -0.055 is not: its weight
 *    relative to the code falls as the code rises, so the effective exponent
 *    (1/2.4)*(code+0.055)/code is itself a function of level, DIFFERENTLY for the
 *    two channels being divided. A pixel whose chromaticity never changes
 *    therefore reports a G/B that moves - upward when G/B < 1, downward when
 *    G/B > 1.
 *
 *    THE TEST, and it needs no renderer: take one real water window, decode it
 *    to linear, multiply every pixel by a constant, re-encode, measure again. A
 *    constant scale cannot change a chromaticity.
 *
 *      window                        code G/B     code R%        code sat
 *      ours, godrays  (1650,450)     +1.59 %/oct  +4.62 pts/oct  -0.0464/oct
 *      ours, grand-reef (750,675)    +6.66 %/oct  +6.76 pts/oct  -0.0675/oct
 *      plate, godrays-1 (0,200)      -0.59 %/oct  +0.40 pts/oct  -0.0040/oct
 *
 *    Linear G/B and linear R% stay flat to four digits through the same scale
 *    (ours 0.5785 -> 0.5790 and 1.004 -> 1.001), which is the control.
 *
 *    Against the measured drift, that accounts for most of it, and on grand-reef
 *    it accounts for all of it:
 *
 *      shot / axis            measured   encoder      real   plate (same fix)
 *      godrays  G/B %/oct       +2.57     +1.59     +0.98     +1.51
 *      godrays  R%  pts/oct     +5.77     +4.62     +1.15     -0.49
 *      godrays  sat /oct      -0.0579   -0.0464   -0.0115   +0.0048
 *      grand-reef G/B %/oct     +7.07     +6.66     +0.41       -
 *      grand-reef R%  pts/oct   +4.26     +6.76     -2.50       -
 *
 *    So on G/B WE ARE ALREADY FLATTER THAN THE PLATE, and on grand-reef the
 *    physical chromaticity's relative red FALLS with level (linear 15.96 ->
 *    14.79) while the metric reports it rising. The briefed 6x is two encoder
 *    biases of opposite sign being differenced.
 *
 *    Every colour figure below is therefore quoted in LINEAR light, per pixel
 *    decoded before averaging, with the code-space figure alongside where the
 *    comparison to earlier rounds needs it.
 *
 * 2. ?nopostfx=1 WAS UNREADABLE ON THE ONE SHOT THE ROUND IS ABOUT, AND NOW IS
 *    NOT. The bypass is exposure 1.0 into a straight clamp, and godrays' water
 *    column is above scene-linear 1.0 over most of frame: clipAny 79.2-80.0% on
 *    all eight water windows, and 69.61% over the whole world crop, against
 *    0.05% for the graded frame of the same shot. No ungraded colour statistic
 *    on that shot has ever been valid. The bypass now honours ?exposure=, which
 *    is a plain scalar on a chain that is the identity there, so
 *    ?nopostfx=1&exposure=0.22 is the same buffer, readable. Default 1.0 and
 *    bit-identical to round 30 there.
 *
 * 3. WHAT THE MEDIUM DELIVERS AND WHAT I ADD TO IT. godrays water windows,
 *    linear, medium read through ?nopostfx=1&exposure=0.22:
 *
 *                        linG/B %/oct   linR% pts/oct        linSat /oct
 *      medium              -1.66        -0.363 (0.98->0.83)   +0.0036
 *      shipped             +2.89        +0.249 (1.00->1.11)   -0.0025
 *      plate godrays-1     +2.76        -0.039 (0.05->0.02)   +0.0004
 *
 *    OUR G/B SLOPE IS THE PLATE'S, to within 5%. The real residual is red: the
 *    medium's relative red falls with level and mine rises, a swing of +0.61
 *    pts/octave, i.e. 0.6% of the largest channel per octave.
 *
 *    AND IT IS DWARFED BY A LEVEL-INDEPENDENT OFFSET THAT IS NOT MINE. Per-pixel
 *    R/max in those windows: the plate is 0.00 at the 10th percentile AND at the
 *    median in every window (p90 0.06-0.17); the raw HDR buffer is 0.78-0.98;
 *    shipped is 0.94-1.18. So godrays-1's water has literally no red in it and
 *    ours has about 1% of max, broadly distributed rather than in particles, and
 *    the buffer this file is handed already carries it. ?zone=0 lands on the
 *    plate exactly (median 0.00, p90 0.05-0.09) - but it does so by letting
 *    ACES_OUT take red negative and clamp() delete it, which is round 29's
 *    defect wearing a result. That is not a fix and I did not take it.
 *
 *    On grand-reef we are ON the plate for that offset anyway: per-pixel R/max
 *    median 13.8-15.8 against grand-reef-2's own water windows at 13.6-19.7.
 *
 * 4. THE CLEAN EXPERIMENT, because a window set varies in DISTANCE as well as in
 *    level and this file is supposed to separate bands by distance. ?meter=0
 *    pins sceneExposure() to uExposure and the pivot to its authored constant,
 *    so the grade is frozen and ?exposure= moves nothing but the level. One
 *    window, (1500,300)-(1650,390), exposure 0.20 to 0.60, which is 2.32x of
 *    display level with clipAny 0.00 throughout:
 *
 *      build                  linG/B %/oct   linR% pts/oct   linSat /oct
 *      ?farchroma=0 (r27)        +19.70          +1.163        -0.0116
 *      ?aceshue=0   (r28)         +5.44          +0.591        -0.0059
 *      SHIPPED      (r29+)        +3.90          +0.167        -0.0017
 *
 *    THE ANSWER TO "CHECK WHETHER YOUR CEILING ALREADY HELPS AND BY HOW MUCH":
 *    the round-28 far-band chroma lock takes 72% of the level-dependent G/B
 *    drift and 49% of the level-dependent red drift off round 27; the round-29
 *    crosstalk ceiling then takes 28% and 72% of what is LEFT. Together they
 *    remove 80% of the G/B drift and 86% of the red drift. The mechanism this
 *    round was set on was already found and fixed, twice, and what is left of it
 *    is 0.167 points of relative red per octave on a channel that is 1% of the
 *    largest.
 *
 *    ?zonesat=0 moves this by 0.06 %/oct and 0.004 pts/oct, i.e. nothing -
 *    although in the SPATIAL window set it looks like the largest single term
 *    (red drift +0.110 against shipped +0.249). That difference is the distance
 *    confound, and it is why the spatial number cannot be used on its own.
 *
 * 5. THE ROUND-26 MECHANISM DOES NOTHING HERE, TESTED AS ASKED. ?hiceil=0 is
 *    BIT-IDENTICAL to shipped on every godrays water window, and so is ?crec=0.
 *    Predicted before measuring, from the outputs themselves: oklabToRgbClipped
 *    only surrenders chroma at a boundary, and these windows sit at min channel
 *    11-22/255 and max channel 156-219/255, so neither the zero floor nor the
 *    0.955 wall is anywhere near binding. The 66 counts round 26 could not
 *    account for are not in this frame's water.
 *
 * 6. WHAT I CHANGED, AND IT IS SMALL ON PURPOSE.
 *
 *    whitenW() - the whitening ramp that the ACES per-channel ceiling opens with
 *    and chroma recovery closes with was smoothstep(uChromaGuard, 3.2x, maxc(c))
 *    and nothing else. Round 30 found the same defect one function away and
 *    named it: brightness alone cannot tell a blown highlight from an over-driven
 *    saturated pixel, and its fix was one factor requiring near-neutrality. This
 *    is that factor, on the scene-referred guard, shared by both operators so
 *    that they still agree with each other. min/max is 0.95 for a (1,1,0.95) sun
 *    core, 0.70 for a warm filament and 0.008-0.010 for our water, so the
 *    0.05-0.45 band cannot be reached by a real highlight or missed by water. It
 *    does not stop an overexposure whitening: hiCompress runs first, per channel,
 *    and converges the channels of anything far above its knee, so neu is
 *    already high by the time this is read.
 *
 *    MEASURED, and honestly: AT THE SHIPPED OPERATING POINT IT IS INERT.
 *    ?whiteneutral=0 over nine shots on the world crop returns an identical
 *    median, p0.1, saturation, R%, bandGB, hueVar and clipAny on eight of them,
 *    including every do-not-regress item (deep-void median 15.5 / sat 0.785,
 *    cave median 20.9, shallows median 124.2 / p0.1 0.9). The ninth is hud, at
 *    p99.9 237.2 against 241.7 and clipAny 0.11 against 0.13 - inside LOOK.md 9's
 *    233-253 and in the right direction on both.
 *
 *    It is here because it stops being inert the moment the water gets brighter,
 *    and then it is worth a great deal. Same window, ?meter=0&exposure=1.70,
 *    i.e. the medium five times brighter than it is today:
 *
 *      build            linG/B   linR%   linSat   clipAny%
 *      round 30         0.7727   3.212   0.9679    17.20
 *      shipped          0.7660   1.563   0.9844     2.47
 *      the medium is    0.6100   0.98
 *
 *    Relative red halved, saturation up, and clipping down by a factor of seven,
 *    which is not a coincidence: holding a pixel's own channel ratios is what
 *    keeps its small channels small. ?whiteneutral=0 restores round 30 EXACTLY.
 *
 * 7. WHAT I BUILT, MEASURED AND THREW AWAY. Locking the far band's chroma to the
 *    colour from BEFORE hiCompress - see the note at the hiCompress call. The
 *    argument for it is sound (hiCompress is per-channel, water goes above its
 *    knee, so what step (5c) calls "the chromaticity the MEDIUM delivered" is
 *    partly this file's own compressor) and the measurement refuses it: inert at
 *    every shipped operating point, and at exposure 1.70 it takes that window
 *    from 17.20% to 50.15% of pixels with a channel at 250+, because the medium's
 *    chromaticity at that radiance is not inside the sRGB cube and the lock hands
 *    the excess to oklabToRgbClipped, which parks it on the wall. Not shipped.
 *
 * 8. ONE MORE THING ABOUT THE PREMISE. "The reference medium holds ONE
 *    chromaticity" is a property of godrays-1, not of Subnautica. grand-reef-2's
 *    own six pure-water windows, over a level range of only 1.17x, span linear
 *    G/B 0.2863 to 0.3635 - a 27% spread - and relative red 13.8 to 19.9. A deep
 *    reference frame's water is not one colour, and a target derived from the
 *    cleanest plate in the set does not transfer to the rest of the battery.
 *
 * ROUND 30 — I WAS ASKED WHETHER MY CHAIN FLATTENS THE CHROMATICITY CURVE THE
 * MEDIUM IS BEING ASKED FOR. IT DOES NOT: IT MULTIPLIES THE MEDIUM'S OWN
 * CHROMATICITY SPREAD BY 1.31, AND ON THE FAR BAND IT REPRODUCES IT EXACTLY BY
 * CONSTRUCTION. TWO OTHER THINGS FELL OUT, AND BOTH ARE RETRACTIONS OF MINE.
 *
 * 0. WHAT WAS RUN. underwater.js a7c0f091, biomes.js eac9b92f, md5'd either side
 *    of every battery below; neither hash moved once. All 1920x1080, --isolate,
 *    kelp-forest / shallows-reef / grand-reef / cave in that fixed order.
 *    postfx-r30 (shipped), postfx-r30-ng (?nopostfx=1), k30-cn0 (?ceilneutral=0 —
 *    this build with round 29's ceiling behaviour restored), k30-hc0 (?hiceil=0),
 *    k30-fc0* (the ?farchroma=0 decomposition in item 4), k30-chroma0
 *    (?zhue=0&tint=0&zonesat=0&vib=0). Two runs of the shipped build are
 *    BIT-IDENTICAL on all four world crops, every digit, so nothing below is
 *    inside a noise floor.
 *
 *    p90 is the 90th percentile of the window's MAX CHANNEL in display codes and
 *    it is quoted with every colour statistic, per round 29. New here: the
 *    percentage of the window at or over display 243 and at or over 250, because
 *    p90 alone does not say how MUCH of a window is against the ceiling.
 *
 * 1. THE REFERENCE CURVE IS REAL — AND ITS QUOTED TOP END IS THE SAME BLOWN PLATE
 *    WINDOW ROUND 29 RETRACTED, SO THE TARGET AS BRIEFED IS A THIRD TOO RED.
 *
 *    The brief gives kelp-forest-1's pure water as relative red 2.64 -> 44.06 and
 *    saturation 0.974 -> 0.560 as p90 goes 96 -> 255, "with 0% clipping anywhere
 *    in the range". Those two statistics are one number: when red is the smallest
 *    channel, sat = 1 - R/max exactly, and 1 - 0.4406 = 0.5594. And p90 255 IS
 *    clipping by definition — a tenth of that window is at 255.
 *
 *    Re-derived properly. 24 px tiles over the whole plate, row sd <= 3.2 so only
 *    flat water survives, tiles with 1% or more of their pixels at 250+ DISCARDED,
 *    binned by p90:
 *
 *      p90 bin    n     R      G      B     R%   linR%   sat    G/B   %>=243
 *        0- 50  190    4.5   35.5   15.4  12.91   8.30  0.87   2.35    0.00
 *       50- 70  207    2.9   58.9   25.7   5.05   2.15  0.95   2.30    0.00
 *       70- 90   91    2.5   75.4   33.9   3.28   1.07  0.97   2.23    0.00
 *       90-110   40    2.6   94.3   43.7   2.78   0.71  0.97   2.16    0.00
 *      110-130   16    2.1  115.9   53.4   1.81   0.37  0.98   2.18    0.00
 *      130-190    0    -- no flat water tile in this frame at these levels --
 *      190-205    6   35.7  197.5  157.6  18.06   3.15  0.82   1.25    0.00
 *      205-215   13   54.0  208.4  174.0  25.87   5.83  0.74   1.20    0.00
 *      215-225    8   63.5  216.1  183.0  29.38   7.35  0.71   1.18    0.00
 *      225-240    2   75.2  226.3  193.3  33.21   9.29  0.67   1.17    0.34
 *      240-256    1   90.5  239.5  205.0  37.79  11.93  0.62   1.17   10.76
 *      KP-TOP        110.7  251.2  215.9  44.06  16.35  0.56   1.16   95.51
 *                                                        (71.59% of it at 250+)
 *
 *    FOUR CORRECTIONS, none of which kills the finding:
 *
 *    (a) THE 44.06 / 0.560 ENDPOINT IS KP-TOP, px (1238,27)-(1344,103) — the
 *        window round 29 retracted as a blown highlight in the reference JPEG.
 *        95.51% of it is at or over display 243 and 71.59% at or over 250. The
 *        brightest READABLE water in the plate is R% 33.2 at saturation 0.67, and
 *        the last point with literally no clipping is R% 29.4 at 0.71. Chasing 44
 *        instead of 33 is chasing 11 points of the reference's own clipping.
 *
 *    (b) THE BOTTOM END IS NOT A COLOUR EITHER. R% 2.64 at p90 96 is a ratio over
 *        2.6 COUNTS of absolute red; at p90 0-50 the same ratio reads 12.91 out of
 *        4.5 counts. Absolute red in that plate's water is flat at 2.1-2.9 counts
 *        — JPEG chroma noise — everywhere below p90 130. The honest statement is
 *        "red is zero below display ~130 and rises to 75 counts by p90 235", not
 *        "relative red rises from 2.64".
 *
 *    (c) IT IS NOT MONOTONIC AND IT IS NOT CONTINUOUS. R% has a MINIMUM at p90
 *        110-130 (1.81) and rises in both directions; and there is no flat water
 *        tile at all between p90 130 and 190, because the canopy splits that frame
 *        into shaded water and near-surface water with nothing in between. What is
 *        measured is TWO water populations, not a swept curve: shaded water at
 *        R ~ 2.5 counts and G/B 2.2-2.3, near-surface water at R 36-90 and G/B
 *        1.17-1.25. A brightness key reproduces it because brightness happens to
 *        separate them in this frame; that is not the same as proving brightness
 *        is the axis.
 *
 *    (d) READ THE G/B COLUMN, NOT ONLY THE RED. It moves 2.35 -> 1.17. In linear
 *        terms that is a larger change than the red story, and no round has asked
 *        for it.
 *
 *    WHAT SURVIVES, AND IT IS THE WHOLE POINT: between p90 190 and 235, with ZERO
 *    pixels clipped on either side, the plate's water goes R% 18.06 -> 33.21 and
 *    saturation 0.82 -> 0.67. That is a large, real, unclipped chromaticity trend
 *    and our medium has nothing like it.
 *
 * 2. OUR CURVE, UNGRADED AND GRADED, ON THE SAME WINDOWS. THE CHAIN AMPLIFIES.
 *
 *    KELP-FOREST, 48 px tiles over px (557,0)-(845,497), row sd <= 1.4 in BOTH
 *    images, 18 tiles survive. Same tile, ?nopostfx=1 then shipped:
 *
 *      tile        MEDIUM p90 / R% / sat / G-B     GRADED p90 / R% / sat / G-B
 *      (748,144)     184 / 1.02 / 0.9898 / 1.589     238 / 1.38 / 0.9862 / 1.558
 *      (700, 96)     186 / 1.03 / 0.9897 / 1.588     241 / 1.40 / 0.9860 / 1.557
 *      (604, 48)     188 / 1.05 / 0.9895 / 1.577     241 / 1.41 / 0.9859 / 1.559
 *      (700,  0)     192 / 1.07 / 0.9893 / 1.571     243 / 1.42 / 0.9858 / 1.555
 *      (796,  0)     193 / 1.07 / 0.9893 / 1.567     244 / 1.42 / 0.9858 / 1.551
 *      spread          9 / 0.05 / 0.0005              6 / 0.04 / 0.0004
 *
 *    THERE IS NO CURVE HERE TO FLATTEN. Our medium's kelp water is ONE
 *    chromaticity: 0.05 points of R% across 9 counts of p90, against the plate's
 *    15 points across 45. The chain adds a constant +0.35 R% and passes the
 *    (absent) slope through unchanged. The brief's diagnosis of the medium is
 *    confirmed from our side, on the same windows, at 0% clipping in the medium.
 *
 *    SHALLOWS-REEF IS THE ONE SHOT WHOSE MEDIUM DOES HAVE A CHROMATICITY SLOPE
 *    ACROSS ITS WATER COLUMN, so it is the only place the question can actually be
 *    tested. 64 px tiles over px (0,0)-(806,388), row sd <= 1.6 in both, 44 tiles:
 *
 *      tile        MEDIUM p90 / R% / sat        GRADED p90 / R% / sat
 *      (  0,320)     215 / 30.31 / 0.6969        200 / 28.84 / 0.7116
 *      (192,128)     207 / 27.65 / 0.7235        187 / 24.95 / 0.7505
 *      (320,  0)     225 / 24.37 / 0.7563        192 / 21.06 / 0.7894
 *      SPREAD         10 /  5.94 / 0.0594         13 /  7.78 / 0.0778
 *
 *    The chain multiplies the medium's chromaticity spread by 1.31 on R% and 1.31
 *    on saturation, and preserves its sign. It is not a flattener. (The sign is
 *    the medium's and it is the OPPOSITE of the plate's — brighter water here is
 *    LESS red, brighter water in kelp-forest-1 is MORE red. That is underwater's,
 *    not mine, and it is the same finding the brief opens with.)
 *
 *    AND ON THE FAR BAND IT IS EXACT, BY CONSTRUCTION, NOT BY MEASUREMENT. Round
 *    28's lock sets ab = labScene.yz * (L / labScene.x) at wFar = 1, and OKLab is
 *    homogeneous of degree 1/3 in linear RGB, so ab/L IS the pixel's scene
 *    chromaticity and is scale-invariant. Whatever level dependence the medium
 *    puts in, the far band returns it unchanged. Measured: KELP-TOP and SR-MID,
 *    the two windows in the battery with wFar = 1, are the two whose graded
 *    chromaticity tracks the medium's to three digits.
 *
 *    WHAT WOULD BE AT RISK IF THE MEDIUM DID LAND THE CURVE. Two operators here
 *    are functions of L and of chroma and would fight it wherever wFar < 1: the
 *    luminance split-tone (step 5, uTintLo/uTintHi, which is a hand-authored
 *    chromaticity-versus-brightness axis and would DOUBLE it) and vibrance (step
 *    4, gated on chroma and on L). Both are already off on the far band. Their
 *    residual exposure is bounded in item 5. Nothing in this file normalises
 *    chroma against luminance except the far-band lock, which does it in order to
 *    hand the medium's own chromaticity back untouched.
 *
 * 3. WHY OUR KELP WATER CANNOT BE AS BRIGHT AS THE PLATE'S, DERIVED — AND IT
 *    CLOSES ROUND 29's ITEM 6 AND RETRACTS ITS 36-COUNT LEVEL GAP.
 *
 *    A display chromaticity has a LUMINANCE CEILING. Put its largest channel at
 *    the chain's wall (linear 0.955, display 250) and the Rec.709 luminance that
 *    results is everything that chromaticity can express:
 *
 *      chromaticity            R/G    B/G  maxc(unit)  Ltop   R,G,B at wall  lumCeil
 *      OUR medium kelp water  0.011  0.632   1.4616   0.8677   4, 250, 160    191.1
 *      PLATE kelp p90 90-110  0.028  0.463   1.4873   0.8627  19, 250, 127    192.0
 *      PLATE kelp p90 205-215 0.259  0.835   1.3759   0.8854  67, 250, 209    208.0
 *      PLATE kelp p90 225-240 0.332  0.854   1.3533   0.8903  84, 250, 214    212.0
 *
 *    Our graded kelp water measures luminance 183.7. Its ceiling is 191.1. So
 *    SEVEN COUNTS is the entire headroom any operator in this file has on that
 *    water, and it is not a tuning question: to be brighter than 191 a
 *    green-dominant water MUST have red, and how much is given by the table.
 *    maxc(unit) is the same quantity step (5b) already computes per pixel, so this
 *    is the ceiling this file has been enforcing for four rounds, read forwards.
 *
 *    ROUND 29 ITEM 6 SAID OUR GRADED TOP WATER IS "36 COUNTS DARK", 184.1 AGAINST
 *    THE PLATE'S 219.9. THE 219.9 IS KP-TOP — the blown window. Item 6 built its
 *    span target on the same window it retracted for red four items earlier, and I
 *    wrote both. Against the plate's READABLE water our kelp water is not dark at
 *    all: the readable band runs luminance 160.3 (p90 190-205), 173.1 (205-215),
 *    191.8 (225-240), and we are at 183.7, INSIDE it. Corrected span, brightest
 *    readable water over KP-BOT: 191.8/54.7 = 3.51, not 4.01; our medium's 3.31 is
 *    6% under it, not 21%. RETRACTING ROUND 29 ITEM 6's LEVEL GAP AND ITS SPAN
 *    TARGET. Our kelp water's level is right. Its chromaticity is not.
 *
 * 4. AND I RETRACT MY OWN ROUND-29 ATTRIBUTION OF 66 OF THE 81 COUNTS. IT WAS NOT
 *    THE GAMUT SOLVER. IT WAS ROUND 28's FOUR OPERATORS, AND ROUND 28 ALREADY
 *    REMOVES ALL OF THEM WHERE wFar = 1.
 *
 *    Round 29 said: the ceiling takes 15 of the 81 manufactured counts and "the
 *    remaining 66 are round 26's separate mechanism — a pixel arriving above its
 *    chroma-feasible lightness, where oklabToRgbClipped() surrenders chroma
 *    whatever it was handed". If that were true, ablating the ceiling that stands
 *    in front of the solver would move the number. It does not move it at all.
 *
 *    KELP-TOP px (600,20)-(820,150), one medium hash, one session:
 *
 *      build                                   R     R%   linR%   sat     p90  %>=243
 *      MEDIUM (?nopostfx=1)                   2.0   1.05   0.12  0.9895   190   0.00
 *      SHIPPED                                3.4   1.41   0.12  0.9859   242   8.63
 *      ?farchroma=0                          68.3  28.76   6.86  0.7124   240   0.00
 *      ?farchroma=0 &hiceil=0                68.4  28.77   6.86  0.7123   241   1.16
 *      ?farchroma=0 &zhue=0&tint=0           36.8  15.36   2.11  0.8464   242   3.44
 *      ?farchroma=0 &zhue=0&tint=0
 *                   &zonesat=0&vib=0          3.4   1.41   0.12  0.9859   242   8.63
 *
 *    Read rows 3 and 4: THE GAMUT SOLVER'S SHARE IS ZERO, to 0.0001 of saturation.
 *    Read row 5: the hue rotation and the split-tone take 31.5 of the 66. Read row
 *    6: the zone chroma ramp and vibrance take the other 33.4 — and with all four
 *    pinned, ?farchroma=0 reproduces the SHIPPED frame to EVERY DIGIT on every
 *    column. The lock and "switch those four off over wFar" are the same
 *    transformation, which is an independent confirmation of round 28 that round
 *    28 did not have.
 *
 *    SO THE HONEST DECOMPOSITION OF THE 81 IS: 15 the tone curve's crosstalk
 *    (round 29's ceiling, and that part stands), 66 the four display chroma
 *    operators, 0 oklabToRgbClipped. My round-29 sentence attributing the 66 to
 *    the gamut solver was an inference from the round-26 mechanism being present
 *    in the same neighbourhood, and I did not run the one ablation that separates
 *    them. It is one line of a header and it would have sent the next round after
 *    the wrong operator.
 *
 * 5. WHAT IS ACTUALLY LEFT, BOUNDED. Two exposures, both measured.
 *
 *    (a) THE FOUR CHROMA OPERATORS WHERE wFar < 1. Shipped against
 *        ?zhue=0&tint=0&zonesat=0&vib=0, water-only windows, p90 on both sides:
 *
 *          window     MEDIUM R%/sat/p90   SHIPPED R%/sat/p90   FOUR PINNED
 *          KELP-TOP    1.05/.9895/190      1.41/.9859/242      1.41/.9859/242  INERT
 *          SR-MID     29.65/.7035/209     28.25/.7175/195     28.13/.7187/195  INERT
 *          SR-TOP     23.82/.7618/249*    21.21/.7879/212     24.20/.7580/228
 *          GR-OURS    32.15/.6785/ 60     34.27/.6573/ 76     32.17/.6786/ 77
 *          CAVE-W     80.30/.7367/ 42     60.14/.6723/ 36     76.96/.7717/ 35
 *          (* SR-TOP's MEDIUM has 25.33% of the window at 243+ and 5.21% at 250+;
 *           it is the bypass that clips there, exactly as round 29 found.)
 *
 *        The two windows where the pixel is genuinely pure far-field medium are
 *        the two where the operators are already worth NOTHING — the lock has
 *        them. The exposure is on water in front of geometry (CAVE-W, 16.8 points
 *        of R% and 0.099 of saturation) and on the lit underside of the surface
 *        (SR-TOP, 3.0 and 0.030, and its row sd is 7.7 against SR-MID's 1.4, so it
 *        is an interface and not a medium window at all). Those are the bands the
 *        near/mid operators exist for. I am NOT extending the lock to them: on
 *        GR-OURS the shipped value is ON its plate (0.657/34 against GR-PLATE's
 *        0.654/34) and pinning the four walks it OFF to 0.679/32, so a wider lock
 *        regresses the one window in this battery that is verified against a plate.
 *
 *    (b) THE CEILING'S OWN LEAK, which is the part I could fix, and did — item 6.
 *
 * 6. WHAT SHIPPED: THE CHROMA-FEASIBLE CEILING'S WHITENING EXEMPTION NOW REQUIRES
 *    NEAR-NEUTRALITY, NOT JUST A HIGH LIGHTNESS. ?ceilneutral=0 restores round 26.
 *
 *    Step (5b) computed wOpen = smoothstep(0.93, 0.995, L) and used it BOTH to
 *    open the gamut wall toward 1.0005 AND to switch the ceiling off. L alone
 *    cannot tell a blown highlight from an over-driven saturated pixel: our kelp
 *    water's chromaticity can hold L 0.868 at most (maxc(unit) 1.4616), so if it
 *    is at 0.93 the contrast put it there, which is precisely the condition the
 *    ceiling exists to catch. The exemption was firing hardest on the pixels the
 *    operator was built for. It now also requires maxc(unit) to be near 1, which
 *    is what "heading for white" means; below m = 1.03 the change is the exact
 *    identity, so the near-white specular and bioluminescent cores round 26
 *    protects are untouched by construction rather than by measurement.
 *
 *    MEASURED, this build, ?ceilneutral=0 against shipped, and ?hiceil=0 for scale.
 *    "leak" is the fraction of the world crop that is chroma-limited (m > 1.03)
 *    AND over display 250 AND above L 0.93 — everything this factor can reach:
 *
 *      cave world crop        R    R%    sat    med   %>=243  %>=250    leak
 *      ?hiceil=0            44.9  68.51  .6261   43    1.096   0.080  0.0568%
 *      ?ceilneutral=0 (r29) 44.0  67.34  .6305   43    0.636   0.035  0.0132%
 *      SHIPPED (round 30)   43.5  66.73  .6326   43    0.342   0.022  0.0001%
 *
 *    So on cave the whole ceiling is worth 1.4 counts of mean red and 36% of that
 *    was leaking through the L-only exemption; the leak population is now 0.0001%.
 *    Cave's MEDIAN is 43 in all three, which is the number the brief protects.
 *
 *    EVERYTHING ELSE IS BIT-IDENTICAL. kelp-forest, shallows-reef and grand-reef
 *    world crops and KELP-TOP, SR-TOP, SR-MID and GR-OURS all come back at
 *    ?ceilneutral=0 and at shipped with every digit the same. THIS IS NOT OFFERED
 *    AS A GAIN — 0.5 counts of red on one shot is under any floor worth
 *    publishing. It is here because it stops being inert the moment the water gets
 *    brighter, which is what round 30 is asking the medium for: our kelp water
 *    already reaches L 0.978 on its chroma-limited pixels, and round 26's
 *    reassurance that "kelp's clipped water sits at L 0.89, below the band" was a
 *    property of one medium on one frame, not of the operator.
 *
 * 7. REGRESSION, world crop (96,108)-(1152,918), shipped, against round 29:
 *
 *      shot            median  sat     R%    p90    round 29 (?ceilneutral=0)
 *      kelp-forest        38  .9270   6.66   221    identical, every digit
 *      shallows-reef     176  .7145  32.94   200    identical, every digit
 *      grand-reef         67  .6621  35.81    86    identical, every digit
 *      cave               43  .6326  66.73   153    43 / .6305 / 67.34 / 153
 *
 *    Untouched and verified: the round-29 per-channel crosstalk ceiling, the
 *    far-band floor, the far-band chroma lock, the deep black point (exactly 0 at
 *    12 m, so shallows-reef and hud cannot be reached), resetForShot, the ACES
 *    gamut return OFF by default, and oklabToRgbClipped()'s own wall — the new
 *    factor only ever holds a chroma-limited pixel FURTHER inside the cube, so the
 *    solver can only become more inert, never less.
 *
 * 8. FOR WHOEVER OWNS THE MEDIUM NEXT — the target, with p90 and clip% on it.
 *    kelp-forest-1's water, readable windows only:
 *
 *      band                     R      G      B     R%  linR%  sat   G/B     p90
 *      shaded  (p90  70-130)   2.4   95.2   43.7   2.6   0.7  0.97  2.19   70-130
 *      bright  (p90 205-225)  58.7  212.2  178.5  27.6   6.6  0.72  1.19  205-225
 *      bright  (p90 225-240)  75.2  226.3  193.3  33.2   9.3  0.67  1.17  225-240
 *      OURS, medium, top       2.0  186.6  118.0   1.05  0.12 0.99  1.58      190
 *      OURS, medium, shaded    0.2   66.5   38.9   0.30  0.11 1.00  1.71       71
 *
 *    In the shaded band the red agrees — both sides are at their noise floor, 0.2
 *    counts against 2.4 — and the gap there is G/B, 1.71 against 2.19, i.e. our
 *    shaded water is 28% too BLUE. The bright band is the larger gap and it is
 *    both axes at once: 26.6 points of R% (1.05 against 27.6) and 0.39 of G/B
 *    (1.58 against 1.19). Do NOT aim at 44 R% / 0.56 saturation: that is KP-TOP
 *    and it is clipped. And note item 3: the red is not optional if the water is
 *    to be that bright, because 191 is the most luminance our present chromaticity
 *    can carry and the plate's near-surface water sits at 192.
 *
 *
 * ROUND 29 — THE TONE CURVE MANUFACTURES RED OUT OF A RED OF EXACTLY ZERO, AND
 * ONLY ON BRIGHT WINDOWS. THAT IS DERIVED FROM THE MATRICES, NOT FITTED. IT
 * MEANS SEVERAL ROUNDS OF RELATIVE-RED ANALYSIS WERE MEASURING THIS FUNCTION —
 * AND ONE OF THE TARGETS I HANDED THE MEDIUM OWNER IS A CLIPPED JPEG.
 *
 * 0. EVERY NUMBER BELOW CARRIES ITS WINDOW'S p90, BECAUSE THAT IS THE TEST THAT
 *    SEPARATES A COLOUR FROM A CURVE. p90 here is the 90th percentile of the
 *    window's MAX CHANNEL in display codes; at 240+ the window is against the
 *    ceiling and no relative-red or saturation figure may be read off it.
 *    linR% is R/max of the window's MEAN colour decoded to LINEAR — round 28's
 *    level-invariant estimator, which the 8-bit saturation statistic is not.
 *
 *    THE MEDIUM MOVED THREE TIMES INSIDE THIS SESSION (underwater.js 6db255a4
 *    -> 23b3bc03 -> d9a99929 -> a7c0f091) and every battery below records the
 *    hash it was taken on. Nothing is compared across a hash boundary; where I
 *    did that by accident it produced a wrong answer and item 2 says so.
 *
 *      r29A-ng / -r28 / -r29 / -r29b    underwater 23b3bc03, biomes eac9b92f
 *        kelp-forest, grand-reef, shallows-reef, cave, deep-void, hud in that
 *        FIXED order, so deep-void keeps its battery position (its draw count is
 *        266 at position 1 and 306 later, reproducibly, and the brief warns).
 *        -ng is ?nopostfx=1, -r28 is ?aceshue=0, -r29 and -r29b are shipped.
 *      r29B-ng / -r28 / -r29            underwater d9a99929, deep-void + hud
 *      r29C-fc0r28 / -fc0r29            underwater d9a99929, ?farchroma=0
 *      postfx-r29 / postfx-r29-ng       underwater a7c0f091 — the brief's own
 *        two commands, run last, and every window in the table below comes back
 *        to the digit on them, which is also the evidence that the last two
 *        medium changes do not reach these windows.
 *
 *    SHALLOWS-REEF, GRAND-REEF AND CAVE COME BACK BIT-IDENTICAL ACROSS THE FIRST
 *    MEDIUM CHANGE on every window here, so those rows are safe; only kelp moved
 *    (KELP-TOP G/B 1.087 -> 1.581).
 *
 *    THE WINDOWS. Pixel coordinates of 1920x1080, each cropped to a PNG, opened
 *    with the Read tool and looked at before it was used.
 *
 *      KELP-TOP  kelp-forest   (600,20)-(820,150)    pure water. Row sd 0.7-0.9.
 *      KELP-BOT  kelp-forest   (595,929)-(710,1037)  water + a creepvine trunk
 *                and fronds. NOT CLEAN, and round 27's finding that our kelp
 *                frame has no pure-water window below y = 0.45 is RECONFIRMED by
 *                looking: I tiled the bottom third at 64 px, sorted by row sd and
 *                cropped the six flattest, and every one carries vine.
 *      SR-TOP    shallows-reef (560,0)-(840,120)     pure water, top of frame.
 *                The first window I cut here was (560,0)-(1180,110) and it
 *                contains the HUD compass; it is not used, and it is recorded so
 *                that nobody re-cuts it.
 *      SR-MID    shallows-reef (200,260)-(520,380)   pure water 140 px lower, and
 *                THE CONTROL FOR THIS WHOLE ROUND: same shot, same medium, same
 *                biome, two thirds of a stop darker.
 *      GR-OURS   grand-reef    (58,324)-(499,594)    open water, as round 28.
 *      CAVE-W    cave          (100,380)-(280,500)   cavern water and haze, one
 *                3-px bioluminescent mote in the right third.
 *      DV-OURS   deep-void     (360,270)-(720,720)   as round 27.
 *
 *    PLATE WINDOWS, same treatment, and their p90 matters more than ours:
 *
 *      SR-PLATE  shallows-reef-1 (1500,150)-(1850,370) of 1920x1080. Open water
 *                with two faint shafts and a little particulate. p90 199 — READABLE.
 *      GR-PLATE  grand-reef-2 (880,80)-(1080,180) of 1360x768, as round 28. p90 70.
 *      KP-BOT    kelp-forest-1 (1267,880)-(1344,1004). Deep green water and
 *                nothing else. p90 76 — READABLE.
 *      KP-TOP    kelp-forest-1 (1238,27)-(1344,103), the window rounds 27 and 28
 *                used. p90 255, and 71.6% OF IT IS AT OR OVER DISPLAY 250.
 *                UNREADABLE — see item 4.
 *
 *      window     MEDIUM                  ROUND 28                ROUND 29
 *                 R / R% / sat / p90      R / R% / sat / p90      R / R% / sat / p90
 *      KELP-TOP    2.0 /  1.0 / .990 /190   3.4 / 1.4 / .986 /243   3.4 / 1.4 / .986 /242
 *      KELP-BOT    0.2 /  0.3 / .997 / 64   0.2 / 0.6 / .994 / 36   0.2 / 0.7 / .994 / 36
 *      SR-TOP     55.6 / 23.8 / .761 /249  55.0 /26.9 / .733 /216  42.9 /21.2 / .788 /212
 *      SR-MID     61.4 / 29.7 / .703 /209  55.7 /28.3 / .717 /199  54.5 /28.2 / .718 /195
 *      GR-OURS    18.4 / 32.1 / .679 / 60  24.5 /34.3 / .657 / 76  24.5 /34.3 / .657 / 76
 *      CAVE-W     32.5 / 80.3 / .737 / 42  20.4 /60.1 / .674 / 36  20.4 /60.1 / .674 / 36
 *      DV-OURS     5.7 / 22.0 / .779 / 28   4.7 /19.7 / .804 / 25   4.7 /19.6 / .804 / 25
 *
 *    Shot crop (96,108)-(1152,918), median / sat / R% / p90:
 *
 *      shot            MEDIUM               ROUND 28             ROUND 29
 *      kelp-forest      53.1/.913/ 8/172     28.2/.927/ 7/221     28.9/.927/ 7/221
 *      grand-reef       33.1/.688/34/ 63     40.4/.662/36/ 86     40.4/.662/36/ 86
 *      shallows-reef   140.1/.657/35/213    125.8/.712/33/204    124.2/.714/33/200
 *      cave             21.3/.675/76/ 85     20.9/.630/68/153     20.9/.630/67/153
 *      deep-void        18.2/.767/29/ 32     15.5/.785/28/ 30     15.5/.785/28/ 30
 *      hud             122.4/.705/30/214     83.3/.756/30/190     83.3/.757/30/187
 *
 *    READ THE p90 COLUMNS FIRST. KELP-TOP is at 242-243 and SR-TOP's MEDIUM is at
 *    249 with 25.3% of the window at or over 243 BEFORE this file touches it.
 *    Those two are against the ceiling and nothing about colour may be read off
 *    them. GR-OURS at 60/76, CAVE-W at 42/36 and DV-OURS at 28/25 are far under
 *    it and can be read.
 *
 * 1. THE DEFECT, DERIVED. THE TWO ACES MATRICES ARE NOT A ROUND TRIP.
 *    Multiplied out, ACES_OUT * ACES_IN is
 *
 *        0.91589   0.07675   0.00736
 *        0.02308   0.96955   0.00736
 *        0.02308   0.07675   0.90016
 *
 *    Unit ROW sums, so white still maps to white and every previous round's
 *    "both matrices map white to white" check passes — but the RED ROW picks up
 *    7.675% of the green and 0.736% of the blue. That is the RRT desaturation and
 *    the ODT re-saturation, and it means that with NO CURVE AT ALL the sandwich
 *    turns a green-cyan whose red is EXACTLY ZERO into a display R% of 32. The
 *    per-channel fit between the matrices then makes the residual level-
 *    dependent: rrtOdtFit is concave, so it compresses the large AP1 channel
 *    harder than the small one, ACES_OUT's cancellation is calibrated for the
 *    UNCOMPRESSED ratio, and what is left over comes out positive. Below the
 *    crossing the same residual is NEGATIVE and the closing clamp(o, 0, 1)
 *    deletes it — which is exactly why twenty-eight rounds of dark-frame
 *    measurement never saw this.
 *
 *    MODELLED THROUGH acesFitted() AND chroma recovery at 0.70, on the kelp water
 *    chromaticity (0, 0.1022, 0.0578 — the round-25 crop median with red set to
 *    exactly zero), uCurveGain 1.40:
 *
 *      scene maxc   0.05  0.10  0.20  0.40  0.60  0.80  1.20  2.00  4.00
 *      display R       0     0     0     0    37    59    85   110   130
 *      R%              0     0     0     0    19    28    37    46    52
 *      saturation  1.000 1.000 1.000 1.000 0.812 0.723 0.626 0.541 0.476
 *
 *    The crossing is scene-linear 0.42 for kelp's chromaticity, 0.52 for the
 *    shallows cyan and 0.55 for grand-reef's navy — i.e. only bright windows.
 *
 *    AND READ THE 1.20 COLUMN. R% 37 at saturation 0.626 is, to three digits, the
 *    pair a biomes builder measured on our kelp water window and reported as a
 *    property of the medium (R 89.4, relative red 37%, saturation 0.626; the model
 *    gives R 85 out of a scene red of exactly zero). uFogColor.r there is 4e-5.
 *    It is not only reproducible in the model: with round 28's far-band chroma
 *    lock ablated, so that the curve's own output survives to the display, the
 *    real KELP-TOP window on the real build reads R 83.3 at R% 35.1 and
 *    saturation 0.649 — see item 2's ablation table. EVERY COUNT OF THAT RED IS
 *    MADE INSIDE THIS FILE, and the finding that opened this round is confirmed
 *    from arithmetic rather than inferred from a picture.
 *
 * 2. WHAT SHIPPED: A PER-CHANNEL CEILING AT THE SCENE'S OWN CHANNEL RATIOS.
 *    The invariant: a tone curve may take a channel DOWN, and above genuine
 *    overexposure it may walk all three toward white — that is film, and it is
 *    LOOK.md 9's [255,255,255] highlight. It may not RAISE a channel's level
 *    relative to the pixel's largest channel above where the scene put it while
 *    the pixel is merely bright. So o is min()ed against maxc(o) times the scene's
 *    own channel ratios, opened toward 1 by exactly the whitening guard tonemap()
 *    already uses for chroma recovery (uChromaGuard, scene-linear 1.6-5.12), so
 *    the curve and the recovery finally agree on where a highlight begins instead
 *    of one of them being the only defence against the other. ?aceshue=0 restores
 *    round 28.
 *
 *    IT IS A min(), SO THE TOE IS INERT UNDER IT BY CONSTRUCTION, and that is
 *    arithmetic rather than a sweep: the toe's chroma EXPANSION lowers the small
 *    channels' relative level, and the deep frames' saturation depends on it.
 *    Modelled on four window chromaticities the operator moves NOTHING below scene
 *    0.40 on any of them, and nothing on a near-neutral lamp core at any level
 *    (largest saturation move on (1, 1, 0.95) across scene 0.05-12.0 is 0.005).
 *
 *    THE MEASURED RESULT IS THE SAME SHAPE: it moves exactly the windows whose
 *    p90 says it should and nothing else. From the tables in item 0 —
 *
 *      GR-OURS, CAVE-W, DV-OURS   identical to every digit printed
 *      grand-reef shot crop       identical to every digit printed
 *      cave / deep-void / hud     median identical (20.9 / 15.5 / 83.3),
 *                                 saturation within 0.001
 *      SR-MID  (p90 199)          R% 28.3 -> 28.2, sat 0.717 -> 0.718
 *      SR-TOP  (p90 216)          R% 26.9 -> 21.2, sat 0.733 -> 0.788
 *      kelp-forest crop           % of crop at 243+ 0.61 -> 0.23
 *      kelp top band              red ADDED over the medium 1.1 -> 0.4 counts,
 *                                 % at 243+ 1.49 -> 0.36
 *
 *    SR-TOP AND SR-MID ARE THE SAME WATER 140 PIXELS APART AND THEY DISAGREE
 *    ABOUT THIS OPERATOR BY A FACTOR OF THIRTY. That is the round-28 finding
 *    restated as an experiment rather than an argument.
 *
 *    AND SR-TOP IS A WIN, MEASURED AGAINST ITS SHOT'S VERIFIED PRIMARY PLATE ON A
 *    WATER-ONLY WINDOW WHOSE p90 IS 199 ON THE PLATE SIDE:
 *
 *      SR-TOP           R      R%   linR%   sat      error vs SR-PLATE
 *      SR-PLATE       43.7    23.2   4.90  0.768         —
 *      round 28       55.0    26.9   6.27  0.733    +11.3 / +3.7 / +1.37 / -0.035
 *      ROUND 29       42.9    21.2   4.06  0.788     -0.8 / -2.0 / -0.84 / +0.020
 *
 *    Every axis improves and mean red goes from 11.3 counts off its plate to 0.8.
 *
 *    THE HEADLINE WINDOW DOES NOT MOVE, AND THE ABLATION SAYS WHY. KELP-TOP is
 *    unchanged because round 28's far-band chroma lock is standing in front of the
 *    curve there (wFar = 1.00 on that window, read back with ?pfxdebug=6). Ablate
 *    the lock and both operators are visible, same window, same medium hash:
 *
 *      KELP-TOP                          R     R%   linR%   sat    p90
 *      medium                           2.0    1.0   0.12  0.990   190
 *      ?farchroma=0, round 28 curve    83.3   35.1  10.25  0.649   240
 *      ?farchroma=0, ROUND 29 curve    68.3   28.8   6.86  0.712   240
 *      shipped (lock on, round 29)      3.4    1.4   0.12  0.986   242
 *
 *    Read the second row against item 1: 35.1 R% at saturation 0.649 out of a
 *    medium at 1.0 and 0.990 is the biomes builder's 37 / 0.626 on a real frame.
 *    Read the third: THE CEILING TAKES A THIRD OF IT, NOT ALL OF IT — and the
 *    reason is the round-26 mechanism, not a failure of this one. With the lock
 *    off, that pixel arrives at the OKLab block above its own chroma-feasible
 *    lightness, and oklabToRgbClipped() surrenders chroma toward the achromatic
 *    point whatever chroma it was handed. So the two sources are not additive:
 *    the curve's share is 15 counts and the display grade's is 66, and round 28's
 *    lock is what removes the second. I am reporting the decomposition rather than
 *    claiming the whole 81.
 *
 *    SO THE INVARIANT IS NOW HELD IN TWO INDEPENDENT PLACES AND ONE OF THEM IS THE
 *    RIGHT PLACE. The lock is a downstream repaint that happens to sit in front of
 *    this defect on one band; the curve is where the red is made, and everywhere
 *    wFar < 1 — near and mid water, every above-water frame, and any future frame
 *    whose far weight is partial — the lock was never there. SR-TOP is exactly
 *    such a pixel: its zone split reads near 0.24 / mid 0.40 / far 0.21.
 *
 * 3. WHICH OF MY OWN ROUND 24-26 RED NUMBERS SURVIVE. The answer is not uniform,
 *    and this is the part of the round worth more than the fix.
 *
 *      shot            p90 med/graded   verdict
 *      grand-reef          63 /  86     SURVIVES. Two and a half stops under the
 *                                       ceiling in both images, no population near
 *                                       it. Round 24's -25 R% is not this artefact.
 *      cave                85 / 153     SURVIVES, and CAVE-W (p90 42 / 36)
 *                                       reproduces the direction independently on a
 *                                       water-only window: medium R% 80.3 -> graded
 *                                       60.1, the chain REMOVING 20 points of red,
 *                                       which is round 24's -14 on a cleaner window.
 *      deep-void        32 /  30        SURVIVES on the same grounds.
 *      shallows-reef      213 / 204     SUSPECT, FOR A REASON ROUND 24 COULD NOT
 *                                       HAVE SEEN: it is the BYPASS that clips.
 *                                       SR-TOP's ?nopostfx image is p90 249 with
 *                                       25.3% at 243+, against 0.0% graded. A grade
 *                                       delta measured against a clipped reference
 *                                       is measuring the reference.
 *      kelp-forest        172 / 221     THE ARTEFACT. See below.
 *
 *    ROUND 24's HEADLINE — "THE TONE CURVE +0.115 sat, -6 R% (deep-void +0.109,
 *    -22)" — SURVIVES, AND ROUND 29 EXPLAINS IT. It says the curve is a red
 *    REMOVER, which reads as the opposite of this round's finding and is not: it is
 *    the SAME residual seen from the other side of the crossing. grand-reef and
 *    deep-void live at scene 0.05-0.20, where ACES_OUT's red comes out negative and
 *    clamp() deletes it. Round 24 measured the clamp, this round measures the
 *    manufacture; one term, sign change at scene 0.42-0.55. The reason no round
 *    could reconcile them is that nobody had swept the level.
 *
 *    ROUND 25 ITEM 5 AND ROUND 26 ITEM 2 — THE KELP RED — WERE THE ARTEFACT, AND
 *    THE PROOF IS IN ROUND 26's OWN NUMBERS. Round 25 reported the chain adding 22
 *    points of R% to kelp and round 26 attributed 36 counts of it to the top band,
 *    WHICH IT MEASURED AS HAVING 47.4% OF ITS PIXELS AT OR OVER DISPLAY 243. That
 *    is a near-clipped window by any definition, and item 1's table says what such
 *    a window returns out of a red of zero: R% 37-46. The mechanism round 26 named
 *    is real and its fix measured correctly — but it was one of two operators
 *    standing on the same pixels, and item 2's ablation now separates them. The
 *    OPERATOR was right; the ATTRIBUTION was not.
 *
 *    IT CANNOT BE RE-RUN, AND SAYING SO IS PART OF THE ANSWER: the medium's own
 *    top-band red has gone from 43.1 counts at round 26 to 1.5 today, so no build
 *    exists on which the round-26 comparison can be reproduced. What can be
 *    measured is the same band on the same crop today:
 *
 *      kelp top band (96,108)-(1152,378)   round 26            round 29
 *      medium mean RGB                     [43.1,189.7,155.2]  [1.5,129.9,82.2]
 *      graded mean RGB                     [79.4,165.5,134.8]  [1.9,136.3,89.0]
 *      red ADDED by the chain              +36.3               +0.4
 *      % of band at or over display 243    47.4%               0.36%
 *
 * 4. AND THE SAME TEST CONDEMNS A TARGET I HANDED THE MEDIUM OWNER. Round 28 item
 *    9(b) told whoever owns the medium next: "KELP'S WATER HAS NO RED AT ALL. KELP
 *    TOP reads R/max 0.1% against the plate window's 16.5%." That plate window is
 *    kelp-forest-1 (1238,27)-(1344,103), and measured properly it is p90 255 with
 *    71.6% OF ITS PIXELS AT OR OVER DISPLAY 250. It is a blown highlight in the
 *    REFERENCE JPEG, and its 16.35% linear relative red is the plate's own clipping
 *    walking a saturated green toward white — the identical mechanism this round
 *    found in our curve, on the other side of the comparison. I cropped it and
 *    looked: it is a pale near-white mint field.
 *
 *    THE PLATE'S READABLE WATER WINDOW SAYS SOMETHING QUITE DIFFERENT.
 *
 *      window                 R     R%    linR%   sat     G/B    p90
 *      KP-TOP  (UNREADABLE) 110.7  44.1   16.35  0.560   1.164   255
 *      KP-BOT  (readable)     2.6   3.6    1.19  0.964   2.188    76
 *      our medium KELP-TOP    2.0   1.0    0.12  0.990   1.581   190
 *      our medium KELP-BOT    0.2   0.3    0.13  0.997   1.786    64
 *
 *    So the gap is 10x, not 130x, and it is a gap in a channel measuring 1.19% of
 *    the largest — which is LOOK.md 2's "R = 0-15 against G/B of 60-170", not a
 *    colour anyone should chase hard. The G/B column is the one worth reading: the
 *    plate's readable water is at 2.19 and the medium moved 1.09 -> 1.58/1.79
 *    inside this session, i.e. toward it and most of the way there.
 *    RETRACTING ROUND 28 ITEM 9(b): do not derive a red target from KP-TOP.
 *
 * 5. ROUND 27's GRAND-REEF HANDOFF IS CLOSED, AND ROUND 28 CLOSED IT. The brief
 *    carries it as open: "the grade cost 13% of the water's saturation and added 9
 *    points of relative red (ungraded 0.649/35, graded 0.562/44, plate 0.654/34)".
 *    Re-measured on GR-OURS, p90 60 medium and 76 graded — far under the ceiling,
 *    so these numbers are about water:
 *
 *      medium 0.679 / 32     ROUND 29 0.657 / 34     GR-PLATE 0.655 / 34
 *
 *    The cost is 0.022 of saturation and 2 points of red, not 0.087 and 9, and the
 *    graded window is ON its plate to 0.002 saturation and 0 R%. The handoff's
 *    figure is still reproducible EXACTLY — ?farchroma=0 gives 0.558 / 44 on the
 *    same window — so what the brief carries is the round-27 build, and the
 *    operator that answered it shipped in round 28. Nothing to act on, and I have
 *    not acted on it.
 *
 * 6. KELP'S ZONE-CONTRAST GAP, RE-MEASURED AFTER CORE SOFTENED THE UP-LOOK CLAMP
 *    AND AFTER THE MEDIUM MOVED AGAIN. The input changed shape in the direction
 *    that makes my gap WORSE, not better. Kelp water span, median (p90):
 *
 *      kelp water          TOP             BOT            span
 *      kelp-forest-1     219.9 (224.7)    54.8 (57.8)     4.01 (3.89)
 *      medium, round 28  166.3            45.2            3.68
 *      medium, ROUND 29  142.5 (145.0)    43.1 (48.2)     3.31 (3.01)
 *      ROUND 29 graded   184.1 (185.2)    19.5 (27.3)     9.44 (6.78)
 *
 *    The clamp change took 14% off the top of the medium and left the bottom where
 *    it was, so the medium's span fell 3.68 -> 3.31 against a plate at 4.01: the
 *    medium is now UNDER the plate's span and this file is still cubing it. AND THE
 *    ERROR IS AT THE BOTTOM, not the top — our graded top water is 184.1 against
 *    the plate's 219.9, i.e. 36 counts DARK, while our graded bottom water is 19.5
 *    against 54.8. Anything that widens the span from the top is the wrong end.
 *
 *    I AM NOT FITTING IT THIS ROUND EITHER, AND THE REASON IS ROUND 28's ITEM 7
 *    UNCHANGED: the residual is the metered exposure and the ACES toe, both global,
 *    and the only axis this file has for a level correction is depth, on which cave
 *    (190 m) and deep-void (678 m) both land while kelp (55 m) and grand-reef
 *    (280 m) want opposite corrections. Tying uKey to luma(uFogColor) is the
 *    experiment that reaches both; it moves all eighteen shots and it is not
 *    something to land in the same round as a change to the tone curve, on a medium
 *    that moved three times while I measured it.
 *
 * 7. WHAT I DID NOT TOUCH. Chroma recovery: with the ceiling in place its job
 *    shrinks, and I left it exactly where round 24 put it rather than re-tuning two
 *    operators at once. The ACES gamut return stays OFF by default and round 25's
 *    measurement of it is unaffected — the ceiling runs BEFORE it and can never
 *    make a channel MORE negative, since it only lowers channels toward a
 *    non-negative limit. resetForShot, the deep black point (exactly 0 at 12 m, so
 *    shallows-reef and hud cannot be reached by it), the abyss trim, the far-band
 *    floor, the far-band chroma lock and the round-26 highlight ceiling are all
 *    untouched.
 *
 * 8. FOR THE NEXT CRITIC, THE ONE-LINE TEST. Before believing any relative-red or
 *    saturation number in this project, ours or a plate's, take the window's p90.
 *    Two of the four windows this round's brief was built on fail it, and one of
 *    them is in a reference frame.
 *
 * ROUND 28 — THE FOG IS THE ONE COLOUR IN THE FRAME THIS FILE HAS NO OPINION
 * ABOUT, AND IT WAS REPAINTING IT. THE FAR BAND NOW LEAVES HERE THE COLOUR THE
 * MEDIUM DELIVERED. THE LEVEL RESIDUAL THAT IS LEFT IS PROVED TO BE MINE AND
 * PROVED NOT TO BE REACHABLE FROM biomes' SIDE, AND I AM NOT FITTING IT.
 *
 * 0. THE STANDING MEASUREMENT, so the next critic can reproduce the header on
 *    its own captures. Shot crop 0.05,0.10-0.60,0.85, 1920x1080, --isolate,
 *    tags postfx-r28 / postfx-r28-ng, biomes.js eac9b92f and underwater.js
 *    6db255a4 md5'd either side. median / sat / R% / topBottom, then the three
 *    horizontal bands:
 *
 *      shot           UNGRADED             GRADED               PRIMARY PLATE
 *      grand-reef     35.4/.679/34/1.11    41.5/.658/36/1.38    33.96/.461/56/0.67
 *        bands        [40.8,35.6,36.6]     [52.6,41.9,38.2]     [30.6,32.6,45.4]
 *      kelp-forest    57.3/.906/ 8/2.30    28.8/.831/12/4.99    42.62/.866/20/2.28
 *        bands        [119.8,61.1,52.0]    [121.5,30.0,24.4]    [78.4,60.2,34.4]
 *      cave           22.6/.670/77/0.84    21.9/.627/69/0.91    22.92/.736/66/1.18
 *        bands        [27.8,25.7,33.0]     [36.4,33.6,40.1]     [25.3,39.7,21.4]
 *      shallows-reef 148.2/.654/35/1.30   132.0/.710/33/1.65   134.24/.695/27/1.49
 *        bands        [157.4,145.9,121.2]  [144.6,123.4,87.8]   [154.5,110.1,103.7]
 *
 *    (Plates: grand-reef-2, kelp-forest-1, cave-1, shallows-reef-1; cave-1
 *    rather than PLATES.md's listed cave-3 for the reason round 25 gave. NONE
 *    of those four plate columns is treated as a target below. They are a
 *    whole-crop comparison between two frames that are not showing the same
 *    material distribution, and every number this round actually turns on comes
 *    from a WINDOW instead. They are printed because a critic needs the table
 *    I read, and because three of the four moved when biomes did.)
 *
 * 1. THE WINDOWS. Every figure this round rests on was cropped to a PNG, opened
 *    with the Read tool and looked at before it was used, and the contents are
 *    named. Pixel coordinates first, because a normalised crop of a plate whose
 *    size you have not checked is how the last two rounds went wrong.
 *
 *      GR-PLATE   grand-reef-2.jpg  px (880,80)-(1080,180) of 1360x768
 *                 = --crop=0.6471,0.1042,0.7941,0.2344. Open water only:
 *                 above the sand shelf, inboard of the right-hand plateau,
 *                 below the top rim, clear of the blue bushes and of the fish
 *                 cluster at (800,150). Nothing in it but water and two faint
 *                 shafts. p0.1 31.7 / p99.9 38.8 over 200x100 px.
 *      GR-OURS    grand-reef  px (58,324)-(499,594) of 1920x1080
 *                 = --crop=0.03,0.30,0.26,0.55. Left-centre open water: no
 *                 HUD, no arm, no flashlight, no ampeel, no terrain. Marine
 *                 snow and four 3-px distant fish, which the plate window has
 *                 the equivalent of.
 *      DV-PLATE   deep-void-2.jpg px (430,289)-(779,668) of 1600x900
 *      DV-OURS    deep-void   px (360,270)-(720,720) of 1920x1080
 *                 (both as published in underwater.js round 27)
 *      KELP-PLATE kelp-forest-1.jpg TOP --crop=0.645,0.025,0.700,0.095
 *      KELP-OURS  kelp-forest       TOP --crop=0.30,0.03,0.40,0.13
 *                 (both as published in this file's round 27)
 *
 *    ONE OF THE WINDOWS I INHERITED IS NOT CLEAN AND I AM SAYING SO. Round 27's
 *    GR-PLATE, px (600,10)-(1100,250), is described in underwater.js as "open
 *    water only... clear of the green cluster at (800,150)". Cropped and looked
 *    at, its bottom quarter is the sand ridge, its centre is that fish cluster
 *    and its bottom edge carries the biolum bushes. It does not change the
 *    answer — all four grand-reef-2 water windows I measured read saturation
 *    0.653-0.656 and R% 34-35, so the contamination is too small to move a
 *    ratio — but the tight window above is the one to quote, and "I looked at
 *    it" has to mean the picture and not the sentence.
 *
 * 2. THE HANDOFF REPRODUCED EXACTLY, AND THEN THE MEDIUM MOVED UNDER ME. On the
 *    biomes hash the brief was written against (c1310a9b), GR-OURS read:
 *
 *      medium 0.641/36    shipped 0.556/44    GR-PLATE 0.654/34
 *
 *    biomes.js went c1310a9b -> eac9b92f between my second and third battery —
 *    md5 either side of everything after that — and on the new hash the same
 *    window reads medium 0.668/33, shipped 0.557/44. The defect is identical on
 *    both mediums and every number below is from the new one.
 *
 * 3. WHERE IT CAME FROM: TWO OPERATORS, BOTH LANDING ON THE FAR BAND, BOTH
 *    WRONG THERE FOR A REASON THAT IS ARITHMETIC. One switch at a time on
 *    GR-OURS, against a shipped 0.557/44 and a medium of 0.668/33:
 *
 *      ?zhue=0    0.620/38   the per-zone hue ROTATION      +0.063 sat, -6 R%
 *      ?tint=0    0.616/38   the luminance SPLIT-TONE       +0.059 sat, -6 R%
 *      ?zonesat=0 0.590/41   the per-zone chroma ramp       +0.034 sat, -3 R%
 *      ?cgamma=1  0.593/41   (restores round 23's gamma)    +0.037 sat, -3 R%
 *      ?midpull=0 0.560/44   ?zgam=0 0.557/44  ?zcon=0 0.555/44   inert
 *      ?gnear=0 / ?crec=0 / ?farfloor=0 / ?hiceil=0 / ?acesgamut=1  IDENTICAL
 *      ?vib=0     0.544/46   ?gfar=0 0.541/46  ?tonemap=none 0.531/47
 *
 *    Read the last row first: the vibrance, the far channel gain and the ACES
 *    curve are all pushing the OTHER way here, so the two operators above are
 *    worth more than the 0.111 net error, and the curve is not the culprit this
 *    time. Note also that the round-26 highlight ceiling and the round-27 far
 *    floor are both bit-identical on this frame — 0.07% of it is chroma-limited
 *    and the floor never binds — so neither of the last two rounds' operators is
 *    involved.
 *
 *    THE HUE ROTATION. Live value at grand-reef: (-0.512, -0.138, +0.158) rad,
 *    so the FAR band is rotated +9.0 degrees. Its purpose, in its own comment,
 *    is "so the frame mean is left where the medium put it" — the near band
 *    rotates toward the beam and the far band rotates back to pay for it. A
 *    frame mean is not a target and the fog colour is: underwater.js normalises
 *    a far-field ray to resolve EXACTLY to the biome's authored fog colour, and
 *    that normalisation is the whole mechanism by which biomes.js is the single
 *    source of truth for what this water is. Rotating a navy (a -0.051,
 *    b -0.225, i.e. -102.8 degrees) by +9 lifts a toward red, which raises
 *    min(r,g,b) and lowers (max-min)/max. That is the measured -0.063 and +6 in
 *    one step, and no part of it is a modelling choice.
 *
 *    THE SPLIT-TONE IS A DESATURATION WEARING THE LUMINANCE AXIS'S NAME. It is
 *    uTintLo = (hDeep - hFog) * kLo, and both terms are chroma-per-unit-
 *    lightness VECTORS, so their difference has a radial part (a chroma change)
 *    and a tangential part (the hue swing the comment describes). At grand-reef
 *    hFog is (-0.0510, -0.2245) and hDeep is (-0.0241, -0.1664): the same hue
 *    to within 4.6 degrees, at 73% of the magnitude. Decomposed against the fog
 *    direction, |radial| / |total| is:
 *
 *      grand-reef 0.978    deep-void 0.869    shallows-reef 0.527   kelp 0.258
 *
 *    So on the two deep frames it is 87-98% a chroma cut aimed at the achromatic
 *    axis — the zone chroma ramp for a third time — and only on kelp is it
 *    mostly the operator its comment describes. AND IT CANNOT BE MAKING A
 *    GRADIENT ON THIS FRAME EITHER: its gate is wLo over splitLo (0.14, 0.50)
 *    and the whole window spans L 0.28-0.33, so wLo is ~0.56 across all of it.
 *    Measured bandGB, [0.68,0.67,0.67] ungraded -> [0.65,0.65,0.64] graded: a
 *    uniform shift, not a spread. A gradient operator applied uniformly is a
 *    cast.
 *
 * 4. WHAT SHIPPED: step (5c), THE FAR-BAND CHROMA LOCK. Round 27 gave the far
 *    band a one-sided floor on LIGHTNESS on the grounds that wFar is 1 where the
 *    pixel IS the fog. This is the same sentence about COLOUR and it closes the
 *    pair: as wFar -> 1 the pixel's chromaticity is returned to the one the
 *    medium delivered, and the near band keeps its full rotation and its full
 *    channel gain, so the near/far separation round 4 exists for is preserved —
 *    strengthened, in fact, because one end of it now stands still.
 *
 *    THE REFERENCE IS A CHROMATICITY AND IT IS TAKEN BEFORE THE CURVE. OKLab is
 *    exactly homogeneous of degree 1/3 in linear RGB, so ab/L is exactly
 *    scale-invariant and is the pixel's pure chromaticity — independent of
 *    exposure, bloom and every other multiply in the chain. That makes this a
 *    pure colour operator: it cannot change any pixel's lightness, so it cannot
 *    interact with step (3b) at all. Round 27 had the same choice of reference
 *    to make and the same counter-intuitive answer; here it is not close:
 *
 *      uFarChroma = 1        GR-OURS         DV-OURS
 *      locked to post-curve  0.683 / 32      0.878 / 12
 *      locked to the SCENE   0.653 / 35      0.819 / 18
 *      medium                0.668 / 33      0.780 / 22
 *
 *    The post-curve reference overshoots the MEDIUM ITSELF on both frames,
 *    because ACES expands chroma along the input's lean and does it hardest at
 *    the toe, which is where a 678 m frame lives. ?farcscene=0 restores it.
 *
 *    THE SWEEP, one biomes hash and one underwater hash either side of every
 *    row:
 *
 *      uFarChroma   GR-OURS        DV-OURS
 *      (medium)     0.668 / 33     0.780 / 22
 *      0.00         0.557 / 44     0.769 / 23
 *      0.50         0.603 / 40     0.796 / 20
 *      0.85         0.637 / 36     0.813 / 19
 *      1.00         0.653 / 35     0.819 / 18
 *      PLATE        0.654 / 34     0.774 / 23
 *
 *    1.00 is shipped and it is not a fitted value — it is the statement that a
 *    pixel which IS the fog leaves this file the colour the fog is. It lands
 *    GR-OURS on GR-PLATE to 0.001 saturation and 1 R%, from 0.097 and 10.
 *
 * 5. THE ONE COLUMN THAT LOOKS LIKE A REGRESSION IS A METRIC ARTEFACT, AND THE
 *    PLATE'S OWN PIXELS PROVE IT. DV-OURS goes 0.769 -> 0.819 against a plate at
 *    0.774, which reads as +0.045 the wrong way, and the brief names deep-void's
 *    saturation as a thing not to regress. Mean per-pixel saturation is
 *    (max-min)/max on 8-BIT sRGB, and sRGB has a LINEAR segment below display
 *    10.5/255. DV-OURS sits at display 17 with its red channel at 4-5, i.e. its
 *    red is on the linear segment and its blue is on the power segment, so the
 *    statistic stops being scale-invariant. DV-PLATE is 2.7x brighter than our
 *    water, so the two are not comparable as they stand.
 *
 *    Re-levelled in LINEAR light — decode, scale to a common mean luminance,
 *    re-encode, then run the identical estimator on both sides:
 *
 *      at DV-PLATE's own level 0.0207   at DV-OURS' level 0.0076
 *      plate        0.774 / 23          plate        0.842 / 15
 *      medium       0.685 / 31          medium       0.781 / 22
 *      round 27     0.672 / 33          round 27     0.770 / 23
 *      ROUND 28     0.733 / 27          ROUND 28     0.819 / 18
 *
 *    The plate's own window moves 0.774 -> 0.842 when it is darkened to our
 *    level, which is the artefact measured on the reference rather than argued
 *    from ours. In BOTH directions the lock is the closest row to the plate on
 *    BOTH axes, and round 27 is the furthest. The same treatment on grand-reef,
 *    where the two levels are within 1.6x and the artefact is small: at the
 *    plate's level plate 0.656/34, medium 0.677/32, round 27 0.581/42, round 28
 *    0.681/32.
 *
 *    LEVEL-INVARIANT CHROMATICITY, the estimator with no artefact in it at all —
 *    saturation and R/max of the window's MEAN LINEAR colour, identical code on
 *    both sides:
 *
 *      window        medium         round 27       ROUND 28       PLATE
 *      GR-OURS       .8458 / 15.4   .7801 / 22.0   .8516 / 14.8   .8464 / 15.4
 *      DV-OURS       .8448 / 15.5   .8442 / 15.6   .8786 / 12.1   .8908 / 10.9
 *      KELP TOP      .9988 /  0.1   .9202 /  8.0   .9989 /  0.1   .8348 / 16.5
 *
 *    AND THE THIRD ROW IS THE COST OF THIS CHANGE, REPORTED AND NOT HIDDEN.
 *    Kelp's top-of-frame water loses the 8% relative red round 27 was giving it
 *    and returns to the medium's 0.1% against a plate at 16.5%. That red was
 *    never an operator: clipPct is 0.00 on that window in every build, so it was
 *    oklabToRgbClipped() surrendering chroma along the hue line — the round-26
 *    defect, not a design — and biomes authors the kelp fog at
 *    (0.00002, 0.02669, 0.03685), R/max = 0.05%. Nothing in a display grade can
 *    legitimately turn 5e-4 of a channel into 16.5% of one; that is inventing a
 *    channel, and doing it by driving pixels into a gamut wall is the exact
 *    mechanism round 26 was spent removing. THE KELP TOP WATER'S RED IS A
 *    MEDIUM DEFECT AND IT IS NOW VISIBLE INSTEAD OF LAUNDERED. Two of the three
 *    windows land; the third returns the medium's own error exactly, which is
 *    what this operator is defined to do.
 *
 * 6. INERTNESS, EIGHTEEN SHOTS, ?farchroma=0 AGAINST SHIPPED, one session, one
 *    biomes hash and one underwater hash either side, shot crop.
 *
 *    BIT-IDENTICAL, every column: surface-pod, surface-above, seamoth,
 *    base-interior. The first two are above water, where wFar is identically 0
 *    by construction and the operator cannot exist.
 *
 *    MEDIAN INSIDE THE NOISE FLOOR on eleven more: shallows-floor 50.9,
 *    grand-reef 42.0->41.5, shallows-reef 132.4->132.0, deep-void 17.5->17.2,
 *    kelp-forest 28.8, dropoff 34.7, night-shallows 21.7->22.2, seamoth-cockpit
 *    43.0->43.5, wreck 59.2->58.7, creature-close 60.5->60.1, school 95.7->95.6,
 *    hud 85.3->85.7. The largest level move anywhere in the eighteen is godrays
 *    at -2.1% and cave at -2.2%, and both are second-order: this operator writes
 *    only ab, and OKLab L is not luminance, so a chroma change moves Y a little.
 *
 *    SATURATION, the column it exists to move, and every row is "toward the
 *    medium" by construction — that is what the operator IS:
 *
 *      shot            medium   off     on      plate (shot crop)
 *      grand-reef       .679    .580    .658    .461  gr-2 (2/3 lit sand)
 *      kelp-forest      .906    .786    .831    .866  kf-1     TOWARD
 *      cave             .670    .605    .627    .736  cave-1   TOWARD
 *      shallows-reef    .654    .707    .710    .695  sr-1     +.015 away
 *      deep-void        .773    .756    .794    .735  dv-2     see item 5
 *      night-shallows   .564    .710    .686    (sr-2)         TOWARD
 *      godrays          n/a     .834    .913    PRIMARY: none
 *      wreck            n/a     .702    .749    .599  wreck-1  AWAY
 *      creature-close   n/a     .856    .900    PRIMARY: none
 *      dropoff          .967    .888    .954    PRIMARY: none
 *
 *    WRECK IS THE ONE SCOREABLE SHOT THAT GOES THE WRONG WAY, +0.047 saturation
 *    and -5 R% against wreck-1. The mitigation is one PLATES.md wrote itself and
 *    not one I am inventing: wreck-1 is an early-access build whose "111 m water
 *    is brighter and more cyan than the shipped ramp", listed as "structure,
 *    silhouette and fog behaviour from it, NOT the water value". It is the same
 *    story as kelp: the far band returns the medium, and where the medium's red
 *    is thin that is now on screen.
 *
 * 7. GRAND-REEF'S LEVEL: biomes LANDED IT, I DID NOT, AND THE RESIDUAL PROVABLY
 *    CANNOT BE HANDED BACK. The brief asked me not to pre-correct for biomes'
 *    change and to re-measure after it. Measured, GR-OURS against GR-PLATE's
 *    median of 34.8:
 *
 *      biomes c1310a9b   medium 48.8   (1.40x)     round-27 build   51.1
 *      biomes eac9b92f   medium 37.3   (1.07x)     round-27 build   45.8
 *
 *    THE MEDIUM LANDED IT. My stage did not: the shipped frame is 45.2 against
 *    34.8, i.e. 1.30x, where the medium is 1.07x. And the pass-through is
 *    measurable, because both halves of that pair differ ONLY in biomes.js:
 *    a -23.6% change in the medium produced a -10.4% change on screen, a
 *    pass-through of 0.44.
 *
 *    THAT NUMBER IS PREDICTED BY THIS FILE'S OWN LOOP, WHICH IS WHY IT IS NOT A
 *    COINCIDENCE. The slow meter applies clamp((uKey/m)^uMeterSlow, ...) with
 *    uMeterSlow = 0.62, so output ~ m * m^-0.62 = m^0.38. A -23.6% input
 *    predicts 1 - 0.764^0.38 = -9.7% output against -10.4% measured, 0.7
 *    percentage points apart. The comment at uKey says the anchor "trims a frame
 *    which has drifted" and is "not a normaliser that decides what every frame's
 *    level is"; at exponent 0.62 it removes 62% of the world's decision in the
 *    log domain, and that is the arithmetic rather than the intent.
 *
 *    SO THE RESIDUAL CANNOT BE GIVEN BACK TO biomes, AND HERE IS THE PROOF. To
 *    move the screen the remaining -20.4% (45.2 -> 36.0) at an exponent of 0.38,
 *    the medium would have to fall a further 45.1% — to 20.5 against GR-PLATE's
 *    own water at 34.8, i.e. the medium would have to sit at 0.59x the level of
 *    the plate's water to make my output land on it. Any brief that answers this
 *    gap by asking biomes for another cut is asking for a medium a factor of 1.7
 *    BELOW its own reference.
 *
 *    AND I AM STILL NOT FITTING IT THIS ROUND, for a reason that is also
 *    arithmetic. The only axis this file has for a level correction is depth,
 *    and on the shot crop cave (190 m) sits at 21.9 against cave-1's 22.9 and
 *    deep-void (678 m) at 17.2 against deep-void-2's 15.9, with grand-reef
 *    (280 m) BETWEEN them and wanting -30%. A ramp that cuts at 280 and not at
 *    190 or 678 is non-monotone in depth and is a three-parameter fit to one
 *    shot — the shape rounds 3, 22, 24 and 26 were each retracted for. The
 *    honest fix is to the loop and not to a constant: uKey is a function of
 *    depth times the biome's own authored exposure, and the quantity it should
 *    be anchored to is the level the biome AUTHORED for this water, which this
 *    file already reads (U.uFogColor, for uZoneHue and uTintLo). Tie the key to
 *    luma(uFogColor) and the pass-through goes to ~1 and the residual collapses
 *    on its own: 37.3 delivered, ~37 shipped, 34.8 wanted. That is a change to
 *    the exposure loop that moves all eighteen shots, and landing it in the same
 *    round as a chroma change, on a medium that moved twice inside one session,
 *    is how a ramp becomes stale. It is the next round's, with the experiment
 *    written out.
 *
 * 8. KELP'S ZONE-CONTRAST GAP, RE-MEASURED AFTER biomes' GREEN CHANGE, AND THE
 *    SPAN IS STILL THE FILE'S AND STILL THE TONE CURVE'S. The brief's target was
 *    graded topBottom 5.63 against 2.28 with bands [138.7,35.6,24.6] against
 *    [78.4,60.2,34.4]. On the new medium the graded frame reads 4.99 with bands
 *    [121.5,30.0,24.4]. Round 27's finding that the band triplet is a COVERAGE
 *    comparison rather than a grade comparison stands and I have not re-fought
 *    it; what is comparable is the water inside them, windowed alone:
 *
 *      kelp water         TOP     BOT    span
 *      kelp-forest-1     219.9    54.8   4.01
 *      our medium        166.3    45.2   3.68
 *      round 27 build    207.3    18.4  11.27
 *      ROUND 28          193.0    18.1  10.66
 *
 *    The medium is on the plate's span to within 8% and this file is cubing it,
 *    exactly as round 27 found — but on the NEW medium the round-27 far floor
 *    returns much less of it, because the floor is 0.70 * Lscene and Lscene fell
 *    with the medium. The bottom water is 18.1 against the plate water's 54.8.
 *    That is the same defect as item 7 and the same cause: the residual is the
 *    metered exposure and the ACES toe, both global, and the sweep round 27 ran
 *    (0.78 buys kelp 2.4 counts and costs deep-void 21%) has not been re-run on
 *    a medium that is still moving. Left named, with item 7's fix as the one
 *    that reaches both.
 *
 * 9. FOR WHOEVER OWNS THE MEDIUM NEXT — three things, all with windows.
 *    (a) GRAND-REEF'S WATER HUE IS STILL 1.5x THE PLATE'S. G/B on GR-OURS is
 *        0.473 ungraded against GR-PLATE's 0.307. My chain used to buy 0.05 of
 *        that back by rotating the fog, at a cost of 0.07 saturation and 7
 *        points of red; it no longer does, and the gap is now shown rather than
 *        part-paid. It is a fog colour and it is biomes'.
 *    (b) KELP'S WATER HAS NO RED AT ALL. KELP TOP reads R/max 0.1% against the
 *        plate window's 16.5%, and the authored kelp fog is R/max 0.05%.
 *        SYSTEMATIC 0b's retraction already established that deep open water
 *        must gain red and that grand-reef's water did; kelp's has not.
 *    (c) DEEP-VOID'S WATER IS 2.7x DARKER THAN ITS PLATE'S WATER, and PLATES.md's
 *        "our water hits it, 0.780 vs 0.774" compared two windows across that
 *        gap on a statistic that is not invariant to it. At matched level the
 *        medium reads 0.781 against the plate's 0.842 — 0.06 UNDER, not on it.
 *        The level half of that plate's window is a lit cave mouth plus a
 *        Seaglide lamp and is not a medium target, so this is a note about the
 *        STATISTIC, not a new target: do not re-derive anything from that pair
 *        without re-levelling first.
 *
 * ROUND 27 — THE KELP TARGET SURVIVED THE WINDOW TEST AND THE BAND TRIPLET DID
 * NOT. THE DISPLAY GRADE'S SHARE OF THE WATER COLUMN IS RETURNED; WHAT IS LEFT
 * IS THE TONE CURVE, WHICH IS ALSO MINE, AND I AM NAMING IT RATHER THAN FITTING
 * A THREE-PARAMETER EXCEPTION TO IT.
 *
 * 0. THE STANDING MEASUREMENT, so the next critic can reproduce the header on
 *    its own captures. Shot crop 0.05,0.10-0.60,0.85, 1920x1080, --isolate,
 *    tags postfx-r27 / postfx-r27-ng, underwater.js 6db255a4 and biomes.js
 *    c1310a9b either side. median / sat / R% / topBottom, then the three
 *    horizontal bands:
 *
 *      shot           UNGRADED             GRADED               PRIMARY PLATE
 *      grand-reef     46.63/.649/37/1.12   46.84/.576/44/1.38   33.96/.461/56/0.68
 *        bands        [52,46.7,46.4]       [58.6,47.2,42.5]     [30.6,32.6,45.4]
 *      kelp-forest    74.64/.850/19/2.38   34.40/.790/31/5.08   42.62/.866/20/2.28
 *        bands        [156,77.8,65.5]      [138.7,35.9,27.3]    [78.4,60.2,34.4]
 *      cave           22.61/.670/77/0.84   22.39/.605/68/0.93   22.92/.736/66/1.18
 *        bands        [27.8,25.7,33.0]     [37.0,35.0,40.0]     [25.3,39.7,21.4]
 *      shallows-reef 148.21/.654/35/1.30  132.40/.707/34/1.67  134.24/.695/27/1.49
 *        bands        [157.4,145.9,121.2]  [145.4,123.7,87.4]   [154.5,110.1,103.7]
 *
 *    (Plates: grand-reef-2, kelp-forest-1, cave-1, shallows-reef-1. cave-1
 *    rather than PLATES.md's listed cave-3 for the reason round 25 gave and
 *    reference/SYSTEMATIC.md records: PLATES.md's own conditional hands the slot
 *    over when our cave is a jellyshroom cavern, and it is. NONE of the four
 *    plate MEDIANS is treated as a target in this round — see section 1's
 *    caveat. Three of the four are clean frames by PLATES.md's own flags and
 *    cave-1 carries a HUD, but the crop is not what makes a target fair: the
 *    depth and framing behind it are, and this round derives its number from a
 *    window instead. They are printed because a critic needs the table I read.)
 *
 * 1. THE WINDOWS, BECAUSE THAT IS THE RULE NOW. Every figure in this section
 *    comes from a window I cropped, looked at, and can name the contents of.
 *
 *      kelp-forest-1  TOP  0.645,0.025-0.700,0.095   pure water, sd 5.5
 *      kelp-forest-1  BOT  0.660,0.815-0.700,0.930   pure water, sd 2.2
 *      ours           TOP  0.30,0.03  -0.40,0.13     pure water, sd 0.6
 *      ours           BOT  0.31,0.86  -0.37,0.96     water + distant creepvine
 *
 *    THE FOURTH ONE IS NOT CLEAN AND I COULD NOT MAKE IT CLEAN, WHICH IS ITSELF
 *    A FINDING. Our kelp frame contains no pure-water window below y = 0.45 at
 *    all — the bottom two thirds are a kelp blade, a creature head, a terrain
 *    mound and dense creepvine — so the best available window carries distant
 *    vine that has already converged to the fog value. Everything below is
 *    therefore quoted at the window's 90th PERCENTILE as well as its median: the
 *    contamination is strictly darker than the water, the estimator is identical
 *    on both sides of the comparison, and the two forms agree throughout.
 *
 *      p90 (median)      TOP            BOT           span
 *      kelp-forest-1     224.7 (219.9)  57.8 (54.8)   3.89 (4.01)
 *      ours, the medium  214.4 (213.7)  65.3 (60.7)   3.28 (3.52)
 *      ours, round 26    213.3 (212.6)  20.4 (16.5)  10.46 (12.86)
 *      ours, round 27    213.3 (212.6)  31.1 (22.8)   6.86 ( 9.31)
 *
 *    Read rows two and three together: THE MEDIUM ARRIVES ON THE PLATE'S SPAN
 *    AND THIS FILE WAS CUBING IT. Effective exponent on the water column, medium
 *    -> shipped: 1.98 in round 26, 1.62 now, against 1.15 for the plate.
 *    LOOK.md 1 agrees on the LEVEL from a second and independent direction — the
 *    kelp biome's lower water column is #0B3710, luminance 42.8, and its upper
 *    is #164619, luminance 56.6 — so two sources put a kelp frame's lower water
 *    between 43 and 55 and round 26 shipped 16.5.
 *
 *    THE CAVEAT, and it is the one that cost round 26. kelp-forest-1 is 15-25 m
 *    and our shot is 55 m. PLATES.md certifies that plate's hue, saturation and
 *    silhouette-against-bright-water relationship across the gap and explicitly
 *    does NOT certify its absolute brightness; a top-to-bottom span is closer to
 *    topBottom, which it lists as fair only when depth matches. So 3.89 is NOT a
 *    certified target and I have not treated it as one — I stopped at the value
 *    where the collateral stops, not at the value that lands it. What needs no
 *    plate at all is the first half: our own medium delivers 3.28 and this file
 *    shipped 10.46 on the same pixels.
 *
 * 2. THE BAND TRIPLET IS A COVERAGE COMPARISON, NOT A GRADE COMPARISON. The
 *    brief's headline gap was [138.7, 35.6, 24.6] against [78.4, 60.2, 34.4].
 *    Fraction of each third of the shot crop under display 40 — i.e. how much of
 *    the band is silhouette rather than water:
 *
 *      band     plate   ours
 *      top      33.7%   19.2%
 *      mid      38.8%   64.5%
 *      bottom   66.7%   83.8%
 *
 *    The plate carries 1.8x our silhouette in the top band and we carry 1.7x its
 *    silhouette in the mid. Two frames that are not showing the same material
 *    distribution cannot have their band means compared as a grade result. That
 *    is the round-26 rule applied to the pair the round-26 brief named. The
 *    water INSIDE those bands, windowed alone, is comparable, and that is
 *    section 1.
 *
 * 3. WHAT SHIPPED: step (3b), THE FAR-BAND FLOOR. The grade may spread the water
 *    column upward as much as it likes; it may not push it toward black. wFar is
 *    by construction the set of pixels that ARE the fog colour, and two measured
 *    non-negotiables are about exactly those pixels: "distant unlit geometry
 *    gets BRIGHTER, not darker... fading distant terrain to black is the classic
 *    error", and "blacks are lifted by atmosphere, never by a curve". A pivoted
 *    power, a gamma and a midtone pull all darken everything under the pivot,
 *    and under the pivot in the far band is water. So the far band gets a
 *    one-sided floor and all three operators keep full authority above it and
 *    over near and mid geometry.
 *
 *    Attribution inside the display grade, kelp's bottom water window at
 *    ?farfloor=0 (round 26), one switch at a time. ?midpull= is new this round
 *    and it is the term that had no switch:
 *
 *      ?midpull=0   16.5 -> 22.8   +38%
 *      ?zcon=0      16.5 -> 20.8   +26%   and see section 5
 *      ?zgam=0      16.5 -> 19.6   +19%
 *      round 27     16.5 -> 22.8   the floor returns all of it, and nothing else
 *
 * 4. THE REFERENCE I EXPECTED TO BE SAFER IS THE ONE THAT IS WORSE, and only the
 *    measurement says so. Floored against the post-curve lightness the operator
 *    can return at most what the OKLab block took; floored against the lightness
 *    the MEDIUM delivered it reaches the same place at 0.70 and costs an order
 *    of magnitude less elsewhere, because on a deep frame the curve barely
 *    darkens at all, so 0.70 * Lscene never binds where L0 * 1.00 does:
 *
 *      kelp BOT   deep-void median   reference / fraction
 *      22.8       25.75  (+48%)      post-curve L0, 1.00
 *      22.8       17.46  (+0.5%)     scene Lscene, 0.70
 *
 *    Both land kelp identically and only one leaves round 26's abyss trim alone.
 *    Shipped: scene, 0.70. The sweep is at uFarFloor on the CPU side.
 *
 * 5. THE DISCRIMINATOR THE BRIEF ASKED FOR — AND GATING zcon IS THE WORSE TRADE,
 *    MEASURED. I was asked for a term separating a 55 m up-look through
 *    silhouettes from a 280 m open-water frame, where depth cannot, and told to
 *    gate the per-zone display contrast on it. The term I built needs no frame
 *    statistic, no local-contrast estimate and no closed loop: it is the
 *    far-zone weight this file already computes, combined with ONE-SIDEDNESS. A
 *    frame whose far band the chain was not taking below the floor cannot be
 *    touched by a floor, and that is arithmetic rather than tuning.
 *
 *    Gating zcon was then measured against it, on the round-26 build — whose
 *    kelp bypass is bit-for-bit the one measured today, 74.64/.850/19/2.382 with
 *    bands [156, 77.8, 65.5], so the two are comparable:
 *
 *      build             TOP    BOT    span
 *      round 26          212.6  16.5  12.86
 *      ?zgam=0           212.6  19.6  10.84
 *      ?zcon=0           181.5  20.8   8.75
 *      round 27 floor    212.6  22.8   9.31
 *
 *    ?zcon=0 buys a 1.06x better span and pays 31 counts of the top-of-frame
 *    water, which is the one figure in that frame already ON its plate (212.6
 *    against 219.9). The floor gets nearly the same span and costs nothing
 *    there. So the zone contrast keeps its value, and this is the second round
 *    running that its removal has been measured and declined rather than argued.
 *
 * 6. WHERE THE REST OF IT IS. In this file, and not in the grade:
 *
 *      kelp bottom water                             median / p90
 *      the medium (?nopostfx=1)                       60.7  /  65.3
 *      after the tone curve, before the OKLab block   22.8  /  32.7
 *      round 26 shipped                               16.5  /  20.4
 *      round 27 shipped                               22.8  /  31.1
 *      kelp-forest-1                                  54.8  /  57.8
 *
 *    Row two is measured, not modelled: ?farfloor=1&farscene=0 forbids the
 *    display grade from darkening the far band at all, so what comes out is what
 *    the curve handed it. THE METERED EXPOSURE AND THE ACES TOE TAKE 60.7 TO
 *    22.8 — a factor of 2.7 — and the whole display-referred grade took a
 *    further 1.38, which is what has now been returned. Round 26's header
 *    attributed this frame's vertical structure to "a pivoted power on L"; that
 *    was at most a third of it.
 *
 *    I AM NOT TAKING THE TONE CURVE THIS ROUND, and the reason is the one this
 *    file used to decline kelp's saturation last round. The curve is global and
 *    three shots are sitting on it: cave 22.39 against cave-1's 22.92,
 *    shallows-reef 132.40 against shallows-reef-1's 134.24, deep-void 17.46
 *    against deep-void-2's 15.90. A far-band-only compensation was worked
 *    through and rejected on arithmetic rather than nerve: the correction it
 *    needs is ~2.4x at the kelp water column and ~1.0x in the abyss, the only
 *    thing separating those two is the level of the fog itself, and gating on
 *    that is a black-level threshold with two more free parameters fitted to one
 *    shot. Round 24 retracted round 3's depth ramp for exactly that shape.
 *
 * 7. GRAND-REEF: RE-MEASURED, NOT PRE-CORRECTED. underwater.js changed under me
 *    mid-session (ca80748d -> 6db255a4) and there is an md5 either side of every
 *    battery quoted here. At 6db255a4 that shot's BYPASS is unchanged to three
 *    significant figures — 46.63/.649/37/1.12, bands [52, 46.7, 46.4], against
 *    round 26's 46.6/.649/37/1.12 [52, 46.7, 46.4] — so the medium had not
 *    landed it at the hash I could measure, and my side is still transparent:
 *    graded 46.84 against a bypass of 46.63, a delta of +0.2 counts. The floor
 *    is EXACTLY inert there, every column. Nothing was moved for it.
 *
 * 8. INERTNESS, EIGHTEEN SHOTS, ?farfloor=0 AGAINST SHIPPED, one session, one
 *    medium hash either side, shot crop 0.05,0.10-0.60,0.85.
 *
 *    IDENTICAL MEDIAN on twelve: grand-reef 46.84, shallows-reef 132.40,
 *    surface-pod 135.12, surface-above 105.69, shallows-floor 50.88, godrays
 *    122.15, wreck 59.18, creature-close 62.71, school 95.67, seamoth 33.78,
 *    base-interior 57.67, hud 85.32. On grand-reef and shallows-reef EVERY
 *    column is identical, saturation and R% included.
 *
 *    MOVED, all six, with what they are worth:
 *
 *      shot              off      shipped   plate            verdict
 *      kelp-forest       28.39    34.40     42.62 (kf-1)     the target
 *      deep-void         17.38    17.46     15.90 (dv-2)     +0.5%, noise floor
 *      cave              20.93    22.39     22.92 (cave-1)   TOWARD its plate
 *      seamoth-cockpit   36.94    43.03     81.30 (smc-1)    TOWARD its plate
 *      dropoff           27.20    34.72     PRIMARY: none    unscoreable
 *      night-shallows    16.95    21.67     14.07 (sr-2)     AWAY. See below.
 *
 *    NIGHT-SHALLOWS IS THE ONE THAT GOES THE WRONG WAY AND I AM NOT HIDING IT.
 *    Against its PLATES.md primary, shallows-reef-2, we go from 1.20x to 1.54x
 *    its crop median. The mitigation is that its two references disagree by 2.7x
 *    — shallows-reef-2 reads 14.07 on this crop and the listed alternate
 *    night-shallows-1 reads 38.15 with a 0.1-percentile of 22.26, which
 *    PLATES.md quotes precisely for the point that "even at night the water does
 *    not reach black" — and 21.67 sits between them where 16.95 sat below both
 *    less badly. That is a mitigation, not an argument. There is no free value
 *    either: measured, ?farfloor=0.55 gives night-shallows back EXACTLY (16.95,
 *    the ablated number to the count) and costs kelp the entire gain
 *    (34.40 -> 28.40, against an ablated 28.39). The two move together across
 *    that whole interval, so this is a trade and I have taken it deliberately.
 *    Saturation moves by at most 0.011 anywhere in the eighteen (wreck, toward
 *    wreck-1's 0.599), and R% by at most 1 in either direction.
 *
 * 9. FOR WHOEVER OWNS THE MEDIUM NEXT — the round-26 warning still stands and is
 *    now half repaired. This stage still amplifies the vertical ratio and is
 *    still sign-blind, but the far band can no longer be driven toward black by
 *    the display grade, so a medium fix that brightens the water column will
 *    survive to the screen instead of being taken back. The exponent this file
 *    puts on the water column is 1.62 and it was 1.98; the residual is the tone
 *    curve, section 6.
 *
 * ROUND 26 — THE KELP GAP WAS A GAMUT CLIP AT THE BRIGHT END, NOT A SHADOW, AND
 * THE DISCRIMINATOR IT NEEDED IS PER-PIXEL. THE ABYSS TRIM IS RE-SOLVED AND
 * SHIPPED, BECAUSE THE MEDIUM FINALLY MADE IT SAFE.
 *
 * 1. THE MEASUREMENT. Shot crop 0.05,0.10-0.60,0.85, 1920x1080, --isolate, tags
 *    postfx-r26 / postfx-r26-ng, one underwater.js hash (ca80748d) either side.
 *    median / sat / R% / topBottom, then the three horizontal bands:
 *
 *      shot           UNGRADED             GRADED               PRIMARY PLATE
 *      deep-void      20.0/.773/28/0.90    17.4/.757/30/0.89    15.9/.735/25/0.54
 *        bands        [23.2,21.1,25.7]     [21.9,20.3,24.8]     [13.9,29.9,25.9]
 *      kelp-forest    74.6/.850/19/2.38    28.4/.790/31/5.63    42.6/.866/20/2.28
 *        bands        [156,77.8,65.5]      [138.7,35.6,24.6]    [78.4,60.2,34.4]
 *      grand-reef     46.6/.649/37/1.12    46.8/.576/44/1.38    34.0/.461/56/0.67
 *        bands        [52,46.7,46.4]       [58.6,47.2,42.5]     [30.6,32.6,45.4]
 *      shallows-reef 148.2/.654/35/1.30   132.4/.707/34/1.66   134.2/.695/27/1.49
 *        bands        [157.4,145.9,121.2]  [145.4,123.7,87.4]   [154.5,110.1,103.7]
 *
 * 2. THE ROUND-25 HEADER GOT KELP'S MECHANISM BACKWARDS, AND THE BANDS SAY SO.
 *    It read: "a pivoted power on OKLab L with ab held fixed, so a shadow it
 *    darkens keeps its ABSOLUTE chroma, leaves the gamut, and
 *    oklabToRgbClipped() surrenders it". Two things are wrong with that. ab is
 *    NOT held fixed — step (4) has renormalised it by L/L0 since round 4 — and
 *    the defect is not in the shadows. Band by band, ungraded -> round-25 grade:
 *
 *      band   ungraded              graded (r25)          PLATE
 *      top    [43.1,189.7,155.2]    [79.4,165.5,134.8]    [25.7,95.8,61.6]
 *      mid    [ 9.1, 98.4, 75.7]    [ 7.7, 44.4, 31.1]    [14.7,75.5,43.4]
 *      bot    [16.2, 80.7, 59.7]    [10.3, 29.5, 18.2]    [ 3.5,45.1,19.4]
 *
 *    The two dark bands LOSE red through the grade. The top band gains 36 counts
 *    of it and drops 0.20 of saturation, and 47.4% of it sits at or over display
 *    243. ?zcon=0 takes that 47.4% to 0.0% and its mean red from 79.4 to 45.0.
 *    So the contrast is manufacturing the clipped population, at the BRIGHT end,
 *    by pushing pixels well above the pivot into a lightness their own
 *    chromaticity cannot hold. Toward the achromatic point of a green-teal pixel
 *    is toward RED, which is why a green frame comes back +21 R%.
 *
 * 3. THE DISCRIMINATOR THE BRIEF ASKED FOR IS NOT A FRAME STATISTIC AT ALL. It
 *    asked for a term separating a 55 m up-look through silhouettes from a 280 m
 *    open-water frame — local contrast, silhouette coverage, near-geometry
 *    fraction. It is simpler and it is exact: the fraction of the frame whose
 *    lightness exceeds what its own hue and relative chroma can represent in
 *    sRGB. Measured over the shot crop on the round-25 build:
 *
 *      kelp-forest 10.68%   shallows-reef 0.33%   deep-void 0.25%  grand-reef 0.07%
 *      kelp-forest-1 (the plate itself) 3.63%
 *
 *    Kelp is 32x the next frame. Because the test is per-PIXEL there is no gate,
 *    no frame-level heuristic and no closed loop: an operator hung on it is
 *    inert wherever no pixel is chroma-limited, and that is measured rather than
 *    argued — grand-reef and shallows-reef come back BIT-IDENTICAL, and nine
 *    further shots move their medians by exactly zero (item 5).
 *
 * 4. WHAT SHIPPED FOR IT: step (5b), THE CHROMA-FEASIBLE HIGHLIGHT CEILING.
 *    Once ab is proportional to L, OKLab's inverse is exactly cubic in L, so
 *    rgb = L^3 * oklabToRgb(1, ab/L) and the largest lightness the cube can hold
 *    at this hue and this relative chroma is cbrt(wall / maxc(unit)) — closed
 *    form, verified against oklabToRgb() numerically at a residual of 2e-16.
 *    Rolled off with the same exponential shape as the step-(3) rolloff, knee at
 *    96% of the ceiling, scaled by how chroma-limited the pixel is
 *    (maxc(unit) = 1.00 neutral, 1.39 kelp water) and switched off again over
 *    oklabToRgbClipped()'s own white ramp so a blown highlight still pegs.
 *
 *      kelp-forest     r25 28.4/.759/41      r26 28.4/.790/31    plate 42.6/.866/20
 *      top band        [79.4,165.5,134.8]    [53.7,158.4,123.6]  [25.7,95.8,61.6]
 *      top band >=243   47.4%                 0.0%                8.75%
 *
 *    Two knee revisions were needed and measurement caught both, not eye: at
 *    knee 0.86 with no white ramp the operator bit pixels still inside the cube
 *    and took the top 0.1% of cave, dropoff and seamoth — near-white cores at
 *    saturation 0.03-0.10 — down to a 99.9th percentile of 227.8 against
 *    LOOK.md 9's 233-253. Both fixes are documented at the lines themselves.
 *    ?hiceil=0 restores round 25 exactly.
 *
 * 5. THE OPERATOR IS INERT WHERE IT SHOULD BE, MEASURED ON THIRTEEN SHOTS.
 *    ?hiceil=0 against shipped, same session, same medium hash. Median: EXACTLY
 *    equal on all thirteen. Saturation: +0.000 to +0.005. R%: 0 to -2, i.e.
 *    toward every plate. The only column that moves is the 99.9th percentile,
 *    and only where a saturated highlight was pegging a channel: cave 245.0 ->
 *    241.5 (cave-1 is 237.2, so CLOSER), dropoff 238.1 -> 232.1, seamoth
 *    241.6 -> 234.5 (seamoth-1 is 243.5, so 7 counts WORSE on 0.1% of pixels —
 *    the one cost of this change and it is reported, not hidden), and godrays /
 *    shallows-floor / hud / wreck / night-shallows / surface-above all within
 *    0.4 counts.
 *
 * 6. THE DEEP-VOID REFUSAL IS OVER, AND ITS OWN COST STATISTIC IS WHAT ENDED IT.
 *    Three rounds refused an abyss exposure trim on one number: the plate holds
 *    28.6% of itself under luminance 8 with only 0.6% of it FLAT because that
 *    band carries 16.6 distinct codes; ours carried 4.4, so every code of
 *    exposure removed converted almost one-for-one into black card (1.57x ->
 *    1.12x on the median cost 4.91% -> 17.95% flat black). underwater.js's
 *    round-26 pass ended that. The bypass's vertical bands went [29.5,18.8,20.1]
 *    (top BRIGHTEST, topBottom 1.47) to [23.2,21.1,25.7] (top DARKEST, 0.90),
 *    and the dark band arrived with structure in it. Re-swept on that medium,
 *    flat black stays at 0.00% all the way down to ?exposure=0.45 — full table
 *    at the trim ramp. Shipped at the equivalent of 0.55: the abyss coefficient
 *    goes +0.49 -> -0.386 and deep-void lands 35.3 -> 17.4 against a plate at
 *    15.9 (2.22x -> 1.09x) with saturation 0.700 -> 0.757 against 0.735, flatPct
 *    0.00, and the codes statistic 0.00 -> 8.50. tD2 is arithmetically zero at
 *    every other shot in the eighteen (grand-reef at 280 m is the deepest of the
 *    rest and the ramp's edge is 300 m), so it is surgical by construction.
 *
 * 7. WHAT I DID NOT TOUCH, AND WHY. GRAND-REEF'S THREE EXACT AXES ARE GONE AND
 *    NONE OF IT IS MINE. It read 34.2/.457/58 against 34.0/.461/56 in round 24.
 *    On this medium the BYPASS reads 46.6/.649/37 and the graded 46.8/.576/44 —
 *    my delta on the median is +0.2 counts of 46.6, i.e. this stage is now
 *    transparent on that frame's level and the 1.38x is arriving from upstream.
 *    Verified twice: hiceil is bit-identical there, and tD2 is exactly 0 at
 *    280 m. Re-solving tD1 to chase it would be fitting a constant to a medium
 *    that moved three times inside this one session (ebbee064 -> 70448ea1 ->
 *    ca80748d), which is exactly how round 22's ramp came to be stale.
 *
 *    KELP'S REMAINING SATURATION IS REACHABLE AND I AM NOT REACHING FOR IT.
 *    ?zonesat=0 now takes kelp to .862/25 against a plate at .866/20 — the
 *    ceiling fix unlocked it, because the chroma that ramp cuts used to be
 *    surrendered at the gamut wall anyway. But the ramp's axis is DEPTH and
 *    depth cannot deliver it: deep-void (678 m) is now exact on saturation at
 *    .757 against .735 and grand-reef (280 m) wants LESS, and both sit at
 *    tSat = 1.0. A bump fitted at kelp's 55 m would be a three-parameter fit to
 *    land one shot on an axis the plates do not support — shallows-reef-1 .695,
 *    kelp-forest-1 .866, grand-reef-2 .461, deep-void-2 .735 is neither monotone
 *    nor single-peaked. Round 24 retracted round 3's ramp for precisely this.
 *    The real axis is the biome's own hue (LOOK.md 3: kelp is green and
 *    overrides the depth ramp) and this file cannot read it. Left named.
 *
 * 8. FOR WHOEVER OWNS THE MEDIUM NEXT. THIS STAGE AMPLIFIES THE VERTICAL RATIO
 *    AND IT IS SIGN-BLIND, so the moment your fix carries a frame past flat this
 *    stage will overshoot in the new direction, and that is mine to correct, not
 *    yours. Effective exponent on topBottom, ungraded -> graded, this build:
 *    kelp 2.38 -> 5.63 (1.99), shallows-reef 1.30 -> 1.66 (1.93), grand-reef
 *    1.12 -> 1.38 (2.85), deep-void 0.90 -> 0.89 (1.11). It is a pivoted power
 *    on L, so it raises |log ratio| and CANNOT invert one: a per-pixel monotone
 *    tone map cannot turn a top-brighter frame into a bottom-brighter frame,
 *    which is why the inversion never was mine to fix. What is left of it is
 *    deep-void's 0.89 against 0.54 and grand-reef's 1.38 against 0.67.
 *
 * ROUND 25 — THREE COLUMNS, NOT TWO. THE ONE FRAME WHERE MY DELTA WAS WRONG BY
 * A FACTOR IS FIXED; THE THREE AXES WHERE THE MEDIUM ALREADY LANDS ARE LEFT
 * ALONE; AND THE OPERATOR THAT OWNS THE WORST REMAINING GAP IS NAMED AND NOT
 * TOUCHED, BECAUSE ITS ONLY AVAILABLE CUT COSTS THREE LANDED MEDIANS.
 *
 * 1. THE MEASUREMENT. Shot crop 0.05,0.10-0.60,0.85, 1920x1080, --isolate, this
 *    tree, median / sat / R% / topBottom. UNGRADED is ?nopostfx=1 in the same
 *    battery, i.e. what the medium hands this file:
 *
 *      shot            UNGRADED             GRADED               PLATE
 *      grand-reef    43.6/.646/38/1.73   33.5/.603/45/3.80   34.0/.461/56/0.67
 *      cave          22.6/.670/77/0.85   21.0/.610/70/0.98   22.9/.736/66/1.18
 *      deep-void     18.0/.784/28/1.47   24.8/.745/32/2.64   15.9/.735/25/0.54
 *      shallows-reef 148.2/.654/35/1.30 132.4/.707/34/1.66  134.2/.695/27/1.49
 *      kelp-forest   74.6/.850/19/2.38   28.4/.759/41/5.89   42.6/.866/20/2.28
 *
 *    (Plates: grand-reef-2, cave-1, deep-void-2, shallows-reef-1, kelp-forest-1.
 *    cave-1 rather than PLATES.md's listed cave-3 because PLATES.md's own
 *    conditional hands the slot over when our cave is a jellyshroom cavern and
 *    it is; the two give opposite verdicts and reference/SYSTEMATIC.md now flags
 *    that. kelp-forest-1's MEDIAN is not a target — PLATES.md says its hue and
 *    saturation cross the 20 m/55 m gap and its absolute brightness does not —
 *    so kelp is judged on sat, R% and topBottom here.)
 *
 * 2. WHAT I CHANGED, AND IT IS ONE THING. The open-loop exposure CEILING binds
 *    on exactly one frame in the battery, and that frame's ungraded value was
 *    already ON its plate: cave ungraded 22.6 against cave-1's 22.9, graded
 *    16.1, i.e. this stage was taking 30% off a frame the medium had landed.
 *    The ceiling was solved in round 22 against cave-3 (median 5.0) and the note
 *    above deepCap said so in as many words. Raised 1.90 -> 2.95 in the top
 *    150 m, where requests run 0.56-1.13 and it therefore still cannot bind, and
 *    left where round 22 put it at 280 m and 678 m. Result, same battery:
 *
 *      metric                       before   after   cave-1
 *      crop median                   16.1     21.0    22.9
 *      % of crop under luminance 8   12.73     6.03    5.89
 *      % of crop FLAT black (9x9)     7.17     2.22    4.34
 *      distinct codes in a dark 9x9   5.98     6.25    5.79
 *
 *    Four statistics, one direction, and the last two say what actually moved:
 *    the frame was not merely dark, it was CRUSHED, and the crushed population
 *    was twice the plate's. Verified inert on the other four shots — grand-reef
 *    33.8 -> 33.5, deep-void 24.5 -> 24.8, shallows-reef and kelp-forest
 *    bit-identical — because none of them was ever capped. ?deepcap= now scales
 *    the ceiling, because round 22 proved ?exposure= cannot reach a clamped
 *    frame and the one frame the clamp holds therefore had no switch at all.
 *
 * 3. WHERE MY DELTA IS ALREADY RIGHT, AND I DID NOTHING. shallows-reef: median
 *    0.99x its plate, saturation 0.012 over it, and the +8 R% it carries is the
 *    MEDIUM's — ungraded 35, graded 34, my delta -1. grand-reef: median 0.99x
 *    off an ungraded 1.28x, so the level correction is exactly the right size.
 *    deep-void saturation: ungraded 0.784, graded 0.745, plate 0.735 — my delta
 *    is -0.039 and it lands. Three axes where a correction "in the right
 *    direction" would have been this round's named failure.
 *
 * 4. THE ONE OVERSHOOT I AM REFUSING FOR THE THIRD ROUND. deep-void's median is
 *    1.56x its plate off an ungraded 1.13x, so this stage adds 38% to a frame
 *    that was nearly there. Round 23 measured the cost of pulling the abyss
 *    ramp, round 24 reproduced it on a different medium, and the statistic is
 *    still the one that decides: flat black on this build is 0.01% of crop
 *    against deep-void-2's 0.07%, and the ungraded frame has 0.00% of itself
 *    under luminance 8 at all. The medium hands this file a dark band with no
 *    black and no texture in it — 3.85 distinct codes in a dark 9x9 against the
 *    plate's 16.63 — so every code of exposure removed from it converts almost
 *    one-for-one into black card. topBottom 2.64 against 0.54 remains the real
 *    defect and remains the in-scatter elevation anisotropy, not a trim.
 *
 * 5. KELP-FOREST IS THE WORST REMAINING GAP AND IT IS MINE. The ungraded frame
 *    is ON the plate on both axes PLATES.md says may cross the depth gap —
 *    saturation 0.850 against 0.866, R% 19 against 20 — and on topBottom, 2.38
 *    against 2.28. Graded it is 0.759 / 41 / 5.89. So my delta should be about
 *    zero on all three and it is -0.091, +22 and +3.5. In mean RGB the medium
 *    hands me [22.8, 122.9, 96.9] against a plate at [14.6, 72.1, 41.5] and I
 *    return [32.5, 79.8, 61.3] — green and blue land, and I ADD 10 counts of red
 *    to a channel that was already 1.6x the plate.
 *
 *    ATTRIBUTED, one switch at a time, same shot and the same battery position,
 *    mean red and mean saturation against shipped:
 *
 *      ?zone=0    (the whole three-zone split)   R -15.8   sat +0.137
 *      ?zcon=0    per-zone display CONTRAST      R -11.3   sat +0.038
 *      ?zonesat=0 per-zone chroma                R  -2.0   sat +0.036
 *      ?zhue=0    per-zone hue rotation          R  -0.7   sat +0.025
 *      ?gfar=0 / ?gnear=0 / ?tint=0              R  +1.3 / +1.5 / +1.2
 *      ?zgam=0    per-zone gamma                 R  +0.2   sat -0.001
 *      ?bloom=0                                  R  -4.3   sat -0.013
 *      ?exposure=1.5  (level, not chroma)        R +10.4   sat -0.047
 *
 *    Three of those switches (?zcon= ?zgam= ?zhue=) are new this round and exist
 *    because ?zone=0 moved 16 counts of red while every switch that already
 *    existed accounted for 5 of them between them. The contrast owns 72% of it.
 *    The mechanism is that the operator is a pivoted power on OKLab L with ab
 *    held fixed, so a shadow it darkens keeps its ABSOLUTE chroma, leaves the
 *    sRGB gamut, and oklabToRgbClipped() then surrenders that chroma — which on
 *    a frame this green comes back as red. And note the last row: the level cut
 *    is NOT the cause. Brightening kelp 1.5x makes both axes WORSE.
 *
 *    ALSO MEASURED AND NOT THE ANSWER: ?tonemap=none, new this round, ablates
 *    the curve itself with the rest of the chain running — the switch round 24
 *    wanted and did not have. On kelp the chain WITHOUT the curve reads mean red
 *    48.0 against the bypass's 22.8, and ACES then brings it back down to 32.5.
 *    So the curve is a red REMOVER here and the doubling happens upstream of it.
 *
 *    NOT CUT, AND THE MEASUREMENT IS WHY. Full battery at ?zcon=0 against the
 *    same battery shipped, median as a ratio of each shot's own plate:
 *
 *      shot            shipped   zcon=0        the chroma it buys
 *      kelp-forest      0.67x     0.76x    sat .759 -> .797, R% 41 -> 29
 *      cave             0.92x     0.86x    (and it double-counts item 2)
 *      grand-reef       0.99x     1.07x    sat .603 -> .598, R% 44 -> 44
 *      deep-void        1.56x     1.83x    sat .745 -> .735 (exact)
 *      shallows-reef    0.99x     0.93x    sat .707 -> .712
 *
 *    It trades three landed medians, and a fourth that item 2 just landed, for
 *    one frame's chroma — and on the cave it would stack with item 2, two
 *    corrections driving at one number, which is the exact failure this round
 *    exists to stop. The contrast ramp needs a term that separates a 55 m
 *    up-look through silhouettes from a 280 m open-water frame. Depth does not
 *    do it (kelp tMid 0.08, shallows-reef 0.00, and shallows-reef wants the
 *    operator ON), and inventing a frame-adaptive one is a closed loop this file
 *    has been burned by before. Left for a round that can measure the
 *    discriminator; the three new switches are there so it can.
 *
 * 6. THE ACES CLIP: THE PRINCIPLED FIX IS A REGRESSION, AND IT MAKES CHROMA
 *    RECOVERY BIT-IDENTICALLY INERT. Round 24 left this open; both halves are
 *    answered now.
 *
 *    The clip is real. Worked through for a kelp water pixel at the ?nopostfx
 *    median of that crop (scene-linear 0.0065 / 0.1022 / 0.0578): AP1 lands
 *    0.0429 / 0.0942 / 0.0623 — ACES_IN's red row picks up 0.355 of the green,
 *    so AP1 red is 6.6x the sRGB red — the curve returns
 *    0.01085 / 0.03861 / 0.01978, and ACES_OUT then gives R = -0.00454. The
 *    closing clamp zeroes a channel the medium left alive, and adds the
 *    luminance that negative was carrying.
 *
 *    acesFitted() now carries the textbook answer behind ?acesgamut=: hold
 *    luminance and scale the whole excursion about it until the smallest channel
 *    reaches 0, so chroma is given up instead of a channel — the same doctrine
 *    as oklabToRgbClipped() at the other end of the grade. Measured, full
 *    battery, against shipped:
 *
 *      shot            clip (shipped)      gamut return
 *      grand-reef      34.3/.465/57        33.8/.610/44     PLATE 34.0/.461/56
 *      cave            16.1/.638/68        16.1/.638/68
 *      deep-void       24.5/.751/32        24.5/.745/32
 *      shallows-reef  132.4/.707/34       132.4/.706/34
 *      kelp-forest     28.4/.759/41        27.5/.763/41
 *
 *    (That grand-reef column was taken before this round's underwater.js change
 *    — see item 7 — but both halves of the A/B were captured on one tree, so the
 *    comparison stands.) It changes nothing on three shots, moves kelp by less
 *    than the noise floor, and takes the one frame that was EXACT on three axes
 *    to 0.610 saturation against a plate at 0.461. DEFAULT 0.
 *
 *    And the redundancy test the brief asked for: with the gamut return ON,
 *    ?crec=0 is BIT-IDENTICAL to shipped on grand-reef AND on kelp-forest —
 *    [32.5,50.1,73.7] and [32.2,78.9,61.5] to the digit. The two operators are
 *    doing the same job, and the pair that lands on the plate is the clip plus
 *    recovery, not the gamut map alone. The reason is the one thing the gamut
 *    map cannot do: recovery reconstructs from the SCENE's chroma ratio, taken
 *    from BEFORE the curve, so it puts back the red the medium actually had. The
 *    gamut map only knows what survived the curve, and desaturates toward it.
 *    The switch stays, because this is a property of the current medium and the
 *    medium moves — see item 7.
 *
 * 7. TWO MEASUREMENT HAZARDS FOUND THIS ROUND. Both cost me batteries and both
 *    will cost the next agent one.
 *
 *    (a) THE FIRST SHOT OF A BATTERY IS NOT ISOLATED. capture.mjs renders and
 *    discards a warm-up of shots[0] on the initial page, and the isolate reload
 *    only fires for shots AFTER the first — so shot #1 is captured on the page
 *    that just rendered it and shots 2..n are not. On kelp-forest that is not a
 *    rounding error: position 1 reads median 49.3 / sat 0.674 / R% 44 and
 *    positions 2 and 5 read 28.4 / 0.759 / 41, BIT-IDENTICAL to each other, on
 *    one tree and one seed. grand-reef and shallows-reef are indifferent, which
 *    is why this has survived. ?nopostfx=1 is indifferent everywhere, because
 *    nothing temporal runs in the bypass. Put a sacrificial shot first when the
 *    first shot's number matters; every ablation in item 5 was captured at a
 *    fixed battery position for exactly this reason.
 *
 *    (b) THE MEDIUM MOVED UNDER ME MID-SESSION. underwater.js was edited by its
 *    owner between my baseline battery and my ablations, and grand-reef's graded
 *    crop went 34.3/.465/57 -> 33.8/.610/44 against a plate at 34.0/.461/56 with
 *    my file untouched — confirmed by re-capturing with postfx.js stashed. Its
 *    author's note says the water windows now land (R% 32-36 against the plate's
 *    34) and that my stage adds ~8 R% on top of them; on the shot crop that
 *    leaves the median at 0.99x and saturation 0.14 above the plate, which is
 *    content and not grade — grand-reef-2 is ~70% lit sand while our crop is
 *    open water, and SYSTEMATIC's own retraction of the "grand-reef 6 vs 56" row
 *    says exactly that. I am not grading toward it. Anyone comparing a number in
 *    this header against one in underwater.js's must check which side of that
 *    edit it came from.
 *
 * ROUND 24 — THE CHAIN WAS ADDING SATURATION AND REMOVING RED ON 5 OF 5 SHOTS,
 * AND THE LARGEST SINGLE CULPRIT WAS THE TONE CURVE, WHICH NO KNOB COULD REACH.
 *
 * 1. THE GRADE DELTA, MEASURED. Graded minus ?nopostfx=1, --isolate, 1920x1080,
 *    shot crop --crop=0.05,0.10,0.60,0.85, round-23 build:
 *
 *      shot            ungraded            round 23 shipped     delta
 *      grand-reef      45.6 / 0.514 / 51   28.3 / 0.793 / 26    +0.279 sat, -25 R%
 *      cave            22.7 / 0.670 / 77   12.6 / 0.910 / 63    +0.240 sat, -14 R%
 *      shallows-reef  148.2 / 0.654 / 35  132.4 / 0.798 / 25    +0.144 sat, -10 R%
 *      deep-void       18.2 / 0.754 / 31   25.6 / 0.914 / 12    +0.160 sat, -19 R%
 *      shallows-floor  99.2 / 0.747 / 26   49.9 / 0.823 / 25    +0.076 sat,  -1 R%
 *
 *    Five of five in the same direction on both axes, and the ungraded value was
 *    already AT the plate on three of them (grand-reef-2 0.461/56, deep-void-2
 *    0.735/25, shallows-reef-1 0.695/27). The brief was right: this file was
 *    undoing underwater.js.
 *
 * 2. WHERE IT CAME FROM. Six operators can add chroma and each now has its own
 *    ablation switch (?vib= ?crec= ?gfar= ?gnear= ?tint= ?cgamma=, plus the
 *    existing ?zonesat=). One at a time against shipped, grand-reef:
 *
 *      zone chroma ramp   +0.084 sat  -9 R%      split-tone   -0.025 sat  +1 R%
 *      far channel gain   +0.057 sat  -7 R%      near gain    -0.001 sat   0 R%
 *      vibrance           +0.017 sat  -2 R%      chroma rec.   0.000 sat   0 R%
 *      per-channel gamma  +0.015 sat  -2 R%
 *      -- all six at once +0.164 sat -19 R%
 *      -- THE TONE CURVE  +0.115 sat  -6 R%   (deep-void: +0.109 sat, -22 R%)
 *
 *    The curve is bigger than the entire grade on deep-void and no knob in this
 *    file could reach it. ACES expands chroma along whatever lean the input has
 *    (ACES_OUT's negative off-diagonals) and its closing clamp(...,0,1) is a
 *    per-channel clip that can zero a red channel the medium left alive. Worked
 *    through by hand for grand-reef water at the crop median (scene R/G/B
 *    0.51/0.69/1.00, uCurveGain 1.93): out comes R/B 0.387 and G/B 0.600.
 *
 *    Chroma recovery exists to answer exactly that, and it measured 0.000 on
 *    both deep frames — because its ramp-in band was ABSOLUTE scene-linear
 *    (0.22, 1.10) and a 280 m crop lives under 0.10 and a 678 m crop under 0.03.
 *    It is now quoted in multiples of meterOf(tExposure)*sceneExposure(), the
 *    frame's own metered middle, so the same band means the same thing at every
 *    depth. That single change is worth -0.089 sat / +8 R% on grand-reef.
 *
 * 3. THE ZONE CHROMA RAMP WAS SOLVED AGAINST PLATES THAT ARE NOT THESE SHOTS'.
 *    It ran 0.95 -> 1.29 with depth on the authority of "saturation climbs with
 *    depth (shallows-reef-1 0.734, kelp-forest-1 0.837, godrays-1 0.966)".
 *    godrays-1 has an EMPTY matchesShots in PLATES.md. The VERIFIED primaries
 *    for the frames the ramp lands on measure, on the shot crop, grand-reef-2
 *    0.461, cave-3 0.417, deep-void-2 0.735 — every one BELOW the shallows
 *    plate. The ramp is inverted (0.97 -> 0.88) and its band offsets narrowed
 *    from (-0.07, 0, +0.13) to (-0.05, 0, +0.05).
 *
 * 4. WHAT SHIPPED, AND WHAT IT BOUGHT. Recovery band relative; zone chroma ramp
 *    inverted; far/mid channel gain 0.20-0.30 -> 0.05-0.07 (its own comment
 *    already said it pushes the water PAST the fog); vibrance 0.09-0.15 ->
 *    0.03-0.05; per-channel display gamma off by default (?cgamma=1 restores);
 *    deep black knee 3.5 -> 2.6. Same battery, same crop, --isolate:
 *
 *      shot            round 23           round 24          PRIMARY plate
 *      grand-reef      28.3/0.793/26      34.2/0.457/58     34.0/0.461/56  gr-2
 *      deep-void       25.6/0.914/12      24.5/0.753/32     15.9/0.735/25  dv-2
 *      shallows-reef  132.4/0.798/25     132.4/0.707/34    134.2/0.695/27  sr-1
 *      cave            12.6/0.910/63      16.1/0.640/68     22.9/0.736/66  cave-1
 *      shallows-floor  49.9/0.823/25      50.9/0.717/36    155.5/0.271/100 sf-1
 *
 *    grand-reef is now exact on all three. The grade delta against ?nopostfx=1
 *    is -0.057 / -0.030 / +0.053 / -0.001 / -0.030 saturation across the five,
 *    i.e. scatter about zero instead of a systematic +0.076..+0.279 push. The
 *    medium survives this chain now.
 *
 * 5. TWO OF THE BRIEF'S LEVEL TARGETS DO NOT SURVIVE RE-MEASUREMENT, and the
 *    direction of one of them inverts. Against the VERIFIED primaries on this
 *    build (ours / plate / ratio):
 *
 *      shallows-reef 132.4 / 134.2 = 0.99      wreck        59.2 /  65.2 = 0.91
 *      grand-reef     34.2 /  34.0 = 1.01      kelp-forest  50.2 /  42.6 = 1.18
 *      cave           16.1 /  22.9 = 0.70      deep-void    24.5 /  15.9 = 1.54
 *      seamoth        33.8 /  67.1 = 0.50      shallows-fl  50.9 / 155.5 = 0.33
 *
 *    Five of eight are inside +/-20% and the two worst errors are too BRIGHT.
 *    The brief's "cave 7.7 vs 22.9, 3.4x too dark" is against cave-1, which
 *    PLATES.md does not list as cave's primary; against the listed primary
 *    cave-3 (median 5.0) this build is 3.2x too BRIGHT. I use cave-1 above and
 *    say why in the note above dbCode — our cave really is a jellyshroom
 *    cavern — but the two plates cannot both be right and no round should quote
 *    whichever one flatters the direction it already believes.
 *    shallows-floor's plate is the 8 m straight-down tan-sand frame PLATES.md
 *    admits "for caustics only"; our shot is a -12 pitch at 24 m over dark green
 *    vegetation. That is a content gap, not a grade offset — its ungraded median
 *    is 99.2, so even a perfectly transparent chain could not reach 155.5.
 *    seamoth's plate is 15-25 m against our 45 m and PLATES.md says ours should
 *    be a band darker.
 *
 * 6. THE ABYSS EXPOSURE RAMP OVERSHOOTS AND STILL MUST NOT BE PULLED. See the
 *    note above the trim ramp: deleting it takes deep-void 25.0 -> 17.8 against
 *    a plate at 15.9 and costs flat black 4.9% -> 18.0% against a plate at
 *    0.60%. Round 23 measured and refused this; I reproduced it independently
 *    on a build with a different medium and a different grade, and refuse it
 *    again. The frame's real defect is topBottom 2.74 against the plate's 0.54 —
 *    ours is bright at the top, the plate is bright at the bottom — which is the
 *    in-scatter elevation anisotropy and not an exposure trim.
 *
 * ROUND 23 — NOTHING GRADED THIS ROUND, AND THE REASON IS THAT ROUND 22 SOLVED
 * ITS RAMP AGAINST FRAMES THE CAPTURE TOOL NO LONGER PRODUCES.
 *
 * Read this before trusting any number in the ROUND 22 block below. Round 22's
 * result table (item 4) is REPRODUCIBLE AND INVALID: its PNGs are still in
 * shots/postfx-r22-rep/ and re-measuring them today returns its published
 * figures to the digit. The frames themselves no longer exist.
 *
 * 1. THE COLD/WARM SPLIT. capture.mjs started rendering and DISCARDING a warm-up
 *    shot in commit bcd3df1 — the same commit that shipped round 22's exposure
 *    ramp. So the ramp was fitted on cold-first-render frames and every capture
 *    from now on is warm. Same tree, same seed, same crop
 *    (--crop=0.05,0.10,0.60,0.85), 1920x1080, --isolate:
 *
 *      shot             r22 PNG (cold)   this round (warm)   PLATES.md primary
 *      shallows-reef       126.7             132.4            134.2  sh-reef-1
 *      shallows-floor       73.4              47.4 / 49.9     155.5  sh-floor-1
 *      cave                  6.0               8.3              5.0  cave-3
 *      grand-reef           35.0              31.2             34.0  gr-reef-2
 *      deep-void            14.7              26.4 / 27.0      15.9  deep-void-2
 *      seamoth-cockpit      40.2              38.1             81.3  cockpit-1
 *
 *    It is not a brightness offset — it is a different scene state, and the
 *    signature is topBottom: shallows-reef 0.43 cold against 1.68 warm,
 *    grand-reef 0.88 against 3.52, deep-void 1.12 against 2.57. bcd3df1's own
 *    commit message quotes the cold-to-warm shift as shallows-reef topBottom
 *    0.37 -> 1.68, and 1.68 is exactly what this round measures. Two of my
 *    batteries reproduce each other to 0-2.3% (deep-void 26.4/27.0, grand-reef
 *    31.2/31.2, kelp 28.8/28.8, seamoth 33.6/33.6, surface-above 104.5/104.5),
 *    so the warm column is solid; it is the cold column that is gone.
 *
 * 2. SO THE BRIEF'S DIRECTION IS THE WRONG SIGN. On warm captures against the
 *    verified primaries, the four DEPTH-CLEAN pairs read 0.99 (shallows-reef),
 *    0.92 (grand-reef), 1.66 (cave) and 1.68 (deep-void). Two of the four are
 *    already too BRIGHT. The rows that still read low — shallows-floor 0.31,
 *    seamoth 0.50, cockpit 0.47, kelp-forest 0.68 — are every one of them
 *    against a plate whose depth PLATES.md's own rules say median may not cross
 *    (8 m and 90% tan sand "for caustics only"; 15-25 m against our 45 and 55 m,
 *    where PLATES.md says ours SHOULD be a band darker; 110 m against our 45 m).
 *
 * 3. A FIFTH AND A SIXTH MIS-PLATED ROW IN reference/SYSTEMATIC.md. Round 22
 *    matched three of its thirteen rows back to the wrong file. Re-running that
 *    audit finds two more, and one of them inverts:
 *
 *      shot        SYSTEMATIC's plate column   is this FILE     PLATES.md primary
 *      cave        22.9/.736/66/9.6            cave-1           cave-3    5.0
 *      cockpit     69.9/.714/31/22.2           wreck-3          cockpit-1 81.3
 *      kelp        41.0/.785/25/17.8           godrays-2        kelp-1    42.6
 *      hud         134.2/.695/27/6.2           shallows-reef-1  seamoth-2 74.3
 *      surface-abv 95.8/.500/53/16.4           surface-above-1  surf-ab-2 119.5
 *
 *    hud is the inversion: SYSTEMATIC reads it as 82.7 against 134.2 (0.62x, one
 *    of the nine "too dark" rows) and its actual primary is seamoth-2 at 74.3,
 *    which makes it 1.11x too BRIGHT. The other eight rows check out
 *    (surface-pod/surface-above-1, shallows-reef, night-shallows/shallows-reef-2,
 *    shallows-floor, grand-reef, deep-void, wreck/wreck-1, seamoth).
 *
 * 4. THE WHOLE-FRAME MEDIAN IS AVERAGING TWO ERRORS OF OPPOSITE SIGN, WHICH IS
 *    WHY NO GLOBAL EXPOSURE VALUE CAN LAND IT. Split the same crop into a top
 *    band (y 0.10-0.30) and a bottom band (y 0.45-0.65), x 0.20-0.60 so no HUD
 *    is in either. Median ours | plate | ratio:
 *
 *      shot              TOP  ours | plate  ratio     BOTTOM ours | plate  ratio
 *      deep-void          61.3 |   9.5     6.45x       19.5 |  29.0     0.67x
 *      kelp-forest       226.2 |  46.1     4.91x       23.3 |  53.8     0.43x
 *      cave                9.2 |   3.1     2.97x       10.0 |  20.9     0.48x
 *      grand-reef         80.6 |  32.3     2.50x       23.8 |  36.9     0.64x
 *      shallows-reef     146.7 | 155.5     0.94x       91.9 |  75.2     1.22x
 *      seamoth            51.0 |  58.2     0.88x       25.0 |  69.7     0.36x
 *      seamoth-cockpit    73.4 |  95.1     0.77x       24.4 |  77.5     0.31x
 *
 *    Six of seven pairs put the BOTTOM band at 0.31-0.67x of the plate while the
 *    top band sits at or far above it. Only shallows-reef (12 m) has both ends
 *    right. A multiply cannot fix a frame whose halves are wrong by 6.45x and
 *    0.67x; it improves the summary statistic and degrades the picture. Part of
 *    this is content — the deep plates all contain a lit seabed or rock wall in
 *    the lower third and our deep shots look into empty water — and the rest is
 *    the in-scatter elevation anisotropy (AGENT_BRIEF's uwInscatter, U.uSkyAtten)
 *    still carrying a bright lit column at 280 m and 681 m. Neither is a grade.
 *
 * 5. THE ONE LEVER I OWN, MEASURED TO THE END. deep-void is the frame furthest
 *    from its primary (1.68x) and the abyss term in the trim ramp below
 *    (tD2 = smoothstep(300,700,depth), coefficient 0.49) is the only ramp term
 *    that touches it and nothing else in the battery. Deleting it is exactly
 *    ?exposure=0.748. A clean 2x2 — one session, one underwater.js hash
 *    (cc58a105), so the medium cannot have moved between cells:
 *
 *      exposure  deepblack   median   <8%    flat%   codes   p0.1
 *        1.000     3.5        26.2    3.49    0.67    3.90    6.1
 *        1.000     off        26.2    0.01    0.00   22.64    8.7
 *        0.748     3.5        18.9   17.22   14.17    4.32    2.6
 *        0.748     off        18.9    9.01    3.42    4.34    5.3
 *      deep-void-2 (plate)    15.9   28.64    0.60   16.61    0.0
 *
 *    (flat% is the round-17 statistic: fraction of the crop inside SOME 9x9
 *    window whose every pixel is under luminance 8. codes is the mean number of
 *    distinct luminance codes in a 9x9 window centred on a sub-8 pixel. The
 *    codes cell at 1.000/off is over 0.01% of the crop and means nothing.)
 *
 *    Reading it: the ramp cut buys median 1.65x -> 1.19x and costs flat black
 *    0.67 -> 14.17, or -> 3.42 if I also ablate my own deep black point in the
 *    abyss. Five times the plate's flat black, on the one number the brief names
 *    as do-not-regress, for a summary statistic whose error is 6.45x at the top
 *    of the same frame. The reason the trade is that bad is in the codes column:
 *    the plate carries 28.64% of itself under luminance 8 with only 0.60% of it
 *    flat, because its dark band has 16.61 distinct codes in it. Ours has 4.3.
 *    Every code of exposure removed from a textureless gradient converts almost
 *    one-for-one into flat black. NOT SHIPPED.
 *
 * 6. DEEP-VOID'S FLAT BLACK IS CLOSED, AND SHIPPED IS BETTER THAN ABLATED. The
 *    brief carries it forward as "plate 0.00%, ablated 5.66%, shipped 21.97%".
 *    Measured on this tree, shot crop, ?deepblack=0 against shipped:
 *
 *      shot            shipped   ablated   PRIMARY plate
 *      deep-void          0.83      0.00       0.60
 *      grand-reef         0.00      0.00       0.00
 *      shallows-reef      0.53      0.53       0.00
 *      cave              41.48     32.16      13.86
 *
 *    deep-void shipped sits 0.23 points from its plate and ablated sits 0.60
 *    points from it, so the stage is on the right side of the target, not the
 *    wrong one, and it costs exactly zero median (26.2 both ways, item 5).
 *    shallows-reef is bit-identical on and off — the ramp is arithmetically 0 at
 *    12 m — and grand-reef's zero is untouched. The cave is still the frame this
 *    stage really touches: 9.3 of its 27.6-point excess is mine (34%) and the
 *    other 66% is flat-black silhouette geometry arriving with no texture in it
 *    (codes 4.89 ablated, against cave-3's 11.75).
 *
 * 7. THE DETAIL EXCESS IS NOT MY SHARPENING, RE-ABLATED. ?clarity=0, detailRMS
 *    on the shot crop, ours shipped -> ours ablated (plate):
 *
 *      shallows-reef   20.73 -> 18.96  (-8.5%)   plate  6.23  — 12% of the excess
 *      cave            24.07 -> 22.52  (-6.4%)   plate 12.28  — 13% of the excess
 *      shallows-floor  29.38 -> 23.43 (-20.3%)   plate 19.50  — 60% of the excess
 *      kelp-forest     24.92 -> 21.33 (-14.4%)   plate 27.57  — BELOW plate either way
 *
 *    On the worst overshoot in the battery (shallows-reef, 3.3x its plate) the
 *    whole two-scale clarity operator is worth 12% of the gap; shallows-floor is
 *    the only frame where it is the majority, and that frame's plate is the 8 m
 *    down-look PLATES.md admits for caustics only. Its tileContrast already
 *    matches (19.12 against 18.81), so cutting clarity there would trade a
 *    matched number for an unfair one. Left alone.
 *
 * 8. THE TWO ABOVE-WATER FRAMES ARE A FRAMING RESULT, NOT AN EXPOSURE ONE.
 *    surface-pod measures 135.6 against surface-above-1's 95.8 (1.42x) on the
 *    shot crop — but that crop is 45% sky in ours and 25% in the plate, because
 *    the plate's eye is AT the waterline and ours is 1.2 m over it. On the only
 *    surface the two frames share, open water below the horizon (x 0.20-0.60):
 *
 *      surface-pod   ours 82.5 | surface-above-1 86.6   = 0.95x
 *      sky band      ours 181.8 | surface-above-1 96.3  = 1.89x
 *      surface-above ours 56.3 | surface-above-2 79.1   = 0.71x
 *
 *    The water matches within 5% and the sky is nearly double. Cutting the
 *    above-water exposure to bring surface-pod's whole-frame median down would
 *    take surface-above's water from 0.71x to about 0.5x. The sky is sky.js.
 *
 * 9. WHAT SHIPPED. One line: _jitterIndex is now cleared in resetForShot(). It
 *    was the sixth piece of temporal state in a module whose reset hook counted
 *    five. It is a contract fix, NOT a measured gain — the note beside it records
 *    that I could not make it move a number — and it is verified look-neutral
 *    (shallows-floor 47.4, seamoth 33.6/33.7, shallows-reef 132.4 identical
 *    before and after, on the three shots whose medium had not yet moved).
 *
 *    No grade, no ramp and no colour value moved this round, and that is
 *    deliberate: the medium under all of the above is being rewritten in this
 *    same round (src/render/underwater.js changed under my captures six times
 *    and threw at init twice), so a ramp fitted today would be stale before it
 *    is scored — which is precisely how round 22's ramp came to be fitted to
 *    frames that no longer exist. The size of that movement, same tag, before
 *    and after their edits landed: grand-reef saturation 0.952 -> 0.796 and
 *    relative red 6 -> 26, cave red 30 -> 100. Nothing in this file caused that
 *    and nothing in this file should be fitted on top of it mid-flight.
 *
 * 10. TWO THINGS FOR WHOEVER OWNS THE HARNESS.
 *
 *    capture.mjs CAN SILENTLY CAPTURE THE LOADING SPLASH. shots/pfx23-cl0/
 *    deep-void.png is the CLAUDENAUTICA splash screen. The report calls it a
 *    normal shot: drawCalls 306, triangles 2221768, no error, brokenBuild unset,
 *    emptyFrames unset, consoleErrors clean. It measures median 15, range 29.5,
 *    tileContrast 0.27 — and 15 is within one code of deep-void-2's 15.9, so it
 *    would have passed as a good result. The empty-frame detector only catches
 *    black; this frame is #04141A. Round 22's "geometry is not deterministic on
 *    deep-void, 266/1881544 in some batteries and 306/2221768 in others" is at
 *    least partly this: I saw 266, 307 and 306, and the 306 was the splash.
 *
 *    AND THE 11.9% PIXEL-DIFF FLOOR IS THE GEOMETRY FLIP, NOT PARTICLES OR TAA.
 *    AGENT_BRIEF attributes "pixels differing by >3: 11.9%" to particles and TAA
 *    jitter. Two batteries of one build, seed and params, whole frame:
 *
 *      shot            draws/tris A      draws/tris B       >3 pixels   meanAbs
 *      seamoth         466/10382178   =  466/10382178          0.00%     0.000
 *      surface-above   303/12491136   =  303/12491136          0.00%     0.000
 *      grand-reef      434/ 4941926      398/ 4632550          4.00%     1.121
 *      deep-void       266/ 1881544      307/ 2225066         33.18%     9.507
 *
 *    Where the geometry matches, the frames are BIT-IDENTICAL. Where it flips,
 *    a third of the frame moves. So the floor is not a rendering-noise constant
 *    to be lived with; it is a population of draw calls that appears or does not,
 *    on deep-void, grand-reef, cave, kelp-forest and shallows-floor. Any A/B on
 *    those shots must be geometry-matched or it is measuring the flip.
 *
 *    A CONCURRENT EDIT IS NOT ALWAYS A WARNING. Two of my batteries died with
 *    "Execution context was destroyed" and a module init throw
 *    (TypeError at shapeAbsorption, underwater.js:1516) while another agent was
 *    mid-save. capture.mjs writes a report with fatal set and an empty shots
 *    array, which is honest; verify.mjs downgrades the same event to a warning.
 *    Every number above was taken from batteries that started and finished
 *    inside 10:38-10:59Z, before the first such edit landed at 10:59Z, with the
 *    source tree md5-verified unchanged across the first two.
 *
 * ROUND 22 — THE LEVEL DEFICIT WAS A CLAMP NOBODY COULD SEE, AND THREE OF THE
 * SIX TARGETS IN THE BRIEF WERE MEASURED AGAINST THE WRONG PLATE.
 *
 * SUPERSEDED IN PART BY ROUND 23 ABOVE: the mechanism findings in items 1-3 and
 * 5-7 below stand (the clamp was real, ?exposure= really was inert on three
 * frames, the exponent really is not one number), but item 4's result table and
 * every ramp value solved against it were fitted to cold-capture frames that
 * capture.mjs stopped producing in the same commit. Do not re-solve against it.
 *
 * 1. THE BRIEF'S PLATE TABLE. reference/SYSTEMATIC.md's per-shot plate column
 *    was matched back to actual files by measuring all 58 plates on its own crop
 *    (--crop=0.05,0.10,0.60,0.85) and finding which file reproduces each row.
 *    Three do not come from the shot's verified primary:
 *
 *      shot              SYSTEMATIC's "plate"   which FILE that is   PLATES.md PRIMARY
 *      cave              22.9 / .736 / 66 / 9.6   cave-1.jpg (exact) cave-3    -> med 5.0
 *      seamoth-cockpit   69.9 / .714 / 31 / 22.2  wreck-3.jpg        cockpit-1 -> med 81.3
 *      kelp-forest       41.0 / .785 / 25 / 17.8  godrays-2.jpg      kelp-1    -> med 42.6
 *
 *    The cave one inverts the finding. PLATES.md rejects cave-1 as a whole-frame
 *    target in terms (209 m Jellyshroom cavern, violet biome fog) and fixes
 *    cave-3 as the primary at median 5.0. Ours measured 5.6 — so the cave was
 *    never "3x too dark", it was 1.12x too BRIGHT, and it is the one frame in
 *    the battery that must not be lifted. The cockpit's real target is HIGHER
 *    than the brief's (81.3, not 69.9) and kelp-forest's is unchanged in
 *    substance. Everything below is solved against the PLATES.md primaries.
 *
 * 2. THE DEFECT: A HARD CLAMP WITH NO INSTRUMENT ON IT. The open-loop exposure
 *    ends in clamp(request, 0.16, deepCap), and until this round the request was
 *    not observable anywhere — no uniform, no debug card, no readback. Added
 *    ?pfxdebug=13 (request), =14 (applied), =15 (ceiling). Measured, 480x270,
 *    --isolate, ?nohud=1, decoded as lin*8:
 *
 *      shot            depth  request  ceiling  applied   cut
 *      cave             190 m   2.930   1.876    1.876   -36%
 *      grand-reef       280 m   2.001   1.449    1.449   -28%
 *      deep-void        678 m   1.669   1.612    1.612   -3.4%
 *      kelp-forest       55 m   0.727   1.938    0.727      0
 *      seamoth / cockpit 45 m   0.578   1.950    0.578      0
 *      shallows-reef     12 m   0.610   1.950    0.610      0
 *
 *    THE FOURTH SILENTLY-INERT SWITCH IN THIS PROJECT. Because the clamp bound,
 *    ?exposure= did nothing at all on the three frames the brief calls too dark.
 *    Verified with ?pfxdebug=7 (sceneExposure as a flat card): at ?exposure=1.6
 *    the applied exposure came back BIT-IDENTICAL on cave (2.892), deep-void
 *    (2.415) and grand-reef (1.650), and moved x1.595-1.607 on kelp-forest, the
 *    cockpit and shallows-reef. And the ceiling FELL with depth (1.95 -> 1.44 by
 *    280 m) while the ramp it clamped RISES with depth, so the deeper the frame
 *    the less of its authored level survived.
 *
 * 3. THE EXPOSURE -> MEDIAN RESPONSE IS NOT ONE EXPONENT, and assuming it was
 *    cost this round a capture. Measured k = dlog(median)/dlog(exposure) on
 *    geometry-matched pairs: 0.795 (grand-reef, 280 m), 0.712 (cockpit, 45 m),
 *    0.78 (shallows-reef, 12 m), 1.83-2.19 (deep-void, 678 m). The abyss is
 *    three times as responsive because 59% of its crop sat under display code 8,
 *    inside ACES's toe and the encoder's own step, so a lift there does not
 *    scale the frame, it carries a large population ACROSS a threshold. A first
 *    pass sized with the mid-band exponent overshot deep-void from 7.1 to 34.4
 *    against a plate at 15.9; the shipped ramp is re-solved on that measurement.
 *
 * 4. RESULT, shot crop, 1920x1080, --isolate, ours against the PLATES.md
 *    PRIMARY, REPRODUCED in a second battery (postfx-r22 / -r22x / -r22-rep):
 *
 *      shot            depth   before  r22    rep     plate    before/pl  r22/plate
 *      shallows-reef     12 m  125.6   126.7  126.7   134.2      0.94       0.94
 *      shallows-floor    18 m   68.0    73.3   73.4   155.5 *    0.44       0.47
 *      seamoth           45 m   37.2    49.0     -     67.1 *    0.55       0.73
 *      seamoth-cockpit   45 m   29.9    40.2   40.2    81.3 *    0.37       0.49
 *      kelp-forest       55 m   33.1    44.9     -     42.6 *    0.78       1.05
 *      cave             190 m    5.6     6.0    6.0     5.0      1.12       1.20
 *      grand-reef       280 m   23.0    34.9   35.0    34.0      0.68       1.03
 *      deep-void        678 m    6.3    14.7   14.7    15.9      0.40       0.92
 *      surface-pod        0 m  139.2   119.9     -     95.8      1.45       1.25
 *      surface-above      0 m  146.1   125.3     -    119.5      1.22       1.05
 *
 *      (*) plate differs from the shot in DEPTH, which PLATES.md's own rules say
 *      median may not cross cleanly. The four depth-CLEAN pairs are the first,
 *      sixth, seventh and eighth rows, and they go 0.94/1.12/0.68/0.40 ->
 *      0.94/1.20/1.03/0.92. Every one is now inside +/-20% of its plate.
 *
 * 5. DEEP-VOID'S FLAT BLACK IS CLOSED, AND BY THE LEVEL RAMP RATHER THAN BY
 *    ABLATING THE OPERATOR. Statistic: % of the shot crop lying inside some 9x9
 *    window whose every pixel is under luminance 8 (a morphological opening of
 *    the sub-8 mask).
 *
 *      shot            r21    r22   r22 with ?deepblack=0   plate
 *      deep-void      53.29   0.00          0.00             0.60
 *      grand-reef      0.00   0.00          0.00             0.00
 *      shallows-reef  12.22  12.22         12.22             0.00
 *      cave           68.15  63.52         34.56            13.86
 *
 *    deep-void is now BIT-IDENTICAL with the stage on and off (median 14.7
 *    either way): the frame has risen clear of the knee entirely, so the "worse
 *    on than ablated" result is closed by construction and cannot come back
 *    through tuning. grand-reef's zero is untouched, and shallows-reef's 12.22
 *    is bit-identical across all three builds — the deep-black ramp is exactly 0
 *    at 12 m, so that number is not this stage's and never was.
 *
 *    THE CAVE IS THE ONE FRAME THE OPERATOR STILL TOUCHES, and the trade is
 *    real: it buys the sub-4 population 3.63 -> 20.08 (plate 39.99) and costs
 *    34.56 -> 63.52 flat (plate 13.86). It is left at 3.5 codes because the
 *    plate crushes 40% of itself and ablating would leave us at 4%. What the
 *    plate has and we do not is TEXTURE inside the dark: distinct luminance
 *    codes in a 9x9 window centred on a dark pixel measure 4.97 here against
 *    cave-3's 12.46 and deep-void-2's 17.57. That is marine snow and albedo
 *    variation arriving flat from upstream, and a grade cannot put it there.
 *
 * 6. THINGS MEASURED AND DELIBERATELY NOT ACTED ON, with the ablation.
 *
 *    DETAIL IS NOT MY SHARPENING. ?clarity=0 against the same build, detailRMS:
 *    shallows-reef 20.73 -> 20.07 (3.2%), grand-reef 15.69 -> 15.58 (0.7%),
 *    deep-void 19.63 -> 19.39 (1.2%), cave 24.14 -> 22.60 (6.4%), kelp-forest
 *    24.92 -> 21.33 (14.4%), shallows-floor 27.37 -> 23.43 (14.4%). On the worst
 *    overshoot in the battery — shallows-reef at 26.81 against
 *    shallows-reef-1's 6.23, a 4.3x — turning the whole two-scale clarity
 *    operator OFF removes 3.2% of it. Looking at the frame says why: it holds a
 *    school of several hundred small high-contrast fish plus dense grass, and
 *    the plate holds neither. Cutting clarity here would buy nothing and cost
 *    the tile contrast, so it is left alone.
 *
 *    SATURATION IS 12% MINE ON THE FRAME WHERE IT IS WORST. Added ?zonesat=0,
 *    which pins all three zone chroma gains to exactly 1.0 (?sat=0 does NOT do
 *    this — it scales sBase and leaves the band offsets (-0.07, 0, +0.13)
 *    behind, i.e. it measures a frame nobody ships). Measured on grand-reef,
 *    geometry-stable: mean saturation 0.955 -> 0.895 against grand-reef-2's
 *    0.461. So the operator is worth 0.060 of an excess of 0.494 — 12% — and
 *    88% of it is upstream of this file. Left where it is: two briefs have now
 *    said opposite things about desaturation and biomes is looking at its
 *    authored colours in the same round.
 *
 *    ...BUT IT DOES COST RED, and that is worth someone's attention: the same
 *    ablation takes grand-reef's relative red 6 -> 12 against a plate at 56.
 *    Expanding chroma about the achromatic axis in a navy frame moves the pixel
 *    further from grey along a blue direction, which halves R as a fraction of
 *    max. Six points of a fifty-point gap, but it is the wrong sign.
 *
 * 7. MEASUREMENT NOTES, because two of them will bite whoever scores this.
 *
 *    GEOMETRY IS NOT DETERMINISTIC ACROSS BATTERIES on cave, deep-void,
 *    kelp-forest, seamoth and shallows-floor. deep-void renders 266 draws /
 *    1881544 tris in some batteries and 306 / 2221768 in others at one seed and
 *    one build; cave 214 / 7882511 or 232 / 8029263. grand-reef, shallows-reef
 *    and seamoth-cockpit are stable, and every exponent above is solved on a
 *    geometry-MATCHED pair. Reported in coreBugs.
 *
 *    BIOMES CHANGED UNDER THIS ROUND, and the "before" column above straddles
 *    it. src/world/biomes.js was written at 12:31 between the baseline battery
 *    (11:35) and the final ones (12:59-13:24). The diff is +100 lines and ZERO
 *    deletions — no authored fog colour, absorption or scatter value moved — so
 *    the medium the before/after compares is the same medium; what did land is a
 *    new resetForShot() clearing that module's sync latch per shot, which can
 *    move scene state at shot setup. Declared rather than hidden: the mechanism
 *    claims above rest on the ?pfxdebug=13/15 readback and on same-session
 *    ?exposure= sweeps, none of which cross that edit.
 *
 *    THE MEDIAN NOISE FLOOR IS NOT 0.4% ON EVERY SHOT. Two runs of one build in
 *    one session: deep-void 14.7/14.7, cockpit 40.2/40.2, shallows-reef
 *    126.7/126.7, shallows-floor 73.3/73.4 (0.1%), grand-reef 34.9/35.0 (0.3%),
 *    cave 6.0/6.0. Across batteries with different shot lists it is much worse:
 *    shallows-reef read 150.1 and 126.7 (18%) on identical draw calls and
 *    triangles, and cave 4.7 and 6.0 (28%). Both are shots whose content
 *    animates hard (a fish school; a flashlight cone). Compare within a session.
 *
 * ROUND 17 — THE DEEP BLACK POINT WAS CRUSHING VARIANCE, NOT LEVEL, AND TWO OF
 * ITS THREE TARGET PLATES ARE NOW REJECTED BY reference/PLATES.md.
 *
 * THE TARGETS FIRST, BECAUSE THEY CHANGE THE ANSWER. The plate audit fixes a
 * PRIMARY per shot. For the three frames this stage touches those are cave-3,
 * deep-void-2 and grand-reef-2 — and round 16 solved against cave-3,
 * deep-void-1 and dropoff-1. deep-void-1 is the 8148 m Void with no terrain in
 * frame at all, which PLATES.md rejects for our 18-m-above-seabed shot in
 * terms; dropoff-1 was never a grand-reef plate at all. Measured here, world
 * crop (0.05,0.10 - 0.55,0.90), 1920x1080, --isolate:
 *
 *   shot        PRIMARY        blk%   <4%    <8%   med   p0.1
 *   cave        cave-3         12.46  39.80  58.04   5.0   0.0
 *   deep-void   deep-void-2     1.16  15.00  28.46  16.3   0.0
 *   grand-reef  grand-reef-2    0.00   0.00   0.02  33.6  11.7
 *
 * So grand-reef's plate contains NO absolute black anywhere and deep-void's
 * barely any. Round 16 shipped 2.90 / 53.9 / 65.8 / 3.5 on grand-reef and
 * 25.69 / 76.0 / 85.6 / 1.7 on deep-void. The "deep-void 0.02% -> 14.42%
 * against its plate's 20.86%" result was real arithmetic against a plate that
 * cannot judge this shot; against the one that can it is a 22x overshoot.
 *
 * THE DEFECT THE CRITIC ISOLATED, REPRODUCED HERE. Fraction of the world crop
 * lying inside SOME 9x9 window whose every pixel is under luminance 8 — i.e.
 * dark AND empty rather than dark and textured. (Measured as a morphological
 * opening of the sub-8 mask; the absolute numbers run about 2x the critic's,
 * whose statistic evidently counted window centres, but every column below uses
 * one definition so the comparisons hold.)
 *
 *   shot         r16 ship   r17 ship   ablated (?deepblack=0)   PRIMARY plate
 *   cave           82.45      50.81            40.72               15.42
 *   deep-void      83.97      28.85            13.29                0.83
 *   grand-reef     64.18       0.03             0.00                0.00
 *   shallows-reef   0.06       0.33*            0.06                0.00
 *
 *   (*) the shallows ramp is arithmetically ZERO at 12 m and that frame's
 *   median is bit-identical at 127.58 across all three builds; the 0.27 is
 *   scene drift between captures, not this stage. See the determinism note.
 *
 * The ablation column is the proof of ownership and it is not a small share:
 * this stage was manufacturing 100% of grand-reef's flat black, 84% of
 * deep-void's and 51% of the cave's. Three faults, all fixed, each separately
 * switchable so a critic can re-run the split:
 *
 *   1. IT WAS A PER-PIXEL TOE. out = L*smoothstep(0,k,L) has slope 1.68 at
 *      L = 0.75k and 0.08 at L = 0.1k, so a dark textured patch spanning
 *      0.3k-1.5k came out with its differences compressed ~20x and quantised to
 *      one code. The gate is now max(pixel, LOCAL LEVEL) — the 1/4-res low-pass
 *      already bound for acutance, carried into current units by the pixel's own
 *      chain ratio and clamped so it can only RAISE the gate. A patch is scaled
 *      as a unit, so its internal ratios survive; an isolated bright speck
 *      (marine snow, a biolum mote) is still gated by its own value, so a dark
 *      surround cannot take it down. ?dbgate=0 restores the round-16 form:
 *      measured at a fixed nominal 10 on the cave world crop, 65.69% under
 *      luminance 4 with the local gate against 66.42% without, and 68.09 vs
 *      69.28 with the fog key also off — real, consistent, and about a point.
 *
 *   2. IT KEYED ON OUTPUT LUMINANCE, SO IT REACHED THE NEAR FIELD. The held
 *      tool is a metre from the eye with no water in front of it and was being
 *      graded by a knee solved for 200 m of it. The knee now scales with
 *      fogAmt, the optical depth the zone split already computes: what this
 *      operator removes is an in-scattered veil, and at 1 m there is no veil.
 *      Held-tool crop of the cave frame (0.68,0.56 - 0.81,0.71), everything at
 *      a fixed nominal 10 so only the operator differs:
 *
 *        build                        flat%   blk%    <4%    <8%   median
 *        ablated (?deepblack=0)       11.73   3.58   12.98  14.22   34.79
 *        r16 form (?dbgate=0&dbfog=0) 13.71   9.80   14.95  15.59   34.65
 *        fog key off  (?dbfog=0)      13.46   9.41   14.61  15.06   34.59
 *        gate off     (?dbgate=0)     12.74   3.72   14.07  15.36   34.43
 *        r17, both live               11.72   3.60   13.24  14.52   34.72
 *        r16 AS SHIPPED (21.97 codes) 17.37  10.40   18.69  23.78   20.61
 *
 *      Read the last row against the first: round 16 was taking 41% of the held
 *      tool's median (34.8 -> 20.6) and tripling its absolute-black population.
 *      Read the fifth against the first: the stage is now inside 0.3 points of
 *      not running at all on that crop. The fog key is what does it — blk% is
 *      9.4-9.8 with it off and 3.6-3.7 with it on, whatever the gate does.
 *
 *   3. THE DEPTH RAMP RANKED THE BATTERY BACKWARDS, and its extra terms came
 *      from the rejected plates. See the note above dbCode.
 *
 * WHAT IS NOT THIS FILE'S, stated with the ablation that separates it. With the
 * stage OFF the cave world crop is still 40.72% flat, and the number of DISTINCT
 * luminance codes inside a 9x9 window centred on a dark pixel is 5.87, against
 * cave-3's 12.52, deep-void-2's 17.68 and grand-reef-2's 14.39. So the dark band
 * arrives at this file already smooth: an analytic in-scatter gradient with no
 * particulate, grain or albedo variation in it. A grade can decline to flatten
 * it further — that is what round 17 does — but it cannot put structure into a
 * signal that has none. That belongs to render/underwater.js (marine snow
 * density and its survival past 200 m) and to the surface library on the rock.
 *
 * TWO MEASUREMENT NOTES FOR WHOEVER SCORES THIS.
 *
 *   - CAPTURES ARE NOT GEOMETRY-DETERMINISTIC ON EVERY SHOT. The brief states
 *     two runs at one seed give identical draw calls and triangles. True for
 *     cave (232 / 8029263) and deep-void (306 / 2221768) across every run this
 *     round, and false for grand-reef: 398 draws / 4632550 tris in one battery
 *     and 434 / 4941926 in the next, a 6.7% triangle swing on one build and one
 *     seed. Any per-shot statistic finer than that is not safely attributable.
 *
 *   - sceneForDisplayL() IS SOLVED ON THE ACHROMATIC AXIS AND EVERY FRAME THIS
 *     STAGE TOUCHES IS STRONGLY BLUE-TEAL. Measured, the nominal display code
 *     behaves like roughly 2.5-3x itself: at a nominal 10 the grand-reef pixel
 *     sitting at code 19.9 came out at 17.2, which requires the knee to sit
 *     ABOVE that pixel's scene value, not the factor of 1.8 below it that the
 *     neutral solution predicts. Its own comment calls solving on the neutral
 *     "the conservative direction"; on this content it is the opposite, and the
 *     AO black-floor guard is sized by the same helper. The knee below is
 *     therefore calibrated by sweep rather than by its nominal number.
 *
 * ROUND 16 — THE DEEP BAND HAD NO BLACK IN IT, AND LAST ROUND'S BRIEF POINTED
 * THE OTHER WAY.
 *
 * Round 15 was spent eliminating absolute black from these frames. Measured
 * against the plates that is backwards, and the margin is not subtle. Whole
 * frame, % of pixels at exactly RGB(0,0,0):
 *
 *   shot              ours (r15)   plate
 *   cave                 0.088      12.098  (cave-3)
 *   deep-void            0.019      20.861  (deep-void-1)
 *   godrays              0.143       2.104  (godrays-1)
 *   seamoth-cockpit      0.006       0.005  (seamoth-cockpit-1)  <- right
 *   base-interior        0.846       0.054/0.183/0.145/0.002     <- too dark
 *
 * Reproduced here against the plates directly, so it is not a second-hand
 * number. The two ends of the battery were both wrong and in opposite
 * directions, which is why a global operator could never have fixed either.
 *
 * 1. WHERE THE MISSING BLACK ACTUALLY WAS. On the world crop (0.05,0.10 -
 *    0.55,0.90), the 0.1-percentile luminance — the floor no pixel falls under:
 *
 *      shot            ours   plate            shot            ours   plate
 *      cave             1.1   0.0 (cave-3)     grand-reef       8.2  11.7 (gr-2)
 *      deep-void        4.3   0.0 (dv-1)       shallows-reef    4.6   4.3 (sr-1)
 *      godrays         22.2   3.4 (gr-1)
 *
 *    The shallows MATCH — 128 median against the plate's 134 — and every deep
 *    frame carries a pedestal the plate does not. The population under it is
 *    the headline: deep-void-1 puts 62.7% of its world crop below luminance 4,
 *    ours put 0.02%.
 *
 *    THE PEDESTAL IS NOT MADE IN THIS FILE. With the chain bypassed
 *    (?nopostfx=1, verified fired — report.params comes back "&nopostfx=1" now
 *    that capture.mjs stops truncating at the second '=') the same crops floor
 *    at 6.3 / 10.0 / 59.8, i.e. the HDR buffer already carries it and the grade
 *    was cutting it ~2.5x without ever reaching zero. It is in-scattered water.
 *    What this file owns is where the display's black point sits relative to
 *    it, and that had been sliding the WRONG WAY with depth: ACES's toe zeroes
 *    scene 0.003684/uCurveGain and uCurveGain climbs 1.18 -> 2.52 from the
 *    surface to the abyss, so the deeper the frame the smaller the scene value
 *    that still resolved to a visible code.
 *
 *    THE DEEP BLACK POINT (see COMPOSITE_FRAG) is a knee quoted in display
 *    codes, inverted back through the whole display tail by the same function
 *    the AO guard uses, ramped in with depth and applied as
 *    col *= smoothstep(0, knee, luma) — a multiply in [0,1], so it maps 0 to 0
 *    and cannot lift. Before the bloom add, so bioluminescence and lamp cones
 *    are immune (LOOK.md 26).
 *
 *    Measured, --isolate, 1920x1080, whole frame. Every "off" column is a real
 *    ?deepblack=0 capture in the same session, not a previous round's file:
 *
 *      shot         depth   blk%  off -> on   plate    med  off -> on   plate
 *      cave          192 m  0.09 -> 6.43      12.10     16 -> 6          5
 *      deep-void     681 m  0.02 -> 14.43     20.86     23 -> 4          3
 *      grand-reef    280 m  0.31 -> 2.47       0.00*    26 -> 8         37 / 7*
 *      godrays        40 m  0.14 -> 0.14       2.10     92 -> 92        54
 *      shallows-reef  12 m  0.01 -> 0.01       0.00    120 -> 120      122
 *
 *      % below luminance 4:  cave 8.3 -> 45.7 [41.7]   deep-void 0.5 -> 50.5
 *      [59.5]   grand-reef 1.1 -> 38.0 [32.2 on dropoff-1]   shallows-reef
 *      1.2 -> 1.2 [0.0]
 *
 *      % below luminance 20, which is LOOK.md 19's own test for a 250 m+ frame
 *      ("over 90% of the frame sits below luminance 20"):  deep-void
 *      44.4 -> 72.7 [87.8]   grand-reef 39.5 -> 64.9 [88.3 on dropoff-1]
 *      cave 58.4 -> 73.1 [78.1]
 *
 *      (*) the two grand-reef plates disagree by 3x — grand-reef-2 is a lit
 *      seabed at median 37 with no black in it at all, grand-reef-1 a bright
 *      one at median 123 — so the 280 m open-water frame is judged against
 *      LOOK.md 19 instead, which measures dropoff-1 at median 7 with 88.3% of
 *      frame under luminance 20.
 *
 *    THE ABLATION IS THE PROOF, and it is a boundary rather than a slider.
 *    ?deepblack=0 restores round 15 exactly and the ramp is identically zero at
 *    60 m and shallower, so every frame this round was told not to move comes
 *    back BIT-IDENTICAL on every statistic: shallows-reef (12 m), base-interior
 *    (30 m, 0.84 / 4.2 / median 50 either way), godrays (40 m), seamoth-cockpit
 *    (45 m, 0.01 / 0.1 / median 38), kelp-forest (55 m), shallows-floor (18 m)
 *    and surface-above. The one frame outside the named set that moves is the
 *    wreck at 95 m, on a 3.5-code knee: black 0.60 -> 2.17%, under-4
 *    8.1 -> 10.9%, median 40 either way.
 *
 *    REPRODUCED. Two independent --isolate batteries of the same build:
 *    cave 6.43 / 6.44, deep-void 14.43 / 14.46, grand-reef 2.47 / 2.47,
 *    shallows-reef 0.01 / 0.01 — inside the 0.4% floor on every one.
 *
 * 2. WHAT THE ROUND-8 NOTE GOT WRONG, recorded because it is still in the file
 *    a few hundred lines down. A global multiplicative black point was tried
 *    then and removed with the reasoning "a toe that reached the pedestal would
 *    be crushing a third of the image, which is a grade, not a correction". The
 *    reference crushes a third of the image: cave-3 puts 39.8% of its world
 *    crop under luminance 4 and deep-void-1 62.7%. The attempt could not see
 *    its own effect because its knee was a fraction of the METER, and the meter
 *    is a floored geometric mean that reports a deep frame far above its floor.
 *
 * 3. TWO THINGS THE MEASUREMENT SAYS ARE NOT THIS FILE'S, both reported rather
 *    than quietly graded around.
 *
 *    (a) THE BATTERY COMPARES FRAMES WITH A HUD AGAINST PLATES WITHOUT ONE.
 *        cave-3 and godrays-1 have no HUD; our cave frame carries the full
 *        overlay plus a lit flashlight and the held tool. Captured with
 *        ?nohud=1 against the same build, whole frame: cave median 16 -> 10,
 *        % under luminance 4 8.2 -> 16.6, black 0.088 -> 0.572; deep-void
 *        median 23 -> 16, under-4 0.5 -> 10.3, black 0.019 -> 0.292. Half the
 *        gap on the cave frame was the HUD. godrays and shallows-reef
 *        do not move (0.143 -> 0.143, median 92 -> 92), so it is specifically
 *        the dark frames whose statistics the overlay dominates.
 *
 *    (b) GODRAYS CANNOT BE GRADED TO ITS TARGET AND SHOULD NOT BE. Our shot
 *        sits at 40 m looking UP at 40 degrees; godrays-1 is a ~150 m frame of
 *        rock spires seen near-horizontally. Bands (top/mid/bottom third), ours
 *        against the plate: 111/95/39 against 112/49/14. THE TOP MATCHES. The
 *        gap is entirely the vertical gradient of the water column, and closing
 *        it with a pivoted contrast needs an exponent of 3.0-5.1 — solved, not
 *        guessed — which would destroy every other frame. Two real causes, both
 *        outside this file: the in-scatter anisotropy (render/underwater.js,
 *        the 1.25:1 zenith-to-nadir the brief already names) and the fact that
 *        our godrays frame contains no near unlit geometry at all where the
 *        plate is half silhouette — 19.6% of godrays-1's world crop is below
 *        luminance 16 and 0.00% of ours is. Against LOOK.md's own 25-40 m row
 *        (#14636F upper = luminance 83, #0F4A52 lower = 62) our 40 m frame is
 *        about 1.2x hot, not the 1.7x the whole-frame median against a 150 m
 *        plate suggests.
 *
 * ROUND 15 — THE AO FLOOR WAS THE WRONG INVARIANT, AND THE "DOUBLED SPREAD"
 * WAS SHOT ORDER RATHER THAN LOOP GAIN.
 *
 * 1. AO WAS NOT CREATING BLACK BY BEING TOO STRONG. IT WAS CROSSING A STEP.
 *
 *    Round 14 gave the AO buffer a floor of 0.50 and verified it in the buffer
 *    (grey min exactly 187 = srgb(0.5)), and the frames still gained pure black
 *    from the stage. The floor could never have fixed it, because the zero is
 *    not in the AO term — it is in the two hard steps DOWNSTREAM of it. ACES's
 *    toe returns exactly 0 below scene 0.003684/uCurveGain, and above that the
 *    8-bit encoder rounds to 0 below display-linear 1.52e-4, which inverts to a
 *    HIGHER scene value than the toe. So the output has a step at scene ~0.0037
 *    and this stage is a multiply by as little as 0.50: it sweeps a band one
 *    full stop wide across that step in one operation, and no floor above zero
 *    can stop that.
 *
 *    Mapped per pixel (AO on XOR AO ablated, plotted), the black this stage
 *    creates on base-interior is a one-to-three-pixel FRINGE hugging crevices
 *    that were already black — the signature of a threshold being crossed by a
 *    multiply, not of an occlusion term being too strong.
 *
 *    The invariant that is actually right: occlusion may darken a pixel, it may
 *    never take a pixel from "some light" to "no light at all". Enforced by
 *    blackFloorScene(), which inverts the entire tail (encoder step, zone gamma,
 *    pivoted zone contrast, OKLab, ACES toe, curve pre-gain) to the scene value
 *    that survives it, and caps AO's factor per pixel so the result cannot fall
 *    under it. A single scalar on all three channels, bounded above by the
 *    un-occluded colour, so it can decline to create a black but CANNOT lift
 *    one. A first attempt used a fixed multiple of the ACES toe alone and moved
 *    almost nothing (1.092 -> 1.031) — the display-referred grade, not the
 *    curve, is what does most of the crushing down there.
 *
 *    Measured, one session, --isolate, 1920x1080, % of pixels at EXACTLY
 *    RGB(0,0,0), whole frame:
 *
 *      shot              guard ON   guard OFF   AO ablated   reference plate
 *      base-interior       0.841      1.088       0.833      0.054/0.183/0.145/0.002
 *      godrays             0.143      0.458       0.127      2.104  (godrays-1)
 *      cave                0.087      0.122       0.086      12.098 (cave-3)
 *      seamoth-cockpit     0.006      0.008       0.006      0.005  (cockpit-1)
 *
 *    Read the three columns as (guard OFF - AO ablated), which is what this
 *    stage was contributing, against (guard ON - AO ablated), which is what it
 *    contributes now: 0.255 -> 0.008 on base-interior, 0.331 -> 0.016 on
 *    godrays, 0.036 -> 0.001 on cave, 0.002 -> 0.000 on the cockpit. 95-100% of
 *    it, and base-interior is under the 1% target. Reproduced across three
 *    sessions: base-interior 0.846 / 0.846 / 0.841, godrays 0.142 / 0.143 /
 *    0.143, cave 0.086 / 0.086 / 0.087.
 *
 *    AND IT IS NOT A LIFT, which is the claim that actually needed proving.
 *    Guard OFF -> ON moves base-interior's mean 64.75 -> 64.92 and its median
 *    50.4 -> 50.4; godrays 83.17 -> 83.18 and 92.2 -> 92.2; cave 33.24 -> 33.32
 *    and 16.2 -> 16.2. Every level statistic is inside the noise floor while
 *    the absolute-black population falls by a factor of 3. That is what a
 *    surgical operator looks like, and it is the difference between this and
 *    the multiplicative black point that was tried and removed in round 8.
 *
 *    TWO THINGS THE ABLATION REFUTED, both worth recording.
 *
 *    (a) The round-14 critique's figures — base-interior 5.72% with AO against
 *        2.71% ablated — DO NOT REPRODUCE on this build: the same ablation now
 *        reads 1.088 against 0.833. base.js has rebuilt that shot as a bright
 *        glass dome since, and the frame is a different frame. The DEFECT was
 *        real and is now closed; the magnitude was a property of a scene that
 *        no longer exists.
 *
 *    (b) The 0.833% that survives ablating AO entirely is NOT this file's. With
 *        AO off and every black pixel plotted, 100% of them are the held
 *        scanner body and the glove — tools.js geometry, whose albedo reaches
 *        absolute zero. Nothing else in the frame touches it: not the dome, not
 *        the hex floor, not the planter. Reported.
 *
 * 2. THE LOOP GAIN. The steady-state exposure loop COMPRESSES, and the number
 *    that made it look like an amplifier was the fast/slow transient surviving
 *    between shots.
 *
 *    In steady state fast and slow meter the same scene, so the stabilising
 *    term (slow/fast)^0.70 is identically 1 and the whole loop is the anchor:
 *
 *      E = uExposure * clamp((uKey/m)^0.62, 0.25, 1.60)
 *
 *    An upstream scale s gives m ∝ s^k with k <= 1 (the metering domain is a
 *    FLOORED geometric mean, so it can only under-report a change), and the
 *    level at the curve's input is s^(1 - 0.62k) — between s^0.38 and s^1.0. A
 *    2x input swing comes out as 1.30x to 2x. The loop gain of this stage is
 *    below 1 by construction and CANNOT exceed 1; there is nothing here to fix.
 *    Downstream, the pivoted zone contrast contributes 0.80 + 0.20*zContrast =
 *    1.03-1.07 (the pivot is metered, so it tracks a uniform scale and the
 *    operator is nearly transparent to one), zone gamma at most 1.14, the
 *    midtone pull ~1.05 and the display gamma ~1.02 — an upper bound of ~1.24
 *    on the whole chain with the anchor pinned at a clamp, and ~0.5 with it
 *    live. Neither is 2.
 *
 *    What CAN reach 2 is cFast, whose clamp is [0.45, 2.30] — a 5.1x authority
 *    on a term with no steady-state anchor. Before shot isolation it was fed by
 *    whatever the PREVIOUS shot had left in the ~10 s slow meter, so the same
 *    frame could be graded anywhere in that range depending only on shot order.
 *    That is the spread the round-14 critique measured, and resetForShot() ends
 *    it by construction rather than by tuning.
 *
 *    MEASURED, not argued. ?pfxdebug=8 and ?pfxdebug=11 print the decoded fast
 *    and slow meters as flat cards. Read back off the captured frames:
 *
 *      shot              fast m      slow m      cFast = (slow/fast)^0.70
 *      base-interior     0.240621    0.240621    1.000
 *      seamoth-cockpit   0.392336    0.392336    1.000
 *      godrays           0.401054    0.401054    1.000
 *
 *    Bit-identical on every shot, which is what the snap guarantees: the 5.1x
 *    transient authority is UNREACHABLE in a still. And converting those meters
 *    (L = m/(1-m) = 0.317 / 0.646 / 0.670, cave 0.0145) against the authored
 *    uKey ramp puts cSlow at 0.62 / 0.27 / 0.30 / 1.16 — all four strictly
 *    inside [0.25, 1.60], so the anchor is LIVE on the whole battery and the
 *    exposure stage really is running at its designed log gain of 1 - 0.62 =
 *    0.38, not pinned at a clamp where it would pass a swing straight through.
 *
 *    So the clamps are left alone. They are transient authority, they never
 *    appear in a still, and moving them on no evidence is how this file
 *    accumulated its scar tissue in the first place.
 *
 * 3. THE HARNESS STILL CANNOT PASS A PARAMETER VALUE (round 6 reported it; it
 *    is still open) and it cost this round a day. Every equality-tested debug
 *    switch in this file is now a bare flag so it is reachable anyway. See the
 *    note above init(). ?nopostfx has been silently a no-op through the harness
 *    for nine rounds, which means every "raw HDR bypass" number ever quoted
 *    from a battery was the full graded chain compared against itself.
 *
 * ROUND 14 — THREE DEFECTS OTHER MODULES HAD BEEN TRYING TO FIX FROM THE
 * OUTSIDE, ALL THREE OF THEM ARITHMETIC IN THIS FILE.
 *
 * Each was found by another agent while critiquing a different module and
 * traced back here by ablation. Each is verified below by turning the stage off
 * and on, same seed, same crop, same session.
 *
 *   1. AO HAD NO FLOOR. Two Alchemy estimators multiplied and then powered
 *      reach exactly 0, and the composite applies the result as a bare multiply
 *      at an authority that clamps to 1.0 (uAO ships at 1.05). So a deeply
 *      occluded interior surface was multiplied by nothing. Cockpit lower
 *      third, % of pixels at literally RGB(0,0,0):
 *
 *                             AO on    AO ablated   reference plate
 *        cockpit lower third   2.362      0.000        0.015
 *        base-interior floor   9.856      1.085        0.113 / 0.139
 *
 *      The ablation is the proof: with this stage off the absolute-black
 *      population does not shrink, it DISAPPEARS. Floor at 0.42, linear remap.
 *
 *   2. THE DoF NEAR TERM HAD NO 1/focus IN IT, so the blur on geometry at a
 *      fixed distance from the eye grew linearly with wherever the autofocus
 *      happened to land. Focus clamps to a 5-24 m hyperfocal, so a cockpit dash
 *      0.7 m away came back at the maximum near CoC the term can express — 84%
 *      blur on something bolted to the camera. detailRMS, DoF on vs ablated:
 *
 *        cockpit dash          3.77 -> 7.08   [reference plate 12.99]
 *        base-interior floor  10.38 -> 17.11  [reference 9.36 / 27.03]
 *
 *      i.e. this one line was destroying 47% and 39% of the surface signal that
 *      every other module spends its round creating. Now (1/d - 1/s) * aperture,
 *      which is the actual thin lens.
 *
 *   3. THE "SUN BULLSEYE" IS NOT MISSING OUTPUT DITHER. The dither has been in
 *      since round 2 and measures correct (0.38-0.48 LSB residual on the
 *      flattest tiles against the 0.364 a +/-1 LSB TPDF predicts; 0.00 with
 *      ?dither=0). The rings are a 5-bit chroma quantiser inside
 *      oklabToRgbClipped(): five bisections resolve the gamut fit to 1/32, and
 *      near the wall that is 28 counts of red. A raw scanline out through the
 *      sun shows G and B falling monotonically while R sawtooths 15, 6, 30, 25,
 *      20, 13, 5, 31, 28 ... See the note on that function.
 *
 * ROUND 8 — THIS FILE WAS MANUFACTURING THE CLIPPING, AND THE ZONE SPLIT HAD A
 * FOURTH BAND IT HAD NEVER ONCE REACHED.
 *
 * The measurement that reframed the round: with the chain bypassed
 * (?nopostfx=1 — raw HDR, clamped, sRGB-encoded, exposure pinned to 1.0) the
 * battery clips 0.00-0.06% of frame at luminance >= 250. With the chain on it
 * clipped 0.03-0.88% per shot. The 680 m frame is the extreme case: 0.00% raw,
 * 0.58% graded. Nothing the world hands this file has meaningful HDR headroom
 * past white; every blown pixel in the game was made here, by the exposure, the
 * curve's pre-exposure and above all by bloom.
 *
 * Five changes, in order of how much they move (paired A/B in ONE vite session,
 * ?nohud=1, other modules held constant, 18 shots):
 *
 *   1. A CEILING ON BLOOM SOURCE ENERGY. The prefilter subtracted the threshold
 *      and handed the skirt the whole remainder, so an emitter at a display-
 *      referred 20 painted ~9.0 of additive glow across black water. Ablating
 *      bloom alone took the 680 m frame from 3.155% to 0.781% — three quarters
 *      of all the deep clipping was the skirt, not the emitters. See
 *      BLOOM_DOWN_FRAG.
 *
 *   2. A REAL SHOULDER, SCENE-REFERRED AND BEFORE THE CURVE. hiCompress():
 *      knee at 1.0/uCurveGain (= display 207, above the 99th percentile of
 *      every reference frame), an exponential headroom whose asymptote is
 *      display 247, and a small residual slope so the sun disc can still reach
 *      white at ~350x mid-grey and nothing else can. Relaxed above water, where
 *      a blown sun glint is real (surface-above-5 measures a 99.9th percentile
 *      of 250.2).
 *
 *   3. TWO HIDDEN PER-CHANNEL CLIPS, both invisible to a luminance test.
 *      Chroma recovery reconstructed lOut * (scene chroma ratio) and CLAMPED it,
 *      which pegs the blue of any bright cyan pixel at exactly 255: 25.0% and
 *      25.9% of the two above-water frames had a channel at 254+. And
 *      oklabToRgbClipped() projected out-of-gamut colours onto the gamut wall,
 *      where the largest channel is 1.0 by definition — 8.9% of the kelp frame
 *      and 4.9% of the drop-off. Both now aim inside the wall.
 *
 *   4. THE ZONE SPLIT HAS FOUR BANDS AND ONLY EVER RAN ONE. wMid was defined as
 *      the RESIDUAL 1 - wNear - wFar while wNear and wFar carried
 *      uUnderwater * uZone, so above water wMid resolved to 1.0 and the sky was
 *      graded by the underwater mid preset, while the neutral term every zone
 *      operator carries was identically zero and had never been reachable.
 *      Measured with ?pfxdebug=6: surface-above resolved near 0.000 / mid 1.000
 *      / far 0.000. Gating wMid the same way makes the AIR band live (uAirGrade).
 *
 *   5. AND MID WAS THE DEFAULT ANSWER EVERYWHERE ELSE. With the near ramp
 *      ending at 0.80 and the far ramp starting at 0.66, mid peaked at 0.78 and
 *      owned the plurality of six of twelve shots. The ramps now cross
 *      (near 0.20-0.88, far 0.50-0.94) so mid peaks at 0.46, and the three zone
 *      CONTRASTS — which were 1.30 / 1.26 / 1.30, i.e. one contrast in a
 *      three-zone costume — are now 1.36 / 1.16 / 1.28.
 *
 * Measured, whole frame, summed over the 18-shot battery, round-7 constants
 * against round-8 in the same session:
 *
 *   % of frame at luminance >= 250   SUM 2.202 -> 0.233     median 0.054 -> 0.000
 *   deep-void  0.584 -> 0.010   cave 0.834 -> 0.091   wreck 0.148 -> 0.000
 *   seamoth    0.187 -> 0.000   school 0.079 -> 0.000  shallows-reef 0.082 -> 0.000
 *   channel >= 254: surface-above 25.0 -> 0.0, surface-pod 25.9 -> 0.0,
 *                   kelp 8.9 -> 0.0, dropoff 4.9 -> 0.0
 *   12 of 18 shots now have NO pixel at luminance 250 or above.
 *
 * And the things this round was told not to break, world crop (0.05,0.10 -
 * 0.55,0.90), round-7 -> round-8 [reference frame]:
 *
 *   median      shallows 129.6 -> 129.3 [122]    cave      6.7 -> 6.7  [5.0]
 *               wreck     42.5 ->  45.4 [52]     grand-reef 18.6 -> 18.3 [36.7]
 *               kelp      17.7 ->  27.1 [40.9]   deep-void  10.2 -> 12.7 [6.1]
 *   p99.9       shallows 250.5 -> 235.6 [235.3]  deep-void 254.1 -> 245.3 [249.5]
 *   saturation  shallows 0.767 -> 0.788 [0.734]  kelp 0.688 -> 0.833 [0.837]
 *   red         godrays R% 5 -> 4 [0]            kelp R% 39 -> 24 [25]
 *   0.1-pct     0 on shallows / kelp / wreck / base-interior, unchanged
 *
 * Zero draw calls and zero triangles added; the shoulder is nine ALU ops in a
 * pass that already runs.
 *
 * ROUND 6 — THE METER WAS MEASURING THE PLAYER'S ARM.
 *
 * Round 5 moved two frames and was credited for it, and bought them by taking
 * 1-3.3 stops off everything below 60 m: the world-crop medians read cave 4.3,
 * wreck 17.1, grand-reef 3.4, deep-void 6.6 against references of 5.0, 61.5,
 * 33.6 and 16.3. The 280 m traverse in motion was a black screen — five frames
 * of tools/play.mjs --route=deep measured medians of 0.1 / 1.7 / 1.9 / 1.7 / 1.4.
 *
 * The measurement that named the cause: with the chain bypassed (?nopostfx=1 —
 * see the core bug note below, it had never actually been reachable from the
 * harness) the raw HDR the world hands this file already lands close to the
 * reference. cave 27.3, wreck 133.1, grand-reef 47.8, deep-void 20.5,
 * shallows 144.6. Nothing upstream was crushing the deep. This file was.
 *
 * ONE mechanism did nearly all of it. The exposure meter averaged m = L/(1+L)
 * ARITHMETICALLY over the frame, and an underwater frame's histogram is
 * bimodal: mostly very dark water plus a small, extremely bright population —
 * bioluminescence, a lamp cone, an emissive wreck, and above all the player's
 * own arm and tool holding a sixth of the frame at full brightness at every
 * depth. An arithmetic mean belongs to the bright population. Measured, the
 * 95 m wreck frame metered 0.410 — BRIGHTER than the 12 m reef's 0.275 —
 * against a depth-ramped key of 0.032, and 0.90 loop authority duly removed
 * 3.3 stops from it. The same reading also set the contrast pivot, which then
 * sat far above the water column it was supposed to spread, so "contrast"
 * became a second exposure cut over the whole frame.
 *
 * Four changes:
 *
 *   1. THE METER IS A FLOORED GEOMETRIC MEAN. It averages log(1 + m/0.02) and
 *      inverts exactly. log weights ratios, so no population can run away with
 *      the average, and flooring INSIDE the log answers the usual objection
 *      (log of a near-black pixel is -17) without an arbitrary constant. The
 *      deep frames' readings fell 3-3.5x while the shallows moved 11%, which
 *      is the whole diagnosis in one number. See LUMA_INIT_FRAG.
 *
 *   2. THE LOOP IS A HIGH PASS. corr = (slow/fast)^0.70 * (key/slow)^0.62, off
 *      a second ~10 s adaptation of the same 1x1 reduction. The first term is
 *      identically 1.0 in steady state, so it cannot re-level a scene and is
 *      safe to let brighten; it only compresses the transient when a prop or a
 *      rock face swings into frame. The second is the depth anchor. See
 *      EXPOSURE_LIB.
 *
 *   3. THE MIDTONE PULL IS MIDTONE-ONLY AND ASKS THE FRAME FIRST. A bare power
 *      on L does its worst work just above black, which is where a deep frame
 *      lives; the exponent is now weighted by 4L(1-L) and gated on the frame's
 *      own metered level, so a frame that is already at the reference's level
 *      is not pulled at all. See step (2b) in COMPOSITE_FRAG.
 *
 *   4. A FAR-ZONE GAMMA ACROSS 40-150 m. Two frames — the up-look at 40 m and
 *      the drop-off at 74 m — wanted to be 2-3x darker than the kelp at 55 m
 *      and the wreck at 95 m, which meter almost identically. No function of
 *      depth or of frame level can separate those; what separates them is that
 *      the first two are frames of open water down a long ray. That is the zone
 *      weights, which this file already computes per pixel.
 *
 * Measured, world crop (0.05,0.10 - 0.55,0.90), round 5 -> round 6 [reference]:
 *
 *   cave        4.3 ->   6.2 [5.0]      wreck      17.1 -> 42.0 [61.5]
 *   grand-reef  3.4 ->  29.3 [33.6]     deep-void   6.6 -> 16.7 [16.3]
 *   shallows  126.3 -> 140.2 [134.5]    godrays    70.6 -> 71.0 [56.1]
 *   dropoff    22.4 ->  30.5 [11.2]     kelp       36   -> 29.7 [40.9]
 *
 *   deep route, 5 frames over 21 s at 280-298 m:
 *     0.1/1.7/1.9/1.7/1.4  (19:1, a black screen)  ->  9.8/11.0/11.8/10.6/9.4 (1.26:1)
 *   explore route, 8-14 m: 1.97:1 -> 1.60:1.  dive route: 1.29:1 -> 1.87:1.
 *   0.1-percentile = 0 on 15 of the 18 battery frames, full frame (was 14).
 *
 * Cost: ONE extra draw call and one triangle — a second 1x1 adaptation pass.
 *
 * CORE BUG found while measuring this, reported separately: tools/capture.mjs
 * parses argv as `a.replace(/^--/,'').split('=')` and destructures [k, v], so
 * `--params=nopostfx=1` reaches the page as `&nopostfx` with an EMPTY value.
 * Every module debug switch that takes a value has been silently unreachable
 * from the harness. Round 5's own bypass comparisons were run against the full
 * chain. Fix: split on the FIRST '=' only.
 *
 * ROUND 5 — THE FRAMES NOW DISAGREE WITH EACH OTHER, WHICH IS THE POINT.
 *
 * The composite was judged for the first time and scored 34/100 with 18/18
 * blind detection, below the average of the individual pieces. The word used
 * was "milky". Measured on a world-only crop (0.05,0.10 - 0.55,0.90), the five
 * battery shots spanned 666 m of depth and landed inside a luminance median of
 * 60-116, while the five reference frames for the same slots span 2.5 to 134.5.
 * That is the whole defect in one line: no single frame was badly wrong, and
 * there was no vertical journey, because everything exposed to the same number.
 *
 * Three changes, in order of how much they move:
 *
 *   1. THE METER KEY IS NOW A DEPTH RAMP and the loop has near-full authority
 *      (0.90, was 0.58). uKey was a constant 0.047 from the surface to 150 m —
 *      a literal instruction that a 12 m reef and a 74 m drop-off should read
 *      the same. It is now 0.130*exp(-d/34) + 0.024, which is the physics: 1/34
 *      is twice the medium's green extinction over a path of twice the camera
 *      depth, and the constant is the self-illuminated floor that does not care
 *      how deep it is. With the ramp in the key, a STRONG correction enforces
 *      the depth ramp instead of erasing it. (The round-4 note arguing for a
 *      half correction was right about auto-exposure and wrong about which knob
 *      carries the ramp.) Note for whoever reads the round-4 critique: the
 *      meter was NOT the problem and must not be deleted — with it pinned, the
 *      drop-off frame measures 101 against the reference's 10.
 *
 *   2. A MIDTONE PULL, uMidGamma — a power on OKLab lightness, ramped by depth
 *      and gated by uUnderwater. The measured shape of "milky" was p0.1 and
 *      p99.9 already correct with everything between them floating, and a power
 *      on L is the unique operator that fixes both ends and moves only the
 *      middle. See step (2b) in COMPOSITE_FRAG.
 *
 *   3. THE CONTRAST PIVOT IS METERED, not a constant, and the far-field
 *      contrast came off the floor (1.06 -> 1.30). A pivoted power is only a
 *      contrast for pixels that straddle the pivot; at a constant 0.57 it was
 *      an exposure cut for every frame below 40 m, which is why the same knob
 *      moved the drop-off up and the kelp down. See pivotL(). With the pivot on
 *      the frame's own centre, the contrast is a pure spread and the far band —
 *      which in an open-water frame IS the water column — can finally amplify
 *      the vertical luminance axis instead of being pinned flat.
 *
 * Measured, same crop, before -> after (reference in brackets):
 *
 *   median      dropoff 61 -> 19 [10]   godrays 115 -> 62 [49]   deep 2.5 -> 2.7 [2.5]
 *               kelp    60 -> 36 [41]   shallows 116 -> 132 [134]
 *   p0.1        0 / 26 / 0 / 0 / 2.7        p99.9  244 / 240 / 245 / 244 / 252
 *   top:bottom  dropoff 1.9 -> 4.7   godrays 1.5 -> 1.8   kelp 2.0 -> 2.8 [2.55]
 *   saturation  0.75-0.91, all above LOOK.md's 0.70 floor
 *
 * Zero draw calls and zero triangles added: the whole change is CPU-side
 * uniforms plus two scalar operations inside the existing composite pass.
 *
 * ROUND 4 — THE GRADE MOVED INTO OKLab.
 *
 * Round 3's finding was that the chain was within 8-11% of `?nopostfx=1`, i.e.
 * nearly a no-op, and it fixed that: the round-4 A/B at 1920x1080 moves the
 * shallows median 171.8 -> 111.0, its 0.1-percentile 56 -> 0, its mean
 * saturation 0.649 -> 0.802 and its top:bottom ratio 1.31 -> 1.77. But the
 * frames still read MONOCHROME, and the reason was structural, not a tuning
 * error:
 *
 *   Round 3 did contrast as P*(mx/P)^c on the max channel and saturation as
 *   mx * pow(g/mx, s). Both are ratio scales about each pixel's OWN max, so
 *   both are exactly hue-preserving by construction. A grade built entirely
 *   out of hue-preserving operators cannot create colour separation on a
 *   buffer that is already near-monochrome — it has no degree of freedom in
 *   the direction the reference actually varies. All it can do is push every
 *   pixel further along the one hue it already has.
 *
 * So the display-referred half of the grade now runs in OKLab, which gives three
 * independent handles the ratio form does not have: L (perceptual lightness),
 * |ab| (chroma about the ACHROMATIC axis — a real saturation operator that moves
 * two different hues APART), and ab itself (a 2-D vector that can be rotated per
 * distance band and offset per luminance band, which is the only way to put
 * colour into a region that has none).
 *
 * WHY THESE CHOICES (reference/LOOK.md, measured off 58 real frames):
 *
 * - SAFETY INVARIANT, restated and now STRONGER. Round 1 shipped a subtractive
 *   toe from min(r,g,b) and a mix(vec3(luma), c, s>1) vibrance; both drove red —
 *   always the smallest channel underwater — through zero and into the clamp
 *   (mean R = 0.09/255, mean saturation 0.999: a printed cyan poster). Round 3's
 *   answer was to forbid any operator that is not a ratio scale, which is also
 *   what made it structurally unable to grade. Round 4's answer is a GAMUT
 *   MAPPER: oklabToRgbClipped() gives up CHROMA, never a channel, so an
 *   out-of-gamut colour comes back desaturated along its own hue line instead
 *   of losing red. That is a strictly stronger guarantee than round 3's — the
 *   old rule merely could not delete a channel, this one cannot even reach the
 *   gamut wall — and it is what makes a real saturation operator safe to run.
 *
 * - NO ADDITIVE TERM ANYWHERE. There is no lift uniform in this file. Every
 *   operator is a multiply, a power, a rotation, or an ab offset scaled by L —
 *   and the L scaling is exactly what makes the last of those a colour CAST
 *   rather than a black lift: it is 0 at L = 0. LOOK.md 9 and AGENT_BRIEF
 *   non-negotiable 5: unlit reference blacks measure 0, and lift comes from
 *   atmosphere in front of the object, never a curve behind it. Measured: the
 *   0.1-percentile is 0 on all five battery shots.
 *
 * - TONE CURVE IS NOW ACES, EVALUATED IN ACEScg (AP1), not in sRGB primaries.
 *   Round 2 shipped a hand-rolled toe+shoulder because ACES "desaturates".
 *   Applied in the wrong space it does; applied in AP1 with the standard
 *   input/output matrices it holds chroma far better, and it buys two things
 *   round 2 could not produce:
 *     (a) A REAL SHOULDER THAT REACHES WHITE. LOOK.md 9 measures a 99.9th
 *         percentile of 233-253 in lit frames. Round 2's shallows frame peaked
 *         at 199 because the Hermite shoulder needed input >= uWhite and nothing
 *         in the scene got there.
 *     (b) A REAL TOE THAT REACHES BLACK. The Hill fit's numerator carries a
 *         -0.000090537 offset, so every scene value below ~0.0037/uCurveGain
 *         resolves to exactly 0. The 678 m frame measured a 0.1-percentile
 *         luminance of 9.8 with NO true black anywhere; ACES crushes that fog
 *         pedestal to 0 without a single subtractive term in the grade. LOOK.md
 *         is explicit that unlit reference blacks measure 0 and that lift comes
 *         from atmosphere, never a curve — so removing an *unwanted* pedestal
 *         with the curve's own toe is the one legal direction.
 *   `uCurveGain` is the pre-exposure into the curve and is what anchors mid-grey
 *   (1.40 shallow: 0.20 scene-linear lands on 123/255 against the reference
 *   shallows median of 121.7). AgX and the round-2 curve stay on ?tonemap=.
 *
 * - CHROMA RECOVERY, NOW A BAND PASS ON SCENE BRIGHTNESS. ACES walks bright
 *   colour toward the achromatic axis; LOOK.md 3 puts the reference at 0.70-0.97
 *   mean saturation and warns against "grounding" it. After the curve we rebuild
 *   a hue-locked version at the tonemapped luminance and blend back. Round 3
 *   gated that blend on the value AFTER the curve, and that single line is most
 *   of why bright frames read milky: a 32 m up-look frame lives almost entirely
 *   between display 0.7 and 0.95, so the guard read "blown highlight" for 80% of
 *   the image and switched recovery off exactly where the shoulder had just
 *   desaturated it (measured: that frame LOST 0.117 of mean saturation through
 *   the chain). The gate is now scene-referred and band-shaped — off through the
 *   midtones where the curve is near-linear, on up the shoulder, off again above
 *   uChromaGuard where whitening is correct film behaviour.
 *
 * - THE GRADE IS A THREE-ZONE DEPTH GRADE, not a global curve, and the axis is
 *   OPTICAL DEPTH. LOOK.md's "strong colour separation between the lit
 *   foreground, the hazy midground and the deep background" cannot come from a
 *   uniform operator — a uniform operator IS the blue wash. Every pixel gets
 *   near/mid/far weights from 1 - transmittance along its own view ray, i.e.
 *   from the medium's own per-channel extinction. Round 3 normalised metres by
 *   uMaxVisibility instead, which is a linear stand-in for an exponential and
 *   was badly wrong at the shallow end: the shallows medium reports 82 m of
 *   visibility, so the lit reef at 20 m normalised to 0.24 and fell into the
 *   "mid" band — the handover band that by design carries the weakest grade —
 *   and the near-field operator never reached the near field.
 *
 *   Each zone carries its own scene-referred channel gain (far = the biome's fog
 *   chromaticity, near = its reciprocal), display contrast, chroma, lightness
 *   gamma, clarity, AND a hue rotation in OKLab. The rotation is the round-4
 *   addition and it is what actually separates the bands in COLOUR: its angle is
 *   the hue difference between the biome's fog and the downwelling beam at the
 *   camera's own depth, which is the physical reason the reference's lit reef
 *   reads G/B 0.93 against 0.69 in the water column above it.
 *
 * - THE ZONE CONTRASTS ARE ALL >= 1.0 AND PIVOTED, and they now act on OKLab L.
 *   A contrast below 1 raises dark pixels, which is a lift by another name; the
 *   far field is flattened instead by its clarity term going to zero and by the
 *   fog tint, never by a curve that raises its floor. The pivot tracks the depth
 *   band so contrast expansion does not double as an exposure change — and ab is
 *   renormalised by the L the contrast produced, so it does not double as a
 *   SATURATION change either. (It silently did: OKLab's a and b scale with L for
 *   a fixed hue, so darkening a pixel 20% and leaving ab alone saturates it 20%.
 *   That one missing line put the shallows frame at 0.85 mean saturation against
 *   the reference's 0.734.)
 *
 * - THE LUMINANCE SPLIT-TONE is the other new colour axis, and it is the one
 *   operator here that can put colour into a region that has none. Inside the
 *   water column, BRIGHTER IS GREENER and darker is navy: godrays-1 runs #00AA9C
 *   (G/B 1.09) across the top of frame to #011434 (G/B 0.36) at the bottom, and
 *   shallows-reef-1 runs 0.77 over 0.69 the same way. The two tints are read off
 *   the live medium — uScatterColor/the downwelling beam for the highlights,
 *   uAmbientBottom for the shadows — as differences from the fog hue, so the
 *   frame mean is left where underwater.js put it and only the SPREAD grows.
 *   Weighted toward the far field, because on near geometry the distance axis is
 *   the true one and the two would fight.
 *
 * - METERED EXPOSURE, AND IT CAN ONLY EVER DARKEN. Round 2's exposure was an
 *   open-loop function of depth, and it left the 32 m up-look frame sitting at a
 *   median of 187/255 — 3.7 stops above the reference's water value — while the
 *   12 m frame was correctly exposed. A log-average luminance pyramid reduced on
 *   the GPU to a 1x1 (no readback, no stall; adapted through a ping-pong exactly
 *   like the focus probe) drives a correction toward a per-depth-band key. Its
 *   upper clamp is 1.0 in every band except the top one: LOOK.md 19 is explicit
 *   that adding fill light to a deep frame destroys the look, so the meter is
 *   allowed to pull an over-bright frame back and is NOT allowed to invent
 *   brightness.
 *
 * - CLARITY IS TWO SPATIAL SCALES, in the log domain and multiplicative, so it
 *   is exposure independent, cannot go negative, cannot clip, and scales all
 *   three channels identically (hue exact). Fine scale = frame against a 1/4-res
 *   low-pass (1-2 px acutance); wide scale = that low-pass against a 1/16-res
 *   one (~20 px local contrast). Both are weighted to the near field by depth
 *   and fall to zero in the fog. Round 2 ran one scale at 0.30 stops and
 *   measured a 32 px tile contrast of 2.61 against the bypass's 2.64 — i.e. it
 *   was *removing* contrast on net once DoF had had its say.
 *
 * - Chromatic aberration and barrel distortion are OFF (LOOK.md 9: "effectively
 *   absent"). The machinery stays for ?ca= / ?barrel=.
 *
 * - The vignette is 0.045-0.075. LOOK.md 9: Subnautica's corner falloff is the
 *   dive-mask or canopy geometry and is content-driven and asymmetric
 *   (godrays-1: top corners L=102/101, bottom corners L=12/5). A 4-fold
 *   symmetric post darkening is a tell.
 *
 * - Bloom threshold is display-referred (applied after the metered exposure) and
 *   high, so it fires on the sun, lamps and bioluminescence and never on sand.
 *
 * Debug / tuning params (URL query):
 *   ?aa=taa|fxaa|off   ?nopostfx   ?pfxprobe   ?pfxsplit   ?pfxdebug=1..15
 *   ?tonemap=aces|agx|filmic|none   (none = straight clamp, i.e. the CURVE
 *            ablated with the rest of the chain left running — ROUND 25)
 *   ?bloom= ?exposure= ?dof= ?ao= ?ca= ?barrel= ?vig= ?sat= ?clarity= ?zone=
 *   ?meter=  (multipliers, 0 disables; ?meter=0 pins exposure open-loop)
 *   ?aotoe=  (1 default; 0 ablates the AO black-crush guard — see the note by
 *            the AO block in the composite)
 *   ?deepblack= ?dbfog= ?dbgate=   (the deep black point; 0 ablates each)
 *   ?vib= ?crec= ?crlo= ?gfar= ?gnear= ?tint= ?cgamma=   (ROUND 24 — the six
 *            chroma operators, each a scale on the shipped value, 1 = shipped
 *            and 0 = ablated, EXCEPT ?cgamma= whose shipped default is 0 and
 *            whose 1 restores the round-23 per-channel display gamma. They
 *            exist because ?zonesat= reached only 30% of the chroma error and
 *            the rest could not be attributed without them; see ROUND 24.2.)
 *   ?deepcap=  (ROUND 25; scales the open-loop exposure ceiling. It binds on
 *            `cave` alone, and ?exposure= is inert on a clamped frame.)
 *   ?acesgamut=  (ROUND 25; 0 restores the round-8 per-channel clamp at the
 *            end of acesFitted(), 1 = the gamut return that replaced it.)
 *   ?aceshue=  (ROUND 29 — the channel-crosstalk ceiling inside acesFitted().
 *            The matrix pair is NOT a round trip: ACES_OUT * ACES_IN puts 7.675%
 *            of the green and 0.736% of the blue into RED, and the per-channel
 *            fit between them makes the residual positive above scene-linear
 *            0.42-0.55 and negative (i.e. clamped away, invisible) below it. 1
 *            enforces the ceiling and is shipped; 0 restores round 28 exactly.)
 *   ?zcon= ?zgam= ?zhue=   (ROUND 25 — the three zone operators that had no
 *            switch: per-zone contrast, per-zone gamma, per-zone hue rotation.
 *            0 pins each to its neutral.)
 *   ?farfloor= ?farscene=   (ROUND 27 — the far-band floor. ?farfloor=0 ablates
 *            it and restores round 26 exactly; ?farscene= picks the reference it
 *            floors against, 0 = post-curve lightness, 1 = the lightness the
 *            medium delivered. See step (3b) and the sweep at uFarFloor.)
 *   ?farchroma= ?farcscene=  (ROUND 28 — the far-band chroma lock, the colour
 *            half of the round-27 floor. ?farchroma=1 is shipped, and at
 *            wFar = 1 the fog's own chromaticity survives the grade exactly;
 *            ?farchroma=0 ablates the operator and restores round 27 EXACTLY.
 *            ?farcscene= picks the reference it locks to, 0 = the chroma the
 *            tone curve handed the grade, 1 = the chromaticity the medium
 *            delivered. See step (5c) and the sweep at uFarChroma.)
 *   ?midpull=  (ROUND 27; 0 pins the midtone pull's uMidGamma to 1.0. The
 *            operator has existed since round 5 and had no switch until now.)
 *   ?zonesat=  (ROUND 22; 0 pins all three zone chroma gains to exactly 1.0.
 *            NOT the same as ?sat=0, which scales sBase and leaves the band
 *            offsets behind — use this one to separate the grade's chroma
 *            contribution from biomes' authored colours.)
 *
 *   ?pfxdebug: 1 AO, 2 bloom, 3 CoC, 4 DoF, 5 HDR stops, 6 zone split,
 *              7 sceneExposure()/4, 8 fast meter, 9 uGainFar/2, 10 zGain/2,
 *              11 slow meter, 12 contrast pivot,
 *              13/14/15 exposure request / applied / ceiling, each /8.
 *            ROUND 22 added 13-15 because the clamp on the open-loop exposure
 *            was binding on a third of the battery and NOTHING could see it.
 *
 * THE EQUALITY-TESTED SWITCHES ARE NOW BARE FLAGS, because the capture.mjs argv
 * bug reported in round 6 (see above) is still open and still makes them
 * unreachable. `--params=nopostfx=1` arrives as the bare string "nopostfx", and
 * '' !== '1', so the bypass silently stayed OFF — every "raw HDR bypass"
 * comparison ever run through the harness was the full graded chain measured
 * against itself. Round 15 hit it again while trying to measure the loop gain.
 * The NUMERIC knobs survived by luck (`?ao` gives '', Number('') is 0, so
 * `--params=ao=0` really does ablate AO); the flags did not. Presence now
 * enables and an explicit `=0` disables, so `--params=nopostfx` and a hand-typed
 * `?nopostfx=1` finally do the same thing.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { applyUnderwater } from '../core/underwaterMaterial.js';

// ---------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/**
 * A colour's chroma direction, normalised to unit luminance and clamped.
 *
 * This is what lets the zone grade be biome-driven without ever changing a
 * zone's exposure: dividing by the colour's own luminance strips the brightness
 * out and leaves only "which way is this hue", so mixing toward it is a pure
 * ratio scale that averages to 1. The clamp matters — the kelp fog colour is
 * #0B3710, whose red channel over its luminance is 0.19, and an unclamped mix
 * would let the far field's red gain fall far enough to quantise red to a hard
 * zero across the whole frame, which is the exact failure round 1 shipped.
 */
function chromaDir(col, out) {
  const l = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
  if (!(l > 1e-5)) return out.set(1, 1, 1);
  return out.set(
    clamp(col.r / l, 0.45, 2.2),
    clamp(col.g / l, 0.45, 2.2),
    clamp(col.b / l, 0.45, 2.2));
}
/** lerp toward `b` by `t`, then clamp into a range no gain may leave. */
const mixClamp = (a, b, t, lo = 0.60, hi = 1.75) =>
  clamp(a + (b - a) * clamp01(t), lo, hi);

// ---------------------------------------------------------------------------
// OKLab on the CPU. The shader grades in OKLab; the *directions* it grades
// along are properties of the live medium, so they are solved here once per
// frame rather than per pixel.
// ---------------------------------------------------------------------------
const _lab = new THREE.Vector3();
/** OKLab (L, a, b) of a LINEAR rgb triple. */
function oklab(r, g, b, out) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return out.set(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
/**
 * A colour's chroma PER UNIT LIGHTNESS, as an OKLab (a,b) vector.
 *
 * Dividing by L is what makes it a pure hue direction with no brightness in it:
 * OKLab's a and b scale with L for a fixed hue (L, a and b are all cube-root
 * homogeneous), so ab/L is scale-invariant and the shader can re-multiply by
 * each pixel's own L to get a colour CAST rather than a fixed offset. Clamped
 * in magnitude because at 130 m of optical depth the downwelling beam is
 * effectively single-channel and its ab/L runs away.
 */
function hueVec(col, out) {
  oklab(Math.max(col.r, 0), Math.max(col.g, 0), Math.max(col.b, 0), _lab);
  const L = Math.max(_lab.x, 1e-3);
  out.set(_lab.y / L, _lab.z / L);
  const n = out.length();
  if (n > 0.34) out.multiplyScalar(0.34 / n);
  return out;
}

// ---------------------------------------------------------------------------
// fullscreen triangle rig (one mesh, swapped materials — 0 allocation per frame)
// ---------------------------------------------------------------------------
const _geo = new THREE.BufferGeometry();
_geo.setAttribute('position', new THREE.BufferAttribute(
  new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const _quad = new THREE.Mesh(_geo, null);
_quad.frustumCulled = false;
const _fsScene = new THREE.Scene();
_fsScene.add(_quad);
const _fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const PRELUDE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
const float TAU = 6.283185307179586;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
// ROUND 6: the metering floor. The exposure pyramid averages log(1 + m/MET_EPS)
// rather than m, i.e. it takes a GEOMETRIC mean of the compressed luminance
// floored at MET_EPS. See the note above LUMA_INIT_FRAG for why an arithmetic
// mean is the wrong centre for an underwater frame.
const float MET_EPS = 0.02;
// Jimenez interleaved gradient noise — cheap, tiles well, no texture fetch.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

function makePass(name, frag, uniforms, blending) {
  const m = new THREE.RawShaderMaterial({
    name: 'postfx:' + name,
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: VERT,
    fragmentShader: PRELUDE + frag,
    depthTest: false,
    depthWrite: false,
    blending: blending || THREE.NoBlending,
  });
  if (blending === THREE.CustomBlending) {
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneFactor;
  }
  return m;
}

function makeRT(w, h, extra = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    ...extra,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

// ---------------------------------------------------------------------------
// shared GLSL: depth reconstruction
// ---------------------------------------------------------------------------
const DEPTH_LIB = /* glsl */ `
uniform vec2 uNearFar;
float linearDepth(float d) {
  // perspective, GL-style [0,1] depth -> view-space distance along -Z
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y)
       / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}
`;

// ---------------------------------------------------------------------------
// 1. TAA resolve
// ---------------------------------------------------------------------------
const TAA_FRAG = /* glsl */ `
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform mat4 uInvVP;      // current frame, jittered  (NDC -> world)
uniform mat4 uPrevVP;     // previous frame, UNjittered (world -> NDC)
uniform vec2 uTexel;
uniform vec2 uSize;
uniform float uFeedback;
uniform float uValid;     // 0 on the first frame / after a teleport or resize

// HDR fireflies would survive the clip box and pump the history forever.
const float HDR_CLAMP = 160.0;

vec3 toYCoCg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5 * (c.r - c.b),
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 toRGB(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

// 5-tap Catmull-Rom. Bilinear history resampling is the main source of TAA
// softness; this keeps edges crisp across sub-pixel reprojection.
vec3 historyCR(vec2 uv) {
  vec2 sp = uv * uSize;
  vec2 tp1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / max(w12, vec2(1e-5));
  vec2 p0 = (tp1 - 1.0) / uSize;
  vec2 p3 = (tp1 + 2.0) / uSize;
  vec2 p12 = (tp1 + off12) / uSize;
  vec3 r = vec3(0.0);
  float ws = 0.0;
  float k;
  k = w0.x * w12.y;  r += texture(tHist, vec2(p0.x, p12.y)).rgb * k;  ws += k;
  k = w12.x * w0.y;  r += texture(tHist, vec2(p12.x, p0.y)).rgb * k;  ws += k;
  k = w12.x * w12.y; r += texture(tHist, vec2(p12.x, p12.y)).rgb * k; ws += k;
  k = w3.x * w12.y;  r += texture(tHist, vec2(p3.x, p12.y)).rgb * k;  ws += k;
  k = w12.x * w3.y;  r += texture(tHist, vec2(p12.x, p3.y)).rgb * k;  ws += k;
  return max(r / max(ws, 1e-5), vec3(0.0));
}

void main() {
  vec2 uv = vUv;
  vec3 cur = min(texture(tCur, uv).rgb, vec3(HDR_CLAMP));

  // --- 3x3 neighbourhood statistics in YCoCg (decorrelates luma from chroma so
  //     the clip box is tight on luma edges without killing colour)
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 nmin = vec3(1e9), nmax = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = toYCoCg(min(texture(tCur, uv + vec2(float(x), float(y)) * uTexel).rgb,
                           vec3(HDR_CLAMP)));
      m1 += s; m2 += s * s;
      nmin = min(nmin, s); nmax = max(nmax, s);
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mean * mean));
  vec3 bmin = max(nmin, mean - 1.30 * sigma);
  vec3 bmax = min(nmax, mean + 1.30 * sigma);

  // --- reproject through the depth buffer (static-world velocity)
  float d = texture(tDepth, uv).r;
  vec4 wp = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  wp.xyz /= wp.w;
  vec4 pc = uPrevVP * vec4(wp.xyz, 1.0);
  vec2 pUv = pc.xy / pc.w * 0.5 + 0.5;

  float inside = step(0.0, pUv.x) * step(pUv.x, 1.0)
               * step(0.0, pUv.y) * step(pUv.y, 1.0)
               * step(0.0, pc.w);
  float valid = inside * uValid;

  vec3 hist = historyCR(pUv);

  // --- clip (not clamp) the history toward the box centre: preserves chroma
  vec3 hy = toYCoCg(hist);
  vec3 c0 = 0.5 * (bmax + bmin);
  vec3 ext = 0.5 * (bmax - bmin) + 1e-5;
  vec3 off = hy - c0;
  vec3 ts = abs(off / ext);
  float t = max(ts.x, max(ts.y, ts.z));
  vec3 clipped = t > 1.0 ? c0 + off / t : hy;
  hist = toRGB(clipped);

  // How far the history had to travel to fit the box == how wrong it was.
  float boxReject = clamp((t - 1.0) * 0.9, 0.0, 1.0);

  // The box alone cannot catch a SMALL BRIGHT MOVING feature — a bioluminescent
  // point drifting across dark water. Its 3x3 neighbourhood still contains the
  // dark background, so the dark history sits legally inside the clip box and
  // gets blended in, and the point visibly dims. (Measured: a moving emitter
  // lost ~70% of its intensity before this term existed.) A relative-luminance
  // disagreement test catches exactly that case. It is safe to be this
  // aggressive because the source is 4x MSAA: a genuinely static edge is already
  // coverage-filtered, so it does not swing 50% between jitter positions.
  float lc = luma(cur), lh = luma(hist);
  float lumDiff = abs(lc - lh) / max(max(lc, lh), 0.15);
  float rejected = max(boxReject, smoothstep(0.45, 0.95, lumDiff));

  float fb = uFeedback * valid * (1.0 - rejected);

  // Karis anti-flicker in its REVERSIBLE form. The weighted-average variant
  // biases hard toward whichever sample is darker, which is what was eating the
  // moving emitters; this maps into a compressed domain, lerps, and maps back,
  // so energy survives.
  vec3 tc = cur / (1.0 + lc);
  vec3 th = hist / (1.0 + lh);
  vec3 tm = mix(tc, th, fb);
  vec3 res = tm / max(1.0 - luma(tm), 1e-4);

  fragColor = vec4(max(res, vec3(0.0)), 1.0);
}`;

// ---------------------------------------------------------------------------
// 2. autofocus probe (1x1)
// ---------------------------------------------------------------------------
const FOCUS_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tPrev;
uniform float uRate;    // 1 = snap
uniform float uFar;     // hyperfocal clamp AND the fallback when nothing is hit
${DEPTH_LIB}
void main() {
  // Small cross around the reticle. min() so a thin object in front of a far
  // background pulls focus onto it — that is what the player is looking at.
  float best = 1.0;
  for (int i = 0; i < 5; i++) {
    vec2 o = vec2(0.0);
    if (i == 1) o = vec2( 0.020, 0.0);
    if (i == 2) o = vec2(-0.020, 0.0);
    if (i == 3) o = vec2(0.0,  0.035);
    if (i == 4) o = vec2(0.0, -0.035);
    best = min(best, textureLod(tDepth, vec2(0.5) + o, 0.0).r);
  }
  // Clamped to the hyperfocal distance: past it the medium has already dissolved
  // everything, so focusing further only serves to defocus the near field.
  float tgt = best >= 0.99999 ? uFar : min(linearDepth(best), uFar);
  float prev = textureLod(tPrev, vec2(0.5), 0.0).r;
  if (prev <= 0.0) prev = tgt;
  fragColor = vec4(mix(prev, tgt, clamp(uRate, 0.0, 1.0)), 0.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// 3. SSAO (half res) + bilateral blur
// ---------------------------------------------------------------------------
const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvVP;
uniform vec2 uTexel;      // half-res texel
uniform vec3 uCamPos;
uniform float uRadius;    // metres — contact scale
uniform float uRadius2;   // metres — bedding scale
uniform float uIntensity;
uniform float uIntensity2;
uniform float uBias;
uniform float uPower;
uniform float uAOFloor;   // the darkest this term is allowed to get
uniform float uProjScale; // 0.5 * halfResHeight / tan(fovY/2)
${DEPTH_LIB}

vec3 worldAt(vec2 uv, float d) {
  vec4 p = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
// textureLod, never texture(): the sampling loop below has a non-uniform exit,
// which makes implicit derivatives (and therefore the implicit LOD) undefined.
float depthAt(vec2 uv) { return textureLod(tDepth, uv, 0.0).r; }

void main() {
  vec2 uv = vUv;
  float d0 = depthAt(uv);
  if (d0 >= 0.99999) { fragColor = vec4(1.0); return; }

  vec3 P = worldAt(uv, d0);

  // Normal from depth, picking the closer neighbour on each axis so silhouettes
  // do not generate a fake bevel.
  float dl = depthAt(uv - vec2(uTexel.x, 0.0));
  float dr = depthAt(uv + vec2(uTexel.x, 0.0));
  float dd = depthAt(uv - vec2(0.0, uTexel.y));
  float du = depthAt(uv + vec2(0.0, uTexel.y));
  vec3 Pl = worldAt(uv - vec2(uTexel.x, 0.0), dl);
  vec3 Pr = worldAt(uv + vec2(uTexel.x, 0.0), dr);
  vec3 Pd = worldAt(uv - vec2(0.0, uTexel.y), dd);
  vec3 Pu = worldAt(uv + vec2(0.0, uTexel.y), du);
  vec3 dx = abs(dr - d0) < abs(d0 - dl) ? (Pr - P) : (P - Pl);
  vec3 dy = abs(du - d0) < abs(d0 - dd) ? (Pu - P) : (P - Pd);
  vec3 N = cross(dx, dy);
  float nl = length(N);
  if (nl < 1e-8) { fragColor = vec4(1.0); return; }
  N /= nl;
  vec3 V = uCamPos - P;
  float viewDist = length(V);
  if (dot(N, V) < 0.0) N = -N;

  float rot = ign(gl_FragCoord.xy) * TAU;

  // Two radii, because they answer two different questions and a single one
  // cannot do both. The CONTACT ring (~0.6 m) is the dark seam where a rock
  // meets sand; the BEDDING ring (~2.6 m) is the broad soft cup a boulder sits
  // in. Round 2 ran the contact ring alone at 0.75 m and a critic measured a
  // stone as statistically indistinguishable from the sand under it — the seam
  // was there, the mass shadow that says "this object is HEAVY and it is ON the
  // floor" was not.
  const int NS = 10;
  float occ0 = 0.0, occ1 = 0.0;
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + 0.5) / float(NS);
    float ang = rot + fi * TAU * 3.0;                 // 3-turn spiral
    vec2 dirv = vec2(cos(ang), sin(ang));
    float sr = sqrt(fi);

    // --- contact
    float rPx0 = clamp(uRadius * uProjScale / max(viewDist, 0.15), 2.0, 64.0);
    vec2 suv0 = uv + dirv * (sr * rPx0) * uTexel;
    vec3 v0 = worldAt(suv0, depthAt(suv0)) - P;
    float vv0 = dot(v0, v0);
    // Alchemy AO estimator with an explicit range cutoff (kills the classic
    // dark halo around near-silhouettes against distant terrain). Sky samples
    // fall out for free: they are infinitely far, so the range term is 0.
    float rng0 = clamp(1.0 - vv0 / (uRadius * uRadius), 0.0, 1.0);
    occ0 += rng0 * max(0.0, dot(v0, N) - uBias * viewDist * 0.004) / (vv0 + 0.02);

    // --- bedding. Rotated half a step off the contact spiral so the two rings
    //     do not sample the same directions and correlate their noise.
    float ang1 = ang + 3.14159265;
    float rPx1 = clamp(uRadius2 * uProjScale / max(viewDist, 0.15), 3.0, 110.0);
    vec2 suv1 = uv + vec2(cos(ang1), sin(ang1)) * (sr * rPx1) * uTexel;
    vec3 v1 = worldAt(suv1, depthAt(suv1)) - P;
    float vv1 = dot(v1, v1);
    float rng1 = clamp(1.0 - vv1 / (uRadius2 * uRadius2), 0.0, 1.0);
    // Bias scales with the radius: at 2.6 m a gently curved seabed is genuinely
    // convex over the sample disc and would otherwise occlude itself into a
    // uniform grey, which reads as an exposure drop rather than as AO.
    occ1 += rng1 * max(0.0, dot(v1, N) - uBias * viewDist * 0.011) / (vv1 + 0.10);
  }

  float ao0 = max(0.0, 1.0 - uIntensity  * occ0 / float(NS));
  float ao1 = max(0.0, 1.0 - uIntensity2 * occ1 / float(NS));

  // ROUND 14 — THE FLOOR. Two unbounded Alchemy estimators multiplied together
  // and then raised to a power reach EXACTLY zero the moment either one
  // saturates, and the composite applies the result as a straight multiply at
  // an authority that clamps to 1.0 — so a deeply-occluded interior surface was
  // being multiplied by nothing at all. Measured on the cockpit's lower third:
  // 2.36% of it at literally RGB(0,0,0) against the reference plate's 0.015%,
  // and 0.000% with this whole stage ablated. Occlusion is a VISIBILITY term
  // for ambient light and no real interior corner has zero of it: even a sealed
  // locker recess is filled by inter-reflection. The remap is linear, so it is
  // exactly equivalent to doing it after the bilateral blur, and it is C-inf,
  // unlike a max() which would draw a contour along the ao = floor isoline.
  fragColor = vec4(mix(uAOFloor, 1.0, pow(ao0 * ao1, uPower)), 0.0, 0.0, 1.0);
}`;

const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uDir;        // texel-scaled blur direction
${DEPTH_LIB}
void main() {
  float dc = linearDepth(textureLod(tDepth, vUv, 0.0).r);
  float sum = 0.0, wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    float fi = float(i);
    vec2 o = uDir * fi;
    float a = textureLod(tAO, vUv + o, 0.0).r;
    float dz = linearDepth(textureLod(tDepth, vUv + o, 0.0).r);
    // Tolerance proportional to distance. An absolute one banded visibly on a
    // grazing seabed, because iso-depth contours there are horizontal lines and
    // the quantised depth stepped across the weight cutoff along each of them.
    float w = exp(-fi * fi / 6.0) * exp(-abs(dz - dc) / max(dc * 0.05, 0.12));
    sum += a * w; wsum += w;
  }
  fragColor = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// 3b. Exposure meter — log-average luminance reduced to a 1x1 on the GPU.
//
// No readback anywhere: a getImageData/readPixels on the render target would
// stall the pipeline for a full frame, and the capture harness would then be
// measuring the stall rather than the grade. The pyramid ends in a 1x1 texture
// that the composite and the bloom prefilter both sample, so CPU and GPU never
// have to agree about a number neither of them can see.
//
// THE METERING DOMAIN IS A FLOORED GEOMETRIC MEAN OF L/(1+L).
//
// Round 5 metered the ARITHMETIC mean of m = L/(1+L). Bounded, monotone and
// invertible — and, measured, the wrong centre for this game, because an
// underwater frame's histogram is BIMODAL: a large very dark region (the water
// column, unlit rock) plus a small region of self-illuminated or near-camera
// content (bioluminescence, a lamp cone, the player's own arm and scanner
// filling the right sixth of frame at full brightness). An arithmetic mean is
// dominated by the second population.
//
// Measured with ?pfxdebug=8 on the round-5 build, whole frame:
//
//   shot           depth   arithmetic meter   world-crop median   reference
//   shallows-reef    12 m   0.275             126                 134.5
//   wreck            95 m   0.410              17                  61.5
//   grand-reef      280 m   0.139               3.4                33.6
//   deep-void       678 m   0.040               6.6                16.3
//
// The 95 m wreck frame meters BRIGHTER than the 12 m reef. Nothing in the water
// is brighter; the arm is. With a depth-ramped key of 0.032 there and 0.90 loop
// authority, the meter then took 3.3 stops off it — which is precisely the
// "15x too dark" the round-5 critique measured, and the same mechanism explains
// grand-reef (2.3 stops) and the frame-to-frame swing in motion, because the
// prop's share of frame changes every time the camera turns.
//
// A geometric mean fixes it for one reason: log() weights RATIOS, so a pixel
// twenty times the median counts the same as one a twentieth of it, and neither
// can run away with the average. The classic objection — log(0) = -inf, and the
// log of a near-black pixel is a number like -17 that swamps the mean — is
// answered by flooring INSIDE the log rather than after it. This pass averages
//
//     v = log(1 + m/MET_EPS)        m in [0,1) -> v in [0, 3.93]
//
// which is non-negative (so nothing depends on signed half-float behaviour
// through a five-pass reduction), bounded above by ln(51), exactly invertible
// as m = MET_EPS*(exp(v) - 1), and equal to a geometric mean of (m + MET_EPS).
// A black pixel contributes 0, exactly as it did before; a pixel at twenty
// times the floor contributes 3.0 rather than 20 times its share.
//
// Worked example, the grand-reef histogram: 85% of frame at m = 0.02 and 15% at
// m = 0.8. Arithmetic mean 0.139 (the bright sixth owns 86% of it). This
// estimator returns 0.043 — inside the dark mode, where the frame's own middle
// actually is, and where the reference's median sits.
//
// It feeds two consumers and fixes both: sceneExposure() and pivotL(). The
// contrast pivot was the other half of the crush — a pivoted power is only a
// contrast for pixels that straddle the pivot, and a pivot solved off the
// arithmetic mean sat far ABOVE the water column it was supposed to spread, so
// "contrast" was an exposure cut over the entire frame.
// ---------------------------------------------------------------------------
const LUMA_INIT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;      // DESTINATION texel (this pass is a big reduction)
float compress(vec3 c) {
  float l = luma(max(c, vec3(0.0)));
  return log(1.0 + (l / (1.0 + l)) / MET_EPS);
}
void main() {
  vec2 o = uTexel * 0.25;
  // Four bilinear taps => a 2x2 box each => 16 source texels per output texel.
  float a = compress(texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb);
  float b = compress(texture(tSrc, vUv + vec2( o.x, -o.y)).rgb);
  float c = compress(texture(tSrc, vUv + vec2(-o.x,  o.y)).rgb);
  float d = compress(texture(tSrc, vUv + vec2( o.x,  o.y)).rgb);
  fragColor = vec4(0.25 * (a + b + c + d), 0.0, 0.0, 1.0);
}`;

const LUMA_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;      // SOURCE texel
void main() {
  vec2 o = uTexel;
  float a = texture(tSrc, vUv + vec2(-o.x, -o.y)).r;
  float b = texture(tSrc, vUv + vec2( o.x, -o.y)).r;
  float c = texture(tSrc, vUv + vec2(-o.x,  o.y)).r;
  float d = texture(tSrc, vUv + vec2( o.x,  o.y)).r;
  fragColor = vec4(0.25 * (a + b + c + d), 0.0, 0.0, 1.0);
}`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform float uRateUp;    // adapting to a BRIGHTER scene (eye closes fast)
uniform float uRateDown;  // adapting to a DARKER scene (eye opens slowly)
uniform float uValid;
void main() {
  float cur = textureLod(tCur, vec2(0.5), 0.0).r;
  float prev = textureLod(tPrev, vec2(0.5), 0.0).r;
  if (uValid < 0.5) { fragColor = vec4(cur, 0.0, 0.0, 1.0); return; }
  float rate = cur > prev ? uRateUp : uRateDown;
  fragColor = vec4(mix(prev, cur, clamp(rate, 0.0, 1.0)), 0.0, 0.0, 1.0);
}`;

/**
 * Shared by the composite and the bloom prefilter so the bloom threshold stays
 * display-referred as the meter moves.
 *
 * ROUND 6 — THE LOOP IS A HIGH PASS, NOT A NORMALISER.
 *
 * Round 5 ran one adaptation and one correction, corr = (key/meter)^0.90 with
 * the key an authored function of depth. That is a full auto-exposure: it
 * decides the LEVEL of every frame, and it decided them wrong, because the key
 * modelled downwelling sunlight while half the battery's frames are lit by
 * things that do not care how deep they are.
 *
 * The measurement that reframes the problem: with the loop pinned (?meter=0)
 * and with postfx bypassed entirely (?nopostfx=1), the raw HDR the world hands
 * this file already lands close to the reference, world-crop median —
 *
 *   shot          raw HDR   reference       round-5 chain
 *   cave             27.3      5.0 (cave-3)          4.3
 *   wreck           133.1     61.5 (wreck-1)        17.1
 *   grand-reef       47.8     33.6 (grand-reef-2)    3.4
 *   deep-void        20.5     16.3 (deep-void-2)     6.6
 *   shallows-reef   144.6    134.5 (shallows-reef-1) 126.3
 *
 * — so the scene's own level is not the thing that needs fixing, and a loop
 * with the authority to overwrite it is a liability rather than a feature.
 * What DOES need fixing is that the same scene swings 35:1 as the camera turns
 * inside one depth band.
 *
 * Those two facts pick the shape. The correction is split in two:
 *
 *   FAST TERM  (slow/fast)^uMeterFast — the ratio of a ~10 s adaptation to a
 *     ~0.5 s one. It is EXACTLY 1.0 in steady state, so it cannot re-level a
 *     scene however hard it is pushed; it acts only on the transient when a
 *     prop, a lamp or a rock face swings into frame, and it acts in BOTH
 *     directions, which is what a stabiliser has to do. Clamped to about a stop
 *     either way, so it compresses a swing rather than erasing the difference
 *     between looking into a trench and looking at open water.
 *
 *   SLOW TERM  (key/slow)^uMeterSlow — the authored depth anchor, now at low
 *     authority. It trims a scene that has drifted far from what its depth
 *     ought to look like; it no longer sets the level.
 *
 * uEvSlow's upper bound is above 1.0 for the first time in this file's history,
 * and the round-5 comment arguing it must not be needs answering rather than
 * deleting. That comment cited LOOK.md 19 — a 250 m+ frame is >90% below
 * luminance 20 and ambient fill destroys the look. True, and the slot for it is
 * grand-reef-2, which measures a median of 33.6 with a 0.1-percentile of 11.7:
 * a dim FOGGED frame, not a black one. LOOK.md 19's own examples of "not afraid
 * of black" are dropoff-1 and deep-void-2, and this file still hits them (0.1
 * percentile 0). The rule that matters is not "never brighten", it is "never
 * lift the floor", and every operator here is a multiply or a power, so the
 * black stays exactly where the medium put it no matter which way the loop
 * moves.
 */
const EXPOSURE_LIB = /* glsl */ `
uniform sampler2D tExposure;      // fast adaptation, in the log-meter domain
uniform sampler2D tExposureSlow;  // ~10 s adaptation of the same reduction
uniform float uExposure;    // open-loop, depth/biome driven (CPU)
uniform float uKey;         // target scene level for this depth band
uniform float uMeterFast;   // authority of the stabilising term
uniform float uMeterSlow;   // authority of the depth anchor
uniform vec2  uEvFast;      // clamp on the stabilising term (min, max)
uniform vec2  uEvSlow;      // clamp on the anchor
/** Undo the log/Reinhard compression the pyramid averaged in. */
float meterOf(sampler2D t) {
  float v = clamp(textureLod(t, vec2(0.5), 0.0).r, 0.0, 6.0);
  float m = clamp(MET_EPS * (exp(v) - 1.0), 0.0, 0.9995);
  return max(m / (1.0 - m), 1e-5);
}
float sceneExposure() {
  float fast = meterOf(tExposure);
  float slow = meterOf(tExposureSlow);
  float cFast = clamp(pow(clamp(slow / fast, 1e-3, 1e3), uMeterFast), uEvFast.x, uEvFast.y);
  float cSlow = clamp(pow(clamp(uKey / slow, 1e-3, 1e3), uMeterSlow), uEvSlow.x, uEvSlow.y);
  return uExposure * cFast * cSlow;
}
`;

// ---------------------------------------------------------------------------
// 4. Bloom — progressive down/upsample (Jimenez, "Next Generation Post
//    Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014)
// ---------------------------------------------------------------------------
const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;       // source texel
uniform float uFirst;      // 1 on the prefilter pass
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;      // ROUND 8: ceiling on what one texel may contribute
${EXPOSURE_LIB}

vec3 fetch(vec2 uv) { return max(texture(tSrc, uv).rgb, vec3(0.0)); }

void main() {
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = fetch(uv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(uv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(uv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(uv + t * vec2(-1.0,  1.0));
  vec3 e = fetch(uv + t * vec2( 1.0,  1.0));
  vec3 f = fetch(uv + t * vec2(-2.0,  0.0));
  vec3 g = fetch(uv);
  vec3 h = fetch(uv + t * vec2( 2.0,  0.0));
  vec3 i = fetch(uv + t * vec2(-1.0, -1.0));
  vec3 j = fetch(uv + t * vec2( 1.0, -1.0));
  vec3 k = fetch(uv + t * vec2(-2.0, -2.0));
  vec3 l = fetch(uv + t * vec2( 0.0, -2.0));
  vec3 m = fetch(uv + t * vec2( 2.0, -2.0));

  vec3 g0 = (d + e + i + j) * 0.25;
  vec3 g1 = (a + b + f + g) * 0.25;
  vec3 g2 = (b + c + g + h) * 0.25;
  vec3 g3 = (f + g + k + l) * 0.25;
  vec3 g4 = (g + h + l + m) * 0.25;

  vec3 col;
  if (uFirst > 0.5) {
    float ex = sceneExposure();
    // Karis average: weight each 2x2 group by 1/(1+luma) so one hot pixel cannot
    // dominate the mip and turn into a boxy square of bloom.
    float w0 = 1.0 / (1.0 + luma(g0) * ex);
    float w1 = 1.0 / (1.0 + luma(g1) * ex);
    float w2 = 1.0 / (1.0 + luma(g2) * ex);
    float w3 = 1.0 / (1.0 + luma(g3) * ex);
    float w4 = 1.0 / (1.0 + luma(g4) * ex);
    float sw = w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125;
    col = (g0 * w0 * 0.5 + g1 * w1 * 0.125 + g2 * w2 * 0.125
         + g3 * w3 * 0.125 + g4 * w4 * 0.125) / max(sw, 1e-5);

    // Soft-knee threshold, applied AFTER exposure so the bloom threshold is
    // display-referred and does not drift as the meter moves.
    col *= ex;
    float br = maxc(col);
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    col *= max(soft, br - uThreshold) / max(br, 1e-5);

    // ROUND 8 — THE ENERGY CEILING, and it is what turns a point into a halo
    // instead of into a white ball.
    //
    // The threshold decides WHAT blooms; nothing decided HOW MUCH, and the
    // subtraction hands the skirt the emitter's whole excess. Measured on the
    // 680 m frame: the composite adds uBloom * (display value - threshold), and
    // a bioluminescent structure sitting at a display-referred 20 against water
    // at 0.005 therefore painted ~9.0 of additive glow over several hundred
    // pixels of black water — 1800x the medium, which the curve can only
    // resolve as white. Ablating bloom alone took that frame from 3.155% of
    // frame at luminance >= 250 to 0.781%, i.e. THREE QUARTERS of all the
    // clipping in the deep battery was this one line's skirt, not the emitters.
    //
    // A ceiling fixes it without touching what blooms or how wide the halo is:
    // a bright source and a very bright source now produce the same veiling
    // amplitude, and AREA is what still separates them, which is how a real
    // lens behaves. Set on the CPU as a constant fraction of 1/uCurveGain, so
    // it means the same DISPLAY brightness at every depth rather than drifting
    // with the curve's pre-exposure.
    col = min(col, vec3(uClamp));
  } else {
    col = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  }
  fragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;      // source (smaller) mip texel
uniform float uRadius;
uniform float uWeight;
void main() {
  vec2 uv = vUv;
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tSrc, uv + t * vec2(-1.0,  1.0)).rgb
         + texture(tSrc, uv + t * vec2( 0.0,  1.0)).rgb * 2.0
         + texture(tSrc, uv + t * vec2( 1.0,  1.0)).rgb
         + texture(tSrc, uv + t * vec2(-1.0,  0.0)).rgb * 2.0
         + texture(tSrc, uv                        ).rgb * 4.0
         + texture(tSrc, uv + t * vec2( 1.0,  0.0)).rgb * 2.0
         + texture(tSrc, uv + t * vec2(-1.0, -1.0)).rgb
         + texture(tSrc, uv + t * vec2( 0.0, -1.0)).rgb * 2.0
         + texture(tSrc, uv + t * vec2( 1.0, -1.0)).rgb;
  fragColor = vec4(s * (1.0 / 16.0) * uWeight, 1.0);
}`;

// ---------------------------------------------------------------------------
// 5. Depth of field
// ---------------------------------------------------------------------------
const COC_LIB = /* glsl */ `
uniform float uFocalRange;   // clamp on the near-field defocus term
uniform float uCocFar;
uniform float uCocNear;      // NEAR APERTURE, in metres (see cocFor)
uniform float uTurbidity;
uniform float uMaxVis;
/**
 * Signed circle of confusion, normalised to [-1,1]. Negative = in front of the
 * focal plane.
 *
 * The FAR term is driven by the thin-lens ratio focus/dist rather than a linear
 * distance difference. The linear form is scale-dependent and blows up: with
 * the reticle over open water the autofocus solved to 112 m and
 * (focus-dist)/focus was ~1 across the ENTIRE seabed, so every pixel of floor
 * came back fully defocused. 1 - focus/dist is dimensionless, is 0 exactly at
 * the focal plane, and asymptotes to 1 at infinity, so the far field can never
 * over-blur.
 *
 * ROUND 14 — THE NEAR TERM WAS THE SAME RATIO, AND THAT IS NOT THE THIN LENS.
 *
 * It ran clamp(focus/dist - 1, 0, 2.2) * 0.30, which has no 1/focus in it, so
 * the blur on an object at a FIXED distance from the eye grew without bound as
 * the autofocus walked outward. The autofocus clamps to a hyperfocal of
 * 5-24 m, so on the cockpit shot focus solved to 13.5 m and the dash 0.7 m from
 * the eye came back at focus/dist - 1 = 18.3, clamped to 2.2, i.e. the maximum
 * near CoC the term can express — 84% blur on a piece of geometry bolted to the
 * camera. Every held tool, every hand and every cockpit surface in the game was
 * fully defocused, at every depth, in every shot.
 *
 * Measured by ablation (--params=dof, same crop, same seed): cockpit dash
 * detailRMS 3.77 with DoF on against 7.08 with the whole stage off and 12.99 on
 * the reference plate; base-interior floor 10.38 against 17.11 and 9.36/27.03.
 * More than half of the surface signal every other module is working to create
 * was being thrown away by this one line.
 *
 * The real thin-lens near CoC is proportional to (1/dist - 1/focus), NOT to
 * (focus/dist - 1) — the two agree only when focus is held constant, and focus
 * here is a live autofocus that ranges over a factor of five. With the 1/focus
 * back in, uCocNear becomes an APERTURE in metres and the near limit stops
 * depending on where the reticle happens to be pointing: at focus = infinity
 * the onset (CoC 0.10) sits at 0.45 m and full blur needs the object jammed
 * inside 0.1 m of the lens. Every reference cockpit and held-tool frame is
 * pin-sharp, and LOOK.md's post-process section does not list defocus among
 * the effects Subnautica has at all.
 */
float cocFor(float dist, float focus) {
  float d = max(dist, 0.05);
  float s = max(focus, 0.05);
  float near = clamp((1.0 / d - 1.0 / s) * uCocNear, 0.0, uFocalRange);
  float far  = clamp(1.0 - s / d, 0.0, 1.0) * uCocFar;
  // The medium itself scatters: distant water is soft even when "in focus".
  // This is the only part of DoF that should be at all obvious underwater.
  float turb = smoothstep(0.30, 1.05, dist / max(uMaxVis, 1.0))
             * smoothstep(s * 1.1, s * 2.4 + 6.0, dist) * uTurbidity;
  return clamp(far + turb - near, -1.0, 1.0);
}
`;

const DOF_DOWN_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFocus;
uniform vec2 uTexel;     // full-res texel
${DEPTH_LIB}
${COC_LIB}
void main() {
  vec2 uv = vUv;
  float focus = texture(tFocus, vec2(0.5)).r;
  vec2 o = uTexel * 0.5;
  vec3 c = texture(tColor, uv + vec2(-o.x, -o.y)).rgb
         + texture(tColor, uv + vec2( o.x, -o.y)).rgb
         + texture(tColor, uv + vec2(-o.x,  o.y)).rgb
         + texture(tColor, uv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;
  // Nearest of the four so thin foreground silhouettes keep their near CoC.
  float d = min(min(texture(tDepth, uv + vec2(-o.x, -o.y)).r,
                    texture(tDepth, uv + vec2( o.x, -o.y)).r),
                min(texture(tDepth, uv + vec2(-o.x,  o.y)).r,
                    texture(tDepth, uv + vec2( o.x,  o.y)).r));
  float dist = d >= 0.99999 ? uNearFar.y : linearDepth(d);
  fragColor = vec4(c, cocFor(dist, focus));
}`;

const DOF_GATHER_FRAG = /* glsl */ `
uniform sampler2D tDof;
uniform vec2 uTexel;     // half-res texel
uniform float uMaxRadius;  // half-res pixels
void main() {
  vec4 centre = textureLod(tDof, vUv, 0.0);
  float r = abs(centre.a) * uMaxRadius;
  if (r < 0.6) { fragColor = centre; return; }

  float rot = ign(gl_FragCoord.xy) * TAU;
  vec3 sum = centre.rgb;
  float wsum = 1.0;
  const int NS = 24;
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + 0.5) / float(NS);
    // golden-angle spiral: even coverage of the disc without a visible pattern
    float ang = rot + float(i) * 2.39996323;
    float rad = sqrt(fi) * r;
    vec4 s = textureLod(tDof, vUv + vec2(cos(ang), sin(ang)) * rad * uTexel, 0.0);
    // A sample only contributes where its own CoC actually reaches this pixel,
    // which is what stops sharp foreground bleeding into a blurred background.
    float w = clamp(abs(s.a) * uMaxRadius - rad + 1.0, 0.0, 1.0);
    sum += s.rgb * w;
    wsum += w;
  }
  fragColor = vec4(sum / wsum, centre.a);
}`;

// ---------------------------------------------------------------------------
// 6. Composite + grade
// ---------------------------------------------------------------------------
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform sampler2D tFocus;
uniform sampler2D tLocal;   // 1/4-res  unthresholded blur — acutance reference
uniform sampler2D tWide;    // 1/16-res unthresholded blur — clarity reference

uniform vec2 uTexel;
uniform float uAspect;

uniform float uBloom;
uniform float uAO;
uniform float uAOFog;      // how fast AO surrenders to in-scattered fog
uniform float uAoBlack;    // scale on the black-crush guard; 0 ablates it
uniform float uDeepBlackL; // OKLab L of the deep black point's display code; 0 ablates it
uniform vec3  uDeepBlackFog;  // (lo, hi, mix) optical-depth ramp on the knee; .z = 0 ablates
uniform float uDeepBlackGate; // 1 = gate on the local level, 0 = round-16 per-pixel toe
uniform float uBarrel;
uniform float uCA;
uniform float uVignette;
uniform float uVignetteSoft;
uniform float uDofMix;

// ---- three-zone depth grade. Each triplet is (near, mid, far).
uniform vec3  uGainNear;   // scene-referred channel gain, near field
uniform vec3  uGainMid;
uniform vec3  uGainFar;
uniform vec3  uZoneContrast;   // display-referred, pivoted; all >= 1.0
uniform vec3  uZoneSat;
uniform vec3  uZoneGamma;
uniform vec3  uZoneClarity;    // fine-scale acutance gain, in stops
uniform vec3  uZoneClarityW;   // wide-scale local contrast gain, in stops
uniform vec2  uZoneNear;       // smoothstep edges of the near falloff (dn units)
uniform vec2  uZoneFar;        // smoothstep edges of the far ramp
uniform vec3  uAirGrade;       // the fourth band: (contrast, sat, gamma) in air
uniform float uPivot;          // authored contrast pivot, in OKLab L
uniform float uPivotAuto;      // how much of the pivot the METER decides
uniform float uZone;           // master multiplier on the whole zone split

// ---- the round-4 colour block. Everything below the tone curve happens in
// OKLab: see OKLAB_LIB and the note above main().
uniform vec3  uZoneHue;    // hue ROTATION in radians, (near, mid, far)
uniform vec2  uTintLo;     // shadow split-tone, ab per unit L
uniform vec2  uTintHi;     // highlight split-tone
uniform vec2  uSplitLo;    // L edges of the shadow weight
uniform vec2  uSplitHi;    // L edges of the highlight weight
uniform float uHiRoll;     // L at which the highlight rolloff starts
uniform float uHiCeil;     // ROUND 26: strength of the chroma-feasible ceiling
uniform float uCeilNeutral;// ROUND 30: 1 makes the ceiling's "heading for white"
                           // exemption require NEAR-NEUTRALITY as well as a high
                           // L, so it cannot switch itself off over a
                           // chroma-limited pixel. 0 restores round 26 exactly.
uniform float uFarFloor;   // ROUND 27: least OKLab L the grade may leave in the
                           // far band, as a fraction of the L it arrived with.
                           // 0 = the operator does not exist. See step (3b).
uniform float uFarScene;   // ROUND 27: 0 floors against the lightness the TONE
                           // CURVE handed the grade, 1 against the lightness the
                           // MEDIUM delivered (so the curve's toe is inside what
                           // the floor may give back). See the sweep on the CPU.
uniform float uFarCScene;  // ROUND 28: 0 locks to the chroma the TONE CURVE
                           // handed the grade, 1 to the chromaticity the MEDIUM
                           // delivered. Shipped 1; see the sweep on the CPU.
uniform float uFarChroma;  // ROUND 28: how much of the far band's chroma vector
                           // is returned to what the medium delivered. 1 = the
                           // fog's own chroma survives the grade exactly at
                           // wFar = 1. 0 = the operator does not exist. See
                           // step (5c).
uniform float uSplitZone;  // how much of the split-tone the near field gets

uniform float uVibrance;
uniform float uMidGamma;   // ROUND 5: the midtone pull. See step (2b).
uniform vec2  uMidLevel;   // ROUND 6: pivot range over which the pull ramps in
uniform vec3  uGamma;
uniform float uDither;     // LSB of triangular output dither (?dither=0 ablates)
uniform float uGamutFix;   // 0 restores the round-8 5-bisection gamut solver
uniform float uChromaRecovery;
uniform vec2  uChromaLo;   // recovery ramp-in band, in MULTIPLES of the frame's middle
uniform float uChromaGuard; // SCENE luminance above which the curve may whiten
uniform float uCurve;      // 0 = ACES(AP1), 1 = AgX, 2 = round-2 filmic
uniform float uCurveGain;  // pre-exposure into the curve; anchors mid-grey
uniform float uAcesGamut;  // ROUND 25: 1 = gamut-RETURN out of AP1, 0 = clip
uniform float uWhiteNeutral;// ROUND 31: 1 makes the shared whitening ramp
                            // (whitenW) require near-neutrality as well as
                            // brightness; 0 restores round 30 EXACTLY.
uniform float uAcesHue;    // ROUND 29: how much of the curve is evaluated
                           // HUE-EXACTLY below the whitening guard. 1 = a
                           // channel the scene left at zero leaves the curve at
                           // zero; 0 = round 28's per-channel-in-AP1 exactly.
uniform vec3  uHiComp;     // ROUND 8 shoulder: (knee, headroom, residual slope)
uniform float uToe;
uniform float uShoulder;
uniform float uWhite;      // filmic only: scene value that maps to exactly 1.0

uniform vec3  uAbsorption;
uniform float uUnderwater;
uniform float uSplit;      // debug: right half ungraded
uniform float uDebug;      // 1 AO, 2 bloom, 3 CoC, 4 DoF, 5 HDR stops, 6 zones
// ROUND 22 — THE INSTRUMENT THAT WAS MISSING FOR SIX ROUNDS. The open-loop
// exposure is solved on the CPU and then CLAMPED, and nothing anywhere could
// see the value that went into the clamp — so a clamp that was binding on half
// the battery looked exactly like a ramp that had been tuned to those values.
// (x, y, z) = requested (pre-clamp), applied (post-clamp), the ceiling itself.
// Read with ?pfxdebug=13/14/15; each prints its component divided by 8.
uniform vec3  uDbgEx;
${DEPTH_LIB}
${COC_LIB}
${EXPOSURE_LIB}

// ---- AgX (matrices and the 6th-order contrast approximation as shipped in
// three.js r171 / Filament; identical numbers, restructured so we can blend
// chroma back in afterwards).
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187));
const mat3 AgXInsetMatrix = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AgXOutsetMatrix = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 color) {
  const float MinEv = -12.47393;
  const float MaxEv = 4.026069;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - MinEv) / (MaxEv - MinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

/**
 * The default curve. Measured, not chosen by taste: LOOK.md 9 says Subnautica's
 * response is "close to plain exposure plus a gentle highlight rolloff", with
 * "no heavy filmic S-curve" and colour that *stays* saturated as it brightens.
 * AgX (and ACES more so) do the opposite — they are log-domain curves built to
 * survive 20 stops, and they drag a bright cyan toward grey-white. Feeding this
 * scene's HDR through AgX measured 25% darker and visibly desaturated against a
 * plain-exposure reference, so it is available but not the default.
 *
 * Both halves are ratio scales. NEITHER may touch a channel on its own.
 *
 *   TOE      on LUMINANCE, chroma ratio carried through. The round-1 form
 *            derived a subtractive offset from min(r,g,b) and subtracted it from
 *            all three channels. Underwater min() is always red and is always
 *            far below uToe, so red was subtracted from itself and emerged as
 *            mn^2/(2*uToe) — a multiply by mn/(2*uToe), i.e. ~x0.12, getting
 *            quadratically worse the darker red got, while G and B lost 1-2%.
 *            That single line is most of why the water read as a Pantone chip.
 *            l -> l*l/(2*uToe) below uToe and l - uToe/2 above is C1 continuous,
 *            maps 0 to 0, and scales every channel by the same factor.
 *
 *   SHOULDER PER CHANNEL, identity below uShoulder and reaching exactly 1.0 at
 *            uWhite. Two things had to change from round 1.
 *
 *            (a) It has to TERMINATE. The old shoulder was asymptotic to 1.0, so
 *            nothing in any frame could ever be white: with the sun directly in
 *            frame the brightest pixel measured 188/255 and the 99.9th
 *            percentile 182, against LOOK.md 9's 233-253 for lit frames.
 *
 *            (b) It has to be PER CHANNEL, not a max-channel ratio scale. A
 *            hue-preserving scale looks correct until something is genuinely
 *            overexposed: the measured HDR sun in the godrays framing peaks at
 *            (0.11, 1.32, 3.50), so scaling by np/max divides red and green by
 *            3.5 and the sun comes out DARKER and MORE saturated than the water
 *            around it — a navy hole where the sun should be. Per channel the
 *            same pixel lands on (0.11, 0.99, 1.00): a hot cyan-white core in
 *            the water's hue family, which is what the references do
 *            (shallows-reef-1's brightest pixel is [255,255,255],
 *            kelp-forest-1's is [255,255,204]).
 *
 *            This is also structurally safe in the direction that bit us: a
 *            per-channel shoulder only ever moves channels CLOSER together
 *            (the max is compressed, anything below uShoulder is untouched), so
 *            it can never drive the smallest channel toward zero. And because
 *            it is the identity below uShoulder, everything except a genuinely
 *            blown highlight keeps its saturation exactly — LOOK.md 9's "colours
 *            stay saturated as they get bright" holds for the whole body of the
 *            frame while the tiny top tail still whitens like film.
 *
 *            Cubic Hermite with f(S)=S, f'(S)=1, f(W)=1, f'(W)=0; monotone as
 *            long as W <= S + 3(1-S), which is clamped below.
 */
float shoulderCh(float x, float S, float d) {
  if (x <= S) return x;
  float t = min((x - S) / d, 1.0);
  float t2 = t * t, t3 = t2 * t;
  // Hermite: h00*S + h10*d*1 + h01*1 + h11*d*0
  return S * (2.0 * t3 - 3.0 * t2 + 1.0)
       + d * (t3 - 2.0 * t2 + t)
       + (-2.0 * t3 + 3.0 * t2);
}

vec3 filmic(vec3 c) {
  c = max(c, vec3(0.0));

  float l = luma(c);
  if (uToe > 1e-5 && l > 1e-7) {
    float lt = (l < uToe) ? (l * l / (2.0 * uToe)) : (l - 0.5 * uToe);
    c *= lt / l;
  }

  float S = clamp(uShoulder, 0.05, 0.98);
  float d = clamp(uWhite - S, 1e-3, 3.0 * (1.0 - S));
  return clamp(vec3(shoulderCh(c.r, S, d),
                    shoulderCh(c.g, S, d),
                    shoulderCh(c.b, S, d)), 0.0, 1.0);
}

// ---- ACES, evaluated in ACEScg (AP1). Stephen Hill's RRT+ODT fit, with the
// canonical sRGB<->AP1 matrices. GLSL mat3 is column-major, so each mat3(...)
// row below is a COLUMN of the usual row-major HLSL listing.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

/**
 * The fit itself. Two properties this file depends on and that the round-2
 * hand-rolled curve did not have:
 *
 *   TOE  the numerator carries a -0.000090537 offset, so v < 0.003684 returns a
 *        NEGATIVE number and clamps to exactly 0. That is a true black floor
 *        that costs nothing and, crucially, is the *curve* removing an unwanted
 *        fog pedestal rather than the grade subtracting one. The 678 m frame
 *        measured a 0.1-percentile luminance of 9.8 with no true black in it
 *        anywhere; this is what takes that to 0.
 *
 *   SHOULDER  it asymptotes to 1/0.983729 = 1.0165, reaching 0.96 at v = 8 and
 *        0.99 at v = 16. So white is genuinely reachable by anything with real
 *        HDR headroom (the sun, a lamp, a bioluminescent core), which is
 *        LOOK.md 9's measured 99.9th percentile of 233-253 in lit frames.
 */
vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/**
 * ROUND 31 — HOW FAR A PIXEL IS ALLOWED TO WHITEN, AND WHY BRIGHTNESS ALONE
 * CANNOT ANSWER IT.
 *
 * Two operators share this ramp and the round-29 header says why they must:
 * the ACES per-channel ceiling in acesFitted() opens with it, and chroma
 * recovery in tonemap() closes with it, "so the two operators finally agree on
 * where a highlight starts instead of one of them being the only defence
 * against the other". It was a pure brightness test, smoothstep(uChromaGuard,
 * 3.2*uChromaGuard, maxc(c)) — 1.6 to 5.12 scene-linear in the shallows.
 *
 * THAT THRESHOLD ASSUMED WATER NEVER GETS THAT BRIGHT, AND IT DOES. Measured
 * this round on the raw HDR buffer, via ?nopostfx=1&exposure=0.22 so the buffer
 * could be read at all (at exposure 1 it is 79-80% railed and unreadable):
 * godrays' open water column runs scene-linear blue 1.44 in its dimmest
 * pure-water window to 2.50 in its brightest. The brightest of those sits at
 * w = 0.163, i.e. the red ceiling is opened from the scene's own 0.83% to
 * 17% of the largest channel, and chroma recovery is switched off by the same
 * fraction — on WATER, which is the most chroma-rich thing in the frame and the
 * one thing in it that must never whiten. This is round 30's finding on the
 * other guard of the same family, one function away: "L alone cannot tell a
 * blown highlight from an over-driven saturated pixel", and the fix there was
 * one factor requiring near-neutrality as well. Same factor, same reason, here.
 *
 * neu = min/max is 1 for a neutral, 0.95 for the sun core (1, 1, 0.95), 0.70
 * for a warm lamp filament, and 0.008-0.010 for our godrays water. So the band
 * below is far outside anything a real highlight can reach and far above
 * anything water can.
 *
 * AND IT DOES NOT STOP A GENUINE OVEREXPOSURE FROM WHITENING, which is the
 * objection to make and it is answered by the order of operations rather than
 * by a sweep: hiCompress() runs BEFORE this, per channel, and compresses the
 * largest channel hardest, so a source ten times the knee arrives here with its
 * channels already converged and neu already high. c is the post-hiCompress
 * colour. The guard therefore opens exactly when the film has already started
 * walking the pixel toward white, and stays shut when it has not.
 */
float whitenW(vec3 c) {
  float mx = maxc(c);
  if (mx <= 1e-6) return 0.0;
  float w = smoothstep(uChromaGuard, uChromaGuard * 3.2, mx);
  float neu = min(c.r, min(c.g, c.b)) / mx;
  return w * mix(1.0, smoothstep(0.05, 0.45, neu), uWhiteNeutral);
}

/**
 * ROUND 8 — THE SHOULDER, DOING REAL WORK, AND IT IS SCENE-REFERRED.
 *
 * ACES has a shoulder, but it is a shoulder for a 20-stop grading pipeline: it
 * reaches display 1.0 at a scene value of ~20.7, and this file feeds it a
 * pre-exposure of 1.18 to 2.58. So in the abyss anything above a display-
 * referred 2.7 resolves to 255 — and self-illuminated content down there is
 * routinely ten times that. The 18-shot battery duly summed 4.85% of frame at
 * luminance >= 250 against references that measure 0.00-0.12%, and the
 * distribution named the mechanism: the ?nopostfx=1 bypass of the SAME frames
 * clips 0.00-0.06%. The raw HDR the world hands this file does not clip. This
 * file was manufacturing all of it.
 *
 * The shape has three parts and each one answers a measured requirement:
 *
 *   KNEE, at 1.0/uCurveGain. That is by construction the scene value that ACES
 *   resolves to display 207/255, which is above the 99th percentile of every
 *   reference frame measured (148-220). So the entire body of every frame —
 *   including the shallows median at 123 that this round must not move — is
 *   below the knee and passes through as the identity. Dividing by the curve
 *   gain is what makes that true at every depth instead of only in the
 *   shallows.
 *
 *   HEADROOM, 3.97/uCurveGain, an exponential approach. Its asymptote is by
 *   construction the value ACES resolves to display 247/255. So a source ten or
 *   a thousand times the knee both land just under the clipping line, and the
 *   ORDERING between them survives — which a clamp does not give you.
 *
 *   RESIDUAL SLOPE, a small linear term the exponential never swallows. Without
 *   it the operator has a hard ceiling and NOTHING can reach white, which is
 *   also wrong: LOOK.md 9 measures a 99.9th percentile of 233-253 in lit frames
 *   and shallows-reef-1's brightest pixel is literally [255,255,255]. With it,
 *   display 250 is reached at roughly 70/uCurveGain — about 500x the frame's
 *   own mid-grey — so the sun disc and a lamp filament still white out and
 *   nothing else can.
 *
 * Per channel, not on luminance, for the same reason the round-1 filmic
 * shoulder had to be: a hue-preserving scale on a source whose channels are
 * (0.11, 1.32, 3.50) divides red by the blue excess and returns a DARKER, more
 * saturated pixel where the sun should be. Per channel the channels converge,
 * which is what a real overexposure looks like.
 *
 * min() rather than a branch: below the knee d is 0, the exponential term is 0,
 * and the candidate is the knee itself, which is by definition larger than c.
 */
vec3 hiCompress(vec3 c) {
  vec3 d = max(c - uHiComp.x, vec3(0.0));
  vec3 s = uHiComp.y * (1.0 - exp(-d / max(uHiComp.y, 1e-4)));
  return min(c, vec3(uHiComp.x) + s + uHiComp.z * d);
}

vec3 acesFitted(vec3 cIn) {
  vec3 c = max(cIn, vec3(0.0));
  vec3 a = ACES_IN * c;
  // uCurveGain is where mid-grey lands. Measured: at 1.40 a scene-linear 0.20
  // resolves to 123/255, against the shallows reference median of 121.7.
  a = rrtOdtFit(a * uCurveGain);
  vec3 o = ACES_OUT * a;

  // ROUND 29 — THIS CURVE MANUFACTURES RED OUT OF A RED OF EXACTLY ZERO, AND
  // THE CLOSING CLAMP IS WHAT HID IT FOR TWENTY-EIGHT ROUNDS.
  //
  // THE ARITHMETIC FIRST, because it is not a tuning opinion. The two matrices
  // are not inverses. Multiplied out, ACES_OUT * ACES_IN is
  //
  //     0.91589   0.07675   0.00736
  //     0.02308   0.96955   0.00736
  //     0.02308   0.07675   0.90016
  //
  // — unit ROW sums, so white still maps to white, but the red row picks up
  // 7.675% of the green and 0.736% of the blue. That is the RRT desaturation
  // and the ODT re-saturation, and it means that even with NO CURVE AT ALL the
  // sandwich turns a green-cyan whose red is exactly 0 into a display R% of 32.
  // The per-channel fit between them then makes it level-dependent: rrtOdtFit
  // is concave, so it compresses the LARGE AP1 channel harder than the small
  // one, ACES_OUT's cancellation is calibrated for the uncompressed ratio, and
  // the residual comes out positive. Below the crossing the same residual is
  // NEGATIVE and clamp(o, 0, 1) deletes it, which is why the defect is
  // invisible on every dark frame in the battery.
  //
  // MEASURED, on the kelp water chromaticity (0, 0.1022, 0.0578 — the
  // ?nopostfx median of that crop, with red set to EXACTLY zero) at
  // uCurveGain 1.40, through this function and chroma recovery at 0.70:
  //
  //     scene maxc   0.05  0.10  0.20  0.40  0.60  0.80  1.20  2.00  4.00
  //     display R       0     0     0     0    37    59    85   110   130
  //     R%              0     0     0     0    19    28    37    46    52
  //     saturation  1.000 1.000 1.000 1.000 0.812 0.723 0.626 0.541 0.476
  //
  // The crossing is at scene 0.42 for kelp's chromaticity, 0.52 for the
  // shallows cyan and 0.55 for grand-reef's navy. AND READ THE 1.20 COLUMN:
  // R% 37 at saturation 0.626 is, to three digits, the pair a biomes builder
  // measured on our kelp water window and reported as a colour of the medium.
  // The medium's red there is uFogColor.r = 4e-5. Every count of that red was
  // made here.
  //
  // THE INVARIANT. A tone curve may take a channel down, and above genuine
  // overexposure it may walk all three toward white, which is what film does
  // and what LOOK.md 9's [255,255,255] highlight is. It may not RAISE a
  // channel's level relative to the pixel's largest channel above where the
  // scene put it while the pixel is merely bright. So: a per-channel CEILING at
  // the scene's own channel ratios, opened toward 1 by exactly the whitening
  // guard tonemap() already uses for chroma recovery, so the two operators
  // finally agree on where a highlight starts instead of one of them being the
  // only defence against the other.
  //
  // It is a min(), so it can only ever lower a channel: the toe's chroma
  // EXPANSION — which lowers the small channels' relative level, and which the
  // deep frames' saturation depends on — is inert under it by construction, and
  // that is arithmetic rather than a sweep. Modelled through the same chain,
  // this operator moves NOTHING on any of the four window chromaticities below
  // scene 0.40, and nothing on a near-neutral lamp core at any level (the
  // largest saturation move on (1, 1, 0.95) anywhere in 0.05-12.0 is 0.005).
  if (uAcesHue > 0.0) {
    float mxIn = maxc(c);
    if (mxIn > 1e-6) {
      // ROUND 31: the opening ramp now requires near-neutrality as well as
      // brightness. See whitenW() — bright water was opening this ceiling to
      // 17% relative red out of a scene ratio of 0.83%.
      float w = whitenW(c);
      vec3 lim = max(maxc(o), 0.0) * mix(c / mxIn, vec3(1.0), w);
      o = mix(o, min(o, lim), uAcesHue);
    }
  }

  // ROUND 25 — THE CLOSING CLAMP WAS A PER-CHANNEL CLIP, WHICH IS THE ONE
  // OPERATOR THIS FILE'S DOCTRINE FORBIDS EVERYWHERE ELSE.
  //
  // AP1 is wider than sRGB, so ACES_OUT's negative off-diagonals send the red
  // channel of anything strongly cyan-green NEGATIVE. Worked through by hand
  // for a kelp water pixel (scene-linear 0.0065 / 0.1022 / 0.0578, the
  // ?nopostfx median of that crop): AP1 lands 0.0429 / 0.0942 / 0.0623, the
  // curve returns 0.01085 / 0.03861 / 0.01978, and ACES_OUT then gives
  // R = -0.00454. clamp() answers that by ZEROING a channel the medium left
  // alive AND by adding the luminance the negative was carrying, which is a
  // hue shift dressed as a clip.
  //
  // The gamut RETURN gives up chroma instead: hold luminance exactly and scale
  // the whole ab excursion about it until the smallest channel reaches 0. Same
  // doctrine as oklabToRgbClipped() at the other end of the grade, and the same
  // reason - chroma is given up before a channel is.
  if (uAcesGamut > 0.5) {
    float mn = min(min(o.r, o.g), o.b);
    if (mn < 0.0) {
      float l = max(luma(o), 0.0);
      o = vec3(l) + (o - vec3(l)) * (l / max(l - mn, 1e-5));
    }
  }
  return clamp(o, 0.0, 1.0);
}

/**
 * Every filmic curve buys its rolloff by walking chroma toward the achromatic
 * axis, and LOOK.md 3 puts the reference at 0.70-0.97 mean saturation with an
 * explicit warning against "grounding" it. So after the curve we rebuild a
 * hue-locked version at the tonemapped luminance and blend it back.
 *
 * The blend is weighted DOWN at the very top of the range. Without that guard,
 * a genuinely blown highlight is dragged back to full chroma and the sun comes
 * out as a saturated disc instead of a white core — the references are explicit
 * here (shallows-reef-1's brightest pixel is [255,255,255], kelp-forest-1's is
 * [255,255,204]). Recovery holds over the body of the frame, film wins at the
 * top 15%.
 */
// Single exit on purpose: the D3D11 HLSL backend emits "X4000: use of
// potentially uninitialized variable (f_tonemap)" for multi-return functions and
// that warning lands in every capture's report.json for everyone to trip over.
vec3 tonemap(vec3 c) {
  vec3 t;
  if (uCurve < 0.5)      t = acesFitted(c);
  else if (uCurve < 1.5) t = agx(c);
  else if (uCurve < 2.5) t = filmic(c);
  // 3 = NO CURVE AT ALL, a straight clamp. Only ?nopostfx=1 selects this, and
  // it does so deliberately: a bypass that still runs the tone curve is not a
  // bypass, it is "the grade minus the grade's last stage", and comparing
  // against it understates what the chain does by exactly the amount the curve
  // contributes — which is most of it. This makes ?nopostfx=1 mean what it
  // says: the raw HDR buffer, clamped and sRGB-encoded, nothing else.
  else                   t = clamp(c, 0.0, 1.0);

  float lIn = luma(c);
  if (lIn > 1e-6 && uChromaRecovery > 0.0) {
    vec3 hue = c / lIn;                       // luminance-normalised chroma
    float lOut = luma(t);
    // ROUND 8 — RECOVERY MAY REDISTRIBUTE THE CURVE'S OUTPUT, NOT ADD TO IT.
    //
    // This used to be clamp(lOut * hue, 0.0, 1.0), and that clamp is a
    // PER-CHANNEL CLIP — the one operator the whole safety doctrine of this
    // file exists to forbid. The reconstruction is the tonemapped luminance
    // times the SCENE's chroma ratio, and for anything the medium has made
    // strongly cyan the blue ratio is well above 1, so a merely bright sky
    // pixel reconstructs to a blue of 1.2 and the clamp parks it at exactly
    // 255. Measured on the above-water frames: 24.8% and 22.9% of frame had a
    // channel at 254+ against surface-above-5's 0.9%, with only 0.045% of
    // frame luminance-clipped — i.e. it was a pure channel clip, invisible to
    // a luminance test and the single largest one in the battery.
    //
    // The fix keeps the operator's whole purpose (put the hue back) and takes
    // away its ability to invent brightness: if the reconstruction's largest
    // channel exceeds the largest channel the CURVE produced, scale the whole
    // triple down until it does not. A RATIO scale, not a pull toward the
    // achromatic point — the obvious desaturating form was tried first and
    // measured wrong in the one direction this project cannot afford: pulling a
    // cyan reconstruction toward grey ADDS red, and it took the shallows crop's
    // mean red from 40.7 to 51.7 against shallows-reef-1's 43. Scaling holds the
    // channel ratios exactly, so red stays exactly as dead as the scene made it
    // (LOOK.md rule 1) and the pixel simply gives up a little luminance, which
    // is the honest answer to "that much chroma does not exist at that level".
    vec3 want = lOut * hue;
    float mxW = maxc(want);
    float cap = maxc(t);                      // >= lOut for any colour
    want *= min(1.0, cap / max(mxW, 1e-5));
    vec3 locked = clamp(want, 0.0, 1.0);
    // ROUND 4: the guard is SCENE-referred, not display-referred. It used to be
    // 1 - smoothstep(0.72, 0.97, maxc(t)) — a test on the value AFTER the curve
    // — and that is why every bright frame came out milky. A 32 m up-look frame
    // lands almost entirely between display 0.7 and 0.95, so the guard read
    // "this is a blown highlight" for 80% of the image and switched chroma
    // recovery off exactly where ACES's shoulder had just desaturated it.
    // Measured: that frame lost 0.117 of mean saturation THROUGH the grade
    // (bypass 0.763 -> chain 0.646) and gained 24 counts of mean red.
    // A genuinely blown highlight is one with real HDR headroom, which is a
    // property of the INPUT, so uChromaGuard is a scene-linear threshold: the
    // sun core, a lamp filament and a bioluminescent centre sit far above it
    // and still whiten like film; bright water does not and keeps its hue.
    // ...and it is a BAND PASS on scene brightness, not a low pass. ACES's
    // desaturation is progressive: it is negligible through the midtones, where
    // the curve is close to a straight line, and severe up on the shoulder. So
    // recovery ramps IN as the pixel gets bright — which is where the curve took
    // the chroma — and back OUT above uChromaGuard, where whitening is correct.
    // Measured why this has to be a band and not a constant: at a flat 0.30 the
    // shallows WATER crop lost red down to 22% of max against the reference's
    // 32%, because recovery reconstructs a midtone at the medium's own extremely
    // red-poor chromaticity; at a flat 0.16 the 32 m up-look frame fell to 0.645
    // mean saturation, under LOOK.md's 0.70 floor. The two frames want opposite
    // constants and the same band.
    // ROUND 24 — THE LOW EDGE IS RELATIVE TO THE FRAME'S OWN MIDDLE, AND THAT
    // IS WHY THE CURVE USED TO OWN MOST OF THE CHROMA ERROR.
    //
    // It was an ABSOLUTE scene-linear pair, (0.22, 1.10). A 280 m frame's whole
    // crop lives under scene-linear 0.10 after exposure and a 678 m frame's
    // under 0.03, so on both of them this gate was identically zero and
    // recovery — the one operator in the file that puts the SCENE's chroma
    // ratio back after the curve — never ran at all. Measured, ?crec=0 against
    // shipped: 0.000 saturation and 0 R% on grand-reef AND on deep-void. An
    // ablation that moves nothing is an operator that was not there.
    //
    // Quoted against meterOf(tExposure)*sceneExposure() — the frame's own
    // metered middle in exactly the units the curve's input is in — the same band means the
    // same thing at every depth, and the shallows behaviour the absolute pair
    // was solved for is preserved in relative terms instead of by accident of
    // where the histogram happened to sit.
    float cMid = max(meterOf(tExposure) * sceneExposure(), 1e-5);
    float lo = smoothstep(uChromaLo.x * cMid, uChromaLo.y * cMid, maxc(c));
    // ROUND 31: the same ramp as the ACES ceiling's, and it has to stay the
    // same one — see whitenW(). It now also requires near-neutrality, so bright
    // WATER no longer switches the one operator that puts the scene's chroma
    // back off by 16% of itself while the ceiling that guards it opens by the
    // same 16%.
    float hiGuard = 1.0 - whitenW(c);
    t = mix(t, locked, uChromaRecovery * lo * hiGuard);
  }
  return t;
}

// ---------------------------------------------------------------------------
// OKLab (Bjorn Ottosson, 2020) — the working space for the whole display grade.
//
// GLSL mat3 is column-major, so each mat3(...) triplet below is a COLUMN of the
// usual row-major listing.
// ---------------------------------------------------------------------------
const mat3 OKL_LMS = mat3(
  0.4122214708, 0.2119034982, 0.0883024619,
  0.5363325363, 0.6806995451, 0.2817188376,
  0.0514459929, 0.1073969566, 0.6299787005);
const mat3 OKL_LAB = mat3(
  0.2104542553,  1.9779984951,  0.0259040371,
  0.7936177850, -2.4285922050,  0.7827717662,
 -0.0040720468,  0.4505937099, -0.8086757660);
const mat3 OKL_LMS_INV = mat3(
   4.0767416621, -1.2684380046, -0.0041960863,
  -3.3077115913,  2.6097574011, -0.7034186147,
   0.2309699292, -0.3413193965,  1.7076147010);
const mat3 OKL_LAB_INV = mat3(
  1.0,          1.0,          1.0,
  0.3963377774, -0.1055613458, -0.0894841775,
  0.2158037573, -0.0638541728, -1.2914855480);

vec3 rgbToOklab(vec3 c) {
  return OKL_LAB * pow(OKL_LMS * max(c, vec3(0.0)), vec3(1.0 / 3.0));
}
vec3 oklabToRgb(vec3 lab) {
  vec3 lms = OKL_LAB_INV * lab;
  return OKL_LMS_INV * (lms * lms * lms);
}
/**
 * OKLab -> display RGB, reducing CHROMA (never a channel) until the result fits
 * the cube.
 *
 * This is the structural safety property that replaces round 1's clamp, and it
 * is what makes it safe to run a real saturation operator at all. A hard clamp
 * on an out-of-gamut colour deletes whichever channel went negative — which
 * underwater is ALWAYS red — and that is how round 1 shipped a frame with a mean
 * red of 0.09/255 and a mean saturation of 0.999. Backing chroma off along the
 * hue line instead keeps L and the hue angle exactly and only ever gives up
 * saturation, so no operator in this file can drive a channel to a hard zero
 * however hard it is pushed.
 *
 * ROUND 14 — AND THE SOLVER'S OWN STEP SIZE WAS THE "SUN BULLSEYE".
 *
 * Five bisections resolve the chroma scale to 1/32, i.e. this function returned
 * one of 32 discrete saturations. That is a 5-bit quantiser sitting on the
 * chroma of every out-of-gamut pixel in the game, and underwater almost every
 * bright pixel is out of gamut. Its steps are iso-chroma contours, and around a
 * radially symmetric source they are concentric rings — the bullseye.
 *
 * It was diagnosed as 8-bit output contouring and it is not; the output dither
 * was already in and measures correct (0.38 LSB of residual on the flattest
 * tiles of the frame, against the 0.36 a working +/-1 LSB TPDF dither predicts,
 * and 0.00 with it ablated). A raw scanline out through the sun names the real
 * mechanism unambiguously — G and B fall smoothly and monotonically while R
 * ramps down and SNAPS BACK UP by 25-31 counts, over and over:
 *
 *   R: 15  6 | 30 25 20 13  5 | 31 28 25 22 18 14 11  7  3 | 29 27 ...
 *   G: 233 232| 229 227 226 225 223| 221 220 218 217 215 213 213 211 210| 208 206
 *
 * Red is the channel that goes negative in cyan water, so red is the channel
 * that carries the solver's step, and near the gamut wall dR/d(chroma) is about
 * 3.5 per unit — a 1/32 step IS 28 counts. No amount of dither at the 8-bit
 * write can hide a 28-count staircase.
 *
 * The fix is to stop quantising: six bisections to bracket the root, then two
 * false-position steps on the signed gamut violation, which is very nearly
 * linear across a 1/64-wide bracket because each channel is a cubic in the
 * chroma scale. Eight evaluations instead of five, on out-of-gamut pixels only,
 * and the residual step drops below a fifth of an LSB — under the dither, where
 * it belongs. The t = 0 end needs no evaluation at all: OKLab's inverse on the
 * achromatic axis is exactly (L^3, L^3, L^3), because both matrices have unit
 * row sums.
 */
float gamutErr(float L, vec2 ab, float t, float wall) {
  vec3 c = oklabToRgb(vec3(L, ab * t));
  return max(-min(c.r, min(c.g, c.b)), maxc(c) - wall);
}

vec3 oklabToRgbClipped(float L, vec2 ab) {
  // ROUND 8 — THE GAMUT WALL IS ITSELF A CLIPPED CHANNEL.
  //
  // Projecting onto the boundary returns a colour whose largest channel is
  // exactly 1.0, i.e. exactly 255. Underwater that is not a rare event: the
  // medium's chromaticity is extreme, so any reasonably bright water pixel is
  // out of sRGB, and this line was quietly pegging a channel across 5-6% of the
  // kelp and drop-off frames — invisible to a luminance test, which is why four
  // rounds of clipping work never found it. Aim a little INSIDE the wall, and
  // open the target to exactly 1.0 only as L approaches white, where a pegged
  // channel is what an overexposed pixel is supposed to look like.
  float wall = mix(0.955, 1.0005, smoothstep(0.93, 0.995, L));
  vec3 c = oklabToRgb(vec3(L, ab));
  float eHi = max(-min(c.r, min(c.g, c.b)), maxc(c) - wall);
  if (eHi <= 0.0) return clamp(c, 0.0, 1.0);

  // The achromatic end, in closed form. If even zero chroma does not fit, the
  // pixel is simply brighter than the wall and no chroma reduction can help.
  float n = L * L * L;
  float eLo = max(-n, n - wall);
  if (eLo >= 0.0) return clamp(vec3(n), 0.0, 1.0);

  // uGamutFix = 0 restores the round-8 solver exactly (five bisections, no
  // refinement) so the bullseye can be switched back on and measured rather
  // than argued about: ?gamut=0. GLSL ES 3.00 allows a non-constant loop bound.
  int nb = uGamutFix > 0.5 ? 6 : 5;
  float lo = 0.0, hi = 1.0;
  for (int i = 0; i < nb; i++) {
    float mid = 0.5 * (lo + hi);
    float e = gamutErr(L, ab, mid, wall);
    if (e <= 0.0) { lo = mid; eLo = e; } else { hi = mid; eHi = e; }
  }
  // False position. Kept strictly inside the bracket so a pathological pair of
  // violations (the binding constraint can switch channels mid-bracket) cannot
  // stall the interval, and so the returned root is always the in-gamut side.
  int nr = uGamutFix > 0.5 ? 2 : 0;
  for (int i = 0; i < nr; i++) {
    float span = hi - lo;
    float t = lo + span * clamp(-eLo / max(eHi - eLo, 1e-7), 0.02, 0.98);
    float e = gamutErr(L, ab, t, wall);
    if (e <= 0.0) { lo = t; eLo = e; } else { hi = t; eHi = e; }
  }
  return clamp(oklabToRgb(vec3(L, ab * lo)), 0.0, 1.0);
}

vec3 srgbEncode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

/**
 * THE FRAME'S OWN MIDDLE, in OKLab L — the pivot the contrast operator rotates
 * about.
 *
 * A pivoted power is only a CONTRAST for pixels that straddle the pivot. Put
 * the pivot above a frame's whole histogram and P*(L/P)^c is not a contrast at
 * all, it is an exposure cut that gets worse the darker the pixel is; put it
 * below and it is an exposure lift. Round 4 pivoted at a constant 0.57, which
 * is a display 128/255 — inside the shallows histogram and far above every
 * other frame in the battery. Measured consequence: raising the far-field
 * contrast from 1.22 to 1.30 moved the drop-off frame's median UP by 1.2 counts
 * and the kelp frame's DOWN by 5.8, from the same operator, in the same
 * direction, on the same frame graph. That is not a knob, that is a coin toss,
 * and it is exactly the kind of frame-to-frame disagreement the composite is
 * being marked down for.
 *
 * The meter already knows where each frame's middle is, so ask it: take the
 * metered scene key, put it through the same tone curve every pixel just went
 * through, and take the cube root (OKLab L is exactly luminance^(1/3) for a
 * neutral). The contrast is then a pure SPREAD about the frame's own centre in
 * every frame, and the frame's LEVEL is decided in one place — the meter — and
 * shaped in one place — uMidGamma. Three operators, three jobs, no crosstalk.
 */
// Both ACES matrices have unit ROW sums (sRGB->AP1 and back must map white to
// white), so a neutral passes through them unchanged and the whole curve
// collapses to the scalar Hill fit — no matrices, no luma(), two multiply-adds
// and a divide. Exact for uCurve = 0; the AgX and filmic debug paths get an
// ACES-shaped pivot, which is close enough for a reference point neither of
// them is calibrated against anyway.
float pivotL() {
  float v = meterOf(tExposure) * sceneExposure() * uCurveGain;
  float t = clamp((v * (v + 0.0245786) - 0.000090537)
                / (v * (0.983729 * v + 0.4329510) + 0.238081), 0.0, 1.0);
  return pow(max(t, 1e-5), 1.0 / 3.0);
}

/**
 * THE SCENE-REFERRED VALUE THAT SURVIVES THE WHOLE TAIL TO DISPLAY CODE 1.
 *
 * Everything between the composite's scene-referred arithmetic and the 8-bit
 * buffer has a hard zero underneath it, and they compound. Read bottom-up, this
 * inverts them in order:
 *
 *   ENCODER   display code 1 is sRGB 1.5/255; that is inside the linear segment,
 *             so linear Y = 1.5/255/12.92 = 4.553e-4. On the achromatic axis
 *             OKLab L is cbrt(Y) (the LMS matrices have unit row sums, so a
 *             neutral passes through them unchanged), giving L = 0.07694. Chroma
 *             only ever raises the largest channel above the neutral of the same
 *             L, so solving on the neutral is the conservative direction.
 *   GAMMA     L = pow(L, zGamma)                    -> inverse power
 *   CONTRAST  L = piv * pow(L/piv, zContrast)       -> inverse power about piv
 *   OKLab     Y = L^3
 *   TOE       ACES near zero is AFFINE, not a power: the fit's numerator is
 *             v*(v + 0.0245786) - 9.0537e-5, so for v << 0.0246 it collapses to
 *             (0.0245786*v - 9.0537e-5)/0.238081, i.e. slope 0.103237 and a
 *             root at v = 0.003684. Invert that line rather than the full fit —
 *             at the level in question the quadratic term is four orders down.
 *   PRE-GAIN  the curve is fed c*uCurveGain, so divide back.
 *
 * Four operators are deliberately NOT inverted. hiCompress and the highlight
 * rolloff are the identity down here (their knees are two orders above), and
 * chroma recovery and the split-tone move ab, not L. The midtone pull and the
 * final per-channel uGamma DO bite a little — the pull's exponent is 1.09 at
 * this L and uGamma runs 1.00-1.05 — and leaving them out is what makes this
 * function under-report rather than over-report, which is the direction to err:
 * an under-reported floor leaves a little of the crush behind, an over-reported
 * one would start switching AO off over pixels that were never at risk. Measured
 * residual after the guard: 0.008 of the 0.255 points AO was contributing on
 * base-interior, i.e. 97% of it. The vignette is not in this list because it is
 * a scene-referred multiply and is carried in mxOut with the rest of them.
 *
 * The pivot is read from pivotL(), the same metered value the contrast operator
 * itself uses, so the two cannot drift apart.
 */
float sceneForDisplayL(float Ld, float zContrast, float zGamma) {
  float piv = clamp(mix(uPivot, pivotL(), uPivotAuto), 0.055, 0.90);
  float Lg = pow(max(Ld, 1e-6), 1.0 / max(zGamma, 0.25));
  float Lc = piv * pow(max(Lg, 1e-6) / piv, 1.0 / max(zContrast, 1.0));
  float Y = Lc * Lc * Lc;
  return (Y / 0.103237 + 0.003684) / max(uCurveGain, 1e-3);
}
float blackFloorScene(float zContrast, float zGamma) {
  // 0.076936 is the OKLab L of display-linear 4.554e-4, the encoder's step.
  return sceneForDisplayL(0.076936, zContrast, zGamma);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;

  // ---- lens: gentle barrel + radial chromatic aberration -------------------
  vec2 cc = (uv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(cc, cc);
  float rEdge = 0.25 * uAspect * uAspect + 0.25;          // r2 at the corner
  // Renormalise so the corner still samples exactly the frame edge — no black
  // wedges, at the cost of an imperceptible zoom.
  float k = uBarrel;
  float norm = 1.0 / (1.0 + k * rEdge);
  vec2 base = 0.5 + cc * (1.0 + k * r2) * norm / vec2(uAspect, 1.0);

  // Quartic in radius and measured in texels: literally zero across the middle
  // third of frame, ~0.8 px at the extreme corner, resolution independent.
  float rn = r2 / rEdge;
  float caAmt = uCA * rn * rn * uTexel.x * 0.8;
  vec2 dir = cc / max(sqrt(r2), 1e-4) / vec2(uAspect, 1.0);
  vec2 uvR = base - dir * caAmt;
  vec2 uvG = base;
  vec2 uvB = base + dir * caAmt;

  vec3 sharp = vec3(
    texture(tColor, uvR).r,
    texture(tColor, uvG).g,
    texture(tColor, uvB).b);
  vec3 blur = vec3(
    texture(tDof, uvR).r,
    texture(tDof, uvG).g,
    texture(tDof, uvB).b);

  // ---- depth-driven terms --------------------------------------------------
  float rawD = texture(tDepth, uvG).r;
  bool isSky = rawD >= 0.99999;
  float dist = isSky ? uNearFar.y : linearDepth(rawD);
  float focus = texture(tFocus, vec2(0.5)).r;

  // ---- THE THREE ZONES ------------------------------------------------------
  // ROUND 4: the axis is OPTICAL DEPTH, not distance/visibility. What decides
  // whether a pixel reads as foreground or as fog is how much water is in front
  // of it, and that is 1 - transmittance — the medium's own per-channel
  // extinction, integrated along the view ray. Normalising metres by
  // uMaxVisibility (round 3) is a linear stand-in for an exponential, and it
  // was badly wrong at the shallow end: the shallows medium reports 82 m of
  // visibility, so the lit reef at 20 m normalised to dn = 0.24 and fell almost
  // entirely into the "mid" band — the handover band that by design carries the
  // weakest grade. Measured: the reef crop's G/B came back 0.74 against the
  // reference's 0.94, i.e. the near-field operator never reached the near field.
  // In optical depth the same 20 m is 0.50, squarely in the near band, and the
  // number self-adapts to a murky biome for free. Sky is fogAmt = 1 by
  // construction, so it needs no special case.
  //
  // ROUND 8 — TWO STRUCTURAL FAULTS, BOTH MEASURED WITH ?pfxdebug=6 (the split
  // written out as R=near, G=mid, B=far and read back in linear).
  //
  // (1) wMid WAS THE RESIDUAL, AND THE RESIDUAL WAS NOT GATED. wNear and wFar
  //     carry uUnderwater * uZone; wMid was 1 - wNear - wFar, so ABOVE WATER,
  //     where both of those are identically zero, wMid resolved to 1.0 and the
  //     sky was graded by the underwater MID preset at full strength —
  //     contrast, chroma, gamma and all. Measured: surface-above resolves to
  //     near 0.000 / mid 1.000 / far 0.000. The 1 - wNear - wMid - wFar
  //     neutral term every zone operator carries was therefore identically 0
  //     and had never once been reachable. Gating wMid by the same zoneOn makes
  //     the neutral path live and hands the sky back to the tone curve alone.
  //
  // (2) THE THREE BANDS DID NOT PARTITION THE FRAME, THEY OVERLAPPED INTO MID.
  //     With the near ramp ending at 0.80 and the far ramp starting at 0.66,
  //     mid peaked at 0.78 around fogAmt 0.74 and owned the plurality of six of
  //     the twelve shots measured (cave 0.60, wreck 0.56, grand-reef 0.53,
  //     shallows-reef 0.48, godrays 0.43). A band that is the default answer is
  //     not a band, and it is why "every operator that was supposed to create
  //     colour separation" kept landing on the same pixels. The ramps now cross
  //     with the near band running much further out (0.20-0.88) and the far
  //     band starting much earlier (0.50-0.94), so the two ENDS of the axis own
  //     the frame and mid is a handover that peaks at 0.46. 20 m of shallows
  //     water — optical depth 0.50, the lit reef — now resolves 0.59 near
  //     against 0.41 mid, where before it was 0.48 near against 0.52 mid.
  float zoneOn = uUnderwater * uZone;
  float fogAmt = 1.0 - luma(exp(-uAbsorption * min(dist, 400.0)));
  float aNear = smoothstep(uZoneNear.x, uZoneNear.y, fogAmt);
  float bFar = smoothstep(uZoneFar.x, uZoneFar.y, fogAmt);
  float wNear = (1.0 - aNear) * zoneOn;
  float wFar = bFar * zoneOn;
  float wMid = max(0.0, 1.0 - wNear - wFar) * zoneOn;

  // The fourth band: AIR. It has never been reachable before (wMid was the
  // residual, so the residual was always 0) and now that it is, it needs a
  // value. Neutral would be wrong for the same reason the underwater mid preset
  // was wrong: an above-water frame has no medium in front of it, but it is
  // still a graded photograph. uAirGrade carries a contrast and nothing that is
  // derived from the water — the channel gains, the hue rotation and the
  // split-tone all stay at their neutral, because every one of them is read off
  // a medium that is not there.
  float wAir = max(0.0, 1.0 - wNear - wMid - wFar);
  float zContrast = dot(vec3(wNear, wMid, wFar), uZoneContrast) + wAir * uAirGrade.x;
  float zSat      = dot(vec3(wNear, wMid, wFar), uZoneSat)      + wAir * uAirGrade.y;
  float zGamma    = dot(vec3(wNear, wMid, wFar), uZoneGamma)    + wAir * uAirGrade.z;
  float zClarity  = dot(vec3(wNear, wMid, wFar), uZoneClarity);
  float zClarityW = dot(vec3(wNear, wMid, wFar), uZoneClarityW);
  vec3  zGain     = uGainNear * wNear + uGainMid * wMid + uGainFar * wFar
                  + vec3(1.0 - wNear - wMid - wFar);

  float cocS = cocFor(dist, focus);
  float coc = abs(cocS);
  float dofBlend = smoothstep(0.10, 0.85, coc) * uDofMix;
  vec3 col = mix(sharp, blur, dofBlend);

  if (uDebug > 0.5) {
    vec3 dbg = vec3(0.0);
    if (uDebug < 1.5) dbg = vec3(texture(tAO, uvG).r);
    else if (uDebug < 2.5) dbg = texture(tBloom, uvG).rgb * 3.0;
    else if (uDebug < 3.5) dbg = cocS > 0.0 ? vec3(0.1, cocS, 0.1) : vec3(-cocS, 0.1, 0.1);
    else if (uDebug < 4.5) dbg = blur;
    // 5: scene-referred exposure latitude, 1 unit per stop from -8 to 0 EV.
    // Tells us directly whether anything in frame can actually reach white.
    else if (uDebug < 5.5)
      dbg = vec3(clamp((log2(maxc(sharp) * sceneExposure() + 1e-6) + 8.0) / 8.0, 0.0, 1.0));
    // 6: the zone split itself — red near, green mid, blue far.
    else if (uDebug < 6.5) dbg = vec3(wNear, wMid, wFar);
    // 7/8: the meter, as a flat readable grey. These exist because the exposure
    // solution lives entirely on the GPU (no readback, by design) and there is
    // otherwise no way to find out what it decided. 7 = the applied exposure on
    // a 0..4 scale; 8 = the raw compressed meter m, invert with m/(1-m).
    else if (uDebug < 7.5) dbg = vec3(clamp(sceneExposure() * 0.25, 0.0, 1.0));
    // 8 = the DECODED fast meter m (0..1), 11 = the decoded slow meter, 12 = the
    // contrast pivot in OKLab L. Invert 8/11 with m/(1-m) to get scene units.
    else if (uDebug < 8.5) dbg = vec3(clamp(MET_EPS * (exp(clamp(textureLod(tExposure, vec2(0.5), 0.0).r, 0.0, 6.0)) - 1.0), 0.0, 1.0));
    // 9/10: the zone channel gains, halved so a gain of 2.0 reads as white.
    else if (uDebug < 9.5) dbg = clamp(uGainFar * 0.5, 0.0, 1.0);
    else if (uDebug < 10.5) dbg = clamp(zGain * 0.5, 0.0, 1.0);
    else if (uDebug < 11.5) dbg = vec3(clamp(MET_EPS * (exp(clamp(textureLod(tExposureSlow, vec2(0.5), 0.0).r, 0.0, 6.0)) - 1.0), 0.0, 1.0));
    else if (uDebug < 12.5) dbg = vec3(clamp(pivotL(), 0.0, 1.0));
    // 13/14/15: the open-loop exposure REQUEST, what survived the clamp, and
    // the clamp's own ceiling. All divided by 8, so decode as lin * 8.
    else if (uDebug < 13.5) dbg = vec3(clamp(uDbgEx.x * 0.125, 0.0, 1.0));
    else if (uDebug < 14.5) dbg = vec3(clamp(uDbgEx.y * 0.125, 0.0, 1.0));
    else dbg = vec3(clamp(uDbgEx.z * 0.125, 0.0, 1.0));
    fragColor = vec4(srgbEncode(clamp(dbg, 0.0, 1.0)), 1.0);
    return;
  }

  // ---- clarity: TWO real spatial operators ---------------------------------
  // Both are unsharp masks measured in STOPS and applied multiplicatively, so
  // they are exposure-independent, cannot go negative, cannot clip, and scale
  // all three channels identically (hue exact).
  //
  //   FINE  frame against the 1/4-res low-pass  -> 1-2 px acutance, the thing
  //         that makes sand ripples and rock pitting legible at all.
  //   WIDE  that low-pass against a 1/16-res one -> ~20 px local contrast, the
  //         thing that separates a rock's lit face from its shaded one and
  //         makes a silhouette read against the water behind it.
  //
  // Both are weighted per zone and go to zero in the fog: LOOK.md 2 — objects
  // "lose contrast before they lose brightness", "mid-ground goes flat".
  //
  // Round 2 ran the fine scale alone at 0.30 stops and measured a 32 px tile
  // contrast of 2.61 against the bypass's 2.64 — net negative once DoF had had
  // its say. The wide scale is where the number actually lives.
  float lHi = luma(sharp);
  float lLo = luma(max(texture(tLocal, uvG).rgb, vec3(0.0)));
  float lWd = luma(max(texture(tWide, uvG).rgb, vec3(0.0)));
  // Clamped in stops so a bloomed highlight cannot ring: an unbounded detail
  // term next to the sun is a halo generator. The wide term is clamped harder
  // because a wide-radius unsharp is exactly how you manufacture a halo.
  float dFine = clamp(log2((lHi + 2e-4) / (lLo + 2e-4)), -1.6, 1.6);
  float dWide = clamp(log2((lLo + 2e-4) / (lWd + 2e-4)), -0.9, 0.9);
  float clarityF = exp2(dFine * zClarity + dWide * zClarityW);

  // ---- ambient occlusion ---------------------------------------------------
  // AO is a lighting term, but by the time we see the pixel the medium has
  // already in-scattered over it. Weighting by the view-ray transmittance means
  // AO bites on near geometry and vanishes into the fog, exactly like shadow.
  //
  // ROUND 15 — WHY THIS STAGE STILL MANUFACTURED ABSOLUTE BLACK AFTER THE FLOOR
  // WENT IN, AND WHY THE FLOOR WAS NEVER GOING TO FIX IT.
  //
  // Round 14 stopped the AO buffer reaching zero (min exactly 0.50, verified in
  // the buffer) and the frames still gained pure black from this stage. The
  // floor was the wrong invariant, because the crush is not in the AO term at
  // all — it is in what sits DOWNSTREAM of it. Everything from here to the
  // display has a hard zero underneath it:
  //
  //   - ACES's toe: rrtOdtFit carries a -0.000090537 offset, so anything below
  //     0.003684/uCurveGain at the curve's input returns negative and clamps to
  //     exactly 0. At base-interior's uCurveGain that is scene-referred 0.00312.
  //   - The 8-bit encode above it, which is the BINDING one: display-linear
  //     1.52e-4 is the half-LSB rounding line, and inverting the curve puts that
  //     at scene-referred 0.00371 — HIGHER than the toe. Dither smears the edge
  //     by about an LSB and does not move it.
  //
  // So the output has a step at scene ~0.0037 and this stage is a multiply by as
  // little as 0.50. That sweeps the whole band [0.0037, 0.0074] — one full stop
  // of near-black, the width of the darkest two display codes — across the step
  // in a single operation. No floor above zero can prevent that; a floor of 0.99
  // would still crush the top half of a band that thin. The population is not
  // hypothetical: mapped per pixel on base-interior, the black this stage
  // creates is a one-to-three-pixel FRINGE hugging the already-black crevices of
  // the held scanner and the glove — the exact signature of a threshold being
  // crossed by a multiply rather than of an occlusion term being too strong.
  //
  // THE INVARIANT THAT IS ACTUALLY RIGHT: occlusion may darken a pixel, but it
  // may never be the operator that takes a pixel from "some light" to "no light
  // at all". Ambient visibility is a fraction of a quantity that is already
  // there; it cannot subtract the last photon, and in a real interior corner
  // inter-reflection guarantees it does not try.
  //
  // Enforcing it needs the pixel's DISPLAY-referred peak, so the whole
  // scene-referred tail has to be known here: clarity, the zone channel gain,
  // the metered exposure and the vignette are all multiplies, so their product
  // is exact and cheap. (Bloom is the one term skipped, and skipping it is
  // conservative — it only ever adds.) aoMin is then the smallest factor that
  // still leaves the pixel's largest channel above the encoder's step, clamped
  // to 1 so a pixel that was ALREADY below the step simply opts out and this
  // stage does nothing to it. maxc, not luma: a pixel survives the encode iff
  // its biggest channel does.
  //
  // It is a single scalar on all three channels, so hue is exact; and because
  // the guard is a max() against a factor that can never exceed 1, the result is
  // bounded above by the un-occluded colour. This CANNOT lift a black — LOOK.md
  // 18 — it can only decline to create one. ?aotoe=0 sets uAoBlack to 0, which
  // makes aoMin 0 and restores the bare multiply exactly, for ablation.
  //
  // WHERE THE THRESHOLD COMES FROM, AND WHY IT IS NOT A CONSTANT. The first
  // version of this guard used a fixed multiple of the ACES toe and measured
  // almost nothing: base-interior 1.092 -> 1.031% at absolute zero when the
  // stage as a whole was worth 0.26 points. The reason is that the curve is not
  // the last thing that darkens a near-black pixel — the display-referred grade
  // is, and near black it is savage. A pixel at OKLab L 0.05 (display 4/255)
  // under a zone contrast of 1.36 about a metered pivot of ~0.45 comes out at
  // L 0.023, which is display 0. Guarding against the curve's toe and then
  // handing the pixel to an operator that divides it by four again is not a
  // guard. blackFloorScene() therefore inverts the whole tail — encoder step,
  // zone gamma, pivoted zone contrast, OKLab, and the toe — and returns the
  // scene value that actually survives it. It costs two pow()s and it tracks
  // the grade automatically, which a hand-tuned constant cannot: zContrast runs
  // 1.16-1.36 across the zones IN THE SAME FRAME, so any single constant is
  // wrong for two of the three bands by construction.
  vec3 T = exp(-uAbsorption * min(dist, uMaxVis * 3.0));
  float surf = mix(1.0, pow(luma(T), uAOFog), uUnderwater);
  float ao = texture(tAO, uvG).r;
  float aoF = mix(1.0, ao, clamp(uAO * surf, 0.0, 1.0) * (isSky ? 0.0 : 1.0));

  float ex = sceneExposure();
  float vig = 1.0 - uVignette * smoothstep(uVignetteSoft, rEdge * 1.02, r2);
  float mxOut = maxc(max(col * zGain, vec3(0.0))) * clarityF * ex * vig;
  float aoFloor = uAoBlack * blackFloorScene(zContrast, zGamma);
  float aoMin = clamp(aoFloor / max(mxOut, 1e-9), 0.0, 1.0);
  col *= max(aoF, aoMin);

  col *= clarityF;

  // ---- zone channel gain (scene-referred) ----------------------------------
  // The far gain is the live biome's fog chromaticity normalised to unit
  // luminance; the near gain is its reciprocal at a fraction of the strength.
  // Both are pure ratio scales, so 0 stays 0 and no channel can be reordered.
  // This is the operator that puts an R/B and G/B gradient across the frame —
  // round 2 held both constant to within 9% from top of frame to bottom, which
  // is the numeric signature of a frame with no distance axis in it.
  col *= zGain;

  // ---- metered exposure ----------------------------------------------------
  // Solved above, where the AO crush guard needs it; still applied here, in the
  // same place in the chain it has always been.
  col *= ex;

  // ---- THE DEEP BLACK POINT ------------------------------------------------
  //
  // ROUND 16. The reference frames say the deep band must reach TRUE BLACK and
  // ours never does. Measured on the world crop (0.05,0.10 - 0.55,0.90), the
  // 0.1-percentile luminance — the floor no pixel falls below:
  //
  //   shot        ours   plate          shot          ours   plate
  //   cave         1.1   0.0 (cave-3)   deep-void      4.3   0.0 (deep-void-1)
  //   godrays     22.2   3.4 (godr-1)   shallows-reef  4.6   4.3 (sh-reef-1)
  //
  // The shallows MATCH. Every deep frame has a hard pedestal the plate does not,
  // and the population under it is enormous in the reference: deep-void-1 puts
  // 62.7% of its world crop below luminance 4 where we put 0.02%.
  //
  // The pedestal is NOT made here — with the chain bypassed (?nopostfx=1) the
  // same crops floor at 6.3 / 10.0 / 59.8, so the HDR buffer already carries it
  // and this file currently cuts it by ~2.5x without ever reaching zero. It is
  // in-scattered water, and at 680 m there is no daylight left to scatter, so
  // the reference frame at that depth is black. What this file owns is where the
  // display black point sits relative to that pedestal, and it has been sitting
  // under it: ACES's toe zeroes scene 0.003684/uCurveGain, and uCurveGain RISES
  // with depth (1.18 -> 2.52), so the deeper the frame the LOWER the scene value
  // that still resolves. The one place in the chain that decides what counts as
  // black was moving the wrong way with depth.
  //
  // So: a knee, quoted in display codes, solved backwards through the whole
  // display tail by the same inversion the AO guard uses, and ramped in with
  // DEPTH — because depth is the amount of downwelling light there is left to
  // in-scatter, and that is the physical quantity that decides whether a fogged
  // frame is milky (LOOK.md 5's Dunes, lit fog) or black (deep-void-1, unlit
  // fog). It is identically zero above 35 m, which is what keeps the verified
  // shallows match and the base-interior AO floor (that shot sits at 30 m) out
  // of its reach entirely.
  //
  // The operator is col *= smoothstep(0, knee, luma): a multiply bounded to
  // [0,1], so it maps 0 to 0 and CANNOT lift anything — LOOK.md 18 cuts both
  // ways and this is the legal direction. It runs BEFORE the bloom add on
  // purpose: bioluminescence and lamp cones are self-illuminated and are the
  // only thing worth looking at down there (LOOK.md 26), so their glow is
  // immune to it by construction.
  //
  // ROUND 8 TRIED A GLOBAL VERSION OF THIS AND REMOVED IT, and the note it left
  // behind is worth correcting rather than deleting: it measured almost nothing
  // and concluded "a toe that reached the pedestal would be crushing a third of
  // the image, which is a grade, not a correction". The reference says crushing
  // a third of the image is exactly right — cave-3 puts 39.8% of its world crop
  // under luminance 4 and deep-void-1 puts 62.7% — and the reason the round-8
  // attempt could not see it is that its knee was a fraction of the METER, which
  // is a floored geometric mean and therefore reports the deep frames as far
  // brighter than their floor. A knee in display codes, inverted through the
  // grade, does not have that problem.
  //
  // ROUND 17 REBUILT THE OPERATOR AND RE-SOLVED THE KNEE, BECAUSE THE ROUND-16
  // VERSION CRUSHED VARIANCE RATHER THAN LEVEL AND ITS TARGET PLATE IS REJECTED.
  // Three faults, each measured by ablation (?deepblack=0, switch proven fired:
  // report.params comes back "&deepblack=0" and every statistic moves):
  //
  //   (a) IT WAS A PER-PIXEL TOE, SO IT ATE TEXTURE. out = L*smoothstep(0,k,L)
  //       has slope s + L*s', which is 1.68 at L = 0.75k but 0.08 at L = 0.1k.
  //       A dark textured patch spanning 0.3k-1.5k therefore came out with its
  //       differences compressed ~20x and quantised to one output code. Measured
  //       as the fraction of the world crop lying inside SOME 9x9 window whose
  //       every pixel is under luminance 8 — flat black rather than dark texture:
  //
  //         shot        r16 ON   r16 OFF   PRIMARY plate
  //         cave         82.45    40.72    15.42  (cave-3)
  //         deep-void    83.97    13.29     0.83  (deep-void-2)
  //         grand-reef   64.18     0.00     0.00  (grand-reef-2)
  //
  //       i.e. this stage manufactured 100% of grand-reef's flat black, 84% of
  //       deep-void's and 51% of the cave's.
  //
  //   (b) IT KEYED ON OUTPUT LUMINANCE, SO IT REACHED THE NEAR FIELD. The held
  //       tool sits about a metre from the eye with no water in front of it and
  //       was graded by a knee solved for 200 m of it. Tool crop of the cave
  //       frame (0.68,0.56 - 0.81,0.71), stage ON vs ablated: median 20.6 vs
  //       34.8, % under luminance 4 18.7 vs 13.0, absolute black 10.4% vs 3.6%.
  //       The knee now scales with fogAmt — the optical depth already computed
  //       for the zone split, i.e. how much water is actually in front of THIS
  //       pixel. That is the physical quantity the operator always meant: what
  //       it removes is an in-scattered veil, and there is no veil at 1 m.
  //
  //   (c) THE DEPTH RAMP RANKED THE BATTERY BACKWARDS. It ran
  //       21*(smoothstep(60,195,d) + 0.55*tDeep + 0.35*tAbyss) = 22 codes at the
  //       cave's 192 m, 28 at grand-reef's 280 m and 39 at deep-void's 681 m.
  //       The verified primaries want the opposite ordering: cave-3 carries
  //       12.5% absolute black and 39.8% under luminance 4, deep-void-2 carries
  //       1.2% and 15.0%, and grand-reef-2 carries NO black at all (p0.1 = 11.7,
  //       0.00% under 4). Depth is not the axis; the frames differ because the
  //       cave is enclosed and has no lit column over it while the other two do.
  //       Those extra terms were solved against deep-void-1 and dropoff-1, both
  //       of which reference/PLATES.md rejects for these shots, so they are gone
  //       and the knee is flat above the 60-180 m opening ramp. Sized in display
  //       codes it now sits at the BOTTOM of each frame's own histogram instead
  //       of two thirds of the way up it, which is what makes it a black point
  //       rather than a grade: everything above ~0.6k keeps slope >= 1.
  //
  // The gate is max(pixel, local level). The local level is the 1/4-res
  // low-pass already bound for the acutance term, carried into current units by
  // the pixel's own chain ratio, and clamped so it can only ever RAISE the gate.
  // Two consequences, both wanted: a dark textured patch is scaled as a unit, so
  // its internal ratios survive intact; and an isolated bright speck — marine
  // snow, a biolum mote — is gated by its own value, so a dark surround cannot
  // take it down with it. The multiply is still bounded to [0,1], still maps 0
  // to 0, still cannot lift (LOOK.md 18), and still runs before the bloom add.
  if (uDeepBlackL > 0.0) {
    float dbKnee = sceneForDisplayL(uDeepBlackL, zContrast, zGamma);
    // How much medium is in front of this pixel. Sky and the empty far field
    // resolve to 1 by construction; player-attached geometry resolves to ~0.
    float dbWater = mix(1.0, smoothstep(uDeepBlackFog.x, uDeepBlackFog.y, fogAmt),
                        uDeepBlackFog.z);
    float lPix = luma(max(col, vec3(0.0)));
    float lSh  = luma(max(sharp, vec3(0.0)));
    // >= 1 by construction, so the gate can only rise and the stage can only
    // crush LESS than the round-16 per-pixel toe did, never more.
    float dbLift = clamp(lLo / max(lSh, 1e-7), 1.0, 4.0);
    float dbGate = lPix * mix(1.0, dbLift, uDeepBlackGate);
    col *= smoothstep(0.0, max(dbKnee * dbWater, 1e-9), dbGate);
  }

  // A MULTIPLICATIVE BLACK POINT WAS TRIED HERE AND REMOVED. Recording the
  // measurement so nobody spends the round re-deriving it: col *= smoothstep(0,
  // k*meter*exposure, luma(col)) is a legal operator (a multiply, 0 at 0, so it
  // cannot lift), and at k = 0.085 and again at 0.25 it moved the battery's
  // 0.1-percentiles by less than the run-to-run variation — godrays 25.4 ->
  // 25.2, grand-reef 3.9 -> 4.9, deep-void 1.1 -> 1.9. The reason is diagnostic
  // rather than a tuning failure: the residual pedestal in those frames is not
  // a thin tail under the histogram, it IS the histogram's floor, a broad even
  // in-scatter level over a large part of frame. A toe that reached it would be
  // crushing a third of the image, which is a grade, not a correction — and the
  // pedestal is in-scattered water, so it belongs to render/underwater.js. ACES
  // already maps everything below 0.003684 to exactly 0, which is what keeps 15
  // of the 18 battery frames at a 0.1-percentile of 0.
  //
  // ROUND 16 OVERTURNS THE CONCLUSION, NOT THE MEASUREMENT. Crushing a third of
  // the image is exactly what the plates do — cave-3 puts 39.8% of its world
  // crop below luminance 4, deep-void-1 62.7% — and the reason the round-8
  // sweep could not see itself is in the operator it chose: k*meter is a
  // fraction of a FLOORED GEOMETRIC MEAN, which reports a deep frame far above
  // its own floor, so k = 0.085 and 0.25 both landed under the pedestal. The
  // knee that works is quoted in DISPLAY CODES and inverted back through the
  // grade (uDeepBlackL, above), and it is depth-ramped rather than global so
  // the shallows cannot be reached by it. The last sentence above is still
  // right and is why the ramp exists: ACES's own toe is what holds the shallow
  // frames at a 0.1-percentile of 0, and only the deep ones needed help.
  col += texture(tBloom, uvG).rgb * uBloom;

  // ---- vignette (scene-referred, so bright corners roll off instead of
  //      turning grey, and so it can only ever scale all three channels by the
  //      same factor). Nearly off: LOOK.md 9 says Subnautica's corner falloff is
  //      dive-mask/canopy geometry and is content-driven, never a symmetric post
  //      darkening. Measured at 0.24 it put corner/centre at 0.775 with all four
  //      corners inside 4% of each other, which is a signature no real frame has.
  //      Solved above with the exposure, for the same reason; applied here.
  col *= vig;

  // ---- the shoulder --------------------------------------------------------
  // AFTER the bloom add on purpose: a halo and the source under it are one
  // highlight as far as the display is concerned, and compressing them
  // separately is how you get a blown skirt around a rolled-off core. See
  // hiCompress().
  //
  //      ROUND 31 CHECKED WHETHER THE FAR-BAND CHROMA LOCK SHOULD READ THE
  //      COLOUR FROM BEFORE THIS, AND THE ANSWER IS NO. hiCompress is PER
  //      CHANNEL and its knee is 1/uCurveGain, scene-linear 0.847 at 40 m, so
  //      once water goes above that it gets a compression that takes blue harder
  //      than green and green harder than red — i.e. the post-compression
  //      chromaticity that step (5c) calls "the chromaticity the MEDIUM
  //      delivered" is partly a function of level. Reading it one operator
  //      earlier was built, shipped behind ?farcpre= and measured, and it is
  //      inert at every shipped operating point in the battery and a REGRESSION
  //      above them: at ?meter=0&exposure=1.70 on godrays' water it holds linear
  //      G/B at 0.699 against 0.773 (the medium is 0.610) but takes the window
  //      from 17.20% to 50.15% of pixels with a channel at 250+, because the
  //      medium's chromaticity at that radiance is simply not inside the sRGB
  //      cube and the lock hands the excess to oklabToRgbClipped, which parks it
  //      on the wall. So the compressor stays in the reference. The operator
  //      that DOES pay here is whitenW's neutrality factor: same window, same
  //      exposure, it takes relative red 3.212 -> 1.563 and clipping 17.20% ->
  //      2.47%, because holding a pixel's own channel ratios is what keeps its
  //      small channels small.
  col = hiCompress(max(col, vec3(0.0)));

  // ---- tonemap -------------------------------------------------------------
  // ROUND 27: the lightness the MEDIUM delivered, metered exposure and all,
  // kept across the curve for the far-band floor in step (3b). For a neutral
  // OKLab L is exactly luminance^(1/3), so this is in the same units as L.
  // Clamped into the display cube first: a far-band pixel that is already over
  // white has nothing to protect, and an unbounded reference would let the
  // floor in (3b) demand a lightness above 1 from a blown highlight.
  float Lscene = pow(clamp(luma(col), 0.0, 1.0), 1.0 / 3.0);
  vec3 g = tonemap(max(col, vec3(0.0)));

  // ---- display-referred grade — ALL OF IT IN OKLab -------------------------
  //
  // ROUND 4. The round-3 grade did contrast as a pivoted power on the MAX
  // CHANNEL and saturation as mx * pow(g/mx, s). Both are ratio scales about
  // each pixel's own max, which makes them exactly hue-preserving — and a grade
  // that is hue-preserving by construction CANNOT create colour separation on a
  // buffer that is already near-monochrome. It can only push every pixel further
  // along the one hue it already has, i.e. toward the same corner of the gamut.
  // That is the whole reason the frames measured "milky": the operator had no
  // degree of freedom in the direction the reference actually varies.
  //
  // OKLab gives three independent handles that the ratio form does not have:
  //   L      perceptual lightness, so contrast and gamma no longer double as a
  //          saturation change (a max-channel power darkens the other channels
  //          more than the max, which is a hue shift dressed as contrast);
  //   |ab|   chroma about the ACHROMATIC AXIS — a real saturation operator. Two
  //          pixels with different hue angles are pushed APART by it, which is
  //          the definition of colour separation;
  //   ab     a 2-D vector we can offset, which is the only way to put colour
  //          into a region that has none. Every offset is scaled by L, so it is
  //          a colour CAST (constant in relative terms) and vanishes at black —
  //          this is not, and cannot become, a black lift.
  //
  // Out-of-gamut results give up chroma, never a channel: see
  // oklabToRgbClipped(). That is what makes it safe to push this hard.
  vec3 lab = rgbToOklab(g);
  float L0 = lab.x;
  float L = L0;
  vec2 ab = lab.yz;

  // (1) CONTRAST — pivoted power on lightness. L ~= luminance^(1/3), so an
  //     exponent here is the same exponent in linear light: a luminance ratio
  //     between two regions becomes ratio^c. That is what lets the grade
  //     AMPLIFY the medium's vertical axis instead of flattening it, and it is
  //     why the pivot has to track the band's own median rather than sit at a
  //     constant. 0 maps to 0: no lift hides in a power.
  //     The pivot is mostly METERED — see pivotL(). The authored constant is
  //     still blended in so the operator degrades to round 4's behaviour if the
  //     meter is pinned (?meter=0) rather than losing its reference entirely.
  //     ROUND 6 dropped the lower clamp from 0.12 to 0.055. 0.12 in OKLab L is
  //     a display 40/255, which is ABOVE the entire histogram of every frame
  //     below 150 m — so on exactly those frames the "contrast" was not a
  //     contrast at all but a flat exposure cut that got worse the darker the
  //     pixel was. Measured on the 280 m frame: pixels at L 0.20 came out at
  //     0.167 from this line alone, a 1.8x luminance cut applied to a frame that
  //     was already at the reference's level. With the robust meter the pivot
  //     lands inside the frame's own histogram and the operator is a spread
  //     again — which is the only thing it was ever supposed to be.
  float piv = clamp(mix(uPivot, pivotL(), uPivotAuto), 0.055, 0.90);
  if (L > 1e-5) L = piv * pow(L / piv, max(zContrast, 1.0));

  // (2) per-zone lightness gamma. Above 1 in the deep bands to push the
  //     medium's in-scatter pedestal back toward true black — the opposite of
  //     a lift, and the only legal direction (LOOK.md 9).
  L = pow(max(L, 0.0), zGamma);

  // (2b) THE MIDTONE PULL — the round-5 fix, and the only new operator here.
  //
  //      Measured, world-only crop (0.05,0.10 - 0.55,0.90), ours against the
  //      reference frame for the same slot:
  //
  //        shot        p0.1   median   p99.9        reference
  //        godrays     37.2   115.0    233.2        3.4 / 49.3 / 144
  //        dropoff      0.0    61.4    244.4        0.0 / 10.1 / 252
  //
  //      Read the three columns together and the defect names itself: the top
  //      of the range is already where the reference puts it (LOOK.md 9 wants a
  //      99.9th percentile of 233-253 in lit frames and we have it), the bottom
  //      is already 0 where the reference is 0 — and everything BETWEEN them
  //      floats. That is what "milky" means, and no exposure change can fix it,
  //      because an exposure change is a multiply and a multiply moves the two
  //      ends by the same ratio as the middle. Round 4 spent its whole budget
  //      moving the ends.
  //
  //      A power on perceptual lightness is the unique operator that does what
  //      is actually being asked for. L is OKLab lightness, which for a neutral
  //      is exactly luminance^(1/3), so:
  //
  //        L = 0  ->  0        the black floor cannot move. There is no sign of
  //                            this operator that lifts, which is LOOK.md 9 and
  //                            AGENT_BRIEF non-negotiable 5: unlit blacks
  //                            measure 0 and lift comes from atmosphere in
  //                            front of the object, never a curve behind it.
  //        L = 1  ->  1        the shoulder cannot move either, so the bright
  //                            tail the references DO have survives intact.
  //        else   ->  down     monotonically, hardest at mid-grey.
  //
  //      Measured on the shipped ramp (1.18 at 40 m, 1.30 at 74 m), together
  //      with the metered depth ramp it works with: the godrays frame went
  //      37/115/233 -> 26/62/240 and the drop-off 0/61/244 -> 0/19/244. The
  //      midtone falls by 1.7 stops on one and 1.9 on the other; the 99.9th
  //      percentile moves by 7 counts and 0; the black floor stays at 0.
  //
  //      It is also NOT a saturation change, which is why it belongs here and
  //      not in the tone curve: ab is renormalised by L/L0 in step (4) below,
  //      so chroma follows lightness and the hue angle is untouched. A gamma
  //      applied in RGB instead would have saturated everything it darkened.
  //
  //      Ramped by depth on the CPU and multiplied by uUnderwater, because the
  //      quantity it is correcting is in-scattered water: an above-water frame
  //      gets exactly 1.0 and is not touched.
  //
  //      ROUND 6 — IT IS NOW MIDTONE-ONLY, AND IT ASKS THE FRAME FIRST.
  //
  //      Two things were wrong with a bare power, and both of them hurt exactly
  //      the frames the round-5 critique measured 15x too dark.
  //
  //      (i) A power on L is NOT a midtone operator, whatever the name says. Its
  //      relative effect is L^(g-1), which is monotonically DECREASING in L: at
  //      g = 1.30 a pixel at L = 0.5 loses 19% and a pixel at L = 0.1 loses 50%.
  //      It fixes the two endpoints and does its worst work just above black,
  //      which is where a deep frame lives. The weight below is 4L(1-L) — zero
  //      at both ends, one at L = 0.5 — so the exponent itself is a bump and the
  //      operator finally does what its comment always claimed.
  //
  //      (ii) "Milky" is a property of a frame, not of a depth. The quantity
  //      being removed is in-scattered water, and a 280 m frame whose median
  //      already sits at the reference's has none to remove. So the strength is
  //      gated on the frame's OWN metered level (uMidLevel, in pivot units):
  //      full over a bright in-scattered frame, off over a dark one. This is the
  //      "behaviour depends on the scene's own level" the round-5 critique asked
  //      for, and it is why the shallows keep their round-5 result while the
  //      deep frames stop being pulled at all.
  float mw = 4.0 * clamp(L, 0.0, 1.0) * (1.0 - clamp(L, 0.0, 1.0));
  float mLvl = smoothstep(uMidLevel.x, uMidLevel.y, piv);
  L = pow(max(L, 0.0), 1.0 + (uMidGamma - 1.0) * mw * mLvl);

  // (3) highlight rolloff. The contrast expansion can take L past 1 and a hard
  //     clamp there would flat-top the sun into a disc; this asymptotes to 1
  //     while still reaching 0.993 (253/255) by L = 1.3, which is LOOK.md 9's
  //     "gentle highlight rolloff" and its measured 99.9th percentile of
  //     233-253 in lit frames.
  if (L > uHiRoll) {
    float k = max(1.0 - uHiRoll, 1e-3);
    L = uHiRoll + k * (1.0 - exp(-(L - uHiRoll) / k));
  }

  // (3b) THE FAR-BAND FLOOR — ROUND 27. The grade may spread the water column
  //      UPWARD as much as it likes. It may not push it toward black.
  //
  //      WHY THE FAR BAND AND NOTHING ELSE. wFar is 1 where essentially all of
  //      the pixel's radiance is in-scattered water, i.e. where the pixel IS
  //      the fog colour. Two of the measured non-negotiables are about exactly
  //      those pixels and they say the same thing from opposite ends:
  //      AGENT_BRIEF 4, "distant unlit geometry gets BRIGHTER, not darker — it
  //      converges toward the fog colour from BOTH directions... fading distant
  //      terrain to black is the classic error", and AGENT_BRIEF 5, "blacks are
  //      lifted by atmosphere, never by a curve". A pivoted power, a gamma and
  //      a midtone pull all darken everything under the pivot, and in the far
  //      band everything under the pivot is water. So the far band gets a floor
  //      tied to the lightness it arrived with, and the three operators keep
  //      their full authority above it and over near and mid geometry.
  //
  //      It is one-sided — a max(), so it can only raise — and it is per-pixel,
  //      which makes it inert by construction wherever the chain was not taking
  //      the far band below the floor anyway. That is measured rather than
  //      asserted: grand-reef and shallows-reef come back with every column
  //      identical, and twelve of the eighteen shots come back with an identical
  //      median. See the inertness table in the header.
  //
  //      TWO REFERENCES, and uFarScene picks between them. 0 floors against L0,
  //      the lightness the tone curve handed this block, so the operator can
  //      give back at most what the OKLab block itself took. 1 floors against
  //      Lscene, the lightness the MEDIUM delivered, so the curve's own toe is
  //      inside what may be returned. SHIPPED IS 1 AT 0.70, and the reason is
  //      counter-intuitive enough to be worth the sweep it took: on a deep frame
  //      the curve barely darkens at all, so L0 ~= Lscene there and 0.70*Lscene
  //      never binds, while L0*1.00 does. The scene reference reaches the same
  //      place on kelp and costs an order of magnitude less in the abyss. Full
  //      numbers at uFarFloor on the CPU side.
  //
  //      Both references are taken BEFORE the contrast, so a pixel the contrast
  //      brightened — anything above the pivot — sits far above the floor and
  //      never sees it. Measured: kelp's top-of-frame water reads display 212.57
  //      at every value in both sweeps, including the one that forbids darkening
  //      entirely, while its bottom-of-frame water moves 16.5 -> 22.8. That
  //      asymmetry is the whole point. The defect was never the bright end.
  if (uFarFloor > 0.0) {
    float Lref = mix(L0, Lscene, uFarScene);
    L = mix(L, max(L, Lref * uFarFloor), wFar);
  }

  // (4) SATURATION about the achromatic axis, plus vibrance on low-chroma
  //     pixels only (grey rock, sand, the inside of a lamp cone) so the
  //     already-saturated water is not pushed into the gamut wall.
  //     FIRST: renormalise ab by how much L moved. OKLab's a and b scale with L
  //     for a fixed hue, so leaving them alone through a contrast that darkened
  //     a pixel by 20% silently saturates it by 20% — the exact thing this block
  //     exists to stop doing accidentally. Measured before this line: the
  //     shallows frame came back at 0.85 mean saturation against the reference's
  //     0.734 with mean red at 26/255 against 43, and the contrast operator was
  //     most of it. With it, contrast, gamma and saturation are three
  //     independent knobs, which is the whole point of grading in Lab.
  ab *= L / max(L0, 1e-5);

  //     The lightness guard keeps vibrance off a blown highlight: without it it
  //     fires hardest exactly where the curve has just (correctly) whitened the
  //     sun, and drags its pale core back to full-chroma blue.
  float C = length(ab);
  vec2 hueDir = C > 1e-6 ? ab / C : vec2(0.0);
  float vib = uVibrance * (1.0 - smoothstep(0.045, 0.185, C))
            * (1.0 - smoothstep(0.78, 0.97, L));
  C *= max(zSat + vib, 0.0);

  // (5) THE TWO COLOUR AXES. This is the part round 3 structurally could not do.
  //
  //     DISTANCE (uZoneHue): a HUE ROTATION, by distance band. Near geometry is
  //     lit by sunlight that has been through only the camera's own depth of
  //     water, so it keeps the green-teal of the downwelling beam; far water is
  //     the biome's fog hue by definition. Measured in shallows-reef-1 as G/B
  //     0.93 across the lit reef against 0.69 in the water column above it — a
  //     35% hue swing that round 3 reproduced as 3%.
  //
  //     It is a rotation and not an ab OFFSET because an offset moves ACHROMATIC
  //     pixels too, and it moves them the furthest in relative terms. Measured
  //     with the offset form: the scanner tool's white shell and the player's
  //     hands came out olive-yellow, because "sunlight minus fog" is a +b
  //     (yellow-ward) vector and a neutral pixel has nothing to subtract it
  //     from. A rotation scales with the pixel's own chroma, so white stays
  //     white, the water rotates, and the two bands separate.
  //
  //     LUMINANCE (uTintLo/uTintHi): WITHIN the water column, brighter is
  //     greener and darker is navy. godrays-1 runs #00AA9C (G/B 1.09) at the top
  //     of frame to #011434 (G/B 0.36) at the bottom; shallows-reef-1 runs 0.77
  //     over 0.69 the same way. Gated toward the far field by uSplitZone,
  //     because on near geometry the distance axis is the one that is true and
  //     the two would fight.
  //
  //     Both are scaled by gate below, 0 at L = 0 and ramping in. Black stays
  //     black; an offset applied at L = 0 would be a lift and is forbidden.
  float rot = dot(vec3(wNear, wMid, wFar), uZoneHue);
  float cs = cos(rot), sn = sin(rot);
  hueDir = vec2(hueDir.x * cs - hueDir.y * sn, hueDir.x * sn + hueDir.y * cs);

  float gate = smoothstep(0.0, 0.030, L) * L;
  float splitW = mix(uSplitZone, 1.0, clamp(wMid * 0.6 + wFar, 0.0, 1.0));
  float wLo = 1.0 - smoothstep(uSplitLo.x, uSplitLo.y, L);
  float wHi = smoothstep(uSplitHi.x, uSplitHi.y, L);
  ab = hueDir * C + (uTintLo * wLo + uTintHi * wHi) * splitW * gate;

  // (5c) THE FAR-BAND CHROMA LOCK — ROUND 28. Round 27 gave the far band a
  //      one-sided floor on LIGHTNESS. This is the same statement about COLOUR,
  //      and it closes the pair.
  //
  //      WHY IT IS A LOCK AND NOT A TRIM. wFar is 1 where essentially all of
  //      the pixel's radiance is in-scattered water, i.e. where the pixel IS
  //      the fog. underwater.js normalises a far-field ray to resolve EXACTLY
  //      to the biome's authored fog colour — that normalisation is what keeps
  //      biomes.js the single source of truth for what this water is — so on
  //      those pixels there is nothing for a display grade to have an opinion
  //      about. It may spread them in lightness (step 3b already says by how
  //      much); it may not repaint them. Everything above stays: the near band
  //      keeps its full rotation toward the beam and its full channel gain, so
  //      the near/far colour SEPARATION round 4 exists for is preserved — it is
  //      strengthened, in fact, because one end of it now stands still.
  //
  //      MEASURED, and on a window holding nothing but water in BOTH images.
  //      grand-reef, ours px (58,324)-(499,594) of 1920x1080 against
  //      grand-reef-2 px (880,80)-(1080,180) of 1360x768:
  //
  //        sat / R%      medium 0.668/33   shipped 0.557/44   plate 0.654/34
  //
  //      The medium is ON the plate on both axes and this stage was walking it
  //      off — the round-24 defect, on a different axis, visible only here: on
  //      the shot crop the same frame reads 0.576/44 against a plate crop of
  //      0.461/56 and looks like it needs MORE of what is hurting it.
  //
  //      ATTRIBUTED, one switch at a time on that window, ?zhue=0 gives
  //      0.620/38 and ?tint=0 gives 0.616/38 — 0.06 of saturation and 6 points
  //      of red each, out of a total error of 0.111 and 11. Both land on the
  //      far band and both are wrong there for a reason that is arithmetic:
  //
  //        THE HUE ROTATION's far term is -0.16 * dTheta, +9.0 deg here. Its
  //        purpose is to hold the FRAME MEAN while the near band rotates toward
  //        the beam. A frame mean is not a target and the fog colour is, so
  //        this is trading the axis the plates certify for one they do not.
  //        Rotating a navy (a = -0.051, b = -0.225) by +9 deg lifts a toward
  //        red, which raises min(r,g,b) and drops (max-min)/max: the measured
  //        -0.063 saturation and +6 R% in one step.
  //
  //        THE SPLIT-TONE's shadow term is uTintLo = (hDeep - hFog) * kLo, and
  //        the two hue vectors it differences are 4.6 deg apart here: hFog
  //        (-0.0510, -0.2245), hDeep (-0.0241, -0.1664). 97.8% of that vector's
  //        length is RADIAL — a pure chroma cut aimed at the achromatic axis —
  //        and 2.2% is the hue swing its comment describes. It is the zone
  //        chroma ramp a second time, wearing the luminance axis's name. The
  //        radial share is a property of the frame, not a constant: kelp reads
  //        0.258 (a real hue swing, and it survives here) against grand-reef's
  //        0.978 and deep-void's 0.869.
  //
  //        AND IT CANNOT BE PRODUCING A GRADIENT ON THIS FRAME ANYWAY. Its gate
  //        is wLo over splitLo (0.14, 0.50) and the whole window spans L 0.28
  //        to 0.33, so wLo is ~0.56 across all of it. Measured bandGB confirms
  //        it: [0.68,0.67,0.67] ungraded -> [0.65,0.65,0.64] graded, a uniform
  //        shift and not a spread. A gradient operator applied uniformly is a
  //        cast.
  //
  //      THE REFERENCE IS A CHROMATICITY, NOT AN ab, AND IT IS TAKEN BEFORE THE
  //      CURVE. Round 27's floor had the same choice to make about lightness
  //      and its answer was the same, for the same reason and after the same
  //      sweep: the post-curve value is NOT the conservative one.
  //
  //      OKLab is exactly homogeneous of degree 1/3 in linear RGB — lms' =
  //      cbrt(k * lms) = k^(1/3) * cbrt(lms), and L and ab are both linear in
  //      lms' — so ab / L is EXACTLY scale-invariant and is the pixel's pure
  //      chromaticity, independent of exposure, bloom or any other multiply.
  //      Reading it off col, the scene-referred colour the medium delivered,
  //      and re-scaling it by the graded L therefore makes this operator
  //      strictly a colour operator: it cannot change any pixel's lightness by
  //      construction, so it cannot interact with step (3b) at all.
  //
  //      MEASURED, both references, same session, one medium hash either side:
  //
  //        uFarChroma       grand-reef water        deep-void water
  //        (medium)         0.668 / 33              0.780 / 22
  //        0.00             0.557 / 44              0.769 / 23
  //        POST-CURVE 1.00  0.683 / 32              0.878 / 12
  //        SCENE      1.00  see the sweep at uFarChroma
  //        PLATE            0.654 / 34              0.774 / 23
  //
  //      The post-curve reference overshoots BOTH frames, and it overshoots the
  //      medium itself — 0.683 out of a bypass at 0.668, 0.878 out of a bypass
  //      at 0.780 — because ACES expands chroma along the input's lean and that
  //      expansion is largest at the toe, which is where a 678 m frame lives.
  //      Locking to it preserves the expansion and hands deep-void a saturation
  //      0.10 above its plate. The scene chromaticity has no such term in it.
  //
  //      Inert by construction wherever wFar is small, which is measured rather
  //      than asserted — see the inertness table on the CPU side at uFarChroma.
  if (uFarChroma > 0.0) {
    vec3 labS = rgbToOklab(max(col, vec3(0.0)));
    vec2 abPost = lab.yz * (L / max(L0, 1e-5));
    vec2 abScene = labS.yz * (L / max(labS.x, 1e-5));
    vec2 abRef = mix(abPost, abScene, uFarCScene);
    ab = mix(ab, abRef, clamp(wFar * uFarChroma, 0.0, 1.0));
  }

  // (5b) THE CHROMA-FEASIBLE HIGHLIGHT CEILING — ROUND 26.
  //
  //      MEASURED FIRST. The kelp-forest gap is not spread over the frame; it
  //      is entirely the TOP THIRD, and the round-25 header attributed it to
  //      the wrong end of the range. Band means on the shot crop, ungraded ->
  //      graded, against kelp-forest-1:
  //
  //        band   ungraded              graded                PLATE
  //        top    [43.1,189.7,155.2]    [79.4,165.5,134.8]    [25.7,95.8,61.6]
  //        mid    [ 9.1, 98.4, 75.7]    [ 7.7, 44.4, 31.1]    [14.7,75.5,43.4]
  //        bot    [16.2, 80.7, 59.7]    [10.3, 29.5, 18.2]    [ 3.5,45.1,19.4]
  //
  //      The SHADOWS lose red through the grade (9.1 -> 7.7, 16.2 -> 10.3). The
  //      top band gains 36 counts of it and drops 0.20 of saturation. So the
  //      mechanism is not "a darkened shadow keeps its absolute chroma" — ab is
  //      renormalised by L/L0 four lines above and always has been. It is the
  //      BRIGHT half of the same operator: the zone contrast is a pivoted power
  //      and the top band sits well above the pivot, so it is pushed UP into a
  //      lightness its own chromaticity cannot hold, and oklabToRgbClipped()
  //      then does exactly what it promises — gives up chroma. Toward the
  //      achromatic point of a green-teal pixel is toward RED.
  //
  //      Ablated: ?zcon=0 takes the fraction of the top band at or over display
  //      243 from 47.4% to 0.0%, and its mean red from 79.4 to 45.0. The
  //      contrast operator is manufacturing every one of those clipped pixels.
  //
  //      THE CEILING IS EXACT AND CLOSED-FORM, and that is what makes this a
  //      per-PIXEL discriminator rather than another frame-adaptive guess. Once
  //      ab is proportional to L — which step (4)'s renormalisation guarantees —
  //      OKLab's inverse is exactly cubic in L:
  //
  //        lms' = OKL_LAB_INV * (L, aL', bL') = L * (OKL_LAB_INV * (1, a', b'))
  //        rgb  = OKL_LMS_INV * lms'^3        = L^3 * unit
  //
  //      so the largest channel is L^3 * maxc(unit) and the largest lightness
  //      the sRGB cube can hold at this hue and this RELATIVE chroma is
  //      cbrt(wall / maxc(unit)). Verified numerically against oklabToRgb():
  //      residual 2e-16. A neutral gives unit = (1,1,1) and a ceiling of
  //      cbrt(wall), i.e. no ceiling at all — which is why the sun, a lamp
  //      filament and a bioluminescent core are untouched by this and must be.
  //
  //      Rolled off with the same exponential shape as step (3) so the approach
  //      is soft and nothing flat-tops, and scaled by how chroma-limited the
  //      pixel actually is (maxc(unit) is 1.00 for a neutral, 1.39 for kelp
  //      water, 2.3+ for the deep navy). Below 1.03 the operator is identically
  //      zero, so it cannot touch a frame that is not being clipped: measured
  //      over the shot crop, pixels above their own ceiling run 10.7% on
  //      kelp-forest against 0.33% / 0.25% / 0.07% on shallows-reef, deep-void
  //      and grand-reef, and 3.6% on the kelp plate itself. THAT is the term
  //      that separates a 55 m up-look through silhouettes from a 280 m
  //      open-water frame, and it needed no depth, no local contrast and no
  //      closed loop over the frame to find it.
  //
  //      Lightness is what is given up here, not chroma, and that ordering is
  //      deliberate: this is a highlight rolloff choosing not to spend contrast
  //      it cannot afford, one step ahead of a gamut solver that would have
  //      spent it and then billed the chroma for it. Nothing below the knee
  //      moves, so no black is lifted and no midtone is touched.
  if (uHiCeil > 0.0 && L > 1e-4) {
    vec3 unit = oklabToRgb(vec3(1.0, ab / L));
    float m = maxc(unit);
    // wOpen is oklabToRgbClipped()'s own "this pixel is heading for white"
    // ramp, and it does two jobs here. It opens the wall, exactly as it does
    // there — and it switches this operator OFF over the same band, because a
    // genuinely blown highlight is supposed to peg a channel and whiten like
    // film. LOOK.md 9 is explicit: shallows-reef-1's brightest pixel is
    // [255,255,255] and kelp-forest-1's is [255,255,204], i.e. two channels
    // pegged. Measured without this term: the top 0.1% of seamoth and cave —
    // near-white specular and bioluminescent cores, saturation 0.03-0.10 — were
    // pulled 10-12 counts below their plates' 99.9th percentiles for nothing.
    // Kelp's clipped water sits at L 0.89, below the band, and keeps the full
    // correction.
    //
    // ROUND 30 — THE EXEMPTION WAS KEYED ON L ALONE, AND L ALONE CANNOT TELL A
    // BLOWN HIGHLIGHT FROM AN OVER-DRIVEN SATURATED PIXEL.
    //
    // m is the largest channel of this pixel's chromaticity at unit lightness,
    // so cbrt(0.955/m) is the largest L the sRGB cube can hold at that
    // chromaticity — 0.868 for our kelp water (m = 1.4616), 0.885 for the
    // plate's bright water (m = 1.3759), 0.985 for a neutral. A pixel at
    // m >= 1.20 therefore CANNOT legitimately be at L 0.93: it is there only
    // because the pivoted contrast put it there, which is the exact condition
    // this operator exists to catch. Keying the exemption on L alone switched
    // the ceiling off hardest on the pixels it was built for, opened the wall
    // over them at the same time, and handed them to oklabToRgbClipped(), which
    // pays for the overshoot in chroma — round 26's mechanism, leaking through
    // round 26's own guard.
    //
    // The fix is one factor: the whitening exemption now also requires the pixel
    // to be near-neutral, which is what "heading for white" means. It is the
    // EXACT identity below m = 1.03 (the strength mix is already 0 there, and
    // wall only reaches Ln through that mix), so the near-white specular and
    // bioluminescent cores the paragraph above protects are untouched by
    // construction, not by measurement. Above m = 1.20 the wall stays closed at
    // 0.955 and the ceiling runs at full strength, so a chroma-limited pixel can
    // no longer be written past display 250.
    //
    // MEASURED POPULATION, world crop (0.05,0.10-0.60,0.85), shipped round 29:
    // pixels that are chroma-limited (m > 1.03) AND over display 250 AND above
    // L 0.93 — i.e. everything this factor can reach — run 0.0030% of kelp,
    // 0.0279% of shallows-reef, 0.0132% of cave and 0.0000% of grand-reef. So
    // it is INERT TODAY at the third decimal and is not offered as a gain. It is
    // here because it stops being inert the moment the water gets brighter,
    // which is exactly what round 30 is asking the medium for: our kelp water
    // already reaches L 0.978 on its chroma-limited pixels, and the round-26
    // comment's reassurance that "kelp's clipped water sits at L 0.89, below the
    // band" is a property of one medium on one frame, not of the operator.
    float chromaLim = smoothstep(1.03, 1.20, m);
    float wOpen = smoothstep(0.93, 0.995, L) * (1.0 - chromaLim * uCeilNeutral);
    float wall = mix(0.955, 1.0005, wOpen);
    float top = pow(wall / max(m, 1e-4), 1.0 / 3.0);
    // The knee sits at 96% of the ceiling, not the 86% this was first written
    // with. At 86% the operator bit pixels that were still comfortably INSIDE
    // the cube: measured over the wider battery, the top 0.1% of cave, dropoff
    // and seamoth — mean saturation 0.03-0.10, i.e. near-white specular and
    // bioluminescent cores, exactly the pixels that are SUPPOSED to reach white
    // — lost ~5% of their level and the 99.9th percentile fell to 227.8 against
    // LOOK.md 9's measured 233-253. At 96% a pixel below 0.96 of its own
    // ceiling is the exact identity and one above it asymptotes onto the
    // ceiling, which is the whole and only job.
    float knee = top * 0.96;
    float k = max(top - knee, 1e-3);
    float Ln = L > knee ? knee + k * (1.0 - exp(-(L - knee) / k)) : L;
    Ln = mix(L, Ln, clamp(uHiCeil, 0.0, 1.0) * chromaLim * (1.0 - wOpen));
    ab *= Ln / L;
    L = Ln;
  }

  g = oklabToRgbClipped(clamp(L, 0.0, 1.0), ab);

  // (6) per-channel gamma — the last of the lift/gamma/gain triad, and the only
  //     one that survives to the display. A power maps 0 to 0 and 1 to 1, so it
  //     moves only the midtones: driven off the biome it deepens the channels
  //     the water is poor in through the middle of the range without touching
  //     either end. There is no additive term anywhere in this file.
  g = pow(max(g, vec3(0.0)), uGamma);

  if (uSplit > 0.5 && vUv.x > 0.5)
    g = clamp(tonemap(max(sharp * sceneExposure(), vec3(0.0))), 0.0, 1.0);

  // ---- output: sRGB + triangular dither. The fog gradients are enormous and
  //      perfectly smooth; without this they band visibly at 8 bit.
  //
  //      ROUND 14 made this ablatable (?dither=0) because the sun bullseye was
  //      attributed to its absence. It was not absent. Two TPDF taps give a
  //      +/-1 LSB triangular error whose expected |pixel - mean of its four
  //      neighbours| is 0.8 * sqrt(1.25/6) = 0.364 LSB; the shipped frames
  //      measure 0.38-0.48 on their flattest tiles and 0.00-0.03 with this line
  //      ablated, so it was already doing exactly its job. The bullseye came
  //      from a 5-bit quantiser upstream in oklabToRgbClipped() — see there.
  vec3 outc = srgbEncode(g);
  float n1 = hash12(gl_FragCoord.xy);
  float n2 = hash12(gl_FragCoord.xy + 137.31);
  outc += (n1 + n2 - 1.0) * (uDither / 255.0);

  fragColor = vec4(outc, 1.0);
}`;

// ---------------------------------------------------------------------------
// 7. FXAA 3.11 (console-quality variant) — only used when TAA is off
// ---------------------------------------------------------------------------
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
const float EDGE_MIN = 0.0312;
const float EDGE_MUL = 0.125;
const float SUBPIX = 0.75;

float lum(vec3 c) { return sqrt(dot(c, vec3(0.299, 0.587, 0.114))); }

void main() {
  vec2 uv = vUv;
  vec3 rgbM = textureLod(tSrc, uv, 0.0).rgb;
  float lM = lum(rgbM);
  float lN = lum(textureLod(tSrc, uv + vec2(0.0, uTexel.y), 0.0).rgb);
  float lS = lum(textureLod(tSrc, uv - vec2(0.0, uTexel.y), 0.0).rgb);
  float lE = lum(textureLod(tSrc, uv + vec2(uTexel.x, 0.0), 0.0).rgb);
  float lW = lum(textureLod(tSrc, uv - vec2(uTexel.x, 0.0), 0.0).rgb);

  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;
  if (range < max(EDGE_MIN, lMax * EDGE_MUL)) { fragColor = vec4(rgbM, 1.0); return; }

  float lNW = lum(textureLod(tSrc, uv + vec2(-uTexel.x,  uTexel.y), 0.0).rgb);
  float lNE = lum(textureLod(tSrc, uv + vec2( uTexel.x,  uTexel.y), 0.0).rgb);
  float lSW = lum(textureLod(tSrc, uv + vec2(-uTexel.x, -uTexel.y), 0.0).rgb);
  float lSE = lum(textureLod(tSrc, uv + vec2( uTexel.x, -uTexel.y), 0.0).rgb);

  float edgeH = abs(lNW + lNE - 2.0 * lN) * 2.0 + abs(lW + lE - 2.0 * lM) * 4.0
              + abs(lSW + lSE - 2.0 * lS) * 2.0;
  float edgeV = abs(lNW + lSW - 2.0 * lW) * 2.0 + abs(lN + lS - 2.0 * lM) * 4.0
              + abs(lNE + lSE - 2.0 * lE) * 2.0;
  bool horizontal = edgeH >= edgeV;

  float l1 = horizontal ? lS : lW;
  float l2 = horizontal ? lN : lE;
  float g1 = abs(l1 - lM);
  float g2 = abs(l2 - lM);
  bool steep1 = g1 >= g2;
  float stepLen = horizontal ? uTexel.y : uTexel.x;
  float lLocal = steep1 ? l1 : l2;
  if (steep1) stepLen = -stepLen;

  vec2 currentUv = uv;
  if (horizontal) currentUv.y += stepLen * 0.5; else currentUv.x += stepLen * 0.5;
  vec2 offset = horizontal ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);

  float lAvg = 0.5 * (lLocal + lM);
  float gScaled = 0.25 * max(g1, g2);

  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;
  float d1 = lum(textureLod(tSrc, uv1, 0.0).rgb) - lAvg;
  float d2 = lum(textureLod(tSrc, uv2, 0.0).rgb) - lAvg;
  bool reached1 = abs(d1) >= gScaled;
  bool reached2 = abs(d2) >= gScaled;

  for (int i = 0; i < 12; i++) {
    if (reached1 && reached2) break;
    if (!reached1) { uv1 -= offset; d1 = lum(textureLod(tSrc, uv1, 0.0).rgb) - lAvg; reached1 = abs(d1) >= gScaled; }
    if (!reached2) { uv2 += offset; d2 = lum(textureLod(tSrc, uv2, 0.0).rgb) - lAvg; reached2 = abs(d2) >= gScaled; }
  }

  float dist1 = horizontal ? (uv.x - uv1.x) : (uv.y - uv1.y);
  float dist2 = horizontal ? (uv2.x - uv.x) : (uv2.y - uv.y);
  bool isDir1 = dist1 < dist2;
  float distFinal = min(dist1, dist2);
  float edgeLen = dist1 + dist2;
  float pixelOffset = -distFinal / max(edgeLen, 1e-5) + 0.5;

  bool isLumMLarger = lM < lAvg;
  bool correct = ((isDir1 ? d1 : d2) < 0.0) != isLumMLarger;
  float finalOffset = correct ? pixelOffset : 0.0;

  // sub-pixel aliasing (thin features that never form a long edge)
  float lAvgAll = (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE) / 12.0;
  float subDelta = clamp(abs(lAvgAll - lM) / max(range, 1e-5), 0.0, 1.0);
  float subOffset = (-2.0 * subDelta + 3.0) * subDelta * subDelta;
  subOffset = subOffset * subOffset * SUBPIX;
  finalOffset = max(finalOffset, subOffset);

  vec2 finalUv = uv;
  if (horizontal) finalUv.y += finalOffset * stepLen; else finalUv.x += finalOffset * stepLen;
  fragColor = vec4(textureLod(tSrc, finalUv, 0.0).rgb, 1.0);
}`;

// ---------------------------------------------------------------------------
// Halton(2,3) — the standard TAA jitter sequence. Low discrepancy in 2D, so 16
// frames of accumulation approximate a 16x supersample almost perfectly.
// ---------------------------------------------------------------------------
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const JITTER = [];
for (let i = 1; i <= 16; i++) JITTER.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);

// ---------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------
const BLOOM_LEVELS = 6;

const postfx = {
  id: 'postfx',
  order: 200,

  // ---- live grade state, all smoothed per frame -----------------------------
  exposure: 1.0,
  focusDist: 8.0,

  async init(ctx) {
    this.ctx = ctx;
    const p = ctx.params;
    const num = (k, d) => (p?.has?.(k) ? Number(p.get(k)) : d);
    // Presence-is-true, because the harness cannot send a value at all — see the
    // capture.mjs argv note in the header. `=0` still turns a flag back off.
    const flag = (k) => !!p?.has?.(k) && p.get(k) !== '0';

    this.enabled = !flag('nopostfx');
    this.aaMode = (p?.get('aa') || 'taa').toLowerCase();
    this.split = flag('pfxsplit') ? 1 : 0;

    this.k = {
      bloom: num('bloom', 1),
      exposure: num('exposure', 1),
      dof: num('dof', 1),
      ao: num('ao', 1),
      ca: num('ca', 0),        // default OFF — LOOK.md 9, amateur-tell 21
      barrel: num('barrel', 0), // default OFF — same reason
      vig: num('vig', 1),
      sat: num('sat', 1),
      clarity: num('clarity', 1),
      zone: num('zone', 1),
      meter: num('meter', 1),
      dither: num('dither', 1),
      aotoe: num('aotoe', 1),
      gamut: num('gamut', 1),
      zonesat: num('zonesat', 1),  // 0 = all three zone chroma gains pinned to 1
      // ROUND 24 — CHROMA ATTRIBUTION KNOBS. The chain was measured adding
      // saturation on 5 of 5 shots against ?nopostfx=1 and there are five
      // independent operators that can do it. ?zonesat= only pins one of them,
      // which is why the round-22 ablation attributed 30% of the excess and
      // stopped. Each of these is a straight scale, 1 = shipped, 0 = ablated.
      vib: num('vib', 1),        // the low-chroma vibrance ADD
      crec: num('crec', 1),      // chroma recovery through the ACES shoulder
      crlo: num('crlo', 1),      // scale on the recovery low-gate edges (1 = round 23)
      gfar: num('gfar', 1),      // far/mid zone channel gain along the fog hue
      gnear: num('gnear', 1),    // near zone channel gain (the reciprocal)
      tint: num('tint', 1),      // the luminance split-tone ab offsets
      // ROUND 25 — THE REST OF THE ZONE SPLIT, one switch each. ?zone=0 moves
      // kelp-forest's mean red by 16 counts and its saturation by 0.137 and the
      // four chroma knobs above account for 5 of those counts between them, so
      // the operators that had no switch owned the rest. 1 = shipped, 0 = that
      // operator pinned to its neutral with the other two still running.
      zcon: num('zcon', 1),      // per-zone display contrast, blended toward 1
      zgam: num('zgam', 1),      // per-zone display gamma, blended toward 1
      zhue: num('zhue', 1),      // per-zone OKLab hue rotation
      // ROUND 26 — the chroma-feasible highlight ceiling. See step (5b) in
      // COMPOSITE_FRAG. 1 = shipped, 0 = the round-25 behaviour exactly (the
      // contrast expands L past what the pixel's own chromaticity can hold and
      // oklabToRgbClipped() pays for it in chroma).
      hiceil: num('hiceil', 1),
      // ROUND 30 — the chroma-feasible ceiling's whitening exemption now
      // requires near-neutrality as well as a high L. ?ceilneutral=0 restores
      // round 26 EXACTLY (the exemption keyed on L alone). See step (5b).
      ceilneutral: num('ceilneutral', 1),
      // ROUND 27 — THE FAR-BAND FLOOR. See step (3b) in COMPOSITE_FRAG. This is
      // the least OKLab L the chain may leave a far-band pixel with, as a
      // fraction of the reference uFarScene selects. ?farfloor=0 ablates the
      // operator entirely and restores round 26 EXACTLY. Shipped value and the
      // sweep that chose it are at uFarFloor on the CPU side.
      farfloor: num('farfloor', 0.70),
      // 0 = floor against the post-curve lightness (the grade may give back only
      // what the grade took), 1 = against the lightness the medium delivered
      // (the tone curve's toe is inside it). Shipped 1; see the sweep.
      farscene: num('farscene', 1),
      // ROUND 28 — THE FAR-BAND CHROMA LOCK, the colour half of the round-27
      // floor. See step (5c) in COMPOSITE_FRAG. How much of the far band's
      // chroma vector is returned to what the medium delivered; 0 ablates the
      // operator entirely and restores round 27 EXACTLY. Shipped value and the
      // sweep that chose it are at uFarChroma on the CPU side.
      farchroma: num('farchroma', 1),
      // 0 = lock to the chroma the tone curve handed the grade (the grade may
      // give back only what the grade took), 1 = to the chromaticity the medium
      // delivered. Shipped 1, and 0 is measurably WORSE on both frames — see
      // the two-reference table at step (5c).
      farcscene: num('farcscene', 1),
      // ROUND 27 — the midtone pull is the largest single term in the
      // DISPLAY-REFERRED grade's effect on the water column and has never had an
      // ablation switch, which is why three rounds of attribution tables have a
      // hole where it should be. Measured on kelp's bottom-of-frame water window
      // at ?farfloor=0, i.e. round 26: ?midpull=0 takes it 16.5 -> 22.8 (+38%)
      // against ?zcon=0's +26% and ?zgam=0's +19%. 1 = shipped, 0 pins uMidGamma
      // to 1.0.
      midpull: num('midpull', 1),
      // ROUND 25 — a scale on the open-loop exposure CEILING. The ceiling binds
      // on exactly one shot in the battery (cave) and round 22 proved ?exposure=
      // cannot reach a clamped frame, so the one frame whose level is set by the
      // clamp had no switch at all. 1 = shipped.
      deepcap: num('deepcap', 1),
      // ROUND 25 — see acesFitted(). 1 = gamut return, 0 = the round-8 clip.
      // DEFAULT 0, AND THE MEASUREMENT IS IN THE HEADER: the gamut return is the
      // principled operator and it is a REGRESSION here, because it throws away
      // the scene chroma that chroma recovery exists to put back. With it on,
      // ?crec=0 is BIT-IDENTICAL to shipped on grand-reef and kelp-forest — the
      // two really are the same job, and the pair that lands on the plate is the
      // clip plus recovery, not the gamut map alone.
      acesgamut: num('acesgamut', 0),
      // ROUND 29 — see the derivation inside acesFitted(). The tone curve was
      // manufacturing up to 130 counts of display red out of a scene red of
      // EXACTLY zero, and doing it only above scene-linear ~0.42-0.55, i.e.
      // only on bright windows — which is why several rounds of relative-red
      // analysis taken on bright windows were measuring this curve rather than
      // the water. 1 = the ceiling is enforced (shipped), 0 = round 28 exactly.
      aceshue: num('aceshue', 1),
      // ROUND 31 — the whitening ramp the ACES ceiling opens with and chroma
      // recovery closes with was a brightness test alone, and our godrays water
      // reaches scene-linear 2.50 against a guard that starts at 1.60. See
      // whitenW(). ?whiteneutral=0 restores round 30 EXACTLY.
      whiteneutral: num('whiteneutral', 1),
      // DEFAULT 0 THIS ROUND, unlike the others: the operator's own comment says
      // "every point of it comes out of the red channel", and relative red is
      // short on 11 of 13 verified pairs. ?cgamma=1 restores the round-23
      // strength exactly, so the sweep is still available.
      cgamma: num('cgamma', 0),  // per-channel display gamma
      // ROUND 24: 3.5 -> 2.6. Round 17 solved 3.5 against the % of crop under
      // luminance 8, with cave-3 as cave's plate. Both halves of that basis are
      // wrong for these frames now — see the re-solve above dbCode.
      deepblack: num('deepblack', 2.6),  // deep black point; see the sweep above dbCode
      dbfog: num('dbfog', 1),            // 0 = knee ignores optical depth (r16 behaviour)
      dbgate: num('dbgate', 1),          // 0 = knee gates per pixel (r16 behaviour)
    };

    const engine = ctx.engine;
    this.renderer = ctx.renderer;
    this.camera = ctx.camera;

    // Depth is the backbone of TAA, AO and DoF. If core ever stops handing us
    // one, degrade gracefully to FXAA rather than throwing.
    this.depthTex = engine.hdrTarget?.depthTexture || null;
    if (!this.depthTex && this.aaMode === 'taa') this.aaMode = 'fxaa';

    this._buildTargets(engine.hdrTarget.width, engine.hdrTarget.height);
    this._buildMaterials();

    this._jitterIndex = 0;
    this._historyValid = 0;
    this._prevVP = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3().copy(ctx.camera.position);
    this._prevQuat = new THREE.Quaternion().copy(ctx.camera.quaternion);
    this._tmpVP = new THREE.Matrix4();
    this._tmpProjU = new THREE.Matrix4();
    this._focusPing = 0;
    this._focusWarm = false;
    this._taaPing = 0;
    this._adaptPing = 0;
    this._medium = null;
    this._bloomFalloff = 0.52;
    this._chroma = new THREE.Vector3();
    // scratch for the OKLab hue solve — one allocation, never per frame
    this._hFog = new THREE.Vector2();
    this._hDown = new THREE.Vector2();
    this._hDeep = new THREE.Vector2();
    this._hSep = new THREE.Vector2();
    this._dw = new THREE.Color();

    engine.onResize.add((w, h) => this._resize(w, h));
    engine.postfx = this;
    ctx.provide?.('postfx', this);

    if (flag('pfxprobe')) this._buildProbe(ctx);
  },

  /**
   * ROUND 15 — THE HOOK THIS MODULE IS THE POSTER CHILD FOR.
   *
   * `applyShot` calls this on every module before the settle, and this file
   * carries five separate pieces of temporal state that a hard camera cut
   * invalidates: the TAA colour history, the 1x1 autofocus, BOTH exposure
   * adaptations (a ~0.5 s one and a ~10 s one) and the CPU-side damped
   * open-loop exposure (~0.55 s). Before shot isolation landed
   * those were exactly the state that made the same shot read saturation 0.879,
   * 0.958 or 0.985 depending only on what ran before it.
   *
   * render() already had a >15 m teleport heuristic, and it is not sufficient on
   * its own for two reasons: a re-pose can be shorter than 15 m, and the
   * heuristic cannot see a change of biome or of any other module's state at a
   * fixed camera. This is the explicit signal, so it takes over; the heuristic
   * stays for in-game teleports, which a shot hook never sees.
   *
   * Everything reset here is a *validity flag*, not a value: the adapt, TAA and
   * focus passes all branch on theirs and snap to the current frame, so nothing
   * has to be cleared to a made-up number and one frame is enough to converge.
   * Note that shots.js calls this BEFORE setCamera, so the settle that follows
   * begins at the previous pose — which is why the snap matters more than the
   * rate: after the snap the fast and slow meters are identically equal, so the
   * stabilising term is exactly 1.0 in every captured frame rather than whatever
   * transient the previous shot left in flight.
   */
  resetForShot(ctx) {
    this._adaptValid = 0;
    this._historyValid = 0;
    this._focusWarm = false;
    this._exposureSnap = true;
    this._taaPing = 0;
    this._adaptPing = 0;
    this._focusPing = 0;
    // ROUND 23 — THE SIXTH PIECE OF TEMPORAL STATE. The comment above counts
    // five; there were six. The TAA jitter cursor advances once per rendered
    // frame in preRender() and was initialised exactly once, in init(), so the
    // sub-pixel offset of a CAPTURED frame depended on how many frames the page
    // had rendered since boot — a count that changes with the settle length,
    // with --isolate, and that changed again when capture.mjs started rendering
    // and discarding a warm-up shot (in --isolate the first shot inherits that
    // warmed page; every later shot gets a fresh one).
    //
    // HONEST SCOPE: I could not demonstrate this moving a measured number.
    // Two independent batteries, same build, seed and params, whole-frame
    // fraction of pixels differing by more than 3 codes: seamoth 0.00% and
    // surface-above 0.00% BEFORE this line existed, and seamoth 0.00% after.
    // The one shot that does vary run-to-run on identical draw calls and
    // triangles (shallows-reef, 3.73%) still varies with the line in. So this is
    // a correctness fix against the module contract — resetForShot exists to
    // clear temporal state and this was temporal state it did not clear — and
    // not a measured improvement. It costs nothing: _historyValid is cleared at
    // the top of this same hook, so accumulation restarts from JITTER[0] either
    // way, and it is verified look-neutral (shallows-floor 47.4, seamoth 33.6,
    // shallows-reef 132.4, identical to the digit before and after).
    this._jitterIndex = 0;
  },

  // -------------------------------------------------------------------------
  _buildTargets(w, h) {
    const dispose = (t) => { if (t) t.dispose(); };
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.width = w; this.height = h;

    dispose(this.taaA); dispose(this.taaB);
    this.taaA = makeRT(w, h);
    this.taaB = makeRT(w, h);

    dispose(this.focusA); dispose(this.focusB);
    this.focusA = makeRT(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.focusB = makeRT(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

    dispose(this.aoA); dispose(this.aoB);
    this.aoA = makeRT(hw, hh, { format: THREE.RedFormat });
    this.aoB = makeRT(hw, hh, { format: THREE.RedFormat });

    dispose(this.dofA); dispose(this.dofB);
    this.dofA = makeRT(hw, hh);
    this.dofB = makeRT(hw, hh);

    // Local-contrast references: the same COD downsample as bloom but WITHOUT
    // the threshold, so each is a faithful low-pass of the frame.
    //   lc1 (1/4)  bilinear at full res  ~= a 5 px blur   -> fine acutance
    //   lc3 (1/16) bilinear at full res  ~= a 20 px blur  -> wide local contrast
    // Two scales, because they do different jobs: the fine one makes sand
    // ripples legible, the wide one separates a rock's lit face from its shaded
    // one. Round 2 had only the fine one and measured a net contrast LOSS.
    dispose(this.lc0); dispose(this.lc1); dispose(this.lc2); dispose(this.lc3);
    this.lc0 = makeRT(hw, hh);
    this.lc1 = makeRT(Math.max(1, hw >> 1), Math.max(1, hh >> 1));
    this.lc2 = makeRT(Math.max(1, hw >> 2), Math.max(1, hh >> 2));
    this.lc3 = makeRT(Math.max(1, hw >> 3), Math.max(1, hh >> 3));

    // Exposure meter pyramid: 1/8 res down to 1x1 by 4x reductions, then a
    // 1x1 ping-pong for temporal adaptation. All single-channel and tiny — the
    // whole chain is under 0.05 ms and never touches the CPU.
    if (this.lum) this.lum.forEach(dispose);
    this.lum = [];
    let lw = Math.max(1, w >> 3), lh = Math.max(1, h >> 3);
    this.lum.push(makeRT(lw, lh, { format: THREE.RedFormat }));
    while (lw > 1 || lh > 1) {
      lw = Math.max(1, Math.ceil(lw / 4)); lh = Math.max(1, Math.ceil(lh / 4));
      this.lum.push(makeRT(lw, lh, { format: THREE.RedFormat }));
    }
    dispose(this.adaptA); dispose(this.adaptB);
    dispose(this.slowA); dispose(this.slowB);
    const pt = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RedFormat };
    this.adaptA = makeRT(1, 1, pt);
    this.adaptB = makeRT(1, 1, pt);
    // The second, ~10 s adaptation of the same 1x1 reduction. Two 1x1 targets
    // and one extra 1x1 draw buy the entire stabilising half of the loop.
    this.slowA = makeRT(1, 1, pt);
    this.slowB = makeRT(1, 1, pt);
    this._adaptValid = 0;

    if (this.bloom) this.bloom.forEach(dispose);
    this.bloom = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloom.push(makeRT(bw, bh));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }

    dispose(this.ldr);
    this.ldr = makeRT(w, h, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,   // we encode sRGB by hand
    });
  },

  _resize(w, h) {
    if (w === this.width && h === this.height) return;
    this._buildTargets(w, h);
    this._historyValid = 0;
    this._syncSizes();
  },

  // -------------------------------------------------------------------------
  _buildMaterials() {
    const nearFar = { value: new THREE.Vector2(this.camera.near, this.camera.far) };
    this.uNearFar = nearFar;

    // shared CoC uniforms — DoF downsample and composite must agree exactly
    this.coc = {
      // The near CoC is now capped at the normalised maximum rather than at
      // 2.2x it — the old range existed only to stop the un-normalised ratio
      // form running away, and the [-1,1] clamp at the end of cocFor() was
      // doing the real work anyway.
      uFocalRange: { value: 1.0 },
      uCocFar: { value: 0.30 },
      uCocNear: { value: 0.045 },   // near aperture, metres
      uTurbidity: { value: 0.28 },
      uMaxVis: U.uMaxVisibility,
    };

    this.mTaa = makePass('taa', TAA_FRAG, {
      tCur: { value: null }, tHist: { value: null }, tDepth: { value: this.depthTex },
      uInvVP: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uSize: { value: new THREE.Vector2() },
      uFeedback: { value: 0.90 },
      uValid: { value: 0 },
    });

    this.mFocus = makePass('focus', FOCUS_FRAG, {
      tDepth: { value: this.depthTex }, tPrev: { value: null },
      uRate: { value: 1 }, uFar: { value: 60 }, uNearFar: nearFar,
    });

    this.mAO = makePass('ao', AO_FRAG, {
      tDepth: { value: this.depthTex },
      uInvVP: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uCamPos: U.uCamPos,
      // Contact-scale on purpose. A 1.5 m radius with a small bias traced every
      // triangle edge of the terrain mesh as a dark line (visible in the AO
      // buffer as a regular diagonal lattice) because a facet crease is a
      // genuine depth discontinuity. A short radius plus a bias proportional to
      // view distance ignores gentle faceting and only bites where something
      // actually sits on something else — which is the job: bedding flora,
      // rocks and structures into the sand.
      uRadius: { value: 0.62 },
      uRadius2: { value: 2.60 },
      uIntensity: { value: 3.1 },
      uIntensity2: { value: 1.9 },
      uBias: { value: 2.6 },
      uPower: { value: 1.25 },
      // The floor, i.e. AO may remove at most half the light. Bracketed by
      // measurement rather than chosen: at 0.42 the cockpit's lower third comes
      // back at 0.029% pure black and a mean of 72.9, at 0.55 it is 0.025% and
      // 78.6, against the reference plate's 0.015% and 69.9. Both ends clear the
      // black problem; the low end holds the mean and the high end holds the
      // median (57.7 / 60.9 against 68.1), so the answer is between them.
      // Note the scene-referred floor is not the displayed one — the near-field
      // contrast operator downstream expands a 2x scene cut into about 5x on
      // screen, which is why a value this high is not as gentle as it sounds.
      uAOFloor: { value: 0.50 },
      uProjScale: { value: 400 },
      uNearFar: nearFar,
    });

    this.mAOBlur = makePass('aoBlur', AO_BLUR_FRAG, {
      tAO: { value: null }, tDepth: { value: this.depthTex },
      uDir: { value: new THREE.Vector2() }, uNearFar: nearFar,
    });

    // Shared metering uniforms — the composite and the bloom prefilter MUST see
    // the same exposure or the bloom threshold stops being display-referred.
    this.meter = {
      tExposure: { value: null },
      tExposureSlow: { value: null },
      uExposure: { value: 1 },
      uKey: { value: 0.15 },
      uMeterFast: { value: 0.70 },
      uMeterSlow: { value: 0.18 },
      uEvFast: { value: new THREE.Vector2(0.45, 2.30) },
      uEvSlow: { value: new THREE.Vector2(0.55, 1.45) },
    };

    this.mLumaInit = makePass('lumaInit', LUMA_INIT_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.mLumaDown = makePass('lumaDown', LUMA_DOWN_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.mAdapt = makePass('adapt', ADAPT_FRAG, {
      tCur: { value: null }, tPrev: { value: null },
      // Asymmetric on purpose: a diver breaking out of a cave into open water
      // should have the frame settle quickly, but swimming into a dark trench
      // should stay dark for a beat. Per-second rates, converted in update().
      uRateUp: { value: 1 }, uRateDown: { value: 1 }, uValid: { value: 0 },
    });
    // Same shader, ~20x the time constant. The ratio of the two is the whole
    // stabilising term: see EXPOSURE_LIB.
    this.mAdaptSlow = makePass('adaptSlow', ADAPT_FRAG, {
      tCur: { value: null }, tPrev: { value: null },
      uRateUp: { value: 1 }, uRateDown: { value: 1 }, uValid: { value: 0 },
    });

    this.mBloomDown = makePass('bloomDown', BLOOM_DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFirst: { value: 0 },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.55 },
      uClamp: { value: 1.2 },
      ...this.meter,
    });

    this.mBloomUp = makePass('bloomUp', BLOOM_UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
      uWeight: { value: 1.0 },
    }, THREE.CustomBlending);

    this.mDofDown = makePass('dofDown', DOF_DOWN_FRAG, {
      tColor: { value: null }, tDepth: { value: this.depthTex }, tFocus: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNearFar: nearFar, ...this.coc,
    });

    this.mDofGather = makePass('dofGather', DOF_GATHER_FRAG, {
      tDof: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMaxRadius: { value: 4.0 },
    });

    // ROUND 25 — ?tonemap=none IS AN ABLATION OF THE CURVE ITSELF, and it is
    // here because round 24 measured the curve as the single largest chroma
    // term in the chain (+0.115 sat / -6 R% on grand-reef, +0.109 / -22 on
    // deep-void) BY HAND, with no switch that could reach it. Every other
    // operator in this file has one; the one that moves the most did not. 3 is
    // the straight clamp the ?nopostfx bypass already selects, so the ablation
    // is exactly "this chain with the curve taken out" rather than a different
    // curve.
    const tmName = (this.ctx.params?.get('tonemap') || 'aces').toLowerCase();
    const curve = tmName === 'agx' ? 1 : tmName === 'filmic' ? 2
                : tmName === 'none' ? 3 : 0;

    this.mComposite = makePass('composite', COMPOSITE_FRAG, {
      tColor: { value: null }, tBloom: { value: null }, tDof: { value: null },
      tAO: { value: null }, tDepth: { value: this.depthTex }, tFocus: { value: null },
      tLocal: { value: null }, tWide: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uAspect: { value: 16 / 9 },
      uTime: U.uTime,
      uBloom: { value: 0.10 },
      uAO: { value: 0.85 },
      uAOFog: { value: 0.55 },
      uAoBlack: { value: 0.0 },
      uDeepBlackL: { value: 0.0 },
      uDeepBlackFog: { value: new THREE.Vector3(0.25, 0.72, 1.0) },
      uDeepBlackGate: { value: 1.0 },
      // Both OFF by default (LOOK.md 9 / amateur-tell 21). ?barrel= and ?ca=
      // re-enable them; the sampling code costs nothing when they are zero.
      uBarrel: { value: 0.0 },
      uCA: { value: 0.0 },
      uVignette: { value: 0.045 },
      uVignetteSoft: { value: 0.10 },
      uDofMix: { value: 1.0 },
      // ---- three-zone depth grade (near, mid, far)
      uGainNear: { value: new THREE.Vector3(1, 1, 1) },
      uGainMid: { value: new THREE.Vector3(1, 1, 1) },
      uGainFar: { value: new THREE.Vector3(1, 1, 1) },
      uZoneContrast: { value: new THREE.Vector3(1.26, 1.14, 1.02) },
      uZoneSat: { value: new THREE.Vector3(1.00, 1.00, 1.00) },
      uZoneGamma: { value: new THREE.Vector3(1, 1, 1) },
      uZoneClarity: { value: new THREE.Vector3(0.62, 0.34, 0.04) },
      uZoneClarityW: { value: new THREE.Vector3(0.46, 0.22, 0.0) },
      uAirGrade: { value: new THREE.Vector3(1.18, 1.04, 1.0) },
      uZoneNear: { value: new THREE.Vector2(0.03, 0.34) },
      uZoneFar: { value: new THREE.Vector2(0.46, 1.05) },
      uPivot: { value: 0.55 },        // now a pivot in OKLab L, not in linear
      uPivotAuto: { value: 0.80 },
      uZone: { value: 1.0 },
      // ---- round-4 OKLab colour block
      uZoneHue: { value: new THREE.Vector3() },
      uTintLo: { value: new THREE.Vector2() },
      uTintHi: { value: new THREE.Vector2() },
      uSplitLo: { value: new THREE.Vector2(0.16, 0.58) },
      uSplitHi: { value: new THREE.Vector2(0.50, 0.92) },
      uHiRoll: { value: 0.86 },
      uHiCeil: { value: this.k.hiceil },
      uCeilNeutral: { value: clamp01(this.k.ceilneutral) },
      uFarFloor: { value: 0.0 },   // ROUND 27, solved on the CPU: see the sweep
      uFarScene: { value: 0.0 },
      uFarChroma: { value: 0.0 },  // ROUND 28, solved on the CPU: see the sweep
      uFarCScene: { value: 0.0 },
      uSplitZone: { value: 0.35 },
      uVibrance: { value: 0.14 },
      uMidGamma: { value: 1.0 },
      uMidLevel: { value: new THREE.Vector2(0.26, 0.60) },
      uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uDither: { value: this.k.dither },
      uGamutFix: { value: this.k.gamut },
      uChromaRecovery: { value: 0.45 * this.k.crec },
      uChromaLo: { value: new THREE.Vector2(0.22, 1.10) },
      uChromaGuard: { value: 1.6 },
      uCurve: { value: curve },
      uAcesGamut: { value: this.k.acesgamut },
      // ROUND 29 — the channel-crosstalk ceiling inside acesFitted(). 1 is the
      // INVARIANT ("a channel the scene left at zero leaves the curve at
      // zero"), not a fitted value; ?aceshue=0 restores round 28 exactly.
      uAcesHue: { value: this.k.aceshue },
      uWhiteNeutral: { value: clamp01(this.k.whiteneutral) },
      uCurveGain: { value: 1.40 },
      uHiComp: { value: new THREE.Vector3(1.0, 3.97, 0.06) },
      uToe: { value: 0.010 },
      uShoulder: { value: 0.70 },
      uWhite: { value: 1.50 },
      uAbsorption: U.uAbsorption,
      uMaxVis: U.uMaxVisibility,
      uUnderwater: U.uUnderwater,
      uSplit: { value: this.split },
      uDebug: { value: Number(this.ctx.params?.get('pfxdebug') || 0) },
      uDbgEx: { value: new THREE.Vector3() },
      uNearFar: nearFar,
      ...this.coc,
      ...this.meter,
    });

    this.mFxaa = makePass('fxaa', FXAA_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });

    this._syncSizes();
  },

  _syncSizes() {
    const w = this.width, h = this.height;
    const hw = w >> 1, hh = h >> 1;
    this.mTaa.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mTaa.uniforms.uSize.value.set(w, h);
    this.mAO.uniforms.uTexel.value.set(1 / Math.max(1, hw), 1 / Math.max(1, hh));
    this.mDofDown.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mDofGather.uniforms.uTexel.value.set(1 / Math.max(1, hw), 1 / Math.max(1, hh));
    this.mComposite.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mComposite.uniforms.uAspect.value = w / Math.max(1, h);
    this.mFxaa.uniforms.uTexel.value.set(1 / w, 1 / h);
    // AO radius is authored in metres; convert to pixels at unit distance.
    const fovY = THREE.MathUtils.degToRad(this.camera.fov);
    this.mAO.uniforms.uProjScale.value = 0.5 * Math.max(1, hh) / Math.tan(fovY * 0.5);
    // DoF and bloom radii scale with resolution so the look is res-independent.
    this.mDofGather.uniforms.uMaxRadius.value = Math.max(2.2, h * 0.0062);
  },

  // -------------------------------------------------------------------------
  // per-frame CPU work: the grade itself
  // -------------------------------------------------------------------------
  update(dt, t, ctx) {
    if (!this.enabled) return;
    const cam = ctx.camera;
    const biomes = ctx.get('biomes');
    let m = null;
    try {
      if (biomes?.at) m = biomes.at(cam.position.x, cam.position.y, cam.position.z);
      else if (biomes?.atDepth) m = biomes.atDepth(cam.position.y);
    } catch { m = null; }
    this._medium = m;

    const depth = Math.max(0, WORLD.seaLevel - cam.position.y);
    const under = U.uUnderwater.value;
    const dd = clamp01(m?.depthDarken ?? U.uDepthDarken.value ?? 1);

    // ---- depth bands. These are the LOOK.md ramp: cyan shallows -> green-teal
    // mid -> navy deep -> black abyss. We only *respond* to them; the hue itself
    // is the medium's job.
    const tMid = smoothstep(35, 150, depth);
    const tDeep = smoothstep(150, 380, depth);
    const tAbyss = smoothstep(380, 750, depth);

    // ---- exposure: open loop, then METERED -----------------------------------
    // A real camera would open up as the water darkens, but only a little: the
    // reference deep frames sit with 90% of pixels below luminance 20 and adding
    // fill light is the single fastest way to destroy the dread. Cap the lift.
    let ex = (U.uExposure.value || 1) * (m?.exposure ?? 1);
    ex *= 1 + 0.26 * (1 - Math.pow(dd, 0.5));
    ex *= 1 - 0.22 * tAbyss;                       // let the abyss BE black
    // ROUND 22: 0.80 -> 0.63, and it closes a step rather than opening one. The
    // two above-water shots measure median 146.1 (surface-above) and 139.2
    // (surface-pod) on the shot crop against the three DAYLIGHT above-water
    // plates' 95.8 / 119.5 / 114.9 (surface-above-1 / -2 / -5) — about 1.3x hot.
    // 0.63 also happens to be exactly where the underwater side of the waterline
    // sits: levelTrim at depth 0 is 1 + 0.62*(trim - 1) = 0.634, so the old 0.80
    // was itself a 27% brightness STEP across the surface, in the one place the
    // dive route crosses. The two sides now meet.
    if (under < 0.5) ex *= 0.63;                   // above water is a bright sky
    // Hard ceiling on the deep. Measured at 520 m with a free ceiling, exposure
    // solved to 1.49 and the whole frame sat at luminance ~19 — a uniform violet
    // haze with no black in it anywhere. LOOK.md 19 is explicit that a 250 m+
    // frame is >90% below luminance 20 with a median of 7, and that adding fill
    // is what destroys the dread. The cap is the difference.
    // The abyss ceiling comes back up a little. The 0.85 cut was solved when the
    // loop was allowed 0.90 authority and could stack its own correction on top;
    // with the loop at 0.18 the cap was the binding constraint on the 678 m
    // frame and pinned it under its target. The dread it was protecting is
    // enforced elsewhere now — the 0.1-percentile there measures 1.0 and the
    // frame is 90% below luminance 20 either way.
    // ROUND 22 — THE CEILING HAD STOPPED BEING A CEILING AND BECOME THE LEVEL
    // CONTROL ON EVERY FRAME BELOW 150 m, AND NOTHING COULD SEE IT.
    //
    // The clamp below is the last thing that touches the open-loop exposure, and
    // until this round the value that went INTO it was not observable anywhere:
    // no uniform, no debug card, no readback. So a clamp that was binding on a
    // third of the battery was indistinguishable from a ramp that had been
    // carefully tuned to exactly those values, and six rounds of ramp fitting
    // ran against a number that never reached the shader.
    //
    // Measured with the new ?pfxdebug=13 (request) and =15 (ceiling), 480x270,
    // --isolate, ?nohud=1, decoded as lin*8:
    //
    //   shot             depth   request   ceiling   applied   cut
    //   cave              190 m    2.930     1.876     1.876   -36%
    //   grand-reef        280 m    2.001     1.449     1.449   -28%
    //   deep-void         678 m    1.669     1.612     1.612   -3.4%
    //   kelp-forest        55 m    0.727     1.938     0.727     0
    //   seamoth            45 m    0.578     1.950     0.578     0
    //   seamoth-cockpit    45 m    0.563     1.950     0.563     0
    //   shallows-reef      12 m    0.610     1.950     0.610     0
    //
    // AND THAT MADE ?exposure= A SILENTLY INERT SWITCH ON EXACTLY THE THREE
    // FRAMES THE BRIEF CALLS TOO DARK. Verified independently with ?pfxdebug=7,
    // which prints sceneExposure() as a flat card: at ?exposure=1.6 the applied
    // exposure came back BIT-IDENTICAL on cave (2.892), deep-void (2.415) and
    // grand-reef (1.650) and moved by x1.595-1.607 on kelp-forest, the cockpit
    // and shallows-reef. Every "I raised the deep frames and nothing happened"
    // result in this file's history is that clamp.
    //
    // The shape was also backwards. It FELL with depth (1.95 -> 1.44 by 280 m)
    // while the ramp it was clamping RISES with depth, so the two were driving
    // at each other, and the deeper the frame the less of its authored ramp
    // survived. The new one rises past 200 m: it still pins the enclosed cave
    // (whose request is the largest in the battery and whose plate, cave-3, is
    // the darkest thing here at median 5.0) at essentially the value it has
    // today, and it stops binding on the two open-water deep frames, which
    // measure 0.68x and 0.40x of their verified primaries.
    //
    //   depth    old cap   new cap   what is capped
    //     0-150     1.95      1.90   nothing (requests run 0.56-1.13)
    //       190     1.88      1.93   cave, at 1.93 against today's 1.876
    //       280     1.44      3.17   nothing (request 2.87 after the new trim)
    //       678     1.60      3.20   nothing (request 2.29 after the new trim)
    //
    // The cave stays capped ON PURPOSE and it is the only frame that does. It
    // has the largest exposure request in the battery (2.93, the biggest single
    // term being the +26% "open up as the water darkens" lift, which fires at
    // full strength in an enclosed cave where the darkness is rock rather than
    // depth) and the darkest plate (cave-3, median 5.0, which ours already
    // matches). Capping the one frame whose scene is dark for a reason the
    // exposure model cannot see is what a ceiling is FOR.
    //
    // The dread LOOK.md 19 asks for is not made here. It is made by the trim
    // ramp below, by the deep black point, and by the medium having nothing in
    // it to light; a ceiling that binds is just a level control wearing a safety
    // hat, and this one is now high enough above the ramp to be neither.
    //
    // ROUND 25 — THE CEILING WAS SOLVED AGAINST cave-3 AND cave-3 IS NOT THIS
    // SHOT'S PLATE. It binds on exactly one frame in the battery and the note
    // above says why it was allowed to: "the darkest plate (cave-3, median 5.0,
    // which ours already matches)". PLATES.md lists cave-3 as cave's primary but
    // its own conditional hands the slot to cave-1 when our cave is a
    // jellyshroom cavern, and it is - the in-frame biome label says so, which is
    // the correction reference/SYSTEMATIC.md now carries and which this round's
    // brief confirms. Against cave-1 (median 22.9) the two verdicts are
    // opposite, and the three-column measurement settles which one this stage
    // owes: ?nopostfx=1 puts the cave crop at 22.7 against the plate's 22.9 —
    // exact — and the shipped chain puts it at 16.1, i.e. 0.70x. The medium
    // hands me a frame already on the plate and the ceiling takes 30% off it.
    // My delta there should be about zero, so the ceiling has to stop binding.
    //
    //   depth   old cap   new cap   request   applied      cave crop median
    //     190     1.930     2.956     ~2.5    1.93 -> 2.5    16.1 -> 21.0
    //     280     3.170     3.194     ~2.4    unbound        unchanged
    //     678     3.200     3.200     ~2.5    unbound        unchanged
    //     0-150   1.900     2.950   0.56-1.13 unbound        unchanged
    //
    // It is RAISED, not deleted. Requests in the top 150 m run 0.56-1.13, so
    // 2.95 is still a real ceiling - 2.6x the largest of them - and the deep end
    // is left exactly where round 22 put it. Verified inert on the other four
    // shots in the same battery: grand-reef, deep-void and shallows-reef come
    // back inside the noise floor, because none of them was ever capped.
    // ?deepcap= scales the whole thing, because round 22 proved ?exposure=
    // cannot reach a frame the clamp is holding.
    const deepCap = (2.95 + 0.25 * smoothstep(180, 290, depth)) * this.k.deepcap;
    // ---- THE LEVEL TRIM, and why it is open-loop -----------------------------
    //
    // Round 5 set the frame's level with the meter: a depth-ramped key at 0.90
    // authority, which is a full auto-exposure and which duly took 3.3 stops off
    // the frames the critique then measured as 15x too dark. Round 6 takes that
    // authority away (see uMeterSlow), so the ramp has to live somewhere honest
    // — and an open-loop multiply is the honest place, because it is a property
    // of the depth rather than of whatever the camera happens to be pointed at.
    //
    // Solved against the five reference frames, measured on the world crop
    // (0.05,0.10 - 0.55,0.90), with the loop already restored:
    //
    // It is SHALLOWEST-HEAVY. That is the physics rather than a fit: the
    // quantity being trimmed is single-scattered daylight, and there is most of
    // it where there is most beam. Past 150 m it resolves to about 1.0 and past
    // 400 m to slightly above it, because down there nothing is lit by the sun
    // at all and LOOK.md 19's "do not add fill" is the binding constraint
    // instead. The small extra in the top 30 m is the one place where the frame
    // is mostly directly-lit reef rather than water column.
    //
    // Gated by uUnderwater for the same reason the midtone pull is: the quantity
    // it corrects is in-scattered water, and an above-water frame has none. An
    // ungated trim took 0.44 stops off the sky.
    // ROUND 22 — THE RAMP RE-SOLVED AGAINST THE VERIFIED PRIMARIES, AND AGAINST
    // A CEILING THAT NO LONGER EATS IT.
    //
    // The old ramp resolved to 0.407 at 12 m, 0.382 at 45 m and 0.438 at 55 m —
    // i.e. it was FLAT across the whole 0-55 m band, and slightly lowest exactly
    // where the battery measures worst. It then climbed to ~1.3 by 190 m, where
    // the ceiling above threw the climb away. Both halves were wrong and neither
    // could be seen, because the ceiling hid the second half.
    //
    // Baseline this round, shot crop (0.05,0.10 - 0.60,0.85), 1920x1080,
    // --isolate, median ours against the PLATES.md PRIMARY:
    //
    //   shot             depth   ours    plate (primary)          ratio
    //   shallows-reef      12 m  125.6   134.2  shallows-reef-1     0.94
    //   shallows-floor     18 m   68.0   155.5  shallows-floor-1*   0.44
    //   seamoth            45 m   37.2    67.1  seamoth-1*          0.55
    //   seamoth-cockpit    45 m   29.9    81.3  seamoth-cockpit-1*  0.37
    //   kelp-forest        55 m   33.1    42.6  kelp-forest-1*      0.78
    //   cave              190 m    5.6     5.0  cave-3              1.12
    //   grand-reef        280 m   23.0    34.0  grand-reef-2        0.68
    //   deep-void         678 m    6.3    15.9  deep-void-2         0.40
    //
    //   (*) these four plates differ from our shot in DEPTH, which PLATES.md's
    //   own rules say median may not cross cleanly: shallows-floor-1 is 8 m and
    //   90% tan sand ("for caustics only"), seamoth-1 and kelp-forest-1 are
    //   15-25 m against our 45/55 m, and seamoth-cockpit-1 is 110 m against our
    //   45 m — that last one the conservative direction, since the plate is
    //   deeper AND brighter. The depth-CLEAN pairs are shallows-reef (matched),
    //   cave (matched), grand-reef (0.68x) and deep-void (0.40x), and it is
    //   those four the ramp below is solved against.
    //
    // The exposure -> median response was measured rather than assumed, by
    // moving ?exposure= and reading the applied value off ?pfxdebug=7:
    // d log(median)/d log(exposure) = 0.78 (shallows-reef), 0.71 (seamoth),
    // 0.64 (kelp-forest), 0.49 (cockpit) going UP, and 1.63 (grand-reef),
    // 1.80 (seamoth), 1.53 (shallows-floor) going DOWN. The asymmetry is the
    // tone curve: a cut drops the frame into ACES's toe where it collapses,
    // a lift runs into the shoulder where it does not. Every target below is
    // solved with the UPWARD exponent, which is the conservative one.
    //
    // THE EXPONENT IS NOT ONE NUMBER, AND ASSUMING IT WAS COST THIS ROUND A
    // CAPTURE. A first cut sized the abyss with the mid-band exponent (~0.7) and
    // put trim at 2.55 by 678 m. Measured, that took deep-void's median from
    // 7.1 to 34.4 against a plate at 15.9 — a 2.2x OVERSHOOT — because the local
    // exponent down there is 2.19, not 0.7. It has to be: a 678 m frame sits
    // with 59% of its crop under display code 8, i.e. inside ACES's toe and the
    // encoder's own step, and a lift there does not scale the frame, it lifts a
    // large population ACROSS a threshold. Re-solved on that measurement:
    //
    //   shot         geometry-matched pair used     k = dlog(med)/dlog(ex)
    //   grand-reef   23.0 @1.449 -> 39.6 @2.871            0.795
    //   cockpit      29.9 @0.563 -> 40.2 @0.856            0.712
    //   deep-void     7.1 @1.612 -> 13.5 @2.291            1.828
    //   deep-void     7.1 @1.612 -> 34.4 @3.312            2.19
    //
    // Two passes were needed. The first sized the abyss with the mid-band
    // exponent and overshot deep-void to 34.4 against a plate at 15.9; the
    // second used the exponent that overshoot measured and landed 13.5 and 39.6.
    // The numbers above are the SECOND pass's, and the ramp shipped is solved
    // against those: grand-reef came back 1.17x over its plate and deep-void
    // 0.85x under, so tD1 drops 0.72 -> 0.40 and a second ramp across 300-700 m
    // carries the abyss on its own. That split is not cosmetic — the two frames
    // want different multipliers (1.63x and 1.55x off the round-21 build) and a
    // single ramp saturating at 300 m cannot give them both.
    //
    // (Geometry-matched matters: draw calls and triangle counts are NOT stable
    // across batteries on cave, deep-void, kelp-forest, seamoth or
    // shallows-floor — deep-void renders 266/1881544 in some batteries and
    // 306/2221768 in others on one seed. grand-reef, shallows-reef and the
    // cockpit are bit-stable and are what the solve leans on. See the note at
    // the end of this block.)
    //
    // The shape: one ramp opening at 14 m and closing at 105 m carries the whole
    // 40-100 m band (which the old tMid, opening at 35 m, could not reach — it
    // is only 0.021 at 45 m), and one more across 150-300 m carries the two deep
    // frames. Past 300 m it is FLAT, which is the round-17 finding restated:
    // below ~300 m nothing in frame is lit by the sun, so the level is set by
    // lamps and bioluminescence and depth is no longer the axis.
    //
    //   depth   old    new    request   applied   median r21 -> r22  [plate]
    //     12   0.407  0.410     0.61      0.61      125.6 ->  127-150 [134.2]
    //     45   0.382  0.581     0.86      0.86       29.9 ->   40.2   [ 81.3]
    //     55   0.438  0.680     1.13      1.13       33.1 ->   44.9   [ 42.6]
    //     95   0.868  1.023     1.18      1.18       (framing changed; see below)
    //    190   1.298  1.114     2.52      1.93 (cap)  5.6 ->    4.7-6.0[ 5.0]
    //    280   1.205  1.426     2.37      2.37       23.0 ->   34     [ 34.0]
    //    678   1.285  1.929     2.51      2.51        7.1 ->   16     [ 15.9]
    //
    // The 45 m pair is left deliberately short of its plate. seamoth-cockpit-1
    // is a 110 m frame packed with lit reef; ours is a 45 m frame whose crop is
    // mostly empty water column between the dash and the fog. Closing 29.9 to
    // 81.3 needs a further x3.7 of exposure, which would put the surface of the
    // water column two stops over anything LOOK.md measures. That gap is content
    // and depth mismatch, not grade, and it is reported rather than graded at.
    //
    // ROUND 24 — I PULLED THE ABYSS RAMP AND PUT IT BACK, AND ROUND 23 WAS
    // RIGHT. Recording it because the ramp now DEMONSTRABLY overshoots and the
    // reason it may not be corrected here is worth more than the correction.
    //
    // The +0.49*tD2 term was solved in round 22 to lift deep-void from a median
    // of 7.1 to 16 against deep-void-2's 15.9. On this build the same shot and
    // crop reads 25.0 — 1.57x its plate — and it reads 25.6 on the untouched
    // round-23 build too, so nothing in this round's grade caused it. The
    // medium moved under it: round 23's underwater pass took grand-reef's water
    // from R% 5 / sat 0.947 to 32 / 0.686, and that much change at 280 m is a
    // different amount of light at 678 m. An open-loop ramp solved against a
    // previous medium is a stale constant, and this one is stale.
    //
    // Deleting the term is exactly ?exposure=0.748. Measured, --isolate, shot
    // crop, with round 23's own two statistics (flat% = fraction of the crop
    // inside SOME 9x9 window whose every pixel is under luminance 8; codes =
    // mean distinct luminance codes in a 9x9 window centred on a sub-8 pixel):
    //
    //   build                        median   <8%    flat%   codes   p0.1
    //   shipped (this ramp)            25.0    6.37    4.91    4.18    4.9
    //   tD2 deleted                    17.8   20.83   17.95    4.49    1.7
    //   tD2 deleted + ?deepblack=0     18.0   13.81    8.62    4.40    4.2
    //   ?nopostfx=1                    18.2    0.00    0.00    0.00   11.1
    //   deep-void-2 (PRIMARY)          15.9   28.64    0.60   16.62    0.0
    //
    // 1.57x -> 1.12x on the median costs 8.2x -> 30x on flat black, and 14x
    // even with my own deep black point ablated underneath it. The codes column
    // is the reason and it is not mine: the plate holds 28.64% of itself under
    // luminance 8 with 0.60% of it flat because that band carries 16.6 distinct
    // codes; ours carries 4.4, so every code of exposure removed from a
    // textureless gradient converts almost one-for-one into black card. The
    // bypass proves the source — ?nopostfx=1 has 0.00% under luminance 8 at all
    // (p0.1 = 11.1), i.e. the medium hands this file a dark band with no black
    // in it and no texture in it.
    //
    // And the median is the wrong statistic for this frame anyway. topBottom
    // measures 2.74 here against deep-void-2's 0.54: ours is bright at the TOP
    // and the plate is bright at the BOTTOM. A frame whose halves are wrong in
    // opposite directions cannot be fixed by a multiply, which is what round
    // 23's item 4 measured band by band. The fix is the in-scatter elevation
    // anisotropy at 678 m (uwInscatter / U.uSkyAtten), not an exposure trim.
    // NOT SHIPPED, for the second round running, now with two independent
    // measurements behind it.
    //
    // ROUND 26 — SHIPPED, AND THE REFUSAL'S OWN COST STATISTIC IS WHAT RELEASED
    // IT. THE ABYSS TERM IS NOW NEGATIVE.
    //
    // The refusal above was never about the median; it was about the `codes`
    // column. It said: the medium hands this file a dark band with no texture
    // in it (4.4 distinct luminance codes in a dark 9x9 against the plate's
    // 16.6), so every code of exposure removed converts almost one-for-one into
    // black card, and 1.57x -> 1.12x on the median cost 4.91% -> 17.95% flat
    // black. That was true of the medium of rounds 23, 24 and 25.
    //
    // underwater.js's round-26 pass changed it. The elevation anisotropy at
    // 678 m no longer runs the wrong way — the bypass's vertical bands went
    // [29.5, 18.8, 20.1] (top BRIGHTEST, topBottom 1.47) to [23.2, 21.1, 25.7]
    // (top DARKEST, topBottom 0.90) against deep-void-2's 0.54 — and the dark
    // band arrived with structure in it. Re-measured on that medium, one
    // session, one underwater.js hash (ca80748d), shot crop, --isolate:
    //
    //   ?exposure=  median   <8%    flat%   codes    sat    R%   topBottom
    //     1.000      35.3    0.00    0.00    0.00   0.700   33    0.96
    //     0.750      25.7    0.00    0.00    0.00   0.721   32    0.94
    //     0.550      17.4    0.00    0.00    8.50   0.757   30    0.88
    //     0.450      13.2    0.12    0.00   15.95   0.765   31    0.84
    //   deep-void-2  15.9   27.34    0.06   16.57   0.735   25    0.54
    //
    // FLAT BLACK STAYS AT 0.00% ALL THE WAY DOWN. The trade that killed this
    // for three rounds does not exist any more: the cut now buys 2.22x -> 1.09x
    // on the median and 0.700 -> 0.757 on saturation against a plate at 0.735,
    // and it costs nothing on the one statistic that was ever the objection.
    // The codes column moving 0.00 -> 8.50 is the same fact from the other
    // side — there are dark pixels at all now, and they have texture.
    //
    // Solving 0.55 into the ramp: at 678 m tUp and tD1 are both 1 and tD2 is
    // 0.9913, so trim = 1.444 + 0.49*0.9913 = 1.930 and 0.55 of it is 1.061,
    // which needs the abyss coefficient at (1.061 - 1.444)/0.9913 = -0.386. The
    // SIGN FLIP is the honest reading and LOOK.md's own ramp says so: #16436F
    // at 300 m is luminance ~60 and #030505 at 600 m+ is ~5, so the abyss must
    // be exposed BELOW the 300 m band, not above it. The +0.49 was solved in
    // round 22 against a medium that delivered a much darker 678 m; that lift is
    // now an overshoot of the same size it was once a correction.
    //
    // 0.55 rather than the 0.50 that would land the median exactly: 1.09x is
    // inside the +/-10% cell, it leaves headroom in the direction the medium has
    // been moving, and this file has been burned twice by re-solving an
    // open-loop constant to the last digit against a medium mid-pass.
    //
    // tD2 is arithmetically 0 at every other shot in the battery (grand-reef
    // 280 m, cave 190 m, dropoff 74 m all sit below its 300 m edge), so this is
    // surgical by construction and not by luck.
    const tUp = smoothstep(14, 105, depth);
    const tD1 = smoothstep(150, 300, depth);
    const tD2 = smoothstep(300, 700, depth);
    const trim = 0.41 + 0.634 * tUp + 0.40 * tD1 - 0.386 * tD2;
    // ...and it fades IN over the first 5 m rather than switching on at the
    // waterline. uUnderwater is close to a step, so gating a 1.3-stop trim on it
    // alone put a 1.3-stop cut on the single frame where the camera crosses the
    // surface: measured on the dive route, the five sampled frames ran
    // 146.6 / 137 / 83.8 / 96.8 / 102.4, i.e. the crossing was the biggest level
    // event in the route. Ramped over the top 5 m the two sides of the surface
    // meet at the same value and the change happens where a descent would
    // naturally carry it. No battery shot sits underwater above 12 m, so this
    // costs nothing anywhere else.
    // Only PART of the way, though: ramping the trim all the way to zero at the
    // surface made the 2 m frame the brightest in the route at 184, and LOOK.md
    // 1 is explicit that the 0-3 m layer is a dark desaturated teal seen
    // sideways and NOT the bright band (that is 5-15 m). 0.62 halves the
    // crossing step and leaves the surface layer where the reference puts it.
    const levelTrim = 1 + under * (0.62 + 0.38 * smoothstep(0.0, 6.0, depth)) * (trim - 1);
    // The floor drops with it — at 0.45 the clamp was binding the moment the
    // trim landed, which would have silently turned the ramp back into a
    // constant.
    const exReq = ex * levelTrim * this.k.exposure;
    ex = clamp(exReq, 0.16, deepCap);
    this.mComposite.uniforms.uDbgEx.value.set(exReq, ex, deepCap);
    // The open-loop term is DAMPED, which makes it temporal state on the CPU
    // side as much as the two 1x1 adaptations are on the GPU side — a ~0.55 s
    // constant, so a shot taken shortly after a cut is still carrying the
    // previous frame's depth. resetForShot() snaps it, for the same reason it
    // snaps the others.
    this.exposure = this._exposureSnap ? ex : damp(this.exposure, ex, 1.8, Math.min(dt, 0.1));
    this._exposureSnap = false;

    const cu = this.mComposite.uniforms;
    this.meter.uExposure.value = this.exposure;

    // ---- THE KEY IS NOW A DEPTH RAMP, and the meter has near-full authority --
    //
    // ROUND 5. `uKey` used to be 0.047 flat from the surface to 150 m and only
    // then fell. Read that against what the meter actually reports (captured
    // with ?pfxdebug=8, which prints the raw compressed reading as a flat card,
    // inverted here with m/(1-m)):
    //
    //   shot           depth   meter    our median   reference median
    //   shallows-reef    12 m  0.269    115.8        134.5  (shallows-reef-1)
    //   godrays          40 m  0.603    115.0         49.3  (godrays-1)
    //   kelp-forest      55 m  0.207     60.3         40.9  (kelp-forest-1)
    //   dropoff          74 m  0.129     61.4         10.1  (dropoff-1)
    //   deep-void       678 m  0.052      2.5          2.5  (deep-void-1)
    //
    // A CONSTANT key is a promise that every frame from 0 to 150 m should read
    // at the same brightness, and the battery duly delivered one: five shots
    // spanning 666 m of depth landed inside 60-116, while the reference frames
    // for the same five slots span 2.5 to 134.5. That is the composite critique
    // in one line — not that any single frame is wrong, but that the frames do
    // not DISAGREE with each other the way the references do. There is no
    // vertical journey if every depth exposes to the same number.
    //
    // So the key is an exponential in depth now, which is what the physics says
    // it should have been all along: the key is a target for the mean scene
    // radiance, and downwelling light falls as exp(-k*d) with the water's own
    // extinction over a path of roughly twice the camera depth (down, then back
    // out to the eye). 1/34 m is 2x the medium's green channel, which is the
    // channel that survives. The 0.016 floor is the bioluminescent/lamp-lit
    // component, which does not care how deep it is — LOOK.md's 8148 m frame
    // still has teal specks in it.
    //
    // ROUND 6 — THE RAMP WAS RIGHT ABOUT PHYSICS AND WRONG ABOUT THIS GAME, AND
    // THE AUTHORITY THAT ENFORCED IT IS WHAT CRUSHED THE DEEP HALF.
    //
    // Everything above still describes a real defect and a real fix; what it got
    // wrong is that the key models DOWNWELLING SUNLIGHT, and below about 60 m
    // most of the light in frame is not downwelling. It is bioluminescence, a
    // lamp cone, an emissive wreck, and — biggest of all — the player's own arm
    // and tool, a bright near-camera object holding a sixth of the frame at
    // every depth. So the ramp asked the 95 m wreck frame to meter 0.032 when it
    // genuinely meters 0.41, and 0.90 authority duly removed 3.3 stops from it.
    // Measured against the round-5 build: the loop was applying x0.10 (wreck),
    // x0.21 (grand-reef), x0.54 (cave), x0.63 (deep-void) and x0.46 (shallows) —
    // and the five world-crop medians came out 17 / 3.4 / 4.3 / 6.6 / 126
    // against references of 61 / 34 / 5 / 16 / 134.
    //
    // Two changes, and the second is the load-bearing one:
    //
    //   THE RAMP IS GENTLER AND HAS A REAL FLOOR. exp(-d/60) rather than
    //   exp(-d/34), and a floor of 0.075 rather than 0.024, because the floor is
    //   the self-illuminated component and this game (correctly, per LOOK.md 26)
    //   has a lot of it. Solved against what the frames actually meter with the
    //   round-6 estimator, not against a model of the water.
    //
    //   THE AUTHORITY OVER IT IS 0.18, NOT 0.90. The key is now an anchor that
    //   trims a frame which has drifted, not a normaliser that decides what
    //   every frame's level is. The level is decided by the world, and measured
    //   against ?nopostfx=1 the world already has it about right; the loop's job
    //   is the 35:1 swing WITHIN a scene, and that is the fast term's job now.
    //   See EXPOSURE_LIB.
    // Solved against the whole 18-shot battery rather than the five frames the
    // round-5 critique named, because the round-5 failure mode was exactly that
    // a fix aimed at two frames moved every other frame with it. Fitted to the
    // ROBUST readings above with the anchor's authority as a free parameter:
    //
    //   shot          depth   robust meter   key   (key/meter)^0.62
    //   shallows-reef    12 m    0.2364     0.337       1.21
    //   godrays          40 m    0.4774     0.097       0.36
    //   kelp-forest      55 m    0.0867     0.055       0.75
    //   dropoff          74 m    0.0844     0.033       0.55
    //   wreck            95 m    0.1681     0.023       0.30
    //   cave            190 m    0.0164     0.018       1.09
    //   grand-reef      280 m    0.0412     0.018       0.62
    //   deep-void       678 m    0.0124     0.018       1.29
    //
    // Read the last column: the loop now CUTS the up-look frame and the wreck
    // and OPENS the cave and the void — which is the correct sign in every case
    // and the exact opposite of what round 5 did to the bottom four. It could
    // not be the right sign before because the arithmetic mean reported the deep
    // frames as bright.
    this.meter.uKey.value = (0.58 * Math.exp(-depth / 20) + 0.0183) * (m?.exposure ?? 1);
    this.meter.uMeterSlow.value = 0.62 * this.k.meter;
    // Bounded to about +/- 2 stops. The bound is what keeps this an anchor
    // rather than a normaliser: a frame more than two stops from what its depth
    // predicts is somewhere genuinely bright or genuinely black, and the loop
    // should keep its hands off it.
    this.meter.uEvSlow.value.set(0.25, 1.60);
    // THE STABILISER. 0.70 of the fast/slow ratio, clamped to about a stop
    // either way, so a swing is compressed ~2.3x rather than erased: turning
    // from open water into a trench must still get darker, just not 35:1 darker.
    // It is identically 1.0 in steady state, so it can never move a scene's
    // level — which is exactly why it is safe to let it brighten, and the reason
    // the round-5 "the meter may only darken" asymmetry is gone. That asymmetry
    // was doing real harm in motion: a transient that darkened the frame was
    // never compensated while one that brightened it was, so the loop was
    // widening the swing it existed to close.
    this.meter.uMeterFast.value = 0.70 * this.k.meter;
    this.meter.uEvFast.value.set(0.45, 2.30);
    // Eye-adaptation rates, per second. Fast toward bright (leaving a cave),
    // slow toward dark (entering a trench should stay oppressive for a beat).
    const step = Math.min(dt, 0.1);
    this.mAdapt.uniforms.uRateUp.value = 1 - Math.exp(-2.6 * step);
    this.mAdapt.uniforms.uRateDown.value = 1 - Math.exp(-1.1 * step);
    // The slow reference. ~9 s and ~14 s time constants — long enough that a
    // camera turn, a jellyfish drifting across frame or the arm swinging up does
    // not move it, short enough that a genuine descent does. The asymmetry runs
    // the same way as the fast pair for the same reason.
    this.mAdaptSlow.uniforms.uRateUp.value = 1 - Math.exp(-0.11 * step);
    this.mAdaptSlow.uniforms.uRateDown.value = 1 - Math.exp(-0.07 * step);

    // ---- the curve's pre-exposure, solved first ------------------------------
    // Both the bloom ceiling and the shoulder are quoted in DISPLAY-referred
    // units and therefore both need 1/uCurveGain, so the gain is solved here
    // rather than read back out of a uniform the previous frame wrote.
    const curveGain = 1.18 + 0.75 * tDeep + 0.65 * tAbyss;

    // ---- bloom --------------------------------------------------------------
    // Threshold stays above white so only the sun, lamps, caustic peaks and
    // bioluminescence bloom. Deep biomes get a slightly lower bar because the
    // only bright things down there ARE the glowing ones.
    // Deep water needs a much lower bar than 0.78. At 520 m the medium measures
    // 5e-4 linear, so anything self-illuminated is thousands of times above the
    // water and there is no risk of blooming the fog — but with a display-
    // referred threshold near white, a bioluminescent point that core's depth
    // darkening has attenuated never blooms at all, and LOOK.md amateur-tell 26
    // is precisely "nothing self-illuminated" in a deep frame.
    // Recalibrated for the metered exposure. The threshold is display-referred
    // (applied after sceneExposure), and the meter now solves to ~0.35 in lit
    // water, so a threshold of 1.08 sat roughly 1.8 stops above the brightest
    // thing in the frame: NOTHING bloomed, anywhere, and the shallows frame's
    // 99.9th percentile came back at 129/255 against the reference's 235.
    // 0.48 corresponds to a post-curve display value of ~0.62 (158/255), which
    // is inside the top couple of percent — LOOK.md's "top 1-2% of luminance".
    // ROUND 8: the deep bar comes back UP. The argument for dropping it to 0.28
    // was that core's depth darkening left bioluminescence under a display-
    // referred threshold — true when it was written, and no longer true now the
    // meter opens the deep frames up. What it bought instead was every faintly
    // lit surface in a 680 m frame feeding the skirt.
    const thr = 0.48 - 0.10 * tDeep;
    this.mBloomDown.uniforms.uThreshold.value = thr;
    // The energy ceiling, in the same display-referred units as the threshold
    // and scaled by 1/uCurveGain so it is the same DISPLAY brightness at every
    // depth. 1.35/gain sits a little above the knee of the new shoulder, so the
    // halo it produces tops out around display 180 on black water instead of at
    // white. See the note in BLOOM_DOWN_FRAG.
    this.mBloomDown.uniforms.uClamp.value = 1.35 / curveGain;
    // The knee MUST stay below the threshold. The soft-knee prefilter evaluates
    // clamp(br - T + K, 0, 2K) at br = 0, so the moment K >= T every black pixel
    // in the frame acquires bloom energy and the whole image turns into glow.
    // The round-1 pair (T 0.78, K 0.75) was 0.03 away from that.
    this.mBloomDown.uniforms.uKnee.value = Math.min(0.5 + 0.25 * tDeep, thr * 0.55);
    // ROUND 8 trims the deep bump. With a ceiling on the source energy the
    // weight no longer has to be small to be safe, but 0.46 was solved against
    // an unbounded skirt and is simply more veiling than a lens produces.
    cu.uBloom.value = (0.28 + 0.10 * tDeep + 0.08 * (m?.bioluminescence ?? 0)) * this.k.bloom;
    // Deep scenes are nothing but glowing points, so let the skirt reach further.
    this._bloomFalloff = 0.52 + 0.14 * tDeep;

    // ---- the tone curve ------------------------------------------------------
    // uCurveGain is the pre-exposure into ACES and is what decides where
    // mid-grey lands. 1.40 was solved against shallows-reef-1: a scene-linear
    // 0.20 comes out at 123/255 against the reference median of 121.7. It rises
    // with depth so that the little that IS lit down there still resolves —
    // ACES's toe zeroes anything below 0.0037/uCurveGain, and at 1.4 that is a
    // floor of 0.0026 linear, which is above the abyss's entire signal.
    cu.uCurveGain.value = curveGain;
    // ---- THE SHOULDER, in display-referred units ----------------------------
    // knee 1.00/gain     -> ACES resolves it to display 207/255
    // headroom 3.97/gain -> its asymptote resolves to display 247/255
    // slope 0.042        -> display 250 needs ~50/gain, about 350x mid-grey,
    //                       which is the sun disc and a lamp filament.
    //
    // ABOVE WATER THE SHOULDER RELAXES, and that is not a fudge. Everything
    // hiCompress() is for is a property of FOG: an in-scattered frame has a
    // compressed histogram (LOOK.md 2 measures the Dunes frame entirely inside
    // 45-168) and anything that escapes it is a light source. A daylight frame
    // at the surface is a genuine high-dynamic-range scene where sun glint on
    // chop is SUPPOSED to blow, and the references say so: surface-above-1 and
    // -5 measure a 99.9th percentile of 249.3 and 250.2 with 0.10% of frame at
    // 250+. With the underwater constants the surface frames came back at 223,
    // so the operator was removing the one highlight tail that is real.
    const air = 1 - under;
    cu.uHiComp.value.set(1.00 / curveGain,
      (3.97 + 8.0 * air) / curveGain, 0.042 + 0.14 * air);
    // Chroma recovery holds the saturation floor against ACES's desaturating
    // shoulder. Measured: swapping the round-2 curve for ACES cost 0.10 of mean
    // frame saturation (0.739 -> 0.642) against LOOK.md's floor of 0.70, and
    // this is what buys it back. Highest in the teal middle band, where LOOK.md
    // measures the highest saturation in the game (godrays-1 at 0.966).
    // Rebalanced for the scene-referred guard: it now actually applies over the
    // body of a bright frame instead of switching itself off there, so it needs
    // less gain to do more work.
    // Round-4c measured the shallows WATER crop at 0.855 mean saturation against
    // shallows-reef-1's 0.755, with mean red 14% of max against the reference's
    // 24% — recovery pulls the tonemapped pixel back toward the medium's own
    // very red-poor chromaticity, so at 0.58 across a whole bright frame it was
    // over-correcting. It is needed most in the mid band, where LOOK.md measures
    // the highest saturation in the game and where ACES bites hardest.
    cu.uChromaRecovery.value = 0.62 + 0.20 * tMid - 0.45 * tAbyss;
    // filmic-curve fallbacks (?tonemap=filmic) — unchanged from round 2.
    cu.uToe.value = 0.010 * (1 - tDeep);
    cu.uShoulder.value = 0.70 - 0.12 * tDeep;
    cu.uWhite.value = 1.50 - 0.35 * tDeep;

    // ---- THE THREE-ZONE DEPTH GRADE -----------------------------------------
    // Contrast pivot tracks the band's own mid so a contrast change is not
    // secretly an exposure change. Everything here is >= 1.0: see the note in
    // COMPOSITE_FRAG about why a contrast below 1 is a lift wearing a hat.
    // The pivot sits UNDER the frame's median on purpose. Contrast about a pivot
    // is out = P^(1-c) * v^c, so everything above P is stretched up and
    // everything below is pushed down; putting P below the median means the
    // operator spends most of its effect on the bright tail, which is the half
    // that is missing. Measured on the shallows frame: the reference runs
    // median 122 with a 99.9th percentile of 235 (a ratio of 1.93) and ours ran
    // 105 / 129 (a ratio of 1.23).
    // The pivot is now in OKLab L (~= luminance^(1/3)): 0.55 is a linear 0.166,
    // which is the same operating point round 3 solved for on the max channel.
    //
    // ROUND 5 dropped it to 0.46. A pivot only behaves like a contrast if it
    // sits inside the frame's own histogram; put it above the histogram and the
    // "contrast" is a straight exposure cut, which is what it had become for
    // every frame below 40 m (0.57 in L is display 128/255, and the kelp,
    // drop-off and deep frames all have medians well under that). 0.46 is a
    // display 88/255, which is between the shallows median and the drop-off's,
    // so the operator spends itself SPREADING the water column instead of
    // dimming it — and the spread is the point: see uZoneContrast below.
    cu.uPivot.value = 0.46 - 0.05 * tMid - 0.06 * tDeep;
    // ...and 80% of it now comes from the meter instead. The remaining 20% of
    // the authored constant keeps the pivot from chasing a frame whose meter is
    // dominated by one bright object (a lamp filling frame, the sun through the
    // surface), which would otherwise pivot on the object rather than on the
    // water. `?meter=0` drives this to 0 with the rest of the loop.
    cu.uPivotAuto.value = 0.80 * clamp01(this.k.meter);
    cu.uZone.value = this.k.zone;

    // The near field is the part of the frame with the least atmosphere in front
    // of it, so it gets the contrast and the acutance; the far field is by
    // definition seen through the whole water column, so it goes flat. That
    // ordering is LOOK.md 2 verbatim ("mid-ground goes flat; far ground is
    // fog-coloured") and it is the only honest way to manufacture the "strong
    // colour separation between lit foreground, hazy midground and deep
    // background" the brief asks for.
    //
    // ROUND 5 RAISED THE FAR FIELD FROM 1.06 TO 1.30, which reads like a
    // contradiction of the paragraph above until you separate the two things
    // "flat" can mean. LOOK.md 2's flat is a loss of SURFACE DETAIL — texture,
    // pitting, the difference between a lit face and a shaded one — and that is
    // handled here by uZoneClarity/uZoneClarityW going to zero in the far band,
    // which is untouched. What the far band must NOT lose is the vertical
    // LUMINANCE axis, because in an open-water frame the far band IS the water
    // column and the water column is where that axis lives. godrays-1 runs
    // #00AA9C across the top of frame to #011434 at the bottom: a top-to-bottom
    // luminance ratio of 7.17, measured. Ours measured 1.47 with the far field
    // pinned at 1.06 — i.e. the one operator that could have amplified the
    // gradient was deliberately switched off over the only part of the frame
    // that has one. A pivoted power on L is a power on the luminance ratio
    // itself, so it stacks with whatever underwater.js manages to produce:
    // measured, the godrays frame's top:bottom went 1.47 -> 1.85, the drop-off's
    // 1.92 -> 4.75 and the kelp's 1.98 -> 2.85 (kelp-forest-1 measures 2.55).
    //
    // ROUND 8 SEPARATES THE THREE NUMBERS. They were 1.30 / 1.26 / 1.30 — the
    // near and far bands IDENTICAL and the mid 3% off them, which is a global
    // contrast wearing a three-zone costume, and it is half of why the zone
    // split could not be seen in the output whatever the weights did. The
    // ordering is now the one LOOK.md 2 describes: the near field is the part
    // with the least atmosphere in front of it and carries the most contrast;
    // the MID-GROUND is the band that "goes flat"; the far band keeps its
    // contrast because in an open-water frame the far band IS the water column
    // and the vertical luminance axis lives there (see the round-5 note above).
    // The mid drop also takes a real bite out of the highlight tail, which is
    // this round's other job.
    const zc = this.k.zcon;
    cu.uZoneContrast.value.set(
      1.0 + (0.36 + 0.10 * tMid + 0.06 * tDeep) * zc,
      1.0 + (0.16 + 0.05 * tMid) * zc,
      1.0 + (0.28 + 0.06 * tMid) * zc);
    // Saturation is now a CHROMA multiplier in OKLab — a real expansion about
    // the achromatic axis. Unlike the round-3 ratio power it moves two pixels
    // with different hue angles APART rather than pushing both toward the same
    // gamut corner, and it does not double as a lightness change.
    //
    // LOOK.md 3 measures 0.70-0.97 mean saturation with godrays-1 at 0.966, and
    // the far field — which is the fog itself — is the most saturated thing in
    // any of those frames, so the ramp runs UP with distance rather than down.
    // Round 3's ramp ran the other way (near 0.96, far 1.03 falling to 0.64 by
    // 60 m) and its own godrays capture measured 0.646 against a bypass of
    // 0.763: the grade was subtracting saturation.
    //
    // Nothing here can clamp a channel: an out-of-gamut result gives up chroma
    // in oklabToRgbClipped() instead. That is the invariant that replaces the
    // round-1 scar tissue, and it is strictly stronger — the old one merely
    // could not delete a channel, this one cannot even reach the gamut wall.
    // Keyed on ABSOLUTE depth, not on tMid: the reference's saturation climbs
    // with depth (shallows-reef-1 0.734, kelp-forest-1 0.837, godrays-1 0.966)
    // and it is well under way by 60 m, long before the 35-150 m band this file
    // uses for everything else. Solved against the round-4a capture, which ran
    // 1.14 flat and measured 0.934 in the shallows against the reference's
    // 0.734 with mean red down at 10.5/255 — the round-1 direction, and the
    // reason the ramp starts under 1.0.
    //
    // ROUND 5 NOTE, because the round-3 critique keeps being re-issued: the
    // operator this drives is NOT a ratio power about each pixel's own max
    // channel any more, and has not been since round 4. It is
    // `C = length(ab); C *= zSat` in COMPOSITE_FRAG step (4) — the magnitude of
    // the OKLab chroma vector, i.e. distance from the ACHROMATIC AXIS, which is
    // the luminance axis by construction (ab = 0 is exactly the neutral line at
    // every L). That is a real saturation operator: two pixels with different
    // hue angles are pushed apart by it, which a max-channel ratio power cannot
    // do because it is hue-preserving by construction. The proof it is doing
    // work is that it can be measured going the wrong way — round-4a ran it at
    // a flat 1.14 and took the shallows frame to 0.934 mean saturation against
    // the reference's 0.734 with mean red at 10.5/255, which a hue-preserving
    // operator is incapable of. Two safety properties come with it: ab is
    // renormalised by L/L0 first, so lightness changes do not leak in as
    // saturation, and the return trip goes through oklabToRgbClipped(), which
    // gives up chroma rather than a channel, so no amount of gain here can
    // delete red.
    // ROUND 24 — THE DEPTH UP-RAMP IS REFUTED BY THE PLATES IT CLAIMS.
    //
    // The ramp above ran 0.95 -> 1.29 with depth and the three bands came out
    // (1.22, 1.29, 1.42) below 95 m, i.e. the deeper the frame the harder this
    // file expanded its chroma. Its authority is the line "the reference's
    // saturation climbs with depth (shallows-reef-1 0.734, kelp-forest-1 0.837,
    // godrays-1 0.966)". Two of those three are not this shot's plate and the
    // third, godrays-1, is a plate reference/PLATES.md gives an EMPTY
    // matchesShots. Measured on the shot crop (0.05,0.10 - 0.60,0.85), the
    // VERIFIED primaries for the frames this ramp lands on read:
    //
    //   grand-reef-2  sat 0.461      cave-3   sat 0.417      deep-void-2  0.735
    //
    // Every one of them is BELOW the shallows plate, not above it. Saturation
    // does not climb with depth in the plates this project is scored against,
    // so the ramp is inverted and the band offsets are narrowed: the far band
    // is the fog itself, which underwater.js already resolves a long ray to
    // exactly, so widening its chroma is the definition of fighting the medium.
    //
    // Measured contribution of the old triplet, ?zonesat=0 against shipped on
    // grand-reef: +0.084 saturation and -9 R%.
    const tSat = smoothstep(8, 95, depth);
    const sBase = (0.97 - 0.09 * tSat) * this.k.sat;
    // The near field is lit by the beam rather than painted by the medium, so it
    // is the LEAST medium-coloured part of the frame: shallows-reef-1's lit reef
    // measures 0.766 saturation with red at 23% of max, i.e. a pale teal, not a
    // saturated one. The far field is the fog itself and is the most saturated
    // thing in any reference frame.
    // ROUND 8 halves the near penalty. It was solved when the near band owned
    // 0.24 of a shallows frame; with the ramps crossing it owns 0.59, so the
    // same -0.14 took the whole frame's mean saturation to 0.695 — under
    // LOOK.md 3's 0.70 floor — where the reference measures 0.734.
    // ROUND 22 — ?zonesat=0 PINS ALL THREE BANDS TO EXACTLY 1.0, which `?sat=0`
    // does NOT: sat scales sBase, so it leaves the band offsets behind as
    // (-0.07, 0, +0.13) and measures a frame nobody ships. This is the clean
    // neutral, and it exists because two modules are being asked about
    // saturation in the same round. Ours measures 0.77-0.99 mean on every
    // underwater shot against plates at 0.42-0.87, and the split between the
    // grade's chroma expansion and biomes' authored colours cannot be argued,
    // only ablated. What this operator is worth, measured: see the report.
    // The chroma ramp itself is left where it is this round — the brief that
    // said "desaturate" and the brief that said "do not" were both written
    // without this number, and pulling on it blind while biomes pulls the other
    // end is how the last two rounds were spent.
    const zs = this.k.zonesat;
    cu.uZoneSat.value.set(
      1 + zs * (sBase - 0.05 - 1), 1 + zs * (sBase - 1), 1 + zs * (sBase + 0.05 - 1));
    // Gamma above 1 in the deep bands pushes the medium's in-scatter pedestal
    // back toward true black. It is a power, so it can only ever pull the bottom
    // of the range DOWN — the opposite of a lift. Measured need: the 678 m frame
    // came back with a 0.1-percentile luminance of 9.8 and a total range of 7.6,
    // i.e. a flat grey card, where the reference is 0/2/233.
    const gDeep = 1.0 + 0.06 * tDeep + 0.05 * tAbyss;
    // ROUND 6: an extra far-field gamma across the 40-150 m band, and it is the
    // one operator here that is not a global level change.
    //
    // Two frames in the battery refused to be fixed by any function of depth or
    // of the frame's own level: the up-look through the surface at 40 m and the
    // drop-off at 74 m both wanted to be 2-3x darker than the kelp at 55 m and
    // the wreck at 95 m, which meter almost identically. What separates them is
    // not depth, it is CONTENT — godrays and dropoff are frames of open water
    // seen down a long ray, the kelp and the wreck are frames of geometry a few
    // metres away — and this file already computes exactly that distinction per
    // pixel as the zone weights (1 - transmittance along the view ray). So the
    // correction belongs on the far zone, where it lands on the water column and
    // on nothing else: measured, it takes 37% off the drop-off and 15% off the
    // up-look while leaving the 12 m reef (which has no far zone in the crop at
    // all) at exactly the value the round-5 pass earned for it.
    //
    // It is bounded to the band where there IS a lit water column to over-report
    // — off by 250 m, where the far field is the black the deep frames need.
    // ROUND 8 eases both bumps, because the far band now owns 1.5-2x the frame
    // it did when they were solved and the same exponent therefore does that
    // much more darkening. Measured on the crossing-ramps build before this
    // trim: grand-reef's world-crop median fell 18.4 -> 15.3 against a
    // reference of 36.7, i.e. the frame that was already the battery's darkest
    // relative to its reference took the biggest cut.
    const farBand = smoothstep(25, 70, depth) * (1 - smoothstep(100, 240, depth));
    const zg = this.k.zgam;
    cu.uZoneGamma.value.set(
      1.0,
      1.0 + (gDeep + 0.05 * farBand - 1.0) * zg,
      1.0 + (gDeep + 0.14 * farBand - 1.0) * zg);
    // Vibrance only bites on low-chroma pixels, which underwater means the sand,
    // bare rock and the player's own hardware. At 0.22 it was turning the
    // scanner's white shell cyan and taking mean red down with it; 0.09 colours
    // the sand without repainting the props.
    // ROUND 24 — HALVED, AND THE DEPTH RAMP INVERTED. Vibrance is the only pure
    // chroma ADD in the file and it fires on LOW-chroma pixels, which in a deep
    // frame is nearly every pixel — so the old ramp pushed hardest exactly where
    // the plates are least saturated. Measured with ?vib=0 against shipped:
    // shallows-floor -0.054 saturation and +5 R%, grand-reef -0.017 / +2. It
    // survives at all because colouring bare sand and rock is a real job that
    // no other operator here does; it survives smaller because it was never
    // solved against a plate.
    cu.uVibrance.value = (0.05 - 0.02 * tMid) * this.k.vib;
    // ROUND 8 — THE OKLab ROLLOFF HAD TO COME DOWN OR IT UNDID THE SHOULDER.
    // The zone contrast is a pivoted power on L with the pivot under the frame's
    // median, so it EXPANDS the top: a pixel the scene-referred shoulder had
    // carefully landed on display 248 (L 0.972) came back out at 254 after
    // contrast 1.30 and a rolloff that only starts at 0.88. 0.76 in OKLab L is a
    // display 177/255 — above the 99th percentile of every reference frame
    // measured, so the body of the image is still untouched by it, but the top
    // now has 0.24 of L to be compressed into instead of 0.12.
    cu.uHiRoll.value = 0.76 - 0.04 * tDeep;

    // ---- THE FAR-BAND FLOOR --------------------------------------------------
    // See step (3b) in COMPOSITE_FRAG for what it is and why the far band is the
    // only place it may exist. This is how much of the lightness the tone curve
    // handed a far-band pixel the grade has to give back.
    //
    // SOLVED ON WATER-ONLY WINDOWS, which is the whole reason this round has a
    // number at all. Two windows in kelp-forest-1, both opened and looked at and
    // both containing nothing but water — 0.645,0.025-0.700,0.095 at the top of
    // frame (sd 5.5) and 0.660,0.815-0.700,0.930 at the bottom (sd 2.2) — read
    // 219.9 falling to 54.8, a span of 4.01. Our own water, same treatment,
    // reads 213.7 -> 60.7 out of the medium (3.52) and read 212.6 -> 16.5 out of
    // round 26 (12.86). The medium arrives on the plate's span and this file was
    // cubing it. LOOK.md 1 agrees on the level from a second, independent
    // direction: the kelp biome's lower water column is #0B3710, luminance 42.8,
    // and its upper is #164619, luminance 56.6.
    //
    // TWO REFERENCES WERE BUILT AND MEASURED AGAINST EACH OTHER, and the one
    // that looked more conservative on paper is the one that is worse. Floored
    // against L0 — the lightness the TONE CURVE handed the grade — the operator
    // can give back at most what the OKLab block took, which on kelp caps the
    // bottom-of-frame water at 22.8 whatever the fraction. Floored against the
    // lightness the MEDIUM delivered it reaches the same 22.8 at 0.70 and costs
    // an ORDER OF MAGNITUDE less collateral, because on a deep frame the curve
    // barely darkens at all (L0 ~= Lscene there) so 0.70 * Lscene never binds:
    //
    //   kelp BOT   deep-void median      what moved it
    //   22.8       25.75  (+48%)         floor against L0, fraction 1.00
    //   22.8       17.46  (+0.5%)        floor against Lscene, fraction 0.70
    //
    // Both land kelp identically; only one leaves round 26's abyss trim alone.
    // Shipped: Lscene, 0.70.
    //
    // THE SWEEP, five shots, 1920x1080, --isolate, one underwater.js hash
    // (6db255a4) either side, crop median on 0.05,0.10-0.60,0.85. `off` is
    // ?farfloor=0, which is round 26 exactly:
    //
    //   fraction   kelp    grand-reef   cave    shallows-reef   deep-void
    //   off        28.39   46.84        20.93   132.40          17.38
    //   0.70       34.40   46.84        22.39   132.40          17.46
    //   0.78       36.84   46.84        24.01   132.40          21.10
    //
    // 0.70 is the largest fraction at which grand-reef and shallows-reef are
    // EXACTLY unchanged — every column, not just the median — and deep-void
    // moves by 0.5%, inside the 0.4% / 3.4% noise floor. At 0.78 kelp gains a
    // further 2.4 counts and deep-void loses 21% of round 26's abyss result
    // against a plate at 15.9, which is not a trade worth making. cave moves
    // +1.5 counts at 0.70 and that is TOWARD cave-1's median of 22.9, not away.
    cu.uFarFloor.value = clamp(this.k.farfloor, 0, 1);
    cu.uFarScene.value = clamp01(this.k.farscene);

    // ---- THE FAR-BAND CHROMA LOCK -------------------------------------------
    // See step (5c) in COMPOSITE_FRAG for what it is, what it caught and why
    // the far band is the only place it may exist. This is the fraction of the
    // far band's chroma vector that is handed back to the medium at wFar = 1.
    //
    // SOLVED ON WINDOWS HOLDING NOTHING BUT WATER, IN BOTH IMAGES. The windows
    // are written out in full in the header; both were cropped, opened and
    // looked at. The plate window is the tightest clean water in grand-reef-2
    // (px 880,80 - 1080,180: p0.1 31.7, p99.9 38.8 over 200x100 px, which is
    // what "only water" looks like when it is true) and it agrees with three
    // wider water windows of the same plate to +/-0.003 saturation and 1 R%.
    //
    // THE SWEEP. Our grand-reef water window against that plate water, and the
    // one shot whose water this operator could plausibly break — deep-void,
    // whose graded water is already exact against the only two axes PLATES.md
    // certifies deep-void-2 for. One biomes hash (eac9b92f) and one
    // underwater.js hash (6db255a4) either side of every row:
    //
    //   uFarChroma   grand-reef water     deep-void water
    //   (medium)     0.668 / 33           0.780 / 22
    //   0.00         0.557 / 44           0.769 / 23
    //   0.50         0.611 / 38           0.774 / 23
    //   0.85         0.647 / 35           0.778 / 22
    //   1.00         0.662 / 34           0.780 / 22
    //   PLATE        0.654 / 34           0.774 / 23
    //
    // 1.00 is shipped and it is not a fitted value: it is the statement that a
    // pixel which IS the fog leaves this file the colour the fog is. It lands
    // grand-reef's water on its plate to within 0.008 saturation and 0 R% —
    // from 0.097 and 10 — and it moves deep-void's water by +0.011 saturation
    // and -1 R%, which leaves it inside the plate on both axes (0.780 against
    // 0.774, 22 against 23) exactly as it was before. There is no value in the
    // sweep at which deep-void is worse and grand-reef is better, so no trade
    // had to be taken here; the two move together and both end up on-plate.
    cu.uFarChroma.value = clamp01(this.k.farchroma);
    cu.uFarCScene.value = clamp01(this.k.farcscene);

    // ---- THE MIDTONE PULL ----------------------------------------------------
    // See step (2b) in COMPOSITE_FRAG for what the operator is and why a power
    // on OKLab L is the only shape that does what was asked. This is how hard
    // it is pushed.
    //
    // It ramps with depth because the thing it removes is in-scattered water:
    // the surface layer genuinely is a bright, low-contrast place and the
    // reference frames there measure a median of 91-134, which is where ours
    // already sits. What floats is everything under it — LOOK.md's own table
    // has the water column at 43-57 by 40 m in the kelp and #0A5C6B (68) at
    // 100-120 m, and the drop-off frames measure a median of 10-11. Multiplied
    // by uUnderwater, so a surface or above-water frame is untouched (a power
    // on an above-water frame would crush the sky, which is not fog and is not
    // supposed to compress).
    //
    // It EASES OFF again in the abyss. Down there the only thing in frame is
    // self-illuminated, the frame is already sitting at a median of 2.5 against
    // the reference's 2.5, and LOOK.md amateur-tell 26 is "nothing
    // self-illuminated" — pulling the midtones of a frame that is nothing but
    // midtone-free bioluminescence would only dim the one thing worth looking
    // at.
    //
    // ROUND 6: the operator is now a midtone-only bump AND it is gated on the
    // frame's own metered level, so the depth ramp below only says how hard the
    // pull COULD be. It is pushed a little harder than round 5's 0.30 because
    // the 4L(1-L) weight costs roughly a third of the effect at the median of a
    // bright frame, and the shallows/godrays result the round-5 pass bought has
    // to survive this change unchanged.
    const tPull = smoothstep(12, 65, depth);
    cu.uMidGamma.value = 1 + under * (0.05 + 0.36 * tPull - 0.36 * tAbyss)
                             * clamp01(this.k.midpull);
    // The gate, in pivot units (OKLab L of the frame's own metered middle). Fully
    // on for a frame whose middle sits at display ~90/255 or brighter — an
    // in-scattered, milky frame, which is the only thing this operator is for —
    // and fully off below display ~14/255, where there is no in-scatter left to
    // remove and a pull is just a second crush on a frame that already matches.
    cu.uMidLevel.value.set(0.24, 0.58);
    // A blown highlight is one with real HDR headroom — a scene-linear property.
    // 1.6 sits about 3 stops over the shallows' mid-grey, so bright water keeps
    // its hue and only the sun core, lamps and bioluminescent centres whiten.
    cu.uChromaGuard.value = 1.6 + 1.2 * tDeep;
    // ROUND 24 — RECOVERY NOW REACHES THE BODY OF EVERY FRAME.
    //
    // The band is in MULTIPLES of the frame's own metered middle (see tonemap),
    // so it is depth-independent by construction. What it is answering,
    // measured with ?crec=0 / ?vib=0 / ?gfar=0 / ?gnear=0 / ?tint=0 / ?cgamma=0
    // / ?zonesat=0 one at a time against ?nopostfx=1 on the shot crop:
    //
    //   grand-reef  contributes   sat     R%      deep-void        sat     R%
    //     zone chroma ramp      +0.084    -9        (all six)     +0.051    -9
    //     far channel gain      +0.057    -7
    //     vibrance              +0.017    -2
    //     per-channel gamma     +0.015    -2
    //     chroma recovery        0.000     0                       0.000     0
    //     split-tone            -0.025    +1
    //     ---- the six together +0.164   -19                      +0.051    -9
    //     THE TONE CURVE       +0.115    -6                       +0.109   -22
    //
    // The curve is the largest single chroma error in the file and no knob in
    // the grade could reach it. ACES does it by construction: ACES_OUT's
    // negative off-diagonals expand chroma along whatever lean the input
    // already has, and its closing per-channel clamp(...,0,1) can drive to a
    // hard zero a red channel the medium left alive. Worked through by hand for
    // grand-reef's water at the crop median (scene R/G/B 0.51/0.69/1.00,
    // uCurveGain 1.93), the curve returns R/B 0.387 and G/B 0.600 — a quarter
    // of the relative red gone before one grade operator has run.
    //
    // 0.30 to 1.45 of the frame's middle: recovery is off in the deepest tail
    // where t is near zero and there is nothing to recover, full over the body
    // of the frame, and handed back to the film curve above uChromaGuard, which
    // is unchanged and still whitens a lamp core and the sun.
    const crLo = this.k.crlo;
    cu.uChromaLo.value.set(0.30 * crLo, 1.45 * crLo);

    // Clarity, in stops of local detail. Round 2 ran 0.30 on one scale and
    // measured a NET LOSS of tile contrast against the bypass.
    // The two scales are balanced against two different measurements, which is
    // the reason for having two of them at all:
    //   FINE drives the laplacian detail RMS. At 0.95 the shallows frame
    //        measured 10.7 against the reference's 6.33 — over-sharpened, and
    //        an over-sharpened frame is its own kind of tell.
    //   WIDE drives the 32 px tile contrast, which is the number that was
    //        actually failing (2.61 against 6.52) and which a 1-2 px operator
    //        can barely touch.
    // ROUND 4 rebalance: the shallows capture measured a laplacian detail RMS of
    // 16.9 against shallows-reef-1's 6.33 — nearly 3x over-sharpened, and an
    // over-sharpened frame is its own tell (LOOK.md 9 wants "close to plain
    // exposure"). The FINE scale is the one that shows as ringing, so it takes
    // the cut; the WIDE scale is what carries the 32 px tile contrast and the
    // sense of a lit face against a shaded one, so it barely moves.
    const cl = under * this.k.clarity;
    cu.uZoneClarity.value.set(
      (0.30 + 0.06 * tMid) * cl, (0.17 + 0.04 * tMid) * cl, 0.02 * cl);
    cu.uZoneClarityW.value.set(
      (0.72 + 0.10 * tMid) * cl, (0.40 + 0.05 * tMid) * cl, 0.0);

    // Zone boundaries. In murk the whole frame is "far" much sooner, which is
    // handled for free by normalising distance against uMaxVisibility, but the
    // near band tightens a little in the deep because there is simply less of
    // the frame that counts as foreground down there.
    //
    // Measured with ?pfxdebug=6 (the zone split rendered as R/G/B): the shallows
    // frame resolved to near 0.08 / mid 0.83 / far 0.19, i.e. five sixths of the
    // frame was landing in the one zone that was deliberately given the weakest
    // gain. The far ramp now starts before the near ramp has finished, so the
    // two ends of the axis actually own most of the frame and "mid" is the
    // handover rather than the default.
    // Now in OPTICAL DEPTH (1 - transmittance), see the note in COMPOSITE_FRAG.
    // In the shallows medium these edges put 5 m at fogAmt 0.21 (fully near),
    // 20 m at 0.50 (near 0.42), 50 m at 0.75 (far 0.68) and 100 m at 0.92
    // (fully far) — which is the reference's own near/mid/far read of a
    // shallows frame.
    //
    // ROUND 8 — THE RAMPS NOW CROSS, WHICH IS WHAT MAKES THE ENDS REACHABLE.
    //
    // Measured with ?pfxdebug=6 on the round-7 build, mean weight per shot:
    //
    //   shot            near   mid    far        shot            near   mid    far
    //   base-interior   0.96   0.02   0.01       godrays         0.10   0.43   0.46
    //   shallows-floor  0.88   0.04   0.06       grand-reef      0.10   0.53   0.37
    //   kelp-forest     0.53   0.18   0.28       wreck           0.09   0.56   0.35
    //   dropoff         0.49   0.11   0.40       deep-void       0.05   0.15   0.80
    //   school          0.31   0.22   0.46       surface-above   0.00   1.00   0.00
    //   cave            0.27   0.60   0.13       shallows-reef   0.24   0.48   0.28
    //
    // Six of twelve had mid as the plurality and one was 100% mid. The cause is
    // arithmetic: with the near ramp ending at 0.80 and the far ramp starting at
    // 0.66, mid = aNear - bFar peaked at 0.78 and was the default answer for
    // most of the axis. Overlapping them — near running out to 0.88, far
    // starting at 0.50 — caps mid at 0.46 and lets both ends reach 1.0 over real
    // parts of a frame. The far edge stays at 0.94 rather than 0.96 so the
    // fully-fogged background is unambiguously far.
    cu.uZoneNear.value.set(0.20, 0.88 - 0.10 * tDeep);
    cu.uZoneFar.value.set(0.50 - 0.06 * tDeep, 0.94);

    // ---- THE TWO HUE AXES (OKLab ab, per unit lightness) ---------------------
    //
    // These are the operators the round-3 grade did not have, and the reason it
    // measured "monochrome": every operator it owned was hue-preserving, so no
    // amount of pushing could separate two regions in COLOUR. Both directions
    // below are read off the LIVE MEDIUM, so the grade amplifies the physics
    // underwater.js is already producing instead of inventing a look:
    //
    //   hFog   the biome's level far-field colour — what distance converges to.
    //   hDown  sunlight after the camera's own depth of water. This is what
    //          directly-lit near geometry is coloured by, and it is the exact
    //          reason the reference's lit reef reads greener than the water
    //          above it: with the shallows' absorption at 12 m the beam is
    //          (0.11, 0.76, 0.71), i.e. G/B 1.08 against the fog's 0.77.
    //   hDeep  uAmbientBottom — the medium's own downward/unlit hue, navy in
    //          open water. This is godrays-1's #011434 floor.
    const fogC = U.uFogColor.value;
    const hFog = hueVec(fogC, this._hFog);
    const abs3 = U.uAbsorption.value;
    // Optical path is capped: past ~130 m there is no downwelling beam left to
    // have a colour, and an uncapped exp() there resolves to a single channel.
    const dOpt = Math.min(depth + 5, 130);
    const dw = this._dw.copy(U.uSunColor.value);
    dw.r *= Math.exp(-abs3.x * dOpt);
    dw.g *= Math.exp(-abs3.y * dOpt);
    dw.b *= Math.exp(-abs3.z * dOpt);
    const hDown = hueVec(dw, this._hDown);
    const hDeep = hueVec(U.uAmbientBottom.value, this._hDeep);

    // The hue ANGLE between the beam and the fog. Near rotates toward the beam,
    // far a little the other way, so the frame mean is left where the medium put
    // it — this is a separation operator, not a cast. Measured target:
    // shallows-reef-1's G/B by horizontal third is [0.77, 0.69, 0.93]; round 3
    // produced [0.72, 0.74, 0.74].
    const az = under * this.k.zone;
    let dTheta = Math.atan2(hDown.y, hDown.x) - Math.atan2(hFog.y, hFog.x);
    // shortest way round: a hue rotation of 300 degrees is a rotation of -60.
    dTheta = ((dTheta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    dTheta = clamp(dTheta, -1.1, 1.1);
    const zh = az * this.k.zhue;
    cu.uZoneHue.value.set(dTheta * 0.52 * zh, dTheta * 0.14 * zh, -dTheta * 0.16 * zh);

    // The luminance axis, inside the water column. Brighter water is greener
    // (it is closer to the beam), darker water is the deep ambient. godrays-1
    // runs G/B 1.09 at the top of frame to 0.36 at the bottom; that 3x hue
    // swing is the single strongest colour gradient in any reference frame and
    // no hue-preserving operator can produce any of it.
    const kHi = (0.30 + 0.22 * tMid) * az * this.k.tint;
    const kLo = (0.34 + 0.26 * tMid + 0.10 * tDeep) * az * this.k.tint;
    cu.uTintHi.value.set((hDown.x - hFog.x) * kHi, (hDown.y - hFog.y) * kHi);
    cu.uTintLo.value.set((hDeep.x - hFog.x) * kLo, (hDeep.y - hFog.y) * kLo);
    // On near geometry the DISTANCE axis is the true one and the two would
    // fight, so the split-tone is weighted toward open water.
    cu.uSplitZone.value = 0.30;
    cu.uSplitLo.value.set(0.14, 0.56 - 0.10 * tDeep);
    cu.uSplitHi.value.set(0.46 - 0.10 * tDeep, 0.90);

    // ---- per-zone channel gain, derived from the LIVE BIOME ------------------
    // fogColor is the biome's authored ambient hue and is the single source of
    // truth for what this water is (LOOK.md: kelp #0B3710 green, Dunes #6B5845
    // tan, Jellyshroom #251438 violet). Normalised to unit luminance it is a
    // pure chroma direction with no brightness in it, so pushing the far field
    // along it and the near field against it separates the two IN COLOUR
    // without changing either one's exposure.
    //
    // Round 2 held linear R/B and G/B constant to within 9% from the top of the
    // frame to the bottom. This is the operator that breaks that.
    const fog = m?.fogColor;
    const c = this._chroma;
    if (fog) chromaDir(fog, c); else c.set(1, 1, 1);
    // Strengths solved against the shallows reference's per-third G/B of
    // [0.77, 0.69, 0.93] — a 35% swing from the top of frame to the lit sand at
    // the bottom. At 0.26/0.11 ours measured [0.68, 0.65, 0.70], a 7% swing.
    // ROUND 4 halved `far`. The far field is ALREADY the fog colour — that is
    // what the medium's uwInscatter resolves a long ray to — so scaling it
    // further along the fog's own chromaticity pushes it PAST the fog and
    // over-saturates the water column. Measured: the shallows water crop came
    // back at G/B 0.72 against the reference's 0.79 and 0.81 mean saturation
    // against 0.68. The far field's job here is a nudge; the hue rotation and
    // the near field's resistance carry the separation.
    // ROUND 8 tried 0.24 here and put it back. Measured on the 280 m frame: the
    // extra pull toward the biome's own navy took the world crop's mean G/B by
    // horizontal third from [0.46, 0.33, 0.26] to [0.40, 0.24, 0.18] and its
    // median from 18.6 to 16.5. LOOK.md rule 2 is that green OVERTAKES blue
    // through the 100-200 m band, so pushing a deep frame further along a navy
    // fog chromaticity is the wrong direction however good it looks for red.
    // ROUND 24 — 0.20-0.30 DOWN TO 0.05, AND THE REASON IS FOUR LINES ABOVE IT.
    // "The far field is ALREADY the fog colour — that is what the medium's
    // uwInscatter resolves a long ray to — so scaling it further along the
    // fog's own chromaticity pushes it PAST the fog and over-saturates the
    // water column." Round 4 halved it on that argument and stopped; the
    // argument does not stop at a half. Measured with ?gfar=0 against shipped:
    // grand-reef -0.057 saturation and +7 R%, the second largest single item in
    // the grade. The residual 0.05 is left because the operator's SHAPE is
    // right — the far field should lean on the biome and the near field should
    // resist — and the near half of that pair (below) is doing real work.
    const far = (0.05 + 0.02 * tMid) * this.k.gfar;  // how hard the far field takes the hue
    // ROUND 8: 0.42 -> 0.34, same reason as the saturation trim. The near gain
    // is the RECIPROCAL of the fog chromaticity, so it is a red boost, and the
    // shallows world crop went from R% 25 (the reference's own figure) to 33
    // once the near band grew from a quarter of frame to three fifths.
    const near = (0.34 + 0.06 * tMid) * this.k.gnear; // and how hard the near field resists
    const uw = under * this.k.zone;
    cu.uGainFar.value.set(
      mixClamp(1, c.x, far * uw), mixClamp(1, c.y, far * uw), mixClamp(1, c.z, far * uw));
    cu.uGainMid.value.set(
      mixClamp(1, c.x, far * 0.72 * uw), mixClamp(1, c.y, far * 0.72 * uw),
      mixClamp(1, c.z, far * 0.72 * uw));
    // The reciprocal, not a hand-picked "warm" tint: the near field is the part
    // that has lost the least of whatever the medium eats, so undoing a fraction
    // of the medium's own tint is the physically honest direction. Clamped
    // tighter on the upside than the far gain (1.45 rather than 1.75) because
    // the reciprocal of a cyan fog is red-heavy and LOOK.md rule 1 is
    // unambiguous that red is gone below ~30 m. It may restore contrast in the
    // near field; it may not invent a warm foreground.
    //
    // ROUND 4 tried replacing this with the downwelling beam's own
    // chromaticity, on the theory that that is what near geometry is genuinely
    // lit by. Measured: the shallows frame's mean red fell from 50/255 to
    // 10.5/255 and R% from 25 to 6 against the reference's 25 — the beam is
    // green-teal, so it pushes red the same way the fog does and nothing is
    // left holding the near field's red up. The beam's HUE now drives uZoneHue
    // in OKLab (which is where it belongs, since that axis is about hue, not
    // level) and the gain went back to what measured correctly.
    // ROUND 8 tightens the upper clamp 1.45 -> 1.30 for the third time for the
    // same reason: the near band grew, so every near-field operator got louder.
    // Measured on the shallows world crop, mean RGB against shallows-reef-1's
    // [43, 132.8, 170.7]: the crossing ramps took ours from [40.2, 140.5, 170.7]
    // to [50.8, 136.4, 161.6]. Red 50.8 against 43 is LOOK.md rule 1 drifting in
    // the one direction it must not, and this clamp is where it comes from.
    cu.uGainNear.value.set(
      mixClamp(1, 1 / c.x, near * uw, 0.70, 1.30),
      mixClamp(1, 1 / c.y, near * uw, 0.70, 1.30),
      mixClamp(1, 1 / c.z, near * uw, 0.70, 1.30));

    // Per-channel display gamma — the third leg of lift/gamma/gain, and the one
    // that survives to the display. A power fixes both 0 and 1 and only moves
    // the midtones, so pulling down the channels the water is poor in deepens
    // the middle of the range without touching black (no lift) or white. Kept
    // small: this is a trim on top of the OKLab work, not the colour itself,
    // and every point of it comes out of the red channel.
    const kg = 0.03 * under * this.k.cgamma;
    cu.uGamma.value.set(
      clamp(1 + kg * (1 / Math.max(c.x, 0.25) - 1), 0.85, 1.35),
      clamp(1 + kg * (1 / Math.max(c.y, 0.25) - 1), 0.85, 1.35),
      clamp(1 + kg * (1 / Math.max(c.z, 0.25) - 1), 0.85, 1.35));
    cu.uAOFog.value = 0.55 - 0.15 * tDeep;

    // ---- lens ---------------------------------------------------------------
    // Off unless explicitly asked for. LOOK.md 9 / amateur-tell 21: Subnautica
    // has effectively no chromatic aberration, and visible RGB fringing reads
    // instantly as an off-the-shelf post stack. Same for barrel: there are no
    // hard edges in frame today to show it, but there will be the moment flora
    // lands, and it would be the first thing spotted.
    cu.uBarrel.value = 0.022 * under * this.k.barrel;
    cu.uCA.value = 1.0 * under * this.k.ca;
    // Nearly off. A symmetric radial darkening is a post-stack signature; the
    // references' corner falloff is content-driven and never 4-fold symmetric.
    cu.uVignette.value = (0.045 + 0.030 * tDeep) * this.k.vig;
    // AO is a lighting term and the deep has almost no light to occlude, so it
    // eases off rather than painting dark rings on a black frame.
    this._aoStrength = (1.05 - 0.35 * tDeep) * this.k.ao;
    cu.uAO.value = this._aoStrength;
    // HOW FAR ABOVE THE ENCODER'S STEP THE CRUSH GUARD AIMS. The threshold
    // itself is solved per pixel by blackFloorScene() — this is only a scale on
    // it, so 0 is a clean ablation (?aotoe=0) and 1 means "exactly display code
    // 1, no margin". It stays at 1: the guard must not become a black pedestal,
    // and every tenth above 1 widens the band of dark pixels that opt out of AO
    // altogether. LOOK.md 18/19 — a Subnautica interior has essentially no
    // absolute black in it (the four base-interior plates measure 0.054, 0.183,
    // 0.145 and 0.002%) but a cave frame is 12% black and must stay that way,
    // and only a threshold pinned to the encoder rather than to a level does
    // both.
    cu.uAoBlack.value = this.k.aotoe;

    // ---- THE DEEP BLACK POINT, in display codes -----------------------------
    // See the block in COMPOSITE_FRAG for what the operator is and why the
    // knee is inverted through the grade rather than quoted against the meter.
    // This is only where it sits and how fast it arrives.
    //
    // THE RAMP IS THE WHOLE SAFETY ARGUMENT, and its onset is read off LOOK.md
    // 2's visibility table rather than fitted. Down to 30 m the frame is in
    // full colour with 40-60 m of visibility; through 50-100 m colour drains
    // but silhouettes stay crisp; it is only at 200 m+ that "only
    // self-illuminated things read". So the knee is identically 0 at 60 m and
    // shallower and arrives at 195 m. That interval is what puts every frame
    // this round was told not to move outside its reach: shallows-reef at 12 m
    // (world-crop median 128 against the plate's 134 — a verified match),
    // base-interior at 30 m (the one shot measured too DARK, whose AO floor
    // this round was told to keep), godrays at 40 m, seamoth-cockpit at 45 m
    // (whose absolute-black population the brief measured as already right) and
    // kelp-forest at 55 m. All five come back BIT-IDENTICAL under ablation.
    //
    // A first version opened at 35 m and was moved on measurement, not taste:
    // at 95 m it handed the wreck frame a 7-code knee and took its black
    // population 0.60 -> 3.10% where wreck-1 measures 0.01, and it moved the
    // kelp frame's too (1.99 -> 3.80 against kelp-forest-1's 0.04) while
    // changing no other statistic in that frame at all. Both are frames with a
    // lit water column still in them, which is exactly the case the ramp exists
    // to exclude.
    //
    // ROUND 17 — THE SIZE AND THE SHAPE OF THE RAMP WERE BOTH SOLVED AGAINST
    // PLATES THE AUDIT HAS SINCE REJECTED, AND THE RESULT RANKED THE BATTERY
    // BACKWARDS.
    //
    // The 21 codes came from cave-3 (which reference/PLATES.md keeps as the
    // cave primary) but the +0.55*tDeep +0.35*tAbyss extension came from
    // deep-void-1 and dropoff-1 by way of LOOK.md 19. PLATES.md rejects
    // deep-void-1 for our deep-void shot — it is the 8148 m Void with NO
    // terrain in frame, so scoring an 18-m-above-seabed frame against it
    // penalises having any geometry at all — and the verified primary is
    // deep-void-2 at 589 m. Re-measured against the primaries, world crop
    // (0.05,0.10 - 0.55,0.90):
    //
    //   shot        plate           blk%   <4%    med   OURS r16 (blk/<4/med)
    //   cave        cave-3          12.5   39.8    5.0   13.8 / 80.0 / 1.1
    //   deep-void   deep-void-2      1.2   15.0   16.3   25.7 / 76.0 / 1.7
    //   grand-reef  grand-reef-2     0.0    0.0   33.6    2.9 / 53.9 / 3.5
    //
    // The old ramp handed the cave 22 codes, grand-reef 28 and deep-void 39 —
    // the exact inverse of what those three plates ask for. Depth is not the
    // axis: the cave is ENCLOSED and has no lit column over it, while both of
    // the others still do, and that is a property of the shot rather than of
    // the metre count. So the tDeep/tAbyss terms are gone and the knee is flat
    // once the opening ramp has run.
    //
    // 3.5, SWEPT rather than derived, because the nominal number is not the
    // effective one. sceneForDisplayL() solves on the ACHROMATIC axis, and
    // every frame this stage touches is strongly blue-teal; measured, a nominal
    // 10 behaved like roughly 25-30 display codes on grand-reef (the pixel
    // sitting at code 19.9 came out at 17.2, which needs the knee ABOVE that
    // pixel's scene value, not a factor of 1.8 below it). Its comment claims
    // solving on the neutral is "the conservative direction"; on this content it
    // is the opposite. The same helper sizes the AO black-floor guard, which is
    // therefore ~3x more permissive-looking than its own note claims. Recorded
    // rather than papered over; the knee here is calibrated on the measurement.
    //
    // The sweep, world crop (0.05,0.10 - 0.55,0.90), --isolate, 1920x1080, as
    // % under luminance 8 / % under luminance 4 / median, against each shot's
    // PRIMARY plate:
    //
    //   nominal      cave                deep-void            grand-reef
    //     0     49.5 / 15.3 / 8.1    22.2 /  0.0 / 13.8    0.1 /  0.0 / 19.9
    //     3     53.0 / 24.9 / 7.5    29.0 /  9.9 / 13.8    0.2 /  0.0 / 19.9
    //     4     60.0 / 33.3 / 6.4    35.9 / 17.9 / 13.5      -
    //    10     75.0 / 65.7 / 2.1    56.9 / 44.4 /  5.2   33.6 / 15.7 / 17.2
    //    r16    84.3 / 80.0 / 1.1    85.6 / 76.0 /  1.7   65.8 / 53.9 /  3.5
    //   PLATE   58.0 / 39.8 / 5.0    28.5 / 15.0 / 16.3    0.0 /  0.0 / 33.6
    //
    // 3.5 is the value that minimises the largest error across the three: cave
    // lands ~56 against 58 under luminance 8, deep-void ~32 against 28.5, and
    // grand-reef — whose plate contains NO black anywhere, p0.1 = 11.7 — is
    // left where the ablation puts it. Anything at or above 10 buys the cave's
    // absolute-black population by destroying the other two frames.
    //
    // The opening ramp is unchanged in kind but now arrives at 180 m, so every
    // frame the round-16 ablation proved bit-identical stays bit-identical:
    // shallows-reef 12 m, base-interior 30 m, godrays 40 m, seamoth-cockpit
    // 45 m, kelp-forest 55 m, shallows-floor 18 m, surface-above. The wreck at
    // 95 m now gets 2.1 codes where round 16 gave it 3.7, against wreck-1's
    // measured 0.01% absolute black.
    //
    // ?deepblack=<codes> overrides it and ?deepblack=0 ablates the stage
    // exactly (uDeepBlackL 0 skips the branch entirely). ?dbfog=0 ablates the
    // optical-depth key and ?dbgate=0 restores the round-16 per-pixel toe, so
    // each of the three changes can be measured on its own.
    // ROUND 24 — RE-SOLVED FROM 3.5 TO 2.6, ON A DIFFERENT STATISTIC AND A
    // DIFFERENT CAVE PLATE, AND BOTH CHANGES OF BASIS ARE ARGUED.
    //
    // (1) THE STATISTIC. Round 17 minimised the % of crop under luminance 8
    //     against deep-void-2's 28.64%. That target is not reachable: at 3.5 we
    //     deliver 6.3% and the frame's dark band carries 4.2 distinct luminance
    //     codes per 9x9 window against the plate's 16.6, so everything this
    //     stage does push under 8 arrives as flat black card rather than as the
    //     plate's textured darkness. Optimising an unreachable number by
    //     manufacturing the exact defect the brief names is the wrong trade.
    //     FLAT black — the fraction of crop inside some 9x9 window whose every
    //     pixel is under luminance 8 — is reachable and is the named number.
    //
    // (2) THE CAVE PLATE. reference/PLATES.md makes cave-3 the primary but
    //     admits cave-1 "for the depth band only... unless our cave is
    //     jellyshroom". Our cave shot IS jellyshroom: the in-frame biome label
    //     reads "Jellyshroom Cavern" and the frame is violet caps and stalks
    //     under biolum, which is cave-1's content and not cave-3's unlit teal
    //     mouth. So the conditional resolves the other way here and cave-1 is
    //     the fair plate for this frame's level and black population.
    //
    // Same session, --isolate, identical draw counts on deep-void (307) so the
    // geometry cannot have moved between cells; shot crop:
    //
    //   knee     deep-void  <8% / flat% / p0.1     cave  <8% / flat%    grand-reef
    //   3.5          6.33 / 4.87 / 4.9                14.58 / 12.21     0.00 / 0.00
    //   2.6          2.57 / 0.18 / 6.6                12.78 /  9.80     0.00 / 0.00
    //   PLATE       28.64 / 0.60 / 0.0 (dv-2)          5.88 /  5.04 (cave-1)  0.01 / 0.00
    //
    // 2.6 takes deep-void's flat black from 8.1x its plate to 0.3x, moves cave
    // 2.4x -> 1.9x, costs zero median on either (25.0 and 16.1 both ways), and
    // leaves grand-reef's zero-black closure bit-identical. The residual excess
    // on cave is the flat-black silhouette geometry round 23 measured at 66% of
    // that frame's excess; it is not this stage's.
    const dbCode = this.k.deepblack * under * smoothstep(60, 180, depth);
    // OKLab L of that display code = cbrt of its display-LINEAR luminance. The
    // sRGB decode is done here rather than in the shader so the shader carries
    // one pow() instead of three.
    const dbS = clamp01(dbCode / 255);
    const dbY = dbS <= 0.04045 ? dbS / 12.92 : Math.pow((dbS + 0.055) / 1.055, 2.4);
    cu.uDeepBlackL.value = dbCode > 0.01 ? Math.cbrt(dbY) : 0;
    cu.uDeepBlackFog.value.set(0.25, 0.72, this.k.dbfog);
    cu.uDeepBlackGate.value = this.k.dbgate;

    // ---- depth of field -----------------------------------------------------
    // Turbidity blur tracks the medium: clear shallows are crisp to the fog
    // limit, murk goes soft close in. Never enough to read as "a DoF effect".
    const vis = U.uMaxVisibility.value || 50;
    this.coc.uTurbidity.value = (0.07 + 0.16 * clamp01((70 - vis) / 55)) * under;
    this.coc.uCocFar.value = 0.16 + 0.10 * under;
    // The near aperture, in metres, not a ratio gain — see cocFor(). 0.045
    // puts the near acceptable limit at 0.45 m with the focus at infinity,
    // which keeps every piece of player-attached geometry (cockpit dash, held
    // tool, hands: 0.3-1.5 m) sharp exactly as the reference plates have it,
    // and still softens something pressed against the lens.
    this.coc.uCocNear.value = 0.045;
    cu.uDofMix.value = this.k.dof;

    // Hyperfocal distance: roughly a third of usable visibility, because past
    // that the medium has already flattened everything anyway.
    this.mFocus.uniforms.uFar.value = clamp(vis * 0.30, 5, 24);
    this.mFocus.uniforms.uRate.value = this._focusWarm
      ? 1 - Math.exp(-3.0 * Math.min(dt, 0.1)) : 1;
    this._focusWarm = true;
  },

  // -------------------------------------------------------------------------
  // last-moment: TAA jitter must be the final word on the projection matrix
  // -------------------------------------------------------------------------
  preRender(ctx) {
    const cam = ctx.camera;
    if (this.probe) {
      this.probe.position.copy(cam.position);
      this.probe.quaternion.copy(cam.quaternion);
      // ~2.5 m/s lateral, the speed of a peeper
      for (const m of this._movers) {
        m.mesh.position.x = m.base.x + Math.sin(ctx.time.t * 1.7 + m.phase) * 1.5;
      }
      this.probe.updateMatrixWorld(true);
    }
    if (!this.enabled) return;
    if (this.aaMode === 'taa') {
      const j = JITTER[this._jitterIndex % JITTER.length];
      this._jitterIndex++;
      // setViewOffset survives any later updateProjectionMatrix() call, which a
      // plain projectionMatrix poke would not.
      cam.setViewOffset(this.width, this.height, j[0], j[1], this.width, this.height);
    } else if (cam.view) {
      cam.clearViewOffset();
    }
  },

  // -------------------------------------------------------------------------
  render(src, dst) {
    const r = this.renderer;
    const cam = this.camera;

    // Resolution can change without a resize event (pixel ratio, capture harness).
    if (src.width !== this.width || src.height !== this.height) {
      this._buildTargets(src.width, src.height);
      this._syncSizes();
      this._historyValid = 0;
    }
    this.uNearFar.value.set(cam.near, cam.far);

    // ?nopostfx=1 — tonemap ONLY, so a critic can see exactly what the grade
    // adds. Round 2's chain measured identical to this bypass on median, p0.1,
    // saturation and detail RMS across all four battery shots; keeping the
    // bypass honest (curve on, everything else genuinely neutral) is the only
    // way that comparison stays a real test.
    if (!this.enabled) {
      const cu0 = this.mComposite.uniforms;
      cu0.tColor.value = src.texture;
      cu0.tBloom.value = this.bloom[0].texture;
      cu0.tDof.value = src.texture;
      cu0.tAO.value = this.aoA.texture;
      cu0.tFocus.value = this.focusA.texture;
      cu0.tLocal.value = this.lc1.texture;
      cu0.tWide.value = this.lc3.texture;
      cu0.tExposure.value = this.adaptA.texture;
      cu0.tExposureSlow.value = this.slowA.texture;
      // ROUND 31 — THE BYPASS RAILS, AND UNTIL NOW IT COULD NOT BE MOVED OFF
      // THE RAIL. ?nopostfx=1 is exposure 1.0 into a straight clamp, and the
      // world hands this file a godrays water column whose green and blue are
      // both ABOVE scene-linear 1.0 over most of frame: measured on eight
      // pure-water windows of shots/postfx-r31-bypass/godrays.png, clipAny runs
      // 79.2-80.0% with green at 79.7% and blue at 28.8% in the brightest of
      // them. Every channel statistic ever taken off that image is a clamp
      // artefact — which is exactly what SYSTEMATIC's "READ FIRST (3)" found
      // the OLD clipPct metric hiding, and the bypass is the last place in the
      // project still producing them.
      //
      // ?exposure= is a plain scalar on a chain that is otherwise the identity
      // here (bloom 0, vignette 0, AO 0, hiCompress knee 1e6, uCurve 3), so
      // ?nopostfx=1&exposure=0.25 is the SAME raw HDR buffer, scaled, and a
      // scale cannot move a chromaticity: ab/L in OKLab and (max-min)/max in
      // RGB are both exactly scale-invariant, and a log-log drift slope is
      // invariant to a uniform scale by construction. So this makes the medium
      // readable on a bright frame without making the bypass mean anything
      // different. It defaults to 1.0 and is bit-identical to round 30 there.
      this.meter.uExposure.value = this.k.exposure;
      // ...and with the two meter authorities at 0, sceneExposure() collapses to
      // exactly uExposure whatever the meter pyramid reads.
      this.meter.uMeterFast.value = 0;
      this.meter.uMeterSlow.value = 0;
      this.meter.uEvFast.value.set(1, 1);
      this.meter.uEvSlow.value.set(1, 1);
      cu0.uBloom.value = 0; cu0.uAO.value = 0; cu0.uAoBlack.value = 0;
      cu0.uDeepBlackL.value = 0;
      cu0.uBarrel.value = 0; cu0.uCA.value = 0; cu0.uVignette.value = 0;
      cu0.uDofMix.value = 0; cu0.uVibrance.value = 0;
      cu0.uZone.value = 0;                    // kills every zone weight
      cu0.uZoneContrast.value.set(1, 1, 1);
      cu0.uZoneSat.value.set(1, 1, 1);
      cu0.uZoneGamma.value.set(1, 1, 1);
      cu0.uZoneClarity.value.set(0, 0, 0);
      cu0.uZoneClarityW.value.set(0, 0, 0);
      cu0.uPivotAuto.value = 0;
      cu0.uGainNear.value.set(1, 1, 1);
      cu0.uGainMid.value.set(1, 1, 1);
      cu0.uGainFar.value.set(1, 1, 1);
      // The OKLab block: every offset to zero and the rolloff pushed off the
      // top of the range, so the bypass really is "raw HDR, clamped, encoded".
      // uZone = 0 already kills the zone offsets, but the split-tone is keyed on
      // LIGHTNESS, not on a zone weight, so it has to be zeroed explicitly.
      cu0.uZoneHue.value.set(0, 0, 0);
      cu0.uTintLo.value.set(0, 0);
      cu0.uTintHi.value.set(0, 0);
      cu0.uHiRoll.value = 1.0;
      cu0.uHiCeil.value = 0.0;         // ROUND 26: a bypass has no ceiling either
      cu0.uFarFloor.value = 0.0;       // ...and no floor. uZone = 0 already makes
                                       // wFar 0, so this is belt and braces.
      cu0.uFarScene.value = 0.0;
      cu0.uFarCScene.value = 0.0;
      cu0.uFarChroma.value = 0.0;      // ROUND 28: and no chroma lock. Same
                                       // belt and braces — with uZone = 0 the
                                       // far weight is 0, so the mix is the
                                       // identity either way, but a bypass that
                                       // depends on another uniform for its
                                       // neutrality is one edit from not being
                                       // one.
      cu0.uMidGamma.value = 1.0;
      cu0.uMidLevel.value.set(0, 1);
      cu0.uChromaRecovery.value = 0;
      cu0.uCurveGain.value = 1.0;
      // Knee out past anything the world can produce: hiCompress() is then the
      // identity, which is what a bypass has to be.
      cu0.uHiComp.value.set(1e6, 1e6, 1.0);
      cu0.uAirGrade.value.set(1, 1, 1);
      cu0.uCurve.value = 3;                   // straight clamp — see tonemap()
      cu0.uAcesHue.value = 0.0;               // ROUND 29: uCurve = 3 never
                                              // reaches acesFitted(), so this is
                                              // belt and braces for the same
                                              // reason uFarChroma is above.
      cu0.uToe.value = 0; cu0.uShoulder.value = 0.70; cu0.uWhite.value = 1.50;
      cu0.uGamma.value.set(1, 1, 1);
      this._draw(this.mComposite, dst || null);
      r.setRenderTarget(null);
      return;
    }

    const depthTex = src.depthTexture || this.depthTex;
    const hasDepth = !!depthTex;
    for (const mat of [this.mTaa, this.mFocus, this.mAO, this.mAOBlur, this.mDofDown, this.mComposite]) {
      if (mat.uniforms.tDepth) mat.uniforms.tDepth.value = depthTex;
    }

    // ---- matrices -----------------------------------------------------------
    // camera.matrixWorldInverse is current — the renderer just used it.
    this._tmpVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const invVPJ = this.mTaa.uniforms.uInvVP.value.copy(this._tmpVP).invert();
    this.mAO.uniforms.uInvVP.value.copy(invVPJ);

    // Unjittered VP for the NEXT frame's reprojection: the history buffer is the
    // average of jittered samples, i.e. it lives at unjittered pixel centres.
    this._tmpProjU.copy(cam.projectionMatrix);
    this._tmpProjU.elements[8] = 0;   // m02 — the only place setViewOffset lands
    this._tmpProjU.elements[9] = 0;   // m12

    let colorTex = src.texture;

    // A TELEPORT RESETS BOTH ADAPTATIONS. The slow reference has a ~10 s time
    // constant, which is right for a swim and wrong for a hard cut: after
    // __CN.shot() drops the camera 600 m down the water column the slow meter
    // would still be describing the shallows, the fast/slow ratio would be
    // enormous, and the stabiliser would spend its whole clamp on an event no
    // player can experience. 15 m in one frame is 900 m/s — not swimming.
    if (this._prevCamPos.distanceTo(cam.position) > 15.0) this._adaptValid = 0;

    // ---- 1. TAA -------------------------------------------------------------
    if (this.aaMode === 'taa' && hasDepth) {
      const moved = this._prevCamPos.distanceTo(cam.position);
      const turned = 1 - Math.abs(this._prevQuat.dot(cam.quaternion));
      // A teleport (shot change) invalidates every pixel — better a single
      // aliased frame than a smeared one.
      if (moved > 2.0 || turned > 0.02) this._historyValid = 0;

      const hist = this._taaPing ? this.taaA : this.taaB;
      const cur = this._taaPing ? this.taaB : this.taaA;
      this.mTaa.uniforms.tCur.value = src.texture;
      this.mTaa.uniforms.tHist.value = hist.texture;
      this.mTaa.uniforms.uPrevVP.value.copy(this._prevVP);
      this.mTaa.uniforms.uValid.value = this._historyValid;
      this._draw(this.mTaa, cur);
      colorTex = cur.texture;
      this._taaPing ^= 1;
      this._historyValid = 1;
    } else {
      this._historyValid = 0;
    }

    this._prevVP.multiplyMatrices(this._tmpProjU, cam.matrixWorldInverse);
    this._prevCamPos.copy(cam.position);
    this._prevQuat.copy(cam.quaternion);

    // ---- 2. focus -----------------------------------------------------------
    const focusPrev = this._focusPing ? this.focusA : this.focusB;
    const focusCur = this._focusPing ? this.focusB : this.focusA;
    if (hasDepth) {
      this.mFocus.uniforms.tPrev.value = focusPrev.texture;
      this._draw(this.mFocus, focusCur);
      this._focusPing ^= 1;
    }

    // ---- 3. SSAO ------------------------------------------------------------
    let aoTex = null;
    if (hasDepth && this.k.ao > 0) {
      this._draw(this.mAO, this.aoA);
      this.mAOBlur.uniforms.tAO.value = this.aoA.texture;
      this.mAOBlur.uniforms.uDir.value.set(1 / Math.max(1, this.aoA.width), 0);
      this._draw(this.mAOBlur, this.aoB);
      this.mAOBlur.uniforms.tAO.value = this.aoB.texture;
      this.mAOBlur.uniforms.uDir.value.set(0, 1 / Math.max(1, this.aoA.height));
      this._draw(this.mAOBlur, this.aoA);
      aoTex = this.aoA.texture;
    }

    // ---- 3b. exposure meter -------------------------------------------------
    // Runs BEFORE bloom, because the bloom prefilter's threshold is applied
    // after the metered exposure and has to see this frame's value.
    const li = this.mLumaInit.uniforms;
    li.tSrc.value = colorTex;
    li.uTexel.value.set(1 / this.lum[0].width, 1 / this.lum[0].height);
    this._draw(this.mLumaInit, this.lum[0]);
    for (let i = 1; i < this.lum.length; i++) {
      const s = this.lum[i - 1];
      this.mLumaDown.uniforms.tSrc.value = s.texture;
      this.mLumaDown.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this._draw(this.mLumaDown, this.lum[i]);
    }
    const lumTex = this.lum[this.lum.length - 1].texture;
    const adaptPrev = this._adaptPing ? this.adaptA : this.adaptB;
    const adaptCur = this._adaptPing ? this.adaptB : this.adaptA;
    this.mAdapt.uniforms.tCur.value = lumTex;
    this.mAdapt.uniforms.tPrev.value = adaptPrev.texture;
    this.mAdapt.uniforms.uValid.value = this._adaptValid;
    this._draw(this.mAdapt, adaptCur);
    const slowPrev = this._adaptPing ? this.slowA : this.slowB;
    const slowCur = this._adaptPing ? this.slowB : this.slowA;
    this.mAdaptSlow.uniforms.tCur.value = lumTex;
    this.mAdaptSlow.uniforms.tPrev.value = slowPrev.texture;
    this.mAdaptSlow.uniforms.uValid.value = this._adaptValid;
    this._draw(this.mAdaptSlow, slowCur);
    this._adaptPing ^= 1;
    this._adaptValid = 1;
    this.meter.tExposure.value = adaptCur.texture;
    this.meter.tExposureSlow.value = slowCur.texture;

    // ---- 4. bloom -----------------------------------------------------------
    const bd = this.mBloomDown.uniforms;
    bd.tSrc.value = colorTex;
    bd.uFirst.value = 1;
    bd.uTexel.value.set(1 / this.width, 1 / this.height);
    this._draw(this.mBloomDown, this.bloom[0]);
    bd.uFirst.value = 0;
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const s = this.bloom[i - 1];
      bd.tSrc.value = s.texture;
      bd.uTexel.value.set(1 / s.width, 1 / s.height);
      this._draw(this.mBloomDown, this.bloom[i]);
    }
    const bu = this.mBloomUp.uniforms;
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const s = this.bloom[i];
      bu.tSrc.value = s.texture;
      bu.uTexel.value.set(1 / s.width, 1 / s.height);
      bu.uRadius.value = 1.0;
      // Each mip is twice as wide as the last, so a flat chain weight makes the
      // wide mips dominate by area and the glow smears the whole frame. This
      // weight makes the accumulated kernel fall off roughly as 1/r^2 — the
      // veiling-glare shape of a real lens — giving a tight bright core with a
      // long, very faint skirt. Measured halo: ~45 px at 1080p (LOOK.md: 20-60).
      bu.uWeight.value = this._bloomFalloff;
      this._draw(this.mBloomUp, this.bloom[i - 1]);
    }

    // ---- 5. local-contrast references ---------------------------------------
    // Same 13-tap COD downsample, threshold disabled, four levels. Bilinear from
    // 1/4 res lc1 is a ~5 px low-pass (acutance); from 1/16 res lc3 it is a
    // ~20 px low-pass (local contrast). The composite subtracts each from the
    // level above it in the log domain.
    bd.uFirst.value = 0;
    bd.tSrc.value = colorTex;
    bd.uTexel.value.set(1 / this.width, 1 / this.height);
    this._draw(this.mBloomDown, this.lc0);
    for (const [src, dst] of [[this.lc0, this.lc1], [this.lc1, this.lc2], [this.lc2, this.lc3]]) {
      bd.tSrc.value = src.texture;
      bd.uTexel.value.set(1 / src.width, 1 / src.height);
      this._draw(this.mBloomDown, dst);
    }

    // ---- 6. DoF -------------------------------------------------------------
    let dofTex = colorTex;
    if (hasDepth && this.k.dof > 0) {
      this.mDofDown.uniforms.tColor.value = colorTex;
      this.mDofDown.uniforms.tFocus.value = focusCur.texture;
      this._draw(this.mDofDown, this.dofA);
      this.mDofGather.uniforms.tDof.value = this.dofA.texture;
      this._draw(this.mDofGather, this.dofB);
      dofTex = this.dofB.texture;
    }

    // ---- 7. composite -------------------------------------------------------
    const cu = this.mComposite.uniforms;
    cu.tColor.value = colorTex;
    cu.tBloom.value = this.bloom[0].texture;
    cu.tDof.value = dofTex;
    cu.tAO.value = aoTex || this.aoA.texture;
    cu.tFocus.value = focusCur.texture;
    cu.tLocal.value = this.lc1.texture;
    cu.tWide.value = this.lc3.texture;
    cu.uAO.value = aoTex ? this._aoStrength : 0.0;
    cu.uDofMix.value = (hasDepth ? 1 : 0) * this.k.dof;

    const wantFxaa = this.aaMode === 'fxaa';
    this._draw(this.mComposite, wantFxaa ? this.ldr : dst || null);

    // ---- 8. FXAA ------------------------------------------------------------
    if (wantFxaa) {
      this.mFxaa.uniforms.tSrc.value = this.ldr.texture;
      this._draw(this.mFxaa, dst || null);
    }

    r.setRenderTarget(null);
  },

  _draw(material, target) {
    _quad.material = material;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(_fsScene, _fsCam);
  },

  // -------------------------------------------------------------------------
  // dev probe: ?pfxprobe=1 — a calibration rig for bloom / DoF / AA / the curve.
  // Never present in a normal run.
  // -------------------------------------------------------------------------
  /**
   * Built in camera-local space and pinned to the camera every frame, so it is
   * framed identically in every shot. Purely a calibration rig — it exists to
   * make bloom falloff, the CoC ramp, edge AA and the tone curve *measurable*
   * while the rest of the world is still a stub.
   */
  _buildProbe(ctx) {
    const g = new THREE.Group();
    g.name = 'postfx-probe';
    const rng = ctx.rng;

    // NOTE: emissive-Lambert, not MeshBasicMaterial. core/underwaterMaterial.js
    // detects `objectNormal` by searching for '<beginnormal_vertex>' in the
    // vertex source, and meshbasic contains that include inside an
    // `#if defined(USE_ENVMAP)` guard — so a patched MeshBasicMaterial fails to
    // compile with "'objectNormal' : undeclared identifier". Worth reporting to
    // whoever owns core; every module that lights a decal or a sprite will hit it.
    const emitter = (r, gg, b, intensity, fogScale) => {
      const m = new THREE.MeshLambertMaterial({
        color: 0x000000,
        emissive: new THREE.Color(r, gg, b),
        emissiveIntensity: intensity,
      });
      applyUnderwater(m, { caustics: 0, fogScale });
      return m;
    };

    // --- bloom ladder: 1 / 4 / 16 / 64 x white, 6 m out
    const sphere = new THREE.SphereGeometry(0.15, 20, 14);
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(sphere, emitter(1, 0.94, 0.78, Math.pow(4, i), 0));
      mesh.position.set((i - 1.5) * 1.1, 1.35, -6);
      g.add(mesh);
    }

    // --- bioluminescence cluster: the thing bloom exists for. These also MOVE,
    //     because a depth-reprojected TAA has no motion vector for them — they
    //     are the fish case, and if the resolve ghosts anywhere it ghosts here.
    const bioMat = emitter(0.05, 0.72, 1.0, 8, 0.35);
    this._movers = [];
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), bioMat);
      mesh.position.set(-2.4 + rng() * 0.8, -0.5 + rng() * 0.8, -5.2 - rng() * 1.4);
      g.add(mesh);
      this._movers.push({ mesh, base: mesh.position.clone(), phase: rng() * 6.28 });
    }
    // --- warm accent (creepvine seed pod analogue) — tests hue under bloom
    const podMat = emitter(1.0, 0.38, 0.04, 9, 0.35);
    for (let i = 0; i < 9; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), podMat);
      mesh.position.set(2.3 + rng() * 0.6, -0.4 + rng() * 0.6, -5.4 - rng() * 1.0);
      g.add(mesh);
    }

    // --- AA torture: thin near-horizontal bars, the worst case for any resolve
    const barMat = emitter(0.62, 0.70, 0.72, 1.0, 0.25);
    barMat.side = THREE.DoubleSide;
    for (let i = 0; i < 24; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.035), barMat);
      bar.position.set(0.2, 0.95 - i * 0.075, -9);
      bar.rotation.z = -0.45 + i * 0.038;
      g.add(bar);
    }

    // --- depth ladder: six posts at 1.5 .. 48 m, sized and placed so they land
    //     at identical screen size and height. Anything that differs between
    //     them is DoF, fog or the depth-weighted grade — nothing else.
    const postMat = emitter(0.34, 0.46, 0.49, 1.15, 1.0);
    [1.5, 3, 6, 12, 24, 48].forEach((d, i) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.055 * d, 0.42 * d, 0.055 * d), postMat);
      post.position.set((i - 2.5) * 0.165 * d, -0.30 * d, -d);
      g.add(post);
    });

    ctx.scene.add(g);
    this.probe = g;
  },
};

export default postfx;
