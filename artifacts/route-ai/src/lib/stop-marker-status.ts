/** Fixed markup only; preserve the vehicle colour and sequence underneath. */
export function stopMarkerStatusBadge(status?: string): string {
  if (status !== "completed") return "";
  return '<span data-stop-status="completed" role="img" aria-label="Utfört" title="Utfört" style="position:absolute;right:-7px;top:-7px;width:18px;height:18px;border-radius:50%;background:#047857;color:white;border:2px solid white;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;line-height:1;box-shadow:0 1px 4px #0005;z-index:2">✓</span>';
}
