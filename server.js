const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const port = parseInt(process.env.PORT || '3000', 10);
const rootDir = __dirname;
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-render';
const databaseUrl = process.env.DATABASE_URL || '';
const sendGridApiKey = process.env.SENDGRID_API_KEY || '';
const sendGridSender = process.env.SENDGRID_SENDER || '';
const notifyEmail = process.env.NOTIFY_EMAIL || '';
const cookieName = 'tbl_admin_session';
const sessionDurationMs = 8 * 60 * 60 * 1000;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp'
};

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
    })
  : null;

let databaseReady = false;
let databaseInitError = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMultilineHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function createSessionToken(username, expiresAt) {
  const payload = `${username}.${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('hex');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [username, expiresAt, signature] = parts;
  const payload = `${username}.${expiresAt}`;
  const expectedSignature = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return false;
  }

  if (username !== adminUsername) {
    return false;
  }

  return Number(expiresAt) > Date.now();
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return header.split(';').reduce((cookies, pair) => {
    const [rawName, ...rawValueParts] = pair.trim().split('=');
    if (!rawName) {
      return cookies;
    }

    cookies[rawName] = decodeURIComponent(rawValueParts.join('='));
    return cookies;
  }, {});
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function setSessionCookie(response, token, request) {
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(sessionDurationMs / 1000)}`
  ];

  if (process.env.NODE_ENV === 'production' || request.headers['x-forwarded-proto'] === 'https') {
    parts.push('Secure');
  }

  response.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(response, request) {
  const parts = [
    `${cookieName}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (process.env.NODE_ENV === 'production' || request.headers['x-forwarded-proto'] === 'https') {
    parts.push('Secure');
  }

  response.setHeader('Set-Cookie', parts.join('; '));
}

async function initializeDatabase() {
  if (!pool) {
    databaseInitError = new Error('DATABASE_URL is not configured.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_requests (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      preferred_service_date DATE NOT NULL,
      service_type TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_updates (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      image_url TEXT NOT NULL,
      publish_date DATE NOT NULL,
      author_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  databaseReady = true;
  databaseInitError = null;
}

async function sendBookingNotification(submission) {
  if (!sendGridApiKey || !sendGridSender || !notifyEmail) {
    return { skipped: true };
  }

  const message = {
    personalizations: [
      {
        to: [{ email: notifyEmail }],
        subject: 'New Booking Request'
      }
    ],
    from: { email: sendGridSender, name: 'Tech Bridge Liberia Notifications' },
    reply_to: { email: submission.email, name: submission.full_name },
    content: [
      {
        type: 'text/plain',
        value:
          `New booking request:\n` +
          `Name: ${submission.full_name}\n` +
          `Email: ${submission.email}\n` +
          `Phone: ${submission.phone}\n` +
          `Preferred date: ${submission.preferred_service_date}\n` +
          `Service: ${submission.service_type}\n` +
          `Payment method: ${submission.payment_method}\n` +
          `Address: ${submission.address}\n`
      }
    ]
  };

  const emailResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendGridApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });

  if (!emailResponse.ok) {
    const detail = await emailResponse.text();
    throw new Error(`SendGrid error: ${emailResponse.status} ${detail}`);
  }

  return { skipped: false };
}

function renderAdminLogin(errorMessage) {
  const message = errorMessage
    ? `<p style="margin:0 0 16px;color:#b02a37;font-weight:700;">${escapeHtml(errorMessage)}</p>`
    : '';

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - Tech Bridge Liberia</title>
    <style>
      :root { --admin-blue: #0f3460; --admin-blue-soft: #6b83a0; --admin-border: #0f3460; --admin-surface: #ffffff; }
      body { margin: 0; font-family: Arial, sans-serif; background: #ffffff; color: var(--admin-blue); }
      .shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: min(420px, 100%); background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 16px; box-shadow: none; padding: 32px; }
      h1 { margin: 0 0 10px; font-size: 1.8rem; }
      p { color: var(--admin-blue-soft); line-height: 1.6; }
      label { display: block; margin: 16px 0 8px; font-weight: 700; }
      input { width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid var(--admin-border); border-radius: 10px; font-size: 1rem; color: var(--admin-blue); background: #ffffff; }
      input:focus { outline: none; border-color: var(--admin-blue); box-shadow: 0 0 0 3px rgba(15, 52, 96, 0.12); }
      button { width: 100%; margin-top: 20px; padding: 14px; border: 1px solid var(--admin-blue); border-radius: 10px; background: #ffffff; color: var(--admin-blue); font-weight: 700; font-size: 1rem; cursor: pointer; }
      button:hover { background: #f4f8fc; }
    </style>
  </head>
  <body>
    <div class="shell">
      <form class="card" method="post" action="/admin/login">
        <h1>Admin Login</h1>
        ${message}
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Login</button>
      </form>
    </div>
  </body>
  </html>`;
}

function renderAdminDashboard(bookingRows, newsRows) {
  const bookingCount = bookingRows.length;
  const newsCount = newsRows.length;

  const bookingTableRows = bookingRows.length
    ? bookingRows.map((row) => `
        <tr>
          <td>${escapeHtml(row.full_name)}</td>
          <td>${escapeHtml(row.email)}</td>
          <td>${escapeHtml(row.phone)}</td>
          <td>${escapeHtml(row.preferred_service_date)}</td>
          <td>${escapeHtml(row.service_type)}</td>
          <td>${escapeHtml(row.payment_method)}</td>
          <td>${escapeHtml(row.address)}</td>
          <td>${escapeHtml(new Date(row.created_at).toLocaleString())}</td>
          <td>
            <form method="post" action="/admin/delete" onsubmit="return confirm('Delete this request?');">
              <input type="hidden" name="id" value="${escapeHtml(row.id)}">
              <button class="delete-btn" type="submit">Delete</button>
            </form>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="9" style="text-align:center; padding:32px;">No requests yet.</td></tr>';

  const newsList = newsRows.length
    ? newsRows.map((row) => `
        <article class="news-item">
          <img src="${escapeHtml(row.image_url)}" alt="${escapeHtml(row.title)}" class="news-thumb">
          <div class="news-item-copy">
            <div class="news-item-meta">${escapeHtml(row.publish_date)} | ${escapeHtml(row.author_name)}</div>
            <h3>${escapeHtml(row.title)}</h3>
            <p>${formatMultilineHtml(row.body)}</p>
          </div>
          <form method="post" action="/admin/news/delete" onsubmit="return confirm('Delete this news post?');">
            <input type="hidden" name="id" value="${escapeHtml(row.id)}">
            <button class="delete-btn" type="submit">Delete</button>
          </form>
        </article>`).join('')
    : '<div class="empty-news">No news posts yet.</div>';

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Booking Requests - Tech Bridge Liberia</title>
    <style>
      :root { --admin-ink: #123252; --admin-ink-soft: #5d7390; --admin-border: #174a7a; --admin-surface: #ffffff; --admin-surface-soft: #ffffff; --admin-accent: #174a7a; --admin-shadow: none; --admin-danger: #b02a37; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, sans-serif; background: #ffffff; color: var(--admin-ink); }
      button, input, textarea { font: inherit; }
      .page { max-width: 1280px; margin: 0 auto; padding: 32px 24px 48px; }
      .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 24px; }
      .topbar h1 { margin: 0; font-size: clamp(1.9rem, 4vw, 2.5rem); }
      .topbar-actions { display: flex; align-items: center; gap: 12px; }
      .menu-shell { position: relative; }
      .menu-toggle, .logout, .publish-btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 18px; border: 1px solid var(--admin-accent); border-radius: 12px; background: #ffffff; color: var(--admin-accent); text-decoration: none; font-weight: 700; cursor: pointer; transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; }
      .menu-toggle:hover, .logout:hover, .publish-btn:hover { background: #f4f8fc; }
      .menu-toggle[aria-expanded="true"] { background: var(--admin-accent); color: #ffffff; }
      .menu-panel { position: absolute; right: 0; top: calc(100% + 12px); width: 220px; padding: 10px; border: 1px solid var(--admin-border); border-radius: 16px; background: #ffffff; box-shadow: var(--admin-shadow); z-index: 10; }
      .menu-item { width: 100%; padding: 12px 14px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: var(--admin-ink); text-align: left; cursor: pointer; }
      .menu-item:hover { background: #f4f8fc; border-color: var(--admin-border); }
      .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr); gap: 20px; margin-bottom: 24px; padding: 28px; }
      .hero-copy h2 { margin: 0; font-size: 1.45rem; }
      .hero-copy p { margin: 10px 0 0; color: var(--admin-ink-soft); line-height: 1.7; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .stat-card { padding: 18px; border: 1px solid var(--admin-border); border-radius: 16px; background: #ffffff; }
      .stat-card span { display: block; color: var(--admin-ink-soft); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.08em; }
      .stat-card strong { display: block; margin-top: 8px; font-size: 2rem; }
      .layout { display: grid; gap: 24px; }
      .admin-card, .panel-card { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 20px; box-shadow: var(--admin-shadow); }
      .admin-card { padding: 24px; }
      .panel-card { overflow: hidden; }
      .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
      .section-heading h2 { margin: 0; font-size: 1.35rem; }
      .section-heading p { margin: 6px 0 0; color: var(--admin-ink-soft); line-height: 1.6; }
      .section-badge { display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid var(--admin-border); border-radius: 999px; background: #ffffff; color: var(--admin-accent); font-size: 0.9rem; font-weight: 700; white-space: nowrap; }
      .composer-card { border-style: solid; }
      .news-form { display: grid; gap: 20px; }
      .news-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .field-full { grid-column: 1 / -1; }
      .news-form label { display: block; margin-bottom: 8px; font-weight: 700; }
      .news-form input, .news-form textarea { width: 100%; padding: 13px 14px; border: 1px solid var(--admin-border); border-radius: 12px; color: var(--admin-ink); background: #ffffff; }
      .news-form textarea { min-height: 180px; resize: vertical; }
      .news-form input:focus, .news-form textarea:focus { outline: none; border-color: var(--admin-accent); box-shadow: 0 0 0 3px rgba(23, 74, 122, 0.12); }
      .form-actions { display: flex; justify-content: flex-end; }
      .panel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 24px 24px 0; }
      .panel-header h2 { margin: 0; font-size: 1.35rem; }
      .panel-header p { margin: 6px 0 0; color: var(--admin-ink-soft); }
      .panel { background: var(--admin-surface); overflow: auto; padding: 18px 24px 24px; }
      table { width: 100%; border-collapse: collapse; min-width: 1040px; }
      th, td { padding: 16px 14px; border-bottom: 1px solid var(--admin-border); text-align: left; vertical-align: top; }
      th { background: #ffffff; color: var(--admin-ink); font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.06em; }
      td { line-height: 1.5; }
      .delete-btn { padding: 10px 14px; border: 0; border-radius: 10px; background: var(--admin-danger); color: #fff; font-weight: 700; cursor: pointer; }
      .delete-btn:hover { background: #951f2b; }
      .news-list { display: grid; gap: 16px; }
      .news-item { display: grid; grid-template-columns: 160px minmax(0, 1fr) auto; gap: 18px; align-items: start; padding: 18px; border: 1px solid var(--admin-border); border-radius: 16px; background: #ffffff; }
      .news-thumb { width: 160px; height: 120px; object-fit: cover; border-radius: 14px; background: #ffffff; border: 1px solid var(--admin-border); }
      .news-item-copy h3 { margin: 0 0 8px; }
      .news-item-copy p { margin: 0; color: var(--admin-ink-soft); line-height: 1.7; }
      .news-item-meta { margin-bottom: 8px; color: var(--admin-ink-soft); font-size: 0.92rem; font-weight: 700; }
      .empty-news { padding: 22px; border: 1px solid var(--admin-border); border-radius: 16px; color: var(--admin-ink-soft); background: #ffffff; }
      [hidden] { display: none !important; }
      @media (max-width: 960px) {
        .topbar, .topbar-actions, .hero, .section-heading, .panel-header { flex-direction: column; align-items: stretch; }
        .topbar-actions { width: 100%; }
        .menu-shell { width: 100%; }
        .menu-toggle, .logout, .publish-btn { width: 100%; }
        .menu-panel { position: static; width: 100%; margin-top: 12px; }
        .hero, .stats, .news-form-grid, .news-item { grid-template-columns: 1fr; }
        .news-thumb { width: 100%; height: 220px; }
        .form-actions { justify-content: stretch; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="topbar">
        <div>
          <h1>Tech Bridge Liberia Admin</h1>
        </div>
        <div class="topbar-actions">
          <div class="menu-shell">
            <button class="menu-toggle" id="adminMenuToggle" type="button" aria-expanded="false" aria-controls="adminMenu">Menu</button>
            <div class="menu-panel" id="adminMenu" hidden>
              <button class="menu-item" type="button" data-target="newsComposer">Post News</button>
              <button class="menu-item" type="button" data-target="publishedNews">Published News</button>
              <button class="menu-item" type="button" data-target="bookingRequests">Booking Requests</button>
            </div>
          </div>
          <a class="logout" href="/admin/logout">Logout</a>
        </div>
      </div>

      <section class="admin-card hero">
        <div class="hero-copy">
          <h2>Overview</h2>
        </div>
        <div class="stats">
          <div class="stat-card">
            <span>Booking Requests</span>
            <strong>${bookingCount}</strong>
          </div>
          <div class="stat-card">
            <span>Published News</span>
            <strong>${newsCount}</strong>
          </div>
        </div>
      </section>

      <div class="layout">
        <section class="admin-card composer-card" id="newsComposer" hidden>
          <div class="section-heading">
            <div>
              <h2>Post News</h2>
            </div>
            <span class="section-badge">Publishing Panel</span>
          </div>
          <form class="news-form" method="post" action="/admin/news">
            <div class="news-form-grid">
              <div class="field-full">
                <label for="newsTitle">News Title</label>
                <input id="newsTitle" name="title" type="text" required>
              </div>
              <div>
                <label for="newsAuthor">Author Name</label>
                <input id="newsAuthor" name="author_name" type="text" required>
              </div>
              <div>
                <label for="newsDate">Date</label>
                <input id="newsDate" name="publish_date" type="date" required>
              </div>
              <div class="field-full">
                <label for="newsImage">Image URL</label>
                <input id="newsImage" name="image_url" type="url" placeholder="https://example.com/image.jpg" required>
              </div>
              <div class="field-full">
                <label for="newsBody">Body</label>
                <textarea id="newsBody" name="body" required></textarea>
              </div>
            </div>
            <div class="form-actions">
              <button class="publish-btn" type="submit">Publish Update</button>
            </div>
          </form>
        </section>
        <section class="admin-card" id="publishedNews">
          <div class="section-heading">
            <div>
              <h2>Published News</h2>
            </div>
            <span class="section-badge">${newsCount} Total</span>
          </div>
          <div class="news-list">${newsList}</div>
        </section>
        <section class="panel-card" id="bookingRequests">
          <div class="panel-header">
            <div>
              <h2>Booking Requests</h2>
            </div>
            <span class="section-badge">${bookingCount} Pending</span>
          </div>
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Preferred Date</th>
                  <th>Service</th>
                  <th>Payment</th>
                  <th>Address</th>
                  <th>Submitted</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>${bookingTableRows}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
    <script>
      const menuToggle = document.getElementById('adminMenuToggle');
      const menuPanel = document.getElementById('adminMenu');
      const composer = document.getElementById('newsComposer');

      const setMenuState = (isOpen) => {
        menuToggle.setAttribute('aria-expanded', String(isOpen));
        menuPanel.hidden = !isOpen;
      };

      const openComposer = () => {
        composer.hidden = false;
        composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      menuToggle.addEventListener('click', () => {
        const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
        setMenuState(!isOpen);
      });

      menuPanel.querySelectorAll('[data-target]').forEach((button) => {
        button.addEventListener('click', () => {
          const target = document.getElementById(button.getAttribute('data-target'));
          if (!target) {
            return;
          }

          if (button.getAttribute('data-target') === 'newsComposer') {
            openComposer();
          } else {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }

          setMenuState(false);
        });
      });

      document.addEventListener('click', (event) => {
        if (!menuShellContains(event.target)) {
          setMenuState(false);
        }
      });

      function menuShellContains(target) {
        return menuToggle.contains(target) || menuPanel.contains(target);
      }
    </script>
  </body>
  </html>`;
}

function sendFile(filePath, response) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extension] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }

    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  });
}

function serveStatic(request, response) {
  const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(rootDir, relativePath);

  if (!resolvedPath.startsWith(rootDir)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.stat(resolvedPath, (error, stats) => {
    if (!error && stats.isDirectory()) {
      sendFile(path.join(resolvedPath, 'index.html'), response);
      return;
    }

    const targetPath = error ? path.join(rootDir, 'index.html') : resolvedPath;
    sendFile(targetPath, response);
  });
}

async function handleBookingRequest(request, response) {
  if (!databaseReady || !pool) {
    sendJson(response, 503, {
      error: databaseInitError ? databaseInitError.message : 'Database is not ready.'
    });
    return;
  }

  try {
    const body = await readRequestBody(request);
    const payload = JSON.parse(body || '{}');
    const submission = {
      full_name: String(payload.full_name || '').trim(),
      email: String(payload.email || '').trim(),
      phone: String(payload.phone || '').trim(),
      preferred_service_date: String(payload.preferred_service_date || '').trim(),
      service_type: String(payload.service_type || '').trim(),
      payment_method: String(payload.payment_method || '').trim(),
      address: String(payload.address || '').trim()
    };

    const missingField = Object.entries(submission).find(([, value]) => !value);
    if (missingField) {
      sendJson(response, 400, { error: `Missing field: ${missingField[0]}` });
      return;
    }

    await pool.query(
      `INSERT INTO booking_requests
        (full_name, email, phone, preferred_service_date, service_type, payment_method, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        submission.full_name,
        submission.email,
        submission.phone,
        submission.preferred_service_date,
        submission.service_type,
        submission.payment_method,
        submission.address
      ]
    );

    try {
      await sendBookingNotification(submission);
    } catch (notificationError) {
      console.error('Booking email notification failed:', notificationError);
    }

    sendJson(response, 201, { ok: true });
  } catch (error) {
    console.error('Booking submission failed:', error);
    sendJson(response, 500, { error: 'Unable to save booking request.' });
  }
}

async function handleAdminLogin(request, response) {
  const body = await readRequestBody(request);
  const form = new URLSearchParams(body);
  const username = form.get('username') || '';
  const password = form.get('password') || '';

  if (!adminPassword) {
    response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminLogin('ADMIN_PASSWORD is not configured on the server.'));
    return;
  }

  if (username !== adminUsername || password !== adminPassword) {
    response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminLogin('Invalid username or password.'));
    return;
  }

  const expiresAt = Date.now() + sessionDurationMs;
  setSessionCookie(response, createSessionToken(username, expiresAt), request);
  redirect(response, '/admin');
}

async function handleAdminDashboard(request, response) {
  const cookies = parseCookies(request);
  if (!verifySessionToken(cookies[cookieName])) {
    redirect(response, '/admin/login');
    return;
  }

  if (!databaseReady || !pool) {
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminDashboard([], []));
    return;
  }

  try {
    const bookingResult = await pool.query(
      `SELECT id, full_name, email, phone, preferred_service_date, service_type, payment_method, address, created_at
       FROM booking_requests
       ORDER BY created_at DESC`
    );

    const newsResult = await pool.query(
      `SELECT id, title, body, image_url, publish_date, author_name, created_at
       FROM news_updates
       ORDER BY publish_date DESC, created_at DESC`
    );

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminDashboard(bookingResult.rows, newsResult.rows));
  } catch (error) {
    console.error('Admin query failed:', error);
    response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminDashboard([], []));
  }
}

async function handleAdminNewsCreate(request, response) {
  const cookies = parseCookies(request);
  if (!verifySessionToken(cookies[cookieName])) {
    redirect(response, '/admin/login');
    return;
  }

  if (!databaseReady || !pool) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Database is not ready.');
    return;
  }

  try {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const newsItem = {
      title: String(form.get('title') || '').trim(),
      body: String(form.get('body') || '').trim(),
      image_url: String(form.get('image_url') || '').trim(),
      publish_date: String(form.get('publish_date') || '').trim(),
      author_name: String(form.get('author_name') || '').trim()
    };

    const missingField = Object.entries(newsItem).find(([, value]) => !value);
    if (missingField) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Missing field: ${missingField[0]}`);
      return;
    }

    await pool.query(
      `INSERT INTO news_updates (title, body, image_url, publish_date, author_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [newsItem.title, newsItem.body, newsItem.image_url, newsItem.publish_date, newsItem.author_name]
    );

    redirect(response, '/admin');
  } catch (error) {
    console.error('Create news failed:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unable to publish news update.');
  }
}

async function handleAdminNewsDelete(request, response) {
  const cookies = parseCookies(request);
  if (!verifySessionToken(cookies[cookieName])) {
    redirect(response, '/admin/login');
    return;
  }

  if (!databaseReady || !pool) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Database is not ready.');
    return;
  }

  try {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const id = Number(form.get('id'));

    if (!Number.isInteger(id) || id <= 0) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid news id.');
      return;
    }

    await pool.query('DELETE FROM news_updates WHERE id = $1', [id]);
    redirect(response, '/admin');
  } catch (error) {
    console.error('Delete news failed:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unable to delete news update.');
  }
}

async function handleNewsApi(response) {
  if (!databaseReady || !pool) {
    sendJson(response, 503, {
      error: databaseInitError ? databaseInitError.message : 'Database is not ready.'
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, title, body, image_url, publish_date, author_name, created_at
       FROM news_updates
       ORDER BY publish_date DESC, created_at DESC`
    );
    sendJson(response, 200, { items: result.rows });
  } catch (error) {
    console.error('News API failed:', error);
    sendJson(response, 500, { error: 'Unable to load news updates.' });
  }
}

async function handleAdminDelete(request, response) {
  const cookies = parseCookies(request);
  if (!verifySessionToken(cookies[cookieName])) {
    redirect(response, '/admin/login');
    return;
  }

  if (!databaseReady || !pool) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Database is not ready.');
    return;
  }

  try {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    const id = Number(form.get('id'));

    if (!Number.isInteger(id) || id <= 0) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid request id.');
      return;
    }

    await pool.query('DELETE FROM booking_requests WHERE id = $1', [id]);
    redirect(response, '/admin');
  } catch (error) {
    console.error('Delete request failed:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unable to delete request.');
  }
}

const server = http.createServer(async (request, response) => {
  const method = request.method || 'GET';
  const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;

  if (method === 'POST' && pathname === '/api/bookings') {
    await handleBookingRequest(request, response);
    return;
  }

  if (method === 'GET' && pathname === '/api/news') {
    await handleNewsApi(response);
    return;
  }

  if (method === 'GET' && pathname === '/admin/login') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminLogin(''));
    return;
  }

  if (method === 'POST' && pathname === '/admin/login') {
    await handleAdminLogin(request, response);
    return;
  }

  if (method === 'GET' && pathname === '/admin/logout') {
    clearSessionCookie(response, request);
    redirect(response, '/admin/login');
    return;
  }

  if (method === 'GET' && pathname === '/admin') {
    await handleAdminDashboard(request, response);
    return;
  }

  if (method === 'POST' && pathname === '/admin/delete') {
    await handleAdminDelete(request, response);
    return;
  }

  if (method === 'POST' && pathname === '/admin/news') {
    await handleAdminNewsCreate(request, response);
    return;
  }

  if (method === 'POST' && pathname === '/admin/news/delete') {
    await handleAdminNewsDelete(request, response);
    return;
  }

  serveStatic(request, response);
});

initializeDatabase().catch((error) => {
  databaseInitError = error;
  console.error('Database initialization failed:', error);
});

server.listen(port, () => {
  console.log(`Tech Bridge server running on port ${port}`);
});