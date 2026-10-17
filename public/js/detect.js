// Turn whatever was pasted, typed or dropped into an item.
const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const VID = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUD = /\.(mp3|wav|ogg|oga|m4a|flac|aac)$/i;

export const TYPES = [
  "note", "image", "video", "audio", "youtube", "vimeo", "pdf", "link", "embed",
  "html", "code", "csv", "json", "color", "countdown", "file",
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

export function detect(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

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
