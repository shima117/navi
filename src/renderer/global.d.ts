import type { NaviApi } from '../../electron/preload';

declare global {
  interface Window {
    navi: NaviApi;
  }
}

export {};
