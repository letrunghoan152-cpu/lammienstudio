/* =============================================================================
   Lam Miên Studio — App v2.0 (Rebuild hoàn toàn)
   Stack: Vanilla JS SPA + Vercel Serverless + Supabase + Google Drive
   Kiến trúc: Centralized AppState, module sections, zero duplicate listeners
   ============================================================================= */

'use strict';

/* ─────────────────────────────────────────────
   1. GLOBAL ERROR BOUNDARY
   ───────────────────────────────────────────── */
window.onerror = (msg, src, line, col, err) => {
  console.error('[LMS] Uncaught error:', msg, src, line, col, err);
};
window.addEventListener('unhandledrejection', e => {
  console.error('[LMS] Unhandled promise rejection:', e.reason);
});

/* ─────────────────────────────────────────────
   2. CENTRALISED STATE
   ───────────────────────────────────────────── */
const S = {
  // Auth
  auth: null,         // { token, name, role } or null
  // Albums
  albums: [],         // master array (active, not trashed)
  trashedAlbums: [],  // trashed
  // Current view
  page: 'albums',     // 'albums' | 'progress' | 'trash' | 'albumdetail'
  filterStatus: null, // null = all
  albumsView: 'grid', // 'grid' | 'list' | 'kanban' | 'masonry'
  albumSort: 'date',  // 'date' | 'name' | 'deadline' | 'photos'
  progView: 'list',
  // Detail
  detailId: null,
  detailSetIdx: 0,
  detailSortAsc: true,
  detailView: 'grid',
  detailPickMode: false,
  detailPicked: new Set(),
  // Upload
  activeUploads: new Set(),    // album IDs currently uploading
  driveToken: null,            // { token, exp }
  // Client picker
  clientAlbum: null,
  clientReview: {},            // { photoId: {r, n} }
  clientPage: 1,
  clientPageSize: 40,
  clientFilter: 'all',
  clientSortAsc: true,
  clientView: 'masonry',
  clientGalleryId: null,  // currently selected gallery in client view
  // Lightbox
  lbPhotos: [],
  lbIdx: 0,
  lbContext: 'client',         // 'client' | 'detail'
  // UI
  theme: 'light',
};

/* ─────────────────────────────────────────────
   3. CONSTANTS
   ───────────────────────────────────────────── */
const STORAGE_KEY    = 'lamMienApiAuth';
const ALBUMS_KEY     = 'lamMienAlbums';
const THEME_KEY      = 'lamMienTheme';
const SESSION_KEY    = 'lmActiveUploads';
const UPLOAD_STUCK_MS = 600_000; // 10 min before clearing stuck flag
const SYNC_INTERVAL   = 30_000;  // 30s auto-refresh

/* ─── Bảng phân quyền (mirror of _supa.js PERMISSIONS) ──────────────────── */
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

/** Kiểm tra quyền của user hiện tại */
function can(resource, action) {
  const rawRole = S.auth?.role || 'viewer';
  // Map unknown/legacy roles (e.g. 'staff') to 'editor' as safe default
  const role = Object.prototype.hasOwnProperty.call(PERMISSIONS, rawRole) ? rawRole : 'editor';
  return !!(PERMISSIONS[role]?.[resource]?.[action]);
}

/** Tên hiện thị của role */
const ROLE_LABELS = { owner: 'Chủ studio', editor: 'Nhân sự chính', viewer: 'Nhân sự phụ' };
function roleLabel(role) { return ROLE_LABELS[role] || role || 'Nhân sự'; }

/* ─────────────────────────────────────────────
   4. UTILITY FUNCTIONS
   ───────────────────────────────────────────── */

/** lh3 CDN URL for a Drive file — preferred, no rate limit */
function lh3(id, size = 's1600') {
  if (!id) return '';
  return `https://lh3.googleusercontent.com/d/${id}=${size}`;
}

/** Canonical Drive file id for a photo. `driveId` is always the real id;
    legacy data stores a placeholder in `id` (e.g. "d0", or "a"+driveId),
    while newer uploads put the real id directly in `id`. So prefer driveId. */
function photoDriveId(p) { return (p && (p.driveId || p.id)) || ''; }

/** lh3 thumbnail URL for a photo object (handles legacy placeholder ids). */
function photoUrl(p, size = 's1600') { return lh3(photoDriveId(p), size); }

/** Toast notification */
let _toastTimer = null;
function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/** Open/close a modal */
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

/** Format date string */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Debounce */
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Safe localStorage read */
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
/** Safe localStorage write with overflow handling */
function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    // quota exceeded — try compacting albums (strip heavy fields)
    if (key === ALBUMS_KEY) {
      try {
        const compact = (val || []).map(a => {
          const c = { ...a };
          if (c.photos && c.photos.length > 500) c.photos = c.photos.slice(0, 500);
          return c;
        });
        localStorage.setItem(key, JSON.stringify(compact));
      } catch { /* give up silently */ }
    }
  }
}

/** Parse shooting date from album name e.g. "8.6 Kiều Anh 12H" → Date */
function parseShootDate(name) {
  const m = (name || '').match(/(\d{1,2})[./](\d{1,2})/);
  if (!m) return null;
  const y = new Date().getFullYear();
  return new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
}

/** Format deadline countdown */
function deadlineBadge(dl) {
  if (!dl) return null;
  const diff = Math.ceil((new Date(dl) - Date.now()) / 86400000);
  if (diff < 0) return { text: `Trễ ${-diff} ngày`, cls: 'dl-over' };
  if (diff === 0) return { text: 'Hôm nay!', cls: 'dl-today' };
  if (diff <= 3) return { text: `Còn ${diff} ngày`, cls: 'dl-soon' };
  return { text: `Còn ${diff} ngày`, cls: '' };
}

/** Generate unique ID */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/** Extract Drive folder ID from URL */
function parseDriveFolderId(url) {
  const m = (url || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (url || '').trim();
}

/* ─────────────────────────────────────────────
   5. AUTH MODULE
   ───────────────────────────────────────────── */

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (S.auth?.token) {
    h['x-token'] = S.auth.token;
  } else if (S.auth?.u) {
    // legacy fallback (should not reach here after rebuild)
    h['x-user'] = S.auth.u;
    h['x-pass'] = S.auth.p;
  }
  return h;
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...apiHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    // Token expired/invalid — logout
    await doLogout(false);
    return null;
  }
  return res;
}

async function verifySessionAndStart() {
  const saved = lsGet(STORAGE_KEY);
  if (!saved?.token) { showLogin(); return; }

  try {
    const res = await fetch('/api/session', { headers: { 'x-token': saved.token } });
    if (!res.ok) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { showLogin(); return; }
    S.auth = { token: saved.token, name: data.name || saved.name, role: data.role || saved.role || 'editor' };
    showApp();
  } catch {
    // Network error — allow offline access if we have local albums
    const local = lsGet(ALBUMS_KEY);
    if (saved.token && local) {
      S.auth = { token: saved.token, name: saved.name || '?', role: saved.role || 'editor' };
      showApp();
    } else {
      showLogin();
    }
  }
}

async function doLogin(user, pass) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Đăng nhập thất bại');
  // data: { ok, token, name, role, sync }
  const auth = { token: data.token || null, name: data.name || user, role: data.role || 'editor' };
  S.auth = auth;
  lsSet(STORAGE_KEY, auth);
  return data;
}

async function doLogout(callServer = true) {
  if (callServer && S.auth?.token) {
    fetch('/api/session', { method: 'DELETE', headers: { 'x-token': S.auth.token } }).catch(() => {});
  }
  S.auth = null;
  localStorage.removeItem(STORAGE_KEY);
  SyncManager.stop();
  showLogin();
}

/* ─────────────────────────────────────────────
   6. API MODULE
   ───────────────────────────────────────────── */

async function apiGetAlbums() {
  const res = await apiFetch('/api/albums');
  if (!res || !res.ok) return null;
  return res.json();
}

async function apiPushAlbum(album) {
  await apiFetch('/api/albums', {
    method: 'POST',
    body: JSON.stringify(album),
  });
}

async function apiDeleteAlbum(id, permanent = false) {
  const url = `/api/albums?id=${encodeURIComponent(id)}${permanent ? '&permanent=1' : ''}`;
  const res = await apiFetch(url, { method: 'DELETE' });
  return res && res.ok;
}

/** Get album for guest (no auth) — with optional studio auth in detail context */
async function apiGetAlbum(id, studioContext = false) {
  const opts = studioContext ? { headers: apiHeaders() } : {};
  const res = await fetch(`/api/album?id=${encodeURIComponent(id)}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
  return res.json();
}

/** Guest save selection with 3-attempt retry */
const GuestSaveManager = {
  _pending: null,
  _saving: false,
  _timer: null,

  schedule(albumId, review, status) {
    this._pending = { albumId, review, status };
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 800);
  },

  async _flush() {
    if (this._saving || !this._pending) return;
    this._saving = true;
    const job = this._pending;
    this._pending = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/album?id=${encodeURIComponent(job.albumId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ review: job.review, status: job.status }),
        });
        if (res.ok) {
          // success
          this._saving = false;
          if (this._pending) this._timer = setTimeout(() => this._flush(), 400);
          return;
        }
        const err = await res.json().catch(() => ({}));
        if (res.status === 400) { // maxCount exceeded — non-retryable
          toast('⚠ ' + (err.error || 'Lưu thất bại'));
          this._saving = false;
          return;
        }
      } catch { /* network error — retry */ }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    toast('⚠ Không thể lưu lựa chọn. Kiểm tra mạng và thử lại.');
    this._saving = false;
    if (this._pending) this._timer = setTimeout(() => this._flush(), 1000);
  },
};

/* ─────────────────────────────────────────────
   7. LOCAL ALBUM STORE
   ───────────────────────────────────────────── */

function saveAlbumsLocal() {
  lsSet(ALBUMS_KEY, [...S.albums, ...S.trashedAlbums]);
}

function loadAlbumsLocal() {
  const all = lsGet(ALBUMS_KEY) || [];
  S.albums = all.filter(a => !a.trashed);
  S.trashedAlbums = all.filter(a => a.trashed);
}

/** Persist active upload IDs in sessionStorage (survive F5 within tab session) */
function persistActiveUpload(id) {
  S.activeUploads.add(id);
  try {
    const arr = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]');
    arr.push(id);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...new Set(arr)]));
  } catch {}
}
function removeActiveUpload(id) {
  S.activeUploads.delete(id);
  try {
    const arr = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]');
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(arr.filter(x => x !== id)));
  } catch {}
}
function restoreActiveUploads() {
  try {
    JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]').forEach(id => S.activeUploads.add(id));
  } catch {}
}

/* ─────────────────────────────────────────────
   8. SYNC MODULE  (with _refreshing guard)
   ───────────────────────────────────────────── */
const SyncManager = {
  _timer: null,
  _refreshing: false,

  start() { this._timer = setInterval(() => this.refresh(), SYNC_INTERVAL); },
  stop()  { clearInterval(this._timer); this._timer = null; },

  async refresh() {
    if (this._refreshing || !S.auth) return;
    this._refreshing = true;
    try {
      const serverList = await apiGetAlbums();
      if (!serverList) return;

      const merged = serverList.map(sv => {
        const lo = S.albums.find(a => a.id === sv.id) ||
                   S.trashedAlbums.find(a => a.id === sv.id);
        // Clear stuck uploading flag (10 min timeout)
        if (sv.uploading && !S.activeUploads.has(sv.id) &&
            Date.now() - (sv.lastActivity || 0) > UPLOAD_STUCK_MS) {
          sv.uploading = false;
        }
        // Use server timestamp for merge arbitration
        if (lo && (lo.lastActivity || 0) > (sv._serverUpdatedAt || 0)) {
          apiPushAlbum(lo).catch(() => {});
          return lo;
        }
        return sv;
      });

      // Preserve any local-only albums (not yet pushed)
      S.albums.forEach(lo => {
        if (!merged.find(m => m.id === lo.id)) merged.push(lo);
      });

      S.albums = merged.filter(a => !a.trashed);
      S.trashedAlbums = merged.filter(a => a.trashed);
      saveAlbumsLocal();
      renderCurrentPage();
    } finally {
      this._refreshing = false;
    }
  },

  async forcePush(album) {
    await apiPushAlbum(album);
  },
};

/* ─────────────────────────────────────────────
   9. DRIVE MODULE
   ───────────────────────────────────────────── */

async function getDriveToken() {
  if (S.driveToken && Date.now() < S.driveToken.exp - 60000) {
    return S.driveToken.token;
  }
  const res = await apiFetch('/api/drive-token');
  if (!res || !res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  S.driveToken = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return S.driveToken.token;
}

async function listDriveFolder(folderId) {
  const res = await apiFetch(`/api/drive-list?folderId=${encodeURIComponent(folderId)}`);
  if (!res) throw new Error('Không kết nối được server');
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Lỗi ${res.status}`);
  }
  const data = await res.json();
  return data.files || [];
}

/** Build photo list from a Drive folder URL/ID */
async function buildDrivePhotos(folderText) {
  const lines = folderText.split('\n').map(l => l.trim()).filter(Boolean);
  const photos = [];
  for (const line of lines) {
    const fid = parseDriveFolderId(line);
    if (!fid) continue;
    try {
      const files = await listDriveFolder(fid);
      files.forEach(f => {
        if (!f.id) return;
        photos.push({
          id: f.id,
          name: f.name || f.id,
          url: lh3(f.id),
          w: f.imageMediaMetadata?.width || 0,
          h: f.imageMediaMetadata?.height || 0,
        });
      });
    } catch (e) {
      toast('⚠ ' + (e.message || 'Không đọc được folder Drive'));
    }
  }
  return photos;
}

/** Find or create a Drive folder by name under a parent */
async function driveFindOrCreateFolder(name, parentId, token) {
  // Search existing
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (searchRes.ok) {
    const d = await searchRes.json();
    if (d.files && d.files[0]) return d.files[0].id;
  }
  // Create
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error(created.error?.message || 'Tạo folder thất bại');
  return created.id;
}

/** Create structured folder: Lam Miên Studio/YYYY/MM - Tháng X/Album Name */
async function driveCreateAlbumFolder(albumName, token) {
  // Get/create root
  const rootQ = `name='Lam Miên Studio' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const rootRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(rootQ)}&fields=files(id)&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  let rootId;
  if (rootRes.ok) {
    const d = await rootRes.json();
    rootId = d.files?.[0]?.id;
  }
  if (!rootId) {
    const cr = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lam Miên Studio', mimeType: 'application/vnd.google-apps.folder' }),
    });
    const d = await cr.json();
    rootId = d.id;
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const month = now.toLocaleString('vi-VN', { month: 'long' });
  const monthName = `${mm} - Tháng ${now.getMonth() + 1}`;

  const yearId  = await driveFindOrCreateFolder(yyyy, rootId, token);
  const monthId = await driveFindOrCreateFolder(monthName, yearId, token);
  const albumId = await driveFindOrCreateFolder(albumName, monthId, token);
  return albumId;
}

/** Upload one file to Drive with resumable upload */
// Chunk size for resumable upload — MUST be a multiple of 256KB (Drive requirement).
// 8MB balances # of round-trips vs. wasted bytes when a chunk fails and resumes.
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_MAX_RETRY = 5;          // per-chunk retries before giving up the whole file
const CHUNK_RETRY_CAP_MS = 15000;   // max backoff between chunk retries

/** Step 1 — open a resumable session, return the session URL (valid ~1 week, no auth needed for data PUTs). */
async function driveInitResumable(file, folderId, token) {
  const meta = { name: file.name, parents: [folderId] };
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': file.type || 'image/jpeg',
        'X-Upload-Content-Length': file.size,
      },
      body: JSON.stringify(meta),
    }
  );
  if (!initRes.ok) throw new Error('Không khởi tạo upload: ' + initRes.status);
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Không nhận được upload URL');
  return uploadUrl;
}

/** PUT one chunk via XHR (so we get real upload progress). Resolves { status, range, body }. */
function drivePutChunk(uploadUrl, blob, start, total, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    const end = start + blob.size - 1;
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    if (contentType) xhr.setRequestHeader('X-Upload-Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(start + e.loaded);
    };
    xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader('Range'), body: xhr.responseText });
    xhr.onerror = () => reject(new Error('Lỗi mạng khi tải chunk'));
    xhr.ontimeout = () => reject(new Error('Hết thời gian chờ khi tải chunk'));
    // NOTE: deliberately no Authorization — the resumable session URL is pre-authorized,
    // which means a long upload can't fail just because the access token expired mid-way.
    xhr.send(blob);
  });
}

/** Ask Drive how many bytes it already has, so we can resume instead of restarting. */
function driveQueryResume(uploadUrl, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Range', `bytes */${total}`);
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ done: true, body: xhr.responseText });
      } else if (xhr.status === 308) {
        const range = xhr.getResponseHeader('Range'); // e.g. "bytes=0-262143"
        const next = range ? parseInt(range.split('-')[1], 10) + 1 : 0;
        resolve({ done: false, next });
      } else {
        reject(new Error('Không truy vấn được trạng thái upload: ' + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Lỗi mạng khi truy vấn upload'));
    xhr.send();
  });
}

/**
 * Upload one file via a TRUE resumable, chunked transfer.
 *  - file.slice() per chunk → never holds the whole file in RAM (was file.arrayBuffer()).
 *  - On any chunk failure it queries the session for the last received byte and resumes
 *    from there instead of restarting from 0.
 *  - Verifies the final size matches before declaring success.
 * onProgress(bytesUploaded, totalBytes) is called continuously for live progress.
 */
async function driveUploadFile(file, folderId, token, onProgress) {
  const total = file.size;
  const contentType = file.type || 'image/jpeg';
  const uploadUrl = await driveInitResumable(file, folderId, token);

  let start = 0;
  let resultBody = null;

  while (start < total) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, total);
    const blob = file.slice(start, end);
    let attempt = 0;
    // Retry this chunk until it sticks (or we exhaust retries).
    for (;;) {
      try {
        const r = await drivePutChunk(uploadUrl, blob, start, total, contentType,
          (uploaded) => onProgress && onProgress(uploaded, total));
        if (r.status === 200 || r.status === 201) {
          resultBody = r.body; start = total; break;          // whole file accepted
        }
        if (r.status === 308) {
          start = r.range ? parseInt(r.range.split('-')[1], 10) + 1 : end;
          break;                                              // chunk accepted, continue
        }
        throw new Error('Chunk PUT lỗi: ' + r.status);        // 4xx/5xx → retry/resume
      } catch (err) {
        attempt++;
        if (attempt >= CHUNK_MAX_RETRY) throw err;
        await new Promise(res => setTimeout(res, Math.min(1000 * Math.pow(2, attempt), CHUNK_RETRY_CAP_MS)));
        // Resume: find out exactly where the server left off, then retry from there.
        try {
          const q = await driveQueryResume(uploadUrl, total);
          if (q.done) { resultBody = q.body; start = total; break; }
          start = q.next;
          break; // re-slice from the resumed offset on the next while-iteration
        } catch (_) { /* query failed too — loop and retry the same chunk */ }
      }
    }
  }

  const result = resultBody ? JSON.parse(resultBody) : {};
  if (onProgress) onProgress(total, total);
  // Integrity check — a truncated upload that Drive somehow accepted must not pass silently.
  if (result.size != null && Number(result.size) !== total) {
    throw new Error(`Kích thước không khớp (${result.size}/${total})`);
  }
  return { id: result.id, name: result.name || file.name };
}

/** Upload one file — outer retry covers session-init failures; chunk-level retry/resume lives inside driveUploadFile. */
async function driveUploadFileWithRetry(file, folderId, token, onProgress, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await driveUploadFile(file, folderId, token, onProgress);
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(3, attempt)));
    }
  }
}

/* ─────────────────────────────────────────────
   UPLOAD MANAGER — concurrent multi-album, multi-user
   Max 6 file uploads simultaneously (2-3 albums × 2-3 workers each)
   BroadcastChannel for real-time tab-to-tab sync
   ───────────────────────────────────────────── */
const UploadManager = {
  MAX_GLOBAL: 6,        // max concurrent file uploads across all albums
  _running: 0,
  _queue: [],           // [{ albumId, galleryId, galleryName, folderId, file, resolve, reject }]
  _sessions: new Map(), // albumId → { albumId, albumName, galleries: { galleryId → {done,total,failed,name} } }
  _bc: null,
  _tokenMutex: false,
  _savePendingTimer: null,
  _liveBytes: new Map(),   // taskKey → bytes uploaded for an in-flight file (smooth progress)
  _renderTimer: null,      // throttle progress re-renders
  _speed: new Map(),       // albumId → { t, bytes, bps } rolling speed sample for ETA

  /** Throttled dashboard re-render — 600ms during upload to prevent flicker. */
  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      renderUploadDashboard();
    }, 600);
  },

  /** Use _scheduleRender for non-completion renders to prevent flicker. */
  _refreshDashboard() { this._scheduleRender(); },

  init() {
    try {
      this._bc = new BroadcastChannel('lm-uploads');
      this._bc.onmessage = e => {
        if (e.data?.type === 'progress') {
          // Another tab sent progress — merge into local display
          this._mergeRemoteSessions(e.data.sessions);
          this._scheduleRender();
        }
      };
    } catch (_) {}
    // Restore session counts from sessionStorage
    try {
      const saved = JSON.parse(sessionStorage.getItem('lmUploadSessions') || 'null');
      if (saved) saved.forEach(s => this._sessions.set(s.albumId, s));
    } catch (_) {}
    renderUploadDashboard();
  },

  /** Enqueue files for a gallery in an album */
  async enqueue(albumId, albumName, galleryId, galleryName, folderId, files) {
    if (!files.length) return;

    // Ensure folderId
    if (!folderId) {
      folderId = await this._ensureAlbumFolder(albumId, albumName, galleryId, galleryName);
      if (!folderId) return;
    }

    // Create/update session
    if (!this._sessions.has(albumId)) {
      this._sessions.set(albumId, { albumId, albumName, galleries: {}, startedAt: Date.now() });
    }
    const session = this._sessions.get(albumId);
    if (!session.galleries[galleryId]) {
      session.galleries[galleryId] = { name: galleryName, done: 0, total: 0, failed: [], bytesDone: 0, bytesTotal: 0 };
    }
    session.galleries[galleryId].total += files.length;
    session.galleries[galleryId].bytesTotal += files.reduce((n, f) => n + (f.size || 0), 0);

    // Mark album as uploading
    persistActiveUpload(albumId);
    const album = S.albums.find(a => a.id === albumId);
    if (album) {
      album.uploading = true;
      album.lastActivity = Date.now();
      if (!album.photoStaff && S.auth?.name) album.photoStaff = S.auth.name; // attribute uploader
    }
    saveAlbumsLocal();
    renderAlbumsList();

    // Enqueue individual files
    files.forEach(file => {
      this._queue.push({ albumId, albumName, galleryId, galleryName, folderId, file });
    });

    this._broadcastProgress();
    this._pump();
  },

  async _ensureAlbumFolder(albumId, albumName, galleryId, galleryName) {
    try {
      const token = await this._getToken();
      if (!token) { toast('⚠ Chưa kết nối Google Drive'); return null; }
      const album = S.albums.find(a => a.id === albumId);
      // Get or create album root folder
      let rootId = album?.folderId;
      if (!rootId) {
        rootId = await driveCreateAlbumFolder(albumName, token);
        if (album) { album.folderId = rootId; saveAlbumsLocal(); }
      }
      // Get or create gallery sub-folder (if it's not the default gallery)
      if (galleryId === '__default__') return rootId;
      const gallery = (album?.galleries || []).find(g => g.id === galleryId);
      if (gallery?.folderId) return gallery.folderId;
      const subFolderId = await driveFindOrCreateFolder(galleryName, rootId, token);
      if (album && gallery) { gallery.folderId = subFolderId; saveAlbumsLocal(); }
      return subFolderId;
    } catch (e) {
      toast('⚠ ' + e.message);
      return null;
    }
  },

  _pump() {
    while (this._running < this.MAX_GLOBAL && this._queue.length) {
      const task = this._queue.shift();
      this._running++;
      this._uploadOne(task).finally(() => {
        this._running--;
        this._pump();
        // Check if all done for this album
        this._checkAlbumComplete(task.albumId);
      });
    }
  },

  async _uploadOne(task) {
    const { albumId, galleryId, folderId, file } = task;
    const session = this._sessions.get(albumId);
    const gallerySession = session?.galleries?.[galleryId];
    const taskKey = `${albumId}|${galleryId}|${file.name}|${file.size}|${file.lastModified || 0}`;
    try {
      const token = await this._getToken();
      if (!token) throw new Error('No Drive token');
      const result = await driveUploadFileWithRetry(file, folderId, token, (uploaded) => {
        // Live byte progress for the currently-uploading file.
        this._liveBytes.set(taskKey, uploaded);
        this._scheduleRender();
      });
      // Add photo to album in state
      this._onPhotoUploaded(albumId, galleryId, result);
      if (gallerySession) { gallerySession.done++; gallerySession.bytesDone += (file.size || 0); }
    } catch (err) {
      console.warn('[LMS] Upload failed:', file.name, err.message);
      if (gallerySession) {
        gallerySession.done++;
        gallerySession.bytesDone += (file.size || 0); // count toward progress so the bar can complete
        gallerySession.failed.push(file.name);
      }
    } finally {
      this._liveBytes.delete(taskKey);
    }
    this._broadcastProgress();
    this._scheduleRender();
    // Debounced server push
    clearTimeout(this._savePendingTimer);
    this._savePendingTimer = setTimeout(() => {
      const album = S.albums.find(a => a.id === albumId);
      if (album) apiPushAlbum(album).catch(() => {});
    }, 3000);
  },

  _onPhotoUploaded(albumId, galleryId, result) {
    const album = S.albums.find(a => a.id === albumId);
    if (!album) return;
    album.photos = album.photos || [];
    album.photos.push({
      id: result.id,
      driveId: result.id,
      name: result.name || result.id,
      url: lh3(result.id),
      galleryId: galleryId === '__default__' ? null : galleryId,
    });
    // Use the first uploaded photo as cover automatically.
    if (!album.cover && album.photos.length === 1) {
      album.cover = result.id;
    }
    album.lastActivity = Date.now();
    saveAlbumsLocal();
    if (S.detailId === albumId) renderDetailGrid();
    renderAlbumsList();
  },

  _checkAlbumComplete(albumId) {
    // Is any queue item still pending for this album?
    const stillPending = this._queue.some(t => t.albumId === albumId);
    if (stillPending || this._running > 0) {
      // Check if any running tasks are for this album (approximation: if total === done across galleries)
      const session = this._sessions.get(albumId);
      if (!session) return;
      const galleries = Object.values(session.galleries);
      const allDone = galleries.every(g => g.done >= g.total);
      if (!allDone) return;
    }
    // Double-check queue
    if (this._queue.some(t => t.albumId === albumId)) return;

    const session = this._sessions.get(albumId);
    if (!session) return;
    const galleries = Object.values(session.galleries);
    if (!galleries.every(g => g.done >= g.total)) return;

    // Album upload complete
    removeActiveUpload(albumId);
    const album = S.albums.find(a => a.id === albumId);
    if (album) {
      album.uploading = false;
      album.lastActivity = Date.now();
      saveAlbumsLocal();
      apiPushAlbum(album).catch(() => {});
    }

    const totalFailed = galleries.reduce((n, g) => n + g.failed.length, 0);
    const totalDone = galleries.reduce((n, g) => n + g.done - g.failed.length, 0);
    if (totalFailed) {
      toast(`⚠ "${session.albumName}": ${totalDone} ảnh OK, ${totalFailed} thất bại.`);
    } else {
      toast(`✓ Tải lên "${session.albumName}" hoàn tất — ${totalDone} ảnh.`);
    }

    // Flip the widget card into its success/error state and show it for a while.
    session.completed = true;
    session.doneCount = totalDone;
    session.failedCount = totalFailed;
    this._speed.delete(albumId);
    renderUploadDashboard();

    // Clean up session after a delay (success card lingers ~6s)
    setTimeout(() => {
      this._sessions.delete(albumId);
      this._broadcastProgress();
      renderUploadDashboard();
    }, 6000);
    renderAlbumsList();
  },

  /** Token with mutex (prevents parallel refresh) */
  async _getToken() {
    while (this._tokenMutex) await new Promise(r => setTimeout(r, 50));
    if (S.driveToken && Date.now() < S.driveToken.exp - 60000) return S.driveToken.token;
    this._tokenMutex = true;
    try {
      const res = await apiFetch('/api/drive-token');
      if (!res?.ok) return null;
      const d = await res.json();
      S.driveToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
      return S.driveToken.token;
    } finally { this._tokenMutex = false; }
  },

  _broadcastProgress() {
    const sessions = [...this._sessions.values()];
    try { this._bc?.postMessage({ type: 'progress', sessions }); } catch (_) {}
    // Persist to sessionStorage so page refresh recovers session counts (not files)
    try { sessionStorage.setItem('lmUploadSessions', JSON.stringify(sessions)); } catch (_) {}
  },

  _mergeRemoteSessions(remoteSessions) {
    (remoteSessions || []).forEach(rs => {
      if (!this._sessions.has(rs.albumId)) {
        this._sessions.set(rs.albumId, rs);
      }
    });
  },

  /** Total active uploads (for badge) */
  get activeCount() {
    return [...this._sessions.values()].reduce((n, s) =>
      n + Object.values(s.galleries).reduce((m, g) => m + (g.total - g.done), 0), 0);
  },
};

/** Human-readable byte size, e.g. 12.4 MB */
function fmtBytes(n) {
  if (!n || n < 1) return '0 B';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return Math.round(n) + ' B';
}
/** Upload speed, e.g. 3.2 MB/s */
function fmtSpeed(bps) { return (!bps || bps < 1) ? '—' : fmtBytes(bps) + '/s'; }
/** ETA in Vietnamese, e.g. "2 phút 5s" */
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + ' giây';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m} phút${s ? ` ${s}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} giờ ${m % 60} phút`;
}

/** Render the fixed bottom-right upload status widget (speed / count / ETA / done) */
function renderUploadDashboard() {
  const stack = document.getElementById('upload-stack');
  if (!stack) return;
  const sessions = [...UploadManager._sessions.values()];
  if (!sessions.length) { stack.innerHTML = ''; return; }
  const now = Date.now();

  stack.innerHTML = sessions.map(s => {
    const galleries = Object.values(s.galleries);
    const totalDone = galleries.reduce((n, g) => n + g.done, 0);
    const totalTotal = galleries.reduce((n, g) => n + g.total, 0);

    // ── Completed card (success / partial-fail) ──
    if (s.completed) {
      const failed = s.failedCount || 0;
      const ok = s.doneCount != null ? s.doneCount : totalDone;
      const cls = failed ? 'err' : 'ok';
      const name = failed ? `⚠ ${s.albumName}` : `✓ ${s.albumName}`;
      const msg = failed
        ? `${ok} ảnh thành công · ${failed} lỗi`
        : `Tải lên thành công — ${ok} ảnh`;
      return `<div class="uf-item ${cls}" data-album="${s.albumId}">
        <div class="uf-head">
          <span class="uf-name">${name}</span>
          <button class="uf-x" data-close="${s.albumId}" title="Đóng">×</button>
        </div>
        <div class="uf-bar"><div class="uf-fill" style="width:100%"></div></div>
        <div class="uf-stats"><span>${msg}</span><span>100%</span></div>
      </div>`;
    }

    // ── In-progress card ──
    let liveBytes = 0;
    UploadManager._liveBytes.forEach((b, key) => { if (key.startsWith(s.albumId + '|')) liveBytes += b; });
    const bytesTotal = galleries.reduce((n, g) => n + (g.bytesTotal || 0), 0);
    const bytesDone = galleries.reduce((n, g) => n + (g.bytesDone || 0), 0) + liveBytes;
    const pct = bytesTotal
      ? Math.min(100, Math.round(bytesDone / bytesTotal * 100))
      : (totalTotal ? Math.round(totalDone / totalTotal * 100) : 0);

    // Rolling upload speed (EMA over byte deltas) → drives the ETA.
    const prev = UploadManager._speed.get(s.albumId);
    let bps = prev?.bps || 0;
    if (prev && now - prev.t > 250) {
      const inst = (bytesDone - prev.bytes) / ((now - prev.t) / 1000);
      bps = inst < 0 ? bps : (prev.bps ? prev.bps * 0.6 + inst * 0.4 : inst);
      UploadManager._speed.set(s.albumId, { t: now, bytes: bytesDone, bps });
    } else if (!prev) {
      UploadManager._speed.set(s.albumId, { t: now, bytes: bytesDone, bps: 0 });
    }
    const remaining = Math.max(0, bytesTotal - bytesDone);
    const eta = bps > 0 ? remaining / bps : Infinity;

    return `<div class="uf-item" data-album="${s.albumId}">
      <div class="uf-head">
        <span class="uf-name">⬆ ${s.albumName}</span>
        <span class="uf-name-pct">${pct}%</span>
      </div>
      <div class="uf-bar"><div class="uf-fill" style="width:${pct}%"></div></div>
      <div class="uf-stats">
        <span>📷 ${totalDone}/${totalTotal} ảnh</span>
        <span>⚡ ${fmtSpeed(bps)}</span>
      </div>
      <div class="uf-stats">
        <span>${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)}</span>
        <span>⏳ còn ${fmtEta(eta)}</span>
      </div>
    </div>`;
  }).join('');

  // Dismiss a completed card immediately
  stack.querySelectorAll('.uf-x[data-close]').forEach(btn => {
    btn.onclick = () => {
      UploadManager._sessions.delete(btn.dataset.close);
      UploadManager._speed.delete(btn.dataset.close);
      renderUploadDashboard();
    };
  });
}

/* ─────────────────────────────────────────────
   10. NAVIGATION / ROUTING
   ───────────────────────────────────────────── */

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId)?.classList.add('active');
  document.querySelectorAll('#sb-nav [data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  S.page = pageId;
}

function navigateFromHash() {
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('album/')) {
    const id = hash.slice(6);
    openAlbumDetail(id, true);
  } else if (['dashboard', 'albums', 'progress', 'trash', 'staff', 'settings', 'perms'].includes(hash)) {
    showPage(hash);
    renderCurrentPage();
  } else {
    showPage('dashboard');
    renderDashboard();
  }
}

function setHash(h) {
  history.pushState(null, '', '#' + h);
}

function renderCurrentPage() {
  if (S.page === 'dashboard') renderDashboard();
  else if (S.page === 'albums') renderAlbumsList();
  else if (S.page === 'progress') renderProgressPage();
  else if (S.page === 'trash') renderTrashPage();
  else if (S.page === 'staff') renderStaffPage();
  else if (S.page === 'settings') { renderSettings(); checkDriveStatus(); }
  else if (S.page === 'albumdetail' && S.detailId) renderDetailGrid();
  // perms is static HTML — no render needed
}

/* ─────────────────────────────────────────────
   11. ALBUMS LIST
   ───────────────────────────────────────────── */

const STATUS_LABELS = {
  new: 'Mới tạo',
  waiting: 'Đang chờ',
  choosing: 'Đang chọn',
  done: 'Đã chốt',
  editing: 'Đang hậu kỳ',
  delivered: 'Đã giao',
};
const STATUS_ORDER = ['new', 'waiting', 'choosing', 'done', 'editing', 'delivered'];

function albumStatusPill(album) {
  const s = album.status || 'new';
  return `<span class="status-pill s-${s}"><span class="dot"></span>${STATUS_LABELS[s] || s}</span>`;
}

function albumCoverUrl(album) {
  const photos = album.photos || [];
  let p = album.cover
    ? photos.find(x => x.id === album.cover || x.driveId === album.cover || photoDriveId(x) === album.cover)
    : null;
  if (!p) p = photos[0];
  return p ? photoUrl(p, 's400') : '';
}

const STATUS_COLORS = {
  new: 'var(--muted-2)', waiting: 'var(--muted)', choosing: 'var(--amber)', done: 'var(--green)',
  editing: 'var(--blue)', delivered: 'var(--teal)',
};

/** Number of selected photos in an album. */
function albumSelCount(a) {
  return (a.photos || []).filter(p => p.selected || p.review === 'selected').length;
}

/** Whether an album is currently uploading (used as a "never hide" guard). */
function albumIsUploading(a) {
  return !!(a.uploading || S.activeUploads.has(a.id));
}

/** Status chips bar — replaces the old filter pills. */
function renderAlbumStatusBar() {
  const bar = document.getElementById('album-status-bar');
  if (!bar) return;
  const active = S.albums.filter(a => !a.trashed);
  const counts = {};
  active.forEach(a => { const s = a.status || 'new'; counts[s] = (counts[s] || 0) + 1; });

  const chips = [
    `<button class="status-chip ${!S.filterStatus ? 'active' : ''}" data-status="">Tất cả <strong>${active.length}</strong></button>`,
    ...STATUS_ORDER.map(st =>
      `<button class="status-chip ${S.filterStatus === st ? 'active' : ''}" data-status="${st}">
         <span class="chip-dot" style="background:${STATUS_COLORS[st]}"></span>
         ${STATUS_LABELS[st]} <strong>${counts[st] || 0}</strong>
       </button>`
    ),
  ];
  bar.innerHTML = chips.join('');
  bar.querySelectorAll('[data-status]').forEach(btn => {
    btn.onclick = () => { S.filterStatus = btn.dataset.status || null; renderAlbumsList(); };
  });
}

/** Populate the month <select> from album names ("8.6 Kiều Anh" → tháng 6). */
function populateMonthSelect() {
  const sel = document.getElementById('alb-month');
  if (!sel) return;
  const months = new Set();
  S.albums.filter(a => !a.trashed).forEach(a => {
    const d = parseShootDate(a.name);
    if (d) months.add(d.getMonth() + 1);
  });
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tất cả tháng</option>'
    + [...months].sort((a, b) => b - a).map(m => `<option value="${m}">Tháng ${m}</option>`).join('');
  sel.value = cur;
}

/** Filter + sort. Albums that are uploading are ALWAYS kept (never lose sight of an in-flight upload). */
function filteredAlbums() {
  const q = (document.getElementById('alb-q')?.value || '').toLowerCase().trim();
  const month = document.getElementById('alb-month')?.value || '';

  let list = S.albums.filter(a => {
    if (a.trashed) return false;
    if (albumIsUploading(a)) return true; // guardrail — keep uploading albums visible
    if (S.filterStatus && (a.status || 'new') !== S.filterStatus) return false;
    if (month) {
      const d = parseShootDate(a.name);
      if (!d || String(d.getMonth() + 1) !== month) return false;
    }
    if (q && !(a.name || '').toLowerCase().includes(q)) return false;
    return true;
  });

  const sort = S.albumSort || 'date';
  if (sort === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'vi'));
  } else if (sort === 'deadline') {
    const days = a => {
      if (!a.deadline) return 99999;
      return Math.ceil((new Date(a.deadline) - Date.now()) / 86400000);
    };
    list.sort((a, b) => days(a) - days(b));
  } else if (sort === 'photos') {
    list.sort((a, b) => (b.photos?.length || 0) - (a.photos?.length || 0));
  } else {
    list.sort((a, b) => (b.lastActivity || b.createdAt || 0) - (a.lastActivity || a.createdAt || 0));
  }
  return list;
}

function renderAlbumCard(album) {
  const cover = albumCoverUrl(album);
  const sel = (album.photos || []).filter(p => p.selected || p.review === 'selected').length;
  const total = (album.photos || []).length;
  const dl = deadlineBadge(album.deadline);
  const uploading = album.uploading || S.activeUploads.has(album.id);

  return `
    <div class="album-card" data-id="${album.id}">
      <div class="card-cover" style="${cover ? `background-image:url('${cover}')` : 'background:#f0f0f0'}">
        ${uploading ? '<div class="card-uploading"><div class="spin"></div>Đang upload…</div>' : ''}
        <div class="card-overlay">
          ${can('album','edit') ? '<button class="card-btn" data-action="edit" title="Sửa">✏</button>' : ''}
          <button class="card-btn" data-action="share" title="Link khách">🔗</button>
          ${can('album','trash') ? '<button class="card-btn" data-action="trash" title="Xoá">🗑</button>' : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="card-name">${album.name || 'Album không tên'}</div>
        <div class="card-meta">
          ${albumStatusPill(album)}
          <span>${sel}/${total} ảnh</span>
          ${dl ? `<span class="dl-badge ${dl.cls}">${dl.text}</span>` : ''}
        </div>
        ${total ? `<div class="card-prog"><div class="card-prog-fill" style="width:${Math.round(sel / total * 100)}%"></div></div>` : ''}
        ${album.photoStaff ? `<div class="card-photo-staff">📷 ${album.photoStaff}</div>` : ''}
      </div>
    </div>`;
}

/** Open an album detail (global — used by inline onclick in list/kanban/masonry views). */
function openAlbum(id) {
  setHash('album/' + id);
  openAlbumDetail(id, true);
}

/** LIST view — detailed table. */
function renderAlbumListView(list) {
  const rows = list.map(a => {
    const sel = albumSelCount(a), total = (a.photos || []).length;
    const pct = total ? Math.round(sel / total * 100) : 0;
    const dl = deadlineBadge(a.deadline);
    const dlHtml = dl ? `<span class="${dl.cls === 'dl-over' ? 'card-dl-over' : dl.cls === 'dl-soon' ? 'card-dl-soon' : 'card-dl-ok'}">${dl.text}</span>` : '—';
    const cover = albumCoverUrl(a);
    const staff = (a.photoStaff || '').trim();
    const initials = staff ? staff.split(' ').map(w => w[0]).slice(-2).join('').toUpperCase() : '—';
    const shoot = parseShootDate(a.name);
    const shootTxt = shoot ? fmtDate(shoot) : '—';
    return `<div class="alv-row" onclick="openAlbum('${a.id}')">
      <div class="alv-thumb">${cover ? `<img src="${cover}" loading="lazy">` : '📷'}</div>
      <div><div class="alv-name">${a.name || 'Album không tên'}</div><div class="alv-sub">${shootTxt}</div></div>
      <span>${albumStatusPill(a)}</span>
      <div class="alv-prog-wrap">
        <span class="alv-prog-text">${sel}/${total}${total ? ` · ${pct}%` : ''}</span>
        ${total ? `<div class="alv-prog-bar"><div class="alv-prog-fill" style="width:${pct}%"></div></div>` : ''}
      </div>
      <span style="font-size:12px">${dlHtml}</span>
      <div class="alv-staff-av" title="${staff}">${initials}</div>
    </div>`;
  }).join('');
  return `<div class="albums-list-view">
    <div class="alv-head"><span></span><span>Album</span><span>Trạng thái</span><span>Ảnh đã chọn</span><span>Deadline</span><span>Nhân sự</span></div>
    ${rows}
  </div>`;
}

/** KANBAN view — columns per status. */
function renderAlbumKanban(list) {
  const groups = {};
  STATUS_ORDER.forEach(s => groups[s] = []);
  list.forEach(a => (groups[a.status || 'new'] || groups.new).push(a));
  const cols = STATUS_ORDER.map(st => {
    const items = groups[st];
    const cards = items.map(a => {
      const sel = albumSelCount(a), total = (a.photos || []).length;
      const dl = deadlineBadge(a.deadline);
      return `<div class="kanban-card" onclick="openAlbum('${a.id}')">
        <div class="kanban-card-name">${a.name || 'Album không tên'}</div>
        <div class="kanban-card-meta">${sel}/${total} ảnh${dl ? ` · ${dl.text}` : ''}</div>
      </div>`;
    }).join('');
    return `<div class="kanban-col">
      <div class="kanban-col-head"><span>${STATUS_LABELS[st]}</span><span class="kanban-col-count">${items.length}</span></div>
      ${cards || '<div class="kanban-empty">Trống</div>'}
    </div>`;
  }).join('');
  return `<div class="albums-kanban-view">${cols}</div>`;
}

/** MASONRY view — Pinterest style. */
function renderAlbumMasonry(list) {
  const cards = list.map(a => {
    const cover = albumCoverUrl(a);
    const sel = albumSelCount(a), total = (a.photos || []).length;
    const dl = deadlineBadge(a.deadline);
    const dlHtml = dl ? `<div class="${dl.cls === 'dl-over' ? 'card-dl-over' : dl.cls === 'dl-soon' ? 'card-dl-soon' : 'card-dl-ok'}">${dl.text}</div>` : '';
    return `<div class="masonry-card" onclick="openAlbum('${a.id}')">
      <div class="masonry-thumb" style="${cover ? `height:auto` : 'height:120px'}">${cover ? `<img src="${cover}" style="width:100%;display:block" loading="lazy">` : '📷'}</div>
      <div class="masonry-body">
        <div class="masonry-name">${a.name || 'Album không tên'}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${albumStatusPill(a)}
          <span style="font-size:11px;color:var(--muted)">${sel}/${total}</span>
        </div>
        ${dlHtml}
      </div>
    </div>`;
  }).join('');
  return `<div class="albums-masonry-view">${cards}</div>`;
}

function renderAlbumsList() {
  populateMonthSelect();
  renderAlbumStatusBar();
  const list = filteredAlbums();
  const grid = document.getElementById('albums-grid');
  const empty = document.getElementById('albums-empty');
  const countLabel = document.getElementById('alb-count-label');
  if (!grid) return;
  if (countLabel) countLabel.textContent = `${list.length} album`;

  // Empty state only when there are genuinely no albums (not just a filter miss).
  const noAlbumsAtAll = S.albums.filter(a => !a.trashed).length === 0;
  if (!list.length) {
    grid.innerHTML = noAlbumsAtAll ? '' : '<div class="empty"><div class="ico">🔍</div><strong>Không tìm thấy album nào</strong><span>Thử đổi bộ lọc hoặc từ khoá tìm kiếm.</span></div>';
    empty && (empty.hidden = !noAlbumsAtAll);
    grid.style.display = noAlbumsAtAll ? 'none' : '';
    return;
  }
  empty && (empty.hidden = true);
  grid.style.display = '';

  const mode = S.albumsView || 'grid';
  if (mode === 'grid') {
    grid.className = 'albums-grid';
    grid.innerHTML = list.map(renderAlbumCard).join('');
  } else if (mode === 'list') {
    grid.className = '';
    grid.innerHTML = renderAlbumListView(list);
  } else if (mode === 'kanban') {
    grid.className = '';
    grid.innerHTML = renderAlbumKanban(list);
  } else {
    grid.className = '';
    grid.innerHTML = renderAlbumMasonry(list);
  }

  // Wire grid cards (data-id + action buttons). List/kanban/masonry use inline onclick=openAlbum.
  grid.querySelectorAll('[data-id]').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      openAlbum(id);
    });
    el.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const album = S.albums.find(a => a.id === id);
        if (!album) return;
        if (btn.dataset.action === 'edit') openEditModal(album);
        else if (btn.dataset.action === 'share') openShareModal(album);
        else if (btn.dataset.action === 'trash') trashAlbum(album);
      };
    });
  });
}

/* ─────────────────────────────────────────────
   11a. DASHBOARD (Tổng quan)
   ───────────────────────────────────────────── */

function renderDashboard() {
  const active = S.albums.filter(a => !a.trashed);

  const byStatus = st => active.filter(a => (a.status || 'new') === st).length;
  const choosing = byStatus('choosing');
  const doneNotEdited = byStatus('done');
  const editing = byStatus('editing');

  // Deadlines (số ngày còn lại)
  const withDl = active
    .filter(a => a.deadline)
    .map(a => ({ a, d: Math.ceil((new Date(a.deadline) - Date.now()) / 86400000) }));
  const overdue = withDl.filter(x => x.d < 0).sort((x, y) => x.d - y.d);
  const soon = withDl.filter(x => x.d >= 0 && x.d <= 3).sort((x, y) => x.d - y.d);
  const uploadingCount = active.filter(a => albumIsUploading(a)).length;

  const g = document.getElementById('dash-greeting');
  if (g) g.textContent = `Chào ${S.auth?.name || ''} 👋`;

  // Stat cards (bấm vào lọc nhanh sang trang Albums)
  const stats = [
    { label: 'Đang chờ khách chọn', n: choosing, color: 'var(--amber)', status: 'choosing' },
    { label: 'Đã chốt, chờ hậu kỳ', n: doneNotEdited, color: 'var(--green)', status: 'done' },
    { label: 'Đang hậu kỳ', n: editing, color: 'var(--blue)', status: 'editing' },
    { label: 'Sắp / đang trễ', n: overdue.length + soon.length, color: 'var(--red)', status: null },
    { label: 'Đang upload', n: uploadingCount, color: 'var(--teal)', status: null },
  ];
  const statsEl = document.getElementById('dash-stats');
  if (statsEl) statsEl.innerHTML = stats.map(s =>
    `<div class="dash-stat"${s.status ? ` onclick="dashGoStatus('${s.status}')" style="cursor:pointer"` : ''}>
       <div class="dash-stat-n" style="color:${s.color}">${s.n}</div>
       <div class="dash-stat-l">${s.label}</div>
     </div>`
  ).join('');

  // Deadline list (trễ trước, sắp trễ sau)
  const dlEl = document.getElementById('dash-deadline');
  const dlItems = [...overdue, ...soon].slice(0, 8);
  if (dlEl) dlEl.innerHTML = dlItems.length ? dlItems.map(({ a, d }) => {
    const cls = d < 0 ? 'card-dl-over' : 'card-dl-soon';
    const txt = d < 0 ? `Trễ ${-d} ngày` : d === 0 ? 'Hôm nay' : `Còn ${d} ngày`;
    return `<div class="dash-row" onclick="openAlbum('${a.id}')">
      <span class="dash-row-name">${a.name || 'Album'}</span>
      ${albumStatusPill(a)}
      <span class="${cls}" style="margin-top:0;white-space:nowrap">${txt}</span>
    </div>`;
  }).join('') : '<div class="dash-empty">Không có album nào sắp trễ 🎉</div>';

  // Recent activity
  const recent = [...active].sort((a, b) => (b.lastActivity || b.createdAt || 0) - (a.lastActivity || a.createdAt || 0)).slice(0, 6);
  const recEl = document.getElementById('dash-recent');
  if (recEl) recEl.innerHTML = recent.length ? recent.map(a => {
    const sel = albumSelCount(a), total = (a.photos || []).length;
    return `<div class="dash-row" onclick="openAlbum('${a.id}')">
      <span class="dash-row-name">${a.name || 'Album'}</span>
      ${albumStatusPill(a)}
      <span style="font-size:12px;color:var(--muted);white-space:nowrap">${sel}/${total} ảnh</span>
    </div>`;
  }).join('') : '<div class="dash-empty">Chưa có album nào.</div>';
}

/** Bấm thẻ thống kê → sang trang Albums đã lọc sẵn theo trạng thái. */
function dashGoStatus(st) {
  S.filterStatus = st;
  showPage('albums');
  setHash('albums');
  renderAlbumsList();
}

/* ─────────────────────────────────────────────
   11c. CÀI ĐẶT PAGE (render động)
   ───────────────────────────────────────────── */

// Renders from S only (no fetch) — the live Drive re-check is kicked once on navigation
// (see renderCurrentPage), and its updateDriveDot() callback re-renders this page.
function renderSettings() {
  const role = S.auth?.role || 'viewer';

  const acc = document.getElementById('settings-account');
  if (acc) acc.innerHTML =
    `<div class="set-row"><span class="set-row-l">Tên</span><span class="set-row-v">${S.auth?.name || '—'}</span></div>
     <div class="set-row"><span class="set-row-l">Vai trò</span><span class="set-row-v"><span class="role-badge role-${role}">${roleLabel(role)}</span></span></div>`;

  const ds = document.getElementById('settings-drive-status');
  if (ds) {
    const connected = !!S.driveConnected;
    ds.innerHTML =
      `<div class="set-row"><span class="set-row-l">Trạng thái</span>
        <span class="set-row-v"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${connected ? 'var(--green)' : 'var(--amber)'}"></span>${connected ? 'Đã kết nối' : 'Chưa kết nối'}</span></div>`
      + (connected && S.driveEmail ? `<div class="set-row"><span class="set-row-l">Tài khoản</span><span class="set-row-v">${S.driveEmail}</span></div>` : '');
  }

  // Gate actions by role
  const connectBtn = document.getElementById('settings-drive-connect');
  if (connectBtn) connectBtn.hidden = !can('drive', 'connect');
  const exportGroup = document.getElementById('settings-export-group');
  if (exportGroup) exportGroup.hidden = !can('album', 'edit');
}

/* ─────────────────────────────────────────────
   11b. NHÂN SỰ PAGE
   ───────────────────────────────────────────── */

function renderStaffPage() {
  const container = document.getElementById('staff-list');
  if (!container) return;

  // Group active albums by the photographer who uploaded them.
  const byStaff = {};
  S.albums.filter(a => !a.trashed).forEach(a => {
    const key = (a.photoStaff || '').trim() || '__unknown__';
    if (!byStaff[key]) byStaff[key] = { name: key === '__unknown__' ? 'Không rõ' : key, albums: [] };
    byStaff[key].albums.push(a);
  });

  if (!Object.keys(byStaff).length) {
    container.innerHTML = '<div class="empty"><div class="ico">👥</div><strong>Chưa có dữ liệu nhân sự</strong><span>Album mới sẽ tự gắn người upload.</span></div>';
    return;
  }

  container.innerHTML = Object.entries(byStaff)
    .sort((a, b) => b[1].albums.length - a[1].albums.length)
    .map(([staffId, data]) => {
      const albums = data.albums;
      const totalPhotos = albums.reduce((n, a) => n + (a.photos?.length || 0), 0);
      const totalSelected = albums.reduce((n, a) => n + albumSelCount(a), 0);
      const counts = {};
      albums.forEach(a => { const s = a.status || 'new'; counts[s] = (counts[s] || 0) + 1; });
      const initials = data.name === 'Không rõ' ? '?' : data.name.split(' ').map(w => w[0]).slice(-2).join('').toUpperCase();
      const safeId = staffId.replace(/[^a-zA-Z0-9_-]/g, '');

      const barSegs = STATUS_ORDER.filter(st => counts[st]).map(st =>
        `<div class="staff-status-seg" style="flex:${counts[st]};background:${STATUS_COLORS[st]}" title="${STATUS_LABELS[st]}: ${counts[st]}"></div>`
      ).join('');
      const legend = STATUS_ORDER.filter(st => counts[st]).map(st =>
        `<span><span class="staff-legend-dot" style="background:${STATUS_COLORS[st]}"></span>${STATUS_LABELS[st]} (${counts[st]})</span>`
      ).join('');
      const albumCards = [...albums].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).map(a => {
        const cover = albumCoverUrl(a);
        const sel = albumSelCount(a), total = (a.photos?.length || 0);
        return `<div class="staff-album-card" onclick="openAlbum('${a.id}')">
          <div class="staff-album-thumb">${cover ? `<img src="${cover}" loading="lazy">` : '📷'}</div>
          <div class="staff-album-body">
            <div class="staff-album-name">${a.name || 'Album không tên'}</div>
            <div class="staff-album-row">${albumStatusPill(a)}<span style="font-size:10px;color:var(--muted)">${sel}/${total}</span></div>
          </div>
        </div>`;
      }).join('');

      return `<div class="staff-card">
        <div class="staff-card-header" onclick="toggleStaffCard('${safeId}')">
          <div class="staff-avatar">${initials}</div>
          <div class="staff-info"><strong>${data.name}</strong><small>Photo — up ảnh gốc</small></div>
          <div class="staff-stats">
            <div class="staff-stat"><span class="staff-stat-n">${albums.length}</span><span class="staff-stat-l">bộ ảnh</span></div>
            <div class="staff-stat"><span class="staff-stat-n">${totalPhotos.toLocaleString('vi')}</span><span class="staff-stat-l">ảnh up</span></div>
            <div class="staff-stat"><span class="staff-stat-n">${totalSelected}</span><span class="staff-stat-l">đã chọn</span></div>
          </div>
          <svg class="staff-chevron open" id="chev-${safeId}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="staff-card-body open" id="scb-${safeId}">
          <div class="staff-status-bar">${barSegs}</div>
          <div class="staff-status-legend">${legend}</div>
          <div class="staff-album-grid">${albumCards}</div>
        </div>
      </div>`;
    }).join('');
}

function toggleStaffCard(safeId) {
  const body = document.getElementById('scb-' + safeId);
  const chev = document.getElementById('chev-' + safeId);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chev?.classList.toggle('open', !isOpen);
}

/* ─────────────────────────────────────────────
   12. PROGRESS PAGE (deadline tracking)
   ───────────────────────────────────────────── */

function renderProgressPage() {
  const list = document.getElementById('progress-list');
  const empty = document.getElementById('progress-empty');
  const banner = document.getElementById('deadline-banner');
  if (!list) return;

  const active = S.albums.filter(a => !a.trashed);
  if (!active.length) { list.innerHTML = ''; empty && (empty.hidden = false); return; }
  empty && (empty.hidden = true);

  // Filter by type/date if set
  let filtered = active;
  const ftype = document.getElementById('pg-ftype')?.value;
  const fdate = document.getElementById('pg-fdate')?.value;
  if (fdate) {
    filtered = filtered.filter(a => {
      if (ftype === 'selected') return a.deadline === fdate || (a.selectedAt && fmtDate(a.selectedAt).includes(fdate));
      const sd = parseShootDate(a.name);
      if (!sd) return false;
      return sd.toISOString().slice(0, 10) === fdate;
    });
  }

  // Sort by deadline
  filtered.sort((a, b) => {
    const da = a.deadline || '9999', db = b.deadline || '9999';
    return da.localeCompare(db);
  });

  // Overdue banner
  const overdue = filtered.filter(a => a.deadline && new Date(a.deadline) < new Date());
  if (banner) {
    banner.innerHTML = overdue.length
      ? `<div class="deadline-banner">⚠ ${overdue.length} album đang trễ hạn trả ảnh!</div>` : '';
  }

  if (S.progView === 'grid') {
    list.className = 'albums-grid';
    list.innerHTML = filtered.map(renderAlbumCard).join('');
    list.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('[data-action]')) return;
        setHash('album/' + el.dataset.id);
        openAlbumDetail(el.dataset.id, true);
      });
    });
  } else {
    list.className = '';
    list.innerHTML = filtered.map(a => {
      const shoot = parseShootDate(a.name);
      const dl = deadlineBadge(a.deadline);
      const sel = (a.photos || []).filter(p => p.selected || p.review === 'selected').length;
      return `<div class="prog-row" data-id="${a.id}">
        <span class="prog-client">${a.name || '—'}<small>${a.client || ''}</small></span>
        <span>${shoot ? shoot.toLocaleDateString('vi-VN') : '—'}</span>
        <span>${a.deadlineDays != null ? a.deadlineDays + ' ngày' : '—'}</span>
        <span>${albumStatusPill(a)}</span>
        <span>${dl ? `<span class="dl-badge ${dl.cls}">${dl.text}</span>` : '—'}</span>
        <span><button class="btn ghost sm" onclick="setHash('album/${a.id}');openAlbumDetail('${a.id}',true)">Xem</button></span>
      </div>`;
    }).join('');
  }
}

/* ─────────────────────────────────────────────
   13. TRASH PAGE
   ───────────────────────────────────────────── */

function renderTrashPage() {
  const grid = document.getElementById('trash-grid');
  const empty = document.getElementById('trash-empty-msg');
  if (!grid) return;
  if (!S.trashedAlbums.length) {
    grid.innerHTML = '';
    empty && (empty.hidden = false);
    return;
  }
  empty && (empty.hidden = true);
  grid.innerHTML = S.trashedAlbums.map(a => `
    <div class="album-card trash-card" data-id="${a.id}">
      <div class="card-cover" style="${albumCoverUrl(a) ? `background-image:url('${albumCoverUrl(a)}')` : ''}"></div>
      <div class="card-body">
        <div class="card-name">${a.name || 'Album không tên'}</div>
        <div class="card-meta" style="gap:6px">
          <button class="btn ghost sm" data-restore="${a.id}">Khôi phục</button>
          <button class="btn danger sm" data-perm="${a.id}">Xoá vĩnh viễn</button>
        </div>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-restore]').forEach(btn => {
    btn.onclick = () => restoreAlbum(btn.dataset.restore);
  });
  grid.querySelectorAll('[data-perm]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('Xoá vĩnh viễn? Không lấy lại được.')) return;
      permanentDeleteAlbum(btn.dataset.perm);
    };
  });
}

function trashAlbum(album) {
  if (!confirm(`Chuyển "${album.name}" vào thùng rác?`)) return;
  album.trashed = true;
  album.lastActivity = Date.now();
  S.trashedAlbums.push(album);
  S.albums = S.albums.filter(a => a.id !== album.id);
  saveAlbumsLocal();
  SyncManager.forcePush(album).catch(() => {});
  renderAlbumsList();
  // Update badge
  document.getElementById('trash-badge') && renderTrashBadge();
}

function restoreAlbum(id) {
  const album = S.trashedAlbums.find(a => a.id === id);
  if (!album) return;
  album.trashed = false;
  album.lastActivity = Date.now();
  S.albums.push(album);
  S.trashedAlbums = S.trashedAlbums.filter(a => a.id !== id);
  saveAlbumsLocal();
  SyncManager.forcePush(album).catch(() => {});
  renderTrashPage();
  renderTrashBadge();
}

async function permanentDeleteAlbum(id) {
  const ok = await apiDeleteAlbum(id, true);
  S.trashedAlbums = S.trashedAlbums.filter(a => a.id !== id);
  saveAlbumsLocal();
  renderTrashPage();
  renderTrashBadge();
  if (!ok) toast('⚠ Không thể xoá trên máy chủ — đã xoá cục bộ.');
}

function renderTrashBadge() {
  const badge = document.getElementById('trash-badge');
  if (!badge) return;
  badge.textContent = S.trashedAlbums.length || '';
  badge.hidden = !S.trashedAlbums.length;
}

/* ─────────────────────────────────────────────
   14. CREATE ALBUM
   ───────────────────────────────────────────── */

let _createFiles = [];
let _createSrc = 'upload';

function openCreateModal() {
  _createFiles = [];
  _createSrc = 'upload';
  document.getElementById('album-name').value = '';
  document.getElementById('deadline-days').value = '';
  document.getElementById('max-count').value = '';
  document.getElementById('drive-url').value = '';
  document.getElementById('allow-notes').checked = true;
  document.getElementById('allow-download').checked = false;
  document.getElementById('lock-on').checked = false;
  document.getElementById('lock-phone').hidden = true;
  document.getElementById('lock-hint').hidden = true;
  document.getElementById('pick-info').hidden = true;
  document.getElementById('pane-upload').style.display = '';
  document.getElementById('pane-drive').hidden = true;
  openModal('create-modal');
}

async function handleCreateSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('album-name').value.trim();
  if (!name) { toast('Vui lòng nhập tên album'); return; }

  const deadlineDays = parseInt(document.getElementById('deadline-days').value) || null;
  const maxCount = parseInt(document.getElementById('max-count').value) || null;
  const allowNotes = document.getElementById('allow-notes').checked;
  const allowDownload = document.getElementById('allow-download').checked;
  const lockOn = document.getElementById('lock-on').checked;
  const lockPhone = lockOn ? document.getElementById('lock-phone').value.trim() : null;

  const submit = document.getElementById('create-submit');
  submit.disabled = true;
  submit.textContent = 'Đang tạo…';

  try {
    let photos = [];
    let folderId = null;

    if (_createSrc === 'drive') {
      const driveText = document.getElementById('drive-url').value.trim();
      if (!driveText) { toast('Vui lòng nhập link Google Drive'); return; }
      photos = await buildDrivePhotos(driveText);
      if (!photos.length) { toast('⚠ Không tìm thấy ảnh — folder trống hoặc chưa chia sẻ đúng cách với tài khoản Drive của studio'); return; }
    }

    const album = {
      id: uid(),
      name,
      status: 'new',
      deadlineDays,
      maxCount,
      allowNotes,
      allowDownload,
      lockPhone: lockPhone || null,
      photos,
      folderId,
      photoStaff: S.auth?.name || null,   // photographer who created/uploaded this set
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    // Save locally first
    S.albums.push(album);
    saveAlbumsLocal();
    closeModal('create-modal');
    renderAlbumsList();

    // Push to server
    apiPushAlbum(album).catch(() => {});

    // If upload mode, start uploading
    if (_createSrc === 'upload' && _createFiles.length) {
      await startUploadFlow(album, _createFiles);
    }

    toast(`✓ Đã tạo album "${name}"`);
  } catch (err) {
    toast('⚠ ' + err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Tạo album';
  }
}

/** Queue files to UploadManager (default gallery = album root) */
async function startUploadFlow(album, files, galleryId = '__default__', galleryName = 'Ảnh gốc') {
  await UploadManager.enqueue(
    album.id, album.name,
    galleryId, galleryName,
    galleryId === '__default__' ? album.folderId : null,
    files
  );
}

/* ─────────────────────────────────────────────
   15. ALBUM DETAIL PAGE
   ───────────────────────────────────────────── */

async function openAlbumDetail(id, skipHash = false) {
  const album = S.albums.find(a => a.id === id);
  if (!album) { toast('⚠ Không tìm thấy album'); return; }
  S.detailId = id;
  S.detailSetIdx = 0;
  S.detailSortAsc = true;
  S.detailView = 'grid';
  S.detailPickMode = false;
  S.detailPicked.clear();
  if (!skipHash) setHash('album/' + id);
  showPage('albumdetail');
  renderDetailFull(album);
}

function getDetailAlbum() { return S.albums.find(a => a.id === S.detailId); }

/** Current gallery's photos, sorted */
function detailPhotos(album) {
  const gallery = currentDetailGallery(album);
  const gid = gallery ? gallery.id : null;
  let photos = (album.photos || []).filter(p =>
    gid ? (p.galleryId === gid) : !p.galleryId
  );
  photos = [...photos].sort((a, b) => {
    const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
    return S.detailSortAsc ? na.localeCompare(nb) : nb.localeCompare(na);
  });
  return photos;
}

/** Current gallery object (null = default) */
function currentDetailGallery(album) {
  if (S.detailSetIdx === 0) return null;
  return (album.galleries || [])[S.detailSetIdx - 1] || null;
}

function renderDetailFull(album) {
  // Top bar
  document.getElementById('ad-name').textContent = album.name || 'Album không tên';
  document.getElementById('ad-meta').textContent =
    `${(album.photos || []).length} ảnh · ${fmtDate(album.createdAt)}`;

  // Status pill
  const sp = document.getElementById('ad-status');
  const s = album.status || 'new';
  if (sp) { sp.className = `status-pill s-${s}`; sp.innerHTML = `<span class="dot"></span>${STATUS_LABELS[s] || s}`; }

  // Cover
  const cov = document.getElementById('ad-cover');
  const covUrl = albumCoverUrl(album);
  if (cov) cov.src = covUrl || '';

  // Sets sidebar
  renderDetailSets(album);
  renderDetailGrid();
  // Apply role-based controls on detail page
  const addPhotosBtn = document.getElementById('ad-add-photos');
  const addSetBtn    = document.getElementById('ad-add-set');
  const pickBtn      = document.getElementById('ad-pick');
  const pickDelBtn   = document.getElementById('ad-pick-del');
  if (addPhotosBtn) addPhotosBtn.hidden = !can('drive', 'upload');
  if (addSetBtn)    addSetBtn.hidden    = !can('gallery', 'create');
  if (pickBtn)      pickBtn.hidden      = !can('album', 'edit');
  if (pickDelBtn)   pickDelBtn.hidden   = !can('album', 'edit');
}

function renderDetailSets(album) {
  const el = document.getElementById('ad-sets');
  if (!el) return;
  const galleries = album.galleries || [];
  const defaultCount = (album.photos || []).filter(p => !p.galleryId).length;

  const mkItem = (idx, name, count, gid) => `
    <div class="set-item ${S.detailSetIdx === idx ? 'active' : ''}" data-set-idx="${idx}">
      <span class="set-name">${name}</span>
      <span class="set-count">${count}</span>
      <div class="set-acts">
        ${gid ? `<button class="set-act" data-rename="${gid}" title="Đổi tên">✏</button>
        <button class="set-act set-up" data-upload="${gid}" title="Tải ảnh vào album này">⬆</button>
        <button class="set-act set-del" data-deleteg="${gid}" title="Xoá album">🗑</button>` : ''}
      </div>
    </div>`;

  el.innerHTML = mkItem(0, 'Ảnh gốc', defaultCount, null) +
    galleries.map((g, i) =>
      mkItem(i + 1, g.name, (album.photos || []).filter(p => p.galleryId === g.id).length, g.id)
    ).join('');

  // Switch gallery
  el.querySelectorAll('[data-set-idx]').forEach(div => {
    div.addEventListener('click', e => {
      if (e.target.closest('[data-rename],[data-upload],[data-deleteg]')) return;
      S.detailSetIdx = parseInt(div.dataset.setIdx);
      el.querySelectorAll('[data-set-idx]').forEach(d => d.classList.remove('active'));
      div.classList.add('active');
      const a = getDetailAlbum();
      const g = currentDetailGallery(a);
      document.getElementById('ad-set-title').textContent = g ? g.name : 'ẢNH GỐC';
      renderDetailGrid();
    });
  });

  // Rename gallery
  el.querySelectorAll('[data-rename]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); renameGallery(album.id, btn.dataset.rename); };
  });
  // Upload to specific gallery
  el.querySelectorAll('[data-upload]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const gid = btn.dataset.upload;
      const gallery = (album.galleries || []).find(g => g.id === gid);
      if (gallery) triggerGalleryUpload(album, gallery);
    };
  });
  // Delete gallery
  el.querySelectorAll('[data-deleteg]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); deleteGallery(album.id, btn.dataset.deleteg); };
  });
}

function renameGallery(albumId, galleryId) {
  const album = S.albums.find(a => a.id === albumId);
  const gallery = (album?.galleries || []).find(g => g.id === galleryId);
  if (!gallery) return;
  const newName = prompt('Tên mới cho album:', gallery.name);
  if (!newName || newName === gallery.name) return;
  gallery.name = newName.trim();
  album.lastActivity = Date.now();
  saveAlbumsLocal();
  apiPushAlbum(album).catch(() => {});
  renderDetailSets(album);
  toast('✓ Đã đổi tên');
}

function deleteGallery(albumId, galleryId) {
  const album = S.albums.find(a => a.id === albumId);
  const gallery = (album?.galleries || []).find(g => g.id === galleryId);
  if (!gallery) return;
  const count = (album.photos || []).filter(p => p.galleryId === galleryId).length;
  if (!confirm(`Xoá album "${gallery.name}"? ${count > 0 ? `${count} ảnh sẽ chuyển về Ảnh gốc.` : ''}`)) return;
  // Move photos to default
  (album.photos || []).forEach(p => { if (p.galleryId === galleryId) p.galleryId = null; });
  album.galleries = (album.galleries || []).filter(g => g.id !== galleryId);
  if (S.detailSetIdx > album.galleries.length) S.detailSetIdx = 0;
  album.lastActivity = Date.now();
  saveAlbumsLocal();
  apiPushAlbum(album).catch(() => {});
  renderDetailFull(album);
  toast('✓ Đã xoá album');
}

/** Trigger file input for a specific gallery */
function triggerGalleryUpload(album, gallery) {
  const fi = document.createElement('input');
  fi.type = 'file'; fi.accept = 'image/*'; fi.multiple = true;
  fi.onchange = async () => {
    const files = [...fi.files];
    if (!files.length) return;
    await startUploadFlow(album, files, gallery.id, gallery.name);
  };
  fi.click();
}

function renderDetailGrid() {
  const album = getDetailAlbum();
  if (!album) return;
  const photos = detailPhotos(album);
  const grid = document.getElementById('ad-grid');
  if (!grid) return;

  if (!photos.length) {
    grid.innerHTML = `<div class="empty-grid"><div class="ico">📷</div><strong>Chưa có ảnh nào</strong><span>Kéo-thả ảnh vào đây hoặc bấm Thêm ảnh.</span></div>`;
    return;
  }

  const sel = new Set((album.photos || []).filter(p => p.selected || p.review === 'selected').map(p => p.id));

  if (S.detailView === 'list') {
    grid.className = 'detail-grid list-view';
    grid.innerHTML = photos.map((p, i) => `
      <div class="photo-list-row ${S.detailPicked.has(p.id) ? 'picked' : ''}" data-idx="${i}" data-id="${p.id}">
        <img src="${photoUrl(p, 's120')}" alt="${p.name}" loading="lazy">
        <span class="photo-name">${p.name || p.id}</span>
        ${sel.has(p.id) ? '<span class="sel-tag">✓ Đã chọn</span>' : ''}
        ${p.note ? `<span class="note-tag" title="${p.note}">📝</span>` : ''}
        ${S.detailPickMode ? `<input type="checkbox" class="pick-cb" ${S.detailPicked.has(p.id) ? 'checked' : ''}>` : ''}
      </div>`).join('');
  } else {
    grid.className = 'detail-grid grid-view';
    grid.innerHTML = photos.map((p, i) => `
      <div class="photo-thumb ${sel.has(p.id) ? 'selected' : ''} ${S.detailPicked.has(p.id) ? 'picked' : ''}" data-idx="${i}" data-id="${p.id}">
        <img src="${photoUrl(p, 's400')}" alt="${p.name}" loading="lazy">
        ${p.note ? '<div class="note-dot" title="Có ghi chú">📝</div>' : ''}
        ${S.detailPickMode ? `<input type="checkbox" class="pick-cb" ${S.detailPicked.has(p.id) ? 'checked' : ''}>` : ''}
        ${sel.has(p.id) ? '<div class="sel-badge">✓</div>' : ''}
      </div>`).join('');
  }

  // Events
  grid.querySelectorAll('[data-idx]').forEach(el => {
    el.onclick = e => {
      if (S.detailPickMode) {
        const id = el.dataset.id;
        const cb = el.querySelector('.pick-cb');
        if (S.detailPicked.has(id)) { S.detailPicked.delete(id); el.classList.remove('picked'); if (cb) cb.checked = false; }
        else { S.detailPicked.add(id); el.classList.add('picked'); if (cb) cb.checked = true; }
        updatePickBar();
        return;
      }
      if (e.target.classList.contains('pick-cb')) return;
      openLightboxDetail(photos, parseInt(el.dataset.idx));
    };
  });
}

function updatePickBar() {
  const n = S.detailPicked.size;
  const bar = document.getElementById('ad-pickbar');
  const nEl = document.getElementById('ad-pick-n');
  if (bar) bar.hidden = !S.detailPickMode;
  if (nEl) nEl.textContent = n;
}

/* ─────────────────────────────────────────────
   16. DETAIL UPLOAD (drag-drop + file input)
   ───────────────────────────────────────────── */

function initDetailDropzone() {
  const wrap = document.getElementById('ad-grid-wrap');
  const fi = document.getElementById('ad-file-input');
  if (!wrap || !fi) return;

  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drag-over'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    wrap.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length) handleDetailUpload(files);
  });

  document.getElementById('ad-add-photos').onclick = () => fi.click();
  fi.onchange = () => {
    const files = [...fi.files];
    fi.value = '';
    if (files.length) handleDetailUpload(files);
  };
}

async function handleDetailUpload(files) {
  const album = getDetailAlbum();
  if (!album) return;
  const g = currentDetailGallery(album);
  await startUploadFlow(album, files, g ? g.id : '__default__', g ? g.name : 'Ảnh gốc');
}

/* ─────────────────────────────────────────────
   17. DRIVE SYNC (detail)
   ───────────────────────────────────────────── */

async function syncAlbumWithDrive() {
  const album = getDetailAlbum();
  if (!album || !album.folderId) { toast('Album chưa có folder Drive'); return; }
  const btn = document.getElementById('ad-sync');
  if (btn) { btn.disabled = true; btn.textContent = 'Đang đồng bộ…'; }
  try {
    const files = await listDriveFolder(album.folderId);
    const existingIds = new Set((album.photos || []).map(p => p.id));
    const newPhotos = files
      .filter(f => !existingIds.has(f.id))
      .map(f => ({ id: f.id, name: f.name, url: lh3(f.id) }));
    // Remove photos no longer in Drive
    const driveIds = new Set(files.map(f => f.id));
    album.photos = (album.photos || []).filter(p => !p.id || driveIds.has(p.id) || p._local);
    album.photos.push(...newPhotos);
    album.lastActivity = Date.now();
    saveAlbumsLocal();
    apiPushAlbum(album).catch(() => {});
    renderDetailGrid();
    toast(`✓ Đồng bộ xong. Thêm ${newPhotos.length} ảnh mới.`);
  } catch (e) {
    toast('⚠ Lỗi đồng bộ: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>Đồng bộ Drive`; }
  }
}

/* ─────────────────────────────────────────────
   18. LIGHTBOX — DETAIL CONTEXT
   ───────────────────────────────────────────── */

function openLightboxDetail(photos, idx) {
  S.lbPhotos = photos;
  S.lbIdx = idx;
  S.lbContext = 'detail';
  renderLightbox();
  document.getElementById('lightbox').classList.add('open');
}

function openLightboxClient(photos, idx) {
  S.lbPhotos = photos;
  S.lbIdx = idx;
  S.lbContext = 'client';
  renderLightbox();
  document.getElementById('lightbox').classList.add('open');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}

function renderLightbox() {
  const photos = S.lbPhotos;
  const p = photos[S.lbIdx];
  if (!p) return;

  document.getElementById('lb-img').src = photoUrl(p, 's1600');
  document.getElementById('lb-name').textContent = p.name || p.id;
  document.getElementById('lb-sub').textContent = `${S.lbIdx + 1} / ${photos.length}`;

  const isClient = S.lbContext === 'client';
  const album = isClient ? S.clientAlbum : getDetailAlbum();
  const review = isClient ? (S.clientReview[p.id] || {}) : {};

  // Note box
  const noteBox = document.getElementById('lb-note-box');
  const noteTxt = document.getElementById('lb-note-text');
  const note = review.n || p.note || '';
  if (note) { noteBox.hidden = false; noteTxt.textContent = note; }
  else noteBox.hidden = true;

  // Choose button
  const lbChoose = document.getElementById('lb-choose');
  if (lbChoose) {
    const r = review.r || (p.selected ? 'selected' : '');
    lbChoose.textContent = r === 'selected' ? '✓ Đã chọn' : 'Chọn';
    lbChoose.className = 'lb-pill primary' + (r === 'selected' ? ' chosen' : '');
  }
  const lbLater = document.getElementById('lb-later');
  if (lbLater) {
    const r = review.r || '';
    lbLater.className = 'lb-pill' + (r === 'later' ? ' chosen' : '');
  }

  // Show/hide actions based on context
  const acts = document.getElementById('lb-acts');
  if (acts) acts.hidden = S.lbContext === 'detail';

  // Download
  const dlBtn = document.getElementById('lb-dl');
  if (dlBtn) dlBtn.hidden = !(album?.allowDownload ?? true);
}

function lbNavigate(dir) {
  S.lbIdx = (S.lbIdx + dir + S.lbPhotos.length) % S.lbPhotos.length;
  renderLightbox();
}

/* ─────────────────────────────────────────────
   19. COVER MODAL
   ───────────────────────────────────────────── */

function openCoverModal() {
  const album = getDetailAlbum();
  if (!album) return;
  const grid = document.getElementById('cover-pick-grid');
  if (!grid) return;
  document.getElementById('cover-step1').hidden = false;
  document.getElementById('cover-step2').hidden = true;
  document.getElementById('cover-save').hidden = true;
  document.getElementById('cover-back').hidden = true;

  const photos = (album.photos || []).slice(0, 100);
  grid.innerHTML = photos.map(p =>
    `<div class="cover-pick-thumb" data-id="${p.id}"><img src="${photoUrl(p, 's200')}" loading="lazy"></div>`
  ).join('');

  grid.querySelectorAll('[data-id]').forEach(el => {
    el.onclick = () => {
      const album = getDetailAlbum();
      if (!album) return;
      album.cover = el.dataset.id;
      album.lastActivity = Date.now();
      saveAlbumsLocal();
      apiPushAlbum(album).catch(() => {});
      const cov = document.getElementById('ad-cover');
      const cp = (album.photos || []).find(x => x.id === el.dataset.id);
      if (cov) cov.src = photoUrl(cp, 's400');
      closeModal('cover-modal');
      toast('✓ Đã lưu ảnh bìa');
    };
  });
  openModal('cover-modal');
}

/* ─────────────────────────────────────────────
   20. EDIT ALBUM MODAL
   ───────────────────────────────────────────── */

let _editAlbumId = null;
function openEditModal(album) {
  _editAlbumId = album.id;
  document.getElementById('ed-name').value = album.name || '';
  document.getElementById('ed-days').value = album.deadlineDays ?? '';
  document.getElementById('ed-max').value = album.maxCount ?? '';
  document.getElementById('ed-notes').checked = album.allowNotes ?? true;
  document.getElementById('ed-download').checked = album.allowDownload ?? false;
  document.getElementById('ed-lock-on').checked = !!album.lockPhone;
  document.getElementById('ed-lock-phone').value = album.lockPhone || '';
  document.getElementById('ed-lock-phone').hidden = !album.lockPhone;
  document.getElementById('ed-internal').value = album.internalNotes || '';
  openModal('edit-modal');
}

function handleEditSave(e) {
  e.preventDefault();
  const album = S.albums.find(a => a.id === _editAlbumId);
  if (!album) return;
  album.name = document.getElementById('ed-name').value.trim() || album.name;
  album.deadlineDays = parseInt(document.getElementById('ed-days').value) || null;
  album.maxCount = parseInt(document.getElementById('ed-max').value) || null;
  album.allowNotes = document.getElementById('ed-notes').checked;
  album.allowDownload = document.getElementById('ed-download').checked;
  const lockOn = document.getElementById('ed-lock-on').checked;
  album.lockPhone = lockOn ? document.getElementById('ed-lock-phone').value.trim() : null;
  album.internalNotes = document.getElementById('ed-internal').value.trim();
  album.lastActivity = Date.now();
  saveAlbumsLocal();
  apiPushAlbum(album).catch(() => {});
  closeModal('edit-modal');
  renderCurrentPage();
  if (S.page === 'albumdetail' && S.detailId === album.id) renderDetailFull(album);
  toast('✓ Đã lưu thay đổi');
}

/* ─────────────────────────────────────────────
   21. SHARE MODAL
   ───────────────────────────────────────────── */

function openShareModal(album) {
  const base = location.origin + location.pathname;
  const link = `${base}?al=${album.id}`;
  document.getElementById('share-link').value = link;
  // Warn if album has no Drive photos
  const hasOnlinePhotos = (album.photos || []).some(p => p.id);
  document.getElementById('share-warn').hidden = hasOnlinePhotos;
  openModal('share-modal');
}

function copyShareLink() {
  const input = document.getElementById('share-link');
  navigator.clipboard.writeText(input.value).then(() => toast('✓ Đã sao chép link'));
}

/* ─────────────────────────────────────────────
   22. CLIENT PICKER (guest view via ?al=ID)
   ───────────────────────────────────────────── */

async function initClientPicker() {
  // Determine album source
  const params = new URLSearchParams(location.search);
  const al = params.get('al');
  const hash = location.hash;

  if (!al && !hash.startsWith('#a=')) return false; // Not a client link

  let album;
  if (al) {
    // Server-synced album
    try {
      album = await apiGetAlbum(al);
    } catch (e) {
      showClientError('Không tìm thấy album: ' + e.message);
      return true;
    }
    if (!album) { showClientError('Album không tồn tại.'); return true; }
  } else {
    // Embedded hash album
    try {
      const b64 = hash.slice(3);
      album = JSON.parse(atob(b64));
    } catch {
      showClientError('Link album không hợp lệ.');
      return true;
    }
  }

  // Phone gate
  if (album.lockPhone) {
    const gateOk = await runPhoneGate(album.lockPhone);
    if (!gateOk) return true;
  }

  S.clientAlbum = album;
  // Restore saved review from localStorage
  const saved = lsGet('lmReview_' + album.id);
  S.clientReview = saved || {};
  // Seed from album.photos review data
  (album.photos || []).forEach(p => {
    if (!S.clientReview[p.id]) {
      S.clientReview[p.id] = { r: p.review || (p.selected ? 'selected' : ''), n: p.note || '' };
    }
  });

  showClientView(album);
  return true;
}

function showClientError(msg) {
  const errEl = document.getElementById('client-error');
  if (errEl) {
    errEl.removeAttribute('hidden');
    const msgEl = document.getElementById('cerr-msg');
    if (msgEl) msgEl.textContent = msg;
  }
  document.getElementById('client-loading')?.setAttribute('hidden', '');
  document.getElementById('client')?.removeAttribute('hidden');
  document.getElementById('app')?.setAttribute('hidden', '');
}

function runPhoneGate(expectedPhone) {
  return new Promise(resolve => {
    document.getElementById('client-gate')?.classList.remove('hidden');
    document.getElementById('client')?.removeAttribute('hidden');
    document.getElementById('client-loading')?.classList.add('hidden');
    const submit = document.getElementById('gate-submit');
    const input = document.getElementById('gate-input');
    const errEl = document.getElementById('gate-error');
    const handler = () => {
      const val = (input?.value || '').replace(/\D/g, '');
      const exp = (expectedPhone || '').replace(/\D/g, '');
      if (val === exp) {
        document.getElementById('client-gate')?.classList.add('hidden');
        resolve(true);
      } else {
        if (errEl) errEl.textContent = 'SĐT không đúng. Thử lại.';
      }
    };
    submit?.addEventListener('click', handler, { once: false });
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') handler(); });
  });
}

function showClientView(album) {
  document.getElementById('app')?.setAttribute('hidden', '');
  const clientEl = document.getElementById('client');
  clientEl?.removeAttribute('hidden');
  document.getElementById('client-loading')?.classList.add('hidden');
  document.getElementById('client-error')?.classList.add('hidden');

  // Cover
  const cover = albumCoverUrl(album);
  const coverEl = document.getElementById('client-cover');
  if (cover && coverEl) {
    coverEl.hidden = false;
    document.getElementById('client-cover-img').src = cover;
    document.getElementById('client-cover-title').textContent = album.name || 'Album của bạn';
    const max = album.maxCount;
    document.getElementById('cc-max').textContent = max ? `Bạn được chọn tối đa ${max} ảnh` : '';
    document.getElementById('cc-total').textContent = `Tổng ảnh: ${(album.photos || []).length}`;
  }

  // Folder tabs
  renderClientFolders(album);
  renderClientGrid();
  updateClientBar();

  // Status bar visibility
  document.getElementById('selbar')?.classList.remove('hidden');
}

function renderClientFolders(album) {
  const el = document.getElementById('cfolders');
  if (!el) return;
  const galleries = album.galleries || [];
  // Only show tabs if there are actual galleries
  if (!galleries.length) { el.innerHTML = ''; S.clientGalleryId = null; return; }

  const defaultCount = (album.photos || []).filter(p => !p.galleryId).length;
  const tabs = [];
  if (defaultCount > 0) tabs.push({ id: null, name: `Ảnh gốc (${defaultCount})` });
  galleries.forEach(g => {
    const cnt = (album.photos || []).filter(p => p.galleryId === g.id).length;
    tabs.push({ id: g.id, name: `${g.name} (${cnt})` });
  });

  el.innerHTML = tabs.map((t, i) =>
    `<button class="cfolder ${i === 0 ? 'active' : ''}" data-cf="${i}" data-gid="${t.id || ''}">${t.name}</button>`
  ).join('');

  // Default to first tab
  S.clientGalleryId = tabs[0]?.id || null;

  el.querySelectorAll('[data-cf]').forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll('[data-cf]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.clientGalleryId = btn.dataset.gid || null;
      S.clientPage = 1;
      renderClientGrid();
    };
  });
}

function clientFilteredPhotos() {
  const album = S.clientAlbum;
  if (!album) return [];
  let photos = album.photos || [];
  // Gallery filter
  if (typeof S.clientGalleryId !== 'undefined' && (album.galleries || []).length > 0) {
    photos = photos.filter(p =>
      S.clientGalleryId ? (p.galleryId === S.clientGalleryId) : !p.galleryId
    );
  }
  // Status filter
  const filter = S.clientFilter;
  if (filter === 'selected')  photos = photos.filter(p => (S.clientReview[p.id]?.r || '') === 'selected');
  else if (filter === 'later') photos = photos.filter(p => (S.clientReview[p.id]?.r || '') === 'later');
  else if (filter === 'skipped') photos = photos.filter(p => (S.clientReview[p.id]?.r || '') === 'skip');
  else if (filter === 'unseen') photos = photos.filter(p => !(S.clientReview[p.id]?.r));
  if (!S.clientSortAsc) photos = [...photos].reverse();
  return photos;
}

function renderClientGrid() {
  const grid = document.getElementById('photo-grid');
  if (!grid || !S.clientAlbum) return;

  const photos = clientFilteredPhotos();
  const total = photos.length;
  const ps = S.clientPageSize;
  const page = S.clientPage;
  const start = (page - 1) * ps;
  const pagePhotos = photos.slice(start, start + ps);

  // Pager info
  document.getElementById('cpage-info').textContent = total
    ? `Ảnh ${start + 1} - ${Math.min(start + ps, total)}, Tổng ${total}` : 'Không có ảnh';
  document.getElementById('cpage-cur').textContent = `Trang ${page}/${Math.ceil(total / ps) || 1}`;
  document.getElementById('cpage-prev').disabled = page <= 1;
  document.getElementById('cpage-next').disabled = start + ps >= total;

  grid.className = 'photo-grid ' + S.clientView;
  grid.innerHTML = pagePhotos.map((p, i) => {
    const r = S.clientReview[p.id]?.r || '';
    const note = S.clientReview[p.id]?.n || '';
    const statusCls = r === 'selected' ? 'c-selected' : r === 'later' ? 'c-later' : r === 'skip' ? 'c-skip' : '';
    return `<div class="photo-item ${statusCls}" data-idx="${i}" data-id="${p.id}">
      <div class="photo-img-wrap">
        <img src="${photoUrl(p, 's600')}" alt="${p.name || ''}" loading="lazy">
        ${note ? `<div class="note-dot">📝</div>` : ''}
      </div>
      <div class="photo-actions">
        <button class="pa-btn ${r === 'selected' ? 'active' : ''}" data-action="select" data-id="${p.id}">
          ${r === 'selected' ? '✓ Đã chọn' : 'Chọn ảnh'}
        </button>
        <button class="pa-btn later ${r === 'later' ? 'active' : ''}" data-action="later" data-id="${p.id}">Xem lại</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const pid = btn.dataset.id;
      const action = btn.dataset.action;
      clientSetReview(pid, action === 'select' ? (S.clientReview[pid]?.r === 'selected' ? '' : 'selected') : 'later');
    };
  });
  grid.querySelectorAll('[data-idx]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      const globalIdx = start + parseInt(el.dataset.idx);
      openLightboxClient(photos, globalIdx);
    });
  });
}

function clientSetReview(photoId, r) {
  const prev = S.clientReview[photoId] || {};
  S.clientReview[photoId] = { ...prev, r };
  const album = S.clientAlbum;
  if (album) {
    const maxCount = album.maxCount;
    if (maxCount && r === 'selected') {
      const selCount = Object.values(S.clientReview).filter(v => v.r === 'selected').length;
      if (selCount > maxCount) {
        S.clientReview[photoId].r = prev.r || '';
        toast(`⚠ Chỉ được chọn tối đa ${maxCount} ảnh`);
        return;
      }
    }
  }
  // Save locally
  try { localStorage.setItem('lmReview_' + (album?.id || ''), JSON.stringify(S.clientReview)); } catch {}
  // Schedule server save
  if (album?.id) {
    const status = 'choosing';
    GuestSaveManager.schedule(album.id, S.clientReview, status);
  }
  updateClientBar();
  renderClientGrid();
}

function updateClientBar() {
  const album = S.clientAlbum;
  const selCount = Object.values(S.clientReview).filter(v => v.r === 'selected').length;
  document.getElementById('sel-count').textContent = selCount;
  const maxEl = document.getElementById('sel-max');
  if (maxEl) maxEl.textContent = album?.maxCount ? ` / ${album.maxCount}` : '';
  const bar = document.getElementById('progress-bar');
  if (bar && album?.maxCount) bar.style.width = Math.min(100, selCount / album.maxCount * 100) + '%';

  // cc-sel
  const ccSel = document.getElementById('cc-sel');
  if (ccSel) ccSel.textContent = `Đã chọn: ${selCount}`;
}

async function handleFinishBtn() {
  const album = S.clientAlbum;
  if (!album?.id) return;
  const selCount = Object.values(S.clientReview).filter(v => v.r === 'selected').length;
  if (!selCount) { toast('⚠ Bạn chưa chọn ảnh nào'); return; }
  if (!confirm(`Gửi ${selCount} ảnh đã chọn về studio?`)) return;

  const btn = document.getElementById('finish-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Đang gửi…'; }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/album?id=${encodeURIComponent(album.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ review: S.clientReview, status: 'done' }),
        });
        if (res.ok) {
          document.getElementById('sum-count').textContent = selCount;
          openModal('summary-modal');
          return;
        }
      } catch {}
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }
    toast('⚠ Không thể gửi. Kiểm tra mạng và thử lại.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Gửi hậu kỳ'; }
  }
}

/* ─────────────────────────────────────────────
   23. DRIVE CONNECT UI
   ───────────────────────────────────────────── */

async function checkDriveStatus() {
  try {
    const res = await apiFetch('/api/drive-token?status=1');
    if (res && res.ok) {
      const data = await res.json();
      updateDriveDot(data.connected, data.email);
      return data.connected;
    }
  } catch {}
  updateDriveDot(false, '');
  return false;
}

function updateDriveDot(connected, email) {
  S.driveConnected = connected;
  S.driveEmail = email || '';
  if (S.page === 'settings') renderSettings();
  const dot = document.getElementById('sb-drive-dot');
  const title = document.getElementById('sb-drive-title');
  const sub = document.getElementById('sb-drive-sub');
  if (dot) dot.className = 'dot ' + (connected ? 'green' : 'orange');
  if (title) title.textContent = 'Google Drive';
  if (sub) sub.textContent = connected ? (email || 'Đã kết nối') : 'Chưa kết nối';

  // Also update modal
  const mDot = document.getElementById('drive-modal-dot');
  const mTxt = document.getElementById('drive-modal-text');
  if (mDot) mDot.className = 'ddot ' + (connected ? 'green' : '');
  if (mTxt) mTxt.textContent = connected ? `Đã kết nối: ${email || ''}` : 'Chưa liên kết tài khoản nào.';
}

async function connectStudioDrive() {
  try {
    const res = await apiFetch('/api/google-auth?action=state', { method: 'POST' });
    if (!res || !res.ok) {
      const d = await res?.json().catch(() => ({}));
      toast('⚠ ' + (d?.error || 'Không kết nối được'));
      return;
    }
    const { state } = await res.json();
    const popup = window.open(`/api/google-auth?action=start&state=${state}`, 'driveAuth', 'width=520,height=620');
    const check = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(check);
        await checkDriveStatus();
      }
    }, 1000);
  } catch (e) { toast('⚠ ' + e.message); }
}

/* ─────────────────────────────────────────────
   24. UI VIEWS (show/hide main areas)
   ───────────────────────────────────────────── */

function showLogin() {
  document.getElementById('login-view')?.removeAttribute('hidden');
  document.getElementById('app')?.setAttribute('hidden', '');
  document.getElementById('client')?.setAttribute('hidden', '');
}

/** Áp dụng phân quyền: ẩn/hiện UI theo role */
function applyRBAC() {
  const role = S.auth?.role || 'viewer';

  // Sidebar nav items
  const navProgress = document.querySelector('#sb-nav [data-page="progress"]');
  const navTrash    = document.querySelector('#sb-nav [data-page="trash"]');
  const navSettings = document.querySelector('#sb-nav [data-page="settings"]');
  if (navProgress) navProgress.hidden = !can('progress', 'view');
  if (navTrash)    navTrash.hidden    = !can('trash', 'view');
  if (navSettings) navSettings.hidden = !can('settings', 'view');

  // New album button
  const newAlbumBtn  = document.getElementById('new-album-btn');
  const emptyNewBtn  = document.getElementById('empty-new-btn');
  const dashNewBtn   = document.getElementById('dash-new-btn');
  if (newAlbumBtn) newAlbumBtn.hidden = !can('album', 'create');
  if (emptyNewBtn) emptyNewBtn.hidden = !can('album', 'create');
  if (dashNewBtn)  dashNewBtn.hidden  = !can('album', 'create');

  // Trash empty button
  const trashEmptyBtn = document.getElementById('trash-empty');
  if (trashEmptyBtn) trashEmptyBtn.hidden = !can('trash', 'empty');

  // Drive button in sidebar — visible to all, but only owner can open modal
  // (handled in click handler)

  // Role badge in sidebar
  const roleEl = document.getElementById('sb-role');
  if (roleEl) {
    roleEl.textContent = roleLabel(role);
    roleEl.className = 'role-badge role-' + role;
  }

  // data-perm attributes (generic approach for future use)
  document.querySelectorAll('[data-perm]').forEach(el => {
    const [res, action] = (el.dataset.perm || '').split('.');
    if (res && action) el.hidden = !can(res, action);
  });
}

/** Hiển thị modal ma trận phân quyền */
function openPermissionsModal() {
  // Build the permission matrix table dynamically
  const modal = document.getElementById('perms-modal');
  if (!modal) {
    // Create modal on first call
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'perms-modal';
    m.innerHTML = `
      <div class="modal-card wide">
        <div class="modal-head">
          <h3>Phân quyền nhân sự</h3>
          <button class="icon-btn" id="perms-close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body" id="perms-body"></div>
        <div class="modal-foot">
          <p class="hint" style="flex:1;margin:0;font-size:12px">Thay đổi role: chỉnh cột E trong Google Sheet nhân sự (owner / editor / viewer)</p>
          <button class="btn ghost" id="perms-ok">Đóng</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    document.getElementById('perms-close').onclick = () => closeModal('perms-modal');
    document.getElementById('perms-ok').onclick = () => closeModal('perms-modal');
    m.addEventListener('click', e => { if (e.target === m) closeModal('perms-modal'); });
  }

  const ROWS = [
    { label: 'Tạo album mới',       res: 'album',    act: 'create'  },
    { label: 'Sửa thông tin album', res: 'album',    act: 'edit'    },
    { label: 'Chuyển vào thùng rác',res: 'album',    act: 'trash'   },
    { label: 'Xoá vĩnh viễn',       res: 'album',    act: 'delete'  },
    { label: 'Tạo / xoá gallery',   res: 'gallery',  act: 'create'  },
    { label: 'Tải ảnh lên Drive',   res: 'drive',    act: 'upload'  },
    { label: 'Kết nối Drive studio',res: 'drive',    act: 'connect' },
    { label: 'Xem tiến độ hậu kỳ', res: 'progress', act: 'view'    },
    { label: 'Xem thùng rác',       res: 'trash',    act: 'view'    },
    { label: 'Dọn sạch thùng rác',  res: 'trash',    act: 'empty'   },
    { label: 'Xem cài đặt',         res: 'settings', act: 'view'    },
  ];

  const tick  = '<span style="color:#22c55e;font-size:18px">✓</span>';
  const cross = '<span style="color:#e5e7eb;font-size:18px">✕</span>';
  const myRole = S.auth?.role || 'viewer';

  const rows = ROWS.map(r => {
    const vals = ['owner','editor','viewer'].map(role => {
      const ok = !!(PERMISSIONS[role]?.[r.res]?.[r.act]);
      const isMe = role === myRole;
      return `<td style="text-align:center;${isMe?'background:var(--surface2,#f5f5f5)':''}">${ok ? tick : cross}</td>`;
    }).join('');
    return `<tr><td style="padding:8px 12px;font-size:13px">${r.label}</td>${vals}</tr>`;
  }).join('');

  document.getElementById('perms-body').innerHTML = `
    <p style="margin:0 0 14px;color:var(--muted);font-size:13px">Role hiện tại của bạn: <strong>${roleLabel(myRole)}</strong> — cột được tô là quyền của bạn.</p>
    <table class="perms-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="font-size:13px;font-weight:600">
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border)">Tính năng</th>
          <th style="text-align:center;padding:8px;border-bottom:1px solid var(--border);${myRole==='owner'?'background:var(--surface2)':''}">👑 Chủ studio</th>
          <th style="text-align:center;padding:8px;border-bottom:1px solid var(--border);${myRole==='editor'?'background:var(--surface2)':''}">🎨 Nhân sự chính</th>
          <th style="text-align:center;padding:8px;border-bottom:1px solid var(--border);${myRole==='viewer'?'background:var(--surface2)':''}">👁 Nhân sự phụ</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="perms-guide" style="margin-top:18px;padding:14px;background:var(--surface2,#f9f9f9);border-radius:8px;font-size:13px;line-height:1.7">
      <strong>Cách thay đổi role:</strong><br>
      Mở Google Sheet nhân sự → Cột E → Đổi thành <code>owner</code>, <code>editor</code>, hoặc <code>viewer</code> → Lưu lại → Nhân sự đăng xuất và đăng nhập lại.
    </div>`;

  openModal('perms-modal');
}

function showApp() {
  document.getElementById('login-view')?.setAttribute('hidden', '');
  document.getElementById('client')?.setAttribute('hidden', '');
  const appEl = document.getElementById('app');
  appEl?.removeAttribute('hidden');

  // Populate sidebar
  document.getElementById('sb-name').textContent = S.auth?.name || '';
  document.getElementById('sb-av').textContent = (S.auth?.name || '?')[0].toUpperCase();

  // Apply RBAC: show/hide UI elements based on role
  applyRBAC();

  // Load local albums
  loadAlbumsLocal();
  restoreActiveUploads();
  renderTrashBadge();
  renderDashboard();
  showPage('dashboard');
  setHash('dashboard');

  // Start sync
  SyncManager.refresh();
  SyncManager.start();
  checkDriveStatus();
  // Init upload manager (BroadcastChannel)
  UploadManager.init();
}

/* ─────────────────────────────────────────────
   25. THEME TOGGLE
   ───────────────────────────────────────────── */

function applyTheme(t) {
  S.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  lsSet(THEME_KEY, t);
}

function toggleTheme() {
  applyTheme(S.theme === 'light' ? 'dark' : 'light');
}

/* ─────────────────────────────────────────────
   26. SAVE TIMER (detail auto-save, proper async)
   ───────────────────────────────────────────── */

const AutoSave = {
  _timer: null,
  _pending: false,

  schedule() {
    this._pending = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._run(), 2000);
  },

  async _run() {
    if (!this._pending) return;
    this._pending = false;
    const album = getDetailAlbum();
    if (!album) return;
    saveAlbumsLocal();
    try { await apiPushAlbum(album); } catch {}
  },
};

/* ─────────────────────────────────────────────
   27. INITIALISATION (single entry point)
   ───────────────────────────────────────────── */

/* ─────────────────────────────────────────────
   EXPORT → GOOGLE SHEET
   ───────────────────────────────────────────── */
async function exportToSheet() {
  const btn = document.getElementById('export-sheet-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Đang xuất…'; }
  try {
    const res = await apiFetch('/api/export-sheet', { method: 'POST' });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) { toast('⚠ ' + (data.error || 'Xuất thất bại')); return; }
    toast(`✓ Đã xuất ${data.exported} album ra Google Sheet`);
    // Open sheet in new tab
    if (data.sheetUrl) window.open(data.sheetUrl, '_blank');
  } catch (e) {
    toast('⚠ ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Xuất ra Sheet`; }
  }
}

async function init() {
  // Download resilience: lh3 CDN occasionally 404/429s. Fall back to Drive's own
  // thumbnail endpoint once per <img> before giving up, so photos still render.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.fb) return;
    if (!/lh3\.googleusercontent\.com\/d\//.test(img.src)) return;
    const m = img.src.match(/\/d\/([^=]+)=?([sw]\d+)?/);
    if (!m) return;
    img.dataset.fb = '1';
    const sz = m[2] && m[2][0] === 'w' ? m[2] : 'w' + (m[2] ? m[2].slice(1) : '1600');
    img.src = `https://drive.google.com/thumbnail?id=${m[1]}&sz=${sz}`;
  }, true); // capture — img error events don't bubble

  // Warn before closing/refreshing while photos are uploading.
  window.addEventListener('beforeunload', (e) => {
    if (UploadManager.activeCount > 0) {
      e.preventDefault();
      e.returnValue = 'Đang tải ảnh lên, nếu tắt tab ảnh sẽ bị mất. Bạn có chắc muốn thoát?';
    }
  });

  // Apply saved theme
  const savedTheme = lsGet(THEME_KEY) || 'light';
  applyTheme(savedTheme);

  // Theme toggle buttons (both app and client)
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.onclick = toggleTheme;
  });

  // Check if this is a client link
  const isClientLink = location.search.includes('al=') || location.hash.startsWith('#a=');
  if (isClientLink) {
    const handled = await initClientPicker();
    if (handled) {
      wireClientEvents();
      return;
    }
  }

  // Wire login form
  document.getElementById('login-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const user = document.getElementById('lg-user').value.trim();
    const pass = document.getElementById('lg-pass').value;
    const btn = e.target.querySelector('[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang đăng nhập…'; }
    try {
      await doLogin(user, pass);
      showApp();
    } catch (err) {
      const errEl = document.getElementById('login-error') || document.getElementById('lg-error');
      if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
      else toast('⚠ ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Đăng nhập'; }
    }
  });

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', () => {
    if (confirm('Đăng xuất?')) doLogout(true);
  });

  // Permissions modal
  document.getElementById('sb-perms')?.addEventListener('click', openPermissionsModal);

  // Nav
  document.querySelectorAll('#sb-nav [data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      showPage(page);
      setHash(page);
      renderCurrentPage();
    });
  });

  // Albums view toggle (grid / list / kanban / masonry)
  document.querySelectorAll('#alb-viewmode [data-v]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.albumsView = btn.dataset.v;
      document.querySelectorAll('#alb-viewmode [data-v]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderAlbumsList();
    });
  });

  // Albums sort
  document.getElementById('alb-sort')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    S.albumSort = btn.dataset.sort;
    document.querySelectorAll('#alb-sort button').forEach(b => b.classList.toggle('active', b === btn));
    renderAlbumsList();
  });

  // Albums search + month filter
  document.getElementById('alb-q')?.addEventListener('input', debounce(() => renderAlbumsList(), 200));
  document.getElementById('alb-month')?.addEventListener('change', () => renderAlbumsList());

  // Settings page actions (reuse existing handlers)
  document.getElementById('settings-drive-connect')?.addEventListener('click', () => {
    if (!can('drive', 'connect')) { toast('⚠ Chỉ chủ studio mới kết nối được Drive'); return; }
    connectStudioDrive();
  });
  document.getElementById('settings-sheet-export')?.addEventListener('click', () => exportToSheet());
  document.getElementById('settings-open-perms')?.addEventListener('click', () => {
    showPage('perms'); setHash('perms');
  });

  // Progress view toggle
  document.querySelectorAll('#prog-view [data-v]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.progView = btn.dataset.v;
      document.querySelectorAll('#prog-view [data-v]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderProgressPage();
    });
  });

  // Progress filters
  document.getElementById('pg-fdate')?.addEventListener('change', () => renderProgressPage());
  document.getElementById('pg-ftype')?.addEventListener('change', () => renderProgressPage());
  document.getElementById('pg-fclear')?.addEventListener('click', () => {
    const fd = document.getElementById('pg-fdate');
    if (fd) fd.value = '';
    renderProgressPage();
  });

  // New album
  document.getElementById('new-album-btn')?.addEventListener('click', openCreateModal);
  document.getElementById('empty-new-btn')?.addEventListener('click', openCreateModal);
  document.getElementById('dash-new-btn')?.addEventListener('click', openCreateModal);

  // Create modal
  document.getElementById('create-close')?.addEventListener('click', () => closeModal('create-modal'));
  document.getElementById('create-cancel')?.addEventListener('click', () => closeModal('create-modal'));
  document.getElementById('create-form')?.addEventListener('submit', handleCreateSubmit);

  // Source toggle in create modal
  document.querySelectorAll('#src-seg [data-src]').forEach(btn => {
    btn.addEventListener('click', () => {
      _createSrc = btn.dataset.src;
      document.querySelectorAll('#src-seg [data-src]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pane-upload').style.display = _createSrc === 'upload' ? '' : 'none';
      document.getElementById('pane-drive').hidden = _createSrc !== 'drive';
    });
  });

  // File picker in create modal
  document.getElementById('dropzone')?.addEventListener('click', () => document.getElementById('file-input')?.click());
  document.getElementById('file-input')?.addEventListener('change', e => {
    _createFiles = [...e.target.files];
    const info = document.getElementById('pick-info');
    if (info) { info.hidden = false; info.textContent = `${_createFiles.length} ảnh đã chọn`; }
  });
  const dz = document.getElementById('dropzone');
  if (dz) {
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      _createFiles = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
      const info = document.getElementById('pick-info');
      if (info) { info.hidden = false; info.textContent = `${_createFiles.length} ảnh đã chọn`; }
    });
  }

  // Lock phone toggle in create
  document.getElementById('lock-on')?.addEventListener('change', e => {
    document.getElementById('lock-phone').hidden = !e.target.checked;
    document.getElementById('lock-hint').hidden = !e.target.checked;
  });

  // Edit modal
  document.getElementById('edit-close')?.addEventListener('click', () => closeModal('edit-modal'));
  document.getElementById('edit-cancel')?.addEventListener('click', () => closeModal('edit-modal'));
  document.getElementById('edit-form')?.addEventListener('submit', handleEditSave);
  document.getElementById('ed-lock-on')?.addEventListener('change', e => {
    document.getElementById('ed-lock-phone').hidden = !e.target.checked;
  });

  // Share modal
  document.getElementById('share-close')?.addEventListener('click', () => closeModal('share-modal'));
  document.getElementById('share-copy')?.addEventListener('click', copyShareLink);
  document.getElementById('share-open')?.addEventListener('click', () => {
    window.open(document.getElementById('share-link').value, '_blank');
  });

  // Trash
  document.getElementById('trash-empty')?.addEventListener('click', async () => {
    if (!S.trashedAlbums.length) return;
    if (!confirm('Xoá vĩnh viễn tất cả album trong thùng rác?')) return;
    await Promise.all(S.trashedAlbums.map(a => apiDeleteAlbum(a.id, true).catch(() => {})));
    S.trashedAlbums = [];
    saveAlbumsLocal();
    renderTrashPage();
    renderTrashBadge();
  });

  // Detail back
  document.getElementById('ad-back')?.addEventListener('click', () => {
    S.detailId = null;
    history.back();
    showPage('albums');
    renderAlbumsList();
  });

  // Detail actions
  document.getElementById('ad-sync')?.addEventListener('click', syncAlbumWithDrive);
  document.getElementById('ad-preview')?.addEventListener('click', () => {
    const album = getDetailAlbum();
    if (album) window.open(`?al=${album.id}`, '_blank');
  });
  document.getElementById('ad-share')?.addEventListener('click', () => {
    const album = getDetailAlbum();
    if (album) openShareModal(album);
  });
  document.getElementById('ad-change-cover')?.addEventListener('click', openCoverModal);

  // Detail view toggle
  document.querySelectorAll('#ad-view [data-v]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.detailView = btn.dataset.v;
      document.querySelectorAll('#ad-view [data-v]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDetailGrid();
    });
  });

  // Detail sort
  document.getElementById('ad-sort')?.addEventListener('click', () => {
    S.detailSortAsc = !S.detailSortAsc;
    document.getElementById('ad-sort').textContent = S.detailSortAsc ? 'A→Z' : 'Z→A';
    renderDetailGrid();
  });

  // Detail pick mode
  document.getElementById('ad-pick')?.addEventListener('click', () => {
    S.detailPickMode = !S.detailPickMode;
    S.detailPicked.clear();
    updatePickBar();
    renderDetailGrid();
  });
  document.getElementById('ad-pick-cancel')?.addEventListener('click', () => {
    S.detailPickMode = false;
    S.detailPicked.clear();
    updatePickBar();
    renderDetailGrid();
  });
  document.getElementById('ad-pick-all')?.addEventListener('click', () => {
    const album = getDetailAlbum();
    if (!album) return;
    detailPhotos(album).forEach(p => S.detailPicked.add(p.id));
    updatePickBar();
    renderDetailGrid();
  });
  document.getElementById('ad-pick-del')?.addEventListener('click', async () => {
    if (!S.detailPicked.size) return;
    if (!confirm(`Xoá ${S.detailPicked.size} ảnh đã chọn? (Không xoá trên Drive)`)) return;
    const album = getDetailAlbum();
    if (!album) return;
    album.photos = (album.photos || []).filter(p => !S.detailPicked.has(p.id));
    album.lastActivity = Date.now();
    S.detailPicked.clear();
    S.detailPickMode = false;
    saveAlbumsLocal();
    apiPushAlbum(album).catch(() => {});
    updatePickBar();
    renderDetailGrid();
    toast('✓ Đã xoá ảnh');
  });

  // Detail add set
  document.getElementById('ad-add-set')?.addEventListener('click', () => {
    const name = prompt('Tên album (VD: Concept 1, Ảnh hậu kỳ, Lễ cưới):');
    if (!name) return;
    const album = getDetailAlbum();
    if (!album) return;
    if (!album.galleries) album.galleries = [];
    const newGallery = { id: uid(), name: name.trim(), order: album.galleries.length, folderId: null };
    album.galleries.push(newGallery);
    album.lastActivity = Date.now();
    saveAlbumsLocal();
    apiPushAlbum(album).catch(() => {});
    renderDetailSets(album);
    toast(`✓ Đã tạo album "${name.trim()}"`);
  });

  // Drive connect
  document.getElementById('sb-drive')?.addEventListener('click', () => {
    if (can('drive', 'connect')) openModal('drive-modal');
    else toast('Chỉ chủ studio (owner) mới có thể kết nối Drive');
  });
  document.getElementById('drive-studio-connect')?.addEventListener('click', connectStudioDrive);
  document.getElementById('drive-close')?.addEventListener('click', () => closeModal('drive-modal'));
  document.getElementById('drive-done')?.addEventListener('click', () => closeModal('drive-modal'));

  // Export to Google Sheet
  document.getElementById('export-sheet-btn')?.addEventListener('click', exportToSheet);

  // Cover modal
  document.getElementById('cover-x')?.addEventListener('click', () => closeModal('cover-modal'));
  document.getElementById('cover-cancel')?.addEventListener('click', () => closeModal('cover-modal'));

  // Lightbox
  document.getElementById('lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('lb-prev')?.addEventListener('click', () => lbNavigate(-1));
  document.getElementById('lb-next')?.addEventListener('click', () => lbNavigate(1));
  document.addEventListener('keydown', e => {
    if (!document.getElementById('lightbox')?.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbNavigate(-1);
    if (e.key === 'ArrowRight') lbNavigate(1);
  });
  document.getElementById('lb-copy')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (p) navigator.clipboard.writeText(p.name || p.id).then(() => toast('✓ Đã chép tên'));
  });

  // Dup modal
  document.getElementById('dup-cancel')?.addEventListener('click', () => closeModal('dup-modal'));

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });

  // Hash routing
  window.addEventListener('popstate', navigateFromHash);

  // Init detail dropzone
  initDetailDropzone();

  // Save on tab/window close
  window.addEventListener('pagehide', () => {
    const album = getDetailAlbum();
    if (album) { saveAlbumsLocal(); }
  });

  // Verify session and show app
  await verifySessionAndStart();
}

/* ─────────────────────────────────────────────
   28. CLIENT EVENTS
   ───────────────────────────────────────────── */

function wireClientEvents() {
  // Filter tabs
  document.querySelectorAll('.ctab[data-f]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.clientFilter = btn.dataset.f;
      S.clientPage = 1;
      document.querySelectorAll('.ctab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderClientGrid();
    });
  });

  // Pager
  document.getElementById('cpage-prev')?.addEventListener('click', () => {
    if (S.clientPage > 1) { S.clientPage--; renderClientGrid(); window.scrollTo(0, 0); }
  });
  document.getElementById('cpage-next')?.addEventListener('click', () => {
    S.clientPage++;
    renderClientGrid();
    window.scrollTo(0, 0);
  });

  // Sort toggle
  document.getElementById('cl-sort')?.addEventListener('click', () => {
    S.clientSortAsc = !S.clientSortAsc;
    S.clientPage = 1;
    renderClientGrid();
  });

  // View toggle
  document.querySelectorAll('#cl-view [data-v]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.clientView = btn.dataset.v;
      document.querySelectorAll('#cl-view [data-v]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderClientGrid();
    });
  });

  // Finish / send
  document.getElementById('finish-btn')?.addEventListener('click', handleFinishBtn);

  // Summary close
  document.getElementById('sum-close')?.addEventListener('click', () => closeModal('summary-modal'));

  // Note modal
  let _notePid = null;
  document.getElementById('note-x')?.addEventListener('click', () => closeModal('note-modal'));
  document.getElementById('note-cancel')?.addEventListener('click', () => closeModal('note-modal'));
  document.getElementById('note-save')?.addEventListener('click', () => {
    if (!_notePid) return;
    const txt = document.getElementById('note-text').value.trim();
    S.clientReview[_notePid] = { ...(S.clientReview[_notePid] || {}), n: txt };
    try { localStorage.setItem('lmReview_' + (S.clientAlbum?.id || ''), JSON.stringify(S.clientReview)); } catch {}
    if (S.clientAlbum?.id) GuestSaveManager.schedule(S.clientAlbum.id, S.clientReview, 'choosing');
    closeModal('note-modal');
    renderClientGrid();
  });

  // Lightbox actions for client
  document.getElementById('lb-choose')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (!p) return;
    const cur = S.clientReview[p.id]?.r || '';
    clientSetReview(p.id, cur === 'selected' ? '' : 'selected');
    renderLightbox();
  });
  document.getElementById('lb-later')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (!p) return;
    const cur = S.clientReview[p.id]?.r || '';
    clientSetReview(p.id, cur === 'later' ? '' : 'later');
    renderLightbox();
  });
  document.getElementById('lb-note-btn')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (!p) return;
    _notePid = p.id;
    document.getElementById('note-photo-name').textContent = p.name || '';
    document.getElementById('note-text').value = S.clientReview[p.id]?.n || '';
    openModal('note-modal');
  });
  document.getElementById('lb-note-edit')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (!p) return;
    _notePid = p.id;
    document.getElementById('note-photo-name').textContent = p.name || '';
    document.getElementById('note-text').value = S.clientReview[p.id]?.n || '';
    openModal('note-modal');
  });
  document.getElementById('lb-note-del')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    if (!p) return;
    S.clientReview[p.id] = { ...(S.clientReview[p.id] || {}), n: '' };
    renderLightbox();
  });
  document.getElementById('lb-dl')?.addEventListener('click', () => {
    const p = S.lbPhotos[S.lbIdx];
    const did = photoDriveId(p);
    if (!did) return;
    const a = document.createElement('a');
    a.href = `https://drive.google.com/uc?export=download&id=${did}`;
    a.download = p.name || did;
    a.click();
  });

  // Lightbox nav
  document.getElementById('lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('lb-prev')?.addEventListener('click', () => lbNavigate(-1));
  document.getElementById('lb-next')?.addEventListener('click', () => lbNavigate(1));
  document.addEventListener('keydown', e => {
    if (!document.getElementById('lightbox')?.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbNavigate(-1);
    if (e.key === 'ArrowRight') lbNavigate(1);
  });

  // Guide modal
  document.getElementById('cover-guide')?.addEventListener('click', () => openModal('guide-modal'));
  document.getElementById('guide-x')?.addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('guide-ok')?.addEventListener('click', () => closeModal('guide-modal'));

  // Scroll top
  document.getElementById('scroll-top')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => {
    const btn = document.getElementById('scroll-top');
    if (btn) btn.classList.toggle('show', window.scrollY > 400);
  });

  // Theme
  document.querySelectorAll('.theme-toggle').forEach(btn => { btn.onclick = toggleTheme; });

  // Close modals on backdrop
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });
}

/* ─────────────────────────────────────────────
   START
   ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
