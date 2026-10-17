# Avad runbook
Chat: "new website idea, a website that displays anything I want". Keep <1,500 tokens; update as work proceeds.

## Decisions
- Name/identity: **Avad**, an archive "wall" of numbered plates (No. 001...). Paper `#ECE5D4`, ink `#1D1B16`, one accent vermilion `#C93A1B`; dark mode auto + manual toggle.
- Type: Young Serif (display), Familjen Grotesk (body), Martian Mono (labels). Self-hosted woff2 in `public/fonts`.
- Stack: plain HTML/CSS/JS ES modules, no build step. Hosted on **Cloudflare Workers** (static assets + small Worker).
- One motion moment: new plate "stamps" down. No gradients/glass/glow/emoji icons.
- Wordless tutorial rule is for games only; not applied here.

## Layout
- `wrangler.jsonc`: assets dir `public`, `run_worker_first: ["/api/*"]`.
- `src/worker.js`: `/api/unfurl?url=` returns title/description/image/icon + `embeddable` (checks X-Frame-Options/CSP). http(s) only, 6s timeout, 512KB cap.
- `public/content.json`: seed boards on first run (config-driven). "Reset" reloads it.
- `public/js/`: `detect.js` (text/URL/file -> type), `render.js` (type -> DOM), `store.js` (localStorage + IndexedDB blobs, export/import, share-link codec), `app.js` (UI).
- Types: note(markdown-lite), image, video, audio, youtube, vimeo, pdf, link(card), embed, html(sandboxed), code, csv, json, color, countdown, file.
- Features: paste/drop anywhere, live type chip, boards, type filters, stage (arrows/swipe/auto), edit/reorder/delete dialog, export/import JSON, share link (`#b=` deflate, files excluded), `/` focuses input.

## State
- Built and tested locally with `npx wrangler dev` + Playwright (desktop 1366, mobile 390, dark). No console errors; upload/reload/share/edit verified.
- Branch `claude/nice-volta-c6agz9`.

## Open / next
- Not yet deployed: needs `npx wrangler login` then `npm run deploy` (user's Cloudflare account).
- Ideas: KV-backed short share links and cross-device sync; drag reorder; more types (map, tweet, 3D).
- Unverified: touch gestures on a real phone; HTML-snippet iframe sizing on mobile full-page capture.
