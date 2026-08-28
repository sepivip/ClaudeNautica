#!/usr/bin/env node
/**
 * Measure the image statistics critics keep re-deriving by hand, identically
 * for our renders and for the real reference frames, so scores are comparable
 * across rounds and across agents.
 *
 *   node tools/measure.mjs shots/x/godrays.png reference/subnautica/godrays-1.jpg
 *   node tools/measure.mjs --json shots/x/*.png
 *
 * Reports, per image:
 *   lum p0.1/p1/median/p99/p99.9 and range   — is there anything dark? anything bright?
 *   topBottom                                 — vertical luminance ratio (the "distance axis")
 *   bandLum / bandGB                          — luminance and G/B by horizontal third
 *   sat                                       — mean saturation (LOOK.md floor is 0.70)
 *   rgbMean, R%                               — is red actually dead?
 *   detailRMS                                 — laplacian energy, i.e. is there surface texture
 *   tileContrast                              — mean 32px local contrast
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const MAXW = Number((args.find(a=>a.startsWith('--max='))||'--max=0').split('=')[1]);
const CROP = (args.find(a=>a.startsWith('--crop='))||'--crop=').split('=')[1];
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: measure.mjs <image> [image...]'); process.exit(1); }

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto('about:blank');

const results = [];
for (const f of files) {
  // Pass the bytes inline: a page at about:blank cannot read file:// URLs.
  const ext = path.extname(f).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const url = `data:${mime};base64,${(await readFile(path.resolve(f))).toString('base64')}`;
  const r = await page.evaluate(async ({ src, maxW, crop }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    // Measure at NATIVE resolution. Downscaling to a fixed width was averaging
    // neighbouring pixels before the laplacian ran, which inflated the detail
    // figure and made two frames with genuinely different surface signal report
    // the same number — a critic caught this comparing against native-res crops.
    // Optional crop, normalised x0,y0,x1,y1 — measure one surface (a cliff face,
    // a patch of sand) rather than a whole frame whose average hides it.
    const cr = crop ? crop.split(',').map(Number) : [0, 0, 1, 1];
    const sx = Math.floor(cr[0] * img.naturalWidth), sy = Math.floor(cr[1] * img.naturalHeight);
    const sw = Math.max(2, Math.floor((cr[2] - cr[0]) * img.naturalWidth));
    const sh = Math.max(2, Math.floor((cr[3] - cr[1]) * img.naturalHeight));

    const w = maxW > 0 ? Math.min(sw, maxW) : sw;
    const h = Math.round(sh * (w / sw));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;

    /**
     * CHROMATICITY MUST BE COMPUTED IN LINEAR LIGHT, NOT ON 8-BIT CODES.
     *
     * sRGB encodes as 1.055*x^(1/2.4) - 0.055. The power term is harmless — a
     * channel ratio becomes ratio^(1/2.4), which is level-independent. The -0.055
     * OFFSET is not: its weight relative to the code falls as the code rises, so
     * the effective exponent is itself a function of level, and differently for
     * the two channels being divided.
     *
     * Consequence: a pixel of EXACTLY CONSTANT chromaticity reports a drifting
     * G/B — upward when G/B < 1, downward when G/B > 1. Our water sits below 1
     * and the reference plates above it, so the two are biased in OPPOSITE
     * directions and every ours-vs-plate comparison was inflated by the sum.
     * Verified: scaling one real window in linear light by 0.5x and 2x leaves
     * linear G/B at 0.5779 throughout while code G/B moves +0.0106 on ours and
     * -0.0071 on a plate.
     *
     * A round was set on a "6x hue-drift gap" that decomposed almost entirely
     * into this. Linear figures are the ones to read; the code-space ones are
     * kept as *Code for continuity with older reports.
     */
    const S2L = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const c = i / 255;
      S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    const lum = new Float32Array(w * h);
    let rs = 0, gs = 0, bs = 0, sats = 0;
    let rl = 0, gl = 0, bl = 0, satl = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      lum[p] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      rs += R; gs += G; bs += B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sats += mx === 0 ? 0 : (mx - mn) / mx;
      const Rl = S2L[R], Gl = S2L[G], Bl = S2L[B];
      rl += Rl; gl += Gl; bl += Bl;
      const mxl = Math.max(Rl, Gl, Bl), mnl = Math.min(Rl, Gl, Bl);
      satl += mxl === 0 ? 0 : (mxl - mnl) / mxl;
    }
    const n = w * h;
    const sorted = Float32Array.from(lum).sort();
    const pct = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];

    // luminance + G/B by horizontal third (the vertical gradient critics measure)
    const band = (a, b) => {
      let L = 0, G = 0, B = 0, m = 0;
      for (let y = Math.floor(a * h); y < Math.floor(b * h); y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          L += lum[y * w + x]; G += d[i + 1]; B += d[i + 2]; m++;
        }
      return { lum: L / m, gb: G / Math.max(B, 1e-6) };
    };
    const top = band(0, 1 / 3), mid = band(1 / 3, 2 / 3), bot = band(2 / 3, 1);

    // laplacian detail energy — surface texture, not shape
    let lap = 0, lc = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const v = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - w] - lum[p + w];
        lap += v * v; lc++;
      }

    // mean local contrast in 32px tiles
    let tc = 0, tn = 0;
    for (let y = 0; y + 32 <= h; y += 32)
      for (let x = 0; x + 32 <= w; x += 32) {
        let s = 0, s2 = 0;
        for (let j = 0; j < 32; j++) for (let i2 = 0; i2 < 32; i2++) {
          const v = lum[(y + j) * w + x + i2]; s += v; s2 += v * v;
        }
        const m = s / 1024;
        tc += Math.sqrt(Math.max(0, s2 / 1024 - m * m)); tn++;
      }

    // ---- Laplacian pyramid: per-octave energy, fine -> coarse.
    // Critics kept hand-rolling this because "is the spectrum flat, and at what
    // amplitude" is the question that actually separates a real surface from a
    // painted one — a single contrast number cannot answer it. Reported as RMS
    // per band as a percentage of crop mean, so it is comparable across crops of
    // different brightness and across ours vs a reference plate.
    const octaves = [];
    {
      let cur = Array.from(lum), cw = w, ch = h;
      const mean = cur.reduce((a, b) => a + b, 0) / cur.length || 1;
      for (let lvl = 0; lvl < 5 && cw > 8 && ch > 8; lvl++) {
        const dw = cw >> 1, dh = ch >> 1;
        const down = new Float32Array(dw * dh);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const a = cur[(y * 2) * cw + x * 2], b = cur[(y * 2) * cw + Math.min(x * 2 + 1, cw - 1)];
          const c = cur[Math.min(y * 2 + 1, ch - 1) * cw + x * 2];
          const d = cur[Math.min(y * 2 + 1, ch - 1) * cw + Math.min(x * 2 + 1, cw - 1)];
          down[y * dw + x] = (a + b + c + d) * 0.25;
        }
        // band = current - upsample(down); RMS of that band is this octave's energy
        let s2 = 0;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const u = down[Math.min(y >> 1, dh - 1) * dw + Math.min(x >> 1, dw - 1)];
          const v = cur[y * cw + x] - u;
          s2 += v * v;
        }
        octaves.push(+(Math.sqrt(s2 / (cw * ch)) / mean * 100).toFixed(2));
        cur = down; cw = dw; ch = dh;
      }
    }

    /**
     * HUE VARIANCE — how many different colours the frame actually contains.
     *
     * Per-pixel saturation says how intense each colour is; it says nothing about
     * how MANY there are. Ours measures 0.80-0.97 against plates of 0.27-0.74,
     * which reads as "too saturated" — but looking at a fair pair shows the real
     * difference is that a reference frame carries five or six distinct hues
     * (teal water, green algae, brown rock, yellow spots, purple and orange
     * coral) while ours is one intense cyan. Monochromatic-but-intense versus
     * moderate-but-polychromatic. Circular variance over the hue wheel, weighted
     * by saturation and value so near-grey and near-black pixels do not vote.
     */
    let hx = 0, hy = 0, hw = 0;
    const hueHist = new Array(12).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), c = mx - mn;
      if (c < 0.06 || mx < 0.06) continue;          // grey or near-black: no hue
      let h;
      if (mx === R) h = ((G - B) / c + 6) % 6;
      else if (mx === G) h = (B - R) / c + 2;
      else h = (R - G) / c + 4;
      const rad = h * Math.PI / 3;
      const w = c * mx;                              // saturated AND bright pixels vote most
      hx += Math.cos(rad) * w; hy += Math.sin(rad) * w; hw += w;
      hueHist[Math.min(11, Math.floor(h * 2))] += w;
    }
    // 0 = every pixel one hue, 1 = hues spread evenly around the wheel
    const hueVariance = hw > 0 ? 1 - Math.hypot(hx, hy) / hw : 0;
    // how many 30-degree hue buckets hold at least 5% of the weight
    const hueBuckets = hueHist.filter((v) => hw > 0 && v / hw >= 0.05).length;

    /**
     * PER-CHANNEL clipping, not luminance clipping.
     *
     * This counted only pixels with LUMINANCE >= 250. A green-teal water pixel of
     * (117, 254, 219) has luminance 224, so a window with 98.63% of its pixels at
     * GREEN >= 250 reported clipPct 0.00 — and a whole round was spent chasing a
     * "hue-vs-level trend with 0% clipping anywhere" that was a green-railed
     * highlight. The builder who found it also showed the ?nopostfx bypass rails
     * 68.73% green and 35.72% blue on a bright shot while this metric called it
     * clean, so ungraded frames were being trusted as ground truth when they were
     * clamp artefacts.
     *
     * clipAny is the one to read. A window with clipAny above a few percent
     * cannot support a colour statistic, whichever channel is railed.
     */
    let clipped = 0, clipR = 0, clipG = 0, clipB = 0, clipAny = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      if (lum[p] >= 250) clipped++;
      const r = d[i] >= 250, g = d[i + 1] >= 250, b = d[i + 2] >= 250;
      if (r) clipR++; if (g) clipG++; if (b) clipB++;
      if (r || g || b) clipAny++;
    }

    const mx = Math.max(rs, gs, bs) / n;
    return {
      octaves,
      octaveTilt: octaves.length > 1
        ? +(octaves[octaves.length - 1] / Math.max(octaves[0], 1e-6)).toFixed(2) : 1,
      clipPct: +(clipped / n * 100).toFixed(3),
      clipAny: +(clipAny / n * 100).toFixed(2),
      clipRGB: [+(clipR / n * 100).toFixed(2), +(clipG / n * 100).toFixed(2), +(clipB / n * 100).toFixed(2)],
      hueVar: +hueVariance.toFixed(3),
      hueBuckets,
      w, h,
      p01: +pct(0.001).toFixed(1), p1: +pct(0.01).toFixed(1),
      median: +pct(0.5).toFixed(1), p99: +pct(0.99).toFixed(1), p999: +pct(0.999).toFixed(1),
      range: +(pct(0.999) - pct(0.001)).toFixed(1),
      topBottom: +(top.lum / Math.max(bot.lum, 1e-6)).toFixed(2),
      bandLum: [+top.lum.toFixed(1), +mid.lum.toFixed(1), +bot.lum.toFixed(1)],
      bandGB: [+top.gb.toFixed(2), +mid.gb.toFixed(2), +bot.gb.toFixed(2)],
      // LINEAR-LIGHT chromaticity — read these.
      sat: +(satl / n).toFixed(3),
      redPct: +((rl / n) / Math.max(Math.max(rl, gl, bl) / n, 1e-12) * 100).toFixed(1),
      gbLinear: +((gl / n) / Math.max(bl / n, 1e-12)).toFixed(4),
      rgbLinear: [+(rl / n).toExponential(3), +(gl / n).toExponential(3), +(bl / n).toExponential(3)],
      // Display-code versions, kept for continuity with reports written before
      // round 31. They are NOT chromaticity statistics; see the note above.
      satCode: +(sats / n).toFixed(3),
      redPctCode: +((rs / n) / Math.max(mx, 1e-6) * 100).toFixed(0),
      rgbMean: [+(rs / n).toFixed(1), +(gs / n).toFixed(1), +(bs / n).toFixed(1)],
      detailRMS: +Math.sqrt(lap / lc).toFixed(2),
      tileContrast: +(tc / Math.max(tn, 1)).toFixed(2),
    };
  }, { src: url, maxW: MAXW, crop: CROP });
  results.push({ file: f, ...r });
}
await browser.close();

if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('file', 40), pad('lum p0.1/med/p99.9', 20), pad('range', 6), pad('top:bot', 8),
  pad('bandGB', 20), pad('sat',6), pad('R%',4), pad('detail',7), pad('tileC',7), pad('clipAny%',9), pad('hueVar',7), pad('hues',5), 'octaves fine->coarse (tilt)');
for (const r of results) {
  console.log(
    pad(r.file.slice(-39), 40),
    pad(`${r.p01}/${r.median}/${r.p999}`, 20),
    pad(r.range, 6), pad(r.topBottom, 8),
    pad(JSON.stringify(r.bandGB), 20),
    pad(r.sat, 6), pad(r.redPct, 4), pad(r.detailRMS, 7), pad(r.tileContrast, 7),
    pad(r.clipAny, 9), pad(r.hueVar, 7), pad(r.hueBuckets, 5), JSON.stringify(r.octaves) + ' (' + r.octaveTilt + ')');
}
