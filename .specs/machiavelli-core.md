# Spec: Machiavelli — портируемое ядро корпоративной онтологии + советник интриг

**Дата:** 2026-08-26
**Статус:** v1 — вертикальный срез `fact → advice`
**Slug:** machiavelli-core

---

## 1. Замысел

Система (CLI-ядро + тонкие адаптеры под LLM-хосты) для моделирования корпоративной
среды по принципу **Онтологии Palantir**. Три примитива:

- **Объекты** — люди, места, документы, события (+ свойства)
- **Связи** — как объекты связаны (граф)
- **Действия** — операции, меняющие объекты

Каждый человек имеет **досье** (как файл в спецслужбе): человекоцентричная база
знаний, где в основе — сам сотрудник. На основе **фактов** строится **интерпретация**
(психопрофиль). Цель — эффективная работа внутри корпорации через тонкое искусство
интриг (отсюда имя — Макиавелли).

## 2. Инварианты (STRICT — нарушать нельзя)

1. **Этика.** Агенты НЕ дают вредительских советов, советов на прямую ложь, подставу
   или прямой вред кому угодно. Только тонкая интрига. Гарантируется двухслойно
   (см. §7 Guardrail).
2. **Факты ≠ интерпретации.** Факты сообщает пользователь — они **immutable**,
   append-only, с источником и датой. Интерпретации хранятся **отдельно** и
   **регенерируемы** (можно перегенерировать другой моделью/линзой).
3. **Портируемость.** Платформа не привязана к Claude. Работает с Codex, OpenCode,
   Claude, Z.AI и др. Достигается через CLI-ядро + провайдер-абстракцию LLM.

## 3. Решения интервью (зафиксировано)

| Тема | Решение |
|------|---------|
| Архитектура | **CLI-ядро (Node.js) + тонкие адаптеры** (skills/commands/prompts под каждый хост). Как t-invest. |
| Хранилище | **SQLite** (embedded, один файл). |
| Рантайм ядра | **Node.js CLI** (node ≥ 20, `.cjs`, без компиляции). |
| Объём v1 | **Вертикальный срез**: `person + facts + profile(lenses) + advice`. |
| Кто генерит | **Ядро зовёт LLM API само** (провайдер-абстракция, ENV `MACH_LLM_KEY`/`MACH_LLM_URL`/`MACH_LLM_MODEL`). |
| Психопрофиль | **Плагинуемые линзы** (DISC / BigFive / leverage), вкл/выкл, регенерируемы независимо. |
| Граф | **Явные факты юзера + авто-подсказки LLM** (подсказки = pending-интерпретации, пока юзер не подтвердит → факт). |
| Безопасность | **Шифрование at-rest + режим псевдонимов** (реальные имена в отдельной шифрованной map). |
| Guardrail | **Систем-правило + отдельный validator-pass** (block \| rewrite \| pass). |
| Идентичность | **Один владелец (ego-центр)** — `/init` задаёт узел «Я», всё относительно меня. |
| Упаковка (Claude) | **5 команд** (`/init /fact /person /advice /daily`) **+ субагент** `machiavelli-advisor`. |
| /daily | **Ручная команда** (без cron в v1). |
| Рыночный research | **Опционально, через хост** (WebSearch адаптера), когда релевантно. Ядро даёт только контекст компании. |

## 4. Архитектура

```
Machiavelli/
├── core/                       # переносимое ядро (Node.js, .cjs)
│   ├── machiavelli.cjs         # CLI entrypoint (арг-парсер, роутинг команд)
│   ├── store/                  # слой данных
│   │   ├── db.cjs              # SQLite open/migrate, шифрование, pseudonym-map
│   │   ├── objects.cjs         # objects (people/places/docs/events) + properties
│   │   ├── relations.cjs       # граф-рёбра (fact|interp, confirmed|pending)
│   │   ├── facts.cjs           # append-only факты (immutable, source, ts)
│   │   └── interpretations.cjs # регенерируемые интерпретации (по линзам)
│   ├── engine/                 # логика
│   │   ├── llm.cjs             # провайдер-абстракция (anthropic | openai-compat)
│   │   ├── profile.cjs         # генерация профиля по линзам из фактов
│   │   ├── advice.cjs          # сбор контекста ego → промпт → совет
│   │   └── guard.cjs           # validator-pass (block|rewrite|pass) + audit
│   ├── lenses/                 # плагинуемые психо-линзы (промпт-шаблоны)
│   │   ├── disc.md             # цветовой квадрат (красный-лидер...)
│   │   ├── bigfive.md          # OCEAN
│   │   └── leverage.md         # мотивы / страхи / рычаги / альянсы / стиль
│   ├── prompts/                # системные шаблоны (несут этический инвариант)
│   │   ├── system.md           # базовый систем-промпт + инвариант
│   │   ├── advice.md
│   │   └── guard.md            # шаблон guard-pass
│   └── package.json            # deps: better-sqlite3 (+ crypto из stdlib)
│
├── adapters/                   # тонкие обёртки под хосты
│   ├── claude/
│   │   ├── commands/           # /init /fact /person /advice /daily → shell CLI
│   │   └── agents/machiavelli-advisor.md
│   ├── codex/                  # Codex adapter (системный промпт + per-command файлы)
│   │   ├── machiavelli.md      # системный промпт-инструктаж для Codex
│   │   └── commands/           # mach-{init,person,fact,advice,daily,profile}.md
│   ├── opencode/               # OpenCode adapter (аналогично Codex)
│   │   ├── machiavelli.md
│   │   └── commands/
│   └── templates/              # общие шаблоны
│       ├── host-brief.md.tmpl  # envelope-контракт, guard, факты≠интерпретации, --dry→ingest
│       └── command.md.tmpl     # образец command-файла
│
├── data/                       # .gitignore — досье, БД, ключи (НЕ в git)
│   ├── machiavelli.db          # SQLite (шифрована)
│   └── names.map.enc           # pseudonym → реальное имя (шифрована)
│
├── .specs/machiavelli-core.md  # этот файл
└── README.md
```

### 4.1 Провайдер-абстракция LLM (`engine/llm.cjs`)

Единый интерфейс `complete({system, messages, model})`. Два бэкенда, выбор по ENV:

- **anthropic** — `MACH_LLM_URL` пуст/anthropic → Anthropic Messages API.
- **openai-compat** — `MACH_LLM_URL` задан → OpenAI-совместимый `/chat/completions`
  (покрывает OpenAI, **Z.AI**, локальные, OpenRouter и т.п.).

ENV: `MACH_LLM_KEY` (ключ), `MACH_LLM_URL` (base URL, опц.), `MACH_LLM_MODEL`
(модель, дефолт настраиваемый). Регенерация интерпретаций = повторный `complete`
с теми же фактами и другим `model`/линзой.

## 5. Модель данных (SQLite)

```sql
-- Объекты онтологии
objects(id PK, kind TEXT[person|place|document|event], name_enc BLOB, props_json_enc BLOB,
        is_ego INTEGER DEFAULT 0, created_ts, updated_ts)

-- Факты: immutable, append-only. Источник правды.
facts(id PK, subject_id FK objects, body_enc BLOB, source TEXT, confidence TEXT,
      created_ts, UNIQUE(id))                 -- НЕТ UPDATE/DELETE в норме (только tombstone-флаг)

-- Интерпретации: регенерируемы, привязаны к линзе + версии.
interpretations(id PK, subject_id FK objects, lens TEXT, body_enc BLOB,
                model TEXT, based_on_fact_ids_json, created_ts, is_current INTEGER)

-- Граф связей. type=fact (от юзера) | interp (подсказано LLM, pending до подтверждения)
relations(id PK, from_id FK, to_id FK, rel TEXT[reports_to|ally|rival|mentor|influence|...],
          origin TEXT[fact|interp], status TEXT[confirmed|pending], created_ts)

-- Действия (журнал операций над объектами) — Palantir-примитив «Действия»
actions(id PK, verb TEXT, target_id FK, payload_json_enc BLOB, ts)

-- Аудит guardrail
guard_audit(id PK, command TEXT, verdict TEXT[block|rewrite|pass], reason TEXT, ts)
```

**Шифрование:** чувствительные поля (`*_enc`) — AES-256-GCM, ключ из OS keychain
(`security`/`libsecret`) или ENV `MACH_KEY`. `names.map.enc` хранит соответствие
псевдоним↔реальное имя отдельно. В `objects.name_enc` при режиме псевдонимов —
только код (`person_7f3a`). `.gitignore`: `data/`, `*.db`, `*.enc`, `*.map`.

## 6. Команды v1 (CLI-контракт)

```
node core/machiavelli.cjs init                       # интервью-стартер: задать ego + базу оргструктуры
node core/machiavelli.cjs person "<описание>"         # создать человека + мини-интервью связей
node core/machiavelli.cjs fact <person> "<факт>"      # добавить факт (immutable)
node core/machiavelli.cjs profile <person> [--lens disc,leverage]  # (пере)генерировать профиль
node core/machiavelli.cjs advice "<запрос>"           # совет из ego-перспективы (+guard-pass)
node core/machiavelli.cjs daily                       # дайджест интриг на день (ручной)
node core/machiavelli.cjs graph [--person X]          # показать рёбра (confirmed/pending)
node core/machiavelli.cjs relation confirm <edge_id>  # подтвердить pending-подсказку → факт
```

Все команды — `--json` для машинного вывода (адаптеры парсят). Выход детерминирован,
кроме шагов, где явно зовётся LLM (`profile`, `advice`, `daily`).

### Поток `/advice` (ключевой срез v1)
1. CLI собирает ego-контекст: факты + текущие интерпретации релевантных людей + граф.
2. `engine/advice.cjs` строит промпт (`prompts/advice.md` + `prompts/system.md` с инвариантом).
3. `engine/llm.cjs` → LLM → черновой совет.
4. `engine/guard.cjs` — **validator-pass** (`prompts/guard.md`): «есть вред/ложь/подстава?»
   → `block` (отказ + причина) | `rewrite` (очистить и вернуть) | `pass`.
   Вердикт пишется в `guard_audit`.
5. Возврат только чистого совета. Опц. рыночный research — флаг для адаптера (host WebSearch).

## 7. Guardrail (двухслойный)

- **Слой 1 (генерация):** `prompts/system.md` несёт этический инвариант в каждом вызове.
- **Слой 2 (validator-pass):** независимый LLM-проход по сгенерированному тексту:
  проверка на прямой вред / ложь / подставу / физ. угрозу. Вердикт `block|rewrite|pass`.
  Заблокированное — не выдаётся, причина логируется в `guard_audit`.
- Инвариант остаётся при регенерации и при любом провайдере.

## 8. Психо-линзы (плагины)

Линза = markdown-шаблон в `core/lenses/*.md`: описание методики + инструкция «на основе
ТОЛЬКО этих фактов дай профиль по данной модели». v1 поставляет `disc`, `bigfive`,
`leverage`. Юзер выбирает активные (`profile <p> --lens disc,leverage`). Каждая линза
регенерируется независимо, версионируется (`interpretations.lens` + `is_current`).
Добавление новой линзы = новый файл, без изменения кода.

## 9. Идентичность (ego-центр)

`init` создаёт объект с `is_ego=1`. Весь граф, советы и /daily — из моей перспективы
(«тебе стоит…»). Одна точка зрения в v1 (мульти-перспектива — потенциальный v2).

## 10. Адаптеры хостов (v1 — реализованы)

### 10.1 Claude Code

- `adapters/claude/commands/{init,fact,person,advice,daily}.md` — тонкие обёртки:
  собирают `$ARGUMENTS`, шелл-аут `node core/machiavelli.cjs <cmd> ...`, показывают итог.
- `adapters/claude/agents/machiavelli-advisor.md` — субагент для глубоких разборов:
  держит персону/тон, вызывает CLI, опц. делает host WebSearch для рыночного research.
- Установка: `bash install.sh` или `bash install.sh --host claude`.
  Рендерит `{{CORE_PATH}}`, копирует в `~/.claude/commands/` и `~/.claude/agents/`.

### 10.2 Codex

- `adapters/codex/machiavelli.md` — единый системный промпт-инструктаж.
- `adapters/codex/commands/{mach-init,mach-person,mach-fact,mach-advice,mach-daily,mach-profile}.md`
  — по команде, с `{{CORE_PATH}}` плейсхолдером.
- Инструкции: как шелл-аутить `node {{CORE_PATH}}/core/machiavelli.cjs <cmd> --json`,
  парсить envelope, обрабатывать guard-вердикты, разделять факты/интерпретации.
- Для хоста БЕЗ `MACH_LLM_KEY` — паттерн `--dry` → своя инференция Codex → `ingest`.
- Установка: `bash install.sh --host codex`.
  Рендерит `{{CORE_PATH}}`, копирует в `~/.config/machiavelli/adapters/codex/`.
  Выводит инструкцию по подключению к Codex.

### 10.3 OpenCode

- `adapters/opencode/machiavelli.md` — единый системный промпт-инструктаж.
- `adapters/opencode/commands/{mach-init,mach-person,mach-fact,mach-advice,mach-daily,mach-profile}.md`
  — аналогично Codex.
- Паттерн `--dry` → своя инференция OpenCode → `ingest`.
- Установка: `bash install.sh --host opencode`.
  Рендерит `{{CORE_PATH}}`, копирует в `~/.config/machiavelli/adapters/opencode/`.

### 10.4 Общий шаблонный слой

- `adapters/templates/host-brief.md.tmpl` — общий инструктаж (envelope-контракт,
  guard-вердикты, факты≠интерпретации, приватность, паттерн --dry→ingest).
  Codex/OpenCode-адаптеры несут его смысл без дублирования.
- `adapters/templates/command.md.tmpl` — образец тонкого command-файла.

### 10.5 install.sh --host

```bash
bash install.sh [--host claude|codex|opencode|all]
```

- `--host claude` — как раньше (обратная совместимость, дефолт).
- `--host codex` / `--host opencode` — рендер адаптеров + инструкция по подключению.
- `--host all` — все три.
- Идемпотентность, проверка конфликтов, не перезаписывает чужие файлы молча.

## 11. Границы v1 (что НЕ входит)

- Cron/расписание для /daily (только ручной запуск).
- Мульти-перспектива (только ego).
- Места/документы как полноценные типы (схема есть, UX-команды — позже; v1 фокус на person).
- Веб-UI / визуализация графа (только CLI `graph`-вывод текстом).

## 12. Точки интеграции / прецеденты в окружении

- **t-invest** (`~/.claude/skills/t-invest/`) — эталон портируемого паттерна:
  bundled Node CLI (`scripts/tinvest.cjs`) + тонкий SKILL.md + `references/`.
  Повторяем структуру: `session status --json`-подобные машинные ответы, проверка
  Node ≥ 20 при первом запуске, установка deps только по явному согласию.
- Greenfield: git не инициализирован, ast-index отсутствует — чистый старт.

## 13. Риски и решения

| Риск | Решение |
|------|---------|
| Утечка досье (PII) | Шифрование at-rest + псевдонимы + `.gitignore` на `data/`. |
| Модель даёт токсичный/вредный совет | Двухслойный guardrail + audit-лог. |
| Галлюцинации в графе | LLM-рёбра = `pending`, становятся фактом только после `relation confirm`. |
| Vendor lock-in LLM | Провайдер-абстракция (anthropic + openai-compat base URL). |
| Смешение фактов и мнений | Раздельные таблицы `facts` (immutable) / `interpretations` (regen). |
| Node/deps не установлены | Проверка при старте, установка `better-sqlite3` только по согласию. |
