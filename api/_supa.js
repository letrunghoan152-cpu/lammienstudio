// Helper dùng chung cho các serverless function — kết nối Supabase REST
const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

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

function checkAuth(req) {
  return req.headers['x-user'] === staffUser() && req.headers['x-pass'] === staffPass();
}

module.exports = { supa, configured, checkAuth, staffUser, staffPass };
