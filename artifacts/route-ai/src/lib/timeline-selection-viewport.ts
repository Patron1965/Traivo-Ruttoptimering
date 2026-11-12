type Rectangle = { left: number; top: number; width: number; height: number };

/** Reveal a selected block without scrolling the page or hiding it behind sticky labels. */
export function timelineSelectionViewport(
  viewport: Rectangle,
  block: Rectangle,
  labelWidth: number,
  padding = 12,
): { left: number; top: number } {
  let left = viewport.left;
  let top = viewport.top;
  const availableWidth = viewport.width - labelWidth - padding * 2;
  if (block.left < left + labelWidth + padding || block.width > availableWidth) {
    left = block.left - labelWidth - padding;
  } else if (block.left + block.width > left + viewport.width - padding) {
    left = block.left + block.width - viewport.width + padding;
  }
  if (block.top < top + padding || block.height > viewport.height - padding * 2) {
    top = block.top - padding;
  } else if (block.top + block.height > top + viewport.height - padding) {
    top = block.top + block.height - viewport.height + padding;
  }
  return { left: Math.max(0, left), top: Math.max(0, top) };
}
