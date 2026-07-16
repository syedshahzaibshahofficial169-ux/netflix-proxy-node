import { existsSync, readdirSync } from 'fs';
import path from 'path';

const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const npxDir = path.join(localAppData, 'npm-cache', '_npx');
let modPath = '';
if (existsSync(npxDir)) {
  for (const d of readdirSync(npxDir)) {
    const p = path.join(npxDir, d, 'node_modules', 'hostinger-api-mcp', 'src', 'core', 'oauth.js');
    if (existsSync(p)) { modPath = p; break; }
  }
}
if (!modPath) throw new Error('hostinger-api-mcp oauth.js not found');

const { OAuthProvider } = await import('file:///' + modPath.replace(/\\/g, '/'));
const oauth = new OAuthProvider();
try {
  const token = await oauth.reauthenticate();
  console.log('TOKEN_OK');
} catch (e) {
  console.error('TOKEN_FAIL', e.message || e);
  process.exit(1);
}
