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
  let currentSource = 'drive';
  let pickedFiles = [];
  // client picker
  let clientAlbum = null, clientBound = false, clientFilter = 'all', lbIndex = -1;
  let clientList = [], clientShown = 0, clientObserver = null;
  const CLIENT_BATCH = 30;
  // album detail (studio)
  let detailAlbum = null, detailSet = 'goc', pickingCover = false;
  let detailList = [], detailShown = 0, detailObserver = null;
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
  function recomputeDeadline(al) { al.deadline = (al.shootDate && al.deadlineDays) ? addDays(al.shootDate, al.deadlineDays) : ''; }
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
  function saveAlbums() { try { localStorage.setItem(ALBUMS_KEY, JSON.stringify(albums)); } catch (_) {} }
  function loadAlbums() { try { const r = localStorage.getItem(ALBUMS_KEY); if (r) albums = JSON.parse(r) || []; } catch (_) { albums = []; } }
  function saveBrand() { try { localStorage.setItem(BRAND_KEY, JSON.stringify(brand)); } catch (_) {} }
  function loadBrand() { try { const r = localStorage.getItem(BRAND_KEY); if (r) brand = Object.assign(brand, JSON.parse(r)); } catch (_) {} }
  function getDriveKey() { try { return localStorage.getItem(DKEY) || ''; } catch (_) { return ''; } }
  function setDriveKey(k) { try { k ? localStorage.setItem(DKEY, k) : localStorage.removeItem(DKEY); } catch (_) {} }

  /* ---------- Auth ---------- */
  function showLogin() { $('#login-view').hidden = false; $('#app').hidden = true; $('#client').hidden = true; }
  function showApp() {
    $('#login-view').hidden = true; $('#app').hidden = false; $('#client').hidden = true;
    renderAlbums();
    if ($('#page-albumdetail').classList.contains('active') && detailAlbum) renderDetail();
  }
  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    const u = $('#lg-user').value.trim(), p = $('#lg-pass').value;
    if (u === LOGIN_USER && p === LOGIN_PASS) {
      try { localStorage.setItem(AUTH_KEY, '1'); } catch (_) {}
      showApp(); toast('Đăng nhập thành công');
    } else { toast('Sai tài khoản hoặc mật khẩu'); }
  });
  $('#logout-btn').addEventListener('click', () => {
    try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
    $('#lg-user').value = ''; $('#lg-pass').value = '';
    showLogin(); toast('Đã đăng xuất');
  });

  /* ---------- Page nav (sidebar) ---------- */
  $$('.sb-nav a').forEach(a => a.addEventListener('click', () => {
    const page = a.dataset.page;
    $$('.sb-nav a').forEach(x => x.classList.toggle('active', x === a));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    $('#sidebar').classList.remove('open');
    window.scrollTo({ top: 0 });
    if (page === 'albums') renderAlbums();
    if (page === 'progress') renderProgress();
  }));
  $('#sb-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

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
  async function listDriveFolder(folderId, apiKey) {
    let files = [], pageToken = '';
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('fields', 'nextPageToken, files(id,name,mimeType)');
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
    return files.map((f, i) => ({ id: 'd' + i, name: f.name, driveId: f.id, src: driveThumb(f.id, 'w400'), full: driveThumb(f.id, 'w1600'), selected: false, note: '' }));
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
      deadline: meta.shootDate && deadlineDays ? addDays(meta.shootDate, deadlineDays) : '',
      sourceUrl: folder,
      cover: '',
      editedPhotos: [],
      createdAt: Date.now(), lastActivity: Date.now(),
      photos
    };
    albums.unshift(al); saveAlbums(); renderAlbums(); closeCreate();
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
    let html = chip('all', 'Tất cả', albums.length, null);
    STATUSES.forEach(s => { html += chip(s.key, s.label, albums.filter(a => a.status === s.key).length, s.color); });
    el.innerHTML = html;
    $$('#filters .filter-chip').forEach(b => b.addEventListener('click', () => { currentFilter = b.dataset.f; renderAlbums(); }));
  }

  function renderAlbums() { renderFilters(); renderGrid(); }

  function renderGrid() {
    const grid = $('#albums-grid'), empty = $('#albums-empty');
    grid.innerHTML = '';
    const list = albums.filter(a => currentFilter === 'all' || a.status === currentFilter);
    if (!albums.length) { empty.hidden = false; grid.hidden = true; return; }
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
      <div class="acard-cover">${cover ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy">` : '🖼️'}</div>
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
      al.status = b.dataset.s; al.lastActivity = Date.now(); saveAlbums(); renderAlbums();
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
    card.querySelector('[data-act="download"]').addEventListener('change', e => { al.allowDownload = e.target.checked; al.lastActivity = Date.now(); saveAlbums(); });

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
    al.lastActivity = Date.now(); saveAlbums(); renderAlbums(); toast('Đã cập nhật');
  }
  function editMax(al) {
    const v = window.prompt('Số ảnh tối đa khách được chọn (0 = không giới hạn):', al.maxCount || 0);
    if (v === null) return;
    const n = parseInt(v, 10); al.maxCount = Number.isFinite(n) && n > 0 ? n : 0;
    saveAlbums(); renderAlbums();
  }
  function deleteAlbum(id) {
    const a = albums.find(x => x.id === id);
    if (!window.confirm(`Xoá album “${a ? a.name : ''}”?`)) return;
    albums = albums.filter(x => x.id !== id); saveAlbums(); renderAlbums(); toast('Đã xoá album');
    if (detailAlbum && detailAlbum.id === id) { detailAlbum = null; gotoPage('page-albums'); }
  }

  /* ---------- Chi tiết album ---------- */
  function gotoPage(id) { $$('.page').forEach(p => p.classList.toggle('active', p.id === id)); window.scrollTo({ top: 0 }); }
  function openAlbumDetail(id) {
    const al = albums.find(x => x.id === id); if (!al) return;
    detailAlbum = al; detailSet = 'goc'; pickingCover = false;
    $$('.sb-nav a').forEach(x => x.classList.toggle('active', x.dataset.page === 'albums'));
    gotoPage('page-albumdetail');
    renderDetail();
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

    detailList = detailSet === 'chon' ? selPhotos : detailSet === 'sua' ? editedPhotos : al.photos;
    $('#ad-set-title').textContent = detailSet === 'chon' ? `ẢNH CHỌN (${selPhotos.length})` : detailSet === 'sua' ? `ẢNH SỬA (${editedPhotos.length})` : `ẢNH GỐC (${al.photos.length})`;
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
    d.addEventListener('click', () => {
      if (pickingCover) {
        detailAlbum.cover = p.full || p.src; pickingCover = false; detailAlbum.lastActivity = Date.now();
        saveAlbums(); renderDetail(); renderAlbums(); toast('Đã đặt làm ảnh bìa');
      } else {
        openLightbox(detailList, idx, 'view');
      }
    });
    return d;
  }
  function appendDetailBatch() {
    const grid = $('#ad-grid');
    const frag = document.createDocumentFragment();
    const end = Math.min(detailShown + DETAIL_BATCH, detailList.length);
    for (let i = detailShown; i < end; i++) frag.appendChild(buildDetailThumb(detailList[i], i));
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
  $('#ad-preview').addEventListener('click', () => { if (detailAlbum) openClient(detailAlbum, true); });
  $('#ad-share').addEventListener('click', () => { if (detailAlbum) openShare(detailAlbum); });
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
      detailAlbum.lastActivity = Date.now(); saveAlbums();
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
    const payload = { n: al.name, m: al.maxCount, an: al.allowNotes ? 1 : 0, dl: al.allowDownload ? 1 : 0, b: brand.name, w: brand.welcome, ci, p };
    return b64encode(JSON.stringify(payload));
  }
  function albumLink(al) { return location.origin + location.pathname + '#a=' + encodeAlbum(al); }
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

  function decodeSharedAlbum() {
    const m = location.hash.match(/[#&]a=([^&]+)/);
    if (!m) return null;
    let payload; try { payload = JSON.parse(b64decode(m[1])); } catch (_) { return null; }
    const id = strHash(m[1]);
    const photos = (payload.p || []).map((row, i) => {
      if (row.length === 2) { const did = row[1]; return { id: 'g' + i, name: row[0] || `anh_${i + 1}`, driveId: did, src: driveThumb(did, 'w400'), full: driveThumb(did, 'w1600'), selected: false, note: '' }; }
      return { id: 'g' + i, name: row[0] || `anh_${i + 1}`, src: row[1], full: row[2] || row[1], selected: false, note: '' };
    });
    const cidx = payload.ci || 0;
    const cover = photos[cidx] ? (photos[cidx].full || photos[cidx].src) : (payload.c || '');
    let al = { id, name: payload.n || 'Album', maxCount: payload.m || 0, allowNotes: !!payload.an, allowDownload: !!payload.dl, brandName: payload.b || 'Lam Miên Studio', welcome: payload.w || '', cover, photos };
    try { const saved = localStorage.getItem('lamMienGuest_' + id); if (saved) { const s = JSON.parse(saved); if (s && s.photos && s.photos.length) al = s; } } catch (_) {}
    return al;
  }

  /* ---------- Client picker ---------- */
  function openClient(al, bound) {
    clientAlbum = al; clientBound = !!bound; clientFilter = 'all';
    $('#login-view').hidden = true; $('#app').hidden = true; $('#client').hidden = false;
    const brandName = al.brandName || brand.name;
    const welcome = al.welcome || brand.welcome || 'Chọn những khoảnh khắc bạn yêu thích';
    $('#client-brand').textContent = brandName;
    $('#client-title').textContent = al.name || 'Album của bạn';
    // banner ảnh bìa
    const cov = albumCover(al);
    $('#client-cover').hidden = !cov;
    if (cov) {
      $('#client-cover-img').src = cov;
      $('#client-cover-title').textContent = welcome;
      $('#client-cover-sub').textContent = brandName;
    }
    // nút quay lại (chỉ khi xem trước từ dashboard)
    let back = $('#client-back');
    if (bound) {
      if (!back) { back = document.createElement('button'); back.id = 'client-back'; back.className = 'btn ghost sm'; back.textContent = '← Bảng điều khiển'; back.style.marginLeft = 'auto'; $('.client-top').appendChild(back); back.addEventListener('click', () => { saveClient(); showApp(); }); }
      back.hidden = false;
    } else if (back) { back.hidden = true; }
    $$('.chips .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
    renderClient();
    window.scrollTo({ top: 0 });
  }
  function saveClient() {
    if (!clientAlbum) return;
    if (clientBound) { clientAlbum.lastActivity = Date.now(); saveAlbums(); }
    else { try { localStorage.setItem('lamMienGuest_' + clientAlbum.id, JSON.stringify(clientAlbum)); } catch (_) {} }
  }
  function cSel() { return clientAlbum ? clientAlbum.photos.filter(p => p.selected) : []; }

  const HEART_SVG = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.4C.7 7.7 3.4 4 7.1 4c2 0 3.6 1 4.9 2.7C13.3 5 14.9 4 16.9 4c3.7 0 6.4 3.7 4.7 7.6C19.5 16.4 12 21 12 21z"/></svg>';
  function buildPhotoCard(p) {
    const card = document.createElement('div');
    card.className = 'pcard' + (p.selected ? ' sel' : '');
    card.dataset.id = p.id;
    card.innerHTML = `<img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.name)}" loading="lazy" decoding="async">
      <button class="pick">${HEART_SVG}</button>
      <div class="cap"><span>${escapeHtml(p.name)}</span>${p.note ? '<span>📝</span>' : ''}</div>`;
    card.querySelector('.pick').addEventListener('click', ev => { ev.stopPropagation(); cToggle(p.id); });
    card.querySelector('img').addEventListener('click', () => openLightbox(clientAlbum.photos, clientAlbum.photos.indexOf(p), 'client'));
    return card;
  }
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
    sentinel.style.cssText = 'height:1px;grid-column:1/-1';
    $('#photo-grid').appendChild(sentinel);
    clientObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        sentinel.remove();
        appendClientBatch();
        setupClientSentinel();
      }
    }, { rootMargin: '800px' });
    clientObserver.observe(sentinel);
  }
  function renderClient() {
    const grid = $('#photo-grid'); grid.innerHTML = '';
    if (!clientAlbum) return;
    clientList = clientAlbum.photos.filter(p => clientFilter === 'all' || (clientFilter === 'selected' && p.selected) || (clientFilter === 'unselected' && !p.selected));
    clientShown = 0;
    appendClientBatch();      // vẽ lô đầu ngay
    setupClientSentinel();    // các lô sau nạp khi cuộn tới
    updateClientUI();
  }
  function cToggle(id) {
    const p = clientAlbum.photos.find(x => x.id === id); if (!p) return;
    if (!p.selected && clientAlbum.maxCount && cSel().length >= clientAlbum.maxCount) { toast(`Chỉ được chọn tối đa ${clientAlbum.maxCount} ảnh`); return; }
    p.selected = !p.selected; saveClient();
    const card = $('#photo-grid').querySelector(`.pcard[data-id="${p.id}"]`);
    if (card) card.classList.toggle('sel', p.selected);
    updateClientUI();
    if (lbIndex >= 0) syncLb();
    if (clientFilter !== 'all') renderClient();   // đang lọc thì cập nhật lại danh sách hiển thị
  }
  function updateClientUI() {
    const n = cSel().length;
    $('#sel-count').textContent = n;
    $('#sel-max').textContent = clientAlbum.maxCount ? ` / ${clientAlbum.maxCount}` : '';
    const total = clientAlbum.photos.length || 1;
    $('#progress-bar').style.width = (n / total * 100) + '%';
  }
  $$('.chips .chip').forEach(c => c.addEventListener('click', () => { clientFilter = c.dataset.filter; $$('.chips .chip').forEach(x => x.classList.toggle('active', x === c)); renderClient(); }));
  $('#clear-sel').addEventListener('click', () => { if (!cSel().length) return; if (!window.confirm('Bỏ chọn tất cả?')) return; clientAlbum.photos.forEach(p => p.selected = false); saveClient(); renderClient(); });

  /* ---------- Lightbox / trình xem ảnh ---------- */
  let lbPhotos = [], lbMode = 'client', lbLoadToken = 0;
  function showLbPhoto(p) {
    const img = $('#lb-img'); const token = ++lbLoadToken;
    img.alt = p.name || '';
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
    $('#lb-name').textContent = `${p.name || ''}  ·  ${i + 1}/${lbPhotos.length}`;
    preloadAround(i);
    const isClient = lbMode === 'client';
    $('#lb-toggle').hidden = !isClient;
    $('#lb-note-wrap').hidden = !(isClient && clientAlbum && clientAlbum.allowNotes);
    if (isClient) { $('#lb-note').value = p.note || ''; syncLb(); }
    $('#lightbox').classList.add('open');
  }
  function closeLb() { $('#lightbox').classList.remove('open'); lbIndex = -1; }
  function lbStep(d) { if (lbIndex < 0 || !lbPhotos.length) return; openLightbox(lbPhotos, (lbIndex + d + lbPhotos.length) % lbPhotos.length, lbMode); }
  function syncLb() { const p = lbPhotos[lbIndex]; if (!p) return; const b = $('#lb-toggle'); b.textContent = p.selected ? '♥ Bỏ chọn' : '♡ Chọn ảnh này'; b.classList.toggle('primary', !p.selected); }
  $('#lb-close').addEventListener('click', closeLb);
  $('#lb-prev').addEventListener('click', () => lbStep(-1));
  $('#lb-next').addEventListener('click', () => lbStep(1));
  $('#lb-toggle').addEventListener('click', () => { if (lbMode === 'client' && lbIndex >= 0) cToggle(lbPhotos[lbIndex].id); });
  $('#lb-note').addEventListener('input', e => { const p = lbPhotos[lbIndex]; if (p) { p.note = e.target.value; saveClient(); } });
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLb(); });
  $('#lb-img').addEventListener('click', () => lbStep(1));  // bấm ảnh để xem ảnh kế tiếp
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
    if (clientBound) { clientAlbum.status = 'done'; saveClient(); }
    $('#sum-count').textContent = sel.length;
    $('#summary-list').innerHTML = sel.map((p, i) => `<div class="r"><span class="nm">${i + 1}. ${escapeHtml(p.name)}</span>${p.note ? `<span class="nt">${escapeHtml(p.note)}</span>` : ''}</div>`).join('');
    $('#summary-modal').classList.add('open');
  });
  function closeSum() { $('#summary-modal').classList.remove('open'); }
  $('#sum-close').addEventListener('click', closeSum);
  $('#sum-x').addEventListener('click', closeSum);
  $('#summary-modal').addEventListener('click', e => { if (e.target.id === 'summary-modal') closeSum(); });
  function summaryText() {
    const sel = cSel();
    let out = `${clientAlbum.brandName || brand.name} — Danh sách ảnh đã chọn\nAlbum: ${clientAlbum.name || ''}\nTổng: ${sel.length} ảnh\n\n`;
    out += sel.map((p, i) => `${i + 1}. ${p.name}${p.note ? `  — ghi chú: ${p.note}` : ''}`).join('\n');
    return out;
  }
  $('#sum-copy').addEventListener('click', () => copyText(summaryText(), 'Đã sao chép danh sách'));
  $('#sum-download').addEventListener('click', () => {
    const blob = new Blob([summaryText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `LamMien_${(clientAlbum.name || 'album').replace(/[^\w]+/g, '_')}.txt`; a.click(); URL.revokeObjectURL(a.href);
    toast('Đã tải danh sách .txt');
  });

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
    if (dl === null) return { cls: 'dl-none', txt: 'Chưa đặt hạn' };
    if (dl < 0) return { cls: 'dl-over', txt: `Trễ ${-dl} ngày 🔥` };
    if (dl === 0) return { cls: 'dl-soon', txt: 'Hết hạn hôm nay' };
    if (dl <= 3) return { cls: 'dl-soon', txt: `Còn ${dl} ngày` };
    return { cls: 'dl-ok', txt: `Còn ${dl} ngày` };
  }
  function isOverdue(al) { const d = daysLeft(al.deadline); return al.status !== 'delivered' && d !== null && d < 0; }
  function isSoon(al) { const d = daysLeft(al.deadline); return al.status !== 'delivered' && d !== null && d >= 0 && d <= 3; }

  function renderProgress() {
    const list = $('#progress-list'), empty = $('#progress-empty'), banner = $('#deadline-banner');
    list.innerHTML = '';
    if (!albums.length) { empty.hidden = false; list.hidden = true; banner.innerHTML = ''; return; }
    empty.hidden = true; list.hidden = false;

    const over = albums.filter(isOverdue).length;
    const soon = albums.filter(isSoon).length;
    if (over) {
      banner.innerHTML = `<div class="banner alert"><svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg><span><strong>${over}</strong> album đang cháy deadline${soon ? `, <strong>${soon}</strong> album sắp đến hạn` : ''} — cần xử lý gấp!</span></div>`;
    } else if (soon) {
      banner.innerHTML = `<div class="banner alert"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2"/></svg><span><strong>${soon}</strong> album sắp đến hạn trả ảnh (trong 3 ngày).</span></div>`;
    } else {
      banner.innerHTML = `<div class="banner ok"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span>Không có album nào trễ hạn. Tiến độ ổn định 👍</span></div>`;
    }

    const sorted = albums.slice().sort((a, b) => {
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
    const row = document.createElement('div');
    row.className = 'prog-row';
    row.innerHTML = `
      <div class="who"><strong>${escapeHtml(al.name)}</strong><small>${al.client ? escapeHtml(al.client) : '—'}${hourTxt}</small></div>
      <input type="date" data-f="shoot" value="${escapeAttr(al.shootDate || '')}">
      <div class="dl-cell">
        <input type="number" min="0" step="1" data-f="days" value="${al.deadlineDays || ''}" placeholder="số ngày">
        <small>${al.deadline ? '→ ' + fmtVN(al.deadline) : (al.shootDate ? 'nhập số ngày' : 'cần ngày chụp')}</small>
      </div>
      <select data-f="status">${STATUSES.map(s => `<option value="${s.key}"${s.key === al.status ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
      <span class="deadline-badge ${bd.cls}"><span class="dot"></span>${bd.txt}</span>`;
    row.querySelector('[data-f="shoot"]').addEventListener('change', e => { al.shootDate = e.target.value; recomputeDeadline(al); al.lastActivity = Date.now(); saveAlbums(); renderProgress(); });
    row.querySelector('[data-f="days"]').addEventListener('change', e => { const n = parseInt(e.target.value, 10); al.deadlineDays = Number.isFinite(n) && n >= 0 ? n : 0; recomputeDeadline(al); al.lastActivity = Date.now(); saveAlbums(); renderProgress(); });
    row.querySelector('[data-f="status"]').addEventListener('change', e => { al.status = e.target.value; al.lastActivity = Date.now(); saveAlbums(); renderProgress(); });
    return row;
  }

  /* ---------- Init ---------- */
  loadAlbums(); loadBrand();

  const shared = decodeSharedAlbum();
  if (shared) {
    openClient(shared, false);
  } else if (localStorage.getItem(AUTH_KEY) === '1') {
    showApp();
  } else {
    showLogin();
  }
})();
