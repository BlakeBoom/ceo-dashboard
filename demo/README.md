# Offline demo — anonymised showcase build

`boomerang-dashboard-demo.html` is the operations dashboard as a **single file
that opens straight from the filesystem**. Double-click it. No server, no
network, no login, no setup — and no client, staff or commercial data.

Built for showing the product to someone outside the business.

## What's in it

The real UI, unmodified, running against an invented dataset:

| | |
|---|---|
| Campaigns | 14 fictional accounts across Customer Services and Sales |
| People | ~430 invented agents, team leaders, QAs and campaign managers |
| History | 18 complete weeks of daily metrics and attendance, plus 30 months of HR records for attrition |
| Tabs | Summary · Campaigns · Trends · Bonus · Targets |
| Drill-downs | Campaign → teams → individual scorecards, and the bonus register per person |
| Exports | The bonus **Export to Excel** button produces a real .xlsx |

Granularity (Day / Week / Month), the period picker, the watch list, campaign
health, churn, shrinkage, fulfilment, slippage and the commercial targets
matrix all work exactly as they do in production.

## What was removed

- **Login.** There is no session. The file opens straight into the dashboard as
  a read-only EXCO viewer, so sign-in and sign-out are gone.
- **Settings.** The Rules, Users, Campaign admin and Access tabs are
  administrative configuration and are not shown.
- **Every real name.** Client accounts, people, rates, volumes and the internal
  Zoho / Apps Script identifiers are all replaced. The build fails if any
  identifying string survives — see the `LEAKS` check in `build-demo.mjs`.

Writes are refused: the demo answers any non-GET call with a read-only error,
so nothing in it can be edited or saved.

## The numbers

Everything is generated in the browser from a fixed seed, so the file shows the
**same figures on every machine and every reload** — safe to rehearse against.

The dataset is built to hold together rather than to look good: hours are
derived per campaign per week from the roster that was actually drawn, so
Fulfil, Slippage, Capacity, Realisation and Absence reconcile with one another
the way real data does. Campaigns are given deliberate performance signatures,
so the walkthrough has a story — roughly half the book on track, a few accounts
amber, and a handful red for different reasons (quality on one, absence on
another, CSAT on a third).

They are still invented numbers. They are not Boomerang's book of business and
should not be quoted as a benchmark.

## Rebuilding

```bash
node demo/build-demo.mjs
```

Two inputs:

- `demo/demo-runtime.js` — generates the dataset and replaces `window.fetch`
  with an in-memory API. This is where campaigns, targets and the performance
  signatures live if you want to change the story.
- `demo/build-demo.mjs` — inlines the shared modules, injects that runtime,
  patches the handful of things that assume a server, renames every real
  client, and refuses to write the file if anything identifying is left.

Neither touches `index.html` or anything the production app deploys.
