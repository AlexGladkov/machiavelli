# mach-person — OpenCode command

Adds a person to the corporate ontology with a stable code reference.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "добавь человека", "запиши {name}", "добавь коллегу", or equivalent.

## Step 1 — collect arguments

Ask if not provided: "Имя человека и его роль / контекст?"

## Step 2 — shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs person "<name and description>" --json
```

## Step 3 — parse envelope

```json
{
  "ok": true,
  "cmd": "person",
  "data": { "id": "...", "code": "person_xxxx", "name": "...", "relation": null }
}
```

## Step 4 — render

On `ok: true`:
> Добавлен: **{name}** — код `{code}`.
> Добавляй факты: `mach-fact {code} "<факт>"`

On `ok: false`:
> Ошибка `{error.code}`: {error.message}

## Invariants

- Always show the code (`person_xxxx`) — it is the stable reference for future commands.
- No LLM call is made.
