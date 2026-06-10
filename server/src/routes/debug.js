// Diagnostic endpoints — admin-only. Used to verify what the deployed function
// actually sees, not what we think we configured. Delete once stable.

import { Router } from 'express';
import { requireRole } from '../rbac.js';
import { env } from '../env.js';

const router = Router();

function mask(v) {
  if (!v) return { length: 0, value: null };
  const s = String(v);
  if (s.length <= 8) return { length: s.length, value: `…${s.slice(-2)}` };
  return { length: s.length, value: `${s.slice(0, 4)}…${s.slice(-4)}` };
}

router.get('/zoho', requireRole('admin'), async (req, res) => {
  res.json({
    region: env.ZOHO_REGION,
    accounts_url: `https://accounts.zoho.${env.ZOHO_REGION}/oauth/v2/token`,
    analytics_url: `https://analyticsapi.zoho.${env.ZOHO_REGION}`,
    workspace_id: env.ZOHO_ANALYTICS_WORKSPACE_ID,
    org_id:       env.ZOHO_ANALYTICS_ORG_ID,
    client_id:     mask(env.ZOHO_CLIENT_ID),
    client_secret: mask(env.ZOHO_CLIENT_SECRET),
    refresh_token: mask(env.ZOHO_REFRESH_TOKEN),
  });
});

// Live test — actually attempts a token refresh and returns the raw Zoho response.
router.get('/zoho/test-token', requireRole('admin'), async (req, res) => {
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id:     env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });
  try {
    const r = await fetch(`https://accounts.zoho.${env.ZOHO_REGION}/oauth/v2/token`, {
      method: 'POST', body,
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    res.json({
      http_status: r.status,
      response: parsed || text,
      access_token_received: !!(parsed?.access_token),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
