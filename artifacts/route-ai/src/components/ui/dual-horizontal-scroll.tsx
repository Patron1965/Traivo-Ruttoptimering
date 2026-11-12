import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import "./dual-horizontal-scroll.css";

/** Two native scrollbars for one wide table, kept in sync in both directions. */
type DualHorizontalScrollProps = {
  children: ReactNode;
  label: string;
  /** Additional attributes for the top scrollbar, including className and event handlers. */
  topProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "ref">;
  /** Additional attributes for the data content scroller, including className and event handlers. */
  contentProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "ref">;
  topRef?: Ref<HTMLDivElement>;
};

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export const DualHorizontalScroll = forwardRef<HTMLDivElement, DualHorizontalScrollProps>(
  function DualHorizontalScroll(
    { children, label, topProps, contentProps, topRef: forwardedTopRef },
    forwardedContentRef,
  ) {
    const topRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [overflowing, setOverflowing] = useState(false);
    const [viewportWidth, setViewportWidth] = useState(0);
    const [position, setPosition] = useState(0);

    const {
      className: topClassName,
      onScroll: onTopScroll,
      ...restTopProps
    } = topProps ?? {};
    const {
      className: contentClassName,
      onScroll: onContentScroll,
      ...restContentProps
    } = contentProps ?? {};

    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content) return;

      const measure = () => {
        const nextWidth = content.scrollWidth;
        const nextOverflowing = nextWidth > content.clientWidth;
        setWidth((current) => current === nextWidth ? current : nextWidth);
        setViewportWidth(content.clientWidth);
        setPosition(content.scrollLeft);
        setOverflowing((current) => current === nextOverflowing ? current : nextOverflowing);
        if (topRef.current) topRef.current.scrollLeft = content.scrollLeft;
      };

      measure();
      const resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(content);
      if (content.firstElementChild) resizeObserver.observe(content.firstElementChild);

      const mutationObserver = new MutationObserver(measure);
      mutationObserver.observe(content, { childList: true, subtree: true, characterData: true });
      window.addEventListener("resize", measure);

      return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        window.removeEventListener("resize", measure);
      };
    }, [children]);

    useLayoutEffect(() => {
      if (topRef.current && contentRef.current) {
        topRef.current.scrollLeft = contentRef.current.scrollLeft;
      }
    }, [width, overflowing]);

    return (
      <>
        {overflowing && (
          <div className="border-b border-border bg-muted px-2 py-1">
            <input
              type="range"
              className="dual-horizontal-scroll-control"
              aria-label={label}
              min={0}
              max={Math.max(0, width - viewportWidth)}
              value={position}
              step={1}
              style={{ "--scroll-thumb-width": `${Math.max(24, (viewportWidth / width) * (viewportWidth - 16))}px` } as CSSProperties}
              onChange={(event) => {
                const next = Number(event.target.value);
                setPosition(next);
                if (contentRef.current) contentRef.current.scrollLeft = next;
                if (topRef.current) topRef.current.scrollLeft = next;
              }}
            />
          </div>
        )}
        <div
          {...restTopProps}
          ref={(element) => {
            setRef(forwardedTopRef, element);
            topRef.current = element;
          }}
          aria-hidden="true"
          aria-label={topProps?.["aria-label"] ?? label}
          tabIndex={-1}
          hidden={!overflowing}
          className={cn(
            "overflow-x-auto overflow-y-hidden",
            topClassName,
          )}
          style={{ height: 0 }}
          onScroll={(event) => {
            const content = contentRef.current;
            if (content && content.scrollLeft !== event.currentTarget.scrollLeft) {
              content.scrollLeft = event.currentTarget.scrollLeft;
            }
            onTopScroll?.(event);
          }}
        >
          <div aria-hidden="true" style={{ width, height: 1 }} />
        </div>
        <div
          {...restContentProps}
          ref={(element) => {
            setRef(forwardedContentRef, element);
            contentRef.current = element;
          }}
          className={cn("overflow-x-auto", contentClassName)}
          onScroll={(event) => {
            setPosition(event.currentTarget.scrollLeft);
            const top = topRef.current;
            if (top && top.scrollLeft !== event.currentTarget.scrollLeft) {
              top.scrollLeft = event.currentTarget.scrollLeft;
            }
            onContentScroll?.(event);
          }}
        >
          {children}
        </div>
      </>
    );
  },
);

DualHorizontalScroll.displayName = "DualHorizontalScroll";