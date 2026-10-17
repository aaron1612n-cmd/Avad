// Turn whatever was pasted, typed or dropped into an item.
const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const VID = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUD = /\.(mp3|wav|ogg|oga|m4a|flac|aac)$/i;

export const TYPES = [
  "note", "image", "video", "audio", "youtube", "vimeo", "pdf", "link", "embed",
  "html", "code", "csv", "json", "color", "countdown", "weather", "clock", "timer", "todo", "price", "file",
];

export function parseUrl(s) {
  s = s.trim();
  if (/\s/.test(s)) return null;
  if (/^www\./i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

export function youtubeId(u) {
  const h = u.hostname.replace(/^(www|m)\./, "");
  if (h === "youtu.be") return u.pathname.slice(1).split("/")[0];
  if (h.endsWith("youtube.com") || h.endsWith("youtube-nocookie.com")) {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
    if (m) return m[1];
  }
  return null;
}

export function vimeoId(u) {
  if (!/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/\/(\d{5,})/);
  return m ? m[1] : null;
}

const isCsv = (t) => {
  const lines = t.trim().split(/\r?\n/);
  if (lines.length < 2) return false;
  const n = (lines[0].match(/,/g) || []).length;
  return n > 0 && lines.slice(0, 6).every((l) => (l.match(/,/g) || []).length === n);
};


const CITY_ZONES = {
  london: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin", madrid: "Europe/Madrid", rome: "Europe/Rome",
  amsterdam: "Europe/Amsterdam", lisbon: "Europe/Lisbon", dublin: "Europe/Dublin", athens: "Europe/Athens", stockholm: "Europe/Stockholm",
  istanbul: "Europe/Istanbul", moscow: "Europe/Moscow", kyiv: "Europe/Kyiv", "new york": "America/New_York", nyc: "America/New_York",
  miami: "America/New_York", boston: "America/New_York", chicago: "America/Chicago", dallas: "America/Chicago", houston: "America/Chicago",
  denver: "America/Denver", phoenix: "America/Phoenix", "los angeles": "America/Los_Angeles", la: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", seattle: "America/Los_Angeles", vancouver: "America/Vancouver", toronto: "America/Toronto",
  "mexico city": "America/Mexico_City", "sao paulo": "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires",
  bogota: "America/Bogota", lima: "America/Lima", honolulu: "Pacific/Honolulu", anchorage: "America/Anchorage",
  tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo", seoul: "Asia/Seoul", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong", taipei: "Asia/Taipei", singapore: "Asia/Singapore", bangkok: "Asia/Bangkok",
  hanoi: "Asia/Ho_Chi_Minh", "ho chi minh": "Asia/Ho_Chi_Minh", saigon: "Asia/Ho_Chi_Minh", "da nang": "Asia/Ho_Chi_Minh",
  manila: "Asia/Manila", jakarta: "Asia/Jakarta", "kuala lumpur": "Asia/Kuala_Lumpur", mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata",
  dubai: "Asia/Dubai", tehran: "Asia/Tehran", karachi: "Asia/Karachi", dhaka: "Asia/Dhaka", cairo: "Africa/Cairo",
  lagos: "Africa/Lagos", nairobi: "Africa/Nairobi", johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", perth: "Australia/Perth", auckland: "Pacific/Auckland", utc: "UTC", gmt: "UTC",
};

export function resolveZone(name) {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  const zone = CITY_ZONES[key] || name.trim().replace(/\s+/g, "_");
  try {
    new Intl.DateTimeFormat([], { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function widgetCommand(text) {
  let m;
  if ((m = text.match(/^weather\s+(.{2,60})$/i))) return { type: "weather", meta: { city: m[1].trim() }, title: m[1].trim() };
  if ((m = text.match(/^(?:time|clock)\s+(?:in\s+)?(.{2,60})$/i))) {
    const zone = resolveZone(m[1]);
    if (zone) return { type: "clock", meta: { zone }, title: m[1].trim() };
  }
  if (/^stopwatch$/i.test(text)) return { type: "timer", meta: { seconds: 0 }, title: "Stopwatch" };
  if ((m = text.match(/^timer\s+(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/i))) {
    const unit = (m[2] || "m").toLowerCase();
    const secs = Math.round(Number(m[1]) * (unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1));
    if (secs > 0 && secs <= 86400) return { type: "timer", meta: { seconds: secs }, title: `${m[1]} ${unit.startsWith("h") ? "hour" : unit.startsWith("m") ? "minute" : "second"} timer` };
  }
  if ((m = text.match(/^(?:todo|to-do|checklist)(?:\s+(.{1,80}))?$/i))) return { type: "todo", meta: { tasks: [] }, title: m[1]?.trim() || "To do" };
  if ((m = text.match(/^(?:price|crypto)\s+([a-z]{2,6})(?:[\s/-]+([a-z]{3,4}))?$/i))) {
    return { type: "price", meta: { base: m[1].toUpperCase(), quote: (m[2] || "USD").toUpperCase() }, title: `${m[1].toUpperCase()} price` };
  }
  return null;
}

export function detect(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  const widget = widgetCommand(text);
  if (widget) return widget;

  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return { type: "color", text: text.toLowerCase(), title: text.toUpperCase() };

  const cd = text.match(/^(?:until|countdown)\s+(.+)$/i);
  if (cd) {
    const d = new Date(cd[1]);
    if (!isNaN(d)) return { type: "countdown", meta: { date: d.toISOString() }, title: cd[1] };
  }

  const u = parseUrl(text);
  if (u) {
    const href = u.href;
    const yt = youtubeId(u);
    if (yt) return { type: "youtube", src: href, meta: { id: yt }, title: "" };
    const vm = vimeoId(u);
    if (vm) return { type: "vimeo", src: href, meta: { id: vm }, title: "" };
    const p = u.pathname;
    if (IMG.test(p)) return { type: "image", src: href };
    if (VID.test(p)) return { type: "video", src: href };
    if (AUD.test(p)) return { type: "audio", src: href };
    if (/\.pdf$/i.test(p)) return { type: "pdf", src: href };
    return { type: "link", src: href };
  }

  const fence = text.match(/^```([\w+-]*)\n([\s\S]*?)\n?```$/);
  if (fence) return { type: "code", text: fence[2], meta: { lang: fence[1] } };

  if (/^<(!doctype|html|body|div|svg|style|script|main|section|canvas|h[1-6]|p|span|button)\b/i.test(text)) {
    return { type: "html", text };
  }

  if (/^[\[{]/.test(text)) {
    try {
      JSON.parse(text);
      return { type: "json", text };
    } catch {}
  }

  if (isCsv(text)) return { type: "csv", text };

  return { type: "note", text: raw.replace(/\s+$/, "") };
}

export function detectFile(file) {
  const t = file.type || "";
  const n = file.name || "";
  const base = { title: n.replace(/\.[^.]+$/, ""), meta: { name: n, size: file.size, mime: t } };
  if (t.startsWith("image/") || IMG.test(n)) return { ...base, type: "image" };
  if (t.startsWith("video/") || VID.test(n)) return { ...base, type: "video" };
  if (t.startsWith("audio/") || AUD.test(n)) return { ...base, type: "audio" };
  if (t === "application/pdf" || /\.pdf$/i.test(n)) return { ...base, type: "pdf" };
  if (/\.csv$/i.test(n) || t === "text/csv") return { ...base, type: "csv", asText: true };
  if (/\.json$/i.test(n) || t === "application/json") return { ...base, type: "json", asText: true };
  if (/\.html?$/i.test(n) || t === "text/html") return { ...base, type: "html", asText: true };
  if (/\.(md|markdown|txt)$/i.test(n) || t === "text/plain") return { ...base, type: "note", asText: true };
  if (/\.(js|mjs|ts|tsx|jsx|py|rb|go|rs|c|h|cpp|java|sh|css|sql|yml|yaml|toml|xml|php|swift|kt)$/i.test(n)) {
    return { ...base, type: "code", asText: true, meta: { ...base.meta, lang: n.split(".").pop() } };
  }
  return { ...base, type: "file" };
}

const BATCHABLE = new Set(["image", "video", "audio", "youtube", "vimeo", "pdf", "link", "color", "countdown"]);

/** Several links/colours pasted together (one per line, or separated by spaces/commas) become one item each. */
export function detectMany(raw) {
  const text = (raw || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#!"));
  let parts = lines.length > 1 ? lines : text.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 1) {
    const found = parts.map(detect);
    if (found.every((d) => d && BATCHABLE.has(d.type))) return found;
  }
  const one = detect(raw);
  return one ? [one] : [];
}
