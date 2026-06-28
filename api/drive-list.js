// GET /api/drive-list?folderId=xxx — liệt kê ảnh trong 1 thư mục Drive (chỉ nhân sự đã đăng nhập)
// Dùng OAuth token của studio (giống drive-token.js) thay vì API key.
// API key không có quyền files.list kể cả folder đã public "Anyone with the link".
const { configured, checkAuth, getConfig } = require('./_supa');

let tokenCache = { token: '', exp: 0 };

async function getStudioToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const cfg = await getConfig('studio_drive');
  if (!cfg || !cfg.refresh_token) return null;
  const cid = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!cid || !secret) return null;
  const body = new URLSearchParams({ client_id: cid, client_secret: secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const tok = await r.json();
  if (!r.ok || !tok.access_token) return null;
  tokenCache = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
  return tok.access_token;
}

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });
  if (!(await checkAuth(req))) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const folderId = (req.query || {}).folderId;
  if (!folderId) return res.status(400).json({ error: 'Thiếu folderId' });

  const token = await getStudioToken();
  if (!token) return res.status(503).json({ error: 'Studio chưa kết nối Google Drive. Vào Cài đặt → Kết nối Drive.' });

  let files = [], pageToken = '';
  try {
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,imageMediaMetadata(width,height))');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'name_natural');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const msg = e.error?.message || 'Drive API lỗi';
        // 404 = folder không tồn tại hoặc Drive token không có quyền truy cập
        if (r.status === 404) return res.status(404).json({ error: `Không tìm thấy folder. Kiểm tra link Drive và đảm bảo folder được chia sẻ với tài khoản Drive của studio (${msg})` });
        return res.status(r.status).json({ error: msg });
      }
      const d = await r.json();
      files.push(...(d.files || []));
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return res.status(200).json({ files });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
};
