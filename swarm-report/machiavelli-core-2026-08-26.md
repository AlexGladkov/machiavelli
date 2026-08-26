# Отчёт: Machiavelli — v1 + v2-доводка (полный)

**Дата:** 2026-08-26
**Профиль:** Бизнес-фича (адаптирован под Node.js CLI-стек)
**Спека:** `.specs/machiavelli-core.md`
**Статус:** ✅ собран, доведён до конца (v2), провалидирован end-to-end

> **Апдейт (v2-доводка).** По требованию владельца отложенные пункты доделаны в этой же сессии.
> Реализовано: guard `rewrite`-ветка (block\|rewrite\|pass), bigfive-линза, мульти-перспектива
> `advice --as <person>`, ключи `key export/import` + `rekey --confirm`, `ingest` (замыкает `--dry`
> для внешних хостов), реальный `doctor`-пинг LLM, **SQLCipher whole-DB** (встал на Node 26,
> opt-in `MACH_CIPHER=sqlcipher`), адаптеры **Codex** и **OpenCode** + `install.sh --host claude|codex|opencode|all`,
> команда Claude `/mach-profile`. Смоуки: store 24 + cli 30 = **54 assertions зелёных**.
> Валидация v2 в main: bigfive ✓, `--as` (perspective=код) ✓, key export (32 байта) ✓, ingest ✓,
> rekey ✓, `driver=sqlcipher` ✓. Больше отложенных пунктов **нет** (кроме cron /daily — вне запроса).

---

## Что построено

Портируемое CLI-ядро (Node.js `.cjs`, `node:sqlite`) корпоративной онтологии + советник интриг,
с тонкими адаптерами под LLM-хосты. Работает по принципу Онтологии Palantir (Объекты / Связи /
Действия), человекоцентричная база с досье, факты отделены от интерпретаций.

### Стадии (Research → Plan → Executing → Validation → Report)
- **Research:** консилиум из 6 агентов (архитектура CLI, Node-реализация, security, API-контракт,
  UX-голос, devops/портируемость). 2 Critical security-находки (C1 PII→LLM, C2 обход гардрейла).
- **Plan:** синтез + разрешение конфликтов (field-level GCM vs SQLCipher; node:sqlite vs
  better-sqlite3; примирение «ядро зовёт LLM» с псевдонимизацией+consent).
- **Executing:** 3 батча — Store-слой (10 файлов) → Engine+CLI (14 файлов) → адаптеры+install+доки.
- **Validation:** юнит-смоуки + реальный сквозной прогон. **2 бага найдены и починены.**

---

## Архитектура (итог)

```
core/
  machiavelli.cjs         тонкий entrypoint (checkNode → detectDriver → lazy openDb → роутинг)
  store/  crypto keyring db objects facts interpretations relations names_map errors
  engine/ llm pseudonymize consent guard profile advice
  prompts/ system advice guard   lenses/ leverage disc
  cli/ args status   config.cjs
  tests/ store.smoke cli.smoke
adapters/claude/ commands(mach-*) agents(machiavelli-advisor)   templates/
install.sh  README.md  CLAUDE.md(DESIGN_SYSTEM: warp)
```

### Ключевые решения
| Тема | Решение |
|------|---------|
| Портируемость | CLI-ядро + тонкие адаптеры; провайдер-абстракция LLM (anthropic + openai-compat по `MACH_LLM_URL`) |
| Хранилище | SQLite через фасад: `node:sqlite` (primary, ноль compile) + `better-sqlite3` (fallback Node 20–22.4) |
| Шифрование | AES-256-GCM field-level (`[ver|iv|tag|ct]`, AAD=table.col), 2 ключа (data + names), keychain>файл-600>ENV |
| Факты≠интерпретации | facts append-only immutable (tombstone); interpretations регенерируемы, is_current, isStale по множеству fact-id |
| Приватность (C1) | Псевдонимизация промпта ON by default (имена→CSPRNG-коды до LLM, реидентификация локально) + one-time consent-гейт |
| Гардрейл (C2) | Детерминированный денилист → LLM-guard (видит только совет, без фактов) → fail-closed. v1 = block\|pass |
| Портируемость++ | `--dry` на всех LLM-командах = ядро как «prompt-compiler» (Codex/OpenCode гоняют свой инференс) |
| Envelope | единый `{ok,cmd,data,error,meta{contract,core,ts,dry,llm,guard}}`, exit 0 даже при ok:false |

---

## Валидация (на реальном CLI, fake LLM)

| Шаг | Результат |
|-----|-----------|
| init / person / fact | ✅ |
| profile --dry: имя псевдонимизировано в промпте | ✅ `hasName=false, hasCode=true` (C1 работает) |
| profile (llm) | ✅ |
| advice норм-запрос | ✅ `guard=pass`, совет есть |
| advice вредный запрос («подставить/оклеветать») | ✅ `guard=block, advice=null` (C2 работает) |
| status | ✅ |
| store.smoke.cjs | ✅ 24 assertions (driver: node:sqlite) |
| cli.smoke.cjs | ✅ 13 assertions |

### Баги, найденные и починенные в валидации
1. **`isStale` ms-коллизия** — при факте и интерпретации в одну мс сравнение по timestamp
   давало ложь. Фикс: сверка множества активных fact-id против `based_on_fact_ids`
   (`core/store/interpretations.cjs`).
2. **Резолвинг ассетов (`LENS_NOT_FOUND`)** — движок джойнил `config.corePath/lenses`, а install.sh
   писал `corePath`=репо-корень (для адаптеров). Ассеты — код, лежат в `core/`. Фикс: движок
   резолвит lenses/prompts от `__dirname` (`core/machiavelli.cjs`), `config.corePath` остаётся только
   для адаптеров.

---

## Возражение (зафиксировано)

Команда `/spec-interview` предписывала workflow «Бизнес-фича» с дефолт-агентами Spring/Compose/Vue
(java-architect, vue-expert, builder-spring-feature). Проект — Node.js CLI. Запуск Spring-билдера =
неверный инструмент = техдолг. **Консилиум и executing адаптированы под стек** (роли сохранены,
агенты — Node/CLI), структура стадий не нарушена.

---

## Известные ограничения v1 (осознанные, в README)
- Field-level шифрование не покрывает метаданные графа (кроме `rel_enc`) — структура графа в
  plaintext. Whole-DB SQLCipher → v2 (opt-in, чтобы не ломать «просто запустить»).
- Псевдонимизация снижает, но не устраняет реидентификацию (граф+роли выдают структуру).
- Guard = block|pass (rewrite → v1.1).
- Только ego-перспектива; Codex/OpenCode адаптеры — структура заложена, реализация позже.
- `better-sqlite3@11` не собирается под Node 26 — не блокер (node:sqlite builtin используется).

## Открытые вопросы для владельца
1. Рыночный research в `/advice` — оставить через host WebSearch (текущий дефолт) или ядро само?
2. `rewrite`-ветка гардрейла в v1.1 — нужна?
3. Ключ шифрования: backup-стратегия при переезде между машинами (сейчас — экспорт на stderr при генерации).

---

## Как запустить
```bash
./install.sh                       # checkNode → deps(по согласию) → адаптеры в ~/.claude → status
export MACH_LLM_KEY=...             # ключ провайдера (или MACH_LLM_URL=localhost для приватности)
node core/machiavelli.cjs init --ego-name "..." --company "..."
node core/machiavelli.cjs advice "Стоит ли просить повышение?" --consent
# в Claude Code: /mach-init  /mach-fact  /mach-person  /mach-advice  /mach-daily
```
