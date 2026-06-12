# Bật đồng bộ đa thiết bị (backend)

Sau khi làm xong các bước này, nhân sự đăng nhập ở **bất kỳ máy nào** cũng thấy đủ album, và **khách chọn ảnh trên điện thoại của họ sẽ tự đồng bộ về studio**.

## Bước 1 — Tạo database miễn phí trên Supabase (~5 phút)

1. Vào https://supabase.com → **Start your project** → đăng nhập bằng GitHub.
2. **New project**:
   - Name: `lammien-studio`
   - Database Password: đặt mật khẩu bất kỳ (lưu lại)
   - Region: **Southeast Asia (Singapore)** (gần VN nhất)
   - Bấm **Create new project**, đợi ~1 phút.
3. Menu trái → **SQL Editor** → **New query** → dán đoạn sau rồi bấm **Run**:

```sql
create table albums (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
```

4. Menu trái → **Project Settings** (bánh răng) → **API**:
   - Copy **Project URL** (dạng `https://xxxx.supabase.co`)
   - Copy **service_role key** (mục Project API keys — bấm Reveal để hiện)
   - ⚠️ service_role key là chìa khoá tối cao — KHÔNG dán vào chat/code, chỉ dán vào Vercel ở bước 2.

## Bước 2 — Khai báo biến môi trường trên Vercel (~3 phút)

1. Vào https://vercel.com → project **lammienstudio** → **Settings → Environment Variables**.
2. Thêm 4 biến sau (Environment: chọn cả Production + Preview):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL vừa copy |
| `SUPABASE_SERVICE_KEY` | service_role key vừa copy |
| `STAFF_USER` | tên đăng nhập cho nhân sự (vd `lammien`) |
| `STAFF_PASS` | mật khẩu mới, đủ mạnh |

3. Tab **Deployments** → bấm **⋯** ở bản mới nhất → **Redeploy** (để biến môi trường có hiệu lực).

## Bước 3 — Kiểm tra

1. Mở `https://lammienstudio.vercel.app` → đăng nhập bằng `STAFF_USER`/`STAFF_PASS`.
2. Thấy toast **"dữ liệu đồng bộ mọi thiết bị"** là thành công. Album cũ trên máy chính sẽ tự đẩy lên máy chủ ở lần đăng nhập đầu.
3. Mở máy/điện thoại khác → đăng nhập → thấy đủ album.
4. Bấm **Chia sẻ link** trong album → link mới dạng ngắn `...?al=xxx` → gửi khách. Khách chọn xong, studio mở album sẽ thấy folder **Ảnh chọn** tự cập nhật.

## Ghi chú

- Chưa làm các bước trên thì web vẫn chạy như cũ (chế độ offline, dữ liệu lưu theo từng máy).
- Link kiểu cũ (`#a=...`) vẫn mở được nhưng không đồng bộ — sau khi bật backend hãy gửi khách link mới.
- Gói miễn phí Supabase: 500MB database — thoải mái cho hàng nghìn album (chỉ lưu tên/ID ảnh, không lưu ảnh).
