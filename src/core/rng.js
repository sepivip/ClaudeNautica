/** Deterministic RNG (mulberry32) + value/fbm noise. OWNER: core. */
export function makeRNG(seed = 1337) {
  let a = seed >>> 0;
  const r = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => Math.floor(r.range(lo, hi + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  r.fork = (n) => makeRNG((seed * 2654435761 + n * 40503) >>> 0);
  return r;
}

export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function fbm2(x, y, octaves = 5, lac = 2.03, gain = 0.5) {
  let s = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * (valueNoise2(x * freq, y * freq) * 2 - 1);
    norm += amp; amp *= gain; freq *= lac;
  }
  return s / norm;
}

/** Ridged noise — good for reef spines, crevasses and cave walls. */
export function ridged2(x, y, octaves = 5, lac = 2.11, gain = 0.5) {
  let s = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq) * 2 - 1);
    s += amp * n * n; norm += amp; amp *= gain; freq *= lac;
  }
  return s / norm;
}
