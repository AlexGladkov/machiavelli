# Machiavelli — Project Instructions

Portable corporate ontology and strategic advisor CLI. Core: Node.js `.cjs` + SQLite.
Adapters: thin markdown wrappers for Claude Code (commands + sub-agent).
Architecture: ego-centric fact graph → psycho-profiles via pluggable lenses → ethical guardrail → advice.

DESIGN_SYSTEM: warp

---

## Agents

### Консилиум

| Role       | Agent                              |
|------------|------------------------------------|
| architect  | voltagent-dev-exp:cli-developer    |
| developer  | voltagent-lang:javascript-pro      |
| security   | voltagent-infra:security-engineer  |
| api        | voltagent-core-dev:api-designer    |
| ui         | voltagent-core-dev:ui-designer     |
| devops     | devops-orchestrator                |

### Executing

| Agent                         | Scope                         |
|-------------------------------|-------------------------------|
| voltagent-lang:javascript-pro | core/**/*.cjs                 |
| devops-orchestrator           | adapters/**, install.sh       |

---

## Commands (development)

### Smoke tests

```bash
node core/tests/store.smoke.cjs
node core/tests/cli.smoke.cjs
```

### Manual CLI (all support --json and --dry)

```bash
node core/machiavelli.cjs status --json
node core/machiavelli.cjs version --json
node core/machiavelli.cjs doctor --json
node core/machiavelli.cjs init "Me" --json
node core/machiavelli.cjs person "Name" --json
node core/machiavelli.cjs fact <code> "<fact>" --json
node core/machiavelli.cjs profile <code> --json
node core/machiavelli.cjs advice "<query>" --json --dry
node core/machiavelli.cjs daily --json --dry
node core/machiavelli.cjs graph --json
node core/machiavelli.cjs relation list --json
node core/machiavelli.cjs relation confirm <edge_id> --json
```

### Reinstall adapters

```bash
bash install.sh
```

---

## Architecture notes

- `core/machiavelli.cjs` — CLI router. All commands return a unified JSON envelope `{ok, cmd, data, error, meta}`.
- `core/store/` — SQLite layer: objects, facts (immutable), interpretations (regenerable), relations (graph).
- `core/engine/` — LLM provider abstraction (`llm.cjs`), profile generation (`profile.cjs`), advice with guard (`advice.cjs`, `guard.cjs`).
- `core/lenses/` — pluggable psycho-lens prompt templates (disc, bigfive, leverage).
- `adapters/claude/commands/` — thin markdown wrappers installed to `~/.claude/commands/mach-*.md`.
- `adapters/claude/agents/` — sub-agent installed to `~/.claude/agents/machiavelli-advisor.md`.
- `data/` — excluded from git (`.gitignore: *`). Contains encrypted DB and pseudonym map.

## Exit codes

| Code | Meaning                                   |
|------|-------------------------------------------|
| 0    | Success (even if `ok: false` in envelope) |
| 1    | Internal error                            |
| 2    | Bad args / consent required               |
| 3    | Environment error (Node, SQLite, key)     |

## Key ENV

| Variable        | Purpose                                       |
|-----------------|-----------------------------------------------|
| `MACH_LLM_KEY`  | LLM API key (Anthropic or OpenAI-compat)      |
| `MACH_LLM_URL`  | Base URL for OpenAI-compat provider (optional)|
| `MACH_LLM_MODEL`| Model name override                           |
| `MACH_KEY`      | DB encryption key (fallback to keyring)       |
| `MACH_NAMES_KEY`| Pseudonym map encryption key                  |

## Invariants (never violate in code or advice)

1. Facts are immutable and append-only — never UPDATE or DELETE facts rows.
2. Interpretations are regenerable — always tied to a lens and versioned.
3. Pending relations are not facts — require explicit `relation confirm`.
4. Guardrail is always enforced — block/rewrite/pass, never bypass.
5. No secrets in git — `data/`, `*.db`, `*.enc`, `*.map` are gitignored.
