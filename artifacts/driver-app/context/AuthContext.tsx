import React, { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@/lib/environment-storage";
import { AppState } from "react-native";
import { setSessionVerificationHandler } from "@/lib/session-verification";
import {
  api,
  clearAuthenticatedSession,
  isAuthError,
  ApiError,
  setAuthenticatedSession,
  setPendingAuthToken,
  setBearerOnlySession,
  setSessionExpiredHandler,
  type AuthUser,
  type Driver,
  type LoginResponse,
} from "@/lib/api";
import { getPersistedGpsSession, stopBackgroundGps } from "@/lib/gps-task";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useOfflineSync } from "@/hooks/useOfflineSync";
import {
  pauseOfflineQueueForScopeChange,
  setOfflineQueueScope,
  setOfflineCacheExpiry,
} from "@/lib/offline-queue";
import { createSingleFlight } from "@/lib/driver-link";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { createOfflineSession, readOfflineSession, sameOfflineAssignment, OFFLINE_SESSION_KEY, type OfflineSession } from "@/lib/offline-session";

interface AuthState {
  user: AuthUser | null;
  driver: Driver | null;
  isAdmin: boolean;
  isLoading: boolean;
  isOfflineRestored: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  verifyEmailCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  activateDriverLink: (token: string) => Promise<string>;
}

const AuthContext = createContext<AuthState | null>(null);

const TOKEN_KEY = "routeai_token";
const BEARER_ONLY_KEY = "routeai_bearer_only";
// Module scope so strict-mode remounts of the provider/screen share one flight.
const driverLinkFlight = createSingleFlight<string>();

class NotADriverError extends Error {
  constructor() {
    super("NOT_A_DRIVER");
    this.name = "NotADriverError";
  }
}

export const isNotADriverError = (err: unknown) => err instanceof NotADriverError;

function DriverEffects({ driver, verifySession, online }: { driver: Driver | null; verifySession: () => Promise<boolean>; online: boolean }) {
  usePushNotifications(online ? driver?.id : undefined);
  useOfflineSync(!!driver, driver?.id, verifySession);
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOfflineRestored, setIsOfflineRestored] = useState(false);
  const { isOnline } = useNetworkStatus(true);
  const queryClient = useQueryClient();
  const snapshot = useRef<OfflineSession | null>(null);
  const currentToken = useRef<string | null>(null);
  const generation = useRef(0);
  const verification = useRef<{ generation: number; promise: Promise<boolean> } | null>(null);

  async function invalidateSession() {
    generation.current++;
    currentToken.current = null;
    snapshot.current = null;
    clearAuthenticatedSession();
    setUser(null);
    setDriver(null);
    setIsOfflineRestored(false);
    queryClient.clear();
    // Remove the durable reopening grant before waiting for an in-flight sync
    // or OS shutdown. Killing the app during logout must not restore it.
    await AsyncStorage.multiRemove([TOKEN_KEY, OFFLINE_SESSION_KEY, BEARER_ONLY_KEY]);
    await stopBackgroundGps().catch(() => {});
    await pauseOfflineQueueForScopeChange();
    setOfflineQueueScope(null);
  }

  useEffect(() => {
    setSessionExpiredHandler(invalidateSession);
    setSessionVerificationHandler(verifySession);
    restoreSession();
    // Safari may resume with cached data after a transient verification failure
    // without emitting a new online event. Revalidate, never replay mutations.
    const resume = () => {
      if (currentToken.current) void verifySession();
    };
    const appState = AppState.addEventListener("change", state => {
      if (state === "active") resume();
    });
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
    return () => {
      setSessionExpiredHandler(null);
      setSessionVerificationHandler(null);
      appState.remove();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  useEffect(() => {
    if (isLoading || !currentToken.current) return;
    if (isOnline) {
      void verifySession();
    } else if (snapshot.current) {
      setPendingAuthToken(currentToken.current);
      setOfflineCacheExpiry(snapshot.current.expiresAt);
      setIsOfflineRestored(true);
    }
  }, [isOnline, isLoading]);

  useEffect(() => {
    if (!isOfflineRestored || !snapshot.current) return;
    const expiresAt = snapshot.current.expiresAt;
    const timer = setTimeout(() => { void invalidateSession(); }, Math.max(0, expiresAt - Date.now()));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() >= expiresAt) void invalidateSession();
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [isOfflineRestored, user, driver]);

  async function resolveDriver(driverProfileId: string | null): Promise<Driver> {
    if (!driverProfileId) throw new NotADriverError();
    return api.verifyDriver(driverProfileId);
  }

  async function restoreSession() {
    let token: string | null = null;
    try {
      await stopBackgroundGps().catch(() => {});
      token = await AsyncStorage.getItem(TOKEN_KEY);
      if (!token) {
        await stopBackgroundGps();
        setOfflineQueueScope(null);
        return;
      }
      currentToken.current = token;
      setBearerOnlySession((await AsyncStorage.getItem(BEARER_ONLY_KEY)) === "1");
      snapshot.current = readOfflineSession(await AsyncStorage.getItem(OFFLINE_SESSION_KEY), token);
      await verifySession();
    } finally {
      setIsLoading(false);
    }
  }

  function verifySession(): Promise<boolean> {
    if (verification.current?.generation === generation.current) return verification.current.promise;
    const runGeneration = generation.current;
    const promise = verifyCurrentSession().finally(() => {
      if (verification.current?.generation === runGeneration) verification.current = null;
    });
    verification.current = { generation: runGeneration, promise };
    return promise;
  }

  async function verifyCurrentSession(): Promise<boolean> {
    const token = currentToken.current;
    const expectedGeneration = generation.current;
    if (!token) return false;
    try {
      const bearerOnly = (await AsyncStorage.getItem(BEARER_ONLY_KEY)) === "1";
      setPendingAuthToken(token);
      setBearerOnlySession(bearerOnly);
      const { user: restoredUser, session } = await api.me();
      if (generation.current !== expectedGeneration) return false;
      if (restoredUser.role !== "driver" && restoredUser.role !== "admin") throw new NotADriverError();
      // Do not fetch driver data until /auth/me has bound this token to its
      // server-authenticated organization.
      const existingGpsSession = await getPersistedGpsSession();
      if (
        existingGpsSession &&
        (
          existingGpsSession.userId !== restoredUser.id ||
          existingGpsSession.organizationId !== restoredUser.organizationId
        )
      ) {
        await stopBackgroundGps();
      }
      const d = restoredUser.role === "admin"
        ? null
        : await resolveDriver(restoredUser.driverProfileId);
      if (generation.current !== expectedGeneration) return false;
      if (d && (d.id !== restoredUser.driverProfileId || d.organizationId !== restoredUser.organizationId)) {
        throw new NotADriverError();
      }
      if (snapshot.current && !sameOfflineAssignment(snapshot.current, restoredUser, d)) {
        await invalidateSession();
        return false;
      }
      setAuthenticatedSession(token, restoredUser.organizationId);
      setOfflineCacheExpiry(null);
      setOfflineQueueScope({ userId: restoredUser.id, organizationId: restoredUser.organizationId });
      snapshot.current = createOfflineSession(token, restoredUser, d, session);
      if (snapshot.current) {
        await AsyncStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(snapshot.current));
      } else {
        await AsyncStorage.removeItem(OFFLINE_SESSION_KEY);
      }
      if (generation.current !== expectedGeneration) return false;
      setOfflineCacheExpiry(null);
      setIsOfflineRestored(false);
      setUser(restoredUser);
      setDriver(d);
      return true;
    } catch (err) {
      if (generation.current !== expectedGeneration) return false;
      if (isAuthError(err) || isNotADriverError(err)) {
        await invalidateSession();
        return false;
      }
      // Only a transport failure permits local recovery; 5xx, malformed data
      // and rejected identities never become an offline login.
      const cached = snapshot.current && readOfflineSession(JSON.stringify(snapshot.current), token);
      if (err instanceof ApiError && err.status === 0 && cached) {
        setPendingAuthToken(token);
        await stopBackgroundGps().catch(() => {});
        if (generation.current !== expectedGeneration) return false;
        setOfflineQueueScope({ userId: cached.user.id, organizationId: cached.user.organizationId });
        setOfflineCacheExpiry(cached.expiresAt);
        setUser(cached.user);
        setDriver(cached.driver);
        setIsOfflineRestored(true);
        return false;
      }
      clearAuthenticatedSession();
      setOfflineQueueScope(null);
      queryClient.clear();
      setUser(null);
      setDriver(null);
      return false;
    }
  }

  async function login(email: string, password: string) {
    // Switching accounts invalidates the previous local reopening grant even
    // if the new login fails. Owned queues remain stored, never reassigned.
    await invalidateSession();
    await pauseOfflineQueueForScopeChange();
    // Prevent the previous bearer session (including a same-organization
    // dispatcher/driver switch) from sending another GPS fix.
    try {
      await stopBackgroundGps();
    } catch (error) {
      setOfflineQueueScope(null);
      throw error;
    }
    let loginResult;
    try {
      loginResult = await api.login(email.trim().toLowerCase(), password);
    } catch (error) {
      setOfflineQueueScope(null);
      throw error;
    }
    if ("mfaRequired" in loginResult) return true;
    await completeLogin(loginResult);
    await AsyncStorage.removeItem(BEARER_ONLY_KEY);
    return false;
  }

  function activateDriverLink(token: string): Promise<string> {
    return driverLinkFlight(token, async () => {
      // Finish startup/foreground verification before redeeming. Otherwise its
      // pending-session transition can invalidate an in-flight resume response.
      if (currentToken.current) await verifySession();
      // Redeem first (device bearer, no cookies): a dead link must not sign out a
      // phone that is already signed in. Only a successful redemption replaces
      // the identity, with the same safety as password login: previous
      // identity (incl. admin) dropped, GPS stopped, queues paused and left
      // owned by their original scope (never reassigned).
      const result = await api.redeemDriverLink(token);
      if (result.user.role !== "driver") throw new NotADriverError();
      if (result.resumed && currentToken.current === result.token &&
          user?.id === result.user.id && user.organizationId === result.user.organizationId &&
          user.driverProfileId === result.user.driverProfileId && user.role === "driver") {
        // Reopening today's SMS must not stop GPS, reset execution or change
        // ownership of pending reports. Reverify the retained device session.
        if (!await verifySession()) throw new Error("SESSION_VERIFICATION_FAILED");
        return result.routeId;
      }
      await invalidateSession();
      await pauseOfflineQueueForScopeChange();
      try {
        await stopBackgroundGps();
      } catch (error) {
        setOfflineQueueScope(null);
        throw error;
      }
      setBearerOnlySession(true);
      await completeLogin(result);
      setBearerOnlySession(true);
      await AsyncStorage.setItem(BEARER_ONLY_KEY, "1");
      return result.routeId;
    });
  }

  async function verifyEmailCode(code: string) {
    await completeLogin(await api.verifyEmailCode(code));
    await AsyncStorage.removeItem(BEARER_ONLY_KEY);
  }

  async function completeLogin(loginResult: LoginResponse) {
    const { user, token } = loginResult;
    currentToken.current = token;
    setAuthenticatedSession(token, user.organizationId);
    let d: Driver | null;
    try {
      if (user.role !== "driver" && user.role !== "admin") throw new NotADriverError();
      d = user.role === "admin" ? null : await resolveDriver(user.driverProfileId);
      if (d && (d.id !== user.driverProfileId || d.organizationId !== user.organizationId)) throw new NotADriverError();
    } catch (err) {
      clearAuthenticatedSession();
      setOfflineQueueScope(null);
      currentToken.current = null;
      await AsyncStorage.multiRemove([TOKEN_KEY, OFFLINE_SESSION_KEY, BEARER_ONLY_KEY]);
      throw err;
    }
    await AsyncStorage.setItem(TOKEN_KEY, token);
    snapshot.current = createOfflineSession(token, user, d, loginResult.session);
    if (snapshot.current) await AsyncStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(snapshot.current));
    setIsOfflineRestored(false);
    setUser(user);
    setDriver(d);
    setOfflineQueueScope({ userId: user.id, organizationId: user.organizationId });
  }

  async function logout() {
    // Capture the old bearer for best-effort server revocation, but do not
    // hold local logout open waiting for an unreachable server.
    const revocation = api.logout().catch(() => {});
    await invalidateSession();
    void revocation;
  }

  return (
    <AuthContext.Provider value={{ user, driver, isAdmin: user?.role === "admin", isLoading, isOfflineRestored, login, verifyEmailCode, logout, activateDriverLink }}>
      <DriverEffects driver={driver} verifySession={verifySession} online={!isOfflineRestored} />
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
