export const VERSION: string;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
  debugging?: boolean;
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

export interface WebMCPTool<I = any, O = any> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  outputSchema?: object;
  annotations?: ToolAnnotations;
  execute(input: I, options: ToolExecuteOptions): O | Promise<O>;
}

export interface RegisterOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
  onError?: (error: unknown, tool: WebMCPTool) => void;
  /** After each agent call: tool name, outcome, duration. Never the input or result. */
  onCall?: (detail: { name: string; ok: boolean; ms: number; error?: 'error' | 'aborted' }) => void;
  context?: unknown;
}

export type Unregister = () => void;

export function getModelContext(doc?: Document, nav?: Navigator): any | null;
export function isSupported(doc?: Document, nav?: Navigator): boolean;
export function defineTool<T extends WebMCPTool>(tool: T): T;
export function registerTool(tool: WebMCPTool, options?: RegisterOptions): Promise<Unregister>;
export function registerTools(tools: WebMCPTool[], options?: RegisterOptions): Promise<Unregister>;
export function listTools(options?: { context?: unknown; fromOrigins?: string[] }): Promise<any[]>;

export interface McpClientOptions {
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}
export function mcpCall(
  url: string,
  options?: McpClientOptions,
): {
  listTools(signal?: AbortSignal): Promise<any[]>;
  callTool(name: string, args?: object, signal?: AbortSignal): Promise<any>;
};
export function mapAnnotations(a?: object): Required<Pick<ToolAnnotations, 'readOnlyHint' | 'consequentialHint' | 'untrustedContentHint'>>;
export function unwrapResult(result: any): any;

export interface BridgeOptions extends McpClientOptions, RegisterOptions {
  include?: string[] | ((name: string) => boolean);
  exclude?: string[] | ((name: string) => boolean);
  prefix?: string;
}
export function bridgeMcpServer(
  url: string,
  options?: BridgeOptions,
): Promise<{ tools: string[]; unregister: Unregister; error?: string }>;

export interface SiteToolsOptions {
  name?: string;
  description?: string;
  search?: string;
  searchApi?: string;
  searchDescription?: string;
  pages?: Record<string, string>;
  llmsTxt?: string | false;
  extraInfo?: Record<string, unknown>;
  document?: Document;
  location?: Location;
  fetch?: typeof fetch;
}
export function siteTools(options?: SiteToolsOptions): WebMCPTool[];

export function supportsDeclarativeForms(win?: any): boolean;
export function formSchema(form: HTMLFormElement): object;
export function formTool(
  form: HTMLFormElement,
  options?: { name?: string; description?: string; autosubmit?: boolean; annotations?: ToolAnnotations },
): WebMCPTool;
export function registerForms(root?: ParentNode, options?: RegisterOptions & { force?: boolean }): Promise<Unregister>;
