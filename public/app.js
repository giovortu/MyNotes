const savedColumns = Number(localStorage.getItem("max-columns"));
const state = { notes: [], order: { pinned: [], others: [] }, filter: "notes", label: "", query: "", grid: true, maxColumns: [1, 2, 3, 4, 5].includes(savedColumns) ? savedColumns : 5 };
let draggedNoteId = "";
let dropTargetId = "";
let dropPosition = "before";
let editorSelection = null;
let pendingImages = new Map();
let pendingImageNumber = 0;
let draggedEditorImage = null;
const colors = { RED: "#f28b82", ORANGE: "#fbbc04", YELLOW: "#fff475", GREEN: "#ccff90", TEAL: "#a7ffeb", BLUE: "#cbf0f8", DARK_BLUE: "#aecbfa", PURPLE: "#d7aefb", PINK: "#fdcfe8", BROWN: "#e6c9a8", GRAY: "#e8eaed", DEFAULT: "#fff" };
const elements = {
  notes: document.querySelector("#notes"), empty: document.querySelector("#empty"),
  summary: document.querySelector("#summary"), search: document.querySelector("#search"),
  labels: document.querySelector("#label-list"), dialog: document.querySelector("#note-dialog"),
  detail: document.querySelector("#detail"), template: document.querySelector("#note-template"),
  editor: document.querySelector("#editor-dialog"), form: document.querySelector("#note-form"),
  editorTitle: document.querySelector("#editor-title"), saveError: document.querySelector("#save-error"),
  titleInput: document.querySelector("#note-title"), textInput: document.querySelector("#note-text"),
  listInput: document.querySelector("#note-list"), labelsInput: document.querySelector("#note-labels"),
  colorInput: document.querySelector("#note-color"), pinnedInput: document.querySelector("#note-pinned"),
  archivedInput: document.querySelector("#note-archived"), contextMenu: document.querySelector("#context-menu"),
  dataDialog: document.querySelector("#data-dialog"), dataStatus: document.querySelector("#data-status"),
  importZip: document.querySelector("#import-zip"), exportZip: document.querySelector("#export-zip"),
  imageInput: document.querySelector("#image-input"), setupDialog: document.querySelector("#setup-dialog"),
  setupError: document.querySelector("#setup-error")
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const lines = (value) => escapeHtml(value).replace(/\n/g, "<br>");
const date = (microseconds) => new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" }).format(new Date(microseconds / 1000));

function visibleNotes() {
  const query = state.query.toLocaleLowerCase();
  return state.notes.filter((note) => {
    const belongs = state.filter === "notes" ? !note.isArchived && !note.isTrashed
      : state.filter === "archived" ? note.isArchived && !note.isTrashed
      : state.filter === "trash" ? note.isTrashed : false;
    const searchable = [note.title, note.textContent, ...note.listContent.map((item) => item.text), ...note.labels, ...note.annotations.flatMap((link) => [link.title, link.description, link.url])].join(" ").toLocaleLowerCase();
    return belongs && (!state.label || note.labels.includes(state.label)) && searchable.includes(query);
  });
}

function media(attachments) {
  return attachments.map((file) => file.mimetype.startsWith("image/")
    ? `<img class="attachment" src="${file.url}" alt="Allegato">`
    : `<audio controls src="${file.url}">Allegato audio: ${escapeHtml(file.name)}</audio>`).join("");
}

function cardBody(note, expanded = false) {
  const content = [];
  if (note.title) content.push(`<h2>${escapeHtml(note.title)}</h2>`);
  if (note.attachments.length) content.push(media(note.attachments));
  if (note.textContent || note.textContentHtml) content.push(`<div class="text rich-text">${note.textContentHtml || lines(note.textContent)}</div>`);
  if (note.listContent.length) content.push(`<ul class="checklist">${note.listContent.map((item) => `<li class="${item.isChecked ? "checked" : ""}"><span>${item.isChecked ? "✓" : ""}</span>${escapeHtml(item.text)}</li>`).join("")}</ul>`);
  if (expanded && note.annotations.length) content.push(`<section class="links">${note.annotations.map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(link.title || link.url)}</strong><small>${escapeHtml(link.description || link.url)}</small></a>`).join("")}</section>`);
  return content.join("") || "<p class=\"text muted\">Nota vuota</p>";
}

function render() {
  const notes = visibleNotes();
  elements.notes.replaceChildren();
  const appendNote = (note) => {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    node.draggable = true;
    node.style.backgroundColor = colors[note.color] || colors.DEFAULT;
    node.querySelector(".note-content").innerHTML = cardBody(note);
    node.querySelector(".labels").innerHTML = note.labels.map((label) => `<em>${escapeHtml(label)}</em>`).join("");
    node.querySelector("time").textContent = date(note.editedAt);
    node.addEventListener("click", () => openNote(note));
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(note, event.clientX, event.clientY);
    });
    node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openNote(note); } });
    node.addEventListener("dragstart", (event) => {
      draggedNoteId = note.id;
      event.dataTransfer.setData("text/plain", note.id);
      event.dataTransfer.effectAllowed = "move";
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => {
      draggedNoteId = "";
      dropTargetId = "";
      document.querySelector(".note.drop-before, .note.drop-after")?.classList.remove("drop-before", "drop-after");
      node.classList.remove("dragging");
    });
    node.addEventListener("dragover", (event) => {
      const dragged = state.notes.find((item) => item.id === draggedNoteId);
      if (dragged && dragged.isPinned === note.isPinned && dragged.id !== note.id) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const previousTarget = document.querySelector(".note.drop-before, .note.drop-after");
        if (previousTarget && previousTarget !== node) previousTarget.classList.remove("drop-before", "drop-after");
        dropTargetId = note.id;
        dropPosition = event.clientY < node.getBoundingClientRect().top + node.offsetHeight / 2 ? "before" : "after";
        node.classList.toggle("drop-before", dropPosition === "before");
        node.classList.toggle("drop-after", dropPosition === "after");
      }
    });
    node.addEventListener("dragleave", (event) => {
      if (!node.contains(event.relatedTarget)) node.classList.remove("drop-before", "drop-after");
    });
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      node.classList.remove("drop-before", "drop-after");
      moveNote(draggedNoteId || event.dataTransfer.getData("text/plain"), dropTargetId || note.id, note.isPinned, dropPosition);
      dropTargetId = "";
    });
    elements.notes.append(node);
  };
  const pinned = notes.filter((note) => note.isPinned);
  const others = notes.filter((note) => !note.isPinned);
  if (pinned.length) {
    const heading = document.createElement("h3");
    heading.className = "note-section-heading";
    heading.id = "pinned";
    heading.textContent = "FISSATE";
    elements.notes.append(heading);
    pinned.forEach(appendNote);
  }
  if (others.length) {
    const heading = document.createElement("h3");
    heading.className = "note-section-heading";
    heading.id = "others";
    heading.textContent = "ALTRE";
    elements.notes.append(heading);
  }
  others.forEach(appendNote);
  elements.summary.textContent = `${notes.length} ${notes.length === 1 ? "nota" : "note"}`;
  elements.empty.hidden = notes.length !== 0;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.filter === state.filter && !state.label));
  document.querySelectorAll("[data-label]").forEach((button) => button.classList.toggle("active", button.dataset.label === state.label));
}

function notePayload(note, changes) {
  return {
    title: note.title,
    textContent: note.textContent,
    listContent: note.listContent,
    labels: note.labels,
    color: note.color,
    isPinned: note.isPinned,
    isArchived: note.isArchived,
    isTrashed: note.isTrashed,
    ...changes
  };
}

async function updateNote(note, changes) {
  const response = await fetch(`/api/notes/${note.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notePayload(note, changes))
  });
  if (!response.ok) throw new Error(await response.text());
  const saved = await response.json();
  state.notes[state.notes.findIndex((item) => item.id === saved.id)] = saved;
  applyOrder();
  renderLabels();
  render();
}

async function moveToTop(note) {
  await updateNote(note, { isPinned: true });
  state.order.pinned = [note.id, ...orderedIds(true).filter((id) => id !== note.id)];
  applyOrder();
  render();
  const response = await fetch("/api/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.order)
  });
  if (!response.ok) throw new Error(await response.text());
}

function closeContextMenu() {
  elements.contextMenu.hidden = true;
  elements.contextMenu.replaceChildren();
}

function openContextMenu(note, x, y) {
  const colorOptions = Object.keys(colors).map((color) => `<button class="color-choice ${note.color === color ? "selected" : ""}" data-color="${color}" role="menuitem" title="${color}"><span style="background:${colors[color]}"></span></button>`).join("");
  elements.contextMenu.innerHTML = `
    <button data-action="top" role="menuitem">Sposta in cima</button>
    <button data-action="pinned" role="menuitem">${note.isPinned ? "Rimuovi da fissate" : "Fissa nota"}</button>
    <button data-action="archived" role="menuitem">${note.isArchived ? "Rimuovi dall'archivio" : "Archivia nota"}</button>
    <div class="context-divider"></div>
    <span class="context-label">Cambia colore</span>
    <div class="color-choices">${colorOptions}</div>`;
  elements.contextMenu.hidden = false;
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;
  const bounds = elements.contextMenu.getBoundingClientRect();
  elements.contextMenu.style.left = `${Math.min(x, window.innerWidth - bounds.width - 8)}px`;
  elements.contextMenu.style.top = `${Math.min(y, window.innerHeight - bounds.height - 8)}px`;
  elements.contextMenu.querySelector("[data-action='pinned']").focus();
  elements.contextMenu.onclick = (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    let changes;
    if (button.dataset.action === "top") {
      closeContextMenu();
      moveToTop(note).catch(() => alert("Impossibile spostare la nota in cima."));
      return;
    }
    if (button.dataset.action === "pinned") changes = { isPinned: !note.isPinned };
    if (button.dataset.action === "archived") changes = { isArchived: !note.isArchived };
    if (button.dataset.color) changes = { color: button.dataset.color };
    if (!changes) return;
    closeContextMenu();
    updateNote(note, changes).catch(() => alert("Impossibile aggiornare la nota."));
  };
}

function orderedIds(isPinned) {
  const group = isPinned ? "pinned" : "others";
  const known = state.notes.filter((note) => note.isPinned === isPinned).map((note) => note.id);
  const persisted = state.order[group].filter((id) => known.includes(id));
  return [...persisted, ...known.filter((id) => !persisted.includes(id))];
}

function applyOrder() {
  const ranks = {
    pinned: new Map(orderedIds(true).map((id, index) => [id, index])),
    others: new Map(orderedIds(false).map((id, index) => [id, index]))
  };
  state.notes.sort((a, b) => {
    const group = a.isPinned ? "pinned" : "others";
    return ranks[group].get(a.id) - ranks[group].get(b.id);
  });
}

async function moveNote(draggedId, targetId, isPinned, position) {
  const dragged = state.notes.find((note) => note.id === draggedId);
  if (!dragged || draggedId === targetId || dragged.isPinned !== isPinned) return;
  const group = isPinned ? "pinned" : "others";
  const ids = orderedIds(isPinned);
  ids.splice(ids.indexOf(draggedId), 1);
  ids.splice(ids.indexOf(targetId) + (position === "after" ? 1 : 0), 0, draggedId);
  state.order[group] = ids;
  applyOrder();
  render();
  const response = await fetch("/api/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.order)
  });
  if (!response.ok) {
    state.order = await fetch("/api/order").then((result) => result.json());
    applyOrder();
    render();
  }
}

function openNote(note) {
  elements.detail.style.backgroundColor = colors[note.color] || colors.DEFAULT;
  elements.detail.innerHTML = `${cardBody(note, true)}<footer>${note.labels.map((label) => `<em>${escapeHtml(label)}</em>`).join("")}<span>Modificata ${date(note.editedAt)}</span><button class="edit-note">Modifica</button></footer>`;
  elements.detail.querySelector(".edit-note").addEventListener("click", () => {
    elements.dialog.close();
    openEditor(note);
  });
  elements.dialog.showModal();
}

function checklistText(items) {
  return items.map((item) => `${item.isChecked ? "[x]" : "[ ]"} ${item.text}`).join("\n");
}

function parseChecklist(value) {
  return value.split("\n").map((line) => {
    const match = line.match(/^\s*\[(x| )\]\s*(.*)$/i);
    return { text: (match ? match[2] : line).trim(), isChecked: Boolean(match && match[1].toLowerCase() === "x") };
  }).filter((item) => item.text);
}

function openEditor(note) {
  elements.form.reset();
  pendingImages = new Map();
  editorSelection = null;
  elements.form.dataset.id = note?.id || "";
  elements.editorTitle.textContent = note ? "Modifica nota" : "Nuova nota";
  elements.titleInput.value = note?.title || "";
  elements.textInput.innerHTML = note?.textContentHtml || lines(note?.textContent || "");
  elements.textInput.querySelectorAll("img").forEach((image) => { image.draggable = true; });
  elements.listInput.value = checklistText(note?.listContent || []);
  elements.labelsInput.value = (note?.labels || []).join(", ");
  elements.colorInput.value = note?.color || "DEFAULT";
  elements.pinnedInput.checked = Boolean(note?.isPinned);
  elements.archivedInput.checked = Boolean(note?.isArchived);
  elements.saveError.textContent = "";
  elements.editor.showModal();
  elements.titleInput.focus();
}

async function saveNote(event) {
  event.preventDefault();
  const form = elements.form;
  const editorCopy = elements.textInput.cloneNode(true);
  editorCopy.querySelectorAll("img[data-pending-image]").forEach((image) => image.remove());
  const payload = editorPayload(editorCopy);
  const id = form.dataset.id;
  const response = await fetch(id ? `/api/notes/${id}` : "/api/notes", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    elements.saveError.textContent = await response.text() || "Impossibile salvare la nota.";
    return;
  }
  let saved = await response.json();
  try {
    const completedHtml = await uploadPendingImages(saved.id);
    if (completedHtml !== null) {
      const imageResponse = await fetch(`/api/notes/${saved.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editorPayload(completedHtml))
      });
      if (!imageResponse.ok) throw new Error(await imageResponse.text() || "Impossibile associare l'immagine alla nota.");
      saved = await imageResponse.json();
    }
  } catch (error) {
    form.dataset.id = saved.id;
    elements.editorTitle.textContent = "Modifica nota";
    elements.saveError.textContent = `Nota salvata, ma l'immagine non è stata aggiunta: ${error.message}`;
    const index = state.notes.findIndex((note) => note.id === saved.id);
    if (index === -1) state.notes.unshift(saved);
    else state.notes[index] = saved;
    renderLabels();
    render();
    return;
  }
  const index = state.notes.findIndex((note) => note.id === saved.id);
  if (index === -1) state.notes.unshift(saved);
  else state.notes[index] = saved;
  renderLabels();
  render();
  elements.editor.close();
}

function editorPayload(editor = elements.textInput) {
  return {
    title: elements.titleInput.value.trim(),
    textContent: editor.innerText,
    textContentHtml: editor.innerHTML,
    listContent: parseChecklist(elements.listInput.value),
    labels: elements.labelsInput.value.split(",").map((label) => label.trim()).filter(Boolean),
    color: elements.colorInput.value,
    isPinned: elements.pinnedInput.checked,
    isArchived: elements.archivedInput.checked,
    isTrashed: false
  };
}

function saveEditorSelection() {
  const selection = window.getSelection();
  if (selection.rangeCount && elements.textInput.contains(selection.anchorNode)) editorSelection = selection.getRangeAt(0).cloneRange();
}

function insertPendingImage(file, dataUrl) {
  const id = `pending-image-${++pendingImageNumber}`;
  pendingImages.set(id, { dataUrl, name: file.name || "Immagine" });
  const image = document.createElement("img");
  image.src = dataUrl;
  image.alt = file.name || "Immagine";
  image.draggable = true;
  image.dataset.pendingImage = id;
  const selection = window.getSelection();
  const range = editorSelection?.cloneRange();
  if (range && elements.textInput.contains(range.commonAncestorContainer)) {
    range.insertNode(image);
    range.setStartAfter(image);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    elements.textInput.append(image);
  }
  saveEditorSelection();
  elements.saveError.textContent = "";
}

async function uploadPendingImages(noteId) {
  const editorCopy = elements.textInput.cloneNode(true);
  const images = [...editorCopy.querySelectorAll("img[data-pending-image]")];
  if (!images.length) return null;
  for (const image of images) {
    const pending = pendingImages.get(image.dataset.pendingImage);
    if (!pending) throw new Error("Dati immagine mancanti.");
    const response = await fetch(`/api/notes/${noteId}/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending)
    });
    if (!response.ok) throw new Error(await response.text());
    const uploaded = await response.json();
    image.src = uploaded.url;
    image.removeAttribute("data-pending-image");
  }
  pendingImages = new Map();
  return editorCopy;
}

function renderLabels() {
  const labels = [...new Set(state.notes.flatMap((note) => note.labels))].sort((a, b) => a.localeCompare(b, "it"));
  elements.labels.innerHTML = labels.map((label) => `<button class="nav-item" data-label="${escapeHtml(label)}"><span>🏷</span>${escapeHtml(label)}</button>`).join("");
  elements.labels.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { state.label = button.dataset.label; state.filter = "notes"; render(); }));
}

document.querySelector("nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter; state.label = ""; render();
});
document.querySelectorAll("[data-section]").forEach((button) => button.addEventListener("click", () => {
  state.filter = "notes";
  state.label = "";
  render();
  const section = document.querySelector(`#${button.dataset.section}`);
  (section || elements.notes).scrollIntoView({ behavior: "smooth", block: "start" });
}));
elements.search.addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
elements.search.addEventListener("keydown", (event) => { if (event.key === "Escape") event.target.value = state.query = ""; render(); });
document.querySelector("#view-button").addEventListener("click", () => { state.grid = !state.grid; elements.notes.classList.toggle("grid", state.grid); elements.notes.classList.toggle("list", !state.grid); });
document.querySelector("#menu-button").addEventListener("click", () => document.body.classList.toggle("sidebar-hidden"));
document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#new-note").addEventListener("click", () => openEditor());
document.querySelector("#close-editor").addEventListener("click", () => elements.editor.close());
elements.form.addEventListener("submit", (event) => saveNote(event).catch(() => { elements.saveError.textContent = "Errore di connessione durante il salvataggio."; }));
document.querySelectorAll(".editor-toolbar [data-command]").forEach((button) => {
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    elements.textInput.focus();
    document.execCommand(button.dataset.command);
  });
});
elements.textInput.addEventListener("keyup", saveEditorSelection);
elements.textInput.addEventListener("mouseup", saveEditorSelection);
elements.textInput.addEventListener("input", saveEditorSelection);
elements.textInput.addEventListener("dragstart", (event) => {
  const image = event.target.closest("img");
  if (!image || !elements.textInput.contains(image)) return;
  draggedEditorImage = image;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", "");
});
elements.textInput.addEventListener("dragover", (event) => {
  if (!draggedEditorImage) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});
elements.textInput.addEventListener("drop", (event) => {
  if (!draggedEditorImage) return;
  event.preventDefault();
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && elements.textInput.contains(range.startContainer)) {
    range.insertNode(draggedEditorImage);
    range.setStartAfter(draggedEditorImage);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    elements.textInput.append(draggedEditorImage);
  }
  draggedEditorImage = null;
  saveEditorSelection();
});
elements.textInput.addEventListener("dragend", () => { draggedEditorImage = null; });
document.querySelector("#insert-image").addEventListener("click", () => {
  saveEditorSelection();
  elements.imageInput.click();
});
elements.imageInput.addEventListener("change", () => {
  const file = elements.imageInput.files[0];
  elements.imageInput.value = "";
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    elements.saveError.textContent = "Scegli un'immagine PNG, JPEG, GIF o WebP fino a 5 MB.";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => insertPendingImage(file, reader.result));
  reader.readAsDataURL(file);
});
document.querySelector("#block-style").addEventListener("change", (event) => {
  elements.textInput.focus();
  document.execCommand("formatBlock", false, event.target.value);
});
document.addEventListener("click", (event) => { if (!elements.contextMenu.hidden && !elements.contextMenu.contains(event.target)) closeContextMenu(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeContextMenu(); });
document.querySelector("#data-button").addEventListener("click", () => {
  elements.dataStatus.textContent = "";
  elements.dataDialog.showModal();
});
document.querySelector("#close-data").addEventListener("click", () => elements.dataDialog.close());
async function completeSetup(mode) {
  const response = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode })
  });
  if (!response.ok) throw new Error(await response.text());
}
document.querySelector("#setup-empty").addEventListener("click", () => {
  completeSetup("empty").then(() => elements.setupDialog.close()).catch((error) => { elements.setupError.textContent = error.message; });
});
document.querySelector("#setup-import").addEventListener("click", () => {
  completeSetup("import").then(() => {
    elements.setupDialog.close();
    elements.dataStatus.textContent = "";
    elements.dataDialog.showModal();
  }).catch((error) => { elements.setupError.textContent = error.message; });
});
const columnCount = document.querySelector("#column-count");
columnCount.value = state.maxColumns;
document.documentElement.style.setProperty("--max-columns", state.maxColumns);
elements.notes.dataset.columns = state.maxColumns;
columnCount.addEventListener("change", () => {
  state.maxColumns = Number(columnCount.value);
  localStorage.setItem("max-columns", state.maxColumns);
  document.documentElement.style.setProperty("--max-columns", state.maxColumns);
  elements.notes.dataset.columns = state.maxColumns;
});

document.querySelector("#note-color").innerHTML = Object.keys(colors).map((color) => `<option value="${color}">${color === "DEFAULT" ? "Predefinito" : color}</option>`).join("");

async function loadData() {
  const [notes, order, status] = await Promise.all([
  fetch("/api/notes").then((response) => response.ok ? response.json() : Promise.reject(new Error("Impossibile caricare le note"))),
  fetch("/api/order").then((response) => response.ok ? response.json() : Promise.reject(new Error("Impossibile caricare l'ordine delle note"))),
  fetch("/api/status").then((response) => response.ok ? response.json() : Promise.reject(new Error("Impossibile caricare lo stato iniziale")))
  ]);
  state.notes = notes; state.order = order; applyOrder(); renderLabels(); render();
  if (!status.notes && !status.setupCompleted) elements.setupDialog.showModal();
}

async function importZip() {
  const file = elements.importZip.files[0];
  if (!file) {
    elements.dataStatus.textContent = "Seleziona un archivio ZIP.";
    return;
  }
  elements.dataStatus.textContent = "Importazione ZIP in corso...";
  const response = await fetch("/api/import/zip", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/zip" },
    body: file
  });
  const result = await response.text();
  if (!response.ok) throw new Error(result);
  const data = JSON.parse(result);
  await loadData();
  elements.dataStatus.textContent = `Importate ${data.imported} note (${data.skipped} file ignorati).`;
}

async function exportZip() {
  const file = elements.exportZip.value.trim();
  if (!file) {
    elements.dataStatus.textContent = "Indica un file ZIP.";
    return;
  }
  elements.dataStatus.textContent = "Esportazione ZIP in corso...";
  const response = await fetch("/api/export/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file })
  });
  const result = await response.text();
  if (!response.ok) throw new Error(result);
  const data = JSON.parse(result);
  elements.dataStatus.textContent = `Esportate ${data.exported} note, ${data.attachments} allegati e ${data.images || 0} immagini in ${data.file}.`;
}

document.querySelector("#import-zip-button").addEventListener("click", () => importZip().catch((error) => { elements.dataStatus.textContent = error.message; }));
document.querySelector("#export-zip-button").addEventListener("click", () => exportZip().catch((error) => { elements.dataStatus.textContent = error.message; }));

loadData().catch((error) => { elements.empty.hidden = false; elements.empty.textContent = error.message; });
