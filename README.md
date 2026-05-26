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
