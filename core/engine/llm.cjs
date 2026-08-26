'use strict';

const { AppError } = require('../store/errors.cjs');

/**
 * Provider abstraction over raw fetch (no SDKs). Two backends, chosen by
 * MACH_LLM_URL:
 *   - empty / "anthropic"  -> Anthropic Messages API (/v1/messages)
 *   - any base URL         -> OpenAI-compatible (/chat/completions)
 *
 * ENV:
 *   MACH_LLM_KEY    api key (required unless MACH_LLM_FAKE=1)
 *   MACH_LLM_URL    base url (optional; presence selects openai-compat)
 *   MACH_LLM_MODEL  default model
 *   MACH_LLM_FAKE   "1" -> deterministic offline stub (for tests / --dry-runs)
 *
 * complete({system, messages, model, maxTokens, temperature, signal})
 *   -> { text, model, usage, provider, stopReason, raw }
 *
 * Retry ONLY on 429/500/502/503/504 + network errors. Exp backoff + jitter.
 * Per-attempt timeout 60s via AbortSignal.timeout.
 */

const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isFake(env = process.env) {
  return env.MACH_LLM_FAKE === '1' || env.MACH_LLM_FAKE === 'true';
}

/** anthropic when MACH_LLM_URL empty or literally "anthropic"; else openai-compat. */
function selectProvider(env = process.env) {
  const url = (env.MACH_LLM_URL || '').trim();
  if (url === '' || url.toLowerCase() === 'anthropic') return 'anthropic';
  return 'openai-compat';
}

function baseUrl(env = process.env) {
  const url = (env.MACH_LLM_URL || '').trim();
  if (url === '' || url.toLowerCase() === 'anthropic') return ANTHROPIC_DEFAULT_URL;
  return url.replace(/\/+$/, '');
}

// ---- request body builders (exported so --dry can show them) --------------

function buildAnthropicBody({ system, messages, model, maxTokens, temperature }) {
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: (messages || []).map((m) => ({ role: m.role, content: String(m.content) })),
  };
  if (system) body.system = String(system);
  if (temperature != null) body.temperature = temperature;
  return body;
}

function buildOpenAiBody({ system, messages, model, maxTokens, temperature }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: String(system) });
  for (const m of messages || []) msgs.push({ role: m.role, content: String(m.content) });
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: msgs,
  };
  if (temperature != null) body.temperature = temperature;
  return body;
}

// ---- response normalizers -------------------------------------------------

function normalizeAnthropic(json, model) {
  const text = Array.isArray(json.content)
    ? json.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    : '';
  return {
    text,
    model: json.model || model,
    usage: json.usage
      ? { input: json.usage.input_tokens, output: json.usage.output_tokens }
      : null,
    provider: 'anthropic',
    stopReason: json.stop_reason || null,
    raw: json,
  };
}

function normalizeOpenAi(json, model) {
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const text = choice && choice.message ? String(choice.message.content ?? '') : '';
  return {
    text,
    model: json.model || model,
    usage: json.usage
      ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens }
      : null,
    provider: 'openai-compat',
    stopReason: (choice && choice.finish_reason) || null,
    raw: json,
  };
}

// ---- HTTP with retry ------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250); // jitter
}

/**
 * POST JSON with retry on transient failures. Honors an optional caller signal
 * plus a per-attempt 60s timeout.
 */
async function postJSON(url, headers, body, { signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (res.ok) {
        return await res.json();
      }
      const errText = await res.text().catch(() => '');
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        lastErr = new AppError('LLM_HTTP_ERROR', `HTTP ${res.status}: ${errText.slice(0, 300)}`, {
          retryable: true,
          details: { status: res.status },
        });
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw new AppError('LLM_HTTP_ERROR', `HTTP ${res.status}: ${errText.slice(0, 300)}`, {
        retryable: RETRYABLE_STATUS.has(res.status),
        details: { status: res.status },
      });
    } catch (err) {
      if (err instanceof AppError && !err.retryable) throw err;
      // network / abort / timeout -> retryable
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      lastErr = err instanceof AppError
        ? err
        : new AppError(aborted ? 'LLM_TIMEOUT' : 'LLM_NETWORK', err.message || String(err), {
            retryable: true,
            cause: err,
          });
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new AppError('LLM_NETWORK', 'request failed after retries', { retryable: true });
}

// ---- deterministic fake (offline) -----------------------------------------

function fakeComplete(opts, env) {
  const model = opts.model || env.MACH_LLM_MODEL || DEFAULT_MODEL;
  const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === 'user');
  const userText = lastUser ? String(lastUser.content) : '';
  const sys = String(opts.system || '');

  let text;
  if (/guard-pass|независимый этический контролёр|verdict/i.test(sys)) {
    // Guard-pass fake: emit valid JSON verdict (block | rewrite | pass).
    // Check ONLY inside <advice>…</advice> (never in the instruction text,
    // which enumerates forbidden words for reference).
    const m = userText.match(/<advice>([\s\S]*?)<\/advice>/i);
    const adviceOnly = m ? m[1] : '';
    const harmCue = /(оклевет|солг|подстав|саботаж|угроз|шантаж|уничтож|навред|sabotage|slander|blackmail|threaten)/i.test(adviceOnly);
    // Soft-manipulation cue -> rewrite (not block). Used for deterministic rewrite tests.
    const softCue = !harmCue && /(манипул|скрой\s+(от|правду|факт)|скрыть\s+(от|правду|факт)|притвор)/i.test(adviceOnly);
    if (harmCue) {
      text = JSON.stringify({ verdict: 'block', text: null, reason: 'fake-guard: harm cue detected' });
    } else if (softCue) {
      // Simulate a rewrite: strip the manipulative sentence, return cleaned text.
      const cleaned = adviceOnly.replace(/(манипул[^.!?]*[.!?]?|скрой[^.!?]*[.!?]?|скрыть[^.!?]*[.!?]?|притвор[^.!?]*[.!?]?)/gi, '').trim();
      text = JSON.stringify({ verdict: 'rewrite', text: cleaned || adviceOnly, reason: 'fake-guard: manipulative cue removed' });
    } else {
      text = JSON.stringify({ verdict: 'pass', text: null, reason: 'fake-guard: no harm detected' });
    }
  } else if (/5 секций|СИТУАЦИЯ|advice/i.test(userText) || /консильери/i.test(sys)) {
    text = [
      '### СИТУАЦИЯ',
      '(fake) Владелец хочет усилить позицию легитимно.',
      '',
      '### РАСКЛАД',
      'Ключевые лица упомянуты в контексте.',
      '',
      '### ВАРИАНТЫ',
      '1. Выстроить доверие. 2. Продемонстрировать ценность.',
      '',
      '### РЕКОМЕНДАЦИЯ',
      'Начать с открытого разговора и демонстрации пользы.',
      '',
      '### РИСКИ',
      'Недооценка тайминга. Запасной вариант — подождать.',
      '',
      '## ОСНОВАНО НА',
      '- Факты: см. контекст',
      '- Профили: [профиль:leverage]',
      '- Граф: связи из досье',
      '- Guard: проверено',
    ].join('\n');
  } else if (/OCEAN|Big Five|bigfive|Openness|Conscientiousness|Extraversion|Agreeableness|Neuroticism/i.test(userText)) {
    // BigFive lens fake.
    text = [
      '## OCEAN-профиль',
      '- **O (Открытость):** Средний. Уверенность: Низкая. Недостаточно данных для точной оценки.',
      '- **C (Добросовестность):** Высокий. Уверенность: Средняя. Судя по фактам (#f1), предпочитает структуру.',
      '- **E (Экстраверсия):** Средний. Уверенность: Низкая. Нет явных сигналов в фактах.',
      '- **A (Доброжелательность):** Средний. Уверенность: Низкая. Недостаточно данных.',
      '- **N (Нейротизм):** Низкий. Уверенность: Низкая. Данных мало.',
      '',
      '## Доминирующий паттерн',
      '(fake) Человек с выраженной добросовестностью. Ценит порядок, выполняет обязательства.',
      '',
      '## Как взаимодействовать (для владельца)',
      '1. Давать структурированные запросы. 2. Фиксировать договорённости письменно.',
      '',
      '## Зоны трения',
      'Возможен конфликт с людьми, предпочитающими спонтанность и гибкие процессы.',
    ].join('\n');
  } else {
    // Profile-lens fake (leverage/disc/default).
    text = [
      '## Мотивы',
      '(fake) Признание и автономия.',
      '## Страхи',
      'Потеря контроля.',
      '## Рычаги (легитимные)',
      'Ценность и доверие.',
      '## Стиль коммуникации',
      'Кратко и по делу.',
    ].join('\n');
  }

  return {
    text,
    model,
    usage: { input: userText.length, output: text.length },
    provider: 'fake',
    stopReason: 'stop',
    raw: { fake: true },
  };
}

// ---- public API -----------------------------------------------------------

/**
 * @param {{
 *   system?: string,
 *   messages: {role:'user'|'assistant', content:string}[],
 *   model?: string, maxTokens?: number, temperature?: number, signal?: AbortSignal
 * }} opts
 * @param {object} [env]
 * @returns {Promise<{text,model,usage,provider,stopReason,raw}>}
 */
async function complete(opts, env = process.env) {
  if (!opts || !Array.isArray(opts.messages) || opts.messages.length === 0) {
    throw new AppError('LLM_BAD_ARGS', 'complete requires { messages: [...] }');
  }

  if (isFake(env)) return fakeComplete(opts, env);

  const provider = selectProvider(env);
  const model = opts.model || env.MACH_LLM_MODEL || DEFAULT_MODEL;
  const key = env.MACH_LLM_KEY;
  if (!key) {
    throw new AppError('LLM_NO_KEY', 'MACH_LLM_KEY is not set (or use MACH_LLM_FAKE=1)', {
      retryable: false,
    });
  }

  if (provider === 'anthropic') {
    const url = `${baseUrl(env)}/v1/messages`;
    const body = buildAnthropicBody({ ...opts, model });
    const headers = {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const json = await postJSON(url, headers, body, { signal: opts.signal });
    return normalizeAnthropic(json, model);
  }

  // openai-compat
  const url = `${baseUrl(env)}/chat/completions`;
  const body = buildOpenAiBody({ ...opts, model });
  const headers = { authorization: `Bearer ${key}` };
  const json = await postJSON(url, headers, body, { signal: opts.signal });
  return normalizeOpenAi(json, model);
}

module.exports = {
  complete,
  selectProvider,
  baseUrl,
  buildAnthropicBody,
  buildOpenAiBody,
  normalizeAnthropic,
  normalizeOpenAi,
  isFake,
  DEFAULT_MODEL,
  ANTHROPIC_VERSION,
};
