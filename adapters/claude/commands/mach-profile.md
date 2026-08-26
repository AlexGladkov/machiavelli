---
name: mach-profile
description: Machiavelli — generate or regenerate a psychological profile of a person from recorded facts, using pluggable lenses (leverage, disc, bigfive). Interpretations are regenerable and kept separate from facts.
user_invocable: true
---

# /mach-profile

Generates a psychological profile (interpretation) of a person from their recorded facts,
via a chosen lens. Interpretations are **regenerable** and stored separately from immutable facts.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## Usage

```
/mach-profile <person_ref> [--lens leverage,disc,bigfive] [--regen]
```

Lenses:
- `leverage` — motives / fears / levers / alliances / communication style (default, most actionable)
- `disc` — colour square (red leader / yellow / green / blue analyst)
- `bigfive` — OCEAN (Openness / Conscientiousness / Extraversion / Agreeableness / Neuroticism)

## Step 1 — Parse $ARGUMENTS

- Token 1 → `<person_ref>` (code `person_7f3a` or a name fragment)
- `--lens a,b` → active lenses (default from config, usually `leverage`)
- `--regen` → force regeneration even if the cached interpretation is fresh

If `<person_ref>` missing — ask: "Чей профиль построить (код или имя)?"

## Step 2 — Consent

Profiles send facts to an external LLM. The core enforces a one-time consent gate.
If the user has not consented before, pass `--consent` after confirming with them:
> Факты об этом человеке уйдут внешнему LLM-провайдеру (псевдонимизированно). Продолжить?

## Step 3 — Shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs profile "<person_ref>" --lens <lenses> --json [--regen] [--consent]
```

Add `--dry` to compile the prompt WITHOUT calling the LLM (useful to inspect what would be sent,
or for hosts that run their own inference then save via `ingest`).

## Step 4 — Parse envelope

```json
{
  "ok": true,
  "cmd": "profile",
  "data": { "results": [ { "lens": "leverage", "interpretationId": "...", "body": "...", "cached": false } ] },
  "meta": { "llm": { "provider": "..." }, "dry": false }
}
```

`meta.llm: null` with `cached: true` means a fresh cached interpretation was returned without an LLM call.

## Step 5 — Render

For each lens result, render with a clear header separating it as an INTERPRETATION (not fact):

> **Профиль `{person_ref}` · линза {lens}** · {cached ? "кэш" : "сгенерировано"}
> ⓘ интерпретация на основе фактов — регенерируема (`--regen`), факты не тронуты
>
> {body}

## Invariants

- This is an INTERPRETATION, never present it as fact. Always label it and note it is regenerable.
- If the person has no facts → `NO_FACTS` error: tell the user to add facts via `/mach-fact` first.
- Do NOT paraphrase the model output into "truth"; keep the fact/interpretation boundary explicit.
