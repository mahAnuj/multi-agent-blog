# AGENTS.md

Guidance for AI coding agents working in this repository. Also useful to humans.

## Commands

```bash
npm install
npm run dev      # tsx server/index.ts, API + Vite client together on :5000
npm run build    # vite build (client) + esbuild (server) -> dist/
npm start        # NODE_ENV=production node dist/index.js
npm run check    # tsc --noEmit - currently zero errors, keep it that way
npm run db:push  # apply the Drizzle schema
```

`npm run dev` loads `.env` through dotenv. Required variables:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres. Required at import time — `server/db.ts` throws without it |
| `OPENAI_API_KEY` | Required at startup — the agents construct clients eagerly |
| `ADMIN_PASSWORD` | Gates every admin route. Unset means 503, never open |

## Architecture

A blog whose posts are drafted by cooperating agents, then reviewed by a human
before publication.

### The agent pipeline

`server/ai-agents/orchestrator.ts` coordinates five agents. Two entry points:
a single custom post from a topic, or a sweep over recent news.

| Agent | Role |
| --- | --- |
| `latestKnowledgeAgent` | Gathers current context before drafting |
| `newsAgent` | Fetches recent AI news, scores articles for relevance |
| `contentAgent` | Drafts the post |
| `reviewAgent` | Critiques the draft, produces a quality score |
| `enhanceAgent` | Revises using **only** the review feedback |

### Other layers

- **`server/routes.ts`** — every HTTP route. Admin routes take `requireAdmin`.
- **`server/auth.ts`** — the admin gate (see invariants).
- **`server/storage.ts`** — data access behind an `IStorage` interface.
- **`shared/schema.ts`** — Drizzle tables *and* the Zod insert schemas, shared
  by client and server. The single source of truth for post shape.
- **`client/src/pages/ai-dashboard.tsx`** — the generation UI: model, keywords,
  topic, instructions, and the news-sweep parameters.
- **`client/src/lib/admin-token.ts`** — reads/writes the session token; the
  query layer attaches it to every request.

### Invariants

- **Admin auth is server-side and fails closed.** `requireAdmin` guards eleven
  routes. With `ADMIN_PASSWORD` unset they return 503 — never open. The password
  must never appear in client code; an earlier version compared it in the
  browser against a hardcoded `admin123`, which meant no protection at all.
- **The model is chosen per run, not hardcoded.** `applyModel()` fans the choice
  out to the content, review, enhance and knowledge agents. Add new agents to
  that method. The web-search step is deliberately pinned to a search-enabled
  model and is not user-selectable.
- **`enhanceAgent` works only from `reviewAgent`'s feedback**, never its own
  opinions. That separation is why the output is worth reading; collapsing the
  two agents defeats the design.
- **The build must not need runtime secrets** beyond what is listed above, and
  `serveStatic` resolves `dist/public` whether running bundled or from source.
- **JSON has no date type.** `insertPostSchema` coerces `publishedAt`; without
  that, every create carrying a date is rejected. Keep the coercion.
- Generated posts are reviewed before publishing. Nothing auto-publishes.

## Conventions

TypeScript with ES modules throughout. Path aliases: `@/` is `client/src/`,
`@shared/` is `shared/`. Server imports use explicit `.js` extensions.
UI is shadcn/ui on Radix with Tailwind; routing is Wouter; server state is
TanStack Query.

## A note on branding

`client/index.html`, `seo-head.tsx` and `header.tsx` carry "Anuj's Blog" and
real SEO metadata for a live deployment, and `pm2.config.cjs` / `deploy.sh`
share a pm2 process name. Those are deployment identity, not stale strings —
renaming them breaks SEO and deploys. The repository name is generic because
the engine is; the app is one deployment of it.
