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
- Branch `claude/nice-volta-c6agz9`. No `main` exists on GitHub; PR blocked until user creates it or allows me to.

## Access model (v5)
- Public can read; only the owner edits. Boards in KV namespace `BOARDS` (key `state`, `{rev, boards}`; files at `file:<id>`, 20 MB max each). Worker secret `ADMIN_PASSWORD` (set with `wrangler secret put`; never in repo). Login sets 30-day HttpOnly cookie (HMAC of password, so changing the password signs everyone out). 8 wrong tries/15 min per IP.
- Client modes: `server` (KV configured; non-owner is read-only, hides edit UI, shows "Owner sign in") or `local` (no KV; per-browser storage, used by plain static hosting).
- Writes check same-origin + cookie; `rev` guards against two devices overwriting each other (409 -> reload). `/api/unfurl` is owner-only.
- Local dev: `.dev.vars` (gitignored) holds a test ADMIN_PASSWORD.

## Changelog
- v8b: user has NO Claude API key, so free Workers AI is the engine. Benchmarked all free models on one brief: default is @cf/google/gemma-4-26b-a4b-it (best design, ~30-70s streamed), then gpt-oss-120b (fast), then qwen2.5-coder-32b. Paid-plan-only models (kimi-k2.7-code, glm-5.x, deepseek-v4) return "not available on Workers Free plan". Override with WORKERS_AI_MODEL var.
- v8: AI widget maker (live; Workers AI verified working on prod, Claude path untested until user adds ANTHROPIC_API_KEY secret; Workers AI streams bare/invalid-JSON digits so parse defensively). Widgets > "Custom, made by AI" opens a studio (prompt + pick board media + links -> streamed single-file HTML -> sandboxed preview -> Save as html plate with meta.ai; "Tweak with AI" in edit dialog). Worker `/api/widget` (owner-only, 60/day cap via AI_DAILY_LIMIT): Claude if ANTHROPIC_API_KEY secret set (model env ANTHROPIC_MODEL, default claude-sonnet-5-5), else Cloudflare Workers AI binding `AI`. html plates now get a CSP via htmlDoc().
- v7 (tested locally with Playwright, deployed): live widgets (weather, world clock, timer/stopwatch, to-do, crypto price via Widgets button or typed commands), search + tags, select-many (move/delete/reorder), drag-to-reorder grip, slideshow shuffle/speed/music/fullscreen/idle-hide. Next: test, deploy; then AI widget maker (Worker -> LLM -> sandboxed html plate; owner-only; user to choose Claude API key vs Workers AI).
- v6: add several at once: pasted/dropped lists of links or colours (one per line, or space/comma separated) become one plate each; multi-file picks show progress. Mixed text stays one note.
- v5: KV storage + owner password + read-only public view.
- v4: security pass. Edits are per-browser only (no server write path, so visitors cannot change the live site or each other). Added `_headers` (nosniff, frame-ancestors none, referrer policy) and same-origin-only `/api/unfurl`. User chose option 2 (public read-only, owner edits) -> built in v5.
- v3: visible Rename/Delete buttons for boards, delete button on each plate.
- v2: Cancel in dialogs no longer triggers form validation (`formnovalidate`; Address field is plain text, not type=url). Photos/Files are `<label for=input>` buttons with visually-hidden inputs (reliable on iOS). Plainer wording: Slideshow, Photos, Files, Save/Restore backup. User found v1 confusing: keep copy plain, avoid jargon.

## Open / next
- DEPLOYED: https://avad.galaxica.workers.dev (Worker `avad`). Redeploy: `npm run deploy` (CLOUDFLARE_API_TOKEN is an env var in the cloud environment; never commit it).
- Ideas: drag reorder; R2 for big files; custom domain; more types (map, tweet, 3D).
- Unverified: touch gestures on a real phone; HTML-snippet iframe sizing on mobile full-page capture.
