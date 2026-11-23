/**
 * AuthContext - Manages authentication state for the app.
 *
 * Provides:
 * - Auth status checking on mount
 * - Login/logout/setup functions
 * - Redirect to login when unauthenticated
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { authEvents } from "../lib/authEvents";
import {
  announceAuthSessionTokenToShell,
  getAuthSessionToken,
  setAuthSessionToken,
} from "../lib/authSessionToken";

interface AuthContextValue {
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether account setup is required (no account exists) */
  isSetupMode: boolean;
  /** Whether auth check is in progress */
  isLoading: boolean;
  /** Whether auth is enabled in settings */
  authEnabled: boolean;
  /** Whether auth is disabled by --auth-disable flag (for recovery) */
  authDisabledByEnv: boolean;
  /** Path to auth.json file (for recovery instructions) */
  authFilePath: string;
  /** Whether the server has a desktop auth token (Tauri app) */
  hasDesktopToken: boolean;
  /** Whether unauthenticated localhost access is allowed */
  localhostOpen: boolean;
  /** Login with password */
  login: (password: string) => Promise<void>;
  /** Login by redeeming a one-time pairing token */
  redeemPairing: (token: string, deviceLabel?: string) => Promise<void>;
  /** Logout current session */
  logout: () => Promise<void>;
  /** Enable auth with a password (from settings) */
  enableAuth: (password: string) => Promise<void>;
  /** Disable auth (requires authenticated session) */
  disableAuth: () => Promise<void>;
  /** Create initial account (setup mode only) - deprecated, use enableAuth */
  setupAccount: (password: string) => Promise<void>;
  /** Change password */
  changePassword: (newPassword: string) => Promise<void>;
  /** Toggle unauthenticated localhost access */
  setLocalhostOpen: (open: boolean) => Promise<void>;
  /** Re-check auth status */
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authDisabledByEnv, setAuthDisabledByEnv] = useState(false);
  const [authFilePath, setAuthFilePath] = useState("");
  const [hasDesktopToken, setHasDesktopToken] = useState(false);
  const [localhostOpen, setLocalhostOpenState] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const checkAuth = useCallback(async () => {
    try {
      const status = await api.getAuthStatus();
      if (status.enabled && !status.authenticated && getAuthSessionToken()) {
        // The held bearer token was revoked or expired; drop it so later
        // requests stop presenting it and native watchers stop polling with it.
        setAuthSessionToken(null);
      } else if (status.authenticated) {
        announceAuthSessionTokenToShell();
      }
      setAuthEnabled(status.enabled);
      setAuthDisabledByEnv(status.disabledByEnv);
      setAuthFilePath(status.authFilePath ?? "");
      setIsAuthenticated(status.authenticated);
      setIsSetupMode(status.setupRequired);
      setHasDesktopToken(status.hasDesktopToken ?? false);
      setLocalhostOpenState(status.localhostOpen ?? false);
    } catch (error) {
      // If we get a network error or the endpoint doesn't exist,
      // assume auth is not enabled (for backward compatibility)
      console.warn(
        "[Auth] Auth check failed, assuming auth not enabled:",
        error,
      );
      setIsAuthenticated(true);
      setIsSetupMode(false);
      setAuthEnabled(false);
      setAuthDisabledByEnv(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Check auth status on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Subscribe to global login required events (from 401 responses)
  useEffect(() => {
    const unsubscribe = authEvents.onLoginRequired(() => {
      console.log("[Auth] Login required signal received");
      setIsAuthenticated(false);
      // The redirect effect below will handle navigation to /login
    });
    return unsubscribe;
  }, []);

  // Redirect to login if not authenticated and auth is enabled
  useEffect(() => {
    if (
      !isLoading &&
      !isAuthenticated &&
      authEnabled &&
      !authDisabledByEnv &&
      location.pathname !== "/login"
    ) {
      const from = `${location.pathname}${location.search}${location.hash}`;
      navigate("/login", { state: { from } });
    }
  }, [
    isLoading,
    isAuthenticated,
    authEnabled,
    authDisabledByEnv,
    location.pathname,
    location.search,
    location.hash,
    navigate,
  ]);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setIsAuthenticated(true);
    setIsSetupMode(false);
    // Clear the global login required flag so connections can resume
    authEvents.clearLoginRequired();
  }, []);

  const redeemPairing = useCallback(
    async (token: string, deviceLabel?: string) => {
      await api.redeemPairingToken(token, deviceLabel);
      setIsAuthenticated(true);
      setIsSetupMode(false);
      authEvents.clearLoginRequired();
    },
    [],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setIsAuthenticated(false);
    navigate("/login");
  }, [navigate]);

  const enableAuth = useCallback(async (password: string) => {
    await api.enableAuth(password);
    setAuthEnabled(true);
    setIsAuthenticated(false);
    setIsSetupMode(false);
    // The useEffect will redirect to /login with { from: location.pathname }
  }, []);

  const disableAuth = useCallback(async () => {
    await api.disableAuth();
    setAuthEnabled(false);
    setIsAuthenticated(true); // No auth needed after disabling
  }, []);

  const setupAccount = useCallback(async (password: string) => {
    await api.setupAccount(password);
    setAuthEnabled(true);
    setIsAuthenticated(true);
    setIsSetupMode(false);
    // Clear the global login required flag so connections can resume
    authEvents.clearLoginRequired();
  }, []);

  const changePassword = useCallback(async (newPassword: string) => {
    await api.changePassword(newPassword);
  }, []);

  const setLocalhostOpen = useCallback(async (open: boolean) => {
    await api.setLocalhostAccess(open);
    setLocalhostOpenState(open);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isSetupMode,
        isLoading,
        authEnabled,
        authDisabledByEnv,
        authFilePath,
        hasDesktopToken,
        localhostOpen,
        login,
        redeemPairing,
        logout,
        enableAuth,
        disableAuth,
        setupAccount,
        changePassword,
        setLocalhostOpen,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to access auth state and functions.
 * Must be used within an AuthProvider.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/**
 * Hook to optionally access auth state.
 * Returns null if not within an AuthProvider (e.g., remote client mode).
 */
export function useOptionalAuth() {
  return useContext(AuthContext);
}
