# Boomerang Operations Dashboard

Multi-team operations dashboard with role-based access control. Frontend is a
single static `index.html`; backend is a Node/Express API on Railway backed by
Neon Postgres.

## Architecture

```
Browser ──HTTPS──▶ Railway (Express)
                     ├── /api/auth/*    (login / logout / me)
                     ├── /api/users/*   (RBAC-scoped)
                     ├── /api/teams/*
                     └── /              (serves index.html)
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
Client-side tab hiding is a UX nicety only — the API will refuse out-of-scope
requests regardless.

## First-time setup

1. **Provision Neon** — create a project at neon.tech, copy the pooled
   connection string.
2. **Provision Railway** — connect this repo, set the env vars from
   `.env.example`, deploy. Railway will run `npm run migrate && npm start`.
3. **Seed the admin** — once running, exec `npm run seed` on Railway to create
   the bootstrap admin (uses `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).
   Sign in, change the password immediately, then create the rest of the team.

## Local development

```bash
cp .env.example .env       # fill in DATABASE_URL + JWT_SECRET
npm install
npm run migrate
npm run seed
npm run dev
# open http://localhost:3000
```

## Roadmap

- **Phase 1 (this PR):** Auth, RBAC, login gate, schema for bonus engine.
- **Phase 2:** Zoho People / Analytics sync, bonus rules CRUD, bonus
  computation, Bonus tab UI matching the Medexpress cohort tracker.
- **Phase 3:** Rollout to PicknPay, Butternut Box, Pinter; per-campaign
  rule customisation; audit/sign-off workflow.
