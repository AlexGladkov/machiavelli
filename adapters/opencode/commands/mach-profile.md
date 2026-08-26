# mach-profile — OpenCode command

Generates or regenerates a psycho-profile for a person using pluggable lenses.
Interpretations are stored in the database and are labeled separately from facts.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "построй профиль", "проанализируй {name}", "покажи профиль", or equivalent.

## Step 1 — collect arguments

- `<personRef>` — person code or name. Required.
- `--lens` — comma-separated: `disc`, `bigfive`, `leverage`. Default: all active.
- `--regen` — force regeneration.

## Step 2 — choose execution mode

**Mode A — `MACH_LLM_KEY` is set**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs profile <personRef> --json --consent [--lens disc,leverage] [--regen]
```

**Mode B — no `MACH_LLM_KEY` (OpenCode portability pattern)**

For each lens:

Step B1 — get compiled prompt:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs profile <personRef> --dry --lens <lens> --json
```

Step B2 — run OpenCode inference on `data.prompt`.

Step B3 — store result:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs ingest profile <personRef> \
  --lens <lens> --body "<generated-text>" --json
```

## Step 3 — render

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
- `--dry` returns the prompt only — no LLM called, no data stored.
- `ingest` stores externally-generated profiles with `model: "external"`.
