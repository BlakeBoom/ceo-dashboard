// Local-dev launcher. On Vercel, api/index.js imports app.js directly (routed
// via the vercel.json /api/* rewrite) and Vercel's runtime handles the listen,
// so this file is unused in prod.

import app from './app.js';
import { env } from './env.js';

app.listen(env.PORT, () => {
  console.log(`[boomerang] listening on :${env.PORT} (${env.NODE_ENV})`);
});
