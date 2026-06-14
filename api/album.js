// /api/album?id=xxx — dành cho khách (không cần đăng nhập)
// GET  -> dữ liệu album để hiển thị trang chọn ảnh
// POST {review:{photoId:{r,n}}, status} -> lưu lựa chọn / ghi chú của khách vào album
const { supa, configured, sendStudioEmail } = require('./_supa');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

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
        // Chặn vượt số ảnh tối đa (phòng request cố tình vượt giới hạn)
        if (data.maxCount) {
          const want = Object.keys(review).filter(k => review[k] && review[k].r === 'selected').length;
          if (want > data.maxCount) return res.status(400).json({ error: `Vượt quá ${data.maxCount} ảnh tối đa` });
        }
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
      // Khách chốt ảnh lần đầu -> ghi thời điểm + tính hạn trả + gửi email thông báo
      let notify = false;
      if (status === 'done' && !data.selectedAt) {
        data.selectedAt = Date.now();
        notify = true;
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
      if (notify) {
        const sel = (data.photos || []).filter(p => p.review === 'selected' || p.selected);
        const names = sel.slice(0, 50).map((p, i) => `${i + 1}. ${esc(p.name)}${p.note ? ` — <i>${esc(p.note)}</i>` : ''}`).join('<br>');
        const html = `<div style="font-family:Arial,sans-serif;color:#222">
          <h2>🎉 Khách đã chọn xong ảnh</h2>
          <p><b>Album:</b> ${esc(data.name || '')}<br>
          <b>Khách:</b> ${esc(data.client || '—')}<br>
          <b>Số ảnh đã chọn:</b> ${sel.length}${data.maxCount ? ' / ' + data.maxCount : ''}</p>
          <p><b>Danh sách ảnh chọn:</b><br>${names || '(trống)'}${sel.length > 50 ? '<br>… và ' + (sel.length - 50) + ' ảnh nữa' : ''}</p>
          <p style="color:#777">Mở dashboard Lam Miên Studio để xem chi tiết &amp; tải về.</p></div>`;
        await sendStudioEmail(`[Lam Miên] ${data.name || 'Khách'} đã chọn xong ${sel.length} ảnh`, html);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
