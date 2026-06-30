// /api/album?id=xxx — dành cho khách (không cần đăng nhập)
// GET  -> dữ liệu album để hiển thị trang chọn ảnh
// POST {review:{photoId:{r,n}}, status} -> lưu lựa chọn / ghi chú của khách vào album
const { supa, configured, sendStudioEmail, casUpdateAlbum, gateToken, gateValid } = require('./_supa');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });
  const id = (req.query || {}).id;
  if (!id) return res.status(400).json({ error: 'Thiếu id' });

  try {
    const rows = await supa(`albums?id=eq.${encodeURIComponent(id)}&select=data`);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Không tìm thấy album' });
    let data = rows[0].data;

    if (req.method === 'GET') {
      // Bảo mật: KHÔNG bao giờ gửi thông tin nhạy cảm cho khách
      const pub = Object.assign({}, data);
      delete pub.internalNotes; delete pub.internal_notes;
      delete pub._rev;
      // lockPhone: không expose SĐT thô — thay bằng flag isLocked
      // để tránh bypass gate bằng cách gọi API trực tiếp
      pub.isLocked = !!pub.lockPhone;
      delete pub.lockPhone;
      // Album bị khoá: chỉ trả ẢNH khi đã qua cổng SĐT (có gate token hợp lệ).
      // Chưa qua cổng -> ẩn photos để không thể xem ảnh bằng cách gọi API trực tiếp.
      if (pub.isLocked && !gateValid(id, data, (req.query || {}).gate)) {
        delete pub.photos;
        pub.gated = true;
      }
      return res.status(200).json(pub);
    }

    if (req.method === 'POST') {
      const { review, status, action, phone } = req.body || {};

      // ── Xác thực SĐT (phone gate) ──
      if (action === 'verify-phone') {
        if (!data.lockPhone) return res.status(200).json({ ok: true }); // không có gate
        const input = (phone || '').replace(/\D/g, '');
        const expected = (data.lockPhone || '').replace(/\D/g, '');
        if (!input || input !== expected) {
          return res.status(401).json({ error: 'Số điện thoại không đúng' });
        }
        // Cấp gate token để khách dùng cho GET ảnh & POST lựa chọn về sau.
        return res.status(200).json({ ok: true, gate: gateToken(id, expected) });
      }

      // Album bị khoá: mọi thao tác ghi lựa chọn phải kèm gate token hợp lệ.
      if (data.lockPhone && !gateValid(id, data, (req.body || {}).gate)) {
        return res.status(401).json({ error: 'Cần xác thực số điện thoại trước khi lưu' });
      }
      // Chặn vượt số ảnh tối đa (phòng request cố tình vượt giới hạn) — kiểm trên
      // bản vừa đọc; số lượng "selected" lấy từ body nên không phụ thuộc độ mới của data.
      if (review && typeof review === 'object' && data.maxCount) {
        const want = Object.keys(review).filter(k => review[k] && review[k].r === 'selected').length;
        if (want > data.maxCount) return res.status(400).json({ error: `Vượt quá ${data.maxCount} ảnh tối đa` });
      }

      // Ghi qua optimistic locking: áp lựa chọn của khách lên bản server MỚI NHẤT
      // (tránh ghi đè mất ảnh mới studio vừa thêm trong lúc khách đang chọn).
      let notify = false;
      const result = await casUpdateAlbum(id, (data) => {
        if (!data) return null;
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
        // Khách chốt ảnh lần đầu -> ghi thời điểm + tính hạn trả + gửi email thông báo
        if (status === 'done' && !data.selectedAt) {
          data.selectedAt = Date.now();
          notify = true;
          if (data.deadlineDays) {
            const d = new Date(data.selectedAt + 7 * 3600 * 1000); // múi giờ VN
            d.setUTCDate(d.getUTCDate() + data.deadlineDays);
            data.deadline = d.toISOString().slice(0, 10);
          }
        }
        // Auto-tạo gallery "Ảnh đã chọn" khi khách chốt (idempotent)
        if (status === 'done') {
          if (!data.galleries) data.galleries = [];
          if (!data.galleries.some(g => g.autoSelected)) {
            data.galleries.push({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
              name: 'Ảnh đã chọn',
              autoSelected: true,
              createdAt: Date.now(),
            });
          }
        }
        data.lastActivity = Date.now();
        return data;
      });
      if (!result.ok) return res.status(409).json({ error: 'Không thể lưu lựa chọn (xung đột đồng bộ)' });
      data = result.data;
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
