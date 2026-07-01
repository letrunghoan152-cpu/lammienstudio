// /api/photo-proxy?albumId=...&photoId=...[&gate=...]
// Stream từng ảnh nguyên bản về client để JSZip nén phía trình duyệt — tránh
// timeout 10s khi gom cả album thành 1 ZIP trên server.
const { supa, configured, gateValid, getStudioDriveAccessToken } = require('./_supa');

// Hint cho Vercel; trên gói Hobby vẫn bị giới hạn 10s, nhưng giữ để khi nâng plan
// hoặc chạy môi trường khác sẽ tự kéo dài.
module.exports.config = { maxDuration: 25 };

async function fetchWithRetry(url, headers, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (res.ok) return res;
      // 401/403 -> có thể token hết hạn, chỉ retry 1 lần; 4xx khác không retry
      if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        throw new Error('HTTP ' + res.status);
      }
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
      console.warn('[PROXY] retry ' + (i + 1) + '/' + attempts + ':', e.message || e);
    }
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, i)));
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });

  const { albumId, photoId, gate } = req.query || {};
  if (!albumId || !photoId) return res.status(400).json({ error: 'Thiếu albumId hoặc photoId' });

  try {
    const rows = await supa(`albums?id=eq.${encodeURIComponent(albumId)}&select=data`);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Album không tồn tại' });
    const data = rows[0].data || {};

    if (data.allowDownload === false) {
      return res.status(403).json({ error: 'Album này không cho phép tải về' });
    }
    // Album bị khoá SĐT: bắt buộc gate token hợp lệ (tránh bypass bằng cách gọi
    // proxy trực tiếp khi chưa qua cổng SĐT).
    if (data.lockPhone && !gateValid(albumId, data, gate)) {
      return res.status(401).json({ error: 'Cần xác thực số điện thoại trước khi tải' });
    }

    const photo = (data.photos || []).find(p => p.id === photoId);
    if (!photo) return res.status(404).json({ error: 'Không tìm thấy ảnh' });
    const driveId = photo.driveId || photo.id;
    if (!driveId) return res.status(404).json({ error: 'Ảnh thiếu driveId' });

    // Dùng Drive API `files/<id>?alt=media` với access token của studio để lấy
    // BYTES NGUYÊN BẢN. Cách này xuyên qua quyền riêng tư (private/Shared Drive)
    // nên khách có thể tải ảnh dù chưa share quyền xem trên Drive.
    // Giới hạn: Vercel Hobby 4.5MB/response — ảnh lớn sẽ báo thiếu trong file txt.
    let tok;
    try { tok = await getStudioDriveAccessToken(); }
    catch (e) { return res.status(502).json({ error: 'Studio chưa kết nối Drive: ' + (e.message || e) }); }

    const dlUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?alt=media&supportsAllDrives=true`;
    const imgRes = await fetchWithRetry(dlUrl, { Authorization: 'Bearer ' + tok.access_token }, 3);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const safeName = String(photo.name || photoId).replace(/[\r\n"]/g, '').slice(0, 200);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeName)}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[PROXY]', albumId, photoId, err.message || err);
    res.status(502).json({ error: 'Không thể tải ảnh: ' + (err.message || err) });
  }
};
