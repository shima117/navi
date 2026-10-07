import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSqliteDb, type Db } from '../src/core/memory/Db';
import { OpenAiLedger } from '../src/core/cloud/OpenAiLedger';
import { openAiRunner } from '../src/core/cloud/OpenAiClient';
import { approveOpenAiText } from '../src/core/cloud/OpenAiApproval';
import { OPENAI_ENDPOINT, CLOUD_CONSENT_TTL, cloudFingerprint, makeOpenAiPayload, validOpenAiPayload } from '../src/core/cloud/OpenAiScope';
import { OPENAI_LIMITS, OPENAI_MODELS, OPENAI_RATES_EXPIRE, quoteOpenAi, validateOpenAiInput, type OpenAiTextInput } from '../src/core/cloud/OpenAiOptions';
import { TaskEngine } from '../src/core/tasks/TaskEngine';
import { TaskDatabase } from '../src/core/tasks/TaskDatabase';
import { initialTask, type TaskRequest } from '../src/core/tasks/TaskProtocol';
import { PolicyEngine } from '../src/core/tasks/PolicyEngine';
import { localHelperEnvironment } from '../src/core/supervisor/environment';

const time = Date.parse('2026-10-07T01:00:00Z');
const input: OpenAiTextInput = { text: '短い文章の校正をお願いします。', tier: 'ECONOMY', dataClass: 'PRIVATE', maxCostMicros: 250000 };
const connections: Db[] = [];
const engines: TaskEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const db of connections.splice(0)) db.close();
});
function setup() {
  const db = openSqliteDb(DatabaseSync, ':memory:'); connections.push(db);
  let now = time;
  const ledger = new OpenAiLedger(db, () => now);
  const policy = new PolicyEngine(undefined, ledger);
  const request: TaskRequest = { id: 'task-a', idempotencyKey: 'task-a', kind: 'OPENAI_TEXT', approvalId: 'consent-a',
    cloud: makeOpenAiPayload(input), traceId: 'trace-a', createdAt: now };
  const grant = (r = request) => ledger.grant({ id: r.approvalId!, taskId: r.id, fingerprint: cloudFingerprint(r.id, r.cloud!),
    grantedAt: now, expiresAt: now + CLOUD_CONSENT_TTL }, r.cloud!);
  const authorize = (r = request) => { grant(r); expect(policy.authorize(r).state).toBe('ALLOW'); };
  return { db, ledger, policy, request, grant, authorize, now: () => now, setTime: (value: number) => { now = value; } };
}
function response(patch: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: 'resp_fixture', model: OPENAI_MODELS.ECONOMY.model, status: 'completed',
    usage: { input_tokens: 100, output_tokens: 20 },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'これは試験用の回答です。' }] }], ...patch }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function runner(s: ReturnType<typeof setup>, transport = vi.fn<typeof fetch>(async () => response()), key: string | undefined = 'fixture-credential') {
  return { run: openAiRunner(s.ledger, () => key, transport), transport };
}

describe('OpenAI payload and explicit native consent', () => {
  it('does not inherit the OpenAI credential into local helper services, including Windows case aliases', () => {
    const inherited = { PATH: 'fixture-path', OPENAI_API_KEY: 'fixture-credential', OpenAI_Api_Key: 'fixture-alias' };
    expect(localHelperEnvironment(inherited, { OLLAMA_HOST: '127.0.0.1:11434', OPENAI_API_KEY: 'fixture-config' }))
      .toEqual({ PATH: 'fixture-path', OLLAMA_HOST: '127.0.0.1:11434' });
    expect(inherited.OPENAI_API_KEY).toBe('fixture-credential');
  });
  it.each(['ECONOMY', 'STANDARD', 'EXPERT'] as const)('binds the %s model, rate and output cap with no automatic fallback', (tier) => {
    const payload = makeOpenAiPayload({ ...input, tier });
    expect(payload.model).toBe(OPENAI_MODELS[tier].model);
    expect(payload.maxOutputTokens).toBe(1024);
    expect(validOpenAiPayload(payload)).toBe(true);
    expect(payload.quotedMicros).toBe(quoteOpenAi({ ...input, tier }));
  });
  it.each([
    { dataClass: 'SECRET' }, { dataClass: 'CONFIDENTIAL' }, { tier: 'unknown' }, { tier: '__proto__' },
    { text: '' }, { text: 'a'.repeat(2049) }, { text: 'a\n'.repeat(24) }, { text: '\u0000' },
    { text: 'api_key=not-a-real-secret' }, { text: 'sk-fixture-not-a-real-key-12345678' },
    { maxCostMicros: 250001 }, { maxCostMicros: -1 }, { maxCostMicros: .1 }, { endpoint: 'http://localhost' },
  ])('rejects unsupported or secret-bearing input %j', (patch) => {
    expect(() => validateOpenAiInput({ ...input, ...patch })).toThrow();
  });
  it('rejects a per-task cap below the estimate', () => {
    expect(() => makeOpenAiPayload({ ...input, maxCostMicros: 1 })).toThrow('料金上限');
  });
  it('cannot mint authority from an approved renderer flag', () => {
    const s = setup();
    expect(s.policy.authorize({ ...s.request, approved: true } as TaskRequest).state).toBe('NEEDS_APPROVAL');
    expect(() => s.ledger.dispatch(s.request)).toThrow();
  });
  it.each(['model', 'inputText', 'textHash', 'maxOutputTokens', 'quotedMicros', 'rateVersion', 'dataClass'] as const)('blocks consent after %s changes', (field) => {
    const s = setup(); s.grant();
    const cloud = { ...s.request.cloud!, [field]: field === 'maxOutputTokens' || field === 'quotedMicros' ? 1 : 'changed' };
    expect(s.policy.authorize({ ...s.request, cloud } as TaskRequest).state).toBe('NEEDS_APPROVAL');
  });
  it('checks task identity, root, one-use, revocation and expiry', () => {
    const s = setup(); s.grant();
    expect(s.policy.authorize({ ...s.request, id: 'other' }).state).toBe('NEEDS_APPROVAL');
    expect(s.policy.authorize({ ...s.request, projectRoot: '/scope' }).state).toBe('NEEDS_APPROVAL');
    expect(s.policy.authorize(s.request).state).toBe('ALLOW');
    expect(s.policy.authorize(s.request).state).toBe('NEEDS_APPROVAL');
    s.ledger.revoke(s.request.id);
    expect(() => s.ledger.dispatch(s.request)).toThrow();
    const b = setup(); b.grant(); b.setTime(time + CLOUD_CONSENT_TTL);
    expect(b.policy.authorize(b.request).state).toBe('NEEDS_APPROVAL');
  });
  it('does not allow local tasks to carry cloud payloads', () => {
    const s = setup();
    expect(s.policy.authorize({ ...s.request, kind: 'LOCAL_HEALTH' }).state).toBe('DENY');
    expect(() => s.ledger.dispatch({ ...s.request, kind: 'LOCAL_HEALTH' })).toThrow();
  });
  it('uses canonical scope independent of JSON field ordering', () => {
    const s = setup(); s.grant();
    const cloud = Object.fromEntries(Object.entries(s.request.cloud!).reverse()) as typeof s.request.cloud;
    expect(s.policy.authorize({ ...s.request, cloud }).state).toBe('ALLOW');
  });
  it('fails closed when the reviewed rate card expires', () => {
    const s = setup(); s.setTime(OPENAI_RATES_EXPIRE);
    expect(() => s.grant()).toThrow();
    expect(s.policy.authorize(s.request).state).toBe('NEEDS_APPROVAL');
  });
  it('shows the exact text, model, classification and retention warning; cancel never queues', async () => {
    const s = setup(); const confirm = vi.fn(async (_detail: string) => false); const enqueue = vi.fn(() => 'id');
    expect(await approveOpenAiText(input, s.ledger.state(true), time, confirm, () => true, enqueue)).toBeNull();
    expect(confirm.mock.calls[0]?.[0]).toContain(input.text);
    expect(confirm.mock.calls[0]?.[0]).toContain(OPENAI_MODELS.ECONOMY.model);
    expect(confirm.mock.calls[0]?.[0]).toContain('通常最大30日');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('a late confirmation after stop never queues a task', async () => {
    const s = setup(); const enqueue = vi.fn(() => 'id');
    expect(await approveOpenAiText(input, s.ledger.state(true), time, async () => true, () => false, enqueue)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('queues only the canonical payload after positive native consent', async () => {
    const s = setup(); const enqueue = vi.fn(() => 'new-task');
    expect(await approveOpenAiText(input, s.ledger.state(true), time, async () => true, () => true, enqueue)).toBe('new-task');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(makeOpenAiPayload(input));
  });
  it('requires a configured key before even showing consent', async () => {
    const s = setup(); const confirm = vi.fn(); const enqueue = vi.fn();
    await expect(approveOpenAiText(input, s.ledger.state(false), time, confirm, () => true, enqueue)).rejects.toThrow('OPENAI_API_KEY');
    expect(confirm).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('fixed OpenAI adapter without real API calls', () => {
  it('does not touch the network or ledger without scoped authority or a key', async () => {
    const s = setup(); const a = runner(s);
    expect((await a.run(s.request, new AbortController().signal, vi.fn())).state).toBe('FAILED');
    expect(a.transport).not.toHaveBeenCalled();
    s.authorize(); const b = runner(s, vi.fn());
    const missing = openAiRunner(s.ledger, () => undefined, b.transport);
    await missing(s.request, new AbortController().signal, vi.fn());
    expect(b.transport).not.toHaveBeenCalled(); expect(s.ledger.state(false).dayChargedMicros).toBe(0);
  });
  it('sends only approved text and fixed instructions to the fixed endpoint', async () => {
    const s = setup(); s.authorize(); const a = runner(s);
    const result = await a.run(s.request, new AbortController().signal, vi.fn());
    expect(result.state).toBe('SUCCESS'); expect(result.summary).toContain('内容の正しさは未検証');
    expect(result.verification.evidence).toContain('not factual verification');
    const [url, options] = a.transport.mock.calls[0]!;
    expect(url).toBe(OPENAI_ENDPOINT); expect(options!.redirect).toBe('error');
    const body = JSON.parse(String(options!.body));
    expect(body).toMatchObject({ input: input.text, model: OPENAI_MODELS.ECONOMY.model, max_output_tokens: 1024,
      store: false, service_tier: 'default', tools: [], tool_choice: 'none', reasoning: { effort: 'low' } });
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'max_output_tokens', 'model', 'reasoning', 'service_tier', 'store', 'tool_choice', 'tools'].sort());
    expect(s.ledger.state(true).dayChargedMicros).toBe(25);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM openai_calls').all())).not.toContain(input.text);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM openai_approvals').all())).not.toContain('fixture-credential');
    expect(a.transport).toHaveBeenCalledTimes(1);
    await a.run(s.request, new AbortController().signal, vi.fn());
    expect(a.transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 'incomplete' }, { model: 'wrong-model' }, { usage: null }, { usage: { input_tokens: -1, output_tokens: 2 } },
    { usage: { input_tokens: 50, output_tokens: 2048 } }, { output: [] },
    { output: [{ type: 'function_call', name: 'shell' }] },
    { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No' }] }] },
  ])('never completes malformed/refused/partial results %j', async (patch) => {
    const s = setup(); s.authorize(); const a = runner(s, vi.fn(async () => response(patch)));
    const result = await a.run(s.request, new AbortController().signal, vi.fn());
    expect(result.state).toBe('FAILED'); expect(result.verification.result).toBe('FAIL');
    expect(a.transport).toHaveBeenCalledTimes(1);
  });
  it.each([401, 429, 500])('keeps the uncertainty reserve on HTTP %s, discards bodies and does not retry', async (status) => {
    const s = setup(); s.authorize(); const a = runner(s, vi.fn(async () => new Response('private-provider-body', { status })));
    const result = await a.run(s.request, new AbortController().signal, vi.fn());
    expect(JSON.stringify(result)).not.toContain('private-provider-body');
    expect(s.ledger.state(true).dayChargedMicros).toBe(s.request.cloud!.quotedMicros);
    await a.run(s.request, new AbortController().signal, vi.fn());
    expect(a.transport).toHaveBeenCalledTimes(1);
  });
  it('bounds response bytes and redacts arbitrary transport exceptions', async () => {
    const s = setup(); s.authorize(); const a = runner(s, vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))));
    expect((await a.run(s.request, new AbortController().signal, vi.fn())).state).toBe('FAILED');
    const b = setup(); b.authorize(); const transport = vi.fn<typeof fetch>(async () => { throw new Error('leaked-fixture-credential'); });
    const result = await openAiRunner(b.ledger, () => 'fixture-credential', transport)(b.request, new AbortController().signal, vi.fn());
    expect(JSON.stringify(result)).not.toContain('credential');
    expect(b.ledger.state(true).dayChargedMicros).toBe(b.request.cloud!.quotedMicros);
  });
  it.each(['day', 'month'] as const)('enforces the %s budget before network dispatch', async (period) => {
    const s = setup(); s.authorize();
    const charge = period === 'day' ? OPENAI_LIMITS.dayMicros : OPENAI_LIMITS.monthMicros;
    s.db.prepare('INSERT INTO openai_calls VALUES(?,?,?,?,?,?)').run('prior', 'hash', period === 'day' ? '2026-10-07' : '2026-10-06', '2026-10', charge, 'UNCERTAIN');
    const a = runner(s); const result = await a.run(s.request, new AbortController().signal, vi.fn());
    expect(result.state).toBe('FAILED'); expect(a.transport).not.toHaveBeenCalled();
  });
  it('reserves atomically and preserves uncertainty while revoking authority on restart', () => {
    const s = setup(); s.authorize(); s.ledger.dispatch(s.request);
    expect(() => s.ledger.dispatch(s.request)).toThrow();
    s.ledger.invalidateSession(); const reopened = new OpenAiLedger(s.db, s.now);
    expect(reopened.state(false).dayChargedMicros).toBe(s.request.cloud!.quotedMicros);
    expect(reopened.authorize(s.request)).toBe(false);
    expect(() => reopened.dispatch(s.request)).toThrow();
  });
  it('keeps the paid-call uncertainty across closing and reopening the SQLite file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'navi-openai-ledger-'));
    const file = path.join(directory, 'tasks.sqlite');
    let db: Db | undefined;
    try {
      db = openSqliteDb(DatabaseSync, file);
      const ledger = new OpenAiLedger(db, () => time);
      const request: TaskRequest = { id: 'durable-task', idempotencyKey: 'durable-task', kind: 'OPENAI_TEXT', approvalId: 'durable-consent',
        cloud: makeOpenAiPayload(input), traceId: 'trace', createdAt: time };
      ledger.grant({ id: 'durable-consent', taskId: request.id, fingerprint: cloudFingerprint(request.id, request.cloud!),
        grantedAt: time, expiresAt: time + CLOUD_CONSENT_TTL }, request.cloud!);
      expect(ledger.authorize(request)).toBe(true);
      ledger.dispatch(request);
      new TaskDatabase(db).create(initialTask(request));
      db.close(); db = undefined;
      db = openSqliteDb(DatabaseSync, file);
      const recovered = new OpenAiLedger(db, () => time + 1000); recovered.invalidateSession();
      expect(recovered.state(true).dayChargedMicros).toBe(request.cloud!.quotedMicros);
      expect(recovered.authorize(request)).toBe(false);
      expect(() => recovered.dispatch(request)).toThrow();
      expect(new TaskDatabase(db).recover(time + 1000)[0]?.request.cloud?.inputText).toBeUndefined();
      expect(db.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2);
    } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('OpenAI task lifecycle', () => {
  it('persists scope hashes, never the submitted prompt; recovered tasks cannot resend', async () => {
    const s = setup(); s.grant(); const tasks = new TaskDatabase(s.db);
    tasks.create(initialTask(s.request));
    expect(String(s.db.prepare('SELECT record_json FROM agent_tasks').get()!.record_json)).not.toContain(input.text);
    const a = runner(s); const engine = new TaskEngine(tasks, a.run, vi.fn(), s.now, 2, s.policy); engines.push(engine);
    expect(tasks.get('task-a')!.request.cloud!.inputText).toBeUndefined();
    engine.control('RESUME', 'task-a');
    await vi.waitFor(() => expect(tasks.get('task-a')!.snapshot.status).toBe('WAITING'));
    expect(a.transport).not.toHaveBeenCalled();
  });
  it('completes API receipt exactly once and cannot reuse a key for different text', async () => {
    const s = setup(); s.grant(); const tasks = new TaskDatabase(s.db); const a = runner(s);
    const observed = vi.fn(a.run);
    const engine = new TaskEngine(tasks, observed, vi.fn(), s.now, 2, s.policy); engines.push(engine);
    engine.enqueue(s.request);
    await vi.waitFor(() => expect(tasks.get('task-a')!.snapshot.status).toBe('DONE'));
    expect(observed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(observed.mock.calls[0]![0].cloud!.inputText).toBeUndefined());
    engine.enqueue(s.request);
    expect(a.transport).toHaveBeenCalledTimes(1);
    expect(() => engine.enqueue({ ...s.request, cloud: makeOpenAiPayload({ ...input, text: '別の文章' }) })).toThrow('conflicts');
  });
  it('an unexpected adapter exception cannot trigger an automatic paid retry', async () => {
    const s = setup(); s.grant(); const tasks = new TaskDatabase(s.db);
    const run = vi.fn(async () => { throw new Error('credential-must-not-leak'); });
    const engine = new TaskEngine(tasks, run, vi.fn(), s.now, 2, s.policy); engines.push(engine);
    engine.enqueue(s.request);
    await vi.waitFor(() => expect(tasks.get('task-a')!.snapshot.status).toBe('WAITING'));
    engine.control('RESUME', 'task-a');
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tasks.get('task-a'))).not.toContain('credential-must-not-leak');
  });
  it('cancel remains terminal even if the provider delivers a late response', async () => {
    const s = setup(); s.grant(); const tasks = new TaskDatabase(s.db);
    let finish!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
    const a = runner(s, transport); const engine = new TaskEngine(tasks, a.run, vi.fn(), s.now, 2, s.policy); engines.push(engine);
    engine.enqueue(s.request); engine.control('CANCEL', 'task-a'); finish(response());
    await vi.waitFor(() => expect(tasks.get('task-a')!.snapshot.status).toBe('CANCELLED'));
    expect(tasks.get('task-a')!.snapshot.lastReport).toBeUndefined();
    expect(s.ledger.state(true).dayChargedMicros).toBe(s.request.cloud!.quotedMicros);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
