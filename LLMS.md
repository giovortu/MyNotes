# LLMS.md — Project Guide & Architectural Context for LLMs

Questo documento è ottimizzato per consentire a un LLM di comprendere rapidamente l'architettura, la struttura dei file, il database, le API e le convenzioni del progetto in una nuova sessione di chat.

---

## 1. Panoramica del Progetto (Project Overview)

**Archivio note** è un'applicazione web locale (SPA + backend Node.js minimale) per visualizzare, modificare, organizzare ed esportare note provenienti da Google Keep (Takeout) o create direttamente nell'applicazione.

- **Stack**: Node.js (>= 22 nativo con `node:sqlite`), Vanilla JavaScript (ES6+), HTML5, CSS3 contemporaneo.
- **Dipendenze minime**: solo `yauzl` e `yazl` per la manipolazione di archivi ZIP. Zero framework backend (nessun Express), zero framework frontend (nessun React/Vue/bundler).
- **Storage**: SQLite locale (`keep.sqlite`) in modalità WAL. Immagini e allegati sono memorizzati direttamente come BLOB nel database.

---

## 2. Struttura del Repository (Repository Structure)

```
/data/Projects/MyNotes/
├── server.js              # Server HTTP nativo, router API, logica SQLite, import/export ZIP
├── package.json           # Dipendenze (yauzl, yazl) e script npm start
├── note-order.json        # Ordine iniziale di backup per note importate
├── Dockerfile             # Container Node.js minimale con volume su /data
├── docker-compose.yaml    # Configurazione Docker Compose per sviluppo/esecuzione locale
├── README.md              # Documentazione utente e cronologia delle modifiche
├── LLMS.md                # Questo file (guida contestuale per modelli linguistici)
└── public/                # File statici serviti direttamente dal server
    ├── index.html         # Struttura SPA, template card e dialog modali (<dialog>)
    ├── app.js             # Stato frontend, rendering reattivo, eventi, editor e dialoghi
    └── style.css          # Tema scuro/chiaro contemporaneo, grid layout, dialoghi, icone
```

---

## 3. Database & Schema SQLite (`keep.sqlite`)

Gestito tramite il modulo nativo di Node.js `node:sqlite` (`DatabaseSync`):

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Note principali
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_dir TEXT NOT NULL,
  data TEXT NOT NULL,               -- Payload JSON originale / esteso stile Keep
  title TEXT NOT NULL,
  text_content TEXT NOT NULL,
  is_pinned INTEGER NOT NULL,       -- 0 o 1
  is_archived INTEGER NOT NULL,     -- 0 o 1
  is_trashed INTEGER NOT NULL,      -- 0 o 1
  created_at INTEGER NOT NULL,      -- Timestamp microsecondi
  edited_at INTEGER NOT NULL,       -- Timestamp microsecondi
  UNIQUE(source_dir, source_file)
);

-- Posizionamento manuale (drag-and-drop)
CREATE TABLE note_order (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL,          -- 1 per fissate, 0 per altre
  position INTEGER NOT NULL         -- Ordinamento sequenziale
);

-- Immagini inline rich-text (BLOB)
CREATE TABLE note_images (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Allegati file generici / Keep (BLOB)
CREATE TABLE note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(note_id, name)
);

-- Impostazioni applicazione
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 4. Architettura Backend (`server.js`)

- Usa `http.createServer` nativo e gestisce le richieste con un dispatcher `async/await` basato su `pathname` e `method`.
- **Parsing JSON**: funzione `readJson(request, limit)`.
- **File statici**: serviti da `/public` (`index.html`, `app.js`, `style.css`).
- **REST API principali**:
  - `GET /api/notes`: Restituisce tutte le note normalizzate (`normalizeNote`).
  - `POST /api/notes`: Crea una nuova nota (validata con `cleanNote`).
  - `PUT /api/notes/:id`: Aggiorna una nota esistente.
  - `DELETE /api/notes/:id`: Elimina definitivamente una nota dal DB (in cascata elimina ordine, immagini e allegati).
  - `GET /api/order` & `PUT /api/order`: Gestione dell'ordine manuale (`pinned` e `others`).
  - `POST /api/notes/:id/images`: Upload immagine rich-text (fino a 5 MB in base64).
  - `GET /api/images/:id`: Download BLOB immagine inline.
  - `GET /media/:noteId/:filename`: Download BLOB allegato nota.
  - `POST /api/import/zip`: Importazione archivio ZIP Google Keep con validazione zip-slip e limiti di sicurezza.
  - `GET /api/export/zip`: Esportazione ZIP con manifest `appImages` e `appAttachments`.
  - `DELETE /api/trash`: Svuota completamente il cestino (`DELETE FROM notes WHERE is_trashed = 1`).
  - `POST /api/setup`: Selezione modalità primo avvio (`empty` o `import`).
  - `POST /api/reset`: Reset totale del database.

---

## 5. Architettura Frontend (`public/app.js`, `index.html`, `style.css`)

### Stato dell'applicazione (`state`)
```javascript
const state = {
  notes: [],                  // Array di tutte le note caricate da /api/notes
  order: { pinned: [], others: [] },
  filter: "notes",            // "notes" | "reminders" | "archived" | "trash"
  label: "",                  // Filtro per etichetta selezionata
  query: "",                  // Query di ricerca testo
  grid: true,                 // true = grid, false = list
  maxColumns: 5               // Colonne massime (persistito in localStorage)
};
```

### Dialog Modali HTML5 nativi
- `#note-dialog`: Visualizzazione dettaglio nota (aperta al click su una card).
- `#editor-dialog`: Editor WYSIWYG per creare/modificare note (titolo, testo formattato, checklist, etichette, colore, fissa, archivia).
- `#data-dialog`: Dialog per import/export archivi ZIP e reset completo.
- `#setup-dialog`: Mostrato solo al primo avvio se il database è vuoto.
- `#confirmation-dialog`: Richiesta di conferma per azioni irreversibili (es. svuota cestino, elimina definitiva).

### Dettaglio Nota (`openNote(note)`)
All'interno di `#detail` (contenuto in `#note-dialog`):
1. **Azioni in alto (`.detail-actions`)**:
   - Pulsante **Modifica**: icona matita SVG (`data-action="edit"`, `title="Modifica"`).
   - Pulsante **Sposta nel cestino** / **Elimina definitivamente**: icona cestino SVG (`data-action="trash"`, `title="${trashLabel}"`, colore rosso `.trash-note`).
2. **Corpo della nota**: generato da `cardBody(note, true)` (titolo, allegati multimediali, testo ricco, checklist, link esterni).
3. **Footer (`#detail footer`)**:
   - Etichette della nota (`<em>`).
   - Data ultima modifica (`Modificata ...`).
   - **Azioni duplicate nel footer (`.detail-footer-actions`)**: esattamente le stesse icone (Modifica e Cestino), con gli stessi listener e attributi.
4. **Pulsante di chiusura**: `.dialog-close` posizionato in alto a destra (`position: absolute; top: 12px; right: 12px`).

---

## 6. Convenzioni di Stile e UI (`public/style.css`)

- **Tema contemporaneo**: sfondo scuro/viola per la barra e la sidebar (`#20202c`), accenti lilla/viola (`#8b70ff`, `#6046cc`), pulsanti di pericolo rossi (`#b3261e`).
- **Attenzione alla specificità CSS**:
  - `header` globale definisce la barra principale superiore dell'applicazione (`height: 76px; background: #20202c`).
  - Per intestazioni all'interno dei dialog modali, usare sempre classi o `div` specifici (es. `.detail-actions`), evitando elementi `<header>` non qualificati per non ereditare lo stile della navbar principale.
- **Pulsanti a icona**:
  - I pulsanti in `.detail-actions` e `.detail-footer-actions` sono circolari `32x32px` (`border-radius: 50%`, `display: grid; place-items: center;`).
  - Icone SVG scalabili a `19x19px` con `fill: currentColor`.
  - `.trash-note` ha `color: #b3261e` per indicare azione distruttiva.

---

## 7. Comandi di Esecuzione e Sviluppo

```bash
# Installazione dipendenze
npm ci

# Avvio server di default su http://localhost:3000
npm start

# Avvio su porta personalizzata
PORT=3001 npm start

# Con Docker
docker compose up --build
```

---

## 8. Linee Guida per Modifiche Future (Guidelines for Agents)

1. **Nessun framework esterno**: non introdurre React, Vue, Express o bundler a meno che non sia esplicitamente richiesto. Mantenere l'applicazione leggera, compatibile con standard web nativi.
2. **Integrità del database**: SQLite usa transazioni `BEGIN` / `COMMIT` / `ROLLBACK` e `SAVEPOINT`. Qualsiasi modifica alle note deve mantenere coerenti le tabelle collegate (`note_order`, `note_images`, `note_attachments`).
3. **Responsive & Accessibilità**: i pulsanti a sola icona devono sempre includere `title` (tooltip) e `aria-label` (screen reader). Gli SVG devono avere `aria-hidden="true"`.
4. **Pulsanti duplicati**: se si modificano le azioni della nota (es. aggiunta di archivio o duplicazione), mantenere sincronizzati sia il blocco superiore (`.detail-actions`) sia quello inferiore (`.detail-footer-actions`).
