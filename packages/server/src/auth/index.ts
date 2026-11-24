export {
  AuthService,
  type AuthServiceOptions,
  type AuthState,
  type CreateSessionOptions,
  type PublicSessionInfo,
  type SessionAuthMethod,
  type SessionValidationResult,
  type StoredSession,
} from "./AuthService.js";
export {
  PairingService,
  type CreatedPairingToken,
  type PairingRedeemResult,
  type PairingServiceOptions,
} from "./PairingService.js";
export {
  AuthRateLimiter,
  type AuthRateLimiterOptions,
  type RateLimitDecision,
} from "./RateLimiter.js";
export {
  createAuthRoutes,
  GATE_COOKIE_NAME,
  getClientRateLimitKey,
  getRequestSessionCredential,
  getSessionCookiePath,
  sanitizeGateRedirect,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_QUERY_PARAM,
  setGateCookie,
  type SessionCredential,
  type SessionCredentialSource,
  setSessionCookie,
  shouldUseSecureCookie,
  type AuthRoutesDeps,
} from "./routes.js";
