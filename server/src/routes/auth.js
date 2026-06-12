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
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.campaign_id, u.team_id,
            u.token_version, u.active, u.must_change_password,
            c.name AS campaign_name, t.name AS team_name
       FROM users u
       LEFT JOIN campaigns c ON c.id = u.campaign_id
       LEFT JOIN teams t     ON t.id = u.team_id
      WHERE LOWER(u.email) = LOWER($1)`,
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
      campaign_name: user.campaign_name, team_name: user.team_name,
      must_change_password: user.must_change_password === true,
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
      campaign_name: req.user.campaign_name,
      team_name: req.user.team_name,
      must_change_password: req.user.must_change_password === true,
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
    `UPDATE users SET password_hash = $1, must_change_password = FALSE,
            token_version = token_version + 1, updated_at = NOW() WHERE id = $2`,
    [newHash, req.user.id]
  );
  clearSessionCookie(res);
  res.json({ ok: true });
});

export default router;
