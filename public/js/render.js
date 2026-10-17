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

export async function resolveSrc(item) {
  return item.file ? fileUrl(item.file) : safe(item.src);
}

/** Wrap user or AI HTML with a content-security policy so a widget can show media and call public APIs but nothing else. */
export function htmlDoc(text) {
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https:; img-src https: data: blob: ${location.origin}; media-src https: data: blob: ${location.origin}; font-src https: data:; connect-src https:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; form-action 'none'; base-uri 'none'`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const src = String(text || "");
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => m + "<head>" + meta + "</head>");
  return "<!doctype html><html><head>" + meta + '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + src + "</body></html>";
}

export const timers = new Set();

/** Run fn on an interval for as long as the plate stays in the page. */
function every(box, ms, fn) {
  const id = setInterval(() => {
    if (box.dataset.mounted && !box.isConnected) return clearInterval(id);
    fn();
  }, ms);
  queueMicrotask(() => (box.dataset.mounted = "1"));
  return id;
}

const WX = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };
const wxCache = new Map();

async function weather(city) {
  const hit = wxCache.get(city);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  const f = /^en-US/i.test(navigator.language || "");
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json();
  const g = geo.results?.[0];
  if (!g) throw new Error("no city");
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1${f ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : ""}`)).json();
  const data = {
    name: [g.name, g.country_code].filter(Boolean).join(", "),
    temp: Math.round(w.current.temperature_2m),
    label: WX[w.current.weather_code] || "—",
    hi: Math.round(w.daily.temperature_2m_max[0]),
    lo: Math.round(w.daily.temperature_2m_min[0]),
    wind: `${Math.round(w.current.wind_speed_10m)} ${f ? "mph" : "km/h"}`,
  };
  wxCache.set(city, { at: Date.now(), data });
  return data;
}


function contrast(hex) {
  let c = hex.replace("#", "");
  if (c.length === 3) c = [...c].map((x) => x + x).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1b16" : "#f6f1e4";
}

/** Build the body of a plate. `big` is the full-screen stage version. */
export function renderBody(item, { big = false, toast = () => {}, editable = false, onChange = () => {} } = {}) {
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
      set(h("iframe", { class: "frame", sandbox: "allow-scripts", allow: "autoplay; fullscreen", srcdoc: htmlDoc(item.text), title: item.title || "HTML", loading: big ? null : "lazy" }));
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
    case "weather": {
      const out = h("div", { class: "wx" }, h("div", { class: "sub mono", text: "loading…" }));
      const load = async () => {
        try {
          const d = await weather(item.meta.city);
          out.replaceChildren(
            h("div", { class: "big", text: `${d.temp}°` }),
            h("div", { class: "wx-line", text: d.label }),
            h("div", { class: "sub mono", text: `${d.name} · high ${d.hi}° low ${d.lo}° · wind ${d.wind}` }));
        } catch {
          out.replaceChildren(h("div", { class: "sub mono", text: "weather unavailable" }));
        }
      };
      load();
      every(box, 600000, load);
      set(h("div", { class: "clock" }, out));
      break;
    }
    case "clock": {
      const zone = item.meta.zone || "UTC";
      const time = h("div", { class: "big" });
      const date = h("div", { class: "sub mono" });
      const tick = () => {
        const now = new Date();
        try {
          time.textContent = now.toLocaleTimeString([], { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit" });
          date.textContent = `${now.toLocaleDateString([], { timeZone: zone, weekday: "short", day: "numeric", month: "short" })} · ${zone.replace(/_/g, " ")}`;
        } catch { time.textContent = "bad zone"; }
      };
      tick();
      every(box, 1000, tick);
      set(h("div", { class: "clock" }, time, date));
      break;
    }
    case "timer": {
      const total = Number(item.meta.seconds) || 0; // 0 = stopwatch
      let base = 0, startedAt = 0, running = false, done = false;
      const out = h("div", { class: "big" });
      const startBtn = h("button", { type: "button", class: "outline", text: "Start" });
      const ms = () => base + (running ? Date.now() - startedAt : 0);
      const fmt = (t) => {
        t = Math.max(0, t);
        const m = Math.floor(t / 60000), sec = Math.floor((t % 60000) / 1000);
        return total ? `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${Math.floor((t % 1000) / 100)}`;
      };
      const draw = () => {
        const shown = total ? Math.ceil((total * 1000 - ms()) / 1000) * 1000 : ms();
        out.textContent = fmt(shown);
        if (total && running && total * 1000 - ms() <= 0) {
          running = false; base = total * 1000; done = true;
          startBtn.textContent = "Start";
          out.textContent = "00:00 done";
          navigator.vibrate?.([200, 100, 200]);
        }
      };
      startBtn.addEventListener("click", () => {
        if (done) { base = 0; done = false; }
        if (running) { base = ms(); running = false; startBtn.textContent = "Resume"; }
        else { startedAt = Date.now(); running = true; startBtn.textContent = "Pause"; }
        draw();
      });
      const reset = h("button", { type: "button", class: "outline", text: "Reset", onclick: () => { running = false; done = false; base = 0; startBtn.textContent = "Start"; draw(); } });
      draw();
      every(box, 100, draw);
      set(h("div", { class: "clock" }, out, h("div", { class: "btns" }, startBtn, reset)));
      break;
    }
    case "todo": {
      const tasks = (item.meta.tasks ||= []);
      const list = h("ul", { class: "todo" });
      const left = h("div", { class: "sub mono" });
      const draw = () => {
        list.replaceChildren(...tasks.map((t, i) => h("li", { class: t.done ? "done" : "" },
          h("button", { type: "button", class: "tick", "aria-pressed": String(!!t.done), "aria-label": "Done", disabled: !editable, onclick: () => { t.done = !t.done; onChange(); draw(); } }),
          h("span", { text: t.t }),
          editable ? h("button", { type: "button", class: "rm", "aria-label": "Remove", text: "remove", onclick: () => { tasks.splice(i, 1); onChange(); draw(); } }) : null)));
        left.textContent = tasks.length ? `${tasks.filter((t) => !t.done).length} of ${tasks.length} left` : "empty";
      };
      draw();
      const form = editable ? h("form", { class: "todo-add", onsubmit: (e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.t;
        const v = input.value.trim();
        if (!v) return;
        tasks.push({ t: v.slice(0, 200), done: false });
        input.value = "";
        onChange(); draw();
      } }, h("input", { name: "t", placeholder: "Add a task", maxlength: 200, "aria-label": "Add a task", autocomplete: "off" }), h("button", { class: "outline", type: "submit", text: "Add" })) : null;
      set(h("div", { class: "text" }, list, left), form);
      break;
    }
    case "price": {
      const base = String(item.meta.base || "BTC").toUpperCase(), quote = String(item.meta.quote || "USD").toUpperCase();
      const out = h("div", { class: "big", text: "…" });
      const sub = h("div", { class: "sub mono", text: `${base} / ${quote}` });
      const load = async () => {
        try {
          const r = await fetch(`https://api.coinbase.com/v2/prices/${encodeURIComponent(base)}-${encodeURIComponent(quote)}/spot`);
          const d = await r.json();
          const n = Number(d.data.amount);
          out.textContent = new Intl.NumberFormat([], { style: "currency", currency: quote, maximumFractionDigits: n < 10 ? 4 : 2 }).format(n);
          sub.textContent = `${base} / ${quote} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        } catch {
          out.textContent = "n/a";
          sub.textContent = `${base} / ${quote} · price unavailable`;
        }
      };
      load();
      every(box, 60000, load);
      set(h("div", { class: "clock" }, out, sub));
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

export const TYPE_LABEL = { youtube: "video", vimeo: "video", pdf: "pdf", countdown: "countdown", clock: "time", color: "colour", html: "html", csv: "table", json: "json", todo: "list" };
export const typeLabel = (t) => TYPE_LABEL[t] || t;
