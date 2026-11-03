# hanhphucventoan.com — Hiilee Gift (version 27 Oct 2026)

The Hiilee Gift site on Cloudflare Workers: book pages for *Trưởng thành* and *HIILEE-6PR* with page-turning previews,
the combo set, an order form (combo and single books), an admin page, order tracking with emails, and two policy pages.

```
public/index.html                 main page
public/css/site.css               shared styles (all pages)
public/dieu-khoan-dich-vu/        Điều khoản dịch vụ & Chính sách giao nhận
public/chinh-sach-bao-mat/        Chính sách bảo mật
public/tra-cuu/                   customer order tracking (tracking code HL…)
public/admin/                     admin page (log in with ADMIN_TOKEN)
public/img/books/<book>/          28 pages per book for the page-turning preview (WebP)
public/img/qr/                    payment QR images from the Techcombank app
public/img/brand/                 Self Hiil and Trường nhà hạnh phúc logos
public/vendor/                    StPageFlip (MIT) — the page-turning effect
src/worker.js                     API: prices, referral check, orders, tracking, admin, emails
schema.sql                        database tables for a NEW database
migrations/003-books-and-wrapping.sql   update for the EXISTING database (run once)
wrangler.toml                     Worker settings: prices, referral codes, bank, email
```

## Deploying (same Worker and database as before)

1. **Update the database once.** In Cloudflare → Storage & databases → D1 → `hiilee-gift` → Console,
   paste everything from `migrations/003-books-and-wrapping.sql` and run it.
   Do this *before* deploying: the new order form saves the quantity of each book and the wrapping choice.
2. Put these files in the GitHub repo connected to the `hanhphucventoan` Worker (replacing the old files),
   or run `npx wrangler deploy` from this folder. Cloudflare builds and deploys automatically from GitHub.
3. Secrets stay as they are: `ADMIN_TOKEN`, `RESEND_API_KEY`.

## Prices and discounts (`wrangler.toml`)

| Setting | Value |
|---|---|
| `PRICE_COMBO` | 389000 — Bộ sách Trưởng thành + HIILEE-6PR |
| `PRICE_TRUONG_THANH` | 270000 |
| `PRICE_HIILEE` | 195000 |
| `REFERRAL_DISCOUNT` | 20000 off **each** combo and **each** book when a valid referral code is used |
| `ORDER_DEADLINE` | empty = always open; set a date to stop taking orders |
| `REFERRAL_CODES` | comma-separated, not case-sensitive |

The server always recalculates the total; the page only shows an estimate. Prices shown on the page are read from these settings.

## Payment QR

The QR images from the bank app have the amount built in, so they are only used when the amount matches:

| Order | QR shown |
|---|---|
| 1, 2 or 3 combos only, no code | `bank-qr-without-code.jpg`, `-x2-…`, `-x3-…` |
| 1, 2 or 3 combos only, with code | `bank-qr-with-code.jpg`, `-x2-…`, `-x3-…` |
| anything else (single books, mixed orders, 4+ combos) | `bank-qr-blank.jpg` + a note asking the customer to type the total |

## Orders, tracking and emails

- **Admin:** `/admin/` — confirm payment, mark shipped (carrier, tracking number) and delivered, cancel, resend email, download CSV.
- Confirming payment creates a tracking code (`HL…`) and emails it to the buyer through Resend
  (from `MAIL_FROM`, replies go to `MAIL_REPLY_TO`).
- **Customers:** `/tra-cuu/` — enter the tracking code to see the order timeline.

## Updating the book previews

Pages were rendered from `truong-thanh-chapter-1.pdf` and `Hiiileee-6PR_file-chapter1.pdf` at 760 px wide (WebP).
To replace them, export new pages with the same names (`trang-01.webp` … `trang-28.webp`).
The first and last pages are treated as hard covers.
