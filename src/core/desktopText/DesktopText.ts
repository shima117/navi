export type TextMode = 'ANSWER' | 'TASK_STATUS' | 'RESULT' | 'MEMO' | 'TRANSCRIPT' | 'TEMPORARY';
export type TextStyle = 'NORMAL' | 'IMPORTANT' | 'SUCCESS' | 'FAILED' | 'TASK_STATUS' | 'MEMO';
export type TextPosition = 'AVATAR_SIDE' | 'TOP_CENTER' | 'BOTTOM_CENTER' | 'TOP_LEFT' | 'TOP_RIGHT' | 'FREE';
export type OverlayCommand = 'show' | 'hide' | 'next' | 'previous' | 'bigger' | 'smaller' | 'right' | 'fix';

export interface DesktopTextSettings {
  fontFamily: string;
  fontSize: number;
  color: string;
  strokeWidth: number;
  shadow: boolean;
  opacity: number;
  lineHeight: number;
  maxWidth: number;
  maxLines: number;
  position: TextPosition;
  x: number;
  y: number;
  clickThrough: boolean;
  captureIncluded: boolean;
  temporarySeconds: number;
}

export const DEFAULT_DESKTOP_TEXT: DesktopTextSettings = {
  fontFamily: '"Yu Gothic", "Meiryo", sans-serif', fontSize: 28, color: '#ffffff',
  strokeWidth: 1, shadow: true, opacity: 0.98, lineHeight: 1.5,
  maxWidth: 640, maxLines: 8, position: 'AVATAR_SIDE', x: 100, y: 100,
  clickThrough: true, captureIncluded: true, temporarySeconds: 12,
};

export interface DesktopTextState {
  revision: number;
  visible: boolean;
  text: string;
  mode: TextMode;
  style: TextStyle;
  page: number;
  settings: DesktopTextSettings;
}

export function normalizeTextSettings(raw: Partial<DesktopTextSettings> = {}): DesktopTextSettings {
  const s = { ...DEFAULT_DESKTOP_TEXT, ...raw };
  const number = (key: keyof DesktopTextSettings, min: number, max: number): number =>
    typeof s[key] === 'number' && Number.isFinite(s[key]) ? Math.min(max, Math.max(min, s[key] as number)) : DEFAULT_DESKTOP_TEXT[key] as number;
  return {
    fontFamily: typeof s.fontFamily === 'string' && s.fontFamily.length <= 200 ? s.fontFamily : DEFAULT_DESKTOP_TEXT.fontFamily,
    color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ffffff',
    fontSize: number('fontSize', 16, 72), strokeWidth: number('strokeWidth', 0, 4),
    opacity: number('opacity', 0.2, 1), lineHeight: number('lineHeight', 1.1, 2),
    maxWidth: number('maxWidth', 240, 1600), maxLines: Math.round(number('maxLines', 2, 16)),
    x: number('x', -30000, 30000), y: number('y', -30000, 30000),
    temporarySeconds: number('temporarySeconds', 3, 60),
    position: ['AVATAR_SIDE', 'TOP_CENTER', 'BOTTOM_CENTER', 'TOP_LEFT', 'TOP_RIGHT', 'FREE'].includes(s.position) ? s.position : 'AVATAR_SIDE',
    shadow: s.shadow !== false, clickThrough: s.clickThrough !== false, captureIncluded: s.captureIncluded !== false,
  };
}

export type TextIntent =
  | { kind: 'command'; command: OverlayCommand }
  | { kind: 'answer'; readAloud: boolean; query: string }
  | { kind: 'none' };

/** Deliberately narrow commands: quoted task text must not become a PC action. */
export function detectTextIntent(text: string, overlayVisible = false): TextIntent {
  const t = text.trim().replace(/[。！!？?]+$/, '');
  const commands: Array<[RegExp, OverlayCommand]> = [
    [/^(?:テキスト|文字|表示|字幕)(?:を)?消して$|^表示を閉じて$/, 'hide'],
    [/^(?:文字|テキスト)(?:を)?大きく(?:して)?$/, 'bigger'],
    [/^(?:文字|テキスト)(?:を)?小さく(?:して)?$/, 'smaller'],
    [/^(?:文字|テキスト)(?:を)?右に(?:移動|寄せて|動かして)?$/, 'right'],
    [/^(?:文字|テキスト|表示)(?:を)?固定(?:して)?$/, 'fix'],
    [/^(?:テキスト|文字)で(?:見せて|出して)$|^画面に出して$/, 'show'],
  ];
  for (const [pattern, command] of commands) if (pattern.test(t)) return { kind: 'command', command };
  if (overlayVisible) {
    if (/^(?:消して|閉じて)$/.test(t)) return { kind: 'command', command: 'hide' };
    if (/^(?:次|次のページ)(?:へ|に|を)?$/.test(t)) return { kind: 'command', command: 'next' };
    if (/^(?:前|前のページ)(?:へ|に|を)?$/.test(t)) return { kind: 'command', command: 'previous' };
  }
  const pattern = /(?:テキスト|文字)で(?:見せて|出して|表示して)|画面に(?:出して|表示して)/;
  if (!pattern.test(t)) return { kind: 'none' };
  const readAloud = /(?:読み上げ|声でも|音声でも)/.test(t);
  const query = t.replace(pattern, '').replace(/(?:も)?読み上げ(?:て|して)?|声でも|音声でも/g, '').replace(/^[\s、,]+|[\s、,]+$/g, '');
  return query ? { kind: 'answer', readAloud, query } : { kind: 'command', command: 'show' };
}
