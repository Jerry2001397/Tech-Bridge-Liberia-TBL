const crypto = require('crypto');
const Busboy = require('busboy');
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
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseStorageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'news-images';
const cookieName = 'tbl_admin_session';
const sessionDurationMs = 8 * 60 * 60 * 1000;
const newsUploadDir = path.resolve(rootDir, 'uploads', 'news');
const newsTypes = ['Partnership', 'Event', 'Contract', 'Recruitment', 'Travels', 'Training', 'Other'];
const localNewsUploadPrefix = '/uploads/news/';

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
  '.xml': 'application/xml; charset=utf-8',
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

const crawlerUserAgentPattern = /(facebookexternalhit|facebot|linkedinbot|twitterbot|xbot|whatsapp|slackbot|discordbot|telegrambot|skypeuripreview|googlebot|bingbot|embedly|pinterest|vkshare|crawler|spider|bot)/i;

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

function formatLiberiaDateTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('en-LR', {
    timeZone: 'Africa/Monrovia',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatLiberiaDate(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('en-LR', {
    timeZone: 'Africa/Monrovia',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(new Date(value));
}

function truncateText(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${protocol}://${request.headers.host || 'localhost'}`;
}

function buildAbsoluteUrl(request, targetPath) {
  return new URL(targetPath, getRequestOrigin(request)).toString();
}

function toAbsoluteMediaUrl(request, mediaUrl) {
  if (!mediaUrl) {
    return '';
  }

  if (/^https?:\/\//i.test(String(mediaUrl))) {
    return String(mediaUrl);
  }

  return buildAbsoluteUrl(request, String(mediaUrl));
}

function isCrawlerRequest(request) {
  return crawlerUserAgentPattern.test(String(request.headers['user-agent'] || ''));
}

function getNewsArticlePath(newsId) {
  return `/news/${encodeURIComponent(String(newsId))}`;
}

function normalizeNewsType(value) {
  const normalized = String(value || '').trim();
  return newsTypes.includes(normalized) ? normalized : 'Other';
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

function sanitizeFileSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'news-image';
}

function getImageExtension(filename, mimeType) {
  const extension = path.extname(filename || '').toLowerCase();
  if (extension) {
    return extension;
  }

  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.bin';
  }
}

function isSupabaseStorageConfigured() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey && supabaseStorageBucket);
}

function getStorageHealthStatus() {
  const missingEnvVars = [];

  if (!supabaseUrl) {
    missingEnvVars.push('SUPABASE_URL');
  }

  if (!supabaseServiceRoleKey) {
    missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');
  }

  if (!supabaseStorageBucket) {
    missingEnvVars.push('SUPABASE_STORAGE_BUCKET');
  }

  if (missingEnvVars.length === 0) {
    return {
      isConfigured: true,
      level: 'ok',
      label: 'CDN Storage Active',
      message: `Uploads go to Supabase bucket "${supabaseStorageBucket}" and are served from the CDN.`
    };
  }

  if (missingEnvVars.length < 3) {
    return {
      isConfigured: false,
      level: 'warning',
      label: 'CDN Setup Incomplete',
      message: `Missing ${missingEnvVars.join(', ')}. Uploads currently fall back to local server storage.`
    };
  }

  return {
    isConfigured: false,
    level: 'warning',
    label: 'Local Storage Fallback',
    message: 'CDN storage is not configured yet. Uploads currently stay on local server storage.'
  };
}

function logStartupHealthChecks() {
  const storageHealth = getStorageHealthStatus();

  if (storageHealth.isConfigured) {
    console.log(`[startup] ${storageHealth.label}: ${storageHealth.message}`);
    return;
  }

  console.warn(`[startup] ${storageHealth.label}: ${storageHealth.message}`);
}

function encodeStorageObjectPath(objectPath) {
  return String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function getSupabaseAuthHeaders() {
  const headers = {
    apikey: supabaseServiceRoleKey
  };

  // New sb_secret keys are not JWTs, so they cannot be used as Bearer tokens.
  if (!String(supabaseServiceRoleKey).startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${supabaseServiceRoleKey}`;
  }

  return headers;
}

function buildSupabasePublicImageUrl(objectPath) {
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseStorageBucket)}/${encodeStorageObjectPath(objectPath)}`;
}

function getSupabaseManagedObjectPath(imageUrl) {
  if (!isSupabaseStorageConfigured() || !imageUrl) {
    return '';
  }

  const expectedPrefix = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseStorageBucket)}/`;
  if (!String(imageUrl).startsWith(expectedPrefix)) {
    return '';
  }

  const encodedObjectPath = String(imageUrl).slice(expectedPrefix.length);
  return encodedObjectPath
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

async function uploadNewsImageToSupabase(upload, fileName) {
  const objectPath = `news/${fileName}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseStorageBucket)}/${encodeStorageObjectPath(objectPath)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...getSupabaseAuthHeaders(),
      'Content-Type': upload.mimeType,
      'x-upsert': 'false'
    },
    body: upload.buffer
  });

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text();
    throw new Error(`Supabase storage upload failed: ${uploadResponse.status} ${detail}`);
  }

  return buildSupabasePublicImageUrl(objectPath);
}

async function saveNewsImage(upload) {
  const extension = getImageExtension(upload.filename, upload.mimeType);
  const fileName = `${Date.now()}-${sanitizeFileSegment(path.basename(upload.filename || 'image', extension))}-${crypto.randomBytes(6).toString('hex')}${extension}`;

  if (isSupabaseStorageConfigured()) {
    return uploadNewsImageToSupabase(upload, fileName);
  }

  await fs.promises.mkdir(newsUploadDir, { recursive: true });
  const targetPath = path.join(newsUploadDir, fileName);

  await fs.promises.writeFile(targetPath, upload.buffer);
  return `${localNewsUploadPrefix}${fileName}`;
}

async function removeManagedNewsImage(imageUrl) {
  const supabaseObjectPath = getSupabaseManagedObjectPath(imageUrl);
  if (supabaseObjectPath) {
    const deleteUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseStorageBucket)}/${encodeStorageObjectPath(supabaseObjectPath)}`;
    const deleteResponse = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: getSupabaseAuthHeaders()
    });

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const detail = await deleteResponse.text();
      throw new Error(`Supabase storage delete failed: ${deleteResponse.status} ${detail}`);
    }

    return;
  }

  if (!imageUrl || !String(imageUrl).startsWith(localNewsUploadPrefix)) {
    return;
  }

  const resolvedPath = path.resolve(rootDir, String(imageUrl).replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(newsUploadDir)) {
    return;
  }

  try {
    await fs.promises.unlink(resolvedPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function parseMultipartForm(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      reject(new Error('Expected multipart form data.'));
      return;
    }

    const fields = {};
    let uploadError = null;
    let imageSavePromise = Promise.resolve('');

    const busboy = Busboy({
      headers: request.headers,
      limits: {
        files: 1,
        fileSize: 5 * 1024 * 1024,
        fields: 20
      }
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, file, info) => {
      if (name !== 'image') {
        file.resume();
        return;
      }

      const { filename, mimeType } = info;
      if (!filename) {
        file.resume();
        return;
      }

      if (!mimeType || !mimeType.startsWith('image/')) {
        uploadError = new Error('Image must be a valid image file.');
        file.resume();
        return;
      }

      const chunks = [];

      file.on('data', (chunk) => {
        chunks.push(chunk);
      });

      file.on('limit', () => {
        uploadError = new Error('Image file must be 5MB or smaller.');
      });

      file.on('end', () => {
        if (uploadError) {
          return;
        }

        imageSavePromise = saveNewsImage({
          filename,
          mimeType,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    busboy.on('error', reject);

    busboy.on('finish', async () => {
      if (uploadError) {
        reject(uploadError);
        return;
      }

      try {
        const imageUrl = await imageSavePromise;
        if (imageUrl) {
          fields.image_url = imageUrl;
        }
        resolve(fields);
      } catch (error) {
        reject(error);
      }
    });

    request.pipe(busboy);
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

function renderNewsArticlePage(item, request) {
  const articlePath = getNewsArticlePath(item.id);
  const articleUrl = buildAbsoluteUrl(request, articlePath);
  const imageUrl = toAbsoluteMediaUrl(request, item.image_url);
  const description = truncateText(item.body, 180) || 'Read the latest update from Tech Bridge Liberia.';
  const pageTitle = `${item.title} - Tech Bridge Liberia News`;
  const newsType = normalizeNewsType(item.news_type);
  const viewCount = Number(item.view_count) || 0;
  const shareCount = Number(item.share_count) || 0;
  const publishedAt = new Date(item.publish_date || item.created_at).toISOString();

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${escapeHtml(articleUrl)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Tech Bridge Liberia">
    <meta property="og:title" content="${escapeHtml(item.title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(articleUrl)}">
    <meta property="og:image:url" content="${escapeHtml(imageUrl)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:alt" content="${escapeHtml(item.title)}">
    <meta property="article:published_time" content="${escapeHtml(publishedAt)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(item.title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <meta name="twitter:image:alt" content="${escapeHtml(item.title)}">
    <link rel="stylesheet" href="/Style.CSS">
    <style>
      .news-article-page {
        min-height: 100vh;
        padding: 64px 20px 88px;
        background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
      }
      .news-article-shell {
        width: min(900px, 100%);
        margin: 0 auto;
        display: grid;
        gap: 24px;
      }
      .news-article-card {
        background: #ffffff;
        border: 1px solid rgba(15, 52, 96, 0.12);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 20px 44px rgba(15, 52, 96, 0.1);
      }
      .news-article-card img {
        width: 100%;
        max-height: 480px;
        object-fit: cover;
        display: block;
        background: #eef4fb;
      }
      .news-article-copy {
        padding: 28px;
        display: grid;
        gap: 16px;
      }
      .news-article-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 18px;
        color: var(--text-light);
        font-size: 0.94rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .news-article-type {
        display: inline-flex;
        width: fit-content;
        padding: 8px 13px;
        border-radius: 999px;
        border: 1px solid rgba(15, 52, 96, 0.18);
        color: var(--primary-color);
        font-weight: 700;
      }
      .news-article-copy h1 {
        margin: 0;
        color: var(--primary-color);
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.15;
      }
      .news-article-body {
        color: var(--text-light);
        line-height: 1.85;
        font-size: 1.02rem;
      }
      .news-article-body p {
        margin: 0;
      }
      .news-article-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        padding-top: 8px;
      }
      .news-article-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 18px;
        border-radius: 12px;
        border: 1px solid rgba(15, 52, 96, 0.16);
        background: #ffffff;
        color: var(--primary-color);
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
      }
      .news-article-action:hover {
        background: #f5f9ff;
      }
      @media (max-width: 640px) {
        .news-article-page {
          padding: 48px 18px 72px;
        }
        .news-article-copy {
          padding: 22px;
        }
        .news-article-actions {
          flex-direction: column;
        }
        .news-article-action {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="container">
        <h1 class="logo">Tech Bridge LIberia-TBL</h1>
        <nav>
          <ul class="nav-links">
            <li><a href="/index.html">Home</a></li>
            <li><a href="/index about.html">About</a></li>
            <li><a href="/Index Service.html">Services</a></li>
            <li><a href="/Portfolia.html">Our Portfolia</a></li>
            <li><a href="/Our Staff.html">Our Staffs</a></li>
            <li><a href="/Contact.html">Contact</a></li>
            <li><a href="/Policy.html">Policy</a></li>
            <li><a href="/News and Updates.html">News and Updates</a></li>
          </ul>
        </nav>
      </div>
    </header>

    <main class="news-article-page">
      <div class="news-article-shell">
        <a class="news-article-action" href="/News and Updates.html">Back to News</a>
        <article class="news-article-card">
          <img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}">
          <div class="news-article-copy">
            <span class="news-article-type">${escapeHtml(newsType)}</span>
            <div class="news-article-meta">
              <span>${escapeHtml(formatLiberiaDate(item.publish_date || item.created_at))}</span>
              <span>By ${escapeHtml(item.author_name)}</span>
              <span>${viewCount} views</span>
              <span>${shareCount} shares</span>
            </div>
            <h1>${escapeHtml(item.title)}</h1>
            <div class="news-article-body"><p>${formatMultilineHtml(item.body)}</p></div>
            <div class="news-article-actions">
              <button class="news-article-action" type="button" id="copyArticleLink">Copy Link</button>
              <button class="news-article-action" type="button" id="shareArticleLink">Share Article</button>
            </div>
          </div>
        </article>
      </div>
    </main>

    <script>
      const articleUrl = ${JSON.stringify(articleUrl)};
      const articleTitle = ${JSON.stringify(item.title)};
      const articleId = ${JSON.stringify(String(item.id))};

      async function registerShare() {
        try {
          await fetch('/api/news/' + encodeURIComponent(articleId) + '/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
        }
      }

      async function copyArticleLink(button) {
        try {
          await navigator.clipboard.writeText(articleUrl);
          await registerShare();
          button.textContent = 'Copied';
          window.setTimeout(() => {
            button.textContent = 'Copy Link';
          }, 1800);
        } catch (error) {
          button.textContent = 'Copy Failed';
          window.setTimeout(() => {
            button.textContent = 'Copy Link';
          }, 1800);
        }
      }

      async function shareArticle(button) {
        if (navigator.share) {
          try {
            await navigator.share({ title: articleTitle, url: articleUrl });
            await registerShare();
            return;
          } catch (error) {
            if (error && error.name === 'AbortError') {
              return;
            }
          }
        }

        await copyArticleLink(button);
      }

      document.getElementById('copyArticleLink').addEventListener('click', function() {
        copyArticleLink(this);
      });

      document.getElementById('shareArticleLink').addEventListener('click', function() {
        shareArticle(this);
      });
    </script>
  </body>
  </html>`;
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
      news_type TEXT NOT NULL DEFAULT 'Other',
      author_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE news_updates
    ADD COLUMN IF NOT EXISTS news_type TEXT NOT NULL DEFAULT 'Other'
  `);

  await pool.query(`
    ALTER TABLE news_updates
    ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE news_updates
    ADD COLUMN IF NOT EXISTS share_count BIGINT NOT NULL DEFAULT 0
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
      :root {
        --admin-blue: #0d4f9a;
        --admin-blue-deep: #0a2f63;
        --admin-blue-soft: #5c7ea6;
        --admin-border: rgba(13, 79, 154, 0.18);
        --admin-surface: rgba(255, 255, 255, 0.96);
        --admin-shadow: 0 22px 55px rgba(10, 47, 99, 0.16);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: radial-gradient(circle at top, rgba(13, 79, 154, 0.16), transparent 34%), linear-gradient(160deg, #eff6ff 0%, #dbeafe 48%, #f8fbff 100%);
        color: var(--admin-blue-deep);
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(460px, 100%);
        background: var(--admin-surface);
        border: 1px solid var(--admin-border);
        border-radius: 24px;
        box-shadow: var(--admin-shadow);
        padding: 36px;
        backdrop-filter: blur(10px);
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(2rem, 3vw, 2.5rem);
        line-height: 1.1;
        text-align: center;
      }
      .intro {
        margin: 0 0 24px;
        color: var(--admin-blue-soft);
        line-height: 1.7;
        text-align: center;
      }
      label {
        display: block;
        margin: 16px 0 8px;
        font-weight: 700;
        color: var(--admin-blue-deep);
      }
      input {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid var(--admin-border);
        border-radius: 14px;
        font-size: 1rem;
        color: var(--admin-blue-deep);
        background: #ffffff;
        transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
      }
      input:focus {
        outline: none;
        border-color: var(--admin-blue);
        box-shadow: 0 0 0 4px rgba(13, 79, 154, 0.12);
        transform: translateY(-1px);
      }
      .actions {
        margin-top: 24px;
      }
      button {
        width: 100%;
        padding: 15px;
        border: 0;
        border-radius: 14px;
        background: linear-gradient(135deg, var(--admin-blue) 0%, var(--admin-blue-deep) 100%);
        color: #ffffff;
        font-weight: 700;
        font-size: 1rem;
        cursor: pointer;
        box-shadow: 0 16px 30px rgba(10, 47, 99, 0.2);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }
      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 18px 34px rgba(10, 47, 99, 0.24);
      }
      .powered-by {
        margin: 14px 0 0;
        text-align: center;
        color: var(--admin-blue);
        font-size: 0.95rem;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <form class="card" method="post" action="/admin/login">
        <h1>Welcome Admin</h1>
        <p class="intro">Sign in to manage bookings, publish updates, and keep the Tech Bridge Liberia platform current.</p>
        ${message}
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <div class="actions">
          <button type="submit">Login</button>
          <p class="powered-by">Powered by Tech Bridge Liberia-TBL</p>
        </div>
      </form>
    </div>
  </body>
  </html>`;
}

function renderAdminDashboard(bookingRows, newsRows, options = {}) {
  const storageHealth = getStorageHealthStatus();
  const editingNews = options.editingNews || null;
  const composerOpen = Boolean(options.composerOpen);
  const publishedNewsOpen = Boolean(options.publishedNewsOpen);
  const bookingCount = bookingRows.length;
  const newsCount = newsRows.length;
  const composerTitle = editingNews ? 'Edit News' : 'Post News';
  const submitLabel = editingNews ? 'Save Changes' : 'Publish Update';
  const formImageRequired = editingNews ? '' : 'required';
  const storageStatusClass = storageHealth.isConfigured ? 'upload-status is-ready' : 'upload-status is-warning';
  const storageTarget = storageHealth.isConfigured ? 'Supabase CDN storage' : 'local server storage';
  const editingIdInput = editingNews ? `<input type="hidden" name="id" value="${escapeHtml(editingNews.id)}">` : '';
  const existingImageInput = editingNews ? `<input type="hidden" name="existing_image_url" value="${escapeHtml(editingNews.image_url)}">` : '';
  const imagePreviewCard = `
      <div class="field-full current-image-card" id="newsImagePreviewCard" ${editingNews && editingNews.image_url ? '' : 'hidden'}>
        <span class="field-caption" id="newsImagePreviewLabel">${editingNews && editingNews.image_url ? 'Current Image' : 'Selected Image Preview'}</span>
        <img
          src="${escapeHtml(editingNews && editingNews.image_url ? editingNews.image_url : '')}"
          alt="${escapeHtml(editingNews ? editingNews.title : 'Selected news image preview')}"
          class="current-image-preview"
          id="newsImagePreview"
          data-existing-src="${escapeHtml(editingNews && editingNews.image_url ? editingNews.image_url : '')}"
          data-existing-alt="${escapeHtml(editingNews ? editingNews.title : 'Selected news image preview')}"
        >
      </div>`
  ;
  const newsTypeOptions = newsTypes.map((type) => {
    const selected = (editingNews ? editingNews.news_type : 'Other') === type ? 'selected' : '';
    return `<option value="${escapeHtml(type)}" ${selected}>${escapeHtml(type)}</option>`;
  }).join('');

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
          <div class="news-item-copy">
            <div class="news-item-meta">${escapeHtml(row.news_type || 'Other')} | ${escapeHtml(formatLiberiaDateTime(row.created_at))} | by ${escapeHtml(row.author_name)}</div>
            <h3>${escapeHtml(row.title)}</h3>
          </div>
          <div class="news-actions">
            <a class="secondary-btn" href="/admin?editNews=${escapeHtml(row.id)}#newsComposer">Edit</a>
            <form method="post" action="/admin/news/delete" onsubmit="return confirm('Delete this news post?');">
              <input type="hidden" name="id" value="${escapeHtml(row.id)}">
              <button class="delete-btn" type="submit">Delete</button>
            </form>
          </div>
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
      .section-actions { display: flex; align-items: center; gap: 10px; }
      .section-actions-end { justify-content: flex-end; }
      .news-form { display: grid; gap: 20px; }
      .news-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .field-full { grid-column: 1 / -1; }
      .field-caption { display: block; margin-bottom: 8px; font-weight: 700; color: var(--admin-accent); }
      .news-form label { display: block; margin-bottom: 8px; font-weight: 700; }
      .news-form input, .news-form textarea, .news-form select { width: 100%; padding: 13px 14px; border: 1px solid var(--admin-border); border-radius: 12px; color: var(--admin-ink); background: #ffffff; }
      .news-form input[type="file"] { padding: 11px 12px; cursor: pointer; }
      .news-form textarea { min-height: 180px; resize: vertical; }
      .news-form input:focus, .news-form textarea:focus, .news-form select:focus { outline: none; border-color: var(--admin-accent); box-shadow: 0 0 0 3px rgba(23, 74, 122, 0.12); }
      .upload-status { margin: 10px 0 0; padding: 12px 14px; border-radius: 12px; font-weight: 700; line-height: 1.5; }
      .upload-status.is-ready { background: #edf7ed; border: 1px solid #4f8f59; color: #1f5d2c; }
      .upload-status.is-warning { background: #fff5e8; border: 1px solid #d48806; color: #8a5a00; }
      .form-actions { display: flex; justify-content: flex-end; }
      .close-panel-btn, .secondary-btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 16px; border: 1px solid var(--admin-border); border-radius: 12px; background: #ffffff; color: var(--admin-accent); text-decoration: none; font-weight: 700; cursor: pointer; }
      .close-panel-btn:hover, .secondary-btn:hover { background: #f4f8fc; }
      .current-image-card { padding: 16px; border: 1px solid var(--admin-border); border-radius: 16px; background: #ffffff; }
      .current-image-preview { width: 100%; max-width: 220px; height: auto; border: 1px solid var(--admin-border); border-radius: 14px; display: block; }
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
      .news-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: center; padding: 18px; border: 1px solid var(--admin-border); border-radius: 16px; background: #ffffff; }
      .news-item-copy h3 { margin: 0; }
      .news-item-meta { margin-bottom: 8px; color: var(--admin-ink-soft); font-size: 0.92rem; font-weight: 700; }
      .news-actions { display: flex; flex-direction: column; gap: 10px; }
      .news-actions form { margin: 0; }
      .empty-news { padding: 22px; border: 1px solid var(--admin-border); border-radius: 16px; color: var(--admin-ink-soft); background: #ffffff; }
      [hidden] { display: none !important; }
      @media (max-width: 960px) {
        .topbar, .topbar-actions, .hero, .section-heading, .panel-header { flex-direction: column; align-items: stretch; }
        .topbar-actions { width: 100%; }
        .menu-shell { width: 100%; }
        .menu-toggle, .logout, .publish-btn { width: 100%; }
        .menu-panel { position: static; width: 100%; margin-top: 12px; }
        .hero, .stats, .news-form-grid, .news-item { grid-template-columns: 1fr; }
        .form-actions { justify-content: stretch; }
        .section-actions, .news-actions { width: 100%; }
        .close-panel-btn, .secondary-btn { width: 100%; }
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
        <section class="admin-card composer-card" id="newsComposer" ${composerOpen ? '' : 'hidden'}>
          <div class="section-heading">
            <div>
              <h2>${composerTitle}</h2>
            </div>
            <div class="section-actions">
              <span class="section-badge">${editingNews ? 'Editing' : 'Publishing'}</span>
              <span class="section-badge">${escapeHtml(storageHealth.label)}</span>
              <button class="close-panel-btn" id="closeComposer" type="button">Close</button>
            </div>
          </div>
          <form class="news-form" method="post" action="/admin/news" enctype="multipart/form-data">
            ${editingIdInput}
            ${existingImageInput}
            <div class="news-form-grid">
              <div class="field-full">
                <label for="newsTitle">News Title</label>
                <input id="newsTitle" name="title" type="text" value="${escapeHtml(editingNews ? editingNews.title : '')}" required>
              </div>
              <div>
                <label for="newsAuthor">Author Name</label>
                <input id="newsAuthor" name="author_name" type="text" value="${escapeHtml(editingNews ? editingNews.author_name : '')}" required>
              </div>
              <div>
                <label for="newsDate">Date</label>
                <input id="newsDate" name="publish_date" type="date" value="${escapeHtml(editingNews ? editingNews.publish_date : '')}" required>
              </div>
              <div>
                <label for="newsType">News Type</label>
                <select id="newsType" name="news_type" required>
                  ${newsTypeOptions}
                </select>
              </div>
              <div class="field-full">
                <label for="newsImage">Image</label>
                <input id="newsImage" name="image" type="file" accept="image/*" ${formImageRequired}>
                <p class="${storageStatusClass}" id="newsImageStatus" data-base-message="${escapeHtml(storageHealth.message)}" data-storage-target="${escapeHtml(storageTarget)}" data-base-tone="${storageHealth.isConfigured ? 'ready' : 'warning'}">${escapeHtml(storageHealth.message)}</p>
              </div>
              ${imagePreviewCard}
              <div class="field-full">
                <label for="newsBody">Body</label>
                <textarea id="newsBody" name="body" required>${escapeHtml(editingNews ? editingNews.body : '')}</textarea>
              </div>
            </div>
            <div class="form-actions">
              <button class="publish-btn" type="submit">${submitLabel}</button>
            </div>
          </form>
        </section>
        <section class="admin-card" id="publishedNews" ${publishedNewsOpen ? '' : 'hidden'}>
          <div class="section-heading">
            <div>
              <h2>Published News</h2>
            </div>
            <div class="section-actions section-actions-end">
              <span class="section-badge">${newsCount} Total</span>
              <button class="close-panel-btn" id="closePublishedNews" type="button">Close</button>
            </div>
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
      const publishedNews = document.getElementById('publishedNews');
      const bookingRequests = document.getElementById('bookingRequests');
      const closeComposerButton = document.getElementById('closeComposer');
      const closePublishedNewsButton = document.getElementById('closePublishedNews');
      const newsImageInput = document.getElementById('newsImage');
      const newsImageStatus = document.getElementById('newsImageStatus');
      const newsImagePreviewCard = document.getElementById('newsImagePreviewCard');
      const newsImagePreviewLabel = document.getElementById('newsImagePreviewLabel');
      const newsImagePreview = document.getElementById('newsImagePreview');
      let selectedPreviewUrl = '';

      const setMenuState = (isOpen) => {
        menuToggle.setAttribute('aria-expanded', String(isOpen));
        menuPanel.hidden = !isOpen;
      };

      const openComposer = () => {
        publishedNews.hidden = true;
        composer.hidden = false;
        composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      const openPublishedNews = () => {
        composer.hidden = true;
        publishedNews.hidden = false;
        clearComposerState();
        publishedNews.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      const clearComposerState = () => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete('editNews');
        nextUrl.hash = '';
        window.history.replaceState({}, '', nextUrl.pathname + nextUrl.search);
      };

      const closeComposer = () => {
        composer.hidden = true;
        clearComposerState();
      };

      const closePublishedNews = () => {
        publishedNews.hidden = true;
        bookingRequests.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      const formatFileSize = (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) {
          return '0 KB';
        }

        if (bytes >= 1024 * 1024) {
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        return String(Math.max(1, Math.round(bytes / 1024))) + ' KB';
      };

      const setImageStatus = (message, tone) => {
        if (!newsImageStatus) {
          return;
        }

        newsImageStatus.textContent = message;
        newsImageStatus.classList.remove('is-ready', 'is-warning');
        newsImageStatus.classList.add(tone === 'ready' ? 'is-ready' : 'is-warning');
      };

      const revokePreviewUrl = () => {
        if (selectedPreviewUrl) {
          URL.revokeObjectURL(selectedPreviewUrl);
          selectedPreviewUrl = '';
        }
      };

      const resetImagePreview = () => {
        if (!newsImagePreviewCard || !newsImagePreview || !newsImagePreviewLabel) {
          return;
        }

        revokePreviewUrl();
        const existingSrc = newsImagePreview.dataset.existingSrc || '';
        const existingAlt = newsImagePreview.dataset.existingAlt || 'Current news image';

        if (existingSrc) {
          newsImagePreviewCard.hidden = false;
          newsImagePreviewLabel.textContent = 'Current Image';
          newsImagePreview.src = existingSrc;
          newsImagePreview.alt = existingAlt;
          return;
        }

        newsImagePreviewCard.hidden = true;
        newsImagePreviewLabel.textContent = 'Selected Image Preview';
        newsImagePreview.removeAttribute('src');
        newsImagePreview.alt = 'Selected news image preview';
      };

      if (newsImageInput) {
        newsImageInput.addEventListener('change', () => {
          const file = newsImageInput.files && newsImageInput.files[0];
          const baseMessage = newsImageStatus ? newsImageStatus.dataset.baseMessage || '' : '';
          const baseTone = newsImageStatus ? newsImageStatus.dataset.baseTone || 'warning' : 'warning';
          const storageTargetLabel = newsImageStatus ? newsImageStatus.dataset.storageTarget || 'local server storage' : 'local server storage';

          if (!file) {
            resetImagePreview();
            setImageStatus(baseMessage, baseTone);
            return;
          }

          if (!file.type || !file.type.startsWith('image/')) {
            resetImagePreview();
            setImageStatus('Selected file is not a valid image. Please choose a JPG, PNG, WEBP, GIF, or SVG file.', 'warning');
            newsImageInput.value = '';
            return;
          }

          revokePreviewUrl();
          selectedPreviewUrl = URL.createObjectURL(file);

          if (newsImagePreviewCard && newsImagePreview && newsImagePreviewLabel) {
            newsImagePreviewCard.hidden = false;
            newsImagePreviewLabel.textContent = newsImagePreview.dataset.existingSrc ? 'New Image Preview' : 'Selected Image Preview';
            newsImagePreview.src = selectedPreviewUrl;
            newsImagePreview.alt = file.name;
          }

          setImageStatus(file.name + ' selected (' + formatFileSize(file.size) + '). It will upload to ' + storageTargetLabel + '.', 'ready');
        });

        resetImagePreview();
      }

      menuToggle.addEventListener('click', () => {
        const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
        setMenuState(!isOpen);
      });

      if (closeComposerButton) {
        closeComposerButton.addEventListener('click', () => {
          closeComposer();
        });
      }

      if (closePublishedNewsButton) {
        closePublishedNewsButton.addEventListener('click', () => {
          closePublishedNews();
        });
      }

      menuPanel.querySelectorAll('[data-target]').forEach((button) => {
        button.addEventListener('click', () => {
          const targetId = button.getAttribute('data-target');
          const target = document.getElementById(targetId);
          if (!target) {
            return;
          }

          if (targetId === 'newsComposer') {
            openComposer();
          } else if (targetId === 'publishedNews') {
            openPublishedNews();
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

async function handleAdminDashboard(request, response, requestUrl) {
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
      `SELECT id, title, body, image_url, publish_date, news_type, author_name, created_at
       FROM news_updates
       ORDER BY publish_date DESC, created_at DESC`
    );

    const editNewsId = Number(requestUrl.searchParams.get('editNews'));
    const editingNews = Number.isInteger(editNewsId) && editNewsId > 0
      ? newsResult.rows.find((row) => Number(row.id) === editNewsId) || null
      : null;
    const publishedNewsOpen = requestUrl.searchParams.get('panel') === 'publishedNews';

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderAdminDashboard(bookingResult.rows, newsResult.rows, {
      editingNews,
      composerOpen: Boolean(editingNews),
      publishedNewsOpen
    }));
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
    const form = await parseMultipartForm(request);
    const newsId = Number(form.id || '');
    const existingImageUrl = String(form.existing_image_url || '').trim();
    const uploadedImageUrl = String(form.image_url || '').trim();
    const newsItem = {
      title: String(form.title || '').trim(),
      body: String(form.body || '').trim(),
      image_url: uploadedImageUrl || existingImageUrl,
      publish_date: String(form.publish_date || '').trim(),
      news_type: normalizeNewsType(form.news_type),
      author_name: String(form.author_name || '').trim()
    };

    const missingField = Object.entries(newsItem).find(([, value]) => !value);
    if (missingField) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Missing field: ${missingField[0]}`);
      return;
    }

    if (Number.isInteger(newsId) && newsId > 0) {
      const existingNewsResult = await pool.query(
        'SELECT image_url FROM news_updates WHERE id = $1',
        [newsId]
      );

      if (!existingNewsResult.rows.length) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('News update not found.');
        return;
      }

      await pool.query(
        `UPDATE news_updates
         SET title = $1, body = $2, image_url = $3, publish_date = $4, news_type = $5, author_name = $6
         WHERE id = $7`,
        [newsItem.title, newsItem.body, newsItem.image_url, newsItem.publish_date, newsItem.news_type, newsItem.author_name, newsId]
      );

      if (uploadedImageUrl && existingNewsResult.rows[0].image_url !== uploadedImageUrl) {
        await removeManagedNewsImage(existingNewsResult.rows[0].image_url);
      }
    } else {
      await pool.query(
        `INSERT INTO news_updates (title, body, image_url, publish_date, news_type, author_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newsItem.title, newsItem.body, newsItem.image_url, newsItem.publish_date, newsItem.news_type, newsItem.author_name]
      );
    }

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

    const existingNewsResult = await pool.query(
      'SELECT image_url FROM news_updates WHERE id = $1',
      [id]
    );

    await pool.query('DELETE FROM news_updates WHERE id = $1', [id]);

    if (existingNewsResult.rows.length) {
      await removeManagedNewsImage(existingNewsResult.rows[0].image_url);
    }

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
      `SELECT id, title, body, image_url, publish_date, news_type, author_name, created_at, view_count, share_count
       FROM news_updates
       ORDER BY publish_date DESC, created_at DESC`
    );
    sendJson(response, 200, { items: result.rows });
  } catch (error) {
    console.error('News API failed:', error);
    sendJson(response, 500, { error: 'Unable to load news updates.' });
  }
}

async function loadNewsItemById(newsId) {
  if (!databaseReady || !pool) {
    return null;
  }

  const result = await pool.query(
    `SELECT id, title, body, image_url, publish_date, news_type, author_name, created_at, view_count, share_count
     FROM news_updates
     WHERE id = $1`,
    [newsId]
  );

  return result.rows[0] || null;
}

async function handleNewsArticle(request, response, newsId) {
  if (!databaseReady || !pool) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(databaseInitError ? databaseInitError.message : 'Database is not ready.');
    return;
  }

  try {
    let item;

    if (isCrawlerRequest(request)) {
      item = await loadNewsItemById(newsId);
    } else {
      const result = await pool.query(
        `UPDATE news_updates
         SET view_count = view_count + 1
         WHERE id = $1
         RETURNING id, title, body, image_url, publish_date, news_type, author_name, created_at, view_count, share_count`,
        [newsId]
      );
      item = result.rows[0] || null;
    }

    if (!item) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('News article not found.');
      return;
    }

    if (!isCrawlerRequest(request)) {
      redirect(response, `/News and Updates.html#news-${encodeURIComponent(String(item.id))}`);
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderNewsArticlePage(item, request));
  } catch (error) {
    console.error('News article page failed:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unable to load news article.');
  }
}

async function handleNewsShareCount(response, newsId) {
  if (!databaseReady || !pool) {
    sendJson(response, 503, {
      error: databaseInitError ? databaseInitError.message : 'Database is not ready.'
    });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE news_updates
       SET share_count = share_count + 1
       WHERE id = $1
       RETURNING share_count`,
      [newsId]
    );

    if (!result.rows.length) {
      sendJson(response, 404, { error: 'News article not found.' });
      return;
    }

    sendJson(response, 200, { share_count: result.rows[0].share_count });
  } catch (error) {
    console.error('News share count update failed:', error);
    sendJson(response, 500, { error: 'Unable to update share count.' });
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
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  const newsArticleMatch = pathname.match(/^\/news\/(\d+)$/);
  const newsShareMatch = pathname.match(/^\/api\/news\/(\d+)\/share$/);

  if (method === 'POST' && pathname === '/api/bookings') {
    await handleBookingRequest(request, response);
    return;
  }

  if (method === 'POST' && newsShareMatch) {
    await handleNewsShareCount(response, Number(newsShareMatch[1]));
    return;
  }

  if (method === 'GET' && pathname === '/api/news') {
    await handleNewsApi(response);
    return;
  }

  if (method === 'GET' && newsArticleMatch) {
    await handleNewsArticle(request, response, Number(newsArticleMatch[1]));
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
    await handleAdminDashboard(request, response, requestUrl);
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
  logStartupHealthChecks();
  console.log(`Tech Bridge server running on port ${port}`);
});