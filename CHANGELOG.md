# Changelog

## 2026-07-02
- **Open-sourced a self-hostable build under AGPL-3.0.** The app, CLI, `@md/core`, MCP stub,
  and Supabase migrations are published as a self-hostable mirror; see the README's
  **Self-hosting** section for setup (Supabase project + any Node/Vercel host, configured
  entirely by environment variables). Licensed AGPL-3.0 (`LICENSE`).

## 2026-06-16
- **Agent read link now works pasted into ChatGPT/any LLM.** The agent link is a GET
  capability URL `…/d/<slug>/agent/<token>` (token in the path): a plain fetch now returns a
  JS-free `text/html` page with the document and reviewer comments visible in the body. Explicit
  `Accept: text/markdown` clients still get the source-embedded Markdown export, and
  `POST /api/d/<slug>/export` (Bearer → fenced JSON) remains for programmatic agents. The route
  keeps read-only, single-document, 30-day, revocable tokens; `no-store`/`no-referrer`;
  rate-limiting; identical 401 for bad/expired/wrong-doc; and untrusted-comment guidance.
- Commenting polish: desktop text selection now opens the inline composer on the first attempt
  instead of losing the fast path to the `selectionchange` debounce, and text/emoji submits close
  the selection composer immediately while the network request reconciles in the background.
- Document pages now set the browser tab title to the loaded document name client-side.
- ActionBar pill: dividers now visible in light + dark (`bg-foreground/20`), and the Preview/Code
  toggle's active view is a filled chip (was near-invisible). Groups: [Preview,Code]│[Download,Copy]│
  [reviewer link,agent link,Participants]│[Theme,Help].
- **Fixed prod upload 500:** migration `0003` (`personal_access_tokens.document_id`) had never been
  applied to the cloud DB; the new export-token mint (called on every create) surfaced it. Applied 0003.
- **Agent link on the receipt + owner-pill polish.** The upload success card now shows the
  AI **read-only** link as a third row under the owner link (Reviewer → Owner → AI, minted at
  upload via `agentUrl` in the create response). The owner ActionBar is regrouped:
  `[Download][Copy document → clipboard]` │ `[Copy reviewer link 🔗][Copy AI agent link ✨][Participants]`
  — "Copy document" copies the full Markdown **including comments** to the clipboard. Also fixed a
  pre-existing AA contrast miss on the thread reply timestamp.
- **AI-agent read access (owner-controlled, read-only).** An owner can hand an AI agent a
  dedicated **read-only** link to fetch a document's markdown + comments + reactions — gated
  by a scoped token, never the owner Magic Link. The owner ActionBar gains a Sparkles
  "Copy AI agent read link" control (mints a read-only PAT, scopes pinned to
  `docs:read`+`comments:read`, 30-day TTL, revocable/audited) and copies an `#x=<token>`
  capability URL. New `POST /api/d/<slug>/export` (Bearer token) returns **provenance-fenced
  JSON** (untrusted comment/author fields wrapped `{source,untrusted,value}` + agent guidance);
  wrong-kind/invalid/tokenless all return an identical `401` (no token-kind oracle); rate-limited
  (new `export` scope, migration `0007`) before any token lookup; `no-store`/`no-referrer`.
  A `public/llms.txt` documents the agent flow (Bearer-only, treat untrusted fields as data).
  Design verified by an 8-expert security workflow (verdict: ok-with-conditions; all conditions met).
- **Security: fixed an HTML-comment fence breakout in the comments serializer** (`@md/core`).
  A reviewer comment (or display name) containing `-->` could escape the embedded-comments
  appendix — injecting markdown a reading agent would treat as trusted content, and silently
  wiping all comments on a round-trip (`parseComments` swallowed the error). Now `--` is
  reversibly escaped so no terminator can form, and `parseComments` **fails loud**
  (`CommentsParseError`) instead of returning `[]`. Affected the existing download / `md pull`.
- **Security: rate limiter now keys on the Vercel-trusted client IP** (`x-real-ip`), not the
  spoofable leftmost `x-forwarded-for` — the per-IP limit on the early-access gate, document
  password, and upload paths was previously bypassable by rotating the header. (Shipped to prod.)
- **Document upload on the landing page.** The home page stays minimal (hero + a single
  "Upload a file" button); clicking it opens an **early-access gate** (shared password, server-checked,
  env-configured, rate-limited per IP — "testers only for now"). After unlocking, drag-and-drop or
  browse a `.md`, set a title + document password, and confirm. Success is a **ticket-style "receipt"
  card** that slides up with a confetti burst (both suppressed under `prefers-reduced-motion`):
  reviewer link first (subtle green icon) + owner link second (subtle red icon), each copyable with
  distinct names; an absolute 30-day auto-delete date; a "how it works" explainer; a CLI/agent note;
  and a barcode of the slug. A self-host card at the bottom links the open-source repo. All steps have
  smooth enter transitions; the landing CTA renders without JS (no first-paint hide).
- **30-day retention + auto-delete.** New `documents.expires_at` (default now()+30d, safe backfill) and
  a pg_cron job that deletes expired documents (cascades to all children), plus an `auth_attempts`
  ledger prune. Capability-token expiry aligned 90→30 days. (Backend landed in the prior commit.)
- New `--accent-solid` token (#0061a8) for filled accent buttons so white label text meets WCAG AA
  (the brand `#0099ff` is only 2.99:1 with white).
- Full Playwright coverage: `upload.spec.ts`, `upload-a11y.spec.ts` (axe per state, both themes +
  keyboard/SR/focus), `upload-security.spec.ts` (gate non-bypassable, no-secret, rate-limit, RLS),
  a gate-aware `seedDocument()` helper + rate-limit reset in `globalSetup` (existing specs migrated to
  unlock the gate). Suite green on desktop + mobile.

## 2026-06-14
- Responsive comment badge: on mobile it caps at 2 avatars (rest collapse into a "+N" pill) and
  shows a single summary emoji, vs 3 avatars / 3 emoji on desktop — so it stays slim and never
  bleeds into the prose. New badge-responsive.spec.ts.
- ActionBar colors reverted to the design-system elevated surface: a light-grey pill in light mode
  and a dark-grey pill in dark mode (undoing the black/white inversion).
- Preview↔Code transition reworked into a soft spring fade (opacity + blur, geometry-neutral so
  comment pins don't drift); removed the morphing-text header effect.
- Loading spinner centered: the loader (SpiralLoader + label) is now a fixed full-viewport centered
  overlay, so it no longer jumps between load phases (gate/checking vs in-document overlay).
- Comments in the Code view (#21 part 2): the raw-markdown Code tab now highlights anchored quotes
  inline (matched in the source) and opens the same thread popover (reply/react/resolve) — comments
  are visible + actionable there, not only in Preview. New code-view-comments E2E.
- Comments in source .md (#21 part 1): downloads / `md pull --comments` now embed the document's
  comments+reactions as an invisible `md.jholec.com/comments` HTML-comment appendix (author, anchor,
  status, reactions, replies) via new @md/core serialize/parse; re-uploading a downloaded file
  stores clean content (appendix stripped). Round-trip E2E + @md/core unit tests.
- **Security review + fixes** (multi-expert audit, 8 confirmed findings). Closed two criticals in
  the PAT/CLI chain: the token-mint endpoint is now owner-gated with a scope allow-list (was
  unauthenticated + arbitrary scopes), and PATs are bound to a single document
  (`personal_access_tokens.document_id`, migration `0003`) so a token authorizes only its own doc
  (was: any PAT = owner of every document). Also: global security headers (CSP/HSTS/X-Frame-Options/
  nosniff/Referrer-Policy/Permissions-Policy) and OWASP-aligned argon2id params + an 8-char password
  floor. New `e2e/security-pat.spec.ts`.
- Preview↔Code view transition: a tasteful, geometry-neutral blur+opacity cross-fade between the
  rendered preview and the raw markdown, plus a one-shot character "decode" morph on the Code view's
  "Markdown source" header (MorphReveal). Animates only opacity/filter — never a transform — so
  comment pins/underlines never drift after toggling. Honors prefers-reduced-motion (instant swap,
  static header). Designed via a motion-specialist workflow. New view-transition.spec.ts.
- ActionBar inverted vs. the theme: a pure-black pill on the light theme and a pure-white pill on
  the dark theme (solid, no translucency), via new --action-bar tokens — the rest of the UI keeps
  its normal theme colors.
- Add-comment composer: the selected text now stays highlighted (a persistent overlay) while the
  composer is open, the composer mirrors the thread-detail design (elevated container + a
  page-coloured boxed input), and its pointer arrow is rounded with the container border wrapping
  continuously around it. New selection-composer.spec.ts + inverted-token coverage in tokens.spec.
- Feedback + loading polish: the document loader now stays up until the comments' initial fetch
  resolves, so the page is never revealed half-loaded (content first, badges popping in late);
  emoji reactions toggle optimistically (the pill responds on the tap, then reconciles with the
  server) so they no longer feel laggy; added app-wide haptic feedback via `use-haptic` (reacting,
  posting a comment/reply, copying the share link) — gracefully no-ops where unsupported, and a
  capture-phase guard stops the iOS haptic trigger from dismissing the thread popover.
- Thread interaction polish: the reply field now renders at 16px on mobile so iOS Safari no longer
  auto-zooms/jumps the viewport on focus; on mobile the reply input is hidden behind a Reply button
  inline with the reactions and revealed on tap (desktop shows it inline as before); newly posted
  replies spring into the thread and the popover grows smoothly instead of snapping, respecting
  reduced-motion. New `thread-interactions.spec.ts` + reusable `useMediaQuery`.
- Comment badges + reactions redesign: right-margin block badges are now left-anchored so their
  avatar stacks line up in one gutter column (no drifting, no dangling empty space); avatar overlap
  loosened so initials aren't clipped; the illegible grey thread-count dot is now a legible outlined
  count chip; badges use the `--elevated` surface with direct hover feedback. The in-thread reaction
  UI is unified into a single `ReactionBar`: each palette emoji is one toggle — a pressed pill with a
  count when reacted, a round add-button when not — tapping toggles instantly (no confirm) and
  tapping again removes it. New `badge-reactions.spec.ts` (desktop + mobile + axe).
- UI polish: new `--elevated` design token for floating surfaces — a faint grey in light mode and
  a near-black grey in dark mode so the action pill and comment thread popovers separate from the
  page background in both themes. Comment input fields stay page-coloured (`bg-background`). Token
  coverage added to `tokens.spec.ts`.
- Loader: replaced the document-load spinner with a Lottie `SpiralLoader` (fast burst → slow
  passes; auto-inverts on light themes).
- **v1 deployed live to https://md.jholec.com** (Vercel + cloud Supabase + GoDaddy DNS).
- Plan 04 (commenting): selection composer, W3C text-quote anchoring, Figma-style pins, thread
  popover, toggleable emoji reactions, replies, Supabase-broadcast realtime, owner toolbar
  (download/share/participants/resolve). 12/12 Playwright+axe E2E.
- Plan 03 (render + gate): document page with capability/password gate + markdown render
  (preview/code, light/dark, mobile); rehype-highlight + rehype-sanitize.
- Plan 02 (backend + CLI): schema + deny-by-default RLS, capability-token/argon2id/PAT auth, all
  route handlers; `md` CLI (new/pull/push/comments/reply/react) with edit-via-CLI; cloud migrations applied.

## 2026-06-13
- Foundation (Plan 01): pnpm monorepo; Next.js 16 + React 19 app with jholec.com design
  tokens (light/dark); core/cli/mcp packages; Playwright (desktop+mobile) + axe harness;
  13-agent build team + build-feature orchestration skill; knowledge base; inspiration
  components; Vercel CLI. Private repo on GitHub.
