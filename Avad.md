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

## Changelog
- v3: visible Rename/Delete buttons for boards, delete button on each plate.
- v2: Cancel in dialogs no longer triggers form validation (`formnovalidate`; Address field is plain text, not type=url). Photos/Files are `<label for=input>` buttons with visually-hidden inputs (reliable on iOS). Plainer wording: Slideshow, Photos, Files, Save/Restore backup. User found v1 confusing: keep copy plain, avoid jargon.

## Open / next
- DEPLOYED: https://avad.galaxica.workers.dev (Worker `avad`). Redeploy: `npm run deploy` (CLOUDFLARE_API_TOKEN is an env var in the cloud environment; never commit it).
- Ideas: KV-backed short share links and cross-device sync; drag reorder; more types (map, tweet, 3D).
- Unverified: touch gestures on a real phone; HTML-snippet iframe sizing on mobile full-page capture.
