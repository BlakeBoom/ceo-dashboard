import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, isProd } from './env.js';
import { pool } from './db.js';
import { authRequired } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const app = express();
app.set('trust proxy', 1);

// CSP allows the existing inline scripts/styles in index.html. Tighten in Phase 3.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Healthcheck (used by Railway)
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
app.use('/api/users', userRoutes);
app.use('/api/teams', teamRoutes);

// Serve the static dashboard from repo root. index.html itself handles the
// login gate client-side by calling /api/auth/me before rendering data.
app.use(express.static(REPO_ROOT, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Fallback: any unknown non-API path returns the SPA shell.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(REPO_ROOT, 'index.html'));
});

// Error handler — last
app.use((err, req, res, next) => {
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: isProd ? 'internal_error' : err.message });
});

app.listen(env.PORT, () => {
  console.log(`[boomerang] listening on :${env.PORT} (${env.NODE_ENV})`);
});
