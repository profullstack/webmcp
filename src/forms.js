// Forms as tools.
//
// The WebMCP declarative proposal makes <form toolname="..." tooldescription="...">
// a tool natively: each named control is a property, toolparamdescription its
// description, toolautosubmit lets the agent submit. Browsers that ship only the
// imperative API ignore those attributes, so registerForms() reads the same
// attributes and registers an equivalent imperative tool there. Write the
// attributes once; both kinds of browser get the tool.

import { registerTools } from './core.js';

export function supportsDeclarativeForms(win = globalThis) {
  const F = win.HTMLFormElement;
  return Boolean(F && ('toolName' in F.prototype || 'toolname' in F.prototype));
}

const SKIP = new Set(['submit', 'button', 'reset', 'image', 'file', 'hidden', 'password']);

function typeOf(el) {
  return (el.getAttribute('type') || '').toLowerCase();
}

function describe(el) {
  const label = el.id && el.ownerDocument?.querySelector?.(`label[for="${el.id}"]`)?.textContent?.trim();
  return (
    el.getAttribute('toolparamdescription') || el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || undefined
  );
}

function controlSchema(el) {
  const tag = el.tagName.toLowerCase();
  const type = typeOf(el);
  const s = {};
  if (tag === 'select') {
    s.type = 'string';
    s.enum = [...el.options].map((o) => o.value).filter((v) => v !== '');
  } else if (type === 'checkbox') {
    s.type = 'boolean';
  } else if (type === 'number' || type === 'range') {
    s.type = 'number';
    if (el.getAttribute('min') != null) s.minimum = Number(el.getAttribute('min'));
    if (el.getAttribute('max') != null) s.maximum = Number(el.getAttribute('max'));
  } else {
    s.type = 'string';
    if (type === 'email') s.format = 'email';
    if (type === 'url') s.format = 'uri';
    if (type === 'date') s.format = 'date';
    const max = Number(el.getAttribute('maxlength'));
    if (max > 0) s.maxLength = max;
  }
  const d = describe(el);
  if (d) s.description = d;
  return s;
}

/** JSON Schema for a form, synthesised from its named controls. */
export function formSchema(form) {
  const properties = {};
  const required = [];
  const els = [...form.elements];
  for (const el of els) {
    const name = el.name;
    if (!name || el.disabled || properties[name]) continue;
    const type = typeOf(el);
    if (SKIP.has(type)) continue;
    if (type === 'radio') {
      properties[name] = { type: 'string', enum: els.filter((r) => r.name === name).map((r) => r.value) };
      const d = el.getAttribute('toolparamdescription');
      if (d) properties[name].description = d;
    } else {
      properties[name] = controlSchema(el);
    }
    if (el.required) required.push(name);
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

function setValue(form, name, value) {
  for (const el of [...form.elements].filter((e) => e.name === name)) {
    const type = typeOf(el);
    if (SKIP.has(type)) continue;
    if (type === 'checkbox') el.checked = Boolean(value);
    else if (type === 'radio') el.checked = el.value === String(value);
    else el.value = value == null ? '' : String(value);
    // Frameworks (React, Svelte) listen for these, not for .value writes.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function toolName(raw) {
  return String(raw).trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

/**
 * An imperative tool for one form. Fills the named controls; submits when the
 * form has toolautosubmit (or options.autosubmit), otherwise focuses the submit
 * button so the person reviews and sends it.
 */
export function formTool(form, options = {}) {
  const autosubmit = options.autosubmit ?? form.hasAttribute('toolautosubmit');
  const allowed = formSchema(form).properties;
  return {
    name: toolName(options.name ?? form.getAttribute('toolname')),
    description: options.description ?? form.getAttribute('tooldescription'),
    inputSchema: formSchema(form),
    annotations: { consequentialHint: autosubmit, ...options.annotations },
    async execute(input) {
      const fields = Object.keys(input ?? {}).filter((k) => k in allowed);
      for (const k of fields) setValue(form, k, input[k]);
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        form.reportValidity?.();
        return { submitted: false, error: 'The form rejected these values', fields };
      }
      if (autosubmit) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return { submitted: true };
      }
      form.querySelector?.('[type=submit],button:not([type])')?.focus?.();
      return { submitted: false, note: 'Filled in. Ask the person to review the form and press submit.' };
    },
  };
}

/**
 * Register every form[toolname][tooldescription] under root as an imperative
 * tool, unless the browser already turns those forms into tools itself.
 */
export async function registerForms(root = globalThis.document, options = {}) {
  if (!root?.querySelectorAll) return () => {};
  if (!options.force && supportsDeclarativeForms()) return () => {};
  const forms = [...root.querySelectorAll('form[toolname][tooldescription]')];
  return registerTools(forms.map((f) => formTool(f)), options);
}
