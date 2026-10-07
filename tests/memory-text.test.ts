import { describe, expect, it } from 'vitest';
import { clampRetentionDays } from '../src/core/memory/MemoryJournal';
import { rankScore } from '../src/core/memory/ranking';
import { isOnlyRedacted, redactSecrets } from '../src/core/memory/redact';
import { bigrams, dice, normalizeForMatch, overlap } from '../src/core/memory/similarity';
import { TopicTracker, topicLabel } from '../src/core/memory/TopicTracker';

const DAY = 86_400_000;

describe('similarity', () => {
  it('normalizes width, case, spaces and punctuation', () => {
    expect(normalizeForMatch('ＡＢＣ　タルコフ、好き！')).toBe('abcタルコフ好き');
    expect(bigrams('仕事。')).toEqual(new Set(['仕事']));
  });

  it('overlap favours containment, dice is symmetric', () => {
    expect(overlap('タルコフ', 'ユーザーはタルコフが好き')).toBe(1);
    expect(dice('タルコフ', 'ユーザーはタルコフが好き')).toBeLessThan(0.6);
    expect(dice('ユーザーはタルコフが好き', 'ユーザーはタルコフが好きです')).toBeGreaterThan(0.8);
    expect(overlap('', 'x')).toBe(0);
  });
});

describe('rankScore', () => {
  const now = 100 * DAY;
  it('weighs relevance, then recency, then use count', () => {
    const fresh = { lastUsedAt: now, uses: 0 };
    const stale = { lastUsedAt: now - 90 * DAY, uses: 0 };
    expect(rankScore(0.5, fresh, now)).toBeGreaterThan(rankScore(0.5, stale, now));
    expect(rankScore(0.5, { lastUsedAt: now, uses: 10 }, now)).toBeGreaterThan(rankScore(0.5, fresh, now));
    expect(rankScore(1, stale, now)).toBeGreaterThan(rankScore(0.4, { lastUsedAt: now, uses: 50 }, now));
  });
});

describe('redactSecrets', () => {
  it('masks credentials and keeps the conversation', () => {
    const cases = [
      'キーは sk-proj-abcdefghijklmnop1234 です',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'password: hunter2!!',
      'パスワードはSecret123です',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
      'blob a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    ];
    for (const c of cases) expect(redactSecrets(c).redacted, c).toBe(true);
    expect(redactSecrets('パスワードは hunter2 です').text).toBe('パスワードは [伏せ字] です');
    expect(redactSecrets('img data:image/png;base64,AAAA').text).toBe('img [画像]');
  });

  it('leaves ordinary sentences alone, including ones about passwords', () => {
    for (const c of ['パスワードを忘れて困った', 'タルコフのタスクが終わらない', 'トークンが足りない', 'GPUは4070 SUPER']) {
      expect(redactSecrets(c)).toEqual({ text: c, redacted: false });
    }
  });

  it('detects text that is nothing but redactions', () => {
    expect(isOnlyRedacted('[伏せ字]。')).toBe(true);
    expect(isOnlyRedacted('キーは[伏せ字]')).toBe(false);
  });
});

describe('TopicTracker', () => {
  it('names topics after the user line that opened them', () => {
    const t = new TopicTracker();
    t.noteUserText('タルコフのタスクが終わらない。どうしよう');
    expect(t.onAction('continue')).toEqual({ label: 'タルコフのタスクが終わらない', event: 'start' });
    t.noteUserText('まだ工場で詰まってる');
    expect(t.onAction('continue')).toEqual({ label: 'タルコフのタスクが終わらない', event: 'continue' });
    t.noteUserText('そういえば晩ごはん何にしよう');
    expect(t.onAction('shift')).toEqual({ label: 'そういえば晩ごはん何にしよう', event: 'start' });
    expect(t.onAction('drop')).toEqual({ label: 'そういえば晩ごはん何にしよう', event: 'drop' });
    expect(t.onAction('drop')).toBeNull();
  });

  it('does not invent a topic when Navi shifts without a new user line', () => {
    const t = new TopicTracker();
    t.noteUserText('眠い');
    t.onAction('continue');
    expect(t.onAction('shift')).toBeNull();
    expect(t.currentTopic).toBeNull();
  });

  it('keeps labels short', () => {
    expect(topicLabel('あ'.repeat(100)).length).toBe(24);
  });
});

describe('clampRetentionDays', () => {
  it('rejects nonsense from a hand-edited settings file', () => {
    expect(clampRetentionDays(30)).toBe(30);
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(1e9)).toBe(3650);
    expect(clampRetentionDays('abc')).toBe(30);
    expect(clampRetentionDays(undefined)).toBe(30);
    expect(clampRetentionDays(7.6)).toBe(8);
  });
});
