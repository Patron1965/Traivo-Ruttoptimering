"use client"

import { forwardRef, useId, useLayoutEffect, useState } from "react"
import { GripVertical } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) => (
  <ResizablePrimitive.PanelGroup
    className={cn(
      "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
      className
    )}
    {...props}
  />
)

type ResizablePanelProps = React.ComponentProps<typeof ResizablePrimitive.Panel> & {
  /**
   * Panel constraints are percentage based in react-resizable-panels. This
   * optional constraint keeps a panel at least this many pixels tall/wide
   * while there is enough room in its parent group.
   */
  minSizePixels?: number
}

const ResizablePanel = forwardRef<
  React.ElementRef<typeof ResizablePrimitive.Panel>,
  ResizablePanelProps
>(({ minSizePixels, minSize, ...props }, ref) => {
  const marker = useId()
  const [pixelMinSizePercent, setPixelMinSizePercent] = useState<number>()

  useLayoutEffect(() => {
    if (minSizePixels == null || typeof document === "undefined") {
      setPixelMinSizePercent(undefined)
      return
    }

    const panel = document.querySelector<HTMLElement>(
      `[data-resizable-panel-marker="${marker}"]`,
    )
    const group = panel?.parentElement
    if (!group) return

    const updatePixelConstraint = () => {
      const direction = group.getAttribute("data-panel-group-direction")
      const axis = direction === "vertical" ? "height" : "width"
      const groupSize = group.getBoundingClientRect()[axis]
      const handleSize = Array.from(group.children).reduce(
        (total, child) =>
          child.hasAttribute("data-panel-resize-handle")
            ? total + child.getBoundingClientRect()[axis]
            : total,
        0,
      )
      const availablePanelSize = groupSize - handleSize
      if (!Number.isFinite(availablePanelSize) || availablePanelSize <= 0) {
        return
      }

      // Two panes must share the available space. When less than two pixel
      // minimums fit, cap each percentage so the responsive stack can still
      // shrink instead of overflowing its group.
      const nextPercent = Math.min(
        50,
        Math.max(0, (minSizePixels / availablePanelSize) * 100),
      )
      const roundedPercent = Math.round(nextPercent * 100) / 100
      setPixelMinSizePercent((previous) =>
        previous === roundedPercent ? previous : roundedPercent,
      )
    }

    updatePixelConstraint()
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updatePixelConstraint)
        : null
    resizeObserver?.observe(group)

    // Restoring a hidden pane adds a resize handle without changing the
    // group's outer size, so observe child changes as well.
    const mutationObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(updatePixelConstraint)
        : null
    mutationObserver?.observe(group, { childList: true })

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [marker, minSizePixels])

  const effectiveMinSize =
    pixelMinSizePercent == null
      ? minSize
      : Math.max(minSize ?? 0, pixelMinSizePercent)

  return (
    <ResizablePrimitive.Panel
      {...props}
      ref={ref}
      minSize={effectiveMinSize}
      defaultSize={props.defaultSize == null ? undefined : Math.min(
        props.maxSize ?? 100, Math.max(props.defaultSize, effectiveMinSize ?? 0),
      )}
      data-resizable-panel-marker={marker}
    />
  )
})
ResizablePanel.displayName = ResizablePrimitive.Panel.displayName

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) => (
  <ResizablePrimitive.PanelResizeHandle
    className={cn(
      "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </ResizablePrimitive.PanelResizeHandle>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
