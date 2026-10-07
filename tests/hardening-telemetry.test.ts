import { describe, expect, it } from 'vitest';
import { EventBus, type TimingKind } from '../src/core/events/EventBus';
import { diagnosticsFileName, HealthTimeline } from '../src/core/telemetry/DiagnosticsReport';
import { attachMetrics, Metrics, percentile, SampleRing } from '../src/core/telemetry/Metrics';
import { errorMessage, redactExternalText } from '../src/core/telemetry/redact';
import { ResponseLatencyTracker } from '../src/core/telemetry/ResponseLatency';
import { RotatingJsonlLog, toTelemetryRecord, type LogFs } from '../src/core/telemetry/TelemetryLog';

describe('percentile / SampleRing', () => {
  it('nearest-rank p50 / p95', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('keeps only the latest N but counts everything', () => {
    const r = new SampleRing(3);
    [1, 2, 3, 4, 5].forEach((v) => r.push(v));
    expect(r.values()).toEqual([3, 4, 5]);
    expect(r.count).toBe(5);
  });
});

describe('Metrics', () => {
  it('computes latency stats per kind over a ring buffer', () => {
    const m = new Metrics({ samples: 10 });
    for (let i = 1; i <= 20; i++) m.recordTiming('chat', i * 100);
    m.recordTiming('chat', -5); // clock jump: ignored
    m.recordTiming('chat', Number.NaN);
    const s = m.latency('chat');
    expect(s).toMatchObject({ count: 20, window: 10, p50: 1500, p95: 2000, max: 2000, last: 2000 });
    expect(m.latency('vision')).toMatchObject({ count: 0, p50: null, p95: null });
  });

  it('counts initiative decisions by reason', () => {
    const m = new Metrics();
    m.recordInitiative(false, 'below_threshold');
    m.recordInitiative(false, 'below_threshold');
    m.recordInitiative(false, 'focus');
    m.recordInitiative(true, 'selected');
    expect(m.snapshot().initiative).toEqual({
      speak: 1,
      silent: 3,
      byReason: { below_threshold: 2, focus: 1, speak: 1 },
    });
  });

  it('keeps the last 50 errors, counted by service and redacted', () => {
    const m = new Metrics();
    for (let i = 0; i < 60; i++) m.recordError(i % 2 ? 'chat' : 'tts', `error ${i}`, i);
    m.recordError('chat', 'Ollama said: 「今日仕事だるかった」 is invalid', 99);
    const s = m.snapshot().errors;
    expect(s.recent).toHaveLength(50);
    expect(s.recent[0]!.message).toBe('error 11');
    expect(s.recent[49]!.message).toBe('Ollama said: … is invalid');
    expect(s.byService).toEqual({ tts: 30, chat: 31 });
  });

  it('is fed from the bus; a service going offline is an error', () => {
    const bus = new EventBus();
    const m = new Metrics();
    attachMetrics(bus, m, () => 42);
    bus.emit('metrics.timing', { kind: 'vision', ms: 812, at: 1 });
    bus.emit('metrics.error', { service: 'vision', message: 'timeout', at: 2 });
    bus.emit('metrics.initiative', { speak: false, reason: 'focus', at: 3 });
    bus.emit('health.changed', { service: 'tts', ok: false });
    bus.emit('health.changed', { service: 'tts', ok: true });
    const s = m.snapshot();
    expect(s.latency.vision.p50).toBe(812);
    expect(s.errors.recent.map((e) => [e.service, e.message, e.at])).toEqual([
      ['vision', 'timeout', 2],
      ['tts', 'offline', 42],
    ]);
    expect(s.initiative.byReason).toEqual({ focus: 1 });
  });
});

describe('ResponseLatencyTracker', () => {
  const track = () => {
    const out: Array<[TimingKind, number]> = [];
    return { out, t: new ResponseLatencyTracker((k, ms) => out.push([k, ms])) };
  };

  it('text turn: utterance → audio playback start', () => {
    const { out, t } = track();
    t.userUtterance(1_000, 'text');
    t.naviSpeak(1_900, true);
    t.playbackStarted(2_300);
    expect(out).toEqual([
      ['tts', 400],
      ['response', 1_300],
    ]);
  });

  it('voice turn starts the clock at end-of-speech, so STT time counts', () => {
    const { out, t } = track();
    t.userSpeechEnded(10_000);
    t.userUtterance(10_700, 'voice');
    t.naviSpeak(11_500, true);
    t.playbackStarted(11_800);
    expect(out).toContainEqual(['response', 1_800]);
  });

  it('subtitles-only speech (TTS down) counts at the speak decision', () => {
    const { out, t } = track();
    t.userUtterance(0, 'text');
    t.naviSpeak(1_200, false);
    t.playbackStarted(5_000); // stray: nothing awaited
    expect(out).toEqual([['response', 1_200]]);
  });

  it('a silent answer or initiative speech yields no response sample', () => {
    const { out, t } = track();
    t.userUtterance(0, 'text');
    t.naviSilent();
    t.naviSpeak(60_000, true); // later initiative
    t.playbackStarted(60_500);
    expect(out).toEqual([['tts', 500]]);
  });

  it('a newer utterance supersedes an unanswered one; stale samples are dropped', () => {
    const { out, t } = track();
    t.userUtterance(0, 'text');
    t.userUtterance(3_000, 'text');
    t.naviSpeak(4_000, false);
    expect(out).toEqual([['response', 1_000]]);

    t.userUtterance(10_000, 'text');
    t.naviSpeak(11_000, true);
    t.playbackStarted(11_000 + 31_000); // playback never really started
    expect(out).toHaveLength(1);
  });
});

describe('telemetry log', () => {
  class MemFs implements LogFs {
    files = new Map<string, string>();
    async mkdir(): Promise<void> {}
    async size(f: string): Promise<number | null> {
      const v = this.files.get(f);
      return v === undefined ? null : new TextEncoder().encode(v).length;
    }
    async append(f: string, d: string): Promise<void> {
      this.files.set(f, (this.files.get(f) ?? '') + d);
    }
    async rename(a: string, b: string): Promise<void> {
      this.files.set(b, this.files.get(a)!);
      this.files.delete(a);
    }
    async remove(f: string): Promise<void> {
      this.files.delete(f);
    }
  }

  it('records only whitelisted numeric/enum fields', () => {
    expect(toTelemetryRecord('metrics.timing', { kind: 'chat', ms: 812.4, at: 5 })).toEqual({ t: 5, type: 'timing', kind: 'chat', ms: 812 });
    expect(toTelemetryRecord('metrics.initiative', { speak: false, reason: 'focus', at: 5 })).toBeNull();
    const err = toTelemetryRecord('metrics.error', { service: 'chat', message: '「バナナ高い」 failed', at: 5 });
    expect(JSON.stringify(err)).not.toMatch(/バナナ/);
    expect(toTelemetryRecord('resource.mode', { mode: 'GAME_PRIORITY', auto: true, reason: 'game', at: 9 })).toEqual({
      t: 9,
      type: 'resource',
      mode: 'GAME_PRIORITY',
      auto: true,
      reason: 'game',
    });
  });

  it('appends JSON lines and rotates by size, keeping N old files', async () => {
    const fs = new MemFs();
    const log = new RotatingJsonlLog(fs, '/logs', { maxBytes: 120, keep: 2 });
    for (let i = 0; i < 12; i++) log.write({ t: i, type: 'timing', kind: 'chat', ms: 1000 + i });
    await log.flush();
    expect([...fs.files.keys()].sort()).toEqual(['/logs/telemetry.1.jsonl', '/logs/telemetry.2.jsonl', '/logs/telemetry.jsonl']);
    for (const content of fs.files.values()) {
      expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(120);
      for (const line of content.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ type: 'timing' });
    }
    // Newest record is in the current file; the oldest ones were rotated away.
    expect(fs.files.get('/logs/telemetry.jsonl')).toContain('"t":11');
    expect([...fs.files.values()].join('')).not.toContain('"t":0,');
  });

  it('never throws when the disk fails', async () => {
    const fs = new MemFs();
    fs.append = async () => {
      throw new Error('EACCES');
    };
    const log = new RotatingJsonlLog(fs, '/logs');
    log.write({ t: 1, type: 'session', event: 'started' });
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe('redaction and diagnostics helpers', () => {
  it('redacts Japanese text, base64 blobs and control characters', () => {
    expect(redactExternalText('user said こんにちは、ナビ\tthen\u001b[31m RED')).toBe('user said … then RED');
    expect(redactExternalText(`img: ${'QUJD'.repeat(50)} end`)).toBe('img: [data] end');
    expect(redactExternalText('ab '.repeat(200), 20)).toHaveLength(20);
    expect(errorMessage(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
  });

  it('health timeline keeps the time of the last flip', () => {
    const h = new HealthTimeline();
    h.record('chat', false, 1);
    h.record('chat', false, 2);
    h.record('chat', true, 3);
    expect(h.list(['chat', 'tts'])).toEqual([
      { name: 'chat', ok: true, changedAt: 3 },
      { name: 'tts', ok: null, changedAt: null },
    ]);
  });

  it('export file name', () => {
    expect(diagnosticsFileName(new Date(2026, 9, 7, 9, 5, 3).getTime())).toBe('navi-diagnostics-20261007-090503.json');
  });
});
