/**
 * Agent Configuration
 *
 * Centralized configuration for all customizable agent values.
 * Edit these values to tailor the voice agent to your business.
 */

export interface AgentConfig {
  /** Your company name (used in greetings and farewells) */
  companyName: string;
  /** The agent's first name (the persona the AI adopts) */
  agentName: string;
  /** Warehouse/office location for pickup inquiries */
  warehouseLocation: string;
  /** Orders above this amount trigger transfer to a sales executive */
  highValueThreshold: number;
  /** IANA timezone for timestamps (e.g., 'America/New_York', 'Europe/London') */
  timezone: string;
  /** BCP 47 locale for date formatting (e.g., 'en-US', 'en-GB') */
  locale: string;
  /** Default country for addresses when not provided (e.g., 'US', 'AU', 'GB') */
  defaultCountry: string;
}

/**
 * Default configuration — replace these values with your own.
 */
export const DEFAULT_CONFIG: AgentConfig = {
  companyName: 'Your Company',
  agentName: 'Alex',
  warehouseLocation: 'Main Warehouse',
  highValueThreshold: 5000,
  timezone: 'UTC',
  locale: 'en-US',
  defaultCountry: 'US',
};

/**
 * Get the active agent configuration.
 * Override values via environment variables or edit DEFAULT_CONFIG directly.
 */
export function getAgentConfig(env?: Record<string, string>): AgentConfig {
  return {
    companyName: env?.COMPANY_NAME || DEFAULT_CONFIG.companyName,
    agentName: env?.AGENT_NAME || DEFAULT_CONFIG.agentName,
    warehouseLocation: env?.WAREHOUSE_LOCATION || DEFAULT_CONFIG.warehouseLocation,
    highValueThreshold: env?.HIGH_VALUE_THRESHOLD ? parseInt(env.HIGH_VALUE_THRESHOLD, 10) : DEFAULT_CONFIG.highValueThreshold,
    timezone: env?.TIMEZONE || DEFAULT_CONFIG.timezone,
    locale: env?.LOCALE || DEFAULT_CONFIG.locale,
    defaultCountry: env?.DEFAULT_COUNTRY || DEFAULT_CONFIG.defaultCountry,
  };
}
