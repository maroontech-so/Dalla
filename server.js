require("dotenv").config();

const express = require("express");
const compression = require("compression");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const APP_URL = process.env.APP_URL;
const CURRENCY = String(process.env.CURRENCY || "KES").toUpperCase();
const MIN_PAYMENT_KES = Number(process.env.MIN_PAYMENT_KES || 10);
const MAX_PAYMENT_KES = Number(process.env.MAX_PAYMENT_KES || 1000000);
const PAYSTACK_SUBACCOUNT = String(
  process.env.PAYSTACK_SUBACCOUNT || "",
).trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const ADMIN_SESSION_SECRET = String(
  process.env.ADMIN_SESSION_SECRET || "",
).trim();

if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is missing");
if (!APP_URL) throw new Error("APP_URL is missing");
if (!/^sk_(test|live)_/.test(PAYSTACK_SECRET_KEY)) {
  throw new Error("PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_");
}
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is missing");
if (!ADMIN_SESSION_SECRET) throw new Error("ADMIN_SESSION_SECRET is missing");

/* =========================================================
   DATABASE
========================================================= */

const db = new Database(path.join(__dirname, "payments.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function migrateWalletsTable() {
  if (!tableExists("wallets")) return;
  const colNames = db
    .prepare(`PRAGMA table_info(wallets)`)
    .all()
    .map((c) => c.name);
  if (
    colNames.includes("customer_id") &&
    colNames.includes("balance") &&
    colNames.includes("currency")
  )
    return;

  console.log("⚙️  Migrating wallets table...");
  db.exec(`ALTER TABLE wallets RENAME TO wallets_old;`);
  db.exec(`
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL UNIQUE,
      balance INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '${CURRENCY}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
  `);
  if (colNames.includes("customer_id") && colNames.includes("balance")) {
    try {
      db.exec(`
        INSERT INTO wallets (customer_id, balance, currency, created_at, updated_at)
        SELECT customer_id, balance,
          COALESCE(NULLIF(currency,''), '${CURRENCY}'),
          COALESCE(created_at, CURRENT_TIMESTAMP),
          COALESCE(updated_at, CURRENT_TIMESTAMP)
        FROM wallets_old WHERE customer_id IS NOT NULL;
      `);
    } catch (err) {
      console.warn("wallet migration partial:", err.message);
    }
  }
  db.exec(`DROP TABLE wallets_old;`);
}

function migratePaymentAttemptsTable() {
  if (!tableExists("payment_attempts")) return;
  if (!columnExists("payment_attempts", "channel")) {
    db.exec(`ALTER TABLE payment_attempts ADD COLUMN channel TEXT;`);
  }
  if (!columnExists("payment_attempts", "authorization_code")) {
    db.exec(`ALTER TABLE payment_attempts ADD COLUMN authorization_code TEXT;`);
  }
}

migrateWalletsTable();
migratePaymentAttemptsTable();

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'KES',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'paystack',
    provider_transaction_id TEXT,
    email TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    channel TEXT,
    status TEXT NOT NULL DEFAULT 'initialized',
    authorization_url TEXT,
    access_code TEXT,
    authorization_code TEXT,
    metadata TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    payment_attempt_id INTEGER,
    provider TEXT NOT NULL,
    provider_transaction_id TEXT,
    reference TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    description TEXT,
    payment_method TEXT,
    channel TEXT,
    gateway_response TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id),
    FOREIGN KEY(payment_attempt_id) REFERENCES payment_attempts(id)
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_id TEXT,
    event_type TEXT NOT NULL,
    reference TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_payment_attempts_reference ON payment_attempts(reference);
  CREATE INDEX IF NOT EXISTS idx_wallets_customer ON wallets(customer_id);
`);

/* =========================================================
   EXPRESS — PERFORMANCE FIRST
========================================================= */

// 1. Compression for all responses
app.use(compression({ threshold: 512 }));

// 2. JSON body parser (small limit; we never receive big payloads)
app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

// 3. Static files with aggressive caching.
//    HTML is served explicitly below with no-cache.
const staticOptions = {
  maxAge: "1y",
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
};
app.use(express.static(__dirname, staticOptions));

// 4. Small helper to send an HTML file with no-cache
function sendHtml(res, filename) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(path.join(__dirname, filename));
}

/* =========================================================
   HELPERS
========================================================= */

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();
const cleanString = (v, max = 200) =>
  String(v || "")
    .trim()
    .slice(0, max);
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const moneyToSubunit = (a) => {
  const v = Number(a);
  if (!Number.isFinite(v)) throw new Error("Invalid amount");
  return Math.round(v * 100);
};
const subunitToMoney = (a) => Number(a) / 100;
const generateReference = () =>
  "DALLA-" + Date.now() + "-" + crypto.randomBytes(5).toString("hex");

function timingSafeEqualHex(a, b) {
  if (!a || !b) return false;
  const A = Buffer.from(String(a), "utf8");
  const B = Buffer.from(String(b), "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function normalizeKenyanPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length === 10)
    return "254" + digits.slice(1);
  if (digits.length === 9) return "254" + digits;
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("2540") && digits.length === 13)
    return "254" + digits.slice(4);
  return digits;
}
const isValidKenyanPhone = (p) => /^254(7|1)\d{8}$/.test(p);

const normalizeCardNumber = (raw) => String(raw || "").replace(/\D/g, "");
function isValidCardNumber(num) {
  if (!/^\d{13,19}$/.test(num)) return false;
  let sum = 0,
    alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function normalizeExpiry(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length < 4) return { month: "", year: "" };
  const month = d.slice(0, 2);
  let year = d.slice(2, 4);
  if (year.length === 2) year = "20" + year;
  return { month, year };
}
function isValidExpiry(month, year) {
  if (!/^\d{2}$/.test(month) || !/^\d{4}$/.test(year)) return false;
  const m = Number(month),
    y = Number(year);
  if (m < 1 || m > 12) return false;
  const now = new Date();
  const cy = now.getFullYear(),
    cm = now.getMonth() + 1;
  if (y < cy) return false;
  if (y === cy && m < cm) return false;
  return y <= cy + 30;
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function signAdminToken(expiresAt) {
  const payload = `admin.${expiresAt}`;
  const sig = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}
function verifyAdminToken(token) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [role, expiresAt, sig] = parts;
  if (role !== "admin") return false;
  if (Number(expiresAt) < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(`${role}.${expiresAt}`)
    .digest("hex");
  return timingSafeEqualHex(sig, expected);
}
function requireAdmin(req, res, next) {
  const token = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("admin_session="))
    ?.split("=")[1];
  if (!verifyAdminToken(token))
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

/* =========================================================
   PAYSTACK API
========================================================= */

async function paystackRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  if (!response.ok || data.status === false) {
    const error = new Error(data.message || `Paystack HTTP ${response.status}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function fetchPaystackBalanceSubunit() {
  const response = await paystackRequest("/balance", { method: "GET" });
  if (!response.status || !Array.isArray(response.data))
    throw new Error("Invalid Paystack balance response");
  const b = response.data.find(
    (x) => String(x.currency).toUpperCase() === CURRENCY,
  );
  if (!b) throw new Error(`No ${CURRENCY} Paystack balance`);
  return { subunit: Number(b.balance), currency: b.currency };
}

/* =========================================================
   CUSTOMER
========================================================= */

function getOrCreateCustomer(email, name, phone) {
  email = normalizeEmail(email);
  let c = db.prepare(`SELECT * FROM customers WHERE email = ?`).get(email);
  if (!c) {
    const r = db
      .prepare(`INSERT INTO customers (email, name, phone) VALUES (?, ?, ?)`)
      .run(email, name || null, phone || null);
    c = db
      .prepare(`SELECT * FROM customers WHERE id = ?`)
      .get(r.lastInsertRowid);
  } else {
    db.prepare(
      `
      UPDATE customers SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(name || null, phone || null, c.id);
  }
  const w = db
    .prepare(`SELECT id FROM wallets WHERE customer_id = ?`)
    .get(c.id);
  if (!w)
    db.prepare(
      `INSERT INTO wallets (customer_id, balance, currency) VALUES (?, 0, ?)`,
    ).run(c.id, CURRENCY);
  return c;
}

/* =========================================================
   CREDIT
========================================================= */

const creditSuccessfulPayment = db.transaction((d) => {
  const {
    customerId,
    reference,
    providerTransactionId,
    amount,
    currency,
    paymentAttemptId,
    paymentMethod,
    channel,
    gatewayResponse,
    metadata,
  } = d;

  const existing = db
    .prepare(
      `SELECT * FROM transactions WHERE reference = ? AND status = 'success'`,
    )
    .get(reference);
  if (existing) return { alreadyProcessed: true, transaction: existing };

  const attempt = db
    .prepare(`SELECT * FROM payment_attempts WHERE id = ?`)
    .get(paymentAttemptId);
  if (!attempt) throw new Error("Payment attempt does not exist");

  const wallet = db
    .prepare(`SELECT id FROM wallets WHERE customer_id = ?`)
    .get(customerId);
  if (!wallet)
    db.prepare(
      `INSERT INTO wallets (customer_id, balance, currency) VALUES (?, 0, ?)`,
    ).run(customerId, CURRENCY);

  db.prepare(
    `UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`,
  ).run(amount, customerId);

  const isMpesa = channel === "mobile_money";
  const tr = db
    .prepare(
      `
    INSERT INTO transactions (
      customer_id, payment_attempt_id, provider, provider_transaction_id,
      reference, type, status, amount, currency, description,
      payment_method, channel, gateway_response, metadata
    ) VALUES (?, ?, 'paystack', ?, ?, 'deposit', 'success', ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      customerId,
      paymentAttemptId,
      providerTransactionId || null,
      reference,
      amount,
      currency,
      isMpesa ? "M-Pesa donation" : "Card donation",
      paymentMethod || "card",
      channel || null,
      gatewayResponse || null,
      metadata || null,
    );

  db.prepare(
    `
    UPDATE payment_attempts SET
      status = 'success',
      provider_transaction_id = ?,
      paid_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(providerTransactionId || null, paymentAttemptId);

  return {
    alreadyProcessed: false,
    transaction: db
      .prepare(`SELECT * FROM transactions WHERE id = ?`)
      .get(tr.lastInsertRowid),
  };
});

/* =========================================================
   M-PESA INITIALIZE
========================================================= */

app.post("/api/payments/paystack/initialize", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = cleanString(req.body.name, 100);
    const rawPhone = cleanString(req.body.phone, 30);
    const amountKes = Number(req.body.amount_kes ?? req.body.amount);

    if (!isValidEmail(email))
      return res.status(400).json({ error: "Enter a valid email" });
    if (
      !Number.isFinite(amountKes) ||
      amountKes < MIN_PAYMENT_KES ||
      amountKes > MAX_PAYMENT_KES
    ) {
      return res.status(400).json({
        error: `Amount must be between KES ${MIN_PAYMENT_KES} and KES ${MAX_PAYMENT_KES}`,
      });
    }

    const phone = normalizeKenyanPhone(rawPhone);
    if (!isValidKenyanPhone(phone))
      return res.status(400).json({ error: "Enter a valid Safaricom number" });
    if (amountKes > 250000)
      return res
        .status(400)
        .json({ error: "M-Pesa limit is KES 250,000 per transaction" });

    const amountSubunit = moneyToSubunit(amountKes);
    const customer = getOrCreateCustomer(email, name, phone);
    const reference = generateReference();
    const callbackUrl = `${APP_URL.replace(/\/$/, "")}/payment/callback`;

    const payload = {
      email,
      amount: String(amountSubunit),
      currency: CURRENCY,
      reference,
      callback_url: callbackUrl,
      channels: ["mobile_money"],
      mobile_money: {
        phone: phone.startsWith("+") ? phone : "+" + phone,
        provider: "mpesa",
      },
      metadata: {
        customer_id: customer.id,
        email,
        name,
        phone,
        method: "mpesa",
        reference,
      },
    };
    if (PAYSTACK_SUBACCOUNT) payload.subaccount = PAYSTACK_SUBACCOUNT;

    const pr = await paystackRequest("/charge", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!pr.status || !pr.data)
      throw new Error("Paystack did not return charge data");
    const data = pr.data;

    db.prepare(
      `
      INSERT INTO payment_attempts (
        customer_id, reference, provider, email, amount, currency,
        channel, status, authorization_url, access_code, metadata
      ) VALUES (?, ?, 'paystack', ?, ?, ?, 'mobile_money', ?, ?, ?, ?)
    `,
    ).run(
      customer.id,
      reference,
      email,
      amountSubunit,
      CURRENCY,
      data.status || "pay_offline",
      data.authorization_url || null,
      data.access_code || null,
      JSON.stringify({
        customer_id: customer.id,
        name,
        phone,
        method: "mpesa",
      }),
    );

    res.json({
      success: true,
      method: "mpesa",
      reference,
      status: data.status,
      display_text:
        data.display_text || "Check your phone for the M-Pesa prompt",
      amount_kes: amountKes,
      currency: CURRENCY,
    });
  } catch (e) {
    console.error("MPESA INIT ERROR:", e.response || e.message);
    res
      .status(502)
      .json({ error: e.message || "Unable to start M-Pesa payment" });
  }
});

/* =========================================================
   CARD CHARGE
========================================================= */

app.post("/api/payments/paystack/charge", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = cleanString(req.body.name, 100);
    const amountKes = Number(req.body.amount_kes ?? req.body.amount);
    const cardNumber = normalizeCardNumber(req.body.card_number);
    const cvv = cleanString(req.body.cvv, 4);
    const expiryRaw = cleanString(req.body.expiry, 10);

    if (!isValidEmail(email))
      return res.status(400).json({ error: "Enter a valid email" });
    if (
      !Number.isFinite(amountKes) ||
      amountKes < MIN_PAYMENT_KES ||
      amountKes > MAX_PAYMENT_KES
    ) {
      return res.status(400).json({
        error: `Amount must be between KES ${MIN_PAYMENT_KES} and KES ${MAX_PAYMENT_KES}`,
      });
    }
    if (!isValidCardNumber(cardNumber))
      return res.status(400).json({ error: "Enter a valid card number" });
    if (!/^\d{3,4}$/.test(cvv))
      return res.status(400).json({ error: "Enter a valid CVV" });

    const { month, year } = normalizeExpiry(expiryRaw);
    if (!isValidExpiry(month, year))
      return res.status(400).json({ error: "Enter a valid expiry (MM/YY)" });

    const amountSubunit = moneyToSubunit(amountKes);
    const customer = getOrCreateCustomer(email, name, "");
    const reference = generateReference();

    const payload = {
      email,
      amount: String(amountSubunit),
      currency: CURRENCY,
      reference,
      card: { number: cardNumber, cvv, expiry_month: month, expiry_year: year },
      metadata: {
        customer_id: customer.id,
        email,
        name,
        method: "card",
        reference,
      },
    };
    if (PAYSTACK_SUBACCOUNT) payload.subaccount = PAYSTACK_SUBACCOUNT;

    const pr = await paystackRequest("/charge", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!pr.status || !pr.data)
      throw new Error("Paystack did not return charge data");
    const data = pr.data;

    const result = db
      .prepare(
        `
      INSERT INTO payment_attempts (
        customer_id, reference, provider, email, amount, currency,
        channel, status, authorization_url, access_code, metadata
      ) VALUES (?, ?, 'paystack', ?, ?, ?, 'card', ?, ?, ?, ?)
    `,
      )
      .run(
        customer.id,
        reference,
        email,
        amountSubunit,
        CURRENCY,
        data.status || "initialized",
        data.authorization_url || null,
        data.access_code || null,
        JSON.stringify({ customer_id: customer.id, name, method: "card" }),
      );

    const paymentAttemptId = result.lastInsertRowid;

    if (data.status === "success") {
      const credit = creditSuccessfulPayment({
        customerId: customer.id,
        reference,
        providerTransactionId: data.id,
        amount: Number(data.amount),
        currency: data.currency,
        paymentAttemptId,
        paymentMethod:
          data.authorization?.card_type || data.authorization?.brand || "card",
        channel: data.channel || "card",
        gatewayResponse: data.gateway_response,
        metadata: JSON.stringify(data.metadata || {}),
      });
      if (data.authorization?.authorization_code) {
        db.prepare(
          `UPDATE payment_attempts SET authorization_code = ? WHERE id = ?`,
        ).run(data.authorization.authorization_code, paymentAttemptId);
      }
      return res.json({
        success: true,
        reference,
        status: "success",
        paid: true,
        amount_kes: subunitToMoney(data.amount),
        currency: data.currency,
        alreadyProcessed: credit.alreadyProcessed,
      });
    }

    res.json({
      success: true,
      reference,
      status: data.status,
      paid: false,
      display_text: data.display_text || null,
      message: data.message || null,
      authorization_url: data.authorization_url || null,
    });
  } catch (e) {
    console.error("CARD CHARGE ERROR:", e.response || e.message);
    res.status(502).json({ error: e.message || "Unable to charge card" });
  }
});

/* =========================================================
   SUBMIT PIN / OTP / BIRTHDAY / ADDRESS
========================================================= */

app.post("/api/payments/paystack/submit", async (req, res) => {
  try {
    const reference = cleanString(req.body.reference, 100);
    const type = cleanString(req.body.type, 20).toLowerCase();
    const value = cleanString(req.body.value, 200);

    if (!reference || !type || !value)
      return res.status(400).json({ error: "Missing fields" });

    const attempt = db
      .prepare(`SELECT * FROM payment_attempts WHERE reference = ?`)
      .get(reference);
    if (!attempt) return res.status(404).json({ error: "Reference not found" });

    let endpoint, payload;
    if (type === "pin") {
      endpoint = "/charge/submit_pin";
      payload = { pin: value, reference };
    } else if (type === "otp") {
      endpoint = "/charge/submit_otp";
      payload = { otp: value, reference };
    } else if (type === "birthday") {
      endpoint = "/charge/submit_birthday";
      payload = { birthday: value, reference };
    } else if (type === "address") {
      endpoint = "/charge/submit_address";
      payload = {
        address: value,
        reference,
        city: cleanString(req.body.city, 80),
        state: cleanString(req.body.state, 80),
        zipcode: cleanString(req.body.zipcode, 20),
      };
    } else return res.status(400).json({ error: "Unsupported type" });

    const pr = await paystackRequest(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = pr.data;
    if (!data) throw new Error("Paystack returned no data");

    if (data.status === "success") {
      const credit = creditSuccessfulPayment({
        customerId: attempt.customer_id,
        reference,
        providerTransactionId: data.id,
        amount: Number(data.amount),
        currency: data.currency,
        paymentAttemptId: attempt.id,
        paymentMethod: data.authorization?.card_type || "card",
        channel: data.channel || "card",
        gatewayResponse: data.gateway_response,
        metadata: JSON.stringify(data.metadata || {}),
      });
      if (data.authorization?.authorization_code) {
        db.prepare(
          `UPDATE payment_attempts SET authorization_code = ? WHERE id = ?`,
        ).run(data.authorization.authorization_code, attempt.id);
      }
      return res.json({
        success: true,
        reference,
        status: "success",
        paid: true,
        amount_kes: subunitToMoney(data.amount),
        currency: data.currency,
        alreadyProcessed: credit.alreadyProcessed,
      });
    }
    res.json({
      success: true,
      reference,
      status: data.status,
      paid: false,
      display_text: data.display_text || null,
      message: data.message || null,
      authorization_url: data.authorization_url || null,
    });
  } catch (e) {
    console.error("SUBMIT ERROR:", e.response || e.message);
    res.status(502).json({ error: e.message || "Unable to submit" });
  }
});

/* =========================================================
   VERIFY
========================================================= */

app.get("/api/payments/paystack/verify/:reference", async (req, res) => {
  try {
    const reference = cleanString(req.params.reference, 100);
    const attempt = db
      .prepare(`SELECT * FROM payment_attempts WHERE reference = ?`)
      .get(reference);
    if (!attempt) return res.status(404).json({ error: "Reference not found" });

    const pr = await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: "GET" },
    );
    const p = pr.data;
    if (!p) throw new Error("No Paystack data");

    const amountMatches = Number(p.amount) === Number(attempt.amount);
    const currencyMatches =
      String(p.currency).toUpperCase() ===
      String(attempt.currency).toUpperCase();
    if (!amountMatches)
      return res
        .status(400)
        .json({ error: "Amount mismatch", status: p.status });
    if (!currencyMatches)
      return res
        .status(400)
        .json({ error: "Currency mismatch", status: p.status });

    if (p.status === "success") {
      const credit = creditSuccessfulPayment({
        customerId: attempt.customer_id,
        reference,
        providerTransactionId: p.id,
        amount: Number(p.amount),
        currency: p.currency,
        paymentAttemptId: attempt.id,
        paymentMethod:
          p.authorization?.card_type ||
          p.authorization?.brand ||
          "mobile_money",
        channel: p.channel,
        gatewayResponse: p.gateway_response,
        metadata: JSON.stringify(p.metadata || {}),
      });
      return res.json({
        success: true,
        paid: true,
        alreadyProcessed: credit.alreadyProcessed,
        reference,
        amount_kes: subunitToMoney(p.amount),
        currency: p.currency,
        status: p.status,
        channel: p.channel,
      });
    }

    db.prepare(
      `UPDATE payment_attempts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(p.status, attempt.id);

    res.json({
      success: true,
      paid: false,
      reference,
      status: p.status,
      channel: p.channel,
    });
  } catch (e) {
    console.error("VERIFY ERROR:", e.response || e.message);
    res.status(502).json({ error: e.message || "Unable to verify" });
  }
});

/* =========================================================
   WEBHOOK
========================================================= */

app.post("/webhooks/paystack", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) return res.status(401).send("Missing signature");

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest("hex");
    if (!timingSafeEqualHex(signature, expected))
      return res.status(401).send("Invalid signature");

    const event = req.body;
    const eventId = event?.data?.id ? String(event.data.id) : null;
    const eventType = event?.event || "unknown";
    const reference = event?.data?.reference || null;

    try {
      db.prepare(
        `
        INSERT INTO webhook_events (provider, event_id, event_type, reference, payload)
        VALUES ('paystack', ?, ?, ?, ?)
      `,
      ).run(eventId, eventType, reference, JSON.stringify(event));
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return res.sendStatus(200);
      throw err;
    }

    if (eventType === "charge.success") {
      const p = event.data;
      const attempt = db
        .prepare(`SELECT * FROM payment_attempts WHERE reference = ?`)
        .get(p.reference);
      if (attempt) {
        const amountMatches = Number(p.amount) === Number(attempt.amount);
        const currencyMatches =
          String(p.currency).toUpperCase() ===
          String(attempt.currency).toUpperCase();
        if (amountMatches && currencyMatches) {
          creditSuccessfulPayment({
            customerId: attempt.customer_id,
            reference: p.reference,
            providerTransactionId: p.id,
            amount: Number(p.amount),
            currency: p.currency,
            paymentAttemptId: attempt.id,
            paymentMethod:
              p.authorization?.card_type || p.authorization?.brand || "card",
            channel: p.channel,
            gatewayResponse: p.gateway_response,
            metadata: JSON.stringify(p.metadata || {}),
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    res.sendStatus(500);
  }
});

/* =========================================================
   ADMIN API
========================================================= */

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body.password || "");
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid password" });
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  const token = signAdminToken(expiresAt);
  res.setHeader(
    "Set-Cookie",
    `admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`,
  );
  res.json({ success: true });
});

app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", `admin_session=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) =>
  res.json({ authenticated: true }),
);

app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  try {
    const stats = db
      .prepare(
        `
      SELECT
        COUNT(*) AS total_tx,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success_tx,
        SUM(CASE WHEN status='success' THEN amount ELSE 0 END) AS gross_subunit
      FROM transactions WHERE type = 'deposit'
    `,
      )
      .get();

    const byChannel = db
      .prepare(
        `
      SELECT channel, COUNT(*) AS count, SUM(amount) AS total_subunit
      FROM transactions
      WHERE status = 'success' AND type = 'deposit'
      GROUP BY channel
    `,
      )
      .all();

    let paystackBalance = null;
    try {
      const live = await fetchPaystackBalanceSubunit();
      paystackBalance = subunitToMoney(live.subunit);
    } catch (err) {
      console.warn("Admin: paystack balance fetch failed:", err.message);
    }

    res.json({
      success: true,
      currency: CURRENCY,
      total_transactions: Number(stats.total_tx || 0),
      successful_transactions: Number(stats.success_tx || 0),
      gross_received: subunitToMoney(stats.gross_subunit || 0),
      paystack_balance: paystackBalance,
      by_channel: byChannel.map((r) => ({
        channel: r.channel || "unknown",
        count: Number(r.count),
        total: subunitToMoney(r.total_subunit || 0),
      })),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("ADMIN SUMMARY ERROR:", e);
    res.status(500).json({ error: "Unable to load summary" });
  }
});

app.get("/api/admin/transactions", requireAdmin, (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = db
      .prepare(
        `
      SELECT
        t.id, t.reference, t.provider_transaction_id, t.type, t.status,
        t.amount, t.currency, t.description, t.payment_method, t.channel,
        t.gateway_response, t.created_at,
        c.email AS customer_email, c.name AS customer_name, c.phone AS customer_phone
      FROM transactions t
      LEFT JOIN customers c ON c.id = t.customer_id
      ORDER BY t.id DESC
      LIMIT ?
    `,
      )
      .all(limit);

    res.json({
      success: true,
      transactions: rows.map((r) => ({
        ...r,
        amount: subunitToMoney(r.amount),
      })),
    });
  } catch (e) {
    console.error("ADMIN TX ERROR:", e);
    res.status(500).json({ error: "Unable to load transactions" });
  }
});

/* =========================================================
   PUBLIC TRANSACTIONS
========================================================= */

app.get("/api/transactions", (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Valid email required" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const customer = db
      .prepare(`SELECT id FROM customers WHERE email = ?`)
      .get(email);
    if (!customer) return res.json({ transactions: [] });

    const rows = db
      .prepare(
        `
      SELECT id, reference, type, status, amount, currency,
             description, payment_method, channel, created_at
      FROM transactions WHERE customer_id = ?
      ORDER BY id DESC LIMIT ?
    `,
      )
      .all(customer.id, limit);

    res.json({
      transactions: rows.map((r) => ({
        ...r,
        amount: subunitToMoney(r.amount),
      })),
    });
  } catch (e) {
    console.error("TX ERROR:", e);
    res.status(500).json({ error: "Unable to load transactions" });
  }
});

/* =========================================================
   CLEAN ROUTES — no .html extension
========================================================= */

app.get("/payment/callback", (req, res) => {
  const reference = cleanString(req.query.reference, 100);
  res.redirect(`/pay?reference=${encodeURIComponent(reference)}`);
});

app.get("/", (req, res) => sendHtml(res, "index.html"));
app.get("/pay", (req, res) => sendHtml(res, "pay.html"));
app.get("/admin", (req, res) => sendHtml(res, "admin.html"));

// Legacy .html requests → redirect to clean URL
app.get("/index.html", (req, res) => res.redirect(301, "/"));
app.get("/pay.html", (req, res) => res.redirect(301, "/pay"));
app.get("/admin.html", (req, res) => res.redirect(301, "/admin"));

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "dalla-community-hub",
    currency: CURRENCY,
    environment: PAYSTACK_SECRET_KEY.startsWith("sk_live_") ? "live" : "test",
    time: new Date().toISOString(),
  });
});

/* =========================================================
   SERVER
========================================================= */

app.listen(PORT, () => {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(" Dalla Community Hub");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Local:    http://localhost:${PORT}`);
  console.log(`Public:   ${APP_URL}`);
  console.log(`Pay page: ${APP_URL}/pay`);
  console.log(`Admin:    ${APP_URL}/admin`);
  console.log(`Currency: ${CURRENCY}`);
  console.log(
    `Env:      ${PAYSTACK_SECRET_KEY.startsWith("sk_live_") ? "LIVE" : "TEST"}`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
