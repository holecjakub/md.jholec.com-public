# md.jholec.com

<p align="center">
  <img src="docs/assets/md-collab-demo.svg" alt="Several reviewers quietly annotating the same markdown document: each cursor highlights a passage in its own colour — one writes a comment, one reacts with an emoji, one just selects text." width="900">
</p>

A hosted **markdown collaboration & feedback** service. The author uploads a `.md`,
gets a shareable link, and reviewers open it in the browser, read a clean rendered
preview, and leave **Figma-style inline comments + emoji reactions** anchored to the
exact text they select — no install, no markdown knowledge, no account. Reviewers
annotate; they never edit the source. The author keeps the markdown as the canonical
artifact and can download it at any time **with all feedback embedded**.

Live: **https://md.jholec.com**

---

## Features

- **Open with a link** — capability tokens in the URL fragment (`#t=…` reviewer,
  `#o=…` owner) or a name + document password. No sign-up.
- **Clean preview** — GitHub-flavored markdown, light/dark, mobile-first, sanitized.
- **Inline comments** — select any text → comment; W3C text-quote anchoring keeps a
  comment pinned to its words even as the document changes.
- **Reactions & replies** — a unified reaction bar (tap to toggle, optimistic) and
  threaded replies.
- **Right-margin badges** — one quiet per-block badge (avatar stack + reaction
  summary); responsive (fewer avatars/emoji on mobile so it never crowds the text).
- **Live** — Supabase Realtime broadcast: new feedback appears for everyone without a
  refresh.
- **Owner tools** — a floating action bar (desktop pill / mobile FAB): Download,
  Share link, Participants, Resolve, Delete, Preview↔Code, theme, Help.
- **Preview ↔ Code** — toggle the rendered view and the raw source (comments are
  visible and actionable in both), with a tasteful spring-fade transition.
- **Comments in the source `.md`** — Download / `md pull --comments` embed all
  feedback as an invisible `md.jholec.com/comments` appendix that round-trips.
- **Polish** — Lottie loader, native iOS haptics (graceful no-op elsewhere),
  reduced-motion aware throughout.
- **CLI + API** — host, edit, and pull documents (with comments) from the terminal.

## Stack

- **App** — Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4
- **UI** — Base UI + Radix primitives · `motion` · `next-themes` · `lucide-react` ·
  `lottie-react` · `use-haptic`
- **Markdown** — `react-markdown` + `remark-gfm` → **`rehype-highlight`** (sync) →
  `rehype-sanitize` (sanitize last; no `rehype-raw`, no `dangerouslySetInnerHTML`)
- **Backend** — Supabase **Postgres + deny-by-default RLS + Realtime** (service-role
  only on the server; the browser reads nothing directly)
- **Auth** — custom capability tokens (SHA-256 hashed) · document password
  (**argon2id**, OWASP params) · signed `jose` HS256 session cookie · document-bound
  PATs for the CLI
- **Validation** — `zod` on every request boundary

> The app does **not** use Supabase Auth — access is the custom capability-token /
> password model described under [Security](#security).

## Monorepo layout

pnpm workspace:

```
apps/web/                 # the Next.js 16 product (UI + API routes)
packages/
  core/                   # @md/core — typed API client, anchoring, comments-md serde
  cli/                    # the `md` CLI (new / pull / push / comments / reply / react / auth)
  mcp/                    # MCP server (phase 2 stub)
supabase/
  migrations/             # 0001 schema · 0002 RLS · 0003 PAT↔document binding
  config.toml             # local Supabase stack
```

## Quickstart (local)

```bash
# 1. Install (see the NODE_ENV gotcha below)
NODE_ENV=development pnpm install

# 2. Start a local Supabase stack (Docker) — applies migrations + seed
supabase start

# 3. Configure the app from the values `supabase start` prints
cp apps/web/.env.example apps/web/.env.local
#   set NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
#   set SESSION_SIGNING_SECRET  →  openssl rand -base64 32

# 4. Run
pnpm dev            # http://localhost:3000
```

> **Install gotcha:** always install with `NODE_ENV=development`. If
> `NODE_ENV=production` is exported, pnpm skips `devDependencies` and the
> build/test/lint toolchain won't be installed. (`next build` itself needs
> production `NODE_ENV`.)

## Scripts

```bash
pnpm dev                                                # Next dev server
pnpm build                                              # build all packages
pnpm -r test                                            # unit tests (Vitest, @md/core)
pnpm --filter @md/web exec playwright test              # E2E (desktop + mobile + axe)
pnpm --filter @md/web exec playwright test --workers=2  # if the shared dev server flakes
pnpm -r lint                                            # eslint
pnpm -r typecheck                                       # tsc --noEmit
```

## CLI

```bash
md auth login --token <pat> --api https://your-host/api   # store a PAT
md new spec.md --title "Spec" --password "<8+ chars>"      # host a doc, get links
md pull <slug>                  # current source
md pull <slug> --comments       # source WITH the embedded feedback appendix
md push <slug> file.md          # upload a new version
md comments <slug> [--open]     # list threads
md reply <slug> <id> "…"        # reply
md react <slug> <id> 👍          # react
```

Configure the endpoint with `MD_API_URL` (or `md auth login --api …`); the token with
`MD_TOKEN` or the stored config at `~/.config/md/config.json`.

## Security

- **Access tokens** — 256-bit, issued once, stored only as a SHA-256 hash, carried in
  the URL **fragment** (never sent in a request line / Referer) and POST-redeemed for a
  session. `invite` tokens are reusable; `owner` tokens are single-use unless explicitly
  minted reusable.
- **Document password** — argon2id (19 MiB / t=2 / p=1), rate-limited, 8-char minimum;
  grants the reviewer role.
- **Session** — `jose` HS256 cookie (`httpOnly`, `secure` in production), short TTL
  (`SESSION_TTL_SECONDS`, default 1h).
- **PATs (CLI)** — owner-gated issuance, a server-side scope allow-list, and **bound to
  a single document** (migration `0003`) so a token can only ever touch its own doc.
- **RLS** — every table denies anon/authenticated by default; only the server's
  service-role client reads/writes, behind the auth checks above.
- **Headers** — strict CSP (`frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, Permissions-Policy.

## Self-hosting

Everything is configured by environment variables — there's no hard dependency on the
hosted instance. You need (1) a Supabase project and (2) somewhere to run the Next.js
app.

### Required environment (`apps/web/.env.local`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase API URL (`https://<ref>.supabase.co`, or your self-hosted URL) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key (browser; reads nothing thanks to RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key (server only) |
| `SESSION_SIGNING_SECRET` | yes | Secret for session cookies — `openssl rand -base64 32` |
| `APP_BASE_URL` | no (default `http://localhost:3000`) | Public origin; used to build share/owner links |
| `SESSION_TTL_SECONDS` | no (default `3600`) | Session lifetime |

### 1. Database (Supabase)

Use **Supabase Cloud** (free tier) *or* a **self-hosted Supabase** (Docker). Apply the
migrations in order:

```bash
# Cloud:
supabase link --project-ref <your-ref>
supabase db push

# Local / self-hosted stack:
supabase start          # applies supabase/migrations/* + seed automatically
```

Migrations: `0001_init.sql` (schema), `0002_rls.sql` (deny-by-default RLS),
`0003_pat_document_binding.sql` (binds PATs to a document).

### 2. App

**Vercel (easiest):** import the repo, set **Root Directory = `apps/web`**, add the env
vars above to the Production + Preview targets, deploy. Keep deployment protection / SSO
**off** (it's a public app). Point your domain's DNS at Vercel.

**Any Node host / Docker:**

```bash
NODE_ENV=development pnpm install
NODE_ENV=production pnpm --filter @md/web build
NODE_ENV=production APP_BASE_URL=https://your-host pnpm --filter @md/web start
```

### Rebranding

A few cosmetic strings say `md.jholec.com` — swap them for your name:
`apps/web/app/layout.tsx` (tab title), `apps/web/app/page.tsx` (landing header/footer),
`apps/web/app/d/[slug]/page.tsx` (document tab title), and the CLI help /
`DEFAULT_API_URL` in `packages/cli/src/index.ts` (or just set `MD_API_URL`). **Do not**
change `COMMENTS_MARKER` (`md.jholec.com/comments`) in `packages/core` — it's a portable
format identifier for the embedded-comments appendix, not a hostname.

## Deploy pipeline (this instance)

- `main` = **production** → auto-deploys to https://md.jholec.com (Vercel, Git-connected).
- `develop` + PRs = **preview** (`*.vercel.app`). Flow: `feat/* → develop` (preview) →
  `develop → main` (production). Cloud DB changes ship as `supabase/migrations/*.sql`.

## Learn more

Changelog: [`CHANGELOG.md`](./CHANGELOG.md).
