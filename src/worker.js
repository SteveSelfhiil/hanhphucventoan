/**
 * Hiilee Gift 20/10 — Cloudflare Worker
 *
 * Serves the landing page (static assets in /public) and handles orders:
 *   GET  /api/config                      price + discount shown on the page
 *   GET  /api/referral?code=XXX           check a referral code
 *   POST /api/orders                      create an order, returns VietQR payment info
 *   GET  /api/admin/orders.csv            export orders (Bearer ADMIN_TOKEN or ?token=)
 *   GET  /api/admin/orders                same, as JSON
 *   POST /api/admin/orders/:code/status   { "status": "paid" | "cancelled" | "shipped" | "pending" }
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const STATUSES = ["pending", "paid", "shipped", "cancelled"];
const RECIPIENT_TYPES = ["Chính mình", "Mẹ", "Vợ", "Chị em, bạn bè", "Đồng nghiệp", "Khác"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/config" && request.method === "GET") return json(publicConfig(env));
      if (pathname === "/api/referral" && request.method === "GET") return handleReferral(url, env);
      if (pathname === "/api/orders" && request.method === "POST") return handleCreateOrder(request, env, ctx);
      if (pathname.startsWith("/api/admin/")) return handleAdmin(request, url, env);
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
  const payment = buildPayment(env, total, transferNote);
  const result = { orderCode, total, transferNote, qrUrl: payment.qrUrl, bank: payment.bankLabel };

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

/* ---------------- payment (VietQR) ---------------- */

function buildPayment(env, amount, note) {
  if (!env.BANK_ID || !env.BANK_ACCOUNT_NO) return { qrUrl: env.STATIC_QR_URL || null, bankLabel: null };
  const tpl = env.VIETQR_TEMPLATE || "compact2";
  const qs = new URLSearchParams({ amount: String(amount), addInfo: note });
  if (env.BANK_ACCOUNT_NAME) qs.set("accountName", env.BANK_ACCOUNT_NAME);
  const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(env.BANK_ID)}-${encodeURIComponent(env.BANK_ACCOUNT_NO)}-${tpl}.png?${qs}`;
  const bankLabel = [env.BANK_NAME || env.BANK_ID.toUpperCase(), env.BANK_ACCOUNT_NO, env.BANK_ACCOUNT_NAME].filter(Boolean).join(" · ");
  return { qrUrl, bankLabel };
}

/* ---------------- admin ---------------- */

async function handleAdmin(request, url, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") || "";
  if (!env.ADMIN_TOKEN || !(await safeEqual(token, env.ADMIN_TOKEN))) return json({ error: "Unauthorized" }, 401);

  const m = url.pathname.match(/^\/api\/admin\/orders\/(HG[A-Z0-9]{6})\/status$/);
  if (m && request.method === "POST") {
    const { status } = await request.json().catch(() => ({}));
    if (!STATUSES.includes(status)) return json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
    const r = await env.DB.prepare("UPDATE orders SET status = ?1, updated_at = datetime('now') WHERE order_code = ?2").bind(status, m[1]).run();
    return r.meta.changes ? json({ ok: true, orderCode: m[1], status }) : json({ error: "Order not found" }, 404);
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

function csv(rows) {
  const cols = ["order_code", "created_at", "status", "name", "phone", "email", "newsletter", "quantity", "recipient_type",
    "signed", "ship_to_recipient", "recipient_name", "recipient_phone", "address", "referral_code", "note",
    "unit_price", "discount_per_set", "total"];
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
