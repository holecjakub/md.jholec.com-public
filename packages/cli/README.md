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
  early-access gate is on. Obtain it once with the shared early-access password:

  ```
  md auth unlock --password <early-access-password>
  ```

- A **Personal Access Token (PAT)** — needed for everything that acts on an
  existing document (pull/push/comment/react/agent-link/resolve). PATs are
  **document-scoped**: you mint one from the document's owner view in the browser,
  then store it:

  ```
  md auth login --token <pat>
  ```

  (Or set `MD_TOKEN` for a one-off.)

## Commands

| Command | What it does |
|---|---|
| `md new <file> --title <t> --password <p>` | Create a hosted document. Prints the reviewer link, owner link, **AI-agent read link**, and the auto-delete date. Requires `md auth unlock` first. |
| `md pull <slug> [-o file] [--comments]` | Download the current version (optionally with the embedded comments appendix — owner). |
| `md push <slug> <file> [--title <t>]` | Upload a new version (owner PAT). |
| `md comments <slug> [--open]` | List comment threads. |
| `md reply <slug> <commentId> <body>` | Reply to a comment. |
| `md react <slug> <commentId> <emoji>` | React to a comment. |
| `md agent-link <slug>` | Mint a fresh read-only AI-agent read link (owner PAT). |
| `md resolve <slug> <commentId>` | Resolve a thread (owner PAT). |
| `md reopen <slug> <commentId>` | Reopen a resolved thread (owner PAT). |

Append `--json` for machine-readable output (also emitted automatically when
stdout is not a TTY).

## Notes & limitations

- `agent-link`, `resolve`, and `reopen` require the stored PAT to carry **owner**
  access for that document — i.e. a token minted from the owner view in the
  browser. There is no CLI-only owner-mint path yet.
- There is intentionally **no `ls` / `whoami`**: PATs are document-scoped, so the
  CLI has no account context to list documents for. Those would require an
  account-level token model and new API endpoints.
