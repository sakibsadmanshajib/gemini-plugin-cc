/**
 * Ambient type stub for ACP message shapes.
 *
 * The authoritative protocol types live at
 * `plugins/gemini/scripts/lib/acp-protocol.d.ts` (declared in the gemini-plugin-baseline
 * spec at commit f8f773c). This file re-exports the most commonly referenced types
 * for use in JSDoc annotations on .mjs files where the relative import would be noisy.
 *
 * Add to this file only when a type is referenced from multiple .mjs files via JSDoc.
 * Single-file references should use the full relative path.
 */

import type {
  AcpMethodMap,
  AcpNotification,
  ApprovalMode,
  AuthenticateParams,
  BrokerDiagnosticNotification,
  ClientInfo,
  InitializeParams,
  InitializeResult,
  SessionUpdate,
  SessionUpdateNotification
} from "../plugins/gemini/scripts/lib/acp-protocol";

declare global {
  namespace Acp {
    type Notification = AcpNotification;
    type MethodMap = AcpMethodMap;
    type Approval = ApprovalMode;
    type Authenticate = AuthenticateParams;
    type Client = ClientInfo;
    type Initialize = InitializeParams;
    type InitResult = InitializeResult;
    type Update = SessionUpdate;
    type UpdateNotification = SessionUpdateNotification;
    type BrokerDiag = BrokerDiagnosticNotification;
  }
}

export {};
