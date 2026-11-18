"use strict";
/*
 * Palestra sociale Ivrea Canoa Club - prenotazioni online.
 * Nessuna dipendenza: serve solo Node 18 o superiore.
 *
 * Variabili d'ambiente:
 *   PORT            porta HTTP (default 3000)
 *   ADMIN_PASSWORD  password degli admin (obbligatoria per usare la gestione)
 *   DATA_DIR        cartella dove salvare db.json (default ./data)
 *   TRUST_PROXY     "1" se l'app sta dietro a un proxy (Render, Railway, Fly...)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const report = require("./report.js");
const { buildXlsx } = require("./xlsx.js");

const PORT = +process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const TZ = "Europe/Rome";
const MAX_COMPANIONS = 2;

/* ---------------- archivio (file JSON, scritto in modo atomico) ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");
const DEFAULT_SETTINGS = { capacity: 8, maxSlotsPerDay: 4, open: "08:00", close: "22:00", daysAhead: 7 };
let db = { settings: { ...DEFAULT_SETTINGS }, blocks: [], accounts: {}, sessions: {}, bookings: [], history: {}, adminSessions: {} };
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  db = { ...db, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
} catch (e) { /* primo avvio */ }

// Storico permanente: ogni prenotazione resta registrata anche dopo la pulizia; se annullata viene solo marcata (x).
for (const b of db.bookings) if (!db.history[b.id])
  db.history[b.id] = { date: b.date, slot: b.slot, name: b.name, by: b.bookerName, byKey: b.bookerKey, created: b.created };

function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------- tempo (sempre ora di Roma) ---------------- */
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function romeNow() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const pad = n => (n < 10 ? "0" + n : "" + n);
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const fromMin = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function dow(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = s => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) || s === "24:00";

/* ---------------- regole ---------------- */
function cleanName(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}
const keyName = n => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function validSlot(slot) {
  if (typeof slot !== "string" || !/^\d{2}:\d{2}$/.test(slot)) return false;
  const m = toMin(slot), s = db.settings;
  return m % 30 === 0 && m >= toMin(s.open) && m + 30 <= toMin(s.close);
}
function blockFor(date, slot) {
  const wd = dow(date);
  for (const b of db.blocks) {
    const applies = b.date ? b.date === date : (b.days || []).includes(wd);
    if (applies && slot >= b.start && slot < b.end) return b;
  }
  return null;
}
function entriesAt(date, slot) { return db.bookings.filter(b => b.date === date && b.slot === slot); }
function dayEntriesFor(date, nameKey) {
  return db.bookings.filter(b => b.date === date && keyName(b.name) === nameKey).length;
}

/* ---------------- utilita' HTTP ---------------- */
function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function fail(res, code, message) { send(res, code, { error: message }); }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(c => {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function cookie(req, name, value, maxAgeSec) {
  const secure = (req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return reject(new Error("tipo"));
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > 20000) { reject(new Error("grande")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
const hits = new Map();
function limited(req, bucket, max, windowMs) {
  const ip = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const key = bucket + "|" + ip, now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

function currentUser(req) {
  const t = parseCookies(req).icc_user;
  if (!t || !db.sessions[t]) return null;
  const acc = db.accounts[db.sessions[t]];
  return acc ? { token: t, key: db.sessions[t], ...acc } : null;
}
function isAdmin(req) {
  const t = parseCookies(req).icc_admin;
  return !!(t && db.adminSessions[t] && db.adminSessions[t] > Date.now());
}

/* ---------------- stato per il client ---------------- */
function buildState(req) {
  const now = romeNow(), s = db.settings, user = currentUser(req), admin = isAdmin(req);
  const counts = {}, who = {};
  for (let i = 0; i < s.daysAhead; i++) { const d = addDays(now.date, i); counts[d] = {}; who[d] = {}; }
  for (const b of db.bookings) {
    if (!counts[b.date]) continue;
    counts[b.date][b.slot] = (counts[b.date][b.slot] || 0) + 1;
    const list = who[b.date][b.slot] = who[b.date][b.slot] || [];
    const g = list.find(x => x.k === b.bookerKey);
    if (g) g.n++; else list.push({ k: b.bookerKey, name: b.bookerName, n: 1 });
  }
  for (const d in who) for (const sl in who[d]) who[d][sl] = who[d][sl].map(({ name, n }) => ({ name, n }));
  const state = {
    now, settings: s, blocks: db.blocks, counts, who, isAdmin: admin,
    maxCompanions: MAX_COMPANIONS,
    me: user ? { id: user.id, name: user.name } : null,
    members: admin ? Object.entries(db.accounts).map(([key, a]) => ({ key, name: a.name })).sort((a, b) => a.name.localeCompare(b.name, "it")) : undefined,
    mine: user ? db.bookings.filter(b => b.bookerKey === keyName(user.name) && b.date >= now.date)
      .map(b => ({ id: b.id, date: b.date, slot: b.slot, name: b.name })) : [],
  };
  if (admin) state.stats = report.stats(report.turni(db.history, now), now);
  if (admin) state.all = db.bookings.filter(b => b.date >= now.date).map(b => ({ id: b.id, date: b.date, slot: b.slot, name: b.name }));
  return state;
}

/* ---------------- azioni ---------------- */
/* PIN: 4 cifre, salvato solo come hash. Dopo 5 errori l'account si blocca per 15 minuti. */
const PIN_RE = /^\d{4}$/;
const fails = new Map();
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString("hex"); }
function newCreds(pin) { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: hashPin(pin, salt) }; }
function pinOk(acc, pin) {
  const a = Buffer.from(hashPin(pin, acc.salt), "hex"), b = Buffer.from(acc.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function startSession(req, res, key, extra) {
  const token = crypto.randomBytes(24).toString("base64url");
  db.sessions[token] = key;
  save();
  send(res, 200, { ok: true, ...extra }, { "Set-Cookie": cookie(req, "icc_user", token, 3 * 365 * 86400) });
}

function enter(req, res, body) {
  if (limited(req, "enter", 60, 15 * 60000)) return fail(res, 429, "Troppi tentativi. Riprova tra qualche minuto.");
  const name = cleanName(body.name), pin = String(body.pin == null ? "" : body.pin);
  if (name.length < 2) return fail(res, 400, "Scrivi nome e cognome (almeno 2 caratteri).");
  if (!PIN_RE.test(pin)) return fail(res, 400, "Il PIN è di 4 cifre.");
  const key = keyName(name), acc = db.accounts[key];
  if (!acc) {
    if (!body.create) return send(res, 200, { status: "new" });
    if (limited(req, "newacc", 15, 3600000)) return fail(res, 429, "Troppi nuovi profili da questo dispositivo. Riprova più tardi.");
    db.accounts[key] = { id: "u" + crypto.randomBytes(6).toString("hex"), name, created: Date.now(), ...newCreds(pin) };
    return startSession(req, res, key, { status: "created" });
  }
  const f = fails.get(key) || { n: 0, until: 0 };
  if (f.until > Date.now()) return fail(res, 429, "Troppi PIN sbagliati. Riprova tra 15 minuti o chiedi a un gestore di azzerare il PIN.");
  if (!pinOk(acc, pin)) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60000; }
    fails.set(key, f);
    return fail(res, 401, "PIN sbagliato.");
  }
  fails.delete(key);
  startSession(req, res, key, { status: "in" });
}

function logout(req, res) {
  const t = parseCookies(req).icc_user;
  if (t && db.sessions[t]) { delete db.sessions[t]; save(); }
  send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "icc_user", "", 0) });
}

function rename(req, res, body) {
  const user = currentUser(req);
  if (!user) return fail(res, 401, "Entra prima.");
  const name = cleanName(body.name);
  if (name.length < 2) return fail(res, 400, "Scrivi nome e cognome (almeno 2 caratteri).");
  const oldKey = user.key, newKey = keyName(name);
  if (newKey !== oldKey && db.accounts[newKey]) return fail(res, 409, "Questo nome è già usato da un altro iscritto.");
  for (const b of db.bookings) if (b.bookerKey === oldKey) {
    if (keyName(b.name) === oldKey) b.name = name;
    b.bookerName = name; b.bookerKey = newKey;
  }
  for (const h of Object.values(db.history)) if (h.byKey === oldKey) {
    if (keyName(h.name) === oldKey) h.name = name;
    h.by = name; h.byKey = newKey;
  }
  const acc = db.accounts[oldKey];
  delete db.accounts[oldKey];
  db.accounts[newKey] = { ...acc, name };
  for (const t in db.sessions) if (db.sessions[t] === oldKey) db.sessions[t] = newKey;
  save();
  send(res, 200, { ok: true });
}

function book(req, res, body) {
  const user = currentUser(req);
  if (!user) return fail(res, 401, "Registrati prima di prenotare.");
  const admin = isAdmin(req), s = db.settings, now = romeNow();
  const { date } = body;
  const slots = Array.isArray(body.slots) ? [...new Set(body.slots)] : [];
  const companionsIn = Array.isArray(body.companions) ? body.companions : [];
  if (!isDate(date) || !slots.length || slots.length > 48) return fail(res, 400, "Richiesta non valida.");
  if (date < now.date || date > addDays(now.date, s.daysAhead - 1)) return fail(res, 400, "Questo giorno non è prenotabile.");

  const companions = companionsIn.map(cleanName).filter(Boolean);
  if (companions.length > MAX_COMPANIONS) return fail(res, 400, `Puoi aggiungere al massimo ${MAX_COMPANIONS} persone.`);
  const people = [user.name, ...companions];
  const keys = people.map(keyName);
  if (new Set(keys).size !== keys.length) return fail(res, 400, "I nomi devono essere diversi tra loro.");

  for (const slot of slots) {
    if (!validSlot(slot)) return fail(res, 400, "Orario non valido.");
    if (date === now.date && toMin(slot) + 30 <= now.min) return fail(res, 400, `Lo slot delle ${slot} è già passato.`);
    if (blockFor(date, slot)) return fail(res, 409, `Lo slot delle ${slot} è riservato.`);
    const here = entriesAt(date, slot);
    if (here.length + people.length > s.capacity) {
      const free = Math.max(0, s.capacity - here.length);
      return fail(res, 409, free === 0 ? `Lo slot delle ${slot} è pieno.` : `Alle ${slot} ${free === 1 ? "è rimasto 1 posto" : "sono rimasti " + free + " posti"}, ma state prenotando in ${people.length}.`);
    }
    for (const k of keys) if (here.some(b => keyName(b.name) === k)) return fail(res, 409, `Alle ${slot} c'è già una prenotazione a nome ${people[keys.indexOf(k)]}.`);
  }
  if (!admin) {
    for (let i = 0; i < people.length; i++) {
      if (dayEntriesFor(date, keys[i]) + slots.length > s.maxSlotsPerDay) {
        const h = s.maxSlotsPerDay / 2;
        return fail(res, 409, `${people[i]} supererebbe il massimo di ${h} or${h === 1 ? "a" : "e"} al giorno.`);
      }
    }
  }
  for (const slot of slots) for (const name of people)
  {
    const id = "b" + crypto.randomBytes(6).toString("hex");
    db.bookings.push({ id, date, slot, name, bookerId: user.id, bookerName: user.name, bookerKey: keyName(user.name), created: Date.now() });
    db.history[id] = { date, slot, name, by: user.name, byKey: keyName(user.name), created: Date.now() };
  }
  save();
  send(res, 200, { ok: true });
}

function cancel(req, res, body) {
  const user = currentUser(req), admin = isAdmin(req);
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === "string").slice(0, 200) : [];
  if (!ids.length) return fail(res, 400, "Richiesta non valida.");
  const allowed = b => ids.includes(b.id) && (admin || (user && b.bookerKey === keyName(user.name)));
  const removed = db.bookings.filter(allowed);
  if (removed.length) {
    for (const b of removed) if (db.history[b.id]) db.history[b.id].x = Date.now();
    db.bookings = db.bookings.filter(b => !allowed(b));
    save();
  }
  send(res, 200, { ok: true });
}

function adminLogin(req, res, body) {
  if (!ADMIN_PASSWORD) return fail(res, 503, "La gestione non è attiva: manca ADMIN_PASSWORD sul server.");
  if (limited(req, "adm", 10, 15 * 60000)) return fail(res, 429, "Troppi tentativi. Riprova tra qualche minuto.");
  const a = crypto.createHash("sha256").update(String(body.password || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return fail(res, 401, "Password errata.");
  const t = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  for (const k of Object.keys(db.adminSessions)) if (db.adminSessions[k] < now) delete db.adminSessions[k];
  db.adminSessions[t] = now + 30 * 86400000;
  save();
  send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "icc_admin", t, 30 * 86400) });
}
function adminLogout(req, res) {
  const t = parseCookies(req).icc_admin;
  if (t && db.adminSessions[t]) { delete db.adminSessions[t]; save(); }
  send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "icc_admin", "", 0) });
}
function adminSettings(req, res, body) {
  const cap = Math.round(+body.capacity), slots = Math.round(+body.maxSlotsPerDay), ahead = Math.round(+body.daysAhead);
  if (!(cap >= 1 && cap <= 200) || !(slots >= 1 && slots <= 48) || !(ahead >= 1 && ahead <= 60)) return fail(res, 400, "Valori non validi.");
  if (!isTime(body.open) || !isTime(body.close) || toMin(body.close) <= toMin(body.open)) return fail(res, 400, "La chiusura deve essere dopo l'apertura.");
  db.settings = { capacity: cap, maxSlotsPerDay: slots, open: body.open, close: body.close, daysAhead: ahead };
  save();
  send(res, 200, { ok: true });
}
function adminBlock(req, res, body) {
  const days = Array.isArray(body.days) ? [...new Set(body.days.map(Number).filter(n => n >= 0 && n <= 6))] : [];
  const date = body.date || "";
  if (date && !isDate(date)) return fail(res, 400, "Data non valida.");
  if (!date && !days.length) return fail(res, 400, "Scegli almeno un giorno o una data.");
  if (!isTime(body.start) || !isTime(body.end) || body.end <= body.start) return fail(res, 400, "L'orario finale deve essere dopo quello iniziale.");
  const block = { id: typeof body.id === "string" && /^b[a-z0-9]{4,20}$/.test(body.id) ? body.id : "b" + crypto.randomBytes(5).toString("hex"),
    label: cleanName(body.label) || "Riservato", days: date ? [] : days, date, start: body.start, end: body.end };
  const i = db.blocks.findIndex(b => b.id === block.id);
  if (i >= 0) db.blocks[i] = block; else db.blocks.push(block);
  save();
  send(res, 200, { ok: true });
}
function adminBlockDelete(req, res, body) {
  db.blocks = db.blocks.filter(b => b.id !== body.id);
  save();
  send(res, 200, { ok: true });
}

function adminSetPin(req, res, body) {
  const acc = db.accounts[body.key];
  if (!acc) return fail(res, 404, "Iscritto non trovato.");
  const pin = String(body.pin == null ? "" : body.pin);
  if (!PIN_RE.test(pin)) return fail(res, 400, "Il PIN è di 4 cifre.");
  db.accounts[body.key] = { ...acc, ...newCreds(pin) };
  for (const t in db.sessions) if (db.sessions[t] === body.key) delete db.sessions[t]; // esce da tutti i dispositivi
  fails.delete(body.key);
  save();
  send(res, 200, { ok: true });
}

const POST = {
  "/api/enter": enter, "/api/logout": logout, "/api/rename": rename, "/api/book": book, "/api/cancel": cancel,
  "/api/admin/login": adminLogin, "/api/admin/logout": adminLogout,
  "/api/admin/settings": adminSettings, "/api/admin/block": adminBlock, "/api/admin/block-delete": adminBlockDelete, "/api/admin/set-pin": adminSetPin,
};
const ADMIN_ONLY = new Set(["/api/admin/settings", "/api/admin/block", "/api/admin/block-delete", "/api/admin/set-pin"]);

/* ---------------- server ---------------- */
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, buildState(req));
    if (req.method === "GET" && url.pathname === "/api/admin/export.xlsx") {
      if (!isAdmin(req)) return fail(res, 403, "Serve l'accesso admin.");
      const now = romeNow(), buf = buildXlsx(report.sheets(db.history, now));
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="palestra-ivrea-${now.date}.xlsx"`,
        "Cache-Control": "no-store", "Content-Length": buf.length,
      });
      return res.end(buf);
    }
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok");
    if (req.method === "POST" && POST[url.pathname]) {
      if (ADMIN_ONLY.has(url.pathname) && !isAdmin(req)) return fail(res, 403, "Serve l'accesso admin.");
      let body;
      try { body = await readJson(req); } catch (e) { return fail(res, 400, "Richiesta non valida."); }
      return POST[url.pathname](req, res, body);
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.join(PUBLIC, rel);
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const buf = fs.readFileSync(file);
        return res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" }), res.end(buf);
      }
    }
    send(res, 404, "Non trovato");
  } catch (e) {
    console.error(e);
    fail(res, 500, "Errore del server.");
  }
});

// pulizia delle prenotazioni vecchie di oltre 14 giorni
function cleanup() {
  const cut = addDays(romeNow().date, -14), before = db.bookings.length;
  db.bookings = db.bookings.filter(b => b.date >= cut);
  if (db.bookings.length !== before) save();
}
cleanup(); setInterval(cleanup, 6 * 3600000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Palestra Ivrea Canoa in ascolto sulla porta ${PORT}`);
    if (!ADMIN_PASSWORD) console.warn("ATTENZIONE: ADMIN_PASSWORD non impostata, la gestione è disattivata.");
  });
}
module.exports = { server, db: () => db };
