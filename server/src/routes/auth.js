import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import {
  hashPassword, verifyPassword, signToken,
  setSessionCookie, clearSessionCookie, authRequired,
} from '../auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { email, password } = parsed.data;

  const { rows } = await query(
    `SELECT id, email, password_hash, full_name, role, campaign_id, team_id, token_version, active
       FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  const user = rows[0];

  // Log every attempt for audit, then check creds. Constant-ish time on miss.
  const ok = user && user.active ? await verifyPassword(password, user.password_hash) : false;

  await query(
    `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [user?.id ?? null, ok ? 'login.success' : 'login.fail', req.ip, req.get('user-agent') || null, { email }]
  );

  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

  const token = signToken(user);
  setSessionCookie(res, token);
  res.json({
    user: {
      id: user.id, email: user.email, name: user.full_name,
      role: user.role, campaign_id: user.campaign_id, team_id: user.team_id,
    },
  });
});

router.post('/logout', authRequired, (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.full_name,
      role: req.user.role,
      campaign_id: req.user.campaign_id,
      team_id: req.user.team_id,
    },
  });
});

// Self-service password change (requires current password).
const changePwSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10).max(200),
});
router.post('/change-password', authRequired, async (req, res) => {
  const parsed = changePwSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  const ok = await verifyPassword(parsed.data.current_password, rows[0]?.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const newHash = await hashPassword(parsed.data.new_password);
  await query(
    `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2`,
    [newHash, req.user.id]
  );
  clearSessionCookie(res);
  res.json({ ok: true });
});

export default router;
