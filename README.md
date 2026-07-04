# NexusFlow — Production Code Handoff Bundle

Full-stack marketing automation hub for a financial advisory firm targeting under-served niches (health & safety sector). Karbon work management triggers an end-to-end pipeline: external AI content generation → SEO scoring → human review gate → WordPress deploy → distribution copy generation → **second** human review gate → Meta Ads + ActiveCampaign + organic social publishing → Karbon timeline callback.

**Stack:** Node.js 20 + TypeScript (Express), PostgreSQL (raw SQL via `pg`), Redis + BullMQ, React + Tailwind dashboard. Modular monolith with adapter interfaces at every external seam.

---

## About the design files (`design/`)

`design/NexusFlow Dashboard.dc.html` (+ `support.js`) is the **high-fidelity interactive design reference** built during the design phase — open it in a browser. It is a prototype showing intended look and behavior, **not production code to copy directly**. Recreate its screens in the React frontend using the skeleton components in `frontend/src/` as the starting point. It is hifi: treat its layout, spacing, copy, states (review gates, audit modal, conflict notices, dark mode) as the spec. Design tokens: bg `#F4F2ED`, card `#FFFFFF`, ink `#1A1D20`, muted `#8A8578`, green `#137A5B`, amber `#B45309`, violet `#5B4FC2`, red `#B3261E`, cyan `#0E7490`; type: Space Grotesk (display), IBM Plex Sans (body), IBM Plex Mono (labels/data). The prototype's dark palette lives in its `THEMES` object.

---

## Repository layout

```
db/schema.sql                     Complete PostgreSQL DDL (enums, constraints, indexes, seeds)
src/
  index.ts                        Entrypoint — binds 0.0.0.0:$PORT, boots API + workers
  server.ts                       Express app, /healthz, static frontend serving
  config/env.ts                   Typed env access (throws on missing required vars)
  db/pool.ts                      pg Pool + tx helper + audit() writer
  redis/connection.ts             ioredis setup (BullMQ-safe options, backoff, failover)
  middleware/karbonHmac.ts        Strict HMAC-SHA256 raw-body signature verification
  middleware/idempotency.ts       Redis SETNX idem:{workItemId}:{stageId}, 24h TTL
  middleware/auth.ts              JWT + Redis session verification, role gates
  routes/webhook.routes.ts        POST /api/webhooks/karbon (raw → HMAC → idempotency → saga)
  routes/auth.routes.ts           /api/auth/login | logout | me (bcrypt + JWT + sessions)
  routes/api.routes.ts            Runs, review queue, gates, overrides, settings (409 conflicts)
  saga/orchestrator.ts            Durable saga: guarded Postgres state transitions
  queues/queues.ts                BullMQ queues, retry policy, rate-limit table
  workers/index.ts                Worker processors + terminal-failure handling
  services/karbonClient.ts        Karbon TIMELINE API notes (success + "Workflow Failed")
  services/seoScorer.ts           Internal SEO scorer (density/readability/headings/meta)
  services/distributionCopy.ts    GPT-4o distribution payloads (brand voice in system prompt)
  adapters/types.ts               ContentGenerationProvider · CmsPublisher · AdPlatform ·
                                  EmailProvider · SocialPublisher interfaces
  adapters/ReplitGenerationAdapter.ts   External generator over HTTP (Bearer, 90s timeout)
  adapters/WordPressAdapter.ts    REST publish (app password), stub mode without creds
  adapters/MetaAdsAdapter.ts      Lead-gen campaign/adset/creative/ad — sandbox mode
  adapters/ActiveCampaignAdapter.ts     Message + campaign send, UTM-rewritten body
  adapters/SocialAdapters.ts      LinkedIn / Facebook / Instagram — independent, non-blocking
  scripts/migrate.ts              Applies db/schema.sql
frontend/src/
  lib/api.ts · context/AuthContext.tsx · pages/Login.tsx · pages/ReviewQueue.tsx · pages/Settings.tsx
Dockerfile · railway.toml · docker-compose.yml · .env.example
design/                           Hifi HTML design reference (see above)
```

## Saga state machine

```
triggered → generating → seo_review ⇄ revision
  seo_review → deploying → dist_generating → dist_review   (gate 2 — always human)
  dist_review → publishing → completing → complete
  any blocking step → failed  (retries exhausted → "Workflow Failed" on Karbon timeline)
```

Every transition is a guarded `UPDATE … WHERE status = <expected>`: a second reviewer, a double-click, or a replayed job gets 0 rows and a `409 Conflict` — never a silent overwrite. Auto-approve (configurable threshold, default 80) applies to gate 1 only.

## Architecture rules honored (from the design phase — do not drop)

1. **Webhook idempotency + security** — HMAC-SHA256 on the raw body with timing-safe compare (`karbonHmac.ts`); Redis `SET NX EX 86400` on `idem:{workItemId}:{stageId}` (`idempotency.ts`); DB unique constraint as durable backstop.
2. **Karbon specifics** — completion + failure notes via the **Timeline API only** (`karbonClient.ts`); work-item custom fields are never written. Terminal failure state posts "Workflow Failed" with the verbatim error body.
3. **API resilience** — BullMQ worker limiters: `activecampaign` 5 req/s, `meta-ads` 10 req/10s (`queues.ts` + `workers/index.ts`).
4. **Railway** — binds `0.0.0.0`, reads `process.env.PORT` (`index.ts`); `DATABASE_URL`/`REDIS_URL` from Railway plugins.
5. **Distribution review gate** — GPT-4o payloads (headline ≤40, primary ≤125, IG "link in bio"); saga pauses at `dist_review`; publish jobs are enqueued only by `POST /runs/:id/publish-all`; every field editable, overrides logged.
6. **ReplitGenerationAdapter** — `POST $REPLIT_GENERATOR_APP_URL` with `Authorization: Bearer $REPLIT_SERVICE_SECRET`, 90s timeout for cold starts, clean error classification so BullMQ retries before terminal failure.
7. **Brand voice** — `app_settings.brand_voice`, sent as `brandVoice` to the generator and prepended to the GPT-4o system prompt.
8. **UTM enforcement** — `utils/utm.ts`, applied inside adapters at publish time so manual edits can't strip tracking.
9. **Dashboard UX** — audit trail feeds the job-log modal (queue, attempts, timestamps, verbatim HTTP errors via `job.failed` events); lead-magnet preview link pre-approval; light/dark theming per the design reference.
10. **Multi-user auth** — bcrypt + JWT + Redis sessions, `/api/auth/*`, role enum (editors cannot approve/publish), `audit_trails.user_id` on every action, 409 concurrency notices.

## Local development

```bash
cp .env.example .env                      # fill in secrets
docker compose up -d postgres redis       # infra (schema auto-applies on first boot)
npm install && npm run build
npm run db:migrate                        # idempotent — safe to re-run
npm run dev                               # API + workers on http://localhost:3000
# Frontend dev: cd frontend && npm install && npm run dev (Vite proxy → :3000)
```

Seeded users (password `change-me` — rotate immediately): `jmercer@aegisadvisory.co.uk` (admin), `dokafor@…` (reviewer), `mreyes@…` (editor).

Simulate a Karbon trigger locally (Phase 1's "mock trigger button" equivalent):

```bash
BODY='{"workItemId":"KB-2214","stageId":"mkt-ready","clientName":"Halcyon Occupational Health","topic":"Cash flow forecasting for occupational health providers","keywords":["cash flow forecast","occupational health finance"],"tone":"Authoritative, plainspoken"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$KARBON_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3000/api/webhooks/karbon \
  -H "Content-Type: application/json" -H "X-Karbon-Signature: sha256=$SIG" -d "$BODY"
# Send it twice: the second delivery returns {"duplicate":true} — idempotency in action.
```

## GitHub → Railway deployment

1. `git init && git add -A && git commit -m "NexusFlow initial"` → push to a new GitHub repo (`.env` is gitignored; commit `.env.example` only).
2. Railway → **New Project → Deploy from GitHub repo** → select the repo. Railway detects `railway.toml` + `Dockerfile`.
3. **Add plugins:** New → Database → PostgreSQL, then New → Database → Redis. Railway auto-injects `DATABASE_URL` and `REDIS_URL` into the service.
4. **Variables tab:** set every secret from `.env.example` (JWT_SECRET, MASTER_ENCRYPTION_KEY, KARBON_*, REPLIT_*, OPENAI_API_KEY, WORDPRESS_*, META_* with `META_SANDBOX_MODE=true`, AC_*, LINKEDIN_*, FB_*, IG_*).
5. First deploy: run `npm run db:migrate` once via `railway run`, or rely on docker-compose locally + let the deploy serve traffic after the schema exists.
6. Point the Karbon webhook at `https://<service>.up.railway.app/api/webhooks/karbon` (Phase 3) and paste the shared secret into both Karbon and `KARBON_WEBHOOK_SECRET`.
7. Health check is `/healthz` (verifies Postgres + Redis). If a deploy fails its health check, the usual cause is a missing plugin var — the app fails fast with the exact missing name.

**Scaling:** the default topology runs API + workers in one service. To split, create a second Railway service from the same repo with start command `node dist/index.js --worker` and change the first to `--web`.

## Phased rollout (matches the original plan)

- **Phase 1 (live now in this code):** core engine, Replit generation, SEO scorer, review dashboard, WordPress deploy — trigger via the curl above.
- **Phase 2:** set AC_* + LinkedIn/FB/IG creds; toggle adapters on in Settings. Social failures are per-platform and non-blocking.
- **Phase 3:** Meta app review (`ads_management`, `pages_read_engagement`, `instagram_basic`) → flip `META_SANDBOX_MODE=false`; register the live Karbon webhook.

Until credentials exist, WordPress/Meta/AC/social adapters run in **structural stub mode**: they log the exact payload they would send (UTM already applied) and return synthetic IDs, so the whole saga is exercisable end-to-end on day one.
