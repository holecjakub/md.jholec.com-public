# `md` — md.jholec.com CLI

Host, edit, and review Markdown documents from the terminal.

```
npm i -g @md/cli      # installs the `md` binary
```

By default the CLI talks to `https://md.jholec.com/api`. Override with
`--api <url>` on `auth`, or the `MD_API_URL` env var.

## Auth

The CLI uses two independent credentials:

- An **early-access grant** — needed only to *create* documents while the public
  early-access gate is on. Obtain it once:

  ```
  md auth unlock
  ```

  You are prompted for the shared early-access password (input is not echoed).
  Non-interactive environments set `MD_EARLY_ACCESS_PASSWORD` instead.

- A **Personal Access Token (PAT)** — needed for everything that acts on an
  existing document (pull/push/comment/react/agent-link/revoke/resolve). PATs
  are **document-scoped**: they are minted via `POST /api/d/<slug>/pat` from an
  owner session. Store one with:

  ```
  md auth login
  ```

  You are prompted for the token (not echoed). Set `MD_TOKEN` for a one-off or
  for non-interactive use.

### Secrets never belong in argv

Flags like `--password` and `--token` still exist as escape hatches, but avoid
them: command-line arguments are visible in `ps` output and shell history. The
preferred order for every secret is **environment variable → interactive
no-echo prompt**:

| Secret | Env var | Prompted by |
|---|---|---|
| Early-access password | `MD_EARLY_ACCESS_PASSWORD` | `md auth unlock` |
| Document password (for reviewers) | `MD_DOC_PASSWORD` | `md new` |
| Personal access token | `MD_TOKEN` | `md auth login` |

Without a TTY, the CLI fails loudly instead of prompting — provide the env var.

## Commands

| Command | What it does |
|---|---|
| `md new <file> --title <t>` | Create a hosted document (prompts for the reviewer password, or reads `MD_DOC_PASSWORD`). Prints the reviewer link, owner link, **AI-agent read link**, and the auto-delete date. Requires `md auth unlock` first. |
| `md pull <slug> [-o file] [--comments]` | Download the current version (optionally with the embedded comments appendix — owner). |
| `md push <slug> <file> [--title <t>]` | Upload a new version (owner PAT). |
| `md comments <slug> [--open]` | List comment threads. |
| `md reply <slug> <commentId> <body>` | Reply to a comment. |
| `md react <slug> <commentId> <emoji>` | React to a comment. |
| `md agent-link <slug>` | Mint a fresh read-only AI-agent read link (PAT with `tokens:mint`). |
| `md revoke <slug> [--invites] [--tokens]` | Revoke credentials for a document you own: `--invites` kills reusable invite share links, `--tokens` kills PATs and agent read links, no flag revokes both. Revoking tokens also kills the PAT the CLI itself is using for that document. Owner capability links are never revoked, so the owner is never locked out. (PAT with `tokens:mint`.) |
| `md resolve <slug> <commentId>` | Resolve a thread (owner PAT). |
| `md reopen <slug> <commentId>` | Reopen a resolved thread (owner PAT). |

Append `--json` for machine-readable output (also emitted automatically when
stdout is not a TTY).

## Notes & limitations

- `md agent-link` and `md revoke` mint/revoke *credentials*, so they require
  TRUE owner authority: the stored PAT must carry the dedicated `tokens:mint`
  scope (granted alongside `docs:write` when the PAT is minted). Content-scoped
  PATs — even with every read/write scope — get a 403 on these commands, and
  PATs minted before the `tokens:mint` scope existed do not carry it. There is
  no browser UI for minting a `tokens:mint` PAT yet; mint one from an owner
  session via `POST /api/d/<slug>/pat` with `scopes: ["docs:write", "tokens:mint"]`.
- `push`, `resolve`, and `reopen` need a PAT for that document with the matching
  content scope (`docs:write` / `comments:write`) — content scopes suffice; no
  `tokens:mint` required. There is no CLI-only PAT-mint path yet.
- There is intentionally **no `ls` / `whoami`**: PATs are document-scoped, so the
  CLI has no account context to list documents for. Those would require an
  account-level token model and new API endpoints.
