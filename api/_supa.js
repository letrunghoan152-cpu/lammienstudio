// Helper dùng chung cho các serverless function — Supabase + xác thực nhân sự
// Làm sạch URL: bỏ khoảng trắng, dấu / cuối, hoặc /rest/v1 dán thừa
const crypto = require('crypto');
const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

/* ---- Cổng SĐT (phone gate) — token HMAC không trạng thái ----
   Sau khi khách nhập đúng SĐT, server cấp token = HMAC(albumId:SĐT, KEY).
   Token này bắt buộc khi GET ảnh / POST lựa chọn với album bị khoá, nên không
   thể bypass gate bằng cách gọi API trực tiếp. */
function gateToken(id, phoneDigits) {
  return crypto.createHmac('sha256', KEY).update(id + ':' + phoneDigits).digest('hex').slice(0, 32);
}
function gateValid(id, data, token) {
  if (!data || !data.lockPhone) return true; // album không khoá -> luôn hợp lệ
  if (!token) return false;
  const expected = gateToken(id, (data.lockPhone || '').replace(/\D/g, ''));
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SHEET_ID = process.env.STAFF_SHEET_ID; // Google Sheet quản lý tài khoản nhân sự

function configured() { return !!(BASE && KEY); }

async function supa(path, opts = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DB ${res.status}: ${t.slice(0, 200)}`);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* ---- Cập nhật album an toàn với optimistic locking ----
   Dùng counter `_rev` lưu ngay trong JSON `data` (không cần migrate cột DB).
   mutate(existingData|null) -> newData (hoặc null để huỷ).
   Mỗi lần ghi được điều kiện theo _rev cũ (compare-and-swap); nếu có request
   khác chen vào (0 dòng khớp) thì đọc lại & thử lại. Sau khi hết lượt thử vẫn
   ghi đè an toàn (last-write-wins) để KHÔNG bao giờ chặn việc lưu của studio/khách. */
async function casUpdateAlbum(id, mutate, { maxRetries = 4 } = {}) {
  const path = `albums?id=eq.${encodeURIComponent(id)}`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const rows = await supa(`${path}&select=data`);
    const existing = rows && rows[0] ? rows[0].data : null;
    const oldRev = existing && typeof existing._rev === 'number' ? existing._rev : null;

    const next = mutate(existing ? { ...existing } : null);
    if (!next) return { ok: false, reason: 'cancelled' };
    next._rev = (oldRev || 0) + 1;

    if (existing == null) {
      // Album chưa có trên server -> INSERT. Nếu bị tạo bởi request khác (race)
      // thì supa() ném lỗi unique -> vòng sau sẽ thành UPDATE.
      try {
        await supa('albums', {
          method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify([{ id, data: next, updated_at: new Date().toISOString() }]),
        });
        return { ok: true, data: next };
      } catch (_) { continue; }
    }

    // UPDATE có điều kiện theo _rev cũ (CAS). Bản ghi cũ chưa có _rev -> lọc is.null.
    const revFilter = oldRev == null ? 'data->>_rev=is.null' : `data->>_rev=eq.${oldRev}`;
    try {
      const updated = await supa(`${path}&${revFilter}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: JSON.stringify({ data: next, updated_at: new Date().toISOString() }),
      });
      if (updated && updated.length) return { ok: true, data: next };
      // 0 dòng khớp -> ai đó vừa ghi xen -> đọc lại & thử lại
    } catch (e) {
      // Nếu bộ lọc JSONB không được hỗ trợ (lỗi PostgREST) -> bỏ CAS, dùng
      // fallback ghi đè an toàn bên dưới để KHÔNG bao giờ chặn việc lưu.
      console.warn('[LMS] casUpdateAlbum CAS filter failed, falling back:', e.message || e);
      break;
    }
  }

  // Fallback: hết lượt thử -> ghi đè không điều kiện để không mất thao tác lưu.
  const rows = await supa(`${path}&select=data`);
  const existing = rows && rows[0] ? rows[0].data : null;
  const next = mutate(existing ? { ...existing } : null);
  if (!next) return { ok: false, reason: 'cancelled' };
  next._rev = ((existing && existing._rev) || 0) + 1;
  await supa('albums?on_conflict=id', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify([{ id, data: next, updated_at: new Date().toISOString() }]),
  });
  return { ok: true, data: next, fellBack: true };
}

/* ---- Cấu hình dùng chung (bảng app_config: key text PK, value jsonb) ---- */
async function getConfig(key) {
  const rows = await supa(`app_config?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows[0] ? rows[0].value : null;
}
async function setConfig(key, value) {
  await supa('app_config?on_conflict=key', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
}

/* ---- Đọc danh sách nhân sự từ Google Sheet ----
   Cột: A=username, B=password, C=tên, D=trạng thái, E=role (owner/staff)
*/
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

let staffCache = { at: 0, list: null };
async function staffList() {
  if (!SHEET_ID) return null;
  if (staffCache.list && Date.now() - staffCache.at < 60000) return staffCache.list; // cache 60s
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`);
  if (!res.ok) throw new Error('Không đọc được sheet tài khoản (' + res.status + ')');
  const rows = parseCsv(await res.text());
  const list = rows
    .map(r => ({
      user: (r[0] || '').trim(),
      pass: (r[1] || '').trim(),
      name: (r[2] || '').trim(),
      active: !/^(off|kh[oó]a|0|no|x)$/i.test((r[3] || '').trim()),
      // Cột E: role — 'owner' hoặc 'staff' (mặc định 'staff')
      role: /^owner$/i.test((r[4] || '').trim()) ? 'owner' : /^editor$/i.test((r[4] || '').trim()) ? 'editor' : /^viewer$/i.test((r[4] || '').trim()) ? 'viewer' : 'editor',
    }))
    .filter(a => a.user && a.pass && !/^(user|t[aà]i kho[aả]n|account|username)$/i.test(a.user));
  staffCache = { at: Date.now(), list };
  return list;
}

// Trả về {user, name, role} nếu hợp lệ; null nếu sai
async function validUser(user, pass) {
  if (!user || !pass) return null;
  try {
    const list = await staffList();
    if (list) {
      const f = list.find(a => a.active && a.user === user && a.pass === pass);
      if (f) return { user: f.user, name: f.name || f.user, role: f.role || 'editor' };
    }
  } catch (_) { /* sheet lỗi -> không ai đăng nhập được (an toàn) */ }
  return null;
}

/* ---- Session token (bảng sessions trong Supabase) ---- */
async function resolveToken(token) {
  if (!token) return null;
  try {
    const rows = await supa(`sessions?token=eq.${encodeURIComponent(token)}&select=user_id,user_name,role,expires_at`);
    if (!rows || !rows[0]) return null;
    if (new Date(rows[0].expires_at) < new Date()) return null; // hết hạn
    return { user: rows[0].user_id, name: rows[0].user_name, role: rows[0].role || 'editor' };
  } catch (_) { return null; }
}

// checkAuth: trả bool (backward compat)
async function checkAuth(req) {
  return !!(await checkAuthFull(req));
}

// checkAuthFull: trả {user, name, role} hoặc null — dùng khi cần kiểm tra role
async function checkAuthFull(req) {
  // Ưu tiên token mới (x-token header)
  const token = req.headers['x-token'];
  if (token) return resolveToken(token);
  // Backward compat: x-user/x-pass (sẽ bỏ dần sau khi tất cả client chuyển sang token)
  return validUser(req.headers['x-user'], req.headers['x-pass']);
}

/* ---- Gửi email thông báo cho nhân sự (qua Resend) ---- */
async function sendStudioEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return false;
  const from = process.env.FROM_EMAIL || 'Lam Mien Studio <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: to.split(',').map(s => s.trim()).filter(Boolean), subject, html }),
    });
    return res.ok;
  } catch (_) { return false; }
}

/* ─── Bảng phân quyền theo role ──────────────────────────────────────────────
   Roles: owner (chủ studio) | editor (nhân sự chính) | viewer (nhân sự phụ)
   ─────────────────────────────────────────────────────────────────────────── */
const PERMISSIONS = {
  owner: {
    album:    { create: true,  edit: true,  trash: true,  delete: true,  viewAll: true  },
    gallery:  { create: true,  edit: true,  delete: true                                },
    drive:    { connect: true, upload: true                                              },
    progress: { view: true                                                               },
    trash:    { view: true,    empty: true                                               },
    settings: { view: true,    manage: true                                              },
  },
  editor: {
    album:    { create: true,  edit: true,  trash: true,  delete: false, viewAll: true  },
    gallery:  { create: true,  edit: true,  delete: true                                },
    drive:    { connect: false, upload: true                                             },
    progress: { view: true                                                               },
    trash:    { view: true,    empty: false                                              },
    settings: { view: false,   manage: false                                            },
  },
  viewer: {
    album:    { create: false, edit: false, trash: false, delete: false, viewAll: true  },
    gallery:  { create: false, edit: false, delete: false                               },
    drive:    { connect: false, upload: true                                             },
    progress: { view: false                                                              },
    trash:    { view: false,   empty: false                                              },
    settings: { view: false,   manage: false                                            },
  },
};

/** Kiểm tra quyền: can('editor', 'album', 'create') → true/false */
function can(role, resource, action) {
  // Map unknown/legacy roles (e.g. 'staff') to 'editor'
  const r = Object.prototype.hasOwnProperty.call(PERMISSIONS, role) ? role : (role ? 'editor' : 'viewer');
  return !!(PERMISSIONS[r]?.[resource]?.[action]);
}

module.exports = { supa, configured, checkAuth, checkAuthFull, validUser, sendStudioEmail, getConfig, setConfig, resolveToken, PERMISSIONS, can, casUpdateAlbum, gateToken, gateValid };
