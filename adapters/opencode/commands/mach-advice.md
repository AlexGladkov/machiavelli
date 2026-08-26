# mach-advice — OpenCode command

Gets strategic advice from the ego perspective. The core assembles context, runs LLM,
and validates through the ethical guardrail.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "дай совет", "как мне поступить", "advice", or equivalent.

## Step 1 — collect the query

If the user's message contains the query — use it. Otherwise ask:
"Что именно тебя интересует? Задай вопрос или опиши ситуацию."

## Step 2 — choose execution mode

**Mode A — `MACH_LLM_KEY` is set in env**

```bash
node {{CORE_PATH}}/core/machiavelli.cjs advice "<query>" --json --consent
```

**Mode B — no `MACH_LLM_KEY` (OpenCode portability pattern)**

Step B1 — get compiled prompt:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs advice "<query>" --dry --json
```

Step B2 — run OpenCode inference on `data.prompt`. Receive generated text.

Step B3 — present the raw output to the user using the render format below.
(Advice is ephemeral — cannot be stored back via `ingest`.)

## Step 3 — parse envelope (Mode A)

On `ok: true`:
```json
{
  "ok": true, "cmd": "advice",
  "data": { "advice": "...", "text": "...", "prompt": "..." },
  "meta": { "guard": { "verdict": "pass" }, "factsUsed": 3, "lenses": ["disc"] }
}
```

## Step 4 — render

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
СОВЕТ МАКИАВЕЛЛИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{data.text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ОСНОВАНО НА
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фактов: {meta.factsUsed} | Линзы: {meta.lenses} | Guard: {meta.guard.verdict}
```

On `GUARD_BLOCK`:
```
Запрос заблокирован guardrail.
Причина: {error.message}
Переформулируй запрос в сторону легитимного влияния.
```

On `GUARD_UNAVAILABLE`:
```
LLM недоступен: {error.message}
Задай MACH_LLM_KEY или используй Mode B (--dry → OpenCode inference).
```

## Invariants

- Never show `data.prompt` unless user explicitly asks.
- Never surface blocked content.
- If Mode B, label output as "(Сгенерировано OpenCode)".
