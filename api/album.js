// /api/album?id=xxx — dành cho khách (không cần đăng nhập)
// GET  -> dữ liệu album để hiển thị trang chọn ảnh
// POST {review:{photoId:{r,n}}, status} -> lưu lựa chọn / ghi chú của khách vào album
const { supa, configured } = require('./_supa');

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });
  const id = (req.query || {}).id;
  if (!id) return res.status(400).json({ error: 'Thiếu id' });

  try {
    const rows = await supa(`albums?id=eq.${encodeURIComponent(id)}&select=data`);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Không tìm thấy album' });
    const data = rows[0].data;

    if (req.method === 'GET') return res.status(200).json(data);

    if (req.method === 'POST') {
      const { review, status } = req.body || {};
      if (review && typeof review === 'object') {
        (data.photos || []).forEach(p => {
          const u = review[p.id];
          if (u) {
            p.review = u.r || '';
            p.selected = u.r === 'selected';
            if ('n' in u) p.note = u.n || '';
          }
        });
      }
      // Khách chỉ được phép đẩy trạng thái sang "đang chọn" / "chọn xong"
      if (status === 'choosing' || status === 'done') data.status = status;
      // Khách chốt ảnh lần đầu -> ghi thời điểm + tính hạn trả (deadline = ngày chốt + số ngày)
      if (status === 'done' && !data.selectedAt) {
        data.selectedAt = Date.now();
        if (data.deadlineDays) {
          const d = new Date(data.selectedAt + 7 * 3600 * 1000); // múi giờ VN
          d.setUTCDate(d.getUTCDate() + data.deadlineDays);
          data.deadline = d.toISOString().slice(0, 10);
        }
      }
      data.lastActivity = Date.now();
      await supa(`albums?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
