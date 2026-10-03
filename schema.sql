-- Hiilee Gift 20/10 — D1 schema
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code        TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | shipped | cancelled
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT NOT NULL,
  newsletter        INTEGER NOT NULL DEFAULT 0,
  quantity          INTEGER NOT NULL,
  recipient_type    TEXT NOT NULL,
  signed            INTEGER NOT NULL DEFAULT 0,
  ship_to_recipient INTEGER NOT NULL DEFAULT 0,
  recipient_name    TEXT,
  recipient_phone   TEXT,
  address           TEXT NOT NULL,
  referral_code     TEXT,
  note              TEXT,
  unit_price        INTEGER NOT NULL,
  discount_per_set  INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL,
  ip                TEXT,
  user_agent        TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ip_time ON orders(ip, created_at);

-- Referral codes handed out to Hiilee community members
CREATE TABLE IF NOT EXISTS referral_codes (
  code       TEXT PRIMARY KEY,          -- stored UPPERCASE, no spaces
  owner      TEXT,                      -- who the code belongs to
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
