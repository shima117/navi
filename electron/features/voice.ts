import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { BackchannelEngine, type BackchannelMood } from '../../src/core/voice/BackchannelEngine';
import { classifyEcho } from '../../src/core/voice/EchoGuard';
import type { EventBus } from '../../src/core/events/EventBus';
import { FloorManager } from '../../src/core/voice/FloorManager';
import { classifyNaviInterrupt } from '../../src/core/voice/NaviInterrupt';
import { buildLipSyncTimeline } from '../../src/core/voice/LipSync';
import { chunkSpeech } from '../../src/core/voice/SpeechChunker';
import { assessTurnContinuation } from '../../src/core/voice/TurnContinuation';
import { VoiceDirector } from '../../src/core/voice/VoiceDirector';
import { VoicevoxClient } from '../../src/core/voice/VoicevoxClient';
import { IPC, type VoicePlaybackEvent, type VoiceServiceEvent } from '../ipc';
import { BackchannelCache } from '../backchannelCache';
import type { AppContext } from '../context';
import type { Feature } from './Feature';

const PREWARM = ['うん', 'はい', 'へえ', 'あー', 'え', 'えっ', 'あー……', 'んー……'];

/** Multi-source full-duplex floor, chunked TTS and backchannels (PR-11B-D). */
export const voiceFeature: Feature = {
  name: 'voice',
  setup(ctx) {
    const { bus, windows, orchestrator, settings } = ctx;
    const director = new VoiceDirector();
    const backchannels = new BackchannelEngine();
    const cache = new BackchannelCache();
    let generation = 0;
    let playbackText = '';
    let playbackStartedAt = 0;
    let interruptPending = false;
    let lastNaviInterruptAt = 0;
    let continuationPrefix = '';
    let pendingTranscript: { text: string; event: Extract<VoiceServiceEvent, { type: 'transcript' }>; timer: ReturnType<typeof setTimeout> } | null = null;
    let warmedVoiceId: string | null = null;
    let warming = false;

    const warmBackchannels = async () => {
      if (warming || !ctx.health.isHealthy('tts') || warmedVoiceId === ctx.voice.tts.id) return;
      warming = true;
      const adapter = ctx.voice.tts;
      try {
        await Promise.all(PREWARM.map((text) => cache.get(adapter, text, director.performance('neutral', 0.25, 'thin'))));
        warmedVoiceId = adapter.id;
      } catch (err) {
        console.warn('[voice] backchannel prewarm failed', err);
      } finally {
        warming = false;
        if (adapter.id !== ctx.voice.tts.id) void warmBackchannels();
      }
    };

    const floor = new FloorManager({
      fadeNavi: (fadeMs) => windows.push({ type: 'stopSpeech', fadeMs }),
      discardPendingChunks: () => {
        generation++;
      },
      stopLipSync: () => windows.sendAvatar(IPC.avatarLipSync, null),
      markInterrupted: () => bus.emit('voice.interrupted', { at: Date.now() }),
      onState: (state) => bus.emit('voice.floor_changed', { state, at: Date.now() }),
    });

    settings.onChange((next, prev) => {
      if (next.speakerId !== prev.speakerId) {
        ctx.voice.tts = new VoicevoxClient(next.speakerId);
        generation++;
        warmedVoiceId = null;
        void warmBackchannels();
      }
    });
    bus.on('health.changed', ({ service, ok }) => {
      if (service === 'tts' && ok) void warmBackchannels();
    });

    bus.on('friend.speak', ({ text, cue }) => {
      windows.push({ type: 'transcript', role: 'navi', text, at: Date.now() });
      playbackText = text;
      void speakChunks(ctx, floor, director, text, cue.emotion, cue.intensity, ++generation, () => generation);
    });

    ipcMain.handle(IPC.voiceStart, () => undefined);
    ipcMain.handle(IPC.voiceStop, () => undefined);
    ipcMain.handle(IPC.voiceSetDevice, async (_e, deviceId: string | null) => {
      await settings.patch({ micDeviceId: deviceId, audio: { ...settings.current.audio, userMicDeviceId: deviceId } });
    });

    ipcMain.on(IPC.voiceEvent, (_e, ev: VoiceServiceEvent) => {
      if (ev.type === 'speech_started') {
        if (ev.source === 'USER_MIC') {
          if (pendingTranscript) {
            clearTimeout(pendingTranscript.timer);
            continuationPrefix = pendingTranscript.text;
            pendingTranscript = null;
          }
          floor.userSpeechStarted(ev.source);
          if (!settings.current.audio.fullDuplex) {
            floor.userPartial({ text: '', durationMs: 1_000, energy: 1, final: true }, ev.source);
          }
          bus.emit('voice.speech_started', { at: ev.at, source: ev.source });
        }
        return;
      }
      if (ev.type === 'speech_ended') {
        if (ev.source === 'USER_MIC') {
          floor.userSpeechEnded(ev.source);
          bus.emit('voice.speech_ended', { at: ev.at, source: ev.source });
        }
        return;
      }
      if (ev.type === 'system_event') {
        bus.emit('audio.system_event', { at: ev.at, kind: ev.event, confidence: ev.confidence });
        return;
      }
      if (ev.type === 'partial') {
        if (ev.source !== 'USER_MIC') return;
        if (isPlaybackEcho(ev.text, ev.echoCorrelation ?? 0, playbackText, playbackStartedAt, floor.state)) return;
        bus.emit('voice.partial', ev);
        if (floor.userContinuedAfterNaviInterrupt()) return;
        const intent = floor.userPartial({ text: ev.text, durationMs: ev.durationMs, energy: ev.energy, final: false }, ev.source);
        if (intent !== 'TAKEOVER') {
          if (!interruptPending && ev.at - lastNaviInterruptAt >= 4_000) {
            interruptPending = true;
            void maybeNaviInterrupt(ctx, cache, director, ev.text, ev.durationMs, floor, (spoken) => { playbackText = spoken; })
              .then((spoke) => {
                if (spoke) lastNaviInterruptAt = ev.at;
                else void maybeBackchannel(ctx, cache, director, backchannels, ev.text, ev.durationMs, ev.at, floor, (spoken) => { playbackText = spoken; });
              })
              .finally(() => {
                interruptPending = false;
              });
          } else {
            void maybeBackchannel(ctx, cache, director, backchannels, ev.text, ev.durationMs, ev.at, floor, (spoken) => { playbackText = spoken; });
          }
        }
        return;
      }
      if (ev.type === 'transcript' && ev.text.trim()) {
        let text = ev.text.trim();
        if (ev.source === 'SYSTEM') {
          if (settings.current.audio.listenSystemAudio) bus.emit('audio.system_transcript', { text, at: ev.at });
          return;
        }
        if (ev.source === 'REMOTE') {
          if (settings.current.audio.remoteConversationContext) bus.emit('audio.remote_transcript', { text, at: ev.at });
          return;
        }
        if (ev.source !== 'USER_MIC') return;
        if (continuationPrefix) {
          text = `${continuationPrefix} ${text}`.trim();
          continuationPrefix = '';
        }
        if (isPlaybackEcho(text, ev.echoCorrelation ?? 0, playbackText, playbackStartedAt, floor.state)) return;
        floor.userContinuedAfterNaviInterrupt();
        const intent = floor.userPartial(
          { text, durationMs: ev.durationMs ?? 1_000, energy: ev.energy ?? 0.5, final: true },
          ev.source,
        );
        floor.userSpeechEnded(ev.source);
        if (settings.current.audio.userBackchannelRecognition && intent === 'BACKCHANNEL') return;
        const continuation = assessTurnContinuation({ text, pauseMs: 600, final: true });
        if (continuation.endTurn) {
          emitUserTranscript(bus, text, ev);
          return;
        }
        const extraWaitMs = continuation.continuationProbability >= 0.7 ? 600 : 300;
        const timer = setTimeout(() => {
          if (pendingTranscript?.timer !== timer) return;
          pendingTranscript = null;
          emitUserTranscript(bus, text, ev);
        }, extraWaitMs);
        pendingTranscript = { text, event: ev, timer };
      }
    });

    ipcMain.on(IPC.voicePlayback, (_e, event: VoicePlaybackEvent | 'started' | 'finished') => {
      const normalized: VoicePlaybackEvent = typeof event === 'string' ? { state: event, backchannel: false } : event;
      if (normalized.state === 'started') {
        playbackStartedAt = Date.now();
        if (normalized.mode === 'interrupt') floor.naviTakeoverStarted();
        else floor.naviStarted(normalized.backchannel);
        if (!normalized.backchannel) orchestrator.conversation.setSpeaking(true);
      } else {
        floor.naviFinished();
        if (!normalized.backchannel) orchestrator.conversation.setSpeaking(false);
      }
    });

  },
};

function emitUserTranscript(
  bus: EventBus,
  text: string,
  ev: Extract<VoiceServiceEvent, { type: 'transcript' }>,
): void {
  bus.emit('voice.transcript', { id: randomUUID(), text, source: 'voice', audioSource: 'USER_MIC', at: ev.at });
}

async function maybeNaviInterrupt(
  ctx: AppContext,
  cache: BackchannelCache,
  director: VoiceDirector,
  partial: string,
  durationMs: number,
  floor: FloorManager,
  rememberPlayback: (text: string) => void,
): Promise<boolean> {
  const audio = ctx.settings.current.audio;
  if (!audio.naviInterruptions || !ctx.health.isHealthy('tts') || floor.state !== 'USER_SPEAKING') return false;
  const decision = classifyNaviInterrupt({ text: partial, durationMs, level: audio.naviInterruptionLevel });
  if (decision.type !== 'SOFT_INTERRUPT' || !decision.text) return false;
  try {
    const result = await cache.get(ctx.voice.tts, decision.text, director.performance('surprised', 0.45, 'thin'));
    if (floor.state !== 'USER_SPEAKING') return false;
    rememberPlayback(decision.text);
    void sendPlaybackReference(result.audio);
    ctx.windows.push({
      type: 'speech',
      text: decision.text,
      audio: result.audio,
      lipsync: result.query ? buildLipSyncTimeline(result.query) : [],
      interrupt: decision.type,
    });
    return true;
  } catch (err) {
    console.warn('[voice] NAVI interrupt failed', err);
    return false;
  }
}

async function speakChunks(
  ctx: AppContext,
  floor: FloorManager,
  director: VoiceDirector,
  text: string,
  emotion: string,
  intensity: number,
  token: number,
  currentToken: () => number,
): Promise<void> {
  const { windows, health, orchestrator } = ctx;
  if (!floor.canStartNormalSpeech()) return;
  if (!health.isHealthy('tts')) {
    windows.push({ type: 'speech', text, audio: null, lipsync: [] });
    return;
  }
  const temperature = orchestrator.conversation.suggestTemperature(text);
  const performance = director.performance(emotion, intensity, temperature);
  try {
    for (const chunk of chunkSpeech(text)) {
      const { audio, query } = await ctx.voice.tts.synthesize(chunk.text, performance);
      if (token !== currentToken() || (!floor.canStartNormalSpeech() && floor.state !== 'NAVI_SPEAKING')) return;
      void sendPlaybackReference(audio);
      windows.push({
        type: 'speech',
        text: chunk.text,
        audio,
        lipsync: query ? buildLipSyncTimeline(query) : [],
        chunkId: chunk.id,
      });
    }
  } catch (err) {
    console.error('[tts] failed', err);
    health.reportFailure('tts');
    windows.push({ type: 'speech', text, audio: null, lipsync: [] });
  }
}

async function maybeBackchannel(
  ctx: AppContext,
  cache: BackchannelCache,
  director: VoiceDirector,
  engine: BackchannelEngine,
  partial: string,
  durationMs: number,
  at: number,
  floor: FloorManager,
  rememberPlayback: (text: string) => void,
): Promise<void> {
  if (!ctx.settings.current.audio.naviBackchannel || !ctx.health.isHealthy('tts')) return;
  if (floor.state !== 'USER_SPEAKING') return;
  const mood: BackchannelMood = /(?:えっ|嘘|まじ|高|万円|事故)/.test(partial) ? 'surprised' : /(?:困|無理|失敗|だめ)/.test(partial) ? 'concerned' : 'neutral';
  const phraseBoundary = /(?:[、。！？!?]|けど|て|で|から|ので|し)$/.test(partial.trim());
  const importantTokenActive = /(?:\d|円|時|分|型番|番地)$/.test(partial.trim());
  const decision = engine.decide({ now: at, userSpeechMs: durationMs, phraseBoundary, importantTokenActive, mood });
  if (!decision.speak || !decision.text) return;
  try {
    const result = await cache.get(ctx.voice.tts, decision.text, director.performance(mood === 'surprised' ? 'surprised' : 'neutral', 0.3, 'thin'));
    if (floor.state !== 'USER_SPEAKING') return;
    rememberPlayback(decision.text);
    void sendPlaybackReference(result.audio);
    ctx.windows.push({
      type: 'speech', text: decision.text, audio: result.audio,
      lipsync: result.query ? buildLipSyncTimeline(result.query) : [], backchannel: true,
    });
  } catch (err) {
    console.warn('[voice] backchannel failed', err);
  }
}

function isPlaybackEcho(text: string, audioCorrelation: number, playbackText: string, playbackStartedAt: number, floor: FloorManager['state']): boolean {
  const decision = classifyEcho({
    transcript: text,
    playbackText,
    audioCorrelation,
    playbackActive:
      floor === 'NAVI_SPEAKING' ||
      floor === 'NAVI_BACKCHANNEL' ||
      floor === 'NAVI_TAKEOVER' ||
      floor === 'OVERLAP' ||
      floor === 'USER_BACKCHANNEL',
    playbackAgeMs: Date.now() - playbackStartedAt,
  });
  return decision.echo;
}

async function sendPlaybackReference(audio: ArrayBuffer): Promise<void> {
  await fetch('http://127.0.0.1:17650/audio/reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: audio,
    signal: AbortSignal.timeout(1_500),
  }).catch(() => undefined);
}
