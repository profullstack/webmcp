import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelContext,
  defineTool,
  registerTool,
  registerTools,
  bridgeMcpServer,
  mapAnnotations,
  unwrapResult,
  siteTools,
} from '../src/index.js';

// A ModelContext that follows the current draft: async registerTool, signal unregisters.
function fakeContext() {
  const tools = new Map();
  return {
    tools,
    async registerTool(tool, { signal } = {}) {
      if (tools.has(tool.name)) throw new DOMException(`duplicate ${tool.name}`, 'InvalidStateError');
      tools.set(tool.name, tool);
      signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true });
    },
    async getTools() {
      return [...tools.values()];
    },
  };
}

test('getModelContext prefers document, falls back to navigator, null otherwise', () => {
  const a = fakeContext();
  const b = fakeContext();
  assert.equal(getModelContext({ modelContext: a }, { modelContext: b }), a);
  assert.equal(getModelContext({}, { modelContext: b }), b);
  assert.equal(getModelContext({}, {}), null);
  assert.equal(getModelContext(undefined, undefined), null);
});

test('defineTool rejects bad names, missing description, non-object schema', () => {
  const ok = { name: 'a_b.c-1', description: 'x', execute() {} };
  assert.equal(defineTool(ok).name, 'a_b.c-1');
  assert.deepEqual(defineTool(ok).inputSchema, { type: 'object', properties: {} });
  assert.throws(() => defineTool({ ...ok, name: 'has space' }), TypeError);
  assert.throws(() => defineTool({ ...ok, name: 'x'.repeat(65) }), TypeError);
  assert.throws(() => defineTool({ ...ok, description: ' ' }), TypeError);
  assert.throws(() => defineTool({ ...ok, inputSchema: [] }), TypeError);
  assert.throws(() => defineTool({ ...ok, execute: 1 }), TypeError);
});

test('registerTool registers, wraps errors as results, and unregisters', async () => {
  const mc = fakeContext();
  const off = await registerTool(
    { name: 'boom', description: 'fails', execute: () => { throw new Error('nope'); } },
    { context: mc },
  );
  assert.ok(mc.tools.has('boom'));
  assert.deepEqual(await mc.tools.get('boom').execute({}, {}), { error: 'nope' });
  off();
  assert.ok(!mc.tools.has('boom'));
  off(); // idempotent
});

test('caller signal unregisters', async () => {
  const mc = fakeContext();
  const ac = new AbortController();
  await registerTool({ name: 't', description: 'd', execute: () => 1 }, { context: mc, signal: ac.signal });
  assert.ok(mc.tools.has('t'));
  ac.abort();
  assert.ok(!mc.tools.has('t'));
});

test('legacy context: sync registerTool + unregisterTool(name)', async () => {
  const names = new Set();
  const mc = { registerTool: (t) => { names.add(t.name); }, unregisterTool: (n) => names.delete(n) };
  const off = await registerTool({ name: 'old', description: 'd', execute: () => 1 }, { context: mc });
  assert.ok(names.has('old'));
  off();
  assert.ok(!names.has('old'));
});

test('no WebMCP: registerTool is a no-op', async () => {
  const off = await registerTool({ name: 'x', description: 'd', execute: () => 1 }, { context: null });
  assert.equal(typeof off, 'function');
});

test('registerTools skips a duplicate and keeps the rest', async () => {
  const mc = fakeContext();
  const errors = [];
  const off = await registerTools(
    [
      { name: 'a', description: 'd', execute: () => 1 },
      { name: 'a', description: 'dup', execute: () => 2 },
      { name: 'b', description: 'd', execute: () => 3 },
    ],
    { context: mc, onError: (e) => errors.push(e) },
  );
  assert.deepEqual([...mc.tools.keys()], ['a', 'b']);
  assert.equal(errors.length, 1);
  off();
  assert.equal(mc.tools.size, 0);
});

test('mapAnnotations: unknown tools are consequential, read-only ones are not', () => {
  assert.deepEqual(mapAnnotations({}), { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false });
  assert.deepEqual(mapAnnotations({ readOnlyHint: true, openWorldHint: true }), {
    readOnlyHint: true,
    consequentialHint: false,
    untrustedContentHint: true,
  });
  assert.equal(mapAnnotations({ destructiveHint: false }).consequentialHint, false);
});

test('unwrapResult: structured, JSON text, plain text, error', () => {
  assert.deepEqual(unwrapResult({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: '{"n":2}' }] }), { n: 2 });
  assert.equal(unwrapResult({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
  assert.throws(() => unwrapResult({ isError: true, content: [{ type: 'text', text: 'bad' }] }), /bad/);
});

// A Streamable-HTTP MCP server: JSON for initialize, SSE for tools/list and tools/call.
function fakeMcpFetch(log) {
  return async (url, init) => {
    const msg = JSON.parse(init.body);
    log.push({ method: msg.method, session: init.headers['mcp-session-id'], credentials: init.credentials });
    const json = (body, extra = {}) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...extra } });
    const sse = (body) =>
      new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') {
      return sse({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'search', description: 'Search feeds', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
            { name: 'delete-feed', description: 'Delete a feed', inputSchema: { type: 'object', properties: {} } },
            { name: 'admin_wipe', description: 'Wipe', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });
    }
    if (msg.method === 'tools/call') {
      return sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ got: msg.params }) }] } });
    }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  };
}

test('bridgeMcpServer registers server tools and proxies calls with the session', async () => {
  const mc = fakeContext();
  const log = [];
  const res = await bridgeMcpServer('https://x.test/mcp', {
    context: mc,
    fetch: fakeMcpFetch(log),
    prefix: 'rs_',
    exclude: ['admin_wipe'],
  });
  assert.deepEqual(res.tools, ['rs_search', 'rs_delete-feed']);
  assert.equal(mc.tools.get('rs_search').annotations.readOnlyHint, true);
  assert.equal(mc.tools.get('rs_delete-feed').annotations.consequentialHint, true);
  const out = await mc.tools.get('rs_search').execute({ q: 'rust' }, {});
  assert.deepEqual(out, { got: { name: 'search', arguments: { q: 'rust' } } });
  const call = log.find((l) => l.method === 'tools/call');
  assert.equal(call.session, 's1');
  assert.equal(call.credentials, 'same-origin');
  res.unregister();
  assert.equal(mc.tools.size, 0);
});

test('bridgeMcpServer resolves with an error instead of throwing when refused', async () => {
  const res = await bridgeMcpServer('https://x.test/mcp', {
    context: fakeContext(),
    fetch: async () => new Response('no', { status: 401 }),
  });
  assert.deepEqual(res.tools, []);
  assert.match(res.error, /401/);
});

test('siteTools: site_info reads llms.txt, search_site uses the API, open_page stays same-origin', async () => {
  const assigned = [];
  const loc = { href: 'https://site.test/a', origin: 'https://site.test', pathname: '/a', assign: (u) => assigned.push(u) };
  const fetchImpl = async (u) => {
    if (String(u).endsWith('/llms.txt')) return new Response('# Site\nDoes things', { headers: { 'content-type': 'text/plain' } });
    if (String(u).includes('/api/search')) return new Response(JSON.stringify({ results: [String(u)] }), { headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 404 });
  };
  const tools = siteTools({ name: 'Site', searchApi: '/api/search?q={query}&limit={limit}', location: loc, fetch: fetchImpl, document: null });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(by), ['site_info', 'search_site', 'open_page']);
  const info = await by.site_info.execute({});
  assert.equal(info.name, 'Site');
  assert.match(info.llmsTxt, /Does things/);
  const s = await by.search_site.execute({ query: 'a b&c', limit: 3 }, {});
  assert.deepEqual(s, { results: ['https://site.test/api/search?q=a%20b%26c&limit=3'] });
  await by.open_page.execute({ path: '/pricing' });
  assert.deepEqual(assigned, ['https://site.test/pricing']);
  await assert.rejects(by.open_page.execute({ path: 'https://evil.test/' }), /only pages on this site/);
  await assert.rejects(by.open_page.execute({ path: '//evil.test/x' }), /only pages on this site/);
});

test('siteTools with a pages map uses an enum', () => {
  const loc = { href: 'https://s.test/', origin: 'https://s.test', pathname: '/', assign() {} };
  const open = siteTools({ pages: { pricing: '/pricing' }, location: loc, document: null }).find((t) => t.name === 'open_page');
  assert.deepEqual(open.inputSchema.properties.page.enum, ['pricing']);
});
