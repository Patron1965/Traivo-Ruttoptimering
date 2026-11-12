/** Width below which the side navigation starts collapsed unless the user chose otherwise. */
export const COMPACT_SIDEBAR_MAX_WIDTH = 1440;

/** Stored "1"/"0" wins; otherwise collapse on small laptops (1366x768 etc). */
export function initialSidebarCollapsed(stored: string | null, viewportWidth: number): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return viewportWidth < COMPACT_SIDEBAR_MAX_WIDTH;
}

/**
 * The progress card already renders the monitor's terminal error. The step
 * should only show its own alert when it carries a different message.
 */
export function shouldShowStepError(
  stepError: string | null,
  progress: { visible: boolean; status: string; errorMessage?: string | null },
): boolean {
  if (!stepError) return false;
  if (progress.visible && progress.status === "error" && progress.errorMessage) {
    return progress.errorMessage.trim() !== stepError.trim();
  }
  return true;
}
