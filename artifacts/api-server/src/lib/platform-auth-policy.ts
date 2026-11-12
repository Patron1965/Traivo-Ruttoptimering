/**
 * Temporary, server-only opt-in, including published deployments. Read on every
 * check: turning this off must not grandfather password-only sessions.
 */
export function platformPasswordOnlyTestMode(): boolean {
  return process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE === "true";
}

export function sessionAuthenticationAllowed(
  user: {
    isActive: boolean;
    isPlatformAdmin: boolean;
    mfaRecoveryRequired: boolean;
    mfaLockedUntil: Date | null;
    lockedUntil: Date | null;
  } | undefined,
  session: { mfaVerifiedAt: Date | null },
): boolean {
  if (!user?.isActive || user.mfaRecoveryRequired) return false;
  if (!user.isPlatformAdmin) return true;
  if ((user.lockedUntil?.getTime() ?? 0) > Date.now() ||
    (user.mfaLockedUntil?.getTime() ?? 0) > Date.now()) return false;
  return Boolean(session.mfaVerifiedAt) || platformPasswordOnlyTestMode();
}