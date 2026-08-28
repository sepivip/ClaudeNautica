/**
 * Module manifest. OWNER: core.
 *
 * Each entry is one independently-built, independently-judged subsystem and is
 * owned by exactly one agent. Do not edit another module's file.
 *
 * Module contract (default export):
 *   {
 *     id: string,
 *     order?: number,                  // init + update order, low first
 *     async init(ctx) {},              // build objects, add to ctx.scene
 *     update(dt, t, ctx) {},           // per-frame simulation
 *     preRender(ctx) {},               // last-moment uniform/camera writes
 *     shots?: { [name]: (ctx) => void } // optional extra capture setups
 *   }
 *
 * ctx = { engine, renderer, scene, camera, U, WORLD, rng, input, time,
 *         get(id), params, uiRoot, assets }
 *
 * A module that throws during init or update is disabled and reported in
 * window.__CN.moduleStatus() — the rest of the game keeps running.
 */
export const MANIFEST = [
  // ---- environment / rendering -------------------------------------------
  { id: 'sky',        order: 10,  path: () => import('../render/sky.js') },
  { id: 'underwater', order: 20,  path: () => import('../render/underwater.js') },
  { id: 'watersurface', order: 30, path: () => import('../render/watersurface.js') },

  // ---- world --------------------------------------------------------------
  { id: 'biomes',     order: 40,  path: () => import('../world/biomes.js') },
  { id: 'terrain',    order: 50,  path: () => import('../world/terrain.js') },
  { id: 'flora',      order: 60,  path: () => import('../world/flora.js') },
  { id: 'structures', order: 70,  path: () => import('../world/structures.js') },

  // ---- life ---------------------------------------------------------------
  { id: 'creatures',  order: 80,  path: () => import('../life/creatures.js') },
  { id: 'schooling',  order: 85,  path: () => import('../life/schooling.js') },

  // ---- player -------------------------------------------------------------
  { id: 'movement',   order: 100, path: () => import('../player/movement.js') },
  { id: 'survival',   order: 110, path: () => import('../player/survival.js') },
  { id: 'tools',      order: 120, path: () => import('../player/tools.js') },

  // ---- vehicles / base ----------------------------------------------------
  { id: 'vehicles',   order: 130, path: () => import('../vehicles/vehicles.js') },
  { id: 'base',       order: 140, path: () => import('../base/base.js') },

  // ---- presentation -------------------------------------------------------
  { id: 'postfx',     order: 200, path: () => import('../render/postfx.js') },
  { id: 'ui',         order: 210, path: () => import('../ui/ui.js') },
  { id: 'audio',      order: 220, path: () => import('../audio/audio.js') },
];
