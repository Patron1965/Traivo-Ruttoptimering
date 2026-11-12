import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";

/** Size to the space below the actual header, including preview/tenant banners. */
export function ImportViewport({ embedded, style, ...props }: ComponentProps<"div"> & { embedded: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (embedded || !ref.current) return;
    const element = ref.current;
    const measure = () => {
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const available = Math.max(0, bottom - element.getBoundingClientRect().top);
      setHeight(Math.min(available, element.parentElement?.clientHeight || available));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element.parentElement) observer.observe(element.parentElement);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [embedded]);
  return <div {...props} ref={ref} style={{ ...style, ...(!embedded && height !== undefined ? { height } : {}) }} />;
}
