/**
 * Hiilee Gift 20/10 — Cloudflare Worker
 *
 * Serves the landing page (static assets in /public) and handles orders:
 *   GET  /api/config                      price + discount shown on the page
 *   GET  /api/referral?code=XXX           check a referral code
 *   POST /api/orders                      create an order, returns VietQR payment info
 *   GET  /api/admin/orders.csv            export orders (Bearer ADMIN_TOKEN or ?token=)
 *   GET  /api/admin/orders                same, as JSON
 *   POST /api/admin/orders/:code/status   { "status": "paid" | "shipped" | "delivered" | "cancelled" | "pending",
 *                                           "carrier"?: "...", "shippingRef"?: "..." }
 *                                         → marking "paid" creates a tracking code and emails it to the buyer
 *   POST /api/admin/orders/:code/resend-email   send the tracking email again
 *   GET  /api/track?code=HLXXXXXXXX       public order tracking (no personal data returned)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];
const RECIPIENT_TYPES = ["Chính mình", "Mẹ", "Vợ", "Chị em, bạn bè", "Đồng nghiệp", "Khác"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/config" && request.method === "GET") return json(publicConfig(env));
      if (pathname === "/api/referral" && request.method === "GET") return handleReferral(url, env);
      if (pathname === "/api/orders" && request.method === "POST") return handleCreateOrder(request, env, ctx);
      if (pathname === "/api/track" && request.method === "GET") return handleTrack(url, env);
      if (pathname.startsWith("/api/admin/")) return handleAdmin(request, url, env, ctx);
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Có lỗi máy chủ, bạn thử lại sau ít phút nhé." }, 500);
    }

    // Everything else: static landing page + images
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- config ---------------- */

function cfg(env) {
  return {
    unitPrice: int(env.UNIT_PRICE, 389000),
    referralDiscount: int(env.REFERRAL_DISCOUNT, 20000),
    maxQty: int(env.MAX_QUANTITY, 50),
    deadline: env.ORDER_DEADLINE || "2026-10-15T23:59:59+07:00",
    acceptAnyReferral: String(env.ACCEPT_ANY_REFERRAL || "false").toLowerCase() === "true",
  };
}

function publicConfig(env) {
  const c = cfg(env);
  return { unitPrice: c.unitPrice, referralDiscount: c.referralDiscount, maxQuantity: c.maxQty, deadline: c.deadline, open: Date.now() <= Date.parse(c.deadline) };
}

/* ---------------- referral ---------------- */

async function lookupReferral(code, env) {
  const c = cfg(env);
  const norm = normalizeCode(code);
  if (!norm) return null;
  const row = await env.DB.prepare("SELECT code FROM referral_codes WHERE code = ?1 AND active = 1").bind(norm).first();
  if (row) return norm;
  const listed = String(env.REFERRAL_CODES || "").split(",").map(normalizeCode).filter(Boolean);
  if (listed.includes(norm)) return norm;
  if (c.acceptAnyReferral) return norm;
  return null;
}

async function handleReferral(url, env) {
  const code = await lookupReferral(url.searchParams.get("code") || "", env);
  return json(code ? { valid: true, code, discount: cfg(env).referralDiscount } : { valid: false });
}

/* ---------------- create order ---------------- */

async function handleCreateOrder(request, env, ctx) {
  const c = cfg(env);
  if (Date.now() > Date.parse(c.deadline)) {
    return json({ error: "Self Hiil đã ngừng nhận đặt quà 20/10. Cảm ơn bạn đã quan tâm!" }, 410);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Dữ liệu gửi lên không hợp lệ." }, 400); }

  // Honeypot: bots fill the hidden "website" field. Pretend success, store nothing.
  if (body.website) return json({ orderCode: "HG000000", total: 0, transferNote: "", qrUrl: null });

  const v = validate(body, c);
  if (v.error) return json({ error: v.error }, 422);
  const o = v.order;

  // Basic abuse guard: max 5 orders per IP per 10 minutes
  const ip = request.headers.get("cf-connecting-ip") || "";
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE ip = ?1 AND created_at > datetime('now','-10 minutes')"
  ).bind(ip).first();
  if (recent && recent.n >= 5) return json({ error: "Bạn gửi quá nhiều đơn trong thời gian ngắn, vui lòng thử lại sau." }, 429);

  const referral = o.referralCode ? await lookupReferral(o.referralCode, env) : null;
  if (o.referralCode && !referral) return json({ error: "Mã giới thiệu không hợp lệ. Bạn xoá mã hoặc nhập lại giúp Self Hiil nhé." }, 422);

  const discount = referral ? c.referralDiscount : 0;
  const total = (c.unitPrice - discount) * o.quantity;
  const transferPrefix = (env.TRANSFER_PREFIX || "HIILEE").toUpperCase();

  // Insert with a unique order code (retry on the rare collision)
  let orderCode;
  for (let i = 0; i < 5; i++) {
    orderCode = "HG" + randomCode(6);
    try {
      await env.DB.prepare(
        `INSERT INTO orders (order_code, name, phone, email, newsletter, quantity, recipient_type, signed,
           ship_to_recipient, recipient_name, recipient_phone, address, referral_code, note,
           unit_price, discount_per_set, total, status, ip, user_agent)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'pending',?18,?19)`
      ).bind(
        orderCode, o.name, o.phone, o.email, o.newsletter ? 1 : 0, o.quantity, o.recipientType, o.signed ? 1 : 0,
        o.shipToRecipient ? 1 : 0, o.recipientName, o.recipientPhone, o.address, referral, o.note,
        c.unitPrice, discount, total, ip, (request.headers.get("user-agent") || "").slice(0, 300)
      ).run();
      break;
    } catch (e) {
      if (!String(e).includes("UNIQUE") || i === 4) throw e;
    }
  }

  const transferNote = `${transferPrefix} ${orderCode}`;
  const payment = buildPayment(env, total, transferNote, !!referral, o.quantity);
  const result = { orderCode, total, transferNote, qrUrl: payment.qrUrl, bank: payment.bankLabel, enterAmount: payment.enterAmount,
    bankName: env.BANK_NAME || null, accountNo: env.BANK_ACCOUNT_NO || null, accountName: env.BANK_ACCOUNT_NAME || null };

  // Optional: push a notification (Google Apps Script, Slack, Zapier, Make, n8n…)
  if (env.NOTIFY_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "order.created", ...result, ...o, referralCode: referral, createdAt: new Date().toISOString() }),
      }).catch((e) => console.error("webhook failed", e))
    );
  }

  return json(result, 201);
}

function validate(b, c) {
  const s = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const o = {
    name: s(b.name, 120),
    phone: normalizePhone(s(b.phone, 20)),
    email: s(b.email, 160).toLowerCase(),
    newsletter: !!b.newsletter,
    quantity: Number.parseInt(b.quantity, 10),
    recipientType: s(b.recipientType, 40),
    signed: !!b.signed,
    shipToRecipient: !!b.shipToRecipient,
    recipientName: s(b.recipientName, 120),
    recipientPhone: normalizePhone(s(b.recipientPhone, 20)),
    address: s(b.address, 500),
    referralCode: s(b.referralCode, 40),
    note: s(b.note, 1000),
  };
  if (!o.name) return { error: "Bạn nhập giúp họ và tên người đặt nhé." };
  if (!isVnPhone(o.phone)) return { error: "Số điện thoại người đặt chưa đúng." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) return { error: "Email chưa đúng định dạng." };
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > c.maxQty) return { error: `Số bộ quà phải từ 1 đến ${c.maxQty}.` };
  if (!RECIPIENT_TYPES.includes(o.recipientType)) return { error: "Bạn chọn giúp người nhận món quà nhé." };
  if (o.shipToRecipient) {
    if (!o.recipientName) return { error: "Bạn nhập giúp tên người nhận nhé." };
    if (!isVnPhone(o.recipientPhone)) return { error: "Số điện thoại người nhận chưa đúng." };
  } else {
    o.recipientName = "";
    o.recipientPhone = "";
  }
  if (o.address.length < 10) return { error: "Bạn nhập địa chỉ giao quà đầy đủ giúp Self Hiil nhé." };
  return { order: o };
}

/* ---------------- payment ---------------- */

function buildPayment(env, amount, note, withReferral = false, qty = 1) {
  const bankLabel = [env.BANK_NAME || (env.BANK_ID || "").toUpperCase(), env.BANK_ACCOUNT_NO, env.BANK_ACCOUNT_NAME].filter(Boolean).join(" · ") || null;
  // QR images made in the bank app (public/img/qr/): one per quantity 1–3, with/without referral code,
  // and a blank QR (customer types the amount) for 4 sets or more.
  const qrImage = qrImageFor(env, qty, withReferral);
  if (qrImage) return { qrUrl: qrImage, bankLabel, enterAmount: qty > 3 };
  if (env.STATIC_QR_URL || !env.BANK_ID || !env.BANK_ACCOUNT_NO) return { qrUrl: env.STATIC_QR_URL || null, bankLabel, enterAmount: true };
  const tpl = env.VIETQR_TEMPLATE || "compact2";
  const qs = new URLSearchParams({ amount: String(amount), addInfo: note });
  if (env.BANK_ACCOUNT_NAME) qs.set("accountName", env.BANK_ACCOUNT_NAME);
  const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(env.BANK_ID)}-${encodeURIComponent(env.BANK_ACCOUNT_NO.replace(/\s/g, ""))}-${tpl}.png?${qs}`;
  return { qrUrl, bankLabel, enterAmount: false };
}

function qrImageFor(env, qty, withReferral) {
  const dir = String(env.QR_IMAGE_DIR || "").replace(/\/$/, "");
  if (!dir) return null;
  if (qty >= 1 && qty <= 3) return `${dir}/bank-qr${qty > 1 ? "-x" + qty : ""}-${withReferral ? "with" : "without"}-code.jpg`;
  return `${dir}/bank-qr-blank.jpg`;
}

/* ---------------- public tracking ---------------- */

async function handleTrack(url, env) {
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^HL[A-Z0-9]{8}$/.test(code)) return json({ error: "Mã theo dõi gồm 10 ký tự, bắt đầu bằng HL." }, 400);
  const o = await env.DB.prepare(
    `SELECT order_code, tracking_code, status, quantity, signed, ship_to_recipient, created_at, paid_at, shipped_at,
            delivered_at, cancelled_at, carrier, shipping_ref FROM orders WHERE tracking_code = ?1`
  ).bind(code).first();
  if (!o) return json({ error: "Không tìm thấy đơn hàng với mã theo dõi này." }, 404);
  return json({
    orderCode: o.order_code, trackingCode: o.tracking_code, status: o.status, quantity: o.quantity,
    signed: !!o.signed, shipToRecipient: !!o.ship_to_recipient, carrier: o.carrier || null, shippingRef: o.shipping_ref || null,
    timeline: { created: iso(o.created_at), paid: iso(o.paid_at), shipped: iso(o.shipped_at), delivered: iso(o.delivered_at), cancelled: iso(o.cancelled_at) },
  });
}

function iso(sqlTime) {
  return sqlTime ? sqlTime.replace(" ", "T") + "Z" : null;
}

/* ---------------- admin ---------------- */

async function handleAdmin(request, url, env, ctx) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") || "";
  if (!env.ADMIN_TOKEN || !(await safeEqual(token, env.ADMIN_TOKEN))) return json({ error: "Unauthorized" }, 401);

  const m = url.pathname.match(/^\/api\/admin\/orders\/(HG[A-Z0-9]{6})\/(status|resend-email)$/);
  if (m && request.method === "POST") {
    const orderCode = m[1];
    const order = await env.DB.prepare("SELECT * FROM orders WHERE order_code = ?1").bind(orderCode).first();
    if (!order) return json({ error: "Order not found" }, 404);

    if (m[2] === "resend-email") {
      if (!order.tracking_code) return json({ error: "Đơn chưa có mã theo dõi (chưa đánh dấu đã thanh toán)." }, 400);
      const mail = await sendTrackingEmail(env, order, url);
      await saveMailResult(env, orderCode, mail);
      return json({ ok: mail.ok, orderCode, trackingCode: order.tracking_code, email: mail });
    }

    const body = await request.json().catch(() => ({}));
    const status = body.status;
    if (!STATUSES.includes(status)) return json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
    const carrier = typeof body.carrier === "string" ? body.carrier.trim().slice(0, 60) : null;
    const shippingRef = typeof body.shippingRef === "string" ? body.shippingRef.trim().slice(0, 80) : null;

    let trackingCode = order.tracking_code;
    const needsTracking = status !== "pending" && status !== "cancelled" && !trackingCode;
    if (needsTracking) trackingCode = await newTrackingCode(env);

    const stamp = { paid: "paid_at", shipped: "shipped_at", delivered: "delivered_at", cancelled: "cancelled_at" }[status];
    const sets = ["status = ?1", "updated_at = datetime('now')", "tracking_code = ?2"];
    if (stamp) sets.push(`${stamp} = COALESCE(${stamp}, datetime('now'))`);
    // Moving forward implies the earlier steps happened too
    if (status === "shipped" || status === "delivered") sets.push("paid_at = COALESCE(paid_at, datetime('now'))");
    if (status === "delivered") sets.push("shipped_at = COALESCE(shipped_at, datetime('now'))");
    sets.push("carrier = COALESCE(?4, carrier)", "shipping_ref = COALESCE(?5, shipping_ref)");
    await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE order_code = ?3`)
      .bind(status, trackingCode, orderCode, carrier, shippingRef).run();

    // First time an order gets a tracking code → email it to the buyer
    let email = null;
    if (needsTracking) {
      const fresh = await env.DB.prepare("SELECT * FROM orders WHERE order_code = ?1").bind(orderCode).first();
      email = await sendTrackingEmail(env, fresh, url);
      await saveMailResult(env, orderCode, email);
    }
    return json({ ok: true, orderCode, status, trackingCode, email });
  }

  if ((url.pathname === "/api/admin/orders" || url.pathname === "/api/admin/orders.csv") && request.method === "GET") {
    const status = url.searchParams.get("status");
    const stmt = STATUSES.includes(status)
      ? env.DB.prepare("SELECT * FROM orders WHERE status = ?1 ORDER BY id DESC").bind(status)
      : env.DB.prepare("SELECT * FROM orders ORDER BY id DESC");
    const { results } = await stmt.all();
    if (url.pathname.endsWith(".csv")) return csv(results);
    return json({ count: results.length, orders: results });
  }

  return json({ error: "Not found" }, 404);
}

async function newTrackingCode(env) {
  for (let i = 0; i < 5; i++) {
    const code = "HL" + randomCode(8);
    const hit = await env.DB.prepare("SELECT 1 FROM orders WHERE tracking_code = ?1").bind(code).first();
    if (!hit) return code;
  }
  throw new Error("could not create tracking code");
}

async function saveMailResult(env, orderCode, mail) {
  await env.DB.prepare(
    "UPDATE orders SET email_sent_at = CASE WHEN ?1 THEN datetime('now') ELSE email_sent_at END, email_error = ?2 WHERE order_code = ?3"
  ).bind(mail.ok ? 1 : 0, mail.ok ? null : String(mail.error).slice(0, 300), orderCode).run();
}

function siteUrl(env, url) {
  return (env.SITE_URL || url.origin).replace(/\/$/, "");
}

/* Sends the "payment received + tracking code" email through Resend (https://resend.com). */
async function sendTrackingEmail(env, o, url) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return { ok: false, error: "Email chưa được cấu hình (RESEND_API_KEY / MAIL_FROM)." };
  const site = siteUrl(env, url);
  const link = `${site}/tra-cuu/?ma=${o.tracking_code}`;
  const money = (n) => Number(n).toLocaleString("vi-VN").replace(/,/g, ".") + "đ";
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const to = o.ship_to_recipient ? `${esc(o.recipient_name)} (${esc(o.recipient_phone)})` : esc(o.name);
  const subject = `Self Hiil đã nhận thanh toán đơn ${o.order_code} · Mã theo dõi ${o.tracking_code}`;
  const html = `<!doctype html><html><body style="margin:0;background:#fbf7ef;font-family:Arial,Helvetica,sans-serif;color:#2b2622">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7ef;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #ebe1cf;border-radius:16px">
<tr><td style="padding:30px 30px 8px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;color:#8a7f73;text-transform:uppercase">Hiilee Gift · 20/10</p>
<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:26px;color:#e43583">Cảm ơn bạn, Self Hiil đã nhận được thanh toán</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6">Chào ${esc(o.name)},<br>Đơn quà của bạn đã được xác nhận. Self Hiil đang chuẩn bị, thắt ruy băng${o.signed ? " và xin chữ ký tác giả trên cả 3 cuốn sách" : ""} để giao quà kịp trước ngày 20/10.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fce8f1;border-radius:12px"><tr><td style="padding:18px 20px;text-align:center">
<p style="margin:0 0 4px;font-size:13px;color:#8a7f73">Mã theo dõi đơn hàng</p>
<p style="margin:0;font-size:28px;font-weight:bold;letter-spacing:3px;color:#c2236c">${o.tracking_code}</p>
</td></tr></table>
<p style="text-align:center;margin:22px 0"><a href="${link}" style="display:inline-block;background:#e43583;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:999px;font-size:15px">Theo dõi đơn hàng</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5;border-top:1px solid #ebe1cf">
<tr><td style="padding:10px 0;color:#8a7f73">Mã đơn</td><td style="padding:10px 0;text-align:right">${o.order_code}</td></tr>
<tr><td style="padding:10px 0;color:#8a7f73;border-top:1px solid #f3ecdf">Số bộ quà</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f3ecdf">${o.quantity}</td></tr>
<tr><td style="padding:10px 0;color:#8a7f73;border-top:1px solid #f3ecdf">Đã thanh toán</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f3ecdf">${money(o.total)}</td></tr>
<tr><td style="padding:10px 0;color:#8a7f73;border-top:1px solid #f3ecdf">Người nhận</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f3ecdf">${to}</td></tr>
<tr><td style="padding:10px 0;color:#8a7f73;border-top:1px solid #f3ecdf;vertical-align:top">Địa chỉ giao</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f3ecdf">${esc(o.address)}</td></tr>
</table>
<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#5c544c">Giao quà dự kiến <b>17–18/10/2026</b>. Bạn có thể xem trạng thái đơn bất kỳ lúc nào tại <a href="${site}/tra-cuu/" style="color:#c2236c">${site.replace(/^https?:\/\//, "")}/tra-cuu</a> với mã theo dõi ở trên.</p>
</td></tr>
<tr><td style="padding:22px 30px 28px;font-size:13px;line-height:1.6;color:#8a7f73">
<i style="font-family:Georgia,serif;font-size:16px;color:#e43583">Trao một món quà. Gieo một hành trình trưởng thành.</i><br><br>
Self Hiil · 99 Nguyễn Cửu Vân, P. Gia Định, HCM · Hotline +84 865 161 315 · hiila@selfhiil.com
</td></tr></table></td></tr></table></body></html>`;
  const text = `Chào ${o.name},\n\nSelf Hiil đã nhận được thanh toán cho đơn ${o.order_code}.\nMã theo dõi đơn hàng: ${o.tracking_code}\nTheo dõi tại: ${link}\n\nSố bộ quà: ${o.quantity}\nĐã thanh toán: ${money(o.total)}\nĐịa chỉ giao: ${o.address}\n\nGiao quà dự kiến 17–18/10/2026.\n\nSelf Hiil · Hotline +84 865 161 315 · hiila@selfhiil.com`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [o.email], reply_to: env.MAIL_REPLY_TO || undefined, bcc: env.MAIL_BCC ? [env.MAIL_BCC] : undefined, subject, html, text }),
    });
    if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const d = await r.json().catch(() => ({}));
    return { ok: true, id: d.id || null, to: o.email };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function csv(rows) {
  const cols = ["order_code", "created_at", "status", "name", "phone", "email", "newsletter", "quantity", "recipient_type",
    "signed", "ship_to_recipient", "recipient_name", "recipient_phone", "address", "referral_code", "note",
    "unit_price", "discount_per_set", "total", "tracking_code", "paid_at", "shipped_at", "delivered_at", "cancelled_at",
    "carrier", "shipping_ref", "email_sent_at", "email_error"];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    // Leading quote stops Excel from treating phone numbers as numbers / formulas
    const safe = /^[=+\-@]|^0\d/.test(s) ? "'" + s : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="hiilee-gift-orders-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/* ---------------- helpers ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function int(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function normalizeCode(c) {
  return String(c || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 40);
}
function normalizePhone(p) {
  let s = p.replace(/[\s.\-()]/g, "");
  if (s.startsWith("+84")) s = "0" + s.slice(3);
  else if (s.startsWith("84") && s.length === 11) s = "0" + s.slice(2);
  return s;
}
function isVnPhone(p) {
  return /^0\d{9,10}$/.test(p);
}
function randomCode(n) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
