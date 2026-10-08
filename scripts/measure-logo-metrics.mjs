// Measure each vendored mark inside its 24x24 viewBox: the real content bounding
// box, the aspect ratio, and how much of the box is actually inked.
//
// A mark whose content is a wide, short band is a wordmark, and a wordmark at
// 20x20 is a smudge. Numbers, not impressions.
//
// usage: node dy-logo-metrics.mjs

import fs from 'node:fs';
import path from 'node:path';

const DEBUG_PORT = Number(process.env.DY_CDP ?? 9333);
const SI = '/root/.hermes/cache/scratch/si/node_modules/simple-icons';

const MARKS = {
  postgres: 'postgresql', mysql: 'mysql', redis: 'redis', mongodb: 'mongodb',
  adminer: 'adminer', nginx: 'nginx', httpd: 'apache', wordpress: 'wordpress',
  'node-app': 'nodedotjs', 'python-app': 'python', 'uptime-kuma': 'uptimekuma',
  grafana: 'grafana', prometheus: 'prometheus', minio: 'minio', n8n: 'n8n',
  rabbitmq: 'rabbitmq', whoami: 'traefikproxy',
};

const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const g = JSON.parse(m.data);
  if (g.id && pending.has(g.id)) {
    const p = pending.get(g.id);
    pending.delete(g.id);
    g.error ? p.reject(new Error(JSON.stringify(g.error))) : p.resolve(g.result);
  }
};
const send = (method, params = {}) => {
  const i = id++;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(800);

const payload = {};
for (const [tpl, si] of Object.entries(MARKS)) {
  const svg = fs.readFileSync(path.join(SI, 'icons', `${si}.svg`), 'utf8');
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
  const d = svg.match(/<path[^>]*\sd="([^"]+)"/)[1];
  payload[tpl] = { viewBox, d, si };
}

const expr = `(() => {
  const data = ${JSON.stringify(payload)};
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;';
  document.body.appendChild(host);
  const out = [];

  for (const [tpl, m] of Object.entries(data)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', m.viewBox);
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.style.cssText = 'position:absolute;left:0;top:0;';
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', m.d);
    p.setAttribute('fill', '#ffffff');
    svg.appendChild(p);
    host.appendChild(svg);

    const b = p.getBBox();

    // Rasterise at 96x96 and count inked pixels, to separate a solid silhouette
    // from a thin outline that will vanish when it shrinks.
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 96;
    const ctx = cv.getContext('2d');
    ctx.scale(4, 4);
    ctx.fillStyle = '#fff';
    ctx.fill(new Path2D(m.d));
    const px = ctx.getImageData(0, 0, 96, 96).data;
    let inked = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) inked++;

    // Ink as a share of the mark's own bounding box: a solid glyph is high, a
    // hairline outline is low.
    const boxArea = (b.width * b.height) / (24 * 24) * (96 * 96);
    out.push({
      tpl,
      si: m.si,
      x: +b.x.toFixed(2), y: +b.y.toFixed(2),
      w: +b.width.toFixed(2), h: +b.height.toFixed(2),
      aspect: +(b.width / b.height).toFixed(2),
      // At 20px tall in a 20x20 box the mark's ink height is:
      inkH: +(b.height / 24 * 20).toFixed(1),
      coverage: +(inked / boxArea * 100).toFixed(1),
    });
    svg.remove();
  }
  host.remove();
  return out;
})()`;

const rows = await js(expr);
rows.sort((a, b) => b.aspect - a.aspect);

console.log('  template      content bbox in 24x24      aspect  inkH@20px  coverage');
for (const r of rows) {
  const flag =
    r.aspect > 1.6 ? '  <-- WORDMARK'
    : r.coverage < 12 ? '  <-- THIN OUTLINE'
    : '';
  console.log(
    `  ${r.tpl.padEnd(13)} ${String(r.x).padStart(5)},${String(r.y).padStart(5)} ${String(r.w).padStart(5)}x${String(r.h).padStart(5)}   ${String(r.aspect).padStart(5)}   ${String(r.inkH).padStart(6)}   ${String(r.coverage).padStart(5)}%${flag}`,
  );
}

fs.writeFileSync('/root/.hermes/cache/scratch/logo-metrics.json', JSON.stringify(rows, null, 1));
console.log(`\n  ${rows.length} marks measured -> logo-metrics.json`);
ws.close();
process.exit(0);
