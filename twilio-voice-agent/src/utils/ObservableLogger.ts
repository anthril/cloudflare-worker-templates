/**
 * Observable Logger - Structured logging for voice agent with conversation context
 * All logs are JSON-formatted and output to console for Cloudflare observability
 */

export interface LogContext {
  conversation_id: string;
  customer_name?: string;
  phase: string;
  timestamp: string;
  session_id: string;
}

export class ObservableLogger {
  private context: LogContext;

  constructor(conversationId: string) {
    this.context = {
      conversation_id: conversationId,
      phase: 'initialization',
      timestamp: new Date().toISOString(),
      session_id: crypto.randomUUID()
    };
  }

  setPhase(phase: string) {
    this.context.phase = phase;
  }

  setCustomer(name: string) {
    this.context.customer_name = name;
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any) {
    const logEntry = {
      level,
      message,
      ...this.context,
      data,
      timestamp: new Date().toISOString()
    };

    console.log(JSON.stringify(logEntry));
  }
}

/**
 * Conversation Phase enum
 */
export enum ConversationPhase {
  INITIALIZATION = 'initialization',
  GREETING = 'greeting',
  PRODUCT_IDENTIFICATION = 'product_identification',
  QUANTITY_CONFIRMATION = 'quantity_confirmation',
  CONTACT_DETAILS = 'contact_details',
  DELIVERY_ADDRESS = 'delivery_address',
  DELIVERY_NOTES = 'delivery_notes',
  QUOTE_CREATION = 'quote_creation',
  ENDING = 'ending',
  TRANSFER = 'transfer',
  ERROR = 'error'
}
