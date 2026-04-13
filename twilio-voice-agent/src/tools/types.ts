/**
 * Shared types for tool execution.
 */

export interface AddressInfo {
  first_name?: string;
  last_name?: string;
  phone?: string;
  street: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
}

export interface CustomerData {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  tax_id?: string;
}

export interface TransferRequest {
  reason: string;
  summary: string;
  callbackNumber: string;
  timestamp: string;
}

export interface CallSession {
  conversationId: string | null;
  callId: string;
  phoneNumber: string;
  startTime: number;
  customerData: CustomerData;
  shippingAddress?: AddressInfo;
  addressType?: 'Commercial' | 'Residential';
  lastAgentResponses: string[];
  totalTurns: number;
  lastToolCalled: string | null;
  consecutiveNoToolTurns: number;
  conversationFinalized: boolean;
  transferRequested?: TransferRequest;
}

/**
 * Environment bindings required by tool execution.
 */
export interface ToolEnv {
  PRODUCTS_INDEX: Vectorize;
  KB_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  SLACK_ACCESS_TOKEN?: string;
  SLACK_CHAT_REQUEST_CHANNEL?: string;
  SLACK_MENTION_USER_ID?: string;
  TIMEZONE?: string;
  LOCALE?: string;
}

/**
 * Minimal logger interface for tool execution observability.
 */
export interface ToolLogger {
  log(level: string, message: string, data?: any): void;
  setCustomer(name: string): void;
  setPhase(phase: string): void;
}
