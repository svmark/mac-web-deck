import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadDeck, validateDeck, saveDeck, allButtons, commandFor } from './config.ts';
import type { Action, Deck } from './config.ts';
import { SessionStore } from './sessions.ts';
import { listApps, appIcon, listShortcuts, warmIcons } from './apps.ts';

export class UserActionError extends Error { publicMessage: string; constructor(message: string) { super(message); this.publicMessage = message; } }

/** Runs a fixed command with literal arguments (no shell). */
export function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', chunk => { if (diagnostic.length < 4096) diagnostic += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new UserActionError('The command timed out. Check your Mac.')); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`exit ${code}: ${diagnostic.trim().slice(0, 300)}`));
    });
  });
}
export const launchAction = (action: Action) => { const [command, args] = commandFor(action); return runCommand(command, args); };

type Options = {
  launch?: (action: Action) => Promise<void>;
  config?: unknown;
  persist?: (deck: Deck) => Promise<void>;
  sessions?: SessionStore;
  apps?: { list: typeof listApps; icon: typeof appIcon; shortcuts: typeof listShortcuts; warm?: typeof warmIcons };
};

export function createDeckServer({ launch = launchAction, config = loadDeck(), persist = saveDeck, sessions = new SessionStore(), apps = { list: listApps, icon: appIcon, shortcuts: listShortcuts, warm: warmIcons } }: Options = {}) {
  let deck = validateDeck(config);
  const warm = () => void apps.warm?.(allButtons(deck).flatMap(b => b.action.type === 'openApp' ? [b.action.bundleId] : []));
  warm();
  let revision = 1;
  let saving = false;
  let busy = false;
  let pairingCode = '';
  let expiresAt = 0;
  let attempts = 0;
  const jobs = new Map<string, { state: string; message: string }>();
  const rotatePairingCode = () => { pairingCode = String(randomInt(100000, 1000000)); expiresAt = Date.now() + 10 * 60_000; attempts = 0; return pairingCode; };
  rotatePairingCode();

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const host = req.headers.host;
      // Reject unknown Host headers (DNS rebinding) and cross-site requests.
      if (!host || !allowedHosts.has(host.toLowerCase())) return json(403, { message: 'Unknown host.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { message: 'Cross-site request refused.' });
      if (req.method === 'POST' && (req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json')) {
        return json(403, { message: 'Request origin could not be verified.' });
      }
      const url = req.url || '/';
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/manifest.webmanifest'].includes(url)) {
        const name = url === '/' ? 'index.html' : url.slice(1);
        const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json' };
        const body = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${types[name.split('.').pop()!]}; charset=utf-8` });
        return res.end(body);
      }
      let body: Record<string, any> = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 256 * 1024) return json(413, { message: 'Request too large.' });
        }
        try { body = JSON.parse(raw); } catch { return json(400, { message: 'Invalid JSON.' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return json(400, { message: 'Invalid request.' });
      }
      if (req.method === 'POST' && url === '/api/pair') {
        if (++attempts > 10 || Date.now() > expiresAt || body.code !== pairingCode) {
          return json(403, { message: 'Wrong or expired code. Run "npm run pair" on the Mac for a new one.' });
        }
        pairingCode = '';
        const token = sessions.create();
        res.setHeader('Set-Cookie', `deck=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${180 * 24 * 3600}`);
        return json(200, { ok: true });
      }
      const token = /(?:^|;\s*)deck=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      if (!sessions.has(token)) return json(401, { message: 'Enter the pairing code shown on your Mac.' });

      if (req.method === 'GET' && /^\/icons\/[a-zA-Z0-9.-]+\.png$/.test(url)) {
        const file = await apps.icon(url.slice('/icons/'.length, -'.png'.length));
        if (!file) return json(404, { message: 'No icon.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && url === '/api/deck') {
        const pages = deck.pages.map(page => ({ ...page, buttons: page.buttons.map(({ action, ...display }) => ({
          ...display, ...(action.type === 'openApp' ? { image: `/icons/${action.bundleId}.png` } : {})
        })) }));
        return json(200, { revision, title: deck.title, pages });
      }
      if (req.method === 'GET' && url === '/api/health') return json(200, { busy: busy || saving, revision });
      if (req.method === 'GET' && url === '/api/config') return json(200, { deck, revision });
      if (req.method === 'GET' && url === '/api/apps') return json(200, (await apps.list()).map(({ name, bundleId }) => ({ name, bundleId })));
      if (req.method === 'GET' && url === '/api/shortcuts') return json(200, await apps.shortcuts());
      if (req.method === 'POST' && url === '/api/config') {
        if (busy || saving) return json(409, { message: 'A button is running or a save is in progress. Try again.' });
        if (body.revision !== revision) return json(409, { message: 'The deck changed elsewhere. Reload the editor.' });
        let updated: Deck;
        try { updated = validateDeck(body.deck); } catch (error) { return json(400, { message: (error as Error).message }); }
        saving = true;
        try { await persist(updated); deck = updated; revision++; warm(); return json(200, { revision }); }
        catch (error) { console.error('Save failed:', (error as Error).message); return json(500, { message: 'Could not save. The previous deck is kept.' }); }
        finally { saving = false; }
      }
      if (req.method === 'GET' && url.startsWith('/api/jobs/')) {
        const job = jobs.get(url.slice('/api/jobs/'.length));
        return json(job ? 200 : 404, job || { message: 'Unknown job.' });
      }
      if (req.method === 'POST' && url.startsWith('/api/actions/')) {
        const button = allButtons(deck).find(b => b.id === decodeURIComponent(url.slice('/api/actions/'.length)));
        if (!button) return json(404, { message: 'Unknown button.' });
        const id = body.requestId;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) return json(400, { message: 'Invalid request id.' });
        if (jobs.has(id)) return json(200, { jobId: id });
        if (busy || saving) return json(409, { message: 'Another button is still running.' });
        if (jobs.size >= 1000) jobs.delete(jobs.keys().next().value!);
        busy = true;
        jobs.set(id, { state: 'running', message: 'Running…' });
        json(202, { jobId: id });
        void Promise.resolve().then(() => launch(button.action)).then(
          () => { jobs.set(id, { state: 'success', message: `${button.label} · done` }); },
          error => {
            console.error(`Button "${button.id}" failed:`, error.message);
            jobs.set(id, { state: 'failed', message: error.publicMessage || `${button.label} · failed. See the server log on your Mac.` });
          }).finally(() => { busy = false; });
        return;
      }
      json(404, { message: 'Not found.' });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) json(500, { message: 'Server error.' }); else res.end();
    }
  });

  const allowedHosts = new Set<string>();
  server.on('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    const names = ['localhost', '127.0.0.1', hostname(), hostname().split('.')[0] + '.local',
      ...Object.values(networkInterfaces()).flat().filter(n => n?.family === 'IPv4').map(n => n!.address)];
    for (const name of names) allowedHosts.add(`${name}:${address.port}`.toLowerCase());
  });
  return { server, sessions, getPairingCode: () => pairingCode, rotatePairingCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = new URL('./.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const sessions = new SessionStore(fileURLToPath(new URL('sessions.json', runtime)));
  const { server, getPairingCode, rotatePairingCode } = createDeckServer({ sessions });
  const pidFile = new URL('server.pid', runtime);
  const port = Number(process.env.PORT || 4310);
  const local = hostname().split('.')[0] + '.local';
  const showCode = (code: string) => console.log(`Pairing code: ${code} (valid 10 minutes, single use)`);
  process.on('SIGUSR1', () => showCode(rotatePairingCode()));           // npm run pair
  process.on('SIGUSR2', () => { sessions.reload(); console.log('Paired browsers reloaded.'); }); // npm run forget-browsers
  const stop = async () => { await unlink(pidFile).catch(() => {}); server.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.on('error', error => { console.error('Could not start:', error.message); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', async () => {
    await writeFile(pidFile, String(process.pid), { mode: 0o600 });
    console.log(`Mac Web Deck is running.\n  On this Mac:   http://localhost:${port}\n  Other devices: http://${local}:${port}`);
    for (const entry of Object.values(networkInterfaces()).flat()) {
      if (entry?.family === 'IPv4' && !entry.internal) console.log(`                 http://${entry.address}:${port}`);
    }
    showCode(getPairingCode());
    console.log(`Paired browsers: ${sessions.size}. Stop with Ctrl+C.`);
  });
}
