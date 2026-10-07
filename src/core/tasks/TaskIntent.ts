import type { TaskControl, TaskKind } from './TaskProtocol';

export type TaskIntent = { type: 'start'; kind: TaskKind } | { type: 'status'; target?: 'project' | 'health' }
  | { type: 'result' } | { type: 'control'; command: TaskControl; all: boolean } | { type: 'none' };
export function detectTaskIntent(text: string): TaskIntent {
  const t = text.trim().replace(/[。？！?!]+$/, '');
  if (/^(?:NAVI|ナビ)(?:の)?(?:環境|接続|サービス)(?:を)?(?:確認|診断)(?:して)?$/.test(t) || /^(?:環境|接続)(?:を)?確認して$/.test(t)) return { type: 'start', kind: 'LOCAL_HEALTH' };
  if (/^(?:選んだ|この)?プロジェクト(?:を)?(?:確認|診断)(?:して)?$/.test(t)) return { type: 'start', kind: 'PROJECT_INSPECT' };
  if (/^(?:結果|作業結果)(?:を)?(?:見せて|教えて)?$/.test(t)) return { type: 'result' };
  if (/^(?:プロジェクト|環境確認)(?:の方|の作業)?(?:は)?(?:どう|今どう|進捗|状況)$/.test(t)) return { type: 'status', target: t.startsWith('プロジェクト') ? 'project' : 'health' };
  if (/^(?:進捗|作業状況|今どこまで|あとどれくらい|今どう|今進捗どう|今どうなってる|今何に時間かかってる|エラー出てる|失敗した)(?:は|を|教えて|見せて)?$/.test(t)) return { type: 'status' };
  if (/^(?:全部|すべて|裏の作業を全部|全作業を)?(?:やめて|止めて|中止して|キャンセルして)$/.test(t)) return { type: 'control', command: 'CANCEL', all: true };
  if (/^(?:作業を|それ)?(?:一旦|いったん|一時)?(?:止めて|停止して|待って)$/.test(t)) return { type: 'control', command: 'PAUSE', all: false };
  if (/^(?:作業を|それ)?(?:続けて|再開して)$/.test(t)) return { type: 'control', command: 'RESUME', all: false };
  if (/^(?:それ|この作業)(?:を)?(?:先にして|優先して)$/.test(t)) return { type: 'control', command: 'PRIORITIZE', all: false };
  if (/^(?:それ|この作業)(?:を)?(?:後回しにして)$/.test(t)) return { type: 'control', command: 'DEPRIORITIZE', all: false };
  return { type: 'none' };
}
