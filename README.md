# Archivio note

Applicazione locale per consultare e modificare un'esportazione Google Keep.
Le note operative sono memorizzate nel database SQLite `keep.sqlite`.

## Avvio

Richiede una versione di Node.js che includa `node:sqlite`.

```bash
cd App
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

Avviala montando una cartella Keep da importare e un volume persistente per il
database:

```bash
docker run --rm -p 3000:3000 \
  -v "$PWD/../Keep:/keep:ro" \
  -v archivio-note-data:/data \
  archivio-note
```

`/data/keep.sqlite` conserva le modifiche tra i riavvii. La cartella montata
in `/keep` viene letta solo al primo avvio, quando il database e' vuoto.

In alternativa, dalla cartella `App`, avvia direttamente:

```bash
docker compose up --build
```

## Dati

- Le note, il loro ordinamento e le immagini inserite sono conservati in
  `App/keep.sqlite`.
- Le label sono contenute nei dati delle singole note. Il file `Labels.txt`
  viene prodotto durante l'esportazione ed e' solo un elenco di supporto.
- L'importazione legge i file JSON da una cartella. L'esportazione crea JSON,
  allegati e immagini nella cartella scelta.

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

#### Immagini nelle note

- Aggiunto il pulsante di inserimento immagini nell'editor rich text.
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
