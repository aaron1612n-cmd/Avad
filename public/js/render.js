import { fileUrl } from "./store.js";
import { parseUrl } from "./detect.js";

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Escape first, then add a small set of tags, so user text can never inject markup.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

export function markdown(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); out.push(`<h${m[1].length === 1 ? 3 : 4}>${inline(m[2])}</h${m[1].length === 1 ? 3 : 4}>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^>\s?(.*)/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join("");
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");

// Only ever put http(s) URLs into href/src.
const safe = (u) => {
  if (typeof u === "string" && /^\/(?!\/)/.test(u)) return u; // same-site path
  const p = parseUrl(u || "");
  return p ? p.href : "";
};

async function resolveSrc(item) {
  return item.file ? fileUrl(item.file) : safe(item.src);
}

export const timers = new Set();

function contrast(hex) {
  let c = hex.replace("#", "");
  if (c.length === 3) c = [...c].map((x) => x + x).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1b16" : "#f6f1e4";
}

/** Build the body of a plate. `big` is the full-screen stage version. */
export function renderBody(item, { big = false, toast = () => {} } = {}) {
  const box = h("div", { class: "plate-body" });
  const set = (...n) => box.replaceChildren(...n.filter(Boolean));

  switch (item.type) {
    case "image": {
      const img = h("img", { class: "pic", alt: item.title || "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => set(h("div", { class: "broken", text: "image would not load" })));
      resolveSrc(item).then((u) => (img.src = u));
      set(img);
      break;
    }
    case "video": {
      const v = h("video", { class: "pic", controls: true, preload: "metadata", playsinline: true });
      v.addEventListener("error", () => set(h("div", { class: "broken", text: "video would not load" })));
      resolveSrc(item).then((u) => (v.src = u));
      set(v);
      break;
    }
    case "audio": {
      const a = h("audio", { controls: true, preload: "metadata" });
      resolveSrc(item).then((u) => (a.src = u));
      set(a);
      break;
    }
    case "youtube":
    case "vimeo": {
      const id = String(item.meta.id || "").replace(/[^\w-]/g, "");
      const src = item.type === "youtube"
        ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`
        : `https://player.vimeo.com/video/${id}?autoplay=1`;
      const frame = () => h("iframe", { src, allow: "autoplay; fullscreen; picture-in-picture", allowfullscreen: true, title: item.title || item.type, referrerpolicy: "strict-origin-when-cross-origin" });
      if (big || item.type === "vimeo") {
        set(h("div", { class: "ratio" }, frame()));
      } else {
        const play = h("button", { class: "play", type: "button", "aria-label": "Play video", onclick: () => set(h("div", { class: "ratio" }, frame())) });
        set(h("div", { class: "ratio" }, h("img", { src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, alt: "", loading: "lazy" }), play));
      }
      break;
    }
    case "pdf": {
      const open = (u) => h("a", { class: "filecard", href: u, target: "_blank", rel: "noopener" }, h("b", { text: item.meta.name || "PDF" }), h("span", { class: "mono", text: "Open" }));
      resolveSrc(item).then((u) => {
        if (matchMedia("(pointer: coarse)").matches && !big) return set(open(u));
        set(h("iframe", { class: "frame", src: u, title: item.title || "PDF" }));
      });
      break;
    }
    case "embed": {
      const u = safe(item.src);
      set(u
        ? h("iframe", { class: "frame", src: u, loading: "lazy", sandbox: "allow-scripts allow-same-origin allow-popups allow-forms", referrerpolicy: "no-referrer", title: item.title || u })
        : h("div", { class: "broken", text: "bad address" }));
      break;
    }
    case "html":
      set(h("iframe", { class: "frame", sandbox: "allow-scripts", srcdoc: item.text, title: item.title || "HTML" }));
      break;
    case "note":
      set(h("div", { class: "text" }));
      box.firstChild.innerHTML = markdown(item.text);
      break;
    case "code": {
      const pre = h("pre", { class: "code" }, h("code", { text: item.text }));
      const copy = h("button", { class: "outline copy mono", type: "button", text: "Copy", onclick: () => navigator.clipboard?.writeText(item.text).then(() => toast("Copied")) });
      set(pre, copy);
      break;
    }
    case "csv": {
      const rows = parseCsv(item.text);
      const cap = big ? 500 : 40;
      const [head = [], ...body] = rows;
      const table = h("table", {},
        h("thead", {}, h("tr", {}, head.map((c) => h("th", { text: c })))),
        h("tbody", {}, body.slice(0, cap).map((r) => h("tr", {}, head.map((_, i) => h("td", { text: r[i] ?? "" }))))));
      set(h("div", { class: "table-wrap" }, table), body.length > cap ? h("div", { class: "more mono", text: `+${body.length - cap} more rows` }) : null);
      break;
    }
    case "json": {
      let pretty = item.text;
      try { pretty = JSON.stringify(JSON.parse(item.text), null, 2); } catch {}
      set(h("pre", { class: "code" }, h("code", { text: pretty })));
      break;
    }
    case "color": {
      const bg = item.text;
      const sw = h("button", { class: "swatch", type: "button", style: `background:${/^#[0-9a-f]{3,6}$/i.test(bg) ? bg : "#888"};color:${contrast(bg)}`, "aria-label": `Copy ${bg}`, onclick: () => navigator.clipboard?.writeText(bg).then(() => toast("Copied " + bg)) },
        h("b", { text: bg.toUpperCase() }), h("span", { text: "tap to copy" }));
      set(sw);
      break;
    }
    case "countdown": {
      const target = new Date(item.meta.date);
      const big$ = h("div", { class: "big" });
      const sub = h("div", { class: "sub mono", text: target.toLocaleString([], { dateStyle: "long", timeStyle: "short" }) });
      const tick = () => {
        let s = Math.round((target - Date.now()) / 1000);
        const past = s < 0; s = Math.abs(s);
        const d = Math.floor(s / 86400), hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
        big$.textContent = `${d}d ${hh}:${mm}:${ss}${past ? " ago" : ""}`;
        if (!box.isConnected && box.dataset.mounted) { clearInterval(id); timers.delete(id); }
      };
      const id = setInterval(tick, 1000);
      timers.add(id);
      queueMicrotask(() => (box.dataset.mounted = "1"));
      tick();
      set(h("div", { class: "clock" }, big$, sub));
      break;
    }
    case "link": {
      const u = safe(item.src);
      const m = item.meta || {};
      const host = u ? new URL(u).hostname : "";
      set(h("a", { class: "card", href: u || "#", target: "_blank", rel: "noopener noreferrer" },
        m.image ? h("img", { src: safe(m.image), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
        h("div", { class: "t", text: m.title || item.title || host }),
        m.description ? h("div", { class: "d", text: m.description }) : null,
        h("div", { class: "u" }, m.icon ? h("img", { src: safe(m.icon), alt: "", referrerpolicy: "no-referrer" }) : null, h("span", { text: (m.site || host) + " ↗" }))));
      if (big && m.embeddable) {
        set(h("iframe", { class: "frame", src: u, sandbox: "allow-scripts allow-same-origin allow-popups allow-forms", referrerpolicy: "no-referrer", title: item.title || host }));
      }
      break;
    }
    case "file":
    default: {
      const a = h("a", { class: "filecard", target: "_blank", rel: "noopener" }, h("b", { text: item.meta.name || item.title || "file" }), h("span", { class: "mono", text: item.meta.size ? fmtSize(item.meta.size) : "Open" }));
      if (item.file) { a.download = item.meta.name || "file"; resolveSrc(item).then((u) => (a.href = u)); }
      else a.href = safe(item.src) || "#";
      set(a);
    }
  }
  return box;
}

export const TYPE_LABEL = { youtube: "video", vimeo: "video", pdf: "pdf", countdown: "clock", color: "colour", html: "html", csv: "table", json: "json" };
export const typeLabel = (t) => TYPE_LABEL[t] || t;
