import { describe, expect, it } from 'vitest';
import { enforceStyle, splitSentences } from '../src/core/conversation/StyleEnforcer';
import { parseCompanionResponse } from '../src/core/conversation/ResponseParser';

describe('StyleEnforcer', () => {
  it('splits Japanese sentences and keeps closing punctuation', () => {
    expect(splitSentences('高いですね。でも欲しい！本当に？')).toEqual(['高いですね。', 'でも欲しい！', '本当に？']);
    expect(splitSentences('え……そうなんですか？！まあいいです')).toEqual(['え……そうなんですか？！', 'まあいいです']);
  });

  it('caps at three sentences', () => {
    const r = enforceStyle('一。二。三。四。五。');
    expect(r.sentences).toHaveLength(3);
    expect(r.text).toBe('一。二。三。');
  });

  it('drops customer-service sentences', () => {
    const r = enforceStyle('それ高いです。他に何かお手伝いできることはありますか？');
    expect(r.text).toBe('それ高いです。');
    expect(r.endsWithQuestion).toBe(false);
  });

  it('flags overly long output for regeneration', () => {
    expect(enforceStyle('あ'.repeat(181)).needsRegenerate).toBe(true);
    expect(enforceStyle('あ'.repeat(180)).needsRegenerate).toBe(false);
  });

  it('suppresses a trailing question only when there is other content', () => {
    expect(enforceStyle('右がいいです。どう思います？', { suppressTrailingQuestion: true }).text).toBe('右がいいです。');
    expect(enforceStyle('どう思います？', { suppressTrailingQuestion: true }).text).toBe('どう思います？');
  });
});

describe('parseCompanionResponse', () => {
  it('parses valid JSON and clamps values', () => {
    const r = parseCompanionResponse(
      '```json\n{"speak":true,"text":"不愉快です","emotion":"unimpressed","intensity":3,"gaze":"user","gesture":"tilt_right","memory_write":["x",1],"topic_action":"continue","needs_vision":false,"needs_tool":null}\n```',
    );
    expect(r.speak).toBe(true);
    expect(r.text).toBe('不愉快です');
    expect(r.emotion).toBe('unimpressed');
    expect(r.intensity).toBe(1);
    expect(r.memory_write).toEqual(['x']);
  });

  it('falls back to defaults for unknown enums', () => {
    const r = parseCompanionResponse('{"text":"はい","emotion":"ecstatic","gesture":"backflip"}');
    expect(r.emotion).toBe('neutral');
    expect(r.gesture).toBe('still');
    expect(r.speak).toBe(true);
  });

  it('treats plain text as speech and empty as silence', () => {
    expect(parseCompanionResponse('お疲れさまです').text).toBe('お疲れさまです');
    expect(parseCompanionResponse('   ').speak).toBe(false);
  });

  it('respects speak=false', () => {
    expect(parseCompanionResponse('{"speak":false,"text":"..."}').speak).toBe(false);
  });

  it('reads tool requests', () => {
    const r = parseCompanionResponse('{"speak":false,"text":"","needs_tool":{"name":"tarkov_item","args":{"name":"GPU"}}}');
    expect(r.needs_tool).toEqual({ name: 'tarkov_item', args: { name: 'GPU' } });
  });
});
