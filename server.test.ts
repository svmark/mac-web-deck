import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { createDeckServer } from './server.ts';
import { validateDeck, commandFor, loadDeck, saveDeck } from './config.ts';
import { SessionStore } from './sessions.ts';

const example = JSON.parse(readFileSync(new URL('./deck.example.json', import.meta.url), 'utf8'));
const fakeApps = {
  list: async () => [{ name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' }],
  icon: async () => null,
  shortcuts: async () => ['Morning']
};

async function start(options: Parameters<typeof createDeckServer>[0] = {}) {
  const deck = createDeckServer({ config: example, persist: async () => {}, apps: fakeApps, ...options });
  await new Promise<void>(resolve => deck.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(deck.server.address() as { port: number }).port}`;
  const headers: Record<string, string> = { Origin: base, 'Content-Type': 'application/json', Cookie: '' };
  const get = (path: string) => fetch(base + path, { headers });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const pair = async () => {
    const response = await post('/api/pair', { code: deck.getPairingCode() });
    headers.Cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response;
  };
  const close = async () => { deck.server.closeAllConnections(); await new Promise(resolve => deck.server.close(resolve)); };
  return { deck, base, headers, get, post, pair, close };
}

test('pairing, origin and host checks, single-use code', async () => {
  const s = await start({ launch: async () => {} });
  try {
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await s.get('/api/deck')).status, 401);
    assert.equal((await s.post('/api/pair', { code: s.deck.getPairingCode() }, { Origin: 'http://evil.example' })).status, 403);
    const port = Number(new URL(s.base).port);
    const rebound = await new Promise<number>((resolve, reject) => request({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example:4310' } }, r => { r.resume(); resolve(r.statusCode!); }).on('error', reject).end());
    assert.equal(rebound, 403); // DNS rebinding: unknown Host header
    const code = s.deck.getPairingCode();
    assert.equal((await s.pair()).status, 200);
    assert.equal((await s.post('/api/pair', { code })).status, 403);
    const view = await (await s.get('/api/deck')).json();
    assert.equal(view.pages[0].buttons[0].image, '/icons/com.apple.Safari.png');
    assert.ok(view.pages.every((p: any) => p.buttons.every((b: any) => !('action' in b))));
    assert.deepEqual(await (await s.get('/api/apps')).json(), [{ name: 'Safari', bundleId: 'com.apple.Safari' }]);
    assert.deepEqual(await (await s.get('/api/shortcuts')).json(), ['Morning']);
  } finally { await s.close(); }
});

test('buttons run once per request id and report results', async () => {
  const actions: unknown[] = [];
  let finish = () => {};
  const s = await start({ launch: action => { actions.push(action); return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await s.pair();
    assert.equal((await s.post('/api/actions/safari', { requestId: 'a'.repeat(32) })).status, 202);
    assert.equal((await s.post('/api/actions/safari', { requestId: 'a'.repeat(32) })).status, 200);
    assert.equal((await s.post('/api/actions/mail', { requestId: 'b'.repeat(32) })).status, 409);
    assert.equal((await s.post('/api/actions/nope', { requestId: 'c'.repeat(32) })).status, 404);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await s.get('/api/jobs/' + 'a'.repeat(32))).json()).state, 'success');
    assert.deepEqual(actions, [{ type: 'openApp', bundleId: 'com.apple.Safari' }]);
  } finally { await s.close(); }
});

test('failures are reported without leaking command details', async () => {
  const s = await start({ launch: async () => { throw new Error('secret detail'); } });
  try {
    await s.pair();
    await s.post('/api/actions/safari', { requestId: 'd'.repeat(32) });
    await new Promise(resolve => setImmediate(resolve));
    const job = await (await s.get('/api/jobs/' + 'd'.repeat(32))).json();
    assert.equal(job.state, 'failed');
    assert.ok(!job.message.includes('secret'));
  } finally { await s.close(); }
});

test('editor saves whole decks with revision checks and validation', async () => {
  const saved: unknown[] = [];
  const s = await start({ launch: async () => {}, persist: async deck => { saved.push(deck); } });
  try {
    await s.pair();
    const { deck, revision } = await (await s.get('/api/config')).json();
    deck.pages.push({ id: 'new', title: 'New', buttons: [{ id: 'docs', label: 'Docs', action: { type: 'openPath', path: '~/Documents' } }] });
    assert.equal((await s.post('/api/config', { deck, revision })).status, 200);
    assert.equal((await s.post('/api/config', { deck, revision })).status, 409); // stale revision
    const bad = structuredClone(deck); bad.pages[0].buttons[0].action = { type: 'shell', command: 'rm -rf ~' };
    assert.equal((await s.post('/api/config', { deck: bad, revision: revision + 1 })).status, 400);
    assert.equal(saved.length, 1);
    assert.equal((await s.post('/api/actions/docs', { requestId: 'e'.repeat(32) })).status, 202);
  } finally { await s.close(); }
});

test('deck validation and literal command arguments', () => {
  const deck = validateDeck(example);
  assert.equal(deck.pages.length, 2);
  assert.throws(() => validateDeck({ ...example, pages: [...example.pages, example.pages[0]] }), /unique/);
  assert.throws(() => validateDeck({ title: 'x', pages: [{ id: 'p', title: 'p', buttons: Array.from({ length: 13 }, (_, i) => ({ id: 'b' + i, label: 'b', action: { type: 'screenshot' } })) }] }), /0-12/);
  assert.throws(() => validateDeck({ title: 'x', pages: [{ id: 'p', title: 'p', buttons: [{ id: 'b', label: 'b', action: { type: 'openUrl', url: 'file:///etc/passwd' } }] }] }), /http/);
  assert.throws(() => validateDeck({ title: 'x', pages: [{ id: 'p', title: 'p', buttons: [{ id: 'b', label: 'b', action: { type: 'openPath', path: 'relative/path' } }] }] }), /path/);
  assert.deepEqual(commandFor({ type: 'openPath', path: '/tmp/a folder; echo hi' }), ['/usr/bin/open', ['/tmp/a folder; echo hi']]);
  assert.deepEqual(commandFor({ type: 'openPath', path: '~/Downloads' }), ['/usr/bin/open', [join(homedir(), 'Downloads')]]);
  assert.deepEqual(commandFor({ type: 'runShortcut', name: 'Morning' }), ['/usr/bin/shortcuts', ['run', 'Morning']]);
});

test('first run copies the example deck; saves keep a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-'));
  const file = pathToFileURL(join(dir, 'deck.json'));
  const backups = pathToFileURL(join(dir, 'backups') + '/');
  const deck = loadDeck(file, new URL('./deck.example.json', import.meta.url));
  assert.ok(existsSync(file));
  deck.title = 'Changed';
  await saveDeck(deck, file, backups);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, 'Changed');
  assert.equal(readdirSync(backups).length, 1);
});

test('paired browsers survive a restart and can be forgotten', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.json');
  const first = new SessionStore(file);
  const token = first.create();
  assert.ok(!readFileSync(file, 'utf8').includes(token)); // only hashes are stored
  const second = new SessionStore(file);
  assert.ok(second.has(token));
  assert.ok(!second.has('f'.repeat(64)));
  second.clear();
  assert.ok(!new SessionStore(file).has(token));
});
