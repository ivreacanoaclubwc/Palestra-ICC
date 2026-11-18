"use strict";
/* Statistiche dallo storico delle prenotazioni.
 * Ingresso = un turno di una persona in un giorno (slot consecutivi = un solo ingresso).
 * Le persone prenotate da altri contano come presenze a loro nome. Le prenotazioni annullate non contano. */
const keyName = n => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const pad = n => (n < 10 ? "0" + n : "" + n);
const fromMin = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const dow = d => { const [y, m, dd] = d.split("-").map(Number); return GIORNI[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]; };
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** history: { id: { date, slot, name, by, x? } }  now: { date: "YYYY-MM-DD", min } */
function turni(history, now) {
  const groups = new Map();
  for (const h of Object.values(history)) {
    if (h.x) continue; // annullata
    const k = h.date + "|" + keyName(h.name);
    if (!groups.has(k)) groups.set(k, { date: h.date, name: h.name, items: [] });
    groups.get(k).items.push(h);
  }
  const out = [];
  for (const g of groups.values()) {
    g.items.sort((a, b) => (a.slot < b.slot ? -1 : 1));
    let cur = null;
    for (const h of g.items) {
      if (cur && toMin(h.slot) === toMin(cur.slots[cur.slots.length - 1]) + 30) cur.slots.push(h.slot);
      else { cur = { date: g.date, name: g.name, slots: [h.slot], by: new Set() }; out.push(cur); }
      cur.by.add(h.by);
    }
  }
  return out.map(t => {
    const end = fromMin(toMin(t.slots[t.slots.length - 1]) + 30);
    const done = t.date < now.date || (t.date === now.date && toMin(end) <= now.min);
    return { date: t.date, name: t.name, start: t.slots[0], end, slots: t.slots, hours: t.slots.length / 2, by: [...t.by].join(", "), done };
  }).sort((a, b) => (a.date + a.start + a.name < b.date + b.start + b.name ? -1 : 1));
}

function stats(list, now) {
  const done = list.filter(t => t.done), from = addDays(now.date, -29);
  const last = done.filter(t => t.date >= from);
  const sum = a => a.reduce((s, t) => s + t.hours, 0);
  const people = a => new Set(a.map(t => keyName(t.name))).size;
  return { ingressi: done.length, ore: sum(done), persone: people(done), ingressi30: last.length, ore30: sum(last), persone30: people(last) };
}

function sheets(history, now) {
  const list = turni(history, now), done = list.filter(t => t.done);
  const st = stats(list, now);
  const byPerson = new Map(), byMonth = new Map(), byDay = new Map(), peak = new Map();
  for (const t of done) {
    const pk = keyName(t.name);
    const p = byPerson.get(pk) || { name: t.name, n: 0, h: 0, last: "" };
    p.n++; p.h += t.hours; if (t.date > p.last) { p.last = t.date; p.name = t.name; } byPerson.set(pk, p);
    const mk = t.date.slice(0, 7), m = byMonth.get(mk) || { n: 0, h: 0, people: new Set() };
    m.n++; m.h += t.hours; m.people.add(pk); byMonth.set(mk, m);
    const d = byDay.get(t.date) || { n: 0, h: 0, people: new Set() };
    d.n++; d.h += t.hours; d.people.add(pk); byDay.set(t.date, d);
    for (const s of t.slots) { const k = t.date + "|" + s; peak.set(k, (peak.get(k) || 0) + 1); }
  }
  const peakDay = new Map();
  for (const [k, v] of peak) { const d = k.slice(0, 10); peakDay.set(d, Math.max(peakDay.get(d) || 0, v)); }
  const days = [...byDay.keys()].sort();
  return [
    { name: "Riepilogo", filter: false, widths: [34, 18], header: ["Voce", "Valore"], rows: [
      ["Ingressi svolti (totale)", st.ingressi], ["Ore svolte (totale)", st.ore], ["Persone diverse (totale)", st.persone],
      ["Ingressi ultimi 30 giorni", st.ingressi30], ["Ore ultimi 30 giorni", st.ore30], ["Persone diverse ultimi 30 giorni", st.persone30],
      ["Primo giorno registrato", days.length ? { date: days[0] } : "-"], ["Ultimo giorno registrato", days.length ? { date: days[days.length - 1] } : "-"],
      ["Aggiornato al", { date: now.date }],
    ] },
    { name: "Per persona", widths: [28, 11, 10, 22, 16], header: ["Persona", "Ingressi", "Ore", "Ore medie per ingresso", "Ultimo ingresso"],
      rows: [...byPerson.values()].sort((a, b) => b.h - a.h || b.n - a.n || a.name.localeCompare(b.name, "it"))
        .map(p => [p.name, p.n, p.h, Math.round(p.h / p.n * 100) / 100, { date: p.last }]) },
    { name: "Per mese", widths: [12, 11, 10, 16], header: ["Mese", "Ingressi", "Ore", "Persone diverse"],
      rows: [...byMonth.keys()].sort().map(k => { const m = byMonth.get(k); return [k, m.n, m.h, m.people.size]; }) },
    { name: "Per giorno", widths: [14, 14, 11, 10, 16, 20], header: ["Data", "Giorno", "Ingressi", "Ore", "Persone diverse", "Picco contemporanei"],
      rows: days.map(d => { const x = byDay.get(d); return [{ date: d }, dow(d), x.n, x.h, x.people.size, peakDay.get(d) || 0]; }) },
    { name: "Turni", widths: [14, 14, 8, 8, 8, 28, 28, 14], header: ["Data", "Giorno", "Dalle", "Alle", "Ore", "Persona", "Prenotato da", "Stato"],
      rows: list.map(t => [{ date: t.date }, dow(t.date), t.start, t.end, t.hours, t.name, t.by, t.done ? "Svolto" : "In programma"]) },
  ];
}

module.exports = { turni, stats, sheets };
