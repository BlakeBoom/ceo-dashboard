// Express app construction. Exported as `app` for both:
//   - Local dev (`npm run dev` → server/src/index.js calls app.listen)
//   - Vercel serverless (api/index.js re-exports this app; vercel.json rewrites /api/* to it)
//
// Do NOT call app.listen() here.

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProd } from './env.js';
import { pool } from './db.js';
import { authRequired } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';
import bonusRoutes from './routes/bonus.js';
import syncRoutes from './routes/sync.js';
import zohoRoutes from './routes/zoho.js';
import targetRoutes from './routes/targets.js';
import settingsRoutes from './routes/settings.js';
import campaignRoutes from './routes/campaigns.js';
import shiftRuleRoutes from './routes/shift-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const app = express();
app.set('trust proxy', 1);

// CSP: permit the inline <script>/<style> and inline style="" attributes the
// dashboard relies on ('unsafe-inline'), plus /shared/names.js ('self') and
// Google Fonts (the only external resources — CSS from fonts.googleapis.com,
// font files from fonts.gstatic.com). Everything else is locked down: all data
// calls are same-origin /api/* so connect-src stays 'self' (the old
// script.google.com proxy is no longer called from the browser).
// useDefaults:false so we don't inherit helmet's upgrade-insecure-requests,
// which would break same-origin sub-resource loads under http://localhost.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Healthcheck (Vercel auto-monitors; also handy for uptime pings)
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Public auth endpoints (login is unauthenticated).
app.use('/api/auth', authRoutes);

// All other /api routes require a valid session.
app.use('/api', authRequired);

// Accounts created with a generated temp password must set their own before
// using the app (the low-cost temp hash is only safe because it's short-lived).
// /api/auth/* stays reachable (mounted above), so change-password works.
app.use('/api', (req, res, next) => {
  if (req.user?.must_change_password) {
    return res.status(403).json({ error: 'password_change_required' });
  }
  next();
});
app.use('/api/users', userRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/shift-rules', shiftRuleRoutes);
app.use('/api/bonus', bonusRoutes);
app.use('/api/targets', targetRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/zoho', zohoRoutes);

// Local-dev only: serve the static dashboard from repo root.
// On Vercel, static files are served directly by the CDN (vercel.json routes
// /api/* here; everything else hits the static layer first).
if (!process.env.VERCEL) {
  app.use(express.static(REPO_ROOT, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(REPO_ROOT, 'index.html'));
  });
}

// Error handler — last
app.use((err, req, res, next) => {
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: isProd ? 'internal_error' : err.message });
});

export default app;
