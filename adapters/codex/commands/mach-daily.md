# mach-daily — Codex command

Generates the daily strategic digest: who to talk to today, what dynamics to watch,
what actions to consider. Runs from the ego perspective across the full graph.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user says: "дай дайджест", "daily", "что делать сегодня", "обзор на день", or equivalent.

## Step 1 — choose execution mode

**Mode A — core has LLM key (`MACH_LLM_KEY` is set)**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs daily --json --consent
```

**Mode B — no `MACH_LLM_KEY` (Codex portability pattern)**

Step B1 — get compiled prompt:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs daily --dry --json
```

Step B2 — run Codex inference on `data.prompt`.

Step B3 — present raw Codex output using the render format below.

## Step 2 — parse envelope (Mode A)

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
    "lenses": ["disc"]
  }
}
```

## Step 3 — render

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ДАЙДЖЕСТ НА СЕГОДНЯ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{data.text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ДАННЫЕ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фактов: {meta.factsUsed} | Линзы: {meta.lenses} | Guard: {meta.guard.verdict}
```

## Invariants

- Same guard rules as `mach-advice`: block = never show, rewrite = show cleaned version.
- If Mode B, label digest as "(Сгенерировано Codex)".
- This is a manual command — no scheduling or cron is triggered.
