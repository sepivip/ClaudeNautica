/**
 * BASE — modular seabase construction, interiors, power, hull integrity and flooding.
 *
 * OWNER: the "base" agent.
 *
 * Design notes (the *why*):
 *
 *  - The emotional payoff of a seabase is CONTRAST. Outside is a cold, fogged,
 *    red-dead medium; inside is dry, warm, bright and finite. Everything here is
 *    arranged to make that step across the hatch legible, which is why interior
 *    materials go through applyUnderwater(mat, { caustics: 0, fogScale: 0.2 })
 *    instead of inheriting open-water fog.
 *
 *  - Interior lighting cannot come from three.js lights alone. core's injection
 *    ends with
 *        uwLit *= mix(0.06, 1.0, sunT.b) * uDepthDarken
 *    which multiplies EVERY light contribution — including a lamp bolted to the
 *    ceiling two metres away — by the ocean's depth response. At 30 m that is
 *    x0.66; at night it is x0.02, i.e. a pitch-black room inside a lit base.
 *    That is physically wrong for a dry pressurised volume, so interior lighting
 *    is BAKED per vertex and injected into `totalEmissiveRadiance`, which core
 *    deliberately exempts from the depth response. Real point lights are still
 *    added on top for the specular lobe and for anything that moves. See
 *    bakeInject() — it wraps core's onBeforeCompile rather than replacing it.
 *
 *  - Every surface in the base comes out of ONE primitive, gridShell(). It takes
 *    a parametric surface, a thickness, and a per-quad keep mask, and returns
 *    three geometries: the inner skin, the outer skin, and a rim wall around
 *    every hole. That is why a corridor with a window, a junction with four
 *    arches and an observatory dome with a door all read as the same kind of
 *    pressure vessel — the holes are real holes with visible plate thickness,
 *    not decals.
 *
 *  - Everything is merged into one batch per material, so an arbitrarily large
 *    player-built base costs a fixed ~12 draw calls. Rebuilds only happen when
 *    a piece is placed or removed.
 *
 * Published API (ctx.get('base')):
 *   pieces()                  every placed piece
 *   isInside(v3)              the piece containing a point, or null
 *   isDry(v3)                 true inside a piece that is not flooded — survival
 *                             should refill oxygen here
 *   nearestHatch(v3)          closest exterior hatch {pos, piece}
 *   power                     { generated, consumed, stored, capacity, ratio }
 *   hull                      { integrity, breaches, crushDepth }
 *   buildMode / setBuildMode(b)
 *   place(kind, opts)         programmatic construction (returns the piece or null)
 *   remove(piece)             deconstruct, refunding resources
 *   inventory                 the resource pool the builder draws from
 *   bases()                   the built base clusters
 */
import * as THREE from 'three';
import { applyUnderwater, UNDERWATER_PARS } from '../core/underwaterMaterial.js';
import { U, WORLD } from '../core/globals.js';
import { makeRNG } from '../core/rng.js';

// ============================================================== small math
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-9)); return t * t * (3 - 2 * t); };

/** sRGB -> linear. Vertex colours are consumed raw by three, so hexes must convert. */
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function linHex(hex) {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}

// ============================================================== dimensions
// One table, because every socket in the game has to line up with every other
// socket and a magic number in two places is a base with a gap in it.
const TR = 1.75;         // corridor interior radius
const TAX = 1.15;        // tube axis height above the deck plane
const TT = 0.20;         // hull plate thickness
const CORR_LEN = 4.6;    // one corridor module
const NODE_R = 2.90;     // junction hub radius (must clear TR + a shoulder)
const ROOM_R = 5.60;     // multipurpose room interior radius
const ROOM_H = 3.10;     // interior floor-to-ceiling
const OBS_R = 5.20;      // observatory dome radius
const OBS_H = 3.60;      // observatory apex height
const OBS_SILL = 1.15;   // solid hull band before the glass starts
const FOUND = 6.0;       // foundation slab edge

// ============================================================== geometry kit

/**
 * A merge target. Everything the base draws goes through here: geometry is
 * transformed to world space on the way in, tinted, and later given a baked
 * interior-light attribute, so an entire multi-room base collapses to one
 * BufferGeometry per material.
 */
class Batch {
  constructor(name) {
    this.name = name;
    this.pos = []; this.nor = []; this.uv = []; this.col = [];
    this.count = 0;
  }
  /**
   * @param {THREE.BufferGeometry} g   non-indexed or indexed, needs position+normal
   * @param {THREE.Matrix4} m
   * @param {number[]} tint            linear rgb multiplier
   * @param {number[]} [uvT]           [su, sv, ou, ov]
   */
  add(g, m, tint, uvT) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    // A source geometry may carry its own colour ramp (leaf blades run blue at
    // the base to orange at the tip in base-interior-1). Multiply, do not
    // overwrite, so the piece tint still applies on top.
    const sc = g.attributes.color || null;
    const idx = g.index ? g.index.array : null;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), vn = new THREE.Vector3();
    const su = uvT ? uvT[0] : 1, sv = uvT ? uvT[1] : 1;
    const ou = uvT ? uvT[2] : 0, ov = uvT ? uvT[3] : 0;
    const cr = tint ? tint[0] : 1, cg = tint ? tint[1] : 1, cb = tint ? tint[2] : 1;
    const emitVert = (i) => {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      if (n) { vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); this.nor.push(vn.x, vn.y, vn.z); }
      else this.nor.push(0, 1, 0);
      if (t) this.uv.push(t.getX(i) * su + ou, t.getY(i) * sv + ov);
      else this.uv.push(0, 0);
      if (sc) this.col.push(cr * sc.getX(i), cg * sc.getY(i), cb * sc.getZ(i));
      else this.col.push(cr, cg, cb);
      this.count++;
    };
    if (idx) for (let i = 0; i < idx.length; i++) emitVert(idx[i]);
    else for (let i = 0; i < p.count; i++) emitVert(i);
  }
  get empty() { return this.count === 0; }
  /**
   * @param {(x,y,z,nx,ny,nz)=>number[]} bakeFn   per-vertex self-lit term, or null
   * @param {(x,y,z,nx,ny,nz)=>number}   shadeFn  per-vertex ALBEDO multiplier, or null
   */
  build(bakeFn, shadeFn) {
    const g = new THREE.BufferGeometry();
    if (shadeFn) {
      // Sky occlusion, folded into vertex colour rather than into the bake.
      // Albedo is the right channel for it: it is then modulated by the real
      // sun, so it disappears at night the way an occlusion term must, whereas
      // the bake goes into totalEmissiveRadiance which core deliberately exempts
      // from every depth and daylight response and would glow at midnight.
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const k = shadeFn(this.pos[o], this.pos[o + 1], this.pos[o + 2],
          this.nor[o], this.nor[o + 1], this.nor[o + 2]);
        this.col[o] *= k; this.col[o + 1] *= k; this.col[o + 2] *= k;
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const bk = new Float32Array(this.count * 3);
    if (bakeFn) {
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const c = bakeFn(this.pos[o], this.pos[o + 1], this.pos[o + 2],
          this.nor[o], this.nor[o + 1], this.nor[o + 2]);
        bk[o] = c[0]; bk[o + 1] = c[1]; bk[o + 2] = c[2];
      }
    }
    g.setAttribute('aBake', new THREE.BufferAttribute(bk, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Camera-facing soft glows, merged into one draw call.
 *
 * The previous light-spill was a world-aligned quad carrying a radial-gradient
 * canvas through alphaMap. Two things went wrong and a critic measured both: the
 * gradient's stops banded into a visible dither ring, and a 2.3 m quad standing
 * 0.65 m off the hatch was drawn edge-on across the junction behind it, painting
 * a hard cream ellipse wider than the module it was supposed to be lighting.
 *
 * A billboard cannot go edge-on and an analytic falloff cannot band. The quad is
 * expanded about its centre in VIEW space in the vertex shader, so the merged
 * batch stays one draw call and every sprite still faces the camera.
 */
class GlowBatch {
  constructor() { this.c = []; this.o = []; this.s = []; this.col = []; this.n = 0; }
  /** @param {number[]} p world centre  @param {number} r radius, metres  @param {number[]} col peak radiance */
  add(p, r, col) {
    const K = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [ox, oy] of K) {
      this.c.push(p[0], p[1], p[2]);
      this.o.push(ox, oy);
      this.s.push(r);
      this.col.push(col[0], col[1], col[2]);
      this.n++;
    }
  }
  get empty() { return this.n === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(this.o, 2));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.s, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    // the vertex shader pushes corners out by aSize, which the bounding sphere
    // computed from centres alone does not know about
    if (g.boundingSphere) g.boundingSphere.radius += Math.max(...this.s, 0) * 1.5;
    return g;
  }
}

/**
 * THE workhorse. A two-sided pressure shell over a parametric grid, with holes.
 *
 *   p(i, j, out)      inner surface point
 *   nrm(i, j, out)    outward unit normal (the thickness direction)
 *   keep(i, j, cx, cy, cz)  false drops the quad; a dropped quad grows a rim wall
 *   uvf(i, j)         [u, v]
 *
 * Returns { inner, outer, rim } as non-indexed geometries with analytic normals —
 * smooth across the surface, hard at every torn edge, with no index bookkeeping.
 */
function gridShell({ nu, nv, wrapU = true, p, nrm, thick = TT, keep = null, uvf = null }) {
  const gi = wrapU ? nu : nu + 1;
  const gj = nv + 1;
  const A = new Float32Array(gi * gj * 3);
  const N = new Float32Array(gi * gj * 3);
  const _p = new THREE.Vector3(), _n = new THREE.Vector3();
  for (let j = 0; j < gj; j++) {
    for (let i = 0; i < gi; i++) {
      p(i, j, _p); nrm(i, j, _n); _n.normalize();
      const k = (j * gi + i) * 3;
      A[k] = _p.x; A[k + 1] = _p.y; A[k + 2] = _p.z;
      N[k] = _n.x; N[k + 1] = _n.y; N[k + 2] = _n.z;
    }
  }
  const at = (i, j) => ((j * gi + (wrapU ? (i % gi) : i)) * 3);

  const IN = { pos: [], nor: [], uv: [] };
  const OUT = { pos: [], nor: [], uv: [] };
  const RIM = { pos: [], nor: [], uv: [] };
  const push = (b, x, y, z, nx, ny, nz, u, v) => {
    b.pos.push(x, y, z); b.nor.push(nx, ny, nz); b.uv.push(u, v);
  };
  const uvAt = (i, j) => (uvf ? uvf(i, j) : [i / nu, j / nv]);

  // which quads survive
  const alive = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      let ok = true;
      if (keep) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        const cx = (A[a] + A[b] + A[c] + A[d]) * 0.25;
        const cy = (A[a + 1] + A[b + 1] + A[c + 1] + A[d + 1]) * 0.25;
        const cz = (A[a + 2] + A[b + 2] + A[c + 2] + A[d + 2]) * 0.25;
        ok = keep(i, j, cx, cy, cz);
      }
      alive[j * nu + i] = ok ? 1 : 0;
    }
  }
  const isAlive = (i, j) => {
    if (j < 0 || j >= nv) return 0;
    if (!wrapU && (i < 0 || i >= nu)) return 0;
    const ii = wrapU ? ((i % nu) + nu) % nu : i;
    return alive[j * nu + ii];
  };

  const corner = (i, j, side) => {
    const k = at(i, j);
    const x = A[k], y = A[k + 1], z = A[k + 2];
    const nx = N[k], ny = N[k + 1], nz = N[k + 2];
    return side ? [x + nx * thick, y + ny * thick, z + nz * thick, nx, ny, nz]
      : [x, y, z, nx, ny, nz];
  };

  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (!alive[j * nu + i]) continue;
      const c00 = corner(i, j, 0), c10 = corner(i + 1, j, 0);
      const c11 = corner(i + 1, j + 1, 0), c01 = corner(i, j + 1, 0);
      const d00 = corner(i, j, 1), d10 = corner(i + 1, j, 1);
      const d11 = corner(i + 1, j + 1, 1), d01 = corner(i, j + 1, 1);
      const u00 = uvAt(i, j), u10 = uvAt(i + 1, j), u11 = uvAt(i + 1, j + 1), u01 = uvAt(i, j + 1);

      /**
       * WINDING FOLLOWS THE PARAMETRISATION, NOT THE AUTHOR'S HOPE.
       *
       * The quad's geometric facing is sign(dot((c10-c00) x (c01-c00), n)), and
       * that sign flips with the handedness of the surface's own (i, j). The
       * corridor sweeps j along +Z and comes out one way; every lathe here —
       * multipurpose room, junction, observatory band — sweeps j along +Y and
       * comes out the other. With a fixed winding the lathes' inner skins were
       * therefore built facing OUTWARD, back-face culled from inside, and what
       * you actually saw standing in a multipurpose room was its EXTERIOR shell
       * through the hole where its interior should have been: exterior material,
       * full open-water fog, full depth response.
       *
       * That is the whole of the "habitat walls measure 3x too dark and 3-7x too
       * saturated" finding, and it is why the room read teal while the corridor
       * two metres away read white on the same material. Compute the sign.
       */
      const e1x = c10[0] - c00[0], e1y = c10[1] - c00[1], e1z = c10[2] - c00[2];
      const e2x = c01[0] - c00[0], e2y = c01[1] - c00[1], e2z = c01[2] - c00[2];
      const crx = e1y * e2z - e1z * e2y;
      const cry = e1z * e2x - e1x * e2z;
      const crz = e1x * e2y - e1y * e2x;
      const flip = (crx * c00[3] + cry * c00[4] + crz * c00[5]) < 0;

      // inner skin: faces -normal (into the volume)
      const inTri = (a, ua, b, ub, c, uc) => {
        const t = flip ? [c, uc, b, ub, a, ua] : [a, ua, b, ub, c, uc];
        for (let k = 0; k < 6; k += 2) {
          const p = t[k], u = t[k + 1];
          push(IN, p[0], p[1], p[2], -p[3], -p[4], -p[5], u[0], u[1]);
        }
      };
      inTri(c00, u00, c11, u11, c10, u10);
      inTri(c00, u00, c01, u01, c11, u11);

      // outer skin: faces +normal
      const outTri = (a, ua, b, ub, c, uc) => {
        const t = flip ? [c, uc, b, ub, a, ua] : [a, ua, b, ub, c, uc];
        for (let k = 0; k < 6; k += 2) {
          const p = t[k], u = t[k + 1];
          push(OUT, p[0], p[1], p[2], p[3], p[4], p[5], u[0], u[1]);
        }
      };
      outTri(d00, u00, d10, u10, d11, u11);
      outTri(d00, u00, d11, u11, d01, u01);

      // rim walls wherever a neighbour was dropped
      const wall = (a, b, da, db) => {
        const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
        const ox = da[0] - a[0], oy = da[1] - a[1], oz = da[2] - a[2];
        // outward = edge x thickness, normalised; sign fixed by winding below
        let nx = ey * oz - ez * oy, ny = ez * ox - ex * oz, nz = ex * oy - ey * ox;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        push(RIM, a[0], a[1], a[2], nx, ny, nz, 0, 0);
        push(RIM, b[0], b[1], b[2], nx, ny, nz, 1, 0);
        push(RIM, db[0], db[1], db[2], nx, ny, nz, 1, 1);
        push(RIM, a[0], a[1], a[2], nx, ny, nz, 0, 0);
        push(RIM, db[0], db[1], db[2], nx, ny, nz, 1, 1);
        push(RIM, da[0], da[1], da[2], nx, ny, nz, 0, 1);
      };
      if (!isAlive(i, j - 1)) wall(c10, c00, d10, d00);
      if (!isAlive(i, j + 1)) wall(c01, c11, d01, d11);
      if (!isAlive(i - 1, j)) wall(c00, c01, d00, d01);
      if (!isAlive(i + 1, j)) wall(c11, c10, d11, d10);
    }
  }
  const mk = (b) => {
    if (!b.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    return g;
  };
  return { inner: mk(IN), outer: mk(OUT), rim: mk(RIM) };
}

/** A surface of revolution about +Y from a profile of {r, y}, for gridShell. */
function latheFns(profile, radial) {
  // profile normals from finite differences along the profile polyline
  const pn = profile.map((_, j) => {
    const a = profile[Math.max(0, j - 1)], b = profile[Math.min(profile.length - 1, j + 1)];
    const dr = b.r - a.r, dy = b.y - a.y;
    const l = Math.hypot(dr, dy) || 1;
    return { r: dy / l, y: -dr / l };
  });
  return {
    nu: radial, nv: profile.length - 1, wrapU: true,
    p: (i, j, o) => {
      const a = (i / radial) * TAU, q = profile[Math.min(j, profile.length - 1)];
      o.set(Math.cos(a) * q.r, q.y, Math.sin(a) * q.r);
    },
    nrm: (i, j, o) => {
      const a = (i / radial) * TAU, q = pn[Math.min(j, pn.length - 1)];
      o.set(Math.cos(a) * q.r, q.y, Math.sin(a) * q.r);
    },
  };
}

/** Distance from a point to an infinite line (origin o, unit dir d). */
function distToAxis(px, py, pz, o, d) {
  const vx = px - o[0], vy = py - o[1], vz = pz - o[2];
  const t = vx * d[0] + vy * d[1] + vz * d[2];
  return Math.hypot(vx - d[0] * t, vy - d[1] * t, vz - d[2] * t);
}

// ---- cheap primitive cache: three's own generators, reused and re-transformed
const _geo = {};
const G = {
  box: (w, h, d) => (_geo[`b${w}_${h}_${d}`] ||= new THREE.BoxGeometry(w, h, d)),
  cyl: (rt, rb, h, s = 16, open = false) =>
    (_geo[`c${rt}_${rb}_${h}_${s}_${open}`] ||= new THREE.CylinderGeometry(rt, rb, h, s, 1, open)),
  sph: (r, s = 16, t = 10) => (_geo[`s${r}_${s}_${t}`] ||= new THREE.SphereGeometry(r, s, t)),
  tor: (r, tb, s = 8, ts = 28, arc = TAU) =>
    (_geo[`t${r}_${tb}_${s}_${ts}_${arc}`] ||= new THREE.TorusGeometry(r, tb, s, ts, arc)),
  ring: (ri, ro, s = 32) => (_geo[`r${ri}_${ro}_${s}`] ||= new THREE.RingGeometry(ri, ro, s)),
  plane: (w, h) => (_geo[`p${w}_${h}`] ||= new THREE.PlaneGeometry(w, h)),
};

/** A rounded slab — the shape of every panel, locker door and console in the base. */
function roundedSlab(w, h, d, r, seg = 3) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3);
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: d, bevelEnabled: true, bevelSize: Math.min(0.035, r * 0.5),
    bevelThickness: Math.min(0.03, d * 0.3), bevelSegments: 1, curveSegments: seg,
  });
  g.translate(0, 0, -d / 2);
  g.computeVertexNormals();
  return g;
}

// ============================================================== textures
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}
function finish(c, srgb, rep = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.repeat.set(rep, rep);
  return t;
}

/**
 * Habitat wall plating. base-interior-3/-4 are the reference: large light-grey
 * rounded plates separated by soft seams, a faint top edge highlight, rare
 * amber pictogram decals, and NO visible tiling frequency.
 *
 * MEASURED, and this is why the sheet was rebuilt: an interior wall crop of our
 * own frame scored tileContrast 43.62 and detailRMS 21.99 against the same crop
 * of base-interior-1 at 10.91 / 9.50. We carried FOUR TIMES the local contrast
 * of the reference and every bit of it was hard-edged decal — 0.9 m plates with
 * 85%-alpha 3 px seams, bolt rows and amber bars, repeated across a whole room.
 * The reference's panels are ~2 m, nearly featureless, and carry their signal as
 * low-amplitude broadband, which core's sfApply() now supplies in the shader.
 *
 * So: half as many plates per tile (2x2, not 4x4 — every uv scale in the module
 * was authored against 4x4 and doubling plate size this way keeps them all
 * valid), seams at a third of the old contrast, and the fine grain halved.
 */
function texPanel(rng) {
  const S = 1024;
  const { c, g } = canvas2d(S, S);
  // Neutral, very slightly warm. The old #d6dadb was cool, and once the
  // interior became bake-lit the cool albedo and the water's dead red channel
  // between them pushed the measured red share of a wall crop down to 53%
  // against the reference's 92-100%. base-interior-3's panels sample ~#c9cccd
  // under a neutral white bake; ours has to leave the red room to survive.
  // ...but base-interior-2 at 4K samples the plating at a faintly GREEN-grey
  // white, and our interior crop came back at R 116 / G 100 / B 96 against the
  // reference's 96 / 103 / 102 — a pink cast, because a warm bake was riding a
  // warm albedo. The bake stays warm (that contrast against the ocean is the
  // whole emotional point); the paint underneath it goes neutral.
  g.fillStyle = '#d8dad8'; g.fillRect(0, 0, S, S);

  // broad tonal drift so a 12 m wall is never one flat value. This is the ONE
  // place the sheet is allowed amplitude: it runs at 200-400 px, far below the
  // 32 px window tileContrast measures, so it reads as form rather than noise.
  for (let i = 0; i < 84; i++) {
    const x = rng() * S, y = rng() * S, r = 120 + rng() * 300;
    const v = rng();
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, v > 0.6 ? 'rgba(255,255,255,0.11)' : 'rgba(122,133,140,0.10)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // the plate lattice: two levels of jitter, drawn as rounded rects
  const rows = 2, cols = 2;
  const cw = S / cols, ch = S / rows;
  const rr = (x, y, w, h, rad) => {
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad);
    g.closePath();
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const jx = (rng() - 0.5) * 22, jy = (rng() - 0.5) * 16;
      const pad = 14 + rng() * 10;
      const x = i * cw + pad + jx, y = j * ch + pad + jy;
      const w = cw - pad * 2, h = ch - pad * 2;
      // plate body, faintly individual
      const tone = 212 + Math.floor(rng() * 16);
      g.fillStyle = `rgb(${tone + 2},${tone + 1},${tone})`;
      rr(x, y, w, h, 34); g.fill();
      // seam shadow + top highlight, both soft. A habitat panel gap is a
      // shadow, not a drawn line; at 85% alpha it was a stencil.
      g.strokeStyle = 'rgba(122,132,139,0.34)'; g.lineWidth = 3.4;
      rr(x, y, w, h, 34); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(x + 34, y + 2.2); g.lineTo(x + w - 34, y + 2.2); g.stroke();
      // bolt row, at a quarter of the old contrast
      g.fillStyle = 'rgba(140,149,155,0.26)';
      for (let b = 0; b < 5; b++) {
        const bx = x + 40 + b * ((w - 80) / 4);
        g.beginPath(); g.arc(bx, y + h - 22, 3.0, 0, TAU); g.fill();
      }
      // occasional inset detail plate or amber decal — rare, and no longer
      // near-black against near-white
      const k = rng();
      if (k < 0.30) {
        g.fillStyle = 'rgba(150,158,164,0.46)';
        rr(x + w * 0.60, y + h * 0.16, w * 0.28, h * 0.15, 12); g.fill();
        g.fillStyle = 'rgba(255,162,42,0.62)';
        for (let d = 0; d < 3; d++) {
          g.beginPath(); g.arc(x + w * 0.66 + d * 14, y + h * 0.235, 3.4, 0, TAU); g.fill();
        }
      } else if (k < 0.55) {
        g.fillStyle = 'rgba(255,162,42,0.42)';
        g.fillRect(x + 26, y + h * 0.52 - 3, w * 0.30, 5);
        g.fillStyle = 'rgba(146,155,161,0.40)';
        for (let d = 0; d < 5; d++) g.fillRect(x + 26 + d * 20, y + h * 0.52 + 14, 8, 14);
      }
    }
  }
  // fine grain — kills the plastic look without reading as noise. Halved: the
  // shader's seven-octave sfBroadband now owns the high frequencies, and two
  // uncorrelated grain fields stacked is just twice the detailRMS.
  const img = g.getImageData(0, 0, S, S), a = img.data;
  for (let i = 0; i < a.length; i += 4) {
    const n = (rng() - 0.5) * 6;
    a[i] += n; a[i + 1] += n; a[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return finish(c, true);
}

/**
 * Roughness (G) + metalness (B) for the plating. Painted composite, lightly
 * metallic.
 *
 * This map is now doing more work than it was, because core's surface injection
 * does NOT in fact vary roughness: SURFACE_FRAG declares `float sfRough`, hands
 * it to sfApply() as the out parameter and then drops it on the floor, since
 * UNDERWATER_FRAG runs after the whole PBR chain has already resolved. (Reported
 * in coreBugs.) A surface uniform in gloss reads as plastic however good its
 * colour is — LOOK.md is right about that — so the variation has to come from
 * here instead: two frequencies of roughness blotching, and a metalness that
 * tracks it inversely, because worn paint exposes metal and metal is smoother.
 */
function texPanelORM(rng) {
  const S = 512;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = 'rgb(0,108,36)'; g.fillRect(0, 0, S, S);
  // coarse: which parts of the plate are matte paint and which are polished
  for (let i = 0; i < 46; i++) {
    const x = rng() * S, y = rng() * S, r = 60 + rng() * 190;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const rough = 58 + Math.floor(rng() * 150);
    grd.addColorStop(0, `rgba(0,${rough},${Math.floor(150 - rough * 0.5)},0.62)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // fine: scuff and handling marks, tight and low contrast
  for (let i = 0; i < 300; i++) {
    const x = rng() * S, y = rng() * S, r = 8 + rng() * 46;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const rough = 80 + Math.floor(rng() * 110);
    grd.addColorStop(0, `rgba(0,${rough},${30 + Math.floor(rng() * 70)},0.34)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return finish(c, false);
}

/**
 * The cross-section of a lit fixture: a bright core with an analytic rolloff to
 * a dim edge, six discrete emitters per tile and a slow lengthwise ripple.
 *
 * Every self-lit thing in this module used to be a solid rectangle of emissive
 * well above 1.0 — lampWarm sat at 3.15 — which tonemaps to flat 255 and then
 * blooms. Measured: 5.45% of an interior wall crop at luminance >= 250 against
 * the reference frame's 0.00%, and 0.61% of the whole frame against
 * base-interior-1's 0.005%. A lamp has to be a FIXTURE with structure inside it,
 * not a blown white blob, so peak radiance came down by ~2x and what is left is
 * shaped by this map on both `map` and `emissiveMap`.
 */
function texGlow() {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    const t = Math.abs((y + 0.5) / S - 0.5) * 2;           // 0 core .. 1 edge
    const prof = 0.09 + 0.91 * Math.pow(1 - t, 1.9);       // analytic: nothing to band
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const seg = Math.abs(((u * 6) % 1) - 0.5) * 2;       // six emitters per tile
      const gap = 1 - 0.34 * sstep(0.68, 1.0, seg);
      const ripple = 0.93 + 0.07 * Math.sin(u * TAU * 6 + 1.1);
      const v = clamp01(prof * gap * ripple);
      const k = (y * S + x) * 4;
      // the texture is tagged sRGB, so encode: a linear ramp written straight
      // into 8-bit sRGB has its rolloff crushed into the last few percent
      d[k] = d[k + 1] = d[k + 2] = Math.round(255 * Math.pow(v, 1 / 2.2));
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, true);
}

/**
 * Deck plate. base-interior-3 shows a dark blue-grey hex lattice with a lighter
 * walkway inset and a cyan strip; that dark floor is what makes the white walls
 * read as white instead of grey.
 */
/**
 * Deck plate. base-interior-3's floor is a DARK blue-grey hex lattice whose
 * grout is barely separable from the tile — measured tileContrast 25.1-25.6
 * against our old 43.4-50.5, which is exactly the "repeating tiled texture with
 * visible grid frequency" tell LOOK.md 11.22 names.
 *
 * Two fixes, both structural rather than cosmetic:
 *  - A regular hexagon cannot tile a square texture: the row pitch is 1.5R and
 *    the column pitch is sqrt(3)R, whose ratio is irrational, so any S that
 *    divides one leaves a wedge seam in the other. That wedge was visibly
 *    crossing the room floor. The cells here are stretched a token 13% so both
 *    pitches divide S exactly and the sheet is genuinely periodic.
 *  - The grout is a soft 45%-alpha 2 px line rather than a hard 90% 3 px one,
 *    and each tile carries its own value so the eye reads plate variation
 *    instead of a stencil.
 */
function texFloor(rng) {
  const S = 512;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#4b5c69'; g.fillRect(0, 0, S, S);
  const COLS = 6, ROWS = 8;             // dx = S/6, 2*dy = S/4  -> exact period
  const dx = S / COLS, dy = S / ROWS;
  const rx = dx / Math.sqrt(3), ry = dy / 1.5;
  const hex = (cx, cy, k) => {
    g.beginPath();
    for (let n = 0; n < 6; n++) {
      const a = n * Math.PI / 3 + Math.PI / 6;
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      n ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
  };
  // per-tile value has to be a function of the WRAPPED cell index, not of the
  // draw order, or the row drawn at j = -1 disagrees with its twin at j = ROWS*2
  const tone = (i, j) => {
    const ii = ((i % COLS) + COLS) % COLS, jj = ((j % (ROWS * 2)) + ROWS * 2) % (ROWS * 2);
    const h = Math.sin(ii * 12.9898 + jj * 78.233) * 43758.5453;
    return h - Math.floor(h);
  };
  for (let j = -2; j <= ROWS * 2 + 2; j++) {
    for (let i = -2; i <= COLS + 2; i++) {
      const cx = i * dx + (((j % 2) + 2) % 2 ? dx / 2 : 0), cy = j * dy;
      const t = tone(i, j);
      const v = 104 + Math.floor(t * 15);
      g.fillStyle = `rgb(${v},${v + 7},${v + 13})`;
      hex(cx, cy, 0.94); g.fill();
      // Grout at 26% rather than 42%: this deck is a moulded composite mat, and
      // the whole sheet has to come down in contrast with the walls or the floor
      // alone carries the frame's tileContrast.
      g.strokeStyle = 'rgba(38,48,58,0.26)'; g.lineWidth = 1.7;
      hex(cx, cy, 0.94); g.stroke();
      // a soft top-left sheen on each plate, which is what stops a flat lattice
      // reading as a stencil rather than as metal
      g.strokeStyle = `rgba(190,208,220,${0.035 + t * 0.035})`; g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(cx - rx * 0.80, cy - ry * 0.44); g.lineTo(cx, cy - ry * 0.90);
      g.lineTo(cx + rx * 0.80, cy - ry * 0.44); g.stroke();
      // tread dots
      g.fillStyle = `rgba(160,180,194,${0.045 + t * 0.035})`;
      for (let d = 0; d < 3; d++) {
        g.beginPath();
        g.arc(cx + Math.cos(d * 2.1 + t) * rx * 0.34, cy + Math.sin(d * 2.1 + t) * ry * 0.34, 2.1, 0, TAU);
        g.fill();
      }
    }
  }
  // fine grain, again periodic-safe because it is per-pixel
  const img = g.getImageData(0, 0, S, S), a = img.data;
  for (let i = 0; i < a.length; i += 4) {
    const n = (rng() - 0.5) * 4;
    a[i] += n; a[i + 1] += n; a[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return finish(c, true);
}

/**
 * Leaf blade: a pale midrib, lateral veins and a soft edge darkening. The
 * blue-to-orange ramp lives in the geometry's vertex colours (see leafGeo), so
 * this stays a value/detail map and one texture serves every hue.
 */
function texLeaf(rng) {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#e8e6e0'; g.fillRect(0, 0, S, S);
  // v runs along the blade; the midrib is the vertical centreline
  g.strokeStyle = 'rgba(255,252,244,0.95)'; g.lineWidth = 7;
  g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.stroke();
  g.strokeStyle = 'rgba(120,110,92,0.30)'; g.lineWidth = 1.6;
  for (let k = 1; k < 16; k++) {
    const y = (k / 16) * S;
    const spread = 26 + Math.sin(k * 1.7) * 6;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(S / 2, y);
      g.quadraticCurveTo(S / 2 + s * spread * 0.6, y + 5, S / 2 + s * spread, y + 13);
      g.stroke();
    }
  }
  // edge darkening, so a blade seen flat-on still has a readable silhouette
  const grd = g.createLinearGradient(0, 0, S, 0);
  grd.addColorStop(0.0, 'rgba(40,44,38,0.55)');
  grd.addColorStop(0.16, 'rgba(40,44,38,0.0)');
  grd.addColorStop(0.84, 'rgba(40,44,38,0.0)');
  grd.addColorStop(1.0, 'rgba(40,44,38,0.55)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S), a = img.data;
  for (let i = 0; i < a.length; i += 4) {
    const n = (rng() - 0.5) * 14;
    a[i] += n; a[i + 1] += n; a[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = finish(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Brushed light trim — frames, rims, conduits, structural ribs. */
function texTrim(rng) {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  // Pale, because the tints that ride on it are already dark and the product of
  // the two was putting near-black conduits and ceiling housings across a white
  // corridor. base-interior-4's conduit runs are light grey, not black.
  g.fillStyle = '#b9c0c3'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const y = rng() * S, v = rng();
    g.strokeStyle = `rgba(${v > 0.5 ? 255 : 20},${v > 0.5 ? 255 : 24},${v > 0.5 ? 255 : 28},0.05)`;
    g.lineWidth = 0.6 + rng() * 1.4;
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y + (rng() - 0.5) * 4); g.stroke();
  }
  return finish(c, true);
}

/** Yellow/black hazard chevrons — the ladder shroud and deck edges. */
function texHazard() {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#f2b21c'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#20242a';
  g.save(); g.translate(S / 2, S / 2); g.rotate(-Math.PI / 4); g.translate(-S, -S);
  for (let i = 0; i < 8; i++) g.fillRect(i * S / 4, 0, S / 8, S * 2);
  g.restore();
  return finish(c, true);
}

/** The dark inset face of a console / fabricator screen, with holo bars. */
function texScreen(rng) {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = '#07202f'; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(111,223,255,0.55)'; g.lineWidth = 2;
  g.strokeRect(10, 10, S - 20, S - 20);
  g.fillStyle = 'rgba(111,223,255,0.9)';
  for (let i = 0; i < 7; i++) {
    const w = 30 + rng() * (S - 90);
    g.globalAlpha = 0.35 + rng() * 0.5;
    g.fillRect(24, 34 + i * 20, w, 7);
  }
  g.globalAlpha = 1;
  g.fillStyle = '#ffa22a';
  g.fillRect(24, S - 52, 64, 10);
  g.fillStyle = 'rgba(155,229,90,0.95)';
  for (let i = 0; i < 12; i++) g.fillRect(S - 44, S - 32 - i * 9, 20, 5);
  return finish(c, true);
}

/** A wall label plate, e.g. the LOCKER unit in base-interior-1. */
function texLabel(text) {
  const S = 256, H = 64;
  const { c, g } = canvas2d(S, H);
  g.fillStyle = '#0d1014'; g.fillRect(0, 0, S, H);
  g.fillStyle = '#e8f4f8';
  g.font = 'bold 30px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.letterSpacing = '6px';
  g.fillText(text, S / 2 - 16, H / 2 + 1);
  g.fillStyle = '#eaf6fb';
  g.beginPath(); g.arc(S - 26, 22, 4.5, 0, TAU); g.fill();
  g.beginPath(); g.arc(S - 26, 42, 4.5, 0, TAU); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ============================================================== materials
//
// Two families. EXTERIOR sits in the full medium like every other object in the
// world. INTERIOR goes through applyUnderwater(mat, { caustics: 0, fogScale: 0.2 })
// AND carries the baked interior-light attribute, because a dry volume must not
// inherit either the ocean's caustics or its depth response.

const MATS = {};

/**
 * Wrap core's shader injection instead of replacing it, and add a per-vertex
 * self-lit term to totalEmissiveRadiance.
 *
 * core deliberately exempts emissive from `mix(0.06, 1, sunT.b) * uDepthDarken`
 * — that exemption is the only channel through which a lamp inside a habitat can
 * survive being 30 m down at night. applyUnderwater() owns onBeforeCompile, so
 * we capture its closure and call it first; the customProgramCacheKey has to
 * change too or three hands us the un-patched program from its cache.
 */
function bakeInject(mat, litMix) {
  const uLitMix = { value: litMix ?? 1.0 };
  mat.userData.uwLitMix = uLitMix;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    const vs = shader.vertexShader, fs = shader.fragmentShader;
    if (!vs.includes('#include <common>') || !fs.includes('#include <emissivemap_fragment>')) return;
    shader.uniforms.uBakeLevel = BAKE_LEVEL;
    shader.uniforms.uBakeTint = BAKE_TINT;
    shader.uniforms.uLitMix = uLitMix;
    shader.vertexShader = vs
      .replace('#include <common>', '#include <common>\nattribute vec3 aBake;\nvarying vec3 vBake;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBake = aBake;');
    let f = fs
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vBake;\nuniform float uBakeLevel;\nuniform vec3 uBakeTint;\nuniform float uLitMix;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vBake * diffuseColor.rgb * uBakeLevel * uBakeTint;');
    // uLitMix < 1 unplugs the shared scene lighting from a surface. Inside a
    // sealed hull that is not an approximation, it is the correction: the world
    // hemisphere is authored teal (uAmbientTop), and core multiplies every light
    // contribution by the OCEAN's depth response, so a habitat wall was being lit
    // by the water outside it — measured 3x too dark, 3-7x too saturated by day
    // and collapsing 14.5x at nightfall in a base reporting full power.
    if (f.includes('#include <lights_fragment_end>')) {
      f = f.replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n'
        + '  reflectedLight.directDiffuse    *= uLitMix;\n'
        + '  reflectedLight.indirectDiffuse  *= uLitMix;\n'
        + '  reflectedLight.directSpecular   *= mix(0.32, 1.0, uLitMix);\n'
        + '  reflectedLight.indirectSpecular *= mix(0.32, 1.0, uLitMix);\n');
    }
    shader.fragmentShader = f;
  };
  /**
   * COMPOSE the key, never replace it. applyUnderwater() warns about this and
   * we were doing exactly what it warns against: every material in the module
   * returned the constant 'uw-basebake', so three's program cache — which keys
   * on that string plus a fixed set of material booleans, and NOT on the shader
   * text onBeforeCompile produced — handed the first-compiled program to every
   * later material that happened to match those booleans. That was invisible
   * while all base materials injected identical GLSL. It stops being invisible
   * the moment some of them ask for surface microstructure and others do not,
   * because `#define UW_SURFACE` lives in the source and not in the key: the
   * hull would have silently rendered with the interior's program or vice versa.
   */
  const priorKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () =>
    'basebake|' + (priorKey ? priorKey.call(mat) : mat.type || '');
  mat.needsUpdate = true;
  return mat;
}

/**
 * How much open-water fog an interior surface takes. Driven per frame from
 * whether the camera is standing in the habitat:
 *   inside  -> ~0, because the path from the eye to that wall is AIR
 *   outside -> ~0.85, because you are reading it through the ocean and a lit
 *              room seen from the water must fog like everything else
 * The brief's flat 0.2 could not satisfy both, and it is the outside case that
 * "the base glows warm from its viewports" (night-shallows-1) depends on.
 */
const IN_FOG = 0.045, OUT_FOG = 0.85;
let insideT = 0;

/**
 * Surface microstructure, per material family.
 *
 * Amplitudes are deliberately below what looks like "texture" in isolation.
 * The brief for this round is measured, not aesthetic: an interior wall crop of
 * ours scored tileContrast 43.62 / detailRMS 21.99 against base-interior-1's
 * 10.91 / 9.50, so the job is to REMOVE hard-edged decal contrast and replace a
 * fraction of it with seven-octave broadband that has no characteristic
 * frequency. Everything below whispers on purpose.
 *
 * `streak` is gravity — biofilm and rust run DOWN a hull that has sat in the sea
 * for years. It belongs on the exterior and on nothing inside a dry, pressurised
 * volume, so every interior family carries a token amount at most (dust settles;
 * it does not run).
 */
const SURF = {
  wall:    { grain: 0.045, wear: 0.26, streak: 0.05, scale: 1.7 },  // painted composite panel
  trim:    { grain: 0.030, wear: 0.42, streak: 0.04, scale: 0.8 },  // brushed metal
  deck:    { grain: 0.062, wear: 0.55, streak: 0.00, scale: 1.1 },  // rubber-composite matting
  hazard:  { grain: 0.055, wear: 0.62, streak: 0.00, scale: 0.6 },  // trodden paint on tread
  accent:  { grain: 0.040, wear: 0.46, streak: 0.05, scale: 1.0 },  // painted steel
  // Hull grain runs FINER and slightly stronger than the interior families, and
  // that is a measurement, not a preference: after the first pass the hull crop
  // came back with tileContrast 22.3 against the reference's 19.3 but detailRMS
  // 13.7 against 18.4 — too much mid-frequency (big bands and big plates), too
  // little fine. Dropping `scale` moves signal from the 32 px window the tile
  // metric samples into the laplacian the detail metric samples.
  hull:    { grain: 0.105, wear: 0.55, streak: 0.42, scale: 1.7 },  // exterior skin
  hullTrim:{ grain: 0.085, wear: 0.64, streak: 0.52, scale: 1.1 },  // exterior ironmongery
  organic: { grain: 0.090, wear: 0.30, streak: 0.08, scale: 0.7 },
};

/** Interior surface: dry-volume fog, no caustics, bake-lit, world lighting unplugged. */
function interiorMat(m, surface) {
  // depthResponse: a sealed pressurised volume does not care how much ocean is
  // stacked above its roof. litMix already unplugs most of the scene lighting;
  // this keeps the specular lobe that survives from collapsing with depth too.
  applyUnderwater(m, { caustics: 0, fogScale: OUT_FOG, depthResponse: 0.15, surface });
  return bakeInject(m, 0.07);
}
/** Exterior hull: full medium, no caustics (a habitat skin is not a seabed). */
function exteriorMat(m, caustics = 0.35, surface, depthResponse) {
  applyUnderwater(m, { caustics, surface, depthResponse });
  return bakeInject(m, 1.0);
}

/**
 * How much of the ocean's depth response a MANUFACTURED, self-floodlit hull
 * takes. 1.0 is the default and it is what made the exterior "a flat cyan ghost
 * with no thickness": measured on the shallows-reef framing, our hull crop had a
 * 1st-percentile luminance of 99.9 against the reference base in
 * shallows-reef-3.jpg at 71.2, and a median of 141 against 126. Every value in
 * the hull sat in the top half of the range, converged on the fog colour, with
 * nothing dark anywhere — and darkness is what thickness is made of.
 *
 * Two things fix that together, and neither works alone: this, which stops the
 * lit half being crushed toward the fog value, and the sky-occlusion term in
 * exteriorShade() which drives the unlit half down. This is a painted hull under
 * its own floods 30 m down; it is not licence to glow at 300 m, where the sun
 * term inside mix(0.06, 1, sunT.b) is doing the work anyway.
 *
 * 0.55 was the first pass and it undershot: with sky occlusion also in play the
 * hull crop landed at p1 81.5 / median 110.1 against the reference's 71.2 /
 * 126.1 — the darks were nearly right but the whole skin had gone dim, and the
 * red channel with it (24.9 against 41.3, because red in a hull crop is the
 * object's own reflected light and nothing else; the fog has none to lend).
 * 0.34 puts the lit half back where the reference has it without touching the
 * shadowed half, which is exactly the range the module was missing.
 */
const HULL_DEPTH_RESPONSE = 0.34;

/** The shared-medium uniform bundle, for this module's own ShaderMaterials. */
function mediumUniforms(extra = {}) {
  return {
    uTime: U.uTime, uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor,
    uFogColor: U.uFogColor, uScatterColor: U.uScatterColor, uScatterStrength: U.uScatterStrength,
    uAbsorption: U.uAbsorption, uMaxVisibility: U.uMaxVisibility, uSkyAtten: U.uSkyAtten,
    uScatterG: U.uScatterG, uGainChroma: U.uGainChroma, uCausticsTex: U.uCausticsTex,
    uCausticsScale: U.uCausticsScale, uCausticsStrength: U.uCausticsStrength,
    uCausticsSpeed: U.uCausticsSpeed, uDepthDarken: U.uDepthDarken, uWaterLevel: U.uWaterLevel,
    uUnderwater: U.uUnderwater, uMatCaustics: { value: 0 }, uMatFogScale: { value: 1 },
    ...extra,
  };
}

/**
 * Fresnel sheen on the observatory glazing. A blind A/B caught the dome for
 * "no glass reading at all — no sheen, no interior reflection, no pane frames,
 * it reads as open water behind brown ribs". A pane at 10% opacity is honest
 * about transmission and says nothing about the surface, and a specular lobe
 * from the shared scene lights is worth almost nothing 30 m down. So the surface
 * term is authored: grazing angles pick up a cold rim, and a broad smeared
 * highlight sits where the interior lamps would reflect off the inside face.
 */
function glassSheen(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    const fs = shader.fragmentShader;
    if (!fs.includes('#include <emissivemap_fragment>')) return;
    shader.uniforms.uBakeLevel = BAKE_LEVEL;
    shader.fragmentShader = fs
      .replace('#include <common>', '#include <common>\nuniform float uBakeLevel;')
      .replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      {
        vec3 gN = normalize(vUwWorldNormal);
        vec3 gV = normalize(uCamPos - vUwWorldPos);
        float gF = pow(1.0 - clamp(abs(dot(gN, gV)), 0.0, 1.0), 3.4);
        // rim: the pane edge you actually see when you stand inside a dome
        totalEmissiveRadiance += vec3(0.30, 0.62, 0.76) * gF * 1.55;
        diffuseColor.a = clamp(diffuseColor.a + gF * 0.42, 0.0, 0.92);
        // a slow smeared reflection of the room's own lamp band, so the glass
        // has a surface even where it is looking at black water
        float gS = smoothstep(0.55, 1.0, sin(vUwWorldPos.y * 2.7 + uTime * 0.05) * 0.5 + 0.5);
        totalEmissiveRadiance += vec3(0.90, 0.86, 0.80) * gS * gF * uBakeLevel * 0.85;
      }`);
  };
  // compose, do not replace — see the note in bakeInject()
  const priorKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () =>
    'baseglass|' + (priorKey ? priorKey.call(mat) : mat.type || '');
  mat.needsUpdate = true;
  return mat;
}

/**
 * Soft camera-facing additive glow. Used for light spilling out of a port, for
 * the wash under a hatch lamp, and for the mist at a breach. No texture, so
 * there is no gradient to band; no world-aligned quad, so nothing can be caught
 * edge-on painting an ellipse across the module behind it.
 *
 * It takes uwTransmittance from the shared medium — a lamp seen through 25 m of
 * water has to lose its red like everything else — but deliberately NOT
 * uwInscatter: an additive element that adds the fog term deposits a solid
 * fog-coloured rectangle, and the water column behind it already contributed it.
 */
function makeGlowMat() {
  return new THREE.ShaderMaterial({
    uniforms: mediumUniforms(),
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec2 aOff;
      attribute float aSize;
      attribute vec3 color;
      varying vec2 vOff;
      varying vec3 vCol;
      varying float vDist;
      #include <common>
      ${UNDERWATER_PARS}
      void main() {
        vOff = aOff; vCol = color;
        vUwWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vUwWorldNormal = vec3(0.0, 1.0, 0.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        mv.xy += aOff * aSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vOff;
      varying vec3 vCol;
      varying float vDist;
      #include <common>
      ${UNDERWATER_PARS}
      void main() {
        float d = length(vOff);
        if (d > 1.0) discard;
        float a = 1.0 - d;
        a = a * a * a * (0.55 + 0.45 * a);     // analytic, so no gradient stops to band
        vec3 T = mix(vec3(1.0), uwTransmittance(max(vDist, 0.0)), uUnderwater);
        gl_FragColor = vec4(vCol * a * T, 1.0);
      }`,
  });
}

/**
 * The surface of the water flooding a breached compartment.
 *
 * The old one was a flat opaque plate at constant y — "reads as UI, not water",
 * and a critic is right that a bar spanning the frame with no meniscus and no
 * angular response is the giveaway. This one is a real interface: Gerstner-ish
 * ripples with analytic normals, Fresnel opacity so looking down through it is
 * clear and looking along it is a mirror, a bright meniscus where it wets the
 * hull, and the biome's own water colour underneath rather than an authored
 * teal. aRim (0 at the compartment centre, 1 at the wall) carries the meniscus.
 */
function makeFloodMat() {
  return new THREE.ShaderMaterial({
    uniforms: mediumUniforms({ uFloodLit: { value: new THREE.Color(1, 1, 1) } }),
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aRim;
      varying float vRim;
      varying vec3 vWP;
      #include <common>
      ${UNDERWATER_PARS}
      void main() {
        vRim = aRim;
        vec3 p = position;
        vec2 q = (modelMatrix * vec4(p, 1.0)).xz;
        float w = sin(q.x * 2.10 + uTime * 1.7) * 0.016
                + sin(q.y * 2.90 - uTime * 1.3) * 0.012
                + sin((q.x + q.y) * 1.30 + uTime * 0.9) * 0.020;
        p.y += w * (1.0 - vRim * 0.55);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWP = wp.xyz;
        vUwWorldPos = wp.xyz;
        vUwWorldNormal = vec3(0.0, 1.0, 0.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying float vRim;
      varying vec3 vWP;
      uniform vec3 uFloodLit;
      #include <common>
      ${UNDERWATER_PARS}
      void main() {
        // analytic normal from the same field the vertex stage displaced with
        float dx = cos(vWP.x * 2.10 + uTime * 1.7) * 2.10 * 0.016
                 + cos((vWP.x + vWP.z) * 1.30 + uTime * 0.9) * 1.30 * 0.020;
        float dz = cos(vWP.z * 2.90 - uTime * 1.3) * 2.90 * -0.012
                 + cos((vWP.x + vWP.z) * 1.30 + uTime * 0.9) * 1.30 * 0.020;
        vec3 N = normalize(vec3(-dx, 1.0, -dz));
        vec3 V = normalize(uCamPos - vWP);
        float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 3.6);

        // Deep is the biome's own water; the grazing reflection is the ROOM's
        // light, not the ocean's — this water is indoors and what it mirrors is
        // a white ceiling.
        vec3 deep = uFogColor * 0.42;
        vec3 skin = mix(deep, uFloodLit * 0.62, fres);
        // meniscus: water climbs the hull and catches the room lights there
        float men = smoothstep(0.86, 1.0, vRim);
        skin += uFloodLit * men * 0.40;
        // glints where a ripple face turns toward a ceiling lamp
        float glint = pow(clamp(N.y * 0.5 + dot(N, normalize(vec3(0.3, 0.9, 0.2))) * 0.5, 0.0, 1.0), 26.0);
        skin += uFloodLit * glint * 0.75;

        float a = mix(0.26, 0.70, fres) + men * 0.22;
        gl_FragColor = vec4(skin, clamp(a, 0.0, 0.86));
      }`,
  });
}

function buildMaterials(rng) {
  const panel = texPanel(rng.fork(1));
  const panelORM = texPanelORM(rng.fork(2));
  const floor = texFloor(rng.fork(3));
  const trim = texTrim(rng.fork(4));
  const hazard = texHazard();
  const screen = texScreen(rng.fork(5));
  const leafTex = texLeaf(rng.fork(6));
  const glowTex = texGlow();
  MATS._tex = { panel, panelORM, floor, trim, hazard, screen, leaf: leafTex, glow: glowTex };

  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });

  // ---- interior
  //
  // A blind pair called our fittings "flat untextured white boxes", and the
  // reason they were is that seven of the nine surfaces in a room shared one
  // shading response: roughness within 0.2 of each other, no roughness map
  // except on the walls, and the same albedo sheet on all of them. Painted
  // composite, brushed metal, rubber matting, trodden tread paint and glass have
  // to disagree with each other under the same lamp, or the room is one object.
  MATS.wallIn = interiorMat(std({
    color: 0xffffff, map: panel, roughnessMap: panelORM, metalnessMap: panelORM,
    roughness: 1.0, metalness: 0.85,
  }), SURF.wall);
  // brushed metal: markedly glossier and much more metallic than the walls
  MATS.trimIn = interiorMat(std({ color: 0xffffff, map: trim, roughness: 0.34, metalness: 0.88 }), SURF.trim);
  // deck matting: near-dielectric and nearly matte, so it never picks up the
  // ceiling strip the way the trim beside it does
  MATS.floorIn = interiorMat(std({ color: 0xffffff, map: floor, roughness: 0.94, metalness: 0.04 }), SURF.deck);
  MATS.hazardIn = interiorMat(std({ color: 0xffffff, map: hazard, roughness: 0.72, metalness: 0.06 }), SURF.hazard);
  MATS.screenIn = interiorMat(std({
    color: 0x1a2a33, map: screen, emissiveMap: screen,
    emissive: new THREE.Color(0.34, 0.66, 0.86), roughness: 0.14, metalness: 0.0,
  }), SURF.trim);
  // Painted orange accent — the one warm hue in a white room (base-interior-2/-3).
  MATS.accentIn = interiorMat(std({ color: 0xffffff, roughness: 0.46, metalness: 0.08 }), SURF.accent);

  // ---- exterior
  MATS.wallOut = exteriorMat(std({
    color: 0xffffff, map: panel, roughnessMap: panelORM, metalnessMap: panelORM,
    roughness: 1.0, metalness: 0.85,
  }), 0.35, SURF.hull, HULL_DEPTH_RESPONSE);
  MATS.trimOut = exteriorMat(std({ color: 0xffffff, map: trim, roughness: 0.44, metalness: 0.86 }),
    0.35, SURF.hullTrim, HULL_DEPTH_RESPONSE);
  MATS.accentOut = exteriorMat(std({ color: 0xffffff, roughness: 0.52, metalness: 0.14 }),
    0.35, SURF.hullTrim, HULL_DEPTH_RESPONSE);

  /**
   * Glass. NOT additive and NOT MeshBasicMaterial: core's injection ends with
   * rgb * T + inscatter on every fragment regardless of alpha, so an additive
   * pane deposits a flat fog-coloured rectangle; and applyUnderwater() fails to
   * compile against meshbasic (objectNormal is undeclared there). A very low
   * opacity keeps the ocean readable through it while the rim and the smeared
   * reflection still say "there is a pane here".
   *
   * Standard, not Physical, and ONE surface rather than a pane with thickness:
   * an observatory fills most of the frame, and every extra transparent layer
   * is a full-screen PBR + medium evaluation. Two layers of physical glass cost
   * more frame time here than the entire rest of the base.
   */
  MATS.glass = new THREE.MeshStandardMaterial({
    color: 0xa8dfec, roughness: 0.05, metalness: 0.0,
    transparent: true, opacity: 0.10, side: THREE.DoubleSide, vertexColors: true,
  });
  applyUnderwater(MATS.glass, { caustics: 0, fogScale: OUT_FOG, surface: 'glass' });
  glassSheen(MATS.glass);

  // ---- self-lit.
  //
  // Emissive is exempt from the depth response, so these are authored at their
  // true radiance rather than pre-multiplied by 1/depthDarken — but "true
  // radiance" was being read as licence to sit at 3.15, which tonemaps to flat
  // 255 across the whole fitting and then blooms. Measured: 5.45% of an interior
  // crop at luminance >= 250 against the reference's 0.00%. Peaks are roughly
  // halved here and every strip now carries texGlow() on `emissiveMap`, so the
  // fixture has a bright core, six discrete emitters and an analytic rolloff to
  // a dim edge instead of being a rectangle of clipped white. The ROOM does not
  // get darker for it: the walls are lit by the per-vertex bake, not by this.
  const emis = (r, g, b, extra = {}) => interiorMat(new THREE.MeshStandardMaterial({
    color: 0x0a0d0f, emissive: new THREE.Color(r, g, b), emissiveMap: glowTex, map: glowTex,
    roughness: 0.4, metalness: 0.0, vertexColors: true, ...extra,
  }), SURF.trim);
  // Habitat strip lighting is NEUTRAL. The old 3.30/3.05/2.55 was 23% saturated
  // and, being the only thing left in frame after dark, it bloomed a salmon wash
  // over every unlit surface — measured sat 0.44-0.56 with red dominant on a
  // deck that should have been reading its own value.
  MATS.lampWarm = emis(1.60, 1.585, 1.53);          // ceiling strips: warm white
  MATS.lampCyan = emis(0.30, 1.10, 1.52);          // trim strips / holo edges
  MATS.lampAmber = emis(1.55, 0.70, 0.15);         // status + hazard indicators
  MATS.lampGreen = emis(0.24, 1.34, 0.42);         // O2 / power OK
  MATS.lampRed = emis(1.58, 0.19, 0.11);           // alarms, breaches
  // Seen from OUTSIDE through a port: pre-brightened, because it is being read
  // through several metres of medium that has already killed the red. 7.4 was
  // three stops past what survives that path — it produced the blown white specks
  // a whole-game critic counted on the hull — so it comes down to a value that
  // still reads warm at 45 m and no longer clips at 5.
  MATS.portGlow = exteriorMat(new THREE.MeshStandardMaterial({
    color: 0x0a0d0f, emissive: new THREE.Color(2.95, 2.05, 1.34),
    emissiveMap: glowTex, map: glowTex,
    roughness: 0.4, metalness: 0.0, vertexColors: true,
  }), 0, null, HULL_DEPTH_RESPONSE);
  MATS.plant = interiorMat(std({
    color: 0xffffff, roughness: 0.68, metalness: 0.0,
    emissive: new THREE.Color(0.06, 0.11, 0.05),
  }), SURF.organic);
  // Leaves are double-sided and mildly self-lit: a blade in base-interior-1 is
  // translucent, so its shaded half is never as dark as an opaque surface would
  // be, and the underside reads at all.
  MATS.leaf = interiorMat(std({
    color: 0xffffff, map: leafTex, roughness: 0.58, metalness: 0.0,
    side: THREE.DoubleSide, emissive: new THREE.Color(0.10, 0.13, 0.09),
  }));
  MATS.fruit = emis(1.42, 0.52, 0.14);
  // Potting medium, not a hole. 0x3a2b21 read as a black void inside a white
  // planter under a bake that only reaches its rim — it is the single darkest
  // thing in the observatory and a blind pair named the planters. Lighter, and
  // rough enough that it never picks up a highlight.
  MATS.soil = interiorMat(std({ color: 0x6b5340, roughness: 0.98, metalness: 0.0 }), SURF.organic);

  MATS.spill = makeGlowMat();
  MATS.leak = makeGlowMat();
  MATS.flood = makeFloodMat();

  // Build ghost — deliberately NOT part of the medium; it is a holographic
  // projection from the builder, not a physical object in the water.
  MATS.ghostOk = new THREE.MeshBasicMaterial({
    color: 0x5fd8ff, transparent: true, opacity: 0.26,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  MATS.ghostBad = new THREE.MeshBasicMaterial({
    color: 0xf0553c, transparent: true, opacity: 0.26,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  MATS.ghostWire = new THREE.MeshBasicMaterial({
    color: 0xa8ecff, wireframe: true, transparent: true, opacity: 0.55,
    depthWrite: false, toneMapped: false,
  });
}

// keys that go into the interior/exterior batch sets ('spill' is a GlowBatch and
// is merged separately, because its vertices are billboard corners not surfaces)
const BATCH_KEYS = [
  'wallIn', 'trimIn', 'floorIn', 'hazardIn', 'screenIn', 'accentIn',
  'wallOut', 'trimOut', 'accentOut', 'glass',
  'lampWarm', 'lampCyan', 'lampAmber', 'lampGreen', 'lampRed', 'portGlow',
  'plant', 'leaf', 'fruit', 'soil',
];
const INTERIOR_KEYS = new Set([
  'wallIn', 'trimIn', 'floorIn', 'hazardIn', 'screenIn', 'accentIn',
  'lampWarm', 'lampCyan', 'lampAmber', 'lampGreen', 'lampRed',
  'plant', 'leaf', 'fruit', 'soil',
]);
/** Interior materials whose view-ray fog follows the camera in/out of the hull. */
const FOG_SWITCH_KEYS = [...INTERIOR_KEYS, 'glass'];

// tints, in LINEAR space, applied through vertex colour
const TINT = {
  white: linHex(0xffffff),
  hull: linHex(0xf0f3f4),
  hullDim: linHex(0xd2d8da),
  grey: linHex(0xbfc6ca),
  dark: linHex(0x4a555d),
  darker: linHex(0x28313a),
  // Thickness is darkness. The reference hull in shallows-reef-3.jpg reaches a
  // 1st-percentile luminance of 71 inside its own silhouette, ours reached 99.9
  // — there was simply no dark value anywhere on the exterior, which is what
  // "flat cyan ghost with no thickness" means. These two tints exist to be the
  // shadow inside a seam, a window reveal and a port recess.
  void_: linHex(0x141a1f),
  shadow: linHex(0x2f3941),
  // Green raised from 0x7a to 0x92: at 0xf07a1e the linear triple is
  // (0.77, 0.19, 0.014), and once the medium has finished with what little green
  // is left the deck kick-strip reads CRIMSON rather than as Alterra's orange.
  // base-interior-2/-3 put this hue on the fabricator and the growbed rims and
  // it is unmistakably orange there.
  orange: linHex(0xef921e),
  amber: linHex(0xffa22a),
  steel: linHex(0xa3aeb4),
  glassT: linHex(0xbfe8f2),
  leaf: linHex(0x86a24c),
  leafBlue: linHex(0x4e7fa8),
  // leafGeo already carries the blue-to-orange ramp in its vertex colours, so
  // the tints that ride on it must be near-white or they crush the ramp flat
  leafPale: linHex(0xd8d2c4),
  bark: linHex(0x6a4a34),
  yellow: linHex(0xf2b21c),
  // leafGeo's own vertex ramp runs blue at the stalk to orange at the tip — the
  // lantern tree's colours. A growbed needs green sprouts, and TINT.leaf was the
  // wrong tool: it is dark, and multiplying a dark green through a ramp whose
  // base is (0.10, 0.30, 0.92) gave blades that measured near-black. A PALE
  // green-white lifts the ramp's green without crushing it.
  sprout: linHex(0xdae4bc),
};

// ============================================================== emit context

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Local transform helper: position / euler / scale -> Matrix4. */
function xf(p, r, s) {
  const m = new THREE.Matrix4();
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _q.setFromEuler(_e);
  const sv = typeof s === 'number' ? _v2.set(s, s, s)
    : s ? _v2.set(s[0], s[1], s[2]) : _v2.set(1, 1, 1);
  m.compose(_v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0), _q, sv);
  return m;
}

/** Everything a piece's build() needs: emit geometry, register a lamp. */
class Emit {
  constructor(batches, lamps, world, lampsOut, glows) {
    this.b = batches; this.lamps = lamps; this.world = world;
    this.lampsOut = lampsOut || []; this.glows = glows || null;
    this._t = new THREE.Matrix4();
  }
  /** g(materialKey, geometry, {p,r,s,tint,uv}) — local space, composed with the piece matrix. */
  g(key, geo, o = {}) {
    if (!geo) return;
    const local = (o.m) ? o.m : xf(o.p, o.r, o.s);
    this._t.multiplyMatrices(this.world, local);
    (this.b[key] || this.b.trimIn).add(geo, this._t, o.tint || TINT.white, o.uv);
  }
  /** A baked interior light source, in LOCAL coordinates. */
  lamp(p, col, power, radius) {
    _v.set(p[0], p[1], p[2]).applyMatrix4(this.world);
    this.lamps.push({ x: _v.x, y: _v.y, z: _v.z, c: col, p: power, r: radius });
  }
  /**
   * A hull-mounted exterior flood, baked onto the OUTSIDE skin. Real stations
   * light their own hulls (night-shallows-1/-2, misc-6), and without it a
   * corridor 12 m from the eye resolves to bare medium while the junction 3 m
   * away is still white — same material, same frame, and a critic measured the
   * pair at #1e4a52 against white.
   */
  lampX(p, col, power, radius) {
    _v.set(p[0], p[1], p[2]).applyMatrix4(this.world);
    this.lampsOut.push({ x: _v.x, y: _v.y, z: _v.z, c: col, p: power, r: radius });
  }
  /** A soft camera-facing glow, LOCAL coordinates, radius in metres. */
  glow(p, radius, col) {
    if (!this.glows) return;
    _v.set(p[0], p[1], p[2]).applyMatrix4(this.world);
    this.glows.add([_v.x, _v.y, _v.z], radius, col);
  }
}

/** Resample a {r,y} polyline to n+1 evenly-arc-spaced points, for shell profiles. */
function resample(pts, n) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].r - pts[i - 1].r, pts[i].y - pts[i - 1].y);
    seg.push(d); total += d;
  }
  const out = [];
  for (let k = 0; k <= n; k++) {
    let want = (k / n) * total, i = 0;
    while (i < seg.length - 1 && want > seg[i]) { want -= seg[i]; i++; }
    const t = seg[i] > 1e-6 ? want / seg[i] : 0;
    out.push({ r: lerp(pts[i].r, pts[i + 1].r, t), y: lerp(pts[i].y, pts[i + 1].y, t) });
  }
  return out;
}

/**
 * A lanceolate leaf blade, +Z along its length.
 *
 * base-interior-1's lantern tree is ~40 veined translucent blades running blue
 * at the base to orange at the tip, each folded along a midrib so it catches a
 * highlight down one half and shades the other. Ours were 14 flat solid-colour
 * lozenges, and a blind A/B named them as the single loudest giveaway in the
 * frame. The fold and the ramp are baked into the geometry (position + vertex
 * colour) so one cached blade serves every leaf and the piece tint still shifts
 * the whole plant's hue.
 */
const _leafCache = {};
function leafGeo(seg = 8, droopK = 0.30, foldK = 0.20) {
  const key = `${seg}_${droopK}_${foldK}`;
  if (_leafCache[key]) return _leafCache[key];
  const COLS = 5;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const base = [0.10, 0.30, 0.92];      // cool blue at the stalk
  const mid = [0.46, 0.66, 0.24];       // green through the middle
  const tip = [1.00, 0.44, 0.06];       // warm orange at the point
  for (let j = 0; j <= seg; j++) {
    const t = j / seg;
    // lanceolate: pinched at the stalk, widest around a third along, a point
    const w = Math.sin(Math.pow(t, 0.52) * Math.PI) * (1 - t * 0.10);
    const drop = -droopK * t * t;
    const ramp = t < 0.5
      ? [lerp(base[0], mid[0], t * 2), lerp(base[1], mid[1], t * 2), lerp(base[2], mid[2], t * 2)]
      : [lerp(mid[0], tip[0], (t - 0.5) * 2), lerp(mid[1], tip[1], (t - 0.5) * 2), lerp(mid[2], tip[2], (t - 0.5) * 2)];
    for (let i = 0; i < COLS; i++) {
      const u = (i / (COLS - 1)) * 2 - 1;
      const fold = (1 - Math.abs(u)) * foldK * w;
      pos.push(u * w * 0.5, drop + fold, t);
      nor.push(u * 0.45, 1, 0);            // replaced by computeVertexNormals
      uv.push(u * 0.5 + 0.5, t);
      // the midrib itself is pale, which is what makes a leaf read as a leaf
      const rib = 1 + (1 - Math.abs(u)) * 0.16;
      col.push(ramp[0] * rib, ramp[1] * rib, ramp[2] * rib);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < COLS - 1; i++) {
      const a = j * COLS + i, b = a + 1, c2 = a + COLS, d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  _leafCache[key] = g;
  return g;
}

/** A drooping bell fruit with a bright tip — the lantern tree's lanterns. */
let _fruitGeo = null;
function fruitGeo() {
  if (_fruitGeo) return _fruitGeo;
  const prof = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    // narrow stem, swelling belly, drawn to a point at the bottom
    const r = Math.sin(Math.pow(t, 0.8) * Math.PI) * 0.5 + (1 - t) * 0.06;
    prof.push(new THREE.Vector2(Math.max(0.012, r), 1 - t));
  }
  _fruitGeo = new THREE.LatheGeometry(prof, 10);
  _fruitGeo.translate(0, -1, 0);      // hangs BELOW its anchor, like a lantern
  _fruitGeo.computeVertexNormals();
  return _fruitGeo;
}

/** A rounded rectangular frame with a hole — window bezels and hatch surrounds. */
function roundedFrame(w, h, r, depth, border) {
  const mk = (W, H, R) => {
    const s = new THREE.Path();
    const x = -W / 2, y = -H / 2;
    R = Math.min(R, W / 2 - 1e-3, H / 2 - 1e-3);
    s.moveTo(x + R, y);
    s.lineTo(x + W - R, y); s.quadraticCurveTo(x + W, y, x + W, y + R);
    s.lineTo(x + W, y + H - R); s.quadraticCurveTo(x + W, y + H, x + W - R, y + H);
    s.lineTo(x + R, y + H); s.quadraticCurveTo(x, y + H, x, y + H - R);
    s.lineTo(x, y + R); s.quadraticCurveTo(x, y, x + R, y);
    return s;
  };
  const outer = new THREE.Shape(mk(w, h, r).getPoints(8));
  outer.holes.push(mk(w - border * 2, h - border * 2, Math.max(0.02, r - border)));
  const g = new THREE.ExtrudeGeometry(outer, {
    depth, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

// ============================================================== the catalogue
//
// Local frame for every piece: the deck plane is y = 0 and the primary axis is
// +Z. Sockets are declared in that frame; the placement code aligns a socket of
// the ghost with a free socket of an existing piece.

const DIRS = {
  '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0],
};

/**
 * A hull-mounted exterior flood: a small housing, a hot lens, a soft billboard
 * wash, and a baked lamp on the outer skin. p/n are LOCAL position and outward
 * normal; the pod stands off the skin so it grazes rather than blows out.
 *
 * The lens is deliberately RECESSED into a dark shroud now. A bare emissive disc
 * standing proud of a hull is a 4 px blob at 45 m and it clipped; a lens sunk in
 * a cowl reads as a fitting from every angle and its own shroud is the dark
 * value that makes the pod legible in the first place.
 */
function hullFlood(c, p, n, power = 1.0) {
  const q = new THREE.Quaternion().setFromUnitVectors(_v.set(0, 1, 0), _v2.set(n[0], n[1], n[2]).normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1));
  c.g('trimOut', G.cyl(0.13, 0.17, 0.18, 10), { m, tint: TINT.steel });
  c.g('trimOut', G.cyl(0.115, 0.115, 0.10, 10, true), {
    m: new THREE.Matrix4().multiplyMatrices(m, xf([0, 0.11, 0])), tint: TINT.void_,
  });
  c.g('portGlow', G.cyl(0.072, 0.072, 0.04, 10), {
    m: new THREE.Matrix4().multiplyMatrices(m, xf([0, 0.085, 0])),
  });
  // the light lands DOWN the hull, not out into the water
  c.lampX([p[0] + n[0] * 0.35, p[1] + n[1] * 0.35, p[2] + n[2] * 0.35],
    [1.0, 0.95, 0.88], power, 4.6);
  c.glow([p[0] + n[0] * 0.16, p[1] + n[1] * 0.16, p[2] + n[2] * 0.16], 0.30, [0.60, 0.46, 0.36]);
}

/**
 * A HULL COURSE SEAM — the single highest-value shape in this file.
 *
 * Look at shallows-reef-3.jpg and misc-6.jpg: what tells you a Subnautica
 * habitat is 200 mm of plate rather than a decal is not the rib, it is the
 * near-black BAND between two courses with a machined lip on each side of it.
 * Ours had bare toruses in the same pale steel as the plating either side, so
 * every joint vanished into the fog with everything else.
 *
 * `m` places the ring with its axis along +Y. Drawn very slightly proud rather
 * than recessed because the shell is a smooth analytic surface with nothing to
 * recess into — and at any distance where this matters, a dark strap between two
 * bright lips and a dark groove between two bright lips are the same picture.
 */
function hullSeam(c, m, r, w = 0.30, lip = 0.055) {
  const at = (dy, rot) => new THREE.Matrix4().multiplyMatrices(m, xf([0, dy, 0], rot));
  c.g('trimOut', G.cyl(r + 0.012, r + 0.012, w, 26, true), { m, tint: TINT.void_ });
  for (const s of [-1, 1]) {
    c.g('trimOut', G.tor(r + 0.028, lip, 6, 28), {
      m: at(s * w * 0.5, [Math.PI / 2, 0, 0]), tint: TINT.steel,
    });
  }
}

/** Hole test shared by every shell: is this point inside an open port? */
function portHole(cx, cy, cz, ports, axes) {
  for (const name of ports) {
    const a = axes[name];
    if (!a) continue;
    if (distToAxis(cx, cy, cz, a.o, a.d) < a.r) {
      // only cut on the side the port actually faces
      const t = (cx - a.o[0]) * a.d[0] + (cy - a.o[1]) * a.d[1] + (cz - a.o[2]) * a.d[2];
      if (t > -0.05) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- corridor
function buildCorridor(c, piece) {
  const L = piece.len || CORR_LEN;
  const wins = piece.opts.windows || [];
  const winTest = (cx, cy, cz) => {
    for (const w of wins) {
      const s = w.side === '-x' ? -1 : 1;
      const dz = cz - (w.z || 0);
      if (Math.abs(dz) > 1.22) continue;
      const ang = Math.atan2(cy - TAX, cx * s);   // 0 at the window centre
      if (Math.abs(ang) < 0.52) return true;
    }
    return false;
  };
  const nu = 28, nv = Math.max(6, Math.round(L / 0.55));
  const sh = gridShell({
    nu, nv, wrapU: true,
    p: (i, j, o) => {
      const a = (i / nu) * TAU;
      o.set(Math.cos(a) * TR, TAX + Math.sin(a) * TR, -L / 2 + (j / nv) * L);
    },
    nrm: (i, j, o) => { const a = (i / nu) * TAU; o.set(Math.cos(a), Math.sin(a), 0); },
    uvf: (i, j) => [(i / nu) * 3.2, (j / nv) * L * 0.30],
    keep: (i, j, cx, cy, cz) => !winTest(cx, cy, cz),
  });
  c.g('wallIn', sh.inner, { tint: TINT.hull });
  c.g('wallOut', sh.outer, { tint: TINT.hullDim, uv: [1.75, 1.75, 0, 0] });
  c.g('trimOut', sh.rim, { tint: TINT.steel });

  // deck plate + hazard edging (base-interior-4: yellow trim along the floor)
  c.g('floorIn', G.box(2.56, 0.10, L * 0.998), { p: [0, -0.05, 0], tint: TINT.white, uv: [1, L * 0.3, 0, 0] });
  for (const s of [-1, 1]) {
    c.g('hazardIn', G.box(0.17, 0.045, L * 0.998), { p: [s * 1.30, 0.005, 0], uv: [1, L * 1.2, 0, 0] });
    // side conduit run + a cool trim strip at ankle height
    c.g('trimIn', G.cyl(0.085, 0.085, L * 0.98, 8), { p: [s * 1.48, TAX + 0.62, 0], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
    c.g('lampCyan', G.box(0.05, 0.05, L * 0.9), { p: [s * 1.56, 0.24, 0] });
  }
  // ceiling light run — a housing with a bright lens under it
  c.g('trimIn', G.box(0.52, 0.10, L * 0.9), { p: [0, TAX + TR - 0.05, 0], tint: TINT.grey });
  c.g('lampWarm', G.box(0.34, 0.045, L * 0.87), { p: [0, TAX + TR - 0.12, 0] });
  for (let k = 0; k < 3; k++) c.lamp([0, TAX + TR - 0.3, (k - 1) * L * 0.33], [1.0, 0.985, 0.945], 1.0, 3.2);

  // Exterior course seams. A corridor is built from three plate courses, and the
  // dark band between them is the module's whole thickness cue at 40 m.
  for (let k = -1; k <= 1; k++) {
    hullSeam(c, xf([0, TAX, k * L * 0.33], [Math.PI / 2, 0, 0]), TR + TT, 0.26, 0.07);
  }
  // Longitudinal stringers down the flanks, which give the tube a lit upper
  // shoulder and a shadowed lower one instead of one smooth gradient. Angles are
  // measured from +X in the cross-section, and the strip's THIN axis (its local
  // +Y) has to end up along the surface normal (cos a, sin a): Rz(t) sends +Y to
  // (-sin t, cos t), so t = a - PI/2 and nothing else works. Clear of the
  // viewport bezel, which reaches +-0.60 rad of arc at this radius.
  for (const a of [0.95, -0.95, Math.PI - 0.95, Math.PI + 0.95]) {
    const R = TR + TT + 0.02;
    c.g('trimOut', G.box(0.10, 0.055, L * 0.94), {
      p: [Math.cos(a) * R, TAX + Math.sin(a) * R, 0],
      r: [0, 0, a - Math.PI / 2], tint: TINT.grey,
    });
  }
  // the ventral service duct — a dark box under the tube, so the silhouette has
  // something below the waist and the underside is not bare shell
  c.g('trimOut', G.box(0.62, 0.30, L * 0.86), { p: [0, TAX - TR - TT - 0.09, 0], tint: TINT.shadow });
  // hull floods along the spine — see Emit.lampX
  for (let k = -1; k <= 1; k += 2) {
    const z = k * L * 0.28;
    hullFlood(c, [0, TAX + TR + TT, z], [0, 1, 0], 0.9);
  }
  // windows registered on this corridor
  for (const w of wins) {
    const s = w.side === '-x' ? -1 : 1;
    buildViewport(c, {
      p: [s * (TR + TT * 0.5), TAX, w.z || 0],
      r: [0, s * Math.PI / 2, 0],
      w: 2.85, h: 2.10, curve: TR, axis: 'y',
    });
  }
}

/**
 * A viewport set into a curved hull. The pane is cylindrically curved to match
 * the shell it sits in, because a flat pane in a round wall shows a crescent gap
 * at both ends — the single most common tell on a procedural habitat.
 *
 * `axis` names which of the pane's own axes runs around the hull: a corridor
 * curves vertically at its flanks, a room curves horizontally, and getting that
 * backwards bows the window the wrong way.
 */
function buildViewport(c, o) {
  const w = o.w, h = o.h, R = o.curve || 0, ax = o.axis || 'x';
  const m = xf(o.p, o.r, 1);
  const bend = (geo) => {
    if (!R) return geo;
    const g = geo.clone();
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
      if (ax === 'y') {
        const a = y / R;
        p.setXYZ(i, x, Math.sin(a) * (R + z), Math.cos(a) * (R + z) - R);
        n.setXYZ(i, nx, Math.cos(a) * ny + Math.sin(a) * nz, -Math.sin(a) * ny + Math.cos(a) * nz);
      } else {
        const a = x / R;
        p.setXYZ(i, Math.sin(a) * (R + z), y, Math.cos(a) * (R + z) - R);
        n.setXYZ(i, Math.cos(a) * nx + Math.sin(a) * nz, ny, -Math.sin(a) * nx + Math.cos(a) * nz);
      }
    }
    p.needsUpdate = true; n.needsUpdate = true;
    return g;
  };
  // The outer bezel sits proud of the skin and the INNER bezel is what the room
  // sees. They used to overlap, so a corridor viewport was ringed in exterior
  // material from the inside and read as a black hole in a white tube.
  const mo = new THREE.Matrix4().multiplyMatrices(m, xf([0, 0, 0.21]));
  c.g('trimOut', bend(roundedFrame(w + 0.14, h + 0.14, 0.48, 0.14, 0.22)), { m: mo, tint: TINT.steel });
  /**
   * THE REVEAL. Between the proud machined lip and the pane there has to be a
   * band of shadow, because that band IS the 200 mm of hull the window is cut
   * through. Without it a viewport is a lighter rectangle outlined in a darker
   * rectangle — line art — and our hull crop measured a 1st percentile of 99.9
   * where the reference's is 71.2. This one frame is most of that difference.
   */
  c.g('trimOut', bend(roundedFrame(w - 0.02, h - 0.02, 0.42, 0.30, 0.26)), {
    m: new THREE.Matrix4().multiplyMatrices(m, xf([0, 0, 0.07])), tint: TINT.void_,
  });
  c.g('wallIn', bend(roundedFrame(w - 0.26, h - 0.26, 0.36, 0.20, 0.14)), { m, tint: TINT.hull });
  c.g('trimIn', bend(roundedFrame(w - 0.52, h - 0.52, 0.28, 0.07, 0.05)), {
    m: new THREE.Matrix4().multiplyMatrices(m, xf([0, 0, -0.06])), tint: TINT.grey,
  });
  // A lit reveal behind the pane: from the water a habitat viewport is a warm
  // outline, not a hole (misc-6, night-shallows-2, where at 88 m the windows are
  // the ONLY thing left of the base). A RING and not a filled plate, because a
  // plate is a bright rectangle from outside and an obstruction from inside —
  // this is the light cove around the frame that base-interior-1's viewport has.
  c.g('portGlow', bend(roundedFrame(w - 0.56, h - 0.52, 0.32, 0.035, 0.10)), {
    m: new THREE.Matrix4().multiplyMatrices(m, xf([0, 0, -0.13])),
  });
  c.g('glass', bend(roundedSlab(w - 0.50, h - 0.50, 0.05, 0.28)), { m, tint: TINT.glassT });
  const strip = new THREE.Matrix4().multiplyMatrices(m, xf([0, -h / 2 + 0.22, -0.05]));
  c.g('lampCyan', G.box(w - 0.9, 0.030, 0.035), { m: strip });
  // latch hardware down both jambs — base-interior-1's viewport is dense with it
  for (const s of [-1, 1]) {
    const jam = new THREE.Matrix4().multiplyMatrices(m, xf([s * (w / 2 - 0.14), 0, 0.02]));
    c.g('trimIn', G.box(0.075, h * 0.46, 0.06), { m: jam, tint: TINT.steel });
    for (let k = -1; k <= 1; k += 2) {
      const bolt = new THREE.Matrix4().multiplyMatrices(m,
        xf([s * (w / 2 - 0.14), k * h * 0.26, 0.05], [Math.PI / 2, 0, 0]));
      c.g('trimIn', G.cyl(0.045, 0.045, 0.05, 8), { m: bolt, tint: TINT.grey });
    }
  }
  // Light leaving the port. Three small billboards rather than one big quad:
  // a port throws a short cone, and the wash has to die within a metre or it
  // paints over whatever hull is behind it.
  for (let k = 0; k < 3; k++) {
    const t = 0.35 + k * 0.55;
    const gp = new THREE.Vector3(0, 0, 0.22 + t * 0.75).applyMatrix4(m);
    c.glow([gp.x, gp.y, gp.z], 0.42 + t * 0.55,
      [0.62 - k * 0.16, 0.49 - k * 0.12, 0.41 - k * 0.10]);
  }
}

// ---------------------------------------------------------------- junction
function buildJunction(c, piece) {
  const open = piece.opts.ports || ['+z', '-z', '+x', '-x'];
  const axes = {};
  for (const k of ['+z', '-z', '+x', '-x']) axes[k] = { o: [0, TAX, 0], d: DIRS[k], r: TR + 0.06 };
  axes.up = { o: [0, TAX, 0], d: [0, 1, 0], r: TR + 0.06 };
  axes.down = { o: [0, 0, 0], d: [0, -1, 0], r: 0.95 };

  const nu = 32, nv = 16;
  const sh = gridShell({
    nu, nv, wrapU: true,
    p: (i, j, o) => {
      const th = (i / nu) * TAU, ph = -Math.PI / 2 + (j / nv) * Math.PI;
      o.set(Math.cos(ph) * Math.cos(th) * NODE_R, TAX + Math.sin(ph) * NODE_R,
        Math.cos(ph) * Math.sin(th) * NODE_R);
    },
    nrm: (i, j, o) => {
      const th = (i / nu) * TAU, ph = -Math.PI / 2 + (j / nv) * Math.PI;
      o.set(Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th));
    },
    uvf: (i, j) => [(i / nu) * 4.0, (j / nv) * 2.4],
    keep: (i, j, cx, cy, cz) => !portHole(cx, cy, cz, open, axes),
  });
  c.g('wallIn', sh.inner, { tint: TINT.hull });
  c.g('wallOut', sh.outer, { tint: TINT.hullDim, uv: [1.75, 1.75, 0, 0] });
  c.g('trimOut', sh.rim, { tint: TINT.steel });

  const fr = Math.sqrt(NODE_R * NODE_R - TAX * TAX);
  const disc = new THREE.CircleGeometry(fr, 36);
  disc.rotateX(-Math.PI / 2);
  c.g('floorIn', disc, { p: [0, 0, 0], uv: [fr * 0.6, fr * 0.6, 0, 0] });
  c.g('hazardIn', G.tor(fr - 0.12, 0.035, 5, 36), { p: [0, 0.02, 0], r: [Math.PI / 2, 0, 0] });

  // port collars: the sphere-to-tube joint is not watertight geometrically, so
  // a machined collar straddles it and reads as a bulkhead flange.
  for (const k of open) {
    const d = DIRS[k];
    const rot = k === 'up' ? [0, 0, 0] : k === 'down' ? [Math.PI, 0, 0]
      : (k === '+x' || k === '-x') ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0];
    const off = k === 'up' ? NODE_R - 0.15 : k === 'down' ? 0 : NODE_R - 0.15;
    const rr = k === 'down' ? 0.95 : TR;
    const base = k === 'down' ? [0, -0.35, 0]
      : [d[0] * off, TAX + d[1] * off, d[2] * off];
    c.g('trimOut', G.cyl(rr + 0.13, rr + 0.13, 0.55, 20, true), { p: base, r: rot, tint: TINT.steel });
    // the shadow gap where the collar meets the sphere: without it the two pale
    // steel cylinders merge into one silhouette and the joint has no depth
    c.g('trimOut', G.cyl(rr + 0.075, rr + 0.075, 0.30, 20, true), { p: base, r: rot, tint: TINT.void_ });
    c.g('trimIn', G.cyl(rr + 0.02, rr + 0.02, 0.5, 20, true), { p: base, r: rot, tint: TINT.grey });
  }
  // equatorial course seam around the hub
  hullSeam(c, xf([0, TAX, 0]), NODE_R + TT, 0.34, 0.075);

  // ceiling ring light + a cyan cove at the floor line
  c.g('lampWarm', G.tor(1.55, 0.055, 6, 30), { p: [0, TAX + 2.05, 0], r: [Math.PI / 2, 0, 0] });
  c.g('trimIn', G.tor(1.55, 0.10, 6, 30), { p: [0, TAX + 2.16, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('lampCyan', G.tor(fr - 0.02, 0.03, 5, 36), { p: [0, 0.30, 0], r: [Math.PI / 2, 0, 0] });
  c.lamp([0, TAX + 1.8, 0], [1.0, 0.985, 0.950], 2.2, 4.0);
  c.lamp([0, TAX - 0.5, 0], [1.0, 0.985, 0.950], 1.1, 3.4);
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4 + TAU / 8;
    hullFlood(c, [Math.cos(a) * NODE_R * 0.80, TAX + NODE_R * 0.62, Math.sin(a) * NODE_R * 0.80],
      [Math.cos(a) * 0.78, 0.62, Math.sin(a) * 0.78], 1.0);
  }
}

// ---------------------------------------------------------------- room
const ROOM_PROFILE = resample([
  { r: ROOM_R, y: -0.70 },
  { r: ROOM_R, y: 0.10 },
  { r: ROOM_R, y: 2.20 },
  { r: ROOM_R - 0.30, y: 2.78 },
  { r: ROOM_R - 1.45, y: 3.10 },
  { r: ROOM_R - 3.30, y: 3.34 },
  { r: 1.10, y: 3.52 },
  { r: 0.0, y: 3.60 },
], 20);

function buildRoom(c, piece) {
  const open = piece.opts.ports || [];
  const wins = piece.opts.windows || [];    // azimuths in radians
  const axes = {};
  for (const k of ['+z', '-z', '+x', '-x']) axes[k] = { o: [0, TAX, 0], d: DIRS[k], r: TR + 0.06 };
  axes.up = { o: [0, 0, 0], d: [0, 1, 0], r: 0.95 };
  axes.down = { o: [0, 0, 0], d: [0, -1, 0], r: 0.95 };

  const f = latheFns(ROOM_PROFILE, 56);
  const winTest = (cx, cy, cz) => {
    for (const a0 of wins) {
      const a = Math.atan2(cz, cx);
      let d = a - a0;
      while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      const s = d * ROOM_R;
      const dy = cy - 1.52;
      if (Math.hypot(Math.max(0, Math.abs(s) - 0.95), Math.max(0, Math.abs(dy) - 0.32)) < 0.42) return true;
    }
    return false;
  };
  const sh = gridShell({
    ...f,
    uvf: (i, j) => [(i / f.nu) * 9.0, (j / f.nv) * 2.6],
    keep: (i, j, cx, cy, cz) => !portHole(cx, cy, cz, open, axes) && !winTest(cx, cy, cz),
  });
  c.g('wallIn', sh.inner, { tint: TINT.hull });
  c.g('wallOut', sh.outer, { tint: TINT.hullDim, uv: [1.75, 1.75, 0, 0] });
  c.g('trimOut', sh.rim, { tint: TINT.steel });

  // deck: dark hex plate, a lighter inset walkway ring and an orange kick strip
  const disc = new THREE.CircleGeometry(ROOM_R - 0.02, 56);
  disc.rotateX(-Math.PI / 2);
  c.g('floorIn', disc, { uv: [ROOM_R * 0.55, ROOM_R * 0.55, 0, 0] });
  c.g('accentIn', G.tor(ROOM_R - 0.06, 0.09, 6, 56), { p: [0, 0.16, 0], r: [Math.PI / 2, 0, 0], tint: TINT.orange });
  c.g('lampCyan', G.tor(ROOM_R - 1.55, 0.028, 5, 56), { p: [0, 0.012, 0], r: [Math.PI / 2, 0, 0] });

  // ceiling: a ring light plus four downlight pods (base-interior-3's flat bright white)
  c.g('trimIn', G.tor(ROOM_R - 2.05, 0.13, 6, 40), { p: [0, 3.02, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('lampWarm', G.tor(ROOM_R - 2.05, 0.070, 6, 40), { p: [0, 2.93, 0], r: [Math.PI / 2, 0, 0] });
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, rr = ROOM_R - 3.35;
    c.g('trimIn', G.cyl(0.30, 0.24, 0.16, 12), { p: [Math.cos(a) * rr, 3.30, Math.sin(a) * rr], tint: TINT.grey });
    c.g('lampWarm', G.cyl(0.22, 0.22, 0.05, 12), { p: [Math.cos(a) * rr, 3.20, Math.sin(a) * rr] });
    c.lamp([Math.cos(a) * rr, 3.05, Math.sin(a) * rr], [1.0, 0.985, 0.950], 3.4, 5.6);
  }
  c.lamp([0, 2.7, 0], [1.0, 0.990, 0.960], 3.8, 7.0);

  // A wall cove at shoulder height. Lighting a cylinder only from the ceiling
  // leaves the walls as one flat gradient; base-interior-4's habitat reads as a
  // room because a continuous strip runs along the wall at eye level too.
  c.g('trimIn', G.tor(ROOM_R - 0.10, 0.10, 6, 56), { p: [0, 2.42, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('lampWarm', G.tor(ROOM_R - 0.20, 0.048, 6, 56), { p: [0, 2.34, 0], r: [Math.PI / 2, 0, 0] });
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8;
    c.lamp([Math.cos(a) * (ROOM_R - 0.7), 2.28, Math.sin(a) * (ROOM_R - 0.7)], [1.0, 0.985, 0.945], 1.1, 3.6);
    // vertical pilaster strips, which is what gives a round wall a rhythm
    c.g('lampCyan', G.box(0.05, 1.90, 0.05), {
      p: [Math.cos(a) * (ROOM_R - 0.09), 1.25, Math.sin(a) * (ROOM_R - 0.09)], r: [0, -a, 0],
    });
  }

  // exterior meridian ribs — what makes a big cylinder read as a pressure vessel
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8 + TAU / 16;
    const pts = [];
    for (let j = 0; j <= 10; j++) {
      const q = ROOM_PROFILE[Math.round((j / 10) * (ROOM_PROFILE.length - 1))];
      pts.push(new THREE.Vector3(Math.cos(a) * (q.r + TT + 0.04), q.y, Math.sin(a) * (q.r + TT + 0.04)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.075, 5, false);
    c.g('trimOut', tube, { tint: TINT.steel });
  }
  // Three course seams instead of two bare rings — a multipurpose room in
  // misc-6.jpg is visibly stacked plate courses, and the dark band is what says
  // so from across a reef.
  hullSeam(c, xf([0, 0.28, 0]), ROOM_R + TT, 0.36, 0.085);
  hullSeam(c, xf([0, 2.16, 0]), ROOM_R + TT, 0.36, 0.085);
  hullSeam(c, xf([0, -0.56, 0]), ROOM_R + TT, 0.24, 0.070);
  // skirt under the deck line: a dark band at the bottom of the drum, so the
  // room has a shadowed underside rather than fading into the water
  c.g('trimOut', G.cyl(ROOM_R + TT + 0.03, ROOM_R - 0.35, 0.34, 56, true),
    { p: [0, -0.86, 0], tint: TINT.shadow });

  for (const a0 of wins) {
    buildViewport(c, {
      p: [Math.cos(a0) * (ROOM_R + TT * 0.5), 1.52, Math.sin(a0) * (ROOM_R + TT * 0.5)],
      r: [0, -a0 + Math.PI / 2, 0], w: 2.95, h: 1.85, curve: ROOM_R, axis: 'x',
    });
  }
  // exterior floods, so the hull reads as inhabited AND holds its own value
  // against the medium instead of resolving to bare fog by 12 m
  for (let k = 0; k < 6; k++) {
    const a = k * TAU / 6 + TAU / 12;
    hullFlood(c, [Math.cos(a) * (ROOM_R + TT), 2.72, Math.sin(a) * (ROOM_R + TT)],
      [Math.cos(a), 0.22, Math.sin(a)], 1.05);
  }
}

// ---------------------------------------------------------------- observatory
function buildObservatory(c, piece) {
  const phiSill = Math.asin(clamp01(OBS_SILL / OBS_H));
  const axes = { '-z': { o: [0, TAX, 0], d: [0, 0, -1], r: TR + 0.06 } };
  const keep = (i, j, cx, cy, cz) => !portHole(cx, cy, cz, ['-z'], axes);

  const ell = (phi) => ({ r: OBS_R * Math.cos(phi), y: OBS_H * Math.sin(phi) });
  const shellFor = (p0, p1, steps) => {
    const prof = [];
    for (let k = 0; k <= steps; k++) prof.push(ell(lerp(p0, p1, k / steps)));
    return latheFns(prof, 48);
  };

  // solid hull band up to the sill
  const band = gridShell({
    ...shellFor(0, phiSill, 3),
    uvf: (i, j) => [(i / 48) * 9.0, j * 0.5], keep,
  });
  c.g('wallIn', band.inner, { tint: TINT.hull });
  c.g('wallOut', band.outer, { tint: TINT.hullDim, uv: [1.75, 1.75, 0, 0] });
  c.g('trimOut', band.rim, { tint: TINT.steel });

  // the glass cap: one double-sided surface, see the note on MATS.glass
  const cap = gridShell({
    ...shellFor(phiSill, Math.PI / 2 - 0.06, 13), thick: 0.05,
    uvf: (i, j) => [i / 48, j / 13], keep,
  });
  c.g('glass', cap.outer, { tint: TINT.glassT });
  c.g('trimIn', cap.rim, { tint: TINT.steel });

  // sill flange + the light cove tucked under it. That cove is the whole night
  // shot: it lights the interior surfaces without putting a lamp in the glass.
  const rs = OBS_R * Math.cos(phiSill);
  c.g('trimOut', G.tor(rs + 0.09, 0.075, 6, 48), { p: [0, OBS_SILL + 0.02, 0], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  // the sill band's own course seam and a dark plinth at the deck line
  hullSeam(c, xf([0, OBS_SILL * 0.46, 0]), OBS_R * Math.cos(phiSill * 0.46) + TT, 0.26, 0.065);
  c.g('trimOut', G.cyl(OBS_R + TT + 0.02, OBS_R - 0.30, 0.30, 48, true),
    { p: [0, -0.20, 0], tint: TINT.shadow });
  c.g('wallIn', G.tor(rs - 0.26, 0.11, 6, 48), { p: [0, OBS_SILL - 0.02, 0], r: [Math.PI / 2, 0, 0], tint: TINT.hull });
  c.g('lampWarm', G.tor(rs - 0.30, 0.070, 6, 48), { p: [0, OBS_SILL - 0.16, 0], r: [Math.PI / 2, 0, 0] });
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8;
    c.lamp([Math.cos(a) * (rs - 0.5), OBS_SILL - 0.25, Math.sin(a) * (rs - 0.5)], [1.0, 0.980, 0.940], 0.85, 4.2);
  }

  // Meridional ribs. Eight, thin, and on the INTERIOR material: twelve fat ribs
  // in the exterior material read as a black spiderweb across the one view the
  // whole build exists for — an observatory's mullions are pale and slim, and
  // they have to take the interior bake or they silhouette against the water.
  for (let k = 0; k < 10; k++) {
    const a = k * TAU / 10;
    const pts = [];
    for (let j = 0; j <= 9; j++) {
      const q = ell(lerp(phiSill, Math.PI / 2 - 0.05, j / 9));
      // inside the pane, not outside it: a mullion seen THROUGH glass picks up
      // the pane's tint and the water behind it and silhouettes black
      pts.push(new THREE.Vector3(Math.cos(a) * (q.r - 0.05), q.y - 0.03, Math.sin(a) * (q.r - 0.05)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.022, 5, false);
    c.g('trimIn', tube, { tint: TINT.grey });
  }
  // Latitude rings. Without them the glazing is ten long unbroken meridians and
  // reads as ribs over open water rather than as PANES — which is precisely what
  // a blind A/B called out. Three rings turn it into a glass geodesic.
  for (const t of [0.26, 0.53, 0.79]) {
    const q = ell(lerp(phiSill, Math.PI / 2, t));
    c.g('trimIn', G.tor(q.r - 0.040, 0.018, 5, 48), { p: [0, q.y - 0.02, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
    // a thin cyan seam light in the ring, so the frame reads at night too
    c.g('lampCyan', G.tor(q.r - 0.040, 0.008, 4, 48), { p: [0, q.y - 0.040, 0], r: [Math.PI / 2, 0, 0] });
  }
  // hull floods raking up the outside of the sill band
  for (let k = 0; k < 5; k++) {
    const a = k * TAU / 5 + 0.5;
    hullFlood(c, [Math.cos(a) * (OBS_R * 0.99), 0.42, Math.sin(a) * (OBS_R * 0.99)],
      [Math.cos(a) * 0.9, 0.44, Math.sin(a) * 0.9], 0.85);
  }
  // The light escaping the sill cove into the water. Small billboards hugging
  // the hull: the old version was eight 3.2 x 2.3 m world-aligned quads standing
  // 0.55 m off the dome, and from any oblique angle they were opaque cream
  // ellipses drawn across the silhouette they were meant to describe.
  for (let k = 0; k < 10; k++) {
    const a = k * TAU / 10;
    c.glow([Math.cos(a) * (rs + 0.30), OBS_SILL + 0.06, Math.sin(a) * (rs + 0.30)],
      0.70, [0.44, 0.35, 0.29]);
  }
  c.g('trimOut', G.cyl(0.42, 0.52, 0.22, 16), { p: [0, OBS_H - 0.07, 0], tint: TINT.steel });
  c.g('lampWarm', G.cyl(0.34, 0.34, 0.05, 16), { p: [0, OBS_H - 0.20, 0] });
  c.lamp([0, OBS_H - 0.5, 0], [1.0, 0.985, 0.945], 1.6, 5.5);

  // deck, kick rail and the ring bench that makes it a room you sit in
  const disc = new THREE.CircleGeometry(OBS_R - 0.02, 48);
  disc.rotateX(-Math.PI / 2);
  c.g('floorIn', disc, { uv: [OBS_R * 0.55, OBS_R * 0.55, 0, 0] });
  c.g('accentIn', G.tor(OBS_R - 0.10, 0.075, 6, 48), { p: [0, 0.14, 0], r: [Math.PI / 2, 0, 0], tint: TINT.orange });
  c.g('lampCyan', G.tor(OBS_R - 2.3, 0.026, 5, 48), { p: [0, 0.012, 0], r: [Math.PI / 2, 0, 0] });
  c.g('trimIn', G.cyl(OBS_R - 0.62, OBS_R - 0.62, 0.46, 44, true), { p: [0, 0.23, 0], tint: TINT.grey });
  const seat = new THREE.RingGeometry(OBS_R - 1.28, OBS_R - 0.60, 44);
  seat.rotateX(-Math.PI / 2);
  c.g('wallIn', seat, { p: [0, 0.46, 0], tint: TINT.hull, uv: [3, 3, 0, 0] });
  c.g('trimIn', G.tor(OBS_R - 0.95, 0.045, 5, 44), { p: [0, 1.02, 0], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  for (let k = 0; k < 10; k++) {
    const a = k * TAU / 10 + 0.31;
    c.g('trimIn', G.cyl(0.035, 0.035, 0.56, 6), { p: [Math.cos(a) * (OBS_R - 0.95), 0.74, Math.sin(a) * (OBS_R - 0.95)], tint: TINT.steel });
  }
}

// ---------------------------------------------------------------- hatch
// Attaches to a free tube socket. +Z is outward, into the water.
/**
 * The airlock. This is the single most-used object in the module — it is where
 * the ocean stops — and at 7 m it used to be a flat black disc with a faint ring
 * and four dots. It now has the parts a pressure door actually has: a raised
 * machined rim, eight dogs on a hazard-striped collar, a recessed door with a
 * spoked handwheel, a lit status pip and a labelled placard.
 */
function buildHatch(c, piece) {
  const RIM = TR + 0.16;
  // collar + raised rim
  c.g('trimOut', G.cyl(RIM, RIM, 0.62, 26, true), { p: [0, 0, -0.06], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  c.g('hazardIn', G.tor(RIM + 0.03, 0.075, 6, 26), { p: [0, 0, 0.20], uv: [10, 1, 0, 0] });
  c.g('trimOut', G.tor(RIM + 0.02, 0.10, 6, 26), { p: [0, 0, 0.34], tint: TINT.steel });
  // The dark annulus the door sits inside — the airlock's own reveal. Held
  // 45 mm inside the collar's own radius: two open cylinders at the SAME radius
  // z-fight, and a flickering ring around the most-looked-at object in the
  // module would be worse than the flat hatch it replaces.
  c.g('trimOut', G.cyl(TR + 0.115, TR + 0.115, 0.26, 26, true), { p: [0, 0, 0.33], r: [Math.PI / 2, 0, 0], tint: TINT.void_ });
  c.g('trimOut', G.ring(TR + 0.03, TR + 0.115, 26), { p: [0, 0, 0.205], tint: TINT.shadow });
  c.g('wallOut', G.cyl(TR + 0.02, TR + 0.02, 0.14, 26), { p: [0, 0, 0.20], r: [Math.PI / 2, 0, 0], tint: TINT.hullDim });

  // the door: recessed, pale, with an orange ring and radial stiffener ribs.
  // Painted orange over the whole leaf turned brown by 8 m — the medium eats the
  // red first, so the identity colour has to be a detail and the field a value
  // the water cannot take away.
  c.g('wallOut', G.cyl(TR - 0.20, TR - 0.20, 0.16, 26), { p: [0, 0, 0.30], r: [Math.PI / 2, 0, 0], tint: TINT.hullDim });
  c.g('accentOut', G.tor(TR - 0.42, 0.05, 6, 26), { p: [0, 0, 0.39], tint: TINT.orange });
  c.g('trimOut', G.tor(TR - 0.20, 0.065, 6, 26), { p: [0, 0, 0.38], tint: TINT.steel });
  for (let k = 0; k < 6; k++) {
    const a = k * TAU / 6 + 0.26;
    c.g('trimOut', G.box(0.085, TR - 0.75, 0.05), {
      p: [Math.cos(a) * (TR * 0.55), Math.sin(a) * (TR * 0.55), 0.40], r: [0, 0, -a + Math.PI / 2], tint: TINT.grey,
    });
  }
  // eight dogs around the door edge, each a boss with a bolt head
  for (let k = 0; k < 8; k++) {
    const a = k * TAU / 8 + TAU / 16;
    const rr = TR - 0.44;
    c.g('trimOut', G.cyl(0.105, 0.125, 0.14, 8), {
      p: [Math.cos(a) * rr, Math.sin(a) * rr, 0.42], r: [Math.PI / 2, 0, 0], tint: TINT.steel,
    });
    c.g('trimOut', G.cyl(0.052, 0.052, 0.06, 6), {
      p: [Math.cos(a) * rr, Math.sin(a) * rr, 0.50], r: [Math.PI / 2, 0, 0], tint: TINT.grey,
    });
  }
  // handwheel: hub, rim, five spokes — the thing a hand goes on
  c.g('trimOut', G.cyl(0.20, 0.24, 0.16, 14), { p: [0, 0, 0.44], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  c.g('trimOut', G.tor(0.52, 0.052, 7, 26), { p: [0, 0, 0.52], tint: TINT.grey });
  for (let k = 0; k < 5; k++) {
    const a = k * TAU / 5;
    c.g('trimOut', G.box(0.062, 0.52, 0.055), {
      p: [Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.52], r: [0, 0, -a + Math.PI / 2], tint: TINT.grey,
    });
  }
  c.g('lampCyan', G.cyl(0.075, 0.075, 0.03, 10), { p: [0, 0, 0.53], r: [Math.PI / 2, 0, 0] });

  // status pip and placard, up where a diver reads them
  c.g('trimOut', G.cyl(0.14, 0.16, 0.09, 10), { p: [0, TR - 0.60, 0.40], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  c.g('lampGreen', G.cyl(0.095, 0.095, 0.05, 10), { p: [0, TR - 0.60, 0.46], r: [Math.PI / 2, 0, 0] });
  c.g('trimOut', roundedSlab(0.66, 0.19, 0.04, 0.05), { p: [0, -TR + 0.52, 0.40], tint: TINT.darker });
  c.g('lampAmber', G.box(0.50, 0.055, 0.02), { p: [0, -TR + 0.52, 0.43] });

  // wash on the door face, and a lamp over it — small, soft, camera-facing
  c.g('trimOut', G.cyl(0.09, 0.13, 0.20, 8), { p: [0, TR + 0.06, 0.30], r: [-0.9, 0, 0], tint: TINT.steel });
  c.g('portGlow', G.cyl(0.070, 0.070, 0.03, 8), { p: [0, TR - 0.02, 0.38], r: [-0.9, 0, 0] });
  c.glow([0, TR - 0.06, 0.44], 0.30, [0.56, 0.44, 0.35]);
  c.glow([0, TR * 0.42, 0.62], 0.85, [0.17, 0.14, 0.12]);
  c.lampX([0, TR - 0.3, 0.70], [1.0, 0.93, 0.84], 1.3, 3.0);

  // interior surround + a warm wash so the airlock is not a black hole
  c.g('trimIn', G.cyl(TR + 0.03, TR + 0.03, 0.5, 24, true), { p: [0, 0, -0.32], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('lampCyan', G.tor(TR + 0.02, 0.03, 5, 24), { p: [0, 0, -0.52] });
  c.lamp([0, 0, -0.9], [0.95, 0.94, 0.90], 0.8, 2.6);

  // exterior grab ladder dropping toward the seabed
  for (const s of [-1, 1]) {
    c.g('accentOut', G.cyl(0.050, 0.050, 3.0, 10), { p: [s * 0.30, -TR - 1.3, 0.62], tint: TINT.yellow });
  }
  for (let k = 0; k < 8; k++) {
    c.g('accentOut', G.cyl(0.036, 0.036, 0.6, 8), {
      p: [0, -TR - 0.05 - k * 0.34, 0.62], r: [0, 0, Math.PI / 2], tint: TINT.yellow,
    });
  }
}

// ---------------------------------------------------------------- ladder
/**
 * The ladder from base-interior-4: fat yellow-painted tube rails with round
 * rungs, a hooped back cage and a hazard-striped landing kerb.
 *
 * The rails used to be 0.052 m cylinders carrying the hazard-chevron texture.
 * Head-on that reads; off-axis a thin cylinder with a diagonal stripe collapses
 * into a twisted flat ribbon, which is exactly what a critic saw splitting the
 * room in half. Paint belongs on the rail, chevrons belong on the deck kerb.
 */
function buildLadder(c, piece) {
  const h = piece.opts.height || 3.2;
  const RA = 0.30;
  for (const s of [-1, 1]) {
    c.g('accentIn', G.cyl(0.062, 0.062, h + 0.30, 12), { p: [s * RA, h / 2 + 0.10, 0], tint: TINT.yellow });
    // the rail is bolted to a standoff bracket every metre, not floating
    for (let k = 0; k <= Math.floor(h / 1.05); k++) {
      c.g('trimIn', G.box(0.075, 0.075, 0.30), { p: [s * RA, 0.45 + k * 1.05, -0.20], tint: TINT.steel });
    }
  }
  const n = Math.max(2, Math.round(h / 0.31));
  for (let k = 1; k < n; k++) {
    c.g('accentIn', G.cyl(0.040, 0.040, RA * 2 + 0.02, 10), {
      p: [0, (k / n) * h, 0], r: [0, 0, Math.PI / 2], tint: TINT.yellow,
    });
    // knurled grip band in the middle of each rung
    c.g('trimIn', G.cyl(0.046, 0.046, 0.16, 8), {
      p: [0, (k / n) * h, 0], r: [0, 0, Math.PI / 2], tint: TINT.grey,
    });
  }
  // grab arch over the top landing
  for (const s of [-1, 1]) {
    c.g('accentIn', G.tor(0.36, 0.052, 6, 14, Math.PI), {
      p: [s * RA, h + 0.06, 0], r: [Math.PI / 2, 0, 0], tint: TINT.yellow,
    });
  }
  c.g('trimIn', G.tor(0.92, 0.075, 6, 24), { p: [0, h + 0.06, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('hazardIn', G.tor(0.92, 0.045, 5, 24), { p: [0, h + 0.16, 0], r: [Math.PI / 2, 0, 0], uv: [12, 1, 0, 0] });
  c.g('hazardIn', G.tor(0.92, 0.040, 5, 24), { p: [0, 0.03, 0], r: [Math.PI / 2, 0, 0], uv: [12, 1, 0, 0] });
  // a cage of hoops, which is what stops a vertical shaft reading as two sticks
  for (let k = 0; k < Math.max(1, Math.floor(h / 0.9)); k++) {
    c.g('trimIn', G.tor(0.46, 0.030, 6, 18, Math.PI * 1.25), {
      p: [0, 0.6 + k * 0.9, 0], r: [Math.PI / 2, 0, Math.PI * 0.62], tint: TINT.steel,
    });
  }
  // the cage's own spine, so the hoops are held by something
  c.g('trimIn', G.cyl(0.030, 0.030, h - 0.4, 8), { p: [0, h * 0.5 + 0.2, -0.44], tint: TINT.steel });
  c.lamp([0, h * 0.5, 0], [0.98, 0.96, 0.92], 0.5, 2.4);
}

// ---------------------------------------------------------------- foundation
function buildFoundation(c, piece) {
  const s = piece.opts.size || FOUND;
  c.g('trimOut', G.box(s, 0.30, s), { p: [0, -0.32, 0], tint: TINT.steel, uv: [2, 2, 0, 0] });
  c.g('floorIn', G.box(s - 0.26, 0.16, s - 0.26), { p: [0, -0.09, 0], uv: [s * 0.5, s * 0.5, 0, 0] });
  for (const sx of [-1, 1]) {
    c.g('hazardIn', G.box(s - 0.26, 0.03, 0.22), { p: [0, -0.005, sx * (s / 2 - 0.24)], uv: [s * 1.2, 1, 0, 0] });
    c.g('hazardIn', G.box(0.22, 0.03, s - 0.7), { p: [sx * (s / 2 - 0.24), -0.005, 0], uv: [1, s * 1.2, 0, 0] });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    c.g('trimOut', G.cyl(0.20, 0.20, 0.5, 10), { p: [sx * (s / 2 - 0.34), -0.5, sz * (s / 2 - 0.34)], tint: TINT.steel });
  }
}

// ---------------------------------------------------------------- reinforcement
function buildReinforcement(c) {
  c.g('trimOut', roundedSlab(2.9, 2.1, 0.20, 0.45), { p: [0, 0, 0.05], tint: TINT.steel });
  for (let k = -1; k <= 1; k++) {
    c.g('trimOut', G.box(0.30, 1.85, 0.16), { p: [k * 0.85, 0, 0.20], tint: TINT.grey });
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    c.g('trimOut', G.cyl(0.09, 0.09, 0.10, 8), { p: [sx * 1.22, sy * 0.82, 0.18], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
  }
  c.g('lampAmber', G.box(0.10, 0.10, 0.03), { p: [1.22, -0.82, 0.26] });
}

// ---------------------------------------------------------------- power
function buildSolar(c) {
  c.g('trimOut', G.cyl(0.62, 0.78, 0.26, 14), { p: [0, 0.13, 0], tint: TINT.steel });
  c.g('trimOut', G.cyl(0.15, 0.17, 1.55, 10), { p: [0, 1.0, 0], tint: TINT.steel });
  const tilt = -0.34;
  const m = xf([0, 1.85, 0], [tilt, 0.4, 0]);
  c.g('trimOut', G.cyl(1.42, 1.42, 0.10, 6), { m, tint: TINT.steel });
  c.g('screenIn', G.cyl(1.30, 1.30, 0.06, 6), { m: _m.clone().multiplyMatrices(m, xf([0, 0.07, 0])), uv: [2, 2, 0, 0] });
  c.g('lampCyan', G.tor(1.34, 0.032, 5, 24), { m: _m.clone().multiplyMatrices(m, xf([0, 0.06, 0], [Math.PI / 2, 0, 0])) });
  c.g('lampGreen', G.cyl(0.06, 0.06, 0.05, 8), { p: [0.36, 0.32, 0.36] });
}

function buildThermal(c) {
  c.g('trimOut', G.cyl(1.05, 1.25, 0.40, 16), { p: [0, 0.20, 0], tint: TINT.steel });
  c.g('wallOut', G.cyl(0.72, 0.80, 2.55, 16), { p: [0, 1.65, 0], tint: TINT.hullDim, uv: [3, 2, 0, 0] });
  for (let k = 0; k < 6; k++) {
    const a = k * TAU / 6;
    c.g('trimOut', G.box(0.10, 2.10, 0.85), {
      p: [Math.cos(a) * 1.05, 1.60, Math.sin(a) * 1.05], r: [0, -a, 0], tint: TINT.steel,
    });
  }
  c.g('lampAmber', G.cyl(0.83, 0.83, 0.24, 16), { p: [0, 1.05, 0] });
  c.g('lampAmber', G.cyl(0.83, 0.83, 0.14, 16), { p: [0, 2.30, 0] });
  c.g('trimOut', G.cyl(0.55, 0.72, 0.55, 16), { p: [0, 3.15, 0], tint: TINT.steel });
  c.g('screenIn', roundedSlab(0.52, 0.36, 0.05, 0.08), { p: [0, 1.75, 0.86], uv: [1, 1, 0, 0] });
}

// ---------------------------------------------------------------- fittings
//
// LOOK.md's base frames are never empty tubes: a locker bank, a fabricator, a
// growbed and a wall cabinet are what make the volume read as inhabited rather
// than as a corridor asset.

/**
 * The locker bank a blind pair called out as "flat untextured white boxes".
 *
 * Three things were wrong and all three were structural rather than a question
 * of texture amplitude:
 *  - the door carried the wall sheet at its native scale, so a 1.0 m leaf was
 *    tiled with a 4x4 grid of plates: a cabinet door printed with wall plating;
 *  - carcass, door and handle were all the same material with the same gloss, so
 *    there was nothing to read the shapes apart by;
 *  - nothing was recessed. A door with no shadow gap around it is a decal, which
 *    is the same failure as the exterior at a different scale.
 * base-interior-1's locker is one smooth leaf, a hard black gap around it, a
 * proud handle rail catching the room light, and a small label plate.
 */
function buildLocker(c) {
  // plinth: the unit is bolted to the deck, and its shadow gap sits under it
  c.g('trimIn', G.box(2.30, 0.13, 0.60), { p: [0, 0.065, 0.27], tint: TINT.dark });
  for (const s of [-1, 1]) {
    // carcass, at a third of the wall's plate density so the panel sheet reads
    // as a cabinet skin and not as habitat plating shrunk to fit
    c.g('wallIn', roundedSlab(1.02, 1.78, 0.50, 0.16), {
      p: [s * 0.54, 1.05, 0.25], tint: TINT.hull, uv: [0.34, 0.34, s * 0.3, 0.15],
    });
    // the shadow gap the door is set into — the whole reason it reads as a door
    c.g('trimIn', roundedSlab(0.94, 1.66, 0.03, 0.14), { p: [s * 0.54, 1.05, 0.503], tint: TINT.darker });
    // the leaf itself: smooth painted steel, glossier than the carcass
    c.g('accentIn', roundedSlab(0.86, 1.58, 0.055, 0.12), { p: [s * 0.54, 1.05, 0.525], tint: TINT.hullDim });
    // proud handle rail with its own recess behind it
    c.g('trimIn', G.box(0.075, 0.80, 0.035), { p: [s * 0.54 - s * 0.30, 1.16, 0.548], tint: TINT.darker });
    c.g('trimIn', G.cyl(0.026, 0.026, 0.74, 8), {
      p: [s * 0.54 - s * 0.30, 1.16, 0.585], r: [Math.PI / 2, 0, 0], tint: TINT.steel,
    });
    for (const y of [0.82, 1.50]) {
      c.g('trimIn', G.box(0.05, 0.05, 0.075), { p: [s * 0.54 - s * 0.30, y, 0.565], tint: TINT.steel });
    }
    // hinge bosses down the far jamb
    for (let k = 0; k < 3; k++) {
      c.g('trimIn', G.cyl(0.030, 0.030, 0.09, 8), {
        p: [s * 0.54 + s * 0.40, 0.44 + k * 0.62, 0.512], r: [Math.PI / 2, 0, 0], tint: TINT.grey,
      });
    }
    c.g('screenIn', roundedSlab(0.46, 0.145, 0.03, 0.03), { p: [s * 0.54, 1.66, 0.556], uv: [1, 1, 0, 0] });
    c.g('lampCyan', G.box(0.05, 0.05, 0.02), { p: [s * 0.54 + 0.31, 1.66, 0.560] });
  }
  // capping rail, with a shadow line under its overhang
  c.g('trimIn', G.box(2.30, 0.09, 0.62), { p: [0, 1.98, 0.27], tint: TINT.grey });
  c.g('trimIn', G.box(2.24, 0.05, 0.54), { p: [0, 1.91, 0.26], tint: TINT.darker });
  c.lamp([0, 1.7, 0.9], [0.9, 0.95, 1.0], 0.35, 2.2);
}

function buildFabricator(c) {
  c.g('wallIn', roundedSlab(1.10, 1.72, 0.52, 0.30), { p: [0, 1.30, 0.26], tint: TINT.hull });
  c.g('accentIn', roundedSlab(1.14, 0.30, 0.50, 0.14), { p: [0, 1.98, 0.25], tint: TINT.orange });
  c.g('accentIn', roundedSlab(1.14, 0.22, 0.50, 0.10), { p: [0, 0.56, 0.25], tint: TINT.orange });
  // the working cavity, lit from within — the frame's brightest small feature
  c.g('trimIn', roundedSlab(0.80, 1.02, 0.34, 0.12), { p: [0, 1.40, 0.44], tint: TINT.darker });
  c.g('screenIn', roundedSlab(0.66, 0.88, 0.03, 0.10), { p: [0, 1.42, 0.60], uv: [1, 1, 0, 0] });
  c.g('trimIn', G.box(1.34, 0.06, 0.42), { p: [0, 0.86, 0.50], tint: TINT.grey });
  c.g('lampCyan', G.box(0.06, 0.72, 0.05), { p: [-0.40, 1.42, 0.61] });
  c.g('lampCyan', G.box(0.06, 0.72, 0.05), { p: [0.40, 1.42, 0.61] });
  c.g('screenIn', roundedSlab(0.58, 0.22, 0.03, 0.05), { p: [0, 0.66, 0.52], uv: [1, 1, 0, 0] });
  c.lamp([0, 1.45, 0.95], [1.0, 0.86, 0.72], 0.9, 2.6);
}

function buildBed(c) {
  c.g('trimIn', G.box(2.05, 0.34, 1.05), { p: [0, 0.24, 0], tint: TINT.dark });
  c.g('wallIn', roundedSlab(2.00, 1.00, 0.26, 0.20), { p: [0, 0.54, 0], r: [Math.PI / 2, 0, 0], tint: TINT.hull });
  c.g('wallIn', roundedSlab(0.62, 0.40, 0.18, 0.14), { p: [-0.62, 0.72, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('trimIn', roundedSlab(0.90, 0.55, 0.10, 0.18), { p: [-1.02, 0.62, 0], r: [0, Math.PI / 2, 0], tint: TINT.grey });
  c.g('lampCyan', G.box(1.90, 0.035, 0.035), { p: [0, 0.10, 0.52] });
  c.g('lampCyan', G.box(1.90, 0.035, 0.035), { p: [0, 0.10, -0.52] });
  c.lamp([0, 0.3, 0], [0.55, 0.85, 1.0], 0.25, 2.0);
}

function buildPlanter(c, piece) {
  const rng = makeRNG(piece.seed || 7);
  // Tub, rim and soil, all differing in material. The old version was one white
  // slab with a near-black box on top of it: from the shot camera that reads as
  // a crate with a hole cut in it, and the blind pair said so.
  c.g('wallIn', roundedSlab(1.70, 1.02, 0.62, 0.26), {
    p: [0, 0.31, 0], r: [Math.PI / 2, 0, 0], tint: TINT.hull, uv: [0.42, 0.42, 0.2, 0.4],
  });
  // The coping is a FRAME, not a lid. Drawn as a solid slab it capped the tub at
  // exactly the height of the growing medium and the growbed rendered as a dark
  // grille with pebbles sitting on it — worse than the flat box it replaced.
  for (const s of [-1, 1]) {
    c.g('trimIn', G.box(1.72, 0.075, 0.10), { p: [0, 0.645, s * 0.43], tint: TINT.grey });
    c.g('trimIn', G.box(0.10, 0.075, 0.86), { p: [s * 0.81, 0.645, 0], tint: TINT.grey });
    c.g('trimIn', G.box(1.60, 0.05, 0.05), { p: [0, 0.598, s * 0.375], tint: TINT.darker });
    c.g('trimIn', G.box(0.05, 0.05, 0.76), { p: [s * 0.755, 0.598, 0], tint: TINT.darker });
  }
  c.g('soil', G.box(1.52, 0.16, 0.82), { p: [0, 0.575, 0] });
  // clods, so the medium has a surface rather than being one flat plane
  for (let k = 0; k < 16; k++) {
    const s = 0.045 + rng() * 0.055;
    c.g('soil', G.sph(1, 6, 4), {
      p: [(rng() - 0.5) * 1.30, 0.655 + rng() * 0.02, (rng() - 0.5) * 0.68],
      s: [s * 1.5, s * 0.62, s * 1.5],
    });
  }
  c.g('lampCyan', G.box(1.62, 0.030, 0.030), { p: [0, 0.16, 0.46] });
  // Real blades on real stems, springing from a few clumps. Flat solid-colour
  // cards in a growbed are the tell base-interior-3's sprouting beds do not have.
  const blade = leafGeo(6, 0.16, 0.24);
  for (let cl = 0; cl < 7; cl++) {
    const cx = (rng() - 0.5) * 1.26, cz = (rng() - 0.5) * 0.62;
    const n = 7 + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) {
      const a = rng() * TAU;
      const len = 0.30 + rng() * 0.26;
      const wid = 0.10 + rng() * 0.05;
      const lean = 0.35 + rng() * 0.75;
      c.g('leaf', blade, {
        p: [cx + Math.cos(a) * 0.05, 0.655, cz + Math.sin(a) * 0.05],
        r: [-Math.PI / 2 + lean * 0.42, a, 0],
        s: [wid, wid, len],
        // A GROWBED, not a lantern tree. leafGeo carries the tree's blue-to-orange
        // ramp in its vertex colours, and left near-white the sprouts came out the
        // dark khaki of a dead houseplant; base-interior-3's beds are green.
        tint: rng() < 0.30 ? TINT.leafPale : TINT.sprout,
      });
    }
    if (rng() < 0.5) {
      c.g('fruit', fruitGeo(), { p: [cx, 0.86 + rng() * 0.08, cz], s: [0.05, 0.11, 0.05] });
    }
  }
  c.lamp([0, 0.9, 0], [0.55, 0.88, 0.62], 0.20, 1.8);
}

function buildPanel(c) {
  c.g('trimIn', roundedSlab(1.55, 1.05, 0.16, 0.16), { p: [0, 1.55, 0.08], r: [-0.22, 0, 0], tint: TINT.dark });
  c.g('screenIn', roundedSlab(1.40, 0.92, 0.03, 0.12), { p: [0, 1.55, 0.17], r: [-0.22, 0, 0], uv: [1, 1, 0, 0] });
  c.g('lampCyan', G.box(1.44, 0.030, 0.03), { p: [0, 1.08, 0.28] });
  c.g('trimIn', G.box(1.60, 0.10, 0.44), { p: [0, 1.00, 0.20], tint: TINT.grey });
  for (let k = 0; k < 4; k++) {
    c.g(k === 3 ? 'lampAmber' : 'lampGreen', G.cyl(0.05, 0.05, 0.04, 8), {
      p: [-0.55 + k * 0.36, 0.98, 0.41], r: [Math.PI / 2, 0, 0],
    });
  }
  c.lamp([0, 1.6, 0.7], [0.45, 0.85, 1.0], 0.45, 2.4);
}

function buildMedkit(c) {
  c.g('wallIn', roundedSlab(0.62, 0.74, 0.28, 0.10), { p: [0, 1.62, 0.14], tint: TINT.hull });
  c.g('lampGreen', G.box(0.34, 0.09, 0.03), { p: [0, 1.62, 0.29] });
  c.g('lampGreen', G.box(0.09, 0.34, 0.03), { p: [0, 1.62, 0.29] });
  c.g('trimIn', G.box(0.05, 0.62, 0.06), { p: [0.26, 1.62, 0.30], tint: TINT.steel });
}

/**
 * The indoor lantern tree from base-interior-1 — a twisted trunk, blue-and-gold
 * blades and glowing orange fruit. It is the one thing in the reference frame
 * that is warm, organic and self-lit, and it is why that shot reads as a home
 * rather than as a corridor.
 */
function buildLanternTree(c, piece) {
  const rng = makeRNG(piece.seed || 91);
  const H = piece.opts.height || 2.5;
  c.g('wallIn', G.cyl(0.62, 0.74, 0.42, 18), { p: [0, 0.21, 0], tint: TINT.hull });
  c.g('trimIn', G.tor(0.60, 0.06, 5, 20), { p: [0, 0.42, 0], r: [Math.PI / 2, 0, 0], tint: TINT.grey });
  c.g('soil', G.cyl(0.56, 0.56, 0.10, 16), { p: [0, 0.45, 0] });
  // trunk: two interwoven tapered strands
  for (let s = 0; s < 2; s++) {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, a = t * 5.4 + s * Math.PI;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.11 * (1 - t * 0.5), 0.45 + t * H, Math.sin(a) * 0.11 * (1 - t * 0.5)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.085, 6, false);
    c.g('plant', tube, { tint: TINT.bark });
  }
  // crown: veined blades in whorls along radiating branches, and lantern fruit
  // slung under them. Counts follow base-interior-1: 9 branches x 5 nodes x 2
  // blades is ~40 leaves, against the 14 lozenges a blind trial spotted at once.
  const blade = leafGeo(8, 0.34, 0.20);
  const fr = fruitGeo();
  const branches = 9;
  for (let b = 0; b < branches; b++) {
    const a = b * TAU / branches + rng() * 0.28;
    const tilt = 0.35 + rng() * 0.5;
    const len = 1.05 + rng() * 0.55;
    const bm = xf([0, 0.45 + H, 0], [0, -a, 0]);
    const arm = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      arm.push(new THREE.Vector3(t * len, Math.sin(t * 1.5) * 0.30 - t * t * tilt, 0));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arm), 8, 0.032, 6, false);
    c.g('plant', tube, { m: bm, tint: TINT.bark });
    for (let k = 1; k <= 5; k++) {
      const t = k / 5;
      const px = t * len, py = Math.sin(t * 1.5) * 0.30 - t * t * tilt;
      for (const s of [-1, 1]) {
        const ll = 0.66 + rng() * 0.32;
        const lw = 0.21 + rng() * 0.08;
        const lm = _m.clone().multiplyMatrices(bm, xf(
          [px, py + 0.02, s * 0.04],
          [-0.30 + rng() * 0.30, s * (0.85 + rng() * 0.45), -0.34 + t * 0.62],
          [lw, lw, ll]));
        c.g('leaf', blade, { m: lm, tint: rng() < 0.42 ? TINT.leafPale : TINT.white });
      }
      if (rng() < 0.72) {
        const fs = 0.048 + rng() * 0.020;
        const fm = _m.clone().multiplyMatrices(bm,
          xf([px, py - 0.05, (rng() - 0.5) * 0.10], null, [fs, fs * 2.4, fs]));
        c.g('fruit', fr, { m: fm });
        // the white specular bead at the tip of each lantern
        const fb = _m.clone().multiplyMatrices(bm,
          xf([px, py - 0.05 - fs * 2.36, (rng() - 0.5) * 0.10], null, [fs * 0.26, fs * 0.26, fs * 0.26]));
        c.g('lampAmber', G.sph(1, 6, 5), { m: fb });
      }
    }
  }
  c.lamp([0, 0.45 + H, 0], [1.0, 0.70, 0.40], 0.26, 2.2);
}

// ---------------------------------------------------------------- caps + supports
/** A bulkhead disc welded over a tube socket nobody connected anything to. */
function buildBulkhead(c, world, r) {
  const e = new Emit(c.b, c.lamps, world);
  // Oversized on purpose. The port is cut as a straight cylinder through a
  // CURVED shell, so the opening it leaves on the hull is wider than the socket
  // plane and a disc of exactly the port radius left blue slivers of open water
  // showing through at the top and bottom of every capped arch.
  e.g('wallOut', G.cyl(r + 0.34, r + 0.34, 0.18, 26), { r: [Math.PI / 2, 0, 0], p: [0, 0, 0.05], tint: TINT.hullDim });
  e.g('wallIn', G.cyl(r + 0.30, r + 0.30, 0.12, 26), { r: [Math.PI / 2, 0, 0], p: [0, 0, -0.12], tint: TINT.hull });
  e.g('trimOut', G.tor(r + 0.30, 0.09, 6, 26), { p: [0, 0, 0.03], tint: TINT.steel });
  e.g('trimOut', G.cyl(r + 0.24, r + 0.24, 0.16, 26, true), { r: [Math.PI / 2, 0, 0], p: [0, 0, 0.06], tint: TINT.void_ });
  for (let k = 0; k < 5; k++) {
    e.g('trimIn', G.box(r * 1.7, 0.07, 0.05), { p: [0, -r * 0.6 + k * r * 0.3, -0.16], tint: TINT.grey });
  }
  e.g('lampCyan', G.tor(r + 0.28, 0.022, 4, 26), { p: [0, 0, -0.19] });
}

/**
 * Pylons. The seabed under a base is never flat, so legs are generated per
 * piece from terrain.heightAt with a footpad that sinks below the surface —
 * geometry that meets sand at a hard line is LOOK.md §11's giveaway.
 */
function buildSupports(c, piece, heightAt) {
  if (!heightAt || piece.def.noSupport) return;
  const r = piece.def.footR;
  if (!r) return;
  // A module stacked on another module stands on THAT, not on the seabed. Without
  // this the upper multipurpose room grew six 20 m legs from its own underside,
  // straight down through the room below it — six dark exterior-material columns
  // planted across the middle of an interior that is supposed to be the payoff.
  for (const s of piece.sockets) {
    if ((s.n === 'down' || s.t === 'deck' || s.t === 'slab') && s.used) return;
  }
  const n = piece.def.footN || 4;
  const y0 = piece.pos.y;
  for (let k = 0; k < n; k++) {
    const a = k * TAU / n + (piece.def.footA || 0);
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
    _v.set(lx, 0, lz).applyMatrix4(piece.matrix);
    const g = heightAt(_v.x, _v.z);
    if (!Number.isFinite(g)) continue;
    const drop = y0 - piece.def.footTop - g;
    if (drop < 0.35) continue;                       // the hull is already bedded here
    const len = Math.min(drop + 1.2, 42);
    const cy = piece.def.footTop - len / 2 + 0.15;
    const taper = clamp(0.34 - len * 0.004, 0.16, 0.34);
    c.g('trimOut', G.cyl(0.34, taper, len, 10), { p: [lx, cy, lz], tint: TINT.steel });
    c.g('trimOut', G.cyl(taper * 2.6, taper * 3.4, 0.55, 12), { p: [lx, cy - len / 2 + 0.1, lz], tint: TINT.steel });
    // brace back to the hull so a long leg is not a lone stick
    if (len > 3) {
      const bl = Math.hypot(len * 0.55, r * 0.55);
      c.g('trimOut', G.cyl(0.10, 0.10, bl, 6), {
        p: [lx * 0.72, piece.def.footTop - len * 0.28, lz * 0.72],
        r: [Math.atan2(r * 0.55, len * 0.55) * Math.cos(a + Math.PI / 2), 0,
          Math.atan2(r * 0.55, len * 0.55) * -Math.sin(a + Math.PI / 2)],
        tint: TINT.steel,
      });
    }
  }
  // a hoop tying the legs together, which is what makes a stilted base read as engineered
  if (piece.def.footHoop) {
    _v.set(0, 0, 0).applyMatrix4(piece.matrix);
    const g = heightAt(_v.x, _v.z);
    if (Number.isFinite(g) && y0 - g > 4) {
      c.g('trimOut', G.tor(r, 0.09, 5, 20), { p: [0, piece.def.footTop - (y0 - g) * 0.55, 0], r: [Math.PI / 2, 0, 0], tint: TINT.steel });
    }
  }
}

// ============================================================== catalogue table
//
// cost   what the builder consumes
// hull   contribution to the cluster's hull integrity (windows and glass are
//        negative — Subnautica's rule, and the reason a nice base is a fragile one)
// draw   continuous power draw, kW
// gen    power generated, kW at full output
// foot*  auto-generated support pylons: ring radius, count, and the local y the
//        legs hang from

const DEFS = {
  corridor: {
    label: 'Corridor', group: 'structure', cost: { titanium: 2 }, hull: 5, draw: 0.03,
    r: CORR_LEN / 2 + TR, rClear: 1.72, hClear: 1.6, build: buildCorridor, footR: 0,
    flood: { shape: 'tube', r: TR, h: TR * 2, base: TAX - TR },
    sockets: (o) => {
      const L = o.len || CORR_LEN;
      return [
        { n: '-z', p: [0, TAX, -L / 2], d: [0, 0, -1], t: 'tube' },
        { n: '+z', p: [0, TAX, L / 2], d: [0, 0, 1], t: 'tube' },
        { n: 'w-x', p: [-TR - TT, TAX, 0], d: [-1, 0, 0], t: 'wall', meta: { side: '-x', z: 0 } },
        { n: 'w+x', p: [TR + TT, TAX, 0], d: [1, 0, 0], t: 'wall', meta: { side: '+x', z: 0 } },
        { n: 'roof', p: [0, TAX + TR + TT, 0], d: [0, 1, 0], t: 'deck' },
      ];
    },
    inside: (l, o) => Math.abs(l.z) <= (o.len || CORR_LEN) / 2 + 0.1
      && Math.hypot(l.x, l.y - TAX) <= TR + 0.05,
  },
  junction: {
    label: 'Junction', group: 'structure', cost: { titanium: 3 }, hull: 6, draw: 0.05,
    r: NODE_R + 0.4, rClear: 2.55, hClear: 2.0, build: buildJunction, footR: NODE_R * 0.62, footN: 4, footTop: -0.9, footHoop: true,
    flood: { shape: 'disc', r: NODE_R * 0.9, h: NODE_R + TAX, base: 0 },
    sockets: () => [
      { n: '+z', p: [0, TAX, NODE_R], d: [0, 0, 1], t: 'tube' },
      { n: '-z', p: [0, TAX, -NODE_R], d: [0, 0, -1], t: 'tube' },
      { n: '+x', p: [NODE_R, TAX, 0], d: [1, 0, 0], t: 'tube' },
      { n: '-x', p: [-NODE_R, TAX, 0], d: [-1, 0, 0], t: 'tube' },
      { n: 'up', p: [0, TAX + NODE_R, 0], d: [0, 1, 0], t: 'deck' },
      { n: 'down', p: [0, 0, 0], d: [0, -1, 0], t: 'shaft' },
    ],
    inside: (l) => Math.hypot(l.x, l.y - TAX, l.z) <= NODE_R + 0.05 && l.y >= -0.15,
  },
  room: {
    label: 'Multipurpose Room', group: 'structure', cost: { titanium: 6 }, hull: 12, draw: 0.12,
    r: ROOM_R + 0.5, rClear: 5.25, hClear: 2.0, build: buildRoom, footR: ROOM_R * 0.72, footN: 6, footTop: -0.7, footHoop: true,
    flood: { shape: 'disc', r: ROOM_R, h: ROOM_H + 0.4, base: 0 },
    sockets: () => {
      const s = [
        { n: '+z', p: [0, TAX, ROOM_R], d: [0, 0, 1], t: 'tube' },
        { n: '-z', p: [0, TAX, -ROOM_R], d: [0, 0, -1], t: 'tube' },
        { n: '+x', p: [ROOM_R, TAX, 0], d: [1, 0, 0], t: 'tube' },
        { n: '-x', p: [-ROOM_R, TAX, 0], d: [-1, 0, 0], t: 'tube' },
        { n: 'up', p: [0, 3.60, 0], d: [0, 1, 0], t: 'shaft' },
        { n: 'down', p: [0, -0.70, 0], d: [0, -1, 0], t: 'shaft' },
      ];
      for (let k = 0; k < 8; k++) {
        const a = (k + 0.5) * TAU / 8;
        s.push({
          n: `w${k}`, p: [Math.cos(a) * (ROOM_R + TT), 1.62, Math.sin(a) * (ROOM_R + TT)],
          d: [Math.cos(a), 0, Math.sin(a)], t: 'wall', meta: { az: a },
        });
      }
      for (let k = 0; k < 8; k++) {
        const a = (k + 0.5) * TAU / 8;
        s.push({
          n: `f${k}`, p: [Math.cos(a) * (ROOM_R - 0.62), 0, Math.sin(a) * (ROOM_R - 0.62)],
          d: [-Math.cos(a), 0, -Math.sin(a)], t: 'fitting',
        });
      }
      return s;
    },
    inside: (l) => Math.hypot(l.x, l.z) <= ROOM_R + 0.05 && l.y >= -0.15 && l.y <= 3.7,
  },
  observatory: {
    label: 'Observatory', group: 'structure', cost: { titanium: 2, glass: 3 }, hull: 2, weak: 3, draw: 0.10,
    r: OBS_R + 0.3, rClear: 4.85, hClear: 2.0, build: buildObservatory, footR: OBS_R * 0.68, footN: 5, footTop: -0.2,
    flood: { shape: 'disc', r: OBS_R, h: OBS_H, base: 0 },
    sockets: () => {
      const s = [{ n: '-z', p: [0, TAX, -OBS_R], d: [0, 0, -1], t: 'tube' }];
      for (let k = 0; k < 6; k++) {
        const a = k * TAU / 6 + 0.35;
        s.push({
          n: `f${k}`, p: [Math.cos(a) * (OBS_R - 1.9), 0, Math.sin(a) * (OBS_R - 1.9)],
          d: [-Math.cos(a), 0, -Math.sin(a)], t: 'fitting',
        });
      }
      return s;
    },
    inside: (l) => {
      const rr = Math.hypot(l.x, l.z) / OBS_R, yy = Math.max(0, l.y) / OBS_H;
      return rr * rr + yy * yy <= 1.02 && l.y >= -0.15;
    },
  },
  hatch: {
    label: 'Hatch', group: 'structure', cost: { titanium: 2, quartz: 1 }, hull: 1, weak: 1, draw: 0.02,
    r: TR + 1.6, build: buildHatch, attach: 'tube', exterior: true,
    sockets: () => [{ n: 'in', p: [0, 0, 0], d: [0, 0, -1], t: 'tube' }],
  },
  ladder: {
    label: 'Ladder', group: 'structure', cost: { titanium: 2 }, hull: 0, draw: 0,
    r: 1.2, build: buildLadder, attach: 'shaft',
    sockets: (o) => [
      { n: 'base', p: [0, 0, 0], d: [0, -1, 0], t: 'shaft' },
      { n: 'top', p: [0, o.height || 3.2, 0], d: [0, 1, 0], t: 'shaft' },
    ],
  },
  foundation: {
    label: 'Foundation', group: 'structure', cost: { titanium: 3 }, hull: 2, draw: 0,
    r: FOUND * 0.75, rClear: FOUND * 0.48, hClear: 0.6, build: buildFoundation, terrain: true,
    footR: FOUND * 0.42, footN: 4, footA: Math.PI / 4, footTop: -0.5,
    sockets: (o) => {
      const s = o.size || FOUND;
      return [
        { n: 'deck', p: [0, 0, 0], d: [0, 1, 0], t: 'deck' },
        { n: '+x', p: [s / 2, -0.15, 0], d: [1, 0, 0], t: 'slab' },
        { n: '-x', p: [-s / 2, -0.15, 0], d: [-1, 0, 0], t: 'slab' },
        { n: '+z', p: [0, -0.15, s / 2], d: [0, 0, 1], t: 'slab' },
        { n: '-z', p: [0, -0.15, -s / 2], d: [0, 0, -1], t: 'slab' },
      ];
    },
  },
  window: {
    label: 'Viewport', group: 'structure', cost: { titanium: 1, glass: 2 }, hull: 0, weak: 1, draw: 0,
    r: 1.8, attach: 'wall', build: () => {},   // drawn by the host so the pane follows its curvature
  },
  reinforcement: {
    label: 'Hull Reinforcement', group: 'structure', cost: { titanium: 3, lithium: 1 }, hull: 10, draw: 0,
    r: 1.8, attach: 'wall', build: buildReinforcement,
  },
  solar: {
    label: 'Solar Panel', group: 'power', cost: { titanium: 2, quartz: 2, copper: 1 },
    hull: 0, draw: 0, gen: 1.6, r: 1.6, rClear: 1.5, hClear: 1.5, build: buildSolar, attach: 'deck', terrain: true,
    footR: 0.55, footN: 3, footTop: 0,
  },
  thermal: {
    label: 'Thermal Plant', group: 'power', cost: { titanium: 2, copper: 2, magnetite: 1 },
    hull: 0, draw: 0, gen: 1.2, r: 1.8, rClear: 1.6, hClear: 1.8, build: buildThermal, terrain: true, thermal: true,
    footR: 1.0, footN: 3, footTop: 0,
  },
  locker: { label: 'Locker', group: 'interior', cost: { titanium: 2 }, hull: 0, draw: 0.01, r: 1.4, build: buildLocker, attach: 'fitting' },
  fabricator: { label: 'Fabricator', group: 'interior', cost: { titanium: 1, copper: 1 }, hull: 0, draw: 0.35, r: 1.2, build: buildFabricator, attach: 'fitting' },
  bed: { label: 'Bed', group: 'interior', cost: { titanium: 1 }, hull: 0, draw: 0.01, r: 1.4, build: buildBed, attach: 'fitting' },
  planter: { label: 'Interior Growbed', group: 'interior', cost: { titanium: 2 }, hull: 0, draw: 0.05, r: 1.2, build: buildPlanter, attach: 'fitting' },
  panel: { label: 'Control Panel', group: 'interior', cost: { titanium: 1, copper: 1 }, hull: 0, draw: 0.03, r: 1.2, build: buildPanel, attach: 'fitting' },
  medkit: { label: 'Medical Cabinet', group: 'interior', cost: { titanium: 1 }, hull: 0, draw: 0.02, r: 0.8, build: buildMedkit, attach: 'fitting' },
  lantern: { label: 'Lantern Tree', group: 'interior', cost: { titanium: 1 }, hull: 0, draw: 0.02, r: 1.6, build: buildLanternTree, attach: 'fitting' },
};
const KIND_ORDER = Object.keys(DEFS);

// ============================================================== world model

let nextId = 1;

class Piece {
  constructor(kind, pos, quat, opts = {}) {
    this.id = nextId++;
    this.kind = kind;
    this.def = DEFS[kind];
    this.opts = opts;
    this.len = opts.len || CORR_LEN;
    this.seed = opts.seed ?? (this.id * 2654435761) % 100003;
    this.pos = pos.clone();
    this.quat = quat.clone();
    this.matrix = new THREE.Matrix4().compose(this.pos, this.quat, _v2.set(1, 1, 1));
    this.inv = this.matrix.clone().invert();
    this.host = null;          // for wall/fitting attachments
    this.hostSocket = null;
    this.flood = 0;
    this.breach = null;
    this.cluster = 0;
    this.sockets = (this.def.sockets ? this.def.sockets(opts) : []).map((s, i) => ({
      i, n: s.n, t: s.t, meta: s.meta || null, used: null, piece: this,
      lp: new THREE.Vector3(s.p[0], s.p[1], s.p[2]),
      ld: new THREE.Vector3(s.d[0], s.d[1], s.d[2]),
      wp: new THREE.Vector3(), wd: new THREE.Vector3(),
    }));
    this.refresh();
  }
  refresh() {
    this.matrix.compose(this.pos, this.quat, _v2.set(1, 1, 1));
    this.inv.copy(this.matrix).invert();
    for (const s of this.sockets) {
      s.wp.copy(s.lp).applyMatrix4(this.matrix);
      s.wd.copy(s.ld).applyQuaternion(this.quat).normalize();
    }
  }
  toLocal(v, out) { return out.copy(v).applyMatrix4(this.inv); }
  contains(v) {
    if (!this.def.inside) return false;
    this.toLocal(v, _v2);
    return this.def.inside(_v2, this.opts);
  }
  /** wall sockets currently occupied by a viewport, for the shell's hole mask */
  windowMeta() {
    const out = [];
    for (const s of this.sockets) {
      if (s.t === 'wall' && s.used && s.used.kind === 'window') out.push(s.meta);
    }
    return out;
  }
  connectedNames() {
    const out = [];
    for (const s of this.sockets) if (s.used && s.t !== 'wall' && s.t !== 'fitting') out.push(s.n);
    return out;
  }
}

// ============================================================== resources
const FALLBACK_STOCK = {
  titanium: 48, glass: 22, quartz: 16, copper: 12, lithium: 6, magnetite: 5,
};
const RES_LABEL = {
  titanium: 'Titanium', glass: 'Glass', quartz: 'Quartz',
  copper: 'Copper', lithium: 'Lithium', magnetite: 'Magnetite',
};

/**
 * The builder draws from player/tools.js's inventory when that module publishes
 * one, and from an internal stock otherwise. Guarded on every call: tools is
 * allowed to be a stub, and the base still has to be buildable so it can be
 * judged.
 */
class Resources {
  constructor(ctx) { this.ctx = ctx; this.local = { ...FALLBACK_STOCK }; }
  get ext() {
    const t = this.ctx.get?.('tools');
    const inv = t?.inventory;
    return (inv && (typeof inv.count === 'function' || typeof inv.get === 'function')) ? inv : null;
  }
  count(k) {
    const e = this.ext;
    if (e) { try { return (e.count ? e.count(k) : e.get(k)) | 0; } catch { /* fall through */ } }
    return this.local[k] | 0;
  }
  has(cost) { for (const k in cost) if (this.count(k) < cost[k]) return false; return true; }
  missing(cost) {
    const out = [];
    for (const k in cost) { const d = cost[k] - this.count(k); if (d > 0) out.push({ k, d }); }
    return out;
  }
  take(cost) {
    if (!this.has(cost)) return false;
    const e = this.ext;
    for (const k in cost) {
      if (e && e.take) { try { e.take(k, cost[k]); continue; } catch { /* fall through */ } }
      this.local[k] = (this.local[k] | 0) - cost[k];
    }
    return true;
  }
  give(cost) {
    const e = this.ext;
    for (const k in cost) {
      if (e && e.add) { try { e.add(k, cost[k]); continue; } catch { /* fall through */ } }
      this.local[k] = (this.local[k] | 0) + cost[k];
    }
  }
}

// ============================================================== module state
let CTX = null;
let group = null;          // merged static hull
let dynGroup = null;       // flood planes, leaks, ghost
let ghostRoot = null;
let RES = null;
let RNG = null;
let terrainAPI = null;
let meshes = [];
let lampList = [];
let lampOutList = [];
const PIECES = [];
let dirty = true;

/** Bake dimmer + tint, so a power failure can drop the interior to emergency red. */
const BAKE_LEVEL = { value: 1.0 };
const BAKE_TINT = { value: new THREE.Color(1, 1, 1) };
let BAKE_DEBUG = 1;

// ============================================================== light bake
/**
 * Per-vertex interior irradiance from the lamps each piece registered. This is
 * injected into totalEmissiveRadiance because core exempts emissive from the
 * ocean's depth response — see the file header. The 0.16 wrap on N.L keeps
 * upward-facing ceilings and downward-facing sills from going black, which is
 * what a real diffusing habitat panel does.
 */
function makeBakeFn(lamps, interior) {
  // Interior surfaces are now lit ENTIRELY by this (bakeInject unplugs the world
  // lighting from them), so the numbers below are the whole lighting rig, not a
  // supplement to one. Exterior skin still takes real scene lighting and only
  // gets its own hull floods on top, hence the far smaller ambient and clamp.
  /**
   * AMB up, CAP down — the interior's histogram was the wrong SHAPE, not the
   * wrong brightness. Measured against the same crop of base-interior-1:
   *
   *              ours          reference
   *   median     101.2         126.0
   *   p99        250.8         159.8
   *   >= 250     5.45% of px   0.00%
   *
   * i.e. our room was simultaneously too dark in the body and blown at the top.
   * Raising the floor and lowering the ceiling compresses toward the reference
   * from both ends at once, which is also exactly what a diffusing habitat panel
   * physically does to a small bright volume.
   *
   * First pass overshot the ceiling correction — clipping went to 0.00% but the
   * body went with it (crop median 108 -> 74, whole frame 61 -> 53 mean, against
   * a reference frame that is BRIGHTER than either at 76.6). The peaks were never
   * the bake's fault: they were lampWarm sitting at emissive 3.15. With the
   * fixtures now shaped and halved, the cap can come back up and take the median
   * with it while the p99 stays where it is.
   *
   * The TINT is a separate correction and it goes the other way. A matched
   * panel patch measured R 155.7 / G 127.6 / B 118.7 against base-interior-1's
   * 132.6 / 142.3 / 140.7: red is our brightest channel and it is the
   * reference's DIMMEST. Subnautica's habitat interiors are neutral-to-cool
   * white; the warmth in base-interior-1 comes from the lantern tree and the
   * orange trim, not from the room light. The emotional contrast against the
   * ocean survives that easily — it is a dry, bright, finite volume against a
   * cold infinite one, and it does not need to be tinted amber to say so.
   */
  const AMB = interior ? [0.438, 0.450, 0.442] : [0.026, 0.026, 0.026];
  const CAP = interior ? 1.16 : 0.50;
  const CELL = 5.0;
  const grid = new Map();
  for (const L of lamps) {
    const gx = Math.floor(L.x / CELL), gy = Math.floor(L.y / CELL), gz = Math.floor(L.z / CELL);
    const rad = Math.ceil((L.r * 2.2) / CELL);
    for (let i = -rad; i <= rad; i++) for (let j = -rad; j <= rad; j++) for (let k = -rad; k <= rad; k++) {
      const key = `${gx + i},${gy + j},${gz + k}`;
      let a = grid.get(key);
      if (!a) { a = []; grid.set(key, a); }
      a.push(L);
    }
  }
  const out = [0, 0, 0];
  return (x, y, z, nx, ny, nz) => {
    // A dry habitat is warm, but only just: base-interior-1 measures saturation
    // 0.102 and base-interior-3 0.234, so the target is a NEUTRAL-warm white
    // with red only fractionally ahead — enough that red stays the dominant
    // channel after the residual path through the medium, and nowhere near the
    // 0.44-0.56 salmon a critic measured off the old night bake.
    let r = AMB[0], g = AMB[1], b = AMB[2];
    const a = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`);
    if (a) {
      for (let i = 0; i < a.length; i++) {
        const L = a[i];
        const dx = L.x - x, dy = L.y - y, dz = L.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2) || 1e-4;
        const ndl = Math.max(0.16, (nx * dx + ny * dy + nz * dz) / d);
        const att = L.p / (1 + d2 / (L.r * L.r));
        const w = ndl * att;
        r += L.c[0] * w; g += L.c[1] * w; b += L.c[2] * w;
      }
    }
    // Clamp on LUMINANCE, not per channel. Clamping per channel drove every
    // brightly lit surface to exactly (cap, cap, cap) and every dim one to the
    // raw warm ambient, which is how the same room measured neutral by day and
    // salmon at night. Scaling the triple preserves its hue at any level.
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m > CAP) { const k = CAP / m; r *= k; g *= k; b *= k; }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
  };
}

/**
 * SKY OCCLUSION for the exterior skin, folded into vertex colour.
 *
 * The whole-game critic's word for our base was "a flat cyan ghost with no
 * thickness", and the measurement behind it is unambiguous: a hull crop of the
 * shallows-reef framing had a 1st-percentile luminance of 99.9 and a median of
 * 141, against 71.2 / 126.1 for the reference base in shallows-reef-3.jpg. Every
 * pixel of our hull sat in the top half of the range. There was no shadow on it
 * anywhere, and a solid with no shadow on it is a decal.
 *
 * Downwelling light underwater arrives from a hemisphere overhead, so an
 * up-facing plate is lit and a down-facing one is not — that single term gives a
 * cylinder a terminator, gives every rib and collar an underside, and pushes the
 * dark tail of the histogram down where the reference's is. It goes in ALBEDO
 * rather than in the bake because albedo is then multiplied by the real sun and
 * vanishes at night, which is what an occlusion term must do; the bake feeds
 * totalEmissiveRadiance, which core exempts from every daylight response, and a
 * sky gradient baked there would still be glowing at midnight.
 */
function exteriorShade(x, y, z, nx, ny, nz) {
  return 0.32 + 0.88 * sstep(-0.90, 0.80, ny);
}

// ============================================================== rebuild
function disposeMeshes() {
  for (const m of meshes) { m.geometry.dispose(); group.remove(m); }
  meshes.length = 0;
}

function rebuild() {
  dirty = false;
  disposeMeshes();
  linkAll();
  recomputeClusters();
  lampList = [];
  lampOutList = [];
  const heightAt = terrainAPI?.heightAt;

  /**
   * One batch set PER CLUSTER, not one for the whole world. Merging two stations
   * 130 m apart into single meshes gave every one of them a bounding sphere that
   * covers the map, so nothing was ever frustum-culled and the transparent glass
   * and light-spill quads were re-sorted and re-drawn in frames the base is not
   * even in — measured at +2.7 ms on the godrays framing, where the nearest hull
   * is 65 m behind the camera.
   */
  const sets = new Map();
  const setFor = (cid) => {
    let s = sets.get(cid);
    if (!s) {
      s = { _glow: new GlowBatch() };
      for (const k of BATCH_KEYS) s[k] = new Batch(k);
      sets.set(cid, s);
    }
    return s;
  };

  for (const piece of PIECES) {
    const batches = setFor(Math.max(0, piece.cluster));
    const def = piece.def;
    // shell holes: tube ports are always flanged (free ones get a blanking
    // plate below); shafts are only cut where something is actually attached.
    const ports = [];
    for (const s of piece.sockets) {
      if (s.t === 'tube') ports.push(s.n);
      else if ((s.t === 'shaft' || s.t === 'deck') && s.used) ports.push(s.n);
    }
    piece.opts.ports = ports;
    const wm = piece.windowMeta();
    piece.opts.windows = piece.kind === 'room' ? wm.map((m) => m.az) : wm;

    const em = new Emit(batches, lampList, piece.matrix, lampOutList, batches._glow);
    try { def.build?.(em, piece); } catch (e) { console.warn('[base] piece build', piece.kind, e); }
    try { buildSupports(em, piece, heightAt); } catch (e) { console.warn('[base] supports', e); }

    // blanking plates over unused tube sockets
    for (const s of piece.sockets) {
      if (s.t !== 'tube' || s.used) continue;
      const bm = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromUnitVectors(_v.set(0, 0, 1), s.wd);
      bm.compose(s.wp, q, _v2.set(1, 1, 1));
      buildBulkhead({ b: batches, lamps: lampList }, bm, TR);
    }
  }

  const bakeIn = makeBakeFn(lampList, true);
  const bakeOut = makeBakeFn(lampOutList, false);
  for (const [cid, batches] of sets) {
    for (const k of BATCH_KEYS) {
      const b = batches[k];
      if (b.empty) continue;
      const inside = INTERIOR_KEYS.has(k);
      // 'glass' is exterior-side but must NOT take sky occlusion: a pane is not
      // a lit surface, it is a hole with a sheen on it, and darkening its lower
      // half would put a grey wash across the observatory's whole view.
      const geo = b.build(inside ? bakeIn : bakeOut,
        (inside || k === 'glass' || k === 'portGlow') ? null : exteriorShade);
      const mesh = new THREE.Mesh(geo, MATS[k]);
      mesh.name = `base.${cid}.${k}`;
      mesh.matrixAutoUpdate = false;
      if (k === 'glass') {
        // excluded from the sun-shadow rig (render/underwater.js skips renderOrder != 0)
        // because a pane that casts a hard shadow puts the observatory in its own dark.
        mesh.renderOrder = 2;
        mesh.userData.noShadow = true;
        mesh.castShadow = false; mesh.receiveShadow = false;
      }
      group.add(mesh);
      meshes.push(mesh);
    }
    if (!batches._glow.empty) {
      const gm = new THREE.Mesh(batches._glow.build(), MATS.spill);
      gm.name = `base.${cid}.glow`;
      gm.matrixAutoUpdate = false;
      gm.frustumCulled = true;
      // after the glass (2) so a port wash reads through the pane, and it writes
      // no depth so nothing downstream is occluded by an invisible sprite corner
      gm.renderOrder = 5;
      gm.userData.noShadow = true;
      gm.castShadow = false; gm.receiveShadow = false;
      group.add(gm);
      meshes.push(gm);
    }
  }
  CTX?.engine?.CN?.enableShadows?.(group);
}

// ============================================================== placement
function socketWorldFits(a, b) {
  // two sockets mate when they are coincident and face each other
  return a.wp.distanceTo(b.wp) < 0.42 && a.wd.dot(b.wd) < -0.80;
}

function linkAll() {
  for (const p of PIECES) for (const s of p.sockets) if (!s.used || !PIECES.includes(s.used)) s.used = null;
  for (let i = 0; i < PIECES.length; i++) {
    for (const a of PIECES[i].sockets) {
      if (a.used || a.t === 'wall' || a.t === 'fitting') continue;
      for (let j = 0; j < PIECES.length; j++) {
        if (i === j) continue;
        for (const b of PIECES[j].sockets) {
          if (b.used || b.t !== a.t) continue;
          if (socketWorldFits(a, b)) { a.used = PIECES[j]; b.used = PIECES[i]; break; }
        }
        if (a.used) break;
      }
    }
  }
  // attachments (hatch / window / reinforcement / fittings) re-bind to their host
  for (const p of PIECES) {
    if (!p.host || !p.hostSocket) continue;
    p.hostSocket.used = p;
  }
}

function recomputeClusters() {
  for (const p of PIECES) p.cluster = -1;
  let c = 0;
  for (const p of PIECES) {
    if (p.cluster >= 0) continue;
    const stack = [p];
    p.cluster = c;
    while (stack.length) {
      const q = stack.pop();
      const nbr = [];
      for (const s of q.sockets) if (s.used instanceof Piece) nbr.push(s.used);
      if (q.host) nbr.push(q.host);
      for (const r of PIECES) if (r.host === q) nbr.push(r);
      for (const n of nbr) if (n.cluster < 0) { n.cluster = c; stack.push(n); }
    }
    c++;
  }

  // A solar panel standing on the sand ten metres from the hull is on that
  // base's grid, not on a grid of its own. Without this the authored station
  // reported 0 kW generated while three panels sat beside it in their own
  // one-piece clusters.
  const hubs = PIECES.filter((p) => p.def.inside);
  for (const p of PIECES) {
    if (p.def.inside || p.host) continue;
    let bd = 60, bc = -1;
    for (const q of hubs) {
      const d = p.pos.distanceTo(q.pos) - (q.def.r || 0);
      if (d < bd) { bd = d; bc = q.cluster; }
    }
    if (bc >= 0) p.cluster = bc;
  }

  // Re-index AFTER the re-home pass. clusterCount used to be assigned before it,
  // so bases() reported 8 stations for the two that exist and the ids left in
  // use were a sparse {0, 5} — which also meant simPower/simHull iterated six
  // grids that no longer had any pieces on them. Renumber to a dense range so
  // the published count is the count and the sim loops stay tight.
  const remap = new Map();
  for (const p of PIECES) {
    if (!remap.has(p.cluster)) remap.set(p.cluster, remap.size);
    p.cluster = remap.get(p.cluster);
  }
  clusterCount = remap.size;
}
let clusterCount = 0;

/**
 * Align a new piece so that its socket `slotName` mates with `target`.
 * roll rotates the piece about the socket axis in 90-degree steps.
 */
function poseForSocket(kind, opts, slotName, target, roll = 0) {
  const defS = DEFS[kind].sockets ? DEFS[kind].sockets(opts) : [];
  const slot = defS.find((s) => s.n === slotName) || defS[0];
  if (!slot) return null;
  const ld = new THREE.Vector3(slot.d[0], slot.d[1], slot.d[2]).normalize();
  const want = target.wd.clone().negate();
  const q = new THREE.Quaternion().setFromUnitVectors(ld, want);
  if (roll) q.premultiply(new THREE.Quaternion().setFromAxisAngle(want, roll * Math.PI / 2));
  const lp = new THREE.Vector3(slot.p[0], slot.p[1], slot.p[2]).applyQuaternion(q);
  return { pos: target.wp.clone().sub(lp), quat: q };
}

/**
 * Clearance test, split into horizontal and vertical because a base is built by
 * abutting things on purpose. A single bounding sphere refused to let a corridor
 * dock onto the junction it was aimed at, and refused to let a second room stack
 * on the first — both of which are the whole point of a modular habitat.
 */
function overlaps(kind, pos, ignore) {
  const d = DEFS[kind];
  const rA = d.rClear ?? (d.r || 1) * 0.5, hA = d.hClear ?? 1.4;
  for (const p of PIECES) {
    if (p === ignore || p.host) continue;
    const rB = p.def.rClear ?? (p.def.r || 1) * 0.5, hB = p.def.hClear ?? 1.4;
    const dxz = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
    const dy = Math.abs(p.pos.y - pos.y);
    if (dxz < rA + rB - 0.05 && dy < hA + hB - 0.05) return p;
  }
  return null;
}

function addPiece(kind, pos, quat, opts = {}) {
  const p = new Piece(kind, pos, quat, opts);
  PIECES.push(p);
  linkAll();
  dirty = true;
  return p;
}

function attach(host, socket, kind, opts = {}, roll = 0) {
  const pose = poseForSocket(kind, opts, (DEFS[kind].sockets ? DEFS[kind].sockets(opts)[0].n : 'in'), socket, roll);
  let p;
  if (pose) p = new Piece(kind, pose.pos, pose.quat, opts);
  else {
    // Fittings and wall units have no sockets of their own. A fitting socket's
    // direction points INTO the room and a wall socket's points out of it, so
    // mapping local +Z onto it puts a locker's face toward the volume and a
    // reinforcement plate's ribs toward the water with the same rule.
    const q = new THREE.Quaternion().setFromUnitVectors(_v.set(0, 0, 1), socket.wd);
    p = new Piece(kind, socket.wp.clone(), q, opts);
  }
  p.host = host; p.hostSocket = socket;
  socket.used = p;
  const back = p.sockets.find((s) => s.t === socket.t);
  if (back) back.used = host;
  PIECES.push(p);
  linkAll();
  dirty = true;
  return p;
}

function removePiece(p) {
  const i = PIECES.indexOf(p);
  if (i < 0) return false;
  // take its attachments with it
  for (const q of PIECES.slice()) if (q.host === p) removePiece(q);
  PIECES.splice(PIECES.indexOf(p), 1);
  for (const q of PIECES) for (const s of q.sockets) if (s.used === p) s.used = null;
  linkAll();
  dirty = true;
  return true;
}

// ============================================================== authored bases
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const QI = new THREE.Quaternion();
const sock = (p, n) => p.sockets.find((s) => s.n === n);

/**
 * Home Reef Station — authored against core/shots.js's `base-interior` camera,
 * which stands at (-60, -30, -30) looking +Z. That camera lands 1.65 m above
 * this deck and 1.2 m inside the observatory's rear opening, so the frame is
 * the dome's interior with nine metres of glass ahead of it and the reef wall
 * beyond — the framing in base-interior-1, with our own ocean in the window.
 *
 * The site is a gully wall: the seabed under the observatory is 3 m down and
 * under the far room it is 20 m down, so the legs are generated per piece from
 * terrain.heightAt rather than authored. A station on stilts at the head of a
 * drop-off is what misc-6.jpg and deep-void-4.jpg actually look like.
 */
function layoutHomeReef() {
  const DY = -31.65;
  const X = -63.2;
  const obs = addPiece('observatory', V3(X, DY, -28.0), QI);
  const c1 = addPiece('corridor', V3(X, DY, -35.5), QI, { len: CORR_LEN });
  const j = addPiece('junction', V3(X, DY, -40.7), QI);
  const c2 = addPiece('corridor', V3(X, DY, -45.9), QI, { len: CORR_LEN });
  const r1 = addPiece('room', V3(X, DY, -53.8), QI);
  const r2 = addPiece('room', V3(X, DY + 4.30, -53.8), QI);

  const lad = addPiece('ladder', V3(X, DY + 0.05, -53.8), QI, { height: 4.25 });
  lad.host = r1;

  attach(j, sock(j, '+x'), 'hatch');

  attach(c1, sock(c1, 'w+x'), 'window');
  attach(c2, sock(c2, 'w-x'), 'window');
  for (const k of [0, 2, 4, 6]) attach(r1, sock(r1, `w${k}`), 'window');
  for (const k of [1, 3, 5, 7]) attach(r2, sock(r2, `w${k}`), 'window');
  attach(r1, sock(r1, 'w1'), 'reinforcement');
  attach(r1, sock(r1, 'w5'), 'reinforcement');

  // interior fit-out. The ordering here is composition, not convenience: the
  // observatory keeps its forward arc clear so the money shot is glass, and
  // puts the lantern tree and a growbed in the near corners instead.
  // f5 is deliberately empty: that slot is where the shot camera stands.
  attach(obs, sock(obs, 'f1'), 'lantern', { height: 2.35 });
  attach(obs, sock(obs, 'f0'), 'planter');
  attach(obs, sock(obs, 'f3'), 'panel');
  attach(obs, sock(obs, 'f4'), 'locker');
  attach(obs, sock(obs, 'f2'), 'planter');

  attach(r1, sock(r1, 'f0'), 'fabricator');
  attach(r1, sock(r1, 'f1'), 'locker');
  attach(r1, sock(r1, 'f2'), 'medkit');
  attach(r1, sock(r1, 'f3'), 'bed');
  attach(r1, sock(r1, 'f5'), 'planter');
  attach(r1, sock(r1, 'f6'), 'panel');
  attach(r2, sock(r2, 'f0'), 'planter');
  attach(r2, sock(r2, 'f2'), 'planter');
  attach(r2, sock(r2, 'f4'), 'locker');
  attach(r2, sock(r2, 'f6'), 'lantern', { height: 2.1 });

  // power farm on the shelf beside the hatch, sitting on the seabed
  const h = terrainAPI?.heightAt;
  const onGround = (x, z, fallback) => {
    const y = h ? h(x, z) : NaN;
    return Number.isFinite(y) ? y : fallback;
  };
  addPiece('solar', V3(-54.6, onGround(-54.6, -34.4, -33) + 0.15, -34.4), QI);
  addPiece('solar', V3(-52.4, onGround(-52.4, -37.6, -32) + 0.15, -37.6), QI);
  addPiece('thermal', V3(-57.2, onGround(-57.2, -45.2, -40) + 0.10, -45.2), QI);
  addPiece('foundation', V3(-53.6, onGround(-53.6, -35.9, -33) + 0.55, -35.9), QI);
  return obs;
}

/**
 * A second, smaller station placed on the `shallows-reef` / `night-shallows`
 * sightline, because the exterior read — a lit hull in dark water — is half of
 * what a seabase is for, and shallows-reef-3.jpg is literally a promo shot of
 * one. Auto-sited: it walks out along the camera bearing looking for the
 * flattest patch it can stand on.
 */
function layoutOutpost() {
  const h = terrainAPI?.heightAt;
  if (!h) return null;
  const ox = 30, oz = 40, fx = 0.866, fz = 0.50;
  let best = null;
  for (let d = 26; d <= 46; d += 2) {
    for (let s = -12; s <= 12; s += 4) {
      const x = ox + fx * d - fz * s, z = oz + fz * d + fx * s;
      let hi = -1e9, lo = 1e9, ok = true;
      for (let a = 0; a < 8; a++) {
        const t = a * TAU / 8;
        const y = h(x + Math.cos(t) * 7, z + Math.sin(t) * 7);
        if (!Number.isFinite(y)) { ok = false; break; }
        hi = Math.max(hi, y); lo = Math.min(lo, y);
      }
      if (!ok) continue;
      const centre = h(x, z);
      if (!Number.isFinite(centre) || centre > -12 || centre < -34) continue;
      const score = (hi - lo) + Math.abs(d - 34) * 0.25;
      if (!best || score < best.score) best = { x, z, hi, score };
    }
  }
  if (!best) return null;
  const DY = best.hi + 1.9;
  const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.75, 0));
  const obs = addPiece('observatory', V3(best.x, DY, best.z), yaw);
  // solve each pose against the previous piece's free port before inserting, so
  // linkAll() never sees a piece sitting at the origin and mates it to nothing
  const p1 = poseForSocket('corridor', { len: CORR_LEN }, '+z', sock(obs, '-z'), 0);
  const c1 = addPiece('corridor', p1.pos, p1.quat, { len: CORR_LEN });
  const p2 = poseForSocket('room', {}, '+z', sock(c1, '-z'), 0);
  const r1 = addPiece('room', p2.pos, p2.quat);
  attach(r1, sock(r1, '+x'), 'hatch');
  for (const k of [0, 2, 4, 6]) attach(r1, sock(r1, `w${k}`), 'window');
  attach(c1, sock(c1, 'w+x'), 'window');
  attach(r1, sock(r1, 'f0'), 'fabricator');
  attach(r1, sock(r1, 'f2'), 'locker');
  attach(r1, sock(r1, 'f4'), 'planter');
  attach(r1, sock(r1, 'f6'), 'bed');
  attach(obs, sock(obs, 'f2'), 'lantern', { height: 2.2 });
  attach(obs, sock(obs, 'f5'), 'panel');
  const gy = h(best.x + 8, best.z - 5);
  addPiece('solar', V3(best.x + 8, (Number.isFinite(gy) ? gy : DY - 3) + 0.15, best.z - 5), QI);
  const gy2 = h(best.x + 5.5, best.z - 9);
  addPiece('solar', V3(best.x + 5.5, (Number.isFinite(gy2) ? gy2 : DY - 3) + 0.15, best.z - 9), QI);
  return obs;
}

// ============================================================== build tool
const tool = {
  active: false,
  idx: 0,
  roll: 0,
  pose: null,
  target: null,
  valid: false,
  msg: '',
  ghostKind: null,
  ghost: null,
  ghostWire: null,
};
const BUILDABLE = KIND_ORDER.slice();

function currentKind() { return BUILDABLE[tool.idx % BUILDABLE.length]; }

/** One merged, material-less copy of a piece, used as the holographic preview. */
function makeGhost(kind) {
  const opts = { len: CORR_LEN, height: 3.2, ports: [], windows: [] };
  const batches = {};
  for (const k of BATCH_KEYS) batches[k] = new Batch(k);
  // new Piece() deliberately does not register itself; only addPiece() does,
  // so this stand-in never enters the world.
  const fake = new Piece(kind, V3(0, 0, 0), QI, opts);
  fake.opts.ports = fake.sockets.filter((s) => s.t === 'tube').map((s) => s.n);
  const em = new Emit(batches, [], new THREE.Matrix4());
  try { DEFS[kind].build?.(em, fake); } catch { /* preview only */ }
  const all = new Batch('ghost');
  const cat = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
  for (const k of BATCH_KEYS) {
    const b = batches[k];
    if (b.empty) continue;
    cat(all.pos, b.pos); cat(all.nor, b.nor); cat(all.uv, b.uv); cat(all.col, b.col);
    all.count += b.count;
  }
  if (all.empty) {
    // window and other pure-attachment kinds: show the pane they will create
    all.add(roundedSlab(2.6, 1.9, 0.12, 0.4), new THREE.Matrix4(), TINT.white);
  }
  return all.build(null);
}

function ensureGhost(kind) {
  if (tool.ghostKind === kind && tool.ghost) return;
  if (tool.ghost) { tool.ghost.geometry.dispose(); ghostRoot.remove(tool.ghost); }
  if (tool.ghostWire) { ghostRoot.remove(tool.ghostWire); }
  const geo = makeGhost(kind);
  tool.ghost = new THREE.Mesh(geo, MATS.ghostOk);
  tool.ghost.userData.noShadow = true;
  tool.ghost.castShadow = false; tool.ghost.receiveShadow = false;
  tool.ghost.renderOrder = 900;
  tool.ghostWire = new THREE.Mesh(geo, MATS.ghostWire);
  tool.ghostWire.userData.noShadow = true;
  tool.ghostWire.castShadow = false; tool.ghostWire.receiveShadow = false;
  tool.ghostWire.renderOrder = 901;
  ghostRoot.add(tool.ghost, tool.ghostWire);
  tool.ghostKind = kind;
}

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Which socket type does this kind mate with? */
function mateType(kind) {
  const d = DEFS[kind];
  if (d.attach) return d.attach;
  const s = d.sockets ? d.sockets({ len: CORR_LEN }) : [];
  const first = s.find((x) => x.t === 'tube' || x.t === 'shaft' || x.t === 'deck');
  return first ? first.t : 'tube';
}

function solveGhost(ctx) {
  const kind = currentKind();
  const def = DEFS[kind];
  const cam = ctx.camera;
  cam.getWorldDirection(_fwd);
  const eye = cam.position;

  tool.target = null; tool.pose = null; tool.valid = false; tool.msg = '';

  const need = mateType(kind);
  let best = null, bestScore = -1;
  for (const p of PIECES) {
    for (const s of p.sockets) {
      if (s.used || s.t !== need) continue;
      _to.copy(s.wp).sub(eye);
      const dist = _to.length();
      if (dist > 26 || dist < 0.2) continue;
      _to.divideScalar(dist);
      const aim = _to.dot(_fwd);
      if (aim < 0.55) continue;
      const score = aim * 2.2 - dist * 0.035;
      if (score > bestScore) { bestScore = score; best = s; }
    }
  }

  if (best) {
    tool.target = best;
    if (def.attach) {
      const q = new THREE.Quaternion();
      const pose = poseForSocket(kind, {}, def.sockets ? def.sockets({})[0].n : 'in', best, tool.roll);
      if (pose) tool.pose = pose;
      else { q.setFromUnitVectors(_v.set(0, 0, 1), best.wd); tool.pose = { pos: best.wp.clone(), quat: q }; }
    } else {
      const slots = def.sockets({ len: CORR_LEN }).filter((s) => s.t === need);
      const slot = slots[Math.abs(tool.roll) % Math.max(1, slots.length)];
      tool.pose = poseForSocket(kind, { len: CORR_LEN }, slot ? slot.n : slots[0]?.n, best, 0);
    }
  } else if (def.terrain && terrainAPI?.heightAt) {
    // free placement on the seabed, for foundations and generators
    let hit = null;
    for (let d = 3; d < 34; d += 0.6) {
      _to.copy(_fwd).multiplyScalar(d).add(eye);
      const g = terrainAPI.heightAt(_to.x, _to.z);
      if (Number.isFinite(g) && _to.y <= g) { hit = new THREE.Vector3(_to.x, g + 0.1, _to.z); break; }
    }
    if (hit) tool.pose = { pos: hit, quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, tool.roll * Math.PI / 2, 0)) };
    else tool.msg = 'no seabed in range';
  } else {
    tool.msg = def.attach ? `needs a free ${need} point` : 'aim at a connection point';
  }

  if (!tool.pose) return;
  const cost = def.cost || {};
  const miss = RES.missing(cost);
  if (miss.length) {
    tool.msg = 'missing ' + miss.map((m) => `${m.d} ${RES_LABEL[m.k] || m.k}`).join(', ');
  } else if (!def.attach && overlaps(kind, tool.pose.pos, null)) {
    tool.msg = 'blocked by existing structure';
  } else {
    tool.valid = true;
    tool.msg = 'ready';
  }
  ensureGhost(kind);
  tool.ghost.position.copy(tool.pose.pos);
  tool.ghost.quaternion.copy(tool.pose.quat);
  tool.ghost.material = tool.valid ? MATS.ghostOk : MATS.ghostBad;
  tool.ghostWire.position.copy(tool.pose.pos);
  tool.ghostWire.quaternion.copy(tool.pose.quat);
}

function commitBuild() {
  if (!tool.valid || !tool.pose) return null;
  const kind = currentKind();
  const def = DEFS[kind];
  if (!RES.take(def.cost || {})) return null;
  let p;
  if (def.attach && tool.target) {
    p = attach(tool.target.piece, tool.target, kind, kind === 'ladder' ? { height: 3.2 } : {}, tool.roll);
  } else {
    p = addPiece(kind, tool.pose.pos, tool.pose.quat, kind === 'corridor' ? { len: CORR_LEN } : {});
  }
  notify(`${def.label} constructed`);
  return p;
}

function deconstructAim(ctx) {
  const cam = ctx.camera;
  cam.getWorldDirection(_fwd);
  let best = null, bestScore = 0.72;
  for (const p of PIECES) {
    if (p.locked) continue;
    _to.copy(p.pos).sub(cam.position);
    const d = _to.length();
    if (d > 22) continue;
    _to.divideScalar(d);
    const aim = _to.dot(_fwd);
    if (aim > bestScore) { bestScore = aim; best = p; }
  }
  if (!best) { notify('nothing to deconstruct'); return; }
  RES.give(best.def.cost || {});
  notify(`${best.def.label} deconstructed`);
  removePiece(best);
}

// ============================================================== simulation
const power = { generated: 0, consumed: 0, stored: 120, capacity: 150, ratio: 1 };
const hull = { strength: 0, load: 0, integrity: 0, crushDepth: 0, breaches: 0, stress: 0 };
const leaks = [];
const floodMeshes = new Map();
let insidePiece = null;
let repairT = 0;

/**
 * Thermal yield at a point. There is no ocean-temperature module to ask, so
 * this is the physical shape of one: cold everywhere shallow, hot near the
 * volcanic depths and hotter still beside anything structures.js flagged as a
 * vent. Guarded — a stub landmark list simply leaves the depth term.
 */
function thermalYield(pos) {
  const depth = Math.max(0, -pos.y);
  let t = 0.10 + 0.90 * clamp01((depth - 220) / 900);
  const st = CTX?.get?.('structures');
  const marks = st?.landmarks?.();
  if (Array.isArray(marks)) {
    for (const m of marks) {
      if (!/vent|lava|thermal|geo/i.test(String(m.kind) + String(m.id))) continue;
      const d = Math.hypot(m.x - pos.x, (m.y ?? pos.y) - pos.y, m.z - pos.z);
      t = Math.max(t, clamp01(1.15 - d / 40));
    }
  }
  return clamp01(t);
}

/**
 * Power and hull are per CLUSTER, not global: two stations twenty metres apart
 * do not share a grid or a pressure hull, and summing them meant the outpost's
 * viewports were flooding the home base.
 */
const cluster = [];
function clusterOf(i) {
  while (cluster.length <= i) cluster.push({ stored: 90, gen: 0, draw: 0, cap: 40, strength: 0, deepest: 0, stress: 0 });
  return cluster[i];
}

function simPower(dt) {
  const sun = clamp01(U.uSunDir.value.y * 1.7);
  for (let i = 0; i < clusterCount; i++) {
    const c = clusterOf(i);
    c.gen = 0; c.draw = 0; c.cap = 40; c.strength = 0; c.deepest = 0; c.leaks = 0;
  }
  for (const p of PIECES) {
    const c = clusterOf(Math.max(0, p.cluster));
    c.draw += p.def.draw || 0;
    c.strength += (p.def.hull || 0) - (p.def.weak || 0);
    if (p.def.inside) { c.cap += 10; c.deepest = Math.max(c.deepest, -p.pos.y); }
    if (p.def.gen) {
      c.cap += 28;
      if (p.kind === 'solar') c.gen += p.def.gen * sun * clamp01(1 - Math.max(0, -p.pos.y) / 190);
      else c.gen += p.def.gen * thermalYield(p.pos);
    }
  }
  for (const l of leaks) clusterOf(Math.max(0, l.piece.cluster)).draw += 0.25;
  for (let i = 0; i < clusterCount; i++) {
    const c = clusterOf(i);
    /**
     * CELL_RATE turns the kW figures into a battery with a believable time
     * constant. Integrating raw kW per second meant a 184-unit bank at a 1.1 kW
     * net night drain ran flat in eighty-one seconds: every night capture of
     * this base was therefore a photograph of a DEAD station in emergency
     * lighting, which is most of why the night interior measured 8/255 with a
     * salmon cast. At 0.09 the same bank carries the night with margin and a
     * base with no generator still visibly dies, which is the point of it.
     */
    c.stored = clamp(c.stored + (c.gen - c.draw) * dt * 0.09, 0, c.cap);
  }
  const c = clusterOf(Math.max(0, insidePiece ? insidePiece.cluster : 0));
  power.generated = c.gen; power.consumed = c.draw; power.capacity = c.cap;
  power.stored = c.stored;
  power.ratio = c.cap > 0 ? c.stored / c.cap : 0;

  // A dead base is a dark base — and ONLY a dead base. The bake is a shared
  // uniform precisely so this can happen without rebuilding a single vertex.
  // Nothing here reads sunT or uDepthDarken: a sealed pressurised hull does not
  // care what time it is outside, only whether its own grid is up.
  const lit = power.stored > 1.0 ? 1 : sstep(0, 1.0, power.stored);
  const emergency = power.stored <= 1.0;
  BAKE_LEVEL.value = lerp(BAKE_LEVEL.value, (emergency ? 0.34 : 1.0) * BAKE_DEBUG, clamp01(dt * 2.5));
  BAKE_TINT.value.lerp(emergency ? _tintRed : _tintWhite, clamp01(dt * 2.5));
  const k = emergency ? 0.22 : 1.0;
  for (const key of ['lampWarm', 'lampCyan', 'lampGreen']) {
    const m = MATS[key];
    if (m && m.userData.base0) m.emissive.copy(m.userData.base0).multiplyScalar(k);
  }
  if (MATS.portGlow?.userData.base0) {
    MATS.portGlow.emissive.copy(MATS.portGlow.userData.base0).multiplyScalar(lit * 0.35 + k * 0.65);
  }
}
// Emergency lighting, not a darkroom safelight. A critic measured the old
// (1.0, 0.32, 0.24) at 0.44-0.56 saturation across whole interior surfaces and
// called it salmon; it is meant to read as a dimmed amber back-up circuit.
const _tintRed = new THREE.Color(1.0, 0.62, 0.46);
const _tintWhite = new THREE.Color(1, 1, 1);

function simHull(dt) {
  for (let i = 0; i < clusterCount; i++) {
    const c = clusterOf(i);
    c.load = Math.max(0, (c.deepest - 55) / 15);
    c.integrity = c.strength - c.load;
    if (c.integrity < 0) {
      c.stress += dt * (0.35 - c.integrity * 0.12);
      if (c.stress > 1 && leaks.length < 8) {
        c.stress = 0;
        const cand = interiorPieces().filter((p) => p.cluster === i);
        if (cand.length) springLeak(cand[Math.floor(RNG() * cand.length)]);
      }
    } else c.stress = Math.max(0, c.stress - dt * 0.2);
  }
  const c = clusterOf(Math.max(0, insidePiece ? insidePiece.cluster : 0));
  hull.strength = c.strength;
  hull.load = c.load;
  hull.integrity = c.integrity;
  hull.crushDepth = Math.round(55 + 15 * Math.max(0, c.strength));
  hull.breaches = leaks.filter((l) => l.piece.cluster === (insidePiece ? insidePiece.cluster : 0)).length;
}

function interiorPieces() { return PIECES.filter((p) => p.def.inside); }

/** Free volume of a compartment, m^3 — the denominator of the fill rate. */
function compartmentVolume(p) {
  const f = p.def.flood;
  if (!f) return 30;
  if (f.shape === 'tube') return Math.PI * f.r * f.r * (p.len || CORR_LEN);
  return Math.PI * f.r * f.r * (f.h || 2.5);
}

/**
 * A breach: a short conical spray of small camera-facing droplets plus a mist
 * ball at the hole. The old jet was a 2.4 m hard-edged cone that punched
 * straight through the bulkhead into the next compartment; this one is 1.1 m
 * long, dies smoothly, and has no silhouette to punch anything with.
 */
function springLeak(target) {
  const cand = interiorPieces();
  if (!cand.length) return null;
  const p = target || cand[Math.floor(RNG() * cand.length)];
  const f = p.def.flood;
  const a = RNG() * TAU;
  const r = (f?.r || 2) * 0.94;
  const lp = new THREE.Vector3(Math.cos(a) * r, (f?.base || 0) + 0.4 + RNG() * 1.2, Math.sin(a) * r);
  if (p.kind === 'corridor') lp.set(Math.cos(a) * TR * 0.94, TAX + Math.sin(a) * TR * 0.94, (RNG() - 0.5) * p.len);
  const dir = new THREE.Vector3(-lp.x, p.kind === 'corridor' ? TAX - lp.y : 0.2, -lp.z).normalize();
  const wp = lp.clone().applyMatrix4(p.matrix);
  const wd = dir.clone().applyQuaternion(p.quat).normalize();

  const N = 14;
  const gb = new GlowBatch();
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    // the spray widens and dims down its length, and stops well short of the
    // far wall of the smallest compartment it can occur in
    const j = (RNG() - 0.5) * t * 0.22;
    const off = [wp.x + wd.x * t * 1.15 + j, wp.y + wd.y * t * 1.15 - t * t * 0.34, wp.z + wd.z * t * 1.15 - j];
    const s = 0.07 + t * 0.30;
    const i = (1 - t * 0.82) * (1 - t * 0.82) * 2.1;
    gb.add(off, s, [i * 0.66, i * 0.94, i * 1.0]);
  }
  // the hole itself: a tight bright core
  gb.add([wp.x, wp.y, wp.z], 0.13, [3.2, 4.2, 4.5]);
  gb.add([wp.x, wp.y, wp.z], 0.34, [0.9, 1.3, 1.4]);
  const jet = new THREE.Mesh(gb.build(), MATS.leak);
  jet.userData.noShadow = true; jet.castShadow = false; jet.receiveShadow = false;
  jet.renderOrder = 6;
  jet.matrixAutoUpdate = false;
  dynGroup.add(jet);
  const leak = { piece: p, wp, jet, t: RNG() * 10, base: jet.geometry.attributes.color.array.slice() };
  leaks.push(leak);
  notify('HULL BREACH — leak detected');
  return leak;
}

function healLeak(leak) {
  const i = leaks.indexOf(leak);
  if (i < 0) return;
  leaks.splice(i, 1);
  dynGroup.remove(leak.jet);
  leak.jet.geometry.dispose();
}

function simFlood(dt, t, ctx) {
  const per = new Map();
  for (const l of leaks) per.set(l.piece, (per.get(l.piece) || 0) + 1);
  for (const p of interiorPieces()) {
    const n = per.get(p) || 0;
    if (n) {
      /**
       * Torricelli, not a debug ramp. Two leaks in a 1.75 m corridor and in a
       * 2.9 m junction used to fill at IDENTICAL rates to three decimals, since
       * the old form was a flat dt * 0.035 * n with no depth, no breach size and
       * no volume in it. Discharge through a hole goes as sqrt(2 g h) with h the
       * head of water outside, and the level it drives rises as volume flow over
       * the compartment's own free volume — so a big room takes visibly longer
       * to drown than the tube leading to it, and a breach at 200 m is violent.
       */
      const head = Math.max(1, -p.pos.y);
      const q = 0.0165 * n * Math.sqrt(2 * 9.81 * head);      // m^3/s
      p.flood = Math.min(1, p.flood + dt * q / compartmentVolume(p));
    } else {
      p.flood = Math.max(0, p.flood - dt * 0.10);
    }
    let mesh = floodMeshes.get(p);
    if (p.flood < 0.01) {
      if (mesh) { dynGroup.remove(mesh); mesh.geometry.dispose(); floodMeshes.delete(p); }
      continue;
    }
    const f = p.def.flood;
    if (!mesh) {
      const g = f.shape === 'tube'
        ? new THREE.PlaneGeometry(TR * 1.9, p.len * 0.99, 14, 18)
        : new THREE.CircleGeometry(f.r * 0.99, 44, 0, TAU);
      g.rotateX(-Math.PI / 2);
      // aRim: 0 in open water, 1 where the surface wets the hull. The shader
      // uses it for the meniscus, which is the single detail that separates a
      // water line from a grey bar drawn across the frame.
      const pos = g.attributes.position;
      const rim = new Float32Array(pos.count);
      const R = f.shape === 'tube' ? TR * 0.95 : f.r * 0.99;
      for (let i = 0; i < pos.count; i++) {
        const dxz = Math.hypot(pos.getX(i), pos.getZ(i));
        rim[i] = clamp01(dxz / R);
      }
      g.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
      mesh = new THREE.Mesh(g, MATS.flood);
      mesh.userData.noShadow = true; mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.renderOrder = 3;
      dynGroup.add(mesh);
      floodMeshes.set(p, mesh);
    }
    const h = (f.base || 0) + p.flood * (f.h || 2.5);
    _v.set(0, h, 0).applyMatrix4(p.matrix);
    mesh.position.copy(_v);
    mesh.quaternion.copy(p.quat);
    // A tube's waterline is a CHORD, not a fixed-width strip. At head height in
    // a 1.75 m corridor the old constant 3.3 m plane stood a metre proud of the
    // hull on both sides and read as a sheet laid across the frame.
    if (f.shape === 'tube') {
      const dy = h - TAX;
      const half = Math.sqrt(Math.max(0.04, TR * TR - dy * dy));
      mesh.scale.x = clamp(half / (TR * 0.95), 0.12, 1.0);
    }
  }
  // the spray breathes; the colour attribute is scaled off its stored baseline
  for (const l of leaks) {
    l.t += dt;
    const k = 0.82 + Math.sin(l.t * 7.4) * 0.16 + Math.sin(l.t * 3.1) * 0.06;
    const a = l.jet.geometry.attributes.color;
    for (let i = 0; i < a.array.length; i++) a.array[i] = l.base[i] * k;
    a.needsUpdate = true;
  }
  // the meniscus and the glints take the room's own light level
  if (MATS.flood) {
    MATS.flood.uniforms.uFloodLit.value.setRGB(1.10, 1.02, 0.92)
      .multiplyScalar(0.35 + BAKE_LEVEL.value * 0.65);
  }
}

// ============================================================== HUD
let ui = null;
let toastT = 0;

const CSS = `
#cn-base{position:absolute;inset:0;pointer-events:none;font-family:"Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;color:#fff}
#cn-base .pane{position:absolute;background:rgba(14,51,80,.66);border:2px solid rgba(143,233,255,.85);
  border-radius:16px;box-shadow:0 0 18px rgba(20,90,130,.35),inset 0 0 24px rgba(80,200,255,.10);
  backdrop-filter:blur(2px)}
/* left flank, clear of ui.js's depth ring (top centre), notifications (top
   left), resource chips (top right) and the vitals cluster (bottom left) */
#cn-base .st{top:27%;left:26px;display:flex;align-items:center;gap:16px;
  padding:8px 18px 9px;border-radius:22px}
#cn-base .st b{font-weight:600;font-size:19px;letter-spacing:.5px}
#cn-base .st .lab{font-size:10.5px;letter-spacing:.26em;opacity:.72;text-transform:uppercase}
#cn-base .bar{width:96px;height:5px;border-radius:3px;background:rgba(6,26,40,.8);overflow:hidden;margin-top:4px}
#cn-base .bar i{display:block;height:100%;background:#9be55a;transition:width .3s}
#cn-base .hullbar i{background:#6fdfff}
#cn-base .bd{right:26px;bottom:120px;width:266px;padding:12px 14px 13px}
#cn-base .bd h4{margin:0 0 8px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;
  color:#8fe9ff;font-weight:600}
#cn-base .bd .name{font-size:17px;font-weight:600;margin-bottom:2px}
#cn-base .bd .grp{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;opacity:.62;margin-bottom:9px}
#cn-base .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}
#cn-base .chip{font-size:11.5px;padding:3px 9px;border-radius:9px;background:rgba(6,30,48,.75);
  border:1px solid rgba(143,233,255,.42)}
#cn-base .chip.no{color:#f0553c;border-color:rgba(240,85,60,.6)}
#cn-base .msg{font-size:12px;color:#9be55a}
#cn-base .msg.no{color:#f0553c}
#cn-base .keys{margin-top:9px;font-size:10.5px;opacity:.66;line-height:1.6}
#cn-base .keys em{font-style:normal;color:#ffa22a}
#cn-base .toast{left:50%;bottom:150px;transform:translateX(-50%);padding:7px 16px;border-radius:14px;
  font-size:13px;opacity:0;transition:opacity .25s}
#cn-base .warn{color:#f0553c}
#cn-base svg{position:absolute;overflow:visible;pointer-events:none}
`;

function makeUI(root) {
  if (!root) return null;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'cn-base';
  el.innerHTML = `
  <div class="pane st" id="cnb-st" style="display:none">
    <svg width="140" height="70" style="left:100%;top:14px">
      <path d="M2 8 C 40 8, 52 44, 92 44 L 132 44" fill="none" stroke="#8fe9ff" stroke-width="1.6" opacity=".5"/>
      <circle cx="133" cy="44" r="3.2" fill="#8fe9ff" opacity=".75"/>
    </svg>
    <div><div class="lab">Power</div><b id="cnb-pw">0/0</b>
      <div class="bar"><i id="cnb-pwb" style="width:100%"></i></div></div>
    <div><div class="lab">Hull</div><b id="cnb-hl">100%</b>
      <div class="bar hullbar"><i id="cnb-hlb" style="width:100%"></i></div></div>
  </div>
  <div class="pane bd" id="cnb-bd" style="display:none">
    <h4>Habitat Builder</h4>
    <div class="name" id="cnb-nm">Corridor</div>
    <div class="grp" id="cnb-gp">structure</div>
    <div class="chips" id="cnb-ch"></div>
    <div class="msg" id="cnb-ms">ready</div>
    <div class="keys">
      <em>B</em> exit &nbsp; <em>[ ]</em> piece &nbsp; <em>R</em> rotate<br>
      <em>LMB</em> build &nbsp; <em>X</em> deconstruct &nbsp; <em>F</em> weld leak
    </div>
  </div>
  <div class="pane toast" id="cnb-ts"></div>`;
  root.appendChild(el);
  return {
    el,
    st: el.querySelector('#cnb-st'), pw: el.querySelector('#cnb-pw'),
    pwb: el.querySelector('#cnb-pwb'), hl: el.querySelector('#cnb-hl'),
    hlb: el.querySelector('#cnb-hlb'), bd: el.querySelector('#cnb-bd'),
    nm: el.querySelector('#cnb-nm'), gp: el.querySelector('#cnb-gp'),
    ch: el.querySelector('#cnb-ch'), ms: el.querySelector('#cnb-ms'),
    ts: el.querySelector('#cnb-ts'),
  };
}

function notify(text) {
  const u = CTX?.get?.('ui');
  if (u?.notify) { try { u.notify(text); } catch { /* ui is a stub */ } }
  if (!ui) return;
  ui.ts.textContent = text;
  ui.ts.style.opacity = '1';
  toastT = 2.6;
}

function updateUI(dt) {
  if (!ui) return;
  const showStatus = !!insidePiece || tool.active;
  ui.st.style.display = showStatus ? 'flex' : 'none';
  if (showStatus) {
    ui.pw.textContent = `${Math.round(power.stored)}/${Math.round(power.capacity)}`;
    ui.pwb.style.width = `${Math.round(power.ratio * 100)}%`;
    ui.pwb.style.background = power.ratio < 0.15 ? '#f0553c' : power.ratio < 0.4 ? '#ffd23f' : '#9be55a';
    const hp = clamp01(hull.strength > 0 ? hull.integrity / hull.strength : 0);
    ui.hl.textContent = hull.breaches ? `${hull.breaches} BREACH` : `${Math.round(hp * 100)}%`;
    ui.hl.className = hull.breaches ? 'warn' : '';
    ui.hlb.style.width = `${Math.round(hp * 100)}%`;
    ui.hlb.style.background = hull.breaches ? '#f0553c' : hp < 0.35 ? '#ffd23f' : '#6fdfff';
  }
  ui.bd.style.display = tool.active ? 'block' : 'none';
  if (tool.active) {
    const kind = currentKind(), def = DEFS[kind];
    ui.nm.textContent = def.label;
    ui.gp.textContent = def.group;
    const cost = def.cost || {};
    let html = '';
    for (const k in cost) {
      const have = RES.count(k);
      html += `<span class="chip${have < cost[k] ? ' no' : ''}">${RES_LABEL[k] || k} ${have}/${cost[k]}</span>`;
    }
    if (def.hull) html += `<span class="chip">Hull +${def.hull}</span>`;
    if (def.weak) html += `<span class="chip no">Hull -${def.weak}</span>`;
    if (def.gen) html += `<span class="chip">+${def.gen} kW</span>`;
    ui.ch.innerHTML = html;
    ui.ms.textContent = tool.msg || (tool.valid ? 'ready' : 'no valid attachment');
    ui.ms.className = 'msg' + (tool.valid ? '' : ' no');
  }
  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0) ui.ts.style.opacity = '0';
  }
}

// ============================================================== module
const api = {
  id: 'base',
  order: 140,

  pieces: () => PIECES.slice(),
  bases: () => clusterCount,
  power,
  hull,
  get buildMode() { return tool.active; },
  get inventory() { return RES ? RES.local : null; },
  setBuildMode(v) { tool.active = !!v; if (!v) ghostRoot.visible = false; },

  isInside(v) { for (const p of PIECES) if (p.contains(v)) return p; return null; },
  isDry(v) {
    const p = api.isInside(v);
    if (!p) return false;
    if (p.flood < 0.02) return true;
    const f = p.def.flood;
    _v2.copy(v).applyMatrix4(p.inv);
    return _v2.y > (f.base || 0) + p.flood * (f.h || 2.5);
  },

  /**
   * THE AIR CONTRACT. src/player/survival.js:928 asks every module whether the
   * player is breathing its air, and its moduleAir() probe (survival.js:131-135)
   * looks for hasAirAt / isInsideAt / insideAt / airAt / playerInside — in that
   * order — and gives up if it finds none of them.
   *
   * This module published isDry() and isInside(). Neither name is on that list,
   * so a sealed, powered, 39-piece station registered as scenery: measured
   * twice, standing dead centre in the observatory with isDry() true, oxygen
   * fell 100 -> 78.5 at a flat 1.77/s with no refill, while structures.js's
   * crashed lifepod kept the player alive because it calls addAirSource().
   *
   * hasAirAt is exact where an addAirSource sphere would not be: it is the same
   * containment test the flooding uses, so a compartment that fills past your
   * head stops being breathable at the right moment and in the right shape.
   * The rest are aliases for whichever name a consumer happens to look for.
   */
  hasAirAt(v) { return api.isDry(v); },
  isInsideAt(v) { return !!api.isInside(v); },
  insideAt(v) { return !!api.isInside(v); },
  airAt(v) { return api.isDry(v); },
  get playerInside() { return !!insidePiece; },
  nearestHatch(v) {
    let best = null, bd = 1e9;
    for (const p of PIECES) {
      if (p.kind !== 'hatch') continue;
      const d = p.pos.distanceTo(v);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { piece: best, pos: best.pos.clone(), distance: bd } : null;
  },
  place(kind, opts = {}) {
    if (!DEFS[kind]) return null;
    const pos = opts.pos ? V3(opts.pos[0], opts.pos[1], opts.pos[2]) : V3(0, 0, 0);
    const q = opts.yaw ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, opts.yaw, 0)) : QI;
    if (opts.free !== true && !RES.take(DEFS[kind].cost || {})) return null;
    return addPiece(kind, pos, q, opts.opts || {});
  },
  remove(p) { if (p) { RES.give(p.def.cost || {}); return removePiece(p); } return false; },
  springLeak,
  repairAll() { while (leaks.length) healLeak(leaks[0]); },
  /** Introspection for the verification harness. */
  debugLight: () => ({
    bakeLevel: +BAKE_LEVEL.value.toFixed(3),
    bakeTint: BAKE_TINT.value.toArray().map((v) => +v.toFixed(3)),
    insideT: +insideT.toFixed(3),
    matFog: +(MATS.wallIn?.userData?.uwUniforms?.uMatFogScale?.value ?? -1).toFixed(4),
    litMix: MATS.wallIn?.userData?.uwLitMix?.value,
    depthDarken: +U.uDepthDarken.value.toFixed(3),
    sunY: +U.uSunDir.value.y.toFixed(3),
    powerRatio: +power.ratio.toFixed(3),
  }),
  debugKind: () => currentKind(),
  debugTool: () => ({
    kind: currentKind(), valid: tool.valid, msg: tool.msg,
    target: tool.target ? `${tool.target.piece.kind}:${tool.target.n}` : null,
    pos: tool.pose ? tool.pose.pos.toArray().map((v) => +v.toFixed(2)) : null,
  }),
  thermalYield,

  async init(ctx) {
    CTX = ctx;
    RNG = makeRNG(0xBA5E ^ Math.floor((ctx.rng ? ctx.rng() : 0.5) * 0xffffff));
    RES = new Resources(ctx);
    buildMaterials(RNG);
    for (const key of ['lampWarm', 'lampCyan', 'lampGreen', 'lampAmber', 'lampRed', 'portGlow']) {
      MATS[key].userData.base0 = MATS[key].emissive.clone();
    }

    group = new THREE.Group(); group.name = 'base';
    dynGroup = new THREE.Group(); dynGroup.name = 'base.dynamic';
    ghostRoot = new THREE.Group(); ghostRoot.name = 'base.ghost'; ghostRoot.visible = false;
    ctx.scene.add(group, dynGroup, ghostRoot);

    terrainAPI = ctx.get('terrain') || null;

    // ?baselit / ?basebake / ?basefog — A/B handles for the interior lighting
    // rig, which is the one part of this module that cannot be judged from a
    // still without being able to isolate its three terms.
    // (Number(null) is 0, not NaN — has() first, or every ordinary run silently
    // gets litMix 0 and a dead bake.)
    if (ctx.params?.has?.('baselit')) {
      const v = Number(ctx.params.get('baselit')) || 0;
      for (const k of BATCH_KEYS) {
        const u = MATS[k]?.userData?.uwLitMix;
        if (u) u.value = v;
      }
    }
    if (ctx.params?.has?.('basebake')) BAKE_DEBUG = Number(ctx.params.get('basebake')) || 0;

    const only = ctx.params?.get('base');       // ?base=none|home|outpost, for A/B perf work
    if (only !== 'none' && only !== 'outpost') layoutHomeReef();
    if (only !== 'none' && only !== 'home') {
      try { layoutOutpost(); } catch (e) { console.warn('[base] outpost siting failed', e); }
    }
    for (const p of PIECES) p.locked = true;      // authored pieces are not deconstructable
    rebuild();

    // DELIBERATELY no THREE.PointLight in here. Two of them measured a drop
    // from 218 to 39 fps on the base-interior framing and from 131 to 67 on a
    // shot the base is not even in: three's light uniforms are global, so one
    // extra point light re-costs every terrain, flora and creature fragment in
    // the world. The interior is lit by the per-vertex bake instead, which is
    // free at render time and is the only lighting that survives nightfall
    // anyway (see the header note on uDepthDarken).
    ui = makeUI(ctx.uiRoot);
    if (ctx.params?.get('build') === '1') tool.active = true;
    if (ctx.params?.get('flood') === '1') { springLeak(); springLeak(); }

    ctx.provide?.('base', api);
    this.pieceCount = PIECES.length;
  },

  update(dt, t, ctx) {
    if (dirty) rebuild();

    const mv = ctx.get('movement');
    const p = (mv && mv.position && mv.position.isVector3) ? mv.position : ctx.camera.position;
    insidePiece = api.isInside(p);

    /**
     * Whose side of the hull the EYE is on decides how much ocean an interior
     * surface is read through. Standing in the habitat that path is air, so the
     * fog is switched almost off; from the water it is the full medium, because
     * a lit room seen from outside must sit in the same haze as everything else
     * and that read is what "the base glows warm from its viewports" depends on.
     * Lerped, so stepping through a hatch is a transition and not a pop.
     */
    const eyeIn = !!api.isInside(ctx.camera.position) || !!insidePiece;
    insideT = lerp(insideT, eyeIn ? 1 : 0, clamp01(dt * 7));
    const fs = lerp(OUT_FOG, IN_FOG, insideT);
    for (const k of FOG_SWITCH_KEYS) {
      const u = MATS[k]?.userData?.uwUniforms;
      if (u) u.uMatFogScale.value = fs;
    }

    // ---- input
    const input = ctx.input;
    if (input) {
      if (input.hit('KeyB')) { tool.active = !tool.active; notify(tool.active ? 'Builder online' : 'Builder offline'); }
      if (tool.active) {
        if (input.hit('BracketRight')) { tool.idx = (tool.idx + 1) % BUILDABLE.length; tool.roll = 0; }
        if (input.hit('BracketLeft')) { tool.idx = (tool.idx + BUILDABLE.length - 1) % BUILDABLE.length; tool.roll = 0; }
        if (input.mouse && input.mouse.wheel) {
          tool.idx = (tool.idx + input.mouse.wheel + BUILDABLE.length) % BUILDABLE.length;
        }
        if (input.hit('KeyR')) tool.roll = (tool.roll + 1) % 4;
        if (input.hit('KeyX')) deconstructAim(ctx);
      }
      // welding: hold F next to a leak
      if (input.down('KeyF') && leaks.length) {
        let near = null, nd = 5;
        for (const l of leaks) { const d = l.wp.distanceTo(p); if (d < nd) { nd = d; near = l; } }
        if (near) {
          repairT += dt;
          if (repairT > 1.4) { healLeak(near); repairT = 0; notify('breach welded'); }
        } else repairT = 0;
      } else repairT = 0;
    }

    if (tool.active) {
      ghostRoot.visible = true;
      solveGhost(ctx);
      const clicked = input && ((input.mouse.buttons & 1) && !tool._down);
      if (input) tool._down = !!(input.mouse.buttons & 1);
      if (clicked || input?.hit('Enter')) commitBuild();
    } else {
      ghostRoot.visible = false;
    }

    simPower(dt);
    simHull(dt);
    simFlood(dt, t, ctx);

    updateUI(dt);
    this.pieceCount = PIECES.length;
    this.leaks = leaks.length;
  },

  shots: {
    'base-interior': () => { tool.active = false; },
    'night-shallows': () => { tool.active = false; },
    'shallows-reef': () => { tool.active = false; },
  },
};

export default api;
