import test from 'node:test';
import assert from 'node:assert/strict';
import { Mcp, normalizeServer } from '../src/mcp.mjs';

function fixture(names = []) {
  const schemas = names.map(name => ({ name, description: name }));
  const launches = [];
  const disposers = [];
  const ctx = {
    effect(setup) { disposers.push(setup()); },
    get: name => name === 'tools' ? { schemas: () => schemas } : undefined,
    plugin(_module, config) { launches.push(config); return Promise.resolve(); },
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

test('an MCP connection finishing startup applies saved tool restrictions immediately', async () => {
  const { mcp, schemas, ctx } = fixture();
  const server = normalizeServer('example', { command: 'unused', disabledTools: ['read'] });
  mcp.servers.set(server.name, server);
  let applied;
  mcp.applyRestriction = () => { applied = mcp.denied(); };
  ctx.plugin = () => { schemas.push({ name: 'mcp__example__read' }); return Promise.resolve(); };
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
