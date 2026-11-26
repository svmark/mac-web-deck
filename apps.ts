import { execFile } from 'node:child_process';
import { readdir, stat, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Installed apps for the editor's app picker, and their icons rendered on demand. */
export type InstalledApp = { name: string; bundleId: string; path: string };

const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];
const ICON_DIR = fileURLToPath(new URL('./.runtime/icons/', import.meta.url));

function run(command: string, args: string[], timeout = 15_000) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function findApps(dir: string, depth = 2): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (entry.endsWith('.app')) found.push(full);
    else if (depth > 1) {
      try { if ((await stat(full)).isDirectory()) found.push(...await findApps(full, depth - 1)); } catch {}
    }
  }
  return found;
}

async function readApp(path: string): Promise<InstalledApp | null> {
  try {
    const json = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')]));
    const bundleId = typeof json.CFBundleIdentifier === 'string' ? json.CFBundleIdentifier : '';
    if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(bundleId)) return null;
    const name = [json.CFBundleDisplayName, json.CFBundleName].find(v => typeof v === 'string' && v.trim()) || path.split('/').pop()!.replace(/\.app$/, '');
    // Resolve symlinks (e.g. /Applications/Safari.app) so the icon has no alias badge.
    return { name, bundleId, path: await realpath(path).catch(() => path) };
  } catch { return null; }
}

let cache: { at: number; apps: InstalledApp[] } | undefined;
export async function listApps(): Promise<InstalledApp[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.apps;
  const paths = [...new Set((await Promise.all(APP_DIRS.map(d => findApps(d)))).flat())];
  const apps = (await Promise.all(paths.map(readApp))).filter((a): a is InstalledApp => a !== null);
  const unique = new Map<string, InstalledApp>();
  for (const app of apps) if (!unique.has(app.bundleId)) unique.set(app.bundleId, app);
  const sorted = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), apps: sorted };
  return sorted;
}

// NSWorkspace renders the same icon Finder shows, including apps that only ship an asset catalog.
const ICON_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  image.size = $.NSMakeSize(128, 128);
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!png.writeToFileAtomically(argv[1], true)) throw new Error('write failed');
}`;
const pending = new Map<string, Promise<string | null>>();

/** Returns a PNG path for the app icon, rendering it once into .runtime/icons/. */
export function appIcon(bundleId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(bundleId)) return Promise.resolve(null);
  const target = join(ICON_DIR, bundleId + '.png');
  if (existsSync(target)) return Promise.resolve(target);
  if (!pending.has(bundleId)) {
    pending.set(bundleId, (async () => {
      const app = (await listApps()).find(a => a.bundleId === bundleId);
      if (!app) return null;
      await mkdir(ICON_DIR, { recursive: true });
      try {
        await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON_SCRIPT, app.path, target]);
        await run('/usr/bin/sips', ['-Z', '128', target]);
        return target;
      }
      catch { return null; }
    })().finally(() => pending.delete(bundleId)));
  }
  return pending.get(bundleId)!;
}

/** Names of the user's Shortcuts (macOS Shortcuts app). */
export async function listShortcuts(): Promise<string[]> {
  try { return (await run('/usr/bin/shortcuts', ['list'])).split('\n').map(s => s.trim()).filter(Boolean); }
  catch { return []; }
}

/** Renders icons for the given apps one at a time, so the first page load already has them. */
export async function warmIcons(bundleIds: string[]) {
  for (const id of new Set(bundleIds)) await appIcon(id).catch(() => null);
}
