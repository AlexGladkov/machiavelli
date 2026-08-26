---
name: mach-daily
description: Machiavelli — daily digest of corporate intrigue. Who to talk to, what to prepare, what to watch. Manual command (no cron in v1).
user_invocable: true
---

# /mach-daily

Generates the daily digest from your ego perspective:
- Who should you talk to today?
- What should you prepare?
- What situations or people to watch?

This is a manual command — there is no cron or auto-scheduling in v1.

## Usage

```
/mach-daily
```

No arguments required. `$ARGUMENTS` is ignored.

## Step 1 — Shell out

```bash
node "${CLAUDE_PLUGIN_ROOT}/core/machiavelli.cjs" daily --json
```

The core builds the digest from: ego facts, active person profiles, confirmed graph edges,
and pending relations that may need attention.

## Step 2 — Parse envelope

On `ok: true`:
```json
{
  "ok": true,
  "cmd": "daily",
  "data": {
    "advice": "...",
    "text": "...",
    "prompt": "..."
  },
  "meta": {
    "guard": { "verdict": "pass" },
    "factsUsed": 5,
    "lenses": ["disc", "leverage"]
  }
}
```

On `ok: false` (guard block or LLM unavailable):
```json
{
  "ok": false,
  "error": { "code": "GUARD_BLOCK" | "GUARD_UNAVAILABLE", "message": "..." }
}
```

## Step 3 — Render digest

Present the digest in three clearly labeled sections.
Use today's date as the header. Separate facts from interpretations.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ДАЙДЖЕСТ ИНТРИГ — {today's date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{advice.text — rendered as-is from the core}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
КОНТЕКСТ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фактов в базе: {meta.factsUsed}
Линзы: {meta.lenses.join(", ")}
Guardrail: {meta.guard.verdict}
```

If the text naturally breaks into sections (talk to / prepare / watch), render them
as separate markdown headers inside the text block. Do not rewrite the advice — render it.

## Step 4 — On error

On `GUARD_BLOCK`:
```
Дайджест заблокирован guardrail: {error.message}
Переформулируй вручную через /mach-advice.
```

On `GUARD_UNAVAILABLE`:
```
LLM недоступен. Проверь MACH_LLM_KEY или MACH_LLM_URL для локальной модели.
```

On empty ontology (no people or facts yet):
```
База пуста — добавь людей (/mach-person) и факты (/mach-fact) для первого дайджеста.
```

## Invariants

- No arguments are required. Do not ask the user any questions before running.
- Do not add market WebSearch for the daily digest — it is a corporate intrigue summary only.
- Facts ≠ interpretations — label them if the core text mixes them.
- Do not log or expose raw prompt or fact bodies.
