# CLAUDE.md

Guidance for AI coding assistants (Claude Code and others) working in this repository. Humans: see README.md (Korean) or README.en.md (English).

## What this is

Mac Web Deck: a Node.js server on the user's Mac serves a web page. A phone or tablet on the same Wi-Fi opens the page, pairs once with a 6-digit code, and taps buttons that make the Mac open apps, paths, URLs, run Shortcuts, or open the screenshot tool. The deck (pages and buttons) is edited in the browser and stored in `deck.json`.

## Commands

- `npm start` — run the server (port 4310, `PORT=` to change). Prints the pairing code.
- `npm test` — run all tests. Run after every change; add tests for new behavior.
- `npm run pair` — print a new pairing code from a running server.
- No build step, no dependencies. TypeScript runs through Node's type stripping (`--experimental-strip-types`), so only erasable syntax works: no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`), no decorators.

## Files

- `server.ts` — `createDeckServer()` (HTTP routes, pairing, auth, jobs) and the startup block at the bottom (pid file, signals: SIGUSR1 new code, SIGUSR2 reload sessions).
- `config.ts` — the `Action` union, `validateDeck()`, `commandFor()`, `loadDeck()`/`saveDeck()` (atomic write + backups).
- `apps.ts` — installed app scan (`/Applications`, `/System/Applications`, `~/Applications`), icon rendering via NSWorkspace (osascript JXA) into `.runtime/icons/`, Shortcuts list.
- `sessions.ts` — paired browsers, stored as SHA-256 hashes in `.runtime/sessions.json`.
- `public/index.html`, `public/app.js`, `public/style.css` — the whole web client, vanilla JS. `app.js` has three parts: deck view + polling, editor (works on a draft copy, saved as a whole with a revision number), button dialog.
- `scripts/admin.ts` — pair / forget-browsers / autostart (LaunchAgent `local.mac-web-deck`).
- `deck.example.json` — copied to `deck.json` on first run. `deck.json` and `.runtime/` are user data and are git-ignored.

## API (all JSON; everything except `/`, static files and `/api/pair` requires the `deck` cookie)

- `POST /api/pair {code}` → sets cookie
- `GET /api/deck` → display-only deck (no actions; app buttons get `image: /icons/<bundleId>.png`)
- `GET /api/health` → `{busy, revision}`; the client polls every 1.5 s and reloads the deck when `revision` changes
- `GET|POST /api/config` → full deck for the editor; POST needs the current `revision` (409 if stale)
- `GET /api/apps`, `GET /api/shortcuts` → editor pickers
- `POST /api/actions/<buttonId> {requestId}` → 202 `{jobId}`; same `requestId` is idempotent; one action at a time
- `GET /api/jobs/<id>` → `{state: running|success|failed, message}`

## Security rules (do not break these)

1. **No arbitrary commands.** Every action type maps to a fixed executable with arguments built in `commandFor()`. Never add an action like `{type: 'shell', command}` or anything that passes user text to `sh -c`, `osascript -e`, `eval`, etc. If the user wants custom behavior, prefer a macOS Shortcut (`runShortcut`) or a dedicated, narrowly validated action.
2. Spawn processes with `spawn`/`execFile` and an argument array. Never build a command string.
3. Validate every new field in `validateDeck()` (type, length, allowed characters). The deck is also written by the browser editor, so treat it as untrusted input.
4. Keep the `Host` allowlist, the `Origin` + `Content-Type` check on POST, the CSP header, and auth on every API route.
5. Never send action details or file paths to the client in `/api/deck`; only `/api/config` (authenticated editor) returns the full deck.
6. Error messages to the client must not include command output or paths. Log details on the server.
7. Do not commit `deck.json`, `.runtime/`, or anything with personal paths.

## Recipes

### Add a new action type

1. `config.ts`: add it to the `Action` union, validate its fields in `validateDeck()` (new `case`), and map it to a fixed command in `commandFor()`.
2. `public/app.js`: add an `<option>` in `index.html` (`#b-type`), a `targetFields` entry (or `null` if it has no fields), and a label in `actionLabel`.
3. `server.test.ts`: test validation (good and bad input) and `commandFor()` output.
4. READMEs: list it under "메뉴 꾸미기" in `README.md` (Korean, the main page) and "Build your deck" in `README.en.md`.

If the action needs something other than a one-shot command (state, a long-running helper), say so to the user before building it.

### Change the look

Everything is in `public/style.css` (CSS variables at the top; grid columns in `#grid` and its media queries). Tiles are `<button class="tile">` with `.icon`, `.label`, `.hint`.

### Show live information (battery, music, etc.)

Add a read-only `GET /api/...` route (authenticated, cached for a few seconds, fixed command), include it in the client's polling, and render it. Do not run commands on every request from every client without caching.

### Increase limits

`LIMITS` in `config.ts` (pages, buttons per page) and `LIMITS` at the top of the editor section in `public/app.js`.

## Conventions

- Keep zero runtime dependencies unless the user asks otherwise.
- Client code: build DOM with `textContent`/`createElement`, never `innerHTML` with data. Use the native `<dialog>` with `showModal()`.
- When reordering in the editor, move existing nodes rather than re-rendering, and announce the change once in `#reorder-status`.
- Run `npm test` and try the change in a browser (`npm start`, then open the printed address) before calling it done.
