// POST /api/create-drive-zip
// Tạo ZIP file từ Google Drive folder (studio chỉ định).
// Server tạo ZIP trên Drive infra, khách tải từ Drive → bypass Vercel 4.5MB limit.
const { supa, configured, checkAuthFull, getStudioDriveAccessToken } = require('./_supa');
const JSZip = require('jszip');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });

  const auth = await checkAuthFull(req);
  if (!auth) return res.status(401).json({ error: 'Chưa đăng nhập' });

  const { albumId, folderId, photoIds } = req.body || {};
  if (!albumId || !folderId) return res.status(400).json({ error: 'Thiếu albumId hoặc folderId' });

  try {
    // Lấy access token studio (để call Drive API với quyền studio)
    let tok;
    try { tok = await getStudioDriveAccessToken(); }
    catch (e) { return res.status(502).json({ error: 'Studio chưa kết nối Drive: ' + (e.message || e) }); }

    // Lấy danh sách file trong folder Drive
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=\`${encodeURIComponent(folderId)}\` in parents and trashed=false&fields=files(id,name,mimeType,imageMediaMetadata)&supportsAllDrives=true`;
    const listRes = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!listRes.ok) return res.status(502).json({ error: 'Không đọc được folder Drive: ' + listRes.status });
    const { files } = await listRes.json();

    // Lọc ảnh (nếu có photoIds thì chỉ lấy những photoId đó, ngược lại lấy tất cả)
    const imagesToZip = files.filter(f => {
      if (!f.mimeType.startsWith('image/')) return false;
      return !photoIds || photoIds.includes(f.id);
    });

    if (!imagesToZip.length) {
      return res.status(400).json({ error: 'Không có ảnh nào trong folder' });
    }

    // Tạo ZIP trên server (stream từng ảnh từ Drive)
    const zip = new JSZip();
    const failed = [];
    const usedNames = new Map();

    for (let i = 0; i < imagesToZip.length; i++) {
      const img = imagesToZip[i];
      try {
        // Download ảnh từ Drive
        const imgUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(img.id)}?alt=media&supportsAllDrives=true`;
        const imgRes = await fetch(imgUrl, {
          headers: { Authorization: 'Bearer ' + tok.access_token },
          signal: AbortSignal.timeout(20000)
        });
        if (!imgRes.ok) throw new Error('HTTP ' + imgRes.status);

        const blob = await imgRes.blob();

        // Tránh trùng tên file trong ZIP
        let name = img.name || `photo_${i + 1}.jpg`;
        const seen = usedNames.get(name) || 0;
        if (seen > 0) {
          const dot = name.lastIndexOf('.');
          name = dot > 0 ? `${name.slice(0, dot)}_${seen}${name.slice(dot)}` : `${name}_${seen}`;
        }
        usedNames.set(img.name || name, seen + 1);

        zip.file(name, blob);
      } catch (e) {
        console.warn('[CREATE-ZIP] Lỗi ảnh:', img.name || img.id, e.message || e);
        failed.push(img.name || img.id);
      }
    }

    if (failed.length) {
      const report = [
        'BÁO CÁO LỖI TẢI ẢNH',
        `Album: ${albumId}`,
        `Ngày: ${new Date().toLocaleString('vi-VN')}`,
        '',
        `Không tải được ${failed.length} ảnh:`,
        ...failed.map(n => '  - ' + n),
        '',
        'Vui lòng liên hệ studio để được hỗ trợ.',
      ].join('\n');
      zip.file('_THIEU_ANH_doc_truoc.txt', report);
    }

    // Tạo ZIP buffer
    const content = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    const buffer = Buffer.from(content);

    // Upload ZIP lên Drive (thành file temp trong folder album)
    const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?supportsAllDrives=true', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tok.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${albumId}_${Date.now()}.zip`,
        mimeType: 'application/zip',
        parents: [folderId],
        properties: { tempFile: 'true', expiresAt: new Date(Date.now() + 86400000).toISOString() } // 24h ttl
      })
    });

    if (!uploadRes.ok) {
      // Fallback: stream ZIP qua Vercel (4.5MB limit) nếu upload Drive fail
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${albumId}.zip"`);
      return res.send(buffer);
    }

    const uploadMeta = await uploadRes.json();
    const zipFileId = uploadMeta.id;

    // Trả ZIP file ID cho khách (client sẽ redirect tải từ Drive)
    res.json({
      ok: true,
      zipId: zipFileId,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${zipFileId}`,
      failed: failed.length,
      total: imagesToZip.length
    });
  } catch (err) {
    console.error('[CREATE-ZIP]', albumId, err.message || err);
    res.status(502).json({ error: 'Không thể tạo ZIP: ' + (err.message || err) });
  }
};
