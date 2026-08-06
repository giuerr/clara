// VENDORED — do not edit here.
// Source of truth: backend/src/llm-client.js in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * LLM CLIENT — one seam for every model call in Tabularum.
 *
 * The whole codebase talks the Anthropic Messages shape:
 *
 *     client.messages.create({ model, max_tokens, system, messages, tools })
 *       -> { content: [{ type: 'text' | 'tool_use', ... }], stop_reason, usage }
 *
 * That shape is kept. What changes underneath is who serves it:
 *
 *   OPENROUTER_API_KEY set  ->  OpenRouter, via its OpenAI-compatible
 *                               /chat/completions endpoint. Requests and
 *                               responses are translated here.
 *   otherwise               ->  Anthropic direct, via the official SDK.
 *
 * OpenRouter is preferred when both are present. Nothing else in the codebase
 * needs to know which one answered — including agentic-loop.js, whose tool
 * protocol (tool_use / tool_result / stop_reason) survives the round trip.
 *
 * Environment
 *   OPENROUTER_API_KEY    routes every call through OpenRouter
 *   OPENROUTER_MODEL      force one model for all calls, ignoring the caller
 *   OPENROUTER_MODEL_MAP  JSON, e.g. {"claude-sonnet-5":"openai/gpt-5"} —
 *                         remaps individual models without touching call sites
 *   OPENROUTER_SITE_URL   sent as HTTP-Referer, for OpenRouter attribution
 *   ANTHROPIC_API_KEY     fallback provider (also the legacy LUCIO_API)
 */

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

// Read at call time, not at import time. Freezing these into module constants
// makes configuration depend on require order — anything that sets the
// environment after the first import is silently ignored, which is both a
// testing obstacle and a real hazard for a process that loads config late.
function baseUrl()  { return process.env.OPENROUTER_BASE_URL || DEFAULT_BASE; }
function timeoutMs() { return Number(process.env.LLM_TIMEOUT_MS) || 120_000; }

// ── Provider selection ──────────────────────────────────────────────────────

function openRouterKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

function anthropicKey() {
  // LUCIO_API is the historical name for the same Anthropic key; several
  // routes still read it, so it stays a valid source here.
  return process.env.ANTHROPIC_API_KEY || process.env.LUCIO_API || '';
}

/** Which provider a call would use right now, or null if no key is configured. */
function activeProvider() {
  if (openRouterKey()) return 'openrouter';
  if (anthropicKey()) return 'anthropic';
  return null;
}

/**
 * The key that a call made right now would actually use.
 *
 * Call sites used to read `process.env.ANTHROPIC_API_KEY` directly, both to
 * decide whether AI is available and to construct a client. On a deployment
 * holding only an OpenRouter key, that test reports "AI unavailable" while the
 * platform is in fact fully configured. Reading through here fixes both uses
 * at once: the result is truthy exactly when a model can be reached, and it is
 * the right key to hand to createLLMClient().
 */
function llmKey() {
  return openRouterKey() || anthropicKey();
}

/** Is any model provider configured? */
function hasLLMKey() {
  return activeProvider() !== null;
}

/** Message shown when no provider is configured. Names both options. */
const NO_KEY_MESSAGE = 'AI unavailable — set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY).';

// ── Model naming ────────────────────────────────────────────────────────────

/**
 * OpenRouter namespaces every model by vendor: `claude-sonnet-5` is
 * `anthropic/claude-sonnet-5` there. Callers pass bare Anthropic IDs, so add
 * the namespace unless one is already present or an override applies.
 */
function toOpenRouterModel(model) {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;

  if (process.env.OPENROUTER_MODEL_MAP) {
    try {
      const mapped = JSON.parse(process.env.OPENROUTER_MODEL_MAP)[model];
      if (mapped) return mapped;
    } catch {
      // A malformed map must not take the platform down — fall through to the
      // default namespacing below.
    }
  }

  if (!model) return 'anthropic/claude-sonnet-5';
  if (model.includes('/')) return model;           // already namespaced
  if (model.startsWith('claude-')) return `anthropic/${model}`;
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    return `openai/${model}`;
  }
  return model;
}

/**
 * Models OpenRouter should try if the requested one is unavailable there.
 *
 * Slugs move as vendors ship and retire versions, and a stale ID would
 * otherwise turn into a hard 400 on every request. This list is passed as
 * OpenRouter's `models` field, which routes past an unroutable primary.
 */
function fallbackModels(primary) {
  const chain = [
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-3.7-sonnet',
  ].filter(m => m !== primary);
  return chain.length ? chain : undefined;
}

// ── Anthropic -> OpenAI request translation ─────────────────────────────────

/** `system` may be a plain string or an array of text blocks. */
function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
  }
  return String(system);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : b.text || JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Translate Anthropic messages into OpenAI chat messages.
 *
 * The two formats disagree about where tool traffic lives. Anthropic keeps it
 * inside content blocks — `tool_use` on the assistant turn, `tool_result` on
 * the following user turn. OpenAI hoists calls to `tool_calls` on the
 * assistant message and gives each result its own `role: 'tool'` message. One
 * Anthropic turn can therefore become several OpenAI ones.
 */
function toOpenAIMessages(system, messages) {
  const out = [];

  const sys = systemText(system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const msg of messages) {
    const { role, content } = msg;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: String(content ?? '') });
      continue;
    }

    // tool_result blocks each become their own message and must precede any
    // ordinary text from the same turn, so they are collected separately.
    const toolResults = [];
    const textParts = [];
    const toolCalls = [];

    for (const block of content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text || '');
          break;

        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;

        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content),
          });
          break;

        case 'image': {
          const src = block.source || {};
          const url = src.type === 'base64'
            ? `data:${src.media_type};base64,${src.data}`
            : src.url;
          if (url) textParts.push({ type: 'image_url', image_url: { url } });
          break;
        }

        default:
          // Unknown block types are dropped rather than forwarded: passing an
          // Anthropic-only shape through would be rejected as a bad request.
          break;
      }
    }

    out.push(...toolResults);

    const hasImage = textParts.some(p => typeof p === 'object');
    if (hasImage) {
      out.push({
        role,
        content: textParts.map(p => (typeof p === 'string' ? { type: 'text', text: p } : p)),
      });
    } else {
      const text = textParts.join('\n');
      if (toolCalls.length) {
        // OpenAI wants null, not '', when an assistant turn is only tool calls.
        out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
      } else if (text || !toolResults.length) {
        out.push({ role, content: text });
      }
    }
  }

  return out;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
    },
  }));
}

// ── OpenAI -> Anthropic response translation ────────────────────────────────

const STOP_REASONS = {
  stop:          'end_turn',
  length:        'max_tokens',
  tool_calls:    'tool_use',
  function_call: 'tool_use',
  content_filter: 'stop_sequence',
};

function toAnthropicResponse(data, requestedModel) {
  const choice = (data.choices && data.choices[0]) || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.map(p => p.text || '').join('');
    if (text) content.push({ type: 'text', text });
  }

  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      // A model can emit malformed JSON arguments. Hand the raw string to the
      // tool rather than throwing: the executor can reject it with a message
      // the model can act on, which a thrown parse error would not allow.
      input = { _raw: call.function?.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }

  const usage = data.usage || {};

  return {
    id: data.id,
    type: 'message',
    role: 'assistant',
    model: data.model || requestedModel,
    content,
    stop_reason: STOP_REASONS[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens:  usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * agentic-loop.js decides whether to retry from `err.status` and reads
 * `err.headers['retry-after']` for the backoff, so an OpenRouter failure has
 * to carry both or every 429 would be treated as a permanent failure.
 */
function apiError(message, status, headers) {
  const err = new Error(message);
  err.status = status;
  err.headers = headers || {};
  return err;
}

function headersToObject(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  }
  return out;
}

// ── OpenRouter transport ────────────────────────────────────────────────────

/**
 * @param {object} params — Anthropic Messages parameters
 * @param {object} [options] — request options, matching the Anthropic SDK's
 *   second argument. `signal` is honoured so a caller's own timeout still
 *   applies; without it a caller-side AbortController would silently do
 *   nothing and only the much longer internal timeout would bound the call.
 */
async function openRouterCreate(params, options = {}) {
  const model = toOpenRouterModel(params.model);

  const body = {
    model,
    messages: toOpenAIMessages(params.system, params.messages || []),
  };

  if (params.max_tokens) body.max_tokens = params.max_tokens;
  if (typeof params.temperature === 'number') body.temperature = params.temperature;
  if (params.stop_sequences) body.stop = params.stop_sequences;

  const tools = toOpenAITools(params.tools);
  if (tools) body.tools = tools;

  // `thinking` is Anthropic-only. It was added across the codebase to stop
  // adaptive thinking from consuming small max_tokens budgets; OpenRouter
  // expresses the same intent through `reasoning`.
  if (params.thinking?.type === 'disabled') body.reasoning = { enabled: false };

  const fallbacks = fallbackModels(model);
  if (fallbacks) body.models = [model, ...fallbacks];

  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${openRouterKey()}`,
    'X-Title':       'Tabularum',
  };
  const referer = process.env.OPENROUTER_SITE_URL || process.env.SITE_URL;
  if (referer) headers['HTTP-Referer'] = referer;

  // A hung upstream must not pin an Express worker open indefinitely. The
  // caller's signal, if any, aborts this one too, so whichever fires first
  // wins rather than the two competing.
  const limit = timeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);

  const callerSignal = options.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      // A caller-initiated abort is not a server timeout — reporting it as 504
      // would make the agentic loop retry a request the caller gave up on.
      if (callerSignal?.aborted) {
        const aborted = new Error('Request aborted by caller');
        aborted.name = 'AbortError';
        throw aborted;
      }
      throw apiError(`OpenRouter request timed out after ${limit}ms`, 504);
    }
    throw apiError(`OpenRouter request failed: ${err.message}`, undefined);
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }

  const responseHeaders = headersToObject(res.headers);
  const raw = await res.text();

  if (!res.ok) {
    let detail = raw.slice(0, 500);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.error?.message || detail;
    } catch { /* keep the raw body */ }
    throw apiError(`OpenRouter ${res.status}: ${detail}`, res.status, responseHeaders);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw apiError('OpenRouter returned a malformed response body', 502, responseHeaders);
  }

  // OpenRouter reports upstream provider failures in-band, with HTTP 200.
  if (data.error) {
    const status = data.error.code >= 400 ? data.error.code : 502;
    throw apiError(`OpenRouter: ${data.error.message || 'upstream error'}`, status, responseHeaders);
  }

  return toAnthropicResponse(data, params.model);
}

// ── Public client ───────────────────────────────────────────────────────────

/**
 * Build a client exposing the Anthropic Messages surface.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey] — legacy per-call Anthropic key. Ignored when
 *   OpenRouter is configured, so existing `new Anthropic({ apiKey })` sites
 *   can be swapped one-for-one.
 * @returns {{ messages: { create: Function }, provider: string }}
 */
function createLLMClient(opts = {}) {
  const provider = activeProvider();

  if (provider === 'openrouter') {
    return {
      provider: 'openrouter',
      messages: { create: openRouterCreate },
    };
  }

  const key = opts.apiKey || anthropicKey();
  if (!key) {
    return {
      provider: 'none',
      messages: {
        create: async () => { throw apiError(NO_KEY_MESSAGE, 401); },
      },
    };
  }

  // Loaded lazily so a deployment running purely on OpenRouter never has to
  // resolve the Anthropic SDK at all. Some agents that vendor this file do not
  // depend on the SDK for exactly that reason, so a missing module here is a
  // configuration problem to report, not a crash at an unrelated call site.
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return {
      provider: 'none',
      messages: {
        create: async () => {
          throw apiError(
            'ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed here. ' +
            'Set OPENROUTER_API_KEY to use the OpenRouter gateway, which needs no SDK.',
            500,
          );
        },
      },
    };
  }

  const client = new Anthropic({ apiKey: key });
  client.provider = 'anthropic';
  return client;
}

module.exports = {
  createLLMClient,
  hasLLMKey,
  llmKey,
  activeProvider,
  NO_KEY_MESSAGE,
  // Exported for tests.
  toOpenAIMessages,
  toOpenAITools,
  toAnthropicResponse,
  toOpenRouterModel,
};
