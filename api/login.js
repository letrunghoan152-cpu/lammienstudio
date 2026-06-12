// POST /api/login  {user, pass} -> {ok, sync, name}
const { configured, validUser } = require('./_supa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { user, pass } = req.body || {};
  const found = await validUser(user, pass);
  if (!found) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  return res.status(200).json({ ok: true, sync: configured(), name: found.name });
};
