import { describe, expect, it } from 'vitest';
import {
  analyzeOcrText,
  detectSaleMarkers,
  extractPrices,
  formatPrice,
  normalizeOcrText,
  OCR_SUMMARY_MAX_CHARS,
  priceSignature,
  summarizeOcrText,
  toScreenOcr,
} from '../src/core/screen/OcrAnalysis';

const first = (text: string) => {
  const p = extractPrices(text)[0];
  return p ? { value: p.value, currency: p.currency } : null;
};

describe('extractPrices', () => {
  it.each([
    ['¥1,980', 1980, 'JPY'],
    ['￥1,980', 1980, 'JPY'],
    ['1,980円', 1980, 'JPY'],
    ['税込1980円', 1980, 'JPY'],
    ['3万円', 30_000, 'JPY'],
    ['3.5万円', 35_000, 'JPY'],
    ['1万2千円', 12_000, 'JPY'],
    ['12万3,456円', 123_456, 'JPY'],
    ['$19.99', 19.99, 'USD'],
    ['US$5', 5, 'USD'],
    ['20 USD', 20, 'USD'],
    ['€9.99', 9.99, 'EUR'],
    ['9,99 €', 9.99, 'EUR'],
    ['45,000₽', 45_000, 'RUB'],
    ['₽ 45000', 45_000, 'RUB'],
    ['12,345 RUB', 12_345, 'RUB'],
    ['RUB 800', 800, 'RUB'],
    ['1.2k ₽', 1_200, 'RUB'],
    ['$1.5M', 1_500_000, 'USD'],
    ['1.2k', 1_200, 'UNKNOWN'],
  ])('%s → %d %s', (text, value, currency) => {
    expect(first(text)).toEqual({ value, currency });
  });

  it('tolerates OCR noise: full-width digits, O/0, l/1, spaces, backslash yen', () => {
    expect(first('１，９８０円')).toEqual({ value: 1980, currency: 'JPY' });
    expect(first('¥l,98O')).toEqual({ value: 1980, currency: 'JPY' });
    expect(first('3, 980 円')).toEqual({ value: 3980, currency: 'JPY' });
    expect(first('税込 \\1,980')).toEqual({ value: 1980, currency: 'JPY' });
    expect(first('3.5 万 円')).toEqual({ value: 35_000, currency: 'JPY' });
    expect(first('12, 345 RUB')).toEqual({ value: 12_345, currency: 'RUB' });
    expect(first('45.000₽')).toEqual({ value: 45_000, currency: 'RUB' });
  });

  it('reads real tesseract output from a shop page', () => {
    const raw = 'ワイ ヤレ スイ ヤ ホ ン\n\\3, 980\nタイ ム セ ー ル 35%0FF\n参考 価格 : \\ そ 6r186\nポイ ント : 40pt (1%) 送料 無料';
    expect(extractPrices(raw)).toEqual([{ raw: '\\3, 980', value: 3980, currency: 'JPY' }]);
    expect(detectSaleMarkers(raw)).toEqual(['%OFF', 'セール']);
  });

  it('finds several prices in order and reports duplicates once', () => {
    const prices = extractPrices('¥1,980 → ¥1,380 (¥1,380円) / $19.99');
    expect(prices.map((p) => `${p.currency}:${p.value}`)).toEqual(['JPY:1980', 'JPY:1380', 'USD:19.99']);
  });

  it('does not invent prices from unrelated numbers', () => {
    for (const text of [
      '2024年10月7日 12:30',
      'HP 100/100',
      '30%',
      'Level 12',
      'Hello world',
      '1,98円',
      '1.2km',
      'Oil Lamp',
      '45,000P',
      '12 RUBY',
      'D:\\2024\\photos',
      'C:\\Users\\navi\\500',
    ]) {
      expect(extractPrices(text), text).toEqual([]);
    }
  });

  it('a yen amount never has cents', () => {
    expect(first('1.980円')).toEqual({ value: 1980, currency: 'JPY' });
  });
});

describe('detectSaleMarkers', () => {
  it.each([
    ['週末セール', ['セール']],
    ['セー ル 開催中', ['セール']],
    ['SUMMER SALE', ['セール']],
    ['30%OFF', ['%OFF']],
    ['30% off', ['%OFF']],
    ['35%0FF', ['%OFF']],
    ['２０％ＯＦＦ', ['%OFF']],
    ['3割引', ['割引']],
    ['割引シール', ['割引']],
    ['半額', ['半額']],
    ['値下げしました', ['値下げ']],
    ['20%引き', ['%引き']],
    ['本日の特価', ['特価']],
  ])('%s → %j', (text, markers) => {
    expect(detectSaleMarkers(text)).toEqual(markers);
  });

  it('ignores look-alikes', () => {
    expect(detectSaleMarkers('Wholesale / Sound: OFF / sales report / 見切れ')).toEqual([]);
  });
});

describe('normalizeOcrText', () => {
  it('removes the spaces tesseract puts between Japanese characters', () => {
    expect(normalizeOcrText('カー ト に 入れ る')).toBe('カートに入れる');
    expect(normalizeOcrText('500 円')).toBe('500円');
    expect(normalizeOcrText('ＡＢＣ　１２３')).toBe('ABC 123');
  });
});

describe('summarizeOcrText', () => {
  it('puts price lines first, drops junk and caps the length', () => {
    const raw = ['ショ ッ プ 検索', '| ~ ;', 'x', '税込 \\1,980', 'ショ ッ プ 検索', 'セール中'].join('\n');
    expect(summarizeOcrText(raw)).toBe('税込 \\1,980 / セール中 / ショップ検索');
  });

  it('never exceeds the limit', () => {
    const raw = Array.from({ length: 80 }, (_, i) => `商品${i} の説明テキスト`).join('\n');
    const s = summarizeOcrText(raw);
    expect(s.length).toBeLessThanOrEqual(OCR_SUMMARY_MAX_CHARS);
    expect(s.startsWith('商品0')).toBe(true);
    expect(summarizeOcrText('あ'.repeat(500)).length).toBe(OCR_SUMMARY_MAX_CHARS);
  });

  it('returns empty for pure noise', () => {
    expect(summarizeOcrText('|\n~\n;;; ,,\n')).toBe('');
  });
});

describe('helpers', () => {
  it('formats normalized prices', () => {
    expect(formatPrice({ raw: '\\1,980', value: 1980, currency: 'JPY' })).toBe('1,980円');
    expect(formatPrice({ raw: '$19.9', value: 19.9, currency: 'USD' })).toBe('$19.90');
    expect(formatPrice({ raw: '45000₽', value: 45000, currency: 'RUB' })).toBe('45,000₽');
    expect(formatPrice({ raw: '1.2k', value: 1200, currency: 'UNKNOWN' })).toBe('1.2k');
  });

  it('price signature ignores order and duplicates', () => {
    const a = extractPrices('¥1,980 $5');
    const b = extractPrices('$5 / 1980円');
    expect(priceSignature(a)).toBe(priceSignature(b));
    expect(priceSignature([])).toBe('');
  });

  it('analyzeOcrText combines prices and sale markers', () => {
    const a = analyzeOcrText('半額 ¥990');
    expect(a.sale).toBe(true);
    expect(a.prices).toHaveLength(1);
  });
});

describe('toScreenOcr', () => {
  const msg = { frameId: 'f1', sourceId: 's1', capturedAt: 1_000, text: 'セール ¥1,980' };

  it('builds the bus payload', () => {
    const ocr = toScreenOcr(msg, 'Chrome')!;
    expect(ocr.sourceName).toBe('Chrome');
    expect(ocr.sale).toBe(true);
    expect(ocr.prices[0]!.value).toBe(1980);
  });

  it('rejects malformed IPC payloads and caps the text', () => {
    expect(toScreenOcr(null, 'x')).toBeNull();
    expect(toScreenOcr({ ...msg, text: 3 }, 'x')).toBeNull();
    expect(toScreenOcr({ ...msg, capturedAt: 'now' }, 'x')).toBeNull();
    expect(toScreenOcr({ ...msg, text: '   ' }, 'x')).toBeNull();
    expect(toScreenOcr({ ...msg, text: 'あ'.repeat(1000) }, 'x')!.text).toHaveLength(OCR_SUMMARY_MAX_CHARS);
  });
});
