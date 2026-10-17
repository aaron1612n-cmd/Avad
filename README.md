# Avad

A wall for whatever you want to look at: links, images, video, notes, files, code, tables, colours, countdowns.

```sh
npm install
npm run dev      # http://127.0.0.1:8787
npm run deploy   # Cloudflare Workers (run `npx wrangler login` first)
```

Edit `public/content.json` to change what loads on first visit. See `Avad.md` for design decisions and status.

## Owner access
Everyone can view; only the owner can edit. Create the KV store once (`npx wrangler kv namespace create BOARDS`, put the id in `wrangler.jsonc`), then set the password: `npx wrangler secret put ADMIN_PASSWORD`. For local dev put `ADMIN_PASSWORD=...` in `.dev.vars`.
