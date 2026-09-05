// THE BETA'S DOOR (owner: "it needs a password or some other kind of constraint on access").
// TestFlight's public link has no password of its own, so the site keeps the link behind a
// word. GET /api/beta?word=… answers with the link when the word is the one in BETA_WORD;
// anything else is refused and counted. The seat cap on the link itself (20) still holds.
export default async function handler(req, res) {
  const want = (process.env.BETA_WORD || '').trim().toLowerCase();
  const got = String((req.query && req.query.word) || '').trim().toLowerCase();
  if (!want) return res.status(503).json({ ok: false, error: 'The beta is closed for the moment.' });
  if (!got || got !== want) return res.status(401).json({ ok: false, error: 'That is not the word. Ask Jared for it.' });
  return res.status(200).json({ ok: true, link: 'https://testflight.apple.com/join/56VXDjSd' });
}
