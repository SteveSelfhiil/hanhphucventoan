# Hiilee Gift 20/10 — Cloudflare Worker

The landing page from `hpvt.html`, with the same content and design, running on Cloudflare Workers. The order form now works:
orders are saved to Cloudflare D1, and the customer gets a VietQR code with the exact amount and order code filled in.

```
public/index.html     the landing page (images moved out of the HTML into public/img/)
public/img/           page images; testimonials/ holds the reader portraits
public/favicon.svg    site icon · public/logo.svg  footer logo
src/worker.js         API: config, referral check, create order, admin export
schema.sql            D1 tables: orders, referral_codes
wrangler.toml         Worker config + settings (price, deadline, bank)
```

## Deploy (about 5 minutes)

```bash
npm install
npx wrangler login
npx wrangler d1 create hiilee-gift          # copy the database_id into wrangler.toml
npm run db:init                             # create the tables in the live database
npx wrangler secret put ADMIN_TOKEN         # a long random password for exporting orders
npm run deploy
```

Before deploying, fill in the `[vars]` in `wrangler.toml`:

| Var | What it is |
|---|---|
| `BANK_ID` | Bank short name or BIN for VietQR, e.g. `vcb`, `tcb`, `mb` (list: https://api.vietqr.io/v2/banks) |
| `BANK_ACCOUNT_NO`, `BANK_ACCOUNT_NAME`, `BANK_NAME` | Self Hiil's company account. These are shown under the QR code. |
| `UNIT_PRICE`, `REFERRAL_DISCOUNT` | 389000 / 20000 by default. The server calculates the price, so a customer can't change it in the browser. |
| `ORDER_DEADLINE` | `2026-10-15T23:59:59+07:00`. After this, new orders are rejected with a polite message. |
| `TRANSFER_PREFIX` | The transfer note becomes `HIILEE HGXXXXXX`, which makes it easy to match payments to orders. |

To use a custom domain, open Workers & Pages → hiilee-gift → Settings → Domains & Routes.

## Referral codes

Add codes to the database so you can see who referred each order:

```bash
npx wrangler d1 execute hiilee-gift --remote --command \
  "INSERT INTO referral_codes(code, owner) VALUES ('LIEN20','Nguyễn Thuỳ Liên'), ('HIILEE01','Community A')"
```

Codes don't care about upper or lower case. You can also list codes in `REFERRAL_CODES` (comma-separated). If you set `ACCEPT_ANY_REFERRAL = "true"`, any code is accepted, which matches how the mockup behaved.

## Working with orders

- **Download all orders as a file that opens in Excel:** `https://<your-domain>/api/admin/orders.csv?token=<ADMIN_TOKEN>`
  (add `&status=pending` or `&status=paid` to filter)
- **Get orders as JSON:** `GET /api/admin/orders` with the header `Authorization: Bearer <ADMIN_TOKEN>`
- **Mark an order paid, shipped or cancelled:**
  ```bash
  curl -X POST https://<domain>/api/admin/orders/HG7RUZ29/status \
    -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"status":"paid"}'
  ```
- **Get a notification for each new order (optional):** run `npx wrangler secret put NOTIFY_WEBHOOK_URL` and give it a Google Apps Script, Slack, Zapier, Make or n8n webhook URL. Each new order is sent there as JSON, which is handy for logging orders into a Google Sheet.

## Run it on your computer

```bash
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run dev        # http://localhost:8787
```

## What changed from the mockup

- Every form field now has a name. The form checks the fields before sending, and the server checks them again (Vietnamese phone numbers in 0xxx or +84 format, email, quantity from 1 to 50, delivery address). If the gift goes straight to the recipient, the recipient's name and phone become required.
- The "Áp dụng" button now checks the referral code with the server. An invalid code shows an error message.
- The success screen shows the order code, the amount the server calculated, the transfer note and a real VietQR code. The two yellow placeholders for the QR code and the transfer note are gone.
- Spam protection: a hidden field that only bots fill in, and a limit of 5 orders per IP every 10 minutes.
- The page loads much faster. The images used to be embedded inside the HTML, which was about 1.9 MB. They are now separate files, and the HTML is about 55 KB.

The signature option now covers all 3 books, so the FAQ placeholder "Cần xác nhận: ký cuốn nào" has been removed.

## Order tracking & emails

- **Admin page:** `https://hanhphucventoan.com/admin/` (log in with `ADMIN_TOKEN`). Confirm payments, mark orders shipped/delivered, cancel, resend emails, download CSV.
- **Customer tracking page:** `https://hanhphucventoan.com/tra-cuu/`, where customers enter their `HL…` tracking code.
- When an order is marked **paid**, a tracking code is created and emailed to the buyer via [Resend](https://resend.com).
  1. Create a Resend account → **Domains → Add domain** `hanhphucventoan.com` → add the DNS records it shows in Cloudflare.
  2. Resend → **API Keys → Create** → add it to the Worker as the secret `RESEND_API_KEY`.
  3. `MAIL_FROM`, `MAIL_REPLY_TO`, `MAIL_BCC` and `SITE_URL` are in `wrangler.toml`.
- **Existing databases** need the new columns once: paste `migrations/002-order-tracking.sql` into the D1 Console and run it. (`schema.sql` already includes them for new databases.)

## Payment QR

QR images made in the Techcombank app live in `public/img/qr/`. The site picks one per order:

| Gift sets | No referral code | With referral code |
|---|---|---|
| 1 | `bank-qr-without-code.jpg` (389.000đ) | `bank-qr-with-code.jpg` (369.000đ) |
| 2 | `bank-qr-x2-without-code.jpg` (778.000đ) | `bank-qr-x2-with-code.jpg` (738.000đ) |
| 3 | `bank-qr-x3-without-code.jpg` (1.167.000đ) | `bank-qr-x3-with-code.jpg` (1.107.000đ) |
| 4+ | `bank-qr-blank.jpg`, no amount; the page asks the customer to type the total | same |

If the price or discount changes, re-make these images in the bank app with the new amounts.

## Book preview

`public/img/doc-thu/` holds the 27 pages of *Trưởng thành* (cover → end of Chapter 1), shown as a page-turning book using [StPageFlip](https://github.com/Nodlik/StPageFlip) (MIT licence, vendored in `public/vendor/`).
