# mach-fact — OpenCode command

Records an immutable fact about a person. Append-only — facts cannot be edited or deleted.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## When to invoke

User: "запиши факт", "добавь наблюдение о {name}", "зафиксируй что ...", or equivalent.

## Step 1 — collect arguments

Required:
- `<personRef>` — person code (`person_xxxx`) or name.
- `"<fact text>"` — a concrete observation (not an interpretation).

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
  "data": { "created": true, "factId": "...", "subject": "person_xxxx" }
}
```

On duplicate:
```json
{
  "ok": true,
  "cmd": "fact",
  "data": { "created": false, "duplicateOf": "..." }
}
```

## Step 4 — render

On `created: true`:
> Факт записан для `{subject}`. ID: `{factId}`.

On `created: false`:
> Этот факт уже записан (дубликат: `{duplicateOf}`).

On `PERSON_NOT_FOUND`:
> Человек `{personRef}` не найден. Проверь код через `status --json`.

## Invariants

- Facts are IMMUTABLE once written. If the user wants to correct one, add a new corrective fact.
- No LLM call is made.
