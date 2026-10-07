import type { ProcessSpec } from './ProcessWatchdog';

/**
 * Which helper processes NAVI starts and watches (user setting). Everything
 * is off by default: NAVI never launches anything the user did not configure.
 * All helpers are told to bind 127.0.0.1 only (§18).
 */
export interface ManagedProcessesSettings {
  /** navi-voice-service: `<python> -m navi_voice.server` in `cwd`. */
  voiceService: { enabled: boolean; python: string; cwd: string };
  /** VOICEVOX ENGINE executable (run.exe) and its arguments. */
  voicevox: { enabled: boolean; executable: string; args: string };
  /** `<executable> serve`. */
  ollama: { enabled: boolean; executable: string };
}

export type ManagedProcessId = 'voice-service' | 'voicevox' | 'ollama';

export const MANAGED_PROCESS_IDS: readonly ManagedProcessId[] = ['voice-service', 'voicevox', 'ollama'];

export const DEFAULT_MANAGED_PROCESSES: ManagedProcessesSettings = {
  voiceService: { enabled: false, python: 'python', cwd: '' },
  voicevox: { enabled: false, executable: '', args: '--host 127.0.0.1 --port 50021' },
  ollama: { enabled: false, executable: 'ollama' },
};

export const PROCESS_LABELS: Record<ManagedProcessId, string> = {
  'voice-service': '音声認識サービス (navi-voice-service)',
  voicevox: 'VOICEVOX ENGINE',
  ollama: 'Ollama',
};

const HEALTH_URLS: Record<ManagedProcessId, string> = {
  'voice-service': 'http://127.0.0.1:17650/health',
  voicevox: 'http://127.0.0.1:50021/version',
  ollama: 'http://127.0.0.1:11434/api/version',
};

/** Fill in anything missing or mistyped (settings.json is user-editable and merged shallowly). */
export function normalizeManagedProcesses(raw: unknown): ManagedProcessesSettings {
  const r = isObject(raw) ? raw : {};
  const d = DEFAULT_MANAGED_PROCESSES;
  const vs = isObject(r.voiceService) ? r.voiceService : {};
  const vv = isObject(r.voicevox) ? r.voicevox : {};
  const ol = isObject(r.ollama) ? r.ollama : {};
  return {
    voiceService: {
      enabled: bool(vs.enabled, d.voiceService.enabled),
      python: str(vs.python, d.voiceService.python),
      cwd: str(vs.cwd, d.voiceService.cwd),
    },
    voicevox: {
      enabled: bool(vv.enabled, d.voicevox.enabled),
      executable: str(vv.executable, d.voicevox.executable),
      args: str(vv.args, d.voicevox.args),
    },
    ollama: {
      enabled: bool(ol.enabled, d.ollama.enabled),
      executable: str(ol.executable, d.ollama.executable),
    },
  };
}

/** Why an enabled helper cannot be started (shown next to its settings), or null. */
export function configProblem(cfg: ManagedProcessesSettings, id: ManagedProcessId): string | null {
  if (id === 'voicevox' && cfg.voicevox.enabled && !unquote(cfg.voicevox.executable)) return '実行ファイルが未設定です';
  return null;
}

export interface SpecContext {
  /** Used when the voice service cwd is left empty (the repo's voice-service/ folder). */
  defaultVoiceServiceCwd: string;
}

/** Specs for the enabled, valid helpers only. */
export function buildProcessSpecs(cfg: ManagedProcessesSettings, ctx: SpecContext): ProcessSpec[] {
  const specs: ProcessSpec[] = [];
  if (cfg.voiceService.enabled) {
    specs.push({
      id: 'voice-service',
      label: PROCESS_LABELS['voice-service'],
      command: unquote(cfg.voiceService.python) || DEFAULT_MANAGED_PROCESSES.voiceService.python,
      args: ['-m', 'navi_voice.server'],
      cwd: unquote(cfg.voiceService.cwd) || ctx.defaultVoiceServiceCwd,
      // Unbuffered UTF-8 stderr so crash output reaches the Diagnostics tab intact (Windows defaults to cp932).
      env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      healthUrl: HEALTH_URLS['voice-service'],
    });
  }
  const vvExe = unquote(cfg.voicevox.executable);
  if (cfg.voicevox.enabled && vvExe) {
    specs.push({
      id: 'voicevox',
      label: PROCESS_LABELS.voicevox,
      command: vvExe,
      args: splitArgs(cfg.voicevox.args),
      // The engine finds its models relative to its own folder.
      cwd: dirnameOf(vvExe),
      healthUrl: HEALTH_URLS.voicevox,
    });
  }
  if (cfg.ollama.enabled) {
    specs.push({
      id: 'ollama',
      label: PROCESS_LABELS.ollama,
      command: unquote(cfg.ollama.executable) || DEFAULT_MANAGED_PROCESSES.ollama.executable,
      args: ['serve'],
      env: { OLLAMA_HOST: '127.0.0.1:11434' },
      healthUrl: HEALTH_URLS.ollama,
    });
  }
  return specs;
}

/** Split a command-line argument string; double or single quotes group words. No shell is involved. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const c of input) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Folder of a Windows or POSIX path (undefined for a bare command name). */
export function dirnameOf(file: string): string | undefined {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  if (i < 0) return undefined;
  if (i === 0) return file[0];
  // "C:\run.exe" → "C:\"
  return /^[A-Za-z]:$/.test(file.slice(0, i)) ? file.slice(0, i + 1) : file.slice(0, i);
}

/** Windows "Copy as path" wraps paths in quotes; spawn() must not see them. */
export function unquote(path: string): string {
  const t = path.trim();
  return t.length >= 2 && /^(["']).*\1$/.test(t) ? t.slice(1, -1).trim() : t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
