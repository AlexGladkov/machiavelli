# mach-daily — OpenCode command

Generates the daily strategic digest. Manual invocation only — no scheduling.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "дайджест", "daily", "что делать сегодня", "обзор на день", or equivalent.

## Step 1 — choose execution mode

**Mode A — `MACH_LLM_KEY` is set**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs daily --json --consent
```

**Mode B — no `MACH_LLM_KEY` (OpenCode portability pattern)**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs daily --dry --json
```

Pass `data.prompt` to OpenCode inference. Present raw output.

## Step 2 — render

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

- Same guard rules as `mach-advice`.
- If Mode B, label digest as "(Сгенерировано OpenCode)".
- Manual-only: no cron or auto-trigger.
