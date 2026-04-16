/**
 * Type definitions for the Gemini CLI ACP (Agent Client Protocol).
 * JSON-RPC 2.0 over stdio, started with `gemini --acp`.
 */

// --- JSON-RPC Base Types ---

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// --- ACP Methods ---

export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  mcpServers?: McpServerConfig[];
}

export interface InitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpServerConfig {
  name: string;
  uri?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AuthenticateParams {}

export interface AuthenticateResult {
  authenticated: boolean;
  method?: string;
  user?: string;
}

export interface NewSessionParams {
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
}

export interface NewSessionResult {
  sessionId: string;
}

export interface LoadSessionParams {
  sessionId: string;
}

export interface LoadSessionResult {
  sessionId: string;
  messageCount: number;
}

export interface PromptParams {
  text: string;
  sessionId?: string;
  model?: string;
}

export interface PromptResult {
  text: string;
  sessionId: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: ToolCallRecord[];
  fileChanges?: FileChangeRecord[];
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export interface FileChangeRecord {
  path: string;
  action: "create" | "modify" | "delete";
}

export interface CancelParams {
  sessionId?: string;
}

export interface CancelResult {
  cancelled: boolean;
}

export interface SetSessionModeParams {
  sessionId?: string;
  approvalMode: "default" | "auto_edit" | "yolo" | "plan";
}

export interface SetSessionModeResult {
  approvalMode: string;
}

export interface SetSessionModelParams {
  sessionId?: string;
  model: string;
}

export interface SetSessionModelResult {
  model: string;
}

// --- Broker-Specific Methods ---

export interface BrokerShutdownParams {}
export interface BrokerShutdownResult {
  ok: boolean;
}

// --- ACP Notification Types ---

export type AcpNotification =
  | { method: "progress"; params: { text: string; phase?: string } }
  | { method: "toolCall"; params: ToolCallRecord }
  | { method: "fileChange"; params: FileChangeRecord }
  | { method: "error"; params: { message: string; code?: number } };

// --- Method Map ---

export interface AcpMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  authenticate: { params: AuthenticateParams; result: AuthenticateResult };
  "session/new": { params: NewSessionParams; result: NewSessionResult };
  "session/load": { params: LoadSessionParams; result: LoadSessionResult };
  "session/prompt": { params: PromptParams; result: PromptResult };
  "session/cancel": { params: CancelParams; result: CancelResult };
  "session/set_mode": { params: SetSessionModeParams; result: SetSessionModeResult };
  "session/set_model": { params: SetSessionModelParams; result: SetSessionModelResult };
  "broker/shutdown": { params: BrokerShutdownParams; result: BrokerShutdownResult };
}
