# Boomerang Operations Dashboard

Multi-team operations dashboard with role-based access control. Frontend is a
single static `index.html`; backend is a Node/Express API deployed as Vercel
serverless functions, backed by Neon Postgres.

## Architecture

```
Browser ──HTTPS──▶ Vercel Edge
                     ├── /                  static index.html (CDN)
                     └── /api/*             api/[...path].js → Express app
                            ├── /api/auth/*    (login / logout / me)
                            ├── /api/users/*   (RBAC-scoped)
                            ├── /api/teams/*
                            └── /api/cron/zoho-sync  (Vercel Cron, hourly)
                                       │
                                       ▼
                                  Neon Postgres
```

## Roles

| Role            | Scope                                                |
|-----------------|------------------------------------------------------|
| `agent`         | Sees only their own bonus row                        |
| `tm`            | Sees their team (Summary, Campaigns, Trends, Bonus)  |
| `campaign_lead` | Sees all teams within their campaign + targets editor|
| `admin`         | Sees everything; can create users / teams / rules    |

Scope is enforced server-side via `scopeClause()` in `server/src/rbac.js`.
Client-side tab hiding is UX only — the API refuses out-of-scope requests
regardless.

## First-time deploy (Vercel + Neon)

1. **Neon** — create a project at neon.tech, copy the *pooled* connection
   string into `DATABASE_URL`.
2. **Vercel** — Import the repo. Set env vars from `.env.example`. Deploy.
3. **Run migrations + seed** from your laptop (Vercel doesn't run them at
   deploy time):
   ```bash
   npm i -g vercel
   vercel link                              # links repo to the project
   vercel env pull .env.production.local    # downloads env vars
   node --env-file=.env.production.local server/src/migrate.js
   node --env-file=.env.production.local server/src/seed.js
   ```
4. Sign in as the seeded admin (email/password from
   `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), change the password
   immediately, then create the rest of the team.

## Local development

```bash
cp .env.example .env       # fill in DATABASE_URL + JWT_SECRET
npm install
npm run migrate
npm run seed
npm run dev
# open http://localhost:3000
```

In local dev the Express server serves both the API and `index.html`.
In production Vercel's CDN serves `index.html` directly; only `/api/*`
hits the serverless function.

## Roadmap

- **Phase 1 (this PR):** Auth, RBAC, login gate, schema for bonus engine,
  Vercel deployment scaffolding.
- **Phase 2:** Zoho People / Analytics sync (hourly via Vercel Cron),
  bonus rules CRUD, bonus computation, Bonus tab UI matching the
  Medexpress cohort tracker.
- **Phase 3:** Rollout to PicknPay, Butternut Box, Pinter; per-campaign
  rule customisation; audit/sign-off workflow.
