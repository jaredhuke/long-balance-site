// A FIRST-PARTY COUNT. Vercel Web Analytics counts visits, but its numbers live behind
// Vercel's own dashboard and no public API the site can read. This is the site's own
// tally, written by the page for the four things worth counting — a visit, the beta
// link, the form opened, the form sent — as one tiny file per event in the store, named
// by day and event, so the dashboard can count them by NAME without ever reading one.
// No cookie, no identifier, nothing about the visitor: a day, a word, a random suffix.

const EVENTS = new Set(['visit', 'beta_click', 'write_open', 'write_send', 'price_seen']);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const ev = String((body && body.e) || '').slice(0, 24);
  if (!EVENTS.has(ev)) return res.status(204).end();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(204).end();
  const day = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 10);
  try {
    await fetch(`https://blob.vercel-storage.com/hits/${day}/${ev}-${rand}.json`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'x-api-version': '7', 'x-content-type': 'application/json', 'x-add-random-suffix': '0' },
      body: '{}',
    });
  } catch (e) { /* a lost tick is a lost tick */ }
  return res.status(204).end();
}
