# Archivio note

Applicazione locale per consultare e modificare un'esportazione Google Keep.
Le note operative sono memorizzate nel database SQLite `keep.sqlite`.

## Avvio

Richiede una versione di Node.js che includa `node:sqlite`.

```bash
cd App
npm ci
npm start
```

L'applicazione e' disponibile su `http://localhost:3000` per impostazione
predefinita. Per usare un'altra porta:

```bash
PORT=3001 npm start
```

## Docker

Costruisci l'immagine dalla cartella `App`:

```bash
docker build -t archivio-note .
```

Avviala con un volume persistente per il database:

```bash
docker run --rm -p 3000:3000 \
  -v archivio-note-data:/data \
  archivio-note
```

`/data/keep.sqlite` conserva le modifiche tra i riavvii. Al primo avvio, con
database vuoto, l'app chiede se importare un archivio ZIP o iniziare con un
archivio vuoto.
L'immagine installa anche le dipendenze ZIP con `npm ci`. Gli archivi vengono
estratti temporaneamente in `/data/zip-imports`; al termine dell'importazione
gli allegati sono salvati nel database e la cartella temporanea viene rimossa.

In alternativa, avvia direttamente con docker compose:

```bash
docker compose up --build
```

## Progressive Web App (PWA) e Android Standalone

L'applicazione soddisfa tutti i requisiti dello standard **Progressive Web App (PWA)** per l'installazione in modalità **standalone** su dispositivi Android:

- **Web App Manifest**: configurato in `/manifest.webmanifest` e `/manifest.json` con `display: standalone`, tema cromatico, categoria e icone dedicate (standard e *maskable* a 192x192 e 512x512 per adattarsi alle forme delle icone Android).
- **Service Worker (`sw.js`)**: gestisce il pre-caching della shell applicativa (`index.html`, `style.css`, `app.js`, icone) e supporta la navigazione e visualizzazione delle note anche offline.
- **Scorciatoie rapide (App Shortcuts)**: pressione prolungata dell'icona sulla schermata Home per creare immediatamente una nuova nota (`/?action=new`).
- **Layout mobile e Safe Areas**: supporto per schermi con notch e barre di navigazione Android (`env(safe-area-inset-*)`).
- **Pulsante di installazione**: compare automaticamente nella barra laterale (**STRUMENTI** -> **Installa applicazione**) quando il browser Android intercetta l'evento di installazione.

### Supporto Nativo HTTPS e Certificati SSL

L'applicazione supporta nativamente il protocollo **HTTPS** sulla porta configurata (`3000` di default), includendo un listener a rilevamento automatico del protocollo:
- Se ci si collega via **HTTPS** (`https://<ip>:3000`), la sessione è cifrata in TLS.
- Se per sbaglio ci si collega via **HTTP** (`http://<ip>:3000`), il server effettua automaticamente un **redirect 301 a HTTPS** sulla stessa porta!

I certificati si trovano nella cartella `./certs`:
- `ca.crt` / `ca.key`: Root Certificate Authority (CA) locale.
- `server.crt` / `server.key`: certificato del server con estensioni SAN (*Subject Alternative Names*) per `localhost`, `*.local`, `127.0.0.1` e tutti gli indirizzi IP della LAN rilevati automaticamente.

#### Come generare o rigenerare i certificati
Puoi generare nuovamente i certificati in qualsiasi momento con:
```bash
./scripts/generate-certs.sh
```
Se desideri includere un dominio personalizzato o un IP specifico:
```bash
EXTRA_SAN="note.mia-rete.home,192.168.1.50" ./scripts/generate-certs.sh
```

#### Installazione del certificato CA su Android (per eliminare ogni avviso di sicurezza)
1. Apri l'app dal tuo smartphone Android: `https://<ip-del-server>:3000`.
2. Dalla barra laterale dell'app, sotto **STRUMENTI**, tocca **🔐 Certificato CA Android** (oppure scarica direttamente `https://<ip-del-server>:3000/ca.crt`).
3. Su Android vai in **Impostazioni** -> **Sicurezza** (o **Sicurezza e privacy**) -> **Altre impostazioni di sicurezza** -> **Installa da memoria dispositivo** (o **Installa certificato**) -> **Certificato CA**.
4. Seleziona il file scaricato `mynotes-ca.crt` e conferma.
5. Da questo momento Chrome su Android riconoscerà la connessione come sicura e affidabile al 100%, abilitando immediatamente la voce **Installa applicazione** per creare la PWA standalone WebAPK!

## Dati

- Le note, il loro ordinamento, le immagini inserite e gli allegati importati
  sono conservati in `App/keep.sqlite`. Immagini e allegati sono BLOB collegati
  alla nota, quindi restano disponibili anche dopo la rimozione dello ZIP.
- Le label sono contenute nei dati delle singole note. Il file `Labels.txt`
  viene prodotto durante l'esportazione ed e' solo un elenco di supporto.
- Il dialog **Importa ed esporta** gestisce esclusivamente archivi ZIP: scegli
  un file locale dal browser per importarlo oppure scarica un archivio ZIP
  per esportare. L'archivio contiene JSON, allegati e immagini BLOB convertite
  tramite `appImages`.
- Gli ZIP importati sono limitati a 100 MB, 10.000 elementi e 250 MB estratti;
  percorsi non sicuri e tipi di file non supportati vengono rifiutati. Le
  estrazioni temporanee, compresi eventuali residui di importazioni precedenti,
  vengono rimosse al termine, anche in caso di errore.
- L'importazione ZIP richiede una conferma. Il dialog include inoltre
  **Cancella completamente il database**, evidenziato in rosso e protetto da
  conferma: elimina note, immagini, ordine e impostazioni.

## Cronologia delle modifiche

### 8 settembre 2026

#### Layout delle note

- Aggiunta un'altezza massima di 360 px alle card per evitare note
  eccessivamente alte.
- Il testo delle card viene troncato dopo sette righe con ellissi; i titoli
  non vengono troncati.
- Introdotta una separazione di 8 px tra le note.
- Sostituito il flusso a colonne, che alterava l'ordine cronologico percepito,
  con un layout flessibile a ritorno a capo. Le note non fissate vengono quindi
  lette da sinistra a destra nell'ordine fornito dal database.
- Le note contenenti immagini non usano il line clamp del testo ricco, per
  evitare sovrapposizioni tra immagine e titolo.

#### Apertura del dettaglio

- I dialog sono ora fissati al viewport. L'apertura di una nota non sposta piu'
  la pagina dalla posizione della card selezionata.
- Aggiunta l'azione **Sposta nel cestino** sia nel menu contestuale sia nella
  preview accanto a **Modifica**. Le opzioni **Modifica** e **Sposta nel cestino**
  sono duplicate anche in alto nella view della nota. La nota viene conservata nel cestino.
- Nel Cestino è possibile svuotare tutti gli elementi oppure eliminarli
  definitivamente singolarmente dal menu contestuale o dalla preview.
- L'azione **Svuota cestino** è visibile solo nella sezione Cestino; ogni
  cancellazione definitiva richiede una conferma in un popup modale.
- L'header dell'editor, compreso il pulsante di chiusura, resta fisso durante
  lo scorrimento della nota.

#### Immagini nelle note

- Aggiunto il pulsante di inserimento immagini nell'editor rich text.
- L'editor supporta anche gli elenchi numerati tramite il pulsante **1.**.
- Sono accettate immagini PNG, JPEG, GIF e WebP fino a 5 MB.
- Le immagini vengono salvate come BLOB nella tabella SQLite `note_images`,
  collegate alla nota tramite il relativo identificatore.
- Le immagini nell'editor possono essere trascinate e riposizionate.
- Le immagini degli allegati Google Keep esistenti vengono migrate
  automaticamente in `note_images` al successivo avvio del server, diventando
  parte modificabile del testo della nota.

#### Importazione ed esportazione

- L'esportazione salva le immagini nel percorso scelto e aggiunge il manifest
  `appImages` ai JSON delle note.
- L'importazione legge quel manifest, salva di nuovo i file come BLOB nel
  database e sostituisce i riferimenti portabili con gli URL locali corretti.
- Gli allegati non immagine importati sono ora salvati come BLOB SQLite; gli
  ZIP esportati includono nuovamente tali byte tramite il manifest
  `appAttachments`. `zip-imports` viene eliminata dopo ogni importazione.
- Aggiunte importazione da un file ZIP selezionato nel browser ed esportazione
  ZIP tramite download del browser, con controlli contro zip-slip e limiti di
  dimensione.
- Rimosse le azioni e gli endpoint pubblici per importare o esportare
  direttamente cartelle: lo ZIP è l'unico formato di scambio disponibile.

#### Primo avvio e container

- Rimossa l'importazione automatica della cartella `Keep`.
- Al primo avvio di un database vuoto viene mostrato un popup che consente di
  scegliere tra importazione manuale e archivio inizialmente vuoto. La scelta
  e' memorizzata nel database.
- Aggiunti `Dockerfile` e `compose.yaml`: il container conserva soltanto il
  volume SQLite e non richiede il montaggio della cartella `../Keep`.
