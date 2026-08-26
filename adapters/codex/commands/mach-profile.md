# mach-profile — Codex command

Generates or regenerates a psycho-profile for a person using pluggable lenses
(disc, bigfive, leverage). Interpretations are stored in the database and are
regenerable — they are NOT facts.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user says: "построй профиль", "проанализируй {name}", "покажи профиль", or equivalent.

## Step 1 — collect arguments

- `<personRef>` — person code or name. Required.
- `--lens` — comma-separated list: `disc`, `bigfive`, `leverage`. Default: all active.
- `--regen` — force regeneration even if a current interpretation exists.

## Step 2 — choose execution mode

**Mode A — core has `MACH_LLM_KEY`**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs profile <personRef> --json --consent [--lens disc,leverage] [--regen]
```

**Mode B — no `MACH_LLM_KEY` (Codex portability pattern)**

Step B1 — get compiled prompt per lens:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs profile <personRef> --dry --lens <lens> --json
```

`data.prompt` contains the full profiling prompt for that lens.

Step B2 — run Codex inference on `data.prompt`. Receive the profile text.

Step B3 — ingest the result back into the database:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs ingest profile <personRef> \
  --lens <lens> --body "<generated-profile-text>" --json
```

Or via stdin:
```bash
echo "<generated-text>" | node {{CORE_PATH}}/core/machiavelli.cjs ingest profile <personRef> \
  --lens <lens> --stdin --json
```

Repeat for each lens. Each stored interpretation is retrievable via `profile` on future calls.

## Step 3 — parse envelope (Mode A)

```json
{
  "ok": true,
  "cmd": "profile",
  "data": {
    "results": [
      { "lens": "disc", "text": "...", "model": "..." },
      { "lens": "leverage", "text": "...", "model": "..." }
    ]
  },
  "meta": { "factsUsed": 4, "dry": false }
}
```

## Step 4 — render

For each lens result:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ПРОФИЛЬ: {personRef} — Линза: {lens}
(Интерпретация — не факт, регенерируема)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{lens.text}

Модель: {lens.model}
```

## Invariants

- Always label profile output as "Интерпретация" — never as a fact.
- The user's recorded facts are the source of truth; the profile is derived from them.
- `--dry` mode returns the prompt only — no LLM called, no data stored.
- `ingest` stores externally-generated profiles with `model: "external"`.
