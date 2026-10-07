/**
 * Reads prices and sale markers out of noisy OCR text (design doc §6.4 "金額・値札",
 * §7.3 "OCR summary"). Pure: the renderer uses it to build the short summary it
 * sends to main, and main uses it to turn that summary into a `screen.ocr` event.
 *
 * OCR text describes the user's screen: callers must never log or persist it (§20).
 */

export type Currency = 'JPY' | 'USD' | 'EUR' | 'RUB' | 'UNKNOWN';

export interface PriceMention {
  /** The matched text after width normalization, e.g. "¥1,980" or "3.5万円". */
  raw: string;
  value: number;
  currency: Currency;
}

export interface OcrTextAnalysis {
  prices: PriceMention[];
  /** A sale / discount marker (割引, 半額, セール, %OFF, 値下げ …) is visible. */
  sale: boolean;
  saleMarkers: string[];
}

/** What the renderer sends to main after OCR'ing one frame. */
export interface OcrFrameText {
  frameId: string;
  sourceId: string;
  capturedAt: number;
  /** Cleaned summary, at most OCR_SUMMARY_MAX_CHARS. */
  text: string;
}

/** Payload of the `screen.ocr` bus event. Lives in RAM only. */
export interface ScreenOcr extends OcrFrameText, OcrTextAnalysis {
  sourceName: string;
}

export const OCR_SUMMARY_MAX_CHARS = 300;

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々`;
const CJK_GAP = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'gu');

/**
 * Undo the usual OCR / typography noise without touching meaning:
 * full-width → half-width (NFKC), spaces tesseract puts between Japanese
 * characters ("セー ル"), and spaces between numbers and 円/万.
 */
export function normalizeOcrText(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[_ ]/g, ' ')
      // Japanese has no inter-word spaces; tesseract's jpn model inserts them anyway.
      .replace(CJK_GAP, '$1')
      .replace(/(\d)[ \t]+(?=[円万千億])/g, '$1')
      .replace(/([万千億])[ \t]+(?=[円\d])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
  );
}

// ---------------------------------------------------------------- prices ----

/** A digit as OCR sees it: O/o for 0, l/I/| for 1. Only trusted next to a currency marker. */
const D = '[0-9OoIl|]';
/** 1,980 / 45,000 / 3, 980 (OCR inserts spaces) / 12,345.67 / 1980 / 19.99 */
const NUM = `(?:${D}{1,3}(?:[,.] ?${D}{3})+(?:\\.\\d{1,2})?|${D}+(?:[.,]\\d+)?)`;
/** Japanese large units: 3万, 3.5万, 1万2千, 12万3,456 */
const JA_AMOUNT = `(?:(?:${NUM})億)?(?:(?:${NUM})万)?(?:(?:${NUM})千)?(?:${NUM})?`;
const MULT = '(?: ?[kKmM](?![A-Za-z]))?';

// "\" is how tesseract usually reads a full-width ￥.
const PREFIX = String.raw`(?<pre>US\$|\$|¥|\\|€|₽|RUB|руб\.?)`;
const SUFFIX = String.raw`(?<suf>円|₽|руб\.?|€|ドル|ユーロ|ルーブル|(?:RUB|USD|JPY|EUR)(?![A-Za-z]))`;

const PREFIX_RE = new RegExp(`${PREFIX} ?(?<amt>${JA_AMOUNT}${MULT})`, 'gu');
const SUFFIX_RE = new RegExp(`(?<![\\w.,])(?<amt>${JA_AMOUNT}${MULT}) ?${SUFFIX}`, 'gu');
/** "1.2k" with no currency at all (e.g. game UIs). */
const BARE_K_RE = new RegExp(`(?<![\\w.,$¥€₽\\\\])(?<amt>\\d+(?:\\.\\d+)?) ?(?<mult>[kK])(?![A-Za-z])`, 'gu');

const CURRENCY_OF: Record<string, Currency> = {
  US$: 'USD',
  $: 'USD',
  USD: 'USD',
  ドル: 'USD',
  '¥': 'JPY',
  '\\': 'JPY',
  円: 'JPY',
  JPY: 'JPY',
  '€': 'EUR',
  EUR: 'EUR',
  ユーロ: 'EUR',
  '₽': 'RUB',
  RUB: 'RUB',
  руб: 'RUB',
  'руб.': 'RUB',
  ルーブル: 'RUB',
};

function fixDigits(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}

/** Parse one OCR'd number. Separators are resolved per currency (yen and roubles have no decimals). */
function parseNumber(token: string, currency: Currency): number | null {
  if (!/\d/.test(token)) return null; // "lO" alone is a word, not a number
  const t = fixDigits(token).replace(/ /g, '');
  if (/^\d{1,3}(?:[,.]\d{3})+$/.test(t)) {
    // 1,980 / 45.000 / $1.980 (cents never have three digits)
    return Number(t.replace(/[,.]/g, ''));
  }
  if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^\d+\.\d+$/.test(t)) return Number(t);
  if (/^\d+,\d{1,2}$/.test(t)) {
    // "9,99 €" is a decimal comma; a yen amount like "1,98" is just broken OCR.
    return currency === 'EUR' || currency === 'RUB' ? Number(t.replace(',', '.')) : null;
  }
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}

function parseAmount(amount: string, currency: Currency): number | null {
  const a = amount.trim();
  const mult = /([kKmM])$/.exec(a);
  const body = mult ? a.slice(0, -1).trim() : a;
  if (/[億万千]/.test(body)) {
    let total = 0;
    let rest = body;
    for (const [unit, scale] of [
      ['億', 1e8],
      ['万', 1e4],
      ['千', 1e3],
    ] as const) {
      const i = rest.indexOf(unit);
      if (i < 0) continue;
      const head = rest.slice(0, i);
      // The pattern always puts a number before a unit; a bare unit still means one of it.
      const n = head ? parseNumber(head, currency) : 1;
      if (n === null) return null;
      total += n * scale;
      rest = rest.slice(i + 1);
    }
    if (rest) {
      const n = parseNumber(rest, currency);
      if (n === null) return null;
      total += n;
    }
    return total;
  }
  const n = parseNumber(body, currency);
  if (n === null) return null;
  if (!mult) return n;
  return n * (mult[1]!.toLowerCase() === 'k' ? 1e3 : 1e6);
}

function round(value: number, currency: Currency): number {
  // Yen and roubles are whole numbers; anything else keeps cents.
  return currency === 'JPY' || currency === 'RUB' ? Math.round(value) : Math.round(value * 100) / 100;
}

/** Find every price in OCR text. Duplicates (same currency and value) are reported once. */
export function extractPrices(text: string): PriceMention[] {
  const norm = normalizeOcrText(text);
  const found: Array<PriceMention & { start: number; end: number }> = [];
  const overlaps = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);

  const collect = (re: RegExp, currencyOf: (m: RegExpExecArray) => Currency) => {
    for (const m of norm.matchAll(re)) {
      const amt = m.groups?.amt;
      if (!amt || !/\d/.test(amt)) continue;
      // "\" stands for ￥ only on real price displays ("\1,980"); "D:\2024" is a path.
      if (m.groups?.pre === '\\' && !/\d[,.] ?\d{3}/.test(amt)) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const currency = currencyOf(m as RegExpExecArray);
      const value = parseAmount(amt + (m.groups?.mult ?? ''), currency);
      if (value === null || !(value > 0) || value >= 1e10) continue;
      found.push({ raw: m[0].trim(), value: round(value, currency), currency, start, end });
    }
  };

  // Suffix first: "¥1,980円" is one price, reported with its suffix.
  collect(SUFFIX_RE, (m) => CURRENCY_OF[m.groups!.suf!] ?? 'UNKNOWN');
  collect(PREFIX_RE, (m) => CURRENCY_OF[m.groups!.pre!] ?? 'UNKNOWN');
  collect(BARE_K_RE, () => 'UNKNOWN');

  found.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const prices: PriceMention[] = [];
  for (const { raw, value, currency } of found) {
    const key = `${currency}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prices.push({ raw, value, currency });
  }
  return prices;
}

// ------------------------------------------------------------ sale marks ----

const SALE_MARKERS: Array<[RegExp, string]> = [
  // "%0FF" / "% 0FF": tesseract often reads the O of OFF as zero.
  [/\d{1,2} ?% ?(?:[O0]FF|オフ)/i, '%OFF'],
  [/\d{1,2} ?% ?引/, '%引き'],
  [/\d ?割 ?引|割引|割り引|値引/, '割引'],
  [/半額/, '半額'],
  [/セール|(?<![A-Za-z])SALE(?![A-Za-z])/i, 'セール'],
  [/値下/, '値下げ'],
  [/特価|特売|見切り?品|処分価格|激安|お買い?得/, '特価'],
];

export function detectSaleMarkers(text: string): string[] {
  const norm = normalizeOcrText(text);
  return SALE_MARKERS.filter(([re]) => re.test(norm)).map(([, label]) => label);
}

export function analyzeOcrText(text: string): OcrTextAnalysis {
  const saleMarkers = detectSaleMarkers(text);
  return { prices: extractPrices(text), sale: saleMarkers.length > 0, saleMarkers };
}

// --------------------------------------------------------------- helpers ----

function groupThousands(n: number): string {
  const [int, frac] = String(n).split('.');
  return int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac.padEnd(2, '0')}` : '');
}

export function formatPrice(p: PriceMention): string {
  switch (p.currency) {
    case 'JPY':
      return `${groupThousands(p.value)}円`;
    case 'USD':
      return `$${groupThousands(p.value)}`;
    case 'EUR':
      return `€${groupThousands(p.value)}`;
    case 'RUB':
      return `${groupThousands(p.value)}₽`;
    default:
      return p.raw;
  }
}

/** Stable key for "the same price tag" so Navi does not bring it up twice. */
export function priceSignature(prices: readonly PriceMention[]): string {
  return [...new Set(prices.map((p) => `${p.currency}:${p.value}`))].sort().join(',');
}

const MEANINGFUL = new RegExp(`[\\p{L}\\p{N}¥$€₽%]`, 'gu');

/** Drop lines that are mostly OCR garbage ("|| ,; ~", single stray glyphs). */
function isMeaningful(line: string): boolean {
  const compact = line.replace(/\s/g, '');
  if (compact.length < 2) return false;
  const good = compact.match(MEANINGFUL)?.length ?? 0;
  return good / compact.length >= 0.6;
}

/**
 * Turn raw OCR output into the short summary that leaves the renderer:
 * junk lines dropped, lines with prices / sale markers first, at most
 * `maxChars` characters. Returns '' when nothing readable remains.
 */
export function summarizeOcrText(raw: string, maxChars = OCR_SUMMARY_MAX_CHARS): string {
  const lines: string[] = [];
  for (const l of normalizeOcrText(raw).split('\n')) {
    const line = l.replace(/\s+/g, ' ').trim();
    if (isMeaningful(line) && !lines.includes(line)) lines.push(line);
  }
  const important = (l: string) => extractPrices(l).length > 0 || detectSaleMarkers(l).length > 0;
  const ordered = [...lines.filter(important), ...lines.filter((l) => !important(l))];

  let out = '';
  for (const line of ordered) {
    const next = out ? `${out} / ${line}` : line;
    if (next.length <= maxChars) {
      out = next;
      continue;
    }
    if (!out) out = `${line.slice(0, Math.max(0, maxChars - 1))}…`;
    break;
  }
  return out;
}

/**
 * Validate an OCR summary that arrived over IPC and turn it into a bus event.
 * The renderer is trusted but not assumed bug-free: wrong shapes are dropped.
 */
export function toScreenOcr(msg: unknown, sourceName: string): ScreenOcr | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Partial<Record<keyof OcrFrameText, unknown>>;
  if (typeof m.frameId !== 'string' || typeof m.sourceId !== 'string' || typeof m.text !== 'string') return null;
  if (typeof m.capturedAt !== 'number' || !Number.isFinite(m.capturedAt)) return null;
  const text = m.text.trim().slice(0, OCR_SUMMARY_MAX_CHARS);
  if (!text) return null;
  return { frameId: m.frameId, sourceId: m.sourceId, capturedAt: m.capturedAt, sourceName, text, ...analyzeOcrText(text) };
}
