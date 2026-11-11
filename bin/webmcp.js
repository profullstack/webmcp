#!/usr/bin/env node
// webmcp: check a site's WebMCP setup and print the embed snippet.
//
//   webmcp check <url>          what an agent would find on this page
//   webmcp snippet [options]    print the <script> tag for a site
//   webmcp mcp <url>            list the tools of an MCP endpoint (what data-mcp would bridge)

import { mcpCall } from '../src/mcp-bridge.js';
import { VERSION } from '../src/core.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CDN = 'https://cdn.jsdelivr.net/npm/@profullstack/webmcp@0/src/embed.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function attr(html, re) {
  return [...html.matchAll(re)].map((m) => m[1]);
}

async function check(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  const html = await res.text();
  const embed = /@profullstack\/webmcp[^"']*embed\.js/.test(html);
  const imperative = /modelContext/.test(html);
  const forms = attr(html, /<form[^>]*\btoolname="([^"]+)"/g);
  const out = { url: res.url, status: res.status, embed, imperativeInHtml: imperative, declarativeForms: forms };
  const csp = res.headers.get('content-security-policy');
  if (csp && embed && !/cdn\.jsdelivr\.net/.test(csp)) out.cspWarning = 'CSP does not allow cdn.jsdelivr.net in script-src';
  const mcpPath = attr(html, /data-mcp="([^"]+)"/g)[0];
  if (mcpPath) {
    try {
      const tools = await mcpCall(new URL(mcpPath, res.url).href, { credentials: 'omit' }).listTools();
      out.mcp = { path: mcpPath, tools: tools.map((t) => t.name) };
    } catch (err) {
      out.mcp = { path: mcpPath, error: err.message };
    }
  }
  out.ok = embed || imperative || forms.length > 0;
  return out;
}

function snippet() {
  const attrs = [['data-webmcp', null]];
  for (const k of ['mcp', 'search', 'search-api', 'pages', 'name', 'mcp-prefix']) {
    const v = arg(k);
    if (v) attrs.push([`data-${k}`, v]);
  }
  const a = attrs.map(([k, v]) => (v == null ? k : `${k}='${v.replace(/'/g, '&#39;')}'`)).join(' ');
  return `<script type="module" src="${CDN}" ${a}></script>`;
}

const [cmd, target] = process.argv.slice(2);
try {
  if (cmd === 'check' && target) {
    const r = await check(target);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'snippet') {
    console.log(snippet());
  } else if (cmd === 'mcp' && target) {
    const tools = await mcpCall(target, { credentials: 'omit' }).listTools();
    for (const t of tools) console.log(`${t.name}\t${(t.description || '').split('\n')[0]}`);
  } else if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
  } else {
    console.log(`webmcp ${VERSION}
  webmcp check <url>      report the page's WebMCP tools (embed, forms, MCP bridge); exit 1 if none
  webmcp snippet [--mcp /mcp] [--search '/search?q={query}'] [--search-api ...] [--pages '{"a":"/a"}']
  webmcp mcp <url>        list an MCP endpoint's tools`);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`webmcp: ${err.message}`);
  process.exit(2);
}
