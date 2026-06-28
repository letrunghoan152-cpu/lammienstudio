// /api/albums — dành cho nhân sự (cần x-token hoặc x-user/x-pass)
// GET            -> danh sách album (kèm _serverUpdatedAt)
// POST {album}   -> tạo / cập nhật 1 album
// DELETE ?id=    -> xoá album (phân quyền theo role)
const { supa, configured, checkAuthFull, can } = require('./_supa');

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });

  try {
    const auth = await checkAuthFull(req);
    if (!auth) return res.status(401).json({ error: 'Chưa đăng nhập' });
    const role = auth.role || 'viewer';

    if (req.method === 'GET') {
      const rows = await supa('albums?select=data,updated_at&order=updated_at.desc');
      return res.status(200).json(
        (rows || []).map(r => ({ ...r.data, _serverUpdatedAt: new Date(r.updated_at).getTime() }))
      );
    }

    if (req.method === 'POST') {
      const album = (req.body || {}).album;
      if (!album || !album.id) return res.status(400).json({ error: 'Thiếu album.id' });

      // Kiểm tra quyền: tạo mới vs cập nhật
      const existing = await supa(`albums?id=eq.${encodeURIComponent(album.id)}&select=data`).catch(() => null);
      const isNew = !existing || !existing[0];

      if (isNew && !can(role, 'album', 'create')) {
        return res.status(403).json({ error: 'Tài khoản của bạn không có quyền tạo album mới' });
      }
      if (!isNew && !can(role, 'album', 'edit')) {
        return res.status(403).json({ error: 'Tài khoản của bạn không có quyền sửa album' });
      }

      // Giữ lại lựa chọn của khách (review, note, selectedAt) khi studio push
      if (!isNew) {
        try {
          const sv = existing[0].data;
          if (sv && Array.isArray(sv.photos)) {
            const byId = {};
            sv.photos.forEach(p => { byId[p.id] = p; });
            (album.photos || []).forEach(p => {
              const o = byId[p.id];
              if (o && (o.review || o.note)) {
                p.review = o.review || '';
                p.selected = o.review === 'selected';
                if (o.note && !p.note) p.note = o.note;
              }
            });
            if (sv.selectedAt && !album.selectedAt) {
              album.selectedAt = sv.selectedAt;
              if (!album.deadline) album.deadline = sv.deadline || '';
            }
          }
        } catch (_) {}
      }

      await supa('albums?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify([{ id: album.id, data: album, updated_at: new Date().toISOString() }]),
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = (req.query || {}).id;
      if (!id) return res.status(400).json({ error: 'Thiếu id' });
      const permanent = (req.query || {}).permanent === '1';

      if (permanent) {
        // Xoá vĩnh viễn: chỉ owner
        if (!can(role, 'album', 'delete')) {
          return res.status(403).json({ error: 'Chỉ chủ studio (owner) mới được xoá vĩnh viễn' });
        }
      } else {
        // Chuyển vào thùng rác: owner hoặc editor
        if (!can(role, 'album', 'trash')) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền xoá album' });
        }
      }

      await supa(`albums?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
