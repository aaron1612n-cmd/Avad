// Boards live in localStorage; file bytes live in IndexedDB so they can be large.
const KEY = "avad:v1";

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const state = { boards: [], current: null };

// "server" mode: boards live on Cloudflare KV; everyone reads, only the signed-in owner writes.
// "local" mode: no server storage configured (e.g. plain static hosting), boards live in this browser.
export const mode = { server: false, admin: false, rev: 0 };
export const hooks = { onConflict() {}, onAuthLost() {} };
const CURRENT = "avad:current";

export async function loadServer() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) return false;
    const d = await r.json();
    if (!d.configured) return false;
    mode.server = true;
    mode.admin = !!d.admin;
    mode.rev = d.rev || 0;
    if (d.boards?.length) {
      state.boards = d.boards;
      let cur = null;
      try { cur = localStorage.getItem(CURRENT); } catch {}
      state.current = d.boards.some((b) => b.id === cur) ? cur : d.boards[0].id;
      return "ok";
    }
    return "empty";
  } catch {
    return false;
  }
}

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.boards) && raw.boards.length) {
      state.boards = raw.boards;
      state.current = raw.boards.some((b) => b.id === raw.current) ? raw.current : raw.boards[0].id;
      return true;
    }
  } catch {}
  return false;
}

let timer;
let queue = Promise.resolve();
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

function flush() {
  if (!mode.server) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ boards: state.boards, current: state.current }));
    } catch {}
    return;
  }
  try { localStorage.setItem(CURRENT, state.current || ""); } catch {}
  if (!mode.admin) return;
  queue = queue.then(async () => {
    try {
      const body = JSON.stringify({ rev: mode.rev, boards: state.boards });
      const r = await fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body });
      if (r.ok) mode.rev = (await r.json()).rev;
      else if (r.status === 409) hooks.onConflict();
      else if (r.status === 401) { mode.admin = false; hooks.onAuthLost(); }
    } catch {}
  });
}

export const board = () => state.boards.find((b) => b.id === state.current) || state.boards[0];

export function normalize(raw) {
  return {
    id: uid(),
    name: String(raw.name || "Untitled").slice(0, 80),
    items: (raw.items || []).map(normalizeItem),
  };
}

export function normalizeItem(i) {
  return {
    id: uid(),
    type: i.type || "note",
    src: i.src || "",
    text: i.text || "",
    title: i.title || "",
    caption: i.caption || "",
    meta: i.meta || {},
    file: i.file || "",
  };
}

// ---------- IndexedDB blobs ----------
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("avad", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("files", mode);
    const req = fn(t.objectStore("files"));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
};
export const putFile = (id, blob) => tx("readwrite", (s) => s.put(blob, id));
export const getFile = (id) => tx("readonly", (s) => s.get(id));
export const delFile = (id) => tx("readwrite", (s) => s.delete(id));

/** Store a picked file. Returns the fields to merge into the item: `src` (server) or `file` (this browser). */
export async function saveBlob(blob) {
  if (mode.server) {
    const id = uid().replace(/[^a-z0-9]/g, "");
    const r = await fetch(`/api/file/${id}`, { method: "PUT", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "upload failed");
    return { src: `/api/file/${id}` };
  }
  const file = uid();
  await putFile(file, blob);
  return { file };
}

export function dropBlob(item) {
  if (item.file) delFile(item.file).catch(() => {});
  else if (mode.server && mode.admin && item.src?.startsWith("/api/file/")) fetch(item.src, { method: "DELETE" }).catch(() => {});
}

const urls = new Map();
export async function fileUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await getFile(id);
  if (!blob) return "";
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}

// ---------- export / import ----------
const toDataUrl = (blob) =>
  new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });

export async function exportAll() {
  const boards = [];
  for (const b of state.boards) {
    const items = [];
    for (const it of b.items) {
      const out = { ...it };
      delete out.id;
      if (it.file) {
        const blob = await getFile(it.file);
        if (blob) out.dataUrl = await toDataUrl(blob);
        delete out.file;
      } else if (it.src?.startsWith("/api/file/")) {
        try {
          out.dataUrl = await toDataUrl(await (await fetch(it.src)).blob());
          delete out.src;
        } catch {}
      }
      items.push(out);
    }
    boards.push({ name: b.name, items });
  }
  return JSON.stringify({ avad: 1, boards }, null, 2);
}

export async function importBoards(data) {
  const out = [];
  for (const rb of data.boards || []) {
    const b = normalize({ name: rb.name, items: [] });
    for (const ri of rb.items || []) {
      const it = normalizeItem(ri);
      if (ri.dataUrl) {
        const blob = await (await fetch(ri.dataUrl)).blob();
        Object.assign(it, await saveBlob(blob));
      }
      b.items.push(it);
    }
    out.push(b);
  }
  return out;
}

// ---------- share links (no server storage: the board rides in the URL) ----------
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeBoard(b) {
  const slim = {
    name: b.name,
    items: b.items.filter((i) => !i.file).map(({ id, file, ...rest }) => rest),
  };
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(slim)), new CompressionStream("deflate-raw"));
  return b64(bytes);
}

export async function decodeBoard(s) {
  const bytes = await pipe(unb64(s), new DecompressionStream("deflate-raw"));
  return normalize(JSON.parse(new TextDecoder().decode(bytes)));
}
