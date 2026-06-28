// POST /api/login  {user, pass} -> {ok, token, name, role, sync}
// Tạo session token ngay tại đây để client không cần gọi thêm /api/session
const { configured, validUser, supa } = require('./_supa');
const crypto = require('crypto');

// Rate limit: tối đa 10 lần thử / phút / IP (in-memory, reset khi cold start)
const _rl = new Map();
function rateCheck(ip) {
  const now = Date.now();
  let r = _rl.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 60000 }; _rl.set(ip, r); }
  r.count++;
  return r.count <= 10;
}
// Dọn map để tránh rò bộ nhớ nếu instance sống lâu
setInterval(() => {
  const now = Date.now();
  _rl.forEach((v, k) => { if (now > v.resetAt) _rl.delete(k); });
}, 300000); // mỗi 5 phút

const SESSION_DAYS = 7;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || 'unknown';
  if (!rateCheck(ip)) {
    return res.status(429).json({ error: 'Quá nhiều lần thử đăng nhập. Vui lòng đợi 1 phút rồi thử lại.' });
  }

  const { user, pass } = req.body || {};
  const found = await validUser(user, pass);
  if (!found) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });

  // Tạo session token (nếu Supabase đã cấu hình)
  let token = null;
  if (configured()) {
    try {
      token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
      await supa('sessions', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify([{
          token,
          user_id: found.user,
          user_name: found.name,
          role: found.role || 'staff',
          expires_at: expiresAt,
        }]),
      });
    } catch (_) {
      // Bảng sessions chưa tồn tại -> vẫn trả kết quả đăng nhập thành công (backward compat)
      token = null;
    }
  }

  return res.status(200).json({
    ok: true,
    sync: configured(),
    name: found.name,
    role: found.role || 'staff',
    ...(token ? { token } : {}),
  });
};
