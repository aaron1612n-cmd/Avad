// Static files in ./public are served by Cloudflare directly.
// Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).

const UA = "Mozilla/5.0 (compatible; AvadBot/1.0; +https://workers.cloudflare.com)";
const MAX_HTML = 512 * 1024;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      ...extra,
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/unfurl") return unfurl(url);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

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
