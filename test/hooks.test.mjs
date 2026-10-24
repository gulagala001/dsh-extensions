import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { Hooks } from '../src/hooks.mjs';
import { Extensions } from '../src/service.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'hooks-'));
  const ctx = new Context(), hooks = new Hooks(ctx, { dsh: directory });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, ctx, hooks };
}

test('concurrent Hook saves preserve both accepted edits after reopening', async t => {
  const { hooks, directory, ctx } = await fixture(t);
  await Promise.all(['first', 'second'].map(command => hooks.save({ event: 'Stop', command })));
  const reopened = new Hooks(ctx, { dsh: directory });
  assert.deepEqual((await reopened.list()).hooks.map(hook => hook.command).sort(), ['first', 'second']);
});

test('Hook edits read the file rather than a cached document with the same timestamp', async t => {
  const { hooks } = await fixture(t);
  const write = async document => { await writeFile(hooks.file, JSON.stringify(document)); await utimes(hooks.file, 1000, 1000); };
  await write({ hooks: {}, annotation: 'old' });
  await hooks.load();
  await write({ hooks: {}, annotation: 'external change' });
  await hooks.setAll(false);
  const document = JSON.parse(await readFile(hooks.file, 'utf8'));
  assert.equal(document.annotation, 'external change');
  assert.equal(document.disableAllHooks, true);
});

test('a failed Hook edit does not poison later edits or overwrite malformed data', async t => {
  const { hooks } = await fixture(t);
  await hooks.save({ event: 'Stop', command: 'kept' });
  await assert.rejects(hooks.remove('Stop/0/0', 'wrong'), { code: 'hook-changed' });
  await hooks.save({ event: 'SessionStart', command: 'next' });
  assert.equal((await hooks.list()).hooks.length, 2);
  await writeFile(hooks.file, '{broken');
  await assert.rejects(hooks.setAll(false), { code: 'hooks-file-invalid' });
  assert.equal(await readFile(hooks.file, 'utf8'), '{broken');
});

async function runningHook(t, hooks, directory, signal) {
  const marker = join(directory, 'started'), script = join(directory, 'hook.cjs');
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
  // All arguments are test-owned paths; no user command is interpolated here.
  const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const task = hooks.test({ event: 'Stop', command: [process.execPath, script, marker].map(quote).join(' '), timeout: 5 }, signal);
  const outcome = task.then(value => ({ value }), error => ({ error }));
  let pid;
  t.after(async () => {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await outcome;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    pid = await readFile(marker, 'utf8').then(Number, () => undefined);
    if (pid) break;
    await delay(10);
  }
  assert.ok(pid, 'the real shell command started');
  return { outcome, pid };
}

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    // Linux may retain a killed grandchild as a zombie until its new parent
    // reaps it. It cannot execute; kill(pid, 0) alone still reports it present.
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null || /^\d+ \(.*\) Z /.test(stat)) return;
    }
    await delay(10);
  }
  assert.fail('The hook process is still running after cancellation');
}

test('unloading Hooks aborts and drains a running shell command', { skip: process.platform === 'win32' }, async t => {
  const { hooks, ctx, directory } = await fixture(t);
  hooks.start();
  const { outcome, pid } = await runningHook(t, hooks, directory);
  await ctx.fiber.dispose();
  const result = await Promise.race([outcome, delay(500, null)]);
  assert.match(result?.error?.message ?? '', /stopped/);
  await assertStopped(pid);
});

test('a disconnected test request cancels its command and a later run still works', { skip: process.platform === 'win32' }, async t => {
  const { hooks, directory } = await fixture(t), controller = new AbortController();
  const { outcome, pid } = await runningHook(t, hooks, directory, controller.signal);
  controller.abort(new Error('request disconnected'));
  const result = await Promise.race([outcome, delay(500, null)]);
  assert.match(result?.error?.message ?? '', /disconnected/);
  await assertStopped(pid);
  const next = await hooks.test({ event: 'Stop', command: 'echo resumed', timeout: 1 });
  assert.equal(next.code, 0);
  assert.equal(next.stdout.trim(), 'resumed');
});

test('an already cancelled request cannot dispatch a shell command', async t => {
  const { hooks } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancel before dispatch'));
  await assert.rejects(hooks.test({ event: 'Stop', command: 'echo unexpected' }, controller.signal), /cancel before dispatch/);
});

test('closing the HTTP test request reaches the running Hook cancellation signal', async t => {
  const { hooks } = await fixture(t);
  // Keep the HTTP path real; the process boundary is covered by the tests above.
  let dispatched, cancelled;
  const started = new Promise(resolve => { dispatched = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  hooks.test = async (_input, signal) => {
    dispatched();
    await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
    cancelled();
    signal.throwIfAborted();
  };
  const service = Object.assign(Object.create(Extensions.prototype), { enabled: true, hooks,
    ctx: { connection: { requestRejection() {} } } });
  const server = createServer((req, res) => void service.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}/dsh-extensions/api/hooks`, {
    method: 'POST', body: JSON.stringify({ action: 'test' }), signal: controller.signal,
  }).catch(error => error);
  await started;
  controller.abort();
  await request;
  assert.equal(await Promise.race([stopped.then(() => true), delay(500, false)]), true);
});
