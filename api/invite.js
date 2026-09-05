// INVITE A TESTER BY NAME (from the desk). POST { t, email, first, last } — the desk key
// gates it. Creates the tester on App Store Connect inside the "testers" group, which mails
// them Apple's own invitation. This is the constrained door: one person, one address.
import crypto from 'node:crypto';
const APP_ID = '6792535399';
const ASC = 'https://api.appstoreconnect.apple.com/v1';
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
async function asc(method, path, token, body) {
  const r = await fetch(ASC + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch (e) {}
  return { ok: r.ok, status: r.status, json };
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!process.env.DASH_TOKEN || body.t !== process.env.DASH_TOKEN) return res.status(401).json({ ok: false, error: 'This page has a key, and that was not it.' });
  const email = String(body.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'That does not look like an address.' });
  const token = ascToken();
  if (!token) return res.status(503).json({ ok: false, error: 'The App Store Connect key is not set.' });
  const groups = await asc('GET', `/apps/${APP_ID}/betaGroups?limit=10`, token);
  const group = (groups.json.data || []).find(g => g.attributes.name === 'testers') || (groups.json.data || [])[0];
  if (!group) return res.status(500).json({ ok: false, error: 'No beta group to put them in.' });
  const made = await asc('POST', '/betaTesters', token, { data: { type: 'betaTesters', attributes: { email, firstName: String(body.first || '').trim() || undefined, lastName: String(body.last || '').trim() || undefined }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } } });
  if (!made.ok) {
    const detail = (made.json.errors || [])[0]?.detail || ('Apple answered ' + made.status);
    return res.status(made.status).json({ ok: false, error: detail });
  }
  return res.status(200).json({ ok: true, invited: email, group: group.attributes.name });
}
