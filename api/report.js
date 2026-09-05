// THE DAILY REPORT, ON VERCEL'S CLOCK (owner: "vercel it"). Every morning at 08:53 the cron
// in vercel.json calls this. It reads the same sources the desk reads, writes one file —
// reports/<date>.json — into the store, and, when a mail key exists, sends the five-line
// summary to the owner. The desk shows the latest report at the top, so the numbers are
// there whether or not the mail went. Nothing about any visitor is in it; it is counts.
//
// Vercel signs its cron calls with CRON_SECRET when one is set; anyone else is refused.

import crypto from 'node:crypto';

const APP_ID = '6792535399';
const ASC = 'https://api.appstoreconnect.apple.com/v1';
const BLOB = 'https://blob.vercel-storage.com';

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
  return r.ok ? r.json() : { error: r.status };
}
async function blobList(prefix, limit) {
  const r = await fetch(`${BLOB}/?prefix=${encodeURIComponent(prefix)}&limit=${limit}`, { headers: { Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7' } });
  return r.ok ? (await r.json()).blobs || [] : [];
}

const day = (d) => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const keyed = (req.query && req.query.t) === process.env.DASH_TOKEN;
  if (secret && auth !== 'Bearer ' + secret && !keyed) return res.status(401).json({ ok: false });

  const today = new Date(); const yesterday = new Date(today.getTime() - 864e5);
  const y = day(yesterday);
  const week = new Set(Array.from({ length: 7 }, (_, i) => day(new Date(today.getTime() - (i + 1) * 864e5))));
  const prior = new Set(Array.from({ length: 7 }, (_, i) => day(new Date(today.getTime() - (i + 8) * 864e5))));

  // the site's own tally
  const hits = await blobList('hits/', 1000);
  const count = (days, ev) => hits.filter(b => { const m = /hits\/(\d{4}-\d{2}-\d{2})\/([a-z_]+)-/.exec(b.pathname || ''); return m && days.has(m[1]) && m[2] === ev; }).length;
  const site = {
    yesterday: { visits: count(new Set([y]), 'visit'), beta: count(new Set([y]), 'beta_click'), writes: count(new Set([y]), 'write_send') },
    week: { visits: count(week, 'visit'), beta: count(week, 'beta_click'), writes: count(week, 'write_send') },
    prior: { visits: count(prior, 'visit'), beta: count(prior, 'beta_click'), writes: count(prior, 'write_send') },
  };

  // the beta, from Apple
  let beta = { error: 'no key' };
  const token = ascToken();
  if (token) {
    const builds = await asc(`/builds?filter[app]=${APP_ID}&limit=6&sort=-uploadedDate&include=preReleaseVersion&fields[builds]=version,processingState,preReleaseVersion&fields[preReleaseVersions]=platform`, token);
    const pre = Object.fromEntries((builds.included || []).map(i => [i.id, i.attributes]));
    const rows = [];
    for (const b of builds.data || []) {
      const use = await asc(`/builds/${b.id}/metrics/betaBuildUsages`, token);
      const u = use?.data?.[0]?.dataPoints?.[0]?.values || {};
      rows.push({ build: b.attributes.version, platform: pre[b.relationships?.preReleaseVersion?.data?.id]?.platform || '?', installs: u.installCount ?? 0, sessions: u.sessionCount ?? 0, crashes: u.crashCount ?? 0, feedback: u.feedbackCount ?? 0 });
    }
    const crashes = await asc(`/apps/${APP_ID}/betaFeedbackCrashSubmissions?limit=50&sort=-createdDate&fields[betaFeedbackCrashSubmissions]=createdDate`, token);
    const newCrashes = (crashes.data || []).filter(c => (c.attributes.createdDate || '').slice(0, 10) === y).length;
    beta = { builds: rows, installs: rows.reduce((a, r) => a + r.installs, 0), newCrashes };
  }

  const letters = (await blobList('letters/', 500)).length;
  const report = { date: y, made: today.toISOString(), site, beta, letters };

  // write it where the desk can find it
  await fetch(`${BLOB}/reports/${y}.json`, { method: 'PUT', headers: { Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN, 'x-api-version': '7', 'x-content-type': 'application/json', 'x-add-random-suffix': '0' }, body: JSON.stringify(report) });

  // and say it, if there is a way to
  const pct = (a, b) => b ? Math.round((a - b) / b * 100) : (a ? 100 : 0);
  const lines = [
    `The valley, ${y}.`,
    `Visitors ${site.yesterday.visits} yesterday · ${site.week.visits} this week (${pct(site.week.visits, site.prior.visits) >= 0 ? '+' : ''}${pct(site.week.visits, site.prior.visits)}% on the week before).`,
    `Beta clicks ${site.yesterday.beta} · ${site.week.beta} this week.`,
    beta.error ? `Beta: ${beta.error}.` : `Installs across builds ${beta.installs} · new crash reports yesterday ${beta.newCrashes}.`,
    `Letters on file ${letters}.`,
  ];
  let mailed = false;
  if (process.env.RESEND_API_KEY && process.env.CONTACT_TO) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.CONTACT_FROM || 'The Long Balance <onboarding@resend.dev>', to: [process.env.CONTACT_TO], subject: `The valley, ${y}`, text: lines.join('\n') }) });
    mailed = r.ok;
  }
  return res.status(200).json({ ok: true, report, mailed, said: lines });
}
