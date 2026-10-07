import { describe, expect, it, vi } from 'vitest';
import { BackchannelEngine } from '../src/core/voice/BackchannelEngine';
import { classifyEcho } from '../src/core/voice/EchoGuard';
import { FloorManager, TAKEOVER_FADE_MS } from '../src/core/voice/FloorManager';
import { classifyUserSpeech } from '../src/core/voice/InterruptionClassifier';
import { classifyNaviInterrupt } from '../src/core/voice/NaviInterrupt';
import { chunkSpeech } from '../src/core/voice/SpeechChunker';
import { assessTurnContinuation } from '../src/core/voice/TurnContinuation';
import { performanceFor } from '../src/core/voice/VoiceStyle';

describe('full-duplex floor control', () => {
  it('keeps NAVI speaking through a short user backchannel', () => {
    const actions = { fadeNavi: vi.fn(), discardPendingChunks: vi.fn(), stopLipSync: vi.fn(), markInterrupted: vi.fn() };
    const floor = new FloorManager(actions);
    floor.naviStarted();
    floor.userSpeechStarted('USER_MIC');
    expect(floor.userPartial({ text: 'うん', durationMs: 380, energy: 0.35, final: true }, 'USER_MIC')).toBe('BACKCHANNEL');
    expect(floor.state).toBe('USER_BACKCHANNEL');
    expect(actions.fadeNavi).not.toHaveBeenCalled();
  });

  it('fades and discards pending chunks on a real takeover', () => {
    const actions = { fadeNavi: vi.fn(), discardPendingChunks: vi.fn(), stopLipSync: vi.fn(), markInterrupted: vi.fn() };
    const floor = new FloorManager(actions);
    floor.naviStarted();
    floor.userSpeechStarted('USER_MIC');
    expect(floor.userPartial({ text: 'いや、ちょっと待って', durationMs: 700, energy: 0.6, final: false }, 'USER_MIC')).toBe('TAKEOVER');
    expect(actions.fadeNavi).toHaveBeenCalledWith(TAKEOVER_FADE_MS);
    expect(actions.discardPendingChunks).toHaveBeenCalledOnce();
    expect(actions.stopLipSync).toHaveBeenCalledOnce();
    expect(actions.markInterrupted).toHaveBeenCalledOnce();
  });

  it('never lets SYSTEM or REMOTE seize the user floor', () => {
    const actions = { fadeNavi: vi.fn(), discardPendingChunks: vi.fn(), stopLipSync: vi.fn(), markInterrupted: vi.fn() };
    const floor = new FloorManager(actions);
    floor.naviStarted();
    floor.userSpeechStarted('REMOTE');
    expect(floor.userPartial({ text: '止めて', durationMs: 900, energy: 1, final: true }, 'REMOTE')).toBeNull();
    expect(floor.state).toBe('NAVI_SPEAKING');
    expect(actions.fadeNavi).not.toHaveBeenCalled();
  });
});

describe('speech policies', () => {
  it('distinguishes backchannels, ambiguity, and takeover', () => {
    expect(classifyUserSpeech({ text: 'へえ', durationMs: 420, energy: 0.2, final: true })).toBe('BACKCHANNEL');
    expect(classifyUserSpeech({ text: 'え', durationMs: 180, energy: 0.2, final: false })).toBe('AMBIGUOUS');
    expect(classifyUserSpeech({ text: 'そこ違う', durationMs: 480, energy: 0.5, final: true })).toBe('TAKEOVER');
  });

  it('waits longer when the user ends on a filler', () => {
    const early = assessTurnContinuation({ text: 'それで、えっと', pauseMs: 600, final: true });
    const finished = assessTurnContinuation({ text: 'これで大丈夫です。', pauseMs: 600, final: true });
    expect(early.endTurn).toBe(false);
    expect(early.continuationProbability).toBeGreaterThan(finished.continuationProbability);
    expect(finished.endTurn).toBe(true);
  });

  it('chunks long speech on Japanese phrase boundaries', () => {
    const chunks = chunkSpeech('これは最初の文です。次は少し長い説明だけど、途中で自然に区切って話します。', 18);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 26)).toBe(true);
  });

  it('throttles NAVI backchannels and avoids important tokens', () => {
    const engine = new BackchannelEngine(2_000);
    expect(engine.decide({ now: 1_000, userSpeechMs: 1_500, phraseBoundary: true, importantTokenActive: false, mood: 'neutral' }).speak).toBe(true);
    expect(engine.decide({ now: 1_500, userSpeechMs: 2_000, phraseBoundary: true, importantTokenActive: false, mood: 'neutral' }).reason).toBe('throttled');
    expect(engine.decide({ now: 4_000, userSpeechMs: 2_000, phraseBoundary: true, importantTokenActive: true, mood: 'neutral' }).speak).toBe(false);
  });

  it('allows rare local NAVI overlaps according to the configured level', () => {
    expect(classifyNaviInterrupt({ text: 'このマイク12万円だった', durationMs: 1_200, level: 'LOW' })).toMatchObject({ type: 'SOFT_INTERRUPT', text: '高っ' });
    expect(classifyNaviInterrupt({ text: 'またマイク買ってさ', durationMs: 1_100, level: 'NORMAL' }).type).toBe('SOFT_INTERRUPT');
    expect(classifyNaviInterrupt({ text: 'またマイク買ってさ', durationMs: 1_100, level: 'LOW' }).type).toBe('NONE');
  });
});

describe('echo and expression', () => {
  it('requires audio and text evidence before suppressing playback echo', () => {
    expect(classifyEcho({ transcript: 'それで大丈夫だよ', playbackText: 'それで大丈夫だよ', audioCorrelation: 0.8, playbackActive: true, playbackAgeMs: 0 }).echo).toBe(true);
    expect(classifyEcho({ transcript: 'それで大丈夫だよ', playbackText: 'それで大丈夫だよ', audioCorrelation: 0.1, playbackActive: true, playbackAgeMs: 0 }).echo).toBe(false);
  });

  it('uses restrained character-consistent voice changes', () => {
    const shy = performanceFor('embarrassed', 1, 'normal');
    const happy = performanceFor('happy', 1, 'dense');
    expect(shy.volume).toBeLessThan(happy.volume);
    expect(shy.preDelayMs).toBeGreaterThan(happy.preDelayMs);
    expect(happy.speed).toBeGreaterThan(1);
  });
});
