import { describe, expect, it } from 'vitest';
import { InitiativeScheduler, type InitiativeCandidate, type InitiativeContext } from '../src/core/initiative/InitiativeScheduler';

const ctx = (over: Partial<InitiativeContext> = {}): InitiativeContext => ({
  now: 1_000_000,
  lastNaviSpeechAt: null,
  lastUserSpeechAt: null,
  userSpeaking: false,
  focus: false,
  screenActivity: 0,
  fatigue: 0,
  quiet: false,
  ...over,
});

const bigEvent: InitiativeCandidate = {
  source: 'plugin',
  description: '大きな失敗',
  eventImportance: 1,
  novelty: 1,
  userInterest: 0.8,
  screenRelevance: 1,
  callbackValue: 0,
  topicKey: 'death',
};

const silence: InitiativeCandidate = {
  source: 'silence',
  description: '沈黙',
  eventImportance: 0.1,
  novelty: 0.4,
  userInterest: 0.3,
  screenRelevance: 0,
  callbackValue: 0.6,
};

describe('InitiativeScheduler', () => {
  const sched = () => new InitiativeScheduler(undefined, () => 0.5);

  it('speaks on an important event', () => {
    expect(sched().decide([bigEvent], ctx()).speak).toBe(true);
  });

  it('stays silent while the user is speaking', () => {
    expect(sched().decide([bigEvent], ctx({ userSpeaking: true })).reason).toBe('user_speaking');
  });

  it('stays silent in focus (combat)', () => {
    const d = sched().decide([bigEvent], ctx({ focus: true }));
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('focus');
  });

  it('does not use silence as a reason before 90 s', () => {
    const d = sched().decide([silence], ctx({ lastUserSpeechAt: 1_000_000 - 60_000 }));
    expect(d.reason).toBe('no_candidates');
  });

  it('low-value silence candidates stay below threshold even after long silence', () => {
    expect(sched().decide([silence], ctx({ lastUserSpeechAt: 0 })).speak).toBe(false);
  });

  it('penalizes speaking right after Navi spoke', () => {
    const s = sched();
    const fresh = s.score(bigEvent, ctx());
    const recent = s.score(bigEvent, ctx({ lastNaviSpeechAt: 1_000_000 - 5_000 }));
    expect(recent).toBeLessThan(fresh - 0.3);
  });

  it('penalizes repeating the same topic', () => {
    const s = sched();
    expect(s.decide([bigEvent], ctx()).speak).toBe(true);
    const later = ctx({ now: 1_000_000 + 60_000 });
    expect(s.score(bigEvent, later)).toBeLessThan(sched().score(bigEvent, later));
  });

  it('does not speak periodically during 3 minutes of uneventful play', () => {
    const s = new InitiativeScheduler();
    let spoke = 0;
    let lastNavi: number | null = null;
    for (let t = 0; t <= 180_000; t += 5_000) {
      const d = s.decide([{ ...silence, source: 'silence' }], ctx({ now: t, lastUserSpeechAt: 0, lastNaviSpeechAt: lastNavi }));
      if (d.speak) {
        spoke++;
        lastNavi = t;
      }
    }
    expect(spoke).toBe(0);
  });
});
