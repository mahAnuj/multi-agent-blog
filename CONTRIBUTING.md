# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

Requires Node 20+ and a Postgres database.

```bash
git clone https://github.com/mahAnuj/multi-agent-blog.git
cd multi-agent-blog
npm install
cp .env.example .env    # fill in DATABASE_URL, OPENAI_API_KEY, ADMIN_PASSWORD
npm run db:push
npm run dev
```

Open http://localhost:5000. Sign in at `/admin`, then the generation dashboard
is at `/ai-dashboard`.

**Set `ADMIN_PASSWORD`.** Without it every admin route returns 503 and the
dashboard will look broken. That is deliberate — see below.

A local Postgres is enough; you do not need Neon to develop.

## Before you open a pull request

```bash
npm run check    # tsc --noEmit, currently zero errors
npm test         # must pass; needs no database or OpenAI key
npm run build    # must succeed
```

`npm run check` is at zero errors. Please keep it there — it got there by
fixing seven real bugs, including a missing import that broke the homepage and
a schema mismatch that made publishing a post impossible.

The tests cover job cancellation so far (`npm test`, Node's built-in runner
through tsx). Add new test files to the `test` script in `package.json`.

## Security rules

**The admin password never goes in client code.** An earlier version compared it
in the browser against a hardcoded `admin123` while the server had no
authentication at all — meaning anyone who could reach the server could trigger
generation runs, spending real OpenAI credit, or delete posts.

Authentication now lives in `server/auth.ts`. If you add a route that mutates
data or spends money, put `requireAdmin` on it. If you are unsure whether a
route needs it, it does.

**It must fail closed.** With `ADMIN_PASSWORD` unset, admin routes return 503.
Never add a fallback that skips the check when the variable is missing.

## Working on the agents

The pipeline lives in `server/ai-agents/`. Two things to preserve:

- **`enhanceAgent` revises only from `reviewAgent`'s feedback**, not from its own
  judgement. That separation is the reason the output is worth reading. A single
  generation pass reliably produced confident, shallow copy.
- **Model choice is per run.** `orchestrator.applyModel()` distributes it. A new
  LLM-backed agent must be added there rather than hardcoding a model.

- **Every agent request must stay cancellable.** Pass `requestOptions()` as the
  second argument to `openai.chat.completions.create()` (and spread it into any
  `fetch`), and start each `catch` that falls back to a default with
  `rethrowIfCancelled(error)`. Both come from `server/ai-agents/jobContext.ts`.
  A new pipeline step in the orchestrator goes after a `this.checkpoint(jobId)`.

Prompt changes are hard to review from a diff. Please include a before/after
sample of generated output in your pull request.

## Gotchas worth knowing

- **JSON has no date type.** `insertPostSchema` coerces `publishedAt` from an ISO
  string. Removing that coercion breaks every create and update carrying a date.
- **`server/db.ts` throws at import time** without `DATABASE_URL`, and the agents
  build OpenAI clients eagerly. Both fail fast on purpose.
- **Don't rename the branding.** `client/index.html`, `seo-head.tsx` and
  `header.tsx` carry live SEO metadata; `pm2.config.cjs` and `deploy.sh` share a
  pm2 process name. These are deployment identity, not leftovers.

## Reporting bugs

Include the route or dashboard action, the full server log, and the browser
console output. For a generation issue, the topic, keywords and model used.
