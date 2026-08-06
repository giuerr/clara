// VENDORED — do not edit here.
// Source of truth: backend/src/agent-core.js in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * AGENT CORE — the reasoning loop that makes an agent autonomous.
 *
 * Without this, an agent is a menu: a set of HTTP endpoints that only do
 * something when a caller already knows which one to hit, in what order, with
 * what arguments. The knowledge of *how to get a job done* lives in the
 * caller, not the agent. That is why these services could serve every
 * capability they advertise and still fail any harness that hands them a goal
 * rather than a route.
 *
 * The core supplies the missing half:
 *
 *   goal in  ->  plan  ->  call own tools  ->  observe  ->  iterate  ->  answer
 *
 * Three things come out of one definition. A tool declared once is (a) offered
 * to the model, (b) executed when the model calls it, and (c) published at
 * GET /tools as JSON Schema. There is no second place to update, so the
 * advertised contract cannot drift from the real one — which is exactly how
 * the agent cards ended up claiming capabilities nothing implemented.
 *
 *   const mind = createMind({
 *     name: 'Gaio',
 *     systemPrompt: 'You are Gaio, general counsel...',
 *     tools: [
 *       defineTool({
 *         name: 'lookup_jurisdiction',
 *         description: 'Fetch the legal profile for a jurisdiction.',
 *         inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
 *         handler: ({ code }) => jurisdictions.get(code),
 *       }),
 *     ],
 *   });
 *
 *   const result = await mind.run('Is a 2% management fee market standard?');
 *   result.response    // the answer
 *   result.toolCalls   // what it actually did, in order
 *   result.transcript  // full turn-by-turn trace
 *
 * Everything is provider-agnostic: the loop talks to llm-client, which routes
 * to OpenRouter or Anthropic depending on which key is configured.
 */

const { createLLMClient, hasLLMKey, NO_KEY_MESSAGE } = require('./llm-client');

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;

// ── Tools ───────────────────────────────────────────────────────────────────

/**
 * Declare a capability the agent can invoke on itself.
 *
 * @param {object}   spec
 * @param {string}   spec.name         snake_case; the model calls it by this
 * @param {string}   spec.description  what it does and when to reach for it —
 *                                     this is the model's only guidance, so
 *                                     vagueness here shows up as wrong calls
 * @param {object}   spec.inputSchema  JSON Schema for the arguments
 * @param {Function} spec.handler      (input, ctx) => result. May be async.
 *                                     Throwing is fine: the error is returned
 *                                     to the model, which can correct itself.
 */
function defineTool({ name, description, inputSchema, handler }) {
  if (!name || typeof name !== 'string') throw new Error('defineTool: name is required');
  if (!description) throw new Error(`defineTool(${name}): description is required`);
  if (typeof handler !== 'function') throw new Error(`defineTool(${name}): handler must be a function`);
  return {
    name,
    description,
    inputSchema: inputSchema || { type: 'object', properties: {} },
    handler,
  };
}

// ── Guardrails ──────────────────────────────────────────────────────────────

/**
 * Guardrails are two optional predicates, checked on the way in and the way
 * out: { checkInput(text), checkOutput(text) } each returning
 * { blocked: boolean, reason: string|null }.
 *
 * That shape matches the guardrail modules Agent Etna generates, so a repo
 * carrying etna-guardrails.js can pass it straight in.
 */
function applyGuard(guard, phase, text) {
  const fn = guard && guard[phase];
  if (typeof fn !== 'function') return { blocked: false, reason: null };
  try {
    const verdict = fn(text);
    return verdict && verdict.blocked
      ? { blocked: true, reason: verdict.reason || 'Blocked by guardrails.' }
      : { blocked: false, reason: null };
  } catch (err) {
    // A broken guardrail must fail closed. Letting the request through
    // because the check itself crashed is the one outcome nobody wants.
    return { blocked: true, reason: `Guardrail check failed: ${err.message}` };
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

/**
 * Build an agent's reasoning core.
 *
 * @param {object}   opts
 * @param {string}   opts.name           agent name, used in traces
 * @param {string}   opts.systemPrompt   who the agent is and how it should work
 * @param {Array}    opts.tools          from defineTool()
 * @param {string}   [opts.model]
 * @param {number}   [opts.maxIterations] cap on plan/act cycles per goal
 * @param {number}   [opts.maxTokens]
 * @param {object}   [opts.guardrails]   { checkInput, checkOutput }
 * @param {Function} [opts.logger]       (event, detail) => void
 */
function createMind(opts = {}) {
  const {
    name = 'agent',
    systemPrompt,
    tools = [],
    model = process.env.AGENT_MODEL || DEFAULT_MODEL,
    maxIterations = Number(process.env.AGENT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS,
    maxTokens = Number(process.env.AGENT_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
    guardrails = null,
    logger = () => {},
  } = opts;

  if (!systemPrompt) throw new Error('createMind: systemPrompt is required');

  const byName = new Map();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`createMind: duplicate tool "${t.name}"`);
    byName.set(t.name, t);
  }

  /** The published contract: what this agent can be asked to do, and with what. */
  function manifest() {
    return {
      agent: name,
      model,
      maxIterations,
      tools: Array.from(byName.values()).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  /**
   * Pursue a goal to completion.
   *
   * Resolves rather than throws for expected outcomes — no key configured,
   * guardrail block, iteration cap — because a caller driving many goals wants
   * a comparable result object each time, not a mix of values and exceptions.
   * Genuine upstream failures still reject.
   */
  async function run(goal, runOpts = {}) {
    const started = Date.now();
    const transcript = [];
    const toolCalls = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    const base = {
      agent: name,
      goal,
      startedAt: nowIso(),
      toolCalls,
      transcript,
      usage,
      iterations: 0,
    };

    if (!hasLLMKey()) {
      return { ...base, ok: false, stopReason: 'no_llm_key', response: null, error: NO_KEY_MESSAGE };
    }

    const inGuard = applyGuard(guardrails, 'checkInput', goal);
    if (inGuard.blocked) {
      logger('guardrail:input-blocked', { agent: name, reason: inGuard.reason });
      return { ...base, ok: false, stopReason: 'blocked_input', response: null, error: inGuard.reason };
    }

    const client = createLLMClient();
    const claudeTools = Array.from(byName.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    const messages = [
      ...(runOpts.history || []).map(m => ({ ...m })),
      { role: 'user', content: String(goal) },
    ];

    const limit = runOpts.maxIterations || maxIterations;
    let iterations = 0;

    while (iterations < limit) {
      iterations++;

      const params = {
        model: runOpts.model || model,
        max_tokens: runOpts.maxTokens || maxTokens,
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages,
      };
      if (claudeTools.length) params.tools = claudeTools;

      let response;
      try {
        response = await callWithRetry(client, params, { agent: name, iteration: iterations, logger });
      } catch (err) {
        logger('loop:failed', { agent: name, iteration: iterations, error: err.message });
        return {
          ...base, iterations, ok: false, stopReason: 'llm_error',
          response: null, error: err.message, durationMs: Date.now() - started,
        };
      }

      if (response.usage) {
        usage.inputTokens += response.usage.input_tokens || 0;
        usage.outputTokens += response.usage.output_tokens || 0;
      }

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const wanted = response.content.filter(b => b.type === 'tool_use');

      transcript.push({
        iteration: iterations,
        thinking: text || null,
        toolsRequested: wanted.map(w => ({ name: w.name, input: w.input })),
      });

      // No tools requested — the agent considers the goal answered.
      if (response.stop_reason !== 'tool_use' || !wanted.length) {
        const outGuard = applyGuard(guardrails, 'checkOutput', text);
        if (outGuard.blocked) {
          logger('guardrail:output-blocked', { agent: name, reason: outGuard.reason });
          return {
            ...base, iterations, ok: false, stopReason: 'blocked_output',
            response: null, error: outGuard.reason, durationMs: Date.now() - started,
          };
        }
        logger('loop:complete', { agent: name, iterations, toolCalls: toolCalls.length });
        return {
          ...base, iterations, ok: true, stopReason: 'complete',
          response: text, error: null, durationMs: Date.now() - started,
        };
      }

      messages.push({ role: 'assistant', content: response.content });

      const results = [];
      for (const call of wanted) {
        const tool = byName.get(call.name);
        const t0 = Date.now();
        let output, ok = true;

        if (!tool) {
          // Hallucinated tool name. Telling the model what does exist lets it
          // recover on the next turn instead of repeating the mistake.
          ok = false;
          output = { error: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}` };
        } else {
          try {
            output = await tool.handler(call.input || {}, { agent: name, goal });
          } catch (err) {
            ok = false;
            output = { error: err.message };
          }
        }

        const durationMs = Date.now() - t0;
        toolCalls.push({ name: call.name, input: call.input, ok, durationMs, iteration: iterations });
        logger('loop:tool', { agent: name, tool: call.name, ok, durationMs });

        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: typeof output === 'string' ? output : JSON.stringify(output ?? null),
          ...(ok ? {} : { is_error: true }),
        });
      }

      messages.push({ role: 'user', content: results });
    }

    // Out of iterations. This is a real outcome worth surfacing rather than
    // dressing up as an answer: the trace shows where it was going.
    logger('loop:exhausted', { agent: name, iterations });
    return {
      ...base, iterations, ok: false, stopReason: 'max_iterations',
      response: null,
      error: `Stopped after ${iterations} iterations without reaching an answer.`,
      durationMs: Date.now() - started,
    };
  }

  return { name, model, run, manifest, tools: byName };
}

/** Retry transient upstream failures; surface everything else immediately. */
async function callWithRetry(client, params, { agent, iteration, logger }, maxRetries = 2) {
  let attempt = 0;
  for (;;) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const status = err.status;
      const transient = !status || status === 429 || status >= 500;
      if (!transient || attempt >= maxRetries) throw err;

      const retryAfter = err.headers && err.headers['retry-after'];
      const delay = retryAfter && !isNaN(parseInt(retryAfter, 10))
        ? Math.min(parseInt(retryAfter, 10) * 1000, 15000)
        : (2 ** attempt) * 1000 + Math.floor(Math.random() * 400);

      logger('loop:retry', { agent, iteration, attempt: attempt + 1, status, delay });
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
}

// ── HTTP surface ────────────────────────────────────────────────────────────

/**
 * Every body shape a caller might reasonably use to say one thing.
 *
 * External harnesses do not read our source before calling us. They post
 * whatever their convention is — `message`, `input`, `prompt`, or an
 * OpenAI-style `messages` array — and an agent that accepts exactly one of
 * those returns 500 to everyone else. That is not a robustness nicety: it is
 * why simulators reported "couldn't reach a chat endpoint — every route
 * answered 404/500" against agents whose chat endpoints were working fine for
 * the one caller that knew the magic key.
 *
 * @returns {{ text: string|null, history: Array }}
 */
function extractPrompt(body) {
  if (!body || typeof body !== 'object') return { text: null, history: [] };

  // OpenAI-style transcript: last user turn is the prompt, the rest history.
  if (Array.isArray(body.messages) && body.messages.length) {
    const turns = body.messages
      .filter(m => m && typeof m === 'object' && m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('')
            : String(m.content ?? ''),
      }));
    const lastUser = [...turns].reverse().find(t => t.role === 'user');
    return { text: lastUser ? lastUser.content : null, history: turns.slice(0, -1) };
  }

  for (const key of ['goal', 'task', 'message', 'input', 'prompt', 'query', 'text', 'question', 'content']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return { text: v, history: [] };
  }
  return { text: null, history: [] };
}

/**
 * Mount the uniform agent surface on an Express app.
 *
 *   GET  /health                liveness + whether a model is reachable
 *   GET  /agent-card            identity
 *   GET  /tools                 the machine-readable capability contract
 *   POST /task                  { goal } -> result with the full trace
 *   POST /chat                  conversational alias of the same loop
 *   POST /v1/chat/completions   the same, in OpenAI response shape
 *
 * These are deliberately identical across every agent, and deliberately
 * unauthenticated by default. Discovery, liveness and conversation were
 * previously each agent's own invention — /health here, /api/status there,
 * /mila/agent-card somewhere else, a chat endpoint that existed on one agent
 * and not the others — so no single harness could drive them all.
 *
 * Mount this BEFORE an agent's own routes. Express gives precedence to
 * whichever handler registered first, and the point is that these paths behave
 * the same everywhere; an agent's richer, stricter handlers stay reachable at
 * their own paths.
 *
 * The task and chat endpoints execute work, so they are gated whenever a token
 * is configured: set AGENT_TASK_TOKEN and callers must send
 * `Authorization: Bearer <token>`. With no token set they are open, which
 * suits a sandbox and is the only way an external simulator can exercise the
 * agent — so set the token if the deployment is reachable from anywhere
 * untrusted.
 *
 * @param {string[]} [opts.chatPaths] paths to serve the conversational alias
 *   on. Override to avoid shadowing a richer chat endpoint the agent already
 *   has — Livia's /api/chat, for instance.
 * @param {object|Function} [opts.agentCard] the card, or a function returning
 *   it. Mounting ahead of an agent's own routes means this can run before the
 *   agent's `const AGENT_CARD = ...` has initialised, which is a ReferenceError
 *   at require time; passing a function defers the read until the first
 *   request, by which point it is always ready.
 */
function mountAgent(app, {
  mind,
  agentCard,
  extraHealth = () => ({}),
  chatPaths = ['/chat', '/api/chat', '/v1/chat/completions'],
}) {
  if (!app || typeof app.get !== 'function') throw new Error('mountAgent: an Express app is required');
  if (!mind) throw new Error('mountAgent: mind is required');

  const json = (res, code, body) => res.status(code).json(body);

  app.get('/health', (_req, res) => json(res, 200, {
    ok: true,
    agent: mind.name,
    version: (typeof agentCard === 'function' ? agentCard() : agentCard || {}).version,
    ai: hasLLMKey(),
    tools: mind.tools.size,
    ...extraHealth(),
  }));

  app.get('/agent-card', (_req, res) => {
    const card = typeof agentCard === 'function' ? agentCard() : agentCard;
    return json(res, 200, card || { name: mind.name });
  });

  app.get('/tools', (_req, res) => json(res, 200, mind.manifest()));

  function authorised(req) {
    const required = process.env.AGENT_TASK_TOKEN;
    if (!required) return true;
    return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') === required;
  }

  async function handle(req, res, { openaiShape }) {
    if (!authorised(req)) {
      return json(res, 401, { ok: false, error: 'Unauthorized — send Authorization: Bearer <AGENT_TASK_TOKEN>.' });
    }

    const { text, history } = extractPrompt(req.body);
    if (!text) {
      // 400 with the accepted shapes, never 500. A caller guessing at our
      // contract should be told what it is, not handed a stack trace.
      return json(res, 400, {
        ok: false,
        error: 'No prompt found in the request body.',
        accepts: ['goal', 'task', 'message', 'input', 'prompt', 'query', 'text', 'question', 'content', 'messages[]'],
      });
    }

    let result;
    try {
      result = await mind.run(text, {
        history: Array.isArray(req.body.history) ? req.body.history : history,
        maxIterations: req.body.maxIterations,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }

    if (openaiShape) {
      return json(res, 200, {
        id: `agent-${mind.name}-${Date.now().toString(36)}`,
        object: 'chat.completion',
        model: result.model || mind.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.response || result.error || '' },
          finish_reason: result.ok ? 'stop' : 'error',
        }],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
      });
    }

    // 200 even when ok:false — the outcome is in the body, and a simulator
    // needs the trace for a blocked or exhausted run as much as a successful
    // one. `reply` and `content` mirror `response` so a caller reading any of
    // the common field names finds the answer.
    return json(res, 200, {
      ...result,
      reply: result.response,
      content: result.response,
    });
  }

  app.post('/task', (req, res) => handle(req, res, { openaiShape: false }));

  for (const path of chatPaths) {
    const openaiShape = path.includes('chat/completions');
    app.post(path, (req, res) => handle(req, res, { openaiShape }));
  }

  return app;
}

module.exports = { createMind, defineTool, mountAgent, applyGuard };
