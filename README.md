# Palestra sociale · Ivrea Canoa Club

Prenotazione online della palestra a slot da 30 minuti. Si entra con nome, cognome e un PIN di 4 cifre
(la prima volta lo sceglie ognuno). Il telefono se lo ricorda; da un altro dispositivo si riscrive nome e PIN.
Il link del sito va nel gruppo WhatsApp.

## Regole (modificabili dagli admin nella scheda Gestione)
- Si prenota fino a 7 giorni avanti (oggi + 6). Si cambia in Gestione, "Giorni prenotabili in anticipo" (metti 8 per arrivare allo stesso giorno della settimana prossima).
- Capienza: 8 persone contemporaneamente (default).
- Massimo 2 ore al giorno a testa (default). Vale per ogni nome, anche per chi viene prenotato da un altro.
- Si può prenotare anche per altre 2 persone al massimo (3 posti in tutto). Nello slot compare "Nome x3".
- I nomi di chi ha prenotato sono visibili a tutti.
- Ognuno può annullare solo le prenotazioni fatte da lui, anche quelle fatte per altre persone. Gli altri non possono toccarle.
- Gli admin possono: azzerare il PIN di chi lo dimentica (scheda Gestione, "Iscritti"); cambiare capienza, ore massime, orari di apertura, giorni prenotabili;
  creare blocchi fissi settimanali (o su una data) e modificarli; vedere chi ha prenotato e rimuovere prenotazioni.
- Gli admin non hanno limite di ore.

## Storico ed Excel
Ogni prenotazione viene registrata in automatico e conservata per sempre (quelle annullate restano nello storico, marcate, e non vengono contate).
In Gestione, "Ingressi e ore", vedi i totali e scarichi il file Excel aggiornato al momento, con i fogli:
Riepilogo, Per persona, Per mese, Per giorno (con il picco di presenze contemporanee) e Turni (l'elenco completo).
- Un **ingresso** è un turno di una persona in un giorno: slot consecutivi contano come un solo ingresso.
- Le **ore** sono i turni da 30 minuti diviso 2.
- I totali contano solo i turni già svolti; nel foglio Turni c'è anche chi è in programma.
- Chi viene prenotato da un altro conta a nome suo.
- Sono prenotazioni, non presenze verificate: se qualcuno prenota e non si presenta, risulta comunque entrato.
Il database è il file `db.json` nella cartella dati: per un backup basta copiarlo.

## Provarla sul proprio computer
    ADMIN_PASSWORD=scegli-una-password node server.js
poi apri http://localhost:3000 (serve Node 18 o superiore, nessuna installazione di pacchetti).
Test automatici: `npm test`.

## Metterla online
Serve un servizio che esegua Node o Docker **con un disco persistente**, altrimenti le prenotazioni
si perdono a ogni riavvio. Va bene uno di questi (controlla i piani attuali):
Railway, Fly.io o Render con volume/disco, oppure un piccolo VPS.

Impostazioni sempre uguali:
- Variabili: `ADMIN_PASSWORD` (obbligatoria), `TRUST_PROXY=1`, `DATA_DIR` = cartella del disco persistente (es. `/data`).
- Comando di avvio: `node server.js` (oppure usa il `Dockerfile`, che usa già `/data`).
- Monta il disco persistente su `/data` e usa HTTPS (lo offrono tutti questi servizi).
- Poi invia agli iscritti il link pubblico del sito.

## Gestori
In fondo alla pagina c'è "Accesso gestori": inserisci `ADMIN_PASSWORD`.

## Note
- I dati stanno in `DATA_DIR/db.json`: per un backup basta copiare quel file.
- Il PIN è salvato solo come hash. Dopo 5 PIN sbagliati l'account si blocca per 15 minuti; un gestore può azzerare il PIN, e così il profilo esce da tutti i dispositivi.
- Un PIN di 4 cifre protegge dagli scherzi e dagli errori, non da un attacco serio: va bene per un gruppo di soci.
- Le prenotazioni attive più vecchie di 14 giorni escono dall'elenco, ma restano nello storico.
