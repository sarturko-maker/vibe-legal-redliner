/**
 * Configuration and constants for Vibe Legal Extension
 */

// Default playbooks matching server
export const DEFAULT_PLAYBOOKS = [
  {
    id: 'nda-standard',
    name: 'Standard NDA Review',
    description: 'Standard review for Non-Disclosure Agreements focusing on balanced terms.',
    isExample: true,
    playbookText: `Review this NDA for balanced, mutual protection. Focus on:

1. CONFIDENTIALITY PERIOD
   - Should be 2-3 years maximum for business information
   - Trade secrets may have longer protection
   - Flag any "perpetual" confidentiality obligations

2. DEFINITION OF CONFIDENTIAL INFORMATION
   - Should have reasonable exclusions (public info, prior knowledge, independent development)
   - Should not be overly broad or capture all information
   - Flag if it includes "residual knowledge" restrictions

3. PERMITTED DISCLOSURES
   - Must allow disclosure to professional advisors
   - Must allow disclosure if required by law (with notice)
   - Should allow disclosure to affiliates/subsidiaries

4. RETURN/DESTRUCTION OF INFORMATION
   - Reasonable timeframe (30 days)
   - Allow retention of archival/legal copies
   - No requirement to certify destruction

5. TERM AND TERMINATION
   - Either party should be able to terminate with 30 days notice
   - Confidentiality obligations should survive termination

6. LIABILITY
   - Cap liability at reasonable amount (contract value or 12 months fees)
   - Exclude consequential damages
   - Carve-out for willful breach only

7. GOVERNING LAW
   - Note the governing law and jurisdiction
   - Flag exclusive jurisdiction clauses
   - Prefer arbitration for disputes over $100k`
  },
  {
    id: 'supply-aggressive',
    name: 'Supply Agreement (Aggressive)',
    description: 'Aggressive review for Supply Agreements favoring the buyer.',
    isExample: true,
    playbookText: `Review this Supply Agreement with aggressive buyer-favorable positions:

1. PRICING & PAYMENT
   - Payment terms should be NET 60 minimum, prefer NET 90
   - Prices should be fixed for contract term
   - No price escalation clauses without caps
   - Right to audit supplier costs

2. DELIVERY & PERFORMANCE
   - Liquidated damages for late delivery (1-2% per week)
   - Right to source from alternative suppliers if delays occur
   - Supplier bears all shipping/insurance costs (DDP terms)

3. WARRANTIES
   - Minimum 24-month warranty period
   - Full replacement or refund at buyer's option
   - Supplier indemnifies for defects

4. INTELLECTUAL PROPERTY
   - Buyer owns all IP in custom specifications
   - Broad license to supplier's background IP
   - Full indemnification for IP infringement claims

5. LIABILITY
   - Supplier liability should NOT be capped
   - Or if capped, minimum 2x annual contract value
   - Full consequential damages for supplier's breach

6. TERMINATION
   - Buyer may terminate for convenience with 30 days notice
   - Buyer may terminate immediately for any breach
   - Supplier termination only for material breach with 90-day cure period

7. EXCLUSIVITY
   - Require supplier exclusivity in territory
   - Most favored customer pricing
   - First right to new products/improvements

8. INSURANCE
   - Minimum $5M product liability insurance
   - Buyer named as additional insured
   - Certificate of insurance required annually`
  },
  {
    id: 'saas-balanced',
    name: 'SaaS Agreement (Balanced)',
    description: 'Balanced review for SaaS/Software agreements.',
    isExample: true,
    playbookText: `Review this SaaS Agreement for balanced, commercially reasonable terms:

1. SERVICE LEVELS (SLA)
   - Uptime commitment should be 99.5% minimum
   - Measurement period should be monthly
   - Service credits for downtime (10% per 1% below SLA)
   - Exclude scheduled maintenance from downtime

2. DATA PROTECTION
   - Clear data ownership (customer owns their data)
   - Data processing agreement if EU data involved
   - Right to export data in standard format
   - Data deletion upon termination (with reasonable timeline)

3. SECURITY
   - SOC 2 Type II or equivalent certification
   - Encryption in transit and at rest
   - Breach notification within 72 hours
   - Regular penetration testing

4. INTELLECTUAL PROPERTY
   - Customer retains all IP in their data/content
   - Provider retains IP in the platform
   - License should be limited to providing the service
   - No use of customer data for training AI/ML without consent

5. LIABILITY
   - Cap at 12 months of fees paid
   - Uncapped for: data breach, IP indemnity, gross negligence
   - Mutual limitation of consequential damages
   - Carve-out for direct damages from data loss

6. TERM AND RENEWAL
   - Annual term with auto-renewal is acceptable
   - 30-day notice to prevent renewal
   - No price increases over 5% on renewal
   - Right to terminate if material terms change

7. SUPPORT
   - Business hours support minimum
   - Response times defined by severity
   - Escalation path documented
   - Named support contact preferred`
  }
];

// AI Provider configurations
export const AI_PROVIDERS = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Latest)', default: true },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
    ],
    enabled: true
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', default: true },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' }
    ],
    enabled: true
  }
};

// Job statuses
export const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  ERROR: 'error'
};
