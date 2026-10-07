import type { ChatMessage, OllamaClient } from '../ai/OllamaClient';
import type { ModelRouter } from '../ai/ModelRouter';
import type { EventBus } from '../events/EventBus';
import { ConversationManager } from '../conversation/ConversationManager';
import { buildSystemPrompt, type PersonaConfig } from '../conversation/persona';
import { parseCompanionResponse, SILENT_RESPONSE } from '../conversation/ResponseParser';
import { enforceStyle, splitSentences } from '../conversation/StyleEnforcer';
import {
  InitiativeScheduler,
  type InitiativeCandidate,
  type InitiativeDecision,
} from '../initiative/InitiativeScheduler';
import type { MemoryStore } from '../memory/MemoryStore';
import type { PluginHost } from '../plugins/PluginHost';
import { detectScreenReference } from '../screen/ScreenReference';
import type { VisionHints, VisionService } from '../screen/VisionService';
import type { FrameSummary } from '../screen/FrameSummary';
import { formatPrice, priceSignature, type ScreenOcr } from '../screen/OcrAnalysis';
import { RecentRegionChanges } from '../screen/RegionHash';
import type { CompanionResponse, PluginContext, PluginEvent, ScreenObservation, UserUtterance } from '../types';

export interface OrchestratorDeps {
  bus: EventBus;
  ollama: OllamaClient;
  router: ModelRouter;
  memory: MemoryStore;
  plugins: PluginHost;
  vision: VisionService | null;
  persona: PersonaConfig;
  /** Live health lookups; the orchestrator never blocks on a dead service. */
  isHealthy: (service: 'chat' | 'vision') => boolean;
  reportFailure?: (service: 'chat' | 'vision') => void;
  conversation?: ConversationManager;
  initiative?: InitiativeScheduler;
  now?: () => number;
  /** "静かめ" setting raises the initiative threshold. */
  quiet?: () => boolean;
  /** Is a screen share running? */
  sharing?: () => boolean;
}

interface TurnInput {
  kind: 'reply' | 'initiative';
  userText: string | null;
  candidate?: InitiativeCandidate;
  observation: ScreenObservation | null;
  /** The user referred to the screen but we could not see it. */
  screenUnavailable: boolean;
  pluginContext: PluginContext | null;
  toolResult?: { name: string; result: unknown };
  /** The observation is only OCR'd text: nothing beyond it may be claimed. */
  observationVia?: 'ocr';
}

const FOCUS_HOLD_MS = 20_000;
const PENDING_EVENT_TTL_MS = 15_000;
/** OCR text older than this no longer describes the screen. */
const OCR_FRESH_MS = 20_000;
/** The same price tag is not brought up again within this window. */
const PRICE_REPEAT_MS = 10 * 60_000;
const PRICE_TOPIC = 'ocr-price:';

/**
 * The single decision point for everything Navi says (design doc §6.1).
 * Vision and plugins only provide context; they never talk to the user.
 */
export class FriendOrchestrator {
  readonly conversation: ConversationManager;
  private readonly initiative: InitiativeScheduler;
  private readonly now: () => number;
  private turnSeq = 0;
  private inflight: AbortController | null = null;
  private userSpeaking = false;
  private focusUntil = 0;
  private screenActivity = 0;
  private pendingEvents: PluginEvent[] = [];
  private pendingScreenChange: FrameSummary | null = null;
  private latestOcr: ScreenOcr | null = null;
  private pendingPriceOcr: ScreenOcr | null = null;
  private surfacedPrices = new Map<string, number>();
  private readonly recentRegions = new RecentRegionChanges();

  constructor(private readonly deps: OrchestratorDeps) {
    this.conversation = deps.conversation ?? new ConversationManager();
    this.initiative = deps.initiative ?? new InitiativeScheduler();
    this.now = deps.now ?? Date.now;

    const { bus } = deps;
    bus.on('voice.transcript', (u) => void this.handleUtterance(u));
    bus.on('voice.speech_started', () => {
      this.userSpeaking = true;
    });
    bus.on('voice.interrupted', () => this.conversation.markInterrupted());
    bus.on('plugin.event', (e) => this.onPluginEvent(e));
    bus.on('screen.changed', (f) => {
      this.screenActivity = Math.max(this.screenActivity * 0.7, f.change);
      if (f.change >= 0.35) this.pendingScreenChange = f;
    });
    bus.on('screen.frame', (f) => {
      this.screenActivity = this.screenActivity * 0.9 + f.change * 0.1;
    });
    bus.on('screen.frame', (f) => this.onFrameRegions(f));
    bus.on('screen.ocr', (o) => this.onScreenOcr(o));
  }

  /** User turn from voice or the text box. Newer turns cancel older in-flight ones. */
  async handleUtterance(u: UserUtterance): Promise<CompanionResponse> {
    this.userSpeaking = false;
    const seq = ++this.turnSeq;
    this.inflight?.abort();
    const abort = new AbortController();
    this.inflight = abort;

    this.conversation.addUserTurn(u.text, u.at);

    const ref = detectScreenReference(u.text);
    let observation: ScreenObservation | null = null;
    let screenUnavailable = false;
    if (ref !== 'none') {
      observation = await this.look(ref, u.text, true, abort.signal);
      screenUnavailable = observation === null;
    }
    if (seq !== this.turnSeq) return { ...SILENT_RESPONSE };

    const pluginContext = observation ? await this.deps.plugins.enrich(observation) : null;
    return this.runTurn(
      seq,
      { kind: 'reply', userText: u.text, observation, screenUnavailable, pluginContext },
      abort.signal,
    );
  }

  /**
   * Periodic check (called every few seconds). Builds initiative candidates
   * from recent events and lets the scheduler decide; usually that is silence.
   */
  async considerInitiative(): Promise<InitiativeDecision> {
    const now = this.now();
    if (this.inflight) return { speak: false, score: 0, reason: 'busy' };
    if (!this.deps.isHealthy('chat')) return { speak: false, score: 0, reason: 'ai_offline' };

    this.pendingEvents = this.pendingEvents.filter((e) => now - e.at < PENDING_EVENT_TTL_MS);
    const snap = this.conversation.snapshot();
    const candidates: InitiativeCandidate[] = this.pendingEvents.map((e) => ({
      source: 'plugin',
      description: e.description,
      eventImportance: e.importance,
      novelty: 0.7,
      userInterest: this.conversation.interestScore(e.description),
      screenRelevance: 0.8,
      callbackValue: 0,
      topicKey: `${e.pluginId}:${e.kind}`,
    }));
    if (this.pendingScreenChange && this.deps.sharing?.()) {
      candidates.push({
        source: 'screen',
        description: '画面が大きく変わった',
        eventImportance: 0.35,
        novelty: 0.6,
        userInterest: 0.4,
        screenRelevance: 1,
        callbackValue: 0,
        topicKey: `screen:${this.pendingScreenChange.hash.slice(0, 6)}`,
      });
    }
    const priceCandidate = this.priceCandidate(now);
    if (priceCandidate) candidates.push(priceCandidate);
    const lastUser = [...snap.turns].reverse().find((t) => t.role === 'user');
    candidates.push({
      // Silence-driven: gated by InitiativeScheduler.minSilenceMs.
      source: lastUser ? 'silence' : 'own_topic',
      description: lastUser ? `少し前の話題「${lastUser.text}」の続き` : 'ナビ自身のどうでもいい話',
      eventImportance: 0.1,
      novelty: 0.4,
      userInterest: lastUser ? this.conversation.interestScore(lastUser.text) : 0.3,
      screenRelevance: 0,
      callbackValue: lastUser ? 0.6 : 0.2,
      topicKey: lastUser ? `callback:${lastUser.at}` : 'own_topic',
    });

    const decision = this.initiative.decide(candidates, {
      now,
      lastNaviSpeechAt: snap.lastSpeakAt,
      lastUserSpeechAt: snap.lastUserAt,
      userSpeaking: this.userSpeaking,
      focus: now < this.focusUntil,
      screenActivity: this.screenActivity,
      fatigue: snap.fatigue,
      quiet: this.deps.quiet?.() ?? false,
    });
    if (!decision.speak || !decision.candidate) return decision;

    const c = decision.candidate;
    if (c.source === 'plugin') this.pendingEvents = this.pendingEvents.filter((e) => e.description !== c.description);
    if (c.source === 'screen') this.pendingScreenChange = null;
    const priceOcr = this.takePriceOcr(c, now);

    const seq = ++this.turnSeq;
    const abort = new AbortController();
    this.inflight = abort;
    const { observation, observationVia } = await this.initiativeObservation(c, priceOcr, abort.signal);
    if (seq !== this.turnSeq) return { speak: false, score: decision.score, reason: 'superseded' };
    const pluginContext = observation ? await this.deps.plugins.enrich(observation) : null;
    const res = await this.runTurn(
      seq,
      {
        kind: 'initiative',
        userText: null,
        candidate: c,
        observation,
        observationVia,
        screenUnavailable: false,
        pluginContext,
      },
      abort.signal,
    );
    return { ...decision, speak: res.speak };
  }

  /** Stop whatever Navi is about to say (user pressed stop / barge-in). */
  interrupt(): void {
    this.turnSeq++;
    this.inflight?.abort();
    this.inflight = null;
    this.conversation.markInterrupted();
  }

  private onPluginEvent(e: PluginEvent): void {
    if (e.focus) this.focusUntil = Math.max(this.focusUntil, e.at + FOCUS_HOLD_MS);
    if (e.importance > 0.2) {
      this.pendingEvents.push(e);
      if (this.pendingEvents.length > 10) this.pendingEvents.shift();
    }
  }

  private onFrameRegions(f: FrameSummary): void {
    this.recentRegions.add(f);
    // A frame from another source means the share switched: old OCR text is not this screen.
    if (this.latestOcr && this.latestOcr.sourceId !== f.sourceId) {
      this.latestOcr = null;
      this.pendingPriceOcr = null;
    }
  }

  /** Prices / sale markers on the shared screen are worth a word: Navi is a penny-pincher (§9, §6.4). */
  private onScreenOcr(o: ScreenOcr): void {
    this.latestOcr = o;
    if (!worthMentioning(o)) return;
    const seen = this.surfacedPrices.get(ocrSignature(o));
    if (seen !== undefined && o.capturedAt - seen < PRICE_REPEAT_MS) return;
    this.pendingPriceOcr = o;
  }

  private priceCandidate(now: number): InitiativeCandidate | null {
    const o = this.pendingPriceOcr;
    if (!o || !this.deps.sharing?.()) return null;
    if (now - o.capturedAt > OCR_FRESH_MS) {
      this.pendingPriceOcr = null;
      return null;
    }
    const prices = knownPrices(o)
      .slice(0, 3)
      .map((p) => formatPrice(p))
      .join(' / ');
    const sale = o.sale ? `セール表示あり(${o.saleMarkers.join('・')})` : '';
    return {
      source: 'screen',
      description: prices
        ? `共有画面に値段が出ている: ${prices}${sale ? ` / ${sale}` : ''}`
        : `共有画面に${sale}`,
      eventImportance: 0.4,
      novelty: 0.8,
      userInterest: o.sale ? 1 : 0.85,
      screenRelevance: 1,
      callbackValue: 0,
      topicKey: `${PRICE_TOPIC}${ocrSignature(o)}`,
    };
  }

  /** The pending price OCR if `c` is its candidate; it is then marked as talked about. */
  private takePriceOcr(c: InitiativeCandidate, now: number): ScreenOcr | null {
    const o = this.pendingPriceOcr;
    if (!o || c.topicKey !== `${PRICE_TOPIC}${ocrSignature(o)}`) return null;
    this.pendingPriceOcr = null;
    for (const [sig, at] of this.surfacedPrices) if (now - at >= PRICE_REPEAT_MS) this.surfacedPrices.delete(sig);
    this.surfacedPrices.set(ocrSignature(o), now);
    return o;
  }

  /**
   * What Navi gets to "see" for an initiative turn. A price tag OCR already
   * read is enough on its own, so Vision is not woken for it; Vision runs only
   * when OCR cannot tell what is going on (§7.4).
   */
  private async initiativeObservation(
    c: InitiativeCandidate,
    priceOcr: ScreenOcr | null,
    signal: AbortSignal,
  ): Promise<{ observation: ScreenObservation | null; observationVia?: 'ocr' }> {
    if (priceOcr && knownPrices(priceOcr).length > 0) return { observation: ocrObservation(priceOcr), observationVia: 'ocr' };
    const observation =
      c.source === 'screen' || c.source === 'plugin' ? await this.look('current', null, false, signal) : null;
    if (!observation && priceOcr && !signal.aborted) return { observation: ocrObservation(priceOcr), observationVia: 'ocr' };
    return { observation };
  }

  /** Recent OCR text and changed screen areas, handed to Vision as hints (§7.4). */
  private visionHints(now: number): VisionHints | undefined {
    const ocr = this.latestOcr && now - this.latestOcr.capturedAt <= OCR_FRESH_MS ? this.latestOcr : null;
    const sourceId = ocr?.sourceId ?? this.recentRegions.sourceId;
    if (!sourceId) return undefined;
    const changedRegions = this.recentRegions.sourceId === sourceId ? this.recentRegions.labels(now) : [];
    if (!ocr && changedRegions.length === 0) return undefined;
    return { sourceId, ocrText: ocr?.text, changedRegions };
  }

  private async look(
    kind: 'current' | 'recent',
    userText: string | null,
    highPriority: boolean,
    signal: AbortSignal,
  ): Promise<ScreenObservation | null> {
    const { vision } = this.deps;
    if (!vision || !this.deps.isHealthy('vision') || !(this.deps.sharing?.() ?? true)) return null;
    try {
      const now = this.now();
      const obs = await vision.observe(kind, userText, { highPriority, now, signal, hints: this.visionHints(now) });
      if (obs) this.deps.bus.emit('screen.observed', obs);
      return obs;
    } catch (err) {
      if (!signal.aborted) {
        console.error('[FriendOrchestrator] vision failed:', err);
        this.deps.reportFailure?.('vision');
      }
      return null;
    }
  }

  private async runTurn(seq: number, input: TurnInput, signal: AbortSignal): Promise<CompanionResponse> {
    const { bus } = this.deps;
    try {
      if (!this.deps.isHealthy('chat')) {
        bus.emit('friend.silent', { reason: 'ai_offline' });
        return { ...SILENT_RESPONSE };
      }

      let res = await this.ask(input, signal);
      if (seq !== this.turnSeq) return { ...SILENT_RESPONSE };

      // One follow-up round for vision / tool requests.
      if (res.needs_vision && !input.observation && input.userText !== null) {
        const obs = await this.look('current', input.userText, true, signal);
        if (obs) {
          input = { ...input, observation: obs, screenUnavailable: false, pluginContext: await this.deps.plugins.enrich(obs) };
        } else {
          input = { ...input, screenUnavailable: true };
        }
        res = await this.ask(input, signal);
      } else if (res.needs_tool && this.deps.plugins.activePlugin) {
        const result = await this.deps.plugins.resolveTool(res.needs_tool.name, res.needs_tool.args);
        res = await this.ask({ ...input, toolResult: { name: res.needs_tool.name, result } }, signal);
      }
      if (seq !== this.turnSeq) return { ...SILENT_RESPONSE };

      res = await this.applyStyle(res, input, signal);
      if (seq !== this.turnSeq) return { ...SILENT_RESPONSE };
      this.commit(res);
      return res;
    } catch (err) {
      if (signal.aborted || seq !== this.turnSeq) return { ...SILENT_RESPONSE };
      console.error('[FriendOrchestrator] chat failed:', err);
      this.deps.reportFailure?.('chat');
      bus.emit('friend.silent', { reason: 'ai_error' });
      return { ...SILENT_RESPONSE };
    } finally {
      if (seq === this.turnSeq) this.inflight = null;
    }
  }

  private async applyStyle(res: CompanionResponse, input: TurnInput, signal: AbortSignal): Promise<CompanionResponse> {
    if (!res.speak) return res;
    const suppressQuestion = this.conversation.questionRate > 0.35;
    let styled = enforceStyle(res.text, { suppressTrailingQuestion: suppressQuestion });
    if (styled.needsRegenerate) {
      const retry = await this.ask({ ...input }, signal, 'さっきの返答は長すぎた。1〜2文で、もっと短く。');
      const retryStyled = enforceStyle(retry.text, { suppressTrailingQuestion: suppressQuestion });
      if (retry.speak && !retryStyled.needsRegenerate) {
        res = retry;
        styled = retryStyled;
      } else {
        // Still too long: keep the first two sentences.
        styled = enforceStyle(splitSentences(styled.text).slice(0, 2).join(''));
      }
    }
    if (!styled.text) return { ...res, speak: false, text: '' };
    return { ...res, text: styled.text };
  }

  private commit(res: CompanionResponse): void {
    const { bus, memory } = this.deps;
    const now = this.now();
    bus.emit('friend.response', res);
    this.conversation.applyTopicAction(res.topic_action);
    for (const m of res.memory_write) {
      memory.write(m, 'session', now);
      bus.emit('memory.write', { text: m, tier: 'session' });
    }
    if (!res.speak) {
      bus.emit('friend.silent', { reason: 'model_chose_silence' });
      return;
    }
    const styled = enforceStyle(res.text);
    this.conversation.addNaviTurn(res.text, now, styled.endsWithQuestion);
    const cue = { emotion: res.emotion, intensity: res.intensity, gaze: res.gaze, gesture: res.gesture };
    bus.emit('avatar.performance', cue);
    bus.emit('friend.speak', { text: res.text, cue });
  }

  private async ask(input: TurnInput, signal: AbortSignal, extraInstruction?: string): Promise<CompanionResponse> {
    const { model, keepAlive } = this.deps.router.chatModel();
    const raw = await this.deps.ollama.chat({
      model,
      keepAlive,
      format: 'json',
      options: { temperature: 0.8, num_predict: 300 },
      signal,
      messages: await this.buildMessages(input, extraInstruction),
    });
    return parseCompanionResponse(raw);
  }

  private async buildMessages(input: TurnInput, extraInstruction?: string): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(this.deps.persona) }];

    const context: string[] = [];
    const now = new Date(this.now());
    context.push(`現在時刻: ${now.getHours()}時${String(now.getMinutes()).padStart(2, '0')}分`);

    const pluginPrompt = await this.deps.plugins.promptContext();
    if (pluginPrompt) context.push(`ゲーム情報: ${pluginPrompt}`);

    const query = input.userText ?? input.candidate?.description ?? '';
    const memories = query ? this.deps.memory.recall(query, 3) : [];
    if (memories.length) context.push(`覚えていること: ${memories.map((m) => m.text).join(' / ')}`);

    if (input.observation) {
      const o = input.observation;
      context.push(
        `共有画面(${o.sourceName}): ${o.summary}` +
          (o.referent ? ` / 指している対象: ${o.referent}` : '') +
          (o.ocrText ? ` / 画面の文字: ${o.ocrText}` : ''),
      );
      if (input.observationVia === 'ocr') {
        context.push(
          '↑は画面の文字をOCRで読んだだけで、画像は見ていない（誤読もありうる）。文字に書いてあること以外（見た目・色・何の商品か）は言わない。',
        );
      }
    } else if (input.screenUnavailable) {
      context.push('画面は今見えていない。見えているふりをせず、見えないと正直に言う。');
    } else if (!(this.deps.sharing?.() ?? false)) {
      context.push('画面共有はされていない。');
    }
    if (input.pluginContext?.facts.length) context.push(`補足情報: ${input.pluginContext.facts.join(' / ')}`);
    if (input.toolResult) {
      context.push(`ツール ${input.toolResult.name} の結果: ${JSON.stringify(input.toolResult.result).slice(0, 1500)}`);
    }

    if (input.kind === 'reply' && input.userText) {
      context.push(`話の温度の目安: ${this.conversation.suggestTemperature(input.userText)}`);
    }
    if (input.kind === 'initiative' && input.candidate) {
      context.push(
        `今ユーザーは話しかけていない。きっかけ: ${input.candidate.description}。` +
          '自分から一言だけ言うなら言う。質問で終えない。言う価値がなければ speak=false。',
      );
    }
    if (extraInstruction) context.push(extraInstruction);
    messages.push({ role: 'system', content: context.join('\n') });

    for (const t of this.conversation.recentTurns(12)) {
      messages.push({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.role === 'navi' && t.interrupted ? `${t.text}（途中で遮られた）` : t.text,
      });
    }
    return messages;
  }
}

/** Prices with a known currency; a bare "1.2k" is too often a view count to react to. */
function knownPrices(o: ScreenOcr) {
  return o.prices.filter((p) => p.currency !== 'UNKNOWN');
}

function worthMentioning(o: ScreenOcr): boolean {
  return knownPrices(o).length > 0 || o.sale;
}

function ocrSignature(o: ScreenOcr): string {
  return priceSignature(knownPrices(o)) || `sale:${o.saleMarkers.join(',')}`;
}

/** A low-confidence observation that says no more than the OCR text does. */
function ocrObservation(o: ScreenOcr): ScreenObservation {
  const prices = knownPrices(o).map((p) => formatPrice(p));
  return {
    frameId: o.frameId,
    capturedAt: o.capturedAt,
    sourceId: o.sourceId,
    sourceName: o.sourceName,
    summary: prices.length ? `画面の文字に金額が見える: ${prices.join(' / ')}` : '画面の文字にセール表示が見える',
    ocrText: o.text,
    confidence: 0.3,
  };
}
