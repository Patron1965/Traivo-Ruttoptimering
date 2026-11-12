export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface HealthcareAssignment {
  id: string;
  careProviderId: string;
  careProviderName: string;
  organizationalUnitId: string;
  organizationalUnitName: string;
  purpose: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface HealthcareIdentity {
  hsaId: string;
  loa: string;
  issuer: string;
  authenticatedAt: string;
  assignments: HealthcareAssignment[];
}

export interface AuthTransaction {
  state: string;
  nonce: string;
  pkceVerifier: string;
  browserBindingHash: string;
  redirectUri: string;
  returnPath: string;
  correlationId: string;
  expiresAt: number;
}

export interface PendingIdentity {
  id: string;
  identity: HealthcareIdentity;
  correlationId: string;
  expiresAt: number;
}

export interface AuthenticatedSession {
  id: string;
  identity: HealthcareIdentity;
  activeAssignment: HealthcareAssignment;
  correlationId: string;
  expiresAt: number;
}

export type AuditEventType =
  | "login_started"
  | "token_rejected"
  | "identity_verified"
  | "assignment_selected"
  | "session_created"
  | "session_expired"
  | "logout";

export interface AuditEvent {
  id: string;
  occurredAt: string;
  eventType: AuditEventType;
  result: "success" | "rejected" | "informational";
  reasonCode: string | null;
  correlationId: string;
}

export interface SessionView {
  state: "anonymous" | "assignment_required" | "authenticated";
  identity: Omit<HealthcareIdentity, "assignments"> | null;
  activeAssignment: HealthcareAssignment | null;
  availableAssignments: HealthcareAssignment[];
  expiresAt: string | null;
  devHarnessEnabled: boolean;
}

export type DevScenario =
  | "valid"
  | "valid_multiple_assignments"
  | "tampered_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_nonce"
  | "replay"
  | "expired"
  | "low_loa"
  | "missing_hsa_id"
  | "missing_assignment";

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface JwkSet {
  keys: Array<Record<string, JsonValue>>;
}

export interface IdTokenVerificationContext {
  issuer: string;
  audience: string;
  expectedNonce: string;
  jwks: JwkSet;
  acceptedLoaValues: string[];
  hsaIdClaim: string;
  loaClaim: string;
  assignmentsClaim: string;
  now?: number;
}