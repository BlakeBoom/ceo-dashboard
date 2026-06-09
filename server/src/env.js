import 'dotenv/config';

function req(name) {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name, fallback) {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const env = {
  NODE_ENV: opt('NODE_ENV', 'development'),
  PORT: parseInt(opt('PORT', '3000'), 10),

  DATABASE_URL: req('DATABASE_URL'),

  JWT_SECRET: req('JWT_SECRET'),
  JWT_TTL_HOURS: parseInt(opt('JWT_TTL_HOURS', '12'), 10),
  COOKIE_SECURE: opt('COOKIE_SECURE', 'false') === 'true',

  ALLOWED_ORIGINS: (opt('ALLOWED_ORIGINS', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  SEED_ADMIN_EMAIL: opt('SEED_ADMIN_EMAIL', null),
  SEED_ADMIN_PASSWORD: opt('SEED_ADMIN_PASSWORD', null),
  SEED_ADMIN_NAME: opt('SEED_ADMIN_NAME', 'Platform Admin'),
};

export const isProd = env.NODE_ENV === 'production';
