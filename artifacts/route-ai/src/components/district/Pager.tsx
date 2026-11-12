import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Renders one page of a long list so 6000-row data never hits the DOM at once. */
export function PagedList<T>({ items, pageSize = 100, render, empty, testId }: {
  items: readonly T[];
  pageSize?: number;
  render: (item: T, index: number) => ReactNode;
  empty?: ReactNode;
  testId: string;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => { if (page >= pages) setPage(pages - 1); }, [page, pages]);
  if (items.length === 0) return <>{empty ?? null}</>;
  const start = page * pageSize;
  return (
    <div data-testid={testId}>
      <ul className="divide-y divide-border/60">{items.slice(start, start + pageSize).map((item, i) => render(item, start + i))}</ul>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
          <span>{start + 1}–{Math.min(items.length, start + pageSize)} av {items.length.toLocaleString("sv-SE")}</span>
          <div className="flex gap-1">
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Föregående sida" data-testid={`${testId}-prev`}><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Nästa sida" data-testid={`${testId}-next`}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
