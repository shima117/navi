import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskRunner, TaskOutcome } from './TaskEngine';

const SERVICES = [
  ['会話AI', 'http://127.0.0.1:11434/api/version'],
  ['音声合成', 'http://127.0.0.1:50021/version'],
  ['音声認識', 'http://127.0.0.1:17650/health'],
] as const;

/** Fixed read-only capabilities. No configurable URL, shell, child process or cloud. */
export const runLocalTask: TaskRunner = async (request, signal, progress) => {
  if (request.kind === 'LOCAL_HEALTH') {
    const results: string[] = [];
    let passed = 0;
    for (const [index, [name, url]] of SERVICES.entries()) {
      signal.throwIfAborted();
      progress(`${name}の接続を確認しています。`, index / SERVICES.length);
      let ok = false;
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) });
        ok = response.ok;
        // No backend response body is retained or forwarded.
        await response.body?.cancel();
      } catch {
        signal.throwIfAborted();
      }
      if (ok) passed++;
      results.push(`${name}: ${ok ? '接続できました' : '接続できません'}`);
    }
    return { state: passed === SERVICES.length ? 'SUCCESS' : 'PARTIAL',
      summary: results.join('\n'), reason: passed === SERVICES.length ? undefined : '応答しないローカルサービスがあります。',
      nextAction: passed === SERVICES.length ? undefined : '接続できないサービスを起動して、もう一度確認してください。',
      verification: { method: 'HTTP', result: passed === SERVICES.length ? 'PASS' : 'FAIL', evidence: `localhost HTTP checks: ${passed}/${SERVICES.length} 2xx` },
    };
  }
  signal.throwIfAborted();
  const root = await fs.realpath(request.projectRoot!);
  if (!path.isAbsolute(root)) throw new Error('Project directory must be absolute');
  progress('選んだフォルダを確認しています。', .2);
  const manifest = path.join(root, 'package.json');
  if ((await fs.lstat(manifest)).isSymbolicLink()) throw new Error('別の場所へのリンクは読みません。');
  // Reject symlinks and oversized manifests; inspect only a user-selected file, never a recursive scan.
  const handle = await fs.open(manifest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('package.json が大きすぎるか、通常のファイルではありません。');
    if ((await fs.realpath(manifest)) !== manifest) throw new Error('別の場所へのリンクは読みません。');
    signal.throwIfAborted();
    const raw = await handle.readFile({ encoding: 'utf8' });
    progress('package.json の形式を確認しています。', .7);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('package.json の形式が正しくありません。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json はオブジェクトではありません。');
    signal.throwIfAborted();
    // Neither scripts nor dependencies are executed, and no contents leave the machine.
    const result: TaskOutcome = { state: 'SUCCESS', summary: '選んだプロジェクトの package.json を読めました。形式も確認できています。ファイルは変更していません。',
      verification: { method: 'FILE', result: 'PASS', evidence: `package.json: regular file, ${stat.size} bytes, JSON object parsed` } };
    return result;
  } finally { await handle.close(); }
};
