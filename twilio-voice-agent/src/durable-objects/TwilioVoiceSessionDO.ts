/**
 * TwilioVoiceSessionDO - Durable Object that bridges Twilio Media Streams
 * with OpenAI's Realtime API for voice-to-voice AI agent functionality.
 *
 * Architecture:
 * - Accepts a bidirectional WebSocket from Twilio (G.711 mu-law audio)
 * - Opens a WebSocket to OpenAI Realtime API (g711_ulaw format - no transcoding!)
 * - Bridges audio bidirectionally between the two
 * - Intercepts tool calls from OpenAI, executes them locally, returns results
 */

import { DurableObject } from 'cloudflare:workers';
import { getAgentInstructions, getToolDefinitions } from '../agents';
import { ToolExecutor } from '../tools/ToolExecutor';
import { ObservableLogger, ConversationPhase } from '../utils/ObservableLogger';
import type { CallSession } from '../tools/types';

interface Env {
  ANALYTICS: AnalyticsEngineDataset;
  PRODUCTS_INDEX: Vectorize;
  KB_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  TIMEZONE?: string;
  LOCALE?: string;
  MAX_CALL_DURATION_MINUTES?: string;
  OPENAI_REALTIME_MODEL?: string;
}

export class TwilioVoiceSessionDO extends DurableObject<Env> {
  // WebSocket connections
  private twilioWs: WebSocket | null = null;
  private openaiWs: WebSocket | null = null;

  // Session state
  private session: CallSession | null = null;

  // Twilio stream metadata
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private callerNumber: string | null = null;

  // Transcript tracking
  private transcriptSequence: number = 0;
  private pendingToolCalls: Array<{ name: string; arguments: any; call_id: string }> = [];
  private transcriptBuffer: Array<Record<string, any>> = [];

  // End call tracking
  private endCallRequested: boolean = false;
  private endCallMarkName: string | null = null;
  private markCounter: number = 0;

  // Utilities
  private toolExecutor: ToolExecutor | null = null;
  private logger: ObservableLogger | null = null;

  // Audio buffering (for early audio before OpenAI connects)
  private audioBuffer: string[] = [];
  private openaiReady: boolean = false;

  // Setup timing (for diagnostic logging)
  private setupStartTime: number = 0;

  // Note: wrapUpSent is persisted via ctx.storage to survive DO hibernation (Fix 5b)

  // Audio metrics
  private audioPacketsSent: number = 0;
  private audioPacketsReceived: number = 0;
  private lastAudioMetricLog: number = 0;

  // ============================================================
  // DIAGNOSTIC HELPERS
  // ============================================================

  /** Log a setup milestone with elapsed time since Twilio start */
  private logSetup(message: string): void {
    const elapsed = this.setupStartTime ? Date.now() - this.setupStartTime : 0;
    console.log(`[Setup +${elapsed}ms] ${message}`);
  }

  /** Time an async operation and log its duration */
  private async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      console.log(`[Timer] ${label}: ${Date.now() - start}ms`);
      return result;
    } catch (e) {
      console.error(`[Timer] ${label} FAILED after ${Date.now() - start}ms:`, e);
      throw e;
    }
  }

  // ============================================================
  // HTTP + WEBSOCKET ENTRY POINTS
  // ============================================================

  /**
   * Handle incoming HTTP requests - only WebSocket upgrades for Twilio Media Stream
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/twilio/media-stream') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      this.ctx.acceptWebSocket(server);
      this.twilioWs = server;

      console.log('[DO] Twilio WebSocket accepted');

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Handle WebSocket messages from Twilio Media Streams
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case 'connected':
          console.log('[Twilio] Connected event received');
          break;

        case 'start':
          await this.handleTwilioStart(data);
          break;

        case 'media':
          this.handleTwilioMedia(data);
          break;

        case 'dtmf':
          console.log(`[Twilio] DTMF digit: ${data.dtmf?.digit}`);
          break;

        case 'mark':
          this.handleTwilioMark(data);
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped');
          await this.handleCallEnd('twilio_stop');
          break;

        default:
          console.log(`[Twilio] Unknown event: ${data.event}`);
      }
    } catch (error) {
      console.error('[DO] Error handling Twilio message:', error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(`[Twilio] WebSocket closed: code=${code}, reason=${reason}, clean=${wasClean}`);
    await this.handleCallEnd('twilio_close');
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Twilio] WebSocket error:', error);
    await this.handleCallEnd('twilio_error');
  }

  // ============================================================
  // TWILIO EVENT HANDLERS
  // ============================================================

  /**
   * Handle Twilio 'start' event - Initialize session and connect to OpenAI
   */
  private async handleTwilioStart(data: any): Promise<void> {
    this.setupStartTime = Date.now();
    this.logSetup('Twilio start received');

    this.streamSid = data.start?.streamSid;
    this.callSid = data.start?.callSid;

    const params = data.start?.customParameters || {};
    this.callerNumber = params.callerNumber || 'unknown';
    const calledNumber = params.calledNumber || 'unknown';

    console.log(`[TwilioStart] streamSid=${this.streamSid}, callSid=${this.callSid}, caller=${this.callerNumber}, called=${calledNumber}`);

    // Initialize session
    this.session = {
      conversationId: null,
      callId: this.callSid || `twilio-${Date.now()}`,
      phoneNumber: this.callerNumber || 'unknown',
      startTime: Date.now(),
      customerData: {},
      lastAgentResponses: [],
      totalTurns: 0,
      lastToolCalled: null,
      consecutiveNoToolTurns: 0,
      conversationFinalized: false,
    };

    // Generate a local conversation ID
    const conversationId = `call_${this.session.callId}_${Date.now()}`;
    this.session.conversationId = conversationId;

    // Initialize tool executor + observability
    this.toolExecutor = new ToolExecutor(this.env as any, this.session, this.logger || undefined);
    this.initializeObservability(conversationId);

    // Connect to OpenAI Realtime API
    this.logSetup('Connecting to OpenAI...');
    await this.timed('connectToOpenAI', () => this.connectToOpenAI());
    this.logSetup(`Init complete. conversationId=${conversationId}`);

    // FIX 5: Set alarm using proper DO alarm (not setTimeout)
    const maxMinutes = parseInt(this.env.MAX_CALL_DURATION_MINUTES || '30', 10);
    const alarmTime = Date.now() + maxMinutes * 60 * 1000;
    await this.ctx.storage.setAlarm(alarmTime);
    this.logSetup(`Max call alarm set for ${maxMinutes} minutes`);
  }

  /**
   * Handle Twilio 'media' event - forward audio to OpenAI
   */
  private handleTwilioMedia(data: any): void {
    const payload = data.media?.payload;
    if (!payload) return;

    if (!this.openaiReady) {
      this.audioBuffer.push(payload);
      return;
    }

    this.sendAudioToOpenAI(payload);
  }

  /**
   * Handle Twilio 'mark' event - audio playback acknowledgment
   */
  private handleTwilioMark(data: any): void {
    const markName = data.mark?.name;
    console.log(`[Twilio] Mark acknowledged: ${markName}`);

    if (markName && markName === this.endCallMarkName) {
      console.log('[Twilio] End-call audio finished, closing connections');
      this.closeAllConnections('Call ended gracefully');
    }
  }

  // ============================================================
  // OPENAI REALTIME API
  // ============================================================

  /**
   * Connect to OpenAI Realtime API via WebSocket
   */
  private async connectToOpenAI(): Promise<void> {
    try {
      if (!this.env.OPENAI_API_KEY) {
        console.error('[OpenAI] OPENAI_API_KEY is not set!');
        return;
      }
      this.logSetup('Connecting to OpenAI...');

      const model = this.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2025-06-03';
      const openaiUrl = `https://api.openai.com/v1/realtime?model=${model}`;

      const response = await fetch(openaiUrl, {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.openaiWs = response.webSocket;
      if (!this.openaiWs) {
        console.error(`[OpenAI] WebSocket upgrade failed. HTTP status: ${response.status}`);
        const body = await response.text().catch(() => 'unable to read body');
        console.error(`[OpenAI] Response body: ${body}`);
        return;
      }

      this.openaiWs.accept();
      this.logSetup('OpenAI WebSocket connected');

      // Configure the session
      this.configureOpenAISession();

      // Set up event handlers
      this.openaiWs.addEventListener('message', async (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data as string);
          await this.handleOpenAIEvent(message);
        } catch (error) {
          console.error('[OpenAI] Error handling message:', error);
        }
      });

      this.openaiWs.addEventListener('close', async (event: CloseEvent) => {
        console.log(`[OpenAI] WebSocket closed: code=${event.code}, reason=${event.reason}`);
        this.openaiReady = false;
        await this.handleCallEnd('openai_close');
      });

      this.openaiWs.addEventListener('error', (error: Event) => {
        console.error('[OpenAI] WebSocket error:', error);
        this.openaiReady = false;
      });
    } catch (error) {
      console.error('[OpenAI] Connection error:', error);
    }
  }

  /**
   * Configure the OpenAI Realtime session.
   * Uses g711_ulaw to match Twilio Media Streams' native format.
   */
  private configureOpenAISession(): void {
    const instructions = getAgentInstructions(this.env as unknown as Record<string, string>);
    const tools = getToolDefinitions();

    const sessionConfig = {
      type: 'session.update',
      session: {
        model: this.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2025-06-03',
        instructions,
        tools,
        voice: 'alloy',
        temperature: 0.6,
        modalities: ['audio', 'text'],
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1',
          language: 'en',
        },
        input_audio_noise_reduction: {
          type: 'far_field',
        },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'medium',
        },
      },
    };

    this.openaiWs?.send(JSON.stringify(sessionConfig));
    this.logSetup(`Session config sent (${this.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2025-06-03'}, g711_ulaw)`);
  }

  /**
   * Handle events from OpenAI Realtime API
   * FIX 6: Logs ALL event types for diagnostics
   */
  private async handleOpenAIEvent(event: any): Promise<void> {
    try {
      // FIX 6: Log all OpenAI events (except high-frequency audio deltas)
      if (event.type !== 'response.audio.delta' && event.type !== 'input_audio_buffer.speech_started' && event.type !== 'input_audio_buffer.speech_stopped') {
        console.log(`[OpenAI Event] ${event.type}`);
      }

      switch (event.type) {
        case 'session.created':
          this.logSetup('OpenAI session created');
          break;

        case 'session.updated':
          this.openaiReady = true;
          this.logSetup('OpenAI session ready');
          this.flushAudioBuffer();
          // FIX 3: Trigger initial greeting so AI speaks first
          this.logSetup('Triggering initial greeting...');
          this.openaiWs?.send(JSON.stringify({ type: 'response.create' }));
          break;

        // Tool call completed - execute and return result
        case 'response.function_call_arguments.done':
          await this.handleToolCall(event);
          break;

        // Agent audio response - forward to Twilio
        case 'response.audio.delta':
          if (event.delta) {
            this.sendAudioToTwilio(event.delta);
          }
          break;

        // Agent finished speaking
        case 'response.audio.done':
          console.log(`[OpenAI] Audio response complete (packets sent to Twilio: ${this.audioPacketsSent})`);
          if (this.endCallRequested) {
            const markName = `end_call_${this.markCounter++}`;
            this.endCallMarkName = markName;
            this.twilioWs?.send(JSON.stringify({
              event: 'mark',
              streamSid: this.streamSid,
              mark: { name: markName },
            }));
            // Safety timeout: force close if Twilio mark never arrives
            setTimeout(() => {
              if (this.endCallRequested && !this.session?.conversationFinalized) {
                console.log('[EndCall] Safety timeout - mark never received, force closing');
                this.handleCallEnd('end_call_safety_timeout');
              }
            }, 10_000);
          }
          break;

        // User started speaking - handle barge-in
        case 'input_audio_buffer.speech_started':
          // Don't interrupt the farewell message during end_call
          if (this.endCallRequested) {
            console.log('[Barge-in] Ignoring during end_call sequence');
            break;
          }
          this.clearTwilioAudio();
          break;

        // User speech transcribed
        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) {
            console.log(`[Transcript] User: "${event.transcript.substring(0, 100)}"`);
            this.storeTranscript('user', event.transcript, { itemId: event.item_id });
          }
          break;

        // Agent speech transcribed
        case 'response.audio_transcript.done':
          if (event.transcript) {
            console.log(`[Transcript] Agent: "${event.transcript.substring(0, 100)}"`);

            const toolCallsForTranscript = this.pendingToolCalls.length > 0
              ? [...this.pendingToolCalls]
              : undefined;

            this.storeTranscript('assistant', event.transcript, {
              itemId: event.item_id,
              toolCalls: toolCallsForTranscript,
            });

            this.pendingToolCalls = [];

            // Loop detection
            this.session!.totalTurns++;
            this.session!.lastAgentResponses.push(event.transcript);
            if (this.session!.lastAgentResponses.length > 3) {
              this.session!.lastAgentResponses.shift();
            }

            if (this.detectLoop()) {
              console.warn(`[Loop] Detected in call ${this.session!.callId} - injecting guidance`);
              this.injectLoopBreaker();
            }
          }
          break;

        case 'response.done':
          if (event.response?.output) {
            const hasToolCall = event.response.output.some((o: any) => o.type === 'function_call');
            if (!hasToolCall) {
              this.session!.consecutiveNoToolTurns++;
            }
          }
          break;

        case 'error':
          console.error('[OpenAI] Error event:', JSON.stringify(event.error));
          this.logger?.log('error', 'OpenAI Realtime API error', { error: event.error });
          break;

        default:
          break;
      }
    } catch (error) {
      console.error(`[OpenAI] Error handling ${event.type}:`, error);
    }
  }

  // ============================================================
  // AUDIO BRIDGING
  // ============================================================

  private sendAudioToOpenAI(base64Audio: string): void {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;

    this.openaiWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    }));
    this.audioPacketsReceived++;
  }

  private sendAudioToTwilio(base64Audio: string): void {
    if (!this.twilioWs || !this.streamSid) return;

    try {
      this.twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: base64Audio },
      }));
      this.audioPacketsSent++;
    } catch (error) {
      console.error('[Twilio] Error sending audio:', error);
    }
  }

  private clearTwilioAudio(): void {
    if (!this.twilioWs || !this.streamSid) return;

    this.twilioWs.send(JSON.stringify({
      event: 'clear',
      streamSid: this.streamSid,
    }));
  }

  private flushAudioBuffer(): void {
    if (this.audioBuffer.length === 0) return;

    console.log(`[Audio] Flushing ${this.audioBuffer.length} buffered packets to OpenAI`);
    for (const audio of this.audioBuffer) {
      this.sendAudioToOpenAI(audio);
    }
    this.audioBuffer = [];
  }

  // ============================================================
  // TOOL EXECUTION
  // ============================================================

  /** Tools that involve network calls and benefit from the acknowledge-then-execute pattern */
  private static readonly SLOW_TOOLS = new Set([
    'search_products',
    'search_knowledge_base',
  ]);

  private async handleToolCall(event: any): Promise<void> {
    const toolName = event.name;
    const callId = event.call_id;

    console.log(`[Tool] Starting: ${toolName}`);

    this.session!.lastToolCalled = toolName;
    this.session!.consecutiveNoToolTurns = 0;

    let parsedArgs: any;
    try {
      parsedArgs = JSON.parse(event.arguments);
    } catch {
      parsedArgs = {};
    }

    this.pendingToolCalls.push({
      name: toolName,
      arguments: parsedArgs,
      call_id: callId,
    });

    // For slow tools (network calls), use acknowledge-then-execute pattern:
    // 1. Send placeholder function_call_output immediately to unblock the AI
    // 2. AI speaks a brief acknowledgment while we execute the tool
    // 3. When tool completes, inject real results and trigger final response
    if (TwilioVoiceSessionDO.SLOW_TOOLS.has(toolName) && this.openaiWs) {
      console.log(`[Tool] Using acknowledge-then-execute for ${toolName}`);

      // Step 1: Send placeholder output to unblock AI from waiting
      this.openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ status: 'processing' }),
        },
      }));

      // Step 2: Trigger brief acknowledgment (AI speaks while tool runs)
      this.openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions: 'Briefly tell the customer you are looking this up. One short sentence only, like "Let me check that for you." Do not apologize or over-explain.',
        },
      }));

      // Step 3: Execute tool in parallel with AI speaking
      const result = await this.executeToolCall(toolName, parsedArgs);

      // Step 4: Inject real results as system context and trigger response
      this.openaiWs?.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[System: ${toolName} results] ${JSON.stringify(result)}`,
          }],
        },
      }));

      this.openaiWs?.send(JSON.stringify({ type: 'response.create' }));
      console.log(`[Tool] ${toolName} result injected as context`);
    } else {
      // Fast tools: standard pattern (send result directly)
      const result = await this.executeToolCall(toolName, parsedArgs);

      this.openaiWs?.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }));

      this.openaiWs?.send(JSON.stringify({ type: 'response.create' }));
      console.log(`[Tool] ${toolName} result sent to OpenAI`);
    }
  }

  /**
   * Execute a tool call with timing
   * FIX 1: logToolCall is now fire-and-forget (non-blocking)
   */
  private async executeToolCall(name: string, args: any): Promise<any> {
    const startTime = Date.now();
    this.logger?.log('info', `Tool call started: ${name}`, { arguments: args });

    try {
      // Handle phase transitions
      if (name === 'collect_customer_info') {
        this.logger?.setPhase(ConversationPhase.CONTACT_DETAILS);
      } else if (name === 'collect_shipping_address') {
        this.logger?.setPhase(ConversationPhase.DELIVERY_ADDRESS);
      } else if (name === 'end_call') {
        this.logger?.setPhase(ConversationPhase.ENDING);
      }

      const result = await this.toolExecutor!.execute(name, args);

      if (result && typeof result === 'object' && result.error && !result.success) {
        this.logger?.log('error', `Tool returned error: ${name}`, { error: result.error });
      }

      if (name === 'end_call') {
        this.endCallRequested = true;
        console.log(`[EndCall] Requested with reason: ${args.reason}`);
      }

      const duration = Date.now() - startTime;
      console.log(`[Timer] Tool ${name}: ${duration}ms`);
      this.logger?.log('info', `Tool call completed: ${name}`, { duration_ms: duration });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';

      console.error(`[Timer] Tool ${name} FAILED: ${duration}ms - ${errMsg}`);
      this.logger?.log('error', `Tool call failed: ${name}`, { error: errMsg, duration_ms: duration });

      return { error: errMsg, success: false };
    }
  }

  // ============================================================
  // LOOP DETECTION
  // ============================================================

  private detectLoop(): boolean {
    const responses = this.session!.lastAgentResponses;
    if (responses.length < 2) return false;

    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const last = responses[responses.length - 1];
    const secondLast = responses[responses.length - 2];

    if (normalize(last) === normalize(secondLast)) return true;
    if (this.session!.consecutiveNoToolTurns >= 3) return true;

    return false;
  }

  private injectLoopBreaker(): void {
    this.openaiWs?.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'IMPORTANT: You have repeated yourself. The customer has already told you what they want. Use the search_products tool NOW with their product request. Do NOT ask clarifying questions - proceed with what you know.',
        }],
      },
    }));

    this.openaiWs?.send(JSON.stringify({ type: 'response.create' }));

    this.session!.consecutiveNoToolTurns = 0;
    this.session!.lastAgentResponses = [];
  }

  // ============================================================
  // LOGGING
  // ============================================================

  private initializeObservability(conversationId: string): void {
    this.logger = new ObservableLogger(conversationId);
    this.logger.log('info', 'Twilio voice session started', {
      call_id: this.session?.callId,
      phone: this.session?.phoneNumber,
      stream_sid: this.streamSid,
    });
  }

  /**
   * Store transcript in local buffer (used for loop detection and diagnostics)
   */
  private storeTranscript(
    role: string,
    content: string,
    options?: { itemId?: string; toolCalls?: any[] }
  ): void {
    if (!content || !this.session?.conversationId) return;

    this.transcriptBuffer.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      sequence_number: this.transcriptSequence++,
      item_id: options?.itemId || null,
      tool_calls: (options?.toolCalls && options.toolCalls.length > 0) ? options.toolCalls : null,
    });
  }

  // ============================================================
  // CALL LIFECYCLE
  // ============================================================

  private async handleCallEnd(source: string): Promise<void> {
    if (this.session?.conversationFinalized) return;

    console.log(`[handleCallEnd] Source: ${source}`);
    await this.finalizeConversation();
    this.closeAllConnections(`Call ended: ${source}`);
  }

  private async finalizeConversation(): Promise<void> {
    if (!this.session?.conversationId) return;
    if (this.session.conversationFinalized) return;
    this.session.conversationFinalized = true;

    try {
      const duration = Math.floor((Date.now() - this.session.startTime) / 1000);

      let conversionType: string | null = null;
      if (this.session.transferRequested) {
        conversionType = 'transfer';
      } else if (this.session.customerData.email) {
        conversionType = 'lead_capture';
      }

      console.log(`[Finalize] ${this.session.conversationId}: ${duration}s, ${this.transcriptSequence} turns, conversion=${conversionType || 'none'}, audio: sent=${this.audioPacketsSent} recv=${this.audioPacketsReceived}`);

      this.logger?.log('info', 'Conversation finalized', {
        duration_seconds: duration,
        total_turns: this.transcriptSequence,
        conversion_type: conversionType,
      });
    } catch (error) {
      console.error('[Finalize] Error:', error);
    }
  }

  private closeAllConnections(reason: string): void {
    console.log(`[closeAll] ${reason}`);
    if (this.openaiWs) {
      try { this.openaiWs.close(1000, reason); } catch (e) { /* already closed */ }
      this.openaiWs = null;
    }
    if (this.twilioWs) {
      try { this.twilioWs.close(1000, reason); } catch (e) { /* already closed */ }
      this.twilioWs = null;
    }
    this.openaiReady = false;
  }

  /**
   * FIX 5: Handle max call duration using two-phase DO alarms (not setTimeout)
   * Phase 1: Inject wrap-up message, schedule force-close alarm
   * Phase 2: Force close the call
   */
  async alarm(): Promise<void> {
    if (this.session?.conversationFinalized) return;

    // Use ctx.storage for wrapUpSent to survive DO hibernation
    const wrapUpSent = await this.ctx.storage.get<boolean>('wrapUpSent') ?? false;

    if (!wrapUpSent) {
      // Phase 1: Ask AI to wrap up
      console.log('[Alarm] Wrap-up phase - asking AI to finish conversation');
      await this.ctx.storage.put('wrapUpSent', true);

      if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{
              type: 'input_text',
              text: 'IMPORTANT: This call has reached the maximum duration. Please wrap up the conversation naturally, thank the customer, and call end_call.',
            }],
          },
        }));

        this.openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }

      // Schedule Phase 2: force close in 30 seconds
      await this.ctx.storage.setAlarm(Date.now() + 30000);
    } else {
      // Phase 2: Force close
      console.log('[Alarm] Force-close phase - terminating call');
      await this.handleCallEnd('max_duration');
    }
  }
}
