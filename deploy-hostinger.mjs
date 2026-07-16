import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = process.env.DEPLOY_DOMAIN || 'ntfliiiix.one-click-server.online';
const CREDS_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'hostinger-mcp', 'credentials.json');
const ZIP_PATH = path.join(__dirname, 'Netflix-Node.zip');

function loadToken() {
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  if (!raw.access_token) throw new Error('Missing Hostinger access_token. Run hostinger-relogin first.');
  return raw.access_token;
}

async function api(pathname, options = {}) {
  const token = loadToken();
  const res = await fetch(`https://developers.hostinger.com/api${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Hostinger API ${pathname} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function main() {
  if (!fs.existsSync(ZIP_PATH)) throw new Error(`Zip not found: ${ZIP_PATH}`);

  console.log('Checking Hostinger websites...');
  const websites = await api('/hosting/v1/websites');
  console.log('Websites:', JSON.stringify(websites, null, 2));

  const zipBuffer = fs.readFileSync(ZIP_PATH);
  const form = new FormData();
  form.append('archive', new Blob([zipBuffer], { type: 'application/zip' }), 'Netflix-Node.zip');

  console.log(`Deploying to ${DOMAIN}...`);
  const result = await api(`/hosting/v1/nodejs/${encodeURIComponent(DOMAIN)}/build-from-archive`, {
    method: 'POST',
    body: form
  });
  console.log('Deploy started:', JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
