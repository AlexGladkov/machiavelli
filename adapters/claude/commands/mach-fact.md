---
name: mach-fact
description: Machiavelli — record an immutable fact about a person. Facts are append-only and are the ground truth from which profiles and advice are generated.
user_invocable: true
---

# /mach-fact

Records an immutable fact about a person in the corporate ontology.
Facts are append-only: they cannot be edited or deleted (only tombstoned).
They are the user-provided ground truth — interpretations are derived from them separately.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## Usage

```
/mach-fact <person_ref> <fact text>
```

Examples:
- `/mach-fact person_7f3a отстаивает свои решения даже под давлением руководства`
- `/mach-fact boss склонен к резким разворотам позиции перед дедлайнами`

## Step 1 — Parse $ARGUMENTS

`$ARGUMENTS` = everything the user typed after `/mach-fact`.

Split on first whitespace token:
- Token 1 → `<person_ref>` (code like `person_7f3a` or a name fragment)
- Remainder → `<fact body>`

If either part is missing — ask the user:
- "Введи ссылку на человека (код или имя):"
- "Введи текст факта:"

## Step 2 — Shell out

```bash
node {{CORE_PATH}}/core/machiavelli.cjs fact "<person_ref>" "<fact body>" --json
```

## Step 3 — Parse envelope

Success (new fact):
```json
{
  "ok": true,
  "cmd": "fact",
  "data": {
    "created": true,
    "factId": "fact_xxxx",
    "subject": "person_xxxx"
  }
}
```

Duplicate (exact body already exists for this person):
```json
{
  "ok": true,
  "cmd": "fact",
  "data": {
    "created": false,
    "duplicateOf": "fact_xxxx"
  }
}
```

Error:
```json
{
  "ok": false,
  "error": { "code": "PERSON_NOT_FOUND", "message": "..." }
}
```

## Step 4 — Render result

On `created: true`:
> Факт записан. ID: `{factId}` — субъект `{subject}`.

On `created: false`:
> Дубль: этот факт уже зафиксирован (`{duplicateOf}`). Ничего не добавлено.

On `ok: false` with `PERSON_NOT_FOUND`:
> Человек `{person_ref}` не найден. Проверь код через `/mach-person` или создай сначала.

On other errors:
> Ошибка `{error.code}`: {error.message}

## Invariants

- Facts are immutable — there is no edit or delete command for them. Communicate this clearly.
- Do NOT paraphrase or rewrite the user's fact body before passing it to the CLI.
- Do NOT log sensitive fact content anywhere outside the render step.
