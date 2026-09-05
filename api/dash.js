// THE DASHBOARD'S OTHER HALF. One function, one JSON: everything the owner asked to see in
// one place — the site's own counts, the beta's installs and sessions, every piece of
// tester feedback and every crash Apple has forwarded, and every letter the contact form
// has taken in. It signs its own App Store Connect token from a key kept in the project's
// environment; nothing here is reachable without the dashboard's token in the query.
//
// Environment: DASH_TOKEN · ASC_ISSUER_ID · ASC_KEY_ID · ASC_P8 (the .p8, base64) ·
// BLOB_READ_WRITE_TOKEN (attached by the store).

import crypto from 'node:crypto';

const APP_ID = '6792535399';
const ASC = 'https://api.appstoreconnect.apple.com/v1';

// ── an ES256 JWT for App Store Connect, by hand, no dependency ──────────────────
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function ascToken() {
  const kid = process.env.ASC_KEY_ID, iss = process.env.ASC_ISSUER_ID, p8 = process.env.ASC_P8;
  if (!kid || !iss || !p8) return null;
  const pem = Buffer.from(p8, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ iss, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), { key: pem, dsaEncoding: 'ieee-p1363' });
  return header + '.' + payload + '.' + b64u(sig);
}
async function asc(path, token) {
  const r = await fetch(ASC + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return { error: r.status, body: (await r.text()).slice(0, 200) };
  return r.json();
}

// ── the beta: builds, installs, sessions, crashes, feedback ──────────────────────
async function beta(token) {
  const builds = await asc(`/builds?filter[app]=${APP_ID}&limit=12&sort=-uploadedDate&include=preReleaseVersion&fields[builds]=version,uploadedDate,processingState,preReleaseVersion&fields[preReleaseVersions]=platform,version`, token);
  if (builds.error) return { error: builds };
  const pre = Object.fromEntries((builds.included || []).map(i => [i.id, i.attributes]));
  const rows = [];
  for (const b of builds.data || []) {
    const rel = b.relationships?.preReleaseVersion?.data?.id;
    // installs · sessions · crashes · feedback, per build, from Apple's own beta usage metrics
    const use = await asc(`/builds/${b.id}/metrics/betaBuildUsages`, token);
    const u = use?.data?.[0]?.dataPoints?.[0]?.values || {};
    rows.push({
      build: b.attributes.version, platform: pre[rel]?.platform || '?', train: pre[rel]?.version || '?',
      state: b.attributes.processingState, uploaded: b.attributes.uploadedDate,
      installs: u.installCount ?? null, sessions: u.sessionCount ?? null,
      crashes: u.crashCount ?? null, feedback: u.feedbackCount ?? null, inviteCount: u.inviteCount ?? null,
    });
  }
  const groups = await asc(`/apps/${APP_ID}/betaGroups?limit=10`, token);
  // WHO IS IN THE BETA (owner: "can i get a list of beta testers on the admin") — every
  // tester on the app, however they came, with the state Apple keeps: invited, accepted,
  // installed. The count stays as it was; the list rides beside it.
  const testers = await asc(`/apps/${APP_ID}/betaTesters?limit=200&fields[betaTesters]=firstName,lastName,email,state,inviteType`, token);
  const testerList = (testers.data || []).map(t => ({
    name: [t.attributes.firstName, t.attributes.lastName].filter(Boolean).join(' ') || '—',
    email: t.attributes.email || '—',
    state: t.attributes.state || '—',
    invite: t.attributes.inviteType || '—',
  }));
  return {
    builds: rows,
    groups: (groups.data || []).map(g => ({ name: g.attributes.name, external: !g.attributes.isInternalGroup, link: g.attributes.publicLink, limit: g.attributes.publicLinkLimit })),
    testers: testers?.meta?.paging?.total ?? testerList.length,
    testerList,
  };
}

// ── what testers said: screenshots with comments, and crashes with logs ─────────
async function feedback(token) {
  const shots = await asc(`/apps/${APP_ID}/betaFeedbackScreenshotSubmissions?limit=30&sort=-createdDate&fields[betaFeedbackScreenshotSubmissions]=createdDate,comment,email,deviceModel,osVersion,appPlatform,buildBundleId`, token);
  const crashes = await asc(`/apps/${APP_ID}/betaFeedbackCrashSubmissions?limit=30&sort=-createdDate&fields[betaFeedbackCrashSubmissions]=createdDate,comment,email,deviceModel,osVersion,appPlatform,appUptimeInMilliseconds`, token);
  const shape = (x) => ({ at: x.attributes.createdDate, comment: x.attributes.comment, who: x.attributes.email, device: x.attributes.deviceModel, os: x.attributes.osVersion, platform: x.attributes.appPlatform, uptime: x.attributes.appUptimeInMilliseconds ?? null });
  return {
    screenshots: (shots.data || []).map(shape),
    crashes: (crashes.data || []).map(shape),
    errors: [shots.error, crashes.error].filter(Boolean),
  };
}

// ── the letters, from the store the contact form writes to ──────────────────────
async function letters() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { error: 'no store attached' };
  const r = await fetch('https://blob.vercel-storage.com/?prefix=letters/&limit=200', { headers: { Authorization: 'Bearer ' + token, 'x-api-version': '7' } });
  if (!r.ok) return { error: r.status };
  const list = await r.json();
  const out = [];
  for (const b of (list.blobs || []).slice(0, 60)) {
    try { const j = await (await fetch(b.url)).json(); out.push({ at: j.at, name: j.name, email: j.email, note: j.note }); } catch (e) { /* a torn write; skip it */ }
  }
  out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return { count: (list.blobs || []).length, letters: out };
}

// ── the site's own first-party counts (the /api/hit beacon writes them) ─────────
async function hits() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { error: 'no store attached' };
  const r = await fetch('https://blob.vercel-storage.com/?prefix=hits/&limit=400', { headers: { Authorization: 'Bearer ' + token, 'x-api-version': '7' } });
  if (!r.ok) return { error: r.status };
  const list = await r.json();
  // hits/<day>/<event>-<rand>.json — counted by name, never read, so a thousand is cheap
  const byDay = {};
  for (const b of list.blobs || []) {
    const m = /hits\/(\d{4}-\d{2}-\d{2})\/([a-z_]+)-/.exec(b.pathname || '');
    if (!m) continue;
    byDay[m[1]] = byDay[m[1]] || {}; byDay[m[1]][m[2]] = (byDay[m[1]][m[2]] || 0) + 1;
  }
  return { byDay };
}

// ── the latest daily report, written by api/report.js on the cron ─────────────────
async function latestReport() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const r = await fetch('https://blob.vercel-storage.com/?prefix=reports/&limit=100', { headers: { Authorization: 'Bearer ' + token, 'x-api-version': '7' } });
  if (!r.ok) return null;
  const list = ((await r.json()).blobs || []).sort((a, b) => (b.pathname || '').localeCompare(a.pathname || ''));
  if (!list.length) return null;
  try { return await (await fetch(list[0].url)).json(); } catch (e) { return null; }
}

export default async function handler(req, res) {
  const want = process.env.DASH_TOKEN;
  const got = (req.query && req.query.t) || '';
  if (!want) return res.status(401).json({ ok: false, error: 'This address has no key set on it. Open the desk on long-balance.vercel.app, from its own link.' });
  if (!got) return res.status(401).json({ ok: false, error: 'This page has a key, and the address you opened has none in it — use the desk link with ?t= on the end.' });
  if (got !== want) return res.status(401).json({ ok: false, error: 'This page has a key, and that was not it.' });
  const token = ascToken();
  const [b, f, l, h, rep] = await Promise.all([
    token ? beta(token) : { error: 'App Store Connect key not configured' },
    token ? feedback(token) : { error: 'App Store Connect key not configured' },
    letters(), hits(), latestReport(),
  ]);
  res.setHeader('Cache-Control', 'private, max-age=120');
  return res.status(200).json({ ok: true, at: new Date().toISOString(), beta: b, feedback: f, letters: l, hits: h, report: rep });
}
