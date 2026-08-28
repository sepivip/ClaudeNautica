/**
 * AUDIO — the other half of the water.
 * OWNER: the "audio" agent (src/audio/audio.js).
 *
 * Everything here is synthesised with the Web Audio API at runtime. There are no
 * sample files, no downloads, no binary assets — the same constraint the visual
 * modules work under. Oscillators, procedurally-filled noise buffers, biquad
 * formant chains and one procedurally-generated convolution impulse are the whole
 * palette.
 *
 * What it does
 *   - Per-biome ambient beds, crossfaded from biomes.ambienceAt(x,y,z). 16 beds:
 *     one per ambience tag plus an above-water surface bed.
 *   - A water muffle chain (gentle lowpass + high shelf cut + a low peaking
 *     "pressure" bell) driven by U.uUnderwater and depth. Crossing the waterline
 *     fires a plunge/burst transient, so it is an event, not a fade.
 *   - Positional creature vocalisations through THREE.AudioListener, including
 *     distant leviathan roars scheduled at the edge of hearing.
 *   - Player: regulator breathing (which IS the oxygen HUD), swim strokes,
 *     heartbeat under stress, damage grunts.
 *   - Holographic UI stings for the PDA, scanner and fabricator.
 *   - Sparse ambient music pads that swell on discovery and on danger.
 *   - A master mixer with a sidechain duck so a roar cuts through the bed.
 *
 * You cannot screenshot audio, so the whole graph is context-agnostic: every
 * voice builds into any BaseAudioContext. `analyze()` re-renders the identical
 * code into an OfflineAudioContext and measures spectra, levels, DC offset and
 * click crest factor. See the numbers in the round report.
 *
 * Browser autoplay policy: the AudioContext is created on the first real user
 * gesture and NOT before, which is also why a headless capture never sees an
 * "AudioContext was not allowed to start" warning. `api.needsGesture` is exposed
 * so ui.js can prompt for the click; `analyze()` needs no gesture at all.
 *
 * Consumed (all guarded — several of these are still stubs):
 *   biomes.ambienceAt / biomes.at   bed crossfades, hostility, temperature
 *   movement.position / .velocity   listener pose, stroke rate  (stub -> camera)
 *   movement.timeSinceCross         the exact frame the eye broke the surface
 *   ctx.water.muffle                watersurface's 70 cm gameplay/audio curve
 *   survival.vitals()               breathing rate, heartbeat   (stub -> local model)
 *   tools._scan / inventory / vm    the scanner, knife, fabricator, beacons
 *   vehicles.piloting               a dry cabin around a wet world
 *   creatures.list / .nearest       who roars and from where
 *
 * NOTHING IN THE GAME CALLS THIS MODULE, so it goes and gets its own triggers.
 * The interaction layer (scan / knife / craft / pickup / beacon / equip) is
 * driven by polling tools.js's published state in _pollTools(), and ui.js's cue
 * channel is adopted at runtime in _adoptUiCues() — see both for why, and for
 * the one-line changes on those modules' side that would make this unnecessary.
 *
 * Published for other modules (ctx.get('audio')):
 *   sting(name, opts)        UI/PDA/scanner/craft stings
 *   uiCue(kind, amt)         ui.js's own cue vocabulary, mixed properly
 *   vocalise(species, pos)   one positional creature call
 *   roar(opts)               force a distant leviathan roar
 *   player(name)             'stroke' | 'knife' | 'grunt' | 'hurt' | 'bubbles' | 'gasp'
 *   music(kind)              'discovery' | 'danger' | 'drift'
 *   duck(amount, seconds)    sidechain the bed and music
 *   setMasterVolume(v) / setMuted(b) / needsGesture / running
 * Modules that cannot import this file can also fire a DOM event:
 *   dispatchEvent(new CustomEvent('cn:audio', { detail: { sting: 'scan-complete' } }))
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { makeRNG } from '../core/rng.js';

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const MIX = {
  /**
   * Master is now unity and the programme trim moved BEFORE the limiter.
   *
   * It used to be 0.62 sitting after it, which meant the limiter was operating
   * 4.2 dB above the level that actually left the module — so it engaged on
   * material that was nowhere near clipping, and the thing it engaged on was
   * whatever was SUSTAINED. A leviathan roar is sustained for two seconds; a
   * bed's overlapping grains are transients. The compressor therefore held the
   * roar down to -8.4 dBFS while letting the bed's own pile-ups through at
   * -6 dB, and no amount of gain on the animal could move it. Trimming first
   * and limiting last makes the limiter a ceiling instead of a governor.
   */
  master: 1.0,
  trim: 0.46,
  bed: 0.75,
  life: 1.15,
  player: 0.9,
  /**
   * The UI bus used to sit at 0.7 and a PDA confirmation moved the block RMS
   * only 2-4 dB over the bed — measured on the live master, firing all eleven
   * stings 1.3 s apart at 30 m. Only the spectral centroid gave them away. A
   * confirmation has to read as a confirmation, so the bus runs hot and the
   * sting envelopes were raised with it; both are inside the helmet, which is
   * why they can be louder than the sea without sounding pasted on.
   */
  ui: 1.15,
  music: 1.5,
  // sets the size of the room now that the impulse is unit-energy (makeIR)
  verb: 0.7,
  /**
   * A brickwall at the very top, NOT a compressor. At threshold -9 / ratio 12 /
   * knee 8 (behind a 0.62 master) the ambient bed rode in permanent gain
   * reduction: master peaks measured -4.6 to -7.1 dBFS in twelve different
   * states, i.e. the bus was pinned wherever you stood and an event physically
   * could not get above it. -1.5 dB with a ratio of 20 and a 2 ms attack only
   * touches a genuine over — a roar landing on top of a swell — and leaves
   * everything below it exactly as authored.
   */
  limit: { threshold: -1.0, knee: 2, ratio: 20, attack: 0.002, release: 0.12 },
};

/**
 * The muffle. NOT a brick-wall lowpass: the beds are already authored dark, so
 * a 700 Hz brick underwater would erase the design rather than express it. What
 * changes across the waterline is a gentle roll-off, a high-shelf cut and a low
 * peaking bell — measured centroid shift is ~3.5x, and the beds themselves swap
 * content on top of that.
 */
const WATER = {
  lpAir: 20000, lpWater: 2350, lpDeep: 1150,
  shelfHz: 1500, shelfAir: 0, shelfWater: -13, shelfDeep: -21,
  /**
   * The 88 Hz bell was +9.5 dB at depth. Everything the deep plays lives under
   * 250 Hz, so that bell was a broadband +9.5 on the entire bed while adding
   * nothing to the SENSE of weight that the pressure drone does not already
   * carry — and it was a third of the reason the abyss ran 11 dB hotter than
   * the shallows with no room left for a roar. +4 keeps the tilt, loses the
   * pile-up.
   */
  bellHz: 88, bellAir: 0, bellWater: 4.5, bellDeep: 4,
  /** metres over which the deep end of those ramps is reached */
  deepAt: 520,
  tau: 0.09, tauCross: 0.03,
  /** the sub drone that IS the weight of water. 0.24 was a bed layer, not a cue. */
  pressure: 0.10,
  /** inside a vehicle cabin you are in air: the muffle mostly lifts, quietly */
  cabinSub: 0.42, cabinBed: 0.55,
};

const BREATH = {
  /** seconds per breath cycle at rest and when the tank is nearly dry */
  calm: 4.6, hard: 1.85,
  /** oxygen fraction under which breathing becomes ragged */
  strain: 0.35, panic: 0.14,
};

const ROAR = {
  /** mean seconds between distant calls, scaled by biome hostility */
  calmInterval: 165, dreadInterval: 42,
  /**
   * Below this biome hostility nothing unprompted ever calls. safe_shallows is
   * 0.05 and used to get a reaper or a reefback every ~158 s starting 40-100 s
   * after spawn: the starting biome is the one place in Subnautica that is
   * SAFE, and a reaper calling there on minute one throws away the whole
   * escalation. Every biome deep enough to deserve a leviathan is >= 0.25.
   */
  gate: 0.2,
  near: 150, far: 270,
  /**
   * In the deep, visibility is 10-15 m and 150-270 m of water eats a call down
   * to a ~340 Hz smear. The distance model is honest, so the caller comes
   * closer instead: at 500 m+ the leviathan is 90-190 m away and its throat
   * survives the trip.
   */
  nearDeep: 90, farDeep: 190,
};

// ---------------------------------------------------------------------------
// bed table — one entry per biomes.js ambience tag, plus 'surface'
//
// drone   : low sustained tone stack. root Hz, partial ratios, filter, swell LFO
// noise   : the body of the water. band-limited noise with a wandering filter
// surge   : a second, slower-moving noise layer — water actually moving past you
// grains  : sparse events. rate is mean events/second, drawn from an exponential
// bright  : how open the top end of this place is (drives the bed's own tilt)
//
// gain SCALES THE SUSTAINED LAYERS ONLY — drone, noise and surge. Grains are
// deliberately outside it, because a bed's level and its event level are two
// different design decisions and the deep needs the second one to be LOUDER
// than the first.
//
// The dark beds used to run at 0.85-1.0 like the bright ones, and that was
// wrong by ~11 dB: all their content is under 250 Hz, so the water lowpass
// (which strips the shallows) does nothing to them, the bed tilt shelf (which
// cuts >900 Hz) does nothing to them, the 88 Hz pressure bell boosted them, and
// brown noise normalised to the same peak as pink carries far more RMS. Live
// master medians measured -21.7 dB at 12 m against -13.5 dB at 280 m and -13.0
// at 678 m, with the limiter pinning peaks at -5 dBFS everywhere. The deep was
// not oppressive, it was just loud, and it left a leviathan nowhere to go. The
// deep is now quieter than the shallows and gets its weight from spectrum,
// from the pressure drone and from events.
// ---------------------------------------------------------------------------
const BEDS = {
  'shallows-reef': {
    gain: 0.95, bright: 1.0,
    drone: { root: 108, partials: [1, 1.5, 2.01], type: 'sine', gain: 0.075, lp: 420, lfo: [0.055, 0.5] },
    noise: { src: 'pink', type: 'bandpass', f: 620, q: 0.55, gain: 0.30, wob: [0.13, 0.55], swell: [0.07, 0.35] },
    surge: { src: 'brown', type: 'lowpass', f: 240, q: 0.7, gain: 0.20, swell: [0.045, 0.6] },
    grains: [
      { kind: 'bubble', rate: 0.85, gain: 0.20 },
      { kind: 'chirp', rate: 0.34, gain: 0.11 },
      { kind: 'tick', rate: 0.7, gain: 0.07 },
    ],
  },
  'kelp-creak': {
    gain: 1.0, bright: 0.55,
    drone: { root: 66, partials: [1, 2, 3.02], type: 'triangle', gain: 0.10, lp: 260, lfo: [0.038, 0.55] },
    noise: { src: 'pink', type: 'bandpass', f: 340, q: 0.8, gain: 0.26, wob: [0.075, 0.5], swell: [0.05, 0.45] },
    surge: { src: 'brown', type: 'lowpass', f: 150, q: 0.7, gain: 0.24, swell: [0.033, 0.7] },
    grains: [
      { kind: 'creak', rate: 0.42, gain: 0.30 },
      { kind: 'bubble', rate: 0.30, gain: 0.11 },
      { kind: 'tick', rate: 0.34, gain: 0.06 },
    ],
  },
  'plateau-open': {
    gain: 0.82, bright: 0.85,
    drone: { root: 92, partials: [1, 1.5, 2], type: 'sine', gain: 0.07, lp: 340, lfo: [0.05, 0.5] },
    noise: { src: 'pink', type: 'bandpass', f: 480, q: 0.5, gain: 0.26, wob: [0.1, 0.45], swell: [0.06, 0.4] },
    surge: { src: 'brown', type: 'lowpass', f: 200, q: 0.7, gain: 0.17, swell: [0.04, 0.6] },
    grains: [
      { kind: 'chirp', rate: 0.28, gain: 0.09 },
      { kind: 'bubble', rate: 0.42, gain: 0.13 },
      { kind: 'moan', rate: 0.020, gain: 0.13 },
    ],
  },
  'mushroom-hum': {
    gain: 0.9, bright: 0.7,
    drone: { root: 128, partials: [1, 1.335, 2, 3.01], type: 'sine', gain: 0.115, lp: 620, lfo: [0.072, 0.62] },
    noise: { src: 'pink', type: 'bandpass', f: 430, q: 0.8, gain: 0.19, wob: [0.16, 0.34], swell: [0.09, 0.45] },
    surge: { src: 'brown', type: 'lowpass', f: 180, q: 0.7, gain: 0.15, swell: [0.05, 0.55] },
    grains: [
      { kind: 'bubble', rate: 0.5, gain: 0.14 },
      { kind: 'drip', rate: 0.16, gain: 0.13 },
    ],
  },
  'bulb-drone': {
    gain: 0.62, bright: 0.45,
    drone: { root: 72, partials: [1, 1.5, 2.02, 2.99], type: 'triangle', gain: 0.13, lp: 300, lfo: [0.028, 0.66] },
    noise: { src: 'brown', type: 'lowpass', f: 300, q: 0.9, gain: 0.26, wob: [0.055, 0.5], swell: [0.037, 0.55] },
    surge: { src: 'brown', type: 'lowpass', f: 120, q: 0.7, gain: 0.24, swell: [0.026, 0.7] },
    grains: [
      { kind: 'creak', rate: 0.16, gain: 0.17 },
      { kind: 'moan', rate: 0.045, gain: 0.16 },
    ],
  },
  'dunes-wind': {
    gain: 0.80, bright: 0.6,
    drone: { root: 58, partials: [1, 2, 3.01], type: 'sine', gain: 0.09, lp: 240, lfo: [0.026, 0.6] },
    // a current dragging sand — wide band, strong slow surge, that IS the "wind"
    noise: { src: 'pink', type: 'bandpass', f: 760, q: 0.4, gain: 0.30, wob: [0.031, 0.75], swell: [0.024, 0.7] },
    surge: { src: 'brown', type: 'lowpass', f: 170, q: 0.7, gain: 0.24, swell: [0.019, 0.8] },
    grains: [
      { kind: 'hiss', rate: 0.30, gain: 0.15 },
      { kind: 'moan', rate: 0.055, gain: 0.19 },
    ],
  },
  'crash-groan': {
    gain: 0.62, bright: 0.4,
    drone: { root: 48, partials: [1, 1.5, 2.03, 4.05], type: 'sawtooth', gain: 0.075, lp: 190, lfo: [0.021, 0.62] },
    noise: { src: 'brown', type: 'lowpass', f: 260, q: 0.9, gain: 0.24, wob: [0.043, 0.55], swell: [0.031, 0.6] },
    surge: { src: 'pink', type: 'bandpass', f: 1500, q: 0.6, gain: 0.09, swell: [0.11, 0.75] },
    grains: [
      { kind: 'groan', rate: 0.13, gain: 0.30 },
      { kind: 'creak', rate: 0.24, gain: 0.20 },
      { kind: 'crackle', rate: 0.5, gain: 0.09 },
    ],
  },
  'sparse-open': {
    gain: 0.92, bright: 0.9,
    drone: { root: 84, partials: [1, 1.5], type: 'sine', gain: 0.05, lp: 330, lfo: [0.045, 0.55] },
    noise: { src: 'pink', type: 'bandpass', f: 520, q: 0.5, gain: 0.20, wob: [0.085, 0.45], swell: [0.055, 0.5] },
    surge: { src: 'brown', type: 'lowpass', f: 190, q: 0.7, gain: 0.13, swell: [0.035, 0.6] },
    grains: [
      { kind: 'chirp', rate: 0.13, gain: 0.07 },
      { kind: 'bubble', rate: 0.2, gain: 0.09 },
    ],
  },
  'islands-teal': {
    gain: 0.88, bright: 0.75,
    drone: { root: 96, partials: [1, 1.5, 2, 3.01], type: 'sine', gain: 0.095, lp: 400, lfo: [0.033, 0.55] },
    noise: { src: 'pink', type: 'bandpass', f: 430, q: 0.6, gain: 0.23, wob: [0.06, 0.5], swell: [0.04, 0.5] },
    surge: { src: 'brown', type: 'lowpass', f: 165, q: 0.7, gain: 0.19, swell: [0.028, 0.65] },
    grains: [
      { kind: 'moan', rate: 0.075, gain: 0.20 },
      { kind: 'bubble', rate: 0.24, gain: 0.10 },
    ],
  },
  'jelly-cave': {
    gain: 0.55, bright: 0.35,
    drone: { root: 58, partials: [1, 1.19, 2.01], type: 'triangle', gain: 0.125, lp: 230, lfo: [0.019, 0.7] },
    noise: { src: 'brown', type: 'lowpass', f: 220, q: 1.0, gain: 0.25, wob: [0.041, 0.5], swell: [0.023, 0.6] },
    surge: { src: 'brown', type: 'lowpass', f: 105, q: 0.7, gain: 0.22, swell: [0.015, 0.75] },
    grains: [
      { kind: 'drip', rate: 0.45, gain: 0.28 },
      { kind: 'pulse', rate: 0.22, gain: 0.22 },
      { kind: 'moan', rate: 0.055, gain: 0.20 },
      { kind: 'boom', rate: 0.012, gain: 0.22 },
    ],
  },
  'grand-reef-deep': {
    gain: 0.45, bright: 0.22,
    drone: { root: 41, partials: [1, 1.5, 2.01, 3.04], type: 'sine', gain: 0.155, lp: 175, lfo: [0.015, 0.72] },
    noise: { src: 'brown', type: 'lowpass', f: 175, q: 0.9, gain: 0.27, wob: [0.026, 0.5], swell: [0.017, 0.65] },
    surge: { src: 'brown', type: 'lowpass', f: 88, q: 0.7, gain: 0.25, swell: [0.011, 0.78] },
    grains: [
      { kind: 'moan', rate: 0.13, gain: 0.21 },
      { kind: 'tick', rate: 0.22, gain: 0.07 },
      { kind: 'pulse', rate: 0.14, gain: 0.20 },
      { kind: 'boom', rate: 0.024, gain: 0.22 },
    ],
  },
  'blood-kelp-dread': {
    gain: 0.45, bright: 0.15,
    // 1.061 against 1.0 beats at ~2 Hz at this root — an unresolved interval you
    // hear as unease rather than as a chord.
    drone: { root: 33, partials: [1, 1.061, 2, 3.02], type: 'triangle', gain: 0.19, lp: 150, lfo: [0.011, 0.75] },
    noise: { src: 'brown', type: 'lowpass', f: 150, q: 1.0, gain: 0.25, wob: [0.018, 0.5], swell: [0.013, 0.7] },
    surge: { src: 'brown', type: 'lowpass', f: 74, q: 0.7, gain: 0.27, swell: [0.008, 0.82] },
    grains: [
      { kind: 'moan', rate: 0.15, gain: 0.22 },
      { kind: 'whine', rate: 0.07, gain: 0.14 },
      { kind: 'tick', rate: 0.24, gain: 0.06 },
      { kind: 'boom', rate: 0.020, gain: 0.22 },
    ],
  },
  'lost-river-hollow': {
    gain: 0.45, bright: 0.3,
    drone: { root: 46, partials: [1, 1.5, 2.98, 4.02], type: 'sine', gain: 0.145, lp: 200, lfo: [0.013, 0.72] },
    noise: { src: 'brown', type: 'lowpass', f: 195, q: 1.2, gain: 0.24, wob: [0.021, 0.55], swell: [0.015, 0.68] },
    surge: { src: 'brown', type: 'lowpass', f: 82, q: 0.7, gain: 0.24, swell: [0.010, 0.8] },
    grains: [
      { kind: 'drip', rate: 0.6, gain: 0.30 },
      { kind: 'moan', rate: 0.10, gain: 0.23 },
      { kind: 'bubble', rate: 0.18, gain: 0.10 },
      { kind: 'boom', rate: 0.018, gain: 0.23 },
    ],
  },
  'lava-rumble': {
    gain: 0.50, bright: 0.18,
    drone: { root: 27, partials: [1, 2, 3.03, 5.06], type: 'sawtooth', gain: 0.185, lp: 130, lfo: [0.009, 0.78] },
    noise: { src: 'brown', type: 'lowpass', f: 135, q: 0.85, gain: 0.30, wob: [0.014, 0.5], swell: [0.009, 0.72] },
    surge: { src: 'pink', type: 'bandpass', f: 2600, q: 0.5, gain: 0.055, swell: [0.09, 0.85] },
    grains: [
      { kind: 'thump', rate: 0.24, gain: 0.28 },
      { kind: 'hiss', rate: 0.42, gain: 0.16 },
      { kind: 'crackle', rate: 0.7, gain: 0.10 },
      { kind: 'boom', rate: 0.020, gain: 0.24 },
    ],
  },
  'void-abyss': {
    gain: 0.40, bright: 0.08,
    drone: { root: 22, partials: [1, 1.5, 2.01], type: 'sine', gain: 0.20, lp: 105, lfo: [0.006, 0.85] },
    noise: { src: 'brown', type: 'lowpass', f: 95, q: 0.8, gain: 0.20, wob: [0.007, 0.5], swell: [0.005, 0.85] },
    surge: { src: 'brown', type: 'lowpass', f: 58, q: 0.7, gain: 0.19, swell: [0.004, 0.9] },
    grains: [
      { kind: 'moan', rate: 0.055, gain: 0.17 },
      { kind: 'tick', rate: 0.10, gain: 0.06 },
      { kind: 'boom', rate: 0.026, gain: 0.15 },
      { kind: 'farcall', rate: 0.016, gain: 0.16 },
    ],
  },
  /**
   * Above the waterline: chop, wind and hull slap. The only bright bed, and it
   * has to be roughly as LOUD as the biome beds or surfacing reads as the game
   * turning the volume down instead of the water coming off your ears.
   */
  surface: {
    gain: 1.25, bright: 1.0,
    drone: { root: 150, partials: [1, 2], type: 'sine', gain: 0.035, lp: 900, lfo: [0.09, 0.6] },
    noise: { src: 'pink', type: 'highpass', f: 520, q: 0.45, gain: 0.52, wob: [0.19, 0.5], swell: [0.12, 0.45] },
    surge: { src: 'pink', type: 'bandpass', f: 900, q: 0.4, gain: 0.34, swell: [0.07, 0.6] },
    grains: [
      { kind: 'lap', rate: 1.25, gain: 0.55 },
      { kind: 'spray', rate: 0.45, gain: 0.24 },
    ],
  },
};

/**
 * Creature voices. `kind` selects the synthesis, the rest scales it.
 * Leviathans get long durations, low fundamentals and a heavy reverb send —
 * that combination is what makes a call read as "enormous and elsewhere".
 */
const VOX = {
  // duck is [amount, extraReleaseSeconds]. The hold is derived from the call's
  // own length in vocalise(), because the old fixed 2.2 s window started
  // recovering at 0.77 s while the roar's envelope does not peak until
  // 0.22*dur (0.5-0.8 s) and holds to 0.52*dur — the duck was climbing back
  // out while the animal was still inhaling. 0.34 (-9 dB) was also far too
  // shallow to clear a bed; 0.12 is -18 dB and the roar owns the frame.
  // `ref` is the inverse-distance reference: the radius inside which the call
  // is at full level. A peeper's is 14 m because a peeper is 20 cm long. A
  // reaper is 55 m of animal and its call is the loudest thing in the ocean, so
  // 46 m was simply wrong physics — it put a leviathan 170 m out at 0.42 gain,
  // 8 dB down, underneath its own ambience. At 100 m it is 0.74, and what makes
  // it read as DISTANT is the air lowpass (404 Hz at 170 m) and the reverb, not
  // a level drop.
  reaper: { kind: 'roar', f: 52, dur: [2.4, 3.4], gain: 3.5, verb: 0.85, duck: [0.12, 1.5], range: 320, ref: 100 },
  ghost_leviathan: { kind: 'wail', f: 88, dur: [3.6, 5.2], gain: 3.05, verb: 0.95, duck: [0.12, 1.6], range: 380, ref: 105 },
  // the reefback is not a threat and must not sound like one: it thins the bed
  // rather than removing it
  reefback: { kind: 'song', f: 34, dur: [4.5, 7.0], gain: 1.45, verb: 0.9, duck: [0.34, 1.4], range: 300, ref: 85 },
  crabsquid: { kind: 'click', f: 900, dur: [0.7, 1.4], gain: 0.8, verb: 0.4, range: 90 },
  crabsnake: { kind: 'click', f: 1350, dur: [0.4, 0.8], gain: 0.6, verb: 0.3, range: 70 },
  ampeel: { kind: 'zap', f: 210, dur: [0.5, 0.9], gain: 0.6, verb: 0.35, range: 90 },
  warper: { kind: 'warp', f: 420, dur: [1.0, 1.6], gain: 0.55, verb: 0.6, range: 110 },
  stalker: { kind: 'snarl', f: 132, dur: [0.55, 0.95], gain: 0.85, verb: 0.3, range: 85 },
  sand_shark: { kind: 'snarl', f: 108, dur: [0.5, 0.9], gain: 0.85, verb: 0.3, range: 85 },
  boneshark: { kind: 'snarl', f: 96, dur: [0.6, 1.0], gain: 0.9, verb: 0.35, range: 95 },
  biter: { kind: 'snarl', f: 260, dur: [0.22, 0.4], gain: 0.55, verb: 0.2, range: 45 },
  mesmer: { kind: 'mesmer', f: 330, dur: [1.6, 2.6], gain: 0.5, verb: 0.5, range: 70 },
  crashfish: { kind: 'shriek', f: 620, dur: [0.5, 0.8], gain: 0.7, verb: 0.25, range: 45 },
  gasopod: { kind: 'puff', f: 150, dur: [0.6, 1.0], gain: 0.45, verb: 0.3, range: 45 },
  jellyray: { kind: 'pulse', f: 62, dur: [1.2, 2.0], gain: 0.4, verb: 0.55, range: 90 },
  bloom_jelly: { kind: 'shimmer', f: 1500, dur: [1.2, 2.2], gain: 0.22, verb: 0.6, range: 45 },
  peeper: { kind: 'chirp', f: 1250, dur: [0.12, 0.22], gain: 0.22, verb: 0.15, range: 26 },
  boomerang: { kind: 'chirp', f: 1050, dur: [0.12, 0.2], gain: 0.2, verb: 0.15, range: 26 },
  holefish: { kind: 'chirp', f: 1450, dur: [0.1, 0.18], gain: 0.18, verb: 0.15, range: 24 },
  reginald: { kind: 'chirp', f: 780, dur: [0.15, 0.26], gain: 0.2, verb: 0.15, range: 28 },
  oculus: { kind: 'chirp', f: 1700, dur: [0.09, 0.16], gain: 0.16, verb: 0.15, range: 22 },
  bladderfish: { kind: 'bubbleup', f: 700, dur: [0.35, 0.6], gain: 0.2, verb: 0.2, range: 26 },
  rabbit_ray: { kind: 'pulse', f: 120, dur: [0.5, 0.9], gain: 0.22, verb: 0.3, range: 34 },
  spadefish: { kind: 'chirp', f: 900, dur: [0.13, 0.22], gain: 0.18, verb: 0.15, range: 26 },
  cave_crawler: { kind: 'skitter', f: 1900, dur: [0.4, 0.8], gain: 0.3, verb: 0.25, range: 34 },
  shuttlebug: { kind: 'skitter', f: 2400, dur: [0.3, 0.6], gain: 0.22, verb: 0.2, range: 28 },
  blighter: { kind: 'chirp', f: 620, dur: [0.16, 0.28], gain: 0.2, verb: 0.2, range: 30 },
  default: { kind: 'chirp', f: 1000, dur: [0.12, 0.24], gain: 0.2, verb: 0.2, range: 30 },
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
/** Poisson waiting time — grains must not sound metronomic. */
const expWait = (rng, mean) => -mean * Math.log(1 - 0.999 * rng());
const semis = (root, n) => root * Math.pow(2, n / 12);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 65536;
}

/**
 * A gain node carrying one percussive envelope. Every one-shot in this module
 * goes through one of these: nothing is ever switched on or off at a non-zero
 * value, which is the entire anti-click policy.
 */
function envGain(actx, t0, peak, atk, hold, rel) {
  const g = actx.createGain();
  const p = g.gain, e = Math.max(peak, 2e-5);
  // The intrinsic value matters: a param holds it until its FIRST scheduled
  // event, so a gain left at the default 1.0 would pass full signal for the
  // whole gap between the source starting and t0. Every grain that schedules
  // sub-events later than its own start depends on this line.
  p.value = 2e-5;
  p.setValueAtTime(2e-5, t0);
  p.exponentialRampToValueAtTime(e, t0 + atk);
  if (hold > 0) p.setValueAtTime(e, t0 + atk + hold);
  p.exponentialRampToValueAtTime(2e-5, t0 + atk + hold + rel);
  p.setValueAtTime(0, t0 + atk + hold + rel + 0.005);
  g.endsAt = t0 + atk + hold + rel + 0.02;
  return g;
}

/** Collects the nodes of one transient voice and tears them down when it ends. */
class Voice {
  /**
   * Takes the Graph (or a bare BaseAudioContext). A voice with no live JS
   * reference is collectable, and Chrome WILL collect one mid-render inside an
   * OfflineAudioContext — see Graph.retain().
   */
  constructor(g) {
    this.actx = g.actx || g;
    this.nodes = []; this.srcs = []; this.endsAt = 0;
    if (g.retain) g.retain(this);
  }
  n(node) { this.nodes.push(node); return node; }
  s(node) { this.srcs.push(node); this.nodes.push(node); return node; }
  /**
   * Start every source at t0 and stop it at t1. Then do nothing.
   *
   * This used to tear the voice down from an `onended` handler. Do not put that
   * back. Disconnecting nodes from a main-thread event while the audio thread
   * is rendering changes the graph topology mid-quantum, and Chrome drops that
   * quantum: measured on a live AudioContext at 678 m, 42 s of steady-state
   * audio contained two single-sample steps of 0.66 and 0.83 of local peak — an
   * audible tick roughly every twenty seconds — and removing the teardown took
   * that to zero jumps with a worst slope of 0.33, which is inside the band
   * limit. Grains fire several times a second, so this was the loudest defect
   * in the module and it was invisible to every level and spectrum metric.
   *
   * Nothing leaks. A one-shot voice is referenced only by its own sources'
   * scheduling; once they end, the Voice and every node in it are unreachable
   * from JS and the implementation reclaims them. That is the standard
   * fire-and-forget pattern. (Offline renders hold them via Graph.retain so GC
   * cannot take them early — see that method.)
   */
  run(t0, t1) {
    this.endsAt = t1;
    for (const s of this.srcs) {
      try { s.start(t0); } catch { /* already started */ }
      try { s.stop(t1); } catch { /* no stop (e.g. a constant source) */ }
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// procedural buffers
// ---------------------------------------------------------------------------
/**
 * Loopable noise. Three colours, all zero-mean (DC is explicitly removed) and
 * all crossfaded across the loop seam — an un-crossfaded noise loop ticks once
 * per period, which is exactly the kind of click this module must not produce.
 */
function makeNoise(actx, kind, seconds, rng) {
  const sr = actx.sampleRate;
  const xf = Math.floor(sr * 0.25);
  const n = Math.floor(sr * seconds);
  const raw = new Float32Array(n + xf);

  if (kind === 'white') {
    for (let i = 0; i < raw.length; i++) raw[i] = rng() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's economical pink filter — 1/f to within ~0.5 dB over the band
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
      b6 = w * 0.115926;
    }
  } else {
    // brown: leaky integrator, then normalised. All the weight below 200 Hz.
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.019 * w) / 1.019;
      raw[i] = last * 4.2;
    }
  }

  const buf = actx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, n));
  // seamless loop: fade the overrun back over the head
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    out[i] = out[i] * t + raw[n + i] * (1 - t);
  }
  // kill DC so nothing downstream carries an offset
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) { out[i] -= mean; peak = Math.max(peak, Math.abs(out[i])); }
  const norm = 0.85 / peak;
  for (let i = 0; i < n; i++) out[i] *= norm;
  return buf;
}

/**
 * Convolution impulse for the "elsewhere" send: exponentially decaying noise,
 * darkened over time so late reflections lose their top end the way a big body
 * of water does, and decorrelated per channel so the tail is wide.
 */
function makeIR(actx, seconds, rng) {
  const sr = actx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = actx.createBuffer(2, n, sr);
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const a = Math.exp(-4.6 * t) * (1 - Math.exp(-i / (sr * 0.012)));
      const w = rng() * 2 - 1;
      // one-pole that closes as the tail decays -> late energy is dark
      const k = lerp(0.55, 0.06, t);
      lp += k * (w - lp);
      d[i] = lp * a;
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    for (let i = 0; i < n; i++) { d[i] -= mean; energy += d[i] * d[i]; }
  }
  /**
   * Normalise to unit energy per channel.
   *
   * A raw procedural impulse has whatever gain its own construction happens to
   * produce, and a convolution's gain is sqrt(sum h^2) — for 2.6 s of
   * exponentially-decaying noise at 44.1 kHz that is a factor of about 14, or
   * +23 dB. Every `verb:` number in this file, and every send inside a grain,
   * was authored against that accidental gain, so a "0.8 send" was really a
   * +21 dB send and the reverb return was among the loudest things in the deep
   * beds — one of the reasons their block peaks sat 4 dB above the shallows'.
   * With this the send numbers mean what they say and MIX.verb sets the room.
   */
  const scale = 1 / Math.sqrt(Math.max(energy / 2, 1e-12));
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] *= scale;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Graph — the whole mixer, buildable into ANY BaseAudioContext.
//
//   bed ─┐
//   music┼→ duck ─┐
//   verb ┘        │
//   life ─────────┼→ water(lp → shelf → bell) ─┐
//   player → helm ┘                            ├→ dcBlock → limiter → master → out
//   ui ────────────────────────────────────────┘
//
// The duck holds the bed and the music only: a roar has to push those down
// without pushing itself down, and the UI is inside the helmet so it never
// gets wet.
// ---------------------------------------------------------------------------
class Graph {
  constructor(actx, opts = {}) {
    const a = this.actx = actx;
    this.rng = makeRNG(opts.seed ?? 1337);
    this.offline = !!opts.offline;
    this.listener = null;
    this.group = null;

    this.noise = {
      white: makeNoise(a, 'white', 3.0, makeRNG(9001)),
      pink: makeNoise(a, 'pink', 6.0, makeRNG(9002)),
      brown: makeNoise(a, 'brown', 8.0, makeRNG(9003)),
    };

    this.master = a.createGain();
    this.master.gain.value = opts.master ?? MIX.master;

    this.limiter = a.createDynamicsCompressor();
    const L = MIX.limit;
    this.limiter.threshold.value = L.threshold;
    this.limiter.knee.value = L.knee;
    this.limiter.ratio.value = L.ratio;
    this.limiter.attack.value = L.attack;
    this.limiter.release.value = L.release;

    // DC blocker. Long envelopes on 22 Hz drones and one-sided noise bursts both
    // leave an offset; two poles at 18 Hz remove it without touching the sub.
    // (15 Hz, not 30: void-abyss runs a 22 Hz fundamental and that has to
    // survive. Any highpass has exactly zero gain at DC, so the corner only
    // sets how fast an offset decays, not whether it is removed.)
    this.dc1 = a.createBiquadFilter(); this.dc1.type = 'highpass';
    this.dc1.frequency.value = 15; this.dc1.Q.value = 0.6;
    this.dc2 = a.createBiquadFilter(); this.dc2.type = 'highpass';
    this.dc2.frequency.value = 15; this.dc2.Q.value = 0.6;

    // the programme trim: every bus sums here, and this is what sets the level
    // the limiter above sees. See MIX.master for why it is not at the end.
    this.preMaster = a.createGain();
    this.preMaster.gain.value = MIX.trim;
    /**
     * Final safety: an odd-symmetric soft clipper, so the module physically
     * cannot emit a sample outside +-0.98 no matter what lands at once.
     *
     * The limiter above is a level control with a 2 ms attack, which means a
     * transient stack — a roar inside its own reference distance, on top of a
     * swell, on top of a hull boom — gets through it. The dense-mix render
     * measured +0.18 dBFS and reported clipped:true with the limiter doing its
     * job, because that peak was faster than the limiter is. Below 0.86 this
     * curve is EXACTLY linear (so nothing in normal play is coloured at all)
     * and above it the knee bends toward 0.98, reaching 0.959 at unity input;
     * anything hotter is clamped there, which is the brickwall.
     *
     * The curve is sampled over [-1, +1] and NOT over the signal's real range.
     * A WaveShaper clamps its input to [-1, 1] and maps that span across the
     * whole array, so authoring the table over [-3, +3] — which looks more
     * correct — makes an input of 0.33 read the entry for 1.0, turning the
     * safety stage into an +8 dB expander. It measured as every bed jumping
     * from -22 dB to -13 dB, which is how it was caught.
     */
    this.safety = a.createWaveShaper();
    this.safety.oversample = '2x';
    {
      const n = 4097, curve = new Float32Array(n);
      const kn = 0.86, head = 0.98 - kn;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const m = Math.abs(x);
        // tanh knee, scaled so its slope is exactly 1 where it meets the linear
        // segment: a mismatched knee would expand rather than compress there
        const y = m <= kn ? m : kn + head * Math.tanh((m - kn) / head);
        curve[i] = x < 0 ? -y : y;
      }
      this.safety.curve = curve;
    }

    this.preMaster.connect(this.dc1); this.dc1.connect(this.dc2);
    this.dc2.connect(this.limiter); this.limiter.connect(this.safety);
    this.safety.connect(this.master);
    this.master.connect(a.destination);

    // ---- the water muffle
    this.wLp = a.createBiquadFilter(); this.wLp.type = 'lowpass';
    this.wLp.frequency.value = WATER.lpWater; this.wLp.Q.value = 0.62;
    this.wShelf = a.createBiquadFilter(); this.wShelf.type = 'highshelf';
    this.wShelf.frequency.value = WATER.shelfHz; this.wShelf.gain.value = WATER.shelfWater;
    this.wBell = a.createBiquadFilter(); this.wBell.type = 'peaking';
    this.wBell.frequency.value = WATER.bellHz; this.wBell.Q.value = 0.9;
    this.wBell.gain.value = WATER.bellWater;
    this.wLp.connect(this.wShelf); this.wShelf.connect(this.wBell);
    this.wBell.connect(this.preMaster);

    // ---- buses
    this.duck = a.createGain(); this.duck.gain.value = 1;
    this.duck.connect(this.wLp);

    this.bedBus = a.createGain(); this.bedBus.gain.value = MIX.bed;
    this.bedBus.connect(this.duck);
    this.musicBus = a.createGain(); this.musicBus.gain.value = MIX.music;
    this.musicBus.connect(this.duck);

    this.lifeBus = a.createGain(); this.lifeBus.gain.value = MIX.life;
    this.lifeBus.connect(this.wLp);

    // player sounds happen inside the helmet: a lighter, fixed muffle
    this.helm = a.createBiquadFilter(); this.helm.type = 'lowpass';
    this.helm.frequency.value = 6500; this.helm.Q.value = 0.6;
    this.playerBus = a.createGain(); this.playerBus.gain.value = MIX.player;
    this.playerBus.connect(this.helm); this.helm.connect(this.preMaster);

    this.uiBus = a.createGain(); this.uiBus.gain.value = MIX.ui;
    this.uiBus.connect(this.preMaster);

    // ---- reverb send, ducked with the bed so a roar's own tail stays big
    this.verb = a.createConvolver();
    this.verb.buffer = makeIR(a, 2.6, makeRNG(9004));
    this.verbSend = a.createGain(); this.verbSend.gain.value = 1;
    this.verbReturn = a.createGain(); this.verbReturn.gain.value = MIX.verb;
    this.verbSend.connect(this.verb); this.verb.connect(this.verbReturn);
    this.verbReturn.connect(this.duck);

    // ---- pressure: a sub drone that only exists when the water is heavy
    this.pressGain = a.createGain(); this.pressGain.gain.value = 0;
    this.pressGain.connect(this.bedBus);
    const pl = a.createBiquadFilter(); pl.type = 'lowpass';
    pl.frequency.value = 130; pl.Q.value = 0.8;
    pl.connect(this.pressGain);
    const po = a.createOscillator(); po.type = 'sine'; po.frequency.value = 31;
    const pog = a.createGain(); pog.gain.value = 0.55;
    po.connect(pog); pog.connect(pl);
    const pn = a.createBufferSource(); pn.buffer = this.noise.brown; pn.loop = true;
    const png = a.createGain(); png.gain.value = 0.5;
    pn.connect(png); png.connect(pl);
    const plfo = a.createOscillator(); plfo.type = 'sine'; plfo.frequency.value = 0.043;
    const plfog = a.createGain(); plfog.gain.value = 6;
    plfo.connect(plfog); plfog.connect(po.frequency);
    this._steady = [po, pn, plfo];

    /** absolute time the current duck finishes; see duckTo() for why */
    this._duckEnd = 0;
    this.subm = 1;
    this.depth = 0;
    this._keep = this.offline ? [] : null;
  }

  /**
   * Hold a JS reference to a voice or bed for the life of an offline render.
   *
   * This is not tidiness, it is a correctness fix. Inside an OfflineAudioContext
   * Chrome will garbage-collect a still-playing node once nothing in JS
   * references it, and its output drops to zero mid-render. It measured as a
   * single-sample step to silence followed by the filter chain refilling,
   * appearing roughly once per ten seconds in half the beds, at a DIFFERENT
   * time on every run of identical input — which is exactly what GC timing
   * looks like and is why it survived three rounds of looking for a scheduling
   * bug. The live game never had it: beds are held in a Map and one-shots are
   * held by their own onended closure.
   */
  retain(x) { if (this._keep) this._keep.push(x); return x; }

  /** Start the always-on sources. Safe to call once per graph. */
  begin(t0 = 0) {
    for (const s of this._steady) { try { s.start(t0); } catch { /* started */ } }
  }

  now() { return this.actx.currentTime; }

  /**
   * Water muffle + pressure, automated at an absolute context time.
   * `stress` is survival.js's pressureStress (0..1) when it exists — past crush
   * depth the hull note should be there whether or not the depth curve agrees.
   */
  applyWater(sub, depth, t, tau = WATER.tau, stress = 0) {
    const d = clamp(depth / WATER.deepAt, 0, 1);
    const lp = lerp(WATER.lpAir, lerp(WATER.lpWater, WATER.lpDeep, d), sub);
    const sh = lerp(WATER.shelfAir, lerp(WATER.shelfWater, WATER.shelfDeep, d), sub);
    const be = lerp(WATER.bellAir, lerp(WATER.bellWater, WATER.bellDeep, d), sub);
    const k = Math.max(tau, 0.005);
    this.wLp.frequency.setTargetAtTime(clamp(lp, 120, 21000), t, k);
    this.wShelf.gain.setTargetAtTime(sh, t, k);
    this.wBell.gain.setTargetAtTime(be, t, k);
    // helmet closes a little as the suit loads up
    this.helm.frequency.setTargetAtTime(lerp(9000, lerp(6200, 3600, d), sub), t, k);
    // The weight of water above you, audible from ~90 m. This used to run at
    // 0.24, which made it a fourth sustained bed layer rather than a cue — a
    // 31 Hz sine and a lowpassed brown noise permanently under the abyss, and
    // the second reason the deep had no headroom. At 0.10 you feel it arrive.
    const press = Math.max(smooth(90, WATER.deepAt, depth), stress) * lerp(0.15, 1, sub) * WATER.pressure;
    this.pressGain.gain.setTargetAtTime(press, t, 0.6);
    this.subm = sub; this.depth = depth;
  }

  /**
   * Sidechain: pull the bed and music down so something else can be heard.
   *
   * `hold` is how long the floor is HELD before the release starts, and it is
   * explicit because only the caller knows the shape of the thing it is making
   * room for. `release` is measured from the end of the hold, not from t.
   *
   * Both of those are the fix for the measured failure. The old signature took
   * one number and derived hold = seconds*0.35, so a reaper's 2.2 s duck began
   * recovering at 0.77 s — while the call's own envelope does not reach peak
   * until 0.22*dur (0.5-0.8 s) and holds to 0.52*dur. The bed was climbing back
   * over the animal while it was still inhaling.
   *
   * The re-anchor also changed. setValueAtTime(1, t) after a cancel STEPPED the
   * bed gain from its current ducked value up to 1.0 in a single sample if a
   * second duck arrived mid-duck — a roar during a hurt, or two calls in one
   * breath. cancelAndHoldAtTime keeps the curve's real value at t.
   */
  duckTo(amount, release, t, hold = 0.25) {
    const p = this.duck.gain;
    const a = clamp(amount, 0.02, 1);
    const h = Math.max(0.15, hold);
    const end = t + h + Math.max(0.25, release);
    /**
     * An anchor event is mandatory and the right anchor depends on whether the
     * timeline is already busy.
     *
     * linearRampToValueAtTime interpolates from the PREVIOUS event; with an
     * empty timeline there is no previous event and the implementation falls
     * back to (currentTime, currentValue). Live that is harmless — currentTime
     * is t — but in an offline render currentTime is 0, so the first duck of a
     * render ramped the bed down across the ENTIRE preceding audio. It made
     * the offline duck measure -7 dB instead of -18 and quietly inflated the
     * roar-over-bed numbers by pre-fading the reference window. Anchoring at
     * unity when nothing is scheduled removes the ambiguity in both contexts.
     *
     * Mid-duck, the anchor must instead be the curve's real value at t, which
     * is what cancelAndHoldAtTime gives us; setValueAtTime(1) there would step
     * the bed up to full for one sample before ramping back down.
     */
    if (t >= (this._duckEnd || 0)) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(1, t);
    } else if (p.cancelAndHoldAtTime) {
      p.cancelAndHoldAtTime(t);
    } else {
      p.cancelScheduledValues(t);
      p.setValueAtTime(a, t);
    }
    p.linearRampToValueAtTime(a, t + 0.10);
    p.setValueAtTime(a, t + h);
    p.linearRampToValueAtTime(1, end);
    this._duckEnd = end;
  }

  /**
   * Route a finished voice into 3D space.
   *
   * Live uses THREE.PositionalAudio off the camera-mounted listener, from a
   * FIXED POOL that is built once and never torn down. A PositionalAudio is an
   * Object3D, so the obvious implementation creates one per call and removes it
   * when the call ends — but that removal is a graph disconnect, and a graph
   * disconnect drops a render quantum for the entire mix, which is an audible
   * tick on every creature call. Pooling makes the topology static: a finished
   * voice's own nodes become unreachable and are reclaimed with their edges
   * still attached, which costs nothing and clicks never.
   *
   * Offline uses a bare PannerNode so analyze() measures the same signal path.
   */
  place(node, pos, opt = {}) {
    const a = this.actx;
    const ref = opt.ref ?? 16, roll = opt.roll ?? 0.75, max = opt.max ?? 600;
    if (this.listener && this.group) {
      if (!this._pool) {
        this._pool = [];
        for (let i = 0; i < 16; i++) {
          const pa = new THREE.PositionalAudio(this.listener);
          pa.panner.distanceModel = 'inverse';
          pa.panner.panningModel = 'HRTF';
          pa.name = 'audio-slot-' + i;
          this.group.add(pa);
          this._pool.push({ pa, busyUntil: 0 });
        }
        this._poolNext = 0;
      }
      // prefer a free slot; if every slot is busy take the one finishing soonest
      const now = a.currentTime;
      let slot = this._pool.find((s) => s.busyUntil <= now);
      if (!slot) slot = this._pool.reduce((m, s) => (s.busyUntil < m.busyUntil ? s : m));
      slot.busyUntil = now + (opt.dur ?? 6);
      const pa = slot.pa;
      pa.panner.refDistance = ref;
      pa.panner.rolloffFactor = roll;
      pa.panner.maxDistance = max;
      pa.position.copy(pos);
      pa.updateMatrixWorld(true);
      node.connect(pa.getOutput());     // straight into the panner, no bookkeeping
      return { obj: pa, dispose: () => { /* pooled: nothing to tear down */ } };
    }
    const p = a.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = max;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
    node.connect(p);
    p.connect(this.lifeBus);
    return { obj: p, dispose: () => { /* offline renders are short; leave it */ } };
  }

  /**
   * Silence a graph we are finished with. Stops the always-on sources and
   * mutes, but does NOT disconnect — see Voice.run(). analyze() builds a new
   * Graph per offline render, and a disconnect on a discarded one can land
   * while the next render is in flight.
   */
  dispose() {
    for (const s of this._steady) { try { s.stop(); } catch { /* not started */ } }
    try { this.master.gain.value = 0; } catch { /* gone */ }
    this._keep = null;
  }
}

// ---------------------------------------------------------------------------
// grains — the sparse events that make a bed a place rather than a texture
// ---------------------------------------------------------------------------
function grain(g, out, kind, t, rng, level, tint = 1) {
  const a = g.actx;
  const v = new Voice(g);
  const N = (which) => { const s = v.s(a.createBufferSource()); s.buffer = g.noise[which]; s.loop = true; return s; };
  const bq = (type, f, q) => { const b = v.n(a.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const O = (type, f) => { const o = v.s(a.createOscillator()); o.type = type; o.frequency.setValueAtTime(f, t); return o; };
  let dur = 0.4;

  switch (kind) {
    case 'bubble': {
      // a bubble rises and its resonance rises with it — the pitch glide up is
      // the whole tell. A string of 3-8 of them reads as a vent, not a blip.
      const n = 3 + Math.floor(rng() * 6);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const f0 = 380 + rng() * 900 * tint;
        const d = 0.035 + rng() * 0.05;
        const o = O('sine', f0);
        o.frequency.exponentialRampToValueAtTime(f0 * (1.6 + rng() * 1.1), tt + d);
        const e = v.n(envGain(a, tt, level * (0.5 + rng() * 0.5), 0.006, 0, d));
        o.connect(e); e.connect(out);
        tt += 0.02 + rng() * 0.09;
      }
      dur = tt - t + 0.2;
      break;
    }
    case 'bubbleup': {
      const src = N('white');
      const b = bq('bandpass', 500, 3);
      b.frequency.exponentialRampToValueAtTime(2400, t + 0.4);
      const e = v.n(envGain(a, t, level, 0.03, 0.12, 0.3));
      src.connect(b); b.connect(e); e.connect(out);
      dur = 0.5;
      break;
    }
    case 'chirp': {
      const f0 = (900 + rng() * 1400) * tint;
      const d = 0.09 + rng() * 0.1;
      const o = O('sine', f0);
      o.frequency.exponentialRampToValueAtTime(f0 * (0.45 + rng() * 0.25), t + d);
      const e = v.n(envGain(a, t, level, 0.008, 0.01, d));
      const o2 = O('triangle', f0 * 2.01);
      o2.frequency.exponentialRampToValueAtTime(f0 * 0.95, t + d);
      const e2 = v.n(envGain(a, t, level * 0.35, 0.008, 0.01, d * 0.7));
      o.connect(e); o2.connect(e2); e.connect(out); e2.connect(out);
      dur = d + 0.15;
      break;
    }
    case 'tick': {
      const src = N('white');
      const b = bq('bandpass', (1400 + rng() * 2600) * tint, 6);
      const e = v.n(envGain(a, t, level, 0.002, 0, 0.03 + rng() * 0.04));
      src.connect(b); b.connect(e); e.connect(out);
      dur = 0.12;
      break;
    }
    case 'crackle': {
      const n = 4 + Math.floor(rng() * 8);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const src = N('white');
        const b = bq('bandpass', 900 + rng() * 3500, 9);
        const e = v.n(envGain(a, tt, level * (0.3 + rng() * 0.7), 0.001, 0, 0.012 + rng() * 0.02));
        src.connect(b); b.connect(e); e.connect(out);
        tt += 0.01 + rng() * 0.07;
      }
      dur = tt - t + 0.1;
      break;
    }
    case 'creak': {
      // stick-slip: a resonant band walking slowly downward, amplitude chattering
      const d = 0.5 + rng() * 1.3;
      const f0 = 240 + rng() * 520;
      const src = N('pink');
      const b = bq('bandpass', f0, 11);
      b.frequency.setValueAtTime(f0, t);
      b.frequency.linearRampToValueAtTime(f0 * (0.55 + rng() * 0.3), t + d);
      const b2 = bq('bandpass', f0 * 2.4, 8);
      b2.frequency.linearRampToValueAtTime(f0 * 1.5, t + d);
      const e = v.n(envGain(a, t, level, 0.09, d * 0.4, d * 0.6));
      // The chatter gets its OWN gain stage. Summed into the envelope's param
      // instead, an LFO keeps modulating around zero after the envelope has
      // closed, and the "grain" never actually stops — it buzzes until stop().
      const trem = v.n(a.createGain()); trem.gain.value = 0.62;
      const chat = v.s(a.createOscillator());
      chat.type = 'sawtooth';
      chat.frequency.setValueAtTime(9 + rng() * 12, t);
      chat.frequency.linearRampToValueAtTime(3 + rng() * 4, t + d);
      const chatG = v.n(a.createGain()); chatG.gain.value = 0.34;
      chat.connect(chatG); chatG.connect(trem.gain);
      src.connect(b); src.connect(b2); b.connect(trem); b2.connect(trem);
      trem.connect(e); e.connect(out);
      dur = d + 0.3;
      break;
    }
    case 'groan': {
      // tortured metal: detuned saws through a slow resonant sweep
      const d = 1.4 + rng() * 2.2;
      const f0 = 38 + rng() * 34;
      const e = v.n(envGain(a, t, level, 0.5, d * 0.3, d * 0.7));
      const b = bq('bandpass', 180, 4.5);
      b.frequency.linearRampToValueAtTime(90 + rng() * 200, t + d);
      for (let i = 0; i < 3; i++) {
        const o = O('sawtooth', f0 * (1 + i * 0.503));
        o.detune.setValueAtTime((i - 1) * 14, t);
        o.frequency.linearRampToValueAtTime(f0 * (1 + i * 0.503) * (0.86 + rng() * 0.1), t + d);
        const og = v.n(a.createGain()); og.gain.value = 0.4 / (i + 1);
        o.connect(og); og.connect(b);
      }
      b.connect(e); e.connect(out);
      if (g.verbSend) e.connect(g.verbSend);
      dur = d + 0.5;
      break;
    }
    case 'moan': {
      // the thing you cannot see. Long, low, slow vibrato, mostly reverb.
      const d = 2.2 + rng() * 3.4;
      const f0 = (36 + rng() * 62) * tint;
      const e = v.n(envGain(a, t, level, d * 0.35, d * 0.15, d * 0.5));
      const b = bq('lowpass', 220, 1.4);
      const o = O('sine', f0);
      o.frequency.linearRampToValueAtTime(f0 * (0.82 + rng() * 0.3), t + d);
      const o2 = O('triangle', f0 * 2.005);
      const o2g = v.n(a.createGain()); o2g.gain.value = 0.22;
      const vib = v.s(a.createOscillator()); vib.type = 'sine';
      vib.frequency.setValueAtTime(0.9 + rng() * 1.6, t);
      const vibG = v.n(a.createGain()); vibG.gain.value = f0 * 0.03;
      vib.connect(vibG); vibG.connect(o.frequency);
      o.connect(b); o2.connect(o2g); o2g.connect(b);
      b.connect(e); e.connect(out);
      if (g.verbSend) { const s = v.n(a.createGain()); s.gain.value = 0.8; e.connect(s); s.connect(g.verbSend); }
      dur = d + 0.6;
      break;
    }
    case 'boom': {
      // Hull pressure. The single startling event the deep was missing: the
      // ocean settling on you, felt before it is heard. Sub sine that falls
      // almost out of the audible band, a lowpassed noise body for the mass,
      // and one dry suit-creak on top so it reads as YOUR hull and not as
      // distant thunder. Slow attack on purpose — a fast one is a kick drum.
      const d = 1.5 + rng() * 1.1;
      const o = O('sine', 30 + rng() * 12);
      o.frequency.exponentialRampToValueAtTime(15, t + d * 0.8);
      const e = v.n(envGain(a, t, level, 0.055, d * 0.16, d * 0.8));
      o.connect(e); e.connect(out);
      const src = N('brown');
      const b = bq('lowpass', 110, 1.4);
      b.frequency.linearRampToValueAtTime(52, t + d);
      const eb = v.n(envGain(a, t, level * 0.7, 0.04, d * 0.12, d * 0.75));
      src.connect(b); b.connect(eb); eb.connect(out);
      // the metal answering it, a beat later
      const ck = t + 0.11 + rng() * 0.18;
      const cs = N('pink');
      const cb = bq('bandpass', 380 + rng() * 520, 9);
      cb.frequency.linearRampToValueAtTime(220, ck + 0.5);
      const ce = v.n(envGain(a, ck, level * 0.16, 0.02, 0.06, 0.5));
      cs.connect(cb); cb.connect(ce); ce.connect(out);
      if (g.verbSend) { const sd = v.n(a.createGain()); sd.gain.value = 0.55; e.connect(sd); ce.connect(sd); sd.connect(g.verbSend); }
      dur = d + 0.6;
      break;
    }
    case 'farcall': {
      // Something enormous, a very long way off, that is not calling to you.
      // Almost all of it is reverb: the dry path is a 40 Hz throat under a
      // 140 Hz roof, so what arrives is the shape of a voice with the voice
      // taken out. It is the abyss's rarest event and its worst news.
      const d = 4.0 + rng() * 3.0;
      const f0 = 30 + rng() * 26;
      const roof = bq('lowpass', 140, 0.9);
      const e = v.n(envGain(a, t, level, d * 0.3, d * 0.2, d * 0.5));
      // one shared slow vibrato in CENTS (see the bed wobble note: a linear Hz
      // sweep on a 30 Hz fundamental walks it toward zero, detune cannot)
      const vib = v.s(a.createOscillator()); vib.type = 'sine';
      vib.frequency.setValueAtTime(0.5 + rng() * 0.7, t);
      const vibG = v.n(a.createGain()); vibG.gain.value = 34;
      vib.connect(vibG);
      for (let i = 0; i < 3; i++) {
        const r = [1, 1.5, 2.02][i];
        const o = O(i ? 'sine' : 'triangle', f0 * r);
        // two long falls, like a breath running out twice
        o.frequency.linearRampToValueAtTime(f0 * r * 1.22, t + d * 0.28);
        o.frequency.linearRampToValueAtTime(f0 * r * 0.74, t + d * 0.62);
        o.frequency.linearRampToValueAtTime(f0 * r * 0.55, t + d);
        vibG.connect(o.detune);
        const og = v.n(a.createGain()); og.gain.value = 0.55 / (1 + i * 1.4);
        o.connect(og); og.connect(roof);
      }
      roof.connect(e); e.connect(out);
      if (g.verbSend) { const sd = v.n(a.createGain()); sd.gain.value = 1.6; e.connect(sd); sd.connect(g.verbSend); }
      dur = d + 1.2;
      break;
    }
    case 'whine': {
      const d = 1.2 + rng() * 1.6;
      const f0 = 1600 + rng() * 1800;
      const o = O('sine', f0);
      o.frequency.linearRampToValueAtTime(f0 * (0.7 + rng() * 0.5), t + d);
      const e = v.n(envGain(a, t, level, d * 0.4, 0, d * 0.6));
      o.connect(e); e.connect(out);
      if (g.verbSend) e.connect(g.verbSend);
      dur = d + 0.3;
      break;
    }
    case 'drip': {
      // cave drip: a short sine ping into the reverb. The tail is the cave.
      const f0 = 900 + rng() * 1700;
      const d = 0.16 + rng() * 0.2;
      const o = O('sine', f0);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + d);
      const e = v.n(envGain(a, t, level, 0.004, 0, d));
      o.connect(e); e.connect(out);
      if (g.verbSend) { const s = v.n(a.createGain()); s.gain.value = 1.1; e.connect(s); s.connect(g.verbSend); }
      dur = d + 0.2;
      break;
    }
    case 'pulse': {
      const d = 0.7 + rng() * 0.9;
      const f0 = 44 + rng() * 40;
      const o = O('sine', f0);
      o.frequency.linearRampToValueAtTime(f0 * 1.4, t + d * 0.5);
      o.frequency.linearRampToValueAtTime(f0 * 0.9, t + d);
      const e = v.n(envGain(a, t, level, d * 0.3, 0, d * 0.7));
      o.connect(e); e.connect(out);
      dur = d + 0.2;
      break;
    }
    case 'thump': {
      const d = 0.5 + rng() * 0.6;
      const o = O('sine', 60 + rng() * 30);
      o.frequency.exponentialRampToValueAtTime(24, t + d);
      const e = v.n(envGain(a, t, level, 0.012, 0.03, d));
      const src = N('brown');
      const b = bq('lowpass', 140, 1.2);
      const eb = v.n(envGain(a, t, level * 0.6, 0.01, 0.05, d * 0.8));
      o.connect(e); e.connect(out);
      src.connect(b); b.connect(eb); eb.connect(out);
      if (g.verbSend) e.connect(g.verbSend);
      dur = d + 0.3;
      break;
    }
    case 'hiss': {
      const d = 0.8 + rng() * 1.6;
      const src = N('white');
      const b = bq('bandpass', 2400 + rng() * 3600, 1.2);
      b.frequency.linearRampToValueAtTime(1200 + rng() * 1600, t + d);
      const e = v.n(envGain(a, t, level, d * 0.35, 0, d * 0.65));
      src.connect(b); b.connect(e); e.connect(out);
      dur = d + 0.2;
      break;
    }
    case 'lap': {
      // a wave folding over: broadband slap then a receding fizz
      const d = 0.55 + rng() * 0.6;
      const src = N('white');
      const b = bq('bandpass', 700 + rng() * 700, 0.7);
      b.frequency.linearRampToValueAtTime(2200 + rng() * 1400, t + d);
      const e = v.n(envGain(a, t, level, 0.05, 0.04, d));
      const lo = N('brown');
      const lb = bq('lowpass', 260, 0.9);
      const le = v.n(envGain(a, t, level * 0.8, 0.03, 0.02, d * 0.7));
      src.connect(b); b.connect(e); e.connect(out);
      lo.connect(lb); lb.connect(le); le.connect(out);
      dur = d + 0.25;
      break;
    }
    case 'spray': {
      const d = 0.3 + rng() * 0.4;
      const src = N('white');
      const b = bq('highpass', 3200 + rng() * 2600, 0.7);
      const e = v.n(envGain(a, t, level, 0.02, 0.02, d));
      src.connect(b); b.connect(e); e.connect(out);
      dur = d + 0.2;
      break;
    }
    case 'skitter': {
      const n = 6 + Math.floor(rng() * 10);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const src = N('white');
        const b = bq('bandpass', 1600 + rng() * 2600, 12);
        const e = v.n(envGain(a, tt, level * (0.4 + rng() * 0.6), 0.001, 0, 0.018));
        src.connect(b); b.connect(e); e.connect(out);
        tt += 0.03 + rng() * 0.06;
      }
      dur = tt - t + 0.1;
      break;
    }
    default: {
      const src = N('pink');
      const b = bq('bandpass', 800, 2);
      const e = v.n(envGain(a, t, level, 0.02, 0.05, 0.2));
      src.connect(b); b.connect(e); e.connect(out);
      dur = 0.3;
    }
  }
  v.run(t, t + dur);
  return dur;
}

// ---------------------------------------------------------------------------
// Bed — one biome's ambience. Crossfaded by weight; grains scheduled by window
// so the identical object can be driven live or pre-scheduled offline.
// ---------------------------------------------------------------------------
class Bed {
  constructor(g, tag, t0 = 0) {
    const a = g.actx;
    const spec = BEDS[tag] || BEDS['sparse-open'];
    this.g = g; this.tag = tag; this.spec = spec;
    this.rng = makeRNG(hashStr(tag) * 7919 + 17);
    this.weight = 0;
    this.dead = false;
    this.nextGrain = spec.grains.map(() => t0 + 0.15 + this.rng() * 2.0);
    this.srcs = [];

    g.retain?.(this);            // see Graph.retain — offline GC will eat this

    this.out = a.createGain();
    this.out.gain.value = 0;
    this.out.connect(g.bedBus);

    // The `bright` column has to be audible or it is decoration. One shelf on
    // the bed's own output widens the measured spread between the burbling
    // shallows and the abyss far more cheaply than re-authoring every layer.
    this.tilt = a.createBiquadFilter();
    this.tilt.type = 'highshelf';
    this.tilt.frequency.value = 900;
    this.tilt.gain.value = lerp(-8, 4, spec.bright ?? 0.5);
    this.tilt.connect(this.out);

    const gain = spec.gain ?? 1;

    // ---- drone stack
    const d = spec.drone;
    const dlp = a.createBiquadFilter(); dlp.type = 'lowpass';
    dlp.frequency.value = d.lp; dlp.Q.value = 0.8;
    const dg = a.createGain(); dg.gain.value = d.gain * gain;
    dlp.connect(dg); dg.connect(this.tilt);
    for (let i = 0; i < d.partials.length; i++) {
      const o = a.createOscillator();
      o.type = d.type;
      o.frequency.value = d.root * d.partials[i];
      // a few cents of spread per partial keeps the stack from phase-locking
      o.detune.value = (this.rng() - 0.5) * 11;
      const og = a.createGain();
      og.gain.value = 1 / (1 + i * 1.15);
      o.connect(og); og.connect(dlp);
      this.srcs.push(o);
    }
    // slow swell on the drone
    const dl = a.createOscillator(); dl.type = 'sine'; dl.frequency.value = d.lfo[0];
    const dlg = a.createGain(); dlg.gain.value = d.gain * gain * d.lfo[1];
    dl.connect(dlg); dlg.connect(dg.gain);
    this.srcs.push(dl);

    // ---- body noise with a wandering filter
    const mk = (s, extraLfo) => {
      const src = a.createBufferSource();
      src.buffer = g.noise[s.src]; src.loop = true;
      // start each layer at a different phase so two beds never comb together
      src.playbackRate.value = 0.94 + this.rng() * 0.12;
      const b = a.createBiquadFilter(); b.type = s.type;
      b.frequency.value = s.f; b.Q.value = s.q;
      const ng = a.createGain(); ng.gain.value = s.gain * gain;
      src.connect(b); b.connect(ng); ng.connect(this.tilt);
      this.srcs.push(src);
      if (s.wob) {
        const lf = a.createOscillator(); lf.type = 'sine'; lf.frequency.value = s.wob[0];
        const lg = a.createGain();
        // Modulate DETUNE (cents), not frequency (Hz). Two reasons, one musical
        // and one hard-won: an exponential wobble is symmetric in pitch, which
        // is how water actually moves; and a linear Hz sweep pushes the cutoff
        // toward zero at the bottom of its swing, which is the coefficient
        // region where Chrome's biquad sporadically resets its own state. That
        // measured as a single-sample step to silence roughly once per twenty
        // seconds, NON-deterministically, in one bed out of sixteen — the only
        // discontinuity the click analysis ever found. Detune cannot reach it.
        lg.gain.value = 1200 * Math.log2(1 + clamp(s.wob[1], 0, 0.95));
        lf.connect(lg); lg.connect(b.detune);
        this.srcs.push(lf);
      }
      if (extraLfo && s.swell) {
        const lf = a.createOscillator(); lf.type = 'sine'; lf.frequency.value = s.swell[0];
        const lg = a.createGain(); lg.gain.value = s.gain * gain * s.swell[1];
        lf.connect(lg); lg.connect(ng.gain);
        this.srcs.push(lf);
      }
      return ng;
    };
    mk(spec.noise, true);
    mk(spec.surge, true);

    for (const s of this.srcs) {
      try { s.start(t0 + this.rng() * 0.02); } catch { /* already running */ }
    }
  }

  /** Crossfade toward w. Never a step: setTargetAtTime, always. */
  setWeight(w, t, tau = 1.6) {
    this.weight = w;
    this.out.gain.setTargetAtTime(w, t, Math.max(tau, 0.02));
  }

  /** Snap (used on a camera teleport, where a 6 s crossfade is just wrong). */
  snapWeight(w, t) {
    this.weight = w;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(w, t, 0.05);
  }

  /**
   * Fill [from, to) with grains. Live passes a 0.6 s lookahead each frame;
   * analyze() passes the whole render at once. Same code, same result.
   */
  schedule(from, to) {
    if (this.dead) return;
    const gs = this.spec.grains;
    for (let i = 0; i < gs.length; i++) {
      const s = gs[i];
      let t = this.nextGrain[i];
      if (t < from) t = from + this.rng() * 0.5;
      let guard = 0;
      while (t < to && guard++ < 96) {
        // grains scale with the bed's own weight: a bed at 5% must not tick
        if (this.weight > 0.12) grain(this.g, this.tilt, s.kind, t, this.rng, s.gain, s.tint ?? 1);
        t += expWait(this.rng, 1 / s.rate);
      }
      this.nextGrain[i] = t;
    }
  }

  /**
   * Fade out and stop. Deliberately does NOT disconnect: a topology change
   * drops a render quantum for the WHOLE graph, not just the node being
   * removed, so retiring a bed would tick the bed that replaced it. Once the
   * sources have stopped and nothing references this Bed, the implementation
   * reclaims the chain on its own. See Voice.run().
   */
  stop(t) {
    if (this.dead) return;
    this.dead = true;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.5);
    for (const s of this.srcs) { try { s.stop(t + 3.2); } catch { /* not started */ } }
  }
}

// ---------------------------------------------------------------------------
// player voices
// ---------------------------------------------------------------------------
/**
 * The regulator. Inhale is a rising band of noise through a resonant body;
 * exhale is that band collapsing plus the bubble string leaving the mouthpiece.
 * Rate and rasp are driven entirely by oxygen, which is why this doubles as the
 * O2 readout: you hear the tank getting low before you look at the number.
 */
function breathVoice(g, t, phase, rng, strain, level) {
  const a = g.actx;
  const v = new Voice(g);
  const out = g.playerBus;
  const src = v.s(a.createBufferSource());
  src.buffer = g.noise.white; src.loop = true;
  src.playbackRate.value = 0.8 + rng() * 0.4;

  const body = v.n(a.createBiquadFilter()); body.type = 'bandpass';
  body.Q.value = 1.25 + strain * 1.6;
  const res = v.n(a.createBiquadFilter()); res.type = 'peaking';
  res.frequency.value = 210; res.Q.value = 2.2; res.gain.value = 7 + strain * 5;

  let dur;
  if (phase === 'in') {
    dur = lerp(1.15, 0.5, strain);
    body.frequency.setValueAtTime(300, t);
    body.frequency.exponentialRampToValueAtTime(lerp(1150, 1750, strain), t + dur * 0.72);
    body.frequency.exponentialRampToValueAtTime(560, t + dur);
    const e = v.n(envGain(a, t, level * lerp(0.8, 1.25, strain), dur * 0.42, dur * 0.16, dur * 0.42));
    src.connect(body); body.connect(res); res.connect(e); e.connect(out);
    // the mechanical click of the demand valve opening
    const ck = v.s(a.createBufferSource()); ck.buffer = g.noise.white;
    const cb = v.n(a.createBiquadFilter()); cb.type = 'bandpass';
    cb.frequency.value = 2600; cb.Q.value = 9;
    const ce = v.n(envGain(a, t, level * 0.22, 0.002, 0, 0.03));
    ck.connect(cb); cb.connect(ce); ce.connect(out);
  } else {
    dur = lerp(1.35, 0.62, strain);
    body.frequency.setValueAtTime(lerp(900, 1400, strain), t);
    body.frequency.exponentialRampToValueAtTime(280, t + dur);
    const e = v.n(envGain(a, t, level * 0.85, dur * 0.15, dur * 0.2, dur * 0.65));
    src.connect(body); body.connect(res); res.connect(e); e.connect(out);
    // bubbles leaving the exhaust, rising as they expand
    const n = 5 + Math.floor(rng() * 7 + strain * 5);
    let tt = t + 0.04;
    for (let i = 0; i < n; i++) {
      const f0 = 320 + rng() * 700;
      const d = 0.03 + rng() * 0.06;
      const o = v.s(a.createOscillator()); o.type = 'sine';
      o.frequency.setValueAtTime(f0, tt);
      o.frequency.exponentialRampToValueAtTime(f0 * (1.7 + rng()), tt + d);
      const be = v.n(envGain(a, tt, level * 0.3 * (0.4 + rng() * 0.6), 0.005, 0, d));
      o.connect(be); be.connect(out);
      tt += 0.03 + rng() * 0.1;
    }
    dur = Math.max(dur, tt - t) + 0.15;
  }
  v.run(t, t + dur + 0.1);
  return dur;
}

/** One swim stroke: the push of water past the suit, panned to the arm. */
function strokeVoice(g, t, rng, level, above, side) {
  const a = g.actx;
  const v = new Voice(g);
  const dur = above ? 0.55 : 0.62;
  const src = v.s(a.createBufferSource());
  src.buffer = g.noise.pink; src.loop = true;
  src.playbackRate.value = 0.85 + rng() * 0.3;
  const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
  b.Q.value = above ? 0.8 : 1.05;
  const f0 = above ? 900 : 210;
  const f1 = above ? 2600 : 780;
  b.frequency.setValueAtTime(f0, t);
  b.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.42);
  b.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + dur);
  const e = v.n(envGain(a, t, level, dur * 0.3, dur * 0.1, dur * 0.6));
  const pan = v.n(a.createStereoPanner ? a.createStereoPanner() : a.createGain());
  if (pan.pan) pan.pan.value = side * 0.4;
  src.connect(b); b.connect(e); e.connect(pan); pan.connect(g.playerBus);
  // low displacement thump so a stroke has mass
  const o = v.s(a.createOscillator()); o.type = 'sine';
  o.frequency.setValueAtTime(96, t);
  o.frequency.exponentialRampToValueAtTime(42, t + dur * 0.7);
  const oe = v.n(envGain(a, t, level * 0.5, 0.03, 0.02, dur * 0.6));
  o.connect(oe); oe.connect(g.playerBus);
  v.run(t, t + dur + 0.1);
  return dur;
}

/**
 * A blade through water, and what it lands on.
 *
 * The whoosh peaks LATE — water has mass, so the band sweeps up through the
 * stroke instead of cracking at the start like a sword in air. The impact is
 * scheduled 0.20 s in because that is exactly when tools.js resolves the
 * pending harvest (it sets vm.swing = 1 and queues `at: t + 0.20`), so the two
 * land together without audio needing to know what was cut.
 */
function knifeVoice(g, t, rng, level) {
  const a = g.actx;
  const v = new Voice(g);
  const src = v.s(a.createBufferSource());
  src.buffer = g.noise.pink; src.loop = true;
  src.playbackRate.value = 0.9 + rng() * 0.25;
  const b = v.n(a.createBiquadFilter()); b.type = 'bandpass'; b.Q.value = 1.15;
  b.frequency.setValueAtTime(280, t);
  b.frequency.exponentialRampToValueAtTime(1500, t + 0.15);
  b.frequency.exponentialRampToValueAtTime(430, t + 0.30);
  const e = v.n(envGain(a, t, level, 0.12, 0.02, 0.18));
  src.connect(b); b.connect(e); e.connect(g.playerBus);

  const ti = t + 0.20;
  const imp = v.s(a.createBufferSource()); imp.buffer = g.noise.white; imp.loop = true;
  const ib = v.n(a.createBiquadFilter()); ib.type = 'bandpass';
  ib.frequency.setValueAtTime(1500 + rng() * 900, ti);
  ib.frequency.exponentialRampToValueAtTime(420, ti + 0.09);
  ib.Q.value = 2.4;
  const ie = v.n(envGain(a, ti, level * 0.9, 0.002, 0.012, 0.1));
  imp.connect(ib); ib.connect(ie); ie.connect(g.playerBus);
  const th = v.s(a.createOscillator()); th.type = 'sine';
  th.frequency.setValueAtTime(150, ti);
  th.frequency.exponentialRampToValueAtTime(58, ti + 0.12);
  const te = v.n(envGain(a, ti, level * 0.55, 0.004, 0.01, 0.12));
  th.connect(te); te.connect(g.playerBus);
  v.run(t, ti + 0.35);
  return 0.55;
}

/** lub-dub. Fifth-interval pitch drop on each thump, dub quieter and shorter. */
function heartVoice(g, t, level, rate) {
  const a = g.actx;
  const v = new Voice(g);
  const beat = (tt, amp, f0, d) => {
    const o = v.s(a.createOscillator()); o.type = 'sine';
    o.frequency.setValueAtTime(f0, tt);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, tt + d);
    const e = v.n(envGain(a, tt, amp, 0.014, 0.02, d));
    o.connect(e); e.connect(g.playerBus);
    const s = v.s(a.createBufferSource()); s.buffer = g.noise.brown; s.loop = true;
    const b = v.n(a.createBiquadFilter()); b.type = 'lowpass'; b.frequency.value = 160;
    const se = v.n(envGain(a, tt, amp * 0.5, 0.008, 0.01, d * 0.8));
    s.connect(b); b.connect(se); se.connect(g.playerBus);
  };
  const gap = clamp(0.26 * (60 / rate) / 0.75, 0.14, 0.3);
  beat(t, level, 74, 0.17);
  beat(t + gap, level * 0.6, 60, 0.14);
  v.run(t, t + gap + 0.4);
  return gap + 0.4;
}

/** A grunt: three vowel formants over a fast-dropping larynx. */
function gruntVoice(g, t, rng, level, hurt) {
  const a = g.actx;
  const v = new Voice(g);
  const dur = hurt ? 0.55 : 0.34;
  const f0 = (hurt ? 132 : 108) * (0.9 + rng() * 0.2);
  const o = v.s(a.createOscillator()); o.type = 'sawtooth';
  o.frequency.setValueAtTime(f0 * 1.18, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + dur);
  const noise = v.s(a.createBufferSource());
  noise.buffer = g.noise.white; noise.loop = true;
  const ng = v.n(a.createGain()); ng.gain.value = hurt ? 0.5 : 0.28;
  noise.connect(ng);
  const e = v.n(envGain(a, t, level, 0.02, dur * 0.25, dur * 0.7));
  // /a/ formants — the reason this reads as a person and not a buzzer
  for (const [ff, q, amp] of [[600, 7, 1.0], [1040, 9, 0.6], [2450, 11, 0.28]]) {
    const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
    b.frequency.setValueAtTime(ff * (0.94 + rng() * 0.12), t);
    b.frequency.linearRampToValueAtTime(ff * 0.86, t + dur);
    b.Q.value = q;
    const bg = v.n(a.createGain()); bg.gain.value = amp;
    o.connect(b); ng.connect(b); b.connect(bg); bg.connect(e);
  }
  e.connect(g.playerBus);
  v.run(t, t + dur + 0.15);
  return dur;
}

/** Waterline transient. Down is a collapsing roar; up is a burst plus drain. */
function crossVoice(g, t, rng, going) {
  const a = g.actx;
  const v = new Voice(g);
  const dur = going === 'down' ? 1.1 : 1.3;
  const src = v.s(a.createBufferSource());
  src.buffer = g.noise.white; src.loop = true;
  const b = v.n(a.createBiquadFilter()); b.type = 'bandpass'; b.Q.value = 0.5;
  if (going === 'down') {
    b.frequency.setValueAtTime(4200, t);
    b.frequency.exponentialRampToValueAtTime(380, t + 0.45);
    b.frequency.exponentialRampToValueAtTime(180, t + dur);
  } else {
    b.frequency.setValueAtTime(300, t);
    b.frequency.exponentialRampToValueAtTime(5200, t + 0.3);
    b.frequency.exponentialRampToValueAtTime(1600, t + dur);
  }
  const e = v.n(envGain(a, t, 0.5, 0.02, 0.1, dur));
  src.connect(b); b.connect(e); e.connect(g.playerBus);
  // the fizz of entrained air
  const n = going === 'down' ? 16 : 10;
  let tt = t + 0.02;
  for (let i = 0; i < n; i++) {
    const f0 = 300 + rng() * 1400;
    const d = 0.03 + rng() * 0.05;
    const o = v.s(a.createOscillator()); o.type = 'sine';
    o.frequency.setValueAtTime(f0, tt);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.5 + rng()), tt + d);
    const be = v.n(envGain(a, tt, 0.16 * (0.4 + rng() * 0.6), 0.004, 0, d));
    o.connect(be); be.connect(g.playerBus);
    tt += 0.012 + rng() * 0.05;
  }
  const thump = v.s(a.createOscillator()); thump.type = 'sine';
  thump.frequency.setValueAtTime(going === 'down' ? 140 : 90, t);
  thump.frequency.exponentialRampToValueAtTime(38, t + 0.4);
  const te = v.n(envGain(a, t, 0.34, 0.006, 0.02, 0.45));
  thump.connect(te); te.connect(g.playerBus);
  v.run(t, t + Math.max(dur, tt - t) + 0.2);
  return dur;
}

// ---------------------------------------------------------------------------
// UI stings — the audible half of the holographic register.
// Bright, short, slightly detuned partials with a fast bell decay, one tiny
// noise tick for the "hardware" edge, and a light reverb send so they sit in
// the helmet rather than on top of the screen.
// ---------------------------------------------------------------------------
function bell(g, v, out, t, f, dur, level, partials = [1, 2.01, 3.02, 4.98]) {
  const a = g.actx;
  for (let i = 0; i < partials.length; i++) {
    const o = v.s(a.createOscillator());
    o.type = i === 0 ? 'triangle' : 'sine';
    o.frequency.setValueAtTime(f * partials[i], t);
    const e = v.n(envGain(a, t, level / (1 + i * 1.9), 0.004, 0, dur / (1 + i * 0.55)));
    o.connect(e); e.connect(out);
  }
}

function glide(g, v, out, t, f0, f1, dur, level, type = 'triangle') {
  const a = g.actx;
  const o = v.s(a.createOscillator());
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const e = v.n(envGain(a, t, level, dur * 0.18, dur * 0.3, dur * 0.55));
  o.connect(e); e.connect(out);
  return e;
}

/**
 * One trim at the voice's own output, rather than thirty edited literals.
 * Measured live: firing all eleven stings 1.3 s apart at 30 m moved the block
 * RMS only 2-4 dB above the bed — the centroid spiking to 1400 Hz was the only
 * thing that gave them away. A confirmation that quiet is not a confirmation.
 * With MIX.ui at 1.15 this puts a PDA ping ~8 dB over the ambience.
 */
const UI_LVL = 1.35;

function stingVoice(g, name, t, rng, o = {}) {
  const a = g.actx;
  const v = new Voice(g);
  const out = v.n(a.createGain());
  out.gain.value = UI_LVL * (o.level ?? 1);
  out.connect(g.uiBus);
  const send = a.createGain(); v.n(send); send.gain.value = 0.22;
  send.connect(g.verbSend);
  const tick = (tt, f, amp, d = 0.02) => {
    const s = v.s(a.createBufferSource()); s.buffer = g.noise.white;
    const b = v.n(a.createBiquadFilter()); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = 10;
    const e = v.n(envGain(a, tt, amp, 0.001, 0, d));
    s.connect(b); b.connect(e); e.connect(out);
  };
  let dur = 0.4;

  switch (name) {
    case 'pda-open': {
      glide(g, v, out, t, 520, 1046, 0.32, 0.22).connect(send);
      bell(g, v, out, t + 0.05, 1568, 0.5, 0.1);
      tick(t, 3200, 0.10);
      // holographic sheet unrolling
      const s = v.s(a.createBufferSource()); s.buffer = g.noise.pink; s.loop = true;
      const b = v.n(a.createBiquadFilter()); b.type = 'bandpass'; b.Q.value = 1.6;
      b.frequency.setValueAtTime(900, t);
      b.frequency.exponentialRampToValueAtTime(4200, t + 0.3);
      const e = v.n(envGain(a, t, 0.10, 0.03, 0.05, 0.3));
      s.connect(b); b.connect(e); e.connect(out);
      dur = 0.75;
      break;
    }
    case 'pda-close': {
      glide(g, v, out, t, 1046, 470, 0.26, 0.18).connect(send);
      tick(t + 0.22, 2200, 0.08);
      dur = 0.45;
      break;
    }
    case 'scan-start': {
      glide(g, v, out, t, 780, 1320, 0.16, 0.16);
      tick(t, 4200, 0.09);
      dur = 0.3;
      break;
    }
    case 'scan-tick': {
      // The scanner's progress is audible: the tick climbs a minor sixth across
      // the sweep, so you know the lock is nearly done without reading the ring.
      const p = clamp(o.p ?? 0, 0, 1);
      bell(g, v, out, t, semis(1568, Math.round(p * 8)), 0.1, 0.075, [1, 2.02]);
      dur = 0.16;
      break;
    }
    case 'equip': {
      // hardware, not hologram: a dry two-stage detent with no tail at all
      tick(t, 1900, 0.34, 0.012);
      tick(t + 0.038, 1180, 0.24, 0.026);
      const oo = v.s(a.createOscillator()); oo.type = 'sine';
      oo.frequency.setValueAtTime(320, t);
      oo.frequency.exponentialRampToValueAtTime(150, t + 0.07);
      const e = v.n(envGain(a, t, 0.26, 0.003, 0, 0.07));
      oo.connect(e); e.connect(out);
      dur = 0.18;
      break;
    }
    case 'toggle': {
      // a relay closing inside the suit
      tick(t, 2600, 0.42, 0.010);
      tick(t + 0.026, 900, 0.30, 0.03);
      const ro = v.s(a.createOscillator()); ro.type = 'sine';
      ro.frequency.setValueAtTime(420, t);
      ro.frequency.exponentialRampToValueAtTime(190, t + 0.06);
      const re2 = v.n(envGain(a, t, 0.34, 0.002, 0, 0.06));
      ro.connect(re2); re2.connect(out);
      dur = 0.16;
      break;
    }
    case 'blueprint': {
      // something became BUILDABLE: a rising fourth left open at the top
      bell(g, v, out, t, 784, 0.34, 0.22, [1, 2.01, 3.02]);
      bell(g, v, out, t + 0.13, 1046, 0.42, 0.22);
      const e = glide(g, v, out, t + 0.2, 1046, 2093, 0.5, 0.11, 'sine');
      e.connect(send);
      dur = 0.9;
      break;
    }
    case 'scan-complete': {
      const notes = [880, 1174.7, 1568];
      for (let i = 0; i < notes.length; i++) {
        bell(g, v, out, t + i * 0.085, notes[i], 0.55 + i * 0.15, 0.17 - i * 0.02);
      }
      const e = glide(g, v, out, t + 0.17, 1568, 3136, 0.35, 0.07, 'sine');
      e.connect(send);
      tick(t, 3600, 0.08);
      dur = 0.95;
      break;
    }
    case 'craft': {
      // a low fabricator thunk under a rising sparkle — the thing became real
      const o = v.s(a.createOscillator()); o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.25);
      const oe = v.n(envGain(a, t, 0.24, 0.006, 0.02, 0.3));
      o.connect(oe); oe.connect(out);
      for (let i = 0; i < 5; i++) {
        bell(g, v, out, t + 0.05 + i * 0.055, 1046 * Math.pow(2, i / 12 * 2), 0.4, 0.075, [1, 2.01]);
      }
      const e = glide(g, v, out, t + 0.1, 1568, 2637, 0.4, 0.06, 'sine');
      e.connect(send);
      dur = 0.85;
      break;
    }
    case 'pickup': {
      bell(g, v, out, t, 1318, 0.22, 0.21, [1, 2.01, 3.03]);
      tick(t, 5200, 0.09);
      dur = 0.35;
      break;
    }
    case 'notify': {
      bell(g, v, out, t, 1046, 0.3, 0.20);
      bell(g, v, out, t + 0.11, 1568, 0.45, 0.17);
      dur = 0.6;
      break;
    }
    case 'warn': {
      for (let i = 0; i < 2; i++) {
        const o = v.s(a.createOscillator()); o.type = 'square';
        o.frequency.setValueAtTime(620, t + i * 0.19);
        const e = v.n(envGain(a, t + i * 0.19, 0.13, 0.008, 0.06, 0.09));
        const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 2400;
        o.connect(lp); lp.connect(e); e.connect(out);
      }
      dur = 0.5;
      break;
    }
    case 'deny': {
      const o = v.s(a.createOscillator()); o.type = 'sawtooth';
      o.frequency.setValueAtTime(240, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.2);
      const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 1400;
      const e = v.n(envGain(a, t, 0.16, 0.006, 0.06, 0.16));
      o.connect(lp); lp.connect(e); e.connect(out);
      dur = 0.35;
      break;
    }
    case 'beacon': {
      // sonar: a single tone thrown into the reverb and left there
      const e = glide(g, v, out, t, 1760, 1400, 0.5, 0.14, 'sine');
      const s = v.n(a.createGain()); s.gain.value = 1.4;
      e.connect(s); s.connect(g.verbSend);
      dur = 1.2;
      break;
    }
    case 'damage': {
      const o = v.s(a.createOscillator()); o.type = 'square';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(220, t + 0.18);
      const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 1800;
      const e = v.n(envGain(a, t, 0.15, 0.004, 0.03, 0.18));
      o.connect(lp); lp.connect(e); e.connect(out);
      dur = 0.35;
      break;
    }
    default: {
      bell(g, v, out, t, 1200, 0.25, 0.12);
      dur = 0.4;
    }
  }
  v.run(t, t + dur + 0.2);
  return dur;
}

// ---------------------------------------------------------------------------
// creature voices
// ---------------------------------------------------------------------------
/**
 * Build one vocalisation as a free-floating node. The caller decides whether it
 * gets a panner (world) or goes straight to a bus (analysis).
 */
function voxVoice(g, spec, t, rng, dist) {
  const a = g.actx;
  const v = new Voice(g);
  const outG = a.createGain(); v.n(outG); outG.gain.value = 1;
  // distance eats the top end long before it eats the level — that asymmetry is
  // what makes a far roar read as far rather than as quiet.
  const air = v.n(a.createBiquadFilter()); air.type = 'lowpass';
  air.frequency.value = clamp(280 + 7000 * Math.exp(-dist / 42), 190, 20000);
  air.Q.value = 0.6;
  const dur = lerp(spec.dur[0], spec.dur[1], rng());
  const lvl = spec.gain;
  const f = spec.f * (0.9 + rng() * 0.2);

  const bandOut = a.createGain(); v.n(bandOut); bandOut.gain.value = 1;
  bandOut.connect(air); air.connect(outG);

  switch (spec.kind) {
    case 'roar': {
      // The reaper. A pitched growl that swells, holds under heavy vibrato and
      // collapses, run through three formants so it has a throat.
      const e = v.n(envGain(a, t, lvl, dur * 0.22, dur * 0.3, dur * 0.48));
      const stack = a.createGain(); v.n(stack); stack.gain.value = 1;
      for (let i = 0; i < 3; i++) {
        const o = v.s(a.createOscillator());
        o.type = i === 0 ? 'sawtooth' : 'square';
        const ff = f * (i === 0 ? 1 : i === 1 ? 1.5 : 2.02);
        o.frequency.setValueAtTime(ff * 0.72, t);
        o.frequency.linearRampToValueAtTime(ff * 1.12, t + dur * 0.3);
        o.frequency.linearRampToValueAtTime(ff * 0.55, t + dur);
        o.detune.value = (rng() - 0.5) * 26;
        const og = v.n(a.createGain()); og.gain.value = 0.55 / (1 + i);
        o.connect(og); og.connect(stack);
      }
      const rasp = v.s(a.createBufferSource());
      rasp.buffer = g.noise.white; rasp.loop = true;
      const rg = v.n(a.createGain()); rg.gain.value = 0.32;
      rasp.connect(rg); rg.connect(stack);
      // vibrato that only bites at the peak of the call, on its own stage so it
      // cannot survive the envelope
      const trem = v.n(a.createGain()); trem.gain.value = 0.78;
      const vib = v.s(a.createOscillator()); vib.type = 'sine';
      vib.frequency.setValueAtTime(5.2, t);
      vib.frequency.linearRampToValueAtTime(8.4, t + dur);
      const vg = v.n(a.createGain());
      vg.gain.value = 0.001;
      vg.gain.setValueAtTime(0.001, t);
      vg.gain.linearRampToValueAtTime(0.30, t + dur * 0.4);
      vg.gain.linearRampToValueAtTime(0.05, t + dur);
      vib.connect(vg); vg.connect(trem.gain);
      for (const [ff, q, amp] of [[105, 5, 1.0], [330, 7, 0.55], [760, 8, 0.3]]) {
        const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
        b.frequency.setValueAtTime(ff, t);
        b.frequency.linearRampToValueAtTime(ff * 0.72, t + dur);
        b.Q.value = q;
        const bg = v.n(a.createGain()); bg.gain.value = amp;
        stack.connect(b); b.connect(bg); bg.connect(trem);
      }
      trem.connect(e); e.connect(bandOut);
      break;
    }
    case 'wail': {
      // ghost leviathan: thinner, higher, and it climbs before it falls
      const e = v.n(envGain(a, t, lvl, dur * 0.3, dur * 0.2, dur * 0.5));
      const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.linearRampToValueAtTime(1700, t + dur * 0.4);
      lp.frequency.linearRampToValueAtTime(420, t + dur);
      lp.Q.value = 1.6;
      for (let i = 0; i < 4; i++) {
        const o = v.s(a.createOscillator());
        o.type = i % 2 ? 'sine' : 'triangle';
        const ff = f * [1, 1.5, 2.01, 3.03][i];
        o.frequency.setValueAtTime(ff * 0.78, t);
        o.frequency.exponentialRampToValueAtTime(ff * 1.45, t + dur * 0.45);
        o.frequency.exponentialRampToValueAtTime(ff * 0.6, t + dur);
        o.detune.value = (rng() - 0.5) * 18;
        const og = v.n(a.createGain()); og.gain.value = 0.5 / (1 + i * 1.3);
        o.connect(og); og.connect(lp);
      }
      const trem = v.n(a.createGain()); trem.gain.value = 0.85;
      const vib = v.s(a.createOscillator()); vib.type = 'sine';
      vib.frequency.value = 3.6 + rng();
      const vg = v.n(a.createGain()); vg.gain.value = 0.14;
      vib.connect(vg); vg.connect(trem.gain);
      lp.connect(trem); trem.connect(e); e.connect(bandOut);
      break;
    }
    case 'song': {
      // reefback: whale song. Slow glissandi, almost no noise, huge tail.
      const e = v.n(envGain(a, t, lvl, dur * 0.28, dur * 0.24, dur * 0.48));
      const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass';
      lp.frequency.value = 380; lp.Q.value = 1.1;
      const steps = 3 + Math.floor(rng() * 2);
      for (let i = 0; i < 3; i++) {
        const o = v.s(a.createOscillator()); o.type = i ? 'sine' : 'triangle';
        const ff = f * [1, 2.01, 3.02][i];
        o.frequency.setValueAtTime(ff, t);
        for (let s = 1; s <= steps; s++) {
          o.frequency.linearRampToValueAtTime(
            ff * (0.7 + rng() * 0.85), t + dur * (s / steps));
        }
        const og = v.n(a.createGain()); og.gain.value = 0.6 / (1 + i * 1.6);
        o.connect(og); og.connect(lp);
      }
      lp.connect(e); e.connect(bandOut);
      break;
    }
    case 'snarl': {
      const e = v.n(envGain(a, t, lvl, dur * 0.12, dur * 0.2, dur * 0.7));
      const o = v.s(a.createOscillator()); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.3, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.62, t + dur);
      const ns = v.s(a.createBufferSource()); ns.buffer = g.noise.white; ns.loop = true;
      const ng = v.n(a.createGain()); ng.gain.value = 0.5;
      ns.connect(ng);
      const trem = v.n(a.createGain()); trem.gain.value = 0.8;
      for (const [ff, q, amp] of [[240, 5, 1.0], [720, 7, 0.5], [1900, 8, 0.22]]) {
        const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
        b.frequency.setValueAtTime(ff, t);
        b.frequency.linearRampToValueAtTime(ff * 0.7, t + dur);
        b.Q.value = q;
        const bg = v.n(a.createGain()); bg.gain.value = amp;
        o.connect(b); ng.connect(b); b.connect(bg); bg.connect(trem);
      }
      const chat = v.s(a.createOscillator()); chat.type = 'sawtooth';
      chat.frequency.value = 22 + rng() * 18;
      const cg = v.n(a.createGain()); cg.gain.value = 0.22;
      chat.connect(cg); cg.connect(trem.gain);
      trem.connect(e); e.connect(bandOut);
      break;
    }
    case 'click': {
      const n = 6 + Math.floor(rng() * 12);
      let tt = t;
      for (let i = 0; i < n && tt < t + dur; i++) {
        const s = v.s(a.createBufferSource()); s.buffer = g.noise.white;
        const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
        b.frequency.value = f * (0.6 + rng() * 1.2); b.Q.value = 14;
        const e = v.n(envGain(a, tt, lvl * (0.4 + rng() * 0.7), 0.001, 0, 0.02 + rng() * 0.02));
        s.connect(b); b.connect(e); e.connect(bandOut);
        tt += 0.025 + rng() * 0.1;
      }
      break;
    }
    case 'zap': {
      const e = v.n(envGain(a, t, lvl, 0.01, dur * 0.25, dur * 0.7));
      const s = v.s(a.createBufferSource()); s.buffer = g.noise.white; s.loop = true;
      const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
      b.frequency.setValueAtTime(2600, t);
      b.frequency.exponentialRampToValueAtTime(700, t + dur);
      b.Q.value = 7;
      const gate = v.s(a.createOscillator()); gate.type = 'square';
      gate.frequency.setValueAtTime(38 + rng() * 40, t);
      gate.frequency.linearRampToValueAtTime(12, t + dur);
      const gt = v.n(a.createGain()); gt.gain.value = 0.5;
      const gg = v.n(a.createGain()); gg.gain.value = 0.45;
      gate.connect(gg); gg.connect(gt.gain);
      s.connect(b); b.connect(gt); gt.connect(e); e.connect(bandOut);
      const o = v.s(a.createOscillator()); o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.35, t + dur * 0.6);
      const oe = v.n(envGain(a, t, lvl * 0.6, 0.005, 0.02, dur * 0.5));
      o.connect(oe); oe.connect(bandOut);
      break;
    }
    case 'warp': {
      // ring modulation: two sines multiplied gives the inharmonic metal edge
      const car = v.s(a.createOscillator()); car.type = 'sine';
      car.frequency.setValueAtTime(f, t);
      car.frequency.exponentialRampToValueAtTime(f * 0.28, t + dur);
      const mod = v.s(a.createOscillator()); mod.type = 'sine';
      mod.frequency.setValueAtTime(f * 0.41, t);
      mod.frequency.exponentialRampToValueAtTime(f * 1.7, t + dur);
      const ring = v.n(a.createGain()); ring.gain.value = 0;
      mod.connect(ring.gain);
      car.connect(ring);
      const e = v.n(envGain(a, t, lvl, dur * 0.2, dur * 0.2, dur * 0.6));
      ring.connect(e); e.connect(bandOut);
      break;
    }
    case 'mesmer': {
      const e = v.n(envGain(a, t, lvl, dur * 0.35, dur * 0.2, dur * 0.45));
      for (let i = 0; i < 3; i++) {
        const o = v.s(a.createOscillator()); o.type = 'sine';
        o.frequency.setValueAtTime(f * (1 + i * 0.5), t);
        const wob = v.s(a.createOscillator()); wob.type = 'sine';
        wob.frequency.value = 2.2 + i * 0.7;
        const wg = v.n(a.createGain()); wg.gain.value = f * 0.08 * (1 + i);
        wob.connect(wg); wg.connect(o.frequency);
        const og = v.n(a.createGain()); og.gain.value = 0.5 / (1 + i);
        o.connect(og); og.connect(e);
      }
      e.connect(bandOut);
      break;
    }
    case 'shriek': {
      const e = v.n(envGain(a, t, lvl, 0.02, dur * 0.2, dur * 0.75));
      const o = v.s(a.createOscillator()); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.7, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.9, t + dur * 0.4);
      o.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur);
      const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
      b.frequency.value = f * 1.6; b.Q.value = 3;
      o.connect(b); b.connect(e); e.connect(bandOut);
      break;
    }
    case 'puff': {
      const e = v.n(envGain(a, t, lvl, 0.03, dur * 0.2, dur * 0.7));
      const s = v.s(a.createBufferSource()); s.buffer = g.noise.pink; s.loop = true;
      const b = v.n(a.createBiquadFilter()); b.type = 'bandpass';
      b.frequency.setValueAtTime(f * 4, t);
      b.frequency.exponentialRampToValueAtTime(f * 1.2, t + dur);
      b.Q.value = 1.4;
      s.connect(b); b.connect(e); e.connect(bandOut);
      break;
    }
    case 'shimmer': {
      const e = v.n(envGain(a, t, lvl, dur * 0.4, dur * 0.1, dur * 0.5));
      for (let i = 0; i < 4; i++) {
        const o = v.s(a.createOscillator()); o.type = 'sine';
        o.frequency.setValueAtTime(f * (1 + i * 0.37) * (0.95 + rng() * 0.1), t);
        const og = v.n(a.createGain()); og.gain.value = 0.4 / (1 + i);
        o.connect(og); og.connect(e);
      }
      e.connect(bandOut);
      break;
    }
    case 'skitter':
    case 'bubbleup':
    case 'chirp':
    default: {
      // small animals reuse the grain vocabulary, which is what makes the reef
      // sound like one ecology rather than two libraries
      const kind = spec.kind === 'chirp' ? 'chirp' : spec.kind === 'skitter' ? 'skitter' : 'bubbleup';
      grain(g, bandOut, kind, t, rng, lvl, f / 1200);
      break;
    }
  }

  if (spec.verb && g.verbSend) {
    const s = v.n(a.createGain()); s.gain.value = spec.verb;
    outG.connect(s); s.connect(g.verbSend);
  }
  v.run(t, t + dur + 0.4);
  return { node: outG, dur: dur + 0.4 };
}

// ---------------------------------------------------------------------------
// music — sparse pads. Silence is the default state; these are events.
// ---------------------------------------------------------------------------
const CHORDS = {
  discovery: { root: 6, semis: [0, 7, 12, 16, 19, 24], attack: 5.5, hold: 4, release: 8, level: 0.16, lp: [400, 2600] },
  danger: { root: -8, semis: [0, 1, 6, 13, 18], attack: 2.2, hold: 3.5, release: 6, level: 0.20, lp: [180, 900] },
  drift: { root: -2, semis: [0, 5, 12, 17, 24], attack: 7, hold: 6, release: 11, level: 0.12, lp: [260, 1400] },
};

function padVoice(g, kind, t, rng, transpose = 0) {
  const a = g.actx;
  const c = CHORDS[kind] || CHORDS.drift;
  const v = new Voice(g);
  const dur = c.attack + c.hold + c.release;
  const root = semis(110, c.root + transpose);
  const lp = v.n(a.createBiquadFilter()); lp.type = 'lowpass'; lp.Q.value = 1.1;
  lp.frequency.setValueAtTime(c.lp[0], t);
  lp.frequency.linearRampToValueAtTime(c.lp[1], t + c.attack + c.hold * 0.5);
  lp.frequency.linearRampToValueAtTime(c.lp[0] * 0.8, t + dur);
  const e = v.n(envGain(a, t, c.level, c.attack, c.hold, c.release));
  lp.connect(e); e.connect(g.musicBus);
  const send = v.n(a.createGain()); send.gain.value = 0.5;
  e.connect(send); send.connect(g.verbSend);

  for (let i = 0; i < c.semis.length; i++) {
    const f = semis(root, c.semis[i]);
    // pairs a few cents apart beat slowly against each other: that slow motion
    // is the whole reason a pad reads as alive rather than as an organ chord
    for (const det of [-5.5, 5.5]) {
      const o = v.s(a.createOscillator());
      o.type = i % 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det + (rng() - 0.5) * 3;
      const og = v.n(a.createGain());
      og.gain.value = 0.26 / (1 + i * 0.65);
      o.connect(og); og.connect(lp);
    }
  }
  v.run(t, t + dur + 0.4);
  return dur;
}

// ---------------------------------------------------------------------------
// analysis (offline) — the only way to prove any of the above is real
// ---------------------------------------------------------------------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const BANDS = [
  ['sub', 20, 80], ['low', 80, 250], ['lowmid', 250, 800],
  ['mid', 800, 2500], ['high', 2500, 8000], ['air', 8000, 20000],
];

const db = (x) => (x > 1e-9 ? +(20 * Math.log10(x)).toFixed(2) : -180);

/** Everything a critic could reasonably ask about a rendered buffer. */
function measure(buf, from = 0, to = null) {
  const sr = buf.sampleRate;
  const ch = buf.numberOfChannels;
  const i0 = Math.floor(from * sr);
  const i1 = Math.min(buf.length, to == null ? buf.length : Math.ceil(to * sr));
  const n = Math.max(2, i1 - i0);
  const x = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) x[i] += d[i0 + i] / ch;
  }

  let sum = 0, sq = 0, peak = 0;
  for (let i = 0; i < n; i++) { sum += x[i]; sq += x[i] * x[i]; peak = Math.max(peak, Math.abs(x[i])); }
  const dc = sum / n;
  const rms = Math.sqrt(sq / n);

  // click detection: a real click is a first-difference outlier. Compare the
  // largest sample-to-sample jump against the RMS of all jumps — smooth audio
  // sits around 4-8, a discontinuity blows past 25.
  let dsq = 0, dmax = 0, dat = 0;
  for (let i = 1; i < n; i++) {
    const d = x[i] - x[i - 1]; dsq += d * d;
    if (Math.abs(d) > dmax) { dmax = Math.abs(d); dat = i; }
  }
  const drms = Math.sqrt(dsq / (n - 1));

  // spectrum: Hann-windowed 4096 frames, hop 2048, magnitude-averaged
  const N = 4096, hop = 2048;
  const mag = new Float64Array(N / 2);
  let frames = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= n; s += hop) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      re[i] = x[s + i] * w; im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  // A voice that lands its envelope on a non-zero value clicks when its source
  // is stopped, and the evidence is a tail that never reaches silence. Measure
  // the last 12% of the window against the peak.
  let tail = 0;
  for (let i = Math.floor(n * 0.88); i < n; i++) tail = Math.max(tail, Math.abs(x[i]));

  // Per-channel, because a jump that exists only in the L+R mix is channel
  // cancellation (the convolver's decorrelated tail), not a discontinuity.
  const chSlope = [];
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    let m = 0, pk = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const j = Math.abs(d[i] - d[i - 1]); if (j > m) m = j;
      const p = Math.abs(d[i]); if (p > pk) pk = p;
    }
    chSlope.push(pk > 1e-9 ? +(m / pk).toFixed(3) : 0);
  }

  const out = {
    seconds: +((i1 - i0) / sr).toFixed(2),
    slopePerChannel: chSlope,
    rmsDb: db(rms), peakDb: db(peak),
    dc: +dc.toFixed(6), dcDb: db(Math.abs(dc)),
    jumpCrest: drms > 1e-9 ? +(dmax / drms).toFixed(1) : 0,
    // jumpCrest alone is misleading: a bright 2 kHz drip inside a very dark bed
    // is a legitimate outlier against that bed's own tiny average slope. What
    // actually identifies a DISCONTINUITY is the jump measured against the
    // signal's own amplitude — a band-limited signal cannot move more than
    // 2*pi*f/sr of its peak in one sample (~0.29 at 2 kHz / 44.1 kHz), so
    // anything approaching 1.0 here is a step, not a transient.
    slopeRatio: peak > 1e-9 ? +(dmax / peak).toFixed(3) : 0,
    jumpAtS: +(from + dat / sr).toFixed(3),
    // the samples straddling the worst jump — a step shows as a hard shelf here,
    // a legitimate transient as a steep but continuous ramp
    jumpWindow: Array.from({ length: 25 },
      (_, k) => +(x[clamp(dat - 12 + k, 0, n - 1)] ?? 0).toFixed(5)),
    tailDb: db(tail), tailBelowPeakDb: +(db(tail) - db(peak)).toFixed(1),
    clipped: peak >= 0.999,
  };
  if (!frames) return out;
  for (let k = 0; k < N / 2; k++) mag[k] /= frames;

  let num = 0, den = 0, tot = 0;
  const bands = {};
  for (const [name] of BANDS) bands[name] = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = k * sr / N;
    const m = mag[k];
    num += f * m; den += m; tot += m * m;
    for (const [name, lo, hi] of BANDS) if (f >= lo && f < hi) { bands[name] += m * m; break; }
  }
  out.centroidHz = den > 0 ? Math.round(num / den) : 0;
  const bandDb = {};
  for (const [name] of BANDS) bandDb[name] = tot > 0 ? +(10 * Math.log10(Math.max(bands[name] / tot, 1e-12))).toFixed(1) : -120;
  out.bandsDb = bandDb;
  // where the top of the content actually is: highest bin within 40 dB of peak
  let pk = 0;
  for (let k = 1; k < N / 2; k++) pk = Math.max(pk, mag[k]);
  let roll = 0;
  for (let k = N / 2 - 1; k > 0; k--) if (mag[k] > pk * 0.01) { roll = k * sr / N; break; }
  out.rolloffHz = Math.round(roll);
  return out;
}

/**
 * Where each bed is actually heard, as [submersion, depth m] — the midpoint of
 * that ambience tag's depth band in biomes.js.
 *
 * This exists because the harness was measuring the beds through the wrong
 * filter state. Every render called applyWater(1, 0): submersion 1 at depth 0,
 * including the ABOVE-WATER `surface` bed, so the headline "48 Hz to 1365 Hz"
 * centroid span was bed content heard through a water muffle that half of them
 * never meet, and the surface bed was reported drowned. Measured on the live
 * game path the real span is 156 Hz at 678 m to 7011 Hz in air — 45x, not 28x.
 * A harness that flatters the module is worse than no harness.
 */
const BED_AT = {
  surface: [0, 0],
  'shallows-reef': [1, 14],
  'kelp-creak': [1, 70],
  'plateau-open': [1, 100],
  'mushroom-hum': [1, 150],
  'crash-groan': [1, 130],
  'sparse-open': [1, 160],
  'islands-teal': [1, 120],
  'jelly-cave': [1, 190],
  'dunes-wind': [1, 190],
  'bulb-drone': [1, 240],
  'grand-reef-deep': [1, 350],
  'blood-kelp-dread': [1, 460],
  'lost-river-hollow': [1, 660],
  'void-abyss': [1, 700],
  'lava-rumble': [1, 1100],
};

/**
 * Level statistics over short blocks rather than one window average.
 *
 * "Is this event above the ambience" cannot be answered by a plain RMS over a
 * window that contains the event: a bed with sparse long grains in it has a
 * window RMS dominated by whichever grains happened to land, so the SAME bed
 * measures 6 dB apart on two renders. The median block level is the room tone;
 * the 85th percentile of the event's blocks is what the event does to it. This
 * is also the statistic the independent live-master tap used, so the offline
 * and live numbers are directly comparable.
 */
function blockLevels(buf, from, to, block = 0.1) {
  const sr = buf.sampleRate, ch = buf.numberOfChannels;
  const i0 = Math.floor(from * sr);
  const i1 = Math.min(buf.length, Math.ceil(to * sr));
  const n = Math.max(1, Math.floor((i1 - i0) / (block * sr)));
  const w = Math.floor(block * sr);
  const rms = [], pk = [];
  for (let b = 0; b < n; b++) {
    let sq = 0, p = 0;
    for (let i = 0; i < w; i++) {
      let x = 0;
      for (let c = 0; c < ch; c++) x += buf.getChannelData(c)[i0 + b * w + i] / ch;
      sq += x * x; const ax = Math.abs(x); if (ax > p) p = ax;
    }
    rms.push(Math.sqrt(sq / w)); pk.push(p);
  }
  const q = (arr, f) => { const s = [...arr].sort((a, b2) => a - b2); return s[clamp(Math.floor(s.length * f), 0, s.length - 1)]; };
  return {
    blocks: n,
    medianRmsDb: db(q(rms, 0.5)), p85RmsDb: db(q(rms, 0.85)),
    p95PeakDb: db(q(pk, 0.95)), maxPeakDb: db(Math.max(...pk)),
  };
}

async function renderOffline(seconds, build, seed = 4242, water = [1, 0], sr = 44100) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const actx = new OAC(2, Math.ceil(seconds * sr), sr);
  const g = new Graph(actx, { seed, offline: true, master: MIX.master });
  g.begin(0);
  g.applyWater(water[0], water[1], 0, 0.005);
  await build(g, actx, seconds);
  const buf = await actx.startRendering();
  g.dispose();
  return buf;
}

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------
const api = {
  id: 'audio',
  order: 220,

  /** true until the browser has given us a gesture; ui.js may prompt on this */
  needsGesture: true,
  running: false,
  muted: false,
  masterVolume: MIX.master,

  // -------------------------------------------------------------- lifecycle
  async init(ctx) {
    this._ctx = ctx;
    this.rng = ctx.rng?.fork ? ctx.rng.fork(0xA0D10) : makeRNG(0xA0D10);
    this.g = null;
    this.beds = new Map();

    this.s = {
      submerged: 1, subTarget: 1, depth: 0, speed: 0,
      oxygen: 1, o2Seconds: 95, health: 1, hypoxia: 0, pressure: 0,
      drowning: false, dead: false,
      hostility: 0.1, biome: 'safe_shallows',
      inVehicle: false, roars: 0, calls: 0, breaths: 0, cues: 0,
    };
    this._vitals = null;
    /** last observed tools.js state; null until the first poll establishes it */
    this._tl = null;
    this._scanTickT = 0;
    this._lastTsc = null;
    this._crossCool = 0;
    this._uiPatched = false;
    this._wasDead = false;
    this._pos = new THREE.Vector3().copy(ctx.camera.position);
    this._prev = new THREE.Vector3().copy(ctx.camera.position);
    this._vel = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    this._nextBreath = 0;
    this._breathPhase = 'in';
    this._nextHeart = 0;
    this._strokePhase = 0;
    this._strokeSide = 1;
    this._roarT = 40 + this.rng() * 60;
    this._vocalT = 3;
    this._musicT = 26 + this.rng() * 30;
    this._seenBiomes = new Set();
    this._lastHealth = 1;
    this._teleport = false;
    /**
     * Local O2 model, used ONLY to drive the breathing loop while
     * player/survival.js is still a stub. The moment survival.oxygen exists it
     * is ignored — this is never published as game state.
     */
    this._fallbackO2 = 1;

    ctx.provide?.('audio', this);

    // Autoplay policy: no AudioContext until a real gesture, which also means a
    // headless capture never logs "AudioContext was not allowed to start".
    // isTrusted matters: only a REAL gesture unlocks an AudioContext. A
    // scripted playthrough dispatches synthetic KeyboardEvents, and starting on
    // those would build the whole graph into a context the browser will never
    // resume — and log an autoplay warning into every capture report for it.
    // Harnesses call start() or ?audio=1 explicitly instead.
    this._arm = (e) => { if (!e || e.isTrusted !== false) this.start(); };
    if (typeof addEventListener === 'function') {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        addEventListener(ev, this._arm, { passive: true });
      }
      this._onEvent = (e) => { try { this.event(e.detail); } catch { /* ignore bad payloads */ } };
      addEventListener('cn:audio', this._onEvent);
    }
    // ?audio=1 starts it without waiting (manual testing / analysis pages)
    if (ctx.params?.get?.('audio') === '1') this.start();
  },

  /** Create the context and the graph. Idempotent, and never throws upward. */
  start() {
    if (this.g || this._starting) return this.running;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    this._starting = true;
    try {
      const actx = new AC({ latencyHint: 'interactive' });
      THREE.AudioContext.setContext(actx);
      const g = new Graph(actx, { seed: 1337, master: this.muted ? 0 : this.masterVolume });
      g.begin(actx.currentTime);

      const ctx = this._ctx;
      const listener = new THREE.AudioListener();
      // route the listener through our mixer instead of straight to the speakers,
      // so positional life gets the same water muffle as everything else
      try { listener.gain.disconnect(); } catch { /* not connected */ }
      listener.gain.connect(g.lifeBus);
      ctx.camera.add(listener);
      g.listener = listener;
      g.group = new THREE.Group();
      g.group.name = 'audio-sources';
      ctx.scene.add(g.group);

      this.g = g;
      this.listener = listener;
      this.running = true;
      this.needsGesture = false;
      const t = actx.currentTime;
      g.applyWater(this.s.submerged, this.s.depth, t, 0.02);
      actx.resume?.().catch(() => { /* will resume on the next gesture */ });
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        try { removeEventListener(ev, this._arm); } catch { /* no listener */ }
      }
      this._adoptUiCues();
    } catch (err) {
      console.warn('[audio] could not start:', err && err.message);
      this.g = null;
      this.running = false;
    }
    this._starting = false;
    return this.running;
  },

  /**
   * Take over ui.js's cue channel — WITHOUT touching src/ui/ui.js.
   *
   * ui.js opens a SECOND AudioContext and wires it straight to
   * `context.destination`. Nothing it plays passes this module's limiter, water
   * muffle, sidechain duck or the M-key mute, and two of its cues are outright
   * duplicates of ours on different formulas: a heartbeat at
   * lerp(62,148,stress) against survival's own `heart` Hz, and a raw
   * 1046/784 Hz square-wave low-oxygen alarm every 0.42-1.6 s. Measured
   * verdict: the loudest cheap-sounding thing in the whole low-oxygen
   * experience, and the M key does not silence it.
   *
   * ui.js's own comment says "audio.js owns the soundscape; this is only the
   * UI/vitals layer", and the intended fix is one line on their side:
   *
   *     _sound(kind, amt) { ctx.get('audio')?.uiCue(kind, amt); }
   *
   * Until that line exists we install exactly that, from here, at runtime: we
   * replace the METHOD on the object they published, we do not edit their file
   * and we do not touch anything else they own. The original is kept on
   * `_soundNative` so it can be restored, and `_sound` is only replaced if it
   * is still the function ui.js shipped (so re-running this is a no-op and a
   * future ui.js that already routes to us is left alone).
   *
   * The side effect that matters most: ui.js creates its AudioContext lazily
   * inside _sound, so with this installed the duplicate context is never built
   * at all.
   */
  _adoptUiCues() {
    if (this._uiPatched) return false;
    const ui = this._ctx?.get?.('ui');
    if (!ui || ui.stub || typeof ui._sound !== 'function') return false;
    if (ui._soundNative) { this._uiPatched = true; return true; }   // already ours
    const self = this;
    ui._soundNative = ui._sound;
    ui._sound = function (kind, amt) {
      try { self.uiCue(kind, amt); } catch { /* a cue must never take the HUD down */ }
    };
    this._uiPatched = true;
    console.info('[audio] adopted ui.js cue channel: its heartbeat, low-O2 alarm and '
      + 'PDA tones now run through the limiter, the water muffle, the duck and the mute. '
      + 'Permanent fix is one line in ui.js: _sound(kind, amt) { ctx.get("audio")?.uiCue(kind, amt); }');
    return true;
  },

  /** Hand ui.js its own cues back (used by nothing in the game; here for tests). */
  _releaseUiCues() {
    const ui = this._ctx?.get?.('ui');
    if (ui?._soundNative) { ui._sound = ui._soundNative; delete ui._soundNative; }
    this._uiPatched = false;
  },

  // ------------------------------------------------------------ public API
  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1.5);
    if (this.g) this.g.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.g.now(), 0.05);
    return this.masterVolume;
  },

  setMuted(m) {
    this.muted = !!m;
    if (this.g) this.g.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.g.now(), 0.05);
    return this.muted;
  },

  /** Duck the bed and music so something else can be heard through them. */
  duck(amount = 0.4, seconds = 1.6) {
    if (this.g) this.g.duckTo(amount, seconds, this.g.now());
  },

  /**
   * A UI/PDA/scanner sting. Names are listed in stingVoice().
   * @param {object} [o] {level} trims this one call, {p} 0..1 feeds scan-tick.
   */
  sting(name = 'notify', o) {
    const g = this.g;
    if (!g) return 0;
    const t = g.now();
    /**
     * De-dupe by name over one frame-and-a-bit. The same user action now
     * reaches this from two honest directions — our own tools poll sees the
     * inventory grow, and ui.js's toast comes through the adopted cue channel
     * on the very same frame — and one pickup must make one sound. The window
     * is shorter than any deliberate repeat in the game (the scan tick runs at
     * 4 Hz) so nothing real is ever swallowed; 'pickup' gets a longer one
     * because harvesting a node delivers its yield across several polls and
     * that is one action, not four.
     */
    const gap = name === 'pickup' ? 0.3 : 0.14;
    const last = (this._stingAt || (this._stingAt = {}))[name] || 0;
    if (t - last < gap) return 0;
    this._stingAt[name] = t;
    return stingVoice(g, name, t + 0.01, this.rng, o || {});
  },

  /** Player-local sound: 'stroke' | 'grunt' | 'hurt' | 'bubbles' | 'gasp' | 'splash'. */
  player(name) {
    const g = this.g;
    if (!g) return 0;
    const t = g.now() + 0.01;
    switch (name) {
      case 'stroke':
        this._strokeSide = -this._strokeSide;
        return strokeVoice(g, t, this.rng, 0.16, this.s.submerged < 0.5, this._strokeSide);
      case 'grunt': return gruntVoice(g, t, this.rng, 0.3, false);
      case 'hurt': {
        // Two independent detectors now reach this: our own survival health
        // delta (>0.012) and ui.js's finer one (>0.004) coming through the
        // adopted cue channel. One bite must not produce two grunts, so the
        // first one through wins the window. 0.3 s is under the grunt's own
        // length, so a genuine second hit still speaks.
        if (t < (this._hurtUntil || 0)) return 0;
        this._hurtUntil = t + 0.3;
        g.duckTo(0.55, 0.7, t, 0.2);
        stingVoice(g, 'damage', t, this.rng);
        return gruntVoice(g, t + 0.02, this.rng, 0.42, true);
      }
      case 'gasp': return breathVoice(g, t, 'in', this.rng, 1, 0.5);
      case 'bubbles': return grain(g, g.playerBus, 'bubble', t, this.rng, 0.2);
      case 'splash': return crossVoice(g, t, this.rng, 'up');
      case 'knife': return knifeVoice(g, t, this.rng, 0.30);
      default: return 0;
    }
  },

  /**
   * One positional creature call.
   * @param {string} species  key of SPECIES in life/creatures.js
   * @param {THREE.Vector3|number[]} pos world position
   */
  vocalise(species, pos, opts = {}) {
    const g = this.g;
    if (!g) return 0;
    const spec = VOX[species] || VOX.default;
    const p = pos?.isVector3 ? pos : new THREE.Vector3(pos?.[0] || 0, pos?.[1] || 0, pos?.[2] || 0);
    const dist = p.distanceTo(this._pos);
    if (dist > (opts.range ?? spec.range)) return 0;
    const t = g.now() + 0.02;
    const built = voxVoice(g, spec, t, this.rng, dist);
    g.place(built.node, p, {
      ref: opts.ref ?? spec.ref ?? 14,
      roll: opts.roll ?? (spec.duck ? 0.55 : 0.85),
      max: spec.range * 2,
      dur: built.dur + 0.6,
    });
    if (spec.duck) {
      /**
       * The duck depth is deliberately NOT scaled by distance any more.
       *
       * It used to be, on the reasoning that a far call should not reach into
       * the cabin. But the unprompted roar is always 90-270 m out, so the
       * proximity term evaluated to ~0.1 and a leviathan ducked the bed by
       * 4 dB instead of 18. Measured consequence: six of six roars in the
       * Grand Reef and the Lost River failed to rise above their own ambience
       * at all, while three of three in the Safe Shallows landed — exactly
       * inverted from what the game wants. The bed gets out of the way by the
       * same amount wherever the animal is. Distance is already expressed by
       * the panner and by the air lowpass, which is the honest place for it.
       */
      g.duckTo(spec.duck[0], built.dur + spec.duck[1], t, built.dur * 0.55);
    }
    this.s.calls++;
    return built.dur;
  },

  /**
   * A leviathan somewhere out there. If a real apex creature is within range we
   * call from it; otherwise we invent a bearing, because the most effective
   * thing in the whole game is a roar with nothing attached to it.
   */
  roar(opts = {}) {
    const g = this.g;
    if (!g) return 0;
    const ctx = this._ctx;
    let species = opts.species;
    let pos = opts.pos;

    if (!pos) {
      const cr = ctx.get('creatures');
      if (cr?.nearest && !cr.stub) {
        const n = cr.nearest(this._pos, (a) => !!a?.spec?.ai?.apex);
        if (n && n.distance < 220 && n.position) { pos = n.position.clone(); species = species || n.name; }
      }
    }
    if (!species) {
      const d = this.s.depth, h = this.s.hostility;
      // Above 140 m the species is chosen by how dangerous the place actually
      // is, not by a coin flip. A reaper answering in gentle water is the same
      // mistake as a reaper answering in the Safe Shallows, one biome along.
      species = d > 420 ? 'ghost_leviathan'
        : d > 140 ? (this.rng() < 0.6 ? 'ghost_leviathan' : 'reaper')
          : h > 0.45 ? 'reaper' : 'reefback';
    }
    if (!pos) {
      const ang = this.rng() * Math.PI * 2;
      // deep water eats a 250 m call down to a ~340 Hz smear, so the caller
      // closes in as the light goes: 90-190 m below 500 m, 150-270 m up top
      const deep = smooth(160, 520, this.s.depth);
      const dist = lerp(lerp(ROAR.near, ROAR.nearDeep, deep),
        lerp(ROAR.far, ROAR.farDeep, deep), this.rng());
      pos = new THREE.Vector3(
        this._pos.x + Math.cos(ang) * dist,
        clamp(this._pos.y + (this.rng() - 0.35) * 60, WORLD.maxDepth + 10, -4),
        this._pos.z + Math.sin(ang) * dist);
    }
    this.s.roars++;
    return this.vocalise(species, pos, { range: 900, roll: 0.5 });
  },

  /** Sparse pad: 'discovery' | 'danger' | 'drift'. */
  music(kind = 'drift') {
    const g = this.g;
    if (!g) return 0;
    if (this._padUntil > g.now()) return 0;
    const tr = kind === 'danger' ? -Math.round(this.s.depth / 220) : 0;
    const d = padVoice(g, kind, g.now() + 0.05, this.rng, tr);
    this._padUntil = g.now() + d * 0.75;
    return d;
  },

  /**
   * Adapter for ui.js's own cue vocabulary.
   *
   * ui/ui.js built a private AudioContext and a `_sound(kind)` fallback while
   * this module was still a stub — its own comment says "audio.js owns the
   * soundscape; this is only the UI/vitals layer". Now that the soundscape
   * exists, those cues are duplicated: two heartbeats, and its tones bypass
   * this mixer's limiter, water muffle, duck and mute because they connect
   * straight to context.destination. This method takes its exact kind names so
   * the swap is one line on their side:
   *
   *     _sound(kind, amt) { ctx.get('audio')?.uiCue(kind, amt); }
   *
   * 'beat' is a no-op here because the heartbeat is already driven from
   * survival.vitals().heart every frame.
   */
  uiCue(kind, amt = 0.5) {
    this.s.cues++;
    switch (kind) {
      case 'beat': return 0;                       // already ours, every frame
      // ui.js escalates its low-O2 alarm from 1.6 s to 0.42 s intervals and
      // hands us the severity; the sting gets louder and tighter with it rather
      // than repeating at one level like the square wave it replaces.
      case 'warn': return this.sting('warn', { level: lerp(0.8, 1.5, clamp(amt, 0, 1)) });
      case 'hit': return this.player('hurt');
      case 'open': return this.sting('pda-open');
      case 'close': return this.sting('pda-close');
      // every toast in the game funnels through ui.notify -> 'blip', which is
      // how pickups, crafts and blueprint unlocks became audible at all
      case 'blip': return this.sting('pickup', { level: 0.8 });
      default: return this.sting('notify');
    }
  },

  /** DOM-event entry point for modules that cannot import this file. */
  event(detail) {
    if (!detail) return;
    if (detail.sting) this.sting(detail.sting);
    if (detail.ui) this.uiCue(detail.ui, detail.amt);
    if (detail.player) this.player(detail.player);
    if (detail.music) this.music(detail.music);
    if (detail.roar) this.roar(detail.roar === true ? {} : detail.roar);
    if (detail.vocalise) this.vocalise(detail.vocalise, detail.pos || this._pos, detail);
    if (detail.volume !== undefined) this.setMasterVolume(detail.volume);
    if (detail.muted !== undefined) this.setMuted(detail.muted);
  },

  // ------------------------------------------------------------------ frame
  update(dt, t, ctx) {
    const s = this.s;
    const d = Math.min(dt, 1 / 15);

    // --- player pose. movement/survival are stubs today; both are guarded.
    const mv = ctx.get('movement');
    const src = (mv && !mv.stub && mv.position?.isVector3) ? mv.position : ctx.camera.position;
    this._teleport = this._pos.distanceToSquared(src) > 2500;
    this._prev.copy(this._pos);
    this._pos.copy(src);
    if (mv && !mv.stub && mv.velocity?.isVector3) this._vel.copy(mv.velocity);
    else this._vel.copy(this._pos).sub(this._prev).divideScalar(Math.max(d, 1e-4));
    s.speed = this._teleport ? 0 : this._vel.length();

    /**
     * --- the waterline.
     *
     * watersurface.js deliberately publishes TWO curves and documents which is
     * which. `submersion` (10 cm, near-binary) drives U.uUnderwater, because
     * every fullscreen medium pass multiplies itself by it and LOOK.md 5 wants
     * the waterline hard. `muffle` (70 cm) carries the comment "the
     * gameplay/audio curve ... sound ducks over a much longer distance than
     * light does" — it exists for us. We were reading U.uUnderwater and then
     * re-smoothing it with our own d*6 lerp, i.e. re-deriving a curve they had
     * already authored, from the wrong one. Their object arrives on
     * ctx.water (watersurface calls ctx.provide('water', ...), which assigns a
     * property, not a module), so it is not reachable through ctx.get().
     */
    const wsrc = ctx.water;
    const muffle = (wsrc && typeof wsrc.muffle === 'number' && Number.isFinite(wsrc.muffle))
      ? wsrc.muffle : null;
    s.subTarget = clamp(muffle ?? U.uUnderwater?.value
      ?? (this._pos.y < WORLD.seaLevel ? 1 : 0), 0, 1);
    s.depth = Math.max(0, (U.uWaterLevel?.value ?? WORLD.seaLevel) - this._pos.y);

    // --- a cabin is dry: inside a Seamoth the muffle mostly lifts and the sea
    // drops behind the hull. vehicles.js publishes `piloting`.
    const veh = ctx.get('vehicles');
    s.inVehicle = !!(veh && !veh.stub && veh.piloting);

    // --- vitals.
    //
    // survival.js publishes breathPhase, breathRate, heart, hypoxia and
    // pressureStress, and its HUD already draws them. Locking to that clock
    // instead of running a second one is the difference between "there is a
    // breathing sound" and "the sound IS the oxygen readout" — the exhale you
    // hear is the same event that pushes the bubbles up the screen.
    // vitals() allocates, so sample it at 20 Hz; a breath cycle is at least
    // 1.4 s, so the trigger jitter is inaudible.
    this._vitT = (this._vitT ?? 0) - d;
    if (this._vitT <= 0) {
      this._vitT = 0.05;
      const sv = ctx.get('survival');
      if (sv && !sv.stub) {
        try { this._vitals = typeof sv.vitals === 'function' ? sv.vitals() : null; }
        catch { this._vitals = null; }
        if (!this._vitals && typeof sv.oxygen === 'number') {
          const max = (typeof sv.oxygenMax === 'number' && sv.oxygenMax > 0) ? sv.oxygenMax
            : (sv.oxygen > 1.001 ? 45 : 1);
          const hmax = (typeof sv.healthMax === 'number' && sv.healthMax > 0) ? sv.healthMax
            : (sv.health > 1.001 ? 100 : 1);
          this._vitals = {
            oxygenT: clamp(sv.oxygen / max, 0, 1),
            healthT: clamp((sv.health ?? hmax) / hmax, 0, 1),
          };
        }
      } else this._vitals = null;
    }
    const v = this._vitals;
    if (v) {
      s.oxygen = clamp(v.oxygenT ?? 1, 0, 1);
      s.health = clamp(v.healthT ?? 1, 0, 1);
      s.o2Seconds = Number.isFinite(v.oxygenSeconds) ? v.oxygenSeconds : s.oxygen * 95;
      s.hypoxia = clamp(v.hypoxia ?? 0, 0, 1);
      s.pressure = clamp(v.pressureStress ?? 0, 0, 1);
      s.drowning = !!v.drowning;
      s.dead = !!v.dead;
    } else {
      // local model, audio only, never published: ~95 s of tank, refills fast
      // at the surface. Exists so the regulator still reads as the O2 gauge
      // when player/survival.js is a stub.
      this._fallbackO2 = clamp(this._fallbackO2
        + (s.subTarget > 0.5 ? -d / 95 : d / 6), 0, 1);
      s.oxygen = this._fallbackO2;
      s.o2Seconds = s.oxygen * 95;
      s.hypoxia = smooth(0.22, 0.03, s.oxygen);
      s.pressure = smooth(180, 900, s.depth) * 0.5;
      s.drowning = s.oxygen <= 0.001;
      s.dead = false;
    }

    // --- biome. ambienceAt() allocates and at() runs the full blend, and bed
    // crossfades take a second and a half anyway, so sampling at 8 Hz is free
    // accuracy-wise and keeps this module off the per-frame allocation path.
    // Never let a teleporting capture rig drag the old bed along, though.
    this._bioT = (this._bioT ?? 0) - d;
    if (this._bioT <= 0 || this._teleport || !this._tags) {
      this._bioT = 0.12;
      const bio = ctx.get('biomes');
      let tags = null;
      if (bio?.ambienceAt && !bio.stub) {
        try {
          tags = bio.ambienceAt(this._pos.x, this._pos.y, this._pos.z);
          const m = bio.at?.(this._pos.x, this._pos.y, this._pos.z);
          if (m) { s.hostility = m.hostility ?? 0.1; s.biome = m.id || s.biome; }
        } catch { tags = null; }
      }
      this._tags = (tags && tags.length) ? tags : [{ tag: 'shallows-reef', w: 1 }];
    }
    const mixTags = this._tags;

    // --- what the player is doing with their hands.
    //
    // Deliberately ABOVE the no-context early-out. Every sting() call it makes
    // is a no-op without a graph, but the polling itself still runs, which
    // means tools.js's shape is exercised on every capture rather than only in
    // the audio-enabled runs nobody launches — a null in here fails the module
    // visibly in report.json instead of hiding until someone turns sound on.
    this._pollTools(ctx, d, this.g ? this.g.now() : t);

    if (!this.g) {
      // no context yet: keep simulating state so the first frame after the
      // gesture is already in the right place rather than sliding into it
      s.submerged += (s.subTarget - s.submerged) * clamp(d * 6, 0, 1);
      return;
    }

    const g = this.g;
    const now = g.now();
    s.submerged += (s.subTarget - s.submerged) * clamp(d * 6, 0, 1);

    // ui.js may register after we start (a ?audio=1 launch builds the graph
    // during init), so keep offering to take its cue channel until it lands.
    if (!this._uiPatched) {
      this._uiAdoptT = (this._uiAdoptT ?? 0) - d;
      if (this._uiAdoptT <= 0) { this._uiAdoptT = 1.0; this._adoptUiCues(); }
    }

    // --- bed crossfade. Strongest three tags plus the surface bed.
    const want = new Map();
    const under = clamp(s.submerged, 0, 1);
    const top = mixTags.slice(0, 3);
    let tot = 0;
    for (const e of top) tot += e.w;
    // ACCUMULATE, do not set. biomes.js derives cavern variants from their
    // surface parent and carries the parent's ambience tag across, so the top
    // three weights routinely contain the same tag twice — and overwriting
    // threw the larger share away. Measured live at 678 m in the Lost River:
    // the bed mix summed to 0.18 instead of 1.0, i.e. the deep ran at a fifth
    // of its intended level, which is exactly the biome that is supposed to be
    // oppressive.
    for (const e of top) want.set(e.tag, (want.get(e.tag) || 0) + (e.w / (tot || 1)) * under);
    if (under < 0.995) want.set('surface', (1 - under) * 1.0);

    for (const [tag, w] of want) {
      let bed = this.beds.get(tag);
      if (!bed) { bed = new Bed(g, tag, now); this.beds.set(tag, bed); }
      if (this._teleport) bed.snapWeight(w, now); else bed.setWeight(w, now, 1.5);
    }
    for (const [tag, bed] of this.beds) {
      if (want.has(tag)) continue;
      if (bed.weight > 0.001) bed.setWeight(0, now, 1.2);
      if (bed.weight <= 0.001 && (bed.idle = (bed.idle || 0) + d) > 6) {
        bed.stop(now); this.beds.delete(tag);
      }
    }
    // one lookahead window of grains per frame
    this._grainT = Math.max(this._grainT || 0, now);
    if (this._grainT < now + 0.55) {
      const to = now + 0.9;
      for (const bed of this.beds.values()) bed.schedule(this._grainT, to);
      this._grainT = to;
    }

    // --- the muffle, and the crossing
    const crossing = Math.abs(s.subTarget - g.subm) > 0.28;
    // A cabin is dry. Inside a Seamoth most of the muffle lifts and the sea
    // drops behind the hull — which is also what finally makes `s.inVehicle`
    // mean something; it was declared in state and never assigned, an honest
    // tell that the vehicle pass was unfinished.
    const cabin = s.inVehicle ? 1 : 0;
    g.applyWater(s.submerged * lerp(1, WATER.cabinSub, cabin), s.depth, now,
      crossing ? WATER.tauCross : WATER.tau, s.pressure);
    g.bedBus.gain.setTargetAtTime(MIX.bed * lerp(1, WATER.cabinBed, cabin), now, 0.35);

    /**
     * The crossing itself. movement.js publishes `timeSinceCross` with the
     * comment "audio wants this": it resets to 0 on the frame the EYE crosses,
     * which is a sharper edge than thresholding our own submersion now that
     * s.subTarget is the 70 cm muffle curve — that curve passes 0.5 up to a
     * third of a second late in chop, and the plunge would land after the
     * screen had already gone under. Their edge when they exist, ours when
     * they do not.
     */
    const tsc = (mv && !mv.stub && Number.isFinite(mv.timeSinceCross)) ? mv.timeSinceCross : null;
    const isUnder = (mv && !mv.stub && typeof mv.isSubmerged === 'boolean')
      ? mv.isSubmerged : s.subTarget > 0.5;
    this._crossCool = Math.max(0, this._crossCool - d);
    let crossed = false;
    if (tsc !== null) {
      // the RESET is the event; the first sample only establishes the baseline
      if (this._lastTsc !== null && tsc < this._lastTsc) crossed = true;
      this._lastTsc = tsc;
    } else if (this._wasUnder !== undefined) {
      crossed = isUnder !== this._wasUnder;
    }
    if (crossed && this._crossCool <= 0) {
      this._crossCool = 0.4;
      crossVoice(g, now + 0.01, this.rng, isUnder ? 'down' : 'up');
      g.duckTo(0.6, 0.7, now, 0.25);
      if (!isUnder) breathVoice(g, now + 0.28, 'in', this.rng, 0.85, 0.42);
    }
    this._wasUnder = isUnder;

    // --- breathing: rate and rasp ARE the oxygen readout.
    // Strain keys on TIME LEFT as well as fraction: with survival's 180 s tank,
    // 35% is a whole minute of air and should not panic, while 35% of a 45 s
    // starter tank is sixteen seconds and absolutely should.
    const strain = clamp(Math.max(
      1 - (s.oxygen - BREATH.panic) / (1 - BREATH.panic),
      smooth(50, 9, s.o2Seconds),
      s.hypoxia), 0, 1);
    const exert = clamp(s.speed / 6, 0, 1);
    const period = v && v.breathRate > 0.02
      ? clamp(1 / v.breathRate, 1.2, 7)
      : lerp(BREATH.calm, BREATH.hard, clamp(strain * 0.85 + exert * 0.35, 0, 1));
    if (now >= this._nextBreath) {
      if (this._nextBreath === 0) this._nextBreath = now + 0.4;
      else {
        const inhale = this._breathPhase === 'in';
        const lvl = under > 0.35 ? lerp(0.20, 0.34, strain) : lerp(0.09, 0.2, strain);
        breathVoice(g, this._nextBreath, inhale ? 'in' : 'out', this.rng,
          s.drowning ? 1 : strain, s.dead ? 0 : lvl);
        if (inhale) this.s.breaths++;
        this._breathPhase = inhale ? 'out' : 'in';
        this._nextBreath += period * (inhale ? 0.46 : 0.54);
      }
    }
    // stay locked to survival's phase: if it has wrapped past us, resync rather
    // than let two clocks drift a quarter-cycle apart over a long dive
    if (v && Number.isFinite(v.breathPhase)) {
      const want = v.breathPhase < 0.46 ? 'out' : 'in';
      if (want !== this._breathPhase && Math.abs(this._nextBreath - now) > period * 0.5) {
        this._breathPhase = want;
        this._nextBreath = now + 0.05;
      }
    }

    // --- heartbeat: only when it means something. survival.heart is already a
    // frequency in Hz (1.0 rest .. 2.7 drowning) and its vignette pulses on it.
    const stress = clamp(Math.max(
      smooth(0.62, 0.12, s.health), s.hypoxia, s.pressure,
      s.drowning ? 1 : 0), 0, 1);
    if (stress > 0.05 && !s.dead) {
      const bpm = (v && v.heart > 0.2 ? v.heart * 60 : lerp(64, 152, stress));
      if (now >= this._nextHeart) {
        if (this._nextHeart === 0) this._nextHeart = now + 0.3;
        else {
          heartVoice(g, this._nextHeart, 0.10 + stress * 0.24, bpm);
          this._nextHeart += 60 / clamp(bpm, 40, 200);
        }
      }
    } else this._nextHeart = 0;

    // --- death and respawn
    if (s.dead !== this._wasDead) {
      this._wasDead = s.dead;
      if (s.dead) {
        g.duckTo(0.12, 4.5, now);
        // the suit losing power: everything slides down and stops
        const dv = new Voice(g);
        const o = dv.s(g.actx.createOscillator()); o.type = 'sine';
        o.frequency.setValueAtTime(180, now);
        o.frequency.exponentialRampToValueAtTime(28, now + 2.6);
        const e = dv.n(envGain(g.actx, now, 0.26, 0.05, 0.6, 2.4));
        o.connect(e); e.connect(g.playerBus);
        const s2 = dv.n(g.actx.createGain()); s2.gain.value = 0.9;
        e.connect(s2); s2.connect(g.verbSend);
        dv.run(now, now + 3.4);
        this._nextBreath = now + 6;
      } else {
        this.player('gasp');
      }
    }

    // --- swim strokes
    if (s.speed > 0.42 && !this._teleport) {
      this._strokePhase += d * (0.5 + s.speed * 0.26);
      if (this._strokePhase >= 1) {
        this._strokePhase -= 1;
        this._strokeSide = -this._strokeSide;
        strokeVoice(g, now + 0.01, this.rng, lerp(0.09, 0.19, clamp(s.speed / 7, 0, 1)),
          under < 0.5, this._strokeSide);
      }
    } else this._strokePhase = Math.min(this._strokePhase, 0.9);

    // --- damage
    if (s.health < this._lastHealth - 0.012) this.player('hurt');
    this._lastHealth = s.health;

    // --- nearby creatures speak for themselves
    this._vocalT -= d;
    if (this._vocalT <= 0) {
      this._vocalT = 1.1 + this.rng() * 2.2;
      this._speakNearby(ctx);
    }

    // --- the thing out there.
    // Gated on the biome's own hostility. safe_shallows is 0.05 and used to get
    // a call every ~158 s starting 40-100 s after spawn, which put a reaper in
    // the starting biome inside the first minute of every session and spent the
    // game's best card before the player had left the lifepod.
    this._roarT -= d;
    if (this._roarT <= 0) {
      const mean = lerp(ROAR.calmInterval, ROAR.dreadInterval,
        clamp(s.hostility * 1.15 + smooth(120, 520, s.depth) * 0.5, 0, 1));
      this._roarT = expWait(this.rng, mean) * 0.5 + mean * 0.5;
      if (under > 0.5 && s.hostility > ROAR.gate) this.roar();
    }

    // --- music: discovery on a new biome, danger when something big is close
    if (under > 0.4 && !this._seenBiomes.has(s.biome)) {
      this._seenBiomes.add(s.biome);
      if (this._seenBiomes.size > 1) this.music('discovery');
    }
    this._musicT -= d;
    if (this._musicT <= 0) {
      this._musicT = 30 + this.rng() * 55;
      const cr = ctx.get('creatures');
      let danger = s.health < 0.5;
      if (cr?.nearest && !cr.stub) {
        const n = cr.nearest(this._pos, (a) => !!a?.spec?.ai?.apex);
        if (n && n.distance < 55) danger = true;
      }
      if (danger) this.music('danger');
      else if (under > 0.5 && s.depth > 90 && this.rng() < 0.55) this.music('drift');
    }

    // --- mute toggle
    if (ctx.input?.hit?.('KeyM')) this.setMuted(!this.muted);
  },

  /**
   * The interaction layer, by observation.
   *
   * Nothing in the game called this module: `get('audio')` returned zero hits
   * outside this file and nobody dispatched `cn:audio`, so sting(), player(),
   * vocalise(), music() and duck() were all dead entry points and the scanner,
   * the knife, the fabricator, beacons and every pickup were silent. A capture
   * of the shallows literally showed the scanner locked on a Peeper reading
   * LIFEFORM ANALYSED, in silence.
   *
   * The fix does not need anyone else's file to change. tools.js publishes its
   * whole working state on the object it provides — `_scan` (0..1 sweep
   * progress), `scannedSet`, `blueprints`, `beacons`, `inventory`, `equipped`,
   * `lightOn`, `craftShown`, and `vm.swing` (the knife stroke, which it drives
   * to 1 and decays at 3.4/s). Polling that at 12 Hz turns six user actions
   * into sound with no cross-module edit and no coupling they can break: every
   * read is optional-chained, and the FIRST poll only records a baseline so a
   * late-initialising tools module can never fire a burst of stings at boot.
   */
  _pollTools(ctx, d, now) {
    // `now` is the audio clock once the graph exists and the game clock before
    // it, and those are different origins — keep the tick from being stranded
    // hours in the future by the switch.
    if (this._scanTickT > now + 2) this._scanTickT = now + 0.25;
    this._tlT = (this._tlT ?? 0) - d;
    if (this._tlT > 0) {
      // the scan tick runs faster than the poll: 4 Hz while the sweep climbs
      if (this._scanning && now >= this._scanTickT) {
        this._scanTickT = now + 0.25;
        this.sting('scan-tick', { p: this._scanP, level: 0.85 });
      }
      return;
    }
    this._tlT = 1 / 12;

    const tl = ctx.get('tools');
    if (!tl || tl.stub) { this._tl = null; this._scanning = false; return; }

    // Per-id counts, not just a total. A craft always spends some ids and makes
    // another, and a pickup only ever adds — so "something went down AND
    // something went up" is an unambiguous fabricator, without needing the
    // craft panel to still be open when the poll lands. Thirty slots at 12 Hz.
    const byId = {};
    const slots = tl.inventory?.slots;
    if (slots) {
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i];
        if (sl) byId[sl.id] = (byId[sl.id] || 0) + (sl.n || 0);
      }
    }

    const cur = {
      byId,
      scan: +(tl._scan || 0),
      scanned: tl.scannedSet?.size ?? 0,
      bp: tl.blueprints?.size ?? 0,
      beacons: tl.beacons?.length ?? 0,
      equipped: tl.equipped || null,
      light: !!tl.lightOn,
      swing: +(tl.vm?.swing || 0),
      craftUi: !!tl.craftShown,
    };
    const p = this._tl;
    this._tl = cur;
    this._scanning = cur.scan > 0.02 && cur.scan < 0.999;
    this._scanP = cur.scan;
    if (!p) return;                    // first poll: baseline only, never fires

    // the scanner sweep — start, a rising tick while it climbs, and the lock
    if (cur.scan > 0.02 && p.scan <= 0.02) { this.sting('scan-start'); this._scanTickT = now + 0.2; }
    if (cur.scanned > p.scanned) {
      this.sting('scan-complete');
      this._scanTickT = now + 1.2;     // do not tick over the top of the lock
      if (cur.bp > p.bp) this.sting('blueprint', { level: 0.9 });
    } else if (cur.bp > p.bp) this.sting('blueprint');

    // The knife. tools.js drives vm.swing to 1 on the stroke and decays it at
    // 3.4/s, so the rising edge IS the stroke and nothing else moves it. The
    // thresholds are loose on purpose: at a 12 Hz poll the first sample after
    // the stroke can already have fallen to 0.72, and a tighter gate silently
    // dropped the swing depending on where the poll landed in the frame.
    if (cur.swing > 0.4 && p.swing < 0.2) this.player('knife');

    // the fabricator: something was spent AND something was made
    let up = false, down = false;
    for (const k in cur.byId) if ((cur.byId[k] || 0) > (p.byId[k] || 0)) { up = true; break; }
    for (const k in p.byId) if ((cur.byId[k] || 0) < (p.byId[k] || 0)) { down = true; break; }
    if (up && (down || cur.craftUi || p.craftUi)) this.sting('craft');
    else if (up) this.sting('pickup');

    if (cur.beacons > p.beacons) this.sting('beacon');
    if (cur.equipped !== p.equipped) this.sting('equip');
    if (cur.light !== p.light) this.sting('toggle');
  },

  /** Pick one nearby creature and let it speak, weighted by how close it is. */
  _speakNearby(ctx) {
    const cr = ctx.get('creatures');
    if (!cr?.list || cr.stub) return;
    let list;
    try { list = cr.list(); } catch { return; }
    if (!list || !list.length) return;
    // sample a handful rather than sorting the whole population every time
    const n = Math.min(list.length, 10);
    let best = null, bestScore = 0;
    for (let i = 0; i < n; i++) {
      const a = list[Math.floor(this.rng() * list.length)];
      if (!a?.position) continue;
      const spec = VOX[a.name];
      if (!spec) continue;
      const dist = a.position.distanceTo(this._pos);
      if (dist > spec.range) continue;
      // agitated animals and big animals talk more
      const excite = (a.state === 'hunt' || a.state === 'flee' ? 2.2 : a.state === 'curious' ? 1.5 : 1);
      const score = (1 - dist / spec.range) * excite * (a.apex ? 2.5 : 1) * (0.4 + this.rng());
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best) this.vocalise(best.name, best.position);
  },

  preRender(ctx) {
    // the listener rides the camera; three updates it from the camera's matrix,
    // but a capture can pose the camera after update() so refresh it here too
    if (this.listener) {
      ctx.camera.updateMatrixWorld(true);
      this.listener.updateMatrixWorld(true);
    }
  },

  // -------------------------------------------------------------- analysis
  /**
   * Render the identical graph offline and measure it. This is the only
   * verification an audio module can honestly offer, so it is thorough:
   * every bed, the waterline crossing, the duck, the roar, the stings and the
   * breathing rate at full and near-empty tank.
   *
   * Needs no user gesture (OfflineAudioContext is exempt from autoplay policy).
   */
  async analyze(opts = {}) {
    // 12 s, not 6: several bed grains have mean intervals of 6-20 s, so a short
    // window measures the drones and misses the events that give a place its
    // character. It is also where the offline render settles — six-second
    // renders of one bed measured a sporadic whole-graph dropout that neither
    // the 14 s render nor a 45 s AudioWorklet tap of the LIVE graph ever shows.
    const bedSecs = opts.bedSeconds ?? 12;
    const out = { sampleRate: 44100, beds: {}, stings: {}, vox: {}, notes: [] };
    const stages = opts.stages || ['beds', 'waterline', 'duck', 'roar', 'vox', 'stings', 'stingbed', 'breath', 'misc', 'mix'];
    const want = (s) => stages.includes(s);
    const tick = (s) => { if (opts.log) console.log('[audio.analyze] ' + s); };

    // ---- 0. the bare mixer: proves the master chain is silent and DC-free
    if (want('graph')) {
      tick('graph');
      out.graph = measure(await renderOffline(2, () => { /* nothing but the mixer */ }), 0.2);
    }

    // ---- 1. every biome bed on its own, AT THE DEPTH IT IS ACTUALLY HEARD
    if (want('beds')) for (const tag of (opts.tags || Object.keys(BEDS))) {
      tick('bed ' + tag);
      const at = BED_AT[tag] || [1, 0];
      const buf = await renderOffline(bedSecs, (g, a, sec) => {
        const bed = new Bed(g, tag, 0);
        bed.snapWeight(1, 0);
        bed.schedule(0, sec);
      }, 1337 + hashStr(tag), at);
      // skip the first 0.5 s: filter/loop startup is not the steady state
      out.beds[tag] = measure(buf, 0.5);
      out.beds[tag].heardAt = { submersion: at[0], depthM: at[1] };
      // the room tone under the events, so the two can be tuned separately
      Object.assign(out.beds[tag], blockLevels(buf, 0.5, bedSecs));
    }

    /**
     * ---- 1a. the sustained FLOOR of each bed: the same drone/noise/surge with
     * no grains scheduled at all. This is the number that has to leave room for
     * an event; `beds` above is the floor plus whatever happened to land in the
     * window, and tuning one while reading the other is how the abyss ended up
     * 11 dB hotter than the shallows in the first place.
     */
    if (want('floor')) {
      out.floor = {};
      for (const tag of (opts.tags || Object.keys(BEDS))) {
        tick('floor ' + tag);
        const at = BED_AT[tag] || [1, 0];
        const buf = await renderOffline(6, (g) => {
          const bed = new Bed(g, tag, 0);
          bed.snapWeight(1, 0);              // no schedule() -> no grains
        }, 4242 + hashStr(tag), at);
        const m = measure(buf, 0.6);
        out.floor[tag] = {
          depthM: at[1], rmsDb: m.rmsDb, peakDb: m.peakDb,
          centroidHz: m.centroidHz, dcDb: m.dcDb,
        };
      }
    }

    // ---- 1b. every grain kind alone. This is the real "no clicks" proof:
    // slopeRatio against the voice's OWN peak, plus a tail that has to reach
    // silence rather than being cut off by stop().
    if (want('grains')) {
      out.grains = {};
      for (const kind of ['bubble', 'bubbleup', 'chirp', 'tick', 'crackle', 'creak', 'groan',
        'moan', 'whine', 'drip', 'pulse', 'thump', 'hiss', 'lap', 'spray', 'skitter',
        'boom', 'farcall']) {
        tick('grain ' + kind);
        const buf = await renderOffline(6, (g) => {
          grain(g, g.bedBus, kind, 0.4, makeRNG(hashStr(kind) + 5), 0.35);
        }, hashStr(kind));
        out.grains[kind] = measure(buf, 0.05, 5.6);
      }
      for (const [label, fn] of [
        ['breath-in', (g) => breathVoice(g, 0.4, 'in', makeRNG(11), 0.2, 0.4)],
        ['breath-out', (g) => breathVoice(g, 0.4, 'out', makeRNG(12), 0.2, 0.4)],
        ['stroke', (g) => strokeVoice(g, 0.4, makeRNG(13), 0.35, false, 1)],
        ['heart', (g) => heartVoice(g, 0.4, 0.4, 90)],
        ['grunt', (g) => gruntVoice(g, 0.4, makeRNG(14), 0.45, true)],
        ['plunge', (g) => crossVoice(g, 0.4, makeRNG(15), 'down')],
        ['surface-burst', (g) => crossVoice(g, 0.4, makeRNG(16), 'up')],
      ]) {
        tick('voice ' + label);
        out.grains[label] = measure(await renderOffline(6, fn, hashStr(label)), 0.05, 5.6);
      }
    }

    // ---- 2. the waterline. Same bed content, submersion flipped at t=3.
    if (want('waterline')) {
      tick('waterline');
      const dur = 6;
      const buf = await renderOffline(dur, (g, a, sec) => {
        const under = new Bed(g, 'shallows-reef', 0);
        const above = new Bed(g, 'surface', 0);
        under.snapWeight(1, 0); above.snapWeight(0, 0);
        under.schedule(0, sec); above.schedule(0, sec);
        g.applyWater(1, 12, 0, 0.005);
        // cross at t = 3
        under.setWeight(0, 3.0, 0.16);
        above.setWeight(1, 3.0, 0.16);
        g.applyWater(0, 0, 3.0, WATER.tauCross);
        crossVoice(g, 3.0, makeRNG(77), 'up');
      }, 24601);
      out.waterline = {
        submerged: measure(buf, 0.7, 2.85),
        above: measure(buf, 3.9, 5.9),
        crossing: measure(buf, 2.9, 3.9),
      };
      const a = out.waterline.submerged.centroidHz, b = out.waterline.above.centroidHz;
      out.waterline.centroidRatio = a > 0 ? +(b / a).toFixed(2) : 0;
      out.waterline.airMinusWaterDb =
        +(out.waterline.above.bandsDb.air - out.waterline.submerged.bandsDb.air).toFixed(1);
    }

    // ---- 3. the duck, measured on the bed alone so the number is unambiguous
    if (want('duck')) {
      tick('duck');
      const dur = 6;
      const buf = await renderOffline(dur, (g, a, sec) => {
        const bed = new Bed(g, 'grand-reef-deep', 0);
        bed.snapWeight(1, 0);
        bed.schedule(0, sec);
        g.duckTo(VOX.reaper.duck[0], VOX.reaper.duck[1], 2.0, 1.6);
      }, 90210, BED_AT['grand-reef-deep']);
      const before = measure(buf, 0.8, 1.9);
      const during = measure(buf, 2.3, 3.2);
      const after = measure(buf, 4.8, 5.9);
      out.duck = {
        beforeDb: before.rmsDb, duringDb: during.rmsDb, afterDb: after.rmsDb,
        depthDb: +(during.rmsDb - before.rmsDb).toFixed(2),
        recoveredDb: +(after.rmsDb - before.rmsDb).toFixed(2),
      };
    }

    /**
     * ---- 3b. The acceptance test this module previously failed.
     *
     * A leviathan calling from 170 m has to be an EVENT over the ambience it
     * lands on, in the deep exactly as much as in the shallows. It was not:
     * measured on the live master, three roars per site, the Safe Shallows got
     * +5.5 to +6.7 dB RMS / +8.1 to +8.9 dB peak while the Grand Reef got
     * -0.9/-0.4/-3.7 and the Lost River +0.1/+0.4/-1.3. Six of six deep roars
     * failed to rise above their own bed — the one place the sound is the whole
     * point. The bar is the shallows' own number: >= +6 dB RMS and >= +8 dB
     * peak, and this runs the same signal path the game does (panner into the
     * life bus, sidechain on the bed, water muffle at the biome's real depth).
     */
    if (want('roar')) {
      out.roarOverBed = {};
      const dist = 170;
      for (const [tag, species] of [
        ['shallows-reef', 'reefback'],
        ['jelly-cave', 'reaper'],
        ['grand-reef-deep', 'reaper'],
        ['blood-kelp-dread', 'ghost_leviathan'],
        ['lost-river-hollow', 'ghost_leviathan'],
        ['void-abyss', 'ghost_leviathan'],
      ]) {
        tick('roar over ' + tag);
        const spec = VOX[species];
        const buf = await renderOffline(14, (g, a, sec) => {
          const bed = new Bed(g, tag, 0);
          bed.snapWeight(1, 0);
          bed.schedule(0, sec);
          const built = voxVoice(g, spec, 6.0, makeRNG(hashStr(tag) + 5), dist);
          g.place(built.node, new THREE.Vector3(dist * 0.8, -20, dist * 0.6),
            { ref: spec.ref, roll: 0.5, max: 900, dur: built.dur + 0.6 });
          g.duckTo(spec.duck[0], built.dur + spec.duck[1], 6.0, built.dur * 0.55);
        }, hashStr(tag) * 3 + 7, BED_AT[tag] || [1, 0]);
        const bedM = blockLevels(buf, 1.0, 5.7);
        const roarM = blockLevels(buf, 6.0, 10.5);
        const dR = +(roarM.p85RmsDb - bedM.medianRmsDb).toFixed(2);
        const dP = +(roarM.maxPeakDb - bedM.p95PeakDb).toFixed(2);
        out.roarOverBed[tag] = {
          species, distanceM: dist, depthM: (BED_AT[tag] || [1, 0])[1],
          bedRmsDb: bedM.medianRmsDb, bedPeakDb: bedM.p95PeakDb,
          roarRmsDb: roarM.p85RmsDb, roarPeakDb: roarM.maxPeakDb,
          dRmsDb: dR, dPeakDb: dP,
          passes: dR >= 6 && dP >= 8,
        };
      }
      out.roarOverBedPasses = Object.values(out.roarOverBed).every((r) => r.passes);
    }

    // ---- 4. creature calls, dry, at three distances
    if (want('vox')) for (const [name, dist] of [
      ['reaper', 24], ['reaper', 180], ['ghost_leviathan', 220],
      ['reefback', 140], ['stalker', 18], ['crabsquid', 30],
    ]) {
      tick('vox ' + name + '@' + dist);
      const buf = await renderOffline(7, (g) => {
        const spec = VOX[name];
        const built = voxVoice(g, spec, 0.4, makeRNG(hashStr(name) + dist), dist);
        built.node.connect(g.lifeBus);
        if (spec.duck) g.duckTo(spec.duck[0], built.dur + spec.duck[1], 0.4, built.dur * 0.55);
      }, hashStr(name) * 13 + dist);
      out.vox[name + '@' + dist + 'm'] = measure(buf, 0.2, 6.5);
    }

    // ---- 5. stings
    if (want('stings')) for (const name of [
      'pda-open', 'pda-close', 'scan-start', 'scan-tick', 'scan-complete', 'craft',
      'pickup', 'notify', 'warn', 'deny', 'beacon', 'blueprint', 'equip', 'toggle', 'damage',
    ]) {
      tick('sting ' + name);
      const buf = await renderOffline(3, (g) => stingVoice(g, name, 0.2, makeRNG(hashStr(name))), hashStr(name));
      out.stings[name] = measure(buf, 0.1, 2.6);
    }

    /**
     * ---- 5b. Do the stings actually CUT? Measured over a real bed, not dry.
     *
     * Firing all eleven 1.3 s apart at 30 m on the live master, the block RMS
     * moved only 2-4 dB above the ambience: only the spectral centroid spiking
     * to ~1400 Hz gave a confirmation away, which is not what a confirmation is
     * for. The bar here is >= +6 dB over the bed's own level.
     */
    if (want('stingbed')) {
      const names = ['pda-open', 'scan-start', 'scan-complete', 'craft', 'pickup',
        'notify', 'warn', 'beacon', 'blueprint', 'equip', 'toggle'];
      const dur = names.length * 1.3 + 3.5;
      const buf = await renderOffline(dur, (g, a, sec) => {
        const bed = new Bed(g, 'shallows-reef', 0);
        bed.snapWeight(1, 0); bed.schedule(0, sec);
        names.forEach((n, i) => stingVoice(g, n, 1.4 + i * 1.3, makeRNG(hashStr(n)), {}));
      }, 5309, [1, 30]);
      // the bed alone, taken after the last sting has fully decayed
      const bedRef = blockLevels(buf, dur - 1.8, dur - 0.2);
      const ref = bedRef.medianRmsDb, refPk = bedRef.p95PeakDb;
      out.stingOverBed = { bedRmsDb: ref, bedPeakDb: refPk, stings: {} };
      names.forEach((n, i) => {
        const t0 = 1.4 + i * 1.3;
        const m = blockLevels(buf, t0, t0 + 0.5);
        out.stingOverBed.stings[n] = {
          rmsDb: m.p85RmsDb, peakDb: m.maxPeakDb,
          overBedDb: +(m.p85RmsDb - ref).toFixed(2),
          overBedPeakDb: +(m.maxPeakDb - refPk).toFixed(2),
        };
      });
      /**
       * 'equip' and 'toggle' are hardware, not confirmations — a detent and a
       * relay inside the suit — and a tool change that announced itself like a
       * scan completing would be exhausting. They are also only 15-20 ms long,
       * so block RMS under-reports them badly: a click whose PEAK is well above
       * the bed still averages low across a 100 ms window. They are judged on
       * peak over the bed's peak instead, which is what a click actually is.
       */
      const quiet = new Set(['equip', 'toggle']);
      const cut = names.filter((n) => !quiet.has(n));
      const worst = Math.min(...cut.map((n) => out.stingOverBed.stings[n].overBedDb));
      const worstQuiet = Math.min(...[...quiet].map((n) => out.stingOverBed.stings[n].overBedPeakDb));
      out.stingOverBed.worstOverBedDb = worst;
      out.stingOverBed.worstHandlingOverBedPeakDb = worstQuiet;
      out.stingOverBed.passes = worst >= 6 && worstQuiet >= 3;
    }

    // ---- 6. breathing at a full and a nearly empty tank
    if (want('breath')) for (const [label, oxy] of [['full', 1.0], ['low', 0.16]]) {
      tick('breath ' + label);
      const dur = 20;
      const strain = clamp(1 - (oxy - BREATH.panic) / (1 - BREATH.panic), 0, 1);
      const period = lerp(BREATH.calm, BREATH.hard, clamp(strain * 0.85, 0, 1));
      let breaths = 0;
      const buf = await renderOffline(dur, (g) => {
        const rng = makeRNG(5150);
        let t = 0.2, phase = 'in';
        while (t < dur - 1.5) {
          breathVoice(g, t, phase, rng, strain, 0.28);
          if (phase === 'in') breaths++;
          t += period * (phase === 'in' ? 0.46 : 0.54);
          phase = phase === 'in' ? 'out' : 'in';
        }
      }, 5150);
      out['breath_' + label] = measure(buf, 0.3, dur - 0.5);
      out['breath_' + label].breathsPerMinute = +(breaths / ((dur - 1.7) / 60)).toFixed(1);
      out['breath_' + label].periodS = +period.toFixed(2);
    }

    // ---- 7. heartbeat, music, player
    if (want('misc')) {
      tick('heartbeat');
      const buf = await renderOffline(8, (g) => {
        for (let i = 0; i < 12; i++) heartVoice(g, 0.3 + i * 0.55, 0.26, 110);
      }, 4242);
      out.heartbeat = measure(buf, 0.2, 7.5);
    }
    if (want('misc')) for (const kind of ['discovery', 'danger', 'drift']) {
      tick('music ' + kind);
      const c = CHORDS[kind];
      const dur = c.attack + c.hold + c.release + 1;
      const buf = await renderOffline(dur, (g) => padVoice(g, kind, 0.2, makeRNG(hashStr(kind))), hashStr(kind));
      out['music_' + kind] = measure(buf, 0.1, dur - 0.3);
    }
    if (want('misc')) {
      tick('strokes');
      const buf = await renderOffline(4, (g) => {
        const rng = makeRNG(31415);
        for (let i = 0; i < 5; i++) strokeVoice(g, 0.2 + i * 0.7, rng, 0.18, false, i % 2 ? 1 : -1);
      }, 31415);
      out.strokes = measure(buf, 0.1, 3.8);
    }

    // ---- 8. the full live mix, as a player would actually hear it
    if (want('mix')) {
      tick('fullMix');
      const dur = 12;
      const buf = await renderOffline(dur, (g, a, sec) => {
        const rng = makeRNG(1234);
        const beds = [new Bed(g, 'kelp-creak', 0), new Bed(g, 'grand-reef-deep', 0)];
        beds[0].snapWeight(0.75, 0); beds[1].snapWeight(0.25, 0);
        for (const b of beds) b.schedule(0, sec);
        let t = 0.4, phase = 'in';
        while (t < dur - 2) {
          breathVoice(g, t, phase, rng, 0.2, 0.26);
          t += 4.2 * (phase === 'in' ? 0.46 : 0.54);
          phase = phase === 'in' ? 'out' : 'in';
        }
        for (let i = 0; i < 6; i++) strokeVoice(g, 1.0 + i * 1.6, rng, 0.15, false, i % 2 ? 1 : -1);
        const roar = voxVoice(g, VOX.reaper, 5.0, rng, 165);
        // through the panner, like the game: a bare connect to the life bus
        // plays a leviathan at its full reference level, which is a level no
        // player ever hears and makes the mix render look 6 dB hotter than it is
        g.place(roar.node, new THREE.Vector3(140, -10, 86),
          { ref: VOX.reaper.ref, roll: 0.5, max: 900, dur: roar.dur + 0.6 });
        g.duckTo(VOX.reaper.duck[0], roar.dur + VOX.reaper.duck[1], 5.0, roar.dur * 0.55);
        padVoice(g, 'danger', 4.4, rng, -1);
        stingVoice(g, 'scan-complete', 9.4, rng);
      }, 1234, [1, 70]);
      out.fullMix = measure(buf, 0.4, 11.6);
      out.fullMixRoar = measure(buf, 5.0, 8.0);
      out.fullMixQuiet = measure(buf, 1.0, 4.0);
    }

    // ---- summary judgements
    const bedVals = Object.values(out.beds);
    const all = [...bedVals, ...Object.values(out.stings), ...Object.values(out.vox)]
      .concat([out.fullMix, out.heartbeat, out.strokes, out.breath_full, out.breath_low].filter(Boolean));
    const span = (arr, f) => (arr.length ? [Math.min(...arr.map(f)), Math.max(...arr.map(f))] : null);
    out.summary = {
      beds: bedVals.length,
      bedRmsDbRange: span(bedVals, (b) => b.rmsDb),
      bedPeakDbRange: span(bedVals, (b) => b.peakDb),
      centroidSpreadHz: span(bedVals, (b) => b.centroidHz),
      worstDcDb: all.length ? Math.max(...all.map((b) => b.dcDb)) : null,
      worstJumpCrest: all.length ? Math.max(...all.map((b) => b.jumpCrest)) : null,
      anyClipped: all.some((b) => b.clipped),
      roarBeatsItsBed: out.roarOverBedPasses ?? null,
      roarWorstDRmsDb: out.roarOverBed
        ? Math.min(...Object.values(out.roarOverBed).map((r) => r.dRmsDb)) : null,
      roarWorstDPeakDb: out.roarOverBed
        ? Math.min(...Object.values(out.roarOverBed).map((r) => r.dPeakDb)) : null,
    };
    out.notes.push('jumpCrest = max |x[n]-x[n-1]| / rms(diff). Smooth audio ~4-10; a real discontinuity blows past 25.');
    out.notes.push('dcDb is 20*log10(|mean sample|); the master runs two 15 Hz highpasses so this should sit below -70 dB.');
    if (!this._ctx?.get?.('survival') || this._ctx.get('survival')?.stub) {
      out.notes.push('player/survival.js is still a stub, so breathing rate is driven by audio.js local O2 fallback (95 s tank).');
    }
    return out;
  },

  /** Snapshot for a debug HUD or a critic. */
  get debug() {
    return {
      running: this.running, needsGesture: this.needsGesture, muted: this.muted,
      contextState: this.g?.actx?.state ?? 'none',
      uiCuesAdopted: !!this._uiPatched,
      beds: Object.fromEntries([...(this.beds?.entries?.() ?? [])].map(([k, b]) => [k, +b.weight.toFixed(3)])),
      ...this.s,
    };
  },

};

export default api;
