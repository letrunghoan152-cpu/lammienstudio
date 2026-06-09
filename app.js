/* Lam Miên Studio — trang chọn ảnh (client-side, không cần backend) */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const STORE_KEY = 'lamMienAlbum';

  /* ---------- State ---------- */
  let album = { name: '', maxCount: 0, allowNotes: true, photos: [] };
  // photo = { id, name, src, selected, note }
  let currentSource = 'files';
  let currentFilter = 'all';
  let lbIndex = -1;

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------- Navigation ---------- */
  function navigate(view) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#' + view + '-view').classList.add('active');
    $$('.main-nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === view));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (view === 'gallery') renderGallery();
  }
  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); navigate(nav.dataset.nav); }
  });
  $('#cta-start').addEventListener('click', () => {
    $('#builder').scrollIntoView({ behavior: 'smooth' });
  });

  /* ---------- Source segmented control ---------- */
  $('#source-seg').addEventListener('click', e => {
    const btn = e.target.closest('button[data-src]');
    if (!btn) return;
    currentSource = btn.dataset.src;
    $$('#source-seg button').forEach(b => b.classList.toggle('active', b === btn));
    $('#src-files').hidden = currentSource !== 'files';
    $('#src-drive').hidden = currentSource !== 'drive';
    $('#src-urls').hidden = currentSource !== 'urls';
  });

  /* ---------- Google Drive ---------- */
  const DRIVE_KEY_STORE = 'lamMienDriveKey';
  // nạp key đã lưu
  try {
    const savedKey = localStorage.getItem(DRIVE_KEY_STORE);
    if (savedKey) $('#drive-key').value = savedKey;
  } catch (_) {}
  $('#drive-key').addEventListener('change', e => {
    const k = e.target.value.trim();
    try { k ? localStorage.setItem(DRIVE_KEY_STORE, k) : localStorage.removeItem(DRIVE_KEY_STORE); } catch (_) {}
  });

  function extractFolderId(text) {
    if (!text) return '';
    const m = String(text).match(/\/folders\/([a-zA-Z0-9_-]+)/) ||
              String(text).match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    const trimmed = String(text).trim();
    return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : '';
  }
  function driveFileId(url) {
    const m = String(url).match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
              String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
              String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }
  const driveThumb = (id, sz) => `https://drive.google.com/thumbnail?id=${id}&sz=${sz || 'w1000'}`;

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
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const e = await res.json(); msg = e.error?.message || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async function buildDrivePhotos(folderText, apiKey) {
    const folderId = extractFolderId(folderText);
    if (!folderId) throw new Error('Không nhận ra ID thư mục Drive. Hãy dán đúng link dạng .../folders/...');
    if (!apiKey) throw new Error('Chưa nhập Google Drive API Key.');
    const files = await listDriveFolder(folderId, apiKey);
    if (!files.length) throw new Error('Thư mục trống hoặc chưa chia sẻ “Bất kỳ ai có đường liên kết”.');
    return files.map((f, i) => ({
      id: 'd' + i + '_' + Date.now(),
      name: f.name,
      src: driveThumb(f.id, 'w1000'),
      full: driveThumb(f.id, 'w1920'),
      selected: false, note: ''
    }));
  }

  /* ---------- File input ---------- */
  let pickedFiles = [];
  $('#file-input').addEventListener('change', e => {
    pickedFiles = Array.from(e.target.files || []);
    $('#files-hint').textContent = pickedFiles.length
      ? `Đã chọn ${pickedFiles.length} ảnh — sẵn sàng tạo album.`
      : 'Chưa chọn ảnh nào. Có thể chọn nhiều file một lúc.';
  });

  const DEMO = [
    'photo-1519741497674-611481863552', 'photo-1520854221256-17451cc331bf',
    'photo-1511285560929-80b456fea0bc', 'photo-1519225421980-715cb0215aed',
    'photo-1465495976277-4387d4b0b4c6', 'photo-1525258946800-98cfd641d0de',
    'photo-1606216794074-735e91aa2c92', 'photo-1583939003579-730e3918a45a',
    'photo-1591604466107-ec97de577aff', 'photo-1537633552985-df8429e8048b',
    'photo-1460978812857-470ed1c77af0', 'photo-1522673607200-164d1b6ce486'
  ].map((id, i) => ({
    name: `LMS_${String(i + 1).padStart(4, '0')}.jpg`,
    src: `https://images.unsplash.com/${id}?auto=format&fit=crop&w=700&q=78`
  }));

  /* ---------- Create album ---------- */
  function readFileAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  $('#create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = $('#create-form button[type="submit"]');
    let photos = [];

    try {
      if (currentSource === 'files') {
        if (!pickedFiles.length) { toast('Hãy chọn ít nhất 1 ảnh từ máy'); return; }
        toast('Đang nạp ảnh…');
        photos = await Promise.all(pickedFiles.map(async (f, i) => ({
          id: 'p' + i + '_' + Date.now(),
          name: f.name,
          src: await readFileAsDataURL(f),
          selected: false, note: ''
        })));

      } else if (currentSource === 'drive') {
        const folderText = $('#drive-url').value.trim();
        const apiKey = $('#drive-key').value.trim();
        if (!folderText) { toast('Hãy dán link thư mục Google Drive'); return; }
        submitBtn.disabled = true; submitBtn.textContent = 'Đang tải ảnh…';
        toast('Đang tải ảnh từ Google Drive…');
        photos = await buildDrivePhotos(folderText, apiKey);

      } else if (currentSource === 'urls') {
        const lines = $('#url-list').value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) { toast('Hãy dán ít nhất 1 link ảnh'); return; }
        // Nếu là link thư mục Drive -> chuyển sang tab Google Drive
        const folderLine = lines.find(l => extractFolderId(l) && /drive\.google\.com\/.*folders/.test(l));
        if (folderLine) {
          $('#drive-url').value = folderLine;
          document.querySelector('#source-seg button[data-src="drive"]').click();
          toast('Đây là link thư mục Drive — đã chuyển sang tab Google Drive, nhập API key giúp nhé');
          return;
        }
        photos = lines.map((url, i) => {
          const fid = driveFileId(url);
          if (fid && /drive\.google\.com/.test(url)) {
            return { id: 'p' + i + '_' + Date.now(), name: `drive_${i + 1}.jpg`, src: driveThumb(fid, 'w1000'), full: driveThumb(fid, 'w1920'), selected: false, note: '' };
          }
          return { id: 'p' + i + '_' + Date.now(), name: url.split('/').pop().split('?')[0] || `anh_${i + 1}.jpg`, src: url, selected: false, note: '' };
        });

      } else {
        photos = DEMO.map((d, i) => ({ id: 'p' + i + '_' + Date.now(), name: d.name, src: d.src, selected: false, note: '' }));
      }
    } catch (err) {
      toast('Lỗi: ' + (err.message || err));
      return;
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = 'Tạo trang chọn';
    }

    const max = parseInt($('#max-count').value, 10);
    album = {
      name: $('#album-name').value.trim() || 'Album chưa đặt tên',
      maxCount: Number.isFinite(max) && max > 0 ? max : 0,
      allowNotes: $('#allow-notes').checked,
      photos
    };
    save();
    reflectAlbumStatus();
    toast(`Đã tạo album với ${photos.length} ảnh`);
  });

  function reflectAlbumStatus() {
    const has = album.photos.length > 0;
    $('#album-status').value = has
      ? `“${album.name}” · ${album.photos.length} ảnh${album.maxCount ? ` · tối đa ${album.maxCount}` : ''}`
      : '';
    $('#album-detail').textContent = has
      ? `Cho phép ghi chú: ${album.allowNotes ? 'Có' : 'Không'}. Bấm “Mở trang chọn ảnh” để khách bắt đầu chọn.`
      : 'Album sẽ lưu ngay trên trình duyệt này. Bạn có thể mở lại tab “Chọn ảnh” bất cứ lúc nào.';
    $('#open-gallery').disabled = !has;
    $('#reset-album').disabled = !has;
    $('#copy-status').disabled = !has;
  }

  $('#open-gallery').addEventListener('click', () => navigate('gallery'));
  $('#reset-album').addEventListener('click', () => {
    if (!confirm('Xoá album hiện tại?')) return;
    album = { name: '', maxCount: 0, allowNotes: true, photos: [] };
    pickedFiles = []; $('#file-input').value = ''; $('#url-list').value = '';
    $('#album-name').value = ''; $('#max-count').value = '';
    $('#files-hint').textContent = 'Chưa chọn ảnh nào. Có thể chọn nhiều file một lúc.';
    localStorage.removeItem(STORE_KEY);
    reflectAlbumStatus(); renderGallery();
    toast('Đã xoá album');
  });
  $('#copy-status').addEventListener('click', () => {
    navigator.clipboard?.writeText($('#album-status').value);
    toast('Đã sao chép thông tin album');
  });

  /* ---------- Persistence ---------- */
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(album)); } catch (_) {} }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) album = Object.assign(album, JSON.parse(raw));
    } catch (_) {}
  }

  /* ---------- Gallery render ---------- */
  function selectedCount() { return album.photos.filter(p => p.selected).length; }

  function renderGallery() {
    const empty = $('#gallery-empty'), grid = $('#photo-grid'), bar = $('#selbar');
    const has = album.photos.length > 0;
    empty.hidden = has;
    bar.hidden = !has;
    grid.innerHTML = '';
    $('#gallery-title').textContent = album.name && album.name !== 'Album chưa đặt tên'
      ? album.name : 'Chọn những khoảnh khắc bạn yêu thích';

    if (!has) { updateSelUI(); return; }

    album.photos.forEach((p, i) => {
      const show = currentFilter === 'all' || (currentFilter === 'selected' && p.selected) || (currentFilter === 'unselected' && !p.selected);
      if (!show) return;
      const card = document.createElement('div');
      card.className = 'photo-card' + (p.selected ? ' selected' : '');
      card.dataset.id = p.id;
      const order = p.selected ? album.photos.filter((x, j) => x.selected && j <= i).length : '';
      card.innerHTML = `
        ${p.selected ? `<span class="num">${order}</span>` : ''}
        <img src="${escapeAttr(p.src)}" alt="${escapeAttr(p.name)}" loading="lazy">
        <button class="pick" aria-label="Chọn ảnh">
          <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.4C.7 7.7 3.4 4 7.1 4c2 0 3.6 1 4.9 2.7C13.3 5 14.9 4 16.9 4c3.7 0 6.4 3.7 4.7 7.6C19.5 16.4 12 21 12 21z"/></svg>
        </button>
        <div class="cap"><span>${escapeHtml(p.name)}</span>${p.note ? '<span class="note-flag" title="Có ghi chú">📝</span>' : ''}</div>`;
      card.querySelector('.pick').addEventListener('click', ev => { ev.stopPropagation(); toggleSelect(p.id); });
      card.querySelector('img').addEventListener('click', () => openLightbox(i));
      grid.appendChild(card);
    });
    updateSelUI();
  }

  function toggleSelect(id) {
    const p = album.photos.find(x => x.id === id);
    if (!p) return;
    if (!p.selected && album.maxCount && selectedCount() >= album.maxCount) {
      toast(`Chỉ được chọn tối đa ${album.maxCount} ảnh`); return;
    }
    p.selected = !p.selected;
    save();
    renderGallery();
    if (lbIndex >= 0) syncLightboxToggle();
  }

  function updateSelUI() {
    const n = selectedCount();
    $('#sel-count').textContent = n;
    $('#sel-max').textContent = album.maxCount ? ` / ${album.maxCount}` : '';
    const total = album.photos.length || 1;
    $('#progress-bar').style.width = (n / total * 100) + '%';
    $('#hero-count').textContent = (1248 + n).toLocaleString('vi-VN');
  }

  /* ---------- Filters ---------- */
  $$('.filter-chips .chip').forEach(c => c.addEventListener('click', () => {
    currentFilter = c.dataset.filter;
    $$('.filter-chips .chip').forEach(x => x.classList.toggle('active', x === c));
    renderGallery();
  }));
  $('#clear-sel').addEventListener('click', () => {
    if (!selectedCount()) return;
    if (!confirm('Bỏ chọn tất cả ảnh?')) return;
    album.photos.forEach(p => p.selected = false);
    save(); renderGallery(); toast('Đã bỏ chọn hết');
  });

  /* ---------- Lightbox ---------- */
  function openLightbox(i) {
    lbIndex = i;
    const p = album.photos[i];
    if (!p) return;
    $('#lb-img').src = p.full || p.src;
    $('#lb-img').alt = p.name;
    $('#lb-name').textContent = p.name;
    $('#lb-note-wrap').hidden = !album.allowNotes;
    $('#lb-note').value = p.note || '';
    syncLightboxToggle();
    $('#lightbox').classList.add('open');
    $('#lightbox').setAttribute('aria-hidden', 'false');
  }
  function closeLightbox() {
    $('#lightbox').classList.remove('open');
    $('#lightbox').setAttribute('aria-hidden', 'true');
    lbIndex = -1;
  }
  function lbStep(d) {
    if (lbIndex < 0) return;
    let i = (lbIndex + d + album.photos.length) % album.photos.length;
    openLightbox(i);
  }
  function syncLightboxToggle() {
    const p = album.photos[lbIndex];
    if (!p) return;
    const btn = $('#lb-toggle');
    btn.textContent = p.selected ? '♥ Đã chọn — bỏ chọn' : '♡ Chọn ảnh này';
    btn.classList.toggle('danger', p.selected);
    btn.classList.toggle('primary', !p.selected);
  }
  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => lbStep(-1));
  $('#lb-next').addEventListener('click', () => lbStep(1));
  $('#lb-toggle').addEventListener('click', () => { if (lbIndex >= 0) toggleSelect(album.photos[lbIndex].id); });
  $('#lb-note').addEventListener('input', e => {
    const p = album.photos[lbIndex];
    if (p) { p.note = e.target.value; save(); }
  });
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', e => {
    if (!$('#lightbox').classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  });

  /* ---------- Finish / summary ---------- */
  function selectedList() { return album.photos.filter(p => p.selected); }
  $('#finish-btn').addEventListener('click', () => {
    const sel = selectedList();
    if (!sel.length) { toast('Bạn chưa chọn ảnh nào'); return; }
    $('#sum-count').textContent = sel.length;
    $('#summary-list').innerHTML = sel.map((p, i) =>
      `<div class="row"><span class="nm">${i + 1}. ${escapeHtml(p.name)}</span>${p.note ? `<span class="nt">${escapeHtml(p.note)}</span>` : ''}</div>`
    ).join('');
    $('#summary-modal').classList.add('open');
    $('#summary-modal').setAttribute('aria-hidden', 'false');
  });
  function closeModal() {
    $('#summary-modal').classList.remove('open');
    $('#summary-modal').setAttribute('aria-hidden', 'true');
  }
  $('#sum-close').addEventListener('click', closeModal);
  $('#summary-modal').addEventListener('click', e => { if (e.target.id === 'summary-modal') closeModal(); });

  function summaryText() {
    const sel = selectedList();
    let out = `LAM MIÊN STUDIO — Danh sách ảnh đã chọn\nAlbum: ${album.name}\nTổng: ${sel.length} ảnh\n\n`;
    out += sel.map((p, i) => `${i + 1}. ${p.name}${p.note ? `  — ghi chú: ${p.note}` : ''}`).join('\n');
    return out;
  }
  $('#sum-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(summaryText());
    toast('Đã sao chép danh sách');
  });
  $('#sum-download').addEventListener('click', () => {
    const blob = new Blob([summaryText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `LamMien_${album.name.replace(/[^\w]+/g, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Đã tải danh sách .txt');
  });

  /* ---------- Helpers ---------- */
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  /* ---------- Init ---------- */
  $('#year').textContent = new Date().getFullYear();
  load();
  reflectAlbumStatus();
})();
