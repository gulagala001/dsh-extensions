import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commands } from '../src/commands.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'commands-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'review.md');
  await writeFile(path, 'Review $ARGUMENTS');
  const commands = new Commands({}, { dsh: directory });
  const definition = commands.definition({ name: 'review', path, body: 'obsolete template', description: 'Review', location: 'user' });
  const sent = [], abort = new AbortController();
  const invocation = { rawInput: '"two words" next', attachments: [], signal: abort.signal, agent: { followup: message => sent.push(message) } };
  return { path, definition, sent, abort, invocation };
}

for (const failure of ['deleted', 'invalid YAML', 'cancelled']) test(`command ${failure} cannot dispatch a cached template`, async t => {
  const f = await fixture(t);
  if (failure === 'deleted') await rm(f.path);
  if (failure === 'invalid YAML') await writeFile(f.path, '---\ndescription: [unterminated\n---\nwrong');
  const result = f.definition.handler(f.invocation).catch(error => ({ kind: 'error', text: error.message }));
  if (failure === 'cancelled') f.abort.abort(Error('request stopped'));
  assert.equal((await result).kind, 'error');
  assert.equal(f.sent.length, 0);
});

test('current template, arguments and attachments reach one followup', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'Use $1, then $2 ($ARGUMENTS)');
  f.invocation.attachments = [{ type: 'file', attachment: { id: 'test-file', name: 'example.txt' } }];
  assert.equal((await f.definition.handler(f.invocation)).kind, 'success');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].content, [...f.invocation.attachments, { type: 'text', text: 'Use two words, then next ("two words" next)' }]);
});
