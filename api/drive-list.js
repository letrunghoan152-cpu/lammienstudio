// GET /api/drive-list?folderId=xxx — liệt kê ảnh trong 1 thư mục Drive (chỉ nhân sự đã đăng nhập)
// Dùng GOOGLE_DRIVE_API_KEY từ biến môi trường Vercel -> KHÔNG lộ key ra phía client.
const { checkAuth } = require('./_supa');

module.exports = async (req, res) => {
  if (!(await checkAuth(req))) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const folderId = (req.query || {}).folderId;
  if (!folderId) return res.status(400).json({ error: 'Thiếu folderId' });
  const key = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  if (!key) return res.status(503).json({ error: 'Chưa cấu hình GOOGLE_DRIVE_API_KEY trên Vercel' });

  let files = [], pageToken = '';
  try {
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
      url.searchParams.set('key', key);
      url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,imageMediaMetadata(width,height))');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'name_natural');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url);
      if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(r.status).json({ error: e.error?.message || 'Drive API lỗi' }); }
      const d = await r.json();
      files.push(...(d.files || []));
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return res.status(200).json({ files });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
};
