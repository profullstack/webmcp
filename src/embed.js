// Drop-in WebMCP for any page, static or framework:
//
//   <script type="module" data-webmcp
//     src="https://cdn.jsdelivr.net/npm/@profullstack/webmcp@0/src/embed.js"
//     data-mcp="/mcp"
//     data-search="/search?q={query}"
//     data-search-api="/api/search?q={query}&limit={limit}"
//     data-pages='{"pricing":"/pricing","docs":"/docs"}'></script>
//
// Registers site_info + open_page always, search_site when a search template is
// given, every tool of the site's MCP server when data-mcp is given, and an
// imperative tool for every <form toolname tooldescription> in browsers without
// declarative WebMCP. Silent no-op in browsers without WebMCP.
//
// Pages can add their own tools later through window.ProfullstackWebMCP, or set
// window.webmcpConfig (same keys, camelCase) before this script runs.

import { getModelContext, registerTool, registerTools, VERSION } from './core.js';
import { siteTools } from './site.js';
import { bridgeMcpServer } from './mcp-bridge.js';
import { registerForms } from './forms.js';

function findConfig() {
  const here = import.meta.url;
  const el =
    [...document.querySelectorAll('script[src]')].find((s) => s.src === here) ||
    document.querySelector('script[data-webmcp]');
  const d = el?.dataset ?? {};
  let pages;
  try {
    pages = d.pages ? JSON.parse(d.pages) : undefined;
  } catch {
    console.warn('[webmcp] data-pages is not valid JSON');
  }
  return {
    name: d.name,
    description: d.description,
    mcp: d.mcp,
    mcpPrefix: d.mcpPrefix,
    mcpExclude: d.mcpExclude ? d.mcpExclude.split(',').map((s) => s.trim()) : undefined,
    search: d.search,
    searchApi: d.searchApi,
    searchDescription: d.searchDescription,
    pages,
    llmsTxt: d.llmsTxt === 'false' ? false : d.llmsTxt,
    forms: d.forms !== 'false',
    ...(globalThis.webmcpConfig || {}),
  };
}

// Every agent call is announced on document as `webmcp:call` with
// { name, ok, ms, error? } (never the input or result), so analytics such as
// crawlproof stats.js can count which tools agents use.
function onCall(detail) {
  document.dispatchEvent(new CustomEvent('webmcp:call', { detail }));
}

async function main() {
  if (globalThis.ProfullstackWebMCP) return; // loaded twice (site tag + stats.js plugin)
  const withCall = (opts = {}) => ({ onCall, ...opts });
  const api = {
    VERSION,
    supported: false,
    tools: [],
    registerTool: (tool, opts) => registerTool(tool, withCall(opts)),
    registerTools: (tools, opts) => registerTools(tools, withCall(opts)),
  };
  globalThis.ProfullstackWebMCP = api;
  if (!getModelContext()) return;
  api.supported = true;
  const cfg = findConfig();
  const onError = (err, tool) => console.warn('[webmcp]', tool?.name ?? '', err?.message ?? err);

  const offs = [];
  const own = siteTools(cfg);
  offs.push(await registerTools(own, { onError, onCall }));
  api.tools.push(...own.map((t) => t.name));

  if (cfg.forms) offs.push(await registerForms(document, { onError, onCall }));

  if (cfg.mcp) {
    const res = await bridgeMcpServer(new URL(cfg.mcp, location.href).href, {
      prefix: cfg.mcpPrefix,
      exclude: cfg.mcpExclude,
      onError,
      onCall,
    });
    if (res.error) console.info('[webmcp] MCP bridge skipped:', res.error);
    offs.push(res.unregister);
    api.tools.push(...res.tools);
  }
  api.unregisterAll = () => offs.forEach((off) => off());
  document.dispatchEvent(new CustomEvent('webmcp:ready', { detail: { tools: api.tools.slice() } }));
}

main().catch((err) => console.warn('[webmcp]', err?.message ?? err));
