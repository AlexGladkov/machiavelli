# mach-init — OpenCode command

Initializes the Machiavelli ego-center. Idempotent — safe to run again.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "инициализируй Machiavelli", "задай ego", "настрой базу", or equivalent.

## Step 1 — collect arguments

Ask (if not already provided):
- "Как тебя зовут (ego-центр)?" — required, default: Me

## Step 2 — shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs init "<name>" --json
```

## Step 3 — parse envelope

```json
{
  "ok": true,
  "cmd": "init",
  "data": { "egoId": "...", "code": "ego_xxxx", "alreadyInitialized": false, "name": "..." }
}
```

## Step 4 — render

On `ok: true`, `alreadyInitialized: false`:
> Ego-центр создан. Добро пожаловать, **{name}**! Код: `{code}`.

On `ok: true`, `alreadyInitialized: true`:
> Ego-центр уже инициализирован (`{code}`). Всё готово.

On `ok: false`:
> Ошибка `{error.code}`: {error.message}

## Invariants

- Never log or print the encryption key or keyring values.
- No LLM call is made.
