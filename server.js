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
      :root { --admin-blue: #0f3460; --admin-blue-soft: #6b83a0; --admin-border: #d8e2ef; --admin-surface: #ffffff; }
      body { margin: 0; font-family: Arial, sans-serif; background: #ffffff; color: var(--admin-blue); }
      .shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: min(420px, 100%); background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 16px; box-shadow: 0 24px 48px rgba(15, 52, 96, 0.08); padding: 32px; }
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
        <p>Sign in to review booking requests submitted from the home page form.</p>
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
      :root { --admin-blue: #0f3460; --admin-blue-soft: #5f7694; --admin-border: #d8e2ef; --admin-surface: #ffffff; }
      body { margin: 0; font-family: Arial, sans-serif; background: #ffffff; color: var(--admin-blue); }
      .page { padding: 32px 24px 48px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; }
      .topbar h1 { margin: 0; font-size: 2rem; }
      .logout { display: inline-flex; align-items: center; justify-content: center; padding: 12px 18px; border: 1px solid var(--admin-blue); border-radius: 10px; background: #ffffff; color: var(--admin-blue); text-decoration: none; font-weight: 700; }
      .logout:hover { background: #f4f8fc; }
      .layout { display: grid; gap: 24px; }
      .admin-card { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 16px; box-shadow: 0 18px 36px rgba(15, 52, 96, 0.06); padding: 24px; }
      .admin-card h2 { margin: 0 0 18px; font-size: 1.35rem; }
      .composer-toggle { border: 1px solid var(--admin-border); border-radius: 16px; background: var(--admin-surface); box-shadow: 0 18px 36px rgba(15, 52, 96, 0.06); }
      .composer-toggle summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px; cursor: pointer; list-style: none; }
      .composer-toggle summary::-webkit-details-marker { display: none; }
      .composer-toggle[open] summary { border-bottom: 1px solid var(--admin-border); }
      .composer-title { display: flex; flex-direction: column; gap: 4px; }
      .composer-title strong { font-size: 1.05rem; }
      .composer-title span { color: var(--admin-blue-soft); font-size: 0.94rem; }
      .composer-button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border: 1px solid var(--admin-blue); border-radius: 999px; background: #ffffff; color: var(--admin-blue); font-weight: 700; white-space: nowrap; }
      .composer-panel { padding: 24px; }
      .news-form { display: grid; gap: 16px; }
      .news-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .news-form label { display: block; margin-bottom: 8px; font-weight: 700; }
      .news-form input, .news-form textarea { width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid var(--admin-border); border-radius: 10px; font: inherit; color: var(--admin-blue); background: #ffffff; }
      .news-form textarea { min-height: 160px; resize: vertical; }
      .news-form input:focus, .news-form textarea:focus { outline: none; border-color: var(--admin-blue); box-shadow: 0 0 0 3px rgba(15, 52, 96, 0.12); }
      .publish-btn { width: fit-content; padding: 12px 20px; border: 1px solid var(--admin-blue); border-radius: 10px; background: #ffffff; color: var(--admin-blue); font-weight: 700; cursor: pointer; }
      .publish-btn:hover { background: #f4f8fc; }
      .panel { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 16px; box-shadow: 0 18px 36px rgba(15, 52, 96, 0.06); overflow: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 1040px; }
      th, td { padding: 16px 14px; border-bottom: 1px solid var(--admin-border); text-align: left; vertical-align: top; }
      th { background: #ffffff; color: var(--admin-blue); font-size: 0.92rem; text-transform: uppercase; letter-spacing: 0.06em; }
      td { line-height: 1.5; }
      .delete-btn { padding: 10px 14px; border: 0; border-radius: 10px; background: #b02a37; color: #fff; font-weight: 700; cursor: pointer; }
      .delete-btn:hover { background: #951f2b; }
      .news-list { display: grid; gap: 16px; }
      .news-item { display: grid; grid-template-columns: 140px 1fr auto; gap: 16px; align-items: start; padding: 16px; border: 1px solid var(--admin-border); border-radius: 14px; }
      .news-thumb { width: 140px; height: 100px; object-fit: cover; border-radius: 12px; background: #f4f8fc; }
      .news-item-copy h3 { margin: 0 0 8px; }
      .news-item-copy p { margin: 0; color: var(--admin-blue-soft); line-height: 1.6; }
      .news-item-meta { margin-bottom: 8px; color: var(--admin-blue-soft); font-size: 0.92rem; font-weight: 700; }
      .empty-news { padding: 18px; border: 1px dashed var(--admin-border); border-radius: 14px; color: var(--admin-blue-soft); }
      @media (max-width: 900px) {
        .composer-toggle summary { align-items: flex-start; flex-direction: column; }
        .news-form-grid { grid-template-columns: 1fr; }
        .news-item { grid-template-columns: 1fr; }
        .news-thumb { width: 100%; height: 220px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="topbar">
        <div>
          <h1>Tech Bridge Liberia--TBL Booking List</h1>
        </div>
        <a class="logout" href="/admin/logout">Logout</a>
      </div>
      <div class="layout">
        <details class="composer-toggle">
          <summary>
            <div class="composer-title">
              <strong>Post News</strong>
              <span>Open the form only when you need to publish an update.</span>
            </div>
            <span class="composer-button">Add News</span>
          </summary>
          <div class="composer-panel">
            <form class="news-form" method="post" action="/admin/news">
              <div>
                <label for="newsTitle">News Title</label>
                <input id="newsTitle" name="title" type="text" required>
              </div>
              <div class="news-form-grid">
                <div>
                  <label for="newsAuthor">Author Name</label>
                  <input id="newsAuthor" name="author_name" type="text" required>
                </div>
                <div>
                  <label for="newsDate">Date</label>
                  <input id="newsDate" name="publish_date" type="date" required>
                </div>
              </div>
              <div>
                <label for="newsImage">Image URL</label>
                <input id="newsImage" name="image_url" type="url" placeholder="https://example.com/image.jpg" required>
              </div>
              <div>
                <label for="newsBody">Body</label>
                <textarea id="newsBody" name="body" required></textarea>
              </div>
              <button class="publish-btn" type="submit">Publish Update</button>
            </form>
          </div>
        </details>
        <section class="admin-card">
          <h2>Published News</h2>
          <div class="news-list">${newsList}</div>
        </section>
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
      </div>
    </div>
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