// Dockyard end-to-end acceptance test.
//
// Drives the real HTTP API against the real Docker engine and real Postgres.
// Run with the API already listening (node server/src/index.ts).
//
//   export PATH=/root/.hermes/node/bin:$PATH
//   node scripts/e2e.mjs
//
// Exit code 0 only when every step observed a real result.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function loadEnv() {
  const env = {};
  for (const line of readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const BASE = `http://127.0.0.1:${env.PORT || 8000}`;
let cookie = '';
const results = [];
const created = { stackId: null, containerId: null, tunnelId: null };

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function call(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('dockyard_session=')) cookie = pair;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, json, text, contentType: res.headers.get('content-type') || '' };
}

function fail(name, detail) {
  record(name, false, detail);
  return false;
}

async function main() {
  // 0. readiness
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/system/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  if (!ready) { fail('api reachable', BASE); return; }
  record('api reachable', true, BASE);

  // 1. login
  const login = await call('POST', '/api/auth/login', {
    email: env.DOCKYARD_ADMIN_EMAIL, password: env.DOCKYARD_ADMIN_PASSWORD,
  });
  if (!login.ok) return void fail('login as admin', `status=${login.status} body=${login.text.slice(0, 200)}`);
  record('login as admin', true, `role=${login.json?.user?.role} cookie=${cookie ? 'set' : 'MISSING'}`);
  if (!cookie) return void fail('session cookie set', 'no dockyard_session cookie in the login response');

  // 2. system info against the real daemon
  const info = await call('GET', '/api/system/info');
  const d = info.json?.docker ?? {};
  record('system/info', info.ok, `docker.ok=${d.ok} engine=${d.version} images=${d.images} mode=${info.json?.mode}`);
  if (!d.ok) return void fail('docker engine reachable from the panel', JSON.stringify(d).slice(0, 200));

  // 3. template catalog
  const tpls = await call('GET', '/api/templates');
  record('template catalog', Array.isArray(tpls.json) && tpls.json.length > 0, `count=${tpls.json?.length}`);
  if (!Array.isArray(tpls.json) || tpls.json.length === 0) return;

  // 4. deploy a template for real
  const slug = 'whoami';
  const spec = tpls.json.find((t) => t.slug === slug) ?? tpls.json[0];
  const deploy = await call('POST', `/api/templates/${spec.slug}/deploy`, {
    name: 'e2e-whoami',
    values: { 'port:80': '18080' },
  });
  if (!deploy.ok) return void fail('deploy template', `slug=${spec.slug} status=${deploy.status} body=${deploy.text.slice(0, 300)}`);
  created.stackId = deploy.json?.stack?.id ?? null;
  created.containerId = deploy.json?.container?.id ?? null;
  record('deploy template', true, `slug=${spec.slug} stack=${created.stackId?.slice(0, 8)} container=${deploy.json?.container?.name}`);

  // 5. the container is really running
  await sleep(1500);
  const detail = await call('GET', `/api/containers/${created.containerId}`);
  record('container running', detail.json?.state === 'running',
    `state=${detail.json?.state} image=${detail.json?.image} ports=${JSON.stringify(detail.json?.ports ?? [])}`);
  record('container labelled as managed', detail.json?.managed === true && detail.json?.templateSlug === spec.slug,
    `managed=${detail.json?.managed} template=${detail.json?.templateSlug}`);

  // 6. logs + stats
  const logs = await call('GET', `/api/containers/${created.containerId}/logs?tail=20`);
  record('container logs', logs.status === 200 && logs.text.length > 0, `${logs.text.length} bytes, ctype=${logs.contentType}`);
  const stats = await call('GET', `/api/containers/${created.containerId}/stats`);
  record('container stats', stats.ok && typeof stats.json?.memLimit === 'number',
    `memUsed=${stats.json?.memUsed} memLimit=${stats.json?.memLimit} cpu=${stats.json?.cpuPercent}`);

  // 7. exec
  const exec = await call('POST', `/api/containers/${created.containerId}/exec`, { cmd: ['echo', 'dockyard-exec-ok'] });
  record('exec in container', exec.ok && String(exec.json?.stdout ?? '').includes('dockyard-exec-ok'),
    `exit=${exec.json?.exitCode} stdout=${JSON.stringify(String(exec.json?.stdout ?? '').trim().slice(0, 60))}`);

  // 8. quick tunnel to the running container (non-persistent)
  const quick = await call('POST', '/api/tunnels', {
    name: 'e2e-quick', mode: 'quick', container_id: created.containerId, port: 80,
  });
  if (quick.ok) {
    created.tunnelId = quick.json?.id ?? null;
    let t = quick.json;
    for (let i = 0; i < 45 && t?.status !== 'running' && t?.status !== 'error'; i++) {
      await sleep(1000);
      t = (await call('GET', `/api/tunnels/${created.tunnelId}`)).json;
    }
    record('quick tunnel reaches running', t?.status === 'running',
      `status=${t?.status} url=${t?.url} pid=${t?.pid} err=${t?.last_error}`);
    if (t?.url) {
      try {
        const probe = await fetch(`${t.url}/`, { signal: AbortSignal.timeout(20000) });
        const body = await probe.text();
        record('quick tunnel serves traffic', probe.ok, `status=${probe.status} bytes=${body.length}`);
      } catch (e) {
        record('quick tunnel serves traffic', false, `fetch failed: ${e.message}`);
      }
    }
  } else {
    record('quick tunnel reaches running', false, `create failed status=${quick.status} body=${quick.text.slice(0, 300)}`);
  }

  // 9. stack view sees the container
  const stacks = await call('GET', '/api/stacks');
  const mine = Array.isArray(stacks.json) ? stacks.json.find((s) => s.id === created.stackId) : null;
  record('stack groups its container', (mine?.containers?.length ?? 0) > 0,
    `stacks=${stacks.json?.length} containers_in_stack=${mine?.containers?.length} status=${mine?.status}`);

  // 10. audit trail recorded the work
  const audit = await call('GET', '/api/audit?limit=50');
  const actions = Array.isArray(audit.json) ? audit.json.map((a) => a.action) : [];
  record('audit trail written', actions.length > 0, `${actions.length} entries, sample=${[...new Set(actions)].slice(0, 6).join(',')}`);

  // 11. teardown
  if (created.tunnelId) {
    const t = await call('DELETE', `/api/tunnels/${created.tunnelId}`);
    record('delete tunnel', t.ok, `status=${t.status}`);
  }
  if (created.stackId) {
    const s = await call('DELETE', `/api/stacks/${created.stackId}?volumes=1`);
    record('delete stack (and its container)', s.ok, `status=${s.status}`);
  }
  await sleep(1500);
  if (created.containerId) {
    const gone = await call('GET', `/api/containers/${created.containerId}`);
    record('container really removed', gone.status === 404, `status=${gone.status}`);
  }
}

main()
  .catch((e) => { fail('unhandled error', e.stack || e.message); })
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n=== ${passed}/${results.length} checks passed ===`);
    if (passed !== results.length) {
      console.log('failed:');
      for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
      process.exitCode = 1;
    }
  });
