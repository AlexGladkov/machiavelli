# mach-advice — Codex command

Gets strategic advice from the ego perspective. The core assembles ego context (facts,
graph, active profiles) into a prompt, runs the LLM, then validates the output through
the ethical guardrail.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user asks: "дай совет", "как мне поступить", "advice", "помоги с ситуацией", or equivalent.

## Step 1 — collect the query

If the user's message contains the query — use it directly.
If empty — ask: "Что именно тебя интересует? Задай вопрос или опиши ситуацию."

## Step 2 — choose execution mode

**Mode A — core has LLM key (`MACH_LLM_KEY` is set in env)**

Shell out directly:

```bash
node {{CORE_PATH}}/core/machiavelli.cjs advice "<query>" --json --consent
```

**Mode B — no `MACH_LLM_KEY` (Codex portability pattern)**

Step B1 — get compiled prompt:
```bash
node {{CORE_PATH}}/core/machiavelli.cjs advice "<query>" --dry --json
```

Extract `data.prompt`. This is the full system+user prompt assembled by the core.

Step B2 — run Codex inference on `data.prompt`. Receive generated text.

Step B3 — present the raw Codex output to the user using the render format below.
(Advice is ephemeral — it cannot be ingested back. Only profile interpretations are stored.)

## Step 3 — parse envelope (Mode A only)

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

On guard block:
```json
{
  "ok": false,
  "error": { "code": "GUARD_BLOCK", "message": "..." }
}
```

## Step 4 — render

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
СОВЕТ МАКИАВЕЛЛИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{data.text — render as-is}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ОСНОВАНО НА
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фактов: {meta.factsUsed} | Линзы: {meta.lenses} | Guard: {meta.guard.verdict}
```

On `GUARD_BLOCK`:
```
Запрос заблокирован guardrail.
Причина: {error.message}

Запрос пересекает этическую черту. Переформулируй вопрос в сторону
легитимного влияния (не прямой вред, ложь или подстава).
```

On `GUARD_UNAVAILABLE`:
```
LLM недоступен: {error.message}
Задай MACH_LLM_KEY или используй Mode B (--dry → Codex inference).
```

## Invariants

- Never show `data.prompt` to the user unless they explicitly ask for it.
- Never surface blocked content — the guard verdict is final.
- Facts ≠ interpretations — label them separately when rendering context.
- If using Mode B, label the advice section clearly as: "(Сгенерировано Codex)".
