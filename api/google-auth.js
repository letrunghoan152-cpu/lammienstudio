// /api/google-auth — kết nối tài khoản Google của STUDIO một lần (luồng authorization code)
//   ?action=state    (POST, cần đăng nhập nhân sự) -> trả state đã ký để mở popup
//   ?action=start&state=...   -> chuyển hướng sang màn hình đồng ý của Google
//   ?action=callback&code=&state= -> đổi code lấy refresh_token, lưu vào Supabase
const crypto = require('crypto');
const { configured, validUser, getConfig, setConfig } = require('./_supa');

const CID = () => (process.env.GOOGLE_CLIENT_ID || '').trim();
const CSECRET = () => (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const SIGN_SECRET = () => process.env.SUPABASE_SERVICE_KEY || 'lammien';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

function sign(ts) { return crypto.createHmac('sha256', SIGN_SECRET()).update(String(ts)).digest('hex').slice(0, 32); }
function makeState() { const ts = Date.now(); return ts + '.' + sign(ts); }
function okState(s) {
  if (!s) return false;
  const i = String(s).indexOf('.'); if (i < 0) return false;
  const ts = s.slice(0, i), sig = s.slice(i + 1);
  if (!/^\d+$/.test(ts) || Date.now() - Number(ts) > 600000) return false; // hết hạn 10 phút
  return sign(ts) === sig;
}
function redirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${req.headers.host}/api/google-auth`;
}
function page(title, body) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 20px;color:#222">
    ${body}</body></html>`;
}

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ (Supabase)' });
  const action = (req.query || {}).action;

  // Chẩn đoán: xem máy chủ đang dùng client_id / secret / redirect_uri nào (client_id không phải bí mật)
  if (action === 'info') {
    return res.status(200).json({
      GOOGLE_CLIENT_ID: CID() || '(TRỐNG — chưa set trên Vercel)',
      has_GOOGLE_CLIENT_SECRET: !!CSECRET(),
      redirect_uri_can_dang_ky: redirectUri(req),
    });
  }

  if (action === 'state') {
    const u = await validUser(req.headers['x-user'], req.headers['x-pass']);
    if (!u) return res.status(401).json({ error: 'Chưa đăng nhập' });
    if (!CID() || !CSECRET()) return res.status(503).json({ error: 'Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET trên Vercel' });
    return res.status(200).json({ state: makeState() });
  }

  if (action === 'start') {
    if (!okState((req.query || {}).state)) return res.status(400).send(page('Lỗi', '<h3>Phiên kết nối không hợp lệ hoặc đã hết hạn</h3><p>Hãy bấm lại nút “Kết nối studio” trong ứng dụng.</p>'));
    if (!CID() || !CSECRET()) return res.status(503).send(page('Thiếu cấu hình', '<h3>Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET</h3>'));
    const p = new URLSearchParams({
      client_id: CID(), redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: (req.query || {}).state,
    });
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString() });
    return res.end();
  }

  if (action === 'callback') {
    const { code, state, error } = req.query || {};
    if (error) return res.status(400).send(page('Đã huỷ', '<h3>Đã huỷ kết nối</h3><p>' + String(error) + '</p>'));
    if (!okState(state)) return res.status(400).send(page('Lỗi', '<h3>Phiên không hợp lệ</h3>'));
    if (!code) return res.status(400).send(page('Lỗi', '<h3>Thiếu mã uỷ quyền</h3>'));
    try {
      const body = new URLSearchParams({
        code, client_id: CID(), client_secret: CSECRET(), redirect_uri: redirectUri(req), grant_type: 'authorization_code',
      });
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const tok = await r.json();
      if (!r.ok || !tok.refresh_token) {
        return res.status(400).send(page('Lỗi', '<h3>Không lấy được refresh token</h3><p>' + (tok.error_description || tok.error || 'Hãy thử lại.') + '</p>'));
      }
      let email = '';
      try {
        const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
        if (ui.ok) email = (await ui.json()).email || '';
      } catch (_) {}
      await setConfig('studio_drive', { refresh_token: tok.refresh_token, email, connectedAt: Date.now() });
      return res.status(200).send(page('Đã kết nối', '<h2>✅ Đã kết nối Google Drive của studio</h2><p><b>' + (email || '') + '</b></p><p>Nhân sự giờ có thể tải ảnh lên mà không cần đăng nhập Google.</p><p style="color:#777">Cửa sổ này sẽ tự đóng…</p><script>setTimeout(function(){window.close()},1600)</script>'));
    } catch (e) { return res.status(500).send(page('Lỗi', '<h3>Lỗi máy chủ</h3><p>' + String(e.message || e) + '</p>')); }
  }

  return res.status(400).json({ error: 'action không hợp lệ' });
};
