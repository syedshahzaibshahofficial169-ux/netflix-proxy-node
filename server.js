import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import zlib from 'zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_HOST = 'www.netflix.com';
const TARGET_BASE = `https://${TARGET_HOST}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PROXY_DOMAINS = [
  TARGET_HOST, 'netflix.com', 'api.netflix.com', 'cdn.netflix.com', 'assets.netflix.com', 'auth.netflix.com',
  'static.netflix.com', 'id.netflix.com', 'ichnaea-web.netflix.com', 'appboot.netflix.com',
  'nflxext.com', 'assets.nflxext.com', 'codex.nflxext.com', 'help.nflxext.com',
  'nflximg.net', 'nflximg.com', 'nflxvideo.net', 'nflxso.net', 'occ.a.nflxso.net', 'dnm.nflximg.net',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.typekit.net',
  'www.googletagmanager.com', 'www.google-analytics.com', 'analytics.google.com',
  'www.google.com', 'ad.doubleclick.net', 'googleads.g.doubleclick.net',
  'stats.g.doubleclick.net', 'pagead2.googlesyndication.com',
  'www.googleadservices.com', 'syndication.google.com',
  'app.launchdarkly.com', 'events.launchdarkly.com',
  'js.stripe.com', 'm.stripe.network',
  'intercom.io', 'intercomcdn.com', 'widget.intercom.io',
  'sentry.io', 'browser.sentry-cdn.com',
  'vercel.com', 'vercel.app',
  'blob.core.windows.net', 'supabase.co'
];

function isNetflixEcosystem(host) {
  if (!host) return false;
  return host === TARGET_HOST ||
    host === 'netflix.com' ||
    host.endsWith('.netflix.com') ||
    host.endsWith('.nflxext.com') ||
    host.endsWith('.nflximg.net') ||
    host.endsWith('.nflximg.com') ||
    host.endsWith('.nflxvideo.net') ||
    host.endsWith('.nflxso.net');
}

function shouldSkipAuth(req) {
  const p = req.path.toLowerCase();
  const skip = ['/user-login', '/user-logout', '/admin', '/admin-login', '/proxy/verify', '/public/', '/__site_check', '/__update_cookies', '/cookie-check', '/site-login'];
  if (skip.some(s => p.startsWith(s))) return true;
  if (p.startsWith('/_next/') || p.startsWith('/_g/')) return true;
  if (p.startsWith('/api/') || p.startsWith('/graphql') || p.startsWith('/nq/')) return true;
  const ext = path.extname(p);
  if (['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.map', '.webp', '.avif', '.json'].includes(ext)) return true;
  const accept = req.headers.accept || '';
  const ct = req.headers['content-type'] || '';
  if (accept.includes('application/json') || ct.includes('application/json')) return true;
  if (accept.includes('text/event-stream')) return true;
  if (req.headers.upgrade === 'websocket') return true;
  return false;
}

const CRED_PATH = path.join(__dirname, 'credentials.json');
const CRED_EXAMPLE_PATH = path.join(__dirname, 'credentials.json.example');
const USAGE_PATH = path.join(__dirname, 'usage.json');

if (!fs.existsSync(CRED_PATH) && fs.existsSync(CRED_EXAMPLE_PATH)) {
  fs.copyFileSync(CRED_EXAMPLE_PATH, CRED_PATH);
}

app.use(cookieParser());

function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8')); }
  catch (e) { return {}; }
}
function saveCredentials(data) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(data, null, 2));
}

// Limits removed completely

function getAmemberConfig() {
  const cred = loadCredentials();
  const amember = cred.amember || {};
  let url = amember.url || '';
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return {
    enabled: amember.enabled !== false,
    url: url,
    api_key: amember.api_key || '',
    session_timeout: amember.session_timeout != null ? amember.session_timeout : 60,
    product_limits: amember.product_limits || {}
  };
}

// 1. Raw Body Middleware
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    req.on('error', () => next());
  } else { next(); }
});

// 2. CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 3. Site Password Middleware
app.use((req, res, next) => {
  const cred = loadCredentials();
  if (!cred.site_password_enabled) return next();

  const skip = ['/site-login', '/__site_check', '/admin', '/admin-login', '/public/', '/_g/', '/_next/'];
  if (skip.some(p => req.path.startsWith(p)) || req.path.includes('/api/') || req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/)) {
    return next();
  }

  if (req.cookies.site_auth === '1') return next();
  res.redirect('/site-login?return_to=' + encodeURIComponent(req.url));
});

// 4. aMember Auth Middleware
app.use((req, res, next) => {
  const amember = getAmemberConfig();
  if (!amember.enabled) return next();
  if (shouldSkipAuth(req)) return next();

  const sessionData = req.cookies.user_session;
  if (!sessionData) return res.redirect('/user-login');

  try {
    req.userSession = JSON.parse(sessionData);
    next();
  } catch (e) {
    res.clearCookie('user_session');
    res.redirect('/user-login');
  }
});

// 5. Session Timeout Middleware
app.use((req, res, next) => {
  const amember = getAmemberConfig();
  if (!amember.session_timeout || amember.session_timeout <= 0) return next();
  if (!req.userSession) return next();

  if (req.path.includes('/api/')) return next();

  const now = Date.now();
  const timeoutMs = amember.session_timeout * 60 * 1000;
  if (now > req.userSession.created_at + timeoutMs) {
    res.clearCookie('user_session');
    return res.redirect('/user-login?expired=1');
  }
  next();
});

// Limit Check Middleware removed completely

// Logout Blocking
app.all(['/api/auth/sign-out', '/api/auth/signout', '/api/auth/logout', '/SignOut'], (req, res) => {
  res.json({ success: true, message: "Blocked by proxy" });
});

// Static and Public files
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/admin-login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/limitreach.html', (req, res) => res.sendFile(path.join(__dirname, 'public/limitreach.html')));
app.get('/site-login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/site-login.html')));

// Admin Routes
function adminAuth(req, res, next) {
  if (req.cookies.admin_session === '1') return next();
  res.redirect('/admin-login');
}

app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.post('/admin-login', (req, res) => {
  const cred = loadCredentials();
  let bodyStr = req.rawBody ? req.rawBody.toString('utf8') : '';
  let params = new URLSearchParams(bodyStr);
  
  if (params.get('admin_password') === cred.admin_password) {
    cred.last_login = new Date().toISOString();
    saveCredentials(cred);
    res.cookie('admin_session', '1', { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
    res.redirect('/admin');
  } else {
    res.redirect('/admin-login?error=1');
  }
});
app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin-login');
});
app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/admin/data', adminAuth, (req, res) => {
  res.json(loadCredentials());
});
// endpoints removed
app.post('/admin/save', adminAuth, (req, res) => {
  const cred = loadCredentials();
  let data;
  try { data = JSON.parse(req.rawBody.toString('utf8')); } catch(e) { return res.status(400).json({error: 'Invalid JSON'}); }
  
  if (data.action === 'general') {
    cred.cookies = data.cookies;
    cred.user_agent = data.user_agent;
    cred.blocked_paths = data.blocked_paths;
    cred.watermark_enabled = data.watermark_enabled;
    cred.watermark_text = data.watermark_text;
    cred.site_password_enabled = data.site_password_enabled;
    cred.site_password = data.site_password;
    if (data.admin_password) cred.admin_password = data.admin_password;
  } else if (data.action === 'proxy') {
    cred.proxy_enabled = data.proxy_enabled;
    cred.proxy = data.proxy;
    cred.proxy_backup = data.proxy_backup;
    cred.amember = data.amember;
  } else if (data.action === 'limits' || data.action === 'products') {
    cred.amember = data.amember;
  }
  saveCredentials(cred);
  res.json({ success: true });
});

app.post('/proxy/verify', (req, res) => {
  let data;
  try { data = JSON.parse(req.rawBody.toString('utf8')); } catch(e) { return res.status(400).json({error: 'Invalid JSON'}); }
  const cred = loadCredentials();
  if (data.password === cred.proxy_password) res.json({ success: true });
  else res.json({ success: false });
});

app.post('/admin/delete-amember', adminAuth, (req, res) => {
  const cred = loadCredentials();
  if (cred.amember) {
    cred.amember = { enabled: false, limits_enabled: true, url: '', api_key: '', default_daily: 30, default_monthly: 1000, session_timeout: 5, product_limits: {} };
    saveCredentials(cred);
  }
  if (fs.existsSync(USAGE_PATH)) fs.unlinkSync(USAGE_PATH);
  res.json({ success: true });
});

// Site Login
app.get('/site-login', (req, res) => res.sendFile(path.join(__dirname, 'public/site-login.html')));
app.post('/site-login', (req, res) => {
  const cred = loadCredentials();
  let bodyStr = req.rawBody ? req.rawBody.toString('utf8') : '';
  let params = new URLSearchParams(bodyStr);
  
  if (params.get('site_password') === cred.site_password) {
    res.cookie('site_auth', '1', { maxAge: 24 * 60 * 60 * 1000 });
    res.redirect(params.get('return_to') || '/');
  } else {
    res.redirect('/site-login?error=1');
  }
});

// User Login (aMember)
app.get('/user-login', (req, res) => {
  let errorMsg = '';
  if (req.query.expired === '1') {
    errorMsg = '<div style="color:#ffc800;margin-bottom:15px;text-align:center;">Session expired. Please login again.</div>';
  } else if (req.query.error === '1') {
    errorMsg = '<div style="color:#E50914;margin-bottom:15px;text-align:center;">Invalid login or no active subscription found.</div>';
  } else if (req.query.timeout === '1') {
    errorMsg = '<div style="color:#E50914;margin-bottom:15px;text-align:center;">Login server timed out. Try again in a few seconds.</div>';
  }
  res.send(`
    <!DOCTYPE html><html><head><title>Login to Proxy</title>
    <style>body{background:#111;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
    .card{background:#222;padding:40px;border-radius:8px;max-width:400px;width:100%;box-shadow:0 4px 15px rgba(0,0,0,0.5);}
    input{width:100%;padding:12px;margin-bottom:15px;background:#000;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;}
    button{width:100%;padding:12px;background:#E50914;color:#fff;border:none;border-radius:4px;font-weight:bold;cursor:pointer;font-size:16px;}
    button:disabled{opacity:0.6;cursor:wait;}
    button:hover{background:#f40612;}
    .instruction{color:#aaa;font-size:14px;text-align:center;margin-bottom:20px;line-height:1.5;}
    </style></head>
    <body><div class="card">
    <h2 style="text-align:center;margin-top:0;">Access Netflix Proxy</h2>
    <div class="instruction">Please login with the EXACT same <b>Email</b> and <b>Password</b> that you used to purchase your subscription.</div>
    ${errorMsg}
    <form method="POST" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Logging in...';">
      <input name="login" placeholder="Email Address" required>
      <input type="password" name="pass" placeholder="Password" required>
      <button type="submit">Login</button>
    </form>
    </div></body></html>
  `);
});

app.post('/user-login', async (req, res) => {
  const amember = getAmemberConfig();
  if (!amember.enabled) return res.redirect('/');

  let bodyStr = req.rawBody ? req.rawBody.toString('utf8') : '';
  let params = new URLSearchParams(bodyStr);
  const login = params.get('login');
  const pass = params.get('pass');

  if (!login || !pass) return res.redirect('/user-login?error=1');
  if (!amember.url || !amember.api_key || amember.api_key.startsWith('YOUR_')) {
    return res.redirect('/user-login?error=1');
  }

  try {
    const url = `${amember.url}/api/check-access/by-login-pass?_key=${amember.api_key}&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const textData = await response.text();
    console.log('Response Status:', response.status);
    console.log('Response Text:', textData);
    
    let data;
    try { data = JSON.parse(textData); } catch(e) { console.error('Failed to parse JSON'); }
    
    let isAuth = false;
    let subscriptions = [];
    
    if (Array.isArray(data) && data.length > 0 && data[0].ok) {
        isAuth = true;
        subscriptions = data[0].subscriptions || data[0].active_subscriptions || Object.keys(data[0]).filter(k => !isNaN(k)) || [];
    } else if (data && data.ok) {
        isAuth = true;
        subscriptions = data.subscriptions || data.active_subscriptions || [];
    } else if (data && data.success) {
        isAuth = true;
        subscriptions = data.subscriptions || [];
    } else if (data && typeof data === 'object' && !data.error && data.ok !== false) {
        isAuth = true;
        subscriptions = data;
    }

    let hasAccess = false;
    let assignedProductId = null;
    const allowedProducts = Object.keys(amember.product_limits || {});
    
    if (isAuth) {
        if (allowedProducts.length === 0) {
            hasAccess = true;
        } else {
            let userProductIds = [];
            if (Array.isArray(subscriptions)) {
                userProductIds = subscriptions.map(s => String(s.product_id || s.id || s));
            } else if (typeof subscriptions === 'object') {
                userProductIds = Object.keys(subscriptions).map(String);
            }
            
            for (let pid of userProductIds) {
                if (allowedProducts.includes(pid)) {
                    hasAccess = true;
                    assignedProductId = pid;
                    break;
                }
            }
        }
    }
    
    if (hasAccess) {
        const sessionData = { login: login, name: login, product_id: assignedProductId || '1', created_at: Date.now() };
        res.cookie('user_session', JSON.stringify(sessionData), { maxAge: 24 * 60 * 60 * 1000 });
        res.redirect('/');
    } else {
        res.redirect('/user-login?error=1');
    }
  } catch (e) {
    console.error('aMember Auth Error:', e.message || e);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.redirect('/user-login?timeout=1');
    }
    res.redirect('/user-login?error=1');
  }
});

app.get('/user-logout', (req, res) => {
  res.clearCookie('user_session');
  res.redirect('/user-login');
});

app.get('/dashboard', (req, res) => {
  res.redirect('/');
});

// usage endpoint removed

app.get('/limitreach', (req, res) => res.sendFile(path.join(__dirname, 'public/limitreach.html')));

function rewriteAllDomains(text) {
  let str = text;

  str = str.split('https://www.netflix.com').join('');
  str = str.split('https://netflix.com').join('');
  str = str.split('http://www.netflix.com').join('');
  str = str.split('http://netflix.com').join('');

  PROXY_DOMAINS.forEach(domain => {
    if (domain !== TARGET_HOST && domain !== 'netflix.com') {
      str = str.split(`https://${domain}`).join(`/_g/${domain}`);
      str = str.split(`http://${domain}`).join(`/_g/${domain}`);
      str = str.split(`//${domain}`).join(`/_g/${domain}`);
    }
  });

  // Catch-all for any remaining external domains
  str = str.replace(/https?:\/\/([a-zA-Z0-9][-a-zA-Z0-9]*[a-zA-Z0-9]\.[a-zA-Z]{2,})/g, (match, domain) => {
    if (domain === 'localhost' || domain.includes('localhost')) return match;
    if (domain === TARGET_HOST || domain === 'netflix.com' || domain.endsWith('.netflix.com')) return match.replace(/^https?:\/\//, '/').replace(`//${domain}`, '');
    return `/_g/${domain}`;
  });

  str = str.replace(/\/\/([a-zA-Z0-9][-a-zA-Z0-9]*[a-zA-Z0-9]\.[a-zA-Z]{2,})/g, (match, domain) => {
    if (domain === 'localhost' || domain.includes('localhost')) return match;
    if (domain === TARGET_HOST || domain === 'netflix.com' || domain.endsWith('.netflix.com')) return match.replace(`//${domain}`, '');
    return `/_g/${domain}`;
  });

  return str;
}

// Proxy helper rewrite logic
function rewriteHTML(body) {
  let str = rewriteAllDomains(body.toString('utf8'));

  const cred = loadCredentials();
  let watermark = '';
  if (cred.watermark_enabled) {
    watermark = `
    <div style="
      position: fixed; 
      bottom: 20px; 
      right: 20px; 
      z-index: 999999; 
      background: rgba(15, 15, 15, 0.85); 
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #eaeaea; 
      padding: 10px 16px; 
      border-radius: 30px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      font-size: 13px; 
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-weight: 500;
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: 0.5px;
      animation: floatIn 0.8s ease-out forwards;
    ">
      <span style="
        display: inline-block;
        width: 8px;
        height: 8px;
        background-color: #22c55e;
        border-radius: 50%;
        box-shadow: 0 0 8px #22c55e;
        animation: pulseDot 2s infinite;
      "></span> 
      <span style="opacity: 0.9;">${cred.watermark_text || 'Active'}</span>
      <style>
        @keyframes floatIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseDot { 0% { opacity: 1; box-shadow: 0 0 8px #22c55e; } 50% { opacity: 0.5; box-shadow: 0 0 2px #22c55e; } 100% { opacity: 1; box-shadow: 0 0 8px #22c55e; } }
      </style>
    </div>`;
  }

  // Disable Service Workers
  str = str.replace(/navigator\.serviceWorker/g, 'null');
  str = str.replace(/'serviceWorker'\s*in\s*navigator/g, 'false');
  str = str.replace(/"serviceWorker"\s*in\s*navigator/g, 'false');

  str = str.replace(/<head([^>]*)>/i, `<head$1><script>${getProxyHelperScript()}</script>`);
  if (!str.includes('rewriteUrl')) {
    str = str.replace('</head>', `<script>${getProxyHelperScript()}</script></head>`);
  }
  str = str.replace('</body>', `${watermark}</body>`);
  return Buffer.from(str, 'utf8');
}

let cachedHelperJs = null;
function getProxyHelperScript() {
  if (cachedHelperJs) return cachedHelperJs;
  try {
    cachedHelperJs = fs.readFileSync(path.join(__dirname, 'public', 'proxy-helper.js'), 'utf8');
  } catch (e) {
    cachedHelperJs = '';
  }
  return cachedHelperJs;
}

function isValidProxyConfig(proxy) {
  if (!proxy || !proxy.host || !proxy.port) return false;
  if (!proxy.username || !proxy.password) return false;
  if (proxy.username.startsWith('YOUR_') || proxy.password.startsWith('YOUR_')) return false;
  return true;
}

function getProxyAgent(cred) {
  if (!cred.proxy_enabled) return null;
  const p = cred.proxy;
  if (isValidProxyConfig(p)) {
    return new HttpsProxyAgent(`http://${p.username}:${p.password}@${p.host}:${p.port}`);
  }
  const b = cred.proxy_backup;
  if (isValidProxyConfig(b)) {
    return new HttpsProxyAgent(`http://${b.username}:${b.password}@${b.host}:${b.port}`);
  }
  return null;
}

function sendSetupError(res, title, message) {
  res.status(503).send(`<!DOCTYPE html><html><head><title>${title}</title><style>body{background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#222;padding:32px;border-radius:10px;max-width:520px;text-align:center}h1{color:#E50914}p{color:#ccc;line-height:1.6}a{color:#fff}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p><p><a href="/admin">Open Admin Panel</a></p></div></body></html>`);
}

function stripSecurityHeaders(headers) {
  delete headers['content-security-policy'];
  delete headers['content-security-policy-report-only'];
  delete headers['x-frame-options'];
  delete headers['strict-transport-security'];
  delete headers['x-content-type-options'];
  return headers;
}

app.get('/cookie-check', (req, res) => {
  const cred = loadCredentials();
  const cookies = Array.isArray(cred.cookies) ? cred.cookies : [];
  const hasSession = cookies.some(c => c.name === 'NetflixId' || c.name === 'SecureNetflixId');
  res.json({
    auth_ok: hasSession && cookies.length > 0,
    cookie_count: cookies.length,
    likely_session: hasSession,
    message: hasSession ? 'Netflix session cookies found' : 'Missing NetflixId/SecureNetflixId — paste fresh cookies in admin'
  });
});

// Main Proxy Route
app.all('*', (req, res) => {
  const cred = loadCredentials();
  const cookies = Array.isArray(cred.cookies) ? cred.cookies : [];
  const hasNetflixCookies = cookies.some(c => c.name === 'NetflixId' || c.name === 'SecureNetflixId');
  const isDocumentRequest = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
  const isMainNetflixRoute = !req.path.startsWith('/_g/') && isDocumentRequest;

  if (isMainNetflixRoute && !hasNetflixCookies) {
    return sendSetupError(res, 'Setup Required', 'Netflix cookies are missing. Open /admin, paste fresh Netflix cookies, save, then reload this page.');
  }

  if (isMainNetflixRoute && cred.proxy_enabled && !getProxyAgent(cred)) {
    return sendSetupError(res, 'Proxy Not Configured', 'Residential proxy credentials are missing or invalid. Open /admin, set proxy host/user/password, save, then reload.');
  }

  if (cred.blocked_paths) {
    const blocked = cred.blocked_paths.split(',').map(s => s.trim());
    if (blocked.some(p => req.path.toLowerCase().includes(p.toLowerCase()))) {
      return res.redirect('/dashboard');
    }
  }

  let targetUrl = TARGET_BASE + req.url;
  let upstreamHost = TARGET_HOST;

  if (req.url.startsWith('/_g/')) {
    const gMatch = req.path.match(/^\/_g\/([a-z0-9.-]+\.[a-z]{2,})(\/.*)?$/i);
    if (gMatch) {
      upstreamHost = gMatch[1];
      const subpath = gMatch[2] || '/';
      const q = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
      targetUrl = `https://${upstreamHost}${subpath}${q}`;
    }
  }

  const options = {
    method: req.method,
    headers: { ...req.headers, host: upstreamHost, 'origin': `https://${TARGET_HOST}`, 'referer': `https://${TARGET_HOST}/`, 'user-agent': cred.user_agent || UA }
  };

  if (isNetflixEcosystem(upstreamHost) && cred.cookies && Array.isArray(cred.cookies) && cred.cookies.length > 0) {
    const cookieStr = cred.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (options.headers.cookie) {
      options.headers.cookie += `; ${cookieStr}`;
    } else {
      options.headers.cookie = cookieStr;
    }
  }
  delete options.headers['accept-encoding'];

  if (isNetflixEcosystem(upstreamHost)) {
    const agent = getProxyAgent(cred);
    if (agent) options.agent = agent;
  }

  const proxyReq = https.request(targetUrl, options, (proxyRes) => {
    if (proxyRes.statusCode === 407) {
      return sendSetupError(res, 'Proxy Authentication Failed', 'Residential proxy rejected the credentials. Check username/password in /admin and try again.');
    }

    let headers = stripSecurityHeaders({ ...proxyRes.headers });
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];

    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(c => {
        return c.replace(/Domain=[^;]+/i, `Domain=${req.hostname}`).replace(/SameSite=Strict/i, 'SameSite=Lax');
      });
    }

    if (headers['location']) {
      let loc = headers['location'];
      if (loc.startsWith(`https://${TARGET_HOST}`)) {
        headers['location'] = loc.replace(`https://${TARGET_HOST}`, '');
      } else {
        PROXY_DOMAINS.forEach(domain => {
          if (loc.startsWith(`https://${domain}`)) headers['location'] = loc.replace(`https://${domain}`, `/_g/${domain}`);
        });
      }
    }

    const contentType = headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    const isJs = contentType.includes('javascript') || contentType.includes('text/javascript') || contentType.includes('application/javascript');
    const isCss = contentType.includes('text/css');
    const isJson = contentType.includes('application/json') || contentType.includes('text/json');

    if (isHtml || isJs || isCss || isJson) {
      delete headers['content-length'];
      const encoding = headers['content-encoding'];
      if (encoding === 'gzip' || encoding === 'br' || encoding === 'deflate') {
        delete headers['content-encoding'];
      }
      res.writeHead(proxyRes.statusCode, headers);

      let body = Buffer.alloc(0);
      proxyRes.on('data', chunk => { body = Buffer.concat([body, chunk]); });
      proxyRes.on('end', () => {
        try {
          if (encoding === 'gzip') body = zlib.gunzipSync(body);
          else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
          else if (encoding === 'deflate') body = zlib.inflateSync(body);
        } catch(e) {}

        let output = isHtml ? rewriteHTML(body) : Buffer.from(rewriteAllDomains(body.toString('utf8')), 'utf8');
        res.end(output);
      });
    } else {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy request error:', e.message);
    if (!res.headersSent) {
      sendSetupError(res, 'Proxy Connection Failed', `Could not reach Netflix through the configured proxy. Verify proxy settings in /admin. (${e.message})`);
    }
  });

  if (req.rawBody) proxyReq.write(req.rawBody);
  proxyReq.end();
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://<your-lan-ip>:${PORT}`);
});

// WebSocket Support for /_g/ paths
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  // simplified websocket proxy forwarding
});
