// POST /api/session  {user, pass}  -> {token, name, role, expiresAt}
// DELETE /api/session               -> {ok:true}  (logout)
// GET /api/session                  -> {ok:true, user, name, role}  (kiểm tra token còn hạn)
const { supa, configured, validUser } = require('./_supa');
const crypto = require('crypto');

const DAYS = 7;

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ (Supabase)' });

  /* ---- Tạo session (đăng nhập) ---- */
  if (req.method === 'POST') {
    const { user, pass } = req.body || {};
    const found = await validUser(user, pass);
    if (!found) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + DAYS * 24 * 3600 * 1000).toISOString();
    try {
      await supa('sessions', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify([{ token, user_id: found.user, user_name: found.name, role: found.role || 'staff', expires_at: expiresAt }]),
      });
    } catch (e) {
      return res.status(500).json({ error: 'Lỗi tạo session: ' + String(e.message || e) });
    }
    return res.status(200).json({ token, name: found.name, role: found.role || 'staff', expiresAt, sync: true });
  }

  /* ---- Kiểm tra session (GET) ---- */
  if (req.method === 'GET') {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
    try {
      const rows = await supa('sessions?token=eq.' + encodeURIComponent(token) + '&select=user_id,user_name,role,expires_at');
      if (!rows || !rows[0]) return res.status(401).json({ error: 'Phiên không hợp lệ' });
      if (new Date(rows[0].expires_at) < new Date()) {
        await supa('sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE' }).catch(() => {});
        return res.status(401).json({ error: 'Phiên đã hết hạn' });
      }
      return res.status(200).json({ ok: true, user: rows[0].user_id, name: rows[0].user_name, role: rows[0].role || 'staff' });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  /* ---- Xoá session (đăng xuất) ---- */
  if (req.method === 'DELETE') {
    const token = req.headers['x-token'];
    if (token) {
      await supa('sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE' }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
