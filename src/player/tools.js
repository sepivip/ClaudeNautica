/**
 * TOOLS — the player's verbs: light, scan, cut, carry, craft, mark.
 *
 * OWNER: the "tools" agent.
 *
 * WHAT IS IN HERE
 *   1. Item + recipe + databank tables
 *   2. Procedural geometry (resource nodes, beacons, the fabricator, the
 *      first-person hand tools)
 *   3. THE LAMP — a deferred + volumetric flashlight cone
 *   4. The node field: deterministic, chunk-streamed harvestables
 *   5. Scanner, knife, harvesting, inventory, crafting, beacons
 *   6. The holographic HUD + PDA (DOM, cyan-blue glass per LOOK.md section 10)
 *
 * WHY THE LAMP IS DEFERRED RATHER THAN A THREE SPOTLIGHT
 * world/terrain.js and world/flora.js are custom ShaderMaterials with their own
 * analytic lighting and no `lights: true` — three's light list never reaches
 * them, so a THREE.SpotLight would light the wreck and the creatures and leave
 * the seabed and the kelp completely black. Since the whole point of a
 * flashlight is that the SEABED lights up, the lamp is instead one additive
 * screen pass that reads render/underwater.js's depth prepass, reconstructs the
 * world position and normal per pixel, and adds
 *
 *     lamp * spot(angle) / d^2 * N.L * uwTransmittance(d) * uwTransmittance(view)
 *
 * plus a jittered raymarch of the same lamp through the medium for the cone
 * itself. Both halves call core's uwTransmittance/uwInscatter rather than
 * inventing their own fog, exactly as AGENT_BRIEF requires of a custom shader.
 * It also means one draw call, no shader recompiles when you press F, and no
 * shadow map. LOOK.md section 3: lamps never cast caustics — this one does not.
 *
 * RENDER ORDER
 *   9800  lamp pass    after sky.js's night grade (9500) so a lamp is not
 *                      multiplied down by the absence of the sun
 *   9900  view models  after the lamp, so the hand is not painted over by it
 * Both are marked noDepthPass/noShadow: a hand 45 cm from the eye in the god-ray
 * depth prepass deletes every light shaft behind it.
 */
import * as THREE from 'three';
import { U, WORLD } from '../core/globals.js';
import { applyUnderwater, UNDERWATER_PARS } from '../core/underwaterMaterial.js';
import { makeRNG, hash2 } from '../core/rng.js';

// ---------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** frame-rate independent exponential approach */
const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
/** URL flag: present and not '0'. Valueless counts, so ?pda works like ?pda=1. */
function flag(params, name) {
  const v = params?.get?.(name);
  return v !== null && v !== undefined && v !== '0' && v !== 'false';
}

/** deterministic 3D value noise — used to warp rock blobs. No Math.random. */
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
function fbm3(x, y, z, oct = 3) {
  let s = 0, a = 1, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * (noise3(x * f, y * f, z * f) * 2 - 1); n += a; a *= 0.5; f *= 2.07; }
  return s / n;
}

// ===========================================================================
// 1. ITEMS
// ===========================================================================
/**
 * `g` names the SVG glyph, `c` the icon tint, `mass` kg, `stack` per slot.
 * Raw ids are exactly the ids world/biomes.js puts in each biome's `resources`
 * array, so the node field can be driven straight off that table with no
 * translation layer to drift out of sync.
 */
const ITEMS = {
  // ---- raw, straight out of the seabed -----------------------------------
  limestone:     { name: 'Limestone Outcrop', g: 'rock', c: 0xcdc6b0, mass: 1.2, stack: 20, cat: 'raw' },
  sandstone:     { name: 'Sandstone Outcrop', g: 'rock', c: 0xc9a877, mass: 1.3, stack: 20, cat: 'raw' },
  shale:         { name: 'Shale Outcrop', g: 'rock', c: 0x60655f, mass: 1.4, stack: 20, cat: 'raw' },
  titanium:      { name: 'Titanium', g: 'ingot', c: 0xb9c2c9, mass: 0.7, stack: 20, cat: 'raw' },
  copper_ore:    { name: 'Copper Ore', g: 'ore', c: 0xc8703a, mass: 0.9, stack: 20, cat: 'raw' },
  silver_ore:    { name: 'Silver Ore', g: 'ore', c: 0xd6dde2, mass: 0.9, stack: 20, cat: 'raw' },
  gold:          { name: 'Gold', g: 'ore', c: 0xe8b93c, mass: 1.0, stack: 20, cat: 'raw' },
  lead:          { name: 'Lead', g: 'ingot', c: 0x6c7178, mass: 1.6, stack: 20, cat: 'raw' },
  lithium:       { name: 'Lithium', g: 'crystal', c: 0xd8d2ea, mass: 0.8, stack: 20, cat: 'raw' },
  magnetite:     { name: 'Magnetite', g: 'crystal', c: 0x41474f, mass: 1.1, stack: 20, cat: 'raw' },
  nickel_ore:    { name: 'Nickel Ore', g: 'ore', c: 0x9aa78e, mass: 1.0, stack: 20, cat: 'raw' },
  quartz:        { name: 'Quartz', g: 'crystal', c: 0xcfe9f2, mass: 0.6, stack: 20, cat: 'raw' },
  diamond:       { name: 'Diamond', g: 'crystal', c: 0xdff6ff, mass: 0.4, stack: 10, cat: 'raw' },
  uraninite:     { name: 'Uraninite Crystal', g: 'crystal', c: 0x74d43a, mass: 1.2, stack: 10, cat: 'raw' },
  kyanite:       { name: 'Kyanite', g: 'crystal', c: 0x3f78d8, mass: 1.0, stack: 10, cat: 'raw' },
  ruby:          { name: 'Ruby', g: 'crystal', c: 0xd23a4a, mass: 0.7, stack: 10, cat: 'raw' },
  crystalline_sulphur: { name: 'Crystalline Sulphur', g: 'crystal', c: 0xe8d24a, mass: 0.8, stack: 10, cat: 'raw' },
  ion_cube:      { name: 'Ion Cube', g: 'cube', c: 0x9a6bff, mass: 1.3, stack: 5, cat: 'raw' },
  titanium_scrap:{ name: 'Titanium Scrap', g: 'scrap', c: 0xa9b3b8, mass: 2.0, stack: 10, cat: 'raw' },

  // ---- organic ------------------------------------------------------------
  salt:          { name: 'Salt Deposit', g: 'cube', c: 0xe6eef2, mass: 0.2, stack: 20, cat: 'organic' },
  coral_sample:  { name: 'Coral Tube Sample', g: 'organic', c: 0xd98a5c, mass: 0.3, stack: 20, cat: 'organic' },
  creepvine_seed:{ name: 'Creepvine Seed Cluster', g: 'organic', c: 0xffb03a, mass: 0.4, stack: 20, cat: 'organic' },
  blood_oil:     { name: 'Blood Oil', g: 'flask', c: 0x9c2029, mass: 0.5, stack: 10, cat: 'organic' },
  acid_sample:   { name: 'Acid Mushroom', g: 'organic', c: 0xe0c23a, mass: 0.3, stack: 20, cat: 'organic' },
  bulb_sample:   { name: 'Bulb Bush Sample', g: 'organic', c: 0x59c8b0, mass: 0.4, stack: 20, cat: 'organic' },

  // ---- fabricated intermediates ------------------------------------------
  glass:         { name: 'Glass', g: 'pane', c: 0x9fe4f2, mass: 0.5, stack: 10, cat: 'made' },
  silicone:      { name: 'Silicone Rubber', g: 'blob', c: 0xe4e0d2, mass: 0.3, stack: 10, cat: 'made' },
  copper_wire:   { name: 'Copper Wire', g: 'coil', c: 0xd08a4a, mass: 0.3, stack: 10, cat: 'made' },
  fiber_mesh:    { name: 'Fiber Mesh', g: 'weave', c: 0x9ac26a, mass: 0.4, stack: 10, cat: 'made' },
  battery:       { name: 'Battery', g: 'battery', c: 0x6fdfff, mass: 0.6, stack: 5, cat: 'made' },
  lubricant:     { name: 'Lubricant', g: 'flask', c: 0xd9c86a, mass: 0.4, stack: 10, cat: 'made' },

  // ---- equipment: these change how the player survives --------------------
  tank:          { name: 'High Capacity O2 Tank', g: 'tank', c: 0x9be55a, mass: 4.0, stack: 1, cat: 'gear',
                   equip: 'tank', note: '+45 s of oxygen' },
  fins:          { name: 'Swim Charge Fins', g: 'fins', c: 0x6fdfff, mass: 1.5, stack: 1, cat: 'gear',
                   equip: 'fins', note: 'recharges the tool in hand as you swim' },
  cargo_webbing: { name: 'Cargo Webbing', g: 'weave', c: 0xffa22a, mass: 1.0, stack: 1, cat: 'gear',
                   equip: 'cargo', note: '+30 kg carry' },
  rebreather:    { name: 'Rebreather', g: 'tank', c: 0x8fe9ff, mass: 1.2, stack: 1, cat: 'gear',
                   equip: 'rebreather', note: 'no O2 penalty below 100 m' },

  // ---- tools: these go in the quick bar -----------------------------------
  knife:         { name: 'Survival Knife', g: 'knife', c: 0xc9d3d8, mass: 0.5, stack: 1, cat: 'tool', slot: 1 },
  flashlight:    { name: 'Flashlight', g: 'torch', c: 0xffe6a8, mass: 0.6, stack: 1, cat: 'tool', slot: 2 },
  scanner:       { name: 'Scanner', g: 'scanner', c: 0x6fdfff, mass: 0.8, stack: 1, cat: 'tool', slot: 3 },
  beacon:        { name: 'Beacon', g: 'beacon', c: 0x6fdfff, mass: 1.0, stack: 5, cat: 'tool', slot: 4 },
  seaglide:      { name: 'Seaglide', g: 'glide', c: 0xffa22a, mass: 3.0, stack: 1, cat: 'tool', slot: 5,
                   equip: 'seaglide', note: 'wide beam, +80% speed' },

  // ---- sustenance ---------------------------------------------------------
  water:         { name: 'Filtered Water', g: 'flask', c: 0x6fdfff, mass: 0.5, stack: 10, cat: 'food',
                   use: { water: 30 } },
  nutrient:      { name: 'Nutrient Block', g: 'block', c: 0xffa22a, mass: 0.6, stack: 10, cat: 'food',
                   use: { food: 40 } },
  medkit:        { name: 'First Aid Kit', g: 'medkit', c: 0xf0553c, mass: 0.8, stack: 5, cat: 'food',
                   use: { health: 45 } },
};
const itemName = (id) => ITEMS[id]?.name || id.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

// ===========================================================================
// 2. RECIPES
// ===========================================================================
/**
 * `bp` means the recipe is locked until that blueprint has been scanned into
 * the databank. Everything else is available from the lifepod fabricator on
 * minute one, which is what makes the first dive a shopping list rather than a
 * wander.
 */
const CRAFT_CATS = [
  { id: 'materials', name: 'Basic Materials', glyph: 'ore' },
  { id: 'equipment', name: 'Equipment', glyph: 'tank' },
  { id: 'tools', name: 'Tools', glyph: 'knife' },
  { id: 'sustenance', name: 'Sustenance', glyph: 'flask' },
];
const RECIPES = [
  { id: 'titanium', cat: 'materials', time: 1.6, out: 2, need: { limestone: 1 } },
  { id: 'titanium', cat: 'materials', time: 1.6, out: 4, need: { titanium_scrap: 1 }, alt: 'scrap' },
  { id: 'glass', cat: 'materials', time: 1.8, need: { quartz: 2 } },
  { id: 'silicone', cat: 'materials', time: 1.8, need: { creepvine_seed: 1 } },
  { id: 'copper_wire', cat: 'materials', time: 1.8, need: { copper_ore: 2 } },
  { id: 'fiber_mesh', cat: 'materials', time: 1.8, need: { creepvine_seed: 2 } },
  { id: 'lubricant', cat: 'materials', time: 1.8, need: { creepvine_seed: 1, acid_sample: 1 } },
  { id: 'battery', cat: 'materials', time: 2.2, need: { acid_sample: 2, copper_ore: 1 } },

  { id: 'tank', cat: 'equipment', time: 3.0, need: { titanium: 3, silicone: 2, glass: 1 } },
  { id: 'fins', cat: 'equipment', time: 2.8, need: { silicone: 2, fiber_mesh: 1 } },
  { id: 'cargo_webbing', cat: 'equipment', time: 2.6, need: { fiber_mesh: 2, silver_ore: 1 }, bp: 'cargo_webbing' },
  { id: 'rebreather', cat: 'equipment', time: 3.0, need: { fiber_mesh: 1, copper_wire: 1, silicone: 1 }, bp: 'rebreather' },

  { id: 'knife', cat: 'tools', time: 2.2, need: { titanium: 2, silicone: 1 } },
  { id: 'flashlight', cat: 'tools', time: 2.4, need: { titanium: 2, glass: 1, battery: 1 } },
  { id: 'scanner', cat: 'tools', time: 2.6, need: { titanium: 1, copper_wire: 1, battery: 1 } },
  { id: 'beacon', cat: 'tools', time: 2.4, need: { titanium: 1, copper_wire: 1 } },
  { id: 'seaglide', cat: 'tools', time: 3.4, need: { titanium: 2, copper_wire: 1, lubricant: 1, battery: 1 }, bp: 'seaglide' },

  { id: 'water', cat: 'sustenance', time: 1.6, need: { salt: 1, coral_sample: 1 } },
  { id: 'nutrient', cat: 'sustenance', time: 1.6, need: { fiber_mesh: 1, salt: 1 } },
  { id: 'medkit', cat: 'sustenance', time: 2.0, need: { fiber_mesh: 1, silicone: 1 }, bp: 'medkit' },
];

// ===========================================================================
// 3. THE DATABANK
// ===========================================================================
/**
 * One entry per scannable subject. `cat` matches the PDA index groups the
 * reference PDA (hud-4.jpg) shows: Indigenous Lifeforms, Geological Data,
 * Blueprints, Data Downloads. `bp` is a blueprint this scan unlocks.
 *
 * Anything not listed still scans: buildEntry() writes a plausible stub from
 * the id and its category, so a species another module adds tomorrow does not
 * produce a blank page.
 */
const DATABANK = {
  // ---- lifeforms
  peeper: { cat: 'life', t: 'Peeper', x: 'Small omnivore, 40 cm. Oversized cranial mirror scatters what light reaches it, which is why a shoal reads as a sheet of flickering silver at range. Docile. Edible raw at some cost to the palate.' },
  boomerang: { cat: 'life', t: 'Boomerang', x: 'Twin-lobed swimmer, 55 cm. The lobes beat out of phase, producing the characteristic yaw wobble. Congregates over coral in daylight and drops to the sand at night.' },
  holefish: { cat: 'life', t: 'Holefish', x: 'A perforated dorsal cavity vents water sideways for near-instant turns. The hole is structural, not a wound. Common across the shallow shelf.' },
  hoopfish: { cat: 'life', t: 'Hoopfish', x: 'Schools in tight vertical rings. The ring is a predator-confusion display: from below it presents no leading edge to strike at.' },
  bladderfish: { cat: 'life', t: 'Bladderfish', x: 'Carries a gas bladder of filtered, potable water. Compressing the bladder yields roughly 20 ml. Slow, incurious, and consequently the first thing most survivors drink.' },
  rabbit_ray: { cat: 'life', t: 'Rabbit Ray', x: 'Broad grazing ray, 1.4 m span. Feeds on algal film. Wholly non-aggressive; will follow a light source out of what reads as curiosity.' },
  gasopod: { cat: 'life', t: 'Gasopod', x: 'Vents clusters of buoyant toxin sacs when alarmed. The sacs drift, then rupture. Give it eight metres and it will ignore you entirely.' },
  crashfish: { cat: 'life', t: 'Crashfish', x: 'Nests inside hollow coral tubes and launches itself at anything that passes within two metres, detonating on contact. Territorial rather than predatory.' },
  stalker: { cat: 'life', t: 'Stalker', x: 'Kelp-forest predator, 4 m. Collects metallic debris, apparently for the abrasive effect on its teeth. Aggressive toward divers carrying scrap.' },
  oculus: { cat: 'life', t: 'Oculus', x: 'Two thirds of its body volume is eye. Adapted to the low, green-filtered light under a creepvine canopy.' },
  reefback: { cat: 'life', t: 'Reefback Leviathan', x: 'Class-3 leviathan, 60 m. A living reef: coral and tube growths colonise the dorsal shell over a lifespan measured in centuries. Entirely peaceful filter feeder.' },
  sand_shark: { cat: 'life', t: 'Sand Shark', x: 'Ambush predator that swims through loose substrate. Watch the sand, not the water.' },
  crabsquid: { cat: 'life', t: 'Crabsquid', x: 'Emits a directed electromagnetic pulse that disables powered equipment at short range. Bioluminescent along the mantle.' },
  reaper: { cat: 'life', t: 'Reaper Leviathan', x: 'Class-4 leviathan, 55 m. Echolocates. If you can hear it, it has already heard you. Avoid the Dunes and the crash zone perimeter.' },
  ghost_leviathan: { cat: 'life', t: 'Ghost Leviathan', x: 'Class-4, translucent, 107 m. Juveniles occupy the Lost River; adults hold the void beyond the crater rim.' },
  mesmer: { cat: 'life', t: 'Mesmer', x: 'Projects a rhythmic optical pattern that suppresses threat response in most vertebrates. Do not watch it.' },
  ampeel: { cat: 'life', t: 'Ampeel', x: 'Generates a 400 V discharge along a dorsal organ. The glow precedes the discharge by about half a second.' },
  jellyray: { cat: 'life', t: 'Jellyray', x: 'Translucent mantle, 3 m span. Grazes plankton at mid-depth. Harmless.' },
  boneshark: { cat: 'life', t: 'Boneshark', x: 'Armoured plating over the skull. Rams first, bites second. Common around wrecks.' },
  cave_crawler: { cat: 'life', t: 'Cave Crawler', x: 'Small scavenging arthropod. Nocturnal above ground, permanent in caves.' },

  // ---- flora
  kelp_vine: { cat: 'life', t: 'Creepvine', x: 'Reaches 30 m from a shallow holdfast. The stalk is a single fiber bundle under tension; cut samples yield a workable elastomer. Seed clusters are phosphorescent and rich in silicon.' },
  coral_tube: { cat: 'life', t: 'Coral Tube', x: 'Hollow calcareous trumpet, 3-8 m. The flare is a passive current trap. Broken sections make usable feedstock.' },
  acid_mushroom: { cat: 'life', t: 'Acid Mushroom', x: 'The cap holds a mildly corrosive electrolyte. Harvested carefully it is the cheapest battery chemistry on this planet.' },
  table_coral: { cat: 'life', t: 'Table Coral', x: 'Flat plating colony up to 13 m across. Samples cleave into thin translucent wafers.' },
  brain_coral: { cat: 'life', t: 'Brain Coral', x: 'Folded mass that vents a slow stream of oxygenated bubbles. Divers use it as a rest stop.' },
  sea_grass: { cat: 'life', t: 'Sea Grass', x: 'Ubiquitous bladed ground cover. Binds the sand and hides everything small.' },
  blood_grass: { cat: 'life', t: 'Blood Grass', x: 'Deep red mat. The pigment is a light-harvesting antenna tuned to what survives at 200 m.' },
  bulb_bush: { cat: 'life', t: 'Bulb Bush', x: 'Translucent bulbs lit from within by a symbiotic bacterium. Edible; tastes of nothing at all.' },
  jellyshroom: { cat: 'life', t: 'Jellyshroom', x: 'Cave-dwelling fungal cap, 8-20 m. Emits in the magenta band, which is the only light most of that cavern ever sees.' },

  // ---- geology
  limestone: { cat: 'geo', t: 'Limestone Outcrop', x: 'Sedimentary nodule with titanium and copper inclusions. Fractures cleanly under a blade. The single most useful rock on the shelf.', bp: null },
  sandstone: { cat: 'geo', t: 'Sandstone Outcrop', x: 'Softer than limestone and richer: silver, gold and lead all precipitate into these nodules.' },
  shale: { cat: 'geo', t: 'Shale Outcrop', x: 'Laminated deep-shelf rock. Diamond and lithium occur in the partings between laminae.' },
  quartz: { cat: 'geo', t: 'Quartz', x: 'Silicon dioxide. Melts to optical-grade glass in a standard fabricator.' },
  copper_ore: { cat: 'geo', t: 'Copper Ore', x: 'Surface-weathered chalcopyrite. Drawn into wire it is the backbone of every powered tool you own.' },
  silver_ore: { cat: 'geo', t: 'Silver Ore', x: 'Native silver in a carbonate matrix.' },
  gold: { cat: 'geo', t: 'Gold', x: 'Chemically inert, superb conductor, and heavier than it looks in your pack.' },
  lithium: { cat: 'geo', t: 'Lithium', x: 'Light alkali metal. Cell chemistry for anything you want to survive a 400 m dive.' },
  diamond: { cat: 'geo', t: 'Diamond', x: 'Deep-formed carbon. Both a cutting edge and a pressure window.' },
  magnetite: { cat: 'geo', t: 'Magnetite', x: 'Ferrimagnetic iron oxide. Deflects a compass at close range.' },
  salt: { cat: 'geo', t: 'Salt Deposit', x: 'Evaporite crust. With a bladderfish it becomes drinkable water; on its own it is the opposite.' },
  titanium_scrap: { cat: 'geo', t: 'Titanium Scrap', x: 'Hull plating from the Aurora. Four ingots per plate and no mining required.' },

  // ---- structures
  lifepod: { cat: 'data', t: 'Lifepod 5', x: 'Emergency escape pod, Aurora complement. Hull integrity nominal, radio damaged, fabricator online. Everything you build for the next hundred metres of depth comes out of this unit.' },
  wreck: { cat: 'data', t: 'Aurora Debris Field', x: 'Structural section, Aurora. Compartments are pressurised in places and open in others. Recoverable data terminals present.', bp: 'seaglide' },
  cave: { cat: 'data', t: 'Cavern System', x: 'Solution cavern in carbonate rock. Wide mouth, no daylight past the first thirty metres, and a resident bioluminescent flora that will be the only thing you can see.', bp: 'rebreather' },
  arch: { cat: 'data', t: 'Rock Arch', x: 'Collapsed cave roof leaving a free-standing span. A reliable navigation landmark.' },
  spire: { cat: 'data', t: 'Rock Spire', x: 'Tapered carbonate finger, 20-40 m. Grows from the base; the crown is the oldest part.' },
};
const DB_CATS = [
  { id: 'life', name: 'Indigenous Lifeforms' },
  { id: 'geo', name: 'Geological Data' },
  { id: 'data', name: 'Data Downloads' },
  { id: 'bp', name: 'Blueprints' },
];

/** Fill in an entry for anything the table does not name explicitly. */
function buildEntry(id, cat) {
  const d = DATABANK[id];
  if (d) return { id, cat: d.cat || cat || 'data', t: d.t, x: d.x, bp: d.bp };
  const t = itemName(id);
  const x = cat === 'life'
    ? `Indigenous organism. Morphology logged, behaviour under observation. Biomass sampled and indexed; no toxicity flags raised by the preliminary assay.`
    : cat === 'geo'
      ? `Mineral sample logged. Composition indexed against the fabricator's feedstock tables; recoverable by hand or by blade.`
      : `Structure logged and added to the navigation index.`;
  return { id, cat: cat || 'data', t, x, bp: null };
}

// ===========================================================================
// 4. ICONS — inline SVG, so every "texture" in the HUD is procedural
// ===========================================================================
const GLYPHS = {
  rock: 'M4 15 L7 7 L13 5 L19 8 L20 15 L14 19 L7 18 Z M9 9 L12 12 L10 15',
  ore: 'M4 14 L8 6 L16 5 L20 12 L15 19 L7 18 Z M11 5 L11 12 L20 12 M11 12 L7 18',
  crystal: 'M12 2 L18 9 L15 21 L9 21 L6 9 Z M12 2 L12 21 M6 9 L18 9',
  cube: 'M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 L12 21',
  ingot: 'M3 16 L7 9 L17 9 L21 16 Z M6 9 L9 4 L19 4 L21 9',
  scrap: 'M3 8 L11 4 L21 9 L18 18 L6 19 Z M8 6 L10 16 M15 6 L13 17',
  organic: 'M12 21 C12 13 6 12 5 4 C13 4 18 9 15 15 M12 21 C12 16 16 13 20 12',
  flask: 'M9 3 L15 3 M10 3 L10 9 L5 19 A2 2 0 0 0 7 21 L17 21 A2 2 0 0 0 19 19 L14 9 L14 3 M7.5 14 L16.5 14',
  pane: 'M4 5 L20 3 L20 19 L4 21 Z M8 5 L15 18',
  blob: 'M12 3 C18 3 21 8 20 13 C19 19 13 22 9 20 C4 18 2 12 5 7 C7 4 9 3 12 3 Z',
  coil: 'M4 8 C4 4 9 4 9 8 L9 16 C9 20 14 20 14 16 L14 8 C14 4 19 4 19 8 M2 12 L21 12',
  weave: 'M4 4 L20 4 L20 20 L4 20 Z M4 9 L20 9 M4 14 L20 14 M9 4 L9 20 M15 4 L15 20',
  battery: 'M6 6 L18 6 L18 20 L6 20 Z M9 3 L15 3 L15 6 M8 16 L16 16 M8 12 L16 12',
  tank: 'M8 7 A4 4 0 0 1 16 7 L16 18 A4 3 0 0 1 8 18 Z M10 7 L10 3 L14 3 L14 7 M11 1 L13 1',
  fins: 'M8 3 L12 3 L12 10 L18 20 L10 21 L6 12 Z M8 8 L12 8',
  knife: 'M14 2 L18 6 L8 17 L5 19 L6 15 Z M7 16 L4 21',
  torch: 'M8 3 L16 3 L17 9 L7 9 Z M9 9 L15 9 L14 21 L10 21 Z M11 12 L13 12',
  scanner: 'M4 8 L14 6 L20 9 L20 15 L14 18 L4 16 Z M15 10 A2.5 2.5 0 1 0 15 15 A2.5 2.5 0 1 0 15 10 M6 10 L11 9.2 L11 15 L6 14 Z',
  beacon: 'M12 2 L12 8 M8 8 L16 8 L14 21 L10 21 Z M5 5 A9 9 0 0 1 19 5',
  glide: 'M3 12 C3 7 9 5 14 6 L20 9 L20 15 L14 18 C9 19 3 17 3 12 Z M14 9 A3 3 0 1 0 14 15 A3 3 0 1 0 14 9',
  block: 'M4 8 L12 4 L20 8 L20 16 L12 20 L4 16 Z M4 8 L12 12 L20 8 M12 12 L12 20',
  medkit: 'M4 7 L20 7 L20 20 L4 20 Z M9 7 L9 4 L15 4 L15 7 M12 10 L12 17 M8.5 13.5 L15.5 13.5',
  dot: 'M12 6 A6 6 0 1 0 12 18 A6 6 0 1 0 12 6',
};
/** Inline SVG for an item id (or a raw glyph key). */
function svgIcon(key, colour, size = 26, w = 1.7) {
  const it = ITEMS[key];
  const g = it ? it.g : key;
  const c = colour || (it ? '#' + it.c.toString(16).padStart(6, '0') : '#dff2ff');
  const d = GLYPHS[g] || GLYPHS.dot;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${c}"
    stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

// ===========================================================================
// 5. GEOMETRY
// ===========================================================================
/**
 * Welded icosphere. BoxGeometry and SphereGeometry both duplicate vertices at
 * their seams, and once a rock is displaced by noise those duplicates average
 * to different normals and leave a visible crease straight down it. This is
 * indexed and shared all the way round, so computeVertexNormals is seamless.
 */
function icoSphere(subdiv = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map();
    const nf = [];
    const midpoint = (a, b) => {
      const k = a < b ? a * 100000 + b : b * 100000 + a;
      let i = mid.get(k);
      if (i !== undefined) return i;
      const p = [verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]];
      const l = Math.hypot(p[0], p[1], p[2]);
      i = verts.length; verts.push([p[0] / l, p[1] / l, p[2] / l]); mid.set(k, i);
      return i;
    };
    for (const f of faces) {
      const a = midpoint(f[0], f[1]), b = midpoint(f[1], f[2]), c = midpoint(f[2], f[0]);
      nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = nf;
  }
  const pos = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) { pos[i * 3] = verts[i][0]; pos[i * 3 + 1] = verts[i][1]; pos[i * 3 + 2] = verts[i][2]; }
  const idx = new Uint16Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) { idx[i * 3] = faces[i][0]; idx[i * 3 + 1] = faces[i][1]; idx[i * 3 + 2] = faces[i][2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

const ICO1 = icoSphere(1);   // 42 verts, 80 tris — small lumps and pods
const ICO2 = icoSphere(2);   // 162 verts, 320 tris — rocks
const ICO3 = icoSphere(3);   // 642 verts, 1280 tris — hand-tool shells
/*
 * ICO4 EXISTS BECAUSE A SUPERELLIPSOID CANNOT BE THINNER THAN ITS OWN FACETS.
 *
 * An icosphere spreads its vertices uniformly over a SPHERE. superShape() then
 * scales each one down the ray to |x/a|^r+|y/b|^r+|z/c|^r = 1, which means an
 * anisotropic part gets no extra vertices along its short axis — it gets FEWER,
 * because the warp pulls them together where the surface turns over. Auditing
 * every part on both hero tools against its own thinnest dimension:
 *
 *   part                  thinnest   ICO2 facet error   ratio
 *   scanner split line      5.2 mm         47.0 mm       9.0x
 *   scanner gap slab        6.8 mm         30.4 mm       4.5x
 *   scanner band stripe     6.8 mm         14.2 mm       2.1x
 *   scanner screen bezel   11.6 mm         15.0 mm       1.3x
 *   scanner louvre (ICO1)   3.2 mm          5.5 mm       1.7x
 *
 * A facet error larger than the part's own thickness means the mesh cannot
 * represent the part at all: some of it collapses inside its host and some of it
 * sticks out, and where it exits is decided by rounding rather than by the
 * model. That is precisely the row of hard black wedges a critic read across the
 * scanner shell, and the brown lens through the top of it. At the framing these
 * tools are shot at, 370 px across 0.115 m, 15 mm of facet error is 48 PIXELS.
 *
 * Two conclusions, and this file now acts on both. Parts above about 4:1 aspect
 * are DELETED rather than subdivided — no subdivision rescues the split line,
 * which is still 18 mm of error at ICO4 — and the parts worth keeping are moved
 * to a level whose error is comfortably under their thickness.
 */
const ICO4 = icoSphere(4);   // 2562 verts, 5120 tris — the thin, near-tangent inlays

/**
 * Superellipsoid from a welded icosphere: |x/a|^r + |y/b|^r + |z/c|^r = 1.
 * r = 2 is an ellipsoid, r = 6 is a rounded box, and the normals stay smooth
 * and welded either way — which is why every manufactured part in this file is
 * one of these rather than a BoxGeometry with four visible creases.
 */
function superShape(a, b, c, r = 5, src = ICO3) {
  const g = src.clone();
  const p = g.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const nx = p[i], ny = p[i + 1], nz = p[i + 2];
    const s = Math.pow(
      Math.pow(Math.abs(nx / a), r) + Math.pow(Math.abs(ny / b), r) + Math.pow(Math.abs(nz / c), r),
      -1 / r);
    p[i] = nx * s; p[i + 1] = ny * s; p[i + 2] = nz * s;
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A rounded, bedded seabed nodule. LOOK.md section 7: nothing has a sharp edge
 * or a flat plane, and geometry that meets the sand at a hard intersection line
 * is a named amateur tell — so the profile flares out at the base into a low
 * skirt that reads as sediment piled against it.
 */
function nodeBlob(seed, { r = 0.42, warp = 0.34, knuckles = 3, squash = 0.72, skirt = 1.45, src = ICO2 } = {}) {
  const g = src.clone();
  const p = g.attributes.position.array;
  const rng = makeRNG(seed);
  const lobes = [];
  for (let i = 0; i < knuckles; i++) {
    const th = rng() * TAU, ph = Math.acos(rng.range(-0.35, 1));
    lobes.push([Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.7, Math.sin(ph) * Math.sin(th),
      rng.range(0.16, 0.38), rng.range(0.5, 1.05)]);
  }
  const ox = rng() * 40, oz = rng() * 40;
  for (let i = 0; i < p.length; i += 3) {
    const nx = p[i], ny = p[i + 1], nz = p[i + 2];
    let rad = 1 + warp * fbm3(nx * 2.1 + ox, ny * 2.1, nz * 2.1 + oz, 3);
    for (const L of lobes) {
      const d = nx * L[0] + ny * L[1] + nz * L[2];
      rad += L[3] * Math.pow(Math.max(0, d), 1 / L[4] * 3);
    }
    // flatten and flare the underside so it beds into the sand
    const down = clamp01(-ny);
    rad *= 1 + skirt * 0.16 * down * down;
    const y = ny * rad * squash * (1 - 0.30 * down);
    p[i] = nx * rad * r; p[i + 1] = y * r; p[i + 2] = nz * rad * r;
  }
  g.computeVertexNormals();
  return g;
}

/** Angular mineral cluster: 5-9 tapered prisms fanning off a low base. */
function crystalCluster(seed, { r = 0.26, n = 7, h = 1.5 } = {}) {
  const rng = makeRNG(seed);
  const geos = [];
  const base = nodeBlob(seed ^ 0x51, { r: r * 0.9, warp: 0.30, knuckles: 2, squash: 0.42, src: ICO1 });
  geos.push(base);
  for (let i = 0; i < n; i++) {
    const len = r * h * rng.range(0.55, 1.35);
    const wid = r * rng.range(0.18, 0.34);
    const c = new THREE.CylinderGeometry(wid * 0.20, wid, len, 5, 1);
    // pyramid tip
    const tip = new THREE.ConeGeometry(wid * 0.20, len * 0.30, 5, 1);
    tip.translate(0, len * 0.65, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      rng.range(-0.75, 0.75), rng() * TAU, rng.range(-0.75, 0.75)));
    const px = rng.range(-1, 1) * r * 0.55, pz = rng.range(-1, 1) * r * 0.55;
    m.compose(new THREE.Vector3(px, len * 0.42 + r * 0.05, pz), q, new THREE.Vector3(1, 1, 1));
    c.applyMatrix4(m); tip.applyMatrix4(m);
    geos.push(c, tip);
  }
  return mergeGeos(geos);
}

/** Harvestable organic specimen: a bladed clump with three glowing pods. */
function organicClump(seed, { r = 0.5 } = {}) {
  const rng = makeRNG(seed);
  const geos = [];
  const holdfast = nodeBlob(seed ^ 0x77, { r: r * 0.55, warp: 0.4, knuckles: 2, squash: 0.5, src: ICO1 });
  geos.push(holdfast);
  const blades = 6 + (rng() * 4 | 0);
  for (let i = 0; i < blades; i++) {
    const h = r * rng.range(1.5, 3.2);
    const w = r * rng.range(0.09, 0.17);
    const bend = rng.range(0.25, 0.85);
    const rows = 6;
    const pts = [];
    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const taper = Math.sin((1 - t * 0.92) * Math.PI * 0.5);
      pts.push([t * t * bend * h * 0.55, t * h, w * taper]);
    }
    const g = ribbon(pts);
    const ang = (i / blades) * TAU + rng.range(-0.3, 0.3);
    g.rotateY(ang);
    g.translate(Math.cos(ang) * r * 0.22, r * 0.16, Math.sin(ang) * r * 0.22);
    geos.push(g);
  }
  return { body: mergeGeos(geos), pods: podGeo(rng, r) };
}
/**
 * The glowing pods. ICO2, not ICO1: at 42 vertices a superellipsoid this round
 * has a radial facet error of about 30% of its own radius, so the one part of
 * the node the eye is drawn to was a visibly faceted lump. 162 brings that to
 * roughly 3.5%, and the rim term in instanceTintedEmissive needs a smooth
 * silhouette to sit on or it just outlines the facets.
 */
function podGeo(rng, r) {
  const geos = [];
  for (let i = 0; i < 3; i++) {
    const s = r * rng.range(0.19, 0.30);
    const g = superShape(s, s * 1.3, s, 2.4, ICO2);
    const a = rng() * TAU;
    g.translate(Math.cos(a) * r * 0.42, r * rng.range(0.55, 1.25), Math.sin(a) * r * 0.42);
    geos.push(g);
  }
  return mergeGeos(geos);
}

/**
 * Blade through a list of [x, y, halfWidth] spine points.
 *
 * THIS FUNCTION USED TO EMIT NORMALS MADE ENTIRELY OF ROUNDING ERROR, and that
 * is the whole of the "flora two-sided lighting bug" the resource-node field was
 * blamed for. It wrote each quad TWICE, once per winding, to get a two-sided
 * strip — but the second set is the exact index reversal of the first, so every
 * face normal was accumulated together with its own negation. Verified in
 * isolation, outside the renderer: the float64 accumulation over all 14 vertices
 * of one blade is EXACTLY zero in every component. three then accumulates into a
 * Float32Array, so what survives is float32 dust — residues of 1e-10 against a
 * true face-normal magnitude of 3.3e-2, a ratio of 3e-8 — and normalizeNormals()
 * blows that dust up to unit length. The result reproduced three's own output to
 * four digits and shows adjacent vertices pointing in OPPOSITE directions
 * (v6 = -0.989,-0.148 next to v7 = +0.993,-0.114). Unit-length garbage, silently,
 * with no NaN to trip an assertion.
 *
 * Two consequences, and the fix addresses both. The duplicate winding is also
 * redundant: leafMat is already THREE.DoubleSide, and three flips the shading
 * normal for back faces via gl_FrontFacing, so ONE winding renders both sides
 * correctly and lights them correctly. And a dead-flat curtain has one normal
 * across its whole width, which is why the blades read as flat cut-outs even
 * before the normals were wrong — so the strip now carries a shallow bowed
 * cross-section (three columns rather than two), which is what makes a blade
 * catch a moving highlight down its length instead of flashing on and off as a
 * single plane.
 */
function ribbon(pts, bow = 0.30) {
  const n = pts.length;
  const COLS = 3;                       // -w, centre (bowed), +w
  const pos = new Float32Array(n * COLS * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const [x, y, w] = pts[i];
    // Spine tangent in the XY plane; the blade's own normal is perpendicular to
    // it there, and the bow displaces the centre column along that normal.
    const p = pts[Math.max(0, i - 1)], q = pts[Math.min(n - 1, i + 1)];
    let tx = q[0] - p[0], ty = q[1] - p[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const nx = ty, ny = -tx;            // in-plane normal
    const b = bow * w;
    for (let c = 0; c < COLS; c++) {
      const u = (c / (COLS - 1)) * 2 - 1;          // -1 .. +1 across the width
      const lift = b * (1 - u * u);                // parabolic bow, zero at edges
      const o = (i * COLS + c) * 3;
      pos[o] = x + nx * lift; pos[o + 1] = y + ny * lift; pos[o + 2] = u * w;
    }
    if (i < n - 1) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = i * COLS + c, d = a + COLS;
        // ONE winding only. See the note above.
        idx.push(a, a + 1, d, a + 1, d + 1, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Merge a list of position/normal geometries into one non-indexed buffer. */
function mergeGeos(list) {
  let total = 0;
  const parts = list.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.normal) ng.computeVertexNormals();
    total += ng.attributes.position.count;
    return ng;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

/**
 * Merge with a per-part material index, for multi-material hand tools.
 *
 * Parts are SORTED by material first so each material becomes exactly ONE
 * group. three issues one draw call per group, so the round-one version — a
 * group per part — charged nine draws for a nine-part scanner and twelve for
 * the fabricator. Sorted, a tool costs one draw per material it actually uses
 * no matter how many pieces it is modelled from, which is what pays for the
 * five-finger hand and the forearm below.
 */
function mergeGroups(list) {
  if (!list.length) return mergeGeos([]);
  const sorted = list.slice().sort((a, b) => a.m - b.m);
  const g = mergeGeos(sorted.map((x) => x.geo));
  const count = (x) => (x.geo.index ? x.geo.index.count : x.geo.attributes.position.count);
  let o = 0, runStart = 0, runMat = sorted[0].m;
  for (const x of sorted) {
    if (x.m !== runMat) { g.addGroup(runStart, o - runStart, runMat); runStart = o; runMat = x.m; }
    o += count(x);
  }
  g.addGroup(runStart, o - runStart, runMat);
  return g;
}

// ===========================================================================
// 6. THE LAMP
// ===========================================================================
/** Every uniform UNDERWATER_PARS declares, so a custom shader can include it. */
function mediumUniforms(extra) {
  return Object.assign({
    uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor,
    uFogColor: U.uFogColor, uScatterColor: U.uScatterColor,
    uScatterStrength: U.uScatterStrength, uAbsorption: U.uAbsorption,
    uMaxVisibility: U.uMaxVisibility, uSkyAtten: U.uSkyAtten,
    uScatterG: U.uScatterG, uGainChroma: U.uGainChroma,
    uCausticsTex: U.uCausticsTex, uCausticsScale: U.uCausticsScale,
    uCausticsStrength: U.uCausticsStrength, uCausticsSpeed: U.uCausticsSpeed,
    uDepthDarken: U.uDepthDarken, uWaterLevel: U.uWaterLevel,
    uUnderwater: U.uUnderwater,
    uMatCaustics: { value: 0 }, uMatFogScale: { value: 1 },
  }, extra);
}

/**
 * HOW MUCH DAYLIGHT IS STILL HERE — core's own depth response, in JS.
 *
 * This is exactly the `uwDark` of core/underwaterMaterial.js's UNDERWATER_FRAG:
 *
 *     sunT   = exp(-uAbsorption * pointDepth * 0.42)
 *     uwDark = mix(0.06, 1.0, sunT.b) * uDepthDarken
 *
 * Both halves of this module need it and both used to approximate it with
 * uDepthDarken alone, which is a shallow-biased ramp: it reads 0.47 at the 193 m
 * cave, where the frame's actual median luminance is 6/255. Driving the lamp's
 * darkness adaptation off that number is why the lamp measured a contribution of
 * ZERO pixels in that frame while measuring 12-14% of the frame at 14 m and at
 * 681 m. Read from the same uniforms core reads, and the tool, the beam and the
 * seabed all describe the same water.
 *
 * Measured live: 0.74 at 20 m (day), 0.77 at 14 m, 0.028 at 193 m, 0.009 at 681 m.
 */
function mediumDark() {
  const depthM = Math.max(0, U.uWaterLevel.value - U.uCamPos.value.y);
  const sunTb = Math.exp(-U.uAbsorption.value.z * depthM * 0.42);
  return (0.06 + 0.94 * sunTb) * clamp01(U.uDepthDarken.value);
}

/*
 * ===========================================================================
 * THE LAMP — round 8 rebuild
 * ===========================================================================
 *
 * WHAT WAS WRONG, MEASURED RATHER THAN GUESSED. A whole-game critic:
 *
 *   "The flashlight renders as a hard-edged glowing DISC — a flat bright
 *    ellipse with a visible dither grid inside, drawn in front of the world and
 *    saturating to white."
 *
 * Four independent causes, all of them arithmetic:
 *
 * 1. THE KNEE WAS MAKING THE DISC, not protecting against one. The old chain
 *    ended in outCol *= 1/(1 + L*uKnee), which asymptotes to 1/uKnee. Working
 *    the numbers for a night dive: the surface term arrives at 2.26 scene-linear
 *    at 4 m and 0.88 at 8 m, while the ceiling is 0.193 — so 1 m and 15 m came
 *    out at 0.178 and 0.118, a 1.5:1 range across the ENTIRE pool. Every trace
 *    of N.L, of inverse-square and of the medium's own colour was being crushed
 *    out by the last line of the shader, which is precisely the definition of a
 *    flat bright ellipse. The fix is not a better knee, it is to put the raw
 *    values two decades BELOW any ceiling and let the physics do the shaping.
 *
 * 2. THE PHASE FUNCTION HAD THE WRONG SIGN. The lamp sits at the eye, so a
 *    particle in the beam is lit from behind the camera and scatters BACK toward
 *    it: the scattering angle is ~180 degrees. The old code evaluated
 *    hg(dot(rd, -L), 0.32), which is the FORWARD peak. For g = 0.32 that is
 *    2.854 against the backscatter lobe's 0.390 — the beam was running 7.3x too
 *    bright by construction, and no amount of tuning uVolume could fix the
 *    shape, only the level.
 *
 * 3. THE MARCH WAS SAMPLING THE WRONG SPACE, which is the dither grid. The
 *    integrand is sigmaS*I/d^2, so with 14 samples spread UNIFORMLY over 0.55 to
 *    40 m, thirteen of them landed where the integrand is ~0 and one landed
 *    where it is everything. That is 100% variance on a per-pixel hash, i.e. a
 *    fixed screen-space noise pattern. Substituting v = 1/t makes dt/t^2 = -dv
 *    exactly, so uniform steps in v carry CONSTANT weight and the 1/d^2 spike
 *    disappears from the estimator entirely. The second grid — 3x3 pixel blocks
 *    — was the half-res depth prepass being point-sampled for the march's end
 *    point; that is now bilinear.
 *
 * 4. THE POOL WAS ADDITIVE WITH A CONSTANT ALBEDO, so a torch put the same
 *    light on black basalt as on white sand and painted over whatever texture
 *    was under it. That is the "flat radial gradient billboard". The pool is now
 *    composited as dst * (1 + Lm) through a DstColor blend, so it MULTIPLIES the
 *    surface that is already there and inherits its albedo, its panel lines and
 *    its surface microstructure for free. A small additive floor rides alongside
 *    it, tinted by the medium and shaped by a depth-derived cavity term, so
 *    geometry that the ambient left at zero still reveals.
 *
 * LOOK.md 3: lamps never cast caustics. This one does not, at any depth.
 */

/**
 * Ray reconstruction, soft depth, and the reflector's intensity distribution —
 * shared verbatim by both halves so they cannot disagree about where the world
 * is or where the cone points.
 */
const LAMP_COMMON = /* glsl */ `
uniform vec3  uLampPos;
uniform vec3  uLampDir;
uniform vec3  uLampCol;
uniform float uIrrNorm;      // normalises irr to 1.0 on axis at LAMP_DREF
uniform float uSpreadInv;    // 1 / (1 - cos(outer half angle))
uniform float uRange;
uniform float uHasDepth;
uniform sampler2D uDepthTex;
uniform vec2  uTexel;        // one texel of the HALF-RES depth prepass
uniform float uNearCut;      // everything closer than this is the player's own hands
uniform float uNear, uFar;
uniform mat3  uCamBasis;
uniform float uTanHalf, uAspect;
varying vec2 vNdc;

/*
 * Distance along the view ray to the nearest geometry, from the half-res packed
 * copy of the ENGINE's own depth attachment that Lamp.preRender writes each
 * frame. See the comment on Lamp._copyDepth for why the source changed and what
 * it cost us to keep reading the old one.
 *
 * uNearCut is the far extent of the player's own view model, measured from its
 * bounding sphere every frame rather than guessed: the hand and the tool DO
 * write depth in the main pass, and without this the pool's 1/d^2 term lands on
 * the glove at 45 cm and puts a flare on the fist. Capped rather than returned
 * as 1e6, because geomDistSoft below interpolates between taps and an infinity
 * would smear across every silhouette in the frame.
 */
float rawDist(vec2 uv, float rayLen, float far) {
  // metres along -Z, already linear; 0 is the sentinel for "no geometry"
  float vz = texture2D(uDepthTex, uv).x;
  if (vz <= 0.0) return far;
  float dist = vz * rayLen;
  return dist < uNearCut ? far : min(dist, far);
}

/*
 * BILINEAR distance, for the volumetric march only.
 *
 * The prepass is 640x360 against a 1920x1080 frame, so a point sample holds the
 * same value across a 3x3 pixel block; the march's end point then jumps in
 * 3-pixel steps and the integral steps with it. That is the visible grid inside
 * the old disc — not dithering at all, but the depth buffer's own resolution
 * printed onto the beam. Interpolating gives a wrong distance ON a silhouette
 * and the right one everywhere else, which for a soft volumetric cut-off is
 * exactly the trade we want.
 */
float geomDistSoft(vec2 uv, float rayLen, float far) {
  vec2 t = uv / uTexel - 0.5;
  vec2 i = floor(t), f = t - i;
  vec2 b = (i + 0.5) * uTexel;
  float d00 = rawDist(b, rayLen, far);
  float d10 = rawDist(b + vec2(uTexel.x, 0.0), rayLen, far);
  float d01 = rawDist(b + vec2(0.0, uTexel.y), rayLen, far);
  float d11 = rawDist(b + uTexel, rayLen, far);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}

/*
 * World position of the surface under a screen uv, off the SMOOTH depth field.
 *
 * This function used to read rawDist, and that put the grid straight back into
 * the frame by a second route: the normal and the cavity term below are
 * differences of it, so a field that is piecewise constant over 3x3 pixel blocks
 * gives a normal that is piecewise constant over 3x3 pixel blocks, and a play
 * route photographed a checkerboard inside the light pool on a smooth cliff
 * face. geomDistSoft's weights are smoothstepped rather than linear, so the
 * field is C1 and its differences are continuous — no texel boundary anywhere in
 * it for the eye to find.
 */
vec3 worldAt(vec2 uv, float far) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 rv = vec3(ndc.x * uTanHalf * uAspect, ndc.y * uTanHalf, -1.0);
  float rayLen = length(rv);
  return uCamPos + (uCamBasis * (rv / rayLen)) * geomDistSoft(uv, rayLen, far);
}

/*
 * THE REFLECTOR'S INTENSITY DISTRIBUTION — and the other half of why the old
 * lamp read as a disc.
 *
 * The old spot() was smoothstep(cosOuter, cosInner, c): a PLATEAU across the
 * inner 8 degrees with a narrow rim at the edge. Viewed from the apex — which is
 * the only way a first-person player ever sees their own torch — a plateau in
 * angle projects to a plateau in screen space, i.e. a flat ellipse with a hard
 * shoulder. Every real reflector has a smooth bell instead: bright on axis,
 * falling continuously, reaching zero exactly at the rim. Written in u = the
 * normalised angular coordinate, this is a smoothstep window times a Gaussian,
 * which is C1 at both ends and therefore has no edge to see.
 */
/*
 * AND THE SPILL, which is the difference between a pool and a spotlight.
 *
 * With the main bell alone the torch still drew a circle: a play route caught it
 * landing on a near cliff face at 95 m, where the pool measured roughly 8:1
 * against a surround the ambient had left at nothing, so the lit patch had no
 * context to belong to and read as a disc floating in front of the rock. Look at
 * what a real lamp does in cave-2.jpg and deep-void-2.jpg and the beam is only
 * half the story — the housing leaks, the reflector spills past its own rim, and
 * a broad dim wash covers two or three times the beam angle. That wash is what
 * puts the bright pool INSIDE a lit region instead of on a black field, and ten
 * per cent of peak over twice the angle costs nothing and fixes the read.
 */
float lampI(float c) {
  float a = 1.0 - c;
  float u = clamp(a * uSpreadInv, 0.0, 1.0);
  float w = 1.0 - u;
  float core = w * w * (3.0 - 2.0 * w) * exp(-1.9 * u * u);
  float us = clamp(a * uSpreadInv * 0.26, 0.0, 1.0);
  float ws = 1.0 - us;
  return core + ws * ws * ws * 0.115;
}

/*
 * Windowed inverse square, then a soft knee on the result.
 *
 * The window reaches exactly zero at uRange, so the reach term can never draw
 * its own contour the way a bare smoothstep did, and the 1.6 in the denominator
 * is the reflector's finite size — a torch head is not a point, so 1/d^2 has to
 * stop somewhere or the first metre runs away. Even with it, 0.4 m against the
 * 2.5 m normalising distance is still a factor of 4.4, and a play route caught
 * exactly that: a kelp blade drifting inside a metre of the lens came back at
 * 250/255 with a bloom halo, in a frame whose water reads 30. The knee holds the
 * shading intact out where the pool actually lives and asymptotes to 3.2 rather
 * than to infinity, so nothing the player swims into can blow.
 */
float lampAtten(float d) {
  float k = clamp(1.0 - pow(d / uRange, 4.0), 0.0, 1.0);
  float a = k * k / (d * d + 1.6);
  float x = a * 7.85;                       // in units of the value at 2.5 m
  return (x / (1.0 + x * 0.16)) / 7.85;
}

/*
 * Interleaved gradient noise (Jimenez). A screen hash of sin(dot(fragCoord,...))
 * is white noise and reads as speckle when a 12-sample estimator leans on it;
 * IGN is spectrally shaped so the residual sits in a band the eye reads as
 * texture rather than as dirt, and it costs the same two instructions.
 */
float lampIGN(vec2 p, float t) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)) + t));
}

/*
 * Normal from the depth buffer. The nearer of the forward and backward
 * difference on each axis, which is what stops a silhouette edge from tilting
 * the normal ninety degrees and stamping a hard black crescent into the pool.
 */
vec3 normalAt(vec2 uv, vec3 p0, float far) {
  vec3 xp = worldAt(uv + vec2(uTexel.x, 0.0), far) - p0;
  vec3 xm = p0 - worldAt(uv - vec2(uTexel.x, 0.0), far);
  vec3 yp = worldAt(uv + vec2(0.0, uTexel.y), far) - p0;
  vec3 ym = p0 - worldAt(uv - vec2(0.0, uTexel.y), far);
  vec3 dx = dot(xp, xp) < dot(xm, xm) ? xp : xm;
  vec3 dy = dot(yp, yp) < dot(ym, ym) ? yp : ym;
  vec3 n = cross(dx, dy);
  float l = length(n);
  return l > 1e-8 ? n / l : vec3(0.0, 1.0, 0.0);
}
`;

/*
 * ===========================================================================
 * THE DEPTH THE LAMP ACTUALLY READS — round 32, and this is why it was dark
 * ===========================================================================
 *
 * Both lamp passes are deferred: they need a distance per pixel or they have
 * nothing to light. They used to read render/underwater.js's published
 * `depthTexture`, which is that module's own half-res prepass rendered with
 * `scene.overrideMaterial = MeshDepthMaterial`.
 *
 * MEASURED, by reading that buffer back with readRenderTargetPixels and
 * decoding it with three's own unpack constants: on `shallows-floor` — camera
 * pointed straight down at sand a few metres away — 88.56% of its texels decode
 * to a view distance of 0.080 m, which is the camera's near plane to three
 * significant figures, and the remaining 11.44% are the far-plane clear. On
 * `night-shallows` it is 53.70% near-plane and 46.30% clear. There is no texel
 * anywhere in that buffer carrying a real distance. An override material
 * replaces every custom vertex shader in the scene, and this game's terrain,
 * flora and instanced fields all compute their world positions IN the vertex
 * stage, so under the override they collapse onto their object origins.
 *
 * The consequence for this file was total. rawDist's near guard turned every
 * one of those texels into "open water", so `sceneD >= uRange` was true on
 * 100% of the frame and BOTH the lit pool and the additive reveal floor
 * `discard`ed on every pixel. Verified end to end: with exposure pinned
 * (`?meter=0`) so the auto-exposure loop cannot mask it, flashlight ON against
 * flashlight OFF measured 9.777e-2 against 9.772e-2 mean linear luminance on
 * the cave floor in front of the player (+0.05%) and 1.128e-2 against 1.127e-2
 * on the night-shallows seabed (+0.09%) — under the 0.4% noise floor, i.e. a
 * torch that lights nothing. Boosting both terms EIGHT times
 * (`?lamppool=8&lampadd=8`) reproduced `shallows-floor` to every digit of every
 * statistic measure.mjs reports. That is not a level that needs tuning; it is a
 * pass that never ran.
 *
 * The fix is to stop reading a reconstruction of the scene and read the scene.
 * core/engine.js renders into an HDR target that owns a real FloatType
 * DepthTexture, written by every material's OWN vertex shader — render/postfx.js
 * already reads it for TAA, DoF and AO, so it is known good. It cannot be
 * sampled while that target is bound (the lamp draws INTO it), so Lamp.preRender
 * copies it into a half-res packed target of our own BEFORE the frame is drawn.
 * That copy is therefore the PREVIOUS frame's depth, which for a light pool is
 * exactly right: one frame of lag on where a torch lands is invisible in motion
 * and identical in a settled capture, and it costs one half-res fullscreen draw
 * instead of a second pass over the whole scene.
 *
 * This is reported upstream as a defect in render/underwater.js rather than
 * worked around there: anything else reading that prepass — god-ray occlusion
 * above all — is reading the same near-plane wall.
 */
const DEPTH_COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DEPTH_COPY_FRAG = /* glsl */ `
#include <common>
uniform sampler2D uSrcDepth;
uniform vec2 uSrcTexel;
uniform float uNear, uFar;
varying vec2 vUv;
void main() {
  /*
   * Downsampling depth by averaging is meaningless — the average of a near and
   * a far sample is a distance at which there is nothing. Take the NEAREST of
   * the four full-res texels under this half-res one, which is the conventional
   * choice for an occlusion consumer: it dilates silhouettes by half a texel
   * rather than smearing a surface into the void behind it, and geomDistSoft's
   * C1 filter downstream hides the half texel.
   */
  vec2 o = uSrcTexel * 0.5;
  float d = texture2D(uSrcDepth, vUv + vec2(-o.x, -o.y)).x;
  d = min(d, texture2D(uSrcDepth, vUv + vec2(o.x, -o.y)).x);
  d = min(d, texture2D(uSrcDepth, vUv + vec2(-o.x, o.y)).x);
  d = min(d, texture2D(uSrcDepth, vUv + vec2(o.x, o.y)).x);
  /*
   * LINEARISE HERE, and store METRES rather than a packed window depth.
   *
   * The obvious thing is packDepthToRGBA into an RGBA8 target, and it was the
   * first thing this did. It does not survive the round trip: read back and
   * decoded with three's own unpack constants, a texel whose true window depth
   * is 0.9985 (53 m) came back as 1.8e-3, which reconstructs to 0.080 m — the
   * near plane — over the whole buffer. Storing the linear distance instead
   * removes the pack, the unpack, and the near/far reconstruction from the hot
   * path in one go, and it is also where the precision wants to be: with a
   * near plane of 0.08 m against a far of 6000, window depth spends more than
   * half its range inside the first 16 cm and has almost none left at the 26 m
   * the lamp actually works over. Half float carries ~3 significant digits at
   * any magnitude, so 26 m resolves to about a centimetre.
   *
   * 0 means "no geometry": the far-plane clear linearises to uFar, which the
   * consumer would then have to compare against, and an exact sentinel is
   * cheaper and cannot drift with the projection.
   */
  float vz = (d >= 1.0) ? 0.0 : -((uNear * uFar) / ((uFar - uNear) * d - uFar));
  gl_FragColor = vec4(vz, 0.0, 0.0, 1.0);
}`;

const LAMP_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  vUwWorldPos = uCamPos;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * PASS 1 — THE LIT POOL, as a multiply.
 *
 * Blended dst*src + dst, i.e. dst * (1 + Lm). The surface the torch lands on
 * keeps its own albedo, its own panel lines and its own surface microstructure,
 * and every one of those is brightened by the same factor rather than being
 * painted over by a constant. It is also self-correcting for the medium: dst has
 * already been through core's uwTransmittance over the same view path the lamp's
 * return leg travels, so the view-ray extinction cancels out of the ratio and
 * only the lamp's OUTBOUND leg needs applying. That is why there is one
 * uwTransmittance in here and not two.
 *
 * Gated on there being geometry inside uRange, so open water is left exactly as
 * the medium drew it and the cone stays the additive pass's job.
 */
const LAMP_POOL_FRAG = /* glsl */ `
#include <common>
#include <packing>
${UNDERWATER_PARS}
${LAMP_COMMON}
uniform float uMulGain;
uniform float uMulMax;


void main() {
  if (uHasDepth < 0.5) discard;
  float far = uRange * 4.0;
  vec3 rv = vec3(vNdc.x * uTanHalf * uAspect, vNdc.y * uTanHalf, -1.0);
  float rayLen = length(rv);
  vec3 rd = uCamBasis * (rv / rayLen);
  vec2 uv = vNdc * 0.5 + 0.5;

  /*
   * THE PRIMARY TAP IS SMOOTH TOO, and this was the last of the grid.
   *
   * The prepass is half res, so a point sample holds one distance across each
   * 2x2 block of pixels — which quantises Ld, and therefore lampAtten and the
   * cone angle, into 2x2 blocks. Zoomed 5x on a light pool at 91 m that is a
   * regular checkerboard, faint but perfectly periodic, and periodic is exactly
   * what an eye finds. Smoothing worldAt fixed the NORMAL and left this; both
   * have to come off the same C1 field or the pool carries the buffer's
   * resolution as a texture.
   */
  float sceneD = geomDistSoft(uv, rayLen, far);
  if (sceneD >= uRange) discard;

  vec3 P = uCamPos + rd * sceneD;
  vec3 Lv = uLampPos - P;
  float Ld = max(length(Lv), 0.05);
  vec3 L = Lv / Ld;
  // The cone test comes BEFORE the normal: normalAt is four more depth taps and
  // there is no point paying for them on a pixel the lamp cannot reach.
  float I = lampI(dot(-L, uLampDir));
  if (I < 0.002) discard;

  vec3 N = normalAt(uv, P, far);
  float ndl = max(dot(N, L), 0.0);
  // Wrapped diffuse: underwater there is enough multiple scattering that a
  // surface angled away from a lamp is dim, not black.
  ndl = (ndl + 0.22) / 1.22;

  float irr = uIrrNorm * I * lampAtten(Ld) * ndl;
  /*
   * SOFT SATURATION, not min(). A hard clamp on the gain draws its own contour:
   * every fragment inside the clamp distance renders at exactly uMulMax, so the
   * pool grows a flat plateau with a visible boundary — which is the round-seven
   * disc rebuilt out of different arithmetic. g/(g+uMulMax) asymptotes to
   * uMulMax with no discontinuity anywhere, so the pool keeps a live gradient
   * from the reflector all the way out to the rim and still cannot blow a
   * surface that was already bright.
   */
  vec3 g = vec3(irr * uMulGain) * uwTransmittance(Ld);
  vec3 gain = uMulMax * g / (g + vec3(uMulMax));
  gl_FragColor = vec4(gain, 1.0);
}`;

/**
 * PASS 2 — THE CONE IN THE WATER, plus the floor that reveals unlit geometry.
 *
 * Additive, because both of these are radiance the medium and the seabed did not
 * already have. Two terms:
 *
 *   FLOOR   the pool again, at the reflectance of the darkest thing in the
 *           world (uAddKey carries it) and tinted by the water rather than by
 *           the torch. Pass 1 is a ratio and therefore cannot lift a pixel the
 *           ambient left at zero, which is most of a cave; this can. It is
 *           shaped by a depth-derived cavity term so it lands on the surface's
 *           form rather than as a decal.
 *   CONE    single scattering along the view ray, importance sampled in 1/t.
 */
const LAMP_ADD_FRAG = /* glsl */ `
#include <common>
#include <packing>
${UNDERWATER_PARS}
${LAMP_COMMON}
uniform vec3  uAddKey;
uniform float uVolKey;
uniform float uDither;
uniform vec3  uNearCancel;
uniform float uKnee;

float hgN(float c, float g) {
  float g2 = g * g;
  float num = pow(max(1.0 + g2 - 2.0 * g, 1e-4), 1.5);
  return num * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), -1.5);
}

void main() {
  float far = uRange * 4.0;
  vec3 rv = vec3(vNdc.x * uTanHalf * uAspect, vNdc.y * uTanHalf, -1.0);
  float rayLen = length(rv);
  vec3 rd = uCamBasis * (rv / rayLen);
  vec2 uv = vNdc * 0.5 + 0.5;

  float camDepth = max(0.0, uWaterLevel - uCamPos.y);
  // An upward ray leaves the water at the surface, exactly as core's uwInscatter
  // cuts it. Past that there is no medium for the lamp to light.
  float tSurf = (rd.y > 1e-3) ? camDepth / max(rd.y, 1e-3) : 1e9;

  vec3 outCol = vec3(0.0);

  // ---- the floor under the pool -----------------------------------------
  if (uHasDepth > 0.5) {
    // Smooth, for the same reason as pass 1 — see the comment there.
    float sceneD = geomDistSoft(uv, rayLen, far);
    if (sceneD < uRange && sceneD < tSurf) {
      vec3 P = uCamPos + rd * sceneD;
      vec3 Lv = uLampPos - P;
      float Ld = max(length(Lv), 0.05);
      vec3 L = Lv / Ld;
      float I = lampI(dot(-L, uLampDir));
      if (I > 0.002) {
        /*
         * THE SAME N.L PASS 1 USES, off the same reconstructed normal.
         *
         * This term is the only thing in the shader that can read as a decal,
         * because it is what lights geometry the ambient left at nothing — so it
         * is the one that most needs to land on the surface's own form. The
         * first cut approximated that with a slope built out of raw neighbour
         * distances, and the approximation was a no-op: at one prepass texel of
         * separation a 45-degree surface three metres out differs by about a
         * centimetre, so the term sat at 1.0 everywhere except silhouettes.
         * normalAt costs the same four taps and is the real quantity.
         */
        vec3 N = normalAt(uv, P, far);
        float ndl = clamp((max(dot(N, L), 0.0) + 0.22) / 1.22, 0.0, 1.0);
        float irr = uIrrNorm * I * lampAtten(Ld) * ndl;
        outCol += uAddKey * irr * uwTransmittance(Ld) * uwTransmittance(sceneD);
      }
    }
  }

  // ---- the cone in the water --------------------------------------------
  // Cheap conservative reject: the lamp sits within ~45 cm of the eye, so a
  // pixel whose view ray is well outside the cone can never be lit by it at any
  // range. This is what keeps a full-screen quad costing cone area.
  if (uVolKey > 0.0 && (1.0 - dot(rd, uLampDir)) * uSpreadInv < 1.6) {
    float tEnd = min(min(geomDistSoft(uv, rayLen, far), mix(1e9, tSurf, uUnderwater)), uRange);
    // Start clear of the reflector. Integrating from zero puts a 1/d^2 ball of
    // light on the muzzle itself, which reads as a flare stuck to the hand.
    float t0 = min(0.62, tEnd * 0.30);
    if (tEnd > t0 + 0.02) {
      /*
       * IMPORTANCE SAMPLED IN 1/t. With v = 1/t, dt/t^2 = -dv exactly, so
       * uniform steps in v carry CONSTANT weight and the 1/d^2 spike is gone
       * from the estimator rather than being hammered flat by more samples.
       * Twelve of these are quieter than fifty uniform ones.
       */
      float v0 = 1.0 / t0, v1 = 1.0 / tEnd;
      float dv = (v0 - v1) / 12.0;
      float jit = lampIGN(gl_FragCoord.xy, uDither);
      /*
       * THE SCATTERING COEFFICIENT follows uScatterColor, not uAbsorption.
       * Absorption REMOVES light; it does not scatter it toward the eye, and
       * red is the most absorbed channel by an order of magnitude — driving
       * in-scattering with it is what made a previous round's beam measure
       * R+25 G+6 B+6 in a 193 m cave. Normalised by LUMINANCE rather than by
       * the max channel: a torch emits the same lumens in every biome and only
       * the medium's HUE is the biome's to choose, and dividing by the max
       * channel made the violet cavern's beam a quarter as bright as the
       * shallows' purely as an artefact of the normaliser.
       */
      vec3 sc = uScatterColor * max(uScatterStrength, 0.05);
      float scL = max(dot(sc, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      vec3 sigmaS = min(sc / scL, vec3(3.5));
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float v = v1 + (float(i) + jit) * dv;
        float t = 1.0 / max(v, 1e-4);
        vec3 P = uCamPos + rd * t;
        vec3 Lv = uLampPos - P;
        float Ld = max(length(Lv), 0.05);
        vec3 L = Lv / Ld;
        // Squared, so the cone's own radial profile is steeper than the pool's.
        // The pool wants the wide flood a dive torch actually is; the medium
        // term wants no perceptible boundary anywhere, and a bell that is 0.23
        // at half-angle has none where a bell that is 0.5 there still reads as
        // the edge of a ball of fog.
        float I = lampI(dot(-L, uLampDir));
        I *= I;
        if (I > 0.0005) {
          /*
           * BACKSCATTER, and this is the sign the old shader had inverted. The
           * photon travels lamp -> particle along -L and leaves toward the eye
           * along -rd, so the scattering cosine is dot(-L, -rd) = dot(L, rd),
           * which is close to MINUS one because the lamp is at the eye. For
           * g = 0.32 that lobe is 0.137 of the forward peak: a torch beam seen
           * from behind is seven times dimmer than the same beam seen side-on,
           * and evaluating the forward peak instead is most of why this pass
           * used to out-shout the world it was lighting.
           */
          float ph = hgN(dot(rd, L), uScatterG);
          // The reflector is a finite emitter, so inverse square does not hold
          // inside ~30 cm of it; without this the first samples of every on-axis
          // ray sit inside the torch head and put a flare on the hand.
          float nf = smoothstep(0.28, 1.45, Ld);
          // t*t/(Ld*Ld) corrects the 1/t^2 the substitution assumed to the true
          // 1/Ld^2, which differ by the lamp's 30-45 cm offset from the eye.
          float geo = (t * t) / (Ld * Ld);
          acc += sigmaS * (I * ph * nf * geo * dv)
               * uwTransmittance(Ld) * uwTransmittance(t);
        }
      }
      outCol += uLampCol * acc * uVolKey;
    }
  }

  if (dot(outCol, vec3(1.0)) < 1e-7) discard;

  /*
   * CANCEL POSTFX'S NEAR-ZONE CHANNEL GAIN — see postfxNearGain(), which derives
   * this from the same uniform postfx derives its own from. postfx grades the
   * near field toward the reciprocal of the fog chromaticity on the argument
   * that near geometry has lost the least of what the medium eats. True of
   * geometry lit by the SUN, false of a pool lit by a torch whose light has
   * already made a two-way trip through the same water. Pass 1 needs no such
   * correction because it is a RATIO and the operator cancels out of it.
   */
  outCol = max(outCol, vec3(0.0)) * uNearCancel;
  /*
   * The knee is a safety and nothing more. It compresses LUMINANCE and rescales
   * the triple, so it cannot flatten the colour the water gave the beam, and its
   * asymptote is set six times above the pass's own operating point — so unlike
   * round seven's, which every pixel of the pool was pinned against, this one
   * only ever acts on a creature that drifts a metre off the reflector.
   */
  float lamL = max(dot(outCol, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  outCol *= (lamL / (1.0 + lamL * uKnee)) / lamL;
  gl_FragColor = vec4(outCol, 1.0);
}`;

/**
 * Motes inside the beam. LOOK.md section 6: particulate must take LOCAL light
 * and twinkle inside a lamp cone, and render/underwater.js's snow only knows
 * about the sun. These are a second, lamp-only population — a wrapping box of
 * specks that are invisible until the cone crosses them.
 */
const MOTE_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3  uLampPos;
uniform vec3  uLampDir;
uniform float uSpreadInv;
uniform float uRange;
uniform float uPixelScale;
uniform float uBoxSize;
attribute vec3 aSeed;
varying float vGlow;
// The same bell the two lamp passes use, so a mote cannot twinkle outside the
// cone the beam is drawing or sit on a hard rim the beam no longer has.
float moteI(float c) {
  float u = clamp((1.0 - c) * uSpreadInv, 0.0, 1.0);
  float w = 1.0 - u;
  return w * w * (3.0 - 2.0 * w) * exp(-1.9 * u * u);
}
void main() {
  // wrap the field around the eye so it is always populated and never streams
  vec3 p = aSeed * uBoxSize;
  p.y -= uTime * (0.28 + fract(aSeed.x * 37.0) * 0.5);
  p.x += sin(uTime * 0.21 + aSeed.z * 19.0) * 0.35;
  vec3 base = uCamPos + uLampDir * (uBoxSize * 0.32);
  vec3 wp = base + mod(p - base + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;

  vec3 Lv = uLampPos - wp;
  float Ld = max(length(Lv), 0.05);
  vec3 L = Lv / Ld;
  float sp = moteI(dot(-L, uLampDir));
  float reach = 1.0 - smoothstep(uRange * 0.35, uRange * 0.95, Ld);
  // twinkle: each mote has its own phase, so the field shimmers rather than
  // pulsing as one sheet
  float tw = 0.55 + 0.45 * sin(uTime * 2.6 + aSeed.y * 41.0);
  vGlow = sp * reach * tw / (0.8 + Ld * Ld * 0.30);

  vUwWorldPos = wp;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPixelScale * (0.006 + 0.010 * fract(aSeed.z * 53.0)) / max(-mv.z, 0.2), 1.3, 3.6);
}`;

const MOTE_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uLampCol;
uniform float uStrength;
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = exp(-r2 * 11.0);
  float dist = length(uCamPos - vUwWorldPos);
  gl_FragColor = vec4(uLampCol * (vGlow * uStrength * a) * uwTransmittance(dist), 1.0);
}`;

/*
 * THE LAMP'S LEVEL, IN UNITS OF THE WATER IT IS LIGHTING.
 *
 * Every previous round set the lamp's brightness as an absolute scene-linear
 * number and then fought the consequences with a knee. That cannot work, because
 * the number the critic actually reads is DISPLAY-referred and postfx
 * auto-exposes: the same 0.19 scene-linear that is a believable pool at 20 m is
 * pure white at 680 m, where the meter is pushing the frame several stops.
 *
 * So anchor on the medium, exactly as the view-model fill does. U.uFogColor is
 * the radiance a far-field horizontal ray resolves to — core normalises
 * uwInscatter to precisely that — so it is both the level and the hue of the
 * water the pool sits in, per biome and per depth, with no table.
 *
 * TWO CORRECTIONS ON TOP OF IT, both measured:
 *
 *   THE NIGHT GRADE. sky.js multiplies the whole submerged frame by
 *   (0.210, 0.079, 0.097) at renderOrder 9500 — luminance 0.108 — and this pass
 *   draws at 9800, AFTER it. uFogColor is identical at the 14 m night shot and
 *   the 20 m day shot (0.1594 against 0.1599, measured live), so a lamp anchored
 *   on uFogColor alone runs NINE TIMES too prominent at midnight. That is most
 *   of why night-shallows was the frame the disc decided.
 *
 *   THE DARK BONUS. LOOK.md 26 is explicit that below 200 m the only things that
 *   read are self-illuminated or lamp-lit, so a torch is entitled to be MORE
 *   prominent relative to its water down there — just not nine times more.
 *   A clamped 0.42-power of the ratio gives 1.0 in the shallows and 2.9 in the
 *   681 m frame, which is a torch taking over a dark scene rather than erasing
 *   one.
 */
const NIGHT_Y = 0.108;      // luminance of sky.js's NIGHT_MUL
const LAMP_FLOOR = 0.0030;  // the darkest water we will anchor to (void is 0.0045)
const LAMP_REF = 0.120;     // a lit shallow frame, for the dark bonus ratio
const LAMP_DREF = 2.5;      // metres: where the pool is normalised
const LAMP_SOFT = 1.60;     // reflector size in the inverse-square denominator
const IRR_NORM = LAMP_DREF * LAMP_DREF + LAMP_SOFT;   // = 7.85

/*
 * THE POOL'S LEVEL — RE-DERIVED NOW THAT THE POOL EXISTS.
 *
 * 0.95 / 1.60 / 0.95 were fitted across rounds 8-16 against a pass that was
 * discarding on every pixel of every frame (see DEPTH_COPY_VERT). They are not
 * evidence about anything, and read against a working pass they are far too
 * small: at 0.95, on axis in the 192 m cave, the multiply arrived at dst*1.05 at
 * 8 m — 5%, which is inside the noise floor of the instrument used to measure
 * it. The reason is not the constant alone, it is that a lamp pays inverse
 * square AND the medium's extinction on the outbound leg, and 8 m of Jellyshroom
 * water is most of a decade on its own.
 *
 * Set by sweep rather than by argument: `?lamppool=6&lampadd=8` against
 * `?flashlight=0`, both at `?meter=0` so the exposure loop cannot hide or
 * manufacture the difference. At 6x/8x the cave's whole-frame median moves 15.4
 * -> 15.6 (+1.3%), p99.9 is unchanged at 232.9, clipAny stays 0.08%, and the
 * difference image is a soft geometry-shaped wash that follows the stalactites
 * and the cavern floor and stops at their silhouettes. At 1x the same difference
 * image is empty. So 6x/8x is legible and still nowhere near a disc, and these
 * are those multipliers folded in.
 *
 * MUL_MAX has to rise with MUL_GAIN or the fix undoes itself: the saturation
 * asymptote is what stops the near field blowing, and left at 1.60 against a
 * gain of 5.7 every surface inside about 4 m would pin against it and the pool
 * would grow exactly the flat plateau round seven had. At 4.2 the on-axis gain
 * still runs 2.95 at 1 m against 1.73 at 2.5 m — a live gradient through the
 * whole near field.
 */
const MUL_GAIN = 5.70;      // pool: dst * (1 + MUL_GAIN) on axis at LAMP_DREF
const MUL_MAX = 4.20;       // and the soft asymptote it can never pass
const ADD_REL = 7.60;       // the reveal floor, in units of the water's radiance
/*
 * VOL_REL IS SMALL ON PURPOSE, and the reference is why. cave-1.jpg is a
 * Jellyshroom cavern at 209 m lit by a Seamoth's lamps and deep-void-2.jpg is a
 * lava-tube wall at 589 m lit by the same: in both, the lamp is legible ONLY as
 * a wash on the rock it lands on. There is no visible cone in the water at all,
 * at any depth, in any of the 58 reference frames. LOOK.md's own list of what a
 * lamp does underwater is two lines long and neither of them is "glows".
 *
 * Which makes sense from the apex: a cone seen end-on has no length to read, so
 * whatever it integrates to projects as a filled circle, and a filled circle in
 * front of the world is exactly the artefact this round exists to delete. Keep
 * enough of it that a torch in silty water is not a laser, and no more.
 */
const VOL_REL = 0.36;       // the cone in the water, same units
const MOTE_REL = 3.4;       // lamp-lit particulate, same units

/** The water's own radiance as this pass will actually see it. */
function lampAmbient() {
  const f = U.uFogColor.value;
  const fogY = 0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b;
  const day = clamp01(U.uSkyDay ? U.uSkyDay.value : 1);
  const nightW = smoothstep(0.02, 0.55, 1 - day) * clamp01(U.uUnderwater.value);
  return Math.max(fogY * (1 - (1 - NIGHT_Y) * nightW), LAMP_FLOOR);
}

/**
 * THE ONE LEVEL EVERY EMITTER ON THE PLAYER'S OWN GEAR IS ALLOWED, in units of
 * the water it will be photographed against.
 *
 * This is Lamp.update's own anchor at full power, factored out — because the
 * lamp was fixed this way three rounds ago and the view model's LIT PANELS were
 * not, and the panels are now the loudest thing left in a dark frame. Measured,
 * with the frozen uniforms read live: the torch's light-pipe collar emits green
 * 0.0955 against a medium of 0.00836 in the 192 m cave (11.4x the water) and
 * 0.146 against 0.00471 in the 681 m void (31x), while in the 14 m night frame
 * the same collar runs 1.10x. The relationship is upside down — the panels get
 * relatively brighter exactly where the reference shows a held device as a flat
 * silhouette.
 *
 * What that costs on screen, in a window holding only the held device, in both
 * images, at matched depth (ours cave 192 m, cave-1.jpg 209 m, both with the
 * lamp lit):
 *
 *   reference cave-1, Seaglide body 810-1130 x 780-900 : peak luminance 50.4,
 *     brightest pixel (47,49,74), pixels over luminance 150: 0, over 60: 0
 *   ours cave, torch head+body 1160-1600 x 550-900     : peak luminance 191.4,
 *     brightest pixel (13,241,225), pixels over 150: 10 937, over 60: 21 559
 *
 * Against frame medians of 21.5 and 22.4 that is 2.3x on the plate and 8.5x on
 * ours, and the plate has NO pixel anywhere on the device above a third of our
 * peak. So the fix is not a smaller number, it is the same anchor the lamp
 * already uses: a fixed ratio to the medium, with the same bounded dark bonus,
 * so a panel cannot out-run a frame the exposure meter has pushed several stops.
 */
function litAnchor() {
  const amb = lampAmbient();
  return amb * Math.pow(clamp(LAMP_REF / amb, 1, 9), 0.35);
}

class Lamp {
  constructor(scene, ctx) {
    this.on = false;
    this.power = 0;                 // eased 0..1, so the beam fades in
    this.pos = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.mode = 'hand';
    this.level = 0;

    /*
     * The engine's own depth attachment is the only depth in this project that
     * every material wrote with its real vertex shader — see the long comment
     * above DEPTH_COPY_VERT for the measurement that moved us onto it. We cannot
     * sample it while drawing into the target that owns it, so preRender mirrors
     * it into this half-res packed copy before the frame is rendered.
     */
    const srcDepth = ctx.engine?.hdrTarget?.depthTexture || null;
    this.hasDepth = !!srcDepth;
    this.depthRT = null;
    this.copy = null;
    if (srcDepth) {
      this.depthRT = new THREE.WebGLRenderTarget(2, 2, {
        format: THREE.RGBAFormat, type: THREE.HalfFloatType,
        colorSpace: THREE.NoColorSpace,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      this.depthRT.texture.name = 'tools.lampDepth';
      const cm = new THREE.ShaderMaterial({
        uniforms: {
          uSrcDepth: { value: srcDepth },
          uSrcTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
          uNear: { value: 0.08 }, uFar: { value: 6000 },
        },
        vertexShader: DEPTH_COPY_VERT, fragmentShader: DEPTH_COPY_FRAG,
        depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      });
      cm.name = 'tools.lampDepthCopy';
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cm);
      quad.frustumCulled = false;
      const cs = new THREE.Scene();
      cs.add(quad);
      this.copy = { scene: cs, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat: cm };
    } else {
      console.info('[tools] no engine depth attachment — the lamp pool and its '
        + 'reveal floor are off; only the cone in the water will draw.');
    }
    const depthTex = this.depthRT ? this.depthRT.texture : null;
    // ?lampvol=N ?lamppool=N ?lampadd=N — scale each of the three terms
    // independently, so "which half of the lamp is making this" is a capture
    // rather than an argument. ?lampvol=0 renders the pool alone.
    const dbg = (n, d) => {
      const v = ctx.params?.get?.(n);
      return (v === null || v === undefined || v === '' || !Number.isFinite(+v)) ? d : +v;
    };
    this._kVol = dbg('lampvol', 1);
    this._kMul = dbg('lamppool', 1);
    this._kAdd = dbg('lampadd', 1);

    // Uniforms shared by BOTH passes, so the two halves cannot disagree about
    // where the cone points or where the world is.
    const shared = {
      uLampPos: { value: this.pos },
      uLampDir: { value: this.dir },
      uLampCol: { value: new THREE.Color(1.0, 0.97, 0.88) },
      uIrrNorm: { value: IRR_NORM },
      uSpreadInv: { value: 1 / (1 - Math.cos(0.42)) },
      uRange: { value: 26 },
      uHasDepth: { value: this.hasDepth ? 1 : 0 },
      uDepthTex: { value: depthTex },
      uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
      // Replaced every frame from the view model's own bounding sphere; the
      // literal is only what frame zero uses before the rig has been posed.
      uNearCut: { value: 0.9 },
      uNear: { value: 0.08 }, uFar: { value: 6000 },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalf: { value: 0.6 }, uAspect: { value: 1.777 },
    };
    this.shared = shared;

    this.uPool = mediumUniforms(Object.assign({}, shared, {
      uMulGain: { value: 0 },
      uMulMax: { value: MUL_MAX },
    }));
    this.uAdd = mediumUniforms(Object.assign({}, shared, {
      uAddKey: { value: new THREE.Vector3() },
      uVolKey: { value: 0 },
      uDither: { value: 0 },
      uNearCancel: { value: new THREE.Vector3(1, 1, 1) },
      uKnee: { value: 1 },
    }));

    /*
     * PASS 1 IS A MULTIPLY: dst * src + dst, i.e. dst * (1 + Lm).
     *
     * This is the line that turns a flat radial gradient into a projected light.
     * An additive pool has to invent an albedo for whatever it lands on — the old
     * one used the constant 0.62 — so it put identical light on black basalt and
     * on white sand and painted straight over the panel lines, the sand ripples
     * and core's surface microstructure. A multiply cannot: every one of those
     * signals is already in dst and comes out the far side brightened by the same
     * factor, which is what "a real projected light interacting with the surface
     * it lands on" means arithmetically.
     */
    const poolMat = new THREE.ShaderMaterial({
      uniforms: this.uPool,
      vertexShader: LAMP_VERT,
      fragmentShader: LAMP_POOL_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    poolMat.name = 'tools.lampPool';
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), poolMat);

    const addMat = new THREE.ShaderMaterial({
      uniforms: this.uAdd,
      vertexShader: LAMP_VERT,
      fragmentShader: LAMP_ADD_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    addMat.name = 'tools.lampAdd';
    this.add = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), addMat);

    // after sky.js's night grade (9500): a torch is not switched off by the sun
    // setting, it is only judged against a darker frame — which is what
    // lampAmbient() accounts for. The pool multiplies first so the additive
    // floor and the cone sit on top of an already-lit surface.
    for (const m of [this.pool, this.add]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.userData.noDepthPass = true;
      m.userData.noShadow = true;
      m.visible = false;
      scene.add(m);
    }
    this.pool.renderOrder = 9800;
    this.pool.name = 'tools.lampPool';
    this.add.renderOrder = 9801;
    this.add.name = 'tools.lampAdd';
    // kept for the module's debug readout and for anything that looked at it
    this.mesh = this.pool;

    // ---- motes
    const MOTES = 420;
    const rng = makeRNG(0x10DE);
    const seeds = new Float32Array(MOTES * 3);
    for (let i = 0; i < MOTES * 3; i++) seeds[i] = rng();
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.moteU = mediumUniforms({
      uLampPos: { value: this.pos }, uLampDir: { value: this.dir },
      uLampCol: shared.uLampCol,
      uSpreadInv: shared.uSpreadInv, uRange: shared.uRange,
      uPixelScale: { value: 540 },
      uBoxSize: { value: 26 },
      uStrength: { value: 0 },
    });
    const moteMat = new THREE.ShaderMaterial({
      uniforms: this.moteU, vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: true, depthWrite: false, fog: false, toneMapped: false,
    });
    moteMat.name = 'tools.motes';
    this.motes = new THREE.Points(mg, moteMat);
    this.motes.frustumCulled = false;
    this.motes.matrixAutoUpdate = false;
    this.motes.renderOrder = 9810;   // lamp-lit, so after the 9500 night grade
    this.motes.userData.noDepthPass = true;
    this.motes.userData.noShadow = true;
    this.motes.visible = false;
    scene.add(this.motes);
  }

  /**
   * WHY THE LAMP EMITS WARM WHITE AND THE MEDIUM DOES THE TINTING.
   *
   * A round-one lamp emitted a fixed green chosen to land on dropoff-2.jpg's
   * olive lamp-lit coral after postfx's near-zone grade. It landed there at 14 m
   * and inverted by 193 m. Emit the warm white a real torch emits and let
   * per-channel extinction on both legs of the path do the tinting: white on
   * sand four metres away lands at G > B > R by construction, it tracks the
   * biome and the depth for free because uAbsorption does, and there is no
   * constant left to be calibrated at one depth and be wrong at another.
   *
   * RANGE IS 26 m, NOT 40. A dive torch does not usefully light anything at
   * forty metres in water whose own visibility LOOK.md 2 puts at 15-25 m with a
   * light below 200 m, and the only thing the extra fourteen metres bought was a
   * bigger disc: the windowed falloff reaches zero AT uRange, so uRange is the
   * screen radius of the cone as much as it is a distance.
   *
   * hand torch: tight and slightly warm. seaglide: wider, cooler, further.
   */
  setMode(mode) {
    this.mode = mode;
    if (mode === 'glide') {
      this.shared.uSpreadInv.value = 1 / (1 - Math.cos(0.66));
      this.shared.uRange.value = 30;
      this.shared.uLampCol.value.setRGB(0.88, 0.97, 1.0);
      this.moteU.uBoxSize.value = 34;
    } else {
      /*
       * 0.55 rad = 31 deg half-angle, and the width is doing real work.
       *
       * At 0.40 the pool on a near cliff face measured about 90 px across on a
       * 1920 frame — a small bright spot on a black field, which the eye reads
       * as a glowing ball rather than as a lit surface however soft its edge is.
       * A dive torch is a FLOOD: widen it until the pool covers enough of the
       * frame that the terrain's own shape and grain are legible inside it, and
       * the same light stops being an object and starts being illumination.
       * lampI() is normalised on axis, so widening costs the centre nothing.
       */
      this.shared.uSpreadInv.value = 1 / (1 - Math.cos(0.55));
      this.shared.uRange.value = 26;
      this.shared.uLampCol.value.setRGB(1.0, 0.97, 0.88);
      this.moteU.uBoxSize.value = 28;
    }
  }

  update(dt, camera, origin, dir, charge) {
    const want = this.on && charge > 0 ? 1 : 0;
    this.power = approach(this.power, want, want ? 9 : 6, dt);
    // a nearly-flat battery browns out and flickers
    const brown = charge < 12 ? 0.45 + 0.55 * Math.abs(Math.sin(U.uTime.value * 7.3)) * (charge / 12) : 1;
    const p = this.power * brown;
    const live = p > 0.004;
    this.pool.visible = live && this.hasDepth && this._kMul > 0;
    this.add.visible = live;
    this.motes.visible = live && U.uUnderwater.value > 0.5;
    if (!live) { this.level = 0; this.uAdd.uVolKey.value = 0; return; }

    this.pos.copy(origin);
    this.dir.copy(dir).normalize();

    // ---- the level, and everything derived from it -------------------------
    const amb = lampAmbient();
    // A torch is entitled to take over a dark scene (LOOK.md 26) but not to be
    // nine times more prominent at midnight than at noon. Clamped and rooted.
    const bonus = Math.pow(clamp(LAMP_REF / amb, 1, 9), 0.35);
    const level = litAnchor() * p;      // === amb * bonus * p
    this.level = level;

    // The multiply is a RATIO, so it carries no units of the medium — but it
    // does have to grow where the ambient has left the seabed at nothing, or a
    // 3x lift on a black rock is still a black rock.
    this.uPool.uMulGain.value = MUL_GAIN * bonus * p * this._kMul;

    /*
     * The additive floor is what actually reveals unlit geometry, and it is the
     * one term in this file that could still paint a flat disc — so it is held
     * at the reflectance of the darkest thing in the world and tinted by the
     * torch, which the shader then filters through two legs of the medium. In
     * blue-green water that lands red-poor by construction: LOOK.md 1 applied to
     * the light rather than to a correction on top of it.
     */
    const c = this.shared.uLampCol.value;
    const cy = Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-4);
    const addK = level * ADD_REL * this._kAdd;
    this.uAdd.uAddKey.value.set(addK * c.r / cy, addK * c.g / cy, addK * c.b / cy);

    // The medium gets denser with depth, so the cone needs less of that ramp
    // than the pool does — sigmaS already tracks the biome inside the shader.
    this.uAdd.uVolKey.value = level * VOL_REL * clamp01(U.uUnderwater.value) * this._kVol;

    /*
     * The knee is a SAFETY now, not a leveller. Its asymptote is 1/uKnee, and it
     * is placed eight times above this pass's own operating point rather than
     * on top of it: round seven ran a ceiling of 0.193 against a pool that
     * arrived at 2.26, so every pixel inside the cone came out within 8% of the
     * same value and the shading was gone. Eight times up, the operator is
     * within a per-cent of the identity everywhere the lamp normally works and
     * only ever acts on a creature that drifts a metre off the reflector.
     */
    this.uAdd.uKnee.value = clamp(1 / (8 * Math.max(level, 1e-5)), 0.05, 400);
    this.uAdd.uDither.value = (this.uAdd.uDither.value + 0.618) % 1;
    this.moteU.uStrength.value = level * MOTE_REL;
  }

  /**
   * Mirror the engine's depth attachment into our own half-res packed target.
   *
   * Runs from preRender, i.e. before engine.render() binds and clears the HDR
   * target, so what it reads is last frame's depth — see DEPTH_COPY_VERT's
   * comment for why that is the right trade rather than a compromise. Restores
   * the previous render target so nothing downstream inherits ours.
   */
  _copyDepth(ctx, w, h) {
    if (!this.copy) return;
    const r = ctx.renderer;
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    if (this.depthRT.width !== hw || this.depthRT.height !== hh) this.depthRT.setSize(hw, hh);
    this.copy.mat.uniforms.uSrcTexel.value.set(1 / Math.max(2, w), 1 / Math.max(2, h));
    this.copy.mat.uniforms.uNear.value = ctx.camera.near;
    this.copy.mat.uniforms.uFar.value = ctx.camera.far;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    try {
      r.setRenderTarget(this.depthRT);
      r.autoClear = false;
      r.render(this.copy.scene, this.copy.cam);
    } finally {
      r.autoClear = prevAuto;
      r.setRenderTarget(prev);
    }
  }

  preRender(ctx) {
    if (!this.pool.visible && !this.add.visible) return;
    const cam = ctx.camera;
    const tanHalf = Math.tan(cam.fov * 0.5 * THREE.MathUtils.DEG2RAD);
    const s = ctx.renderer.getDrawingBufferSize(_sizeV);
    const sh = this.shared;
    sh.uTanHalf.value = tanHalf;
    sh.uAspect.value = cam.aspect;
    sh.uCamBasis.value.setFromMatrix4(cam.matrixWorld);
    sh.uNear.value = cam.near;
    sh.uFar.value = cam.far;
    // the copy is half res, and normalAt walks whole texels of it
    sh.uTexel.value.set(2 / Math.max(2, s.x), 2 / Math.max(2, s.y));
    this._copyDepth(ctx, s.x, s.y);
    this.moteU.uPixelScale.value = (s.y * 0.5) / Math.max(tanHalf, 1e-3);
    // see the comment at the end of LAMP_ADD_FRAG
    const ng = postfxNearGain(_nearGain);
    this.uAdd.uNearCancel.value.set(1 / ng[0], 1 / ng[1], 1 / ng[2]);
  }
}
const _sizeV = new THREE.Vector2();

// ===========================================================================
// 7. THE NODE FIELD — what there is to cut, break and pick up
// ===========================================================================
/**
 * Which of the three archetypes a biome resource id becomes. The ids are
 * world/biomes.js's own, straight out of each biome's `resources` array.
 */
const NODE_KIND = {
  limestone: 'outcrop', sandstone: 'outcrop', shale: 'outcrop',
  salt: 'deposit', quartz: 'deposit', copper_ore: 'deposit', silver_ore: 'deposit',
  gold: 'deposit', lead: 'deposit', lithium: 'deposit', magnetite: 'deposit',
  nickel_ore: 'deposit', diamond: 'deposit', uraninite: 'deposit', kyanite: 'deposit',
  ruby: 'deposit', crystalline_sulphur: 'deposit', ion_cube: 'deposit',
  titanium_scrap: 'deposit',
  coral_sample: 'organic', creepvine_seed: 'organic', blood_oil: 'organic',
  acid_sample: 'organic', bulb_sample: 'organic',
};
/** What an outcrop actually contains once you have broken it open. */
const OUTCROP_YIELD = {
  limestone: ['titanium', 'titanium', 'copper_ore'],
  sandstone: ['silver_ore', 'gold', 'lead'],
  shale: ['lithium', 'diamond', 'lithium'],
};
/** Flora ids world/flora.js plants, mapped onto a harvestable specimen. */
const ORGANIC_SPECIES = {
  coral_sample: 'coral_tube', creepvine_seed: 'kelp_vine', acid_sample: 'acid_mushroom',
  bulb_sample: 'bulb_bush', blood_oil: 'blood_grass',
};
const NODE_COLOUR = {
  limestone: 0xb5ac93, sandstone: 0xb2996b, shale: 0x74796f,
  salt: 0xdfe8ee, quartz: 0xb9dbe6, copper_ore: 0xb8672f, silver_ore: 0xc2cbd2,
  gold: 0xd7a92e, lead: 0x848b93, lithium: 0xc6c0dc, magnetite: 0x5a626d,
  nickel_ore: 0x8a9680, diamond: 0xcfeaf4, uraninite: 0x5fc42c, kyanite: 0x2f66c6,
  ruby: 0xc02c3e, crystalline_sulphur: 0xd8c032, ion_cube: 0x9366ff,
  titanium_scrap: 0x8f9aa0,
  coral_sample: 0xd08853, creepvine_seed: 0x7cae42, blood_oil: 0x9c2530,
  acid_sample: 0xc8ae2c, bulb_sample: 0x46b09a,
};
const ORE_COLOUR = { limestone: 0xb0763c, sandstone: 0xc9b06a, shale: 0x9fb8c4 };

/**
 * three only declares `vColor` in the FRAGMENT stage under USE_COLOR, and
 * USE_COLOR comes from material.vertexColors alone — instanceColor is a
 * vertex-only define. So a per-instance tint on a MeshStandardMaterial needs
 * both vertexColors AND a real `color` attribute, or the attribute falls back
 * to WebGL's (0,0,0,1) default and every node renders black.
 */
function whiteColours(geo) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * applyUnderwater owns onBeforeCompile; chain onto it without editing core.
 *
 * WHAT WAS WRONG WITH `vColor * vColor`, MEASURED.
 *
 * A tint should tint. Squaring one does two things, and both were visible in the
 * frame. It DOUBLES the tint's saturation, because every channel sits below 1 and
 * squaring pushes the small ones down hardest: bulb_sample #46b09a is linear
 * (0.061, 0.434, 0.323), a green-teal whose red is already only 14% of its green,
 * and squared it becomes (0.004, 0.188, 0.104) where red is 2% of green. Every
 * node's glow was therefore driven toward a pure primary — which is exactly why
 * ion_cube #9366ff, linear (0.292, 0.133, 1.000) and a perfectly reasonable
 * lavender, came out of the same line as (0.085, 0.018, 1.000): saturated violet.
 * The tint was a saturation amplifier, not a tint.
 *
 * The second failure is that emissive has no geometry in it. A constant emissive
 * over a closed body is the one term in the shading model that carries NO form —
 * it is identical on the lit side, the shadow side and the silhouette — so as it
 * grows it erases the object underneath it. Measured on the shallows-floor node
 * cluster before this change: 17,052 masked pixels at mean rgb(68.6, 213.0,
 * 203.0) with a standard deviation of only (7.6, 14.6, 13.8). That is a
 * coefficient of variation of 6.8% in green, against 62% for the sand it is
 * sitting on — one ninth the relative variation of its own surroundings. Flat,
 * numerically.
 *
 * (It was NOT clipped, whatever it looks like: peak 239, clipAny 0.00% on every
 * window I measured. The defect is flatness and level, not clipping.)
 *
 * So: tint linearly, and give the emissive a view-dependent rim. A bulb that
 * glows is a translucent shell with a longer optical path at grazing angles, so
 * the glow belongs at the silhouette and the body belongs to the diffuse lobe
 * that already lights and shades it. The rim costs one dot product and it is
 * what puts curvature back into a sphere that was reading as a disc.
 *
 * It is built from vUwWorldNormal / vUwWorldPos / uCamPos rather than three's own
 * `normal` and `vViewPosition`. Those two would work today, but they are internal
 * chunk state whose declaration and ordering are three's to change; core's
 * varyings are injected by the applyUnderwater() call that every one of these
 * materials has already been through, so they are guaranteed to be in scope in
 * exactly the shaders this runs in.
 */
function instanceTintedEmissive(mat, cacheKey, rim = 0.85, base = 0.45) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  {
    vec3 uwV = normalize(uCamPos - vUwWorldPos);
    float uwFres = 1.0 - abs(dot(normalize(vUwWorldNormal), uwV));
    totalEmissiveRadiance *= vColor.rgb * (${base.toFixed(3)} + ${rim.toFixed(3)} * uwFres * uwFres);
  }`);
  };
  /*
   * COMPOSE the key, do not overwrite it. applyUnderwater's own comment is
   * explicit that a module wrapping its onBeforeCompile "MUST also compose its
   * own key on top of this one — otherwise three hands it the program compiled
   * for a different variant", and this line used to replace core's key with a
   * bare constant. It happened to be safe, because the two constants in use here
   * are unique strings, but it threw away core's 'uw|sf' variant marker: if core
   * ever bakes another #define into that shader, these two materials would stop
   * distinguishing the variants and would silently take the wrong program. That
   * failure mode is invisible — it does not throw and it does not fail to link.
   */
  const priorKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () =>
    (priorKey ? priorKey.call(mat) : '') + '|' + cacheKey;
  mat.needsUpdate = true;
  return mat;
}

const CELL = 26;
const NODE_RADIUS = 72;

class NodePool {
  constructor(geo, mats, max, name) {
    this.mesh = new THREE.InstancedMesh(whiteColours(geo), mats, max);
    this.mesh.name = 'tools.' + name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.max = max;
    this.nodes = [];
  }
  reset() { this.nodes.length = 0; }
  push(node, m, col) {
    const i = this.nodes.length;
    if (i >= this.max) return;
    this.mesh.setMatrixAt(i, m);
    this.mesh.instanceColor.setXYZ(i, col.r, col.g, col.b);
    this.nodes.push(node);
  }
  upload() {
    this.mesh.count = this.nodes.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}

class NodeField {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.cells = new Map();       // "cx,cz" -> node[]
    this.state = new Map();       // nodeKey -> { hp, respawn }
    this.group = new THREE.Group();
    this.group.name = 'tools.nodes';
    scene.add(this.group);

    const V = { color: 0xffffff, vertexColors: true };
    const rockMat = new THREE.MeshStandardMaterial({ ...V, roughness: 0.93, metalness: 0.02 });
    const oreMat = new THREE.MeshStandardMaterial({ ...V, roughness: 0.42, metalness: 0.12 });
    const crystalMat = new THREE.MeshStandardMaterial({
      ...V, roughness: 0.26, metalness: 0.06,
      emissive: new THREE.Color(0.32, 0.32, 0.32), emissiveIntensity: 1.0,
    });
    const leafMat = new THREE.MeshStandardMaterial({
      ...V, roughness: 0.72, metalness: 0.0, side: THREE.DoubleSide,
    });
    /*
     * NEITHER THE EMISSIVE NOR THE ALBEDO IS THE FLAT CYAN BLOB — see the
     * caustics note on the applyUnderwater calls below, which is where it lives.
     *
     * Recorded here because two plausible causes were eliminated by measurement
     * and both eliminations cost a capture:
     *
     *  - EMISSIVE. Ablating both node emissives to zero with ?nodeglow=0 — same
     *    build, same geometry, same seed — moves the pods 1.6 out of 212.7 in
     *    green (0.8%) and the blades 0.1 out of 209.5, which is nothing. An
     *    earlier attempt at the briefed fix, cutting podMat from 1.6 to 0.30 and
     *    un-squaring the tint, likewise moved the object's pixels by nothing.
     *  - ALBEDO. Cutting these materials' `color` to 0.34/0.42 moved the same
     *    window from 212.7 to 212.5. The diffuse lobe is under 2% of what this
     *    object renders.
     *
     * The albedo values below are therefore back near 1: the instance tint IS the
     * intended reflectance, and darkening it was solving a problem it did not
     * have. They sit slightly under 1 only because #46b09a is a linear green of
     * 0.43 where real foliage is nearer 0.15, so a little comes off on principle.
     *
     * One correction to the brief's framing that survives independently of all
     * this: the blob is NOT clipped. Peak 235-241 and clipAny 0.00% on every node
     * window measured, before and after. It is flat and it is too bright, and
     * those are different faults with different fixes.
     */
    leafMat.color.setRGB(0.82, 0.82, 0.82);
    /*
     * The bulbs. Emissive 0.55 against the old 1.6, but the tint is no longer
     * SQUARED — squaring a sub-unity tint is a saturation amplifier, not a tint,
     * and it is what turned lavender ion_cube #9366ff, linear (0.292, 0.133,
     * 1.000), into a pure violet (0.085, 0.018, 1.000). Un-squared, red comes
     * back from 0.4% of green to 14% of it, which is the colour the palette
     * actually authored.
     *
     * The level goes UP rather than down, which is the opposite of the briefed
     * fix and follows directly from the ?nodeglow=0 ablation above: with the
     * diffuse cut to 0.42 the emissive is finally a term that can be seen, and a
     * bioluminescent pod should read as self-lit rather than as one more bright
     * surface. The rim in instanceTintedEmissive puts it at the silhouette.
     */
    const podMat = new THREE.MeshStandardMaterial({
      ...V, roughness: 0.42, metalness: 0.0,
      emissive: new THREE.Color(0.55, 0.55, 0.55), emissiveIntensity: 1.0,
    });
    podMat.color.setRGB(0.88, 0.88, 0.88);
    crystalMat.color.setRGB(0.92, 0.92, 0.92);
    /*
     * SURFACE MICROSTRUCTURE, per material rather than one preset for the lot.
     *
     * A census found only 35 of the game's 179 materials opted in, and every one
     * of this module's was in the other 144 — so a limestone outcrop the player
     * puts a knife through at arm's length was a smoothly-shaded solid colour,
     * which is the exact charge the whole-game critic laid ("moulded vinyl").
     *
     * The scale numbers are the part that has to be authored rather than
     * inherited. core's presets are written for terrain and hull plating and
     * carry scales of 1.4-3.5 m; a resource nodule is 40 cm across, so at 3.5 m
     * the wear and streak fields do not complete a single cycle over the whole
     * object and it comes back with one flat gradient across it instead of
     * texture. Everything below is scaled to the object it is actually on.
     */
    /*
     * `fogScale: 0.20` — AND THIS, NOT THE EMISSIVE, IS THE FLAT CYAN BLOB.
     *
     * These five materials were the only ones in this file that never set
     * fogScale, so they took the shared medium's DISTANCE leg at full strength.
     * Localised by ablation, one term at a time, same build and seed each time,
     * measured on a 17.4k-pixel mask of the node cluster in shallows-floor:
     *
     *   node emissive -> 0   (?nodeglow=0)      green 212.7 -> 211.1   0.8%
     *   node albedo   -> 0.42                   green 212.7 -> 212.5   0.1%
     *   node caustics -> 0                      green 212.5 -> 211.5   0.5%
     *   node fogScale -> 0                      green 212 -> 8         100%
     *
     * The whole object was the medium. `color * T + inscatter` over a path this
     * long drives T to nearly zero, which annihilates albedo, emissive and
     * caustics alike — that is why every material knob I turned did nothing, and
     * why "the emissive is a light-source-shaped hole" could not have been the
     * cause however plausible it looked. What was left was inscatter: a value
     * that depends only on the view ray, so it is IDENTICAL across the whole
     * object. An object painted with a term that has no shape in it has no shape.
     * That is the flatness, exactly: s.d. 14.6 on a mean of 213, a coefficient of
     * variation of 6.8% against the 62% of the sand it stands on.
     *
     * fogScale is core's sanctioned knob for precisely this and it was already in
     * use all around this file — creatures.js runs 0.5, base.js runs 0.2, and the
     * held tool twenty screens down this same file runs 0.15 with a comment
     * explaining that a fog coefficient tuned for a 40 m water column should not
     * do 40 m of work over 45 cm. A resource node is a 40 cm object a few metres
     * away. It was the one asset here still asking the medium to integrate a full
     * water column across it.
     *
     * Measured on the same fixed window before and after, node body against the
     * seabed it stands on: 2.00x -> 1.23x. seamoth-1.jpg's brightest coral sits
     * at 1.18x its own seabed and 1.64x its open sand, and its green plants at
     * 0.79x, so 1.23x is inside the reference band. The cyan-cutout mask goes from
     * 17,444 pixels to 180.
     *
     * KNOWN COST, stated rather than hidden: at 0.20 a node 40 m away will fog
     * less than the terrain behind it and will read slightly too crisp at range.
     * The right end state is a distance-dependent scale rather than a constant,
     * but that wants a core change and this is the honest interim.
     *
     * The caustic scales below are a second, much smaller correction. LOOK.md 8
     * puts caustics at "+30-45% over local diffuse" — a modulation. Core adds them,
     * so on a small object they substitute instead. The rock and ore keep more
     * than the organics: a bedded stone nodule genuinely catches the floor's
     * caustics, a vertical blade does not.
     */
    applyUnderwater(rockMat, { caustics: 0.40, fogScale: 0.20, surface: { grain: 0.13, wear: 0.62, streak: 0.20, scale: 0.55 } });
    applyUnderwater(oreMat, { caustics: 0.40, fogScale: 0.20, surface: { grain: 0.10, wear: 0.50, streak: 0.14, scale: 0.30 } });
    // A mineral crystal is the one thing down here with a clean fracture face:
    // low grain, almost no wear, and a little streaking where silt has run down
    // the vertical facets.
    applyUnderwater(crystalMat, { caustics: 0.35, fogScale: 0.20, surface: { grain: 0.045, wear: 0.16, streak: 0.22, scale: 0.28 } });
    applyUnderwater(leafMat, { caustics: 0.35, fogScale: 0.20, surface: { grain: 0.11, wear: 0.30, streak: 0.06, scale: 0.22 } });
    applyUnderwater(podMat, { caustics: 0.35, fogScale: 0.20, surface: { grain: 0.07, wear: 0.20, streak: 0.05, scale: 0.16 } });
    /*
     * ?nodetint=1 flattens each pool to one unmistakable emissive colour:
     *   rock RED   ore AMBER   crystal MAGENTA   leaf GREEN   pod BLUE
     *
     * One capture then says which material draws any given object in the field,
     * which is a question that has now cost this project two rounds. A critic
     * scored a flat cyan blob against a neighbouring module; the neighbour
     * ablated it back to this field; and the obvious candidate here — the pods'
     * emissive — turned out on measurement to be innocent, because changing it
     * by a factor of five moved the object's pixels by nothing at all
     * (mean green 213.0 -> 212.7, s.d. 14.6 -> 14.5). Guessing from a screenshot
     * is what made that expensive. This makes it a single measurement.
     *
     * instanceTintedEmissive is skipped under the flag on purpose: its injection
     * multiplies the emissive by vColor, which would re-tint the very thing the
     * flag exists to make distinguishable.
     */
    if (flag(ctx.params, 'nodetint')) {
      for (const [mm, e] of [[rockMat, [3, 0, 0]], [oreMat, [3, 1.4, 0]],
        [crystalMat, [3, 0, 3]], [leafMat, [0, 3, 0]], [podMat, [0, 0, 3]]]) {
        mm.color.setRGB(0, 0, 0);
        mm.emissive.setRGB(e[0], e[1], e[2]);
      }
      ctx.declareGodMode?.('tools', 'node pools flat-tinted per material (?nodetint=1)');
    } else {
      /*
       * ?nodeglow=<k> scales BOTH node emissives, so the self-illuminated share
       * of a node's radiance can be measured by differencing two captures rather
       * than argued from a screenshot. ?nodeglow=0 leaves only albedo, lighting
       * and the medium — which is the number that decides whether a node reads
       * bright because it GLOWS or because its albedo is a hyper-saturated teal.
       * Parallel to ?vmfill for the view model, and for the same reason.
       */
      const gk = ctx.params?.get?.('nodeglow');
      const glowK = gk === null || gk === undefined ? 1 : Math.max(0, Number(gk) || 0);
      if (glowK !== 1) {
        crystalMat.emissive.multiplyScalar(glowK);
        podMat.emissive.multiplyScalar(glowK);
        ctx.declareGodMode?.('tools', `node emissive scaled x${glowK} (?nodeglow=)`);
      }
      // A mineral face carries its light at the edges harder than a soft bulb
      // does, so the crystal runs a lower flat floor and a stronger rim.
      instanceTintedEmissive(crystalMat, 'uw-tools-crystal', 1.05, 0.34);
      instanceTintedEmissive(podMat, 'uw-tools-pod', 0.85, 0.45);
    }
    this.mats = { rockMat, oreMat, crystalMat, leafMat, podMat };

    // --- outcrop: a bedded nodule with metallic inclusions showing through
    const oreLumps = [];
    const orng = makeRNG(0x0C7);
    for (let i = 0; i < 3; i++) {
      const s = orng.range(0.10, 0.17);
      const g = nodeBlob(0x400 + i, { r: s, warp: 0.45, knuckles: 2, squash: 0.9, skirt: 0, src: ICO1 });
      const a = orng() * TAU, e = orng.range(0.05, 0.9);
      g.translate(Math.cos(a) * 0.34 * Math.cos(e), 0.30 * Math.sin(e) + 0.04, Math.sin(a) * 0.34 * Math.cos(e));
      oreLumps.push(g);
    }
    const outGeo = mergeGroups([
      { geo: nodeBlob(0x401, { r: 0.44, warp: 0.32, knuckles: 4, squash: 0.74 }), m: 0 },
      { geo: mergeGeos(oreLumps), m: 1 },
    ]);
    this.outcrop = new NodePool(outGeo, [rockMat, oreMat], 210, 'outcrop');

    // --- deposit: an angular mineral cluster
    this.deposit = new NodePool(
      mergeGroups([{ geo: crystalCluster(0x402, { r: 0.21, n: 7, h: 1.5 }), m: 0 }]),
      [crystalMat], 210, 'deposit');

    // --- organic: bladed clump with three glowing pods
    const org = organicClump(0x403, { r: 0.46 });
    this.organic = new NodePool(
      mergeGroups([{ geo: org.body, m: 0 }, { geo: org.pods, m: 1 }]),
      [leafMat, podMat], 190, 'organic');

    this.pools = [this.outcrop, this.deposit, this.organic];
    for (const p of this.pools) this.group.add(p.mesh);
    // Only the outcrops cast: a 30 cm crystal and a bladed clump each throw a
    // shadow no cascade covering hundreds of metres can resolve, and postfx's
    // SSAO already beds them into the sand. Measured at 9 draws for nothing.
    for (const p of [this.deposit, this.organic]) {
      p.mesh.castShadow = false;
      p.mesh.userData.noShadow = true;    // main.js re-enables shadows every second
    }

    this._occl = [];
    this._ov = [];      // reused Vector3s: core reads pos by reference each frame
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._lastX = 1e9; this._lastZ = 1e9;
  }

  /** Deterministic contents of one cell, cached. */
  cell(cx, cz) {
    const key = cx + ',' + cz;
    let list = this.cells.get(key);
    if (list) return list;
    list = [];
    const ctx = this.ctx;
    const terrain = ctx.get('terrain');
    const biomes = ctx.get('biomes');
    const rng = makeRNG(((hash2(cx, cz) * 4294967296) ^ 0x9E37) >>> 0);
    const n = 3 + (rng() * 4 | 0);
    for (let i = 0; i < n; i++) {
      const x = cx * CELL + rng() * CELL;
      const z = cz * CELL + rng() * CELL;
      const y = terrain?.heightAt ? terrain.heightAt(x, z) : -30;
      if (!Number.isFinite(y) || y > WORLD.seaLevel - 1.2) continue;
      let up = 1;
      if (terrain?.normalAt) {
        const nn = terrain.normalAt(x, z);
        if (nn && Number.isFinite(nn.y)) up = nn.y;
      }
      if (up < 0.42) continue;              // nothing clings to a cliff face
      let res = null;
      if (biomes?.get && biomes?.dominant) {
        const b = biomes.get(biomes.dominant(x, y, z));
        if (b?.resources?.length) res = b.resources;
      }
      if (!res) res = ['limestone', 'sandstone', 'salt', 'coral_sample', 'quartz'];
      const item = res[(rng() * res.length) | 0];
      const kind = NODE_KIND[item] || 'deposit';
      list.push({
        key: key + ':' + i, kind, item, x, y, z,
        scale: rng.range(0.74, 1.20) * (kind === 'outcrop' ? 1.0 : kind === 'organic' ? 1.10 : 0.82),
        rot: rng() * TAU, tilt: rng.range(-0.13, 0.13),
        species: ORGANIC_SPECIES[item] || item,
      });
    }
    this.cells.set(key, list);
    return list;
  }

  nodeState(node) {
    let s = this.state.get(node.key);
    if (!s) { s = { hp: node.kind === 'outcrop' ? 3 : 1, dead: 0 }; this.state.set(node.key, s); }
    return s;
  }

  refill(px, pz, t) {
    for (const p of this.pools) p.reset();
    const c0 = Math.floor(px / CELL), c1 = Math.floor(pz / CELL);
    const R = Math.ceil(NODE_RADIUS / CELL);
    const r2 = NODE_RADIUS * NODE_RADIUS;
    for (let ax = -R; ax <= R; ax++) {
      for (let az = -R; az <= R; az++) {
        const list = this.cell(c0 + ax, c1 + az);
        for (const nd of list) {
          const dx = nd.x - px, dz = nd.z - pz;
          if (dx * dx + dz * dz > r2) continue;
          const st = this.nodeState(nd);
          if (st.dead > t) continue;
          // a regrown node is whole again, not still three hits from broken
          if (st.dead > 0 && t > st.dead + 2) { st.dead = 0; st.hp = nd.kind === 'outcrop' ? 3 : 1; }
          const pool = nd.kind === 'outcrop' ? this.outcrop : nd.kind === 'organic' ? this.organic : this.deposit;
          // regrowth pops back in over two seconds rather than appearing
          const grow = st.dead > 0 ? clamp01((t - st.dead) / 2.0) : 1;
          const s = nd.scale * (0.35 + 0.65 * grow) * (st.hp < 3 && nd.kind === 'outcrop' ? 0.86 : 1);
          this._q.setFromEuler(_euler.set(nd.tilt, nd.rot, nd.tilt * 0.7));
          // sink a quarter of the body into the sand: LOOK.md section 11.22 —
          // geometry meeting sand at a hard line is a named tell
          this._v.set(nd.x, nd.y - s * 0.16, nd.z);
          this._s.set(s, s, s);
          this._m.compose(this._v, this._q, this._s);
          this._c.setHex(NODE_COLOUR[nd.item] ?? 0x9a9484, THREE.SRGBColorSpace);
          if (nd.kind === 'outcrop') this._c.setHex(NODE_COLOUR[nd.item] ?? 0xa89f88, THREE.SRGBColorSpace);
          pool.push(nd, this._m, this._c);
        }
      }
    }
    for (const p of this.pools) p.upload();
    this.pickOccluders(px, pz);
    // stop the cell cache growing without bound as the player crosses the map
    if (this.cells.size > 900) {
      for (const k of this.cells.keys()) {
        const [a, b] = k.split(',');
        if (Math.abs(a - c0) > R + 3 || Math.abs(b - c1) > R + 3) this.cells.delete(k);
      }
    }
  }

  update(px, pz, t, force) {
    const d = Math.hypot(px - this._lastX, pz - this._lastZ);
    if (!force && d < 6) return;
    this._lastX = px; this._lastZ = pz;
    this.refill(px, pz, t);
  }

  /**
   * The nearest few nodes, as caustic occluders.
   *
   * WHY THE NODES AND NOT THE HELD TOOL. The brief suggested publishing the tool,
   * and it would be dead weight: core seeds the list with the player at radius
   * 1.1 m centred on movement.position, and the view model is held about 0.55 m
   * from the eye — entirely inside that sphere. A second sphere there occludes
   * nothing the first one does not, and it would spend one of the eight slots
   * doing it.
   *
   * The resource nodes are the opposite case. They are the only geometry this
   * module owns that sits ON the seabed, in the shallows, in the exact band where
   * caustics are still strong (core fades them out with exp(-depth * 0.020)), and
   * a rock breaking a caustic field into a soft pool of shade is precisely what
   * the reference shallows-floor plate shows. Three of them, not seven: other
   * modules have to fit in the same eight slots, and the player plus three
   * nearby nodes is already the difference between a field with objects in it
   * and a field painted over the top of them.
   *
   * Radii are the node's own, so a knee-high outcrop shades a knee-high patch.
   * The centre is lifted to the body's mid-height because the instance is bedded
   * a sixth of its height into the sand.
   */
  pickOccluders(px, pz) {
    const out = this._occl || (this._occl = []);
    out.length = 0;
    const best = [];
    for (const pool of this.pools) {
      // base half-extent of each pool's geometry, in the node's own units
      const base = pool === this.outcrop ? 0.46 : pool === this.organic ? 0.50 : 0.30;
      for (const nd of pool.nodes) {
        const dx = nd.x - px, dz = nd.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > 400) continue;               // 20 m: past that the shade is a smear
        best.push({ d2, nd, r: base * nd.scale });
      }
    }
    best.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < best.length && out.length < 3; i++) {
      const b = best[i];
      if (b.r < 0.22) continue;               // too small to read as a shadow
      const v = this._ov[out.length] || (this._ov[out.length] = new THREE.Vector3());
      v.set(b.nd.x, b.nd.y + b.r * 0.55, b.nd.z);
      out.push({ pos: v, radius: b.r });
    }
    return out;
  }

  /** Ore/ore knuckle colour for the break burst. */
  burstColour(node) {
    const hex = node.kind === 'outcrop'
      ? (ORE_COLOUR[node.item] ?? 0xb0763c) : (NODE_COLOUR[node.item] ?? 0xcccccc);
    return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  }
}
const _euler = new THREE.Euler();

// ===========================================================================
// 8. HAND TOOLS — the first-person view models
// ===========================================================================
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _te = new THREE.Euler();
const _upY = new THREE.Vector3(0, 1, 0);
const _dirV = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
/** Place a geometry into a merge list under material index m. */
function part(geo, m, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
  const g = geo.clone();
  _te.set(rot[0], rot[1], rot[2]);
  _tq.setFromEuler(_te);
  _tm.compose(new THREE.Vector3(pos[0], pos[1], pos[2]), _tq, new THREE.Vector3(scl[0], scl[1], scl[2]));
  g.applyMatrix4(_tm);
  return { geo: g, m };
}
/** Part aimed along a direction: the geometry's +Y axis is rotated onto `dir`. */
function aimed(geo, m, pos, dir) {
  const g = geo.clone();
  _tq.setFromUnitVectors(_upY, _dirV.set(dir[0], dir[1], dir[2]).normalize());
  _tm.compose(new THREE.Vector3(pos[0], pos[1], pos[2]), _tq, _one);
  g.applyMatrix4(_tm);
  return { geo: g, m };
}
const CYL = (rt, rb, h, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);

/**
 * The scanner's readout. seamoth-1.jpg's scanner carries a lit cyan-on-navy LCD
 * reading READY TO SCAN, and it is the single most recognisable thing on the
 * model — a critic called ours out as an untextured placeholder specifically for
 * not having it. Canvas, so it stays procedural, and redrawn only when the
 * string changes.
 */
function makeScreen() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 176;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { cv, tex, state: '' };
}
function drawScreen(scr, line1, line2, progress) {
  const key = line1 + '|' + line2 + '|' + (progress >= 0 ? Math.round(progress * 20) : -1);
  if (!scr || scr.state === key) return;
  scr.state = key;
  const g = scr.cv.getContext('2d');
  const W = scr.cv.width, H = scr.cv.height;
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#12507f'); grd.addColorStop(0.55, '#0d3a63'); grd.addColorStop(1, '#08243d');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  // inner bezel, matching the HUD's 2 px cyan rim language
  g.strokeStyle = 'rgba(143,233,255,.55)'; g.lineWidth = 5;
  g.strokeRect(8, 8, W - 16, H - 16);
  // status furniture: a clock at top-left, a caution triangle at top-right
  g.strokeStyle = '#9fe9ff'; g.lineWidth = 4; g.beginPath();
  g.arc(32, 32, 12, 0, TAU); g.moveTo(32, 24); g.lineTo(32, 32); g.lineTo(39, 36); g.stroke();
  g.beginPath(); g.moveTo(W - 34, 20); g.lineTo(W - 20, 44); g.lineTo(W - 48, 44); g.closePath();
  g.fillStyle = '#8fe9ff'; g.fill();
  g.textAlign = 'center';
  g.fillStyle = '#cdf4ff';
  g.font = '700 34px "Segoe UI",system-ui,sans-serif';
  const cy = line2 ? 92 : 106;
  g.fillText(line1, W / 2, cy);
  if (line2) g.fillText(line2, W / 2, cy + 38);
  if (progress >= 0) {
    g.fillStyle = 'rgba(8,36,61,.9)'; g.fillRect(30, H - 40, W - 60, 14);
    g.fillStyle = '#8fe9ff'; g.fillRect(30, H - 40, (W - 60) * clamp01(progress), 14);
  } else {
    // idle tick row, so the panel is never a flat slab of colour
    g.fillStyle = 'rgba(143,233,255,.42)';
    for (let i = 0; i < 9; i++) g.fillRect(32 + i * 21, H - 36, 11, 7);
  }
  scr.tex.needsUpdate = true;
}

/**
 * Materials shared by every hand tool. Index order is fixed and every builder
 * below indexes into it, so all five tools are one material set; mergeGroups
 * sorts by material, so a tool costs one draw per material it uses however many
 * pieces it is modelled from.
 *   0 suit  1 glove  2 shell  3 steel  4 dark  5 emissive  6 band  7 screen
 *
 * THE DETAIL BUDGET IS SPENT IN GEOMETRY, NOT IN MATERIALS. Round three's tools
 * measured (115, 121, 121) across the whole shell against the reference's
 * (153, 157, 142) with no panel breaks anywhere on them — one smooth lozenge.
 * Because mergeGroups collapses a material into exactly one group, a seam
 * modelled as a 3 mm strip of material 4 between two shell masses is free: the
 * scanner draws in five calls whether it is nine parts or forty. Every shadow
 * gap, louvre, screw and bezel below is one of those, which is why the models
 * can carry reference-density detail inside the draw budget.
 */
const M_SUIT = 0, M_GLOVE = 1, M_SHELL = 2, M_STEEL = 3, M_DARK = 4,
  M_LIT = 5, M_BAND = 6, M_SCREEN = 7;
function makeToolMats(screen) {
  const m = [
    /*
     * 0 WETSUIT. Black neoprene, which under water is very nearly a silhouette —
     * that is the point, because the lower-right corner needs a dark anchor or
     * the whole view model floats on the water behind it. But WET neoprene is
     * also glossy: at roughness 0.66 the sleeve measured a median of 1/255 and
     * read as a hole cut in the frame rather than as an arm. 0.44 gives it the
     * broad specular sheen a wet suit actually has, which is what carries its
     * form in a dark frame.
     */
    new THREE.MeshStandardMaterial({ color: srgb(0x1e262d), roughness: 0.44, metalness: 0.05 }),
    /*
     * 1 DIVE GLOVE — and it USED TO BE SKIN, which was the single most repeated
     * tell in the project: six of eighteen blind pairs were decided on a bare
     * pink forearm, at depths from 12 m to 681 m.
     *
     * Skin is the wrong content and it is also arithmetically fatal. The fill
     * below is albedo-weighted (a bounce carries the surface's own hue, which is
     * what a bounce physically is), so an albedo of linear (0.527, 0.279, 0.156)
     * emits a fill at R/G 1.9 — and the measured result was an arm reading R% 76
     * against water at 15 at 75 m, five times redder than the medium it floats
     * in, at a depth where LOOK.md rule 1 says red is dead. No level or chroma
     * trim survives an albedo that warm covering that much of the frame.
     *
     * A diver at the depths this game spends its time at wears gloves. Neoprene
     * with a cool slate cast: R BELOW G and B, so every derived quantity —
     * diffuse, fill, rim — is red-poor by construction rather than by correction.
     */
    new THREE.MeshStandardMaterial({ color: srgb(0x36434c), roughness: 0.52, metalness: 0.03 }),
    /*
     * 2 SHELL — worn Alterra composite. It was 0xa9b4b3, a clean neutral, and a
     * critic reading the 75 m frame called it "white plastic at full brightness":
     * measured, the shell's own fill ran 2.8x the radiance of the surrounding
     * water, so it read as a light source rather than as a lit object. Two things
     * fix that and both are here: the level (see setFill, which now anchors to
     * the water) and the albedo, which is dropped a third and given a green-grey
     * cast — gear that has been in salt water is never bright white. wearColours
     * takes another 10-30% out of it per vertex, in blotches.
     */
    /*
     * ROUND 32, and this is the other half of the same measurement. Windowing
     * ONLY tool shell in both images — ours `hud` at 20 m, crop
     * 0.640-0.740 x 0.555-0.625; seamoth-1.jpg's first-person scanner, crop
     * 0.648-0.712 x 0.7475-0.9088 — against a window of ONLY open water in each:
     *
     *              shell median   water median   ratio
     *   plate          108.8          62.3       1.75x
     *   ours            86.5         125.0       0.69x
     *
     * The reference tool is the BRIGHTEST thing in its frame by three quarters;
     * ours is a third darker than the water behind it. The round-three
     * correction that took this albedo down was right about the level it was
     * fitted at and overshot by two and a half times at the top. Brought back
     * up 1.3x — not the whole way, because the plate's tool sits in a dry
     * lamp-lit Seamoth cabin and ours is outside a hull in open water, so some
     * of that gap is honestly ours to keep.
     */
    /*
     * ROUND 34: 0xacb8b3 -> 0xb6c0ba, about +15% in linear. Measured on a
     * shell-only mask of `hud` (23.7k px) against an open-water window, ours sat
     * at 1.24x its own water where seamoth-1.jpg's scanner sits at ~1.8x on
     * matched clean windows. Only part of that is taken here: our water measures
     * luminance 127 against the plate's 69, so the headroom between the shell and
     * the rail is a little over half the plate's and a full correction would
     * clip. p90 was 199 before this; it must stay under ~235.
     */
    new THREE.MeshStandardMaterial({ color: srgb(0xb6c0ba), roughness: 0.47, metalness: 0.05 }),
    // Brushed steel: the barrel block. Measured on the reference at (87,109,101)
    // against the shell's (153,157,142), i.e. clearly DARKER and cooler — the
    // two masses read apart because of that gap, not because of a seam line.
    new THREE.MeshStandardMaterial({ color: srgb(0x647075), roughness: 0.30, metalness: 0.48 }),
    /*
     * The one dark material: grip rubber, shadow gaps, louvres, screws, bezels.
     *
     * ROUND 32 — IT WAS PURE BLACK, AND THAT IS THE DECAL CHARGE STATED
     * NUMERICALLY. On the same two shell-only windows as M_SHELL above, ours
     * measures detailRMS 31.97 and tileContrast 42.47 against the plate's 12.52
     * and 29.62 — 2.55x and 1.43x — and, more diagnostic than either, our shell
     * window's 0.1st percentile is luminance 0.9 while the plate's is 22 against
     * a median of 108.8. The reference shell has a 5:1 range top to bottom and
     * no true black anywhere on it; every seam, screw and louvre on it is a
     * BLUE-GREY line. Ours were 1.4% albedo against the shell's 30%, i.e. a 20:1
     * step drawn as hard-edged shapes, which is exactly the "smoothly-shaded
     * solid colour with painted-on line art" the whole-game critic named.
     *
     * 0x2e373d is 2.4x the old linear value: still unambiguously the dark
     * material against the shell, still reading as a shadow gap, but it can no
     * longer punch a hole to zero in a frame whose blacks LOOK.md 5 says are
     * lifted by atmosphere and never by a curve.
     */
    new THREE.MeshStandardMaterial({ color: srgb(0x2e373d), roughness: 0.78, metalness: 0.10 }),
    new THREE.MeshStandardMaterial({
      color: srgb(0x0e3350), roughness: 0.30, metalness: 0.0,
      emissive: new THREE.Color(0.22, 1.02, 1.45), emissiveIntensity: 1.0,
    }),
    /*
     * 6 THE ORANGE ACCENT. Kept — LOOK.md 3 is explicit that the reference is a
     * near-monochrome field with tiny hyper-saturated accents punched into it,
     * and the wrist bracelet and the tool's ident stripe are exactly that. But it
     * was rendering a fill of (0.084, 0.019, 0.014) at the 193 m cave, i.e. a red
     * channel SEVENTEEN TIMES the water's whole luminance: a glowing red bar in a
     * frame whose water is teal-black. Pulled toward rust so that even at full
     * fill it cannot out-run the medium.
     */
    new THREE.MeshStandardMaterial({ color: srgb(0xa9541d), roughness: 0.62, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({
      color: srgb(0x05131f), roughness: 0.22, metalness: 0.0,
      emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1.0,
      emissiveMap: screen ? screen.tex : null,
    }),
  ];
  /*
   * WEAR RIDES ON VERTEX COLOUR, on the albedo AND on the fill.
   *
   * These parts have no consistent UV set — they are superellipsoids welded out
   * of an icosphere, cylinders and tori merged into one buffer — so a texture map
   * is not available without unwrapping forty primitives by hand. A colour
   * attribute needs none: wearColours() bakes grime, cavity dirt and handling
   * polish straight onto the merged vertices from object-space noise.
   *
   * three multiplies vColor into diffuseColor only, and at 200 m the diffuse is
   * attenuated to nothing while the fill (carried in emissive) is all that is
   * left — so wear applied to albedo alone would be invisible in exactly the
   * frames the tool looks worst in. Chain onto core's onBeforeCompile, as this
   * file already does for the node field's instance tint, and take the emissive
   * with it. The cache key MUST differ from core's constant 'uw' or three hands
   * these materials some other module's compiled program.
   */
  /*
   * THE VIEW MODEL IS IN THE WATER LIKE EVERYTHING ELSE — with one leg of the
   * model scaled and one at full strength, and the difference matters.
   *
   *   fogScale 0.15  The DISTANCE leg. There is 45 cm of water between the tool
   *                  and the lens, so the view-ray extinction and in-scattering
   *                  that core integrates over tens of metres should be nearly
   *                  absent here. At the Lost River's authored 0.62/m red
   *                  extinction, fogScale 1 was eating 27% of the tool's red
   *                  over half a metre — a fog coefficient tuned for a 40 m
   *                  water column doing 40 m of work in 0.45 m.
   *   depthResponse  LEFT AT 1. This is the other leg and it is the one that was
   *                  missing: the light that lands on the tool has still come
   *                  down through 680 m of ocean, so the tool must go dark with
   *                  depth exactly as the seabed does.
   *   caustics 0     LOOK.md 3: lamps never cast caustics, and neither does the
   *                  hand holding one.
   *
   * Note that core deliberately EXEMPTS emissive from the depth response (see
   * UW_EMISSIVE in underwaterMaterial.js) — correctly, for a bioluminescent
   * plant. The lamp/ambient fill below is carried in emissive because a custom
   * ShaderMaterial cannot see three's light list, so ViewModel.setFill has to
   * apply that same response itself. It does; see the uwDark term there.
   */
  /*
   * SURFACE MICROSTRUCTURE ON THE HELD TOOL, at hand scale.
   *
   * wearColours() below already bakes grime, cavity dirt and handling polish
   * onto the merged vertices — but a vertex attribute can only carry detail down
   * to the vertex spacing, which on a 30 cm superellipsoid is about 8 mm. The
   * band a critic reads as "surface" is finer than that and it is the band core's
   * sfBroadband owns, so the two are complementary rather than redundant: the
   * vertex layer does the blotches, this does the pores.
   *
   * scale 0.30, not core's 2.2. The hull preset is authored for wreck plating
   * metres across; on a tool held 45 cm from the lens a 2.2 m streak field is a
   * single soft gradient over the whole object, which is what the round-seven
   * census found six materials doing across the game.
   *
   * The two lit materials are deliberately NOT in this list. Grain on a lit
   * readout is grain on light, not on a surface, and LOOK.md 27 wants
   * self-illuminated things to read as clean emissive points.
   */
  /*
   * MEASURED, not chosen. Per-octave energy of our scanner's shell plate against
   * the same plate on seamoth-1.jpg's first-person scanner, as % of crop mean,
   * fine -> coarse:
   *
   *   ours (grain 0.095)   4.48  7.04  12.14  20.79  35.68   detailRMS  4.75
   *   real scanner shell   4.69  7.49   9.76  13.95  21.03   detailRMS 19.62
   *
   * Two separate faults in one line. The fine end is a QUARTER of the
   * reference's — that is the "moulded vinyl" charge, stated numerically — and
   * the coarse end is 1.7x too high, so the spectrum rises 8:1 across the five
   * octaves where the reference rises 4.5:1. The correction is therefore in
   * opposite directions at the two ends, which is why "more detail" and "less
   * contrast" have both been wrong as blanket instructions: raise grain, which
   * core now builds DOWNWARD from the fragment's own footprint and so lands at
   * the fine end, and cut wear and streak, which are the low-frequency fields
   * and are all of the coarse end.
   */
  const TOOL_SURF = { grain: 0.21, wear: 0.20, streak: 0.07, scale: 0.30 };
  const SUIT_SURF = { grain: 0.16, wear: 0.14, streak: 0.05, scale: 0.22 };
  m.forEach((x, i) => applyUnderwater(x, {
    caustics: 0, fogScale: 0.15,
    surface: (i === M_LIT || i === M_SCREEN) ? null
      : (i === M_SUIT || i === M_GLOVE) ? SUIT_SURF : TOOL_SURF,
  }));
  /*
   * WEAR RIDES ON VERTEX COLOUR, on the albedo AND on the fill.
   *
   * These parts have no consistent UV set — they are superellipsoids welded out
   * of an icosphere, plus cylinders and tori, merged into one buffer — so a
   * texture map is not available without unwrapping forty primitives by hand. A
   * colour attribute needs none: wearColours() bakes grime, cavity dirt and
   * handling polish straight onto the merged vertices from object-space noise.
   *
   * three multiplies vColor into diffuseColor only, and below ~150 m the diffuse
   * is attenuated to nothing while the fill (carried in emissive) is all that is
   * left — so wear on albedo alone would be invisible in exactly the frames the
   * tool looks worst in. Chain onto core's onBeforeCompile, as this file already
   * does for the node field's instance tint (see instanceTintedEmissive), and
   * take the emissive with it.
   *
   * ORDER IS LOAD-BEARING: applyUnderwater ASSIGNS onBeforeCompile rather than
   * composing, so this must run after it or core silently drops the chunk. The
   * cache key must also differ from core's constant 'uw' or three hands these
   * materials the program it compiled for some other module's standard material;
   * core composes onto a prior key, so 'uw|tools.vmWear' comes out of this.
   */
  for (let i = 0; i <= M_BAND; i++) {
    m[i].vertexColors = true;
    const prev = m[i].onBeforeCompile;
    m[i].onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTlObj;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTlObj = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + TOOL_MICRO_PARS)
        .replace('#include <color_fragment>',
          '#include <color_fragment>\n\tfloat tlG = tlGrain(vTlObj);\n'
          + '\tdiffuseColor.rgb *= 1.0 + tlG;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n'
          + '\ttotalEmissiveRadiance *= vColor.rgb * (1.0 + tlG);\n'
          // Gloss varies with it too. A surface uniform in roughness reads as
          // plastic no matter how good its albedo is, and the whole point of
          // this layer is that the tool stops reading as moulded plastic.
          + '\troughnessFactor = clamp(roughnessFactor + tlG * 0.85, 0.04, 1.0);');
    };
    const priorKey = m[i].customProgramCacheKey;
    m[i].customProgramCacheKey = () => (priorKey ? priorKey.call(m[i]) : '') + '|tools.vmWear2';
    m[i].needsUpdate = true;
  }
  return m;
}

/**
 * OBJECT-SPACE MICROGRAIN FOR THE HELD TOOL — and why it is not core's job.
 *
 * Two reasons core's sfBroadband cannot serve this object, both measured:
 *
 * 1. IT IS EVALUATED IN WORLD SPACE, and the band-limited rebuild multiplies
 *    world position by 1/(2.5 px footprint). A tool 45 cm from the lens has a
 *    footprint around 0.3 mm, so the noise is sampled at roughly 3300 cycles per
 *    metre — against world coordinates that are in the tens of metres. The hash
 *    is fract()-based, and at an argument of 1e5 a 32-bit float's spacing is
 *    ~0.01, so the whole pattern collapses onto a few hundred distinct values.
 *    Measured: raising the preset's grain from 0.095 to 0.21 moved our fine
 *    octave by 0.04 absolute — i.e. the knob was doing nothing at all.
 *
 * 2. EVEN IF IT WORKED, world space is the wrong space for a view model. A held
 *    tool that draws its grain from where the PLAYER is standing has a surface
 *    that swims as you swim, which is a worse tell than having no grain.
 *
 * So: three octaves of value noise in OBJECT space, at 3-14 px on screen for a
 * tool at its rest pose, modulating albedo, the emissive fill and roughness
 * together. Frequencies are fixed rather than footprint-derived because a view
 * model's apparent size barely changes — which also means no fwidth, and
 * therefore nothing that could break the vertex stage.
 */
const TOOL_MICRO_PARS = /* glsl */ `
varying vec3 vTlObj;
float tlHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float tlNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tlHash(i + vec3(0, 0, 0)), tlHash(i + vec3(1, 0, 0)), f.x),
                 mix(tlHash(i + vec3(0, 1, 0)), tlHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(tlHash(i + vec3(0, 0, 1)), tlHash(i + vec3(1, 0, 1)), f.x),
                 mix(tlHash(i + vec3(0, 1, 1)), tlHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
/*
 * Flat amplitude per octave — the reference spectrum is flat, and a 1/f roll-off
 * is exactly the coarse-dominated blotch the round-7 census found across the
 * game. The three frequencies are solved from the tool's actual screen size
 * rather than picked: the shell spans about 0.46 object units and 200 px at the
 * rest pose, so f cycles per unit lands at 200/(0.46*f) px per cycle, and
 * 145/68/32 puts the three octaves at 3, 6 and 13 px. The first cut ran
 * 300/128/54, whose finest octave is 1.4 px — below Nyquist, so it averaged to
 * grey and moved the measured fine band by 0.04 in a hundred. That is what a
 * knob that appears to do nothing usually is.
 */
float tlGrain(vec3 op) {
  float s = tlNoise(op * 145.0) + tlNoise(op * 68.0) + tlNoise(op * 32.0);
  return (s / 3.0 - 0.5) * 0.46;
}
`;
/*
 * WHY 0.46 AND NOT 0.34, WHICH IS WHAT THE PHYSICS WANTED.
 *
 * postfx's depth of field blurs the view model. Measured on the same crop of the
 * same frame, fine -> coarse, against seamoth-1.jpg's own first-person scanner:
 *
 *   ours, DoF bypassed   6.96  7.96  12.12  20.59  24.45   detailRMS 13.26
 *   ours, DoF as shipped 3.66  5.71   9.97  18.50  24.28   detailRMS  5.59
 *   real scanner shell   4.69  7.49   9.76  13.95  21.03   detailRMS 19.62
 *
 * i.e. the pass removes 2.4x of the fine band from the single largest near-field
 * object in the frame, and 0.34 is correct only in the render nobody sees. The
 * reference's own view model is razor sharp — seamoth-1.jpg resolves the moulded
 * seams and the screen bezel of a tool at the same 45 cm — so the blur is wrong
 * as well as expensive. That is postfx's call, not this file's; until it is made,
 * calibrate on the frame a blind trial actually looks at, which is the one with
 * DoF in it. If the near-focus rule changes, drop this back to 0.34.
 */

/**
 * Per-vertex wear, baked from object-space noise onto an already-merged tool.
 *
 * Three signals, all of which are things a critic can name in a frame:
 *   grime    low-frequency blotches, slightly warm-green, so the shell is not one
 *            flat slab of albedo across a 40 cm object
 *   cavity   down-facing and inward-facing vertices hold silt — this is what
 *            makes the moulded seams and louvres read as recesses rather than as
 *            lines drawn on a smooth lozenge
 *   polish   up-facing high spots are rubbed back by handling, so the grime has
 *            a direction and the object looks used rather than dirty
 *
 * Deterministic: fbm3/noise3 are this file's own hash-based value noise, never
 * Math.random, so a seed reproduces a frame.
 */
function wearColours(geo, seed = 1) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const ox = seed * 13.7, oz = seed * 7.31;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const x = pos[j], y = pos[j + 1], z = pos[j + 2];
    /*
     * 2 cm blotches and a 7 mm speckle. The first cut ran 4 cm blotches at 0.26
     * amplitude and the shell photographed with a dark diagonal SMEAR across the
     * top cap — at that scale a low-frequency term stops reading as surface and
     * starts reading as a stain, which is worse than the flat albedo it replaced.
     * Higher frequency and half the amplitude reads as the thing it is.
     */
    const blot = fbm3(x * 48 + ox, y * 48, z * 48 + oz, 3) * 0.5 + 0.5;
    const fine = noise3(x * 160 + ox, y * 160, z * 160 + oz);
    const down = clamp01(-nor[j + 1]);
    const up = clamp01(nor[j + 1]);
    /*
     * ROUND 8 REBALANCE. A 2 cm blotch on an object held 45 cm from a 1920-wide
     * lens is roughly 80 px across, i.e. it lands squarely in the COARSEST
     * octave — and the octave measurement against seamoth-1.jpg's scanner put
     * our coarse band at 35.7% against the reference's 21.0%. This layer was a
     * third of that excess. Halve the blotch and lift the speckle: the vertex
     * attribute keeps the mid band it is actually good for and hands the fine
     * band to core's sfBroadband, which can resolve below the vertex spacing and
     * this cannot.
     */
    let w = 1 - 0.075 * blot - 0.10 * fine - 0.17 * down * down + 0.05 * up * blot;
    w = clamp(w, 0.70, 1.05);
    // Grime is warmer and greener than the plastic under it, but only just: this
    // is a 4% chroma swing, because LOOK.md 2 does not allow a near-field object
    // to grow a red channel and a "dirt is brown" instinct is exactly how one
    // grows. Blue loses the most, which is what algae film actually does.
    const t = (1 - w) * 0.9;
    col[j] = w * (1 + 0.045 * t);
    col[j + 1] = w * (1 + 0.030 * t);
    col[j + 2] = w * (1 - 0.075 * t);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * THE GLOVED HAND AND THE SLEEVED ARM.
 *
 * This used to be a bare hand on a bare forearm, and it was the most expensive
 * object in the project: six of eighteen blind A/B pairs were decided on it, at
 * depths from 12 m to 681 m, and the measured reason was always the same — skin
 * albedo is R/G 1.9, so the arm rendered five times redder than the water it
 * floated in at a depth where LOOK.md rule 1 says red is dead.
 *
 * The reference frame that bare skin was fitted against (seamoth-1.jpg) is a
 * player sitting INSIDE a Seamoth: a dry, pressurised, lamp-lit cabin at about
 * 10 m in the brightest water in the game. It is not evidence about a diver
 * outside a hull at 279 m with a hypothermia warning on the HUD. That diver
 * wears the suit, and so does this one now: neoprene glove, gauntlet cuff, full
 * sleeve to the corner of frame, with the orange Alterra bracelet kept because
 * LOOK.md 3 wants exactly one tiny hyper-saturated accent in a monochrome field.
 *
 * Built in tool space and parented to the same pivot as the tool, so the fingers
 * touch the grip by construction rather than by two offsets that have to be kept
 * in step. Angles run 0 = +X (back of the hand, away from the eye) increasing
 * toward +Z (the camera-facing side), so a finger wrapping from the knuckle at
 * -0.62 rad to a tip at +1.88 rad crosses the front of the grip exactly where
 * the reference shows four articulated segments.
 */
function handGeo() {
  const p = [];
  const GZ = 0.012;                       // grip axis, tool-local
  const seg = (a, y, R, len, rad, m = M_GLOVE) => part(
    superShape(len, rad, rad * 0.94, 2.7, ICO1), m,
    [Math.cos(a) * R, y, GZ + Math.sin(a) * R], [0, a + Math.PI / 2, 0]);

  /*
   * Four fingers, four segments each. A gloved finger is about 12% thicker than
   * a bare one and its segments are less articulated, because the neoprene
   * bridges the joints — hence the slightly fatter TH and the shallower DR.
   */
  const AS = [-0.62, 0.24, 1.10, 1.88];
  const RS = [0.0345, 0.0315, 0.0287, 0.0258];
  const TH = [0.0115, 0.0110, 0.0100, 0.0087];
  const DR = [0, -0.0010, -0.0030, -0.0060];
  for (let f = 0; f < 4; f++) {
    const y0 = 0.034 - f * 0.0205;
    const w = f === 3 ? 0.86 : f === 0 ? 0.97 : 1.0;    // the little finger is smaller
    for (let k = 0; k < 4; k++) {
      p.push(seg(AS[k], y0 + DR[k] * (1 + f * 0.2), RS[k] * (f === 3 ? 0.94 : 1),
        0.0136 * w, TH[k] * w));
    }
    /*
     * GRIP PADS on the palm side of the middle phalanx. This is the detail that
     * makes a fist read as GLOVED rather than as a dark-skinned bare hand: every
     * dive glove has a textured palm in a second, harder compound, and at this
     * scale it is four 8 mm dark lozenges crossing the front of the grip. Free —
     * mergeGroups puts every M_DARK part in the same draw.
     */
    const y0p = 0.034 - f * 0.0205;
    p.push(seg(1.10, y0p - 0.0030, RS[2] * 0.965, 0.0128, TH[2] * 0.62 * (f === 3 ? 0.86 : 1), M_DARK));
  }
  // ---- thumb: two segments round the far side, mostly in silhouette
  p.push(seg(-1.05, 0.040, 0.032, 0.0155, 0.0125));
  p.push(seg(-1.78, 0.033, 0.030, 0.0140, 0.0110));

  // ---- palm and the back of the hand
  p.push(part(superShape(0.027, 0.044, 0.034, 3.5, ICO2), M_GLOVE, [0.040, 0.002, 0.010]));
  p.push(part(superShape(0.024, 0.041, 0.032, 3.8, ICO2), M_GLOVE, [0.056, -0.014, 0.020], [0.16, 0, -0.10]));
  /*
   * Knuckle ARMOUR across the back of the hand: four low domes in the hard dark
   * compound instead of the four skin-coloured metacarpal domes that were here.
   * Same silhouette job — without them the back of the hand is one smooth
   * ellipsoid and the fist reads as a mitten — but now they also carry the
   * glove's two-material story into the lit half of the object.
   */
  for (let i = 0; i < 4; i++) {
    p.push(part(superShape(0.0092, 0.0074, 0.0092, 2.6, ICO1), M_DARK,
      [0.0465 + 0.004 * i, 0.030 - i * 0.0205, 0.0025 + i * 0.0035]));
  }
  // the seam that runs from the knuckles back to the cuff — one 3 mm rib, which
  // is what stops the back of the glove being a bare curved panel
  p.push(part(superShape(0.0035, 0.0300, 0.0032, 3.0, ICO1), M_DARK, [0.0505, -0.006, 0.014], [0.10, 0, -0.14]));
  // ---- wrist
  p.push(part(superShape(0.025, 0.029, 0.029, 3.6, ICO2), M_GLOVE, [0.066, -0.044, 0.033], [0.20, 0, -0.16]));

  /*
   * The arm, running out of the lower-right corner. The direction is mostly DOWN
   * and RIGHT with only a little toward the eye: the first cut aimed it at the
   * camera (+0.52 z) and the far end ended up 0.38 m from the lens, where a
   * 10 cm arm projects 310 px wide and became the largest object in every frame.
   * This lands the far end past the corner at about 180 px across.
   *
   * D is unit length, so `s` is metres along the arm from the wrist. The
   * gauntlet, the bracelet and the sleeve are all placed on that one axis.
   */
  const D = [0.46, -0.86, 0.22];
  const wrist = [0.066, -0.048, 0.036];
  const at = (s) => [wrist[0] + D[0] * s, wrist[1] + D[1] * s, wrist[2] + D[2] * s];
  // a torus's axis is +Z, and `aimed` rotates +Y — pre-roll it upright
  const ring = (r, t, m, s) => p.push(
    aimed(new THREE.TorusGeometry(r, t, 8, 20).rotateX(Math.PI / 2), m, at(s), D));
  /*
   * THE GAUNTLET. The glove does not simply stop at the wrist — it runs 6 cm up
   * the forearm and overlaps the suit sleeve, sealed by a moulded cuff ring. That
   * overlap is the whole reason the arm no longer reads as a limb pushed into a
   * tube: there are three distinct mouldings between the fingers and the corner
   * of frame instead of one uninterrupted cylinder of one colour.
   */
  ring(0.0308, 0.0058, M_DARK, 0.018);                        // glove wrist seal
  p.push(aimed(CYL(0.0300, 0.0345, 0.062, 16), M_GLOVE, at(0.052), D));
  ring(0.0362, 0.0062, M_DARK, 0.086);                        // gauntlet lip
  // suit sleeve from here to the corner of frame — one taper, two mouldings
  p.push(aimed(CYL(0.0352, 0.0412, 0.098, 16), M_SUIT, at(0.138), D));
  /*
   * The Alterra bracelet, two thirds of the way down the forearm. Kept as the
   * one warm accent in an otherwise cyan frame (LOOK.md 3), and it is now a
   * 5.4 mm band on a rust albedo rather than a 7.2 mm band on hazard orange —
   * measured, the old one emitted a red channel seventeen times the water's whole
   * luminance at the 193 m cave, which is not an accent, it is a light source.
   */
  ring(0.0420, 0.0054, M_BAND, 0.196);
  ring(0.0432, 0.0038, M_DARK, 0.208);                        // its dark surround
  p.push(aimed(CYL(0.0424, 0.0492, 0.072, 16), M_SUIT, at(0.246), D));
  ring(0.0512, 0.0072, M_LIT, 0.286);            // the suit's own trim light
  p.push(aimed(CYL(0.0500, 0.0620, 0.150, 16), M_SUIT, at(0.372), D));
  // moulded ribs down the sleeve, so it is not a plain black tube in silhouette
  ring(0.0532, 0.0044, M_DARK, 0.322);
  ring(0.0588, 0.0048, M_DARK, 0.392);
  return p;
}

/**
 * The survival knife, held blade FORWARD. Round one pointed a 35 cm blade
 * straight up out of the fist and, at this scale, it filled the right third of
 * the frame with a black spike — Subnautica's knife is a short forward-raked
 * blade that sits under the aim point.
 */
function knifeGeo() {
  const p = [];
  // handle: a hard core wrapped in rubber, with four moulded finger swells so
  // the fingers land in grooves instead of on a smooth dowel
  p.push(part(superShape(0.0180, 0.0520, 0.0160, 3.4, ICO2), M_SHELL, [0, 0.004, 0.004], [0.10, 0, 0]));
  p.push(part(superShape(0.0190, 0.0400, 0.0100, 3.2, ICO2), M_DARK, [-0.002, 0.004, 0.017], [0.10, 0, 0]));
  for (let i = 0; i < 4; i++) {
    p.push(part(superShape(0.0186, 0.0048, 0.0125, 3.0, ICO1), M_DARK,
      [0, 0.036 - i * 0.0215, 0.0080 - i * 0.0022], [0.10, 0, 0]));
  }
  // pommel and lanyard eye
  p.push(part(superShape(0.0165, 0.0125, 0.0085, 3.2, ICO2), M_STEEL, [0, -0.044, 0.012], [0.10, 0, 0]));
  // guard, and the shadow gap where the tang leaves the handle
  p.push(part(superShape(0.0225, 0.0090, 0.0275, 3.6, ICO2), M_STEEL, [0, 0.056, -0.006]));
  p.push(part(superShape(0.0228, 0.0026, 0.0278, 6.0, ICO1), M_DARK, [0, 0.049, -0.006]));
  // flat blade running forward and slightly up, with a fuller down its spine
  p.push(part(superShape(0.0050, 0.0210, 0.0700, 4.2, ICO2), M_STEEL, [0, 0.074, -0.082], [0.22, 0, 0]));
  p.push(part(superShape(0.0056, 0.0042, 0.0520, 4.0, ICO2), M_DARK, [0, 0.082, -0.084], [0.22, 0, 0]));
  p.push(part(new THREE.ConeGeometry(0.021, 0.052, 4, 1), M_STEEL, [0, 0.086, -0.170],
    [-Math.PI / 2 + 0.22, 0, Math.PI / 4], [1, 1, 0.26]));
  // honed edge: the one bright line on an otherwise dark tool
  p.push(part(superShape(0.0022, 0.0050, 0.0640, 3.0, ICO2), M_LIT, [0, 0.056, -0.082], [0.22, 0, 0]));
  // serrations on the spine, near the guard
  for (let i = 0; i < 5; i++) {
    p.push(part(superShape(0.0054, 0.0035, 0.0035, 2.6, ICO1), M_DARK,
      [0, 0.0905 + i * 0.0022, -0.038 - i * 0.0095], [0.22, 0, 0]));
  }
  return p;
}

/**
 * The scanner, laid out off seamoth-1.jpg: a chunky cream shell with a moulded
 * top rail, a brushed steel barrel housing on the far side ending in a
 * cyan-ringed lens, the big navy readout on the near face, and a pistol grip
 * with a trigger. Bigger than round one by half: measured against the reference
 * the whole tool has to hold about 7% of the frame, and a 12 cm body could not.
 */
/*
 * THE LAYOUT PROBLEM, AND WHY THE DRUM MOVED TO THE NEAR FACE.
 *
 * Round three put the readout on the tool's -X face and the lens on its -Z nose.
 * With the rig's +0.50 rad yaw those two map to world offsets (-0.070, -0.021)
 * and (-0.073, -0.159): the same screen X to within 3 mm. The screen is the
 * nearer of the two, so it covered the lens completely and the frame showed a
 * white box with a panel on it — a critic reading it called the tool a lozenge
 * and was right, because the half of the model that carries all the character
 * was geometrically unreachable from the only angle it is ever seen at.
 *
 * seamoth-1.jpg does not have this problem because its drum is a SIDE feature:
 * the disc faces the player, roughly coplanar with the readout, and the tool's
 * nose runs off past it. So the drum sits on the near face here too, forward of
 * the readout along the barrel, which separates them by 7 cm of screen X and
 * puts both squarely in view. The nose is then free to be the aperture it should
 * always have been.
 */
function scannerGeo() {
  const p = [];
  const push = (...a) => p.push(...a);
  const NX = -0.040;            // the near face, i.e. the one turned to the eye

  // ---- main shell: long in Z (it points where you aim). Exponent 3.6, not the
  // 4.6 of round three — at 4.6 this is a rounded BOX and it read as a toaster.
  push(part(superShape(0.041, 0.047, 0.084, 3.6, ICO4), M_SHELL, [0, 0.072, -0.044]));
  // the neck that steps down into the grip
  push(part(superShape(0.035, 0.030, 0.030, 3.6, ICO2), M_SHELL, [0, 0.038, 0.014]));
  // the nose: a tapered cap with the emitter aperture in it
  push(part(superShape(0.030, 0.034, 0.030, 3.4, ICO2), M_SHELL, [0, 0.078, -0.132]));
  push(part(CYL(0.0205, 0.0245, 0.014, 16), M_DARK, [0, 0.078, -0.160], [Math.PI / 2, 0, 0]));
  push(part(superShape(0.0135, 0.0032, 0.0030, 3.0, ICO1), M_LIT, [0, 0.078, -0.166]));

  /*
   * THE SPLIT LINE IS GONE, AND SO IS THE SHADOW-GAP SLAB UNDER THE TOP CAP.
   *
   * Both were thin dark superellipsoids laid along a curved shell, and both were
   * unrepresentable at any subdivision this file can afford: the split line is
   * 2.6 mm thick against a 47 mm ICO2 facet error — 9x — and still 18 mm at
   * ICO4. What draws is not a parting seam, it is whatever the tessellation
   * happens to leave outside the shell along a grazing curve, which is a
   * wandering dark smear.
   *
   * The gap slab, separately, was measured 100% BURIED: every one of its 162
   * vertices lies inside the shell mesh, so it drew nothing at all and cost 320
   * triangles to do it. Same for the three louvre bars, which the round-33 note
   * above already admitted the reference tool does not have.
   *
   * Deleting them is not a loss of surface language, because the language they
   * were carrying was the wrong kind: the whole-game critic's charge is that our
   * assets carry their signal as hard-edged decal (this shell measured 2.55x the
   * reference's detailRMS and 1.43x its tileContrast) where the reference carries
   * it as low-amplitude broadband. The shell already has core's sfBroadband and
   * wearColours() on it; those are shading terms and cannot z-fight.
   */
  push(part(superShape(0.0308, 0.0125, 0.0665, 3.8, ICO3), M_SHELL, [0, 0.115, -0.050]));
  /*
   * THE ALTERRA IDENT STRIPE IS GONE FROM THE CROWN, AND IT WAS THE BROWN GASH.
   *
   * The round-33 note here claimed "the reference puts exactly one of these on
   * the tool". It does not. Looking at seamoth-1.jpg's scanner at 3x: the shell
   * is one unbroken cream mass with no stripe, no louvre row, no parting seam and
   * no panel gap anywhere on it. Its only warm element is the small amber emitter
   * slot beside the drum — which this file already models, twenty lines below.
   *
   * Geometry was only half of what was wrong with it. Reseating it as a properly
   * tessellated raised rib did make it a clean shape, and it still read as a hole:
   * measured on the crown in `hud`, the rib comes back at luminance 25 against
   * the shell beside it at 97 and the open water at 127 — the darkest thing in
   * the upper half of the frame, on the crown of the hero tool.
   *
   * The reason generalises, and matters for anything else tinted M_BAND. This
   * accent's chroma lives almost entirely in RED, and setFill divides the albedo
   * by the depth transmittance, which at 20 m puts red at 0.38 of neutral. An
   * accent whose whole colour sits in the one channel the medium deletes cannot
   * survive as an accent at depth — it desaturates to brown and then to black,
   * and a black lozenge on a pale shell is read as an opening. If a warm accent
   * is wanted at depth it has to be an AMBER one, carrying its energy in green,
   * which is the channel that survives.
   */

  /*
   * THE DRUM. In seamoth-1.jpg this is the tool's focal point: a brushed steel
   * housing carrying a dark bezel, a bright cyan annulus, black glass and one
   * small bright bar. Round three built it 2.4 cm across on the nose, where it
   * was both too small to read at 1080p and hidden behind the readout. It is
   * 6 cm across now and it sits on the face the player is looking at.
   */
  const DX = NX - 0.014, DZ = -0.086;
  push(part(superShape(0.0180, 0.0330, 0.0330, 4.0, ICO2), M_STEEL, [DX + 0.008, 0.080, DZ]));
  push(part(CYL(0.0300, 0.0310, 0.020, 20), M_STEEL, [DX - 0.004, 0.080, DZ], [0, 0, Math.PI / 2]));
  push(part(new THREE.TorusGeometry(0.0298, 0.0055, 8, 22), M_DARK, [DX - 0.013, 0.080, DZ], [0, Math.PI / 2, 0]));
  push(part(new THREE.TorusGeometry(0.0228, 0.0060, 8, 22), M_LIT, [DX - 0.016, 0.080, DZ], [0, Math.PI / 2, 0]));
  push(part(new THREE.SphereGeometry(0.0200, 16, 10), M_DARK, [DX - 0.014, 0.080, DZ], [0, 0, 0], [0.42, 1, 1]));
  push(part(superShape(0.0026, 0.0100, 0.0026, 3.0, ICO1), M_LIT, [DX - 0.020, 0.080, DZ]));
  // the amber emitter window beside the drum, straight off the reference
  push(part(superShape(0.0040, 0.0090, 0.0056, 3.6, ICO1), M_BAND, [NX - 0.008, 0.080, DZ + 0.040]));
  // four fixing screws around the drum
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * (Math.PI / 2);
    push(part(new THREE.SphereGeometry(0.0032, 8, 6), M_DARK,
      [DX - 0.008, 0.080 + Math.sin(a) * 0.031, DZ + Math.cos(a) * 0.031]));
  }

  /*
   * ---- the readout, AND THE SAWTOOTH.
   *
   * A critic read "a sawtooth of 5+ black wedges through the scanner shell". It
   * is this bezel. At 11.6 mm thick with a 15.0 mm ICO2 facet error, the mesh is
   * coarser than the slab is thick — so along the curve where the bezel leaves
   * the shell, whether any given facet lands inside or outside the shell is
   * decided by tessellation noise, and the exit curve draws as a row of hard
   * black triangles tens of pixels across. It is made worse by the two surfaces
   * being nearly PARALLEL there: the bezel's plane sits at x -0.039 and the
   * shell's own surface at that height is at x -0.0398, so they graze, and a
   * grazing intersection converts a small normal error into a large lateral one.
   *
   * Fixed on both axes. ICO4 takes the facet error to 2.2 mm — under a fifth of
   * the slab's thickness — and the whole readout stack moves 5 mm further out in
   * X so the bezel stands clear of the shell's flank rather than straddling it,
   * with a small steeply-walled riser doing the joining. A riser that is much
   * smaller than the shell's local curvature meets it in a short, well-conditioned
   * closed curve instead of a long tangent one.
   */
  push(part(superShape(0.0130, 0.0300, 0.0380, 3.6, ICO3), M_DARK, [NX + 0.006, 0.0715, 0.000]));
  push(part(superShape(0.0058, 0.0430, 0.0520, 3.8, ICO4), M_DARK, [NX - 0.004, 0.0715, 0.000]));
  push(part(superShape(0.0072, 0.0400, 0.0485, 3.6, ICO4), M_SHELL, [NX - 0.009, 0.0715, 0.000]));
  /*
   * The three hinge knuckles are gone. Along their row the bezel's own x
   * half-extent runs from 3.4 mm at the rear end to 5.4 mm at the middle, so a
   * 4.8 mm cylinder was proud at one end of the row and buried at the other —
   * the row could not be consistently seated at any single x. They are also
   * exactly the hard-edged line art this shell already carries too much of, and
   * seamoth-1.jpg's scanner has no hinge on its readout at all.
   */

  // ---- grip: a hard core with a soft rubber over-mould and four finger swells
  push(part(superShape(0.0250, 0.0575, 0.0225, 3.8, ICO2), M_SHELL, [0.002, -0.012, 0.014], [0.30, 0, 0]));
  push(part(superShape(0.0268, 0.0350, 0.0130, 3.4, ICO2), M_DARK, [-0.001, -0.010, 0.031], [0.30, 0, 0]));
  // Finger swells at ICO2: 5.8 mm thick against a 6.2 mm ICO1 facet error, i.e.
  // the same unrepresentable case as the louvres, on the part of the tool the
  // player's own hand is wrapped around.
  for (let i = 0; i < 4; i++) {
    push(part(superShape(0.0262, 0.0058, 0.0165, 3.0, ICO2), M_DARK,
      [0.002, 0.028 - i * 0.0215, 0.0245 - i * 0.0064], [0.30, 0, 0]));
  }
  // Trigger, in its own guard. The guard is 7.6 mm through and needs ICO3 to get
  // under the one-third rule (ICO1 6.9 mm, ICO2 4.1 mm, ICO3 1.5 mm).
  push(part(superShape(0.0080, 0.0175, 0.0062, 3.0, ICO2), M_STEEL, [0.002, 0.026, -0.021], [0.5, 0, 0]));
  push(part(superShape(0.0225, 0.0038, 0.0055, 3.4, ICO3), M_DARK, [0.002, 0.008, -0.030], [0.2, 0, 0]));
  // battery cap in the butt of the grip
  push(part(CYL(0.0215, 0.0225, 0.0090, 14), M_STEEL, [0.007, -0.070, 0.031], [0.30, 0, 0]));

  /*
   * ---- status pips on the shoulder: a charge row rather than one blue lozenge.
   *
   * They RAN OFF THE BACK OF THE TOP CAP. The cap ends at z +0.0165 and the row
   * was laid at z 0.000 / 0.010 / 0.020, so measured against the cap mesh the
   * three pips were 38%, 95% and 100% outside it — the last one floating in open
   * air behind the moulding. What the frame showed was two or three grey warts on
   * the shoulder rather than a charge row. Pulled forward onto the cap's crown,
   * given a thickness their tessellation can resolve, and seated 5 mm deep.
   */
  for (let i = 0; i < 3; i++) {
    push(part(superShape(0.0100, 0.0055, 0.0042, 3.0, ICO2), M_LIT,
      [0, 0.1240, -0.020 + i * 0.0115]));
  }
  return p;
}
/**
 * The lit readout plane. A PlaneGeometry's normal is +Z and its width runs +X,
 * so rotY = -PI/2 lays it on the scanner's near face with the canvas's long
 * axis running down the tool. 3 mm proud of the bezel, which is itself proud of
 * the shell.
 *
 * MOVED WITH THE READOUT STACK. The screen face now sits at x -0.049 with a
 * half-thickness of 7.2 mm, so its outer surface is at -0.0562; a plane left at
 * -0.0530 would have been 3 mm INSIDE the panel it is supposed to light, which
 * is the same "buried readout that z-fights into a black scribble" the round-one
 * note above records. Kept at the same 3 mm of clearance it always meant to have.
 */
const SCREEN_PLACE = { w: 0.092, h: 0.064, pos: [-0.0592, 0.0715, 0.000], rotY: -Math.PI / 2 };

/**
 * The dive torch. Round one was a plain 20 cm tube, and held at 28 degrees off
 * the view axis it projected as one featureless sausage with the reflector
 * hidden behind it. This is shorter, with a flared reflector head that stays in
 * silhouette from behind, a knurled collar and a lit strip down the body, so
 * the shape reads as a lamp from the angle it is actually seen at.
 */
function torchGeo() {
  const p = [];
  const CZ = (rt, rb, h, z, m, seg = 18, x = 0, y = 0.052) =>
    p.push(part(CYL(rt, rb, h, seg), m, [x, y, z], [Math.PI / 2, 0, 0]));
  const ring = (r, t, z, m) => p.push(part(new THREE.TorusGeometry(r, t, 8, 24), m, [0, 0.052, z]));

  // ---- barrel, in three mouldings separated by knurled collars
  CZ(0.0300, 0.0325, 0.062, 0.014, M_SHELL);
  CZ(0.0338, 0.0338, 0.013, -0.021, M_DARK);
  CZ(0.0322, 0.0332, 0.050, -0.054, M_SHELL);
  CZ(0.0345, 0.0345, 0.011, -0.083, M_DARK);
  /*
   * The Alterra ident band, RECESSED between two grooves and 6 mm rather than
   * 13 mm wide. At full width on the barrel of the most-carried tool it was the
   * one saturated warm object in a 75 m frame and it photographed as a red
   * warning stripe; a fine stripe between two dark grooves is what the reference
   * actually does with an accent colour, and it reads as trim instead.
   */
  CZ(0.0334, 0.0334, 0.0032, -0.0295, M_DARK);
  CZ(0.0331, 0.0331, 0.0060, -0.036, M_BAND);
  CZ(0.0334, 0.0334, 0.0032, -0.0425, M_DARK);

  /*
   * THE HEAD, AND WHY IT IS LIT ON THE OUTSIDE.
   * A dive torch is only ever seen from BEHIND in first person: the reflector
   * dish faces the water, so at night the previous model presented a black disc
   * on a black background and a critic could not tell the lamp was on from the
   * view model at all. Real dive lights solve exactly this with a light-pipe
   * collar around the outside of the head, and it is the honest fix — the ring
   * below is visible from every angle the player can hold the tool at, and it
   * is driven by the lamp's own power in setFill, so the model states its own
   * on/off. The forward-facing dish is still there for the 3/4 angles.
   */
  CZ(0.0402, 0.0352, 0.020, -0.100, M_DARK);
  // 4.5 mm PROUD of the housing behind it. At 0.0412 the collar was flush with
  // the reflector's back end and the night frame showed a black head on a black
  // background — the ring has to break the silhouette to do its job.
  ring(0.0455, 0.0072, -0.114, M_LIT);            // the collar — reads from behind
  /*
   * THE REFLECTOR NOW FLARES FORWARD, AND THE TWO FRONT RINGS ARE ATTACHED TO IT.
   *
   * CZ() rotates a CylinderGeometry by +PI/2 about X, which maps the cylinder's
   * +Y (its `rt` end) onto +Z — the end nearest the player. So `CZ(0.0492,
   * 0.0402, ...)` was 49 mm across at the BACK and 40 mm at the front: a
   * reflector tapering the wrong way, narrowing toward the water. Swapped.
   *
   * That also fixes the "open-crescent collar rings" a critic read on this head.
   * The two rings in front sat at radii 50.5 mm and 51.6 mm while the housing
   * under them was only 40.8 mm and 40.5 mm — so their inner tube surface cleared
   * the body by 3.7 mm and 4.5 mm and they were floating, unattached, in open
   * water. The rear one was worse than floating: at z -0.163 it sat 4 mm BEYOND
   * the housing's front face, with nothing behind it at all. With the flare the
   * right way round the body is ~49 mm where they sit, so both rings now bite
   * into it and read as a lip and a bezel instead of two hoops in mid-air.
   */
  CZ(0.0402, 0.0492, 0.048, -0.135, M_STEEL, 22);
  ring(0.0505, 0.0060, -0.156, M_LIT);            // front lip, lit, in silhouette
  ring(0.0512, 0.0062, -0.1575, M_DARK);          // bezel over it
  p.push(part(new THREE.SphereGeometry(0.0445, 18, 10, 0, TAU, 0, Math.PI * 0.5), M_LIT,
    [0, 0.052, -0.150], [-Math.PI / 2, 0, 0], [1, 0.42, 1]));

  /*
   * ---- body furniture: a lit charge strip, the switch, vents, battery hump
   *
   * THE CHARGE STRIP IS THE "STRAY DAGGER POLYGON". It is 9.6 mm through its thin
   * axes and 60 mm long — a 6:1 aspect — and at ICO2 that shape carries a 6.0 mm
   * facet error, 62% of its own thickness. Sitting at radius 31.1 mm on a barrel
   * of 32.2 mm it barely breaks the surface at all, so which end of it emerges is
   * decided by the facets, and what draws is a hard black wedge across the barrel
   * rather than a strip down it. ICO4 takes the error to 0.7 mm, and the strip is
   * lifted to a radius that clears the barrel along its whole length instead of
   * grazing it. The vents have the same disease at ICO1 (6.4 mm error on 7.6 mm).
   */
  p.push(part(superShape(0.0048, 0.0048, 0.030, 3.0, ICO4), M_LIT, [-0.0318, 0.0648, -0.028]));
  p.push(part(superShape(0.0090, 0.0078, 0.0135, 3.2, ICO2), M_DARK, [-0.0300, 0.040, 0.006]));
  for (let i = 0; i < 4; i++) {
    p.push(part(superShape(0.0038, 0.0038, 0.0230, 3.4, ICO3), M_DARK,
      [0.020 + 0.0075 * i, 0.052 + (i - 1.5) * 0.010, -0.054]));
  }
  p.push(part(superShape(0.0235, 0.0180, 0.0380, 3.8, ICO2), M_SHELL, [0, 0.021, -0.014]));
  // grip: rubber over-mould with finger swells, matching the scanner's language
  p.push(part(superShape(0.0225, 0.0400, 0.0200, 3.6, ICO2), M_SHELL, [0, -0.006, 0.008], [0.25, 0, 0]));
  p.push(part(superShape(0.0240, 0.0270, 0.0120, 3.2, ICO2), M_DARK, [-0.003, -0.004, 0.023], [0.25, 0, 0]));
  // finger swells: 5.2 mm thick, 5.5 mm ICO1 facet error — unrepresentable, and
  // on the part the hand closes around. ICO2 takes it to 1.9 mm.
  for (let i = 0; i < 3; i++) {
    p.push(part(superShape(0.0232, 0.0052, 0.0140, 3.0, ICO2), M_DARK,
      [0, 0.020 - i * 0.0215, 0.0175 - i * 0.0054], [0.25, 0, 0]));
  }
  p.push(part(CYL(0.0195, 0.0205, 0.0085, 14), M_STEEL, [0.005, -0.050, 0.020], [0.25, 0, 0]));
  return p;
}

function beaconGeo() {
  const p = [];
  p.push(part(CYL(0.028, 0.034, 0.130, 14), 2, [0, 0.062, 0]));
  p.push(part(new THREE.TorusGeometry(0.030, 0.006, 8, 18), 5, [0, 0.100, 0], [Math.PI / 2, 0, 0]));
  p.push(part(new THREE.SphereGeometry(0.022, 14, 10), 5, [0, 0.140, 0]));
  p.push(part(CYL(0.010, 0.010, 0.040, 8), 3, [0, 0.166, 0]));
  p.push(part(superShape(0.020, 0.030, 0.020, 3.4, ICO2), 4, [0, 0.010, 0.006], [0.2, 0, 0]));
  return p;
}

function seaglideGeo() {
  const p = [];
  p.push(part(superShape(0.075, 0.058, 0.140, 3.0, ICO3), 2, [0, 0.070, -0.050]));
  p.push(part(superShape(0.052, 0.042, 0.030, 4.0, ICO2), 3, [0, 0.070, -0.176]));
  p.push(part(new THREE.SphereGeometry(0.040, 16, 10), 5, [0, 0.070, -0.196], [0, 0, 0], [1, 1, 0.42]));
  p.push(part(new THREE.TorusGeometry(0.048, 0.008, 8, 22), 3, [0, 0.070, -0.170], [0, 0, 0]));
  p.push(part(superShape(0.024, 0.052, 0.022, 3.4, ICO2), 4, [-0.062, 0.020, 0.010], [0.2, 0, -0.35]));
  p.push(part(superShape(0.024, 0.052, 0.022, 3.4, ICO2), 4, [0.062, 0.020, 0.010], [0.2, 0, 0.35]));
  p.push(part(superShape(0.058, 0.004, 0.056, 4.0, ICO2), 5, [0, 0.122, -0.030]));
  return p;
}

/** Consumables: a squeeze flask with a cyan level window. */
function flaskGeo() {
  const p = [];
  p.push(part(superShape(0.036, 0.062, 0.030, 3.2, ICO2), 2, [0, 0.062, 0]));
  p.push(part(superShape(0.020, 0.044, 0.004, 3.0, ICO2), 5, [0, 0.058, 0.031]));
  p.push(part(CYL(0.014, 0.018, 0.030, 10), 4, [0, 0.132, 0]));
  p.push(part(new THREE.TorusGeometry(0.017, 0.005, 8, 14), 3, [0, 0.126, 0], [Math.PI / 2, 0, 0]));
  return p;
}

/**
 * Rest pose of the whole hand rig: x, y, z, pitch, yaw, roll.
 *
 * Measured against seamoth-1.jpg at 1920x1080: the reference scanner spans
 * x 1205-1560, y 570-1000 — 355x430 px, 7.4% of the frame, centred at NDC
 * (+0.44, -0.45). Round one held it at z -0.66 and scale 0.70, which measured
 * 140x110 px = 0.7%. This is 0.50 m out at 1.24 (with the tool pivot's own
 * 1.12 on top), i.e. 2.3x linear before the model itself was enlarged.
 *
 * The yaw is POSITIVE now, which is the other half of the fix: at -0.48 the
 * scanner's readout face pointed away from the eye and could never be seen.
 */
const HOLD = [0.292, -0.212, -0.545, 0.11, 0.50, 0.10];

const TOOL_BUILDERS = {
  knife: knifeGeo, scanner: scannerGeo, flashlight: torchGeo,
  beacon: beaconGeo, seaglide: seaglideGeo, water: flaskGeo,
};

/**
 * The view model rig. Everything lives at renderOrder 9900 so the lamp pass
 * (9800) cannot paint a light pool across the back of the player's own hand,
 * and both noDepthPass and noShadow are set: a hand 45 cm from the eye in the
 * god-ray depth prepass deletes every shaft behind it, and in the sun's shadow
 * map it drags a black blob across the seabed.
 */
/**
 * Per-tool hand placement. Everything is modelled with its grip on the tool's
 * own origin so the default identity is right; the seaglide is the exception
 * because it is held by a side handle rather than a pistol grip.
 */
const HAND_AT = {
  seaglide: { pos: [0.058, 0.014, 0.010], rot: [0, 0, -0.30] },
  water: { pos: [0.004, 0.052, 0.004], rot: [0, 0, 0] },
};
/**
 * Extra yaw per tool, about the grip axis. The rig's 0.50 rad turns the
 * scanner's readout toward the eye, which is exactly right for the scanner and
 * wrong for everything with a long barrel: the torch at that angle projected as
 * one featureless tube with its reflector hidden behind it. Yaw is the only
 * safe axis to vary here — the grip is a vertical cylinder, so a spin about it
 * leaves the fingers exactly where they were.
 */
const TOOL_YAW = { flashlight: -0.40, knife: -0.16, beacon: -0.20, seaglide: -0.26, water: -0.10 };

/**
 * The muzzle glow. A dive torch is only ever seen from BEHIND in first person,
 * so the one thing that tells a player the lamp is lit — the reflector dish —
 * faces away from them. Real footage solves this with flare off the water right
 * at the head, and this is that: a camera-facing additive disc parked at the
 * muzzle with a tight core and a wide soft halo, alpha driven by the lamp's own
 * eased power. It is also what postfx's bloom (top 1-2% of luminance, LOOK.md 9)
 * catches, so the torch gets a real halo instead of a painted one.
 */
const GLOW_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uCentre;
uniform float uSize;
varying vec2 vGUv;
void main() {
  vGUv = uv * 2.0 - 1.0;
  vec3 f = normalize(uCamPos - uCentre);
  vec3 r = cross(vec3(0.0, 1.0, 0.0), f);
  float rl = length(r);
  r = rl > 1e-4 ? r / rl : vec3(1.0, 0.0, 0.0);
  vec3 u = cross(f, r);
  vec3 wp = uCentre + (r * vGUv.x + u * vGUv.y) * uSize;
  vUwWorldPos = wp;
  vUwWorldNormal = f;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const GLOW_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uTint;
uniform float uAmt;
varying vec2 vGUv;
void main() {
  float r = length(vGUv);
  if (r > 1.0 || uAmt < 0.002) discard;
  /*
   * TIGHT. The first cut ran a 0.26-weight halo out to r = 1 at a 6 cm radius,
   * which at 45 cm from the eye is a 220 px warm disc — and since the tint is a
   * torch white, it washed the whole barrel salmon in the night frame and read
   * as the tool's colour rather than as light. LOOK.md 2 does not forgive that.
   * The core does the work; the halo is a hint, and postfx's bloom supplies the
   * spread it used to be painting by hand.
   */
  float core = exp(-r * r * 11.0);
  float halo = exp(-r * 4.2) * 0.14;
  float dist = length(uCamPos - vUwWorldPos);
  gl_FragColor = vec4(uTint * ((core + halo) * uAmt) * uwTransmittance(dist), 1.0);
}`;

const _vmF = new THREE.Vector3();
const _vmD = new THREE.Vector3();

/*
 * ===========================================================================
 * THE VIEW-MODEL FILL, ANCHORED TO THE WATER
 * ===========================================================================
 *
 * A MeshStandardMaterial cannot see the deferred lamp pass (see the header), so
 * the light the player's own torch and the surrounding water put on the tool has
 * to be supplied by hand, carried in `emissive`. Four rounds of that fill were
 * free-floating constants tuned per frame, and the measurement that finally
 * indicted them is simple: at every depth in the battery, the fill was brighter
 * than the water it sat in.
 *
 *     shot            depth    water radiance   glove fill   shell fill
 *     hud              20 m       0.160           0.455        0.236
 *     night-shallows   14 m       0.159           0.431        0.440
 *     dropoff          75 m       0.077           0.287        0.214
 *     cave            193 m       0.0048          0.0417       0.0389
 *     grand-reef      280 m       0.0194          0.0548       0.0518
 *     deep-void       681 m       0.0045          0.0284       0.0295
 *
 * 1.5x to 8.7x, everywhere. That is not a tuning error, it is a missing
 * denominator: nothing in the old model referred to the medium at all, so the
 * tool's brightness and the water's brightness were two independent numbers that
 * happened to be fitted at 20 m and diverged everywhere else.
 *
 * So give it the denominator. U.uFogColor IS the radiance a far-field horizontal
 * ray resolves to — core normalises uwInscatter to exactly that, and biomes.js
 * authors it per biome and per depth band. A surface immersed in a field of that
 * radiance reflects albedo x radiance, i.e. it is DARKER than the water, which is
 * precisely what LOOK.md 2's "the nearest rock spire is near-black" describes.
 * Anchor the ambient half there and it is correct in every biome and at every
 * depth for free, with no per-frame constants and no per-biome table.
 *
 * The lamp half stays absolute, because a torch 30 cm from the hand does not care
 * how deep the ocean is — and postfx's meter is clamped to uEvMax = 1 below 30 m,
 * so it may only darken and cannot blow a fixed near-field level up.
 */
/*
 * VM_AMB is in units of the water's own radiance, and it is deliberately ABOVE 1.
 * A surface immersed in an isotropic field of radiance L reflects albedo x L,
 * i.e. it is darker than the water — which is the right shape of the answer and,
 * at 1.05, was the wrong size of it: measured against seamoth-1.jpg's own
 * first-person scanner, the reference tool reads 1.60x the median of the water
 * beside it and ours came back at 0.30x. The field a held tool sits in is not
 * isotropic (the upward hemisphere is much brighter than the downward one, and
 * the tool is held up into it) and the direct sun is on top of that, so >1 is
 * physical rather than a fudge. 1.35 plus the albedo lift closes most of the gap
 * without putting the fill back above the medium at depth, where the whole
 * problem was.
 */
const VM_AMB = 1.35;     // hemispheric bounce, in units of the water's radiance
const VM_LAMP = 0.032;   // torch backscatter onto its own holder, absolute
const VM_SPILL = 1.7;    // metres of water that backscatter has been through
/*
 * The two emitters ON the gear, both in units of litAnchor() — see its comment
 * for the plate window that sets them. Chosen so the frames that already
 * measured correctly do not move and the frames that were blowing come down:
 * the collar's own emissive falls 3.0x at the 192 m cave and 5.2x at the 681 m
 * void while rising 1.17x at 74 m, and the muzzle flare falls 4.1x and 6.7x at
 * the same two depths while holding to within 6% at 74 m.
 */
const VM_LIT = 2.55;     // the torch's light-pipe collar and the tool trim
const VM_GLOW = 8.50;    // the muzzle flare, which is a halo AROUND that collar

/**
 * postfx's near-zone channel gain, rederived from the same uniform postfx reads.
 *
 * postfx grades the near field by a partial lerp toward the reciprocal of the
 * live biome's fog chromaticity, on the argument that the near field is the part
 * that has lost the least red. That argument is sound for geometry a few metres
 * out and false for an object 45 cm from the lens, which has no medium in front
 * of it at all — there, the operator does not restore red, it invents it. In
 * blue-green water the gain lands on (1.45, 0.93, 0.76): a 1.9:1 red-over-blue
 * push applied to whatever the view model happens to be, which is most of the
 * reason a neutral shell rendered salmon and a tan hand rendered pink.
 *
 * So cancel it, on this object only. Same formula, same clamps, same source
 * uniform — not a hand-fitted approximation of it, which is what the previous
 * three rounds of residual constants were.
 */
const _nearGain = [1, 1, 1];
function postfxNearGain(out) {
  const f = U.uFogColor.value;
  const y = 0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b;
  if (!(y > 1e-5)) { out[0] = out[1] = out[2] = 1; return out; }
  // postfx's chromaDir clamps the direction to [0.45, 2.2]; its strength ramps
  // 0.42 -> 0.48 over 35-150 m and scales with uUnderwater; the gain itself is
  // then clamped to [0.70, 1.45]. Every one of those numbers is reproduced here
  // rather than approximated, because the red leg is pinned on the upper clamp in
  // every biome we ship and getting the clamp wrong is the difference between
  // cancelling the operator and doubling it.
  const depth = Math.max(0, U.uWaterLevel.value - U.uCamPos.value.y);
  const amt = (0.42 + 0.06 * smoothstep(35, 150, depth)) * clamp01(U.uUnderwater.value);
  const c = [clamp(f.r / y, 0.45, 2.2), clamp(f.g / y, 0.45, 2.2), clamp(f.b / y, 0.45, 2.2)];
  for (let i = 0; i < 3; i++) out[i] = clamp(1 + amt * (1 / c[i] - 1), 0.70, 1.45);
  return out;
}

const _vmC = new THREE.Vector3();
const _vmS = new THREE.Vector3();

class ViewModel {
  constructor(scene) {
    this.screen = makeScreen();
    this.mats = makeToolMats(this.screen);
    this.root = new THREE.Group();
    this.root.name = 'tools.viewmodel';
    scene.add(this.root);

    this.pivot = new THREE.Group();     // sway + bob
    this.root.add(this.pivot);
    this.holder = new THREE.Group();    // draw/holster
    this.holder.position.set(HOLD[0], HOLD[1], HOLD[2]);
    this.holder.rotation.set(HOLD[3], HOLD[4], HOLD[5]);
    this.holder.scale.setScalar(1.20);
    this.pivot.add(this.holder);

    this.toolPivot = new THREE.Group();
    this.toolPivot.scale.setScalar(1.12);
    this.holder.add(this.toolPivot);

    // The hand shares the TOOL pivot, not the holder: one frame, so the fingers
    // land on the grip by construction and stay there through the swing arc.
    // wearColours: the materials declare vertexColors, so EVERY mesh that uses
    // them must carry a colour attribute or WebGL hands the shader the disabled-
    // attribute default of (0,0,0) and the object renders black.
    this.hand = new THREE.Mesh(wearColours(mergeGroups(handGeo()), 3), this.mats);
    this.hand.name = 'tools.vm.hand';
    this.hand.renderOrder = 9900;
    this.hand.userData.noDepthPass = true;
    this.hand.userData.noShadow = true;
    this.hand.castShadow = false; this.hand.receiveShadow = false;
    this.hand.frustumCulled = false;
    this.hand.visible = false;
    this.toolPivot.add(this.hand);

    this.tools = {};
    let wseed = 11;
    for (const [id, build] of Object.entries(TOOL_BUILDERS)) {
      const mesh = new THREE.Mesh(wearColours(mergeGroups(build()), wseed += 7), this.mats);
      mesh.name = 'tools.vm.' + id;
      mesh.renderOrder = 9900;
      mesh.userData.noDepthPass = true;
      mesh.userData.noShadow = true;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.rotation.y = TOOL_YAW[id] || 0;
      this.toolPivot.add(mesh);
      this.tools[id] = mesh;
    }

    // the lit readout: its own UV'd plane on the scanner's near face
    if (this.screen) {
      const S = SCREEN_PLACE;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(S.w, S.h), this.mats[7]);
      scr.name = 'tools.vm.screen';
      scr.position.set(S.pos[0], S.pos[1], S.pos[2]);
      scr.rotation.y = S.rotY;
      scr.renderOrder = 9901;
      scr.userData.noDepthPass = true;
      scr.userData.noShadow = true;
      scr.castShadow = false; scr.receiveShadow = false;
      scr.frustumCulled = false;
      this.tools.scanner.add(scr);
      drawScreen(this.screen, 'READY TO', 'SCAN', -1);
    }

    // ---- muzzle glow (see GLOW_VERT). One draw, and only while the lamp is lit.
    this.glowU = mediumUniforms({
      uCentre: { value: new THREE.Vector3() }, uSize: { value: 0.075 },
      // Cooler than the lamp's own emitted white: this is light that has been
      // through a few centimetres of water on both legs, and a warm disc parked
      // on the near field is exactly what LOOK.md 2 rules out.
      uAmt: { value: 0 }, uTint: { value: new THREE.Color(1.10, 1.34, 1.30) },
    });
    const gm = new THREE.ShaderMaterial({
      uniforms: this.glowU, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      fog: false, toneMapped: false,
    });
    gm.name = 'tools.muzzleGlow';
    gm.userData.__uw = true;      // it includes UNDERWATER_PARS by hand
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm);
    this.glow.frustumCulled = false;
    this.glow.matrixAutoUpdate = false;
    this.glow.renderOrder = 9905;         // over the head, so it haloes it
    this.glow.userData.noDepthPass = true;
    this.glow.userData.noShadow = true;
    this.glow.visible = false;
    scene.add(this.glow);

    this.phase = 0;
    this.breathe = 0;
    this.swing = 0;         // 0..1 knife swing
    this.kick = 0;          // 0..1 impact recoil, decays fast
    this.draw = 1;          // 0 holstered, 1 out
    this.current = null;
    this._pq = new THREE.Quaternion();
    this._lag = new THREE.Vector3();    // extra positional trail behind the turn
    this._prevPos = new THREE.Vector3();
    this._prevFwd = new THREE.Vector3(0, 0, -1);
    this._yawRate = 0; this._pitchRate = 0;
    this._haveFrame = false;
  }

  /**
   * Park the glow at the muzzle and set its level. Called after the rig's world
   * matrices are current, so it tracks the sway rather than the rest pose.
   */
  setGlow(amt, size) {
    /*
     * The flare rides the same exposure envelope as everything else in view
     * space. It IS light, so it keeps most of its level in the dark — that is the
     * whole reason it exists — but it was measured at (218,251,214) on the 681 m
     * frame, i.e. clipping green, in a frame whose water reads (1,1,3). LOOK.md 9:
     * a deep fogged frame's 99.9th percentile lands at 152-168 and nothing clips.
     * The floor of 0.5 keeps the torch head unambiguously lit at any depth.
     *
     * ROUND 32: that envelope was uwDark, i.e. daylight again, and it left the
     * flare at 0.285 absolute in a 192 m cave whose water is 0.0084 — the single
     * brightest hard-edged object in that frame. It rides litAnchor() now, for
     * exactly the reason the collar under it does; see litAnchor's comment. The
     * flare is a halo around a lit collar, so if the two do not share one anchor
     * they separate at depth and the head grows a white core with a dim ring.
     */
    const a = amt * VM_GLOW * litAnchor();
    const on = a > 0.004 && !!this.current && this.root.visible;
    this.glow.visible = on;
    if (!on) { this.glowU.uAmt.value = 0; return; }
    this.muzzle(this.glowU.uCentre.value);
    this.glowU.uSize.value = size;
    this.glowU.uAmt.value = a;
  }

  /** Update the scanner's readout. Cheap: bails unless the string changed. */
  setReadout(a, b, p) { drawScreen(this.screen, a, b, p); }

  equip(id) {
    if (this.current === id) return;
    for (const k in this.tools) this.tools[k].visible = (k === id);
    this.current = this.tools[id] ? id : null;
    this.hand.visible = !!this.current;
    const at = HAND_AT[id];
    this.hand.position.set(at ? at.pos[0] : 0, at ? at.pos[1] : 0, at ? at.pos[2] : 0);
    this.hand.rotation.set(at ? at.rot[0] : 0, at ? at.rot[1] : 0, at ? at.rot[2] : 0);
    this.draw = 0;
  }

  /**
   * THE LIGHT ON THE PLAYER'S OWN HANDS, IN UNITS OF THE WATER AROUND THEM.
   *
   * Two sources, and they fall off at completely different rates, which is why
   * every single-term version of this has failed:
   *
   *   AMBIENT   the water itself. U.uFogColor is the radiance a long horizontal
   *             ray resolves to (core normalises uwInscatter to exactly that), so
   *             it is both the hue and the LEVEL of the light an immersed surface
   *             sees from every direction. Anchoring here is what makes the tool
   *             obey the medium instead of arguing with it, in every biome and at
   *             every depth, with no constants per frame.
   *   LAMP      the torch, 30 cm away, pointing away from the holder. What lands
   *             on the glove is light backscattered off the medium in front of the
   *             lens, so it is (a) small, (b) depth-independent, and (c) already
   *             filtered by ~1.7 m of round trip — which kills its red for free,
   *             hard in the Lost River (0.62/m) and gently in the shallows
   *             (0.18/m). No red-kill table; the biome's own absorption does it.
   *
   * The DIRECT sun is deliberately not here. That one three.js CAN deliver, and
   * core's uwDark already attenuates it correctly through the water column — so
   * in the shallows the diffuse term carries the tool and this fill is a minor
   * lift, while below 150 m the diffuse is gone and the fill is all there is.
   * That split is what stops a single fitted constant having to be right at 14 m
   * and at 681 m simultaneously, which it never was.
   */
  setFill(k0, lit) {
    const m = this.mats;
    const k = clamp01(k0);
    const dbg = this._fillScale ?? 1;

    // ---- the medium: level, hue, and how much daylight is left ---------------
    const f = U.uFogColor.value;
    const fogY = Math.max(0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b, 1e-6);
    const uwDark = mediumDark();
    this._uwDark = uwDark;          // setGlow rides the same exposure envelope

    /*
     * The ambient tint is the water's own chromaticity at unit luminance, so the
     * level constant below means what it says and the hue comes from biomes.js.
     * Clamped on postfx's own [0.45, 2.2] bounds: in the 193 m cave the raw fog
     * direction is (0, 0.79, 6.13) and an unclamped blue of six would turn the
     * glove into a blue lamp.
     */
    const at = [clamp(f.r / fogY, 0.45, 2.2), clamp(f.g / fogY, 0.45, 2.2),
      clamp(f.b / fogY, 0.45, 2.2)];

    /*
     * The lamp tint: a torch white through VM_SPILL metres of this water, both
     * legs, normalised to unit luminance. In the Grand Reef that is (0.46, 0.86,
     * 0.86) before normalisation — a 1.9:1 cyan bias straight out of the biome's
     * authored absorption, which is exactly the red-kill LOOK.md 2 asks for and
     * exactly the thing three rounds of hand-fitted RB/BB residuals were trying
     * to approximate.
     */
    const ab = U.uAbsorption.value;
    const lt = [Math.exp(-ab.x * VM_SPILL), Math.exp(-ab.y * VM_SPILL), Math.exp(-ab.z * VM_SPILL)];
    const lty = Math.max(0.2126 * lt[0] + 0.7152 * lt[1] + 0.0722 * lt[2], 1e-5);
    lt[0] /= lty; lt[1] /= lty; lt[2] /= lty;

    // ---- levels -------------------------------------------------------------
    const ambKey = fogY * VM_AMB * dbg;
    /*
     * The lamp spill does not fall with depth, but it does have to be THERE — a
     * torch pointing away still throws a wide low-angle wash off the medium in
     * front of it. The 0.35 floor is the unlit case: a hand at 681 m with the
     * torch off is entitled to be a silhouette (LOOK.md 26), and at 0 it was one.
     */
    const lampKey = (0.10 + 0.90 * k) * VM_LAMP * dbg;

    /*
     * ---- CANCEL POSTFX'S NEAR-ZONE GAIN, ON BOTH HALVES OF THE PIXEL ---------
     *
     * A near-field pixel is diffuse (three's real lights x albedo) PLUS the fill
     * above, and postfx's near gain multiplies the sum. Cancelling it on the fill
     * alone leaves the other half uncorrected — which is measurable and was
     * measured: with the fill running R/G 0.28 (deeply red-poor, exactly as
     * intended), the rendered sleeve still came back (2.3, 1.2, 0.5), i.e. RED
     * DOMINANT, because the +45% red the operator applies lands on the diffuse
     * half where nothing was pushing back.
     *
     * So pre-divide the ALBEDO by the same gain, once per frame. Diffuse is
     * linear in albedo, so an albedo scaled by 1/gain renders at exactly its
     * authored hue after the operator; and because the fill weights off the
     * AUTHORED colour (kept in userData.base) rather than off the live one, the
     * cancellation is applied exactly once to each half rather than twice to one.
     */
    const ng = postfxNearGain(_nearGain);
    const cr = 1 / ng[0], cg = 1 / ng[1], cb = 1 / ng[2];

    /*
     * ---- AND FILTER THE SUN THE DIFFUSE IS COMPUTED FROM --------------------
     *
     * three shades the view model with the real sky.js DirectionalLight and
     * HemisphereLight, which is right — and core's uwDark then attenuates the
     * result. But uwDark is a SCALAR (it reads sunT.b only), so the light three
     * used still has the full above-water spectrum in it: at 75 m the shell's
     * diffuse came back at R% 36 against open water at 5, purely because the sun
     * lighting a tool 75 m down was still white.
     *
     * The same albedo channel is the only handle on it, and folding the medium's
     * own downwelling transmittance into it is exact for a diffuse lobe:
     * albedo x (E0 x T) == (albedo x T) x E0. So this is not a fudge factor, it
     * is moving one commuting term to the side we can reach. At 20 m it lands
     * red at 0.38 of neutral, at 75 m at 0.013 — which is LOOK.md rule 1 applied
     * to the light rather than to the water, where it belongs.
     *
     * Clamped, because past ~200 m the normalisation of a channel that has gone
     * to 1e-30 is unbounded and would turn the tool into a two-channel cutout.
     */
    const depthM = Math.max(0, U.uWaterLevel.value - U.uCamPos.value.y);
    const dt0 = Math.exp(-ab.x * depthM * 0.42), dt1 = Math.exp(-ab.y * depthM * 0.42),
      dt2 = Math.exp(-ab.z * depthM * 0.42);
    const dty = Math.max(0.2126 * dt0 + 0.7152 * dt1 + 0.0722 * dt2, 1e-6);
    const dr = clamp(dt0 / dty, 0.10, 1.7), dg = clamp(dt1 / dty, 0.10, 1.7),
      db = clamp(dt2 / dty, 0.10, 1.7);

    /*
     * THE FILL IS ALBEDO-WEIGHTED, which is the difference between a bounce and a
     * coat of paint: light x albedo carries each surface's own hue for free, and
     * it is what a bounce physically is. An earlier round added the same
     * achromatic amount to every channel of every material and the orange
     * bracelet came out MAGENTA.
     *
     * `sat` mixes toward the material's own mean, because the light doing the
     * bouncing is cyan ambient rather than white and a fully albedo-proportional
     * fill oversaturates a painted shell. The two near-black materials run the
     * lowest sat and the highest weights: at 2-4% albedo they would otherwise be
     * holes cut in the frame, and a wetsuit sleeve reading pure 0 in the corner
     * is how the round-4 fill was first caught being wrong in the other
     * direction.
     */
    /*
     * `dMix` BLENDS THE DEPTH CHROMATICITY TOWARD NEUTRAL, PER MATERIAL.
     *
     * The division above is exact for the light, and at 20 m it lands the tool's
     * red at 0.38 of neutral. Measured against the plate, that is too strong for
     * the manufactured masses and it is the reason our hero tool has no hue of
     * its own. Windowing ONLY tool shell and ONLY open water in each frame —
     * ours `hud`, 23,721 masked shell pixels; seamoth-1.jpg's first-person
     * scanner, a clean unclipped window:
     *
     *                shell R/G   water R/G   separation
     *   plate           0.886       0.249       0.637
     *   ours            0.554       0.255       0.299
     *
     * The reference tool is a warm cream object sitting in a teal medium, and
     * that separation is a large part of what makes it read as a manufactured
     * thing rather than as more water. Ours carries 47% of it: the albedo is
     * fine (0xacb8b3 is R/G 0.935 before shading), the depth division is what
     * flattens it into the medium. This is also exactly the axis SYSTEMATIC keeps
     * asking for — distinct materials in distinct hue families — rather than one
     * more pass of level tuning.
     *
     * 0.30 on the shell and the steel only. The suit and the glove stay at full
     * correction: an arm is most of the lower-right corner of every frame, and
     * warming THAT is how this file previously shipped a forearm measuring R% 76
     * against water at 15. A 30 cm tool is not that, and 45 cm of water is not
     * 20 m of it.
     */
    const set = (i, sat, ambW, lampW, dMix = 1) => {
      const c = m[i].userData.base || (m[i].userData.base = m[i].color.clone());
      const mean = (1 - sat) * (c.r + c.g + c.b) / 3;
      const sr = ambKey * ambW * at[0] + lampKey * lampW * lt[0];
      const sg = ambKey * ambW * at[1] + lampKey * lampW * lt[1];
      const sb = ambKey * ambW * at[2] + lampKey * lampW * lt[2];
      const mr = 1 + (dr - 1) * dMix, mg = 1 + (dg - 1) * dMix, mb = 1 + (db - 1) * dMix;
      m[i].emissive.setRGB(
        (sat * c.r + mean) * sr * cr,
        (sat * c.g + mean) * sg * cg,
        (sat * c.b + mean) * sb * cb);
      m[i].color.setRGB(c.r * cr * mr, c.g * cg * mg, c.b * cb * mb);
    };
    //     material          sat   ambient  lamp   dMix
    set(M_SUIT, 0.30, 3.30, 4.30);         // neoprene sleeve — 2% albedo
    set(M_GLOVE, 0.40, 2.25, 2.95);        // dive glove — 4% albedo
    // Level, separately from hue: ours measures 1.24x its own water against the
    // plate's ~1.8x on matched shell-only / water-only windows. Not the 0.64x vs
    // 3.8x this was briefed as — see the report — so the gap being closed here is
    // about 1.45x, and only part of it is taken in one round because our water
    // sits at luminance 127 against the plate's 69 and the headroom to the rail
    // is correspondingly smaller.
    set(M_SHELL, 0.55, 1.12, 1.15, 0.30);  // the tool's main mass
    set(M_STEEL, 0.55, 1.10, 1.45, 0.30);  // metal catches more of a grazing spill
    set(M_DARK, 0.32, 2.90, 3.80);         // grip rubber, seams, bezels
    set(M_BAND, 0.70, 1.05, 1.05);         // the one warm accent, held down deliberately

    /*
     * THE LIT PANELS ARE THE ONE THING THAT MUST NOT FOLLOW THE DAYLIGHT.
     * A torch whose head is dark at night states the opposite of the truth. They
     * ride the LAMP — `lit` is the lamp's own eased power — so the head is
     * brightest precisely when the frame is darkest, which is when a player needs
     * to see it. This IS self-illuminated, so unlike the fill above it is
     * entitled to core's emissive exemption and keeps it.
     *
     * Trimmed against LOOK.md 9: in a deep fogged frame nothing clips at all, and
     * an earlier cut had these three collar rings measuring 224-246/255 at 681 m.
     */
    const expoAmb = 0.05 + 0.95 * Math.pow(clamp01(uwDark * clamp01(U.uSunIntensity.value * 0.42)), 1.4);
    const e = 0.30 + 0.70 * expoAmb;
    /*
     * ...but they must ride the MEDIUM, not the daylight, and that is what
     * changed in round 32. `e` above is built from uwDark and the sun, so it is
     * a proxy for how much DAYLIGHT is left — which is not the same quantity as
     * how bright the frame will be after postfx's exposure meter has finished
     * with it. In the 192 m cave the daylight proxy reads 0.06 while the meter is
     * running at 2.55 because the biolum is carrying the frame, and the product
     * is a light-pipe collar at 11.4x the water. litAnchor() is the lamp's own
     * medium anchor, and its comment carries the plate window that sets the
     * target. `e` is kept for the screen below, which is only ever framed in
     * daylight shots and measured correctly there.
     */
    const glow = VM_LIT * litAnchor() * (0.34 + 0.66 * clamp01(lit === undefined ? k : lit));
    // The same cancellation: a cyan trim light authored at R/G 0.22 was arriving
    // on screen at 0.32, which is the whole reason "cyan" HUD-language trim kept
    // photographing turquoise-white.
    m[M_LIT].emissive.setRGB(0.22 * glow * cr, 1.02 * glow * cg, 1.45 * glow * cb);
    // the readout carries its colour in its map, so the cancellation rides on the
    // emissive tint the map is multiplied by and only the LEVEL moves
    m[M_SCREEN].emissive.setRGB(cr, cg, cb);
    m[M_SCREEN].emissiveIntensity = 0.30 + 0.80 * e;
  }

  /**
   * How far from the eye the player's own view model reaches, in metres.
   *
   * The lamp is deferred and now reads the ENGINE's depth buffer, which the hand
   * and the tool write into like any other opaque geometry — so without a cut
   * the pool's 1/d^2 term lands on the glove at 45 cm and puts a flare on the
   * fist, which is the "glowing ball stuck to the hand" of two earlier rounds
   * rebuilt out of a different mistake. Measure it off the rig's own bounding
   * spheres rather than hard-coding a number: HOLD, the two pivot scales and the
   * length of the sleeve have all moved between rounds, and a literal here would
   * silently stop matching the model it is supposed to describe.
   *
   * Call after root.updateMatrixWorld(true).
   */
  nearCut(camera) {
    let d = 0;
    for (const mesh of [this.hand, this.current ? this.tools[this.current] : null]) {
      if (!mesh || !mesh.visible) continue;
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = g.boundingSphere;
      if (!s) continue;
      _vmC.copy(s.center).applyMatrix4(mesh.matrixWorld);
      // uniform scale down the whole rig, so one axis is the scale
      const k = _vmS.setFromMatrixScale(mesh.matrixWorld).x;
      d = Math.max(d, _vmC.distanceTo(camera.position) + s.radius * k);
    }
    // 4 cm of slack for the muzzle glow quad and for a frame of sway lag, and a
    // floor at the old constant so a holstered rig cannot switch the guard off.
    return Math.max(0.40, d + 0.04);
  }

  /** Muzzle in world space — where a scan beam or a lamp cone starts. */
  muzzle(out) {
    const t = this.current ? this.tools[this.current] : null;
    if (!t) return out.copy(this.root.position);
    const m = MUZZLE[this.current] || MUZZLE.default;
    out.set(m[0], m[1], m[2]).applyMatrix4(t.matrixWorld);
    return out;
  }

  update(dt, camera, speed, busy) {
    this.root.position.copy(camera.position);
    /*
     * Turn lag. 1-exp(-5.0*dt) is a ~200 ms constant: through a 51 deg/s pan the
     * rig trails the camera by ~10 deg, which moves the tool roughly 150 px on a
     * 1920-wide frame. Round one ran at 11 — a 90 ms constant — and a critic
     * measured 32.7 px of whip across that same pan and called the tool welded
     * to the glass. Weight in a first-person game is almost entirely this number.
     */
    this._pq.copy(camera.quaternion);
    this.root.quaternion.slerp(this._pq, 1 - Math.exp(-5.0 * dt));

    /*
     * COUNTER-SWAY ON TOP OF THE LAG. Orientation lag alone rotates the rig
     * about the eye, which moves a tool held 0.55 m out almost purely
     * horizontally; a real arm ALSO trails in translation and rolls into the
     * turn. Both terms are driven off the camera's angular rate, smoothed so a
     * single jittery mouse frame cannot snap the tool, and hard-clamped so a
     * whip-pan cannot fling it out of frame.
     */
    _vmF.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const yawNow = Math.atan2(_vmF.x, _vmF.z);
    const pitchNow = Math.asin(clamp(_vmF.y, -1, 1));
    if (this._haveFrame && dt > 1e-5) {
      let dy = yawNow - this._yaw;
      if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
      this._yawRate = approach(this._yawRate, dy / dt, 11, dt);
      this._pitchRate = approach(this._pitchRate, (pitchNow - this._pitch) / dt, 11, dt);
    }
    this._yaw = yawNow; this._pitch = pitchNow;
    /*
     * BOB THAT LAGS THE CAMERA. The eye's own translation, expressed in the
     * rig's frame and low-passed, so kicking off the bottom pushes the tool
     * down in frame for ~150 ms before it catches up. This is the term that
     * makes the tool feel attached to a body rather than to the lens.
     */
    if (this._haveFrame && dt > 1e-5) {
      _vmD.copy(camera.position).sub(this._prevPos).multiplyScalar(1 / dt);
      _vmD.applyQuaternion(_qInv.copy(camera.quaternion).invert());
    } else _vmD.set(0, 0, 0);
    this._prevPos.copy(camera.position);
    this._haveFrame = true;

    const tgtX = clamp(-this._yawRate * 0.052 - _vmD.x * 0.012, -0.060, 0.060);
    const tgtY = clamp(this._pitchRate * 0.040 - _vmD.y * 0.011, -0.048, 0.048);
    const tgtZ = clamp(-_vmD.z * 0.009, -0.030, 0.030);
    this._lag.x = approach(this._lag.x, tgtX, 8.5, dt);
    this._lag.y = approach(this._lag.y, tgtY, 8.5, dt);
    this._lag.z = approach(this._lag.z, tgtZ, 8.5, dt);

    // swim cycle + a slow breath, so the tool still moves when standing still
    this.phase += dt * (1.35 + speed * 0.55);
    this.breathe += dt * 0.62;
    const amp = 0.55 + clamp01(speed / 4) * 0.75;
    const s1 = Math.sin(this.phase), s2 = Math.sin(this.phase * 2);
    const b1 = Math.sin(this.breathe), b2 = Math.sin(this.breathe * 0.83 + 1.1);
    this.kick = Math.max(0, this.kick - dt * 5.2);
    const kk = this.kick * this.kick;
    this.pivot.position.set(
      s1 * 0.0235 * amp + b1 * 0.0068 + this._lag.x,
      -Math.abs(s2) * 0.0180 * amp - 0.002 + b2 * 0.0072 + this._lag.y - 0.014 * kk,
      s2 * 0.0080 * amp + this._lag.z + 0.030 * kk);
    this.pivot.rotation.set(
      s2 * 0.034 * amp + b1 * 0.012 + this._lag.y * 1.35 + 0.30 * kk,
      s1 * 0.052 * amp + this._lag.x * 0.55,
      -s1 * 0.058 * amp - this._lag.x * 1.25);

    this.draw = approach(this.draw, 1, 9, dt);
    this.swing = Math.max(0, this.swing - dt * 3.4);

    if (!this.current) return;
    const sw = this.swing;
    // ease-out arc: fast on the way down, slower on the recovery
    const arc = Math.sin(clamp01(1 - sw) * Math.PI) * (sw > 0 ? 1 : 0);
    const h = this.holder;
    h.position.set(HOLD[0] + 0.030 * arc, HOLD[1] - 0.150 * (1 - this.draw) - 0.055 * arc, HOLD[2] + 0.115 * arc);
    h.rotation.set(HOLD[3] - 1.05 * arc - 0.50 * (1 - this.draw), HOLD[4] + 0.34 * arc, HOLD[5] - 0.40 * arc);
    if (busy) h.rotation.x -= 0.09;
  }
}
const _qInv = new THREE.Quaternion();
/** Where each tool emits from, in its own local space. */
const MUZZLE = {
  scanner: [0, 0.078, -0.168], flashlight: [0, 0.052, -0.162],
  knife: [0, 0.300, 0.004], beacon: [0, 0.150, 0], seaglide: [0, 0.070, -0.200],
  water: [0, 0.130, 0], default: [0.04, 0.07, -0.18],
};

// ===========================================================================
// 9. IN-WORLD EFFECTS — the scan beam, the target bracket, breakage debris
// ===========================================================================
const BEAM_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uA, uB;
uniform float uWidth;
varying vec2 vBUv;
void main() {
  vBUv = uv;
  vec3 axis = uB - uA;
  float len = max(length(axis), 1e-4);
  vec3 dir = axis / len;
  vec3 mid = mix(uA, uB, uv.y);
  vec3 toCam = normalize(uCamPos - mid);
  vec3 side = cross(dir, toCam);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
  vec3 wp = mid + side * ((uv.x - 0.5) * uWidth * mix(1.0, 0.42, uv.y));
  vUwWorldPos = wp;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const BEAM_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uTint;
uniform float uAmt;
varying vec2 vBUv;
void main() {
  float edge = 1.0 - abs(vBUv.x - 0.5) * 2.0;
  float core = pow(clamp(edge, 0.0, 1.0), 2.2);
  // travelling rungs, so the beam reads as data rather than as a laser
  float rung = 0.55 + 0.45 * sin((vBUv.y * 34.0) - uTime * 13.0);
  float fade = smoothstep(0.0, 0.10, vBUv.y) * (1.0 - smoothstep(0.80, 1.0, vBUv.y) * 0.35);
  float dist = length(uCamPos - vUwWorldPos);
  vec3 c = uTint * (core * (0.30 + 0.42 * rung) * fade * uAmt);
  gl_FragColor = vec4(c * uwTransmittance(dist), 1.0);
}`;

const MARK_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uCentre;
uniform float uSize;
varying vec2 vMUv;
void main() {
  vMUv = uv * 2.0 - 1.0;
  vec3 f = normalize(uCamPos - uCentre);
  vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f));
  vec3 u = cross(f, r);
  vec3 wp = uCentre + (r * vMUv.x + u * vMUv.y) * uSize;
  vUwWorldPos = wp;
  vUwWorldNormal = f;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

/**
 * The bracket that sits on whatever is being scanned: a thin ring whose arc
 * fills with progress, four corner brackets that close in as it completes, and
 * a sweep line running down the subject.
 */
const MARK_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uTint;
uniform float uProgress;
uniform float uAmt;
uniform float uPulse;
varying vec2 vMUv;
void main() {
  vec2 p = vMUv;
  float r = length(p);
  float a = atan(p.y, p.x);
  float turns = fract((a / 6.2831853) + 0.25 + 1.0);

  // ring: a faint full circle plus a bright arc up to uProgress
  float ring = smoothstep(0.038, 0.004, abs(r - 0.60));
  float arc = ring * (turns <= uProgress ? 1.0 : 0.0);
  float track = ring * 0.16;
  // The leading end of the arc runs hot. A constant-brightness arc reads as a
  // static ring; the bright head is what says the number is still climbing.
  float head = smoothstep(0.055, 0.0, abs(turns - uProgress)) * ring * 1.9;

  // graduation ticks every 10%, so the arc is legible as a QUANTITY at a glance
  float tk = abs(fract(turns * 10.0) - 0.5);
  float tick = smoothstep(0.34, 0.5, tk)
             * smoothstep(0.10, 0.02, abs(r - 0.685)) * 0.55;

  // corner brackets, converging as the scan completes
  float k = mix(0.98, 0.70, uProgress);
  vec2 q = abs(p);
  float bx = smoothstep(0.028, 0.0, abs(q.x - k)) * step(q.y, k) * step(k - 0.34, q.y);
  float by = smoothstep(0.028, 0.0, abs(q.y - k)) * step(q.x, k) * step(k - 0.34, q.x);

  // sweep line travelling down the subject
  float sweep = smoothstep(0.05, 0.0, abs(p.y - (1.0 - fract(uTime * 0.55) * 2.0)))
              * step(r, 0.92) * 0.55;

  /*
   * THE COMPLETION PULSE. uPulse runs 1 -> 0 over ~0.7 s the instant the entry
   * lands: a bright ring accelerating outward past the bracket, plus a short
   * flash of the whole disc. Without it a scan simply stops, and the single
   * most repeatable verb in the game has no punctuation at all.
   */
  float pw = 1.0 - uPulse;
  float shock = smoothstep(0.13, 0.0, abs(r - (0.35 + pw * 1.05))) * uPulse * 2.6;
  float flash = smoothstep(1.0, 0.2, r) * uPulse * uPulse * 0.55;

  float m = arc * 1.7 + head + track + tick + (bx + by) * 1.25 + sweep + shock + flash;
  if (m < 0.004) discard;
  float dist = length(uCamPos - vUwWorldPos);
  gl_FragColor = vec4(uTint * (m * uAmt) * uwTransmittance(dist), 1.0);
}`;

/**
 * depthTest is OFF for the targeting overlay. A bracket drawn on the surface of
 * the thing it is bracketing loses its lower half into that surface, and the
 * beam z-fights where it lands; Subnautica's draws over the subject. Paired
 * with renderOrder 9700 it also sits after sky.js's night grade, so a scan
 * reads at the same brightness at midnight as at noon.
 */
function additive(uniforms, vs, fs, name) {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: vs, fragmentShader: fs,
    transparent: true, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    fog: false, toneMapped: false,
  });
  m.name = name;
  m.userData.__uw = true;   // it already includes UNDERWATER_PARS by hand
  return m;
}

class ScanFX {
  constructor(scene) {
    this.beamU = mediumUniforms({
      uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() },
      uWidth: { value: 0.024 }, uAmt: { value: 0 },
      uTint: { value: new THREE.Color(0.35, 1.7, 2.6) },
    });
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 12),
      additive(this.beamU, BEAM_VERT, BEAM_FRAG, 'tools.beam'));
    this.beam.frustumCulled = false;
    this.beam.matrixAutoUpdate = false;
    this.beam.renderOrder = 9700;
    this.beam.userData.noDepthPass = true;
    this.beam.userData.noShadow = true;
    this.beam.visible = false;

    this.markU = mediumUniforms({
      uCentre: { value: new THREE.Vector3() }, uSize: { value: 1 },
      uProgress: { value: 0 }, uAmt: { value: 0 }, uPulse: { value: 0 },
      uTint: { value: new THREE.Color(0.30, 1.55, 2.4) },
    });
    this.pulse = 0;
    this.pulseAt = new THREE.Vector3();
    this.pulseSize = 1;
    this.mark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      additive(this.markU, MARK_VERT, MARK_FRAG, 'tools.mark'));
    this.mark.frustumCulled = false;
    this.mark.matrixAutoUpdate = false;
    this.mark.renderOrder = 9710;
    this.mark.userData.noDepthPass = true;
    this.mark.userData.noShadow = true;
    this.mark.visible = false;

    scene.add(this.beam, this.mark);
  }
  show(from, to, size, progress, amt) {
    this.beamU.uA.value.copy(from);
    this.beamU.uB.value.copy(to);
    this.beamU.uAmt.value = amt;
    this.markU.uCentre.value.copy(to);
    this.markU.uSize.value = size;
    this.markU.uProgress.value = progress;
    this.markU.uAmt.value = amt;
    this.markU.uPulse.value = 0;
    this.beam.visible = amt > 0.01;
    this.mark.visible = amt > 0.01;
  }
  /** Fire the completion shockwave, which outlives the beam by ~0.7 s. */
  burst(at, size) {
    this.pulse = 1;
    this.pulseAt.copy(at);
    this.pulseSize = size;
  }
  /** Keep the pulse alive after show()/hide() have stopped being called. */
  tick(dt) {
    if (this.pulse <= 0) return false;
    this.pulse = Math.max(0, this.pulse - dt * 1.45);
    this.beam.visible = false;
    this.mark.visible = this.pulse > 0;
    this.markU.uCentre.value.copy(this.pulseAt);
    this.markU.uSize.value = this.pulseSize;
    this.markU.uProgress.value = 1;
    this.markU.uAmt.value = this.pulse;
    this.markU.uPulse.value = this.pulse;
    return true;
  }
  hide() { this.beam.visible = this.mark.visible = false; }
}

/** CPU particle burst for breaking rock and cutting plants. One draw. */
const DEBRIS_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform float uPixelScale;
attribute vec3 aCol;
attribute float aLife;
varying vec3 vCol;
varying float vLife;
void main() {
  vCol = aCol; vLife = aLife;
  vUwWorldPos = position;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPixelScale * (0.012 + 0.030 * aLife) / max(-mv.z, 0.2), 1.5, 22.0);
}`;
const DEBRIS_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
varying vec3 vCol;
varying float vLife;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = exp(-r2 * 8.0) * vLife;
  float dist = length(uCamPos - vUwWorldPos);
  gl_FragColor = vec4(vCol * (a * 2.2) * uwTransmittance(dist), 1.0);
}`;

class Debris {
  constructor(scene, count = 160) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.u = mediumUniforms({ uPixelScale: { value: 540 } });
    const m = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: DEBRIS_VERT, fragmentShader: DEBRIS_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: true, depthWrite: false, fog: false, toneMapped: false,
    });
    m.name = 'tools.debris';
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = 29;
    this.points.userData.noDepthPass = true;
    this.points.userData.noShadow = true;
    this.points.visible = false;
    scene.add(this.points);
    this.rng = makeRNG(0xDEB1);
    this.alive = 0;
  }
  burst(p, colour, n = 22, spread = 1.5) {
    for (let i = 0; i < n; i++) {
      const j = this.cursor; this.cursor = (this.cursor + 1) % this.n;
      const r = this.rng;
      this.pos[j * 3] = p.x + (r() - 0.5) * 0.2;
      this.pos[j * 3 + 1] = p.y + (r() - 0.5) * 0.2;
      this.pos[j * 3 + 2] = p.z + (r() - 0.5) * 0.2;
      this.vel[j * 3] = (r() - 0.5) * spread;
      this.vel[j * 3 + 1] = r() * spread * 0.8 + 0.15;
      this.vel[j * 3 + 2] = (r() - 0.5) * spread;
      this.col[j * 3] = colour.r; this.col[j * 3 + 1] = colour.g; this.col[j * 3 + 2] = colour.b;
      this.life[j] = 1;
    }
    this.points.visible = true;
  }
  update(dt) {
    if (!this.points.visible) return;
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      any++;
      this.life[i] = Math.max(0, this.life[i] - dt * 0.85);
      const k = Math.exp(-dt * 2.4);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - dt * 0.55;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aLife.needsUpdate = true;
    this.points.geometry.attributes.aCol.needsUpdate = true;
    if (!any) this.points.visible = false;
  }
}

// ===========================================================================
// 10. BEACONS
// ===========================================================================
function buildBeacon(mats) {
  const p = [];
  p.push(part(CYL(0.20, 0.30, 0.11, 16), 3, [0, 0.055, 0]));
  p.push(part(CYL(0.055, 0.075, 0.70, 12), 2, [0, 0.45, 0]));
  p.push(part(new THREE.TorusGeometry(0.10, 0.018, 8, 20), 3, [0, 0.80, 0], [Math.PI / 2, 0, 0]));
  p.push(part(superShape(0.11, 0.10, 0.11, 4.0, ICO2), 2, [0, 0.90, 0]));
  p.push(part(new THREE.SphereGeometry(0.075, 16, 10), 5, [0, 0.99, 0]));
  p.push(part(CYL(0.014, 0.014, 0.16, 8), 3, [0, 1.09, 0]));
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3;
    p.push(part(CYL(0.020, 0.030, 0.34, 8), 3,
      [Math.cos(a) * 0.16, 0.16, Math.sin(a) * 0.16], [Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55]));
  }
  // mats 0-4 are the view model's own, which declare vertexColors — so this
  // geometry needs the attribute too or the beacon renders as a black stick.
  const mesh = new THREE.Mesh(wearColours(mergeGroups(p), 29), mats);
  mesh.name = 'tools.beacon';
  return mesh;
}

// ===========================================================================
// 11. THE FABRICATOR
// ===========================================================================
const SPARK_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uOrigin;
uniform float uProgress;
uniform float uPixelScale;
attribute vec3 aSeed;
varying float vA;
void main() {
  float sp = fract(aSeed.x * 13.0);
  // each spark is on its own loop, so the column never pulses as one body
  float t = fract(uTime * (0.6 + sp * 0.9) + aSeed.y * 7.0);
  float rise = t * 0.46;
  float ang = aSeed.z * 6.2831853 + t * 5.4;
  float rad = (0.03 + 0.10 * (1.0 - t)) * (0.4 + sp);
  vec3 wp = uOrigin + vec3(cos(ang) * rad, rise, sin(ang) * rad);
  vA = uProgress * (1.0 - t) * (0.35 + 0.65 * sp);
  vUwWorldPos = wp;
  vUwWorldNormal = vec3(0.0, 1.0, 0.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPixelScale * 0.010 / max(-mv.z, 0.2), 1.5, 9.0);
}`;
const SPARK_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uTint;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25 || vA <= 0.002) discard;
  float dist = length(uCamPos - vUwWorldPos);
  gl_FragColor = vec4(uTint * (exp(-r2 * 9.0) * vA * 3.4) * uwTransmittance(dist), 1.0);
}`;

const HOLO_VERT = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
varying vec3 vHN;
varying vec3 vHP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vHP = wp.xyz;
  vHN = normalize(mat3(modelMatrix) * normal);
  vUwWorldPos = wp.xyz;
  vUwWorldNormal = vHN;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const HOLO_FRAG = /* glsl */ `
#include <common>
${UNDERWATER_PARS}
uniform vec3 uTint;
uniform float uAmt;
uniform float uBuild;
varying vec3 vHN;
varying vec3 vHP;
void main() {
  vec3 v = normalize(uCamPos - vHP);
  float fres = pow(1.0 - clamp(dot(v, vHN), 0.0, 1.0), 2.4);
  // the build front sweeps up the object and the solid part trails behind it
  float band = smoothstep(0.03, 0.0, abs(fract(vHP.y * 26.0 - uTime * 1.4) - 0.5) - 0.42);
  float front = smoothstep(0.06, -0.02, (vHP.y - uBuild));
  float m = (0.22 + fres * 1.5 + band * 0.9) * front;
  float dist = length(uCamPos - vHP);
  gl_FragColor = vec4(uTint * (m * uAmt) * uwTransmittance(dist), 1.0);
}`;

class Fabricator {
  constructor(scene, ctx) {
    const shell = new THREE.MeshStandardMaterial({ color: srgb(0xe6e6e0), roughness: 0.42, metalness: 0.06 });
    const orange = new THREE.MeshStandardMaterial({ color: srgb(0xd9691f), roughness: 0.48, metalness: 0.08 });
    const dark = new THREE.MeshStandardMaterial({ color: srgb(0x121a22), roughness: 0.35, metalness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: srgb(0xa6afb5), roughness: 0.36, metalness: 0.26 });
    const glow = new THREE.MeshStandardMaterial({
      color: srgb(0x0d2b42), roughness: 0.3, metalness: 0,
      emissive: new THREE.Color(0.18, 1.15, 1.75), emissiveIntensity: 1.0,
    });
    this.glow = glow;
    const mats = [shell, orange, dark, steel, glow];
    // A fabricator bolted to the outside of a lifepod has been in salt water for
    // as long as the pod has: more streaking than a hand tool, at the scale of a
    // 1.4 m cabinet rather than a 30 cm gadget. The lit panel opts out.
    const FAB_SURF = { grain: 0.075, wear: 0.38, streak: 0.34, scale: 0.75 };
    mats.forEach((m, i) => applyUnderwater(m, {
      caustics: 0.35, surface: i === 4 ? null : FAB_SURF,
    }));

    const p = [];
    p.push(part(superShape(0.44, 0.66, 0.20, 4.4, ICO3), 0, [0, 0.66, 0]));
    p.push(part(superShape(0.10, 0.50, 0.18, 4.0, ICO2), 1, [-0.40, 0.70, 0.01]));
    p.push(part(superShape(0.10, 0.50, 0.18, 4.0, ICO2), 1, [0.40, 0.70, 0.01]));
    p.push(part(superShape(0.30, 0.40, 0.03, 4.0, ICO2), 2, [0, 0.78, 0.19]));
    p.push(part(superShape(0.27, 0.36, 0.012, 4.0, ICO2), 4, [0, 0.78, 0.205]));
    // fold-out work tray
    p.push(part(superShape(0.36, 0.020, 0.16, 4.6, ICO2), 3, [0, 0.34, 0.20]));
    p.push(part(superShape(0.13, 0.010, 0.13, 4.6, ICO2), 4, [0, 0.355, 0.20]));
    p.push(part(superShape(0.24, 0.09, 0.10, 4.0, ICO2), 0, [0, 0.18, 0.14]));
    p.push(part(superShape(0.19, 0.045, 0.008, 4.0, ICO2), 2, [0, 0.18, 0.235]));
    // top vents and the status lamp
    p.push(part(superShape(0.30, 0.05, 0.16, 4.4, ICO2), 2, [0, 1.28, 0.02]));
    p.push(part(new THREE.SphereGeometry(0.030, 12, 8), 4, [0.20, 1.30, 0.15]));
    // wall mounting frame, so it is bolted to something rather than floating
    p.push(part(superShape(0.50, 0.72, 0.05, 4.6, ICO2), 3, [0, 0.68, -0.20]));

    this.mesh = new THREE.Mesh(mergeGroups(p), mats);
    this.mesh.name = 'tools.fabricator';
    this.group = new THREE.Group();
    this.group.name = 'tools.fabricatorRig';
    this.group.add(this.mesh);

    // ---- sparks
    const N = 150;
    const rng = makeRNG(0xFAB);
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = rng();
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.sparkU = mediumUniforms({
      uOrigin: { value: new THREE.Vector3() }, uProgress: { value: 0 },
      uPixelScale: { value: 540 }, uTint: { value: new THREE.Color(2.2, 0.5, 1.9) },
    });
    const sm = new THREE.ShaderMaterial({
      uniforms: this.sparkU, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: true, depthWrite: false, fog: false, toneMapped: false,
    });
    sm.name = 'tools.sparks';
    this.sparks = new THREE.Points(sg, sm);
    this.sparks.frustumCulled = false;
    this.sparks.matrixAutoUpdate = false;
    this.sparks.renderOrder = 28;
    this.sparks.userData.noDepthPass = true;
    this.sparks.userData.noShadow = true;
    this.sparks.visible = false;
    this.group.add(this.sparks);

    // ---- the thing being made
    this.holoU = mediumUniforms({
      uTint: { value: new THREE.Color(0.5, 1.9, 2.6) },
      uAmt: { value: 0 }, uBuild: { value: 0 },
    });
    const hm = new THREE.ShaderMaterial({
      uniforms: this.holoU, vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      fog: false, toneMapped: false,
    });
    hm.name = 'tools.holo';
    this.holo = new THREE.Mesh(superShape(0.055, 0.055, 0.055, 3.4, ICO2), hm);
    this.holo.renderOrder = 27;
    this.holo.userData.noDepthPass = true;
    this.holo.userData.noShadow = true;
    this.holo.visible = false;
    this.group.add(this.holo);

    scene.add(this.group);
    this.place(ctx);

    this.job = null;
    this.t = 0;
  }

  /** Bolt it to the outside of the lifepod if structures gave us one. */
  place(ctx) {
    const st = ctx.get('structures');
    const pod = (st && !st.stub) ? st.lifepod : null;
    if (pod?.position) {
      // Mount it on the shoreward flank — the side that faces the middle of the
      // crater, which is the side you swim in from and the side core's
      // surface-pod framing looks at.
      const dx = -pod.position.x, dz = -pod.position.z;
      const l = Math.max(Math.hypot(dx, dz), 1e-3);
      const yaw = Math.atan2(dx / l, dz / l);
      const r = (pod.radius || 2.6) + 0.05;
      this.group.position.set(
        pod.position.x + Math.sin(yaw) * r,
        pod.position.y - 0.55,
        pod.position.z + Math.cos(yaw) * r);
      this.group.rotation.y = yaw;
    } else {
      const terrain = ctx.get('terrain');
      const y = terrain?.heightAt ? terrain.heightAt(14, 22) : -26;
      this.group.position.set(14, (Number.isFinite(y) ? y : -26) + 0.1, 22);
    }
    this.anchor = this.group.position.clone();
    this.anchor.y += 0.9;
    this.trayWorld = new THREE.Vector3();
  }

  start(id, seconds) { this.job = { id, dur: seconds }; this.t = 0; }

  update(dt) {
    this.group.updateMatrixWorld();
    this.trayWorld.set(0, 0.40, 0.20).applyMatrix4(this.group.matrixWorld);
    this.sparkU.uOrigin.value.copy(this.trayWorld);
    let done = null;
    if (this.job) {
      this.t += dt;
      const k = clamp01(this.t / this.job.dur);
      this.sparks.visible = true;
      this.sparkU.uProgress.value = Math.sin(clamp01(k * 1.15) * Math.PI) * 1.15;
      this.holo.visible = true;
      this.holo.position.copy(this.trayWorld).add(_up18);
      this.holo.rotation.y += dt * 2.1;
      this.holo.rotation.x = 0.35;
      const s = 0.55 + 0.45 * smoothstep(0, 0.55, k);
      this.holo.scale.setScalar(s * (1 + 0.06 * Math.sin(U.uTime.value * 6)));
      this.holoU.uAmt.value = smoothstep(0, 0.10, k) * (1 - smoothstep(0.90, 1.0, k) * 0.4);
      this.holoU.uBuild.value = this.holo.position.y - 0.09 + 0.20 * k;
      this.glow.emissiveIntensity = 1 + 2.4 * Math.sin(k * Math.PI);
      if (k >= 1) { done = this.job.id; this.job = null; }
    } else {
      this.sparks.visible = false;
      this.holo.visible = false;
      this.glow.emissiveIntensity = approach(this.glow.emissiveIntensity, 1, 6, dt);
    }
    return done;
  }
}
const _up18 = new THREE.Vector3(0, 0.19, 0);

// ===========================================================================
// 12. INVENTORY
// ===========================================================================
class Inventory {
  constructor(slots = 30, capacity = 45) {
    this.slots = new Array(slots).fill(null);
    this.capacity = capacity;
  }
  get mass() {
    let m = 0;
    for (const s of this.slots) if (s) m += (ITEMS[s.id]?.mass ?? 0.5) * s.n;
    return m;
  }
  get used() { return this.slots.reduce((a, s) => a + (s ? 1 : 0), 0); }
  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.n;
    return n;
  }
  /** @returns {number} how many were actually taken */
  add(id, n = 1) {
    const def = ITEMS[id];
    if (!def) return 0;
    const stack = def.stack ?? 10;
    let left = n, took = 0;
    const room = Math.max(0, this.capacity - this.mass);
    const byMass = def.mass > 0 ? Math.floor(room / def.mass) : left;
    left = Math.min(left, byMass);
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.n < stack) {
        const d = Math.min(stack - s.n, left);
        s.n += d; left -= d; took += d;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue;
      const d = Math.min(stack, left);
      this.slots[i] = { id, n: d }; left -= d; took += d;
    }
    return took;
  }
  remove(id, n = 1) {
    let left = n;
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const d = Math.min(s.n, left);
      s.n -= d; left -= d;
      if (s.n <= 0) this.slots[i] = null;
    }
    return n - left;
  }
  has(need) {
    for (const k in need) if (this.count(k) < need[k]) return false;
    return true;
  }
}

// ===========================================================================
// 13. THE HUD — translucent cyan-blue holographic glass (LOOK.md section 10)
// ===========================================================================
const CSS = `
#cn-tl{position:fixed;inset:0;pointer-events:none;z-index:11;
  font-family:system-ui,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  color:#fff;-webkit-font-smoothing:antialiased;letter-spacing:.012em}
#cn-tl *{box-sizing:border-box}
.tl-glass{background:rgba(14,51,80,.66);border:2px solid #6fdfff;
  box-shadow:0 0 18px rgba(63,190,236,.30),inset 0 0 26px rgba(80,200,255,.10);
  backdrop-filter:blur(5px) saturate(1.1);-webkit-backdrop-filter:blur(5px) saturate(1.1)}

/* ---- reticle ---- */
.tl-ret{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:180px;height:180px;display:grid;place-items:center}
.tl-ret svg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);overflow:visible}
.tl-pct{position:absolute;left:50%;top:calc(50% - 62px);transform:translateX(-50%);
  font-size:15px;font-weight:600;letter-spacing:.06em;color:#dff6ff;opacity:0;
  text-shadow:0 0 10px rgba(90,210,255,.85),0 1px 3px rgba(0,10,20,.9)}
.tl-label{position:absolute;left:50%;top:calc(50% + 46px);transform:translateX(-50%);
  text-align:center;white-space:nowrap;text-shadow:0 1px 3px rgba(0,10,20,.85)}
.tl-label .n{font-size:15px;font-weight:500;letter-spacing:.05em}
.tl-label .s{font-size:11.5px;opacity:.72;letter-spacing:.09em;text-transform:uppercase;margin-top:2px}
.tl-key{display:inline-block;min-width:19px;padding:1px 5px;margin:0 3px;border-radius:5px;
  border:1px solid #8fe9ff;background:rgba(20,70,105,.72);font-size:10.5px;font-weight:600;
  color:#dff6ff;vertical-align:1px}

/* ---- quick bar ---- */
.tl-quick{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);display:flex;gap:13px}
.tl-slot{position:relative;width:52px;height:52px;border-radius:50%;
  background:rgba(9,32,52,.70);border:1.6px solid rgba(111,223,255,.75);
  display:grid;place-items:center;box-shadow:0 0 10px rgba(50,170,220,.22)}
.tl-slot.sel{border-color:#bff2ff;background:rgba(22,74,112,.80);
  box-shadow:0 0 16px rgba(120,225,255,.55),inset 0 0 12px rgba(120,225,255,.20);transform:translateY(-4px)}
.tl-slot .num{position:absolute;top:-3px;left:-3px;font-size:9.5px;opacity:.68}
.tl-slot .cnt{position:absolute;right:-1px;bottom:-1px;font-size:11px;font-weight:600;
  text-shadow:0 1px 2px #000}
.tl-slot .arc{position:absolute;inset:-4px}
.tl-empty{opacity:.34}

/* ---- notifications ---- */
.tl-notes{position:absolute;left:34px;top:44%;width:290px;display:flex;flex-direction:column;gap:8px}
.tl-note{border-radius:5px 16px 16px 5px;padding:8px 14px 9px 13px;
  border-left:3px solid #ffa22a;font-size:12.5px;line-height:1.36;
  background:rgba(14,51,80,.62);border-top:1px solid rgba(111,223,255,.45);
  border-right:1px solid rgba(111,223,255,.45);border-bottom:1px solid rgba(111,223,255,.45);
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  box-shadow:0 0 12px rgba(40,150,200,.20)}
.tl-note b{color:#ffc271;font-weight:600}

/* ---- databank card: the PDA page arriving on a completed scan ---- */
.tl-dbcard{display:none;position:absolute;left:calc(50% + 118px);top:50%;
  width:344px;padding:14px 18px 16px;border-radius:6px 22px 22px 6px;
  background:rgba(11,44,74,.80);border:1px solid rgba(143,233,255,.55);
  border-left:3px solid #8fe9ff;
  box-shadow:0 0 26px rgba(63,190,236,.34),inset 0 0 30px rgba(80,200,255,.10);
  backdrop-filter:blur(6px) saturate(1.1);-webkit-backdrop-filter:blur(6px) saturate(1.1);
  transform:translateY(-50%)}
.tl-dbcard .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.tl-dbcard .ic{display:flex}
.tl-dbcard .k{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:#8fe9ff}
.tl-dbcard .tt{font-size:22px;font-weight:400;letter-spacing:.005em;line-height:1.15}
.tl-dbcard .cc{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;
  color:#ffa22a;margin-top:3px}
.tl-dbcard .rl{height:1px;margin:9px 0 9px;
  background:linear-gradient(90deg,#6fdfff,rgba(111,223,255,0))}
.tl-dbcard .bd{font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.88);
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}

/* ---- resource chips, top right ---- */
.tl-chips{position:absolute;right:26px;top:96px;display:flex;flex-direction:column;
  align-items:flex-end;gap:9px}
.tl-chiprow{display:flex;align-items:center;gap:9px}
.tl-chipbox{display:flex;gap:9px;padding:7px 11px;border-radius:15px;
  background:rgba(10,38,60,.62);border:1px solid rgba(111,223,255,.55)}
.tl-chip{width:34px;text-align:center}
.tl-chip .q{font-size:11px;margin-top:1px;font-weight:600}
.tl-goal{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#bfeeff;
  opacity:.8;margin-right:4px;text-shadow:0 1px 3px rgba(0,10,20,.9)}
.tl-big{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;
  background:rgba(14,51,80,.72);border:1.6px solid #8fe9ff}

/* ---- world markers ---- */
.tl-mark{position:absolute;transform:translate(-50%,-50%);text-align:center;
  text-shadow:0 1px 3px rgba(0,8,16,.9);pointer-events:none}
.tl-mark .t{font-size:10.5px;letter-spacing:.1em;color:#bfeeff;opacity:.85}
.tl-mark .d{font-size:10px;color:#8fe9ff;opacity:.66}

/* ---- PDA ---- */
.tl-pda{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(1140px,68vw);height:min(760px,76vh);border-radius:30px;
  display:flex;flex-direction:column;padding:16px 22px 20px;pointer-events:auto;
  background:rgba(10,40,72,.74)}
.tl-pda:before{content:"";position:absolute;inset:9px;border-radius:22px;
  border:1px solid rgba(143,233,255,.30);pointer-events:none}
.tl-tabs{display:flex;gap:7px;justify-content:center;margin:2px 0 14px}
.tl-tab{width:74px;height:38px;border-radius:11px 11px 4px 4px;display:grid;place-items:center;
  background:rgba(9,32,52,.62);border:1px solid rgba(111,223,255,.45);cursor:pointer;
  position:relative;transition:none}
.tl-tab.on{background:rgba(31,116,178,.92);border-color:#bff2ff;
  box-shadow:0 0 14px rgba(110,220,255,.45)}
.tl-tab.on:after{content:"";position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);
  width:16px;height:2px;background:#bff2ff}
.tl-tab .badge{position:absolute;top:-6px;right:-5px;min-width:16px;height:16px;border-radius:8px;
  background:#ffa22a;color:#231000;font-size:10px;font-weight:700;display:grid;place-items:center}
.tl-body{flex:1;display:flex;gap:18px;min-height:0}
.tl-idx{width:290px;overflow:auto;display:flex;flex-direction:column;gap:4px;padding-right:4px}
.tl-idx::-webkit-scrollbar{width:5px}
.tl-idx::-webkit-scrollbar-thumb{background:rgba(143,233,255,.35);border-radius:3px}
.tl-grp{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8fe9ff;
  opacity:.8;margin:10px 0 3px 4px}
.tl-row{display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:5px;
  background:rgba(8,30,50,.55);border:1px solid rgba(111,223,255,.20);font-size:13px;cursor:pointer}
.tl-row .bul{width:7px;height:7px;border-radius:50%;background:#ffa22a;flex:0 0 auto}
.tl-row.on{background:#ffa22a;color:#1b0f00;border-color:#ffc271;font-weight:600}
.tl-row.on .bul{background:#1b0f00}
.tl-pane{flex:1;min-width:0;overflow:auto;padding-right:6px}
.tl-pane::-webkit-scrollbar{width:5px}
.tl-pane::-webkit-scrollbar-thumb{background:rgba(143,233,255,.35);border-radius:3px}
.tl-h{font-size:27px;font-weight:400;letter-spacing:.005em;margin:2px 0 4px}
.tl-sub{font-size:11px;letter-spacing:.17em;text-transform:uppercase;color:#8fe9ff;opacity:.85}
.tl-rule{height:1px;background:linear-gradient(90deg,#6fdfff,rgba(111,223,255,0));margin:11px 0 14px}
.tl-p{font-size:14.5px;line-height:1.62;color:rgba(255,255,255,.93);max-width:62ch}
.tl-grid{display:grid;grid-template-columns:repeat(6,60px);gap:9px}
.tl-cell{position:relative;width:60px;height:60px;border-radius:9px;
  background:rgba(8,30,50,.62);border:1px solid rgba(111,223,255,.32);display:grid;place-items:center}
.tl-cell.fill{border-color:rgba(143,233,255,.75);background:rgba(16,58,92,.7)}
.tl-cell .cnt{position:absolute;right:4px;bottom:2px;font-size:11px;font-weight:600;
  text-shadow:0 1px 2px #000}
.tl-meter{margin-top:14px;font-size:12px;color:#bfeeff;opacity:.9}
.tl-bar{height:5px;border-radius:3px;background:rgba(8,30,50,.7);margin-top:5px;overflow:hidden;
  border:1px solid rgba(111,223,255,.3)}
.tl-bar i{display:block;height:100%;background:#9be55a}
.tl-bar.hot i{background:#f0553c}
.tl-need{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.tl-need span{font-size:11.5px;padding:3px 8px;border-radius:9px;
  border:1px solid rgba(111,223,255,.4);background:rgba(8,30,50,.5)}
.tl-need span.no{border-color:#f0553c;color:#ff9f92}

/* ---- fabricator radial ---- */
.tl-craft{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  pointer-events:auto;display:flex;align-items:center;gap:16px}
.tl-cats{display:flex;flex-direction:column;gap:12px}
.tl-cbtn{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;cursor:pointer;
  background:rgba(9,32,52,.72);border:1.6px solid rgba(143,233,255,.7)}
.tl-cbtn.on{background:rgba(31,116,178,.92);border-color:#bff2ff;
  box-shadow:0 0 16px rgba(110,220,255,.5)}
.tl-items{display:grid;grid-template-columns:repeat(3,92px);gap:10px 6px}
.tl-icell{display:flex;flex-direction:column;align-items:center;gap:4px;width:92px}
.tl-iname{font-size:10px;line-height:1.15;text-align:center;color:#dff2ff;opacity:.88;
  letter-spacing:.03em;text-shadow:0 1px 3px rgba(0,10,20,.9);min-height:23px}
.tl-ineed{display:flex;gap:5px;justify-content:center}
.tl-ineed b{font-size:9.5px;font-weight:600;letter-spacing:.02em}
.tl-ibtn{position:relative;width:58px;height:58px;border-radius:50%;display:grid;place-items:center;
  cursor:pointer;background:rgba(9,32,52,.72);border:1.6px solid rgba(143,233,255,.55)}
.tl-ibtn.ok{border-color:#9be55a}
.tl-ibtn.no{border-color:rgba(240,85,60,.75);opacity:.62}
.tl-ibtn.on{box-shadow:0 0 18px rgba(120,225,255,.6);background:rgba(28,100,152,.9)}
.tl-tip{min-width:190px;padding:11px 14px;border-radius:5px 14px 14px 5px}
.tl-tip .n{font-size:15px;margin-bottom:2px}
.tl-tip .d{font-size:11.5px;opacity:.78;line-height:1.4}
.tl-hint{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);font-size:12px;
  color:#cfeeff;opacity:.85;text-shadow:0 1px 3px rgba(0,10,20,.9);white-space:nowrap}
`;

const PDA_TABS = [
  { id: 'inventory', g: 'weave', name: 'Inventory' },
  { id: 'databank', g: 'scanner', name: 'Databank' },
  { id: 'blueprints', g: 'knife', name: 'Blueprints' },
  { id: 'beacons', g: 'beacon', name: 'Beacons' },
];

class Hud {
  constructor(root, api) {
    this.api = api;
    this.el = document.createElement('div');
    this.el.id = 'cn-tl';
    const st = document.createElement('style');
    st.textContent = CSS;
    this.el.appendChild(st);
    this.el.insertAdjacentHTML('beforeend', `
      <div class="tl-ret">
        <svg width="220" height="220" viewBox="-110 -110 220 220">
          <circle r="13.5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".92"/>
          <circle r="1.7" fill="#fff"/>
          <circle class="arcbg" r="27" fill="none" stroke="#0e3350" stroke-width="5"
            opacity="0"/>
          <circle class="arcglow" r="27" fill="none" stroke="#6fdfff" stroke-width="9"
            stroke-linecap="round" transform="rotate(-90)" opacity="0"/>
          <circle class="arc" r="27" fill="none" stroke="#bff2ff" stroke-width="4.2"
            stroke-linecap="round" transform="rotate(-90)" opacity="0"/>
          <circle class="flash" r="27" fill="none" stroke="#fff" stroke-width="3" opacity="0"/>
          <path class="conn" d="M0 36 C0 44 6 46 14 46" fill="none" stroke="#6fdfff"
            stroke-width="1.2" opacity="0"/>
        </svg>
        <div class="tl-pct"></div>
      </div>
      <div class="tl-label"><div class="n"></div><div class="s"></div></div>
      <div class="tl-dbcard"></div>
      <div class="tl-quick"></div>
      <div class="tl-notes"></div>
      <div class="tl-chips"></div>
      <div class="tl-marks"></div>
      <div class="tl-hint"></div>
    `);
    root.appendChild(this.el);

    const q = (s) => this.el.querySelector(s);
    this.arc = q('.arc'); this.arcbg = q('.arcbg'); this.conn = q('.conn');
    this.arcGlow = q('.arcglow'); this.arcFlash = q('.flash'); this.pct = q('.tl-pct');
    this.dbcard = q('.tl-dbcard');
    this.labN = q('.tl-label .n'); this.labS = q('.tl-label .s');
    this.quick = q('.tl-quick'); this.notes = q('.tl-notes');
    this.chips = q('.tl-chips'); this.marks = q('.tl-marks');
    this.hint = q('.tl-hint');
    this.ARC = 2 * Math.PI * 27;
    this.arc.setAttribute('stroke-dasharray', this.ARC);
    this.arcGlow.setAttribute('stroke-dasharray', this.ARC);
    this._flash = 0; this._card = 0;
    this.pda = null; this.craft = null;
    this._noteList = [];
    this._quickCache = '';
    this._markPool = [];
  }

  /**
   * The scan arc. Round three drew this 3.2 px wide in #8fe9ff at 100% and a
   * critic reading the frame could not tell it from the reticle's own ring —
   * it looked like a second crosshair, not like 63% of a job done. It now
   * carries a dark track behind it, a wide soft glow under a crisp near-white
   * stroke, and the number itself, which is the loudest element on Subnautica's
   * HUD by LOOK.md 10's own account.
   */
  setScan(progress, name, sub) {
    const p = clamp01(progress);
    const on = p > 0.001;
    const o = on ? '1' : '0';
    if (this.arc.getAttribute('opacity') !== o) {
      this.arc.setAttribute('opacity', o);
      this.arcGlow.setAttribute('opacity', on ? '0.42' : '0');
      this.arcbg.setAttribute('opacity', on ? '0.72' : '0');
    }
    const off = (this.ARC * (1 - p)).toFixed(1);
    this.arc.setAttribute('stroke-dashoffset', off);
    this.arcGlow.setAttribute('stroke-dashoffset', off);
    const t = on ? Math.round(p * 100) + '%' : '';
    if (this.pct.textContent !== t) {
      this.pct.textContent = t;
      this.pct.style.opacity = on ? '1' : '0';
    }
    this.conn.setAttribute('opacity', name ? '0.55' : '0');
    if (this.labN.textContent !== (name || '')) this.labN.textContent = name || '';
    if (this.labS.innerHTML !== (sub || '')) this.labS.innerHTML = sub || '';
  }

  /**
   * The databank card. Subnautica's signature beat is not the arc filling, it
   * is the PDA page that arrives the moment it does — so the entry itself flies
   * in beside the reticle for four seconds. Same glass language as the PDA it
   * came from, so it reads as a page of that document rather than a toast.
   */
  entryCard(e) {
    const cat = (DB_CATS.find((c) => c.id === e.cat) || {}).name || 'Data';
    this.dbcard.innerHTML = `<div class="hd">
        <span class="ic">${svgIcon(e.cat === 'life' ? 'organic' : e.cat === 'geo' ? 'crystal' : 'scanner', '#8fe9ff', 20, 1.8)}</span>
        <span class="k">Databank updated</span></div>
      <div class="tt">${e.t}</div><div class="cc">${cat}</div>
      <div class="rl"></div><div class="bd">${e.x}</div>`;
    this.dbcard.style.display = 'block';
    this._card = 4.6;
  }
  tickCard(dt) {
    if (this._card <= 0) return;
    this._card -= dt;
    const a = this._card > 4.25 ? (4.6 - this._card) / 0.35 : Math.min(1, this._card / 0.7);
    this.dbcard.style.opacity = a.toFixed(3);
    this.dbcard.style.transform = `translateY(-50%) translateX(${((1 - a) * 26).toFixed(1)}px)`;
    if (this._card <= 0) this.dbcard.style.display = 'none';
  }

  /**
   * Anchor the name label under the SUBJECT rather than under the centre of the
   * screen. With the aim cone tightened the two are within ~120 px of each
   * other anyway, but binding them makes it structurally impossible for the
   * label and the bracket to name different creatures — which is what a critic
   * caught in two of three shots.
   */
  setLabelAt(x, y) {
    const lx = x === null ? '50%' : x.toFixed(0) + 'px';
    const ly = y === null ? 'calc(50% + 46px)' : y.toFixed(0) + 'px';
    const el = this.el.querySelector('.tl-label');
    if (el._lx !== lx) { el._lx = lx; el.style.left = lx; }
    if (el._ly !== ly) { el._ly = ly; el.style.top = ly; }
  }

  setHint(html) { if (this.hint.innerHTML !== html) this.hint.innerHTML = html; }

  note(html) {
    const d = document.createElement('div');
    d.className = 'tl-note';
    d.innerHTML = html;
    this.notes.appendChild(d);
    this._noteList.push({ el: d, t: 0 });
    while (this._noteList.length > 4) {
      const old = this._noteList.shift();
      old.el.remove();
    }
  }
  tickNotes(dt) {
    for (let i = this._noteList.length - 1; i >= 0; i--) {
      const n = this._noteList[i];
      n.t += dt;
      if (n.t > 6.5) { n.el.remove(); this._noteList.splice(i, 1); }
      else if (n.t > 5.5) n.el.style.opacity = String(1 - (n.t - 5.5));
    }
  }

  refreshQuick(bar, sel, charges) {
    const key = bar.join('|') + '#' + sel + '#' + bar.map((b) => Math.round((charges[b] ?? -1) * 4)).join(',');
    if (key === this._quickCache) return;
    this._quickCache = key;
    let h = '';
    for (let i = 0; i < 5; i++) {
      const id = bar[i];
      const ch = id ? charges[id] : undefined;
      let arc = '';
      if (ch !== undefined && ch >= 0) {
        const C = 2 * Math.PI * 27;
        const col = ch > 0.25 ? '#9be55a' : '#f0553c';
        arc = `<svg class="arc" width="60" height="60" viewBox="-30 -30 60 60">
          <circle r="27" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ch)}" transform="rotate(-90)"/></svg>`;
      }
      h += `<div class="tl-slot${i === sel ? ' sel' : ''}${id ? '' : ' tl-empty'}">
        <span class="num">${i + 1}</span>${arc}
        ${id ? svgIcon(id, null, 25, 1.6) : ''}
        ${id && ITEMS[id]?.stack > 1 ? '' : ''}</div>`;
    }
    this.quick.innerHTML = h;
  }

  /**
   * Missing-resource chips, top right, as in hud-1.jpg: a rounded pill of item
   * glyphs with have/need under each in red or green, paired with a larger
   * circular icon of the thing being built. hud-1.jpg shows this pill with the
   * player standing idle on a platform — it is not a craft-menu widget, it
   * tracks whatever you are working toward, so it is on in every frame.
   */
  setChips(recipe, inv, title) {
    if (!recipe) { if (this.chips.childNodes.length) this.chips.innerHTML = ''; return; }
    let h = `<div class="tl-goal">${title || itemName(recipe.id)}</div>
      <div class="tl-chiprow"><div class="tl-chipbox">`;
    for (const k in recipe.need) {
      const have = inv.count(k), want = recipe.need[k];
      const col = have >= want ? '#9be55a' : '#f0553c';
      h += `<div class="tl-chip">${svgIcon(k, null, 24, 1.6)}
        <div class="q" style="color:${col}">${have}/${want}</div></div>`;
    }
    h += `</div><div class="tl-big">${svgIcon(recipe.id, null, 26, 1.6)}</div></div>`;
    if (this.chips.innerHTML !== h) this.chips.innerHTML = h;
  }

  updateMarkers(list, camera, w, h) {
    while (this._markPool.length < list.length) {
      const d = document.createElement('div');
      d.className = 'tl-mark';
      d.innerHTML = `<div class="g"></div><div class="t"></div><div class="d"></div>`;
      this.marks.appendChild(d);
      this._markPool.push(d);
    }
    for (let i = 0; i < this._markPool.length; i++) {
      const el = this._markPool[i];
      const m = list[i];
      if (!m) { el.style.display = 'none'; continue; }
      if (el._g !== m.glyph) {
        el._g = m.glyph;
        el.children[0].innerHTML = svgIcon(m.glyph, '#8fe9ff', 15, 1.7);
      }
      _mv.copy(m.pos).project(camera);
      const behind = _mv.z > 1;
      let x = (_mv.x * 0.5 + 0.5) * w, y = (-_mv.y * 0.5 + 0.5) * h;
      let chev = '';
      if (behind || x < 24 || x > w - 24 || y < 24 || y > h - 24) {
        // clamp to the frame edge with a chevron, per LOOK.md's off-screen rule
        if (behind) { x = w - x; y = h - y; }
        // the bottom 120 px belongs to the quick bar and the hint line
        x = clamp(x, 34, w - 34); y = clamp(y, 34, h - 120);
        chev = '▸';
      }
      // never park a marker on the reticle or under the quick bar
      if (y > h - 120 && Math.abs(x - w * 0.5) < w * 0.22) y = h - 120;
      el.style.display = '';
      el.style.left = x.toFixed(0) + 'px';
      el.style.top = y.toFixed(0) + 'px';
      el.children[1].textContent = m.name + (chev ? ' ' + chev : '');
      el.children[2].textContent = m.dist.toFixed(0) + ' m';
      el.style.opacity = String(clamp(1 - m.dist / 900, 0.35, 0.95));
    }
  }
}
const _mv = new THREE.Vector3();

// ===========================================================================
// 14. PDA + FABRICATOR PANELS
// ===========================================================================
function pdaOpen(api, tab) {
  const hud = api.hud;
  if (!hud) return;
  if (!hud.pda) {
    const d = document.createElement('div');
    d.className = 'tl-pda tl-glass';
    hud.el.appendChild(d);
    hud.pda = d;
    d.addEventListener('mousedown', (e) => {
      const tabEl = e.target.closest('.tl-tab');
      if (tabEl) { api.pdaTab = tabEl.dataset.k; pdaRender(api); return; }
      const row = e.target.closest('.tl-row');
      if (row) { api.pdaSel[api.pdaTab] = row.dataset.k; pdaRender(api); }
    });
  }
  if (tab) api.pdaTab = tab;
  hud.pda.style.display = '';
  api.pdaShown = true;
  document.exitPointerLock?.();
  pdaRender(api);
}
function pdaClose(api) {
  if (api.hud?.pda) api.hud.pda.style.display = 'none';
  api.pdaShown = false;
}

function pdaRender(api) {
  const hud = api.hud;
  if (!hud?.pda) return;
  const tab = api.pdaTab;
  let tabs = '';
  for (const t of PDA_TABS) {
    const badge = t.id === 'databank' && api.unread > 0
      ? `<span class="badge">${api.unread}</span>` : '';
    tabs += `<div class="tl-tab${t.id === tab ? ' on' : ''}" data-k="${t.id}">
      ${svgIcon(t.g, t.id === tab ? '#ffffff' : '#8fe9ff', 22, 1.7)}${badge}</div>`;
  }
  let idx = '', pane = '';

  if (tab === 'inventory') {
    const inv = api.inventory;
    let cells = '';
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      cells += `<div class="tl-cell${s ? ' fill' : ''}">${s ? svgIcon(s.id, null, 30, 1.6) : ''}
        ${s && s.n > 1 ? `<span class="cnt">${s.n}</span>` : ''}</div>`;
    }
    const m = inv.mass, cap = inv.capacity;
    const groups = {};
    for (const s of inv.slots) if (s) groups[ITEMS[s.id]?.cat || 'raw'] = true;
    idx = `<div class="tl-grp">Carried</div>`;
    const names = { raw: 'Raw Material', organic: 'Organic', made: 'Fabricated', gear: 'Equipment', tool: 'Tools', food: 'Sustenance' };
    for (const k in groups) {
      const list = inv.slots.filter((s) => s && (ITEMS[s.id]?.cat || 'raw') === k);
      idx += `<div class="tl-row" data-k="${k}"><span class="bul"></span>${names[k] || k}
        <span style="margin-left:auto;opacity:.7">${list.length}</span></div>`;
    }
    pane = `<div class="tl-sub">Personal Storage</div><div class="tl-h">Inventory</div>
      <div class="tl-rule"></div><div class="tl-grid">${cells}</div>
      <div class="tl-meter">Mass ${m.toFixed(1)} / ${cap.toFixed(0)} kg &nbsp;·&nbsp;
        Slots ${inv.used} / ${inv.slots.length}
        <div class="tl-bar${m > cap * 0.9 ? ' hot' : ''}"><i style="width:${clamp01(m / cap) * 100}%"></i></div></div>
      ${api.equipList()}`;

  } else if (tab === 'databank') {
    const sel = api.pdaSel.databank;
    let first = null;
    for (const g of DB_CATS) {
      const rows = api.entriesIn(g.id);
      if (!rows.length) continue;
      idx += `<div class="tl-grp">${g.name}</div>`;
      for (const e of rows) {
        if (!first) first = e.id;
        idx += `<div class="tl-row${e.id === sel ? ' on' : ''}" data-k="${e.id}">
          ${api.unreadSet.has(e.id) ? '<span class="bul"></span>' : ''}${e.t}</div>`;
      }
    }
    const e = api.entry(sel) || api.entry(first);
    if (e) {
      api.unreadSet.delete(e.id);
      api.unread = api.unreadSet.size;
      pane = `<div class="tl-sub">${(DB_CATS.find((c) => c.id === e.cat) || {}).name || 'Databank'}</div>
        <div class="tl-h">${e.t}</div><div class="tl-rule"></div><div class="tl-p">${e.x}</div>
        ${e.bp ? `<div class="tl-need"><span>Blueprint acquired: ${itemName(e.bp)}</span></div>` : ''}`;
    } else {
      pane = `<div class="tl-sub">Databank</div><div class="tl-h">No entries</div>
        <div class="tl-rule"></div><div class="tl-p">Nothing has been scanned yet. Equip the
        scanner, put the reticle on a lifeform, a mineral deposit or a structure and hold
        the scan trigger until the arc closes.</div>`;
    }

  } else if (tab === 'blueprints') {
    const sel = api.pdaSel.blueprints;
    const seen = new Set();
    let first = null;
    for (const c of CRAFT_CATS) {
      const rows = RECIPES.filter((r) => r.cat === c.id && api.known(r) && !seen.has(r.id + r.cat));
      if (!rows.length) continue;
      idx += `<div class="tl-grp">${c.name}</div>`;
      for (const r of rows) {
        seen.add(r.id + r.cat);
        if (!first) first = r.id;
        idx += `<div class="tl-row${r.id === sel ? ' on' : ''}" data-k="${r.id}">${itemName(r.id)}</div>`;
      }
    }
    const r = RECIPES.find((x) => x.id === (sel || first) && api.known(x));
    if (r) {
      const it = ITEMS[r.id];
      let need = '';
      for (const k in r.need) {
        const ok = api.inventory.count(k) >= r.need[k];
        need += `<span class="${ok ? '' : 'no'}">${itemName(k)} ${api.inventory.count(k)}/${r.need[k]}</span>`;
      }
      pane = `<div class="tl-sub">Fabricator Schematic</div><div class="tl-h">${itemName(r.id)}</div>
        <div class="tl-rule"></div>
        <div class="tl-p">${DATABANK[r.id]?.x || it?.note || 'Standard Alterra fabricator pattern.'}</div>
        <div class="tl-need">${need}</div>
        <div class="tl-meter">Fabrication time ${r.time.toFixed(1)} s${r.out > 1 ? ` · yields ${r.out}` : ''}</div>`;
    } else {
      pane = `<div class="tl-sub">Blueprints</div><div class="tl-h">Nothing yet</div>
        <div class="tl-rule"></div><div class="tl-p">Scan wreckage and structures to acquire
        fabricator schematics.</div>`;
    }

  } else {
    const sel = api.pdaSel.beacons;
    idx = '<div class="tl-grp">Placed</div>';
    if (!api.beacons.length) idx += '<div class="tl-row" data-k="none">No beacons deployed</div>';
    for (const b of api.beacons) {
      idx += `<div class="tl-row${b.id === sel ? ' on' : ''}" data-k="${b.id}">
        <span class="bul"></span>${b.name}<span style="margin-left:auto;opacity:.7">
        ${b.pos.distanceTo(api.playerPos).toFixed(0)} m</span></div>`;
    }
    pane = `<div class="tl-sub">Navigation</div><div class="tl-h">Beacons</div><div class="tl-rule"></div>
      <div class="tl-p">A deployed beacon transmits a position marker to the HUD from any range.
      ${api.beacons.length} of ${api.maxBeacons} deployed. Carrying
      ${api.inventory.count('beacon')}.</div>
      <div class="tl-need"><span>Deploy &mdash; B</span><span>Fabricate from Tools</span></div>`;
  }

  hud.pda.innerHTML = `<div class="tl-tabs">${tabs}</div>
    <div class="tl-body"><div class="tl-idx">${idx}</div><div class="tl-pane">${pane}</div></div>`;
}

function craftOpen(api) {
  const hud = api.hud;
  if (!hud) return;
  if (!hud.craft) {
    const d = document.createElement('div');
    d.className = 'tl-craft';
    hud.el.appendChild(d);
    hud.craft = d;
    d.addEventListener('mousedown', (e) => {
      const c = e.target.closest('.tl-cbtn');
      if (c) { api.craftCat = c.dataset.k; api.craftSel = null; craftRender(api); return; }
      const i = e.target.closest('.tl-ibtn');
      if (i) {
        if (api.craftSel === i.dataset.k) api.craft(i.dataset.k);
        else api.craftSel = i.dataset.k;
        craftRender(api);
      }
    });
    d.addEventListener('mousemove', (e) => {
      const i = e.target.closest('.tl-ibtn');
      if (i && api.craftHover !== i.dataset.k) { api.craftHover = i.dataset.k; craftRender(api); }
    });
  }
  hud.craft.style.display = '';
  api.craftShown = true;
  document.exitPointerLock?.();
  craftRender(api);
}
function craftClose(api) {
  if (api.hud?.craft) api.hud.craft.style.display = 'none';
  api.craftShown = false;
  api.hud?.setChips(null, api.inventory);
}

function craftRender(api) {
  const hud = api.hud;
  if (!hud?.craft) return;
  let cats = '';
  for (const c of CRAFT_CATS) {
    cats += `<div class="tl-cbtn${c.id === api.craftCat ? ' on' : ''}" data-k="${c.id}"
      title="${c.name}">${svgIcon(c.glyph, c.id === api.craftCat ? '#ffffff' : '#8fe9ff', 25, 1.7)}</div>`;
  }
  const rows = RECIPES.filter((r) => r.cat === api.craftCat && api.known(r));
  let items = '';
  const seen = new Set();
  // A grid of seven unlabelled circles is not a menu. Every cell carries its
  // output name and its own have/need chips, so the radial is readable without
  // hovering — LOOK.md 10's resource-chip language, per item.
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    // show the recipe the player can actually afford when there are two
    const best = rows.filter((x) => x.id === r.id).sort((a, b) =>
      (api.inventory.has(b.need) ? 1 : 0) - (api.inventory.has(a.need) ? 1 : 0))[0];
    seen.add(r.id);
    const ok = api.inventory.has(best.need);
    let need = '';
    for (const k in best.need) {
      const have = api.inventory.count(k), want = best.need[k];
      need += `<b style="color:${have >= want ? '#9be55a' : '#f0553c'}">${have}/${want}</b>`;
    }
    items += `<div class="tl-icell"><div class="tl-ibtn ${ok ? 'ok' : 'no'}${api.craftSel === r.id ? ' on' : ''}"
      data-k="${r.id}">${svgIcon(r.id, null, 27, 1.6)}</div>
      <div class="tl-iname">${itemName(r.id)}</div>
      <div class="tl-ineed">${need}</div></div>`;
  }
  const showId = api.craftSel || api.craftHover;
  const rec = api.recipeFor(showId);
  let tip = '';
  if (rec) {
    let need = '';
    for (const k in rec.need) {
      const ok = api.inventory.count(k) >= rec.need[k];
      need += `<span class="${ok ? '' : 'no'}">${itemName(k)} ${api.inventory.count(k)}/${rec.need[k]}</span>`;
    }
    tip = `<div class="tl-tip tl-glass"><div class="n">${itemName(rec.id)}</div>
      <div class="d">${ITEMS[rec.id]?.note || DATABANK[rec.id]?.x?.slice(0, 90) || 'Fabricator pattern.'}</div>
      <div class="tl-need">${need}</div>
      <div class="d" style="margin-top:7px">
        ${api.craftSel === rec.id ? 'Click again to fabricate' : 'Click to select'}</div></div>`;
    hud.setChips(rec, api.inventory, 'Fabricating');
  } else {
    api.refreshGoalChips();
  }
  hud.craft.innerHTML = `<div class="tl-cats">${cats}</div>
    <div class="tl-items">${items}</div>${tip}`;
}

// ===========================================================================
// 15. THE MODULE
// ===========================================================================
/*
 * The fifth slot is deliberately NOT the seaglide. vehicles.js owns that: it
 * builds the first-person seaglide with its holographic terrain map, drives its
 * speed and power, and has a published handshake for whoever is presenting it.
 * Two seaglides in one frame is a bug the player sees, so this module carries
 * the four hand tools and a consumable, and vehicles keeps the glide.
 */
const QUICK_ORDER = ['knife', 'flashlight', 'scanner', 'beacon', 'water'];
const SCAN_TIME = { node: 2.2, creature: 3.2, landmark: 4.0 };
const DRAIN = { flashlight: 0.30, scanner: 1.5, seaglide: 0.55 };
/** Half-angle tangent of the aim cone: 0.075 rad ~= 4.3 deg ~= 120 px at 1080p. */
const AIM_TAN = 0.075;
/** What the player is most likely working toward, for the top-right chips. */
const GOAL_ORDER = ['tank', 'fins', 'flashlight', 'scanner', 'knife', 'beacon',
  'medkit', 'water', 'battery', 'rebreather', 'cargo_webbing', 'seaglide'];

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _prevCam = new THREE.Vector3();
const _toolFwd = new THREE.Vector3();
const _spark = new THREE.Color();
const _up2 = new THREE.Vector3(0, 2, 0);

const api = {
  id: 'tools',
  order: 120,

  // ---- state ---------------------------------------------------------------
  inventory: new Inventory(30, 45),
  bar: [null, null, null, null, null],
  sel: 1,
  charge: { flashlight: 100, scanner: 100, seaglide: 100 },
  scannedSet: new Set(),
  unreadSet: new Set(),
  unread: 0,
  blueprints: new Set(),
  beacons: [],
  maxBeacons: 6,
  playerPos: new THREE.Vector3(),
  equipment: { oxygenBonus: 0, swimSpeedMul: 1, carryBonus: 0, lightOn: false, rebreather: false },
  pdaTab: 'databank',
  pdaSel: { inventory: 'raw', databank: null, blueprints: null, beacons: null },
  pdaShown: false, craftShown: false,
  craftCat: 'materials', craftSel: null, craftHover: null,
  lightOn: true,

  // ---- published helpers ---------------------------------------------------
  /**
   * The tool currently in hand, as an id. vehicles.js polls exactly this to
   * decide whether it should present the seaglide view model; movement.js and
   * survival.js can read `equipment` for the gear bonuses.
   */
  get equipped() { return this.bar[this.sel] || null; },
  has(id, n = 1) { return this.inventory.count(id) >= n; },
  add(id, n = 1) { return this.give(id, n); },
  remove(id, n = 1) { return this.inventory.remove(id, n); },
  databank() { return [...this.scannedSet].map((id) => this.entry(id)); },
  entry(id) { return id ? this._entries.get(id) || null : null; },
  entriesIn(cat) {
    const out = [];
    for (const e of this._entries.values()) if (e.cat === cat) out.push(e);
    return out.sort((a, b) => a.t.localeCompare(b.t));
  },
  known(r) { return !r.bp || this.blueprints.has(r.bp); },
  recipeFor(id) {
    const all = RECIPES.filter((r) => r.id === id && this.known(r));
    if (!all.length) return null;
    return all.find((r) => this.inventory.has(r.need)) || all[0];
  },
  equipList() {
    const worn = ['tank', 'fins', 'cargo_webbing', 'rebreather'].filter((k) => this.inventory.count(k) > 0);
    if (!worn.length) return '';
    return `<div class="tl-meter">Equipped: ${worn.map((k) =>
      `${itemName(k)} <span style="opacity:.65">(${ITEMS[k].note})</span>`).join(' &nbsp;·&nbsp; ')}</div>`;
  },

  // ---- inventory plumbing --------------------------------------------------
  give(id, n = 1, quiet) {
    const took = this.inventory.add(id, n);
    if (took < n && !quiet) this.notify(`<b>Inventory full</b> — dropped ${n - took} ${itemName(id)}`);
    if (took > 0) {
      this._invDirty = true;
      this._goalDirty = true;
      if (!quiet) this.notify(`${itemName(id)} <b>x${took}</b>`);
    }
    return took;
  },

  /**
   * ui.js owns the toast channel, the PDA and the item/recipe tables; this
   * module owns the reticle, the quick slots, the context hint and the world
   * markers, because ui.js stands its versions of those down the moment it sees
   * #cn-tl in the DOM (see its _detectPeerHud). One toast stack, one PDA.
   */
  notify(html, kind) {
    const ui = this.uiApi;
    if (ui) {
      try { ui.notify(html.replace(/<[^>]+>/g, ''), kind || 'info'); return; } catch { /* fall through */ }
    }
    this.hud?.note(html);
  },

  /** ui's glyph vocabulary is its own; map ours onto it once. */
  _uiGlyph(id) {
    const M = {
      rock: 'ore', ore: 'ore', crystal: 'crys', cube: 'salt', ingot: 'metal', scrap: 'metal',
      organic: 'leaf', flask: 'drop', pane: 'crys', blob: 'seed', coil: 'bolt', weave: 'leaf',
      battery: 'batt', tank: 'pod', fins: 'glide', knife: 'knife', torch: 'torch',
      scanner: 'scan', beacon: 'pin', glide: 'glide', block: 'ore', medkit: 'heart',
    };
    return M[ITEMS[id]?.g] || 'ore';
  },

  /** Hand ui.js the tables it needs to render our economy in its PDA. */
  _bindUi(ui) {
    this.uiApi = ui;
    const items = {};
    for (const k in ITEMS) items[k] = { name: ITEMS[k].name, glyph: this._uiGlyph(k) };
    try { ui.defineItems(items); } catch { /* optional surface */ }
    const cats = Object.fromEntries(CRAFT_CATS.map((c) => [c.id, c.name]));
    const seen = new Set();
    const list = [];
    for (const c of CRAFT_CATS) {
      for (const r of RECIPES) {
        if (r.cat !== c.id || seen.has(r.id) || !this.known(r)) continue;
        seen.add(r.id);
        list.push({ id: r.id, out: itemName(r.id), need: { ...r.need }, cat: cats[r.cat] });
      }
    }
    this._uiRecipes = list;
    try { ui.setRecipes(list); } catch { /* optional surface */ }
    this._pushInv(true);
    for (const id of this.scannedSet) this._pushDatabank(this.entry(id));
  },

  _pushDatabank(e) {
    if (!e || !this.uiApi) return;
    const g = e.cat === 'life' ? (DATABANK[e.id]?.cat === 'life' && ITEMS[e.id] ? 'leaf' : 'fish')
      : e.cat === 'geo' ? 'crys'
        : e.id === 'wreck' ? 'wreck' : e.id === 'cave' ? 'cave' : e.id === 'arch' ? 'arch' : 'pod';
    try { this.uiApi.addDatabank({ t: e.t, b: e.x, g }); } catch { /* optional */ }
  },

  /**
   * Mirror our inventory into ui.js, and honour its PDA's own FABRICATE button:
   * that button decrements ui's private copy, so a copy that drops below what we
   * pushed is a craft request. Match the delta against a recipe and run it for
   * real rather than letting the two tallies drift apart.
   */
  _pushInv(force) {
    const ui = this.uiApi;
    if (!ui) return;
    const map = {};
    for (const s of this.inventory.slots) if (s) map[s.id] = (map[s.id] || 0) + s.n;
    if (!force && ui.inventory) {
      const delta = {};
      let any = false;
      for (const k in this._uiInv) {
        const now = ui.inventory[k] ?? 0;
        if (now < this._uiInv[k]) { delta[k] = this._uiInv[k] - now; any = true; }
      }
      if (any) {
        const hit = this._uiRecipes?.find((r) =>
          Object.keys(r.need).length === Object.keys(delta).length
          && Object.keys(r.need).every((k) => r.need[k] === delta[k]));
        if (hit) this.craft(hit.id);
      }
    }
    this._uiInv = map;
    try { ui.setInventory(map); } catch { /* optional */ }
  },

  // ---- scanning ------------------------------------------------------------
  /**
   * Cylinder test rather than a raycast. Raycasting a few hundred instanced
   * nodes with 320 triangles each is 60k+ triangle tests a frame in JS, and a
   * scanner that demands pixel-exact aim is not the interaction this game has.
   * Perpendicular distance to the view ray, tolerance scaled by the subject's
   * own radius, is both cheaper and kinder.
   */
  acquire(camera) {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const cam = camera.position;
    let best = null, bestScore = 1e9;
    /*
     * The tolerance is ANGULAR, not a fixed metric radius. Round one used
     * `radius + 0.75 m` at any distance, which at 8 m is 10 degrees — 280 px on
     * a 1920 frame — so the reticle's name label sat on one creature at screen
     * centre while the bracket and the beam were stamped on a different one 430
     * px away, in two of the three shots a critic looked at. AIM_TAN is 0.075,
     * i.e. 4.3 degrees or about 120 px: still forgiving enough that the scanner
     * is not a sniper rifle, but tight enough that the label and the bracket can
     * only ever be the same subject.
     */
    /*
     * `bias` breaks ties BETWEEN CLASSES of subject. A landmark is 6-14 m across
     * and 40 m away, so its angular tolerance swallows the whole aim cone and it
     * won every contest against the fish and the outcrop actually under the
     * reticle — the hud framing acquired a rock arch 60 m out and stamped the
     * bracket on it, which then landed BEHIND the held tool and disappeared. A
     * subject you can reach out and touch outranks scenery unless you are aimed
     * squarely at the scenery.
     */
    const test = (pos, radius, maxD, bias, make) => {
      _to.copy(pos).sub(cam);
      const along = _to.dot(_fwd);
      if (along < 0.35 || along > maxD) return;
      _tmp.copy(_fwd).multiplyScalar(along);
      const perp = _to.distanceTo(_tmp);
      // The +0.06 floor keeps arm's-length subjects selectable without letting
      // a fish 1.5 m away be acquired 300 px off the reticle — which is how a
      // creature swimming past the lens ended up bracketed behind the tool.
      const tol = Math.min(radius * 0.8 + 0.35, along * AIM_TAN + 0.06);
      if (perp > tol) return;
      const score = perp / tol + along * 0.014 + bias;
      if (score < bestScore) { bestScore = score; best = make(along); }
    };

    for (const pool of this.field.pools) {
      for (const nd of pool.nodes) {
        _pt.set(nd.x, nd.y + nd.scale * 0.30, nd.z);
        const r = nd.scale * (nd.kind === 'organic' ? 0.60 : 0.42);
        test(_pt, r, 22, 0, (d) => ({
          kind: 'node', node: nd, dbId: nd.kind === 'organic' ? nd.species : nd.item,
          dbCat: nd.kind === 'organic' ? 'life' : 'geo',
          name: nd.kind === 'organic'
            ? (DATABANK[nd.species]?.t || itemName(nd.species))
            : (DATABANK[nd.item]?.t || itemName(nd.item)),
          point: _pt.clone(), size: Math.max(0.45, r * 2.1), dist: d,
        }));
      }
    }

    const cr = this._ctx.get('creatures');
    if (cr && !cr.stub && typeof cr.list === 'function') {
      let list;
      try { list = cr.list(); } catch { list = null; }
      if (list) {
        for (const a of list) {
          if (!a.position) continue;
          const r = Math.max(0.4, (a.length || 1) * 0.42);
          test(a.position, r, 26, 0.05, (d) => ({
            kind: 'creature', dbId: a.name, dbCat: 'life',
            name: DATABANK[a.name]?.t || itemName(a.name),
            point: a.position.clone(), size: Math.max(0.8, r * 2.3), dist: d,
          }));
        }
      }
    }

    const st = this._ctx.get('structures');
    if (st && !st.stub && typeof st.landmarks === 'function') {
      const marks = this._landmarks || (this._landmarks = (() => {
        try { return st.landmarks(); } catch { return []; }
      })());
      for (const l of marks) {
        // Bracket a landmark on its MASS, not on its foot. structures.js anchors
        // these at ground level, so the ring was being stamped on the sand below
        // an arch rather than on the arch — and in the hud framing that put it
        // behind the held tool, where it was simply invisible.
        _pt.set(l.x, l.y + Math.min(l.r || 6, 10) * 0.55, l.z);
        if (_pt.distanceToSquared(cam) > 6400) continue;
        test(_pt, Math.min(l.r || 6, 14), 78, 0.45, (d) => ({
          kind: 'landmark', dbId: l.kind, dbCat: 'data',
          name: DATABANK[l.kind]?.t || itemName(l.kind),
          point: _pt.clone(), size: Math.min(l.r || 6, 9), dist: d, desc: l.desc,
        }));
      }
    }
    return best;
  },

  completeScan(target) {
    const e = buildEntry(target.dbId, target.dbCat);
    if (target.desc && !DATABANK[target.dbId]) e.x = target.desc + '. ' + e.x;
    this._entries.set(e.id, e);
    this.scannedSet.add(e.id);
    this.unreadSet.add(e.id);
    this.unread = this.unreadSet.size;
    this._pushDatabank(e);
    /*
     * The three beats of a finished scan, all at the same instant: the bracket
     * throws a shockwave in the world, the tool kicks in the hand, and the
     * databank page arrives beside the reticle. Round three did none of them —
     * the arc simply stopped and a toast appeared somewhere else on screen.
     */
    const half = clamp(target.size * 0.5, target.dist * 0.05, target.dist * 0.125);
    this.fx.burst(target.point, half);
    this.vm.kick = 0.55;
    this.vm.setReadout('ENTRY', 'LOGGED', -1);
    this.hud?.entryCard(e);
    if (!this.uiApi) this.notify(`<b>New databank entry</b><br>${e.t}`);
    if (e.bp && !this.blueprints.has(e.bp)) {
      this.blueprints.add(e.bp);
      this.notify(`<b>Blueprint acquired</b><br>${itemName(e.bp)}`, 'ok');
      if (this.uiApi) this._bindUi(this.uiApi);   // the recipe list just grew
    }
    if (this.pdaShown) pdaRender(this);
  },

  // ---- harvesting ----------------------------------------------------------
  harvest(target, withKnife, t) {
    const nd = target.node;
    const st = this.field.nodeState(nd);
    const col = this.field.burstColour(nd);
    _pt.set(nd.x, nd.y + nd.scale * 0.3, nd.z);
    // The hand feels the hit. A blade that passes through rock with only a
    // particle puff to show for it is the reason harvesting read as inert.
    this.vm.kick = Math.max(this.vm.kick, nd.kind === 'outcrop' ? (withKnife ? 1 : 0.7) : 0.45);
    if (nd.kind === 'outcrop') {
      st.hp -= withKnife ? 1 : 0.5;
      this.debris.burst(_pt, col, 18, 1.9);
      // a struck rock throws a few hot chips as well as dust
      this.debris.burst(_pt, _spark.setRGB(2.0, 1.55, 0.85), 5, 3.4);
      if (st.hp > 0) { this.field.refill(this.playerPos.x, this.playerPos.z, t); return; }
      this.debris.burst(_pt, col, 34, 3.2);
      this.debris.burst(_pt, _spark.setRGB(2.2, 1.7, 0.95), 10, 4.6);
      const table = OUTCROP_YIELD[nd.item] || ['titanium'];
      const r = this._rng;
      const n = 1 + (r() < 0.55 ? 1 : 0);
      for (let i = 0; i < n; i++) this.give(table[(r() * table.length) | 0], 1);
      if (r() < 0.5) this.give(nd.item, 1);
      st.dead = t + 300;                      // the shelf reseeds over five minutes
    } else if (nd.kind === 'organic') {
      this.debris.burst(_pt, col, 14, 1.1);
      this.give(nd.item, 1 + (this._rng() < 0.4 ? 1 : 0));
      st.dead = t + 100;
    } else {
      this.debris.burst(_pt, col, 12, 1.0);
      this.give(nd.item, nd.item === 'salt' || nd.item === 'quartz' ? 1 + (this._rng() < 0.5 ? 1 : 0) : 1);
      st.dead = t + 240;
    }
    this.field.refill(this.playerPos.x, this.playerPos.z, t);
  },

  // ---- crafting ------------------------------------------------------------
  craft(id) {
    if (this.fab.job) { this.notify('Fabricator busy'); return false; }
    const r = this.recipeFor(id);
    if (!r) { this.notify(`<b>No schematic</b> for ${itemName(id)}`); return false; }
    if (!this.inventory.has(r.need)) {
      const missing = Object.keys(r.need).filter((k) => this.inventory.count(k) < r.need[k]);
      this.notify(`<b>Missing</b> ${missing.map(itemName).join(', ')}`);
      return false;
    }
    for (const k in r.need) this.inventory.remove(k, r.need[k]);
    this._invDirty = true;
    this._goalDirty = true;
    this.fab.start(r.id, r.time);
    this.notify(`Fabricating <b>${itemName(r.id)}</b>`);
    if (this.craftShown) craftRender(this);
    return true;
  },

  // ---- beacons -------------------------------------------------------------
  dropBeacon(ctx) {
    if (this.inventory.count('beacon') < 1) { this.notify('<b>No beacon</b> in inventory'); return; }
    if (this.beacons.length >= this.maxBeacons) { this.notify('<b>Beacon limit</b> reached'); return; }
    this.inventory.remove('beacon', 1);
    this._invDirty = true;
    const terrain = ctx.get('terrain');
    const p = this.playerPos.clone();
    const gy = terrain?.heightAt ? terrain.heightAt(p.x, p.z) : NaN;
    // a beacon sinks to the floor if the floor is within reach, otherwise it
    // hangs where it was released
    if (Number.isFinite(gy) && p.y - gy < 26) p.y = gy;
    else p.y -= 1.2;
    const mesh = buildBeacon(this.beaconMats);
    mesh.position.copy(p);
    mesh.rotation.y = this._rng() * TAU;
    ctx.scene.add(mesh);
    const name = 'Beacon ' + (this._beaconN = (this._beaconN || 0) + 1);
    this.beacons.push({ id: 'b' + this._beaconN, name, pos: p, mesh });
    this.notify(`<b>${name}</b> deployed`);
    if (this.pdaShown) pdaRender(this);
  },

  // ---- equipment -----------------------------------------------------------
  /**
   * Gear has to CHANGE something or it is a line of inventory text. Round one
   * computed oxygenBonus and swimSpeedMul and published them, and a critic
   * grepped survival.js and movement.js and found nobody reading either — so
   * the tank and the fins were inert. survival.js publishes setUpgrade('tank' |
   * 'rebreather' | 'suit') explicitly for this module to call, so call it: a
   * fabricated tank now genuinely lengthens the dive.
   *
   * The fins are the honest exception. movement.js takes a swim multiplier from
   * exactly one place, vehicles.js's swimHandling(), and there is no second
   * hook — so rather than publish a number nobody reads, the Swim Charge Fins
   * do what their name says here: they trickle-charge the tool in hand while
   * you swim. That is entirely inside this module and it is real.
   */
  recomputeEquipment() {
    const inv = this.inventory;
    const e = this.equipment;
    const hasTank = inv.count('tank') > 0;
    const hasReb = inv.count('rebreather') > 0;
    e.oxygenBonus = hasTank ? 45 : 0;
    e.swimSpeedMul = 1;                       // see above: nobody consumes this
    e.fins = inv.count('fins') > 0;
    e.carryBonus = inv.count('cargo_webbing') > 0 ? 30 : 0;
    e.rebreather = hasReb;
    inv.capacity = 45 + e.carryBonus;
    const sv = this._ctx?.get('survival');
    if (sv && !sv.stub && typeof sv.setUpgrade === 'function') {
      try {
        if (this._svTank !== hasTank) { sv.setUpgrade('tank', hasTank ? 'high' : 'standard'); this._svTank = hasTank; }
        if (this._svReb !== hasReb) { sv.setUpgrade('rebreather', hasReb); this._svReb = hasReb; }
      } catch { /* their model, their rules */ }
    }
    // quick bar mirrors what is actually carried
    for (let i = 0; i < 5; i++) {
      const id = QUICK_ORDER[i];
      this.bar[i] = inv.count(id) > 0 ? id : null;
    }
    if (!this.bar[this.sel]) {
      const first = this.bar.findIndex((x) => x);
      this.sel = first < 0 ? 0 : first;
    }
    this._invDirty = false;
    this._pushInv(true);
  },

  // ---- lifecycle -----------------------------------------------------------
  async init(ctx) {
    this._ctx = ctx;
    // ?notools builds nothing, so a critic can A/B the frame cost of this
    // module against the same seed without editing the manifest. Presence is
    // enough: tools/capture.mjs splits --seed=a=b on the first '=', so a flag
    // smuggled through the seed arrives valueless.
    if (flag(ctx.params, 'notools')) { this.disabled = true; return; }
    this._rng = ctx.rng?.fork ? ctx.rng.fork(9137) : makeRNG(0x70015);
    this._entries = new Map();
    this._invDirty = true;
    this.playerPos.copy(ctx.camera.position);
    _prevCam.copy(ctx.camera.position);

    this.field = new NodeField(ctx.scene, ctx);
    /*
     * ?nonodes hides the resource-node field and NOTHING else — the lamp, the
     * view model and the HUD all stay, which ?notools cannot do.
     *
     * It exists because an attribution reached me that could not be checked any
     * other way. A flat cyan blob in the middle of shallows-floor was traced to
     * this field by hiding `tools.nodes`, and a critic scored it against a
     * neighbouring module on that basis. Whoever owns that object next should be
     * able to settle it in one capture instead of inheriting the claim.
     */
    this._noNodes = flag(ctx.params, 'nonodes');
    if (this._noNodes) {
      this.field.group.visible = false;
      ctx.declareGodMode?.('tools', 'resource node field hidden (?nonodes=1)');
    }
    this.lamp = new Lamp(ctx.scene, ctx);
    this.vm = new ViewModel(ctx.scene);
    /*
     * ?novm hides the view model and nothing else, so its screen footprint can
     * be measured by differencing two otherwise frame-identical captures. That
     * is the number three critics in a row have scored this module on (0.7% of
     * frame against the reference's 7.4%) and it was being estimated by eye off
     * a crop; ?notools cannot serve because it also removes the node field, the
     * lamp and the HUD.
     */
    this._noVm = flag(ctx.params, 'novm');
    if (this._noVm) this.vm.root.visible = false;
    /*
     * ?vmfill=<scale> multiplies BOTH halves of the view-model fill, so the
     * ambient/lamp split described in setFill can be A/B'd against the frame's
     * own water rather than argued about. ?vmfill=0 leaves only the diffuse from
     * three's real lights, which is how the shallow/deep split was checked to be
     * carrying what this comment claims it carries.
     */
    const vf = ctx.params?.get?.('vmfill');
    if (vf !== null && vf !== undefined && vf !== '' && Number.isFinite(+vf)) {
      this.vm._fillScale = +vf;
    }
    this.fx = new ScanFX(ctx.scene);
    this.debris = new Debris(ctx.scene);
    this.fab = new Fabricator(ctx.scene, ctx);

    // beacons get their own blinking emissive so the view model's screen does
    // not blink with them
    const blink = new THREE.MeshStandardMaterial({
      color: srgb(0x0e3350), roughness: 0.3, metalness: 0,
      emissive: new THREE.Color(0.35, 1.65, 2.35), emissiveIntensity: 1,
    });
    applyUnderwater(blink, { caustics: 0 });
    this.beaconBlink = blink;
    /*
     * A DROPPED BEACON GETS ITS OWN MATERIALS, not a slice of the view model's.
     *
     * They were shared, which was already questionable — a marker 60 m away was
     * carrying the emissive fill computed for an object 45 cm from the eye — and
     * ViewModel.setFill now writes the ALBEDO too, pre-dividing it by postfx's
     * NEAR-zone gain so the held tool comes out at its authored hue. That
     * correction is only valid in the near zone; a beacon at any real distance is
     * graded by the far gain instead, so it would have come out over-cyan by
     * exactly the amount the tool needed. One extra material set, no extra draws
     * (mergeGroups still collapses each material to one group), and the two
     * objects now answer to the lighting they are actually in.
     */
    const beaconOwn = makeToolMats(null);
    this.beaconMats = [...beaconOwn.slice(0, 5), blink];

    // ---- the Alterra survival package: the three verbs, and a databank that
    // is not an empty page on minute one
    this.inventory.add('knife', 1);
    this.inventory.add('flashlight', 1);
    this.inventory.add('scanner', 1);
    this.inventory.add('beacon', 1);
    this.inventory.add('titanium', 2);
    this.inventory.add('quartz', 1);
    for (const seed of ['lifepod', 'limestone', 'peeper']) {
      const e = buildEntry(seed, DATABANK[seed]?.cat);
      this._entries.set(e.id, e);
      this.scannedSet.add(e.id);
    }
    this.pdaSel.databank = 'lifepod';
    this.recomputeEquipment();
    // The scanner is the default, not the torch. Every play route starts in the
    // sunlit 0-8 m shallows and round one swam all of them holding a lit
    // flashlight, which is not a thing a player does. The torch comes out when
    // it is dark: below LAMP_DEPTH, or when the sun is down (see update).
    this.sel = Math.max(0, this.bar.indexOf('scanner'));
    this.lightOn = false;
    this.vm.equip(this.bar[this.sel]);

    const p = ctx.params;
    // An explicit ?flashlight=0 / ?flashlight=1 outranks the shot hooks. Round
    // one read the flag here and then every hook called setupShot({light:true})
    // straight over the top of it, so a critic A/Bing the lamp with that flag
    // got a false negative twice before giving up on it.
    this._lightOverride = p?.get('flashlight') === '0' ? false
      : (p?.get('flashlight') != null ? true : null);
    if (this._lightOverride !== null) this.lightOn = this._lightOverride;
    this._wantPda = flag(p, 'pda') ? (p.get('pdatab') || 'data') : null;
    this._wantCraft = flag(p, 'craft');
    this.equipment.lightOn = this.lightOn;

    /*
     * ---- HUD, and ?nohud=1.
     *
     * ui.js and survival.js have both honoured ?nohud=1 for rounds; this module
     * did not, so the flag was ineffective for anyone capturing a clean landscape
     * frame — the reticle, the quick bar, the world markers and the resource
     * chips are all drawn HERE, not there. A critic building an argument on
     * ?nohud=1 was building it on a HUD that never went away.
     *
     * There is exactly one HUD: ui.js detects this element (#cn-tl) on its own
     * init and stands its overlapping widgets down (see its _detectPeerHud), so
     * the reticle, slots, chips, markers and Tab binding are ours and the depth
     * readout, compass and vitals cluster are its. Under ?nohud=1 neither draws:
     * ui.js already gates its whole overlay on the same flag.
     */
    this._noHud = flag(p, 'nohud');
    if (ctx.uiRoot && !this._noHud) {
      try {
        this.hud = new Hud(ctx.uiRoot, this);
        if (this._wantCraft) craftOpen(this);
      } catch (e) { console.warn('[tools] HUD unavailable:', e.message); }
    }

    // ---- input edges
    this._mb = 0;
    this._onKey = (ev) => {
      // ui.js binds Tab itself; taking it too would open two PDAs on one key.
      if (ev.code === 'Tab' && !this.uiApi) {
        ev.preventDefault();
        if (this.pdaShown) pdaClose(this); else { craftClose(this); pdaOpen(this); }
      } else if (ev.code === 'KeyI') {
        craftClose(this);
        if (this.uiApi) { try { this.uiApi.openPDA('inventory'); } catch { /* optional */ } }
        else if (this.pdaShown && this.pdaTab === 'inventory') pdaClose(this);
        else pdaOpen(this, 'inventory');
      } else if (ev.code === 'Escape') { pdaClose(this); craftClose(this); }
    };
    addEventListener('keydown', this._onKey);

    this.field.update(this.playerPos.x, this.playerPos.z, 0, true);
    ctx.provide?.('tools', this);
    /*
     * A MATERIAL CENSUS THIS MODULE CAN BE HELD TO.
     *
     * A whole-game count found only 35 of 179 scene materials opted into surface
     * microstructure, "despite six subsystems reporting they wired it in" — i.e.
     * the reporting was the unreliable part, not the wiring. So report it from
     * the live objects rather than from memory: walk every material this module
     * actually put in the scene, and count how many carry core's
     * userData.uwSurface flag. Anything that regresses shows up in report.json.
     */
    this.materialCensus = () => {
      const seen = new Set();
      let total = 0, patched = 0, surf = 0, custom = 0;
      const visit = (m) => {
        if (!m || seen.has(m)) return;
        seen.add(m);
        total++;
        if (m.userData.__uw) patched++;
        if (m.userData.uwSurface) surf++;
        if (m.isShaderMaterial) custom++;
      };
      const roots = [this.field.group, this.vm.root, this.vm.glow, this.fab.group,
        this.fx.beam, this.fx.mark, this.debris.points, this.lamp.pool,
        this.lamp.add, this.lamp.motes, ...this.beacons.map((b) => b.mesh)];
      for (const r of roots) {
        r?.traverse?.((o) => {
          if (!o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(visit);
        });
        if (r && !r.traverse && r.material) visit(r.material);
      }
      // materials held but not necessarily mounted this frame
      this.beaconMats?.forEach(visit);
      return { total, patched, surf, custom, surfPct: +(100 * surf / Math.max(1, total)).toFixed(1) };
    };
    this.stats = () => ({
      nodes: this.field.pools.reduce((a, p) => a + p.nodes.length, 0),
      scanned: this.scannedSet.size, beacons: this.beacons.length,
      mass: +this.inventory.mass.toFixed(1), lamp: this.lamp.power.toFixed(2),
      lampLevel: +this.lamp.level.toFixed(5),
      hasDepth: this.lamp.hasDepth,
      materials: this.materialCensus(),
    });
    if (!this.lamp.hasDepth) {
      console.info('[tools] render/underwater.js exposes no depth prepass — the lamp '
        + 'runs volumetric-only and will not paint a pool on the seabed.');
    }
  },

  update(dt, t, ctx) {
    if (this.disabled) return;
    const camera = ctx.camera;
    const input = ctx.input;
    const mv = ctx.get('movement');
    const mvLive = mv && !mv.stub;

    // ui.js is order 210, so it does not exist during our init — bind on the
    // first frame instead, and hand it the item, recipe and databank tables.
    if (!this._uiChecked) {
      this._uiChecked = true;
      const ui = ctx.get('ui');
      if (ui && !ui.stub && typeof ui.setInventory === 'function') {
        this._bindUi(ui);
        pdaClose(this);
        if (this._wantPda) { try { ui.openPDA(this._wantPda); } catch { /* optional */ } }
      }
    }
    this._uiSync = (this._uiSync || 0) + dt;
    if (this.uiApi && this._uiSync > 0.35) { this._uiSync = 0; this._pushInv(false); }

    // ---- who and where is the player ---------------------------------------
    if (mvLive && mv.position?.isVector3) this.playerPos.copy(mv.position);
    else this.playerPos.copy(camera.position);
    let speed = 0;
    if (mvLive && mv.velocity?.isVector3) speed = mv.velocity.length();
    else if (dt > 1e-4) speed = _prevCam.distanceTo(camera.position) / dt;
    _prevCam.copy(camera.position);
    speed = Math.min(speed, 12);

    if (this._invDirty) this.recomputeEquipment();

    // ---- input --------------------------------------------------------------
    const mb = input?.mouse?.buttons ?? 0;
    const lmb = !!(mb & 1), rmb = !!(mb & 4);
    const lmbHit = lmb && !(this._mb & 1);
    this._mb = mb;
    // ui.js's PDA counts as modal too, or our reticle label draws across it
    const modal = this.pdaShown || this.craftShown || !!this.uiApi?.pdaOpen;

    for (let i = 0; i < 5; i++) {
      if (input?.hit?.('Digit' + (i + 1))) { this.sel = i; this._invDirty = true; this._lampManual = true; }
    }
    /*
     * Arm the torch the first time it actually gets dark, once, and never
     * again — after that the player owns the switch. Without this the scanner
     * default would mean a descent into a 200 m cave with no light at all,
     * which is worse than the old bug of swimming the sunlit shallows holding a
     * lit torch. LOOK.md 7: below 200 m you see 15-25 m only WITH a light.
     */
    if (!this._lampManual && !this.lightOn) {
      const depth = WORLD.seaLevel - this.playerPos.y;
      if ((depth > 45 || U.uDepthDarken.value < 0.34) && this.bar.indexOf('flashlight') >= 0) {
        this.sel = this.bar.indexOf('flashlight');
        this.lightOn = true;
        this._invDirty = true;
        this._lampManual = true;
        this.notify('<b>Flashlight</b> on — ambient light low');
      }
    }
    if (input?.hit?.('KeyF')) {
      this._lampManual = true;
      const fi = this.bar.indexOf('flashlight');
      const gi = this.bar.indexOf('seaglide');
      if (this.bar[this.sel] === 'flashlight' || this.bar[this.sel] === 'seaglide') {
        this.lightOn = !this.lightOn;
      } else if (fi >= 0) { this.sel = fi; this.lightOn = true; this._invDirty = true; }
      else if (gi >= 0) { this.sel = gi; this.lightOn = true; this._invDirty = true; }
      else this.notify('<b>No flashlight</b> — fabricate one from Tools');
    }
    if (input?.hit?.('KeyG')) this.swapBattery();
    if (input?.hit?.('KeyB') && !modal) this.dropBeacon(ctx);

    // Both hands are on the seaglide or the Seamoth stick: vehicles.js is
    // presenting that model, so ours gets out of the way rather than sprouting
    // a second arm out of the same shoulder.
    const veh = ctx.get('vehicles');
    if (this._wantHands && veh && !veh.stub && typeof veh.setSeaglide === 'function') {
      try { veh.setSeaglide(false); } catch { /* their call, their rules */ }
    }
    const busyHands = !!(veh && !veh.stub
      && ((veh.seaglide && veh.seaglide.active) || veh.playerInVehicle));
    this.vm.root.visible = !busyHands && !this._noVm;

    const tool = busyHands ? null : this.bar[this.sel];
    this.vm.equip(tool);

    // ---- the fabricator -----------------------------------------------------
    const fabDist = this.playerPos.distanceTo(this.fab.anchor);
    const nearFab = fabDist < 3.6;
    if (input?.hit?.('KeyE')) {
      if (this.craftShown) craftClose(this);
      else if (nearFab) { pdaClose(this); craftOpen(this); }
    }
    // ?craft is a capture flag: every canonical shot spawns hundreds of metres
    // from the lifepod, so this auto-close fired on frame one and the panel
    // could never survive to a capture. Walking away still closes it.
    if (this.craftShown && !this._wantCraft && !nearFab && fabDist > 5.5) craftClose(this);
    const made = this.fab.update(dt);
    if (made) {
      const r = RECIPES.find((x) => x.id === made) || { out: 1 };
      this.give(made, r.out || 1);
      this.notify(`<b>${itemName(made)}</b> fabricated`);
      if (this.craftShown) craftRender(this);
      if (this.pdaShown) pdaRender(this);
    }

    // ---- aim ----------------------------------------------------------------
    const target = modal ? null : this.acquire(camera);
    this.target = target;

    // ---- scanning -----------------------------------------------------------
    const wantScan = !modal && (rmb || input?.down?.('KeyQ'));
    const canScan = tool === 'scanner' && this.charge.scanner > 0;
    let scanned = false;
    if (target && wantScan && canScan && !this.scannedSet.has(target.dbId)) {
      const dur = SCAN_TIME[target.kind] || 2.5;
      if (this._scanId !== target.dbId) { this._scanId = target.dbId; this._scan = 0; }
      this._scan = clamp01(this._scan + dt / dur);
      this.charge.scanner = Math.max(0, this.charge.scanner - DRAIN.scanner * dt);
      if (this._scan >= 1) { this.completeScan(target); this._scan = 0; this._scanId = null; }
      scanned = true;
    } else if (!this._pinScan) {
      this._scan = Math.max(0, (this._scan || 0) - dt * 1.6);
      if (this._scan <= 0) this._scanId = null;
    }
    if (this._pinScan) this._scan = this._pinScan;
    const scanAmt = this._pinScan ? 1 : (scanned ? 1 : clamp01(this._scan * 3));

    // The completion shockwave outlives the beam, so it owns the overlay for
    // its 0.7 s rather than being cut off the frame the arc reaches 1.
    if (this.fx.pulse > 0) this.fx.tick(dt);
    else if (target && (scanned || this._pinScan)) {
      this.vm.muzzle(_tmp);
      // Clamp the bracket to an angular size. Bracketing a 4 m creature at 3 m
      // with a 4 m ring filled a third of the frame; Subnautica's is a fixed
      // overlay whatever it is pointed at.
      const half = clamp(target.size * 0.5, target.dist * 0.05, target.dist * 0.125);
      this.fx.show(_tmp, target.point, half, this._scan, scanAmt);
    } else this.fx.hide();

    // ---- primary use: cut, break, collect -----------------------------------
    const useHit = !modal && (lmbHit || input?.hit?.('KeyR'));
    if (useHit && target && target.kind === 'node') {
      const knife = tool === 'knife';
      if (knife) { this.vm.swing = 1; this._pending = { node: target.node, at: t + 0.20, knife: true }; }
      else this.harvest(target, false, t);
    } else if (useHit && tool && ITEMS[tool]?.use) {
      this.consume(tool);
    } else if (useHit && tool === 'knife') {
      this.vm.swing = 1;
    }
    if (this._pending && t >= this._pending.at) {
      const nd = this._pending.node;
      this._pending = null;
      const still = this.field.nodeState(nd);
      if (!still.dead || still.dead <= t) this.harvest({ node: nd }, true, t);
    }

    // ---- the lamp -----------------------------------------------------------
    const lampTool = tool === 'flashlight' ? 'hand' : tool === 'seaglide' ? 'glide' : null;
    const lampCharge = lampTool ? this.charge[tool] : 0;
    this.lamp.on = !!lampTool && this.lightOn;
    this.lamp.setMode(lampTool === 'glide' ? 'glide' : 'hand');
    if (this.lamp.on && lampCharge > 0) {
      this.charge[tool] = Math.max(0, lampCharge - DRAIN[tool] * dt);
      if (this.charge[tool] === 0) this.notify('<b>Battery dead</b> — swap one in (G)');
    }
    this.equipment.lightOn = this.lamp.on && lampCharge > 0;

    // Swim Charge Fins: swimming spins the impellers and trickles charge back
    // into whatever is in hand. Real, measurable, and entirely ours.
    if (this.equipment.fins && speed > 0.8 && tool && this.charge[tool] !== undefined) {
      this.charge[tool] = Math.min(100, this.charge[tool] + Math.min(speed, 5) * 0.09 * dt);
    }

    // ---- the scanner's own readout ------------------------------------------
    if (tool === 'scanner') {
      const pct = this._scan > 0.002 ? this._scan : -1;
      if (pct >= 0) this.vm.setReadout('SCANNING', Math.round(pct * 100) + '%', pct);
      else if (target && this.scannedSet.has(target.dbId)) this.vm.setReadout('ALREADY', 'ANALYSED', -1);
      else if (target) this.vm.setReadout('SUBJECT', 'ACQUIRED', -1);
      else this.vm.setReadout('READY TO', 'SCAN', -1);
    }

    // ---- view model ---------------------------------------------------------
    const lampLive = this.lamp.power * (lampCharge > 0 ? 1 : 0);
    this.vm.setFill(lampLive, lampLive);
    this.vm.update(dt, camera, speed, scanned);
    this.vm.root.updateMatrixWorld(true);
    this.vm.muzzle(_tmp);
    // Half way from the eye to the muzzle: enough parallax that the beam reads
    // as handheld, not enough to throw the pool off the reticle at 8 m.
    _tmp.lerp(camera.position, 0.5);
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    /*
     * Bend the beam a third of the way onto the TOOL'S own axis. Round three
     * fired the cone dead along the view while the torch model sat 11 degrees
     * off it, so the head pointed one way and the light went another — the
     * cheapest possible tell that the view model is a prop rather than the
     * thing casting the light. A third is enough that the two agree and little
     * enough that the pool still lands where the reticle is pointed.
     */
    const heldMesh = this.vm.current ? this.vm.tools[this.vm.current] : null;
    if (heldMesh) {
      _toolFwd.set(0, 0, -1).transformDirection(heldMesh.matrixWorld);
      if (_toolFwd.dot(_fwd) > 0.5) _fwd.lerp(_toolFwd, 0.34).normalize();
    }
    // The deferred lamp reads the engine depth buffer, which the hand and the
    // tool are in — tell it where the player's own gear ends. See vm.nearCut.
    this.lamp.shared.uNearCut.value = this.vm.nearCut(camera);
    this.lamp.update(dt, camera, _tmp, _fwd, lampCharge);
    // The head of a dive torch faces away from the eye; this is what tells the
    // player it is lit. See GLOW_VERT.
    this.vm.setGlow(lampTool && this.lamp.on ? lampLive * 0.46 : 0,
      lampTool === 'glide' ? 0.040 : 0.030);

    // ---- world streaming ----------------------------------------------------
    const jumped = Math.hypot(this.playerPos.x - this.field._lastX, this.playerPos.z - this.field._lastZ) > 60;
    this.field.update(this.playerPos.x, this.playerPos.z, t, jumped || ctx.time.frame < 3);
    this.debris.update(dt);

    // beacons blink; the lamp's own screen does not
    this.beaconBlink.emissiveIntensity = 0.6 + 2.4 * Math.pow(Math.abs(Math.sin(t * 1.35)), 6);

    // ---- HUD ----------------------------------------------------------------
    this.updateHud(dt, t, ctx, target, tool, nearFab, modal);
  },

  /**
   * survival.js exposes oxygen/food/water/health as GETTER-ONLY accessors, so
   * round one's `sv[k] = sv[k] + n` inside a try/catch was a silent no-op in
   * strict-mode ESM: drinking a Filtered Water removed the bottle and fired a
   * toast while survival.water never moved. It publishes consume/eat/drink/heal
   * precisely for this; use them, and only report success if one of them ran.
   */
  consume(id) {
    if (this.inventory.count(id) < 1) return false;
    const eff = ITEMS[id]?.use;
    if (!eff) return false;
    const sv = this._ctx.get('survival');
    let applied = false;
    if (sv && !sv.stub) {
      try {
        if (typeof sv.consume === 'function') { sv.consume(eff); applied = true; }
        else {
          if (eff.food && typeof sv.eat === 'function') { sv.eat(eff.food); applied = true; }
          if (eff.water && typeof sv.drink === 'function') { sv.drink(eff.water); applied = true; }
          if (eff.health && typeof sv.heal === 'function') { sv.heal(eff.health); applied = true; }
        }
      } catch { /* survival owns its own model; never fight it */ }
    }
    if (!applied && sv && !sv.stub) {
      this.notify(`<b>${itemName(id)}</b> — no effect (survival offers no intake hook)`);
      return false;
    }
    this.inventory.remove(id, 1);
    this._invDirty = true;
    const what = eff.water ? `+${eff.water} water` : eff.food ? `+${eff.food} food` : `+${eff.health} health`;
    this.notify(`Consumed <b>${itemName(id)}</b> — ${what}`);
    return true;
  },

  swapBattery() {
    const tool = this.bar[this.sel];
    if (!tool || this.charge[tool] === undefined) return;
    if (this.charge[tool] > 95) { this.notify('Battery is full'); return; }
    if (this.inventory.count('battery') < 1) { this.notify('<b>No spare battery</b>'); return; }
    this.inventory.remove('battery', 1);
    this.charge[tool] = 100;
    this._invDirty = true;
    this.notify(`<b>${itemName(tool)}</b> recharged`);
  },

  updateHud(dt, t, ctx, target, tool, nearFab, modal) {
    const hud = this.hud;
    if (!hud) return;
    hud.tickNotes(dt);
    hud.tickCard(dt);

    const ch = {};
    for (const k in this.charge) if (this.bar.includes(k)) ch[k] = this.charge[k] / 100;
    hud.refreshQuick(this.bar, this.sel, ch);

    if (modal) {
      hud.setScan(0, '', '');
      hud.setHint(this.craftShown
        ? 'Fabricator &mdash; <span class="tl-key">E</span> close'
        : '<span class="tl-key">Tab</span> close &nbsp; <span class="tl-key">1</span>&ndash;<span class="tl-key">5</span> tools');
      hud.marks.style.display = 'none';
      return;
    }
    hud.marks.style.display = '';

    // ---- reticle label + contextual prompt
    let name = '', sub = '';
    if (target) {
      name = target.name;
      const done = this.scannedSet.has(target.dbId);
      if (target.kind === 'node') {
        const nd = target.node;
        const knife = tool === 'knife';
        const verb = nd.kind === 'outcrop' ? (knife ? 'Break' : 'Chip')
          : nd.kind === 'organic' ? (knife ? 'Cut' : 'Pick') : 'Collect';
        sub = `${verb} <span class="tl-key">LMB</span>`;
      } else if (target.kind === 'creature') sub = 'Lifeform';
      else sub = 'Structure';
      if (tool === 'scanner') {
        sub += done ? ' &nbsp;·&nbsp; Analysed'
          : ` &nbsp;·&nbsp; Scan <span class="tl-key">RMB</span>`;
      } else if (!done && target.kind !== 'node') {
        sub += ' &nbsp;·&nbsp; unscanned';
      }
    }
    hud.setScan(this._scan || 0, name, sub);

    // ---- bottom hint line
    let hint = '';
    if (nearFab) hint = 'Fabricator &mdash; <span class="tl-key">E</span> use';
    else if (this.charge[tool] !== undefined && this.charge[tool] < 20)
      hint = `${itemName(tool)} battery ${Math.round(this.charge[tool])}% &mdash; <span class="tl-key">G</span> swap`;
    else if (tool) hint = `${itemName(tool)}`;
    hud.setHint(hint);

    if (!this.craftShown) this.refreshGoalChips();

    // ---- reticle label anchored to the subject, not to screen centre
    const w = ctx.renderer.domElement.clientWidth || 1920;
    const h = ctx.renderer.domElement.clientHeight || 1080;
    if (target) {
      _mv.copy(target.point).project(ctx.camera);
      const sx = (_mv.x * 0.5 + 0.5) * w, sy = (-_mv.y * 0.5 + 0.5) * h;
      // Inside the aim cone the label belongs under the reticle, exactly as
      // Subnautica draws it. Only a subject that has drifted out of the cone
      // (a creature that swam on while the arc was still filling) gets the
      // label moved onto it, so the two can never name different things.
      const off = Math.hypot(sx - w * 0.5, sy - h * 0.5) > w * 0.115;
      if (off && _mv.z < 1) {
        // The drop below the subject is CAPPED. It was target.size * 26, so a
        // 9 m landmark pushed the label 234 px down — far enough that it landed
        // on the held tool and read as part of the readout.
        hud.setLabelAt(clamp(sx, 150, w - 150),
          clamp(sy + clamp(target.size * 22, 34, 78), 90, h - 170));
      } else hud.setLabelAt(null, null);
    } else hud.setLabelAt(null, null);

    /*
     * World markers. Round one drew beacons only, on the grounds that base.js
     * labelled the landmarks — it does not, and ui.js's markers stand down the
     * moment it sees our #cn-tl, so a critic running ?notools got "Lifepod 5
     * 30 m", "Arch 108 m", "Cave Mouth 157 m" and with us present got nothing.
     * If we take ui's HUD we owe it the whole HUD. Sourced from
     * structures.landmarks(), which is where ui.js sourced them.
     */
    const marks = this._marks || (this._marks = []);
    marks.length = 0;
    for (const b of this.beacons) {
      marks.push({ name: b.name, glyph: 'beacon', pos: b.pos, dist: b.pos.distanceTo(this.playerPos) });
    }
    for (const l of this.worldMarks()) {
      const d = _pt.set(l.x, l.y, l.z).distanceTo(this.playerPos);
      if (d > 900) continue;
      marks.push({ name: l.name, glyph: l.glyph, pos: l.pos, dist: d });
    }
    // nearest first, and cap it: a screen edged with twenty chevrons is noise
    marks.sort((a, b) => a.dist - b.dist);
    if (marks.length > 8) marks.length = 8;
    hud.updateMarkers(marks, ctx.camera, w, h);
  },

  /**
   * Landmark markers, built once. structures.landmarks() is static after init,
   * so this is a one-time walk rather than a per-frame allocation.
   */
  worldMarks() {
    if (this._worldMarks) return this._worldMarks;
    const out = [];
    const st = this._ctx.get('structures');
    if (st && !st.stub) {
      let list = [];
      try { list = typeof st.landmarks === 'function' ? st.landmarks() : []; } catch { list = []; }
      const GL = { wreck: 'scrap', cave: 'rock', arch: 'rock', spire: 'crystal', pod: 'beacon' };
      // structures publishes the lifepod BOTH as a landmark and as .lifepod, so
      // a naive merge put two "Lifepod 5" chevrons four metres apart
      const seen = new Set();
      const push = (name, glyph, x, y, z) => {
        const k = name + '|' + Math.round(x / 8) + ',' + Math.round(z / 8);
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ name, glyph, x, y, z, pos: new THREE.Vector3(x, y, z) });
      };
      for (const l of list) {
        const base = String(l.id || l.kind || '').split('@')[0].replace(/[-_]/g, ' ').trim();
        if (!base) continue;
        push(base.replace(/\b\w/g, (m) => m.toUpperCase()), GL[l.kind] || 'dot', l.x, l.y, l.z);
      }
      const pod = st.lifepod;
      if (pod?.position) push('Lifepod 5', 'beacon', pod.position.x, pod.position.y + 2, pod.position.z);
    }
    this._worldMarks = out;
    return out;
  },

  /**
   * The top-right chips track the next thing worth building: the first item in
   * GOAL_ORDER the player has a schematic for, does not already carry, and
   * cannot yet afford. That makes the shopping list visible on the HUD in every
   * frame, which is what hud-1.jpg shows and what turns a swim into an errand.
   */
  refreshGoalChips() {
    if (!this.hud) return;
    const inv = this.inventory;
    if (this._goalDirty !== false) {
      let pick = null;
      for (const id of GOAL_ORDER) {
        const r = this.recipeFor(id);
        if (!r) continue;
        const own = ITEMS[id]?.stack === 1 ? inv.count(id) > 0 : inv.count(id) >= 3;
        if (own || inv.has(r.need)) continue;
        pick = r; break;
      }
      this._goal = pick;
      this._goalDirty = false;
    }
    this.hud.setChips(this._goal, inv, this._goal ? 'Next: ' + itemName(this._goal.id) : '');
  },

  /**
   * Caustic occluders — see NodeField.pickOccluders for what is published and
   * why the held view model deliberately is not. Core calls this every frame and
   * disables it permanently if it throws, so it must never assume the field is
   * built: `init` can have failed while the rest of the module survived.
   */
  causticOccluders() {
    if (this.disabled) return null;
    return this.field?._occl?.length ? this.field._occl : null;
  },

  preRender(ctx) {
    if (this.disabled) return;
    this.lamp?.preRender(ctx);
    const s = ctx.renderer.getDrawingBufferSize(_sizeV);
    const tanHalf = Math.tan(ctx.camera.fov * 0.5 * THREE.MathUtils.DEG2RAD);
    const px = (s.y * 0.5) / Math.max(tanHalf, 1e-3);
    if (this.debris) this.debris.u.uPixelScale.value = px;
    if (this.fab) this.fab.sparkU.uPixelScale.value = px;
  },

  // ---- capture setups ------------------------------------------------------
  /**
   * Shot hooks put the player in the state a player would actually be in for
   * that framing: torch out in the dark, scanner out in daylight. They run
   * before settle(), so the streamed node field and the lamp both have time to
   * reach steady state before the frame is taken.
   */
  shots: {
    'hud': (c) => setupShot(c, { tool: 'scanner', light: false, scan: 0.63, stock: true }),
    'shallows-reef': (c) => setupShot(c, { tool: 'scanner', light: false, scan: 0.28, stock: true }),
    'shallows-floor': (c) => setupShot(c, { tool: 'knife', light: false, stock: true }),
    'night-shallows': (c) => setupShot(c, { tool: 'flashlight', light: true, stock: true }),
    'cave': (c) => setupShot(c, { tool: 'flashlight', light: true }),
    'deep-void': (c) => setupShot(c, { tool: 'flashlight', light: true }),
    'grand-reef': (c) => setupShot(c, { tool: 'flashlight', light: true }),
    'dropoff': (c) => setupShot(c, { tool: 'flashlight', light: true }),
    'wreck': (c) => setupShot(c, { tool: 'flashlight', light: true }),
    'kelp-forest': (c) => setupShot(c, { tool: 'knife', light: false }),
    'godrays': (c) => setupShot(c, { tool: 'scanner', light: false }),
    'surface-pod': (c) => setupShot(c, { tool: 'scanner', light: false }),
    'surface-above': (c) => setupShot(c, { tool: 'scanner', light: false }),
    // base.js is still a stub, so this framing is otherwise empty water. Use it
    // to show the PDA, which is the one piece of this module a still cannot
    // otherwise reach.
    'base-interior': (c) => {
      setupShot(c, { tool: 'scanner', light: true, pda: true });
      if (api.uiApi) { try { api.uiApi.openPDA('data'); } catch { /* optional */ } }
      else pdaOpen(api, 'databank');
    },
  },
};

/** Shared body of the shot hooks. */
function setupShot(ctx, o) {
  if (api.disabled) return;
  pdaClose(api);
  // ui.js owns the PDA when it is up, and the base-interior hook opens it. Shot
  // hooks run in module order inside one page, so without this the PDA left
  // open by base-interior was still covering the next shot in the battery.
  if (api.uiApi?.closePDA && !o.pda) { try { api.uiApi.closePDA(); } catch { /* optional */ } }
  if (!api._wantCraft) craftClose(api);
  if (o.stock) {
    // a player twenty minutes in: something in every quick slot and a bag with
    // weight in it, so the HUD reads as a game in progress rather than a demo
    for (const [id, n] of [['water', 2], ['tank', 1], ['fins', 1], ['battery', 2],
      ['titanium', 6], ['copper_ore', 3], ['quartz', 4], ['salt', 2],
      ['coral_sample', 3], ['creepvine_seed', 2], ['silver_ore', 1], ['glass', 2]]) {
      if (api.inventory.count(id) < n) api.inventory.add(id, n - api.inventory.count(id));
    }
    api._invDirty = true;
    api.recomputeEquipment();
  }
  const i = api.bar.indexOf(o.tool);
  if (i >= 0) api.sel = i;
  api.lightOn = api._lightOverride !== null && api._lightOverride !== undefined
    ? api._lightOverride : !!o.light;
  // A staged frame is about the hand tool. vehicles.js stows its seaglide on
  // request through its own published setter, which is the polite way to ask.
  api._wantHands = true;
  api._lampManual = true;      // a staged frame is exactly as authored
  api._pinScan = o.scan || 0;
  api.vm.draw = 1;
  if (api.hud) api.hud._quickCache = '';
}

export default api;









