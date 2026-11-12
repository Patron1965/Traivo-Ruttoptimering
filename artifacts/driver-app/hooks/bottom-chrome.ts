/** Menu toggle control: 44px touch target plus breathing room. */
export const MENU_TOGGLE_SIZE = 44;
export const MENU_TOGGLE_GAP = 6;

/**
 * Space the bottom chrome occupies over scroll content.
 * Expanded: the toggle lives inside the tab row, so only row + inset.
 * Collapsed: only the floating "Visa meny" pill (44 + gap) above the inset.
 */
export function computeBottomChromeHeight(opts: {
  expanded: boolean;
  collapsible: boolean;
  insetBottom: number;
  rowHeight: number;
}): number {
  if (opts.collapsible && !opts.expanded) return opts.insetBottom + MENU_TOGGLE_SIZE + MENU_TOGGLE_GAP;
  return opts.rowHeight + opts.insetBottom;
}

/** Right padding reserved on the tab bar for the in-row toggle slot. */
export const MENU_TOGGLE_SLOT = 60;
