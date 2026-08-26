# mach-init — Codex command

Initializes the Machiavelli ego-center. Idempotent — safe to run again if already initialized.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user says: "инициализируй Machiavelli", "задай ego", "настрой Machiavelli", or equivalent.

## Step 1 — collect arguments

Ask the user (if not already provided):
- "Как тебя зовут (ego-центр)?" — required, default: Me
- "Твоя должность / роль?" — optional; if provided, add as a fact after init

## Step 2 — shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs init "<name>" --json
```

## Step 3 — parse envelope

```json
{
  "ok": true,
  "cmd": "init",
  "data": {
    "egoId": "...",
    "code": "ego_xxxx",
    "alreadyInitialized": false,
    "name": "...",
    "title": null
  }
}
```

## Step 4 — render

On `ok: true` and `alreadyInitialized: false`:
> Ego-центр создан. Добро пожаловать, **{name}**!
> ID: `{code}`. Добавляй людей (`mach-person`) и факты (`mach-fact`).

On `ok: true` and `alreadyInitialized: true`:
> Ego-центр уже инициализирован (`{code}`). Всё готово к работе.

On `ok: false`:
> Ошибка `{error.code}`: {error.message}
> Если код 3: проверь Node >= 20 и доступность SQLite.

## Invariants

- Never log or print the encryption key.
- If the user provided a title, add it as a fact after init:
  `node {{CORE_PATH}}/core/machiavelli.cjs fact <code> "<title>" --json`
- This command does not call any LLM.
