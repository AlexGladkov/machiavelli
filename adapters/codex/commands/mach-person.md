# mach-person — Codex command

Adds a person to the corporate ontology. Creates a stable code (e.g. `person_3b2c`)
that is used as a reference in all subsequent commands.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user says: "добавь человека", "добавь коллегу", "запиши {name}", or equivalent.

## Step 1 — collect arguments

The description should include name and relevant context (role, reporting line, relationship).
If not provided, ask: "Имя человека и его роль / контекст?"

## Step 2 — shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs person "<name and description>" --json
```

## Step 3 — parse envelope

```json
{
  "ok": true,
  "cmd": "person",
  "data": {
    "id": "...",
    "code": "person_xxxx",
    "name": "...",
    "relation": null
  }
}
```

## Step 4 — render

On `ok: true`:
> Добавлен: **{name}** — код `{code}`.
> Добавляй факты: `mach-fact {code} "<факт>"`

On `ok: false`:
> Ошибка `{error.code}`: {error.message}

## Invariants

- The code (`person_xxxx`) is the stable reference — always show it to the user.
- This command does not call any LLM.
- Relations can be added via `fact` or via `relation confirm` after a pending suggestion.
