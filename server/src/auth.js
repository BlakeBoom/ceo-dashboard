import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env, isProd } from './env.js';
import { query } from './db.js';

const COOKIE_NAME = 'bbpo_session';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      cid: user.campaign_id,
      tid: user.team_id,
      v: user.token_version,
    },
    env.JWT_SECRET,
    { expiresIn: `${env.JWT_TTL_HOURS}h` }
  );
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProd,
    sameSite: 'lax',
    maxAge: env.JWT_TTL_HOURS * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Express middleware. On success, attaches req.user (full row from DB).
export async function authRequired(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'unauthenticated' });

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const { rows } = await query(
    `SELECT id, email, full_name, role, campaign_id, team_id, token_version, active
       FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.active || user.token_version !== payload.v) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'session_revoked' });
  }
  req.user = user;
  next();
}
