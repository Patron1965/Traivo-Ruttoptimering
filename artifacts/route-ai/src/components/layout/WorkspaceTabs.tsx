import { Link, useLocation } from "wouter";
import { LayoutGrid, Map as MapIcon, PlusCircle, Cpu, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { MouseEvent as ReactMouseEvent } from "react";

type Locale = "sv" | "en";
type LocalizedCopy = Record<Locale, string>;

type Tab = {
  href: string;
  labelKey: string;
  fallbackLabel: LocalizedCopy;
  icon: LucideIcon;
  expert?: boolean;
  exact?: boolean;
};

type WorkspaceNavigationGuard = () => boolean;

let workspaceNavigationGuard: WorkspaceNavigationGuard | null = null;

/**
 * The creation flow is intentionally kept in memory only. Registering a guard
 * here lets the shell (sidebar and workspace tabs) protect in-progress
 * selections without persisting another user's draft in shared browser state.
 */
export function registerWorkspaceNavigationGuard(
  guard: WorkspaceNavigationGuard,
): () => void {
  workspaceNavigationGuard = guard;
  return () => {
    if (workspaceNavigationGuard === guard) {
      workspaceNavigationGuard = null;
    }
  };
}

function pathOnly(value: string): string {
  return value.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
}

function isSamePath(currentLocation: string, targetHref: string): boolean {
  return pathOnly(currentLocation) === pathOnly(targetHref);
}

/**
 * Protect an internal link while retaining normal browser affordances such as
 * opening a link in a new tab or using the context menu.
 */
export function guardWorkspaceNavigation<T extends HTMLElement>(
  event: ReactMouseEvent<T>,
  currentLocation: string,
  targetHref: string,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    isSamePath(currentLocation, targetHref)
  ) {
    return;
  }

  if (workspaceNavigationGuard && !workspaceNavigationGuard()) {
    event.preventDefault();
  }
}

/**
 * The same guard is useful for buttons in the creation flow (for example,
 * resuming an existing draft) where there is no anchor click to intercept.
 */
export function canNavigateWorkspace(
  currentLocation: string,
  targetHref: string,
): boolean {
  if (isSamePath(currentLocation, targetHref)) return true;
  return workspaceNavigationGuard ? workspaceNavigationGuard() : true;
}

function tabMatchesLocation(location: string, tab: Tab): boolean {
  const pathname = pathOnly(location);
  const tabPath = pathOnly(tab.href);
  return pathname === tabPath || (!tab.exact && pathname.startsWith(`${tabPath}/`));
}

function localized(
  t: (key: string, options?: { defaultValue?: string }) => string,
  language: Locale,
  key: string,
  fallbackLabel: LocalizedCopy,
): string {
  return t(key, { defaultValue: fallbackLabel[language] });
}

function Tabs({
  tabs,
  contextLabel,
}: {
  tabs: Tab[];
  contextLabel: { key: string; fallbackLabel: LocalizedCopy };
}) {
  const [location] = useLocation();
  const { t, i18n } = useTranslation();
  const language: Locale = (i18n.resolvedLanguage ?? i18n.language).startsWith("sv")
    ? "sv"
    : "en";
  const activeTab = tabs.find((tab) => tabMatchesLocation(location, tab));
  const activeLabel = activeTab
    ? localized(t, language, activeTab.labelKey, activeTab.fallbackLabel)
    : localized(t, language, contextLabel.key, contextLabel.fallbackLabel);
  const currentContext = t("workspace.currentContext", {
    defaultValue:
      language === "sv"
        ? "Aktivt arbetsområde: {{label}}"
        : "Current workspace: {{label}}",
    label: activeLabel,
  });

  return (
    <nav
      aria-label={localized(t, language, contextLabel.key, contextLabel.fallbackLabel)}
      className="shrink-0 border-b border-border bg-card/60 backdrop-blur-sm"
    >
      <div className="overflow-x-auto overscroll-x-contain" aria-label={t("common.horizontalScroll")}>
        <div className="flex min-w-max items-center gap-1 px-3 py-1.5">
          {tabs.map((tab) => {
            const active = tabMatchesLocation(location, tab);
            const label = localized(t, language, tab.labelKey, tab.fallbackLabel);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                aria-label={tab.expert ? `${label} (${language === "sv" ? "expert" : "expert"})` : label}
                title={tab.expert ? `${label} (${language === "sv" ? "expertfunktion" : "expert feature"})` : label}
                onClick={(event) => guardWorkspaceNavigation(event, location, tab.href)}
                className={cn(
                  "flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
              >
                <tab.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
                {tab.expert && (
                  <span className="rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {language === "sv" ? "Expert" : "Expert"}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {currentContext}
      </span>
    </nav>
  );
}

export function CockpitTabs() {
  return (
    <Tabs
      contextLabel={{
        key: "workspace.trafficControl",
        fallbackLabel: { sv: "Trafikledning", en: "Traffic control" },
      }}
      tabs={[
        {
          href: "/dispatch?view=live",
          labelKey: "cockpit.board",
          fallbackLabel: { sv: "Tavla", en: "Board" },
          icon: LayoutGrid,
        },
        {
          href: "/map",
          labelKey: "cockpit.map",
          fallbackLabel: { sv: "Karta", en: "Map" },
          icon: MapIcon,
        },
      ]}
    />
  );
}

export function RouteBuilderTabs() {
  return (
    <Tabs
      contextLabel={{
        key: "sidebar.allRoutes",
        fallbackLabel: { sv: "Projekt och rutter", en: "Projects and routes" },
      }}
      tabs={[
        {
          href: "/routes",
          labelKey: "sidebar.allRoutes",
          fallbackLabel: { sv: "Projekt och rutter", en: "Projects and routes" },
          icon: LayoutGrid,
          exact: true,
        },
        {
          href: "/routes/create",
          labelKey: "routes.newProject",
          fallbackLabel: { sv: "Nytt projekt", en: "New project" },
          icon: PlusCircle,
        },
        {
          href: "/planner",
          labelKey: "routes.planExistingStops",
          fallbackLabel: { sv: "Planera befintliga stopp", en: "Plan existing stops" },
          icon: Cpu,
        },
      ]}
    />
  );
}
