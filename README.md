# Clara — Operations Lead

Operations Lead for Tabularum. Owns CRM, communications, scheduling and operational workflows across the agent team.

- **Slug:** `clara`
- **Entry:** [`index.js`](./index.js)
- **Persona spec:** [`instructions.txt`](./instructions.txt)

## Three layers

| Layer | Location |
|---|---|
| **Core** (this folder) | [`agents/clara/`](.) — agent card, CRM engine, adapters |
| **Backend HTTP** | [`backend/src/agents/clara/`](../../backend/src/agents/clara) — `route.js`, HR functions, onboarding chat, receipt processor |
| **Frontend page** | [`frontend/tabularum-clara.html`](../../frontend/tabularum-clara.html) |
| **Frontend JS** | [`frontend/js/pages/clara.js`](../../frontend/js/pages/clara.js) |

## Capabilities

- **CRM** — contact/profile memory, deal tracking, follow-up scheduling ([`crm-engine.js`](./crm-engine.js), [`follow-up.js`](./follow-up.js))
- **Email** — Gmail send/receive, OTP and notification templating ([`gmail-adapter.js`](./gmail-adapter.js), [`templates.js`](./templates.js))
- **Calendar** — meeting scheduling and conflict detection ([`calendar-adapter.js`](./calendar-adapter.js))
- **Telegram** — inbound command handling ([`telegram-handler.js`](./telegram-handler.js))
- **Task parsing** — extracts actions from natural-language messages ([`task-parser.js`](./task-parser.js))
- **At-rest encryption** — secrets via [`crypto-store.js`](./crypto-store.js)

## HTTP surface

Runs as a standalone Express server in [`server.js`](./server.js) for local/admin use, and is also exposed by the main backend via `backend/src/agents/clara`.

## Dependencies

- Shared institutional layer: [`packages/institutional-core`](../../packages/institutional-core) (audit, confidence, approvals)
- Node ≥ 18

## Quick start

```bash
cd agents/clara
yarn install
node server.js
```

Env vars: `GMAIL_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CALENDAR_*`, `TABULARUM_MASTER_KEY`. See repo root `README.md`.

## Connecting a simulator or harness (Agent Etna)

This agent exposes the same surface every Tabularum agent does, so a harness
needs no per-agent knowledge:

| | |
|---|---|
| `GET /health` | liveness, and whether a model is reachable |
| `GET /agent-card` | identity |
| `GET /tools` | the callable contract, as JSON Schema |
| `POST /task` | `{ goal }` — runs the reasoning loop, returns the answer and the full trace |
| `POST /chat` | the same loop, conversational shape |
| `POST /v1/chat/completions` | the same, in OpenAI response shape |

The chat endpoints accept `goal`, `task`, `message`, `input`, `prompt`,
`query`, `text`, `question`, `content`, or an OpenAI-style `messages` array,
and answer `400` naming what they accept rather than `500` when a body has
none of them. The reply is under `response`, and mirrored as `reply` and
`content`.

`/api/chat` is deliberately left to this repository's own handler.

### It runs with no configuration

The service boots and answers with nothing set at all, which is what a sandbox
gives it. Without a model key the reasoning endpoints return `ok: false` and
`stopReason: "no_llm_key"` rather than failing to start, so a harness sees a
live agent that is unconfigured instead of a dead process.

Set `OPENROUTER_API_KEY` to make it think.

### Authentication

`/task` and `/chat` run the model, so they are gated as soon as any of
`AGENT_TASK_TOKEN`, `AGENT_PASSWORD` or `DASHBOARD_PASSWORD` is set. The secret
may arrive as `Authorization: Bearer <secret>`, `X-Agent-Password` or
`X-Api-Key`.

With none of them set the endpoints are open. That is what makes a zero-config
sandbox work — and why any deployment reachable from the internet should set
one, or it is an unauthenticated endpoint spending your inference credit.
