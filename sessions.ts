import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Paired browsers. Only a SHA-256 hash of each cookie token is stored, in .runtime/sessions.json,
 * so pairing survives server restarts. Sessions unused for 180 days expire.
 */
const MAX_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;
type Entry = { created: number; seen: number };

export class SessionStore {
  private entries = new Map<string, Entry>();
  private dirty = false;
  private file?: string;
  private now: () => number;
  constructor(file?: string, now = () => Date.now()) { this.file = file; this.now = now; this.reload(); }

  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  reload() {
    this.entries.clear();
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [hash, entry] of Object.entries(data as Record<string, Entry>)) {
        if (/^[a-f0-9]{64}$/.test(hash) && typeof entry?.seen === 'number') this.entries.set(hash, entry);
      }
    } catch {}
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.dirty = false;
  }

  create(): string {
    const token = randomBytes(32).toString('hex');
    const t = this.now();
    this.entries.set(this.hash(token), { created: t, seen: t });
    const sorted = [...this.entries.entries()].sort((a, b) => b[1].seen - a[1].seen);
    this.entries = new Map(sorted.slice(0, MAX_SESSIONS));
    this.persist();
    return token;
  }

  has(token: string | undefined): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const key = this.hash(token);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const t = this.now();
    if (t - entry.seen > MAX_IDLE_MS) { this.entries.delete(key); this.persist(); return false; }
    // Record activity at most once an hour to avoid writing on every request.
    if (t - entry.seen > 60 * 60 * 1000) { entry.seen = t; this.dirty = true; }
    if (this.dirty) this.persist();
    return true;
  }

  clear() { this.entries.clear(); this.persist(); }
  get size() { return this.entries.size; }
}
