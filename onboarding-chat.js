/**
 * CLARA — Onboarding Chat Agent
 * Pops up during onboarding if the user idles for 30+ seconds.
 * Guides users through the registration process and answers questions.
 *
 * In production: connects to Claude API for dynamic responses.
 * Currently: uses structured response templates.
 */

'use strict';

const LIVIA_RESPONSES = {
  greeting: [
    "Hi there! I'm Clara, your onboarding guide. I noticed you might need a hand — how can I help?",
    "Hello! I'm Clara, TABULARUM's onboarding assistant. The registration process is straightforward — let me walk you through it.",
    "Welcome! I'm Clara. I'm here to make sure your onboarding goes smoothly. What can I help you with?"
  ],

  profileType: {
    question: "Which profile type are you looking for?",
    answers: {
      'individual_investor': "As an Individual Investor, you'll get access to portfolio tracking, fund performance data, and the Forum marketplace. The onboarding involves identity verification and accreditation checks — typically takes under 10 minutes.",
      'fund': "As a Fund, you'll be able to manage LP relationships, issue capital calls, share documents, and access the full TABULARUM infrastructure. We'll need your fund formation documents and GP details.",
      'company': "As a Company, TABULARUM helps you manage capital raises, investor relations, and document management. You'll need basic corporate documents to get started.",
      'advisor': "As an Advisor/Intermediary, you'll access deal tracking, investor search, automated outreach, and a proprietary CRM. We'll verify your professional credentials during onboarding."
    }
  },

  sections: {
    'email': "This step verifies your email address. We'll send a 6-digit code to the email you enter — check your inbox (and spam folder). The code expires in 10 minutes.",
    'identity': "For identity verification, we need your passport details and a clear photo of your passport data page. You can use your phone camera via the QR code.",
    'documents': "Upload your supporting documents here. Accepted formats are PDF, JPG, and PNG (max 20MB each). These are encrypted and stored securely.",
    'wealth': "The source of wealth section helps us comply with AML regulations. Select all sources that apply — this information is confidential and used solely for compliance.",
    'address': "We need your current residential address with a proof of address document dated within the last 3 months. Utility bills, bank statements, or government letters work.",
    'submit': "You're almost done! Review your information and click Submit. Our team will review your application — most approvals happen within 24 hours."
  },

  faq: {
    'how long': "The onboarding process typically takes 5-10 minutes. Approval usually happens within 24 hours.",
    'documents needed': "It depends on your profile type. Generally: government ID (passport), proof of address, and for funds/entities — formation documents.",
    'tin': "Your Tabularum Identity Number (TIN) is assigned after your application is approved. It's a unique identifier you can use across all TABULARUM services and partner platforms.",
    'security': "All documents are encrypted with AES-256 and stored on Cloudflare R2. We use end-to-end encryption and strict access controls. Your data never leaves the platform.",
    'forum': "The Forum is TABULARUM's marketplace and community platform. Once onboarded, you can access deal sourcing, research, debates, and secondary market trading.",
    'agents': "TABULARUM has four AI agents: Lucio (financial intelligence), Gaio (legal), Mila (tax & reporting), and Clara (executive assistant & onboarding — that's me!).",
    'cost': "Forum Light is free with limited features. Forum Pro is a subscription with unlimited access to all platform features.",
    'help': "I'm here to help! Ask me about any part of the onboarding process, what documents you need, how the platform works, or anything else."
  },

  fallback: "I'm not sure I understood that. Could you rephrase? You can ask me about the onboarding process, required documents, security, the Forum, or our AI agents."
};

/**
 * Generate a response to a user message.
 * @param {string} message - User's question
 * @param {string} currentSection - Which onboarding section they're on
 * @returns {string} Clara's response
 */
function generateResponse(message, currentSection) {
  const lower = message.toLowerCase();

  // Check FAQ matches first
  for (const [key, answer] of Object.entries(LIVIA_RESPONSES.faq)) {
    if (lower.includes(key)) return answer;
  }

  // Check section-specific help
  if (currentSection && LIVIA_RESPONSES.sections[currentSection]) {
    if (lower.includes('help') || lower.includes('what') || lower.includes('how') || lower.includes('?')) {
      return LIVIA_RESPONSES.sections[currentSection];
    }
  }

  // Check profile type questions
  for (const [type, answer] of Object.entries(LIVIA_RESPONSES.profileType.answers)) {
    if (lower.includes(type.replace('_', ' '))) return answer;
  }

  // Generic keyword matching
  if (lower.includes('email') || lower.includes('code') || lower.includes('verify')) return LIVIA_RESPONSES.sections.email;
  if (lower.includes('passport') || lower.includes('identity') || lower.includes('id')) return LIVIA_RESPONSES.sections.identity;
  if (lower.includes('document') || lower.includes('upload') || lower.includes('file')) return LIVIA_RESPONSES.sections.documents;
  if (lower.includes('address') || lower.includes('proof')) return LIVIA_RESPONSES.sections.address;
  if (lower.includes('submit') || lower.includes('done') || lower.includes('finish')) return LIVIA_RESPONSES.sections.submit;
  if (lower.includes('secure') || lower.includes('encrypt') || lower.includes('safe')) return LIVIA_RESPONSES.faq.security;
  if (lower.includes('forum') || lower.includes('market')) return LIVIA_RESPONSES.faq.forum;
  if (lower.includes('agent') || lower.includes('ai') || lower.includes('lucio') || lower.includes('mila') || lower.includes('gaio')) return LIVIA_RESPONSES.faq.agents;

  return LIVIA_RESPONSES.fallback;
}

/**
 * Get greeting message.
 */
function getGreeting() {
  return LIVIA_RESPONSES.greeting[Math.floor(Math.random() * LIVIA_RESPONSES.greeting.length)];
}

module.exports = { generateResponse, getGreeting, LIVIA_RESPONSES };
