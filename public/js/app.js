import { state, mode, hooks, load, loadServer, save, board, normalize, normalizeItem, saveBlob, dropBlob, shrinkImage, exportAll, importBoards, encodeBoard, decodeBoard } from "./store.js";
import { detect, detectMany, detectFile, resolveZone } from "./detect.js";
import { h, renderBody, typeLabel, timers, resolveSrc, htmlDoc } from "./render.js";

const $ = (id) => document.getElementById(id);
const el = {
  boards: $("boards"), title: $("boardTitle"), count: $("count"), chip: $("chip"), input: $("input"),
  filters: $("filters"), wall: $("wall"), empty: $("empty"), shared: $("shared"), bar: $("bar"),
  stage: $("stage"), dlg: $("dlg"), dlgForm: $("dlgForm"), toast: $("toast"), drop: $("drop"),
};

let sharedBoard = null;
let filter = null;
let tagFilter = null;
let query = "";
let selecting = false;
const selected = new Set();
const fetched = new Map();
const view = () => sharedBoard || board();
const readonly = () => !!sharedBoard || (mode.server && !mode.admin);

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
    el.dlg.returnValue = "";
    const done = () => resolve(el.dlg.returnValue);
    el.dlg.addEventListener("close", done, { once: true });
    // Close it ourselves so older mobile browsers that lack <dialog> still work.
    el.dlgForm.onsubmit = (e) => {
      e.preventDefault();
      el.dlg.returnValue = e.submitter?.value ?? "";
      if (el.dlg.close) el.dlg.close();
      else { el.dlg.removeAttribute("open"); el.dlg.dispatchEvent(new Event("close")); }
    };
    if (el.dlg.showModal) el.dlg.showModal();
    else el.dlg.setAttribute("open", "");
  });
}

// If something breaks on a phone, say so instead of silently doing nothing.
window.addEventListener("error", (e) => toast("Error: " + String(e.message || e.error).slice(0, 90)));
window.addEventListener("unhandledrejection", (e) => toast("Error: " + String(e.reason?.message || e.reason).slice(0, 90)));

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
  hooks.onConflict = () => { toast("Changed on another device. Reloading."); setTimeout(() => location.reload(), 1200); };
  hooks.onAuthLost = () => { toast("Signed out. Sign in again to edit."); renderAll(); };
  const srv = await loadServer();
  if (srv === false) { if (!load()) await seed(); }
  else if (srv === "empty") { await seed(); }
  const m = location.hash.match(/^#b=(.+)$/);
  if (m) {
    try { sharedBoard = await decodeBoard(m[1]); } catch { toast("That share link is broken"); }
  }
  renderAll();
  setTimeout(optimizeExisting, 1500);
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
function renderChrome() {
  const owner = !mode.server || mode.admin;
  for (const id of ["newBoard", "import", "reset", "export"]) $(id).hidden = !owner || !!sharedBoard;
  $("auth").hidden = !mode.server;
  $("auth").textContent = mode.admin ? "Sign out" : "Owner sign in";
}

function renderAll() {
  renderChrome();
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
  $("renameBoard").hidden = $("deleteBoard").hidden = $("selectMode").hidden = readonly();
  $("widgets").hidden = readonly();
  el.shared.hidden = !sharedBoard;
  el.bar.hidden = readonly();
  document.title = `${b.name} · Avad`;
}

const hashtags = (t) => [...(t || "").matchAll(/(?:^|\s)#([a-z][\w-]{1,30})/gi)].map((m) => m[1].toLowerCase());
const tagsOf = (it) => [...new Set([...(it.tags || []), ...hashtags(`${it.title} ${it.caption}`)])];

function matches(it) {
  if (filter && typeLabel(it.type) !== filter) return false;
  if (tagFilter && !tagsOf(it).includes(tagFilter)) return false;
  if (query) {
    const m = it.meta || {};
    const hay = [it.title, it.caption, it.type, typeLabel(it.type), it.type === "json" ? "" : it.text, it.src, m.name, m.title, m.description, m.city, m.zone, ...tagsOf(it)].join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  return true;
}

function renderFilters() {
  const counts = new Map();
  const tags = new Map();
  for (const i of view().items) {
    counts.set(typeLabel(i.type), (counts.get(typeLabel(i.type)) || 0) + 1);
    tagsOf(i).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
  }
  if (filter && !counts.has(filter)) filter = null;
  if (tagFilter && !tags.has(tagFilter)) tagFilter = null;
  const mk = (label, active, n, fn) => h("button", { type: "button", "aria-pressed": String(active), text: `${label} ${n}`, onclick: fn });
  const typeBtns = counts.size > 1 ? [...counts].map(([k, n]) => mk(k, filter === k, n, () => { filter = filter === k ? null : k; renderFilters(); applyFilters(); })) : [];
  const tagBtns = [...tags].sort((a, b) => b[1] - a[1]).map(([k, n]) => mk("#" + k, tagFilter === k, n, () => { tagFilter = tagFilter === k ? null : k; renderFilters(); applyFilters(); }));
  el.filters.replaceChildren(...typeBtns, ...tagBtns);
}

function applyFilters() {
  const items = view().items;
  let shown = 0;
  for (const p of el.wall.children) {
    const it = items.find((x) => x.id === p.dataset.id);
    const ok = it && matches(it);
    p.classList.toggle("hide", !ok);
    if (ok) shown++;
  }
  const filtering = !!(filter || tagFilter || query);
  el.count.textContent = filtering ? `${shown} of ${items.length}` : `${items.length} ${items.length === 1 ? "plate" : "plates"}`;
  el.empty.hidden = items.length > 0 ? shown > 0 : readonly();
  if (items.length && !shown) el.empty.textContent = "No matches.";
  else el.empty.innerHTML = "Nothing here yet. Tap <b>Photos</b> to add pictures, <b>Files</b> for anything else, or paste a link above.";
}

$("q").addEventListener("input", (e) => { query = e.target.value.trim(); applyFilters(); });

function plateFor(item, idx, { stamp = false } = {}) {
  const ro = readonly();
  const p = h("article", { class: "plate" + (stamp ? " stamp" : ""), "data-id": item.id, "data-type": typeLabel(item.type) });
  const acts = ro ? null : h("div", { class: "acts" },
    h("button", { type: "button", "aria-label": "Open full screen", text: "open", onclick: () => openStage(item.id) }),
    h("button", { type: "button", "aria-label": "Edit", text: "edit", onclick: () => editItem(item.id) }),
    h("button", { type: "button", "aria-label": "Delete", text: "delete", onclick: () => removeItem(item.id) }));
  const grip = ro ? null : h("span", { class: "grip", role: "button", tabindex: "-1", "aria-label": "Drag to reorder", title: "Drag to reorder", onpointerdown: (e) => startDrag(e, item, p) });
  const tags = tagsOf(item);
  if (selected.has(item.id)) p.classList.add("sel");
  p.append(
    h("header", { class: "plate-head" }, h("span", { class: "no" }, grip, "No. " + String(idx + 1).padStart(3, "0")), h("span", { class: "plate-tools" }, h("span", { class: "kind", text: typeLabel(item.type) }), acts)),
    renderBody(item, { toast, editable: !ro, onChange: save }),
    h("footer", { class: "plate-foot" },
      item.title ? h("h3", { class: "plate-title", text: item.title }) : null,
      item.caption ? h("p", { class: "plate-cap", text: item.caption }) : null,
      tags.length ? h("p", { class: "plate-tags" }, tags.map((t) => h("button", { type: "button", text: "#" + t, onclick: () => { tagFilter = tagFilter === t ? null : t; renderFilters(); applyFilters(); } }))) : null));
  if (ro) p.addEventListener("dblclick", () => openStage(item.id));
  return p;
}

function renderWall(stampId) {
  timers.forEach(clearInterval); timers.clear();
  const b = view();
  const plates = b.items.map((it, i) => {
    return plateFor(it, i, { stamp: it.id === stampId });
  });
  el.wall.replaceChildren(...plates);
  applyFilters();
  if (!readonly()) b.items.filter((i) => i.type === "link" && !i.meta.fetched).forEach(unfurl);
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

// Shrink photos that were uploaded before resizing existed, one at a time, so old boards get fast too.
let optimizing = false;
async function optimizeExisting() {
  if (optimizing || !mode.server || !mode.admin) return;
  const todo = state.boards.flatMap((b) => b.items).filter((i) => i.type === "image" && i.src?.startsWith("/api/file/") && (i.meta?.size || 0) > 400 * 1024 && !i.meta.opt);
  if (!todo.length) return;
  optimizing = true;
  toast("Making photos load faster…");
  for (const item of todo) {
    try {
      const blob = await (await fetch(item.src)).blob();
      const small = await shrinkImage(blob);
      if (small !== blob) {
        const saved = await saveBlob(small);
        dropBlob(item);
        item.src = saved.src;
        item.meta = { ...item.meta, size: saved.size, opt: 1 };
      } else {
        item.meta = { ...item.meta, opt: 1 };
      }
      save();
      refreshPlate(item);
    } catch {}
  }
  optimizing = false;
  toast("Photos are faster now");
}

// ---------- boards ----------
function switchBoard(id) {
  if (sharedBoard) leaveShared();
  state.current = id;
  filter = null; tagFilter = null; query = ""; $("q").value = "";
  selecting = false; selected.clear(); syncSelect();
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
  if (state.boards.length === 1) return toast("Make a second board first (+ New board)");
  if (!(await confirm(`Delete “${b.name}” and its ${b.items.length} plates?`))) return;
  b.items.forEach(dropBlob);
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
  const found = detectMany(raw);
  if (!found.length) return false;
  if (found.length === 1) addItem(found[0]);
  else {
    found.forEach((d) => addItem(d, { quiet: true }));
    renderWall();
    toast(`Added ${found.length}`);
  }
  return true;
}

async function addFiles(files) {
  if (readonly()) return;
  const list = [...files];
  let added = 0;
  for (const [n, f] of list.entries()) {
   if (list.length > 1) toast(`Adding ${n + 1} of ${list.length}…`);
   try {
    const d = detectFile(f);
    const { asText, ...partial } = d;
    if (asText) {
      partial.text = await f.text();
    } else {
      const saved = await saveBlob(f);
      partial.meta = { ...partial.meta, size: saved.size, opt: 1 };
      delete saved.size;
      Object.assign(partial, saved);
    }
    addItem(partial, { quiet: list.length > 1 });
    added++;
   } catch (e) {
    toast(e?.message && e.message !== "upload failed" ? e.message : "Could not add " + (f.name || "that file"));
   }
  }
  if (list.length > 1) renderWall();
  if (added) toast(added === 1 ? "Added" : `Added ${added}`);
}

function updateChip() {
  const found = detectMany(el.input.value);
  el.chip.textContent = !found.length ? "add" : found.length > 1 ? `${found.length} items` : typeLabel(found[0].type);
  el.chip.dataset.on = String(found.length > 0);
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
  const uris = dt.getData("text/uri-list");
  const t = uris ? uris.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).join("\n") : dt.getData("text/plain");
  if (t) addText(t);
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
  const src = URL_TYPES.has(item.type) && !item.file && !item.src.startsWith("/api/file/") ? h("input", { value: item.src, type: "text", inputmode: "url", autocapitalize: "off", autocomplete: "off" }) : null;
  const text = TEXT_TYPES.has(item.type) ? h("textarea", { spellcheck: "false" }) : null;
  if (text) text.value = item.text;
  const when = item.type === "countdown" ? h("input", { type: "datetime-local", value: toLocal(item.meta.date) }) : null;
  const asEmbed = item.type === "link" || item.type === "embed"
    ? h("select", { class: "outline" }, h("option", { value: "link", text: "Card" }), h("option", { value: "embed", text: "Live page" }))
    : null;
  if (asEmbed) asEmbed.value = item.type;
  const tagsIn = h("input", { value: (item.tags || []).join(" "), maxlength: 200, autocapitalize: "off", placeholder: "trip ideas" });
  const META = { weather: [["City", "city"]], clock: [["Time zone", "zone"]], timer: [["Seconds (0 = stopwatch)", "seconds"]], price: [["Coin", "base"], ["Currency", "quote"]] };
  const metaIn = (META[item.type] || []).map(([label, key]) => [label, key, h("input", { value: item.meta[key] ?? "", maxlength: 60, autocapitalize: "off" })]);

  const r = await dialog((f) => f.append(
    h("h2", { text: "Edit plate" }),
    field("Title", title), field("Caption", cap), ...metaIn.map(([label, , input]) => field(label, input)),
    src && field("Address", src), text && field(item.type === "color" ? "Hex" : "Content", text),
    when && field("Date", when), asEmbed && field("Show as", asEmbed), field("Tags (space between)", tagsIn),
    h("div", { class: "row" },
      h("span", { class: "sp" }, btn("← Earlier", "up"), btn("Later →", "down"), btn("Delete", "del"), item.type === "html" ? btn("Tweak with AI", "ai") : null),
      btn("Cancel", "no"), btn("Save", "ok", "solid"))));

  if (r === "ok") {
    item.title = title.value.trim(); item.caption = cap.value.trim();
    if (src) { item.src = src.value.trim(); if (item.type === "link") { item.meta = {}; fetched.delete(item.id); } }
    if (text) item.text = text.value;
    if (when?.value) item.meta = { ...item.meta, date: new Date(when.value).toISOString() };
    if (asEmbed) item.type = asEmbed.value;
    item.tags = [...new Set(tagsIn.value.split(/[\s,]+/).map((t) => t.replace(/^#+/, "").toLowerCase()).filter((t) => /^[\p{L}\d_-]{1,30}$/u.test(t)))];
    for (const [, key, input] of metaIn) {
      const v = input.value.trim();
      if (item.type === "clock" && key === "zone") { const z = resolveZone(v); if (z) item.meta.zone = z; else toast("Unknown time zone, kept the old one"); }
      else if (item.type === "timer") item.meta.seconds = Math.max(0, Number(v) || 0);
      else if (item.type === "price") item.meta[key] = v.toUpperCase() || item.meta[key];
      else if (v) item.meta[key] = v;
    }
  } else if (r === "ai") {
    return openStudio(item);
  } else if (r === "up" && i > 0) [b.items[i - 1], b.items[i]] = [b.items[i], b.items[i - 1]];
  else if (r === "down" && i < b.items.length - 1) [b.items[i + 1], b.items[i]] = [b.items[i], b.items[i + 1]];
  else if (r === "del") {
    dropBlob(item);
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

async function removeItem(id) {
  const b = board();
  const i = b.items.findIndex((x) => x.id === id);
  if (i < 0 || !(await confirm("Delete this plate?"))) return;
  dropBlob(b.items[i]);
  b.items.splice(i, 1);
  save();
  renderAll();
}

// ---------- stage ----------
let stageList = [], stageIdx = 0, stageTimer = null, lastFocus = null, playing = false, idleTimer = null, wake = null, bgm = null;
const hist = [];
const SPEEDS = [3, 6, 10, 20, 30];
let prefs = { shuffle: false, speed: 6 };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem("avad:stage") || "{}") }; } catch {}
const savePrefs = () => { try { localStorage.setItem("avad:stage", JSON.stringify(prefs)); } catch {} };

function openStage(id) {
  stageList = view().items.filter(matches);
  if (!stageList.length) return;
  stageIdx = Math.max(0, stageList.findIndex((x) => x.id === id));
  hist.length = 0;
  lastFocus = document.activeElement;
  el.stage.hidden = false;
  document.body.style.overflow = "hidden";
  $("stageShuffle").setAttribute("aria-pressed", String(prefs.shuffle));
  $("stageSpeed").textContent = prefs.speed + "s";
  $("stageMusic").hidden = !view().items.some((i) => i.type === "audio");
  $("stageFull").hidden = !el.stage.requestFullscreen;
  showStage();
  $("stageClose").focus();
}

const WIDGETS_PLAIN = new Set(["countdown", "weather", "clock", "timer", "price"]);

function showStage() {
  const item = stageList[stageIdx];
  const all = view().items;
  $("stageNo").textContent = `No. ${String(all.indexOf(item) + 1).padStart(3, "0")} / ${all.length}`;
  $("stageTitle").textContent = item.title || typeLabel(item.type);
  $("stageCap").textContent = item.caption || "";
  const body = renderBody(item, { big: true, toast, editable: !readonly(), onChange: save });
  const framed = ["note", "code", "csv", "json", "link", "file", "todo"].includes(item.type);
  $("stageBody").replaceChildren(h("div", { class: framed ? "plate-like" : "" }, body));
  schedule();
}

function stageMove(d) {
  if (stageList.length < 2) return;
  if (d > 0 && prefs.shuffle) {
    hist.push(stageIdx);
    let n;
    do n = Math.floor(Math.random() * stageList.length); while (n === stageIdx);
    stageIdx = n;
  } else if (d < 0 && prefs.shuffle && hist.length) {
    stageIdx = hist.pop();
  } else {
    stageIdx = (stageIdx + d + stageList.length) % stageList.length;
  }
  showStage();
}

function schedule() {
  clearTimeout(stageTimer);
  if (!playing) return;
  const next = () => stageMove(1);
  const wait = () => (stageTimer = setTimeout(next, prefs.speed * 1000));
  if (stageList[stageIdx].type !== "video") return wait();
  // videos play through before moving on
  stageTimer = setTimeout(() => {
    const v = $("stageBody").querySelector("video");
    if (!v) return wait();
    v.addEventListener("ended", next, { once: true });
    v.play().catch(wait);
    stageTimer = setTimeout(next, 180000);
  }, 400);
}

async function setStagePlay(on) {
  playing = on;
  $("stagePlay").setAttribute("aria-pressed", String(on));
  clearTimeout(stageTimer);
  clearTimeout(idleTimer);
  el.stage.classList.remove("idle");
  if (on) {
    schedule();
    bump();
    try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  } else {
    try { await wake?.release(); } catch {}
    wake = null;
  }
}

function bump() {
  el.stage.classList.remove("idle");
  clearTimeout(idleTimer);
  if (playing) idleTimer = setTimeout(() => el.stage.classList.add("idle"), 3000);
}
["pointermove", "pointerdown", "keydown", "touchstart"].forEach((t) => el.stage.addEventListener(t, bump, { passive: true }));

async function setMusic(on) {
  $("stageMusic").setAttribute("aria-pressed", String(on));
  if (!on) { bgm?.pause(); bgm = null; return; }
  const tracks = view().items.filter((i) => i.type === "audio");
  if (!tracks.length) return;
  let n = 0;
  bgm = new Audio();
  bgm.volume = 0.6;
  const play = async () => {
    bgm.src = await resolveSrc(tracks[n % tracks.length]);
    n++;
    bgm.play().catch(() => toast("Tap Music again to start it"));
  };
  bgm.addEventListener("ended", play);
  play();
}

function closeStage() {
  el.stage.hidden = true;
  document.body.style.overflow = "";
  setStagePlay(false);
  setMusic(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  $("stageBody").replaceChildren();
  lastFocus?.focus?.();
}

$("present").addEventListener("click", () => openStage(view().items.find(matches)?.id));
$("stageClose").addEventListener("click", closeStage);
$("stagePrev").addEventListener("click", () => stageMove(-1));
$("stageNext").addEventListener("click", () => stageMove(1));
$("stagePlay").addEventListener("click", (e) => setStagePlay(e.currentTarget.getAttribute("aria-pressed") !== "true"));
$("stageShuffle").addEventListener("click", (e) => { prefs.shuffle = !prefs.shuffle; e.currentTarget.setAttribute("aria-pressed", String(prefs.shuffle)); hist.length = 0; savePrefs(); });
$("stageSpeed").addEventListener("click", (e) => {
  prefs.speed = SPEEDS[(SPEEDS.indexOf(prefs.speed) + 1) % SPEEDS.length];
  e.currentTarget.textContent = prefs.speed + "s";
  savePrefs();
  schedule();
});
$("stageMusic").addEventListener("click", (e) => setMusic(e.currentTarget.getAttribute("aria-pressed") !== "true"));
$("stageFull").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : el.stage.requestFullscreen().catch(() => {})));
let sx = 0;
el.stage.addEventListener("touchstart", (e) => (sx = e.changedTouches[0].clientX), { passive: true });
el.stage.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - sx;
  if (Math.abs(dx) > 60) stageMove(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener("keydown", (e) => {
  if (!el.stage.hidden) {
    if (e.key === "Escape" && !document.fullscreenElement) closeStage();
    else if (e.key === "ArrowRight") stageMove(1);
    else if (e.key === "ArrowLeft") stageMove(-1);
    else if (e.key === " " && !/^(INPUT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) { e.preventDefault(); setStagePlay(!playing); }
    return;
  }
  if (e.key === "/" && !el.dlg.open && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    e.preventDefault();
    (readonly() ? $("q") : el.input).focus();
  }
});

// ---------- select many ----------
function syncSelect() {
  $("selectMode").textContent = selecting ? "Done" : "Select";
  $("selectMode").setAttribute("aria-pressed", String(selecting));
  el.wall.classList.toggle("selecting", selecting);
  $("selbar").hidden = !selecting;
  document.body.classList.toggle("selecting-on", selecting);
  $("selCount").textContent = `${selected.size} selected`;
  for (const id of ["selUp", "selDown", "selMove", "selDelete"]) $(id).disabled = !selected.size;
  for (const p of el.wall.children) p.classList.toggle("sel", selected.has(p.dataset.id));
}

$("selectMode").addEventListener("click", () => {
  selecting = !selecting;
  if (!selecting) selected.clear();
  syncSelect();
});

el.wall.addEventListener("click", (e) => {
  if (!selecting) return;
  const p = e.target.closest(".plate");
  if (!p) return;
  e.preventDefault();
  e.stopPropagation();
  selected.has(p.dataset.id) ? selected.delete(p.dataset.id) : selected.add(p.dataset.id);
  syncSelect();
}, true);

$("selAll").addEventListener("click", () => {
  const all = view().items.filter(matches);
  if (all.every((i) => selected.has(i.id))) selected.clear();
  else all.forEach((i) => selected.add(i.id));
  syncSelect();
});

function shiftSelected(dir) {
  const items = board().items;
  const order = dir < 0 ? items.map((_, i) => i) : items.map((_, i) => i).reverse();
  for (const i of order) {
    const j = i + dir;
    if (selected.has(items[i].id) && items[j] && !selected.has(items[j].id)) [items[i], items[j]] = [items[j], items[i]];
  }
  save();
  renderWall();
  syncSelect();
}
$("selUp").addEventListener("click", () => shiftSelected(-1));
$("selDown").addEventListener("click", () => shiftSelected(1));

$("selMove").addEventListener("click", async () => {
  const others = state.boards.filter((b) => b.id !== state.current);
  const r = await dialog((f) => f.append(
    h("h2", { text: `Move ${selected.size} to…` }),
    h("div", { class: "row", style: "justify-content:flex-start" }, others.map((b) => btn(b.name, b.id)), btn("+ New board", "__new")),
    h("div", { class: "row" }, btn("Cancel", "no"))));
  if (!r || r === "no") return;
  let target;
  if (r === "__new") {
    const name = await askText("New board", "", "Name");
    if (!name) return;
    target = normalize({ name });
    state.boards.push(target);
  } else target = state.boards.find((b) => b.id === r);
  if (!target) return;
  const cur = board();
  target.items.push(...cur.items.filter((i) => selected.has(i.id)));
  cur.items = cur.items.filter((i) => !selected.has(i.id));
  selected.clear();
  save();
  renderAll();
  syncSelect();
  toast(`Moved to ${target.name}`);
});

$("selDelete").addEventListener("click", async () => {
  if (!(await confirm(`Delete ${selected.size} plates?`))) return;
  const cur = board();
  cur.items.filter((i) => selected.has(i.id)).forEach(dropBlob);
  cur.items = cur.items.filter((i) => !selected.has(i.id));
  selected.clear();
  selecting = false;
  save();
  renderAll();
  syncSelect();
});

// ---------- drag to reorder ----------
let drag = null;
function startDrag(e, item, plate) {
  if (selecting || (e.button != null && e.button !== 0)) return;
  e.preventDefault();
  drag = { item, plate, target: null, after: false, x: e.clientX, y: e.clientY };
  plate.classList.add("dragging");
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  (function loop() {
    if (!drag) return;
    if (drag.y < 90) scrollBy(0, -16);
    else if (drag.y > innerHeight - 90) scrollBy(0, 16);
    requestAnimationFrame(loop);
  })();
}

function clearMarks() {
  el.wall.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
}

function onDrag(e) {
  if (!drag) return;
  drag.x = e.clientX; drag.y = e.clientY;
  clearMarks();
  const t = document.elementFromPoint(e.clientX, e.clientY)?.closest(".plate");
  if (t && t !== drag.plate && el.wall.contains(t)) {
    const r = t.getBoundingClientRect();
    drag.after = e.clientY > r.top + r.height / 2;
    drag.target = t;
    t.classList.add(drag.after ? "drop-after" : "drop-before");
  } else drag.target = null;
}

function endDrag() {
  window.removeEventListener("pointermove", onDrag);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  document.body.classList.remove("is-dragging");
  clearMarks();
  const d = drag;
  drag = null;
  if (!d) return;
  d.plate.classList.remove("dragging");
  if (!d.target) return;
  const items = board().items;
  const dest = items.find((x) => x.id === d.target.dataset.id);
  items.splice(items.indexOf(d.item), 1);
  items.splice(items.indexOf(dest) + (d.after ? 1 : 0), 0, d.item);
  save();
  renderWall();
}


// ---------- AI studio ----------
let studioItem = null, studioHtml = "", studioHist = [], studioBusy = false;
const studio = $("studio");

const cleanHtml = (t) => {
  let out = t.replace(/^\s*```(?:html)?\s*/i, "").replace(/```\s*$/, "");
  const i = out.search(/<!doctype|<html/i);
  if (i > 0) out = out.slice(i);
  return out.trim();
};

function studioMedia() {
  return view().items.filter((i) => ["image", "video", "audio"].includes(i.type) && i.src && !i.file);
}

function studioShow(html) {
  studioHtml = html;
  $("studioFrame").srcdoc = html ? htmlDoc(html) : "";
  $("studioSave").disabled = !html;
  $("studioUndo").disabled = !studioHist.length;
}

async function openStudio(item = null) {
  studioItem = item;
  studioHist = [];
  $("studioPrompt").value = item?.meta?.prompt || "";
  $("studioLinks").value = "";
  $("studioStatus").textContent = "";
  $("studioGo").textContent = item ? "Change it" : "Make it";
  const list = studioMedia();
  $("studioMedia").hidden = !list.length;
  $("mediaList").replaceChildren(...list.map((i) => h("label", { class: "chk" },
    h("input", { type: "checkbox", value: i.id }), h("span", { text: `${typeLabel(i.type)}: ${i.title || i.meta?.name || i.src.split("/").pop()}` }))));
  studioShow(item ? item.text : "");
  studio.hidden = false;
  document.body.style.overflow = "hidden";
  $("studioProv").textContent = "checking AI…";
  try {
    const r = await fetch("/api/widget");
    const d = await r.json();
    $("studioProv").textContent = d.provider === "claude" ? "Claude" : d.provider === "workers-ai" ? "Cloudflare Workers AI (free)" : "";
    if (!d.provider) $("studioStatus").textContent = "AI is not set up yet.";
    $("studioGo").disabled = !d.provider;
  } catch {
    $("studioProv").textContent = "";
    $("studioStatus").textContent = "Sign in as owner to use AI.";
    $("studioGo").disabled = true;
  }
  $("studioPrompt").focus();
}

function closeStudio() {
  studio.hidden = true;
  document.body.style.overflow = "";
  $("studioFrame").srcdoc = "";
}

$("studioClose").addEventListener("click", closeStudio);

$("studioGo").addEventListener("click", async () => {
  if (studioBusy) return;
  const prompt = $("studioPrompt").value.trim();
  if (!prompt) return $("studioPrompt").focus();
  const picked = [...$("mediaList").querySelectorAll("input:checked")].map((c) => view().items.find((i) => i.id === c.value)).filter(Boolean);
  const media = picked.map((i) => ({ kind: i.type, url: i.src, name: i.title || i.meta?.name }));
  for (const line of $("studioLinks").value.split(/\r?\n/)) {
    const u = line.trim();
    if (/^https?:\/\//i.test(u)) media.push({ kind: /\.(mp4|webm|mov|m4v)$/i.test(u) ? "video" : /\.(mp3|wav|ogg|m4a)$/i.test(u) ? "audio" : "image", url: u });
  }
  studioBusy = true;
  $("studioGo").disabled = true;
  const t0 = Date.now();
  let buf = "";
  try {
    const r = await fetch("/api/widget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, current: studioHtml, media }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      $("studioStatus").textContent = `Writing… ${buf.length.toLocaleString()} characters, ${Math.round((Date.now() - t0) / 1000)}s`;
    }
    const html = cleanHtml(buf);
    if (!/<\w/.test(html)) throw new Error("The AI did not return a widget. Try again.");
    if (studioHtml) studioHist.push(studioHtml);
    studioShow(html);
    $("studioGo").textContent = "Change it";
    $("studioStatus").textContent = `Done in ${Math.round((Date.now() - t0) / 1000)}s. Describe a change and tap Change it, or save it.`;
    $("studioPrompt").value = "";
  } catch (e) {
    $("studioStatus").textContent = e.message || "Something went wrong.";
  } finally {
    studioBusy = false;
    $("studioGo").disabled = false;
  }
  studioLastPrompt = prompt;
});
let studioLastPrompt = "";

$("studioUndo").addEventListener("click", () => {
  if (studioHist.length) studioShow(studioHist.pop());
});

$("studioSave").addEventListener("click", () => {
  if (!studioHtml) return;
  const prompt = studioLastPrompt || studioItem?.meta?.prompt || "AI widget";
  if (studioItem) {
    studioItem.text = studioHtml;
    studioItem.meta = { ...studioItem.meta, ai: true, prompt };
    save();
    renderAll();
  } else {
    addItem({ type: "html", text: studioHtml, title: prompt.slice(0, 60), meta: { ai: true, prompt } });
  }
  closeStudio();
  toast("Saved");
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !studio.hidden && !el.dlg.open) closeStudio(); });

// ---------- widgets ----------
const KINDS = {
  ai: ["Custom, made by AI", "", () => ""],
  weather: ["Weather", "City, e.g. Paris", (v) => `weather ${v}`],
  clock: ["World clock", "City, e.g. Tokyo", (v) => `time ${v}`],
  timer: ["Timer or stopwatch", "Minutes, e.g. 10 (empty = stopwatch)", (v) => (v ? `timer ${v}` : "stopwatch")],
  todo: ["To-do list", "List name, e.g. Groceries", (v) => `todo ${v}`.trim()],
  price: ["Crypto price", "Coin, e.g. BTC or ETH EUR", (v) => `price ${v}`],
};

$("widgets").addEventListener("click", async () => {
  const kind = h("select", { name: "k" }, Object.entries(KINDS).map(([k, v]) => h("option", { value: k, text: v[0] })));
  const input = h("input", { name: "v", maxlength: 80, autocomplete: "off", autocapitalize: "off" });
  const zones = h("datalist", { id: "zones" }, (Intl.supportedValuesOf?.("timeZone") || []).map((z) => h("option", { value: z })));
  const details = field("Details", input);
  const sync = () => {
    details.hidden = kind.value === "ai";
    input.placeholder = KINDS[kind.value][1];
    kind.value === "clock" ? input.setAttribute("list", "zones") : input.removeAttribute("list");
    input.required = ["weather", "clock", "price"].includes(kind.value);
  };
  kind.addEventListener("change", sync);
  sync();
  const r = await dialog((f) => f.append(h("h2", { text: "Add a widget" }), field("Kind", kind), details, zones,
    h("div", { class: "row" }, btn("Cancel", "no"), btn("Next", "ok", "solid"))));
  if (r !== "ok") return;
  if (kind.value === "ai") return openStudio();
  const d = detect(KINDS[kind.value][2](input.value.trim()));
  if (!d || d.type !== kind.value) return toast("Could not understand that. Check the spelling.");
  addItem(d);
});

// ---------- rail tools ----------
$("newBoard").addEventListener("click", newBoard);
$("renameBoard").addEventListener("click", renameBoard);
$("deleteBoard").addEventListener("click", () => removeBoard(board().id));
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
  state.boards.forEach((b) => b.items.forEach(dropBlob));
  fetched.clear();
  if (sharedBoard) leaveShared();
  await seed();
  renderAll();
});

$("auth").addEventListener("click", async () => {
  if (mode.admin) {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
    return;
  }
  const input = h("input", { type: "password", name: "p", autocomplete: "current-password", required: true });
  const r = await dialog((f) => f.append(h("h2", { text: "Owner sign in" }), field("Password", input), h("div", { class: "row" }, btn("Cancel", "no"), btn("Sign in", "ok", "solid"))));
  if (r !== "ok") return;
  const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: input.value }) });
  if (res.ok) location.reload();
  else toast((await res.json().catch(() => ({}))).error || "Could not sign in");
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
