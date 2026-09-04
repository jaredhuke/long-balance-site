// THE FORM'S OTHER HALF. "Write to us" was a mailto: it did nothing at all on a machine
// with no mail client set up, and it put the address in front of every reader and every
// harvester that ever loaded the page. The address lives HERE now, in an environment
// variable on the server, and never reaches a browser.
//
// What a reader sends goes two places: to the owner's inbox as mail they can simply reply
// to, and onto a list, so a note survives a bad afternoon at the mail provider. Neither
// half is allowed to fail the other.

const MAX = { name: 120, email: 200, note: 4000 };

const clean = (v, cap) => (typeof v === 'string' ? v.trim().slice(0, cap) : '');

// Deliberately loose. An address that looks like an address is as much as a contact form
// can honestly check, and turning away a real one is worse than accepting a fake.
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);

async function sendMail({ name, email, note, to }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, why: 'no mail provider configured' };
  const from = process.env.CONTACT_FROM || 'The Long Balance <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email || undefined,
        subject: 'The Long Balance — ' + (name || 'a reader'),
        text: (name || '(no name)') + ' <' + (email || 'no address given') + '>\n\n' + note + '\n',
      }),
    });
    return r.ok ? { sent: true } : { sent: false, why: 'mail provider said ' + r.status };
  } catch (e) {
    return { sent: false, why: String(e && e.message) };
  }
}

// The list. Vercel Blob when a store is attached, skipped in silence when there is none —
// a missing list must never swallow a letter the mail half already delivered.
async function appendToList(entry) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { listed: false, why: 'no store attached' };
  try {
    // THE NAME CARRIES NOTHING AND IS NOT GUESSABLE. A blob store serves what it holds to
    // anyone who knows the URL, so a letter filed under its own timestamp would be a
    // stranger's email address behind a name you could count up to. The path is 32 hex
    // characters of real randomness, and Vercel appends its own suffix on top; nothing
    // about the writer is in it.
    const rand = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    const r = await fetch('https://blob.vercel-storage.com/letters/' + rand + '.json', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'x-api-version': '7',
        'x-content-type': 'application/json',
        'x-add-random-suffix': '1',
      },
      body: JSON.stringify(entry),
    });
    return r.ok ? { listed: true } : { listed: false, why: 'store said ' + r.status };
  } catch (e) {
    return { listed: false, why: String(e && e.message) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Send it as a POST.' });
  }
  const to = process.env.CONTACT_TO;
  if (!to) return res.status(500).json({ ok: false, error: 'This form is not finished being set up.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // A honeypot: a field no person can see and every crude robot fills in. Answer 200, so
  // the robot learns nothing from the difference, and drop the message on the floor.
  if (clean(body.hedgerow, 40)) return res.status(200).json({ ok: true });

  const name = clean(body.name, MAX.name);
  const email = clean(body.email, MAX.email);
  const note = clean(body.note, MAX.note);
  if (!note) return res.status(400).json({ ok: false, error: 'Say something first.' });
  if (email && !looksLikeEmail(email)) {
    return res.status(400).json({ ok: false, error: 'That address does not look right.' });
  }

  const entry = {
    at: new Date().toISOString(),
    name: name,
    email: email,
    note: note,
    from: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
  };

  const both = await Promise.all([sendMail({ name, email, note, to }), appendToList(entry)]);
  const mail = both[0], list = both[1];
  if (!mail.sent && !list.listed) {
    console.error('contact: nothing landed —', mail.why, '/', list.why);
    return res.status(502).json({ ok: false, error: 'The letter did not get through. Try again shortly.' });
  }
  if (!mail.sent) console.warn('contact: listed but not mailed —', mail.why);
  if (!list.listed) console.warn('contact: mailed but not listed —', list.why);
  return res.status(200).json({ ok: true });
}
