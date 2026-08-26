# Machiavelli — pi extension

Integrates the Machiavelli corporate-ontology advisor into
[pi / OpenCode](https://github.com/earendil-works/pi) as a native extension.

## Installation

```
pi install git:github.com/AlexGladkov/machiavelli
```

Then reload the extension runtime inside pi:

```
/reload
```

The extension registers six slash commands immediately after reload.

## Prerequisites

The extension shells out to the Machiavelli core CLI. One of:

- **Homebrew binary** (recommended): `machiavelli` available on `$PATH`.
  The extension auto-detects it by scanning PATH entries.
- **Dev checkout**: keep this repository cloned with `core/` intact.
  The extension falls back to `node <repo>/core/machiavelli.cjs`.

Node >= 20 is required by the core CLI (SQLite is bundled via
`better-sqlite3-multiple-ciphers`).

## Commands

| Command | Description |
|---|---|
| `/mach-advice <question>` | Get strategic advice for a specific situation |
| `/mach-daily` | Daily digest — overview of all tracked persons and dynamics |
| `/mach-fact <person> <fact text>` | Record an immutable fact about a person |
| `/mach-person <name or description>` | Add a new person to the store |
| `/mach-profile <person> [lens]` | Generate a psychological profile (optional lens: `disc`, `bigfive`, `leverage`) |
| `/mach-status` | Show runtime diagnostics (DB path, person/fact counts, Node version) |

All argument parsing avoids shell injection — commands use `execFile` with
an explicit argument array, never `shell: true`.

## Privacy note

`/mach-advice`, `/mach-daily`, and `/mach-profile` forward pseudonymised
personal data to an external LLM API configured in `~/.machiavelli/config.json`
(typically OpenAI or Anthropic). On first use the extension will ask for your
explicit consent. The answer is stored in:

```
~/.pi/agent/machiavelli-settings.json
```

No data is sent until you confirm. You can revoke consent by editing that file
and setting `"consentGiven": false`.

## Build / type-check

Install devDependencies from the repository root (not from `core/`):

```
npm install
npm run typecheck
```

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are scoped
packages published to the public npm registry. If `npm install` fails (e.g.
private registry, auth issue), pin versions manually in the root `package.json`
or use `"*"` for latest. The `core/` directory has its own `package.json` and
is intentionally isolated.
