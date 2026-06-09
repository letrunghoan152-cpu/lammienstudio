# Lam Miên Studio — Trang chọn & lọc ảnh

Trang web tĩnh giúp khách hàng của **Lam Miên Studio** chọn ảnh và gửi lại danh sách cho studio xử lý.

## Tính năng
- Tạo album bằng cách tải ảnh từ máy, dán link ảnh, hoặc dùng ảnh mẫu.
- Khách chọn ảnh bằng 1 chạm (nút trái tim), giới hạn số ảnh tối đa.
- Xem ảnh lớn (lightbox) với điều hướng bàn phím, ghi chú trên từng ảnh.
- Lọc Tất cả / Đã chọn / Chưa chọn, thanh tiến độ.
- Hoàn tất: sao chép hoặc tải về danh sách ảnh đã chọn (.txt).
- Tự lưu lựa chọn vào trình duyệt (localStorage).

## Chạy local
Mở thẳng `index.html` bằng trình duyệt, hoặc chạy server tĩnh:

```bash
python3 -m http.server 4173
# mở http://localhost:4173
```

## Triển khai
Đây là site tĩnh thuần (HTML/CSS/JS), không cần build. Deploy trực tiếp lên Vercel, Netlify, hoặc GitHub Pages.
