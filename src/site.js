// The tools every Profullstack property can offer with no app code:
//   site_info    what this site is and what an agent can do here (llms.txt if present)
//   search_site  run the site's search (JSON API when given, else open the results page)
//   open_page    navigate to one of the site's own pages
//
// All three only read, and only touch this origin.

const MAX_LLMS = 8000;

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(values[k] ?? ''));
}

function sameOriginUrl(path, loc) {
  const u = new URL(String(path), loc.href);
  if (u.origin !== loc.origin) throw new Error('only pages on this site can be opened');
  return u;
}

/**
 * options.name               site name (default: document.title)
 * options.description        one line (default: meta description)
 * options.search             results page template, e.g. '/search?q={query}'
 * options.searchApi          JSON endpoint template, e.g. '/api/search?q={query}&limit={limit}'
 * options.searchDescription  what search_site searches, for the agent
 * options.pages              { label: '/path' } the agent may open (default: any same-origin path)
 * options.llmsTxt            path to llms.txt, or false to skip (default '/llms.txt')
 * options.extraInfo          object merged into site_info's answer
 */
export function siteTools(options = {}) {
  const doc = options.document ?? globalThis.document;
  const loc = options.location ?? globalThis.location;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const tools = [];

  const meta = (n) =>
    doc?.querySelector?.(`meta[name="${n}"],meta[property="og:${n}"]`)?.getAttribute('content') || undefined;

  tools.push({
    name: 'site_info',
    title: 'About this site',
    description:
      'Describe this website: what it is, what an agent can do here, its main pages, and its llms.txt guide when it has one. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      const info = {
        name: options.name ?? doc?.title,
        description: options.description ?? meta('description'),
        url: loc?.origin,
        page: loc?.pathname,
        ...(options.pages ? { pages: options.pages } : {}),
        ...options.extraInfo,
      };
      if (options.llmsTxt !== false && fetchImpl && loc) {
        try {
          const r = await fetchImpl(new URL(options.llmsTxt ?? '/llms.txt', loc.href).href, { credentials: 'same-origin' });
          const type = r.headers.get('content-type') || 'text/plain';
          if (r.ok && /text\/(plain|markdown)/.test(type)) info.llmsTxt = (await r.text()).slice(0, MAX_LLMS);
        } catch {
          // no llms.txt
        }
      }
      return info;
    },
  });

  if (options.search || options.searchApi) {
    tools.push({
      name: 'search_site',
      title: 'Search this site',
      description: options.searchDescription ?? `Search ${options.name ?? 'this site'} and return matching results.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (API search only)' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute({ query, limit = 10 }, { signal } = {}) {
        if (!query || !String(query).trim()) throw new Error('query is required');
        if (options.searchApi) {
          const u = sameOriginUrl(fill(options.searchApi, { query, limit }), loc);
          const r = await fetchImpl(u.href, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal });
          if (!r.ok) throw new Error(`search failed (${r.status})`);
          return r.json();
        }
        const u = sameOriginUrl(fill(options.search, { query, limit }), loc);
        loc.assign(u.href);
        return { navigated: u.href, note: 'Opened the results page; read the results from the page.' };
      },
    });
  }

  const pages = options.pages;
  tools.push({
    name: 'open_page',
    title: 'Open a page',
    description: pages
      ? `Open one of this site's pages: ${Object.keys(pages).join(', ')}.`
      : 'Open a page on this site by its path, e.g. /pricing.',
    inputSchema: pages
      ? { type: 'object', properties: { page: { type: 'string', enum: Object.keys(pages) } }, required: ['page'] }
      : { type: 'object', properties: { path: { type: 'string', description: 'Path on this site' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
    async execute(input) {
      const target = pages ? pages[input.page] : input.path;
      if (!target) throw new Error('unknown page');
      const u = sameOriginUrl(target, loc);
      loc.assign(u.href);
      return { navigated: u.href };
    },
  });

  return tools;
}
