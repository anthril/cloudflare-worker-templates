/**
 * Shared Tool Executor for voice agent template.
 *
 * Contains all tool implementations (product search, knowledge base, info collection, etc.)
 * used by both the OpenAI Realtime agent (VoiceSessionDO) and the ElevenLabs agent.
 *
 * Extracted from VoiceSessionDO.ts to enable code reuse across platforms.
 */

import type { CallSession, ToolEnv, ToolLogger } from './types';

/**
 * Utility function to sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch wrapper with exponential backoff retry logic.
 * Handles transient failures and rate limiting (429) gracefully.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelayMs - Base delay in milliseconds for exponential backoff (default: 500)
 * @returns The fetch response
 * @throws Error after all retries are exhausted
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 1,
  baseDelayMs: number = 500
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success or client error (4xx except 429) - don't retry
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response;
      }

      // Rate limited (429) - wait and retry
      if (response.status === 429) {
        await response.text().catch(() => {}); // MUST consume body in CF Workers
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * baseDelayMs;
        console.log(`Rate limited (429), waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
        await sleep(waitMs);
        continue;
      }

      // Server error (5xx) - retry with exponential backoff
      if (response.status >= 500) {
        await response.text().catch(() => {}); // MUST consume body in CF Workers
        const waitMs = Math.pow(2, attempt) * baseDelayMs;
        console.log(`Server error (${response.status}), waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
        await sleep(waitMs);
        continue;
      }

      // Unexpected status - return as-is
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Network error - retry with exponential backoff
      if (attempt < maxRetries - 1) {
        const waitMs = Math.pow(2, attempt) * baseDelayMs;
        console.log(`Network error, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}: ${lastError.message}`);
        await sleep(waitMs);
      }
    }
  }

  // All retries exhausted
  throw lastError || new Error(`fetchWithRetry: All ${maxRetries} attempts failed`);
}

export class ToolExecutor {
  constructor(
    private env: ToolEnv,
    private session: CallSession,
    private logger?: ToolLogger,
  ) {}

  /**
   * Execute a tool by name with the given arguments.
   * Returns the tool result object.
   */
  async execute(name: string, args: any): Promise<any> {
    switch (name) {
      case 'collect_customer_info':
        return this.collectCustomerInfo(args);
      case 'collect_shipping_address':
        return this.collectShippingAddress(args);
      case 'set_address_type':
        return this.setAddressType(args);
      case 'search_products':
        return this.searchProducts(args.query);
      case 'search_knowledge_base':
        return this.searchKnowledgeBase(args.query);
      case 'end_call':
        return this.endCall(args.reason);
      case 'transfer_to_human':
        return this.transferToHuman(args);
      case 'send_slack_message':
        return this.sendSlackMessage(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ============================================================
  // TOOL IMPLEMENTATIONS
  // ============================================================

  async collectCustomerInfo(data: any): Promise<any> {
    this.session.customerData = {
      ...this.session.customerData,
      ...data
    };

    if (data.first_name) {
      this.logger?.setCustomer(data.first_name);
    }

    return {
      success: true,
      message: `Thank you ${data.first_name}, I've recorded your information.`
    };
  }

  async searchProducts(query: string): Promise<any> {
    try {
      console.log(`Searching products for: "${query}"`);

      // Step 1: Generate embedding (timed)
      const embStart = Date.now();
      const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: query
        })
      });

      if (!embeddingRes.ok) {
        const errorText = await embeddingRes.text();
        console.error(`[searchProducts] Embedding API failed after ${Date.now() - embStart}ms (${embeddingRes.status}):`, errorText);
        return {
          products: [],
          message: 'I apologize, but I\'m having trouble searching our product catalog right now. Let me take note of your requirements and have someone follow up.'
        };
      }

      const embeddingData = await embeddingRes.json() as any;
      console.log(`[searchProducts] Embedding API: ${Date.now() - embStart}ms`);

      if (!embeddingData.data?.[0]?.embedding) {
        console.error('Invalid embedding response:', JSON.stringify(embeddingData).slice(0, 500));
        return {
          products: [],
          message: 'I apologize, but I\'m having trouble searching our product catalog right now. Let me take note of your requirements and have someone follow up.'
        };
      }

      const queryEmbedding = embeddingData.data[0].embedding;

      // Step 2: Vectorize similarity search (timed)
      const vecStart = Date.now();
      const results = await this.env.PRODUCTS_INDEX.query(queryEmbedding, {
        topK: 3,
        returnMetadata: 'all',
      });
      console.log(`[searchProducts] Vectorize query: ${Date.now() - vecStart}ms, found ${results.matches.length} products`);

      if (results.matches.length === 0) {
        return {
          products: [],
          message: 'I couldn\'t find exact matches for that product. Could you describe what you\'re looking for in a different way, or tell me more about what you need?'
        };
      }

      // Step 3: Map Vectorize metadata to product results
      const products = results.matches.map((match) => {
        const meta = match.metadata || {};
        return {
          name: (meta.name as string) || '',
          price: (meta.price as number) || 0,
          sku: (meta.sku as string) || '',
          description: (meta.short_description as string) || '',
          product_url: (meta.product_url as string) || null,
          product_image_url: (meta.product_image_url as string) || null,
        };
      });

      return {
        products,
        message: `I found ${products.length} products that match your requirements.`
      };
    } catch (error) {
      console.error('Error searching products:', error);
      return {
        products: [],
        message: 'Let me note your requirements and have someone follow up with product recommendations.'
      };
    }
  }

  async searchKnowledgeBase(query: string): Promise<any> {
    try {
      // Step 1: Generate embedding (timed)
      const embStart = Date.now();
      const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: query
        })
      });

      if (!embeddingRes.ok) {
        const errorText = await embeddingRes.text();
        console.error(`[searchKnowledgeBase] Embedding API failed after ${Date.now() - embStart}ms (${embeddingRes.status}):`, errorText);
        return {
          knowledge: [],
          message: 'No relevant information found in knowledge base.'
        };
      }

      const embeddingData = await embeddingRes.json() as any;
      console.log(`[searchKnowledgeBase] Embedding API: ${Date.now() - embStart}ms`);
      const queryEmbedding = embeddingData.data[0].embedding;

      // Step 2: Vectorize similarity search (timed)
      const vecStart = Date.now();
      const results = await this.env.KB_INDEX.query(queryEmbedding, {
        topK: 3,
        returnMetadata: 'all',
      });
      console.log(`[searchKnowledgeBase] Vectorize query: ${Date.now() - vecStart}ms, found ${results.matches.length} entries`);

      if (results.matches.length === 0) {
        return {
          knowledge: [],
          message: 'No relevant information found. I\'ll note your question for our team.'
        };
      }

      return {
        knowledge: results.matches.map((match) => ({
          title: (match.metadata?.title as string) || '',
          content: (match.metadata?.content as string) || '',
          category: (match.metadata?.category as string) || '',
          relevance: match.score
        })),
        message: `Found ${results.matches.length} relevant knowledge entries to help answer your question.`
      };
    } catch (error) {
      console.error('Error searching knowledge base:', error);
      return {
        knowledge: [],
        message: 'Unable to search knowledge base at this time.'
      };
    }
  }

  async collectShippingAddress(address: any): Promise<any> {
    this.session.shippingAddress = {
      first_name: address.first_name || this.session.customerData.first_name,
      last_name: address.last_name || this.session.customerData.last_name,
      phone: address.phone || this.session.customerData.phone || this.session.phoneNumber,
      street: address.street,
      city: address.city,
      state: address.state,
      postcode: address.postcode,
      country: address.country || 'US'
    };

    return { success: true, message: 'Shipping address recorded.' };
  }

  async setAddressType(data: any): Promise<any> {
    const addressType = data.address_type;
    if (addressType === 'Commercial' || addressType === 'Residential') {
      this.session.addressType = addressType;
      return { success: true, message: `Address type set to ${addressType}.` };
    }
    return { error: 'Invalid address type. Must be Commercial or Residential.' };
  }

  async transferToHuman(args: { reason: string; summary: string; callback_number?: string }): Promise<any> {
    console.log(`Transfer to human requested: ${args.reason} - ${args.summary}`);

    const reasonLabels: Record<string, string> = {
      'refund_request': 'Refund Request',
      'account_inquiry': 'Account Inquiry',
      'order_status': 'Order Status/Tracking',
      'complaint': 'Customer Complaint',
      'returns_exchange': 'Returns/Exchange',
      'payment_issue': 'Payment Issue',
      'other': 'Other Inquiry'
    };

    const reasonLabel = reasonLabels[args.reason] || args.reason;
    const callbackNumber = args.callback_number || this.session.phoneNumber || 'Unknown';
    const customerName = this.session.customerData?.first_name
      ? `${this.session.customerData.first_name} ${this.session.customerData.last_name || ''}`.trim()
      : 'Unknown';

    try {
      this.session.transferRequested = {
        reason: args.reason,
        summary: args.summary,
        callbackNumber: callbackNumber,
        timestamp: new Date().toISOString()
      };

      await this.sendSlackMessage({
        text: `${this.buildSlackMention()} New transfer request.\n` +
          `Reason: ${reasonLabel}\n` +
          `Summary: ${args.summary}\n` +
          `Name: ${customerName}\n` +
          `Phone: ${callbackNumber}\n` +
          `Email: ${this.session.customerData?.email || 'Not provided'}\n` +
          `Company: ${this.session.customerData?.company || 'Not provided'}\n` +
          `Conversation ID: ${this.session.conversationId || 'Unknown'}`
      });

      return {
        success: true,
        message: `Callback request created for ${reasonLabel}. A team member will call ${customerName} back shortly.`,
        callback_number: callbackNumber
      };
    } catch (error) {
      console.error('Error creating transfer request:', error);
      return {
        success: false,
        error: 'Failed to create callback request, but the customer has been informed someone will call back.'
      };
    }
  }

  async endCall(reason: string): Promise<any> {
    console.log(`Agent requested call end: ${reason}`);
    return {
      success: true,
      reason: reason,
      message: 'Call ended successfully'
    };
  }

  async sendSlackMessage(data: { text: string; channel?: string }): Promise<any> {
    if (!this.env.SLACK_ACCESS_TOKEN) {
      return { success: false, error: 'Slack access token not configured' };
    }

    const channel = data.channel || this.env.SLACK_CHAT_REQUEST_CHANNEL || 'website-chat-request';
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.env.SLACK_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          channel,
          text: data.text
        })
      });

      const result = await response.json() as any;
      if (!result.ok) {
        return { success: false, error: result.error || 'Slack API error' };
      }
      return { success: true, message_ts: result.ts };
    } catch (error) {
      return { success: false, error: 'Failed to send Slack message' };
    }
  }

  private buildSlackMention(): string {
    return this.env.SLACK_MENTION_USER_ID ? '<@' + this.env.SLACK_MENTION_USER_ID + '>' : '';
  }
}
