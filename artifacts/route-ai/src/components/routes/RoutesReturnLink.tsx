import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { readRoutesReturnTo } from "@/lib/routes-return";

/** Shown only when Dispatch was opened from the project table. */
export function RoutesReturnLink({ search }: { search: string }) {
  const { t } = useTranslation();
  const href = readRoutesReturnTo(search);
  if (!href) return null;
  return (
    <Link
      href={href}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-testid="link-back-to-projects"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {t("routes.table.backToProjects")}
    </Link>
  );
}
