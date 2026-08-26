---
name: mach-person
description: Machiavelli — add a new person to the corporate ontology, run a mini-interview for relations, and review LLM-suggested pending connections.
user_invocable: true
---

# /mach-person

Adds a person to the ontology and runs a mini-interview to capture immediate relations.
After creation, displays any LLM-suggested `pending` relations for the user to confirm or ignore.

## Core path

```
{{CORE_PATH}}/core/machiavelli.cjs
```

## Usage

```
/mach-person <name or description>
```

Examples:
- `/mach-person Директор по продукту, формально мой руководитель`
- `/mach-person Артём Волков, коллега из backend-команды`

## Step 1 — Parse $ARGUMENTS

`$ARGUMENTS` = name or description of the person.

If empty — ask: "Имя и/или описание человека?"

## Step 2 — Shell out (create person)

```bash
node {{CORE_PATH}}/core/machiavelli.cjs person "<description>" --json
```

The core returns the assigned code (e.g. `person_3b2c`) — this is the stable ref to use
in future `/mach-fact` commands.

## Step 3 — Parse envelope

```json
{
  "ok": true,
  "cmd": "person",
  "data": {
    "id": "...",
    "code": "person_xxxx",
    "name": "...",
    "relation": { "id": "rel_xxx", "rel": "reports_to" }
  }
}
```

`relation` may be `null` if no relation was captured.

## Step 4 — Mini-interview (relations)

After creation, ask the user ONE question:

> Какая у тебя связь с **{name}**? (например: `reports_to`, `ally`, `rival`, `mentor`, `влияние` — или пропусти)

If the user provides a relation — shell out again to create it:

```bash
node {{CORE_PATH}}/core/machiavelli.cjs relation confirm <edge_id> --json
```

Wait — in `--json` mode the core does NOT run an interactive interview.
The relation from Step 3 is already captured if the core returned it.
If `relation` is null and the user provides one now, add it as a fact instead:

```bash
node {{CORE_PATH}}/core/machiavelli.cjs fact "<person_code>" "связь с ego: <relation>" --json
```

## Step 5 — Render result

```
Человек добавлен: **{name}** (`{code}`)
Связь: {relation.rel if present, else "не указана"}

Используй этот код для фактов:
  /mach-fact {code} <текст факта>
```

Then show a CTA for pending relations (if the graph returns any for this person after creation):

```
Хочешь посмотреть граф связей и подтвердить подсказки LLM?
→ node {{CORE_PATH}}/core/machiavelli.cjs graph --json
→ node {{CORE_PATH}}/core/machiavelli.cjs relation confirm <edge_id> --json
```

## Step 6 — On error

`ok: false` / `ARGS_MISSING`: ask user for description.
Other errors: show `{error.code}: {error.message}`.

## Invariants

- The code returned by the core is the stable identifier — always show it to the user.
- Pending relations from LLM are NOT facts until confirmed via `relation confirm`.
- Do NOT rewrite or paraphrase the user's description of the person.
