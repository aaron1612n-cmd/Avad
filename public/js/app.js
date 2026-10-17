import { state, load, save, board, uid, normalize, normalizeItem, putFile, delFile, exportAll, importBoards, encodeBoard, decodeBoard } from "./store.js";
import { detect, detectFile } from "./detect.js";
import { h, renderBody, typeLabel, timers } from "./render.js";

const $ = (id) => document.getElementById(id);
const el = {
  boards: $("boards"), title: $("boardTitle"), count: $("count"), chip: $("chip"), input: $("input"),
  filters: $("filters"), wall: $("wall"), empty: $("empty"), shared: $("shared"), bar: $("bar"),
  stage: $("stage"), dlg: $("dlg"), dlgForm: $("dlgForm"), toast: $("toast"), drop: $("drop"),
};

let sharedBoard = null;
let filter = null;
const fetched = new Map();
const view = () => sharedBoard || board();
const readonly = () => !!sharedBoard;

// ---------- small helpers ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("on"), 1800);
}

function dialog(build) {
  return new Promise((resolve) => {
    el.dlgForm.replaceChildren();
    build(el.dlgForm);
    el.dlg.addEventListener("close", () => resolve(el.dlg.returnValue), { once: true });
    el.dlg.returnValue = "";
    el.dlg.showModal();
  });
}

const field = (label, control) => h("label", { text: label }, control);
const btn = (text, value, cls = "outline") => h("button", { type: "submit", value, class: cls, text, formnovalidate: value !== "ok" });

async function askText(title, value = "", label = "Name") {
  const input = h("input", { name: "v", value, maxlength: 80, required: true });
  const r = await dialog((f) => f.append(h("h2", { text: title }), field(label, input), h("div", { class: "row" }, btn("Cancel", "no"), btn("Save", "ok", "solid"))));
  return r === "ok" ? input.value.trim() : null;
}

async function confirm(title) {
  const r = await dialog((f) => f.append(h("h2", { text: title }), h("div", { class: "row" }, btn("Cancel", "no"), btn("Do it", "ok", "solid"))));
  return r === "ok";
}

// ---------- boot ----------
async function boot() {
  if (!load()) await seed();
  const m = location.hash.match(/^#b=(.+)$/);
  if (m) {
    try { sharedBoard = await decodeBoard(m[1]); } catch { toast("That share link is broken"); }
  }
  renderAll();
}

async function seed() {
  let data = { boards: [{ name: "Home", items: [] }] };
  try {
    const r = await fetch("/content.json", { cache: "no-cache" });
    if (r.ok) data = await r.json();
  } catch {}
  state.boards = data.boards.map(normalize);
  if (!state.boards.length) state.boards = [normalize({ name: "Home" })];
  state.current = state.boards[0].id;
  save();
}

// ---------- rendering ----------
function renderAll() {
  renderRail();
  renderTop();
  renderFilters();
  renderWall();
}

function renderRail() {
  el.boards.replaceChildren(...state.boards.map((b) => {
    const li = h("li", { "aria-current": String(!sharedBoard && b.id === state.current) },
      h("button", { class: "pick", type: "button", onclick: () => switchBoard(b.id) }, h("span", { text: b.name }), h("span", { class: "n", text: String(b.items.length) })));
    return li;
  }));
}

function renderTop() {
  const b = view();
  el.title.replaceChildren(readonly() ? b.name : h("button", { type: "button", title: "Rename", text: b.name, onclick: renameBoard }));
  el.count.textContent = `${b.items.length} ${b.items.length === 1 ? "plate" : "plates"}`;
  $("present").disabled = !b.items.length;
  el.shared.hidden = !readonly();
  el.bar.hidden = readonly();
  document.title = `${b.name} · Avad`;
}

function renderFilters() {
  const counts = new Map();
  for (const i of view().items) counts.set(typeLabel(i.type), (counts.get(typeLabel(i.type)) || 0) + 1);
  if (filter && !counts.has(filter)) filter = null;
  const mk = (label, key, n) => h("button", { type: "button", "aria-pressed": String(filter === key), text: `${label} ${n}`, onclick: () => { filter = filter === key ? null : key; renderFilters(); renderWall(); } });
  el.filters.replaceChildren(...(counts.size > 1 ? [...counts].map(([k, n]) => mk(k, k, n)) : []));
}

function plateFor(item, idx, { stamp = false } = {}) {
  const ro = readonly();
  const p = h("article", { class: "plate" + (stamp ? " stamp" : ""), "data-id": item.id, "data-type": typeLabel(item.type) });
  const acts = ro ? null : h("div", { class: "acts" },
    h("button", { type: "button", "aria-label": "Open full screen", text: "open", onclick: () => openStage(item.id) }),
    h("button", { type: "button", "aria-label": "Edit", text: "edit", onclick: () => editItem(item.id) }));
  p.append(
    h("header", { class: "plate-head" }, h("span", { text: "No. " + String(idx + 1).padStart(3, "0") }), h("span", { class: "plate-tools" }, h("span", { class: "kind", text: typeLabel(item.type) }), acts)),
    renderBody(item, { toast }),
    h("footer", { class: "plate-foot" },
      item.title ? h("h3", { class: "plate-title", text: item.title }) : null,
      item.caption ? h("p", { class: "plate-cap", text: item.caption }) : null));
  if (ro) p.addEventListener("dblclick", () => openStage(item.id));
  return p;
}

function renderWall(stampId) {
  timers.forEach(clearInterval); timers.clear();
  const b = view();
  const plates = b.items.map((it, i) => {
    const p = plateFor(it, i, { stamp: it.id === stampId });
    if (filter && typeLabel(it.type) !== filter) p.classList.add("hide");
    return p;
  });
  el.wall.replaceChildren(...plates);
  el.empty.hidden = b.items.length > 0 || readonly();
  b.items.filter((i) => i.type === "link" && !i.meta.fetched).forEach(unfurl);
  if (stampId) el.wall.querySelector(`[data-id="${stampId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function refreshPlate(item) {
  const old = el.wall.querySelector(`[data-id="${item.id}"]`);
  if (!old) return;
  const idx = view().items.indexOf(item);
  const p = plateFor(item, idx);
  if (old.classList.contains("hide")) p.classList.add("hide");
  old.replaceWith(p);
}

async function unfurl(item) {
  if (fetched.has(item.id)) return;
  fetched.set(item.id, true);
  try {
    const r = await fetch("/api/unfurl?url=" + encodeURIComponent(item.src));
    if (!r.ok) throw 0;
    const d = await r.json();
    item.meta = { ...item.meta, title: d.title, description: d.description, image: d.image, site: d.site, icon: d.icon, embeddable: d.embeddable, fetched: 1 };
    if (!readonly()) save();
    refreshPlate(item);
  } catch {}
}

// ---------- boards ----------
function switchBoard(id) {
  if (sharedBoard) leaveShared();
  state.current = id;
  filter = null;
  save();
  renderAll();
}

async function renameBoard() {
  const b = board();
  const input = h("input", { name: "v", value: b.name, maxlength: 80, required: true });
  const r = await dialog((f) => f.append(h("h2", { text: "Board" }), field("Name", input),
    h("div", { class: "row" }, h("span", { class: "sp" }, btn("Delete board", "del")), btn("Cancel", "no"), btn("Save", "ok", "solid"))));
  if (r === "ok" && input.value.trim()) { b.name = input.value.trim(); save(); renderRail(); renderTop(); }
  else if (r === "del") removeBoard(b.id);
}

async function newBoard() {
  const name = await askText("New board", "", "Name");
  if (!name) return;
  const b = normalize({ name });
  state.boards.push(b);
  switchBoard(b.id);
  el.input.focus();
}

async function removeBoard(id) {
  const b = state.boards.find((x) => x.id === id);
  if (state.boards.length === 1) return toast("Keep at least one board");
  if (!(await confirm(`Delete “${b.name}” and its ${b.items.length} plates?`))) return;
  b.items.forEach((i) => i.file && delFile(i.file));
  state.boards = state.boards.filter((x) => x.id !== id);
  if (state.current === id) state.current = state.boards[0].id;
  save();
  renderAll();
}

function leaveShared() {
  sharedBoard = null;
  history.replaceState(null, "", location.pathname);
}

// ---------- adding ----------
function addItem(partial, { quiet = false } = {}) {
  const item = normalizeItem(partial);
  board().items.push(item);
  save();
  renderRail(); renderTop(); renderFilters();
  renderWall(quiet ? null : item.id);
  return item;
}

function addText(raw) {
  const d = detect(raw);
  if (!d) return false;
  addItem(d);
  return true;
}

async function addFiles(files) {
  if (readonly()) return;
  const list = [...files];
  let added = 0;
  for (const f of list) {
   try {
    const d = detectFile(f);
    const { asText, ...partial } = d;
    if (asText) {
      partial.text = await f.text();
    } else {
      partial.file = uid();
      await putFile(partial.file, f);
    }
    addItem(partial, { quiet: list.length > 1 });
    added++;
   } catch {
    toast("Could not add " + (f.name || "that file"));
   }
  }
  if (list.length > 1) renderWall();
  if (added) toast(added === 1 ? "Added" : `Added ${added}`);
}

function updateChip() {
  const d = detect(el.input.value);
  el.chip.textContent = d ? typeLabel(d.type) : "add";
  el.chip.dataset.on = String(!!d);
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, innerHeight * 0.4) + "px";
}

el.input.addEventListener("input", updateChip);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.bar.requestSubmit(); }
});
el.bar.addEventListener("submit", (e) => {
  e.preventDefault();
  if (addText(el.input.value)) { el.input.value = ""; updateChip(); }
});
for (const id of ["photos", "file"]) {
  $(id).addEventListener("change", (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    if (list.length) addFiles(list);
  });
}

// paste anywhere
document.addEventListener("paste", (e) => {
  if (readonly() || el.dlg.open || !el.stage.hidden) return;
  const files = e.clipboardData?.files;
  if (files?.length) { e.preventDefault(); addFiles(files); return; }
  if (e.target === el.input || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const t = e.clipboardData?.getData("text/plain");
  if (t) { e.preventDefault(); addText(t); }
});

// drop anywhere
let dragDepth = 0;
const hasPayload = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || t === "text/uri-list" || t === "text/plain");
document.addEventListener("dragenter", (e) => { if (readonly() || !hasPayload(e)) return; dragDepth++; el.drop.hidden = false; });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
document.addEventListener("dragover", (e) => { if (hasPayload(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
  if (readonly()) return;
  const dt = e.dataTransfer;
  if (dt.files.length) return addFiles(dt.files);
  const t = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (t) addText(t.split(/\r?\n/).find((l) => l && !l.startsWith("#")) || t);
});

// ---------- editing ----------
const URL_TYPES = new Set(["image", "video", "audio", "pdf", "link", "embed", "youtube", "vimeo"]);
const TEXT_TYPES = new Set(["note", "code", "csv", "json", "html", "color"]);

async function editItem(id) {
  const b = board();
  const i = b.items.findIndex((x) => x.id === id);
  const item = b.items[i];
  const title = h("input", { value: item.title, maxlength: 120 });
  const cap = h("input", { value: item.caption, maxlength: 240 });
  const src = URL_TYPES.has(item.type) && !item.file ? h("input", { value: item.src, type: "text", inputmode: "url", autocapitalize: "off", autocomplete: "off" }) : null;
  const text = TEXT_TYPES.has(item.type) ? h("textarea", { spellcheck: "false" }) : null;
  if (text) text.value = item.text;
  const when = item.type === "countdown" ? h("input", { type: "datetime-local", value: toLocal(item.meta.date) }) : null;
  const asEmbed = item.type === "link" || item.type === "embed"
    ? h("select", { class: "outline" }, h("option", { value: "link", text: "Card" }), h("option", { value: "embed", text: "Live page" }))
    : null;
  if (asEmbed) asEmbed.value = item.type;

  const r = await dialog((f) => f.append(
    h("h2", { text: "Edit plate" }),
    field("Title", title), field("Caption", cap),
    src && field("Address", src), text && field(item.type === "color" ? "Hex" : "Content", text),
    when && field("Date", when), asEmbed && field("Show as", asEmbed),
    h("div", { class: "row" },
      h("span", { class: "sp" }, btn("← Earlier", "up"), btn("Later →", "down"), btn("Delete", "del")),
      btn("Cancel", "no"), btn("Save", "ok", "solid"))));

  if (r === "ok") {
    item.title = title.value.trim(); item.caption = cap.value.trim();
    if (src) { item.src = src.value.trim(); if (item.type === "link") { item.meta = {}; fetched.delete(item.id); } }
    if (text) item.text = text.value;
    if (when?.value) item.meta = { ...item.meta, date: new Date(when.value).toISOString() };
    if (asEmbed) item.type = asEmbed.value;
  } else if (r === "up" && i > 0) [b.items[i - 1], b.items[i]] = [b.items[i], b.items[i - 1]];
  else if (r === "down" && i < b.items.length - 1) [b.items[i + 1], b.items[i]] = [b.items[i], b.items[i + 1]];
  else if (r === "del") {
    if (item.file) delFile(item.file);
    b.items.splice(i, 1);
  } else return;
  save();
  renderAll();
}

const toLocal = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// ---------- stage ----------
let stageList = [], stageIdx = 0, stageTimer = null, lastFocus = null;

function openStage(id) {
  stageList = view().items.filter((it) => !filter || typeLabel(it.type) === filter);
  if (!stageList.length) return;
  stageIdx = Math.max(0, stageList.findIndex((x) => x.id === id));
  lastFocus = document.activeElement;
  el.stage.hidden = false;
  document.body.style.overflow = "hidden";
  showStage();
  $("stageClose").focus();
}

function showStage() {
  const item = stageList[stageIdx];
  const all = view().items;
  $("stageNo").textContent = `No. ${String(all.indexOf(item) + 1).padStart(3, "0")} / ${all.length}`;
  $("stageTitle").textContent = item.title || typeLabel(item.type);
  $("stageCap").textContent = item.caption || "";
  const body = renderBody(item, { big: true, toast });
  const textual = ["note", "code", "csv", "json", "countdown", "link", "file"].includes(item.type);
  const holder = h("div", { class: textual && item.type !== "countdown" ? "plate-like" : "" }, body);
  $("stageBody").replaceChildren(holder);
}

function stageMove(d) {
  stageIdx = (stageIdx + d + stageList.length) % stageList.length;
  showStage();
}

function closeStage() {
  el.stage.hidden = true;
  document.body.style.overflow = "";
  setStagePlay(false);
  $("stageBody").replaceChildren();
  lastFocus?.focus?.();
}

function setStagePlay(on) {
  clearInterval(stageTimer);
  $("stagePlay").setAttribute("aria-pressed", String(on));
  if (on) stageTimer = setInterval(() => stageMove(1), 6000);
}

$("present").addEventListener("click", () => openStage(view().items[0]?.id));
$("stageClose").addEventListener("click", closeStage);
$("stagePrev").addEventListener("click", () => stageMove(-1));
$("stageNext").addEventListener("click", () => stageMove(1));
$("stagePlay").addEventListener("click", (e) => setStagePlay(e.currentTarget.getAttribute("aria-pressed") !== "true"));
let sx = 0;
el.stage.addEventListener("touchstart", (e) => (sx = e.changedTouches[0].clientX), { passive: true });
el.stage.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - sx;
  if (Math.abs(dx) > 60) stageMove(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener("keydown", (e) => {
  if (!el.stage.hidden) {
    if (e.key === "Escape") closeStage();
    else if (e.key === "ArrowRight") stageMove(1);
    else if (e.key === "ArrowLeft") stageMove(-1);
    return;
  }
  if (e.key === "/" && !el.dlg.open && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !readonly()) {
    e.preventDefault();
    el.input.focus();
  }
});

// ---------- rail tools ----------
$("newBoard").addEventListener("click", newBoard);
$("keep").addEventListener("click", () => {
  const b = sharedBoard;
  state.boards.push(b);
  state.current = b.id;
  leaveShared();
  save();
  renderAll();
  toast("Kept");
});

$("share").addEventListener("click", async () => {
  const b = view();
  const hasFiles = b.items.some((i) => i.file);
  const url = `${location.origin}${location.pathname}#b=${await encodeBoard(b)}`;
  if (url.length > 60000) return toast("Too big for a link. Use Export.");
  try { await navigator.clipboard.writeText(url); toast(hasFiles ? "Copied (uploaded files skipped)" : "Link copied"); }
  catch { await dialog((f) => f.append(h("h2", { text: "Share link" }), field("Copy this", h("textarea", { readonly: true, text: url })), h("div", { class: "row" }, btn("Done", "ok", "solid")))); }
});

$("export").addEventListener("click", async () => {
  const blob = new Blob([await exportAll()], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "avad-export.json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const added = await importBoards(JSON.parse(await f.text()));
    if (!added.length) throw 0;
    state.boards.push(...added);
    switchBoard(added[0].id);
    toast(`Imported ${added.length} ${added.length === 1 ? "board" : "boards"}`);
  } catch { toast("Not an Avad export"); }
});

$("reset").addEventListener("click", async () => {
  if (!(await confirm("Replace everything with content.json?"))) return;
  state.boards.forEach((b) => b.items.forEach((i) => i.file && delFile(i.file)));
  fetched.clear();
  if (sharedBoard) leaveShared();
  await seed();
  renderAll();
});

const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $("theme").textContent = "Theme: " + t;
}
let theme = "auto";
try { theme = localStorage.getItem("avad:theme") || "auto"; } catch {}
applyTheme(theme);
$("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("avad:theme", theme); } catch {}
  applyTheme(theme);
});

window.addEventListener("hashchange", async () => {
  const m = location.hash.match(/^#b=(.+)$/);
  if (!m) return;
  try { sharedBoard = await decodeBoard(m[1]); renderAll(); } catch { toast("That share link is broken"); }
});

boot();
