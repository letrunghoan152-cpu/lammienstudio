// /api/albums — dành cho nhân sự (cần header x-user/x-pass)
// GET            -> danh sách album
// POST {album}   -> tạo / cập nhật 1 album
// DELETE ?id=    -> xoá album
const { supa, configured, checkAuth } = require('./_supa');

module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  if (!(await checkAuth(req))) return res.status(401).json({ error: 'Chưa đăng nhập' });

  try {
    if (req.method === 'GET') {
      const rows = await supa('albums?select=data&order=updated_at.desc');
      return res.status(200).json((rows || []).map(r => r.data));
    }

    if (req.method === 'POST') {
      const album = (req.body || {}).album;
      if (!album || !album.id) return res.status(400).json({ error: 'Thiếu album hoặc album.id' });
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
      await supa(`albums?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
