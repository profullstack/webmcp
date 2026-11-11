// React binding: register a tool while a component is mounted.
//
//   'use client';
//   import { useWebMCPTool } from '@profullstack/webmcp/react';
//   useWebMCPTool({ name: 'add_to_cart', description: '...', inputSchema, execute }, [cart]);
//
// execute always sees the latest props/state; the registration itself only
// changes when deps change.

import { useEffect, useRef } from 'react';
import { registerTool, registerTools } from './core.js';

export function useWebMCPTool(tool, deps = []) {
  const ref = useRef(tool);
  ref.current = tool;
  useEffect(() => {
    const ac = new AbortController();
    registerTool({ ...ref.current, execute: (input, opts) => ref.current.execute(input, opts) }, { signal: ac.signal }).catch(
      (err) => console.warn('[webmcp]', err?.message ?? err),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current.name, ...deps]);
}

export function useWebMCPTools(tools, deps = []) {
  const ref = useRef(tools);
  ref.current = tools;
  useEffect(() => {
    const ac = new AbortController();
    registerTools(
      ref.current.map((t, i) => ({ ...t, execute: (input, opts) => ref.current[i].execute(input, opts) })),
      { signal: ac.signal },
    ).catch((err) => console.warn('[webmcp]', err?.message ?? err));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
