/**
 * CLARA Agent — The Operations Lead Agent
 * Data rooms, investor onboarding, scheduling, KYC compliance, communications coordination.
 */

// ─── NANDA: Verifiable Identity — Agent Card (machine-readable) ──────────────
const AGENT_CARD = {
  name: 'Clara',
  version: '6.0.0',
  protocol: 'NANDA/1.0',
  description: 'Operations Lead Agent — data rooms, investor onboarding, scheduling, KYC compliance, communications coordination',
  owner: {
    name: 'Antoninus Global SPC',
  },
  // Capabilities and endpoints are kept in step: the card is a
  // machine-readable contract, so advertising a capability with nothing behind
  // it is a defect. 'dataroom' was previously listed here with no endpoint and
  // no implementation on either the standalone service or the Tabularum mount,
  // and has been dropped until one exists.
  capabilities: [
    'chat',
    'calendar',
    'outreach',
    'onboarding',
    'crm',
    'compliance-calendar',
    'hr',
    'receipts',
    'vault',
    'campaigns',
  ],
  endpoints: {
    agentCard:            '/agent-card',
    status:               '/api/status',
    chat:                 '/clara/chat',
    calendar:             '/api/calendar',
    outreach:             '/api/outreach',
    onboarding:           '/clara/onboarding',
    crm:                  '/clara/crm',
    complianceCalendar:   '/clara/compliance-calendar',
    hr:                   '/clara/hr',
    receipts:             '/clara/receipts/process',
    vault:                '/api/vault',
    campaigns:            '/api/campaigns',
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
  role: 'Operations Lead',
  version: AGENT_CARD.version,
  AGENT_CARD,
  capabilities: AGENT_CARD.capabilities,

  // Portable domain logic — no I/O at import time.
  crmEngine:        require('./crm-engine'),
  calendarAdapter:  require('./calendar-adapter'),
  telegramHandler:  require('./telegram-handler'),
  hrFunctions:      require('./hr-functions'),
  onboardingChat:   require('./onboarding-chat'),
  receiptProcessor: require('./receipt-processor'),

  // Deferred: these touch the filesystem, Google APIs or the Anthropic SDK on
  // load, which a consumer importing only the agent card should not pay for.
  get cryptoStore() { return require('./crypto-store'); },
  get templates()   { return require('./templates'); },
  get followUp()    { return require('./follow-up'); },
  get gmailAdapter() { return require('./gmail-adapter'); },
  get taskParser()  { return require('./task-parser'); },

  /** The Express app, loaded on demand. */
  get app() { return require('./server'); },
};
