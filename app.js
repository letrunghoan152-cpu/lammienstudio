/* Lam Miên Studio — Hệ thống quản lý album chọn ảnh (client-side) */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- Constants ---------- */
  const ALBUMS_KEY = 'lamMienAlbums';
  const AUTH_KEY = 'lamMienAuth';
  const DKEY = 'lamMienDriveKey';
  const BRAND_KEY = 'lamMienBrand';
  const FIXED_DRIVE_KEY = 'AIzaSyB30IdJg_FKZpi2oOmF8bS7qMEna5P2dpg';
  const API_AUTH_KEY = 'lamMienApiAuth';
  const MIGRATED_KEY = 'lamMienMigrated';
  const THEME_KEY = 'lamMienTheme';

  /* ---------- Giao diện sáng/tối ---------- */
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark'); try { localStorage.setItem(THEME_KEY, t); } catch (_) {} }
  function toggleTheme() { const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; applyTheme(cur === 'light' ? 'dark' : 'light'); }
  $$('.theme-toggle').forEach(b => b.addEventListener('click', toggleTheme));

  /* ---------- API (đồng bộ đa thiết bị) ---------- */
  let apiAuth = null;          // {u, p} của nhân sự
  let apiSync = false;         // true khi máy chủ hoạt động
  try { apiAuth = JSON.parse(localStorage.getItem(API_AUTH_KEY) || 'null'); } catch (_) {}
  function apiHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (apiAuth) { h['x-user'] = apiAuth.u; h['x-pass'] = apiAuth.p; }
    return h;
  }
  async function apiListAlbums() {
    const r = await fetch('/api/albums?t=' + Date.now(), { headers: apiHeaders(), cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function apiPushAlbum(al) {
    if (!apiSync || !apiAuth || !al) return;
    fetch('/api/albums', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ album: al }) })
      .then(r => { if (!r.ok) toast('⚠ Lưu lên máy chủ thất bại — kiểm tra mạng rồi thử lại'); })
      .catch(() => toast('⚠ Mất kết nối máy chủ — thay đổi chưa được lưu'));
  }
  function apiDeleteAlbum(id) {
    if (!apiSync || !apiAuth) return;
    fetch('/api/albums?id=' + encodeURIComponent(id), { method: 'DELETE', headers: apiHeaders() }).catch(() => {});
  }
  async function apiGetAlbum(id) {
    const r = await fetch('/api/album?id=' + encodeURIComponent(id) + '&t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function refreshAlbumsFromServer() {
    if (!apiAuth) return false;
    try {
      const list = await apiListAlbums();
      apiSync = true;
      const serverIds = new Set(list.map(a => a.id));
      const migrated = localStorage.getItem(MIGRATED_KEY) === '1';
      if (!migrated && list.length === 0 && albums.length > 0) {
        // Lần đầu bật đồng bộ, máy chủ trống: di cư toàn bộ album cục bộ lên (1 lần duy nhất)
        albums.filter(a => a.id).forEach(apiPushAlbum);
      } else {
        // Máy chủ là nguồn chính. Chỉ giữ album VỪA TẠO trên máy này (<60s) chưa kịp đồng bộ,
        // để không vô tình "hồi sinh" album đã xoá ở thiết bị khác.
        const recent = albums.filter(a => !serverIds.has(a.id) && (Date.now() - (a.createdAt || 0) < 60000));
        recent.forEach(apiPushAlbum);
        // Giữ thay đổi cục bộ mới hơn (vd vừa đổi bìa/album) chưa kịp đồng bộ về máy chủ,
        // và đẩy lại lên để không bị mất khi máy chủ trả về bản cũ.
        const localById = {}; albums.forEach(a => { if (a.id) localById[a.id] = a; });
        const merged = list.map(sv => {
          const lo = localById[sv.id];
          if (lo && (lo.lastActivity || 0) > (sv.lastActivity || 0)) { apiPushAlbum(lo); return lo; }
          return sv;
        });
        albums = merged.concat(recent);
      }
      albums.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (_) {}
      saveAlbumsLocal();
      return true;
    } catch (_) { return false; }
  }

  const STATUSES = [
    { key: 'draft',     label: 'Bản nháp',          cls: 'st-draft',     color: '#94a3b8' },
    { key: 'waiting',   label: 'Chờ khách xem',     cls: 'st-waiting',   color: '#38bdf8' },
    { key: 'choosing',  label: 'Khách đang chọn',   cls: 'st-choosing',  color: '#fbbf24' },
    { key: 'done',      label: 'Khách chọn xong',   cls: 'st-done',      color: '#34d399' },
    { key: 'editing',   label: 'Đang hậu kỳ',       cls: 'st-editing',   color: '#b9a7ff' },
    { key: 'ready',     label: 'Sẵn sàng bàn giao', cls: 'st-ready',     color: '#2dd4bf' },
    { key: 'delivered', label: 'Đã bàn giao',       cls: 'st-delivered', color: '#34d399' },
  ];
  const statusOf = k => STATUSES.find(s => s.key === k) || STATUSES[0];

  /* ---------- State ---------- */
  let albums = [];
  let brand = { name: 'Lam Miên Studio', welcome: 'Chọn những khoảnh khắc bạn yêu thích' };
  let currentFilter = 'all';
  let albumsView = 'grid', progView = 'list';
  let currentSource = 'drive';
  let pickedFiles = [];
  // client picker
  let clientAlbum = null, clientBound = false, clientRemote = false, clientFilter = 'all', lbIndex = -1;
  let clientFolder = 'goc', clientSort = 'az', clientView = 'masonry', clientPage = 0;
  let clientList = [], clientShown = 0, clientObserver = null, guestSyncTimer = null;
  const CLIENT_BATCH = 30, CLIENT_PAGE = 100;
  const FILTER_DESC = {
    all: 'Hiển thị tất cả ảnh, gồm ảnh đã chọn, ảnh xem lại sau, ảnh đã bỏ qua và ảnh chưa xem.',
    selected: 'Những ảnh bạn đã chọn để gửi hậu kỳ.',
    later: 'Những ảnh bạn đánh dấu xem lại sau.',
    skipped: 'Những ảnh bạn đã bỏ qua.',
    unseen: 'Những ảnh bạn chưa quyết định.'
  };
  function folderPhotos(f) {
    if (!clientAlbum) return [];
    if (f === 'goc') return clientAlbum.photos;
    const s = (clientAlbum.sets || []).find(x => x.id === f); return s ? (s.photos || []) : [];
  }
  function pushGuestSelection(status) {
    if (!clientRemote || !clientAlbum) return;
    const review = {};
    clientAlbum.photos.forEach(p => { review[p.id] = { r: p.review || '', n: p.note || '' }; });
    fetch('/api/album?id=' + encodeURIComponent(clientAlbum.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review, status: status || 'choosing' })
    }).catch(() => {});
  }
  // album detail (studio)
  let detailAlbum = null, detailSet = 'goc', pickingCover = false;
  let detailList = [], detailShown = 0, detailObserver = null;
  let detailSort = 'az', detailView = 'grid';
  let detailPick = false;
  const detailPicked = new Set();
  const photoKey = p => p.driveId || p.id;
  const DETAIL_BATCH = 60;

  /* ---------- Helpers ---------- */
  function genId() { return 'al' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtVN(dateStr) { if (!dateStr) return ''; const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return ''; return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }
  function addDays(dateStr, n) { if (!dateStr || !n) return ''; const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return ''; d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  // Lấy ngày chụp + giờ + tên khách từ chuỗi kiểu "8.6 Kiều Anh 12H"
  function parseAlbumMeta(str) {
    const year = new Date().getFullYear();
    let shootDate = '', hour = null, client = String(str || '');
    const dm = client.match(/(\d{1,2})\s*[.\/-]\s*(\d{1,2})/);            // 8.6 / 8/6 / 8-6
    if (dm) { const day = +dm[1], month = +dm[2]; if (day >= 1 && day <= 31 && month >= 1 && month <= 12) shootDate = `${year}-${pad2(month)}-${pad2(day)}`; }
    const hm = client.match(/(\d{1,2})\s*[hH](?![a-zA-Z])/);             // 12H
    if (hm) hour = +hm[1];
    if (dm) client = client.replace(dm[0], ' ');
    if (hm) client = client.replace(hm[0], ' ');
    client = client.replace(/\s+/g, ' ').trim();
    return { shootDate, hour, client };
  }
  function toYMD(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  // Deadline tính từ lúc khách bấm "Gửi hậu kỳ" (selectedAt), không phải từ ngày chụp
  function recomputeDeadline(al) { al.deadline = (al.selectedAt && al.deadlineDays) ? addDays(toYMD(al.selectedAt), al.deadlineDays) : ''; }
  function albumCover(al) { return (al && al.cover) || (al && al.photos && al.photos[0] && (al.photos[0].full || al.photos[0].src)) || ''; }
  function genSetId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  // Chuẩn hoá danh sách album con (sets); di cư editedPhotos kiểu cũ -> 1 set "Ảnh sửa"
  function normalizeSets(al) {
    if (!al) return [];
    if (!Array.isArray(al.sets)) {
      al.sets = [];
      if (al.editedPhotos && al.editedPhotos.length) al.sets.push({ id: 'sua', name: 'Ảnh sửa', sourceUrl: al.editedSourceUrl || '', photos: al.editedPhotos });
    }
    return al.sets;
  }
  function fmtAgo(ts) {
    if (!ts) return 'vừa xong';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'vừa xong';
    const m = Math.floor(s / 60); if (m < 60) return m + ' phút trước';
    const h = Math.floor(m / 60); if (h < 24) return h + ' giờ trước';
    const d = Math.floor(h / 24); if (d < 30) return d + ' ngày trước';
    const mo = Math.floor(d / 30); if (mo < 12) return mo + ' tháng trước';
    return Math.floor(mo / 12) + ' năm trước';
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2300);
  }

  /* ---------- Persistence ---------- */
  function activeAlbums() { return albums.filter(a => !a.trashed); }
  function trashedAlbums() { return albums.filter(a => a.trashed); }
  function updateTrashBadge() {
    const n = trashedAlbums().length, b = $('#trash-badge');
    if (b) { b.hidden = n === 0; b.textContent = n; }
  }
  function saveAlbumsLocal() { try { localStorage.setItem(ALBUMS_KEY, JSON.stringify(albums)); } catch (_) {} }
  // changed: album vừa sửa -> đồng bộ đúng album đó lên máy chủ
  function saveAlbums(changed) { saveAlbumsLocal(); if (changed) apiPushAlbum(changed); }
  function loadAlbums() { try { const r = localStorage.getItem(ALBUMS_KEY); if (r) albums = JSON.parse(r) || []; } catch (_) { albums = []; } }
  function saveBrand() { try { localStorage.setItem(BRAND_KEY, JSON.stringify(brand)); } catch (_) {} }
  function loadBrand() { try { const r = localStorage.getItem(BRAND_KEY); if (r) brand = Object.assign(brand, JSON.parse(r)); } catch (_) {} }
  function getDriveKey() { try { return localStorage.getItem(DKEY) || ''; } catch (_) { return ''; } }
  function setDriveKey(k) { try { k ? localStorage.setItem(DKEY, k) : localStorage.removeItem(DKEY); } catch (_) {} }

  /* ---------- Auth ---------- */
  function hideAllScreens() { $('#login-view').hidden = true; $('#app').hidden = true; $('#client').hidden = true; const ce = $('#client-error'); if (ce) ce.hidden = true; const cl = $('#client-loading'); if (cl) cl.hidden = true; }
  function showClientLoading() { hideAllScreens(); $('#client-loading').hidden = false; }
  function showLogin() { hideAllScreens(); $('#login-view').hidden = false; }
  function showClientError(msg) {
    hideAllScreens(); $('#client-error').hidden = false;
    if (msg) $('#cerr-msg').textContent = msg;
  }
  $('#cerr-retry').addEventListener('click', () => location.reload());
  function showApp() {
    hideAllScreens(); $('#app').hidden = false;
    if (apiAuth) {
      const nm = apiAuth.name || apiAuth.u;
      $('#sb-name').textContent = nm;
      $('#sb-av').textContent = (nm.trim()[0] || 'L').toUpperCase();
    }
    renderAlbums();
    if ($('#page-albumdetail').classList.contains('active') && detailAlbum) renderDetail();
    // làm mới ngầm từ máy chủ (để thấy lựa chọn khách vừa gửi)
    refreshAlbumsFromServer().then(ok => { if (ok) { renderAlbums(); if (detailAlbum) { detailAlbum = albums.find(x => x.id === detailAlbum.id) || detailAlbum; if ($('#page-albumdetail').classList.contains('active')) renderDetail(); } } });
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('#lg-user').value.trim(), p = $('#lg-pass').value;
    const btn = $('#login-form button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Đang đăng nhập…';
    // Chỉ đăng nhập qua máy chủ bằng tài khoản trong Google Sheet — không có tài khoản mặc định
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: u, pass: p }) });
      if (!r.ok) {
        btn.disabled = false; btn.textContent = 'Đăng nhập';
        toast(r.status === 401 ? 'Sai tài khoản hoặc mật khẩu' : 'Lỗi máy chủ, thử lại sau'); return;
      }
      const d = await r.json();
      apiAuth = { u, p, name: d.name || u };
      try { localStorage.setItem(API_AUTH_KEY, JSON.stringify(apiAuth)); } catch (_) {}
      checkStudioDrive();   // biết studio đã kết nối Drive chưa
      if (d.sync) { await refreshAlbumsFromServer(); }
      else toast('Máy chủ chưa nối database');
    } catch (_) {
      btn.disabled = false; btn.textContent = 'Đăng nhập';
      toast('Không kết nối được máy chủ — kiểm tra mạng rồi thử lại'); return;
    }
    try { localStorage.setItem(AUTH_KEY, '1'); } catch (_) {}
    btn.disabled = false; btn.textContent = 'Đăng nhập';
    showApp(); if (apiSync) toast('Đăng nhập thành công — dữ liệu đồng bộ mọi thiết bị');
  });
  $('#logout-btn').addEventListener('click', () => {
    try { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(API_AUTH_KEY); } catch (_) {}
    apiAuth = null; apiSync = false;
    $('#lg-user').value = ''; $('#lg-pass').value = '';
    showLogin(); toast('Đã đăng xuất');
  });

  /* ---------- Page nav (sidebar) ---------- */
  $$('.sb-nav a').forEach(a => a.addEventListener('click', () => {
    const page = a.dataset.page;
    $$('.sb-nav a').forEach(x => x.classList.toggle('active', x === a));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    setSidebar(false);
    window.scrollTo({ top: 0 });
    if (page === 'albums') renderAlbums();
    if (page === 'progress') renderProgress();
    if (page === 'trash') renderTrash();
  }));
  function setSidebar(open) { $('#sidebar').classList.toggle('open', open); const o = $('#sb-overlay'); if (o) o.hidden = !open; }
  $('#sb-toggle').addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('open')));
  $('#sb-overlay').addEventListener('click', () => setSidebar(false));
  (function () { let sx = 0, sy = 0;
    $('#sidebar').addEventListener('touchstart', e => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
    $('#sidebar').addEventListener('touchend', e => { const t = e.changedTouches[0]; if (t.clientX - sx < -45 && Math.abs(t.clientY - sy) < 60) setSidebar(false); }, { passive: true });
  })();

  /* ---------- Google Drive ---------- */
  function extractFolderId(t) {
    if (!t) return '';
    const m = String(t).match(/\/folders\/([a-zA-Z0-9_-]+)/) || String(t).match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    const x = String(t).trim();
    return /^[a-zA-Z0-9_-]{20,}$/.test(x) ? x : '';
  }
  function driveFileId(u) {
    const m = String(u).match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || String(u).match(/[?&]id=([a-zA-Z0-9_-]+)/) || String(u).match(/\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }
  const driveThumb = (id, sz) => `https://drive.google.com/thumbnail?id=${id}&sz=${sz || 'w400'}`;
  function driveIdFromThumb(u) { const m = String(u).match(/[?&]id=([a-zA-Z0-9_-]+)/) || String(u).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : ''; }
  // Khi thumbnail Drive lỗi/bị giới hạn -> thử nguồn lh3 (cũng từ Drive), rồi mới chịu thua
  function attachImgFallback(img, p) {
    if (!img) return; let tried = 0;
    img.addEventListener('error', () => {
      const id = p.driveId || driveIdFromThumb(p.src); if (!id) return;
      if (tried === 0) { tried = 1; img.src = `https://lh3.googleusercontent.com/d/${id}=w600`; }
      else if (tried === 1) { tried = 2; img.src = driveThumb(id, 'w400'); } // thử lại 1 lần nữa (qua cơn rate-limit)
    });
  }
  async function listDriveFolder(folderId, apiKey) {
    let files = [], pageToken = '';
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('fields', 'nextPageToken, files(id,name,mimeType,imageMediaMetadata(width,height))');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'name_natural');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url);
      if (!res.ok) { let msg = 'HTTP ' + res.status; try { const e = await res.json(); msg = e.error?.message || msg; } catch (_) {} throw new Error(msg); }
      const data = await res.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }
  async function buildDrivePhotos(folderText, apiKey) {
    const fid = extractFolderId(folderText);
    if (!fid) throw new Error('Không nhận ra ID thư mục Drive. Dán đúng link .../folders/...');
    if (!apiKey) throw new Error('Chưa nhập Google Drive API Key (mục “Tài khoản NAS”).');
    const files = await listDriveFolder(fid, apiKey);
    if (!files.length) throw new Error('Thư mục trống hoặc chưa chia sẻ “Bất kỳ ai có đường liên kết”.');
    return files.map((f, i) => {
      const md = f.imageMediaMetadata || {};
      return { id: 'd' + i, name: f.name, driveId: f.id, w: md.width || 0, h: md.height || 0, src: driveThumb(f.id, 'w400'), full: driveThumb(f.id, 'w1600'), selected: false, note: '' };
    });
  }
  const DEMO = ['photo-1519741497674-611481863552','photo-1520854221256-17451cc331bf','photo-1511285560929-80b456fea0bc','photo-1519225421980-715cb0215aed','photo-1465495976277-4387d4b0b4c6','photo-1525258946800-98cfd641d0de','photo-1606216794074-735e91aa2c92','photo-1583939003579-730e3918a45a','photo-1591604466107-ec97de577aff','photo-1537633552985-df8429e8048b']
    .map((id, i) => ({ name: `LMS_${String(i + 1).padStart(4, '0')}.jpg`, src: `https://images.unsplash.com/${id}?auto=format&fit=crop&w=600&q=75` }));

  /* ===================================================================
     Google Drive: liên kết tài khoản (OAuth – GIS token model) + upload
     =================================================================== */
  const GCID_KEY = 'lamMienGoogleClientId';
  const DRIVE_EMAIL_KEY = 'lamMienDriveEmail';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
  let driveToken = '', driveTokenExp = 0, driveEmail = '';
  let studioConnected = false;   // studio đã kết nối Drive ở máy chủ -> nhân sự khỏi đăng nhập Google
  let _tokenClient = null, _tokenResolve = null, _tokenReject = null, _tokenTimer = null;
  try { driveEmail = localStorage.getItem(DRIVE_EMAIL_KEY) || ''; } catch (_) {}

  function getClientId() { try { return (localStorage.getItem(GCID_KEY) || '').trim(); } catch (_) { return ''; } }
  function driveLinked() { return studioConnected || !!(getClientId() && driveEmail); }
  function canUseDrive() { return studioConnected || !!(getClientId() && driveEmail); }
  function gisReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }

  function buildTokenClient() {
    const cid = getClientId();
    if (!cid) throw new Error('Chưa nhập OAuth Client ID (mục Kết nối Google Drive).');
    if (!gisReady()) throw new Error('Thư viện Google chưa tải xong — thử lại sau giây lát.');
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: DRIVE_SCOPE,
      callback: resp => {
        if (_tokenTimer) { clearTimeout(_tokenTimer); _tokenTimer = null; }
        if (resp && resp.access_token) {
          driveToken = resp.access_token;
          driveTokenExp = Date.now() + ((resp.expires_in || 3500) - 60) * 1000;
          if (_tokenResolve) _tokenResolve(driveToken);
        } else if (_tokenReject) { _tokenReject(new Error('Không lấy được quyền truy cập Drive')); }
        _tokenResolve = _tokenReject = null;
      },
      error_callback: err => {
        if (_tokenTimer) { clearTimeout(_tokenTimer); _tokenTimer = null; }
        if (_tokenReject) _tokenReject(new Error(err && err.type === 'popup_closed' ? 'Bạn đã đóng cửa sổ liên kết' : (err && err.message) || 'Liên kết thất bại'));
        _tokenResolve = _tokenReject = null;
      }
    });
  }
  // interactive=true: hiện màn hình cấp quyền (chỉ dùng khi bấm "Liên kết").
  // interactive=false: lấy token IM LẶNG (không hiện gì) nếu đã từng cấp quyền & còn phiên Google.
  function requestToken(interactive) {
    return new Promise((resolve, reject) => {
      try { buildTokenClient(); } catch (e) { return reject(e); }
      _tokenResolve = resolve; _tokenReject = reject;
      const params = interactive ? { prompt: 'consent' } : { prompt: '' };
      if (!interactive && driveEmail && driveEmail.indexOf('@') > 0) params.hint = driveEmail; // tự chọn đúng tài khoản
      if (!interactive) {
        _tokenTimer = setTimeout(() => {
          if (_tokenReject) { const rj = _tokenReject; _tokenResolve = _tokenReject = null; _tokenTimer = null; rj(new Error('Phiên Google đã hết hạn')); }
        }, 8000);
      }
      try { _tokenClient.requestAccessToken(params); }
      catch (e) { if (_tokenTimer) { clearTimeout(_tokenTimer); _tokenTimer = null; } _tokenResolve = _tokenReject = null; reject(e); }
    });
  }
  async function ensureDriveToken(interactive) {
    if (driveToken && Date.now() < driveTokenExp) return driveToken;
    // 1) Ưu tiên token của STUDIO từ máy chủ -> nhân sự không cần đăng nhập Google
    if (apiAuth) {
      const t = await fetchServerToken();
      if (t && t.access_token) {
        driveToken = t.access_token; driveTokenExp = Date.now() + ((t.expires_in || 3500) - 60) * 1000;
        studioConnected = true;
        if (t.email) { driveEmail = t.email; try { localStorage.setItem(DRIVE_EMAIL_KEY, driveEmail); } catch (_) {} }
        renderDriveStatus();
        return driveToken;
      }
    }
    // 2) Dự phòng: liên kết riêng từng máy (GIS)
    return requestToken(!!interactive);
  }
  // Lấy access token của studio từ máy chủ (null nếu studio chưa kết nối)
  async function fetchServerToken() {
    if (!apiAuth) return null;
    try {
      const r = await fetch('/api/drive-token', { headers: apiHeaders(), cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (_) {}
    return null;
  }
  // Kiểm tra studio đã kết nối Drive chưa (không cấp token)
  async function checkStudioDrive() {
    if (!apiAuth) return;
    try {
      const r = await fetch('/api/drive-token?status=1', { headers: apiHeaders(), cache: 'no-store' });
      if (r.ok) { const j = await r.json(); studioConnected = true; if (j.email) driveEmail = j.email; renderDriveStatus(); }
      else { studioConnected = false; renderDriveStatus(); }
    } catch (_) {}
  }
  // Kết nối Drive cho cả studio (1 lần, chủ studio thực hiện)
  async function connectStudioDrive() {
    if (!apiAuth) { toast('Hãy đăng nhập ứng dụng trước'); return; }
    let state;
    try {
      const r = await fetch('/api/google-auth?action=state', { method: 'POST', headers: apiHeaders() });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ('HTTP ' + r.status)); }
      state = (await r.json()).state;
    } catch (e) { toast('Lỗi: ' + (e.message || e)); return; }
    const w = 520, h = 660, left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    const pop = window.open('/api/google-auth?action=start&state=' + encodeURIComponent(state), 'studio-drive', `width=${w},height=${h},left=${left},top=${top}`);
    toast('Mở cửa sổ Google để cấp quyền…');
    const timer = setInterval(async () => {
      if (pop && pop.closed) {
        clearInterval(timer);
        await checkStudioDrive();
        toast(studioConnected ? ('Đã kết nối Drive studio: ' + driveEmail) : 'Chưa hoàn tất kết nối — thử lại');
      }
    }, 800);
  }
  async function fetchDriveEmail(token) {
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) return (await r.json()).email || '';
    } catch (_) {}
    return '';
  }
  async function linkDrive() {
    const token = await ensureDriveToken(true);
    driveEmail = (await fetchDriveEmail(token)) || 'Đã liên kết';
    try { localStorage.setItem(DRIVE_EMAIL_KEY, driveEmail); } catch (_) {}
    renderDriveStatus();
    return token;
  }
  function unlinkDrive() {
    if (driveToken && gisReady()) { try { google.accounts.oauth2.revoke(driveToken, () => {}); } catch (_) {} }
    driveToken = ''; driveTokenExp = 0; driveEmail = '';
    try { localStorage.removeItem(DRIVE_EMAIL_KEY); } catch (_) {}
    renderDriveStatus();
  }
  function renderDriveStatus() {
    const linked = driveLinked();
    const t = $('#sb-drive-title'), s = $('#sb-drive-sub'), dot = $('#sb-drive-dot');
    if (t) t.textContent = studioConnected ? 'Google Drive (studio)' : (linked ? 'Google Drive' : 'Chưa kết nối Drive');
    if (s) s.textContent = linked ? driveEmail : 'Bấm để liên kết tài khoản';
    if (dot) dot.classList.toggle('on', linked);
    const md = $('#drive-modal-dot'), mt = $('#drive-modal-text'), unb = $('#drive-unlink'), lb = $('#drive-link');
    if (md) md.classList.toggle('on', linked);
    if (mt) mt.textContent = studioConnected ? ('Đã kết nối cho cả studio: ' + driveEmail + ' — nhân sự không cần đăng nhập Google.')
      : (linked ? ('Đã liên kết (máy này): ' + driveEmail) : 'Chưa liên kết tài khoản nào.');
    if (unb) unb.hidden = !(getClientId() && driveEmail) || studioConnected;
    if (lb) lb.textContent = (getClientId() && driveEmail) ? 'Liên kết lại / đổi tài khoản' : 'Liên kết tài khoản Google';
    const sc = $('#drive-studio-connect'); if (sc) sc.textContent = studioConnected ? 'Kết nối lại / đổi tài khoản studio' : 'Kết nối studio (1 lần)';
  }

  // ---- Thao tác ghi lên Drive ----
  async function driveCreateFolder(name, token) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Album', mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!r.ok) throw new Error('Không tạo được thư mục Drive (' + r.status + ')');
    return (await r.json()).id;
  }
  async function driveShareAnyone(fileId, token) {
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
    } catch (_) {}
  }
  // Chuyển file/thư mục vào thùng rác Drive (chỉ được với thứ do app này tạo — scope drive.file)
  function driveTrashOne(id, token) {
    return fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    }).then(r => { if (!r.ok) throw new Error(String(r.status)); });
  }
  function driveTokenOrPrompt() {
    if (driveToken && Date.now() < driveTokenExp) return Promise.resolve(driveToken);
    return ensureDriveToken(false);   // im lặng, không bắt đăng nhập lại
  }
  async function driveTrashFiles(ids) {
    ids = (ids || []).filter(Boolean); if (!ids.length) return;
    let token; try { token = await driveTokenOrPrompt(); } catch (_) { toast('Chưa đăng nhập Drive — ảnh đã xoá trên web nhưng chưa xoá trên Drive'); return; }
    let ok = 0, fail = 0;
    await Promise.all(ids.map(id => driveTrashOne(id, token).then(() => ok++).catch(() => fail++)));
    if (fail) toast(`Drive: đã xoá ${ok}, ${fail} ảnh không xoá được (ảnh không do web tạo)`);
  }
  // Lấy tất cả ID thư mục Drive của 1 album (folder gốc + các album con)
  function albumFolderIds(al) {
    const ids = [];
    const a = extractFolderId(al.sourceUrl || ''); if (a) ids.push(a);
    (al.sets || []).forEach(s => { const f = extractFolderId(s.sourceUrl || ''); if (f) ids.push(f); });
    return ids;
  }
  async function driveTrashAlbum(al) {
    const ids = albumFolderIds(al); if (!ids.length) return;
    let token; try { token = await driveTokenOrPrompt(); } catch (_) { return; }
    await Promise.all(ids.map(id => driveTrashOne(id, token).catch(() => {})));
  }
  // Upload 1 file kiểu resumable, báo tiến độ qua onDelta(bytesTăngThêm)
  function driveUploadFile(file, folderId, token, onDelta) {
    return new Promise((resolve, reject) => {
      fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': file.type || 'image/jpeg', 'X-Upload-Content-Length': String(file.size)
        },
        body: JSON.stringify({ name: file.name, parents: [folderId] })
      }).then(init => {
        if (!init.ok) throw new Error('Khởi tạo upload lỗi (' + init.status + ')');
        const sessionUrl = init.headers.get('Location');
        if (!sessionUrl) throw new Error('Không nhận được phiên upload');
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', sessionUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || 'image/jpeg');
        let last = 0;
        xhr.upload.onprogress = e => { if (e.lengthComputable) { onDelta(e.loaded - last); last = e.loaded; } };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText).id); } catch (_) { resolve(''); } }
          else reject(new Error('Upload lỗi (' + xhr.status + ')'));
        };
        xhr.onerror = () => reject(new Error('Mất kết nối khi upload'));
        xhr.send(file);
      }).catch(reject);
    });
  }
  function readDims(file) {
    return new Promise(resolve => {
      if (!window.createImageBitmap) return resolve({ w: 0, h: 0 });
      createImageBitmap(file).then(bm => { const d = { w: bm.width, h: bm.height }; if (bm.close) bm.close(); resolve(d); }).catch(() => resolve({ w: 0, h: 0 }));
    });
  }
  // Upload danh sách file vào 1 thư mục có sẵn (song song 3 luồng) + tiến độ tổng / tốc độ / ETA
  async function uploadFilesToFolder(files, folderId, token, ui) {
    const total = files.reduce((s, f) => s + f.size, 0);
    let uploaded = 0, done = 0, idx = 0;
    const startT = Date.now();
    const results = new Array(files.length);
    ui.start(files.length);
    const tick = () => {
      const el = (Date.now() - startT) / 1000;
      const speed = el > 0 ? uploaded / el : 0;
      ui.update({ uploaded, total, done, count: files.length, speed });
    };
    const timer = setInterval(tick, 400);
    const worker = async () => {
      while (idx < files.length) {
        const i = idx++, file = files[i];
        const dim = await readDims(file);
        try {
          const id = await driveUploadFile(file, folderId, token, d => { uploaded += d; });
          await driveShareAnyone(id, token);
          results[i] = { id: 'a' + id, name: file.name, driveId: id, w: dim.w, h: dim.h, src: driveThumb(id, 'w400'), full: driveThumb(id, 'w1600'), selected: false, note: '' };
        } catch (_) { results[i] = null; }
        done++; tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
    clearInterval(timer); uploaded = total; tick(); ui.finish();
    return results.filter(Boolean);
  }
  // Tạo album mới: tạo folder rồi upload vào đó
  async function uploadAlbumPhotos(files, folderName, ui) {
    const token = await ensureDriveToken(false);
    if (!driveEmail) { driveEmail = (await fetchDriveEmail(token)) || 'Đã liên kết'; try { localStorage.setItem(DRIVE_EMAIL_KEY, driveEmail); } catch (_) {} renderDriveStatus(); }
    const folderId = await driveCreateFolder(folderName, token);
    await driveShareAnyone(folderId, token);
    const photos = await uploadFilesToFolder(files, folderId, token, ui);
    if (!photos.length) throw new Error('Không upload được ảnh nào');
    return { folderId, photos };
  }

  // ---- Định dạng hiển thị ----
  function fmtSpeed(bps) { if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s'; if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s'; return Math.round(bps) + ' B/s'; }
  function fmtEta(sec) { if (!isFinite(sec) || sec <= 0) return '—'; if (sec >= 3600) return Math.floor(sec / 3600) + 'h' + Math.round(sec % 3600 / 60) + 'm'; if (sec >= 60) return Math.floor(sec / 60) + 'm' + Math.round(sec % 60) + 's'; return Math.ceil(sec) + 's'; }
  // Thanh tiến độ nổi góc dưới-phải: mỗi lần upload là 1 thẻ riêng
  let _ufSeq = 0;
  function createUploadItem(name, count) {
    const stack = $('#upload-stack');
    const el = document.createElement('div');
    el.className = 'uf-item'; el.id = 'uf' + (++_ufSeq);
    el.innerHTML = `<div class="uf-head"><span class="uf-name">${escapeHtml(name)}</span><button class="uf-x" title="Ẩn">×</button></div>
      <div class="uf-bar"><div class="uf-fill"></div></div>
      <div class="uf-stats"><span class="uf-pct">0%</span><span class="uf-count">0/${count}</span><span class="uf-speed">—</span><span class="uf-eta">còn —</span></div>`;
    stack.appendChild(el);
    el.querySelector('.uf-x').addEventListener('click', () => el.remove());
    const q = s => el.querySelector(s);
    return {
      start(c) { q('.uf-count').textContent = '0/' + c; },
      update({ uploaded, total, done, count, speed }) {
        const pct = total ? Math.min(100, uploaded / total * 100) : 0;
        q('.uf-fill').style.width = pct.toFixed(1) + '%'; q('.uf-pct').textContent = Math.round(pct) + '%';
        q('.uf-count').textContent = done + '/' + count; q('.uf-speed').textContent = fmtSpeed(speed);
        q('.uf-eta').textContent = 'còn ' + fmtEta(speed > 0 ? (total - uploaded) / speed : Infinity);
      },
      finish() { q('.uf-fill').style.width = '100%'; q('.uf-pct').textContent = '100%'; q('.uf-eta').textContent = 'xong'; },
      done(msg) { el.classList.add('ok'); q('.uf-name').textContent = msg; q('.uf-eta').textContent = ''; setTimeout(() => el.remove(), 6000); },
      fail(msg) { el.classList.add('err'); q('.uf-name').textContent = msg; }
    };
  }

  /* ---------- Wiring: nút kết nối Drive ---------- */
  function openDriveModal() { $('#gcid').value = getClientId(); renderDriveStatus(); $('#drive-modal').classList.add('open'); }
  function closeDriveModal() { $('#drive-modal').classList.remove('open'); }
  $('#sb-drive') && $('#sb-drive').addEventListener('click', openDriveModal);
  $('#drive-close') && $('#drive-close').addEventListener('click', closeDriveModal);
  $('#drive-modal') && $('#drive-modal').addEventListener('click', e => { if (e.target.id === 'drive-modal') closeDriveModal(); });
  $('#gcid') && $('#gcid').addEventListener('change', () => { try { localStorage.setItem(GCID_KEY, $('#gcid').value.trim()); } catch (_) {} _tokenClient = null; });
  $('#drive-link') && $('#drive-link').addEventListener('click', async () => {
    const cid = $('#gcid').value.trim();
    if (!cid) { toast('Hãy dán OAuth Client ID trước'); $('#gcid').focus(); return; }
    try { localStorage.setItem(GCID_KEY, cid); } catch (_) {} _tokenClient = null;
    const btn = $('#drive-link'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Đang mở Google…';
    try { await linkDrive(); toast('Đã liên kết Google Drive: ' + driveEmail); }
    catch (e) { toast('Lỗi: ' + (e.message || e)); }
    finally { btn.disabled = false; btn.textContent = old; }
  });
  $('#drive-unlink') && $('#drive-unlink').addEventListener('click', () => { unlinkDrive(); toast('Đã ngắt liên kết Google Drive'); });
  $('#drive-studio-connect') && $('#drive-studio-connect').addEventListener('click', connectStudioDrive);
  $('#drive-done') && $('#drive-done').addEventListener('click', closeDriveModal);
  renderDriveStatus();
  checkStudioDrive();   // hỏi máy chủ xem studio đã kết nối Drive chưa

  /* ---------- Create modal ---------- */
  let pickedUploadFiles = [], createSource = 'upload';
  function renderPickInfo() {
    const el = $('#pick-info');
    if (!pickedUploadFiles.length) { el.hidden = true; return; }
    const totalMB = (pickedUploadFiles.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1);
    el.hidden = false;
    el.innerHTML = `<b>${pickedUploadFiles.length}</b> ảnh đã chọn · ${totalMB} MB <span class="clear" id="pick-clear">Xoá chọn</span>`;
    $('#pick-clear').addEventListener('click', () => { pickedUploadFiles = []; renderPickInfo(); });
  }
  function setSource(src) {
    createSource = src;
    $$('#src-seg button').forEach(b => b.classList.toggle('active', b.dataset.src === src));
    $('#pane-upload').hidden = src !== 'upload';
    $('#pane-drive').hidden = src !== 'drive';
  }
  function openCreate() {
    $('#create-form').reset();
    $('#allow-notes').checked = true; $('#allow-download').checked = false;
    pickedUploadFiles = []; renderPickInfo();
    setSource('upload'); renderDriveStatus();
    $('#create-modal').classList.add('open');
  }
  function closeCreate() { $('#create-modal').classList.remove('open'); }
  $('#new-album-btn').addEventListener('click', openCreate);
  $('#empty-new-btn').addEventListener('click', openCreate);
  $('#create-close').addEventListener('click', closeCreate);
  $('#create-cancel').addEventListener('click', closeCreate);
  $('#create-modal').addEventListener('click', e => { if (e.target.id === 'create-modal') closeCreate(); });

  // chuyển nguồn ảnh
  $$('#src-seg button').forEach(b => b.addEventListener('click', () => setSource(b.dataset.src)));
  // dropzone / chọn file
  const dz = $('#dropzone'), fi = $('#file-input');
  function addFiles(list) {
    const imgs = Array.from(list).filter(f => f.type.startsWith('image/'));
    if (!imgs.length) { toast('Chỉ nhận file ảnh'); return; }
    pickedUploadFiles = pickedUploadFiles.concat(imgs); renderPickInfo();
  }
  if (dz) {
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  }

  // Tạo bản ghi album từ metadata + ảnh đã có
  function finalizeAlbum(meta, photos, sourceUrl) {
    const m = parseAlbumMeta(meta.rawName);
    const al = {
      id: genId(),
      name: meta.rawName,
      client: m.client || '',
      status: 'waiting',
      maxCount: meta.maxCount,
      allowNotes: meta.allowNotes,
      allowDownload: meta.allowDownload,
      shootDate: m.shootDate,
      shootHour: m.hour,
      deadlineDays: meta.deadlineDays,
      deadline: '',        // sẽ tự tính khi khách bấm "Gửi hậu kỳ"
      selectedAt: 0,
      sourceUrl,
      cover: '',
      editedPhotos: [],
      createdAt: Date.now(), lastActivity: Date.now(),
      photos
    };
    albums.unshift(al); saveAlbums(al);
    if ($('#page-albums').classList.contains('active')) renderAlbums();
    return al;
  }
  // Upload nền: tạo folder, upload có thanh tiến độ nổi, rồi tạo album
  async function runUploadJob(meta, files) {
    const ui = createUploadItem(meta.rawName, files.length);
    try {
      const r = await uploadAlbumPhotos(files, meta.rawName, ui);
      finalizeAlbum(meta, r.photos, 'https://drive.google.com/drive/folders/' + r.folderId);
      ui.done('✓ Đã tạo “' + meta.rawName + '” (' + r.photos.length + ' ảnh)');
    } catch (err) {
      ui.fail('✕ Lỗi: ' + meta.rawName);
      toast('Upload lỗi: ' + (err.message || err));
    }
  }

  $('#create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#create-submit');
    const rawName = $('#album-name').value.trim();
    if (!rawName) { toast('Hãy nhập tên khách / mã buổi chụp'); return; }
    const days = parseInt($('#deadline-days').value, 10);
    const max = parseInt($('#max-count').value, 10);
    const meta = {
      rawName,
      deadlineDays: Number.isFinite(days) && days >= 0 ? days : 0,
      maxCount: Number.isFinite(max) && max > 0 ? max : 0,
      allowNotes: $('#allow-notes').checked,
      allowDownload: $('#allow-download').checked
    };

    if (createSource === 'drive') {
      const folder = $('#drive-url').value.trim();
      if (!folder) { toast('Hãy dán link thư mục Google Drive'); return; }
      try {
        btn.disabled = true; btn.textContent = 'Đang tải ảnh…'; toast('Đang tải ảnh từ Google Drive…');
        const photos = await buildDrivePhotos(folder, FIXED_DRIVE_KEY);
        finalizeAlbum(meta, photos, folder); closeCreate();
        toast(`Đã tạo album “${rawName}” (${photos.length} ảnh)`);
      } catch (err) { toast('Lỗi: ' + (err.message || err)); }
      finally { btn.disabled = false; btn.textContent = 'Tạo album'; }
      return;
    }

    // Nguồn "Tải từ máy" -> upload chạy nền
    if (!pickedUploadFiles.length) { toast('Hãy chọn ảnh từ máy'); return; }
    const files = pickedUploadFiles;
    if (!(driveToken && Date.now() < driveTokenExp)) {   // lấy token (studio ở máy chủ, hoặc cá nhân)
      try { await ensureDriveToken(false); }
      catch (_) { toast('Chưa kết nối Google Drive — mở phần “Kết nối Drive”'); openDriveModal(); return; }
    }
    closeCreate();                            // đóng popup ngay để làm việc khác
    toast('Đang tải ảnh lên Google Drive…');
    runUploadJob(meta, files);                // không await -> chạy nền
  });

  /* ---------- Albums dashboard ---------- */
  function selCount(al) { return al.photos.filter(p => p.selected).length; }

  function renderFilters() {
    const el = $('#filters');
    const chip = (key, label, count, color) => {
      const active = currentFilter === key ? ' active' : '';
      const dot = color ? `<span class="dot" style="width:8px;height:8px;border-radius:50%;background:${color}"></span>` : '';
      return `<button class="filter-chip${active}" data-f="${key}">${dot}<span>${label}</span><span class="cnt">(${count})</span></button>`;
    };
    const act = activeAlbums();
    let html = chip('all', 'Tất cả', act.length, null);
    STATUSES.forEach(s => { html += chip(s.key, s.label, act.filter(a => a.status === s.key).length, s.color); });
    el.innerHTML = html;
    $$('#filters .filter-chip').forEach(b => b.addEventListener('click', () => { currentFilter = b.dataset.f; renderAlbums(); }));
  }

  function renderAlbums() { renderFilters(); renderGrid(); updateTrashBadge(); }

  function renderGrid() {
    const grid = $('#albums-grid'), empty = $('#albums-empty');
    grid.innerHTML = '';
    grid.className = 'albums-grid' + (albumsView === 'list' ? ' listv' : '');
    const act = activeAlbums();
    const list = act.filter(a => currentFilter === 'all' || a.status === currentFilter);
    if (!act.length) { empty.hidden = false; grid.hidden = true; return; }
    empty.hidden = true; grid.hidden = false;
    if (!list.length) { grid.innerHTML = `<p class="sub" style="color:var(--muted)">Không có album ở trạng thái này.</p>`; return; }

    list.forEach(al => grid.appendChild(buildCard(al)));
  }

  function buildCard(al) {
    const st = statusOf(al.status);
    const sel = selCount(al);
    const total = al.photos.length;
    const cover = albumCover(al);
    const pct = total ? Math.round(sel / total * 100) : 0;
    const card = document.createElement('div');
    card.className = 'acard';
    card.innerHTML = `
      <div class="acard-cover">${cover ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy" style="object-position:${escapeAttr(al.coverPos || '50% 50%')}">` : '<span class="ph">🖼️</span>'}</div>
      <div class="acard-body">
        <div class="acard-top">
          <div class="status">
            <button class="status-pill ${st.cls}" data-act="status"><span class="dot"></span>${st.label}<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
            <div class="status-menu" hidden></div>
          </div>
          <span class="grow"></span>
          <button class="icon-btn" data-act="share" title="Chia sẻ link"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg></button>
          <div class="status" style="position:relative">
            <button class="icon-btn" data-act="more" title="Thêm"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
            <div class="popmenu" hidden>
              <button data-m="preview"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Xem trước trang chọn</button>
              <button data-m="rename"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Đổi tên / khách</button>
              <button data-m="link"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>Sao chép link</button>
              <button data-m="del" class="danger"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>Xoá album</button>
            </div>
          </div>
        </div>
        <div class="acard-title">${escapeHtml(al.name)}</div>
        <div class="acard-client">${al.client ? escapeHtml(al.client) : '—'}</div>
        <div class="acard-links">
          <span class="tag-link" data-act="orig"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Ảnh gốc (${total})</span>
          <span class="tag-link add" data-act="addfolder"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Thêm thư mục ảnh</span>
        </div>
        <div class="acard-progress">
          <div class="lab">Đã chọn ảnh: ${sel} / ${al.maxCount || total}<span class="edit" data-act="editmax" title="Sửa số tối đa">✎</span></div>
          <div class="bar"><i style="width:${al.maxCount ? Math.min(100, Math.round(sel / al.maxCount * 100)) : pct}%"></i></div>
        </div>
        <label class="switch"><input type="checkbox" data-act="download" ${al.allowDownload ? 'checked' : ''}><span class="track"></span><span>Cho phép tải ảnh</span></label>
        <div class="acard-foot">
          <span>Tổng ảnh: ${total}</span>
          <span>Hoạt động gần đây: ${fmtAgo(al.lastActivity)}</span>
        </div>
      </div>`;

    // status pill + menu
    const stWrap = card.querySelector('.status');
    const stBtn = card.querySelector('[data-act="status"]');
    const stMenu = card.querySelector('.status-menu');
    stMenu.innerHTML = STATUSES.map(s => `<button data-s="${s.key}"><span class="dot" style="background:${s.color}"></span>${s.label}</button>`).join('');
    stBtn.addEventListener('click', e => { e.stopPropagation(); closeMenus(); stMenu.hidden = false; });
    stMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      al.status = b.dataset.s; al.lastActivity = Date.now(); saveAlbums(al); renderAlbums();
    }));

    // share
    card.querySelector('[data-act="share"]').addEventListener('click', () => openShare(al));

    // more menu
    const moreWrap = card.querySelectorAll('.status')[1];
    const popmenu = card.querySelector('.popmenu');
    card.querySelector('[data-act="more"]').addEventListener('click', e => { e.stopPropagation(); closeMenus(); popmenu.hidden = false; });
    popmenu.querySelector('[data-m="preview"]').addEventListener('click', () => openClient(al, true));
    popmenu.querySelector('[data-m="rename"]').addEventListener('click', () => renameAlbum(al));
    popmenu.querySelector('[data-m="link"]').addEventListener('click', () => copyAlbumLink(al));
    popmenu.querySelector('[data-m="del"]').addEventListener('click', () => deleteAlbum(al.id));

    // links
    card.querySelector('[data-act="orig"]').addEventListener('click', () => {
      if (al.sourceUrl) window.open(al.sourceUrl, '_blank'); else toast('Album này không có thư mục Drive nguồn');
    });
    card.querySelector('[data-act="addfolder"]').addEventListener('click', () => toast('Tính năng thêm thư mục sẽ được bổ sung sau'));
    card.querySelector('[data-act="editmax"]').addEventListener('click', () => editMax(al));
    card.querySelector('[data-act="download"]').addEventListener('change', e => { al.allowDownload = e.target.checked; al.lastActivity = Date.now(); saveAlbums(al); });

    // mở chi tiết album khi bấm ảnh bìa / tên
    card.querySelector('.acard-cover').addEventListener('click', () => openAlbumDetail(al.id));
    card.querySelector('.acard-title').addEventListener('click', () => openAlbumDetail(al.id));

    return card;
  }

  function closeMenus() { $$('.status-menu, .popmenu').forEach(m => m.hidden = true); }
  document.addEventListener('click', () => closeMenus());

  function renameAlbum(al) {
    const name = window.prompt('Tên album:', al.name); if (name === null) return;
    const client = window.prompt('Tên khách (có thể để trống):', al.client || '');
    al.name = name.trim() || al.name; if (client !== null) al.client = client.trim();
    al.lastActivity = Date.now(); saveAlbums(al); renderAlbums(); toast('Đã cập nhật');
  }
  function editMax(al) {
    const v = window.prompt('Số ảnh tối đa khách được chọn (0 = không giới hạn):', al.maxCount || 0);
    if (v === null) return;
    const n = parseInt(v, 10); al.maxCount = Number.isFinite(n) && n > 0 ? n : 0;
    saveAlbums(al); renderAlbums();
  }
  function deleteAlbum(id) {
    const a = albums.find(x => x.id === id); if (!a) return;
    if (!window.confirm(`Chuyển album “${a.name}” vào thùng rác?`)) return;
    a.trashed = true; a.trashedAt = Date.now(); a.lastActivity = Date.now();
    saveAlbums(a); renderAlbums(); updateTrashBadge(); toast('Đã chuyển vào thùng rác');
    if (detailAlbum && detailAlbum.id === id) { detailAlbum = null; gotoPage('page-albums'); }
  }
  /* ---------- Thùng rác ---------- */
  function renderTrash() {
    const grid = $('#trash-grid'), empty = $('#trash-empty-msg'); grid.innerHTML = '';
    const list = trashedAlbums().sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    $('#trash-empty').style.display = list.length ? '' : 'none';
    if (!list.length) { empty.hidden = false; grid.hidden = true; updateTrashBadge(); return; }
    empty.hidden = true; grid.hidden = false;
    list.forEach(al => {
      const cover = (al.photos[0] && al.photos[0].src) || '';
      const card = document.createElement('div');
      card.className = 'tcard';
      card.innerHTML = `
        <div class="acard-cover">${cover ? `<img src="${escapeAttr(cover)}" alt="">` : '<span class="ph">🖼️</span>'}</div>
        <div class="tcard-body">
          <strong>${escapeHtml(al.name)}</strong>
          <small>${al.photos.length} ảnh · xoá ${fmtVN(toYMD(al.trashedAt || Date.now()))}</small>
          <div class="tcard-acts">
            <button class="btn ghost sm" data-act="restore">Khôi phục</button>
            <button class="btn danger sm" data-act="purge">Xoá vĩnh viễn</button>
          </div>
        </div>`;
      card.querySelector('[data-act="restore"]').addEventListener('click', () => restoreAlbum(al.id));
      card.querySelector('[data-act="purge"]').addEventListener('click', () => purgeAlbum(al.id));
      grid.appendChild(card);
    });
    updateTrashBadge();
  }
  function restoreAlbum(id) {
    const a = albums.find(x => x.id === id); if (!a) return;
    a.trashed = false; a.trashedAt = 0; a.lastActivity = Date.now();
    saveAlbums(a); renderTrash(); renderAlbums(); toast('Đã khôi phục album');
  }
  function purgeAlbum(id) {
    const a = albums.find(x => x.id === id);
    if (!window.confirm(`Xoá vĩnh viễn album “${a ? a.name : ''}”? Thư mục ảnh trên Google Drive cũng sẽ được chuyển vào thùng rác Drive. Không thể lấy lại trên web.`)) return;
    if (a) driveTrashAlbum(a);            // đồng bộ xoá thư mục trên Drive (nền)
    albums = albums.filter(x => x.id !== id); saveAlbumsLocal(); apiDeleteAlbum(id); renderTrash(); toast('Đã xoá vĩnh viễn');
  }
  $('#trash-empty').addEventListener('click', () => {
    const list = trashedAlbums(); if (!list.length) return;
    if (!window.confirm(`Xoá vĩnh viễn ${list.length} album trong thùng rác? Thư mục ảnh trên Google Drive cũng sẽ được chuyển vào thùng rác Drive. Không thể lấy lại.`)) return;
    list.forEach(a => { driveTrashAlbum(a); apiDeleteAlbum(a.id); });
    albums = activeAlbums(); saveAlbumsLocal(); renderTrash(); toast('Đã dọn sạch thùng rác');
  });

  /* ---------- Chi tiết album ---------- */
  function gotoPage(id) { $$('.page').forEach(p => p.classList.toggle('active', p.id === id)); window.scrollTo({ top: 0 }); }
  function openAlbumDetail(id) {
    const al = albums.find(x => x.id === id); if (!al) return;
    detailAlbum = al; detailSet = 'goc'; pickingCover = false;
    $$('.sb-nav a').forEach(x => x.classList.toggle('active', x.dataset.page === 'albums'));
    gotoPage('page-albumdetail');
    renderDetail();
    // lấy bản mới nhất từ máy chủ (cập nhật Ảnh chọn khách vừa gửi)
    if (apiSync) {
      apiGetAlbum(id).then(fresh => {
        const idx = albums.findIndex(x => x.id === id);
        const local = idx >= 0 ? albums[idx] : detailAlbum;
        // Tránh đua thời gian: nếu bản local vừa được sửa (bìa/album…) mới hơn bản máy chủ
        // thì giữ local, không ghi đè bằng dữ liệu cũ vừa tải về.
        if (local && (local.lastActivity || 0) > (fresh.lastActivity || 0)) return;
        if (idx >= 0) { albums[idx] = fresh; saveAlbumsLocal(); }
        if (detailAlbum && detailAlbum.id === id) { detailAlbum = fresh; renderDetail(); }
      }).catch(() => {});
    }
  }
  const ICN_DL = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
  const ICN_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const ICN_XX = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  function detailSelPhotos() { return detailAlbum.photos.filter(p => p.review === 'selected' || p.selected); }
  function renderSetList() {
    const al = detailAlbum, wrap = $('#ad-sets'); if (!wrap) return;
    const rows = [
      { key: 'goc', name: 'Ảnh gốc', count: al.photos.length, fixed: true },
      { key: 'chon', name: 'Ảnh chọn', count: detailSelPhotos().length, fixed: true },
      ...al.sets.map(s => ({ key: s.id, name: s.name, count: (s.photos || []).length, fixed: false }))
    ];
    wrap.innerHTML = '';
    rows.forEach(r => {
      const div = document.createElement('div');
      div.className = 'set-item' + (detailSet === r.key ? ' active' : '');
      div.innerHTML = `<span class="set-label">${escapeHtml(r.name)}</span><span class="cnt">${r.count}</span>` +
        `<button class="set-dl" title="Tải .zip">${ICN_DL}</button>` +
        (r.fixed ? '' : `<button class="set-edit" title="Đổi tên album">${ICN_EDIT}</button><button class="set-del" title="Xoá album">${ICN_XX}</button>`);
      div.addEventListener('click', () => { if (detailPick) { detailPick = false; detailPicked.clear(); $('#ad-pickbar').hidden = true; $('#ad-pick').classList.remove('active'); $('#ad-pick').textContent = 'Chọn'; } detailSet = r.key; renderDetail(); });
      div.querySelector('.set-dl').addEventListener('click', e => { e.stopPropagation(); zipDownloadSet(setList(r.key), zipName(r.key), e.currentTarget); });
      if (!r.fixed) {
        div.querySelector('.set-edit').addEventListener('click', e => { e.stopPropagation(); renameSet(r.key); });
        div.querySelector('.set-del').addEventListener('click', e => { e.stopPropagation(); deleteSet(r.key); });
      }
      wrap.appendChild(div);
    });
  }
  function renderDetail() {
    const al = detailAlbum; if (!al) return;
    normalizeSets(al);
    $('#ad-name').textContent = al.name;
    const parts = [];
    if (al.client) parts.push(al.client);
    if (al.shootDate) parts.push('Chụp ' + fmtVN(al.shootDate) + (al.shootHour != null ? ` ${al.shootHour}h` : ''));
    if (al.deadline) parts.push('Hạn trả ' + fmtVN(al.deadline));
    $('#ad-meta').textContent = parts.join(' · ') || 'Chưa có thông tin';
    const st = statusOf(al.status);
    const stEl = $('#ad-status'); stEl.className = 'status-pill ' + st.cls; stEl.innerHTML = `<span class="dot"></span>${st.label}`;

    const cov = albumCover(al);
    $('#ad-cover').src = cov || '';
    $('#ad-cover').style.objectPosition = al.coverPos || '50% 50%';

    renderSetList();

    let list, title;
    if (detailSet === 'chon') { list = detailSelPhotos(); title = `ẢNH CHỌN (${list.length})`; }
    else if (detailSet === 'goc') { list = al.photos; title = `ẢNH GỐC (${al.photos.length})`; }
    else {
      const s = al.sets.find(x => x.id === detailSet);
      if (!s) { detailSet = 'goc'; list = al.photos; title = `ẢNH GỐC (${al.photos.length})`; }
      else { list = s.photos || []; title = `${(s.name || 'ALBUM').toUpperCase()} (${list.length})`; }
    }
    detailList = list.slice().sort((a, b) => (detailSort === 'az' ? 1 : -1) * String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    $('#ad-set-title').textContent = title;
    $('#ad-pick').style.display = detailSet === 'chon' ? 'none' : '';
    $('#ad-pickbar').hidden = !(detailPick && detailSet !== 'chon');
    $('#ad-sort').textContent = detailSort === 'az' ? 'A→Z' : 'Z→A';
    $$('#ad-view button').forEach(b => b.classList.toggle('active', b.dataset.v === detailView));
    $('#ad-grid').classList.toggle('list-view', detailView === 'list');
    const grid = $('#ad-grid'); grid.innerHTML = '';
    if (!detailList.length) {
      grid.innerHTML = detailSet === 'chon'
        ? `<p class="sub" style="color:var(--muted)">Khách chưa chọn ảnh nào. Khi khách chọn, ảnh sẽ tự xuất hiện ở đây.</p>`
        : `<p class="sub" style="color:var(--muted)">Album này chưa có ảnh.</p>`;
      return;
    }
    detailShown = 0;
    appendDetailBatch();
    setupDetailSentinel();
  }
  function renameSet(id) {
    const s = detailAlbum.sets.find(x => x.id === id); if (!s) return;
    const name = window.prompt('Tên album:', s.name); if (name === null) return;
    s.name = name.trim() || s.name; detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum); renderDetail();
  }
  function deleteSet(id) {
    const s = detailAlbum.sets.find(x => x.id === id); if (!s) return;
    if (!window.confirm(`Xoá album “${s.name}”? (Ảnh gốc trên Drive không bị ảnh hưởng)`)) return;
    detailAlbum.sets = detailAlbum.sets.filter(x => x.id !== id);
    if (detailSet === id) detailSet = 'goc';
    detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum); renderDetail();
  }
  function buildDetailThumb(p, idx) {
    const ext = (String(p.name).split('.').pop() || 'IMG').toUpperCase().slice(0, 4);
    const picked = detailPick && detailPicked.has(photoKey(p));
    const d = document.createElement('div');
    d.className = 'dthumb' + (p.selected ? ' sel' : '') + (detailPick ? ' pickable' : '') + (picked ? ' picked' : '');
    d.innerHTML = `<img src="${escapeAttr(p.src)}" alt="" loading="lazy" decoding="async"><span class="dtag">${escapeHtml(ext)}</span>${p.selected ? '<span class="dheart">♥</span>' : ''}${detailPick ? '<span class="pickbox"></span>' : ''}`;
    attachImgFallback(d.querySelector('img'), p);
    d.addEventListener('click', () => { if (detailPick) togglePickOne(p, d); else openLightbox(detailList, idx, 'view'); });
    return d;
  }
  function buildDetailRow(p, idx) {
    const ext = (String(p.name).split('.').pop() || 'IMG').toUpperCase().slice(0, 4);
    const picked = detailPick && detailPicked.has(photoKey(p));
    const d = document.createElement('div');
    d.className = 'drow' + (p.selected ? ' sel' : '') + (detailPick ? ' pickable' : '') + (picked ? ' picked' : '');
    d.innerHTML = `${detailPick ? '<span class="pickbox"></span>' : ''}<img src="${escapeAttr(p.src)}" alt="" loading="lazy" decoding="async">
      <span class="nm">${escapeHtml(p.name)}</span>
      ${p.note ? '<span title="' + escapeAttr(p.note) + '">📝</span>' : ''}
      ${p.selected ? '<span class="hrt">♥</span>' : ''}
      <span class="ext">${escapeHtml(ext)}</span>`;
    attachImgFallback(d.querySelector('img'), p);
    d.addEventListener('click', () => { if (detailPick) togglePickOne(p, d); else openLightbox(detailList, idx, 'view'); });
    return d;
  }
  function togglePickOne(p, el) {
    const k = photoKey(p);
    if (detailPicked.has(k)) { detailPicked.delete(k); el.classList.remove('picked'); }
    else { detailPicked.add(k); el.classList.add('picked'); }
    updatePickBar();
  }
  function updatePickBar() {
    $('#ad-pick-n').textContent = detailPicked.size;
    $('#ad-pick-del').disabled = !detailPicked.size;
  }
  function currentSetArray() {
    const al = detailAlbum;
    if (detailSet === 'goc') return al.photos;
    if (detailSet === 'chon') return null;             // "Ảnh chọn" là view dẫn xuất, không xoá ở đây
    const s = al.sets.find(x => x.id === detailSet);
    if (!s) return null;
    if (!Array.isArray(s.photos)) s.photos = [];
    return s.photos;
  }
  function togglePick(on) {
    detailPick = on; detailPicked.clear();
    $('#ad-pickbar').hidden = !on;
    $('#ad-pick').classList.toggle('active', on);
    $('#ad-pick').textContent = on ? 'Xong' : 'Chọn';
    updatePickBar();
    renderDetail();
  }
  async function deletePicked() {
    const arr = currentSetArray(); if (!arr) return;
    const toDel = arr.filter(p => detailPicked.has(photoKey(p)));
    if (!toDel.length) return;
    if (!window.confirm(`Xoá ${toDel.length} ảnh khỏi album? Ảnh tương ứng cũng sẽ được chuyển vào thùng rác Google Drive.`)) return;
    const delKeys = new Set(toDel.map(photoKey));
    const kept = arr.filter(p => !delKeys.has(photoKey(p)));
    if (detailSet === 'goc') detailAlbum.photos = kept;
    else { const s = detailAlbum.sets.find(x => x.id === detailSet); if (s) s.photos = kept; }
    // nếu ảnh bìa bị xoá -> bỏ bìa
    if (detailAlbum.cover && toDel.some(p => detailAlbum.cover === (p.full || p.src) || (p.driveId && detailAlbum.cover.indexOf(p.driveId) >= 0))) detailAlbum.cover = '';
    detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum);
    togglePick(false); renderAlbums();
    toast(`Đã xoá ${toDel.length} ảnh`);
    driveTrashFiles(toDel.map(p => p.driveId).filter(Boolean));   // đồng bộ xoá trên Drive (nền)
  }

  /* ---------- Thêm ảnh vào album có sẵn ---------- */
  function currentSetFolderId() {
    const al = detailAlbum;
    if (detailSet === 'goc') return extractFolderId(al.sourceUrl || '');
    const s = al.sets.find(x => x.id === detailSet);
    return s ? extractFolderId(s.sourceUrl || '') : '';
  }
  // Hộp thoại hỏi cách xử lý ảnh trùng tên -> trả 'overwrite' | 'both' | 'cancel'
  function askDuplicate(names) {
    return new Promise(resolve => {
      const m = $('#dup-modal');
      const list = names.slice(0, 6).join(', ') + (names.length > 6 ? `… (+${names.length - 6})` : '');
      $('#dup-text').innerHTML = `Có <b>${names.length}</b> ảnh trùng tên đã có trong album:<br><span style="color:var(--muted)">${escapeHtml(list)}</span><br><br>Bạn muốn xử lý thế nào?`;
      m.classList.add('open');
      const done = v => { m.classList.remove('open'); $('#dup-over').onclick = $('#dup-both').onclick = $('#dup-cancel').onclick = null; resolve(v); };
      $('#dup-over').onclick = () => done('overwrite');
      $('#dup-both').onclick = () => done('both');
      $('#dup-cancel').onclick = () => done('cancel');
    });
  }
  async function addPhotosToSet(files) {
    files = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!files.length) { toast('Chỉ nhận file ảnh'); return; }
    if (detailSet === 'chon') { toast('Không thể thêm ảnh vào mục “Ảnh chọn”. Hãy chọn “Ảnh gốc” hoặc một album.'); return; }
    if (!canUseDrive()) { toast('Chưa kết nối Google Drive — mở phần “Kết nối Drive”'); openDriveModal(); return; }
    const folderId = currentSetFolderId();
    if (!folderId) { toast('Album này không có thư mục Google Drive nên không thêm ảnh được'); return; }
    const arr = currentSetArray(); if (!arr) return;
    // phát hiện trùng tên
    const existing = new Set(arr.map(p => p.name));
    const dupNames = [...new Set(files.filter(f => existing.has(f.name)).map(f => f.name))];
    let mode = 'both';
    if (dupNames.length) { mode = await askDuplicate(dupNames); if (mode === 'cancel') return; }
    // token im lặng
    if (!(driveToken && Date.now() < driveTokenExp)) {
      try { await ensureDriveToken(false); }
      catch (_) { toast('Phiên Google Drive đã hết — bấm “Liên kết tài khoản” lại'); openDriveModal(); return; }
    }
    const albumRef = detailAlbum, setRef = detailSet;
    toast('Đang thêm ảnh vào album…');
    runAddJob(albumRef, setRef, folderId, files, mode, dupNames);
  }
  async function runAddJob(album, setId, folderId, files, mode, dupNames) {
    const ui = createUploadItem('+ ' + (files.length) + ' ảnh → ' + album.name, files.length);
    try {
      const token = await driveTokenOrPrompt();
      const added = await uploadFilesToFolder(files, folderId, token, ui);
      if (!added.length) throw new Error('Không upload được ảnh nào');
      // lấy mảng ảnh đích hiện tại của album (album có thể đã thay đổi reference do đồng bộ)
      const target = setId === 'goc' ? album.photos : (album.sets.find(x => x.id === setId) || {}).photos;
      if (!Array.isArray(target)) throw new Error('Không tìm thấy album đích');
      let base = target;
      if (mode === 'overwrite' && dupNames.length) {
        const dupSet = new Set(dupNames);
        const old = target.filter(p => dupSet.has(p.name));
        const rm = new Set(old.map(photoKey));
        base = target.filter(p => !rm.has(photoKey(p)));
        driveTrashFiles(old.map(p => p.driveId).filter(Boolean)); // xoá bản cũ trên Drive
      }
      const merged = base.concat(added);
      if (setId === 'goc') album.photos = merged;
      else { const s = album.sets.find(x => x.id === setId); if (s) s.photos = merged; }
      album.lastActivity = Date.now(); saveAlbums(album);
      if (detailAlbum && detailAlbum.id === album.id) renderDetail();
      renderAlbums();
      ui.done('✓ Đã thêm ' + added.length + ' ảnh' + (mode === 'overwrite' && dupNames.length ? ' (ghi đè ' + dupNames.length + ')' : ''));
    } catch (err) {
      ui.fail('✕ Lỗi thêm ảnh: ' + (err.message || err));
      toast('Lỗi thêm ảnh: ' + (err.message || err));
    }
  }

  function appendDetailBatch() {
    const grid = $('#ad-grid');
    const frag = document.createDocumentFragment();
    const end = Math.min(detailShown + DETAIL_BATCH, detailList.length);
    for (let i = detailShown; i < end; i++) {
      frag.appendChild(detailView === 'list' ? buildDetailRow(detailList[i], i) : buildDetailThumb(detailList[i], i));
    }
    grid.appendChild(frag);
    detailShown = end;
  }
  function setupDetailSentinel() {
    if (detailObserver) { detailObserver.disconnect(); detailObserver = null; }
    let s = $('#ad-sentinel'); if (s) s.remove();
    if (detailShown >= detailList.length) return;
    s = document.createElement('div'); s.id = 'ad-sentinel'; s.style.cssText = 'height:1px;grid-column:1/-1';
    $('#ad-grid').appendChild(s);
    detailObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { s.remove(); appendDetailBatch(); setupDetailSentinel(); }
    }, { rootMargin: '800px' });
    detailObserver.observe(s);
  }
  $('#ad-back').addEventListener('click', () => { gotoPage('page-albums'); renderAlbums(); });

  /* ---------- Tải & nén .zip (cho studio) ---------- */
  function setList(set) {
    const al = detailAlbum;
    if (set === 'chon') return al.photos.filter(p => p.review === 'selected' || p.selected);
    if (set === 'goc') return al.photos;
    const s = (al.sets || []).find(x => x.id === set); return s ? (s.photos || []) : [];
  }
  function zipName(set) {
    const al = detailAlbum;
    const base = (al.client || al.name || 'album').replace(/[\\/:*?"<>|]+/g, '_').trim();
    let suffix = '';
    if (set === 'chon') suffix = ' - Anh chon';
    else if (set !== 'goc') { const s = (al.sets || []).find(x => x.id === set); if (s) suffix = ' - ' + (s.name || 'Album').replace(/[\\/:*?"<>|]+/g, '_'); }
    return base + suffix;
  }
  function safeFileName(name, i, used) {
    let n = String(name || `anh_${i + 1}`).replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]{2,5}$/i.test(n)) n += '.jpg';
    if (used.has(n)) { const dot = n.lastIndexOf('.'); n = n.slice(0, dot) + '_' + (i + 1) + n.slice(dot); }
    used.add(n); return n;
  }
  async function zipDownloadSet(list, fname, btn) {
    if (!list || !list.length) { toast('Folder này chưa có ảnh để tải'); return; }
    if (typeof JSZip === 'undefined') { toast('Chưa tải được thư viện nén, kiểm tra mạng rồi thử lại'); return; }
    if (list.length > 150 && !window.confirm(`Tải & nén ${list.length} ảnh gốc có thể nặng và lâu. Tiếp tục?`)) return;
    const icon = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.style.width = 'auto'; btn.style.padding = '0 8px'; }
    const setBtn = t => { if (btn) btn.textContent = t; };
    const zip = new JSZip(); const used = new Set(); let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]; setBtn(`${i + 1}/${list.length}`);
      const id = p.driveId || driveIdFromThumb(p.src);
      try {
        const url = id
          ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${FIXED_DRIVE_KEY}&supportsAllDrives=true`
          : (p.full || p.src);
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        zip.file(safeFileName(p.name, i, used), await res.blob());
        ok++;
      } catch (_) { fail++; }
    }
    if (!ok) { toast('Không tải được ảnh — kiểm tra thư mục Drive đã chia sẻ công khai chưa'); if (btn) { btn.disabled = false; btn.innerHTML = icon; btn.style.width = ''; btn.style.padding = ''; } return; }
    setBtn('Nén…');
    const blob = await zip.generateAsync({ type: 'blob' }, m => setBtn(Math.round(m.percent) + '%'));
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname + '.zip';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    if (btn) { btn.disabled = false; btn.innerHTML = icon; btn.style.width = ''; btn.style.padding = ''; }
    toast(`Đã tải ${ok} ảnh${fail ? ` (lỗi ${fail})` : ''} → ${fname}.zip`);
  }
  $('#ad-preview').addEventListener('click', () => { if (detailAlbum) openClient(detailAlbum, true); });
  $('#ad-share').addEventListener('click', () => { if (detailAlbum) openShare(detailAlbum); });
  $('#ad-sync').addEventListener('click', async () => {
    const al = detailAlbum; if (!al) return;
    if (!al.sourceUrl) { toast('Album này không lấy từ Google Drive nên không đồng bộ được'); return; }
    const btn = $('#ad-sync'); const old = btn.innerHTML; btn.disabled = true; btn.textContent = 'Đang đồng bộ…';
    try {
      const fresh = await buildDrivePhotos(al.sourceUrl, FIXED_DRIVE_KEY);
      // Giữ lựa chọn/ghi chú cho ảnh còn tồn tại (ghép theo Drive ID)
      const oldById = {};
      al.photos.forEach(p => { const id = p.driveId || driveIdFromThumb(p.src); if (id) oldById[id] = p; });
      let added = 0, kept = 0;
      fresh.forEach(np => {
        const o = oldById[np.driveId];
        if (o) { np.review = o.review || ''; np.selected = !!o.selected; np.note = o.note || ''; kept++; }
        else added++;
      });
      const removed = al.photos.length - kept;
      al.photos = fresh;
      if (al.cover && !fresh.some(p => (p.full || p.src) === al.cover)) al.cover = ''; // bìa cũ đã bị xoá
      al.lastActivity = Date.now();
      saveAlbums(al);
      renderDetail(); renderAlbums();
      toast(`Đã đồng bộ: +${added} ảnh mới, bỏ ${removed} ảnh, giữ ${kept} ảnh`);
    } catch (err) { toast('Lỗi đồng bộ: ' + (err.message || err)); }
    finally { btn.disabled = false; btn.innerHTML = old; }
  });
  $('#ad-sort').addEventListener('click', () => { detailSort = detailSort === 'az' ? 'za' : 'az'; renderDetail(); });
  $$('#ad-view button').forEach(b => b.addEventListener('click', () => { detailView = b.dataset.v; renderDetail(); }));
  $('#ad-pick').addEventListener('click', () => togglePick(!detailPick));
  $('#ad-pick-cancel').addEventListener('click', () => togglePick(false));
  $('#ad-pick-del').addEventListener('click', deletePicked);
  $('#ad-pick-all').addEventListener('click', () => {
    const allSel = detailList.every(p => detailPicked.has(photoKey(p)));
    detailPicked.clear();
    if (!allSel) detailList.forEach(p => detailPicked.add(photoKey(p)));
    updatePickBar(); renderDetail();
  });
  // Thêm ảnh: nút + ô chọn file ẩn
  $('#ad-add-photos').addEventListener('click', () => $('#ad-file-input').click());
  $('#ad-file-input').addEventListener('change', e => { addPhotosToSet(e.target.files); e.target.value = ''; });
  // Kéo-thả file vào vùng ảnh để thêm
  (function () {
    const zone = $('#ad-grid-wrap'); if (!zone) return;
    let depth = 0;
    zone.addEventListener('dragenter', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); depth++; zone.classList.add('drop-on'); } });
    zone.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
    zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('drop-on'); });
    zone.addEventListener('drop', e => {
      if (!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) return;
      e.preventDefault(); depth = 0; zone.classList.remove('drop-on');
      addPhotosToSet(e.dataTransfer.files);
    });
  })();
  $('#ad-change-cover').addEventListener('click', openCoverModal);
  $('#ad-add-set').addEventListener('click', async () => {
    if (!detailAlbum) return;
    const name = window.prompt('Tên album mới:', 'Ảnh sửa'); if (name === null) return;
    const link = window.prompt('Dán link thư mục Google Drive cho album này:'); if (!link || !link.trim()) return;
    toast('Đang tải ảnh…');
    try {
      const photos = await buildDrivePhotos(link.trim(), FIXED_DRIVE_KEY);
      normalizeSets(detailAlbum);
      const id = genSetId();
      detailAlbum.sets.push({ id, name: name.trim() || 'Album', sourceUrl: link.trim(), photos });
      if (detailAlbum.status === 'choosing' || detailAlbum.status === 'done') detailAlbum.status = 'editing';
      detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum);
      detailSet = id; renderDetail(); renderAlbums();
      toast(`Đã thêm album “${name.trim()}” (${photos.length} ảnh)`);
    } catch (err) { toast('Lỗi: ' + (err.message || err)); }
  });

  /* ---------- Popup đổi ảnh bìa (chọn ảnh + chỉnh vị trí crop) ---------- */
  let cropUrl = '', cropX = 50, cropY = 50;
  function openCoverModal() {
    if (!detailAlbum) return;
    const grid = $('#cover-pick-grid'); grid.innerHTML = '';
    detailAlbum.photos.forEach(p => {
      const im = document.createElement('img'); im.src = p.src; im.loading = 'lazy';
      attachImgFallback(im, p);
      im.addEventListener('click', () => coverPick(p));
      grid.appendChild(im);
    });
    $('#cover-step1').hidden = false; $('#cover-step2').hidden = true;
    $('#cover-back').hidden = true; $('#cover-save').hidden = true;
    $('#cover-title').textContent = 'Chọn ảnh làm bìa';
    $('#cover-modal').classList.add('open');
  }
  function coverPick(p) {
    cropUrl = p.full || p.src; cropX = 50; cropY = 50;
    const fr = $('#crop-frame'); fr.style.backgroundImage = `url("${cropUrl}")`; fr.style.backgroundPosition = '50% 50%';
    $('#cover-step1').hidden = true; $('#cover-step2').hidden = false;
    $('#cover-back').hidden = false; $('#cover-save').hidden = false;
    $('#cover-title').textContent = 'Chỉnh vị trí ảnh bìa';
  }
  function closeCover() { $('#cover-modal').classList.remove('open'); }
  (function () {
    const fr = $('#crop-frame'); if (!fr) return;
    let drag = false, lx = 0, ly = 0;
    const down = e => { drag = true; const t = e.touches ? e.touches[0] : e; lx = t.clientX; ly = t.clientY; };
    const move = e => {
      if (!drag) return; const t = e.touches ? e.touches[0] : e;
      cropX = Math.max(0, Math.min(100, cropX - (t.clientX - lx) / fr.clientWidth * 100));
      cropY = Math.max(0, Math.min(100, cropY - (t.clientY - ly) / fr.clientHeight * 100));
      lx = t.clientX; ly = t.clientY; fr.style.backgroundPosition = `${cropX}% ${cropY}%`;
      if (e.cancelable) e.preventDefault();
    };
    const up = () => { drag = false; };
    fr.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    fr.addEventListener('touchstart', down, { passive: true }); fr.addEventListener('touchmove', move, { passive: false }); fr.addEventListener('touchend', up);
  })();
  $('#cover-x').addEventListener('click', closeCover);
  $('#cover-cancel').addEventListener('click', closeCover);
  $('#cover-back').addEventListener('click', openCoverModal);
  $('#cover-modal').addEventListener('click', e => { if (e.target.id === 'cover-modal') closeCover(); });
  $('#cover-save').addEventListener('click', () => {
    if (!detailAlbum || !cropUrl) return;
    detailAlbum.cover = cropUrl; detailAlbum.coverPos = `${Math.round(cropX)}% ${Math.round(cropY)}%`;
    detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum);
    closeCover(); renderDetail(); renderAlbums(); toast('Đã cập nhật ảnh bìa');
  });

  /* ---------- Share link ---------- */
  function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64decode(s) { return decodeURIComponent(escape(atob(s))); }
  function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'g' + (h >>> 0).toString(36); }
  function encodeAlbum(al) {
    const p = al.photos.map(ph => {
      const did = ph.driveId || driveIdFromThumb(ph.src);
      return did ? [ph.name, did] : [ph.name, ph.src, ph.full || ph.src, 1];  // [name,id] cho Drive; [name,src,full,1] cho URL thường
    });
    let ci = 0;
    if (al.cover) { const idx = al.photos.findIndex(x => (x.full || x.src) === al.cover); if (idx >= 0) ci = idx; }
    const payload = { aid: al.id, n: al.name, m: al.maxCount, an: al.allowNotes ? 1 : 0, dl: al.allowDownload ? 1 : 0, b: brand.name, w: brand.welcome, ci, p };
    return b64encode(JSON.stringify(payload));
  }
  function albumLink(al) {
    // Có máy chủ -> link ngắn ?al=ID (mở được mọi thiết bị, lựa chọn đồng bộ về studio)
    if (apiSync) return location.origin + location.pathname + '?al=' + encodeURIComponent(al.id);
    return location.origin + location.pathname + '#a=' + encodeAlbum(al);
  }
  function isLocalAlbum(al) { return al.photos.some(p => /^data:/.test(p.src)); }

  function openShare(al) {
    const local = isLocalAlbum(al);
    $('#share-warn').hidden = !local;
    const link = local ? '' : albumLink(al);
    $('#share-link').value = local ? '(không tạo được link cho album tải từ máy)' : link;
    $('#share-modal').dataset.link = link;
    $('#share-modal').classList.add('open');
  }
  function closeShare() { $('#share-modal').classList.remove('open'); }
  $('#share-close').addEventListener('click', closeShare);
  $('#share-modal').addEventListener('click', e => { if (e.target.id === 'share-modal') closeShare(); });
  $('#share-copy').addEventListener('click', () => {
    const link = $('#share-modal').dataset.link;
    if (!link) { toast('Album này không tạo được link chia sẻ'); return; }
    copyText(link, 'Đã sao chép link — gửi cho khách');
  });
  $('#share-open').addEventListener('click', () => { const link = $('#share-modal').dataset.link; if (link) window.open(link, '_blank'); });

  function copyAlbumLink(al) {
    if (isLocalAlbum(al)) { toast('Album “Tải từ máy” chỉ xem trên máy này — dùng Google Drive để có link'); return; }
    const link = albumLink(al);
    if (link.length > 60000) { toast('Album quá nhiều ảnh để nhúng vào link — hãy chia nhỏ'); return; }
    copyText(link, 'Đã sao chép link — gửi cho khách');
  }
  function copyText(text, okMsg) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(okMsg)).catch(() => window.prompt('Sao chép:', text));
    else window.prompt('Sao chép:', text);
  }

  async function resolveSharedAlbum() {
    // Link ngắn ?al=ID -> lấy album từ máy chủ (đồng bộ 2 chiều)
    const q = new URLSearchParams(location.search).get('al');
    if (q) {
      try {
        const data = await apiGetAlbum(q);
        data.photos.forEach(p => { if (!p.review) p.review = p.selected ? 'selected' : ''; });
        return { album: data, bound: false, remote: true };
      } catch (_) {
        return { error: 'Không tải được album — kiểm tra mạng hoặc link' };
      }
    }
    return decodeSharedAlbum();
  }
  function decodeSharedAlbum() {
    const m = location.hash.match(/[#&]a=([^&]+)/);
    if (!m) return null;
    let payload; try { payload = JSON.parse(b64decode(m[1])); } catch (_) { return null; }
    // Nếu album này có sẵn trên máy (cùng trình duyệt studio) -> thao tác thẳng trên album thật
    if (payload.aid) { const local = albums.find(x => x.id === payload.aid); if (local) return { album: local, bound: true }; }
    const id = strHash(m[1]);
    const photos = (payload.p || []).map((row, i) => {
      if (row.length === 2) { const did = row[1]; return { id: 'g' + i, name: row[0] || `anh_${i + 1}`, driveId: did, src: driveThumb(did, 'w400'), full: driveThumb(did, 'w1600'), selected: false, note: '' }; }
      return { id: 'g' + i, name: row[0] || `anh_${i + 1}`, src: row[1], full: row[2] || row[1], selected: false, note: '' };
    });
    const cidx = payload.ci || 0;
    const cover = photos[cidx] ? (photos[cidx].full || photos[cidx].src) : (payload.c || '');
    let al = { id, name: payload.n || 'Album', maxCount: payload.m || 0, allowNotes: !!payload.an, allowDownload: !!payload.dl, brandName: payload.b || 'Lam Miên Studio', welcome: payload.w || '', cover, photos };
    try { const saved = localStorage.getItem('lamMienGuest_' + id); if (saved) { const s = JSON.parse(saved); if (s && s.photos && s.photos.length) al = s; } } catch (_) {}
    return { album: al, bound: false };
  }

  /* ---------- Client picker ---------- */
  function openClient(al, bound, remote) {
    clientAlbum = al; clientBound = !!bound; clientRemote = !!remote; clientFilter = 'all';
    hideAllScreens(); $('#client').hidden = false;
    const brandName = al.brandName || brand.name;
    const welcome = al.welcome || brand.welcome || 'Chọn những khoảnh khắc bạn yêu thích';
    $('#client-brand').textContent = brandName;
    // chuẩn hoá trạng thái cũ (p.selected -> review)
    al.photos.forEach(p => { if (!p.review) p.review = p.selected ? 'selected' : ''; });
    // bật/tắt nút tải theo cài đặt album
    $('#dl-all').hidden = !al.allowDownload;
    // banner ảnh bìa
    const cov = albumCover(al);
    $('#client-cover').hidden = !cov;
    if (cov) {
      $('#client-cover-img').src = cov;
      $('#client-cover-img').style.objectPosition = al.coverPos || '50% 50%';
      $('#client-cover-title').textContent = al.name || welcome;   // mã KH
    }
    // nút quay lại (chỉ khi xem trước từ dashboard)
    let back = $('#client-back');
    if (bound) {
      if (!back) { back = document.createElement('button'); back.id = 'client-back'; back.className = 'btn ghost sm'; back.textContent = '← Bảng điều khiển'; back.style.marginLeft = 'auto'; $('.client-top').appendChild(back); back.addEventListener('click', () => { saveClient(); showApp(); }); }
      back.hidden = false;
    } else if (back) { back.hidden = true; }
    clientFilter = 'all'; clientFolder = 'goc'; clientSort = 'none'; clientView = 'masonry'; clientPage = 0;
    $('#cl-sort').classList.remove('on'); $('#cl-sort').title = 'Đang: thứ tự gốc';
    $$('#ctabs .ctab').forEach(c => c.classList.toggle('active', c.dataset.f === 'all'));
    $$('#cl-view button').forEach(x => x.classList.toggle('active', x.dataset.v === 'masonry'));
    $('#ctabs').style.display = ''; $('.cmeta').style.visibility = ''; $('#dl-all').style.display = ''; $('#finish-btn').style.display = '';
    renderFolders();
    renderClient();
    window.scrollTo({ top: 0 });
  }
  function renderFolders() {
    const wrap = $('#cfolders'); if (!wrap) return;
    normalizeSets(clientAlbum);
    const dl = clientAlbum.allowDownload;
    const fdl = key => dl ? `<span class="fdl" data-fdl="${key}" title="Tải cả album (.zip)"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span>` : '';
    const folders = [{ id: 'goc', name: 'Ảnh gốc', n: clientAlbum.photos.length },
      ...clientAlbum.sets.filter(s => (s.photos || []).length).map(s => ({ id: s.id, name: s.name, n: s.photos.length }))];
    wrap.innerHTML = folders.map(f =>
      `<button class="cfolder${clientFolder === f.id ? ' active' : ''}" data-folder="${f.id}">${escapeHtml(f.name)} <span class="fn">${f.n}</span>${fdl(f.id)}</button>`
    ).join('');
    wrap.querySelectorAll('.cfolder').forEach(b => b.addEventListener('click', () => {
      clientFolder = b.dataset.folder; clientPage = 0;
      const isGoc = clientFolder === 'goc';
      // Album phụ (ảnh sửa…): chỉ xem/tải, ẩn bộ lọc trạng thái + thanh chọn
      $('#ctabs').style.display = isGoc ? '' : 'none';
      $('.cmeta').style.visibility = isGoc ? '' : 'hidden';
      $('#dl-all').style.display = isGoc ? '' : 'none';
      $('#finish-btn').style.display = isGoc ? '' : 'none';
      renderFolders(); renderClient();
    }));
    wrap.querySelectorAll('.fdl').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (!clientAlbum.allowDownload) { toast('Album này không cho phép tải ảnh'); return; }
      const f = b.dataset.fdl;
      const fname = f === 'goc' ? 'Anh goc' : ((clientAlbum.sets.find(s => s.id === f) || {}).name || 'Album');
      const nm = `${clientAlbum.name || 'album'} - ${fname}`.replace(/[\\/:*?"<>|]+/g, '_');
      zipDownloadSet(folderPhotos(f), nm, b);
    }));
  }
  let saveClientTimer = null;
  function flushSaveClient() {
    if (!clientAlbum || !saveClientTimer) return;
    clearTimeout(saveClientTimer); saveClientTimer = null;
    if (clientBound) { clientAlbum.lastActivity = Date.now(); saveAlbums(clientAlbum); }
    else { try { localStorage.setItem('lamMienGuest_' + clientAlbum.id, JSON.stringify(clientAlbum)); } catch (_) {} if (clientRemote) pushGuestSelection(); }
  }
  // Gom mọi thay đổi rồi mới ghi (sau 500ms) -> bấm chọn không bị khựng
  function saveClient() {
    if (!clientAlbum) return;
    clearTimeout(saveClientTimer);
    saveClientTimer = setTimeout(() => { saveClientTimer = 1; flushSaveClient(); }, 500);
  }
  // Lưu nốt thay đổi đang chờ khi khách rời/ẩn tab (đóng nốt khe 500ms cuối khi F5/thoát)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaveClient(); });
  window.addEventListener('pagehide', flushSaveClient);
  window.addEventListener('pagehide', flushSaveClient);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaveClient(); });
  function cSel() { return clientAlbum ? clientAlbum.photos.filter(p => p.review === 'selected') : []; }
  function cCount(state) { return clientAlbum ? clientAlbum.photos.filter(p => p.review === state).length : 0; }

  const ICN = {
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    later: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
  };
  function buildPhotoCard(p) {
    const editing = clientFolder !== 'goc';
    const dlAllowed = clientAlbum && clientAlbum.allowDownload;
    const card = document.createElement('figure');
    card.className = 'pcard' + (p.review === 'selected' ? ' s-selected' : p.review ? ' s-' + p.review : '');
    card.dataset.id = p.id;
    if (editing) {
      card.innerHTML = `
        <img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.name)}" loading="lazy" decoding="async">
        <div class="pbar"><span class="fname" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</span>${dlAllowed ? `<button class="more-btn" data-a="download" title="Tải ảnh">${ICN.dl}</button>` : ''}</div>`;
    } else {
      card.innerHTML = `
        <img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.name)}" loading="lazy" decoding="async">
        <div class="pbar">
          <span class="fname" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</span>
          <button class="choosebtn${p.review === 'selected' ? ' on' : ''}" data-a="choose">${p.review === 'selected' ? '✓' : 'Chọn'}</button>
          <div class="pmore">
            <button class="more-btn" data-a="more" title="Thêm">${ICN.dots}</button>
            <div class="pmenu" hidden>
              <button data-a="copy">${ICN.copy}<span>Chép tên</span></button>
              ${dlAllowed ? `<button data-a="download">${ICN.dl}<span>Tải ảnh</span></button>` : ''}
              <button data-a="note">${ICN.note}<span>Ghi chú</span></button>
              <button class="${p.review === 'later' ? 'on' : ''}" data-a="later">${ICN.later}<span>Xem lại sau</span></button>
              <button data-a="skip">${ICN.skip}<span>Bỏ qua</span></button>
            </div>
          </div>
        </div>`;
    }
    const im = card.querySelector('img');
    // Giữ chỗ đúng tỉ lệ ảnh (chống nhảy layout) + khung skeleton mờ -> ảnh fade vào
    if (clientView !== 'list') {
      // Biết kích thước -> giữ chỗ đúng tỉ lệ ngay; chưa biết -> lấy tỉ lệ thật khi ảnh tải xong
      if (p.w && p.h) im.style.aspectRatio = `${p.w} / ${p.h}`;
      card.classList.add('skel');
      const markLoaded = () => {
        if (!(p.w && p.h) && im.naturalWidth) { im.style.aspectRatio = `${im.naturalWidth} / ${im.naturalHeight}`; p.w = im.naturalWidth; p.h = im.naturalHeight; }
        im.classList.add('loaded'); card.classList.remove('skel');
      };
      if (im.complete && im.naturalWidth) markLoaded(); else im.addEventListener('load', markLoaded);
    } else { im.classList.add('loaded'); }
    im.addEventListener('click', () => openLightbox(clientList, clientList.indexOf(p), editing ? 'view' : 'client'));
    attachImgFallback(im, p);
    card.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const a = b.dataset.a;
      if (a === 'more') { const m = card.querySelector('.pmenu'); const open = m.hidden; closeClientMenus(); m.hidden = !open; return; }
      closeClientMenus();
      if (a === 'choose') setReview(p.id, 'selected');
      else if (a === 'later') setReview(p.id, 'later');
      else if (a === 'skip') setReview(p.id, 'skipped');
      else if (a === 'note') openNote(p.id);
      else if (a === 'download') downloadPhoto(p);
      else if (a === 'copy') copyText(p.name, 'Đã chép tên ảnh');
    }));
    return card;
  }
  function closeClientMenus() { $$('#photo-grid .pmenu').forEach(m => m.hidden = true); }
  document.addEventListener('click', closeClientMenus);
  function appendClientBatch() {
    const grid = $('#photo-grid');
    const frag = document.createDocumentFragment();
    const end = Math.min(clientShown + CLIENT_BATCH, clientList.length);
    for (let i = clientShown; i < end; i++) frag.appendChild(buildPhotoCard(clientList[i]));
    grid.appendChild(frag);
    clientShown = end;
  }
  function setupClientSentinel() {
    if (clientObserver) { clientObserver.disconnect(); clientObserver = null; }
    let sentinel = $('#client-sentinel');
    if (sentinel) sentinel.remove();
    if (clientShown >= clientList.length) return;
    sentinel = document.createElement('div');
    sentinel.id = 'client-sentinel';
    sentinel.style.cssText = 'height:1px';
    $('#photo-grid').after(sentinel);
    clientObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { sentinel.remove(); appendClientBatch(); setupClientSentinel(); }
    }, { rootMargin: '900px' });
    clientObserver.observe(sentinel);
  }
  function passFilter(p) {
    switch (clientFilter) {
      case 'selected': return p.review === 'selected';
      case 'later': return p.review === 'later';
      case 'skipped': return p.review === 'skipped';
      case 'unseen': return !p.review;
      default: return true;
    }
  }
  function renderClient() {
    const grid = $('#photo-grid'); grid.innerHTML = '';
    if (!clientAlbum) return;
    grid.className = 'photo-grid ' + clientView;
    const base = folderPhotos(clientFolder);
    let list = (clientFolder !== 'goc') ? base.slice() : base.filter(passFilter);
    // Mặc định: giữ nguyên thứ tự file (trái→phải). Chỉ sắp xếp khi chọn A→Z / Z→A
    if (clientSort === 'az' || clientSort === 'za')
      list.sort((a, b) => (clientSort === 'az' ? 1 : -1) * String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    clientList = list;
    if (!list.length) {
      const labels = { all: 'Chưa có ảnh nào trong album.', selected: 'Bạn chưa chọn ảnh nào.', later: 'Chưa có ảnh nào để xem lại sau.', skipped: 'Chưa bỏ qua ảnh nào.', unseen: 'Bạn đã xem hết ảnh rồi 🎉' };
      grid.className = 'photo-grid';
      grid.innerHTML = `<div class="grid-empty">${clientFolder !== 'goc' ? 'Album này chưa có ảnh.' : (labels[clientFilter] || 'Không có ảnh.')}</div>`;
      updateClientUI();
      return;
    }
    const pages = Math.max(1, Math.ceil(list.length / CLIENT_PAGE));
    if (clientPage >= pages) clientPage = pages - 1;
    if (clientPage < 0) clientPage = 0;
    const start = clientPage * CLIENT_PAGE, end = Math.min(start + CLIENT_PAGE, list.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(buildPhotoCard(list[i]));
    grid.appendChild(frag);
    // chạy lại animation fade
    grid.style.animation = 'none'; void grid.offsetWidth; grid.style.animation = '';
    updateClientUI();
  }
  function gotoClientPage(d) {
    const pages = Math.max(1, Math.ceil(clientList.length / CLIENT_PAGE));
    const np = Math.min(pages - 1, Math.max(0, clientPage + d));
    if (np === clientPage) return;
    clientPage = np; renderClient();
    const wrap = $('.client-wrap'); if (wrap) window.scrollTo({ top: wrap.offsetTop - 70, behavior: 'smooth' });
  }
  $('#cpage-prev').addEventListener('click', () => gotoClientPage(-1));
  $('#cpage-next').addEventListener('click', () => gotoClientPage(1));
  // Cập nhật trạng thái 1 thẻ tại chỗ (không dựng lại DOM -> mượt, không reflow)
  function updateCardState(p) {
    const card = $('#photo-grid').querySelector(`.pcard[data-id="${p.id}"]`);
    if (!card) return;
    card.classList.toggle('s-selected', p.review === 'selected');
    card.classList.toggle('s-later', p.review === 'later');
    card.classList.toggle('s-skipped', p.review === 'skipped');
    const ch = card.querySelector('.choosebtn');
    if (ch) { ch.textContent = p.review === 'selected' ? '✓' : 'Chọn'; ch.classList.toggle('on', p.review === 'selected'); ch.classList.remove('pop'); void ch.offsetWidth; ch.classList.add('pop'); }
    const lt = card.querySelector('[data-a="later"]'); if (lt) lt.classList.toggle('on', p.review === 'later');
  }
  function setReview(id, state) {
    const p = clientAlbum.photos.find(x => x.id === id); if (!p) return;
    if (state === 'selected' && p.review !== 'selected' && clientAlbum.maxCount && cSel().length >= clientAlbum.maxCount) {
      toast(`Chỉ được chọn tối đa ${clientAlbum.maxCount} ảnh`); return;
    }
    p.review = (p.review === state) ? '' : state;
    p.selected = (p.review === 'selected');
    saveClient();
    // lọc 'Tất cả' -> cập nhật tại chỗ; đang lọc theo trạng thái -> ảnh có thể đổi nhóm nên vẽ lại
    if (clientFilter === 'all') updateCardState(p); else renderClient();
    updateClientUI();
    if (lbIndex >= 0) syncLb();
  }
  function updateClientUI() {
    const n = cSel().length, total = clientAlbum.photos.length, max = clientAlbum.maxCount;
    $('#sel-count').textContent = n;
    $('#sel-max').textContent = max ? ` / ${max}` : '';
    $('#progress-bar').style.width = (max ? Math.min(100, n / max * 100) : (n / (total || 1) * 100)) + '%';
    // cover thông số
    $('#cc-max').textContent = max ? `Bạn được chọn tối đa ${max} ảnh` : 'Bạn có thể chọn không giới hạn';
    $('#cc-total').textContent = `Tổng ảnh: ${total}`;
    $('#cc-sel').textContent = `Đã chọn: ${n}${max ? ` / ${max}` : ''}`;
    // phân trang
    const len = clientList.length, pages = Math.max(1, Math.ceil(len / CLIENT_PAGE));
    const start = len ? clientPage * CLIENT_PAGE + 1 : 0, end = Math.min((clientPage + 1) * CLIENT_PAGE, len);
    $('#cpage-info').textContent = `Ảnh ${start} - ${end}, Tổng ${len}`;
    $('#cpage-cur').textContent = `Trang ${clientPage + 1}/${pages}`;
    $('#cpage-prev').disabled = clientPage <= 0;
    $('#cpage-next').disabled = clientPage >= pages - 1;
    // Nút Gửi hậu kỳ: mờ tới khi chọn đủ số ảnh tối đa (nếu có giới hạn), hoặc khi chưa chọn ảnh nào
    const fin = $('#finish-btn');
    const ready = max ? (n >= max) : (n > 0);
    fin.disabled = !ready;
    fin.title = max ? (ready ? '' : `Hãy chọn đủ ${max} ảnh để gửi`) : (ready ? '' : 'Hãy chọn ít nhất 1 ảnh');
  }
  $$('#ctabs .ctab').forEach(c => c.addEventListener('click', () => { clientFilter = c.dataset.f; clientPage = 0; $$('#ctabs .ctab').forEach(x => x.classList.toggle('active', x === c)); renderClient(); }));
  $('#cl-sort').addEventListener('click', () => {
    clientSort = clientSort === 'none' ? 'az' : clientSort === 'az' ? 'za' : 'none';
    $('#cl-sort').title = clientSort === 'az' ? 'Đang: A→Z' : clientSort === 'za' ? 'Đang: Z→A' : 'Đang: thứ tự gốc';
    $('#cl-sort').classList.toggle('on', clientSort !== 'none');
    renderClient();
  });
  $$('#cl-view button').forEach(b => b.addEventListener('click', () => { clientView = b.dataset.v; $$('#cl-view button').forEach(x => x.classList.toggle('active', x === b)); renderClient(); }));
  // Hướng dẫn cho khách
  $('#cover-guide').addEventListener('click', () => $('#guide-modal').classList.add('open'));
  $('#guide-x').addEventListener('click', () => $('#guide-modal').classList.remove('open'));
  $('#guide-ok').addEventListener('click', () => $('#guide-modal').classList.remove('open'));
  $('#guide-modal').addEventListener('click', e => { if (e.target.id === 'guide-modal') $('#guide-modal').classList.remove('open'); });

  /* ---------- Ghi chú (dùng chung khách + hậu kỳ) ---------- */
  let notePhoto = null, notePersist = null;
  function persistCurrent() {
    if (lbMode === 'view' && detailAlbum) { detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum); }
    else saveClient();
  }
  function openNoteFor(p, persistFn) {
    if (!p) return;
    notePhoto = p; notePersist = persistFn || persistCurrent;
    $('#note-photo-name').textContent = p.name || '';
    $('#note-text').value = p.note || ''; $('#note-modal').classList.add('open');
    setTimeout(() => $('#note-text').focus(), 50);
  }
  function openNote(id) { const p = clientAlbum && clientAlbum.photos.find(x => x.id === id); openNoteFor(p, saveClient); }
  function closeNote() { $('#note-modal').classList.remove('open'); notePhoto = null; }
  $('#note-x').addEventListener('click', closeNote);
  $('#note-cancel').addEventListener('click', closeNote);
  $('#note-modal').addEventListener('click', e => { if (e.target.id === 'note-modal') closeNote(); });
  $('#note-save').addEventListener('click', () => {
    if (notePhoto) {
      notePhoto.note = $('#note-text').value.trim();
      (notePersist || persistCurrent)();
      if (clientAlbum) updateCardState(notePhoto);
      if (lbIndex >= 0) syncLb();
      if (typeof renderDetail === 'function' && detailAlbum && lbMode === 'view') renderDetail();
      toast('Đã lưu ghi chú');
    }
    closeNote();
  });
  // Khung ghi chú trên ảnh trong lightbox
  function renderLbNote() {
    const p = lbPhotos[lbIndex], box = $('#lb-note-box');
    if (!box) return;
    if (p && p.note) { $('#lb-note-text').textContent = p.note; box.hidden = false; }
    else box.hidden = true;
  }
  $('#lb-note-edit').addEventListener('click', () => { if (lbIndex >= 0) openNoteFor(lbPhotos[lbIndex], persistCurrent); });
  $('#lb-note-del').addEventListener('click', () => {
    const p = lbPhotos[lbIndex]; if (!p) return;
    if (!window.confirm('Xoá ghi chú của ảnh này?')) return;
    p.note = ''; persistCurrent(); if (clientAlbum) updateCardState(p);
    if (detailAlbum && lbMode === 'view') renderDetail();
    renderLbNote(); toast('Đã xoá ghi chú');
  });

  /* ---------- Tải ảnh gốc từ Drive ---------- */
  function driveDownloadUrl(p) { const id = p.driveId || driveIdFromThumb(p.src); return id ? `https://drive.google.com/uc?export=download&id=${id}` : (p.full || p.src); }
  function downloadPhoto(p) {
    if (clientAlbum && !clientAlbum.allowDownload) { toast('Album này không cho phép tải ảnh'); return; }
    const a = document.createElement('a'); a.href = driveDownloadUrl(p); a.download = p.name || 'photo.jpg'; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  $('#dl-all').addEventListener('click', () => {
    if (!clientAlbum.allowDownload) { toast('Album này không cho phép tải ảnh'); return; }
    const sel = cSel(); if (!sel.length) { toast('Chưa có ảnh đã chọn để tải'); return; }
    const nm = ((clientAlbum.name || 'album') + ' - Anh chon').replace(/[\\/:*?"<>|]+/g, '_');
    zipDownloadSet(sel, nm, $('#dl-all'));
  });

  /* ---------- Scroll to top + tự ẩn thanh công cụ ---------- */
  $('#scroll-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  let lastScrollY = 0;
  window.addEventListener('scroll', () => {
    const inClient = !$('#client').hidden;
    const st = $('#scroll-top');
    if (st) st.classList.toggle('show', inClient && window.scrollY > 600);
    // lướt xuống -> ẩn thanh công cụ; vuốt lên -> hiện lại
    if (inClient) {
      const bar = $('#selbar'), y = window.scrollY;
      if (y > lastScrollY + 8 && y > 260) bar.classList.add('hide');
      else if (y < lastScrollY - 8 || y < 120) bar.classList.remove('hide');
      lastScrollY = y;
    }
  }, { passive: true });

  /* ---------- Lightbox / trình xem ảnh ---------- */
  let lbPhotos = [], lbMode = 'client', lbLoadToken = 0, lbDir = 0;
  function showLbPhoto(p) {
    const img = $('#lb-img'); const token = ++lbLoadToken;
    img.alt = p.name || '';
    img.onerror = () => { img.onerror = null; const id = p.driveId || driveIdFromThumb(p.src); if (id) img.src = `https://lh3.googleusercontent.com/d/${id}=w1200`; };
    // Hiện thumbnail (đã cache trong lưới) ngay lập tức → không giật
    img.src = p.src || p.full;
    // Hiệu ứng trượt theo hướng next/prev
    img.classList.remove('lb-slide-l', 'lb-slide-r');
    if (lbDir !== 0) { void img.offsetWidth; img.classList.add(lbDir > 0 ? 'lb-slide-r' : 'lb-slide-l'); }
    lbDir = 0;
    // Rồi âm thầm nâng lên bản nét; chỉ áp dụng nếu vẫn đang xem ảnh này
    if (p.full && p.full !== p.src) {
      const hi = new Image();
      hi.onload = () => { if (token === lbLoadToken) img.src = p.full; };
      hi.src = p.full;
    }
  }
  function preloadAround(i) {
    if (!lbPhotos.length) return;
    [i - 1, i + 1, i + 2].forEach(k => {
      const q = lbPhotos[(k + lbPhotos.length) % lbPhotos.length];
      if (q) { const im = new Image(); im.src = q.full || q.src; }
    });
  }
  function openLightbox(photos, i, mode) {
    lbPhotos = photos || []; lbMode = mode || 'client'; lbIndex = i;
    const p = lbPhotos[i]; if (!p) return;
    showLbPhoto(p);
    $('#lb-name').textContent = p.name || '';
    preloadAround(i);
    const isClient = lbMode === 'client';
    const isStudio = lbMode === 'view' && !!detailAlbum;
    const canDl = clientAlbum && clientAlbum.allowDownload;
    const canNote = (isClient && clientAlbum && clientAlbum.allowNotes) || isStudio;
    $('#lb-acts').hidden = !(isClient || canDl || canNote);
    $('#lb-dl').hidden = !canDl;
    $('#lb-note-btn').hidden = !canNote;
    $('#lb-later').hidden = !isClient;
    $('#lb-choose').hidden = !isClient;
    syncLb();
    renderLbNote();
    $('#lightbox').classList.add('open');
  }
  function closeLb() { $('#lightbox').classList.remove('open'); lbIndex = -1; }
  function lbStep(d) { if (lbIndex < 0 || !lbPhotos.length) return; lbDir = d; openLightbox(lbPhotos, (lbIndex + d + lbPhotos.length) % lbPhotos.length, lbMode); }
  function syncLb() {
    const p = lbPhotos[lbIndex]; if (!p) return;
    $('#lb-name').textContent = (p.name || '') + (p.note ? '  📝' : '');
    $('#lb-sub').textContent = `${lbIndex + 1} / ${lbPhotos.length}`;
    if (lbMode === 'client' && clientAlbum) {
      const n = cSel().length, max = clientAlbum.maxCount;
      const sel = p.review === 'selected';
      const limit = max && n >= max && !sel;
      const ch = $('#lb-choose');
      ch.textContent = sel ? '✓ Đã chọn' : (limit ? 'Đã đạt giới hạn' : 'Chọn');
      ch.classList.toggle('on', sel); ch.disabled = limit;
      $('#lb-later').classList.toggle('on', p.review === 'later');
    }
  }
  $('#lb-close').addEventListener('click', closeLb);
  $('#lb-prev').addEventListener('click', () => lbStep(-1));
  $('#lb-next').addEventListener('click', () => lbStep(1));
  $('#lb-choose').addEventListener('click', () => { if (lbMode === 'client' && lbIndex >= 0) setReview(lbPhotos[lbIndex].id, 'selected'); });
  $('#lb-later').addEventListener('click', () => { if (lbMode === 'client' && lbIndex >= 0) setReview(lbPhotos[lbIndex].id, 'later'); });
  $('#lb-note-btn').addEventListener('click', () => { if (lbIndex >= 0) openNoteFor(lbPhotos[lbIndex], persistCurrent); });
  $('#lb-dl').addEventListener('click', () => { if (lbIndex >= 0) downloadPhoto(lbPhotos[lbIndex]); });
  $('#lb-copy').addEventListener('click', () => { if (lbIndex >= 0) copyText(lbPhotos[lbIndex].name, 'Đã chép tên ảnh'); });
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLb(); });
  let lbSwiped = false;
  $('#lb-img').addEventListener('click', () => { if (lbSwiped) { lbSwiped = false; return; } lbStep(1); });  // bấm ảnh -> ảnh kế tiếp
  // Vuốt: trái/phải đổi ảnh, vuốt xuống để đóng
  let lbTX = 0, lbTY = 0;
  $('#lightbox').addEventListener('touchstart', e => { const t = e.changedTouches[0]; lbTX = t.clientX; lbTY = t.clientY; lbSwiped = false; }, { passive: true });
  $('#lightbox').addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - lbTX, dy = t.clientY - lbTY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) { lbSwiped = true; lbStep(dx < 0 ? 1 : -1); }
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) { lbSwiped = true; closeLb(); }
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if (!$('#lightbox').classList.contains('open')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // đang gõ ghi chú
    if (e.key === 'Escape') closeLb();
    else if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); lbStep(1); }
  });

  /* ---------- Finish / summary ---------- */
  $('#finish-btn').addEventListener('click', () => {
    const sel = cSel(); if (!sel.length) { toast('Bạn chưa chọn ảnh nào'); return; }
    if (clientBound) {
      clientAlbum.status = 'done';
      if (!clientAlbum.selectedAt) { clientAlbum.selectedAt = Date.now(); recomputeDeadline(clientAlbum); }
      saveClient();
    } else if (clientRemote) { clearTimeout(saveClientTimer); saveClientTimer = null; pushGuestSelection('done'); }
    $('#sum-count').textContent = sel.length;
    $('#summary-modal').classList.add('open');
  });
  function closeSum() { $('#summary-modal').classList.remove('open'); }
  $('#sum-close').addEventListener('click', closeSum);
  $('#summary-modal').addEventListener('click', e => { if (e.target.id === 'summary-modal') closeSum(); });

  /* ---------- Tiến độ hậu kỳ ---------- */
  function daysLeft(deadline) {
    if (!deadline) return null;
    const d = new Date(deadline + 'T00:00:00'); if (isNaN(d)) return null;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.round((d - now) / 86400000);
  }
  function deadlineBadge(al) {
    if (al.status === 'delivered') return { cls: 'dl-ok', txt: 'Đã bàn giao' };
    const dl = daysLeft(al.deadline);
    if (dl === null) {
      if (al.deadlineDays && !al.selectedAt) return { cls: 'dl-none', txt: 'Chờ khách chốt ảnh' };
      return { cls: 'dl-none', txt: 'Chưa đặt hạn' };
    }
    if (dl < 0) return { cls: 'dl-over', txt: `Trễ ${-dl} ngày 🔥` };
    if (dl === 0) return { cls: 'dl-soon', txt: 'Hết hạn hôm nay' };
    if (dl <= 3) return { cls: 'dl-soon', txt: `Còn ${dl} ngày` };
    return { cls: 'dl-ok', txt: `Còn ${dl} ngày` };
  }
  function isOverdue(al) { const d = daysLeft(al.deadline); return al.status !== 'delivered' && d !== null && d < 0; }
  function isSoon(al) { const d = daysLeft(al.deadline); return al.status !== 'delivered' && d !== null && d >= 0 && d <= 3; }

  function progFiltered() {
    const act = activeAlbums();
    const fdate = $('#pg-fdate').value;
    if (!fdate) return act;
    const ftype = $('#pg-ftype').value;
    return act.filter(a => ftype === 'selected'
      ? (a.selectedAt && toYMD(a.selectedAt) === fdate)
      : (a.shootDate === fdate));
  }
  function renderProgress() {
    const list = $('#progress-list'), empty = $('#progress-empty'), banner = $('#deadline-banner');
    list.innerHTML = '';
    list.className = progView === 'grid' ? 'prog-cards' : '';
    $('.prog-head').style.display = progView === 'grid' ? 'none' : '';
    const act = activeAlbums();
    if (!act.length) { empty.hidden = false; list.hidden = true; banner.innerHTML = ''; return; }
    empty.hidden = true; list.hidden = false;

    const over = act.filter(isOverdue).length;
    const soon = act.filter(isSoon).length;
    if (over) {
      banner.innerHTML = `<div class="banner alert"><svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg><span><strong>${over}</strong> album đang cháy deadline${soon ? `, <strong>${soon}</strong> album sắp đến hạn` : ''} — cần xử lý gấp!</span></div>`;
    } else if (soon) {
      banner.innerHTML = `<div class="banner alert"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2"/></svg><span><strong>${soon}</strong> album sắp đến hạn trả ảnh (trong 3 ngày).</span></div>`;
    } else {
      banner.innerHTML = `<div class="banner ok"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span>Không có album nào trễ hạn. Tiến độ ổn định 👍</span></div>`;
    }

    const sorted = progFiltered().sort((a, b) => {
      const da = daysLeft(a.deadline), db = daysLeft(b.deadline);
      const ga = a.status === 'delivered' ? 3 : da === null ? 2 : 0;
      const gb = b.status === 'delivered' ? 3 : db === null ? 2 : 0;
      if (ga !== gb) return ga - gb;
      if (ga === 0) return da - db;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
    sorted.forEach(al => list.appendChild(buildProgRow(al)));
  }

  function buildProgRow(al) {
    const bd = deadlineBadge(al);
    const hourTxt = (al.shootHour != null) ? ` · ${al.shootHour}h` : '';
    const chotTxt = al.selectedAt ? `chốt ${fmtVN(toYMD(al.selectedAt))}` : 'chưa chốt ảnh';
    const row = document.createElement('div');
    row.className = 'prog-row';
    row.innerHTML = `
      <div class="who" title="Mở album"><strong>${escapeHtml(al.name)}</strong><small>${al.client ? escapeHtml(al.client) : '—'}${hourTxt} · ${chotTxt}</small></div>
      <label class="pf" data-l="Ngày chụp"><input type="date" data-f="shoot" value="${escapeAttr(al.shootDate || '')}"></label>
      <label class="pf" data-l="Hạn trả (số ngày)">
        <div class="dl-cell">
          <input type="number" min="0" step="1" data-f="days" value="${al.deadlineDays || ''}" placeholder="số ngày">
          <small>${al.deadline ? '→ ' + fmtVN(al.deadline) : (al.selectedAt ? 'nhập số ngày' : 'tính khi khách gửi hậu kỳ')}</small>
        </div>
      </label>
      <label class="pf" data-l="Trạng thái"><select data-f="status">${STATUSES.map(s => `<option value="${s.key}"${s.key === al.status ? ' selected' : ''}>${s.label}</option>`).join('')}</select></label>
      <div class="pf badge-cell" data-l="Deadline"><span class="deadline-badge ${bd.cls}"><span class="dot"></span>${bd.txt}</span></div>
      <button class="icon-btn lnk" data-f="link" title="Copy link gửi khách"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></button>`;
    row.querySelector('.who').addEventListener('click', () => openAlbumDetail(al.id));
    row.querySelector('[data-f="link"]').addEventListener('click', () => copyAlbumLink(al));
    row.querySelector('[data-f="shoot"]').addEventListener('change', e => { al.shootDate = e.target.value; al.lastActivity = Date.now(); saveAlbums(al); renderProgress(); });
    row.querySelector('[data-f="days"]').addEventListener('change', e => { const n = parseInt(e.target.value, 10); al.deadlineDays = Number.isFinite(n) && n >= 0 ? n : 0; recomputeDeadline(al); al.lastActivity = Date.now(); saveAlbums(al); renderProgress(); });
    row.querySelector('[data-f="status"]').addEventListener('change', e => { al.status = e.target.value; al.lastActivity = Date.now(); saveAlbums(al); renderProgress(); });
    return row;
  }
  $('#pg-ftype').addEventListener('change', renderProgress);
  $('#pg-fdate').addEventListener('change', renderProgress);
  $('#pg-fclear').addEventListener('click', () => { $('#pg-fdate').value = ''; renderProgress(); });
  $$('#albums-view button').forEach(b => b.addEventListener('click', () => { albumsView = b.dataset.v; $$('#albums-view button').forEach(x => x.classList.toggle('active', x === b)); renderGrid(); }));
  $$('#prog-view button').forEach(b => b.addEventListener('click', () => { progView = b.dataset.v; $$('#prog-view button').forEach(x => x.classList.toggle('active', x === b)); renderProgress(); }));

  /* ---------- Tự cập nhật (thiết bị khác thêm/sửa album) ---------- */
  function autoRefresh() {
    if ($('#app').hidden || !apiAuth) return;
    refreshAlbumsFromServer().then(ok => {
      if (!ok) return;
      if ($('#page-albums').classList.contains('active')) renderAlbums();
      else if ($('#page-progress').classList.contains('active')) renderProgress();
      else if ($('#page-trash').classList.contains('active')) renderTrash();
      else if ($('#page-albumdetail').classList.contains('active') && detailAlbum) {
        const fresh = albums.find(x => x.id === detailAlbum.id);
        if (fresh) { detailAlbum = fresh; renderDetail(); } else { gotoPage('page-albums'); renderAlbums(); }
      }
    });
  }
  window.addEventListener('focus', autoRefresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoRefresh(); });
  setInterval(autoRefresh, 25000);

  /* ---------- Init ---------- */
  (async () => {
    loadAlbums(); loadBrand();
    if (apiAuth) apiSync = true; // đã từng đăng nhập qua API -> bật đồng bộ (xác thực lại ở lần fetch đầu)

    const hasShareRef = new URLSearchParams(location.search).get('al') || location.hash.match(/[#&]a=/);
    if (hasShareRef) {
      showClientLoading();   // hiện ngay, tránh nháy trang đăng nhập
      const shared = await resolveSharedAlbum();
      if (shared && shared.album) {
        openClient(shared.album, shared.bound, shared.remote);
      } else {
        showClientError(shared && shared.error ? shared.error : 'Link không hợp lệ hoặc album đã bị xoá.');
      }
    } else if (localStorage.getItem(AUTH_KEY) === '1') {
      showApp();
    } else {
      showLogin();
    }
  })();
})();
