---
name: mach-init
description: Machiavelli — initialize your ego-center (yourself) in the corporate ontology. Run once; idempotent. Sets your name, title, and the ego node from which all advice is given.
user_invocable: true
---

# /mach-init

Initializes the Machiavelli ego-center. This is idempotent — running it again when
already initialized returns the existing ego node without error.

## Step 1 — Parse $ARGUMENTS

`$ARGUMENTS` format (all optional): `--ego-name "Name" --company "Company" --role "Title"`

If `$ARGUMENTS` contains `--ego-name` — extract it directly.  
If `$ARGUMENTS` is empty or missing required values — ask the user:

- "Как тебя зовут (ego-центр)?" (required, default: Me)
- "Твоя должность / роль?" (optional)

Do NOT ask for a company — the core does not store it as an ego property in v1.

## Step 2 — Shell out

```bash
node "${CLAUDE_PLUGIN_ROOT}/core/machiavelli.cjs" init "<name>" --json
```

If a title was provided, the core accepts it via the TTY interview only. In `--json` mode,
pass only the ego name as a positional. The title can be added as a fact afterward.

## Step 3 — Parse envelope

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

## Step 4 — Render result

On `ok: true` and `alreadyInitialized: false`:
> Ego-центр создан. Добро пожаловать, **{name}**!
> ID: `{code}`. Теперь можно добавлять людей (`/mach-person`) и факты (`/mach-fact`).

On `ok: true` and `alreadyInitialized: true`:
> Ego-центр уже инициализирован (`{code}`). Всё готово к работе.

On `ok: false`:
> Ошибка `{error.code}`: {error.message}

## Invariants

- Never log or print the encryption key or keyring values.
- If exit code is 3 (ENV error) — tell the user to check Node >= 22.5 and SQLite availability.
- This command does not push or expose any data remotely.
