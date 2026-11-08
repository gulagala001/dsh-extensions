import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as nativeMcp from '@deepseek-ai/dsh-mcp-client';
import { Mcp } from '../src/mcp.mjs';

// Exercise the exact peer SDKs used by the installed native MCP client.
const native = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
const { ToolRuntime } = await import(native.resolve('@deepseek-ai/dsh-tools'));
const { SystemPrompt } = await import(native.resolve('@deepseek-ai/dsh-system-prompt'));
const { createScope } = await import(native.resolve('@deepseek-ai/dsh-scope'));
const server = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] };

test('a transport disconnect and native reconnect update the managed connection state', async t => {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'mcp-lifecycle-'));
  const ctx = new Context(), pids = join(directory, 'pids');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    await ctx.fiber.dispose();
    const owned = (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
    for (let tries = 0; tries < 100 && owned.some(alive); tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(owned.some(alive), false, 'all fixture children must exit');
    await rm(directory, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const mcp = new Mcp(ctx, { dsh: directory }); await mcp.start();
  await mcp.save({ name: 'lifecycle', server: { ...server, env: { MCP_FIXTURE_PIDS: pids } } });
  await mcp.records.get('lifecycle').ready;
  assert.equal((await mcp.list()).servers[0].status, 'connected');
  const pid = (await readFile(pids, 'utf8')).trim().split('\n').map(Number).findLast(alive);
  assert.ok(pid, 'the fixture owns a live native child');
  process.kill(pid, 'SIGTERM');
  for (let tries = 0; tries < 100 && alive(pid); tries++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.notEqual((await mcp.list()).servers[0].status, 'connected', 'a lost native transport is not connected');
  for (let tries = 0; tries < 200 && mcp.records.get('lifecycle').status !== 'connected'; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(mcp.records.get('lifecycle').status, 'connected');
  assert.ok((await readFile(pids, 'utf8')).trim().split('\n').length >= 2, 'native reconnect created a new generation');
});

test('native MCP tool masks restore after switches, disconnect, reload and namespace conflict', async t => {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'mcp-native-'));
  const ctx = new Context(), agents = [];
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide('agents', { list: () => agents });
  const agent = {}, scope = createScope(ctx, agent); agent.ctx = scope.ctx; agents.push(agent);
  const visible = () => ctx.tools.schemas(agent).map(tool => tool.name).sort();
  let mcp;
  const mount = async () => {
    const owner = ctx.plugin({ async apply(child) { mcp = new Mcp(child, { dsh: directory }); await mcp.start(); } });
    await owner; return owner;
  };
  const owner = await mount();
  await mcp.save({ name: 'example', server: { ...server, disabledTools: ['read'] } });
  await mcp.records.get('example').ready;
  assert.equal(mcp.records.get('example').status, 'connected');
  assert.deepEqual(visible(), ['mcp__example__write']);
  await mcp.setTool('example', 'write', false);
  assert.deepEqual(visible(), []);
  await mcp.setTool('example', 'read', true);
  assert.deepEqual(visible(), ['mcp__example__read']);
  await mcp.setTool('example', 'write', true);
  assert.deepEqual(visible(), ['mcp__example__read', 'mcp__example__write']);
  await mcp.setEnabled('example', false);
  assert.deepEqual(visible(), []);
  await mcp.setEnabled('example', true);
  await mcp.records.get('example').ready;
  assert.deepEqual(visible(), ['mcp__example__read', 'mcp__example__write']);
  await mcp.setTool('example', 'read', false);
  await owner.dispose();
  assert.deepEqual(visible(), []);
  assert.deepEqual(JSON.parse(await readFile(mcp.cacheFile, 'utf8')).example.map(tool => tool.name), ['read', 'write']);
  const reopened = await mount();
  await mcp.records.get('example').ready;
  assert.deepEqual(visible(), ['mcp__example__write']);
  await reopened.dispose();
  const foreign = ctx.plugin(nativeMcp, { ...server, serverName: 'example', transport: 'stdio', failOnStartupError: true });
  await foreign;
  const conflicting = await mount();
  await mcp.records.get('example').ready;
  assert.equal(mcp.records.get('example').error, 'name-in-use');
  assert.deepEqual(visible(), ['mcp__example__read', 'mcp__example__write']);
  await conflicting.dispose();
  await foreign.dispose();
  assert.deepEqual(visible(), []);
});

test('valid server names remain data keys and malformed optional cache cannot block startup', async t => {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'mcp-keys-'));
  const ctx = new Context(), mcp = new Mcp(ctx, { dsh: directory });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, 'dsh-extensions'));
  await writeFile(mcp.cacheFile, '{"constructor":null,"__proto__":[null,{}]}');
  await mcp.start();
  for (const name of ['constructor', '__proto__']) {
    await mcp.save({ name, server: { ...server, disabled: true } });
    await mcp.setTool(name, 'read', false);
    assert.deepEqual((await mcp.server(name)).raw.disabledTools, ['read']);
  }
  assert.deepEqual((await mcp.list()).servers.map(server => server.name).sort(), ['__proto__', 'constructor']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(mcp.file, 'utf8')).mcpServers).sort(), ['__proto__', 'constructor']);
});

test('stopping an unresponsive native startup cancels initialization and closes its children', async t => {
  const directory = await mkdtemp(join(process.env.DSHX_TEST_TMPDIR || tmpdir(), 'mcp-startup-'));
  const ctx = new Context(), pids = join(directory, 'pids');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    await ctx.fiber.dispose();
    const owned = (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
    for (let tries = 0; tries < 100 && owned.some(alive); tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(owned.some(alive), false); await rm(directory, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  const mcp = new Mcp(ctx, { dsh: directory }); await mcp.start();
  await mcp.save({ name: 'stall', server: { ...server, env: { MCP_FIXTURE_PIDS: pids, MCP_FIXTURE_STALL: '1' } } });
  for (let tries = 0; tries < 100; tries++) {
    if ((await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const before = performance.now(); await mcp.stop('stall');
  assert.ok(performance.now() - before < 3000, 'stop must not wait for the initialization request timeout');
  assert.equal(mcp.records.size, 0);
});
