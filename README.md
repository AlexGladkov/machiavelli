# Machiavelli

<p align="center">
  <img src="assets/machiavelli.png" alt="Machiavelli" width="640">
</p>

Portable corporate ontology and strategic advisor. Models the people, relationships, and
power dynamics in your organization as an ego-centric knowledge base. Generates advice from
your perspective using recorded facts and psycho-profiles — with an ethical guardrail built in.

Built on the Palantir ontology model: Objects (people, places, documents) + Relations (graph)
+ Actions (audit log). Three primitives, one ego, one source of truth.

---

## Install

```bash
git clone https://github.com/AlexGladkov/machiavelli && cd machiavelli && bash install.sh
```

Then set your LLM key: `export MACH_LLM_KEY=sk-ant-...` — or point `MACH_LLM_URL` at any OpenAI-compatible / local model (Ollama, Z.AI, OpenRouter). Adapters: `bash install.sh --host codex|opencode|all`.

---

## Quick start

```
/mach-init
```
Set your ego-center (name, optional title). Idempotent.

```
/mach-person Артём Волков, технический директор, формально мой руководитель
```
Creates a person node with a stable code (e.g. `person_3b2c`).

```
/mach-fact person_3b2c избегает конфликтов публично, но фиксирует позицию через email
/mach-fact person_3b2c меняет приоритеты без предупреждения перед квартальными ревью
```
Records immutable facts. Append-only — facts cannot be edited.

```
/mach-advice как подготовиться к разговору о повышении с Артёмом не получив отказ
```
Gets strategic advice from your ego perspective.

```
/mach-daily
```
Daily digest: who to talk to, what to prepare, what to watch.

---

## PRIVACY — read this

**Your facts are sent to an external LLM.** Every `/mach-advice` and `/mach-daily` call
sends fact bodies and profile interpretations to the LLM provider configured via `MACH_LLM_KEY`.

**What this means:**
- If you use Anthropic/OpenAI, your corporate intelligence leaves your machine.
- Pseudonym mode (`aliasMode: true` in config) replaces real names with codes in prompts.
  This reduces — but does NOT eliminate — re-identification risk, because relationship structure
  and behavioral patterns are still present.
- The graph structure (who relates to whom) is stored locally encrypted, but is transmitted
  as context during advice calls.

**Local privacy path (recommended for sensitive environments):**

```bash
export MACH_LLM_URL=http://localhost:11434/v1   # Ollama or LM Studio
export MACH_LLM_MODEL=llama3.2                  # or any local model
export MACH_LLM_KEY=local                       # any non-empty value
```

With a local model, no data leaves your machine.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MACH_LLM_KEY` | Yes (for advice/profile) | LLM API key. Anthropic key for default; any non-empty string for local. |
| `MACH_LLM_URL` | No | Base URL for OpenAI-compatible API. Empty = Anthropic. |
| `MACH_LLM_MODEL` | No | Model name override. Default set in `core/config.cjs`. |
| `MACH_KEY` | No | Encryption key for the SQLite database. If absent, keyring (macOS Keychain / libsecret) is used, or a key is generated on first `/mach-init`. |
| `MACH_NAMES_KEY` | No | Separate encryption key for the pseudonym map (`data/names.map.enc`). Falls back to `MACH_KEY` if unset. |

---

## Development

### Smoke tests

```bash
node core/tests/store.smoke.cjs
node core/tests/cli.smoke.cjs
```

### Manual CLI

```bash
node core/machiavelli.cjs status --json
node core/machiavelli.cjs init "Me" --json
node core/machiavelli.cjs person "Colleague Name" --json
node core/machiavelli.cjs fact person_xxxx "some fact" --json
node core/machiavelli.cjs advice "my question" --json --dry
node core/machiavelli.cjs graph --json
```

All commands support `--json` for machine-readable output and `--dry` to skip LLM calls.

---

## Multi-platform support

Machiavelli is built on a "prompt-compiler" model: the core assembles all corporate context
into a structured prompt, then either calls the configured LLM directly or returns the compiled
prompt for the host to handle via `--dry`.

### --dry → ingest pattern (hosts without MACH_LLM_KEY)

Codex, OpenCode, or any host with its own inference engine can use the two-step portability pattern:

```bash
# Step 1: get the compiled prompt (no LLM called)
node core/machiavelli.cjs advice "<query>" --dry --json
# → data.prompt contains the full assembled prompt

# Step 2: run your host's inference on data.prompt

# Step 3: for profile interpretations, store the result back
node core/machiavelli.cjs ingest profile <personRef> --lens <lens> --body "<result>" --json
```

Advice results are ephemeral — present the host's raw output directly.
Only profile interpretations have an ingest path.

### Host connection table

| Host | Connection method | Key requirement |
|------|------------------|----------------|
| Claude Code | `/mach-*` slash commands + `machiavelli-advisor` sub-agent | `MACH_LLM_KEY` optional (uses host's model via `--dry` pattern) |
| Codex | System prompt in `~/.config/machiavelli/adapters/codex/machiavelli.md` + per-command files | `MACH_LLM_KEY` optional (use `--dry` → Codex inference) |
| OpenCode | System prompt in `~/.config/machiavelli/adapters/opencode/machiavelli.md` + per-command files | `MACH_LLM_KEY` optional (use `--dry` → OpenCode inference) |
| Any OpenAI-compat host | Set `MACH_LLM_URL` + `MACH_LLM_MODEL`; core calls it directly | `MACH_LLM_KEY` required |

---

## Known limitations (v1)

- **Field-level encryption** covers fact bodies and names, but does NOT cover relation metadata
  (rel type, status, timestamps) beyond `rel_enc`. Graph structure is visible as plaintext in the DB.
- **Guard pass** supports `block` and `pass` verdicts. The `rewrite` path exists in the schema
  but may not be fully exercised in all providers.
- **Single ego only.** All advice is from one perspective. Multi-perspective is a potential v2 feature.
- **No cron / auto-scheduling** for `/mach-daily`. Manual invocation only.
- **No web UI** or graph visualization. Graph is text-only via `graph` CLI command.

---

## Invariants (never violated)

1. **Facts != Interpretations.** User-recorded facts are immutable and append-only. LLM-generated
   profiles and interpretations are labeled separately and can be regenerated at any time.
2. **Ethical guardrail.** The system does not give advice involving direct harm, deception toward
   third parties, physical threats, or setups (подстава). Two-layer enforcement: system prompt
   invariant + independent validator pass.
3. **Pending relations are not facts.** LLM-suggested graph edges are `pending` until the user
   explicitly confirms them via `relation confirm <edge_id>`.
4. **Build-once portability.** The core CLI is not bound to Claude. It works with any
   OpenAI-compatible provider or Anthropic. Adapters are thin wrappers.
