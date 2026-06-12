// POST /api/login  {user, pass} -> {ok, sync}
const { configured, staffUser, staffPass } = require('./_supa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { user, pass } = req.body || {};
  if (user !== staffUser() || pass !== staffPass()) {
    return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  }
  return res.status(200).json({ ok: true, sync: configured() });
};
