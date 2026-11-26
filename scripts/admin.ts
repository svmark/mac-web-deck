// npm run pair | forget-browsers | autostart:install | autostart:remove
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, '.runtime');
const label = 'local.mac-web-deck';
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const uid = process.getuid!();

function serverPid(): number | null {
  try {
    const pid = Number(readFileSync(join(runtime, 'server.pid'), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}
function lastLog(pattern: RegExp) {
  for (const file of ['server.out.log']) {
    try { const lines = readFileSync(join(runtime, file), 'utf8').split('\n').filter(l => pattern.test(l)); if (lines.length) return lines.at(-1); } catch {}
  }
  return undefined;
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const command = process.argv[2];
switch (command) {
  case 'pair': {
    const pid = serverPid();
    if (!pid) { console.error('The server is not running. Start it with "npm start".'); process.exit(1); }
    process.kill(pid, 'SIGUSR1');
    await new Promise(r => setTimeout(r, 500));
    const line = lastLog(/^Pairing code:/);
    console.log(existsSync(plistPath) && line ? line : 'A new pairing code was printed in the server window.');
    break;
  }
  case 'forget-browsers': {
    const file = join(runtime, 'sessions.json');
    if (existsSync(file)) unlinkSync(file);
    const pid = serverPid();
    if (pid) process.kill(pid, 'SIGUSR2');
    console.log('All paired browsers were removed. Pair again with "npm run pair".');
    break;
  }
  case 'autostart:install': {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>--experimental-strip-types</string>
    <string>${xml(join(root, 'server.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(join(runtime, 'server.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(runtime, 'server.err.log'))}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist);
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch {}
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    console.log(`Installed. The server now starts when you log in.\n  Logs: ${runtime}/server.out.log\n  Pairing code: npm run pair`);
    break;
  }
  case 'autostart:remove': {
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch {}
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log('Removed. The server no longer starts at login.');
    break;
  }
  default:
    console.log('Usage: npm run pair | npm run forget-browsers | npm run autostart:install | npm run autostart:remove');
}
