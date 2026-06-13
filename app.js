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
  const LOGIN_USER = 'lammien';
  const LOGIN_PASS = 'lammien';
  const FIXED_DRIVE_KEY = 'AIzaSyB30IdJg_FKZpi2oOmF8bS7qMEna5P2dpg';
  const API_AUTH_KEY = 'lamMienApiAuth';
  const MIGRATED_KEY = 'lamMienMigrated';

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
        albums = list.concat(recent);
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
    return f === 'sua' ? (clientAlbum.editedPhotos || []) : clientAlbum.photos;
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
    let viaApi = false;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: u, pass: p }) });
      if (r.ok) {
        const d = await r.json();
        apiAuth = { u, p, name: d.name || u };
        try { localStorage.setItem(API_AUTH_KEY, JSON.stringify(apiAuth)); } catch (_) {}
        viaApi = true;
        if (d.sync) { await refreshAlbumsFromServer(); }
        else toast('Máy chủ chưa nối database — dữ liệu chỉ lưu trên máy này');
      } else if (r.status === 401) {
        btn.disabled = false; btn.textContent = 'Đăng nhập';
        toast('Sai tài khoản hoặc mật khẩu'); return;
      }
    } catch (_) { /* API không chạy (mở file local) -> fallback */ }
    if (!viaApi) {
      if (u !== LOGIN_USER || p !== LOGIN_PASS) {
        btn.disabled = false; btn.textContent = 'Đăng nhập';
        toast('Sai tài khoản hoặc mật khẩu'); return;
      }
      toast('Chế độ offline — dữ liệu chỉ lưu trên máy này');
    }
    try { localStorage.setItem(AUTH_KEY, '1'); } catch (_) {}
    btn.disabled = false; btn.textContent = 'Đăng nhập';
    showApp(); if (viaApi && apiSync) toast('Đăng nhập thành công — dữ liệu đồng bộ mọi thiết bị');
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

  /* ---------- Create modal ---------- */
  function openCreate() {
    $('#create-form').reset();
    $('#allow-notes').checked = true; $('#allow-download').checked = false;
    $('#create-modal').classList.add('open');
  }
  function closeCreate() { $('#create-modal').classList.remove('open'); }
  $('#new-album-btn').addEventListener('click', openCreate);
  $('#empty-new-btn').addEventListener('click', openCreate);
  $('#create-close').addEventListener('click', closeCreate);
  $('#create-cancel').addEventListener('click', closeCreate);
  $('#create-modal').addEventListener('click', e => { if (e.target.id === 'create-modal') closeCreate(); });

  $('#create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#create-submit');
    const rawName = $('#album-name').value.trim();
    if (!rawName) { toast('Hãy nhập tên khách / mã buổi chụp'); return; }
    const folder = $('#drive-url').value.trim();
    if (!folder) { toast('Hãy dán link thư mục Google Drive'); return; }

    let photos = [];
    try {
      btn.disabled = true; btn.textContent = 'Đang tải ảnh…'; toast('Đang tải ảnh từ Google Drive…');
      photos = await buildDrivePhotos(folder, FIXED_DRIVE_KEY);
    } catch (err) { toast('Lỗi: ' + (err.message || err)); return; }
    finally { btn.disabled = false; btn.textContent = 'Tạo album'; }

    const meta = parseAlbumMeta(rawName);
    const days = parseInt($('#deadline-days').value, 10);
    const deadlineDays = Number.isFinite(days) && days >= 0 ? days : 0;
    const max = parseInt($('#max-count').value, 10);
    const al = {
      id: genId(),
      name: rawName,
      client: meta.client || '',
      status: 'waiting',
      maxCount: Number.isFinite(max) && max > 0 ? max : 0,
      allowNotes: $('#allow-notes').checked,
      allowDownload: $('#allow-download').checked,
      shootDate: meta.shootDate,
      shootHour: meta.hour,
      deadlineDays,
      deadline: '',        // sẽ tự tính khi khách bấm "Gửi hậu kỳ"
      selectedAt: 0,
      sourceUrl: folder,
      cover: '',
      editedPhotos: [],
      createdAt: Date.now(), lastActivity: Date.now(),
      photos
    };
    albums.unshift(al); saveAlbums(al); renderAlbums(); closeCreate();
    toast(`Đã tạo album “${al.name}” (${photos.length} ảnh)`);
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
    const cover = (al.photos[0] && al.photos[0].src) || '';
    const pct = total ? Math.round(sel / total * 100) : 0;
    const card = document.createElement('div');
    card.className = 'acard';
    card.innerHTML = `
      <div class="acard-cover">${cover ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy">` : '<span class="ph">🖼️</span>'}</div>
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
    if (!window.confirm(`Xoá vĩnh viễn album “${a ? a.name : ''}”? Không thể lấy lại.`)) return;
    albums = albums.filter(x => x.id !== id); saveAlbumsLocal(); apiDeleteAlbum(id); renderTrash(); toast('Đã xoá vĩnh viễn');
  }
  $('#trash-empty').addEventListener('click', () => {
    const list = trashedAlbums(); if (!list.length) return;
    if (!window.confirm(`Xoá vĩnh viễn ${list.length} album trong thùng rác? Không thể lấy lại.`)) return;
    list.forEach(a => apiDeleteAlbum(a.id));
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
        if (idx >= 0) { albums[idx] = fresh; saveAlbumsLocal(); }
        if (detailAlbum && detailAlbum.id === id) { detailAlbum = fresh; renderDetail(); }
      }).catch(() => {});
    }
  }
  function renderDetail() {
    const al = detailAlbum; if (!al) return;
    $('#ad-name').textContent = al.name;
    const parts = [];
    if (al.client) parts.push(al.client);
    if (al.shootDate) parts.push('Chụp ' + fmtVN(al.shootDate) + (al.shootHour != null ? ` ${al.shootHour}h` : ''));
    if (al.deadline) parts.push('Hạn trả ' + fmtVN(al.deadline));
    $('#ad-meta').textContent = parts.join(' · ') || 'Chưa có thông tin';
    const st = statusOf(al.status);
    const stEl = $('#ad-status'); stEl.className = 'status-pill ' + st.cls; stEl.innerHTML = `<span class="dot"></span>${st.label}`;

    // ảnh bìa
    const cov = albumCover(al);
    $('#ad-cover').src = cov || '';
    $('#ad-change-cover').classList.toggle('show', pickingCover);
    $('#ad-change-cover').innerHTML = pickingCover
      ? '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Bấm 1 ảnh để đặt làm bìa'
      : '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Đổi ảnh bìa';

    const selPhotos = al.photos.filter(p => p.selected);
    const editedPhotos = al.editedPhotos || [];
    $('#ad-goc-cnt').textContent = al.photos.length;
    $('#ad-chon-cnt').textContent = selPhotos.length;
    $('#ad-sua-cnt').textContent = editedPhotos.length;
    $$('#page-albumdetail .set-item').forEach(b => b.classList.toggle('active', b.dataset.set === detailSet));

    detailList = (detailSet === 'chon' ? selPhotos : detailSet === 'sua' ? editedPhotos : al.photos)
      .slice().sort((a, b) => (detailSort === 'az' ? 1 : -1) * String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    $('#ad-set-title').textContent = detailSet === 'chon' ? `ẢNH CHỌN (${selPhotos.length})` : detailSet === 'sua' ? `ẢNH SỬA (${editedPhotos.length})` : `ẢNH GỐC (${al.photos.length})`;
    $('#ad-sort').textContent = detailSort === 'az' ? 'A→Z' : 'Z→A';
    $$('#ad-view button').forEach(b => b.classList.toggle('active', b.dataset.v === detailView));
    $('#ad-grid').classList.toggle('list-view', detailView === 'list');
    const grid = $('#ad-grid'); grid.innerHTML = '';
    if (!detailList.length) {
      grid.innerHTML = detailSet === 'chon'
        ? `<p class="sub" style="color:var(--muted)">Khách chưa chọn ảnh nào. Khi khách chọn, ảnh sẽ tự xuất hiện ở đây.</p>`
        : detailSet === 'sua'
        ? `<p class="sub" style="color:var(--muted)">Chưa có ảnh sửa. Bấm “+ Ảnh sửa” để thêm thư mục ảnh đã chỉnh.</p>`
        : `<p class="sub" style="color:var(--muted)">Album chưa có ảnh.</p>`;
      return;
    }
    detailShown = 0;
    appendDetailBatch();
    setupDetailSentinel();
  }
  function buildDetailThumb(p, idx) {
    const ext = (String(p.name).split('.').pop() || 'IMG').toUpperCase().slice(0, 4);
    const d = document.createElement('div');
    d.className = 'dthumb' + (p.selected ? ' sel' : '') + (pickingCover ? ' picking' : '');
    d.innerHTML = `<img src="${escapeAttr(p.src)}" alt="" loading="lazy" decoding="async"><span class="dtag">${escapeHtml(ext)}</span>${p.selected ? '<span class="dheart">♥</span>' : ''}`;
    attachImgFallback(d.querySelector('img'), p);
    d.addEventListener('click', () => {
      if (pickingCover) {
        detailAlbum.cover = p.full || p.src; pickingCover = false; detailAlbum.lastActivity = Date.now();
        saveAlbums(detailAlbum); renderDetail(); renderAlbums(); toast('Đã đặt làm ảnh bìa');
      } else {
        openLightbox(detailList, idx, 'view');
      }
    });
    return d;
  }
  function buildDetailRow(p, idx) {
    const ext = (String(p.name).split('.').pop() || 'IMG').toUpperCase().slice(0, 4);
    const d = document.createElement('div');
    d.className = 'drow' + (p.selected ? ' sel' : '');
    d.innerHTML = `<img src="${escapeAttr(p.src)}" alt="" loading="lazy" decoding="async">
      <span class="nm">${escapeHtml(p.name)}</span>
      ${p.note ? '<span title="' + escapeAttr(p.note) + '">📝</span>' : ''}
      ${p.selected ? '<span class="hrt">♥</span>' : ''}
      <span class="ext">${escapeHtml(ext)}</span>`;
    attachImgFallback(d.querySelector('img'), p);
    d.addEventListener('click', () => {
      if (pickingCover) {
        detailAlbum.cover = p.full || p.src; pickingCover = false; detailAlbum.lastActivity = Date.now();
        saveAlbums(detailAlbum); renderDetail(); renderAlbums(); toast('Đã đặt làm ảnh bìa');
      } else { openLightbox(detailList, idx, 'view'); }
    });
    return d;
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
  $('#ad-back').addEventListener('click', () => { pickingCover = false; gotoPage('page-albums'); renderAlbums(); });
  $$('#page-albumdetail .set-item').forEach(b => b.addEventListener('click', () => { detailSet = b.dataset.set; renderDetail(); }));
  $$('#page-albumdetail .set-dl').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (!detailAlbum) return;
    const set = b.dataset.dl;
    zipDownloadSet(setList(set), zipName(set), b);
  }));

  /* ---------- Tải & nén .zip (cho studio) ---------- */
  function setList(set) {
    const al = detailAlbum;
    if (set === 'chon') return al.photos.filter(p => p.review === 'selected' || p.selected);
    if (set === 'sua') return al.editedPhotos || [];
    return al.photos;
  }
  function zipName(set) {
    const al = detailAlbum;
    const base = (al.client || al.name || 'album').replace(/[\\/:*?"<>|]+/g, '_').trim();
    const suffix = set === 'chon' ? ' - Anh chon' : set === 'sua' ? ' - Anh sua' : '';
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
  $('#ad-sort').addEventListener('click', () => { detailSort = detailSort === 'az' ? 'za' : 'az'; renderDetail(); });
  $$('#ad-view button').forEach(b => b.addEventListener('click', () => { detailView = b.dataset.v; renderDetail(); }));
  $('#ad-change-cover').addEventListener('click', () => {
    if (!detailAlbum) return;
    pickingCover = !pickingCover;
    if (pickingCover) { detailSet = 'goc'; toast('Bấm vào 1 ảnh để đặt làm bìa'); }
    renderDetail();
  });
  $('#ad-add-edited').addEventListener('click', async () => {
    if (!detailAlbum) return;
    const link = window.prompt('Dán link thư mục Google Drive chứa ảnh đã sửa:');
    if (!link || !link.trim()) return;
    toast('Đang tải ảnh đã sửa…');
    try {
      const photos = await buildDrivePhotos(link.trim(), FIXED_DRIVE_KEY);
      detailAlbum.editedPhotos = photos; detailAlbum.editedSourceUrl = link.trim();
      if (detailAlbum.status === 'choosing' || detailAlbum.status === 'done') detailAlbum.status = 'editing';
      detailAlbum.lastActivity = Date.now(); saveAlbums(detailAlbum);
      detailSet = 'sua'; renderDetail(); renderAlbums();
      toast(`Đã thêm ${photos.length} ảnh sửa`);
    } catch (err) { toast('Lỗi: ' + (err.message || err)); }
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
    const sua = (clientAlbum.editedPhotos || []).length;
    const dl = clientAlbum.allowDownload;
    const fdl = key => dl ? `<span class="fdl" data-fdl="${key}" title="Tải cả album (.zip)"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span>` : '';
    let html = `<button class="cfolder${clientFolder === 'goc' ? ' active' : ''}" data-folder="goc">📂 Ảnh gốc <span class="fn">${clientAlbum.photos.length}</span>${fdl('goc')}</button>`;
    if (sua) html += `<button class="cfolder${clientFolder === 'sua' ? ' active' : ''}" data-folder="sua">🎨 Ảnh sửa <span class="fn">${sua}</span>${fdl('sua')}</button>`;
    wrap.innerHTML = html;
    wrap.querySelectorAll('.cfolder').forEach(b => b.addEventListener('click', () => {
      clientFolder = b.dataset.folder; clientPage = 0;
      // Ảnh sửa: chỉ xem/tải, ẩn bộ lọc trạng thái + thanh chọn
      $('#ctabs').style.display = clientFolder === 'sua' ? 'none' : '';
      $('.cmeta').style.visibility = clientFolder === 'sua' ? 'hidden' : '';
      $('#dl-all').style.display = clientFolder === 'sua' ? 'none' : '';
      $('#finish-btn').style.display = clientFolder === 'sua' ? 'none' : '';
      renderFolders(); renderClient();
    }));
    wrap.querySelectorAll('.fdl').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (!clientAlbum.allowDownload) { toast('Album này không cho phép tải ảnh'); return; }
      const f = b.dataset.fdl;
      const nm = (clientAlbum.name || 'album') + (f === 'sua' ? ' - Anh sua' : ' - Anh goc');
      zipDownloadSet(folderPhotos(f), nm.replace(/[\\/:*?"<>|]+/g, '_'), b);
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
    const editing = clientFolder === 'sua';
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
    let list = (clientFolder === 'sua') ? base.slice() : base.filter(passFilter);
    // Mặc định: giữ nguyên thứ tự file (trái→phải). Chỉ sắp xếp khi chọn A→Z / Z→A
    if (clientSort === 'az' || clientSort === 'za')
      list.sort((a, b) => (clientSort === 'az' ? 1 : -1) * String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    clientList = list;
    if (!list.length) {
      const labels = { all: 'Chưa có ảnh nào trong album.', selected: 'Bạn chưa chọn ảnh nào.', later: 'Chưa có ảnh nào để xem lại sau.', skipped: 'Chưa bỏ qua ảnh nào.', unseen: 'Bạn đã xem hết ảnh rồi 🎉' };
      grid.className = 'photo-grid';
      grid.innerHTML = `<div class="grid-empty">${clientFolder === 'sua' ? 'Album chưa có ảnh sửa.' : (labels[clientFilter] || 'Không có ảnh.')}</div>`;
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

  /* ---------- Ghi chú ---------- */
  let noteTargetId = null;
  function openNote(id) {
    const p = clientAlbum.photos.find(x => x.id === id); if (!p) return;
    noteTargetId = id; $('#note-photo-name').textContent = p.name || '';
    $('#note-text').value = p.note || ''; $('#note-modal').classList.add('open');
    setTimeout(() => $('#note-text').focus(), 50);
  }
  function closeNote() { $('#note-modal').classList.remove('open'); noteTargetId = null; }
  $('#note-x').addEventListener('click', closeNote);
  $('#note-cancel').addEventListener('click', closeNote);
  $('#note-modal').addEventListener('click', e => { if (e.target.id === 'note-modal') closeNote(); });
  $('#note-save').addEventListener('click', () => {
    const p = clientAlbum && clientAlbum.photos.find(x => x.id === noteTargetId);
    if (p) { p.note = $('#note-text').value.trim(); saveClient(); updateCardState(p); if (lbIndex >= 0) syncLb(); toast('Đã lưu ghi chú'); }
    closeNote();
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
  let lbPhotos = [], lbMode = 'client', lbLoadToken = 0;
  function showLbPhoto(p) {
    const img = $('#lb-img'); const token = ++lbLoadToken;
    img.alt = p.name || '';
    img.onerror = () => { img.onerror = null; const id = p.driveId || driveIdFromThumb(p.src); if (id) img.src = `https://lh3.googleusercontent.com/d/${id}=w1200`; };
    // Hiện thumbnail (đã cache trong lưới) ngay lập tức → không giật
    img.src = p.src || p.full;
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
    const canDl = clientAlbum && clientAlbum.allowDownload;
    $('#lb-acts').hidden = !(isClient || canDl);
    $('#lb-dl').hidden = !canDl;
    $('#lb-note-btn').hidden = !(isClient && clientAlbum && clientAlbum.allowNotes);
    $('#lb-later').hidden = !isClient;
    $('#lb-choose').hidden = !isClient;
    syncLb();
    $('#lightbox').classList.add('open');
  }
  function closeLb() { $('#lightbox').classList.remove('open'); lbIndex = -1; }
  function lbStep(d) { if (lbIndex < 0 || !lbPhotos.length) return; openLightbox(lbPhotos, (lbIndex + d + lbPhotos.length) % lbPhotos.length, lbMode); }
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
  $('#lb-note-btn').addEventListener('click', () => { if (lbMode === 'client' && lbIndex >= 0) openNote(lbPhotos[lbIndex].id); });
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
