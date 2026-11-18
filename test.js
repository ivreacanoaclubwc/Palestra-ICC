"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "palestra-"));
process.env.ADMIN_PASSWORD = "segreta";
const { server } = require("./server.js");

function client(base) {
  const jar = {};
  async function call(p, body) {
    const opt = { headers: { cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ") } };
    if (body !== undefined) { opt.method = "POST"; opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    const r = await fetch(base + p, { ...opt, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); const v = decodeURIComponent(kv.slice(i + 1)); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = v; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j, headers: r.headers };
  }
  return { call, jar };
}
const addDays = (d, n) => { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, dd + n)); return t.toISOString().slice(0, 10); };

server.listen(0, async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  let ok = 0; const t = (name, cond) => { assert.ok(cond, name); ok++; console.log("ok -", name); };
  try {
    const admin = client(base), anna = client(base), bruno = client(base), carla = client(base);
    let st = (await anna.call("/api/state")).body;
    const tomorrow = addDays(st.now.date, 1), dayAfter = addDays(st.now.date, 2);
    t("stato iniziale: capienza 8, 2 ore (4 slot), 7 giorni di anticipo, non registrato", st.settings.capacity === 8 && st.settings.maxSlotsPerDay === 4 && st.settings.daysAhead === 7 && st.me === null);
    t("si vedono 7 giorni (oggi + 6)", Object.keys(st.counts).length === 7);

    t("prenotare senza registrazione è rifiutato", (await anna.call("/api/book", { date: tomorrow, slots: ["10:00"] })).status === 401);
    t("nome troppo corto rifiutato", (await anna.call("/api/enter", { name: "A", pin: "1234", create: true })).status === 400);
    t("registrazione ok", (await anna.call("/api/enter", { name: "Anna Rossi", pin: "1234", create: true })).status === 200);
    await bruno.call("/api/enter", { name: "Bruno Verdi", pin: "1234", create: true });
    await carla.call("/api/enter", { name: "Carla Neri", pin: "1234", create: true });
    st = (await anna.call("/api/state")).body;
    t("il profilo viene ricordato (cookie)", st.me && st.me.name === "Anna Rossi");

    const phone2 = client(base), intruder = client(base);
    t("senza create, un nome nuovo non crea nulla", (await intruder.call("/api/enter", { name: "Mario Nuovo", pin: "1111" })).body.status === "new"
      && (await intruder.call("/api/state")).body.me === null);
    t("chi scrive il nome di Anna con PIN sbagliato non entra", (await intruder.call("/api/enter", { name: "Anna Rossi", pin: "9999", create: true })).status === 401
      && (await intruder.call("/api/state")).body.me === null);
    t("PIN non numerico o di lunghezza sbagliata rifiutato", (await intruder.call("/api/enter", { name: "Anna Rossi", pin: "12a4" })).status === 400
      && (await intruder.call("/api/enter", { name: "Anna Rossi", pin: "123" })).status === 400);
    t("Anna entra da un altro dispositivo con nome e PIN", (await phone2.call("/api/enter", { name: "anna  ROSSI", pin: "1234" })).status === 200
      && (await phone2.call("/api/state")).body.me.name === "Anna Rossi");

    t("prenotazione singola", (await anna.call("/api/book", { date: tomorrow, slots: ["10:00"] })).status === 200);
    t("stesso slot due volte rifiutato", (await anna.call("/api/book", { date: tomorrow, slots: ["10:00"] })).status === 409);
    t("slot non da 30 minuti rifiutato", (await anna.call("/api/book", { date: tomorrow, slots: ["10:15"] })).status === 400);
    t("fuori orario rifiutato", (await anna.call("/api/book", { date: tomorrow, slots: ["23:00"] })).status === 400);

    t("max 4 slot (2 ore) al giorno", (await anna.call("/api/book", { date: tomorrow, slots: ["10:30", "11:00", "11:30"] })).status === 200
      && (await anna.call("/api/book", { date: tomorrow, slots: ["12:00"] })).status === 409);

    // accompagnatori
    let res = await bruno.call("/api/book", { date: tomorrow, slots: ["15:00"], companions: ["Dario Blu", "Elena Gialli"] });
    t("prenota per sé + 2 persone", res.status === 200);
    st = (await bruno.call("/api/state")).body;
    t("3 posti occupati, 3 voci in 'mine'", st.counts[tomorrow]["15:00"] === 3 && st.mine.filter(b => b.slot === "15:00").length === 3);
    const seen = (await carla.call("/api/state")).body.who[tomorrow]["15:00"];
    t("tutti vedono chi ha prenotato, con x3 per chi ha prenotato in tre", seen.length === 1 && seen[0].name === "Bruno Verdi" && seen[0].n === 3);
    const seen10 = (await carla.call("/api/state")).body.who[tomorrow]["10:00"];
    t("chi prenota da solo compare con n=1", seen10.length === 1 && seen10[0].name === "Anna Rossi" && seen10[0].n === 1);
    res = await bruno.call("/api/book", { date: tomorrow, slots: ["16:00"], companions: ["A", "B", "C"] });
    t("più di 2 accompagnatori rifiutato", res.status === 400);
    res = await bruno.call("/api/book", { date: tomorrow, slots: ["16:00"], companions: ["bruno verdi"] });
    t("nome duplicato (anche con maiuscole) rifiutato", res.status === 400);
    res = await carla.call("/api/book", { date: tomorrow, slots: ["17:00", "17:30", "18:00", "18:30"], companions: ["Dario Blu"] });
    t("Dario ha già 1 slot: altri 4 sforano il suo limite di 2 ore, anche se prenota Carla", res.status === 409 && /Dario Blu/.test(res.body.error));
    t("nulla è stato prenotato da quella richiesta fallita", (await carla.call("/api/state")).body.mine.length === 0);
    res = await carla.call("/api/book", { date: tomorrow, slots: ["15:00"], companions: ["dario blu"] });
    t("stessa persona (nome uguale) già presente nello slot rifiutata", res.status === 409);

    // capienza
    const fill = client(base); await fill.call("/api/enter", { name: "Fabio Riempi", pin: "1234", create: true });
    await fill.call("/api/book", { date: dayAfter, slots: ["09:00"], companions: ["P1 Test", "P2 Test"] });
    const f2 = client(base); await f2.call("/api/enter", { name: "Gina Due", pin: "1234", create: true });
    await f2.call("/api/book", { date: dayAfter, slots: ["09:00"], companions: ["P3 Test", "P4 Test"] });
    const f3 = client(base); await f3.call("/api/enter", { name: "Ilaria Tre", pin: "1234", create: true });
    await f3.call("/api/book", { date: dayAfter, slots: ["09:00"] });
    t("si può prenotare fino a oggi+6 giorni", (await f3.call("/api/book", { date: addDays(st.now.date, 6), slots: ["10:00"] })).status === 200);
    t("oltre una settimana di anticipo no", (await f3.call("/api/book", { date: addDays(st.now.date, 7), slots: ["10:00"] })).status === 400);
    st = (await f3.call("/api/state")).body;
    t("lo slot arriva a 7 su 8", st.counts[dayAfter]["09:00"] === 7);
    res = await carla.call("/api/book", { date: dayAfter, slots: ["09:00"], companions: ["Q1 Test", "Q2 Test"] });
    t("3 persone con 1 solo posto libero: rifiutato per intero", res.status === 409 && /1 posto/.test(res.body.error));
    t("1 persona entra e lo slot è pieno", (await carla.call("/api/book", { date: dayAfter, slots: ["09:00"] })).status === 200);
    t("il nono viene respinto", (await bruno.call("/api/book", { date: dayAfter, slots: ["09:00"] })).status === 409);

    // limiti di data
    t("giorno nel passato rifiutato", (await bruno.call("/api/book", { date: addDays(st.now.date, -1), slots: ["10:00"] })).status === 400);
    t("giorno oltre i giorni prenotabili rifiutato", (await bruno.call("/api/book", { date: addDays(st.now.date, 30), slots: ["10:00"] })).status === 400);

    // annullamento: solo le proprie
    const mineB = (await bruno.call("/api/state")).body.mine.map(b => b.id);
    await carla.call("/api/cancel", { ids: mineB });
    t("non si cancellano prenotazioni altrui", (await bruno.call("/api/state")).body.mine.length === mineB.length);
    await bruno.call("/api/cancel", { ids: mineB });
    t("si cancellano le proprie (anche quelle fatte per altri)", (await bruno.call("/api/state")).body.mine.length === 0);

    // lo stesso nome su un altro dispositivo può annullare
    const annaPhone2 = (await phone2.call("/api/state")).body.mine;
    t("dall'altro dispositivo Anna vede le sue prenotazioni", annaPhone2.length === 4);
    await phone2.call("/api/cancel", { ids: [annaPhone2[0].id] });
    t("e può annullarle", (await anna.call("/api/state")).body.mine.length === 3);
    await anna.call("/api/rename", { name: "Anna Bianchi" });
    t("cambiando nome le prenotazioni restano e i nomi si aggiornano", (await anna.call("/api/state")).body.mine.length === 3
      && Object.values((await anna.call("/api/state")).body.who[tomorrow]).some(l => l.some(g => g.name === "Anna Bianchi")));
    await anna.call("/api/rename", { name: "Anna Rossi" });

    // admin
    t("azioni admin senza login rifiutate", (await anna.call("/api/admin/settings", { capacity: 20 })).status === 403);
    t("password errata rifiutata", (await admin.call("/api/admin/login", { password: "no" })).status === 401);
    t("login admin ok", (await admin.call("/api/admin/login", { password: "segreta" })).status === 200);
    t("l'admin cambia la capienza a 10 e il limite a 3 ore", (await admin.call("/api/admin/settings", { capacity: 10, maxSlotsPerDay: 6, open: "08:00", close: "22:00", daysAhead: 14 })).status === 200);
    t("con capienza 10 si può prenotare nello slot che era pieno", (await bruno.call("/api/book", { date: dayAfter, slots: ["09:00"] })).status === 200);
    t("impostazioni non valide rifiutate", (await admin.call("/api/admin/settings", { capacity: 0, maxSlotsPerDay: 4, open: "08:00", close: "22:00", daysAhead: 14 })).status === 400);
    t("chiusura prima dell'apertura rifiutata", (await admin.call("/api/admin/settings", { capacity: 8, maxSlotsPerDay: 4, open: "20:00", close: "10:00", daysAhead: 14 })).status === 400);
    await admin.call("/api/admin/settings", { capacity: 8, maxSlotsPerDay: 4, open: "08:00", close: "22:00", daysAhead: 14 });

    const wd = new Date(tomorrow + "T00:00:00Z").getUTCDay();
    t("blocco fisso settimanale creato", (await admin.call("/api/admin/block", { label: "Corso agonisti", days: [wd], date: "", start: "18:00", end: "19:30" })).status === 200);
    res = await carla.call("/api/book", { date: tomorrow, slots: ["18:30"] });
    t("slot bloccato non prenotabile", res.status === 409);
    res = await carla.call("/api/book", { date: addDays(tomorrow, 7) > addDays(st.now.date, 13) ? tomorrow : addDays(tomorrow, 7), slots: ["18:00"] });
    t("il blocco vale anche nelle settimane successive", res.status === 409);
    t("fuori dal blocco si prenota (19:30)", (await carla.call("/api/book", { date: tomorrow, slots: ["19:30"] })).status === 200);
    const bl = (await admin.call("/api/state")).body.blocks;
    t("blocco modificabile (nuovo orario)", (await admin.call("/api/admin/block", { id: bl[0].id, label: "Corso", days: [wd], date: "", start: "18:00", end: "18:30" })).status === 200
      && (await carla.call("/api/book", { date: tomorrow, slots: ["18:30"] })).status === 200);
    t("blocco eliminabile", (await admin.call("/api/admin/block-delete", { id: bl[0].id })).status === 200 && (await admin.call("/api/state")).body.blocks.length === 0);

    const adminState = (await admin.call("/api/state")).body;
    t("l'admin vede tutte le prenotazioni, gli ospiti no", Array.isArray(adminState.all) && adminState.all.length > 0 && (await anna.call("/api/state")).body.all === undefined);
    const other = adminState.all.find(b => b.name === "Anna Rossi");
    await admin.call("/api/cancel", { ids: [other.id] });
    t("l'admin rimuove prenotazioni altrui", !(await admin.call("/api/state")).body.all.some(b => b.id === other.id));
    t("l'admin non ha il limite di ore", (await admin.call("/api/enter", { name: "Gestore", pin: "1234", create: true })).status === 200
      && (await admin.call("/api/book", { date: dayAfter, slots: ["12:00", "12:30", "13:00", "13:30", "14:00", "14:30"] })).status === 200);

    t("richiesta non JSON rifiutata (anti-CSRF)", (await fetch(base + "/api/book", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status === 400);
    t("la pagina si carica", (await fetch(base + "/")).status === 200);
    t("path traversal bloccato", (await fetch(base + "/..%2fserver.js")).status === 404);

    // intruso: non può annullare né vedere come proprie le prenotazioni di altri
    const annaIds = (await anna.call("/api/state")).body.mine.map(b => b.id);
    t("l'intruso non può annullare le prenotazioni di Anna", (await intruder.call("/api/cancel", { ids: annaIds })).status === 200
      && (await anna.call("/api/state")).body.mine.length === annaIds.length);

    // blocco dopo 5 PIN sbagliati + azzeramento da parte del gestore
    const lucia = client(base);
    await lucia.call("/api/enter", { name: "Lucia Prova", pin: "4321", create: true });
    const attacker = client(base);
    let last;
    for (let i = 0; i < 5; i++) last = await attacker.call("/api/enter", { name: "Lucia Prova", pin: "000" + i });
    t("5 PIN sbagliati bloccano l'account", (await attacker.call("/api/enter", { name: "Lucia Prova", pin: "4321" })).status === 429);
    const members = (await admin.call("/api/state")).body.members;
    t("solo il gestore vede l'elenco iscritti", members.some(m => m.name === "Lucia Prova") && (await anna.call("/api/state")).body.members === undefined);
    const luciaKey = members.find(m => m.name === "Lucia Prova").key;
    t("un ospite non può cambiare il PIN altrui", (await anna.call("/api/admin/set-pin", { key: luciaKey, pin: "5555" })).status === 403);
    t("il gestore azzera il PIN", (await admin.call("/api/admin/set-pin", { key: luciaKey, pin: "5555" })).status === 200);
    t("il vecchio dispositivo di Lucia è uscito", (await lucia.call("/api/state")).body.me === null);
    t("col nuovo PIN Lucia rientra", (await lucia.call("/api/enter", { name: "Lucia Prova", pin: "5555" })).status === 200);
    t("l'uscita cancella la sessione", (await lucia.call("/api/logout", {})).status === 200 && (await lucia.call("/api/state")).body.me === null);

    // cambio nome
    t("non si può prendere il nome di un altro iscritto", (await anna.call("/api/rename", { name: "Bruno Verdi" })).status === 409);

    // storico, report ed Excel
    const report = require("./report.js");
    const D = "2026-03-10", now = { date: "2026-03-11", min: 9 * 60 };
    const H = {};
    let n = 0; const add = (date, slot, name, by, x) => { H["h" + n++] = { date, slot, name, by, x }; };
    ["10:00", "10:30", "11:00"].forEach(sl => add(D, sl, "Anna Rossi", "Anna Rossi"));
    add(D, "14:00", "Anna Rossi", "Anna Rossi");
    ["10:00", "10:30"].forEach(sl => add(D, sl, "Bruno Verdi", "Anna Rossi"));
    add(D, "16:00", "Carla Neri", "Carla Neri", Date.now());       // annullata
    add("2026-03-12", "10:00", "Anna Rossi", "Anna Rossi");         // futura
    const turni = report.turni(H, now);
    t("slot consecutivi = un solo ingresso; annullate escluse", turni.length === 4 && turni.filter(x => x.done).length === 3);
    const stt = report.stats(turni, now);
    t("statistiche: 3 ingressi, 3 ore, 2 persone (la prenotazione futura non conta)", stt.ingressi === 3 && stt.ore === 3 && stt.persone === 2);
    const sh = report.sheets(H, now), byName = Object.fromEntries(sh.map(x => [x.name, x]));
    const rAnna = byName["Per persona"].rows.find(r => r[0] === "Anna Rossi"), rBruno = byName["Per persona"].rows.find(r => r[0] === "Bruno Verdi");
    t("Anna: 2 ingressi, 2 ore. Bruno (prenotato da Anna): 1 ingresso, 1 ora", rAnna[1] === 2 && rAnna[2] === 2 && rBruno[1] === 1 && rBruno[2] === 1);
    t("picco contemporanei del giorno = 2", byName["Per giorno"].rows[0][5] === 2);
    t("foglio Turni elenca anche quelli in programma", byName["Turni"].rows.some(r => r[7] === "In programma") && byName["Turni"].rows.length === 4);

    t("l'export Excel è riservato ai gestori", (await anna.call("/api/admin/export.xlsx")).status === 403);
    const xr = await fetch(base + "/api/admin/export.xlsx", { headers: { cookie: Object.entries(admin.jar).map(([k, v]) => k + "=" + v).join("; ") } });
    const xb = Buffer.from(await xr.arrayBuffer());
    t("l'export Excel per il gestore è un file .xlsx valido (zip con 10 parti)", xr.status === 200 && /spreadsheetml/.test(xr.headers.get("content-type")) && xb.slice(0, 2).toString() === "PK" && xb.readUInt16LE(xb.length - 22 + 10) === 10);
    fs.writeFileSync(path.join(process.env.DATA_DIR, "export-test.xlsx"), xb);
    const adminSt = (await admin.call("/api/state")).body;
    t("lo stato admin include le statistiche, quello degli ospiti no", adminSt.stats && typeof adminSt.stats.ingressi === "number" && (await anna.call("/api/state")).body.stats === undefined);

    // persistenza
    const dbf = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "db.json"), "utf8"));
    t("lo storico conserva le prenotazioni annullate marcandole", Object.values(dbf.history).some(h => h.x) && Object.keys(dbf.history).length > dbf.bookings.length);
    t("i dati sono salvati su disco", Object.keys(dbf.accounts).length >= 5 && !JSON.stringify(dbf).includes("\"pin\"") && dbf.bookings.length > 0);
    console.log(`\n${ok} controlli superati`);
    server.close(); process.exit(0);
  } catch (e) { console.error("FALLITO:", e.message); server.close(); process.exit(1); }
});
