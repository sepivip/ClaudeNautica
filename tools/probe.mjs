#!/usr/bin/env node
/** Probe the live world: terrain height/biome under every shot camera, so shot
 *  framings can be aimed at actual geometry instead of empty water. */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ headless: true, channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`${url}/?capture=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__CN?.ready === true, null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(() => {
  const CN = window.__CN, t = CN.modules.get('terrain');
  if (!t?.heightAt) return { error: 'terrain has no heightAt' };
  const rows = [];
  for (const [name, s] of Object.entries(CN.SHOTS)) {
    const [x, y, z] = s.pos;
    const h = t.heightAt(x, z);
    // sample the seabed along the view bearing to see if anything is in frame
    const yaw = (s.yaw ?? 0) * Math.PI / 180;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const ahead = [10, 25, 50, 80, 120].map((d) => +t.heightAt(x + fx * d, z + fz * d).toFixed(1));
    rows.push({
      shot: name, camY: y, groundY: +h.toFixed(1), altitude: +(y - h).toFixed(1),
      biome: t.biomeAt ? t.biomeAt(x, z) : '?', ahead,
    });
  }
  return { rows };
});

console.log(out.error || '');
for (const r of out.rows || []) {
  const flag = r.altitude > 60 ? '  << camera is far above the seabed — likely empty frame'
    : r.altitude < 0 ? '  << camera is INSIDE terrain' : '';
  console.log(`${r.shot.padEnd(17)} cam=${String(r.camY).padStart(6)} ground=${String(r.groundY).padStart(7)} alt=${String(r.altitude).padStart(6)} ${String(r.biome).padEnd(18)} ahead=${JSON.stringify(r.ahead)}${flag}`);
}
await browser.close(); await server.close();
