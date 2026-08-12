/**
 * AuthContext - Manages authentication state for the app.
 *
 * Provides:
 * - Auth status checking on mount
 * - Login/logout/password-management functions
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

export interface AuthContextValue {
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether auth check is in progress */
  isLoading: boolean;
  /** Whether auth is enabled in settings */
  authEnabled: boolean;
  /** Whether the server has a desktop auth token (Tauri app) */
  hasDesktopToken: boolean;
  /** Whether unauthenticated localhost access is allowed */
  localhostOpen: boolean;
  /** Whether this request may perform localhost-only password management */
  localManagementAllowed: boolean;
  /** Login with password */
  login: (password: string) => Promise<void>;
  /** Logout current session */
  logout: () => Promise<void>;
  /** Enable auth with a password (from settings) */
  enableAuth: (adminPassword: string, newPassword: string) => Promise<void>;
  /** Disable auth after administrator confirmation */
  disableAuth: (adminPassword: string) => Promise<void>;
  /** Change password */
  changePassword: (adminPassword: string, newPassword: string) => Promise<void>;
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
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [hasDesktopToken, setHasDesktopToken] = useState(false);
  const [localhostOpen, setLocalhostOpenState] = useState(false);
  const [localManagementAllowed, setLocalManagementAllowed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const checkAuth = useCallback(async () => {
    try {
      const status = await api.getAuthStatus();
      setAuthEnabled(status.enabled);
      setIsAuthenticated(status.authenticated);
      setHasDesktopToken(status.hasDesktopToken);
      setLocalhostOpenState(status.localhostOpen);
      setLocalManagementAllowed(status.localManagementAllowed);
    } catch (error) {
      // If we get a network error or the endpoint doesn't exist,
      // assume auth is not enabled (for backward compatibility)
      console.warn(
        "[Auth] Auth check failed, assuming auth not enabled:",
        error,
      );
      setIsAuthenticated(true);
      setAuthEnabled(false);
      setLocalManagementAllowed(false);
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
      location.pathname !== "/login"
    ) {
      navigate("/login", { state: { from: location.pathname } });
    }
  }, [isLoading, isAuthenticated, authEnabled, location.pathname, navigate]);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setIsAuthenticated(true);
    // Clear the global login required flag so connections can resume
    authEvents.clearLoginRequired();
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setIsAuthenticated(false);
    navigate("/login");
  }, [navigate]);

  const enableAuth = useCallback(
    async (adminPassword: string, newPassword: string) => {
      await api.enableAuth(adminPassword, newPassword);
      setAuthEnabled(true);
      setIsAuthenticated(false);
      // The useEffect will redirect to /login with { from: location.pathname }
    },
    [],
  );

  const disableAuth = useCallback(async (adminPassword: string) => {
    await api.disableAuth(adminPassword);
    setAuthEnabled(false);
    setIsAuthenticated(true); // No auth needed after disabling
  }, []);

  const changePassword = useCallback(
    async (adminPassword: string, newPassword: string) => {
      await api.changePassword(adminPassword, newPassword);
      setAuthEnabled(true);
      setIsAuthenticated(false);
    },
    [],
  );

  const setLocalhostOpen = useCallback(async (open: boolean) => {
    await api.setLocalhostAccess(open);
    setLocalhostOpenState(open);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        authEnabled,
        hasDesktopToken,
        localhostOpen,
        localManagementAllowed,
        login,
        logout,
        enableAuth,
        disableAuth,
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
