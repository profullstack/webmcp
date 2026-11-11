# @profullstack/webmcp

WebMCP for every site. Register a page's own functions as tools for the AI agent
in the visitor's browser, bridge the MCP server you already run, and turn plain
forms into tools. One script tag or one import. Where the browser has no WebMCP
it does nothing, so you can ship it now.

[WebMCP](https://webmachinelearning.github.io/webmcp/) is the W3C Web Machine
Learning CG draft (`document.modelContext.registerTool()`). It is in origin
trial in Chrome 149+ and Edge 150+, and is used by Brave Leo, ChatGPT Desktop
and Meta's glasses web apps. Instead of screenshotting and clicking, an agent calls
`search_site({ query })` and gets JSON back, as the signed-in person.

## One script tag

```html
<script type="module" data-webmcp
  src="https://cdn.jsdelivr.net/npm/@profullstack/webmcp@0/src/embed.js"
  data-mcp="/mcp"
  data-search-api="/api/search?q={query}&limit={limit}"
  data-pages='{"pricing":"/pricing","docs":"/docs"}'></script>
```

That registers:

| tool | when | what |
| --- | --- | --- |
| `site_info` | always | name, description, pages, and your `/llms.txt` |
| `open_page` | always | navigate within this origin (an enum when `data-pages` is set) |
| `search_site` | `data-search` or `data-search-api` | JSON results, or opens the results page |
| every tool of your MCP server | `data-mcp` | proxied `tools/call` with the visitor's cookies |
| one per `<form toolname tooldescription>` | browsers without declarative WebMCP | fills the form; submits only with `toolautosubmit` |

Other attributes: `data-mcp-prefix` (prefix bridged names), `data-mcp-exclude`
(comma list), `data-search` (results page template), `data-search-description`,
`data-name`, `data-description`, `data-llms-txt="false"`, `data-forms="false"`.
Or set `window.webmcpConfig = {...}` (camelCase) before the tag.

`@0` gets every 0.x release automatically; pin `@0.1.0` if you would rather not.
CSP: allow `https://cdn.jsdelivr.net` in `script-src`.

Pages can add tools later: `window.ProfullstackWebMCP.registerTool({...})`, and
`document` fires `webmcp:ready` with the registered names.

Every agent call fires `webmcp:call` on `document` with `{ name, ok, ms, error? }`
(never the input or the result), so analytics can count which tools agents use.
In code, pass `onCall` to `registerTool`/`registerTools`/`bridgeMcpServer`.

### Via crawlproof stats.js

Sites already on [crawlproof](https://crawlproof.com) stats can skip the separate tag:

```html
<script data-site="<project_id>" src="https://crawlproof.com/stats.js"
  data-webmcp data-webmcp-mcp="/mcp" data-webmcp-search="/search?q={query}"></script>
```

stats.js loads this embed only in browsers that have WebMCP, and records each
agent tool call as a `webmcp_tool` event. `data-webmcp-*` takes the same keys as
the embed's `data-*` attributes (`-mcp`, `-mcp-prefix`, `-mcp-exclude`, `-search`,
`-search-api`, `-pages`, `-name`, `-description`).

## Forms

Use the declarative attributes from the WebMCP proposal. Browsers that support them
make the tool natively; the embed registers the same tool imperatively everywhere else.

```html
<form toolname="subscribe" tooldescription="Subscribe an email to the newsletter" toolautosubmit>
  <input name="email" type="email" required toolparamdescription="Subscriber email">
  <select name="plan"><option>weekly</option><option>daily</option></select>
</form>
```

Without `toolautosubmit` the agent fills the form and the person presses submit.

## In code

```js
import { registerTool, registerTools, bridgeMcpServer, siteTools } from '@profullstack/webmcp';

const off = await registerTool({
  name: 'add_to_cart',
  description: 'Add a product to the cart by SKU',
  inputSchema: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, required: ['sku'] },
  annotations: { consequentialHint: false },
  execute: async ({ sku, qty = 1 }) => cart.add(sku, qty),
});

await bridgeMcpServer('/mcp', { exclude: ['admin_reset'] });
await registerTools(siteTools({ searchApi: '/api/search?q={query}' }));
```

React (Next.js client components):

```jsx
'use client';
import { useWebMCPTool } from '@profullstack/webmcp/react';

useWebMCPTool({ name: 'play', description: 'Play a channel', inputSchema, execute: ({ id }) => player.play(id) }, [player]);
```

## Rules the module enforces

- Names match `[A-Za-z0-9_.-]{1,64}`; every tool has a description; schemas are objects.
- A throwing `execute` returns `{ error }` to the agent instead of crashing the call.
- Bridged MCP tools are `consequentialHint: true` unless the server marks them
  `readOnlyHint` or `destructiveHint: false`, so the browser asks before they run.
- `search_site` and `open_page` never leave the page's origin.
- Works with `document.modelContext` (current draft) and `navigator.modelContext`
  (early previews), async or sync `registerTool`, and signal or `unregisterTool` removal.

## CLI

```sh
npx @profullstack/webmcp check https://example.com    # what an agent finds; exit 1 if nothing
npx @profullstack/webmcp snippet --mcp /mcp --search '/search?q={query}'
npx @profullstack/webmcp mcp https://example.com/mcp  # tools data-mcp would bridge
```

## Testing in Chrome

`chrome --enable-features=WebMCPTesting` (or `chrome://flags/#enable-webmcp-testing`),
then in DevTools: `await document.modelContext.getTools()`.

MIT, Profullstack, Inc.
