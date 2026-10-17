// Static files in ./public are served by Cloudflare directly.
// Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
//
// Everyone can read the wall. Only someone holding ADMIN_PASSWORD (a Worker secret) can change it.
// Boards live in KV key "state"; uploaded files live in KV under "file:<id>".

const UA = "Mozilla/5.0 (compatible; AvadBot/1.0; +https://workers.cloudflare.com)";
const MAX_HTML = 512 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_STATE = 4 * 1024 * 1024;
const SESSION_SECONDS = 30 * 24 * 3600;
const COOKIE = "avad_session";
const enc = new TextEncoder();

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    const configured = !!(env.BOARDS && env.ADMIN_PASSWORD);
    const admin = configured && (await isAdmin(request, env));
    const write = request.method !== "GET" && request.method !== "HEAD";
    // Writes and the preview fetcher only answer this site's own pages.
    if ((write || path === "/api/unfurl") && !sameOrigin(request, url)) return json({ error: "forbidden" }, 403);

    if (path === "/api/state") {
      if (!configured) return json({ configured: false });
      if (request.method === "GET") {
        const state = await env.BOARDS.get("state", "json");
        return json({ configured: true, admin, rev: state?.rev || 0, boards: state?.boards || null });
      }
      if (request.method === "PUT") return admin ? putState(request, env) : json({ error: "sign in" }, 401);
    }

    if (path === "/api/login" && request.method === "POST") return configured ? login(request, env) : json({ error: "not set up" }, 501);
    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
    }

    const f = path.match(/^\/api\/file\/([a-z0-9]{6,32})$/);
    if (f && configured) return file(request, env, f[1], admin);

    if (path === "/api/widget") {
      if (!configured || !admin) return json({ error: "sign in" }, 401);
      if (request.method === "GET") return json({ provider: provider(env) });
      if (request.method === "POST") return widget(request, env);
    }

    if (path === "/api/unfurl") {
      if (configured && !admin) return json({ error: "sign in" }, 401);
      return unfurl(url);
    }
    return json({ error: "not found" }, 404);
  },
};

// ---------- auth ----------
const sameOrigin = (request, url) => {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return site ? site === "same-origin" : !origin || origin === url.origin;
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode("avad-session:" + env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

async function same(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const cookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

async function isAdmin(request, env) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([a-f0-9]+)`));
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return same(m[2], await sign(env, m[1]));
}

async function login(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `rl:${ip}`;
  const tries = Number(await env.BOARDS.get(key)) || 0;
  if (tries >= 8) return json({ error: "too many tries, wait 15 minutes" }, 429);
  let password = "";
  try {
    password = String((await request.json()).password || "");
  } catch {}
  if (!password || !(await same(password, env.ADMIN_PASSWORD))) {
    await env.BOARDS.put(key, String(tries + 1), { expirationTtl: 900 });
    await new Promise((r) => setTimeout(r, 500));
    return json({ error: "wrong password" }, 401);
  }
  await env.BOARDS.delete(key);
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  return json({ ok: true }, 200, { "set-cookie": cookie(`${exp}.${await sign(env, exp)}`, SESSION_SECONDS) });
}

// ---------- boards ----------
async function putState(request, env) {
  const text = await request.text();
  if (text.length > MAX_STATE) return json({ error: "too big" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!Array.isArray(body.boards) || !body.boards.length) return json({ error: "bad boards" }, 400);
  const current = await env.BOARDS.get("state", "json");
  const rev = current?.rev || 0;
  if (Number(body.rev) !== rev) return json({ error: "changed elsewhere", rev }, 409);
  await env.BOARDS.put("state", JSON.stringify({ rev: rev + 1, boards: body.boards }));
  return json({ rev: rev + 1 });
}

async function file(request, env, id, admin) {
  const key = `file:${id}`;
  if (request.method === "GET" || request.method === "HEAD") {
    const { value, metadata } = await env.BOARDS.getWithMetadata(key, "arrayBuffer");
    if (!value) return new Response("not found", { status: 404 });
    const type = metadata?.type || "application/octet-stream";
    const headers = {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };
    // Anything that could run script is locked in a sandbox when opened directly.
    if (/html|svg|xml|javascript/i.test(type)) headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
    return new Response(value, { headers });
  }
  if (!admin) return json({ error: "sign in" }, 401);
  if (request.method === "DELETE") {
    await env.BOARDS.delete(key);
    return json({ ok: true });
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE) return json({ error: "file too big (20 MB max)" }, 413);
    const type = (request.headers.get("content-type") || "application/octet-stream").slice(0, 100);
    await env.BOARDS.put(key, buf, { metadata: { type, size: buf.byteLength } });
    return json({ ok: true, src: `/api/file/${id}` });
  }
  return json({ error: "not allowed" }, 405);
}


// ---------- AI widget maker (owner only) ----------
const WIDGET_SYSTEM = `You build single-file interactive web widgets that are shown in a sandboxed iframe on a personal dashboard.
Output ONLY the complete HTML document, starting with <!doctype html>. No markdown fences, no commentary before or after.
Rules:
- One file: inline <style> and <script>. Fill the whole viewport (html, body: margin 0, width and height 100%, overflow hidden) and adapt to any size from 280x200 phone cards to fullscreen using relative units and a resize handler.
- Make the design striking and original, never generic: a deliberate small palette, expressive typography, real layout decisions, and motion that has a purpose. Avoid purple or blue gradients, glassmorphism, glow shadows, and emoji used as icons.
- You may use canvas, SVG, CSS animation or WebGL. External libraries only from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net, with a pinned version.
- For images, video or audio use ONLY the media URLs the user lists. Videos: autoplay muted loop playsinline, object-fit cover. Never invent media URLs.
- No forms, no navigation or links that leave the widget, no alert/confirm/prompt, no cookies or localStorage. Network calls only to public CORS-enabled GET APIs, and only if the user asked for live data.
- Honour prefers-reduced-motion. Keep it under about 500 lines.`;

const provider = (env) => (env.ANTHROPIC_API_KEY ? "claude" : env.AI ? "workers-ai" : null);

async function widget(request, env) {
  const which = provider(env);
  if (!which) return json({ error: "AI is not set up" }, 501);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const prompt = String(body.prompt || "").trim().slice(0, 2000);
  const current = String(body.current || "").slice(0, 80000);
  if (!prompt) return json({ error: "describe the widget first" }, 400);

  // Owner-only already, but cap daily use anyway so a stolen session can't run up a bill.
  const day = `ai:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.BOARDS.get(day)) || 0;
  if (used >= (Number(env.AI_DAILY_LIMIT) || 60)) return json({ error: "daily AI limit reached" }, 429);
  await env.BOARDS.put(day, String(used + 1), { expirationTtl: 172800 });

  const origin = new URL(request.url).origin;
  const media = (Array.isArray(body.media) ? body.media : []).slice(0, 12).flatMap((m) => {
    const u = String(m?.url || "");
    const abs = u.startsWith("/api/file/") ? origin + u : /^https?:\/\//i.test(u) ? u : "";
    return abs ? [`- ${String(m.kind || "media").slice(0, 10)}: ${abs}${m.name ? ` (${String(m.name).slice(0, 60)})` : ""}`] : [];
  });
  const user = [
    current ? `Here is the current widget:\n\n${current}\n\nChange it as follows and return the COMPLETE updated HTML:` : "Build this widget:",
    prompt,
    media.length ? `\nMedia you may use:\n${media.join("\n")}` : "\nNo media was provided.",
  ].join("\n");

  try {
    const stream = which === "claude" ? await claudeStream(env, user) : await workersAiStream(env, user);
    return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-provider": which } });
  } catch (e) {
    return json({ error: String(e?.message || "the AI call failed").slice(0, 300) }, 502);
  }
}

// Turn a server-sent-event body into a stream of plain text pieces.
function sseText(body, pick) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { const t = pick(JSON.parse(data)); if (t) ctl.enqueue(enc.encode(t)); } catch {}
      }
    },
  }));
}

async function claudeStream(env, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 12000, stream: true, system: WIDGET_SYSTEM, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude said ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return sseText(r.body, (j) => (j.type === "content_block_delta" ? j.delta?.text : ""));
}

async function workersAiStream(env, user) {
  const models = [env.WORKERS_AI_MODEL, "@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"].filter(Boolean);
  let last;
  for (const model of models) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "system", content: WIDGET_SYSTEM }, { role: "user", content: user }], stream: true, max_tokens: 6000 });
      return sseText(out, (j) => j.response || "");
    } catch (e) {
      last = e;
    }
  }
  throw new Error("Workers AI failed: " + (last?.message || "no model available"));
}

// ---------- link previews ----------
function cleanTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u;
}

async function unfurl(url) {
  const target = cleanTarget(url.searchParams.get("url") || "");
  if (!target) return json({ error: "bad url" }, 400);

  let res;
  try {
    res = await fetch(target.href, {
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return json({ error: "unreachable" }, 502);
  }

  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
  const csp = (res.headers.get("content-security-policy") || "").toLowerCase();
  const embeddable = !xfo && !/frame-ancestors/.test(csp);

  const out = { url: res.url, type, embeddable, title: "", description: "", image: "", site: "", icon: "" };
  if (!type.includes("html")) {
    res.body?.cancel();
    out.title = target.pathname.split("/").filter(Boolean).pop() || target.hostname;
    out.site = target.hostname;
    return json(out);
  }

  const meta = {};
  const state = { title: "", icon: "" };
  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") || el.getAttribute("name");
        const val = el.getAttribute("content");
        if (key && val && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = val;
      },
    })
    .on("title", {
      text(t) {
        if (state.title.length < 300) state.title += t.text;
      },
    })
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        if (!state.icon && rel.includes("icon")) state.icon = el.getAttribute("href") || "";
      },
    });

  // Cap how much HTML we read so a huge page can't stall the Worker.
  const reader = res.body.getReader();
  let size = 0;
  const limited = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      size += value?.length || 0;
      if (done || size > MAX_HTML) {
        controller.close();
        reader.cancel().catch(() => {});
      } else controller.enqueue(value);
    },
  });
  await rewriter.transform(new Response(limited, { headers: { "content-type": "text/html" } })).text();

  const abs = (v) => {
    if (!v) return "";
    try {
      const a = new URL(v, res.url);
      return a.protocol === "http:" || a.protocol === "https:" ? a.href : "";
    } catch {
      return "";
    }
  };
  out.title = (meta["og:title"] || meta["twitter:title"] || state.title || "").trim().slice(0, 200);
  out.description = (meta["og:description"] || meta["description"] || meta["twitter:description"] || "")
    .trim()
    .slice(0, 400);
  out.image = abs(meta["og:image"] || meta["twitter:image"]);
  out.site = (meta["og:site_name"] || new URL(res.url).hostname).slice(0, 80);
  out.icon = abs(state.icon) || abs("/favicon.ico");
  return json(out);
}
