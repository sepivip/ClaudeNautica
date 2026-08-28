/**
 * Canonical capture framings. OWNER: core (agents may ADD shots, never remove).
 *
 * These are the A/B battery: each one is deliberately composed to match an
 * iconic Subnautica framing so a critic can put ours and theirs side by side.
 * `ref` names the reference image in reference/subnautica/.
 */
export const SHOTS = {
  'surface-pod': {
    desc: 'Treading water at the surface, lifepod and horizon in frame',
    ref: 'surface-pod', pos: [12, 1.2, 18], yaw: -145, pitch: -4, tod: 0.42, settle: 3,
  },
  'surface-above': {
    desc: 'Above the waterline: ocean surface, sky, sun glitter',
    ref: 'surface-above', pos: [0, 6, 0], yaw: 30, pitch: -8, tod: 0.38, settle: 3,
  },
  'shallows-reef': {
    desc: 'Safe Shallows at ~12m, horizontal across coral and fish',
    ref: 'shallows-reef', pos: [30, -12, 40], yaw: -120, pitch: -6, tod: 0.42, settle: 3,
  },
  'shallows-floor': {
    desc: 'Low over the sand, coral tubes and brain coral, caustics on the floor',
    ref: 'shallows-floor', pos: [-40, -18, 25], yaw: 55, pitch: -12, tod: 0.42, settle: 3, snap: 3.5,
  },
  'godrays': {
    // Was [0,-32,0] pitch 58: pointed at empty water with NO terrain anywhere in
    // frame, so the terrain occlusion that LOOK.md section 4 says IS the god-ray
    // effect could not possibly appear. godrays-1.jpg frames rock spires
    // silhouetted against the shafts, so sit lower and tilt down toward the rise.
    desc: 'Looking up at the sun through the surface — volumetric shafts, terrain silhouetted',
    ref: 'godrays', pos: [0, -40, 0], yaw: 20, pitch: 40, tod: 0.42, settle: 3,
  },
  'kelp-forest': {
    desc: 'Inside the kelp forest, fronds swaying, dappled light',
    ref: 'kelp-forest', pos: [130, -55, -90], yaw: 15, pitch: 8, tod: 0.42, settle: 4,
  },
  'dropoff': {
    desc: 'Reef edge falling away into the blue void',
    // Probed along this bearing: -80m at 10m ahead falling to -244m by 50m ahead.
    // Sit just above the lip and look shallowly down so the lit shelf holds the
    // lower third and the unresolved dark fills the middle — that contrast is what
    // sells vertical scale, per the critic's measurement against godrays-1.jpg.
    ref: 'dropoff', pos: [-160, -74, 150], yaw: 200, pitch: -14, tod: 0.42, settle: 3, snap: 7,
  },
  'grand-reef': {
    desc: 'Deep reef ~280m, dim blue, bioluminescent accents',
    ref: 'grand-reef', pos: [340, -280, -260], yaw: 90, pitch: -8, tod: 0.42, settle: 4,
  },
  'deep-void': {
    // Probed: the seabed here is at -696. The camera used to sit at -520, i.e. 176m
    // above anything, so the frame was empty water and critics scored a blank card.
    desc: 'Near-black deep water, only bioluminescence and the light cone',
    ref: 'deep-void', pos: [-420, -678, 380], yaw: 145, pitch: -10, tod: 0.42, settle: 4, snap: 18,
  },
  'wreck': {
    desc: 'Exterior of a broken Aurora-style wreck section on the seabed',
    ref: 'wreck', pos: [210, -95, 60], yaw: -60, pitch: -8, tod: 0.42, settle: 4,
  },
  'cave': {
    desc: 'Cave interior, bioluminescent flora, hard darkness beyond the light',
    ref: 'cave', pos: [-90, -190, -180], yaw: 35, pitch: 0, tod: 0.42, settle: 4, snap: 9,
  },
  'creature-close': {
    desc: 'Close pass of a large creature, readable silhouette and animation',
    ref: 'creature-close', pos: [60, -40, -60], yaw: 0, pitch: 0, tod: 0.42, settle: 5,
  },
  'school': {
    desc: 'A school of fish streaming past camera',
    ref: 'school', pos: [-20, -26, 70], yaw: 90, pitch: -4, tod: 0.42, settle: 5,
  },
  'seamoth': {
    desc: 'Seamoth exterior, lights on, hovering over the reef',
    ref: 'seamoth', pos: [10, -45, 90], yaw: -30, pitch: -6, tod: 0.42, settle: 4,
  },
  'seamoth-cockpit': {
    desc: 'First-person from inside the Seamoth cockpit, HUD visible',
    ref: 'seamoth-cockpit', pos: [10, -45, 90], yaw: -30, pitch: -4, tod: 0.42, settle: 4,
  },
  'base-interior': {
    desc: 'Habitat interior looking out through the observatory glass',
    // The PDA panel was covering the whole frame, so this battery slot never
    // actually tested the base module. Shots may now request UI state.
    ref: 'base-interior', pos: [-60, -30, -30], yaw: 180, pitch: 0, tod: 0.42, settle: 3,
    ui: { pda: false, hud: true },
  },
  'hud': {
    desc: 'Normal gameplay framing with full survival HUD',
    ref: 'hud', pos: [30, -20, 40], yaw: -120, pitch: -8, tod: 0.42, settle: 3,
  },
  'night-shallows': {
    desc: 'Night dive in the shallows, moonlight and flashlight cone',
    ref: 'night-shallows', pos: [30, -14, 40], yaw: -120, pitch: -6, tod: 0.88, settle: 4,
  },
};

/**
 * Apply a named shot. Tolerant of missing modules so any subsystem can be
 * judged before the rest of the world exists.
 */
export async function applyShot(name, ctx, CN) {
  const s = SHOTS[name];
  if (!s) throw new Error(`unknown shot: ${name} (have: ${Object.keys(SHOTS).join(', ')})`);

  if (s.tod !== undefined) ctx.time.timeOfDay = s.tod;

  // A shot may request UI state (e.g. close the PDA so it does not cover the
  // frame). ui.js should implement setState({ pda, hud }); guarded so a shot
  // never fails because a module has not implemented it yet.
  // FAIL LOUDLY. This was `ctx.get('ui')?.setState?.(s.ui)`, whose optional chain
  // silently swallowed the fact that ui.js has no setState at all — so
  // base-interior went two whole-game rounds with the PDA covering the entire
  // frame and was never actually judged. A capture harness that quietly does
  // nothing is worse than one that throws.
  if (s.ui) {
    const ui = ctx.get('ui');
    if (!ui) console.warn(`[shot:${name}] requested UI state but no ui module is loaded`);
    else if (typeof ui.setState !== 'function') {
      const msg = `[shot:${name}] requested UI state ${JSON.stringify(s.ui)} but ui.js has no setState() — `
        + 'the frame is NOT in the requested state and must not be judged as if it were';
      console.error(msg);
      CN.errors.push(msg);
    } else {
      try { ui.setState(s.ui); } catch (e) { console.error(`[shot:${name}] ui.setState threw`, e); }
    }
  }

  let pos = [...s.pos];
  // Snap above the terrain surface when the terrain module can tell us where it is.
  const terrain = ctx.get('terrain');
  if (s.snap && terrain?.heightAt) {
    const h = terrain.heightAt(pos[0], pos[2]);
    if (Number.isFinite(h)) pos[1] = h + s.snap;
  }

  CN.setCamera({ pos, yaw: s.yaw, pitch: s.pitch, fov: s.fov ?? 68 });

  /**
   * MOVE THE PLAYER BODY, NOT JUST THE CAMERA.
   *
   * Modules that cull or spawn by range to the PLAYER — creatures, schooling,
   * flora — were measuring distance to a body still sitting at the spawn point
   * while the camera had been teleported 300m away, so they culled themselves out
   * of the frame they were being judged in. A creatures critic isolated this and
   * it affects every range-driven module in the game. ui.js has the same class of
   * problem: it gates the drowning wash on movement.isSubmerged, which never got
   * set, so survival's most dramatic state was invisible to the shot battery.
   */
  const mv = ctx.get('movement');
  if (mv) {
    try {
      if (mv.position?.set) mv.position.set(pos[0], pos[1], pos[2]);
      else if (mv.setPosition) mv.setPosition(pos[0], pos[1], pos[2]);
      if (mv.velocity?.set) mv.velocity.set(0, 0, 0);
      // isSubmerged is a GETTER on movement.js, so assigning it threw on every
      // single shot — "Cannot set property isSubmerged which has only a getter".
      // Position and velocity were set first so range-culling did get fixed, but
      // the submersion forcing never happened, which is the half this was written
      // for: ui.js gates its drowning wash on it, so survival's most dramatic
      // state stayed invisible to the still battery. Drive the backing field if
      // the module exposes one, and only assign when it is actually writable.
      const sub = pos[1] < (ctx.U?.uWaterLevel?.value ?? 0);
      if (typeof mv.setSubmerged === 'function') mv.setSubmerged(sub);
      else if ('_sub' in mv) mv._sub = sub ? 1 : 0;
      else {
        const d = Object.getOwnPropertyDescriptor(mv, 'isSubmerged')
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mv) || {}, 'isSubmerged');
        if (!d || d.writable || d.set) mv.isSubmerged = sub;
      }
    } catch (e) { console.warn('[shot] could not place player body', e); }
  }

  /**
   * DROP TEMPORAL STATE BEFORE SETTLING.
   *
   * The same shot measured differently depending on which shot preceded it:
   * godrays came out saturation 0.955 / R% 5 alone, and 0.877 / 13 straight after
   * cave — reproduced. Adaptive exposure, temporal AA history, current
   * accumulators and spawn state all survived the teleport, so every metric taken
   * from a multi-shot battery carried the previous shot's history. Any module
   * with temporal state MUST implement resetForShot(ctx) and clear it.
   */
  for (const m of (CN.modules?.values?.() ?? [])) {
    try { m.resetForShot?.(ctx); } catch (e) { console.warn('[shot] resetForShot', m.id, e); }
  }

  // Let modules react (spawn a creature in frame, open a base door, etc.)
  for (const m of ctx.modules?.values?.() ?? []) {
    try { m.shots?.[name]?.(ctx); } catch (e) { console.warn('shot hook', m.id, e); }
  }
  for (const m of (CN.modules?.values?.() ?? [])) {
    try { m.shots?.[name]?.(ctx); } catch (e) { console.warn('shot hook', m.id, e); }
  }

  CN.settle(s.settle ?? 3);
  CN.setCamera({ pos, yaw: s.yaw, pitch: s.pitch, fov: s.fov ?? 68 });
  CN.step(1, 1 / 60);
  return { name, desc: s.desc, ref: s.ref, pos, yaw: s.yaw, pitch: s.pitch };
}
