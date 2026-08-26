# mach-fact — Codex command

Records an immutable fact about a person. Facts are append-only — they cannot be edited
or deleted. They form the source of truth for all profiles and advice.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

The user says: "запиши факт", "добавь наблюдение", "зафиксируй что {name} ...", or equivalent.

## Step 1 — collect arguments

Required:
- `<personRef>` — the person's code (e.g. `person_3b2c`) or name. Use `status --json` or
  `graph --json` to list known persons if the user is unsure of the code.
- `"<fact text>"` — the fact body. A concrete observation, not an interpretation.

If either is missing, ask for them before proceeding.

## Step 2 — shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs fact <personRef> "<fact text>" --json
```

## Step 3 — parse envelope

On success:
```json
{
  "ok": true,
  "cmd": "fact",
  "data": {
    "created": true,
    "factId": "...",
    "subject": "person_xxxx"
  }
}
```

On duplicate:
```json
{
  "ok": true,
  "cmd": "fact",
  "data": {
    "created": false,
    "duplicateOf": "..."
  }
}
```

## Step 4 — render

On `created: true`:
> Факт записан для `{subject}`. ID: `{factId}`.

On `created: false`:
> Этот факт уже записан ранее (дубликат: `{duplicateOf}`). Ничего не изменилось.

On `ok: false` with `PERSON_NOT_FOUND`:
> Человек `{personRef}` не найден. Проверь код через `status --json`.

## Invariants

- Facts are IMMUTABLE once written. If the user wants to "edit" a fact, explain that facts
  are append-only by design. They can add a corrective fact instead.
- The fact body is stored encrypted. Never log or echo raw fact bodies outside this render.
- This command does not call any LLM.
