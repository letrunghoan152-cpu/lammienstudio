// Helper dùng chung cho các serverless function — Supabase + xác thực nhân sự
// Làm sạch URL: bỏ khoảng trắng, dấu / cuối, hoặc /rest/v1 dán thừa
const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
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

function staffUser() { return process.env.STAFF_USER || 'lammien'; }
function staffPass() { return process.env.STAFF_PASS || 'lammien'; }

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

/* ---- Đọc danh sách nhân sự từ Google Sheet (cột: A tài khoản, B mật khẩu, C tên, D trạng thái) ---- */
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
    }))
    .filter(a => a.user && a.pass && !/^(user|t[aà]i kho[aả]n|account|username)$/i.test(a.user));
  staffCache = { at: Date.now(), list };
  return list;
}

// Trả về {user, name} nếu hợp lệ; null nếu sai
async function validUser(user, pass) {
  if (!user || !pass) return null;
  // Tài khoản chủ (env trên Vercel) luôn đăng nhập được — không bao giờ tự khoá mình
  if (user === staffUser() && pass === staffPass()) return { user, name: 'Chủ studio' };
  try {
    const list = await staffList();
    if (list) {
      const f = list.find(a => a.active && a.user === user && a.pass === pass);
      if (f) return { user: f.user, name: f.name || f.user };
    }
  } catch (_) { /* sheet lỗi -> chỉ tài khoản chủ đăng nhập được */ }
  return null;
}

async function checkAuth(req) {
  return !!(await validUser(req.headers['x-user'], req.headers['x-pass']));
}

/* ---- Gửi email thông báo cho nhân sự (qua Resend) ---- */
async function sendStudioEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return false; // chưa cấu hình -> bỏ qua
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

module.exports = { supa, configured, checkAuth, validUser, staffUser, staffPass, sendStudioEmail, getConfig, setConfig };
