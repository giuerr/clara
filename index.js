/**
 * CLARA Agent — The Operations Lead Agent
 * Data rooms, investor onboarding, scheduling, KYC compliance, communications coordination.
 */

// ─── NANDA: Verifiable Identity — Agent Card (machine-readable) ──────────────
const AGENT_CARD = {
  name: 'Clara',
  version: '1.0.0',
  protocol: 'NANDA/1.0',
  description: 'Operations Lead Agent — data rooms, investor onboarding, scheduling, KYC compliance, communications coordination',
  owner: {
    name: 'Antoninus Global SPC',
  },
  capabilities: [
    'chat',
    'calendar',
    'outreach',
    'onboarding',
    'crm',
    'dataroom',
    'compliance-calendar',
    'vault',
    'campaigns',
  ],
  endpoints: {
    agentCard: '/agent-card',
    status:    '/api/status',
    chat:      '/clara/chat',
    calendar:  '/api/calendar',
    outreach:  '/api/outreach',
    onboarding: '/clara/onboarding',
    vault:     '/api/vault',
    campaigns: '/api/campaigns',
  },
  models: {
    haiku:   'claude-haiku-4-5-20251001',
    fast:    'claude-sonnet-4-6',
    capable: 'claude-opus-4-6',
  },
  integrations: ['gmail', 'google-calendar', 'google-contacts', 'telegram'],
  security: {
    authentication: 'Bearer token (DASHBOARD_PASSWORD)',
    cors:           'ALLOWED_ORIGINS whitelist',
    rateLimiting:   true,
    injectionGuard: 'untrusted_content tag boundary',
  },
};

module.exports = {
  name: 'Clara',
  description: 'The Operations Lead Agent',
  AGENT_CARD,
  capabilities: AGENT_CARD.capabilities,
};
