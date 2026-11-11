// @profullstack/webmcp: register a page's own functions as WebMCP tools.
//
// WebMCP (W3C Web Machine Learning CG draft, https://webmachinelearning.github.io/webmcp/)
// lets an agent running in the browser call tools the page registers, with the
// user's own session, instead of screen-scraping and clicking. The draft API is
//
//   await document.modelContext.registerTool(tool, { signal, exposedTo })
//
// Chrome 149's origin trial and older previews expose it as navigator.modelContext,
// and early builds returned synchronously or offered unregisterTool(name). This
// module hides those differences, validates tool definitions, and is a silent no-op
// where WebMCP does not exist, so a site can ship it unconditionally.

export const VERSION = '0.1.0';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The page's ModelContext, or null when the browser has no WebMCP. */
export function getModelContext(doc = globalThis.document, nav = globalThis.navigator) {
  try {
    if (doc && doc.modelContext && typeof doc.modelContext.registerTool === 'function') return doc.modelContext;
    if (nav && nav.modelContext && typeof nav.modelContext.registerTool === 'function') return nav.modelContext;
  } catch {
    // A SecureContext-only getter can throw on http: pages.
  }
  return null;
}

export function isSupported(doc, nav) {
  return getModelContext(doc, nav) !== null;
}

/**
 * Validate and normalise a tool definition. Returns a new object; throws TypeError
 * on anything the browser would reject, so mistakes surface in tests and in
 * browsers without WebMCP rather than only in Chrome.
 */
export function defineTool(tool) {
  if (!tool || typeof tool !== 'object') throw new TypeError('webmcp: tool must be an object');
  const { name, title, description, inputSchema, outputSchema, execute, annotations } = tool;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new TypeError(`webmcp: tool name ${JSON.stringify(name)} must match ${NAME_RE}`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError(`webmcp: tool ${name} needs a description`);
  }
  if (typeof execute !== 'function') throw new TypeError(`webmcp: tool ${name} needs an execute function`);
  for (const [key, schema] of [['inputSchema', inputSchema], ['outputSchema', outputSchema]]) {
    if (schema !== undefined && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) {
      throw new TypeError(`webmcp: tool ${name} ${key} must be a JSON Schema object`);
    }
  }
  const out = {
    name,
    description: description.trim(),
    inputSchema: inputSchema ?? { type: 'object', properties: {} },
    execute,
  };
  if (title) out.title = String(title);
  if (outputSchema) out.outputSchema = outputSchema;
  if (annotations) {
    const a = {};
    for (const k of ['readOnlyHint', 'untrustedContentHint', 'consequentialHint', 'debugging']) {
      if (annotations[k] !== undefined) a[k] = Boolean(annotations[k]);
    }
    out.annotations = a;
  }
  return out;
}

// The agent receives whatever execute resolves to, serialised. Errors become a
// plain { error } result rather than a rejected promise, which some agents report
// as "the tool crashed" and never show the message from.
function wrapExecute(tool, onError) {
  return async (input, options) => {
    try {
      const result = await tool.execute(input ?? {}, options ?? {});
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      onError?.(err, tool);
      return { error: String(err?.message ?? err) };
    }
  };
}

/**
 * Register one tool. Resolves to a function that unregisters it.
 * Resolves to a no-op when WebMCP is unavailable.
 *
 * options.signal     aborting it unregisters the tool
 * options.exposedTo  origins (in this document's tree) the tool is exposed to
 * options.onError    called with (error, tool) when execute throws
 * options.context    a ModelContext to use (tests, iframes)
 */
export async function registerTool(tool, options = {}) {
  const def = defineTool(tool);
  const mc = options.context ?? getModelContext();
  if (!mc) return () => {};
  if (options.signal?.aborted) return () => {};

  const controller = new AbortController();
  const regOptions = { signal: controller.signal };
  if (options.exposedTo) regOptions.exposedTo = options.exposedTo;

  const registered = await mc.registerTool({ ...def, execute: wrapExecute(def, options.onError) }, regOptions);

  let done = false;
  const unregister = () => {
    if (done) return;
    done = true;
    controller.abort();
    // Pre-signal builds: an object with unregister(), or unregisterTool(name).
    try {
      if (registered && typeof registered.unregister === 'function') registered.unregister();
      else if (typeof mc.unregisterTool === 'function') mc.unregisterTool(def.name);
    } catch {
      // Already gone.
    }
  };
  options.signal?.addEventListener('abort', unregister, { once: true });
  return unregister;
}

/**
 * Register several tools. Resolves to one function that unregisters them all.
 * A tool that fails to register (duplicate name, bad schema) is reported to
 * options.onError and skipped; the rest still register.
 */
export async function registerTools(tools, options = {}) {
  const offs = [];
  for (const tool of tools) {
    try {
      offs.push(await registerTool(tool, options));
    } catch (err) {
      if (options.onError) options.onError(err, tool);
      else console.warn('[webmcp]', err?.message ?? err);
    }
  }
  return () => offs.forEach((off) => off());
}

/** List the tools visible to this page (draft getTools); [] without WebMCP. */
export async function listTools(options = {}) {
  const mc = options.context ?? getModelContext();
  if (!mc || typeof mc.getTools !== 'function') return [];
  return mc.getTools(options.fromOrigins ? { fromOrigins: options.fromOrigins } : {});
}
