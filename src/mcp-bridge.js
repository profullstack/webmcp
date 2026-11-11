// Bridge a site's existing MCP server into WebMCP.
//
// House rule: anything an agent should operate ships an MCP server, and most of
// ours answer Streamable HTTP JSON-RPC at /mcp. bridgeMcpServer() lists those
// tools and registers each one as a WebMCP tool whose execute() is a tools/call
// to the same server, from the page, with the user's cookies. One line turns the
// server that an outside agent needs an API key for into tools a browser agent
// can use as the signed-in person.

import { registerTools, VERSION } from './core.js';

const PROTOCOL = '2025-06-18';

async function readJsonRpc(res) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    // Take the last JSON-RPC response carried in a data: line.
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg;
      } catch {
        // keep-alive or partial line
      }
    }
    if (!last) throw new Error('webmcp: MCP server sent no JSON-RPC result');
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`webmcp: MCP server answered ${res.status} with non-JSON`);
  }
}

/** A small MCP Streamable-HTTP client bound to one endpoint. */
export function mcpCall(url, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const credentials = opts.credentials ?? 'same-origin';
  let sessionId = null;
  let initialized = null;
  let nextId = 1;

  async function headers() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      ...(typeof opts.headers === 'function' ? await opts.headers() : opts.headers),
    };
    if (sessionId) h['mcp-session-id'] = sessionId;
    return h;
  }

  async function rpc(method, params, signal) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: await headers(),
      credentials,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`webmcp: MCP server refused (${res.status}); the person needs to sign in`);
    }
    const msg = await readJsonRpc(res);
    if (msg.error) throw new Error(msg.error.message || `webmcp: MCP error ${msg.error.code}`);
    return msg.result;
  }

  function init() {
    initialized ??= rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: '@profullstack/webmcp', version: VERSION },
    })
      .then(async (result) => {
        // A notification: no id, nothing to read back.
        await fetchImpl(url, {
          method: 'POST',
          headers: await headers(),
          credentials,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }).catch(() => {});
        return result;
      })
      .catch((err) => {
        initialized = null;
        throw err;
      });
    return initialized;
  }

  return {
    async listTools(signal) {
      await init();
      const tools = [];
      let cursor;
      do {
        const r = await rpc('tools/list', cursor ? { cursor } : {}, signal);
        tools.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, signal) {
      await init();
      return rpc('tools/call', { name, arguments: args ?? {} }, signal);
    },
  };
}

// MCP annotations -> WebMCP annotations. A tool counts as consequential unless the
// server says it only reads or is explicitly non-destructive, so the browser asks
// the person before it runs.
export function mapAnnotations(a = {}) {
  const readOnly = a.readOnlyHint === true;
  return {
    readOnlyHint: readOnly,
    consequentialHint: !readOnly && a.destructiveHint !== false,
    untrustedContentHint: a.openWorldHint === true,
  };
}

// tools/call result -> what the agent gets back.
export function unwrapResult(r) {
  if (!r) return { ok: true };
  const content = r.content ?? [];
  if (r.isError) {
    const msg = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    throw new Error(msg || 'tool failed');
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (content.length && content.every((c) => c.type === 'text')) {
    const text = content.map((c) => c.text).join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return content;
}

function keepFn(include, exclude) {
  return (n) => {
    if (typeof include === 'function' && !include(n)) return false;
    if (Array.isArray(include) && !include.includes(n)) return false;
    if (typeof exclude === 'function' && exclude(n)) return false;
    if (Array.isArray(exclude) && exclude.includes(n)) return false;
    return true;
  };
}

/**
 * Register every tool of the MCP server at `url` as a WebMCP tool.
 *
 * options.include / exclude  tool names (array or predicate) to keep / drop
 * options.prefix             prepended to each name, e.g. 'rssamp_'
 * options.headers            object or async () => object, e.g. a bearer token
 * options.signal             aborting unregisters everything
 *
 * Resolves to { tools, unregister, error? }. Never rejects: a server that is down
 * or needs auth resolves with tools: [] and the reason in `error`.
 */
export async function bridgeMcpServer(url, options = {}) {
  const client = mcpCall(url, options);
  let listed;
  try {
    listed = await client.listTools(options.signal);
  } catch (err) {
    return { tools: [], unregister: () => {}, error: String(err?.message ?? err) };
  }
  const keep = keepFn(options.include, options.exclude);
  const prefix = options.prefix ?? '';
  const tools = listed
    .filter((t) => keep(t.name))
    .map((t) => ({
      name: (prefix + t.name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
      title: t.title ?? t.annotations?.title,
      description: t.description || t.title || t.name,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: mapAnnotations(t.annotations),
      execute: async (input, { signal } = {}) => unwrapResult(await client.callTool(t.name, input, signal)),
    }));
  const unregister = await registerTools(tools, options);
  return { tools: tools.map((t) => t.name), unregister };
}
