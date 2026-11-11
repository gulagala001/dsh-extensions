import test from 'node:test';
import assert from 'node:assert/strict';
import { Mcp, normalizeServer } from '../src/mcp.mjs';
import { observeNativeMcp } from '../src/mcp-lifecycle.mjs';

function fixture(names = []) {
  const schemas = names.map(name => ({ name, description: name }));
  const launches = [];
  const disposers = [];
  const ctx = {
    effect(setup) { disposers.push(setup()); },
    get: name => name === 'tools' ? { schemas: () => schemas } : undefined,
    plugin(_module, config) { launches.push(config); return Object.assign(Promise.resolve(), { async dispose() {}, async await() {} }); },
  };
  const mcp = new Mcp(ctx, { dsh: '/unused' });
  mcp.observeTools = () => {};
  return { mcp, launches, schemas, ctx, dispose: () => Promise.all(disposers.map(dispose => dispose?.())) };
}

test('a foreign MCP namespace is rejected before starting a second connection', async () => {
  const { mcp, launches } = fixture(['mcp__example__read']);
  mcp.launch(normalizeServer('example', { command: 'unused' }));
  await mcp.records.get('example').ready;
  assert.equal(mcp.records.get('example').error, 'name-in-use');
  assert.equal(launches.length, 0);
});

test('failed and disabled servers never restrict another provider’s tools', () => {
  const { mcp } = fixture(['mcp__example__read']);
  mcp.servers.set('example', normalizeServer('example', { command: 'unused', disabledTools: ['read'] }));
  mcp.records.set('example', { status: 'failed', error: 'name-in-use' });
  assert.deepEqual(mcp.denied(), []);
  mcp.records.delete('example');
  mcp.servers.get('example').enabled = false;
  assert.deepEqual(mcp.denied(), []);
});

test('an MCP connection finishing startup applies saved tool restrictions immediately', async t => {
  const { mcp, schemas, ctx, dispose } = fixture(); t.after(dispose);
  const server = normalizeServer('example', { command: 'unused', disabledTools: ['read'] });
  mcp.servers.set(server.name, server);
  let applied;
  mcp.applyRestriction = () => { applied = mcp.denied(); };
  ctx.plugin = () => { schemas.push({ name: 'mcp__example__read' }); return Object.assign(Promise.resolve(), { async dispose() {}, async await() {} }); };
  mcp.launch(server);
  await mcp.records.get(server.name).ready;
  assert.deepEqual(applied, ['mcp__example__read']);
});

test('a namespace claimed during loading is still rejected before connection startup', async () => {
  const { mcp, schemas, launches } = fixture();
  mcp.launch(normalizeServer('example', { command: 'unused' }));
  schemas.push({ name: 'mcp__example__read' });
  await mcp.records.get('example').ready;
  assert.equal(mcp.records.get('example').error, 'name-in-use');
  assert.equal(launches.length, 0);
});

test('changing a restriction survives synchronous tools/change without leaking the old mask', () => {
  const { mcp } = fixture();
  const live = new Set();
  let deny = ['mcp__example__read'];
  const agent = { ctx: { inject() {
    const fiber = { dispose() {
      if (!live.delete(fiber)) return;
      mcp.restrictAgent(agent, deny);
    } };
    live.add(fiber);
    return fiber;
  } } };
  mcp.restrictAgent(agent, deny);
  deny = [...deny, 'mcp__example__write'];
  mcp.restrictAgent(agent, deny);
  assert.equal(live.size, 1);
  deny = [];
  mcp.restrictAgent(agent, deny);
  assert.equal(live.size, 0);
});

test('unload prevents a pending MCP import from dispatching or accepting more edits', async () => {
  const { mcp, launches, dispose } = fixture();
  mcp.launch(normalizeServer('example', { command: 'unused' }));
  await dispose();
  assert.equal(launches.length, 0);
  assert.equal(mcp.records.size, 0);
  await assert.rejects(mcp.setEnabled('example', true), /stopped/);
});

test('failed teardown retains the old owner across manager reload until cleanup succeeds', async () => {
  const { mcp, launches, ctx } = fixture();
  const server = normalizeServer('example', { command: 'unused' }); mcp.servers.set(server.name, server);
  let failing = true;
  const record = { status: 'connected', fiber: { async dispose() { if (failing) throw Error('cleanup not confirmed'); }, async await() {} } };
  mcp.records.set(server.name, record);
  await assert.rejects(mcp.reconnect(server.name), /cleanup/);
  assert.equal(mcp.records.get(server.name), record);
  assert.equal(launches.length, 0);
  const reopened = new Mcp(ctx, { dsh: '/unused' }); reopened.servers.set(server.name, server);
  reopened.launch(server);
  assert.equal(reopened.records.get(server.name).status, 'cleanup-failed');
  assert.equal(launches.length, 0);
  failing = false;
  await reopened.stop(server.name);
  assert.equal(mcp.records.has(server.name), false);
  assert.equal(reopened.records.has(server.name), false);
  assert.equal(mcp.quarantines.size, 0);
});

test('native cleanup requires an actual close receipt and remains retryable after timeout', async () => {
  const states = [], observer = await observeNativeMcp(value => states.push(value.status), { closeWaitMs: 10 });
  const transport = { async close() {} }, client = { transport, async close() { this.transport = undefined; } };
  try {
    await observer.connect(client, transport, async () => {});
    await assert.rejects(observer.close(), /not confirmed/);
    client.onclose();
    await observer.close();
    assert.deepEqual(states, ['starting', 'connected']);
  } finally { client.onclose(); await observer.close(); }
});

test('cleanup can retire a failed fiber without treating its recorded start error as a new failure', async () => {
  const {mcp,ctx}=fixture(), initial=Error('initialize failed'), server=normalizeServer('example',{command:'unused'});
  let attempts=0;
  ctx.plugin=()=>Object.assign(Promise.reject(initial),{
    async dispose(){if(++attempts===1) throw Error('close failed');}, async await(){throw initial;}
  });
  mcp.launch(server); await mcp.records.get('example').ready;
  assert.equal(mcp.records.get('example').status,'cleanup-failed'); assert.equal(mcp.records.get('example').startError,initial);
  await mcp.stop('example');assert.equal(attempts,2);assert.equal(mcp.quarantines.size,0);
});
test('a never-started transport may close silently, but an attempted start still needs evidence', async () => {
  for (const attempted of [false,true]) {
    const observer=await observeNativeMcp(()=>{},{closeWaitMs:15});
    const transport={async start(){},async close(){}},client={async close(){}};
    await assert.rejects(observer.connect(client,transport,async()=>{if(attempted)await transport.start();throw Error('connect failed');}));
    if(attempted){await assert.rejects(observer.close(),/not confirmed/);client.onclose();}
    await observer.close();
  }
});
