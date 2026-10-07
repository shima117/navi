import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NaviSettings } from '../electron/ipc';

const navi = vi.hoisted(() => ({ settings: null as NaviSettings | null }));

// The tab only needs settings from the shared renderer state.
vi.mock('../src/renderer/state/NaviContext', () => ({
  useNavi: () => ({ settings: navi.settings, updateSettings: async () => undefined }),
}));

const { MemoryTab } = await import('../src/renderer/tabs/MemoryTab');

describe('MemoryTab', () => {
  it('renders the memory switches and clear actions in Japanese', () => {
    navi.settings = { ...DEFAULT_SETTINGS, persistMemory: true, utteranceRetentionDays: 45 };
    const html = renderToString(createElement(MemoryTab));
    expect(html).toContain('会話から覚えたことをセッションをまたいで保持する');
    expect(html).toContain('会話ログ (発言と画面の要約) を保存する');
    expect(html).toContain('記憶を検索');
    expect(html).toContain('全部消す');
    // A hand-edited retention value still shows up as the selected option.
    expect(html).toMatch(/<option value="45" selected="">45日<\/option>/);
    expect(html).toContain('まだ何も覚えていません');
  });

  it('renders nothing until settings have loaded', () => {
    navi.settings = null;
    expect(renderToString(createElement(MemoryTab))).toBe('');
  });
});
