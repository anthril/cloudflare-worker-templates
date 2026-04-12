/**
 * Voice Agent Template - Twilio + OpenAI Realtime API
 *
 * Main entry point. Handles:
 * 1. POST /twilio/voice-webhook - Twilio incoming call webhook, returns TwiML
 * 2. GET/WS /twilio/media-stream - WebSocket upgrade for Twilio Media Streams
 * 3. GET /health - Health check
 */

import { TwilioVoiceSessionDO } from './durable-objects/TwilioVoiceSessionDO';
export { TwilioVoiceSessionDO };

export interface Env {
  VOICE_SESSION_DO: DurableObjectNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  PRODUCTS_INDEX: Vectorize;
  KB_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  WOOCOMMERCE_KEY: string;
  WOOCOMMERCE_SECRET: string;
  HUBSPOT_API_KEY: string;
  HUBSPOT_PIPELINE_ID?: string;
  HUBSPOT_DEAL_STAGE_ID?: string;
  HUBSPOT_OWNER_ID?: string;
  SHIPPING_API_URL?: string;
  SHIPPING_API_KEY?: string;
  ENVIRONMENT?: string;
  MAX_CALL_DURATION_MINUTES?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Health check
      if (url.pathname === '/health' && request.method === 'GET') {
        return Response.json(
          { status: 'ok', service: 'voice-agent', timestamp: new Date().toISOString() },
          { headers: CORS_HEADERS }
        );
      }

      // Twilio incoming call webhook
      if (url.pathname === '/twilio/voice-webhook' && request.method === 'POST') {
        return await handleTwilioIncomingCall(request, env);
      }

      // Twilio Media Stream WebSocket upgrade
      if (url.pathname === '/twilio/media-stream') {
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        // Use callSid from query params as Durable Object ID
        const callSid = url.searchParams.get('callSid') || `call-${Date.now()}`;
        const doId = env.VOICE_SESSION_DO.idFromName(callSid);
        const stub = env.VOICE_SESSION_DO.get(doId);

        // Forward the WebSocket upgrade request to the Durable Object
        return stub.fetch(request);
      }

      // Twilio call status callback (optional, for monitoring)
      if (url.pathname === '/twilio/status-callback' && request.method === 'POST') {
        const formData = await request.formData();
        const callSid = formData.get('CallSid') as string;
        const callStatus = formData.get('CallStatus') as string;
        console.log(`[Twilio Status] CallSid=${callSid}, Status=${callStatus}`);
        return new Response('OK', { status: 200 });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('[Worker] Unhandled error:', error);
      return Response.json(
        { error: 'Internal server error' },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },
};

/**
 * Handle Twilio's incoming call webhook.
 * Responds with TwiML that tells Twilio to open a bidirectional Media Stream
 * WebSocket to our Durable Object.
 */
async function handleTwilioIncomingCall(request: Request, env: Env): Promise<Response> {
  // Parse Twilio's form-encoded POST body
  const formData = await request.formData();
  const callSid = formData.get('CallSid') as string;
  const from = formData.get('From') as string;
  const to = formData.get('To') as string;
  const callerCity = formData.get('CallerCity') as string | null;
  const callerState = formData.get('CallerState') as string | null;

  console.log(`[Twilio] Incoming call: CallSid=${callSid}, From=${from}, To=${to}, City=${callerCity}, State=${callerState}`);

  // Build the WebSocket URL for Media Stream
  // Twilio will connect to this URL to stream audio bidirectionally
  const workerUrl = new URL(request.url);
  const wsUrl = `wss://${workerUrl.host}/twilio/media-stream?callSid=${encodeURIComponent(callSid)}`;

  // Respond with TwiML to start a bidirectional Media Stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="callerNumber" value="${from}" />
      <Parameter name="calledNumber" value="${to}" />
    </Stream>
  </Connect>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml',
    },
  });
}
