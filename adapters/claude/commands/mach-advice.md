---
name: mach-advice
description: Machiavelli — get a strategic advice from your ego perspective. Draws on facts, profiles, and the corporate graph. Passes through an ethical guard. Optionally enriches with market/salary data via host WebSearch.
user_invocable: true
---

# /mach-advice

Gets strategic advice from the ego perspective. The core:
1. Gathers ego context (facts, active interpretations, relevant graph edges).
2. Builds a prompt with the ethical invariant.
3. Calls the LLM via the provider abstraction.
4. Runs the advice through the guard pass (block | rewrite | pass).
5. Returns only the clean advice (blocked content is never shown).

The adapter renders the result with clear visual separation of facts vs. interpretations,
and optionally enriches market/salary queries with a host WebSearch before the core call.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## Usage

```
/mach-advice <query>
```

Examples:
- `/mach-advice как попросить повышения у директора по продукту не получив отказ`
- `/mach-advice стоит ли вступать в конфликт с Артёмом публично или лучше приватно`
- `/mach-advice какая рыночная зарплата у senior PM в Москве`

## Step 1 — Parse $ARGUMENTS

`$ARGUMENTS` = the full query string.

If empty — ask: "Что именно тебя интересует? Задай вопрос или опиши ситуацию."

## Step 2 — Detect market/salary intent (optional WebSearch)

If the query contains keywords like: `рыночная зарплата`, `рынок труда`, `повышение зарплаты`,
`рыночная ставка`, `salary`, `market rate`, `compensation benchmark` — this is a market query.

In that case, BEFORE calling the core:
1. Run a host WebSearch for: `"{relevant role} зарплата Москва 2025 site:habr.com OR hh.ru OR levels.fyi"`
2. Summarize the results into 2-3 sentences of market context.
3. Prepend that context to the query as: `[Рыночный контекст: {summary}] {original_query}`

This market context goes into the query string passed to the core. The core itself does NOT
do internet searches — it only provides the corporate context and profile.

## Step 3 — Shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs advice "<query>" --json
```

Add `--consent` if the user has previously agreed to send facts to the external LLM
(check if they confirmed during `/mach-init` or in this session).

## Step 4 — Parse envelope

On `ok: true`:
```json
{
  "ok": true,
  "cmd": "advice",
  "data": {
    "advice": "...",
    "text": "...",
    "prompt": "..."
  },
  "meta": {
    "guard": { "verdict": "pass" },
    "factsUsed": 3,
    "lenses": ["disc", "leverage"]
  }
}
```

On guard block (`ok: false`):
```json
{
  "ok": false,
  "error": { "code": "GUARD_BLOCK", "message": "..." }
}
```

On `GUARD_UNAVAILABLE` (LLM not configured):
```json
{
  "ok": false,
  "error": { "code": "GUARD_UNAVAILABLE", "message": "..." }
}
```

## Step 5 — Render result

Render the advice in five visual sections with clear separators.
Visually distinguish facts (from user input) from interpretations (from LLM):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
СОВЕТ МАКИАВЕЛЛИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{advice.text — main advice body, rendered as-is}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ОСНОВАНО НА
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фактов использовано: {meta.factsUsed}
Линзы профиля: {meta.lenses.join(", ")}
Guardrail: {meta.guard.verdict}
```

If market context was added in Step 2, show it as a labeled note:
```
[Рыночный контекст из WebSearch добавлен к запросу]
```

Visual rule for facts vs. interpretations:
- Facts (from user) are immutable — show them in plain text or as bullet points.
- Interpretations (LLM-generated) — label clearly as "Интерпретация:" or "Профиль:".
- Never mix them without labeling.

## Step 6 — Guard block rendering

On `GUARD_BLOCK`:
```
Запрос заблокирован guardrail.

Причина: {error.message}

Маршрут advice заблокирован, потому что запрос пересекает этическую черту
(прямой вред, ложь, подстава или физическая угроза). Переформулируй запрос
или задай другой вопрос.
```

On `GUARD_UNAVAILABLE`:
```
LLM недоступен: {error.message}

Проверь ENV: MACH_LLM_KEY должен быть задан. Локальная модель:
MACH_LLM_URL=http://localhost:11434/v1 MACH_LLM_MODEL=<model>
```

## Invariants

- Never show the raw prompt to the user (it contains internal context). `data.prompt` is for
  debugging only — show it only if the user explicitly asks.
- Never surface blocked advice content. The guard verdict is final.
- Facts ≠ interpretations — always labeled separately in the render.
- Do not add market context for non-market queries (no unnecessary WebSearch calls).
- Do not log key values or raw fact bodies outside the render step.
