const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const appDir = __dirname;
const defaultKeepDir = path.resolve(process.env.KEEP_DIR || path.join(appDir, "../Keep"));
const databaseFile = path.resolve(process.env.DATABASE_FILE || path.join(appDir, "keep.sqlite"));
const port = Number(process.env.PORT) || 3001;
const maxImageBytes = 5 * 1024 * 1024;
const maxJsonBytes = 7 * 1024 * 1024;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".aac": "audio/aac",
  ".awb": "audio/amr-wb"
};
const colors = new Set(["DEFAULT", "RED", "ORANGE", "YELLOW", "GREEN", "TEAL", "BLUE", "DARK_BLUE", "PURPLE", "PINK", "BROWN", "GRAY"]);

const db = new DatabaseSync(databaseFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_dir TEXT NOT NULL,
    data TEXT NOT NULL,
    title TEXT NOT NULL,
    text_content TEXT NOT NULL,
    is_pinned INTEGER NOT NULL,
    is_archived INTEGER NOT NULL,
    is_trashed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER NOT NULL,
    UNIQUE(source_dir, source_file)
  );
  CREATE TABLE IF NOT EXISTS note_order (
    note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    pinned INTEGER NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_state_index ON notes(is_trashed, is_archived, is_pinned, edited_at DESC);
  CREATE TABLE IF NOT EXISTS note_images (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS note_images_note_index ON note_images(note_id);
`);

const statements = {
  count: db.prepare("SELECT COUNT(*) AS count FROM notes"),
  get: db.prepare("SELECT * FROM notes WHERE id = ?"),
  all: db.prepare(`SELECT n.* FROM notes n LEFT JOIN note_order o ON o.note_id = n.id
    ORDER BY n.is_pinned DESC, CASE WHEN o.position IS NULL THEN 1 ELSE 0 END, o.position ASC, n.edited_at DESC`),
  bySource: db.prepare("SELECT id FROM notes WHERE source_dir = ? AND source_file = ?"),
  insert: db.prepare(`INSERT INTO notes (id, source_file, source_dir, data, title, text_content, is_pinned, is_archived, is_trashed, created_at, edited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`UPDATE notes SET data = ?, title = ?, text_content = ?, is_pinned = ?, is_archived = ?, is_trashed = ?, created_at = ?, edited_at = ? WHERE id = ?`),
  allOrder: db.prepare("SELECT note_id, pinned FROM note_order ORDER BY pinned DESC, position ASC"),
  clearOrder: db.prepare("DELETE FROM note_order WHERE pinned = ?"),
  putOrder: db.prepare("INSERT INTO note_order (note_id, pinned, position) VALUES (?, ?, ?)"),
  existingFiles: db.prepare("SELECT source_file FROM notes"),
  imagesForNote: db.prepare("SELECT id, mime_type, bytes FROM note_images WHERE note_id = ? ORDER BY created_at ASC"),
  getImage: db.prepare("SELECT id, mime_type, bytes FROM note_images WHERE id = ?"),
  insertImage: db.prepare("INSERT INTO note_images (id, note_id, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?)"),
  clearImages: db.prepare("DELETE FROM note_images WHERE note_id = ?")
};

function imageUrl(id) {
  return `/api/images/${id}`;
}

function normalizeNote(raw, row) {
  return {
    id: row.id,
    title: raw.title || "",
    textContent: raw.textContent || "",
    textContentHtml: sanitizeHtml(raw.textContentHtml || ""),
    listContent: (raw.listContent || []).map((item) => ({ text: item.text || "", isChecked: Boolean(item.isChecked) })),
    labels: (raw.labels || []).map((label) => label.name).filter(Boolean),
    color: raw.color || "DEFAULT",
    isPinned: Boolean(raw.isPinned),
    isArchived: Boolean(raw.isArchived),
    isTrashed: Boolean(raw.isTrashed),
    createdAt: Number(raw.createdTimestampUsec || 0),
    editedAt: Number(raw.userEditedTimestampUsec || 0),
    annotations: (raw.annotations || []).map(({ title, description, url }) => ({ title, description, url })),
    attachments: (raw.attachments || []).map(({ filePath, mimetype }) => ({
      name: filePath,
      mimetype,
      url: `/media/${encodeURIComponent(row.id)}/${encodeURIComponent(filePath)}`
    }))
  };
}

function loadNotes() {
  return statements.all.all().map((row) => normalizeNote(JSON.parse(row.data), row));
}

function loadOrder() {
  const order = { pinned: [], others: [] };
  for (const row of statements.allOrder.all()) order[row.pinned ? "pinned" : "others"].push(row.note_id);
  return order;
}

function noteRecord(raw, sourceFile, sourceDir, id = crypto.randomUUID()) {
  return [
    id, sourceFile, sourceDir, JSON.stringify(raw), raw.title || "", raw.textContent || "",
    Number(Boolean(raw.isPinned)), Number(Boolean(raw.isArchived)), Number(Boolean(raw.isTrashed)),
    Number(raw.createdTimestampUsec || 0), Number(raw.userEditedTimestampUsec || 0)
  ];
}

function writeNote(raw, sourceFile, sourceDir, id) {
  const existing = id && statements.get.get(id);
  if (existing) {
    const record = noteRecord(raw, existing.source_file, existing.source_dir, id);
    statements.update.run(...record.slice(3), id);
    return statements.get.get(id);
  }
  const record = noteRecord(raw, sourceFile, sourceDir, id);
  statements.insert.run(...record);
  return statements.get.get(record[0]);
}

function importFolder(folder) {
  const sourceDir = path.resolve(folder);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) throw new Error("La cartella di importazione non esiste.");
  let imported = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    for (const sourceFile of fs.readdirSync(sourceDir)) {
      if (!sourceFile.endsWith(".json")) continue;
      db.exec("SAVEPOINT import_note");
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(sourceDir, sourceFile), "utf8"));
        const existing = statements.bySource.get(sourceDir, sourceFile);
        const row = writeNote(raw, sourceFile, sourceDir, existing?.id);
        importInlineImages(raw, row, sourceDir);
        removeUnusedImages(row.id, raw.textContentHtml);
        db.exec("RELEASE SAVEPOINT import_note");
        imported += 1;
      } catch (error) {
        db.exec("ROLLBACK TO SAVEPOINT import_note");
        db.exec("RELEASE SAVEPOINT import_note");
        console.warn(`Skipping invalid note ${sourceFile}: ${error.message}`);
        skipped += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { imported, skipped, total: statements.count.get().count };
}

function migrateLegacyOrder() {
  const orderFile = path.join(appDir, "note-order.json");
  if (!fs.existsSync(orderFile)) return;
  try {
    const oldOrder = JSON.parse(fs.readFileSync(orderFile, "utf8"));
    const convert = (id) => {
      const sourceFile = Buffer.from(id, "base64url").toString("utf8");
      return statements.bySource.get(defaultKeepDir, sourceFile)?.id;
    };
    setOrder({
      pinned: (oldOrder.pinned || []).map(convert).filter(Boolean),
      others: (oldOrder.others || []).map(convert).filter(Boolean)
    });
  } catch (error) {
    console.warn(`Could not migrate old order: ${error.message}`);
  }
}

function setOrder(input) {
  if (!input || !Array.isArray(input.pinned) || !Array.isArray(input.others)) throw new Error("Ordine note non valido.");
  const knownIds = new Set(loadNotes().map((note) => note.id));
  const usedIds = new Set();
  const clean = (ids) => ids.filter((id) => typeof id === "string" && knownIds.has(id) && !usedIds.has(id) && (usedIds.add(id), true));
  const order = { pinned: clean(input.pinned), others: clean(input.others) };
  db.exec("BEGIN");
  try {
    statements.clearOrder.run(1);
    statements.clearOrder.run(0);
    order.pinned.forEach((id, position) => statements.putOrder.run(id, 1, position));
    order.others.forEach((id, position) => statements.putOrder.run(id, 0, position));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return order;
}

function cleanNote(input, existing = {}) {
  if (!input || typeof input !== "object" || typeof input.title !== "string" || typeof input.textContent !== "string" || !Array.isArray(input.labels) || !Array.isArray(input.listContent)) throw new Error("Dati della nota non validi.");
  const listContent = input.listContent
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ text: item.text.trim(), isChecked: Boolean(item.isChecked) }));
  const labels = [...new Set(input.labels.filter((label) => typeof label === "string").map((label) => label.trim()).filter(Boolean))];
  const now = Date.now() * 1000;
  const raw = {
    ...existing,
    color: colors.has(input.color) ? input.color : "DEFAULT",
    isTrashed: Boolean(input.isTrashed),
    isPinned: Boolean(input.isPinned),
    isArchived: Boolean(input.isArchived),
    textContent: input.textContent,
    title: input.title,
    userEditedTimestampUsec: now,
    createdTimestampUsec: existing.createdTimestampUsec || now
  };
  if (listContent.length) raw.listContent = listContent;
  else delete raw.listContent;
  if (labels.length) raw.labels = labels.map((name) => ({ name }));
  else delete raw.labels;
  const suppliedHtml = typeof input.textContentHtml === "string" ? input.textContentHtml : raw.textContent ? plainTextHtml(raw.textContent) : "";
  const textContentHtml = sanitizeHtml(suppliedHtml);
  if (textContentHtml) raw.textContentHtml = textContentHtml;
  else delete raw.textContentHtml;
  return raw;
}

function plainTextHtml(text) {
  return text.split("\n").map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`).join("");
}

function sanitizeHtml(html) {
  const allowed = new Set(["p", "br", "div", "h2", "h3", "blockquote", "strong", "b", "em", "i", "u", "s", "strike", "ul", "ol", "li"]);
  return String(html).replace(/<\/?([a-zA-Z0-9]+)(?:\s[^>]*)?>/g, (tag, name) => {
    const tagName = name.toLowerCase();
    if (tagName === "img") {
      if (tag.startsWith("</")) return "";
      const src = tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const alt = tag.match(/\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const source = src && (src[1] ?? src[2] ?? src[3]);
      if (!/^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source || "")) return "";
      const description = alt && (alt[1] ?? alt[2] ?? alt[3]);
      return `<img src="${source}"${description ? ` alt="${escapeAttribute(description)}"` : ""}>`;
    }
    if (!allowed.has(tagName)) return "";
    return tag.startsWith("</") ? `</${tagName}>` : `<${tagName}>`;
  });
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function imageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Immagine non valida.");
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error("Formato immagine non supportato.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > maxImageBytes || bytes.toString("base64") !== match[2]) throw new Error("L'immagine supera il limite di 5 MB o non è valida.");
  const mimeType = imageMime(bytes);
  if (!mimeType) throw new Error("Sono consentite solo immagini PNG, JPEG, GIF o WebP.");
  return { bytes, mimeType };
}

function extensionForImage(mimeType) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[mimeType] || "img";
}

function portableImageUrl(fileName) {
  return `keep-image:${encodeURIComponent(fileName)}`;
}

function importInlineImages(raw, row, sourceDir) {
  const manifest = raw.appImages;
  delete raw.appImages;
  if (manifest === undefined) return;
  if (!Array.isArray(manifest)) throw new Error("Elenco immagini esportate non valido.");
  const imported = [];
  for (const item of manifest) {
    const fileName = item && typeof item.filePath === "string" ? item.filePath : "";
    if (!fileName || path.basename(fileName) !== fileName) throw new Error("Nome file immagine non valido.");
    const filePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Immagine mancante: ${fileName}`);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > maxImageBytes) throw new Error(`Immagine troppo grande: ${fileName}`);
    const mimeType = imageMime(bytes);
    if (!mimeType) throw new Error(`Formato immagine non supportato: ${fileName}`);
    imported.push({ id: crypto.randomUUID(), fileName, bytes, mimeType });
  }
  statements.clearImages.run(row.id);
  for (const image of imported) statements.insertImage.run(image.id, row.id, image.mimeType, image.bytes, Date.now() * 1000);
  if (typeof raw.textContentHtml === "string") {
    for (const image of imported) raw.textContentHtml = raw.textContentHtml.split(portableImageUrl(image.fileName)).join(imageUrl(image.id));
    raw.textContentHtml = sanitizeHtml(raw.textContentHtml);
  }
  writeNote(raw, row.source_file, row.source_dir, row.id);
}

function migrateAttachmentImages() {
  for (const row of statements.all.all()) {
    const raw = JSON.parse(row.data);
    const imageAttachments = (raw.attachments || []).filter((attachment) => attachment?.mimetype?.startsWith("image/"));
    if (!imageAttachments.length) continue;

    const images = [];
    for (const attachment of imageAttachments) {
      const filename = path.basename(attachment.filePath || "");
      const filePath = path.join(row.source_dir, filename);
      if (!filename || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const bytes = fs.readFileSync(filePath);
      const mimeType = imageMime(bytes);
      if (!mimeType || bytes.length > maxImageBytes) continue;
      const id = crypto.randomUUID();
      statements.insertImage.run(id, row.id, mimeType, bytes, Date.now() * 1000);
      images.push({ id, filename });
    }
    if (!images.length) continue;

    raw.attachments = (raw.attachments || []).filter((attachment) => !attachment?.mimetype?.startsWith("image/"));
    const existingHtml = raw.textContentHtml || (raw.textContent ? plainTextHtml(raw.textContent) : "");
    raw.textContentHtml = `${existingHtml}${images.map((image) => `<img src="${imageUrl(image.id)}" alt="${escapeAttribute(image.filename)}">`).join("")}`;
    writeNote(raw, row.source_file, row.source_dir, row.id);
  }
}

function removeUnusedImages(noteId, html) {
  const imageIds = [...String(html || "").matchAll(/\/api\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((match) => match[1]);
  if (!imageIds.length) return statements.clearImages.run(noteId);
  const placeholders = imageIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM note_images WHERE note_id = ? AND id NOT IN (${placeholders})`).run(noteId, ...imageIds);
}

function exportFolder(folder) {
  const targetDir = path.resolve(folder);
  fs.mkdirSync(targetDir, { recursive: true });
  const usedFiles = new Set();
  let attachments = 0;
  let images = 0;
  for (const row of statements.all.all()) {
    const raw = JSON.parse(row.data);
    let file = path.basename(row.source_file);
    if (!file.endsWith(".json")) file = `${row.id}.json`;
    if (usedFiles.has(file)) file = `${path.basename(file, ".json")}-${row.id.slice(0, 8)}.json`;
    usedFiles.add(file);
    const inlineImages = [];
    for (const image of statements.imagesForNote.all(row.id)) {
      const imageFile = `inline-image-${row.id}-${image.id}.${extensionForImage(image.mime_type)}`;
      fs.writeFileSync(path.join(targetDir, imageFile), image.bytes);
      inlineImages.push({ filePath: imageFile, mimetype: image.mime_type });
      if (typeof raw.textContentHtml === "string") raw.textContentHtml = raw.textContentHtml.split(imageUrl(image.id)).join(portableImageUrl(imageFile));
      images += 1;
    }
    raw.appImages = inlineImages;
    fs.writeFileSync(path.join(targetDir, file), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    for (const attachment of raw.attachments || []) {
      const name = path.basename(attachment.filePath || "");
      const source = path.join(row.source_dir, name);
      const target = path.join(targetDir, name);
      if (name && fs.existsSync(source) && !fs.existsSync(target)) {
        fs.copyFileSync(source, target);
        attachments += 1;
      }
    }
  }
  fs.writeFileSync(path.join(targetDir, "Labels.txt"), `${[...new Set(loadNotes().flatMap((note) => note.labels))].sort().join("\n")}\n`, "utf8");
  return { exported: statements.count.get().count, attachments, images, folder: targetDir };
}

function readJson(request, maxBytes = maxJsonBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        tooLarge = true;
        reject(new Error("Richiesta troppo grande."));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(body)); } catch { reject(new Error("JSON non valido.")); }
    });
    request.on("error", reject);
  });
}

function send(response, status, type, body) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function sendImage(response, image) {
  response.writeHead(200, {
    "Content-Type": image.mime_type,
    "Content-Length": image.bytes.length,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(image.bytes);
}

function serveFile(response, root, requestedPath) {
  const file = path.join(root, path.basename(requestedPath));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, "text/plain; charset=utf-8", "Not found");
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}

if (statements.count.get().count === 0) {
  importFolder(defaultKeepDir);
  migrateLegacyOrder();
}
migrateAttachmentImages();

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/notes") return sendJson(response, 200, loadNotes());
    if (request.method === "GET" && url.pathname === "/api/order") return sendJson(response, 200, loadOrder());
    if (request.method === "POST" && url.pathname === "/api/notes") {
      const raw = cleanNote(await readJson(request));
      const sourceFile = `${new Date().toISOString().replace(/[:.]/g, "_")}.json`;
      return sendJson(response, 201, normalizeNote(raw, writeNote(raw, sourceFile, defaultKeepDir)));
    }
    if (request.method === "POST" && /^\/api\/notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/images$/i.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const row = statements.get.get(id);
      if (!row) return send(response, 404, "text/plain; charset=utf-8", "Nota non trovata.");
      const { bytes, mimeType } = decodeImageDataUrl((await readJson(request, Math.ceil(maxImageBytes * 1.4))).dataUrl);
      const image = { id: crypto.randomUUID(), noteId: id, mimeType, bytes };
      statements.insertImage.run(image.id, image.noteId, image.mimeType, image.bytes, Date.now() * 1000);
      return sendJson(response, 201, { id: image.id, url: imageUrl(image.id), mimetype: image.mimeType });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/api/notes/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/notes/".length));
      const row = statements.get.get(id);
      if (!row) return send(response, 404, "text/plain; charset=utf-8", "Nota non trovata.");
      const raw = cleanNote(await readJson(request), JSON.parse(row.data));
      const saved = writeNote(raw, row.source_file, row.source_dir, id);
      removeUnusedImages(id, raw.textContentHtml);
      return sendJson(response, 200, normalizeNote(raw, saved));
    }
    if (request.method === "PUT" && url.pathname === "/api/order") return sendJson(response, 200, setOrder(await readJson(request)));
    if (request.method === "POST" && url.pathname === "/api/import") {
      const input = await readJson(request);
      if (!input || typeof input.folder !== "string" || !input.folder.trim()) throw new Error("Indica una cartella da importare.");
      return sendJson(response, 200, importFolder(input.folder));
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      const input = await readJson(request);
      if (!input || typeof input.folder !== "string" || !input.folder.trim()) throw new Error("Indica una cartella di esportazione.");
      return sendJson(response, 200, exportFolder(input.folder));
    }
    if (request.method === "GET" && /^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)) {
      const image = statements.getImage.get(url.pathname.split("/").pop());
      if (!image) return send(response, 404, "text/plain; charset=utf-8", "Not found");
      return sendImage(response, image);
    }
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      const [, , id, filename] = url.pathname.split("/").map(decodeURIComponent);
      const row = statements.get.get(id);
      if (!row || !filename || !JSON.parse(row.data).attachments?.some((item) => item.filePath === filename)) return send(response, 404, "text/plain; charset=utf-8", "Not found");
      return serveFile(response, row.source_dir, filename);
    }
    if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
    const staticPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (staticPath.includes("/") || !["index.html", "app.js", "style.css"].includes(staticPath)) return send(response, 404, "text/plain; charset=utf-8", "Not found");
    serveFile(response, path.join(appDir, "public"), staticPath);
  } catch (error) {
    console.error(error);
    send(response, 400, "text/plain; charset=utf-8", error.message);
  }
}).listen(port, "0.0.0.0", () => console.log(`Archivio note: http://localhost:${port} (${statements.count.get().count} note)`));
