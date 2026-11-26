import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The only things a button can do. Adding a new kind of action touches three places:
 * this type + validateDeck(), commandFor() below, and the editor in public/app.js (actionKinds).
 * Never add an action that runs an arbitrary shell command taken from the deck file or a request.
 */
export type Action =
  | { type: 'openApp'; bundleId: string }
  | { type: 'openPath'; path: string }
  | { type: 'openUrl'; url: string }
  | { type: 'runShortcut'; name: string }
  | { type: 'screenshot' };
export type DeckButton = { id: string; label: string; icon?: string; hint?: string; action: Action };
export type DeckPage = { id: string; title: string; buttons: DeckButton[] };
export type Deck = { title: string; pages: DeckPage[] };

export const LIMITS = { pages: 8, buttonsPerPage: 12 } as const;
export const allButtons = (deck: Deck) => deck.pages.flatMap(page => page.buttons);

const DECK_FILE = new URL('./deck.json', import.meta.url);
const EXAMPLE_FILE = new URL('./deck.example.json', import.meta.url);
const BACKUP_DIR = new URL('./.runtime/backups/', import.meta.url);

export function validateDeck(value: unknown): Deck {
  const fail = (message: string): never => { throw new Error(`Invalid deck: ${message}`); };
  const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: any, max = 2048) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0');
  const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!object(value)) fail('expected an object.');
  const input = value as any;
  if (!text(input.title, 80)) fail('title is required (max 80 characters).');
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > LIMITS.pages) fail(`1-${LIMITS.pages} pages are required.`);
  const buttonIds = new Set<string>(), pageIds = new Set<string>();
  const pages: DeckPage[] = input.pages.map((page: any) => {
    if (!object(page) || !text(page.id) || !idPattern.test(page.id) || pageIds.has(page.id)) fail('each page needs a unique id (letters, digits, - or _).');
    if (!text(page.title, 40)) fail(`${page.id}: page title is required (max 40 characters).`);
    pageIds.add(page.id);
    if (!Array.isArray(page.buttons) || page.buttons.length > LIMITS.buttonsPerPage) fail(`${page.id}: 0-${LIMITS.buttonsPerPage} buttons per page.`);
    const buttons = page.buttons.map((b: any) => {
      if (!object(b) || !text(b.id) || !idPattern.test(b.id) || buttonIds.has(b.id)) fail('button ids must be unique across all pages.');
      buttonIds.add(b.id);
      if (!text(b.label, 80)) fail(`${b.id}: label is required (max 80 characters).`);
      if (b.icon !== undefined && b.icon !== '' && !text(b.icon, 8)) fail(`${b.id}: icon must be a short text or emoji (max 8 characters).`);
      if (b.hint !== undefined && b.hint !== '' && !text(b.hint, 100)) fail(`${b.id}: hint is too long (max 100 characters).`);
      const a = b.action;
      if (!object(a)) fail(`${b.id}: action is required.`);
      let action: Action;
      switch (a.type) {
        case 'openApp':
          if (!text(a.bundleId, 255) || !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(a.bundleId)) fail(`${b.id}: bundleId looks wrong (e.g. com.apple.Safari).`);
          action = { type: 'openApp', bundleId: a.bundleId }; break;
        case 'openPath':
          if (!text(a.path) || !(isAbsolute(a.path) || a.path.startsWith('~/'))) fail(`${b.id}: path must start with / or ~/ (e.g. ~/Documents).`);
          action = { type: 'openPath', path: a.path }; break;
        case 'openUrl': {
          let url: URL | undefined;
          try { url = new URL(a.url); } catch { fail(`${b.id}: invalid URL.`); }
          if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password) fail(`${b.id}: only http/https URLs without credentials.`);
          action = { type: 'openUrl', url: a.url }; break;
        }
        case 'runShortcut':
          if (!text(a.name, 200) || a.name.startsWith('-')) fail(`${b.id}: shortcut name is required.`);
          action = { type: 'runShortcut', name: a.name }; break;
        case 'screenshot': action = { type: 'screenshot' }; break;
        default: return fail(`${b.id}: unsupported action type "${a.type}".`);
      }
      const button: DeckButton = { id: b.id, label: b.label, action };
      if (b.icon) button.icon = b.icon;
      if (b.hint) button.hint = b.hint;
      return button;
    });
    return { id: page.id, title: page.title, buttons };
  });
  return { title: input.title, pages };
}

/** Command + literal arguments. Arguments are passed without a shell, so no quoting issues. */
export function commandFor(action: Action): [string, string[]] {
  switch (action.type) {
    case 'screenshot': return ['/usr/bin/open', ['-b', 'com.apple.screenshot.launcher']];
    case 'openApp': return ['/usr/bin/open', ['-b', action.bundleId]];
    case 'openPath': return ['/usr/bin/open', [action.path.startsWith('~/') ? join(homedir(), action.path.slice(2)) : action.path]];
    case 'openUrl': return ['/usr/bin/open', [action.url]];
    case 'runShortcut': return ['/usr/bin/shortcuts', ['run', action.name]];
  }
}

/** Loads deck.json, creating it from deck.example.json on first run. */
export function loadDeck(file = DECK_FILE, example = EXAMPLE_FILE): Deck {
  if (!existsSync(file)) copyFileSync(example, file);
  return validateDeck(JSON.parse(readFileSync(file, 'utf8')));
}

/** Atomic save. The previous deck.json is kept in .runtime/backups/ (last 20). */
export async function saveDeck(deck: Deck, target = DECK_FILE, backups = BACKUP_DIR) {
  const validated = validateDeck(deck);
  if (existsSync(target)) {
    mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(target, new URL(`deck-${stamp}.json`, backups));
    const { readdir } = await import('node:fs/promises');
    const old = (await readdir(backups)).filter(f => f.startsWith('deck-')).sort().slice(0, -20);
    await Promise.all(old.map(f => unlink(new URL(f, backups)).catch(() => {})));
  }
  const temporary = new URL(target.href + '.' + randomBytes(8).toString('hex') + '.tmp');
  try { await writeFile(temporary, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
}
