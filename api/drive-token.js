// /api/drive-token — cấp access token Drive ngắn hạn cho nhân sự đã đăng nhập app
//   GET            -> { access_token, expires_in, email }  (504/404 nếu studio chưa kết nối)
//   GET ?status=1  -> { connected, email }                 (không cấp token, chỉ kiểm tra)
const { configured, checkAuth, getConfig } = require('./_supa');

let cache = { token: '', exp: 0 }; // cache theo instance ấm (giảm gọi Google)

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });
  if (!(await checkAuth(req))) return res.status(401).json({ error: 'Chưa đăng nhập' });

  const cfg = await getConfig('studio_drive');
  if (!cfg || !cfg.refresh_token) return res.status(404).json({ error: 'Studio chưa kết nối Google Drive' });

  if ((req.query || {}).status) return res.status(200).json({ connected: true, email: cfg.email || '' });

  if (cache.token && Date.now() < cache.exp - 60000) {
    return res.status(200).json({ access_token: cache.token, expires_in: Math.floor((cache.exp - Date.now()) / 1000), email: cfg.email || '' });
  }
  const cid = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!cid || !secret) return res.status(503).json({ error: 'Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' });
  try {
    const body = new URLSearchParams({ client_id: cid, client_secret: secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' });
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const tok = await r.json();
    if (!r.ok || !tok.access_token) return res.status(502).json({ error: tok.error_description || tok.error || 'Không refresh được token' });
    cache = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
    return res.status(200).json({ access_token: tok.access_token, expires_in: tok.expires_in || 3600, email: cfg.email || '' });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
};
