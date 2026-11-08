import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.env.MCP_FIXTURE_PIDS) appendFileSync(process.env.MCP_FIXTURE_PIDS, process.pid + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (process.env.MCP_FIXTURE_STALL && request.method === 'initialize') return;
  if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'extensions-fixture', version: '1.0.0' } } });
  else if (request.method === 'tools/list') send({ id: request.id, result: { tools: ['read', 'write'].map(name => ({
    name, description: name, inputSchema: { type: 'object', properties: {} },
  })) } });
  else if (request.method === 'tools/call') send({ id: request.id, result: { content: [{ type: 'text', text: request.params.name }] } });
  else send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
});
