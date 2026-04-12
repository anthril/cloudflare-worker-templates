/**
 * Shared Tool Executor for voice agent template.
 *
 * Contains all tool implementations (product search, HubSpot CRM, freight, etc.)
 * used by both the OpenAI Realtime agent (VoiceSessionDO) and the ElevenLabs agent.
 *
 * Extracted from VoiceSessionDO.ts to enable code reuse across platforms.
 */

import type { CallSession, LineItem, ToolEnv, ToolLogger } from './types';

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
      case 'collect_billing_address':
        return this.collectBillingAddress(args);
      case 'add_line_item':
        return this.addLineItem(args);
      case 'update_line_item':
        return this.updateLineItem(args);
      case 'remove_line_item':
        return this.removeLineItem(args);
      case 'clear_line_items':
        return this.clearLineItems();
      case 'set_address_type':
        return this.setAddressType(args);
      case 'add_delivery_notes':
        return this.addDeliveryNotes(args);
      case 'search_products':
        return this.searchProducts(args.query);
      case 'search_knowledge_base':
        return this.searchKnowledgeBase(args.query);
      case 'create_hubspot_contact':
        return this.createHubSpotContact();
      case 'create_hubspot_company':
        return this.createHubSpotCompany();
      case 'create_hubspot_deal':
        return this.createHubSpotDeal(args);
      case 'create_hubspot_task':
        return this.createHubSpotTask(args);
      case 'calculate_freight':
        return this.calculateFreight(args);
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

  /**
   * Parse product dimensions from WooCommerce metadata attributes
   */
  parseProductDimensions(metadata: any): {
    length_cm: number;
    width_cm: number;
    height_cm: number;
    weight_kg: number;
  } | null {
    if (!metadata?.attributes) return null;

    let length_cm: number | null = null;
    let width_cm: number | null = null;
    let height_cm: number | null = null;
    let weight_kg: number | null = null;

    for (const attr of metadata.attributes) {
      const name = attr.name?.toLowerCase() || '';
      const value = attr.options?.[0] || '';

      if (name.includes('size')) {
        const lwh = value.match(/(\d+)\s*mm\s*[Ll]?\s*x\s*(\d+)\s*mm\s*[Ww]?\s*x\s*(\d+)\s*mm\s*[Hh]?/i);
        if (lwh) {
          length_cm = Math.round(parseInt(lwh[1]) / 10);
          width_cm = Math.round(parseInt(lwh[2]) / 10);
          height_cm = Math.round(parseInt(lwh[3]) / 10);
        }
        const simple = value.match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+)/i);
        if (simple && !lwh) {
          length_cm = Math.round(parseInt(simple[1]) / 10);
          width_cm = Math.round(parseInt(simple[2]) / 10);
          height_cm = Math.round(parseInt(simple[3]) / 10);
        }
      }

      if (name.includes('weight')) {
        const weightMatch = value.match(/(\d+(?:\.\d+)?)\s*[Kk][Gg]/);
        if (weightMatch) {
          weight_kg = parseFloat(weightMatch[1]);
        }
      }
    }

    if (length_cm || width_cm || height_cm || weight_kg) {
      return {
        length_cm: length_cm || 50,
        width_cm: width_cm || 50,
        height_cm: height_cm || 50,
        weight_kg: weight_kg || 10
      };
    }

    return null;
  }

  /**
   * Determine if item should ship as Carton or Pallet based on dimensions/weight
   */
  determineItemType(item: LineItem): 'Carton' | 'Pallet' {
    const totalWeight = (item.weight_kg || 10) * item.quantity;
    const maxDimension = Math.max(
      item.length_cm || 50,
      item.width_cm || 50,
      item.height_cm || 50
    );

    if (totalWeight > 30 || maxDimension > 120) {
      return 'Pallet';
    }
    return 'Carton';
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
          message: 'I couldn\'t find exact matches for that product. Could you describe what you\'re looking for in a different way, or tell me more about your application?'
        };
      }

      // Step 3: Enrich with full product data from KV for dimension parsing
      const products = await Promise.all(results.matches.map(async (match) => {
        const meta = match.metadata || {};
        let dims = null;

        const wooId = meta.woocommerce_id;
        if (wooId) {
          const fullData = await this.env.PRODUCT_DATA.get(`product:${wooId}`, 'json') as any;
          if (fullData?.attributes) {
            dims = this.parseProductDimensions({ attributes: fullData.attributes });
          }
        }

        return {
          name: (meta.name as string) || '',
          price: (meta.price as number) || 0,
          sku: (meta.sku as string) || '',
          description: (meta.short_description as string) || '',
          product_url: (meta.product_url as string) || null,
          product_image_url: (meta.product_image_url as string) || null,
          ...(dims && {
            length_cm: dims.length_cm,
            width_cm: dims.width_cm,
            height_cm: dims.height_cm,
            weight_kg: dims.weight_kg
          })
        };
      }));

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

  async collectBillingAddress(address: any): Promise<any> {
    this.session.billingAddress = {
      first_name: address.first_name || this.session.customerData.first_name,
      last_name: address.last_name || this.session.customerData.last_name,
      phone: address.phone || this.session.customerData.phone || this.session.phoneNumber,
      street: address.street,
      city: address.city,
      state: address.state,
      postcode: address.postcode,
      country: address.country || 'US'
    };

    return { success: true, message: 'Billing address recorded.' };
  }

  async addLineItem(item: any): Promise<any> {
    const existingIndex = this.session.lineItems.findIndex(
      existing => {
        if (item.sku && existing.sku) {
          return existing.sku === item.sku;
        }
        return existing.name.toLowerCase() === item.name.toLowerCase();
      }
    );

    if (existingIndex >= 0) {
      const existing = this.session.lineItems[existingIndex];
      return {
        success: false,
        needs_clarification: true,
        existing_quantity: existing.quantity,
        new_quantity: item.quantity || 1,
        product_name: item.name,
        message: `I already have ${existing.quantity}x ${item.name} on your quote. Did you want to change that to ${item.quantity || 1}, or add ${item.quantity || 1} more (total ${existing.quantity + (item.quantity || 1)})?`
      };
    }

    this.session.lineItems.push({
      name: item.name,
      sku: item.sku,
      quantity: item.quantity || 1,
      price: item.price || 0,
      description: item.description,
      length_cm: item.length_cm,
      width_cm: item.width_cm,
      height_cm: item.height_cm,
      weight_kg: item.weight_kg
    });

    return {
      success: true,
      message: `Added ${item.quantity || 1}x ${item.name} to quote.`,
      total_items: this.session.lineItems.length
    };
  }

  async updateLineItem(data: any): Promise<any> {
    const index = this.session.lineItems.findIndex(
      item => item.name.toLowerCase() === data.name.toLowerCase()
    );

    if (index >= 0) {
      const oldQty = this.session.lineItems[index].quantity;
      this.session.lineItems[index].quantity = data.new_quantity;
      return {
        success: true,
        message: `Updated ${data.name} from ${oldQty} to ${data.new_quantity} units.`
      };
    }

    return {
      success: false,
      message: `Could not find ${data.name} in the quote to update.`
    };
  }

  async removeLineItem(data: any): Promise<any> {
    const sku = data.sku;
    const name = data.name;
    let index = -1;

    if (sku) {
      index = this.session.lineItems.findIndex(item => item.sku === sku);
    }
    if (index < 0 && name) {
      index = this.session.lineItems.findIndex(
        item => item.name.toLowerCase() === name.toLowerCase()
      );
    }

    if (index >= 0) {
      const [removed] = this.session.lineItems.splice(index, 1);
      this.session.freightQuote = undefined;
      this.session.freightCalculationFailed = false;
      return {
        success: true,
        message: `Removed ${removed.name} from quote.`,
        removed_item: removed,
        total_items: this.session.lineItems.length
      };
    }

    return {
      success: false,
      message: sku
        ? `Could not find an item with SKU ${sku} in the quote.`
        : 'Could not find that item in the quote.'
    };
  }

  async clearLineItems(): Promise<any> {
    const previousItemCount = this.session.lineItems.length;
    this.session.lineItems = [];

    // Also clear freight quote since it's no longer valid
    this.session.freightQuote = undefined;
    this.session.freightCalculationFailed = false;

    return {
      success: true,
      message: `Cleared ${previousItemCount} item(s) from quote. Ready to start a new quote.`,
      items_cleared: previousItemCount
    };
  }

  async setAddressType(data: any): Promise<any> {
    const addressType = data.address_type;
    if (addressType === 'Commercial' || addressType === 'Residential') {
      this.session.addressType = addressType;
      return { success: true, message: `Address type set to ${addressType}.` };
    }
    return { error: 'Invalid address type. Must be Commercial or Residential.' };
  }

  async addDeliveryNotes(data: any): Promise<any> {
    const notes = data.notes;
    if (notes) {
      if (this.session.deliveryNotes) {
        this.session.deliveryNotes += '\n' + notes;
      } else {
        this.session.deliveryNotes = notes;
      }
      return { success: true, message: 'Delivery notes recorded.' };
    }
    return { error: 'No notes provided.' };
  }

  async createHubSpotContact(): Promise<any> {
    try {
      if (!this.env.HUBSPOT_API_KEY) {
        return { error: 'HubSpot API key not configured', success: false };
      }

      const customerData = this.session.customerData;

      if (!customerData.email) {
        return { error: 'Email is required to create HubSpot contact', success: false };
      }

      // Skip HubSpot search if we already have the contact ID (from searchExistingCustomer)
      if (this.session.hubspotContactId) {
        console.log(`Using cached HubSpot contact ID: ${this.session.hubspotContactId}`);
        // Update the existing contact with any new information
        const updateResponse = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${this.session.hubspotContactId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              firstname: customerData.first_name,
              lastname: customerData.last_name,
              phone: customerData.phone || this.session.phoneNumber,
              company: customerData.company,
              hs_lead_status: 'IN_PROGRESS'
            }
          })
        });

        if (!updateResponse.ok) {
          console.warn(`Failed to update existing contact ${this.session.hubspotContactId}:`, await updateResponse.text());
          // Don't fail - the contact exists, we just couldn't update it
        }

        return { success: true, contact_id: this.session.hubspotContactId, message: 'Using existing contact from previous lookup', skipped_search: true };
      }

      // Search for existing contact in HubSpot (with retry for transient failures)
      const searchResponse = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: customerData.email
            }]
          }]
        })
      });

      if (searchResponse.ok) {
        const searchResult = await searchResponse.json() as any;
        if (searchResult.total > 0) {
          const existingContact = searchResult.results[0];
          this.session.hubspotContactId = existingContact.id;
          console.log(`Found existing HubSpot contact: ${existingContact.id}`);

          await fetchWithRetry(`https://api.hubapi.com/crm/v3/objects/contacts/${existingContact.id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              properties: {
                firstname: customerData.first_name || existingContact.properties.firstname,
                lastname: customerData.last_name || existingContact.properties.lastname,
                phone: customerData.phone || this.session.phoneNumber || existingContact.properties.phone,
                company: customerData.company || existingContact.properties.company
              }
            })
          });

          return { success: true, contact_id: existingContact.id, message: 'Found existing contact in CRM' };
        }
      }

      // Create new contact (with retry for transient failures)
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            email: customerData.email,
            firstname: customerData.first_name,
            lastname: customerData.last_name,
            phone: customerData.phone || this.session.phoneNumber,
            company: customerData.company,
            hs_lead_status: 'IN_PROGRESS',
            lifecyclestage: 'lead'
          }
        })
      });

      if (response.ok) {
        const result = await response.json() as any;
        this.session.hubspotContactId = result.id;
        console.log(`Created new HubSpot contact: ${result.id}`);

        return { success: true, contact_id: result.id, message: 'Contact created in CRM' };
      } else {
        const errorText = await response.text();
        let errorDetail: any = {};
        try {
          errorDetail = JSON.parse(errorText);
        } catch {
          errorDetail = { message: errorText };
        }

        // Enhanced error logging with actionable details
        console.error(JSON.stringify({
          level: 'error',
          message: 'HubSpot contact creation failed',
          status: response.status,
          statusText: response.statusText,
          error: errorDetail,
          email: this.session.customerData?.email,
          conversation_id: this.session.conversationId
        }));

        // Provide specific error messages based on HTTP status
        if (response.status === 401 || response.status === 403) {
          return {
            success: false,
            error: 'HubSpot authentication failed. Please verify API credentials are correct.',
            details: errorDetail.message || errorText
          };
        } else if (response.status === 409) {
          // Contact already exists - treat as success since we need the contact for deal creation
          // Try to find the existing contact and return it
          console.log('Contact already exists (409), searching for existing contact by email...');
          const searchRetry = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/contacts/search', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              filterGroups: [{
                filters: [{
                  propertyName: 'email',
                  operator: 'EQ',
                  value: customerData.email
                }]
              }]
            })
          });

          if (searchRetry.ok) {
            const searchResult = await searchRetry.json() as any;
            if (searchResult.total > 0) {
              const existingContact = searchResult.results[0];
              this.session.hubspotContactId = existingContact.id;
              console.log(`Found existing contact after 409: ${existingContact.id}`);
              return { success: true, contact_id: existingContact.id, message: 'Using existing contact from CRM' };
            }
          }

          // If search fails, return error
          return {
            success: false,
            error: 'Contact with this email already exists but could not be retrieved.',
            details: errorDetail.message || errorText
          };
        } else if (response.status === 400) {
          return {
            success: false,
            error: 'Invalid contact data provided to HubSpot.',
            details: errorDetail.message || errorText
          };
        } else {
          return {
            success: false,
            error: 'Failed to create contact in HubSpot CRM.',
            details: errorDetail.message || errorText
          };
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: 'error',
        message: 'Exception creating HubSpot contact',
        error: errorMessage,
        email: this.session.customerData?.email,
        conversation_id: this.session.conversationId
      }));

      return {
        success: false,
        error: 'Network or system error creating contact.',
        details: errorMessage
      };
    }
  }

  async createHubSpotCompany(): Promise<any> {
    try {
      if (!this.env.HUBSPOT_API_KEY) {
        return { error: 'HubSpot API key not configured', success: false };
      }

      const customerData = this.session.customerData;

      if (!customerData.company) {
        return { success: true, message: 'No company to create' };
      }

      // Search for existing company (with retry)
      const searchResponse = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/companies/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'name',
              operator: 'EQ',
              value: customerData.company
            }]
          }]
        })
      });

      if (searchResponse.ok) {
        const searchResult = await searchResponse.json() as any;
        if (searchResult.total > 0) {
          const existingCompany = searchResult.results[0];
          this.session.hubspotCompanyId = existingCompany.id;
          console.log(`Found existing HubSpot company: ${existingCompany.id}`);

          if (this.session.hubspotContactId) {
            await fetchWithRetry(`https://api.hubapi.com/crm/v3/objects/contacts/${this.session.hubspotContactId}/associations/companies/${existingCompany.id}/280`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
                'Content-Type': 'application/json'
              }
            });
          }

          return { success: true, company_id: existingCompany.id, message: 'Found existing company in CRM' };
        }
      }

      // Create new company (with retry)
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/companies', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            name: customerData.company,
            phone: customerData.phone,
            lifecyclestage: 'lead',
            ...(customerData.tax_id ? { tax_id: customerData.tax_id } : {})
          }
        })
      });

      if (response.ok) {
        const result = await response.json() as any;
        this.session.hubspotCompanyId = result.id;
        console.log(`Created new HubSpot company: ${result.id}`);

        if (this.session.hubspotContactId) {
          await fetchWithRetry(`https://api.hubapi.com/crm/v3/objects/contacts/${this.session.hubspotContactId}/associations/companies/${result.id}/280`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
              'Content-Type': 'application/json'
            }
          });
        }

        return { success: true, company_id: result.id, message: 'Company created in CRM' };
      } else {
        const error = await response.text();
        console.error('HubSpot company creation failed:', error);
        return { error: 'Failed to create company' };
      }
    } catch (error) {
      console.error('Error creating HubSpot company:', error);
      return { error: 'Error creating company' };
    }
  }

  async createHubSpotDeal(data: any): Promise<any> {
    try {
      if (!this.env.HUBSPOT_API_KEY) {
        return { error: 'HubSpot API key not configured', success: false };
      }

      // Early validation: email is required for contact creation
      if (!this.session.customerData.email) {
        console.error('Deal creation failed: No customer email available', {
          customerData: this.session.customerData
        });
        return {
          error: 'Customer email is required to create a deal. Please collect the customer email first.',
          success: false
        };
      }

      // Ensure contact exists - validate return value
      if (!this.session.hubspotContactId) {
        console.log('Creating HubSpot contact for deal...');
        const contactResult = await this.createHubSpotContact();

        // Explicit validation: ensure we have a valid contact ID (string with length > 0)
        if (!contactResult.success) {
          console.error('Contact creation failed, cannot proceed with deal:', {
            result: contactResult,
            customerData: this.session.customerData
          });
          return {
            error: 'Failed to create contact - cannot proceed with deal creation',
            details: contactResult.error || 'Contact creation returned failure',
            success: false
          };
        }

        // Double-check that contact ID is actually set
        if (!this.session.hubspotContactId || typeof this.session.hubspotContactId !== 'string') {
          console.error('Contact created but ID not stored in session:', {
            result: contactResult,
            sessionContactId: this.session.hubspotContactId
          });
          return {
            error: 'Contact creation succeeded but ID was not properly stored',
            details: 'Internal error: hubspotContactId not set after successful contact creation',
            success: false
          };
        }
      }

      console.log(`Proceeding with deal creation. Contact ID: ${this.session.hubspotContactId}`);

      // Ensure company exists if customer has company - validate return value
      if (!this.session.hubspotCompanyId && this.session.customerData.company) {
        const companyResult = await this.createHubSpotCompany();
        if (!companyResult.success) {
          console.warn('Company creation failed, proceeding without company association:', companyResult);
          // Don't fail the deal - company is optional
        }
      }

      const customerName = `${this.session.customerData.first_name || ''} ${this.session.customerData.last_name || ''}`.trim() || 'Unknown';
      const dealName = `Quote Request - ${customerName}`;

      const lineItemsTotal = this.session.lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const dealNotesContent = this.buildDealNotes();

      // Validate HubSpot configuration
      if (!this.env.HUBSPOT_PIPELINE_ID || !this.env.HUBSPOT_DEAL_STAGE_ID) {
        console.error('HubSpot deal creation failed: Missing HUBSPOT_PIPELINE_ID or HUBSPOT_DEAL_STAGE_ID in environment');
        return { error: 'HubSpot deal configuration missing. Please configure HUBSPOT_PIPELINE_ID and HUBSPOT_DEAL_STAGE_ID.', success: false };
      }

      const dealProperties: Record<string, any> = {
        dealname: dealName,
        amount: lineItemsTotal,
        dealstage: this.env.HUBSPOT_DEAL_STAGE_ID,
        pipeline: this.env.HUBSPOT_PIPELINE_ID,
        ...(this.env.HUBSPOT_OWNER_ID && { hubspot_owner_id: this.env.HUBSPOT_OWNER_ID }),
        closedate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        description: data.notes || this.session.conversationSummary || '',
        deal_notes: dealNotesContent
      };

      if (this.session.freightQuote?.cost) {
        dealProperties.shipping = this.session.freightQuote.cost;
      }

      if (this.session.addressType) {
        dealProperties.address_type = this.session.addressType;
      }

      if (this.session.shippingAddress) {
        dealProperties.address_line_1_shipping = this.session.shippingAddress.street;
        dealProperties.city_shipping = this.session.shippingAddress.city;
        dealProperties.state_shipping = this.session.shippingAddress.state;
        dealProperties.postcode_shipping = this.session.shippingAddress.postcode;
        dealProperties.country_region_shipping = this.session.shippingAddress.country;
        if (this.session.shippingAddress.first_name) {
          dealProperties.first_name_shipping = this.session.shippingAddress.first_name;
        }
        if (this.session.shippingAddress.last_name) {
          dealProperties.last_name_shipping = this.session.shippingAddress.last_name;
        }
        if (this.session.shippingAddress.phone) {
          dealProperties.phone_shipping = this.session.shippingAddress.phone;
        }
      }

      const billingAddr = this.session.billingAddress || this.session.shippingAddress;
      if (billingAddr) {
        dealProperties.address_line_1 = billingAddr.street;
        dealProperties.city = billingAddr.city;
        dealProperties.state = billingAddr.state;
        dealProperties.postcode = billingAddr.postcode;
        dealProperties.country_region = billingAddr.country;
        if (billingAddr.first_name) {
          dealProperties.first_name = billingAddr.first_name;
        }
      }

      const associations: any[] = [];
      if (this.session.hubspotContactId) {
        associations.push({
          to: { id: this.session.hubspotContactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
        });
      }
      if (this.session.hubspotCompanyId) {
        associations.push({
          to: { id: this.session.hubspotCompanyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }]
        });
      }

      // Create deal (with retry for transient failures)
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties: dealProperties, associations })
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetail: any = {};
        try {
          errorDetail = JSON.parse(errorText);
        } catch {
          errorDetail = { message: errorText };
        }

        // Enhanced error logging with full context
        console.error(JSON.stringify({
          level: 'error',
          message: 'HubSpot deal creation failed',
          status: response.status,
          statusText: response.statusText,
          error: errorDetail,
          dealName,
          amount: lineItemsTotal,
          contactId: this.session.hubspotContactId,
          companyId: this.session.hubspotCompanyId,
          email: this.session.customerData?.email,
          conversation_id: this.session.conversationId
        }));

        // Provide specific error messages based on HTTP status
        if (response.status === 401 || response.status === 403) {
          return {
            success: false,
            error: 'HubSpot authentication failed. Please verify API credentials are correct.',
            details: errorDetail.message || errorText
          };
        } else if (response.status === 400) {
          // Check for common validation errors
          const errorMsg = errorDetail.message || errorText;
          if (errorMsg.includes('pipeline') || errorMsg.includes('dealstage')) {
            return {
              success: false,
              error: 'Invalid HubSpot pipeline or deal stage configuration.',
              details: `Pipeline ID: ${this.env.HUBSPOT_PIPELINE_ID}, Stage ID: ${this.env.HUBSPOT_DEAL_STAGE_ID}. ${errorMsg}`
            };
          } else if (errorMsg.includes('association')) {
            return {
              success: false,
              error: 'Failed to associate deal with contact or company.',
              details: `Contact ID: ${this.session.hubspotContactId}. ${errorMsg}`
            };
          } else {
            return {
              success: false,
              error: 'Invalid deal data provided to HubSpot.',
              details: errorMsg
            };
          }
        } else if (response.status === 404) {
          return {
            success: false,
            error: 'HubSpot contact or company not found. They may have been deleted.',
            details: errorDetail.message || errorText
          };
        } else {
          return {
            success: false,
            error: `Failed to create deal in HubSpot CRM (HTTP ${response.status}).`,
            details: errorDetail.message || errorText
          };
        }
      }

      const result = await response.json() as any;
      this.session.hubspotDealId = result.id;
      console.log(`Deal created: ${result.id}`);

      const freightCost = this.session.freightQuote?.cost || 0;
      const estimatedTotal = lineItemsTotal + freightCost;

      // Build tasks for batch creation (prepare data before parallel execution)
      const shippingAddressText = this.session.shippingAddress
        ? `${this.session.shippingAddress.street}\n${this.session.shippingAddress.city}, ${this.session.shippingAddress.state} ${this.session.shippingAddress.postcode}`
        : 'Not provided';

      const lineItemsSummary = this.session.lineItems.map(item => {
        const itemType = this.determineItemType(item);
        return `- ${item.quantity}x ${item.name} (${itemType}, ${item.weight_kg || 10}kg)`;
      }).join('\n');

      const tasksToCreate: Array<{
        subject: string;
        notes: string;
        priority: 'HIGH' | 'MEDIUM' | 'LOW';
        associateDeal: boolean;
      }> = [
        // Review task (always created)
        {
          subject: `Review Quote - ${customerName}`,
          notes: `Please review the quote request from ${customerName}.\n\nProducts requested: ${this.session.lineItems.length} items\nEstimated value: $${estimatedTotal.toFixed(2)}${freightCost > 0 ? ` (includes $${freightCost.toFixed(2)} freight)` : ''}\n\nThis quote was generated from an AI voice call and requires human review before sending to customer.`,
          priority: 'HIGH',
          associateDeal: true
        }
      ];

      // Freight task (varies based on calculation status)
      if (this.session.freightCalculationFailed) {
        tasksToCreate.push({
          subject: `Calculate Freight - ${customerName}`,
          notes: `URGENT: Freight calculation failed during the call.\n\nShipping Address:\n${shippingAddressText}\n\nAddress Type: ${this.session.addressType || 'Not specified'}\n\nLine Items:\n${lineItemsSummary}\n\nPlease calculate freight costs manually and update the quote before sending to customer.`,
          priority: 'HIGH',
          associateDeal: true
        });
      } else {
        tasksToCreate.push({
          subject: `Verify Freight Quote - ${customerName}`,
          notes: `Please verify AI-generated freight quote before sending to customer.\n\nFreight Quote:\n- Carrier: ${this.session.freightQuote?.carrier || 'Unknown'}\n- Cost: $${this.session.freightQuote?.cost?.toFixed(2) || '0.00'}\n- Transit: ${this.session.freightQuote?.transitDays || 3} business days\n\nShipping Address:\n${shippingAddressText}\n\nAddress Type: ${this.session.addressType || 'Not specified'}\n\nLine Items:\n${lineItemsSummary}\n\nVerify dimensions and weights are correct for freight calculation.`,
          priority: 'MEDIUM',
          associateDeal: true
        });
      }

      // Generate conversation summary before parallel execution
      const conversationSummary = this.generateConversationSummary();

      // Execute all post-deal operations in parallel for maximum performance
      // These operations are independent and can run concurrently
      const parallelOperations: Promise<any>[] = [
        // Create tasks (batch API)
        this.createHubSpotTasksBatch(tasksToCreate, result.id),
        // Add conversation summary note
        this.addDealNote(result.id, conversationSummary)
      ];

      // Only add line items if there are any
      if (this.session.lineItems.length > 0) {
        parallelOperations.push(this.createHubSpotLineItems(result.id));
      }

      // Fire-and-forget post-deal operations — don't block the AI response
      Promise.all(parallelOperations)
        .then(() => console.log(`Completed all post-deal operations for deal ${result.id}`))
        .catch(err => console.error(`Post-deal operations failed for deal ${result.id}:`, err));

      return { success: true, deal_id: result.id, message: 'Quote request created in CRM with all details' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const totalAmount = this.session.lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

      console.error(JSON.stringify({
        level: 'error',
        message: 'Exception creating HubSpot deal',
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        email: this.session.customerData?.email,
        amount: totalAmount,
        lineItemCount: this.session.lineItems.length,
        contactId: this.session.hubspotContactId,
        conversation_id: this.session.conversationId
      }));

      return {
        success: false,
        error: 'Network or system error creating deal.',
        details: errorMessage
      };
    }
  }

  /**
   * Create line items using HubSpot Batch API (single API call for all items).
   * This is much faster than creating items one by one.
   */
  async createHubSpotLineItems(dealId: string): Promise<void> {
    try {
      if (this.session.lineItems.length === 0) {
        return;
      }

      // Build batch inputs for all line items
      const inputs = this.session.lineItems.map(item => ({
        properties: {
          name: item.name,
          hs_sku: item.sku || '',
          quantity: item.quantity,
          price: item.price,
          description: item.description || ''
        },
        associations: [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
        }]
      }));

      // Use batch create endpoint - single API call for all line items (with retry)
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/line_items/batch/create', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to batch create line items:`, error);
        // Fallback to individual creation if batch fails
        console.log('Falling back to individual line item creation...');
        await this.createHubSpotLineItemsFallback(dealId);
      } else {
        const result = await response.json() as any;
        console.log(`Batch created ${result.results?.length || 0} line items for deal ${dealId}`);
      }
    } catch (error) {
      console.error('Error creating line items:', error);
    }
  }

  /**
   * Fallback: Create line items one by one if batch fails.
   */
  private async createHubSpotLineItemsFallback(dealId: string): Promise<void> {
    for (const item of this.session.lineItems) {
      try {
        const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/line_items', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              name: item.name,
              hs_sku: item.sku || '',
              quantity: item.quantity,
              price: item.price,
              description: item.description || ''
            },
            associations: [{
              to: { id: dealId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
            }]
          })
        });

        if (!response.ok) {
          console.error(`Failed to create line item ${item.name}:`, await response.text());
        }
      } catch (err) {
        console.error(`Error creating line item ${item.name}:`, err);
      }
    }
  }

  async addDealNote(dealId: string, noteBody: string): Promise<void> {
    try {
      // Create note with retry for transient failures
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            hs_note_body: noteBody,
            hs_timestamp: new Date().toISOString()
          },
          associations: [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
          }]
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Failed to add deal note:', error);
      }
    } catch (error) {
      console.error('Error adding deal note:', error);
    }
  }

  buildDealNotes(): string {
    let notes = '';

    if (this.session.addressType) {
      notes += `Address Type: ${this.session.addressType}\n`;
    }
    if (this.session.deliveryNotes) {
      notes += `\nDelivery Requirements:\n${this.session.deliveryNotes}\n`;
    }
    if (this.session.freightQuote) {
      notes += `\nFreight Quote:\n`;
      notes += `- Carrier: ${this.session.freightQuote.carrier}\n`;
      notes += `- Cost: $${this.session.freightQuote.cost.toFixed(2)}\n`;
      notes += `- Transit: ${this.session.freightQuote.transitDays} days\n`;
    } else if (this.session.freightCalculationFailed) {
      notes += `\n⚠️ FREIGHT CALCULATION FAILED - Manual quote required\n`;
    }

    if (this.session.lineItems.length > 0) {
      notes += `\nProducts:\n`;
      this.session.lineItems.forEach((item, idx) => {
        notes += `${idx + 1}. ${item.name} x${item.quantity} @ $${item.price.toFixed(2)}\n`;
      });
    }

    return notes || 'No additional notes';
  }

  generateConversationSummary(): string {
    const customer = this.session.customerData;
    const items = this.session.lineItems;
    const shipping = this.session.shippingAddress;
    const billing = this.session.billingAddress;
    const freight = this.session.freightQuote;

    let summary = `📞 AI Voice Call Summary\n`;
    summary += `========================\n\n`;
    summary += `📅 Call Date: ${new Date(this.session.startTime).toLocaleString(this.env.LOCALE || 'en-US', { timeZone: this.env.TIMEZONE || 'UTC' })}\n`;
    summary += `📱 Phone: ${this.session.phoneNumber}\n\n`;

    summary += `👤 Customer Information:\n`;
    summary += `- Name: ${customer.first_name || ''} ${customer.last_name || ''}\n`;
    summary += `- Email: ${customer.email || 'Not provided'}\n`;
    summary += `- Company: ${customer.company || 'Not provided'}\n\n`;

    if (items.length > 0) {
      summary += `🛒 Products Requested:\n`;
      let subtotal = 0;
      items.forEach((item, idx) => {
        const lineTotal = item.price * item.quantity;
        subtotal += lineTotal;
        summary += `${idx + 1}. ${item.name} (${item.sku || 'No SKU'})\n`;
        summary += `   Qty: ${item.quantity} × $${item.price.toFixed(2)} = $${lineTotal.toFixed(2)}\n`;
      });
      summary += `\nSubtotal: $${subtotal.toFixed(2)}\n`;
    }

    if (this.session.addressType) {
      summary += `\n🏢 Address Type: ${this.session.addressType}\n`;
    }

    if (shipping) {
      summary += `\n📦 Shipping Address:\n`;
      if (shipping.first_name || shipping.last_name) {
        summary += `${shipping.first_name || ''} ${shipping.last_name || ''}\n`;
      }
      summary += `${shipping.street}\n`;
      summary += `${shipping.city}, ${shipping.state} ${shipping.postcode}\n`;
      summary += `${shipping.country}\n`;
      if (shipping.phone) summary += `Phone: ${shipping.phone}\n`;
    }

    if (billing && billing !== shipping) {
      summary += `\n💳 Billing Address:\n`;
      if (billing.first_name || billing.last_name) {
        summary += `${billing.first_name || ''} ${billing.last_name || ''}\n`;
      }
      summary += `${billing.street}\n`;
      summary += `${billing.city}, ${billing.state} ${billing.postcode}\n`;
      summary += `${billing.country}\n`;
    }

    if (this.session.deliveryNotes) {
      summary += `\n🚨 Delivery Requirements:\n${this.session.deliveryNotes}\n`;
    }

    if (freight) {
      summary += `\n🚚 Freight Quote:\n`;
      summary += `- Carrier: ${freight.carrier}\n`;
      summary += `- Cost: $${freight.cost.toFixed(2)}\n`;
      summary += `- Transit: ${freight.transitDays} days\n`;
    } else if (this.session.freightCalculationFailed) {
      summary += `\n⚠️ Freight: CALCULATION FAILED - Manual quote required\n`;
    }

    summary += `\n---\nGenerated by AI Voice Agent`;
    return summary;
  }

  /**
   * Create multiple HubSpot tasks using Batch API (single API call).
   * Much faster than creating tasks sequentially.
   */
  async createHubSpotTasksBatch(tasks: Array<{
    subject: string;
    notes: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    associateDeal?: boolean;
  }>, dealId?: string): Promise<{ success: boolean; task_ids?: string[]; error?: string }> {
    try {
      if (!this.env.HUBSPOT_API_KEY) {
        return { success: false, error: 'HubSpot API key not configured' };
      }

      if (tasks.length === 0) {
        return { success: true, task_ids: [] };
      }

      // Build batch inputs for all tasks
      const inputs = tasks.map(task => {
        const associations: any[] = [];

        if (this.session.hubspotContactId) {
          associations.push({
            to: { id: this.session.hubspotContactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }]
          });
        }

        if (task.associateDeal && (dealId || this.session.hubspotDealId)) {
          associations.push({
            to: { id: dealId || this.session.hubspotDealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }]
          });
        }

        if (this.session.hubspotCompanyId) {
          associations.push({
            to: { id: this.session.hubspotCompanyId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 192 }]
          });
        }

        return {
          properties: {
            hs_task_subject: task.subject,
            hs_task_body: task.notes,
            hs_task_status: 'NOT_STARTED',
            hs_task_priority: task.priority,
            hs_timestamp: new Date(Date.now() + 45 * 60 * 1000).getTime()
          },
          associations
        };
      });

      // Use batch create endpoint - single API call for all tasks (with retry)
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/tasks/batch/create', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs })
      });

      if (response.ok) {
        const result = await response.json() as any;
        const taskIds = result.results?.map((r: any) => r.id) || [];
        console.log(`Batch created ${taskIds.length} tasks`);
        return { success: true, task_ids: taskIds };
      } else {
        const error = await response.text();
        console.error('HubSpot batch task creation failed:', error);
        // Fallback to individual task creation
        console.log('Falling back to individual task creation...');
        return await this.createHubSpotTasksFallback(tasks, dealId);
      }
    } catch (error) {
      console.error('Error in batch task creation:', error);
      // Fallback to individual task creation
      return await this.createHubSpotTasksFallback(tasks, dealId);
    }
  }

  /**
   * Fallback: Create tasks individually if batch API fails.
   */
  private async createHubSpotTasksFallback(tasks: Array<{
    subject: string;
    notes: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    associateDeal?: boolean;
  }>, dealId?: string): Promise<{ success: boolean; task_ids?: string[]; error?: string }> {
    const taskIds: string[] = [];
    for (const task of tasks) {
      const result = await this.createHubSpotTask({ ...task, dealId });
      if (result.task_id) {
        taskIds.push(result.task_id);
      }
    }
    return { success: taskIds.length > 0, task_ids: taskIds };
  }

  /**
   * Create a single HubSpot task. Used as fallback when batch API fails.
   */
  async createHubSpotTask(data: any): Promise<any> {
    try {
      if (!this.env.HUBSPOT_API_KEY) {
        return { error: 'HubSpot API key not configured', success: false };
      }

      const associations: any[] = [];

      if (this.session.hubspotContactId) {
        associations.push({
          to: { id: this.session.hubspotContactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }]
        });
      }

      if (data.associateDeal && (data.dealId || this.session.hubspotDealId)) {
        associations.push({
          to: { id: data.dealId || this.session.hubspotDealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }]
        });
      }

      if (this.session.hubspotCompanyId) {
        associations.push({
          to: { id: this.session.hubspotCompanyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 192 }]
        });
      }

      // Create single task with retry for transient failures
      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/tasks', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            hs_task_subject: data.subject || 'Follow up on voice call',
            hs_task_body: data.notes || '',
            hs_task_status: 'NOT_STARTED',
            hs_task_priority: data.priority || 'MEDIUM',
            hs_timestamp: new Date(Date.now() + 45 * 60 * 1000).getTime()
          },
          associations
        })
      });

      if (response.ok) {
        const result = await response.json() as any;
        console.log(`Task created: ${data.subject}`);
        return { success: true, task_id: result.id, message: 'Follow-up task created' };
      } else {
        const error = await response.text();
        console.error('HubSpot task creation failed:', error);
        return { error: 'Failed to create task' };
      }
    } catch (error) {
      console.error('Error creating HubSpot task:', error);
      return { error: 'Error creating task' };
    }
  }

  async calculateFreight(_data: any): Promise<any> {
    try {
      if (!this.session.shippingAddress) {
        this.session.freightCalculationFailed = true;
        return { error: 'Shipping address required for freight calculation' };
      }

      if (!this.session.lineItems || this.session.lineItems.length === 0) {
        this.session.freightCalculationFailed = true;
        return { error: 'No items in quote for freight calculation' };
      }

      // If no shipping API is configured, return a graceful fallback
      if (!this.env.SHIPPING_API_URL) {
        this.session.freightCalculationFailed = true;
        return {
          success: false,
          message: 'Shipping API not configured. Freight will be calculated manually.',
          freightCalculationFailed: true
        };
      }

      const lineItems = this.session.lineItems.map((item) => ({
          product_id: (item as any).product_id,
          sku: item.sku,
          name: item.name || 'Product',
          length_cm: item.length_cm,
          width_cm: item.width_cm,
          height_cm: item.height_cm,
          weight_kg: item.weight_kg,
          quantity: item.quantity || 1,
      }));

      // Replace this with your shipping provider's API format
      const response = await fetchWithRetry(this.env.SHIPPING_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.SHIPPING_API_KEY || ''}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          address_type: this.session.addressType,
          shipping_address: {
            city: this.session.shippingAddress.city,
            postcode: this.session.shippingAddress.postcode,
            state: this.session.shippingAddress.state,
            country: this.session.shippingAddress.country
          },
          line_items: lineItems
        })
      });

      if (response.ok) {
        const result = await response.json() as any;
        const selectedRoute = Array.isArray(result.routes) ? result.routes[0] : null;
        if (selectedRoute) {
          const carrierName = selectedRoute.service
            ? `${selectedRoute.carrier} (${selectedRoute.service})`
            : selectedRoute.carrier || 'Unknown';
          const priceIncGst = Number(selectedRoute.total || 0);
          const transitDays = Number(selectedRoute.transit_days || 0) || 3;

          this.session.freightCalculationFailed = false;
          this.session.freightQuote = {
            carrier: carrierName,
            cost: priceIncGst,
            transitDays: transitDays
          };

          return {
            success: true,
            carrier: carrierName,
            cost: priceIncGst,
            transit_days: transitDays,
            message: `Freight cost: $${priceIncGst.toFixed(2)} including GST via ${carrierName}`
          };
        } else {
          this.session.freightCalculationFailed = true;
          const dest = this.session.shippingAddress;
          return {
            error: `No freight options available for ${dest?.city || 'destination'}, ${dest?.state || ''} ${dest?.postcode || ''}`.trim(),
            message: 'I\'ll calculate freight manually and include it in your quote'
          };
        }
      } else {
        const error = await response.text();
        console.error('Freight calculation failed:', error);
        this.session.freightCalculationFailed = true;
        return {
          error: 'Unable to calculate freight at this time',
          message: 'I\'ll include freight calculation in your quote and email it to you'
        };
      }
    } catch (error) {
      console.error('Error calculating freight:', error);
      this.session.freightCalculationFailed = true;
      return {
        error: 'Error calculating freight',
        message: 'I\'ll calculate freight and include it in your emailed quote'
      };
    }
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
      'price_match': 'Price Match Request',
      'high_value_order': 'High Value Order - Sales Executive',
      'other': 'Other Inquiry'
    };

    const reasonLabel = reasonLabels[args.reason] || args.reason;
    const callbackNumber = args.callback_number || this.session.phoneNumber || 'Unknown';
    const customerName = this.session.customerData?.first_name
      ? `${this.session.customerData.first_name} ${this.session.customerData.last_name || ''}`.trim()
      : 'Unknown';

    try {
      // Ensure CRM objects are created before scheduling a task
      const contactResult = await this.createHubSpotContact();
      if (!contactResult.success) {
        console.warn('Transfer: contact creation failed', contactResult);
      }

      const companyResult = await this.createHubSpotCompany();
      if (companyResult.error) {
        console.warn('Transfer: company creation failed', companyResult);
      }

      const dealResult = await this.createHubSpotDeal({
        notes: `Transfer request: ${reasonLabel}\nSummary: ${args.summary}`
      });
      if (!dealResult.success) {
        console.warn('Transfer: deal creation failed', dealResult);
      }

      const taskSubject = `URGENT CALLBACK - ${reasonLabel}`;
      const taskNotes = `
**URGENT: Customer requires callback**

**Reason:** ${reasonLabel}
**Summary:** ${args.summary}

**Customer Details:**
- Name: ${customerName}
- Phone: ${callbackNumber}
- Email: ${this.session.customerData?.email || 'Not provided'}
- Company: ${this.session.customerData?.company || 'Not provided'}

**Action Required:** Please call the customer back as soon as possible.

---
*Generated by AI Voice Agent*
*Call ID: ${this.session.conversationId || 'Unknown'}*
      `.trim();

      await this.createHubSpotTask({
        subject: taskSubject,
        notes: taskNotes,
        priority: 'HIGH'
      });

      this.session.transferRequested = {
        reason: args.reason,
        summary: args.summary,
        callbackNumber: callbackNumber,
        timestamp: new Date().toISOString()
      };

      await this.sendSlackMessage({
        text: `${this.buildSlackMention()} New website chat transfer request.\n` +
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
      console.error('Error creating transfer task:', error);
      return {
        success: false,
        error: 'Failed to create callback task, but the customer has been informed someone will call back.'
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
