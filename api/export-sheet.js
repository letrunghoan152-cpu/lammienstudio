// POST /api/export-sheet — đẩy toàn bộ data album → Google Sheet (1 chiều)
// Tốc độ tối ưu: Supabase 1 query → build rows trong memory → 1 batch write duy nhất
// Env cần có: EXPORT_SHEET_ID (ID của Google Sheet nhận data)
// Auth: dùng refresh_token studio Drive (cần scope spreadsheets — xem ROADMAP Phase 3)
const { configured, checkAuth, supa, getConfig } = require('./_supa');

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Parse tên khách từ tên album "8.6 Kiều Anh 12H" → "Kiều Anh" */
function parseClientName(name) {
  let s = (name || '').trim();
  s = s.replace(/^\d{1,2}[.\/-]\d{1,2}\s+/, ''); // bỏ ngày đầu
  s = s.replace(/\s+\d{1,2}[Hh]\d{0,2}$/, '');   // bỏ giờ cuối
  return s.trim();
}

/** Parse ngày chụp từ tên album → "08/06/2026" */
function parseShootDate(name) {
  const m = (name || '').match(/(\d{1,2})[.\/-](\d{1,2})/);
  if (!m) return '';
  const year = new Date().getFullYear();
  const d = new Date(year, parseInt(m[2]) - 1, parseInt(m[1]));
  return isNaN(d) ? '' : d.toLocaleDateString('vi-VN');
}

const STATUS_VN = {
  new: 'Mới tạo', choosing: 'Đang chọn', done: 'Đã chốt',
  editing: 'Đang hậu kỳ', delivered: 'Đã giao',
};

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return isNaN(d) ? '' : d.toLocaleDateString('vi-VN');
}

function driveLink(folderId) {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : '';
}
function fileLink(fileId) {
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : '';
}

/* ── Lấy Sheets access token ─────────────────────────────────────────────── */
async function getSheetsToken() {
  const cfg = await getConfig('studio_drive');
  if (!cfg?.refresh_token) throw new Error('Studio chưa kết nối Google Drive. Kết nối Drive trước (cần reconnect với scope Sheets mới).');
  const cid = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!cid || !secret) throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id: cid, client_secret: secret,
    refresh_token: cfg.refresh_token, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tok = await r.json();
  if (!tok.access_token) throw new Error(tok.error_description || 'Không lấy được Sheets token. Hãy reconnect Drive với scope mới.');
  return tok.access_token;
}

/* ── Sheets API helpers ───────────────────────────────────────────────────── */
async function sheetsRequest(method, path, token, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Sheets API ${res.status}`);
  return data;
}

/** Đảm bảo sheet "Albums" tồn tại, trả về sheetId */
async function ensureAlbumSheet(token, spreadsheetId) {
  const meta = await sheetsRequest('GET', spreadsheetId, token);
  const sheet = (meta.sheets || []).find(s => s.properties.title === 'Albums');
  if (sheet) return sheet.properties.sheetId;
  // Tạo mới
  const res = await sheetsRequest('POST', `${spreadsheetId}:batchUpdate`, token, {
    requests: [{ addSheet: { properties: { title: 'Albums' } } }],
  });
  return res.replies[0].addSheet.properties.sheetId;
}

/** Xoá toàn bộ nội dung sheet, viết lại từ đầu */
async function writeSheet(token, spreadsheetId, sheetName, rows) {
  // Clear
  await sheetsRequest('POST', `${spreadsheetId}/values/${encodeURIComponent(sheetName)}:clear`, token, {});
  // Batch write
  await sheetsRequest('PUT',
    `${spreadsheetId}/values/${encodeURIComponent(sheetName)}?valueInputOption=USER_ENTERED`,
    token,
    { range: sheetName, majorDimension: 'ROWS', values: rows }
  );
}

/** Format header (bold, freeze, màu nền) */
async function formatHeader(token, spreadsheetId, sheetId, colCount) {
  await sheetsRequest('POST', `${spreadsheetId}:batchUpdate`, token, {
    requests: [
      // Bold header
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.13, green: 0.13, blue: 0.13 }, horizontalAlignment: 'CENTER' } },
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
        },
      },
      // Freeze row 1
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // Auto resize
      { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount } } },
    ],
  });
}

/* ── Main handler ─────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Chưa cấu hình máy chủ' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkAuth(req))) return res.status(401).json({ error: 'Chưa đăng nhập' });

  const sheetId = (process.env.EXPORT_SHEET_ID || '').trim();
  if (!sheetId) return res.status(503).json({ error: 'Chưa cấu hình EXPORT_SHEET_ID trong Vercel environment' });

  try {
    // 1. Lấy TẤT CẢ albums từ Supabase — 1 query duy nhất
    const rows = await supa('albums?select=data,updated_at&order=updated_at.desc');
    const albums = (rows || []).map(r => ({ ...r.data, _updatedAt: r.updated_at }));

    // 2. Lấy Sheets token
    const token = await getSheetsToken();

    // 3. Đảm bảo tab "Albums" tồn tại
    const albumSheetId = await ensureAlbumSheet(token, sheetId);

    // 4. Build header
    const HEADERS = [
      'STT', 'Tên Album', 'Tên Khách', 'SĐT',
      'Ngày Chụp', 'Trạng Thái',
      'Tổng Ảnh', 'Đã Chọn', 'Hạn Trả (ngày)',
      'Ngày Chốt', 'Deadline',
      'Ghi Chú Nội Bộ',
      'Link Folder Drive', 'Link Ảnh Bìa',
      'Gallery / Album con',
      'Ngày Tạo', 'Cập Nhật Lần Cuối',
    ];

    // 5. Build data rows — 1 row/album, xử lý trong memory
    const dataRows = albums
      .filter(a => !a.trashed)
      .map((a, i) => {
        const photos = a.photos || [];
        const selected = photos.filter(p => p.review === 'selected' || p.selected).length;
        const galleries = (a.galleries || []).map(g => g.name).join(', ');

        return [
          i + 1,
          a.name || '',
          a.client || parseClientName(a.name || ''),
          a.lockPhone || '',
          parseShootDate(a.name || ''),
          STATUS_VN[a.status] || a.status || 'Mới tạo',
          photos.length,
          selected,
          a.deadlineDays != null ? a.deadlineDays : '',
          fmtDate(a.selectedAt),
          a.deadline || '',
          a.internalNotes || '',
          driveLink(a.folderId),
          fileLink(a.cover),
          galleries,
          fmtDate(a.createdAt),
          a._updatedAt ? new Date(a._updatedAt).toLocaleDateString('vi-VN') : fmtDate(a.lastActivity),
        ];
      });

    // 6. Ghi tất cả bằng 1 request duy nhất (clear + write)
    await writeSheet(token, sheetId, 'Albums', [HEADERS, ...dataRows]);

    // 7. Format header (bold, freeze) — async, không block response
    formatHeader(token, sheetId, albumSheetId, HEADERS.length).catch(() => {});

    return res.status(200).json({
      ok: true,
      exported: dataRows.length,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    });
  } catch (e) {
    console.error('[export-sheet]', e.message);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
