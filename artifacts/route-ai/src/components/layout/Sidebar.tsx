import { Link, useLocation } from "wouter";
import { useId, useState } from "react";
import { LayoutDashboard, Truck, Map as MapIcon, Route as RouteIcon, Command, Leaf, PlusCircle, CalendarClock, Shield, ShieldAlert, Smartphone, BarChart3, Settings, UserCog, FolderOpen, FileText, Files, Inbox, Activity, ChevronLeft, ChevronRight, LogOut, Users, IdCard, Hexagon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useAuth, type UserRole } from "@/lib/auth-context";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useBrand } from "@/context/BrandingContext";
import { useTheme } from "@/context/ThemeContext";
import { guardWorkspaceNavigation } from "./WorkspaceTabs";
import { useDistrictCapability } from "@/lib/use-district-capability";

type NavItem = {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  roles?: UserRole[];
  requirePlatformAdmin?: boolean;
  match?: string[];
  fallbackLabel?: {
    sv: string;
    en: string;
  };
};

type NavSection = {
  titleKey: string;
  collapsible?: boolean;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    titleKey: "sidebar.sections.projects",
    items: [
      { href: "/routes", labelKey: "sidebar.allRoutes", icon: RouteIcon, match: ["/planner"] },
    ],
  },
  {
    titleKey: "sidebar.sections.traffic",
    items: [
      { href: "/dispatch?view=live", labelKey: "sidebar.dispatch", icon: CalendarClock, roles: ["admin", "dispatcher"], match: ["/dispatch", "/map"] },
      { href: "/map", labelKey: "sidebar.liveMap", icon: MapIcon, roles: ["driver", "viewer"] },
    ],
  },
  {
    titleKey: "sidebar.sections.overview",
    items: [
      { href: "/overview", labelKey: "sidebar.dashboard", icon: LayoutDashboard },
    ],
  },
  {
    titleKey: "sidebar.sections.plan",
    items: [
      { href: "/orders", labelKey: "sidebar.orderInbox", icon: Inbox, roles: ["admin", "dispatcher"], match: ["/stops", "/orders-pickup-delivery"] },
    ],
  },
  {
    titleKey: "sidebar.sections.resources",
    items: [
      { href: "/customers", labelKey: "sidebar.customerRegister", fallbackLabel: { sv: "Fasta kundstopp", en: "Recurring customer stops" }, icon: Users, roles: ["admin", "dispatcher", "viewer"] },
      { href: "/districts", labelKey: "sidebar.districts", fallbackLabel: { sv: "Distriktsplanering", en: "District planning" }, icon: Hexagon, roles: ["admin", "dispatcher", "viewer"] },
      { href: "/vehicles", labelKey: "sidebar.fleet", icon: Truck, roles: ["admin", "dispatcher"], },
      { href: "/drivers", labelKey: "sidebar.drivers", fallbackLabel: { sv: "Förare", en: "Drivers" }, icon: IdCard, roles: ["admin", "dispatcher"] },
      { href: "/driver-view", labelKey: "sidebar.driverView", icon: Smartphone, roles: ["driver"] },
    ],
  },
  {
    titleKey: "sidebar.sections.followUp",
    collapsible: true,
    items: [
      { href: "/operations", labelKey: "sidebar.operations", icon: Activity, roles: ["admin", "dispatcher"] },
      { href: "/analytics", labelKey: "sidebar.analytics", icon: BarChart3, roles: ["admin", "dispatcher"] },
      { href: "/reports", labelKey: "sidebar.reports", icon: FileText, roles: ["admin", "dispatcher"] },
      { href: "/documents", labelKey: "sidebar.documents", icon: Files, roles: ["admin", "dispatcher"] },
      { href: "/sustainability", labelKey: "sidebar.co2Dashboard", icon: Leaf },
    ],
  },
  {
    titleKey: "sidebar.sections.administration",
    collapsible: true,
    items: [
      { href: "/users", labelKey: "sidebar.users", icon: UserCog, roles: ["admin"] },
      { href: "/user-groups", labelKey: "sidebar.userGroups", icon: FolderOpen, roles: ["admin"] },
      { href: "/customer-portal", labelKey: "sidebar.customerPortal", fallbackLabel: { sv: "Kundportal", en: "Customer portal" }, icon: Users, roles: ["admin"] },
      { href: "/security-logs", labelKey: "sidebar.securityLogs", icon: ShieldAlert, roles: ["admin"] },
      { href: "/settings", labelKey: "sidebar.settings", icon: Settings, roles: ["admin"] },
    ],
  },
  {
    titleKey: "sidebar.sections.platform",
    items: [
      { href: "/platform", labelKey: "sidebar.traivoSuperuser", fallbackLabel: { sv: "Traivo Superuser", en: "Traivo Superuser" }, icon: Shield, requirePlatformAdmin: true },
    ],
  },
  {
    titleKey: "sidebar.sections.aiSupport",
    items: [
      { href: "/ai-support", labelKey: "sidebar.aiSupport", fallbackLabel: { sv: "AI-stöd", en: "AI support" }, icon: Sparkles, roles: ["admin", "dispatcher", "viewer"] },
    ],
  },
];

const ROLE_COLORS: Record<UserRole, string> = {
  admin: "text-red-400",
  dispatcher: "text-blue-400",
  driver: "text-emerald-400",
  viewer: "text-slate-400",
};

interface SidebarProps {
  className?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ className, collapsed = false, onToggleCollapse }: SidebarProps) {
  const sectionId = useId();
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const district = useDistrictCapability();
  const [location] = useLocation();
  const { t, i18n } = useTranslation();
  const { user, logout, hasRole } = useAuth();
  const { brand } = useBrand();
  const { theme } = useTheme();
  const logoUrl = (theme === "dark" && brand?.logoDarkUrl) || brand?.logoUrl;
  const language = (i18n.resolvedLanguage ?? i18n.language).startsWith("sv")
    ? "sv"
    : "en";

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      if (item.href === "/districts" && !district.allowed) return false;
      if (item.requirePlatformAdmin && !user?.isPlatformAdmin) return false;
      if (!item.roles) return true;
      return hasRole(...item.roles);
    }),
  })).filter((section) => section.items.length > 0);

  return (
    <aside className={cn("flex h-full flex-col bg-sidebar border-r border-sidebar-border shadow-2xl shadow-black/50 z-20 transition-[width] duration-200", className)}>
      <div className={cn("flex items-center gap-3 relative", collapsed ? "p-3 justify-center" : "p-6 [@media(max-height:820px)]:p-4")}>
        {logoUrl ? (
          <a
            href={brand?.websiteUrl || undefined}
            target={brand?.websiteUrl ? "_blank" : undefined}
            rel={brand?.websiteUrl ? "noopener noreferrer" : undefined}
            className="flex h-8 min-w-0 w-full items-center justify-start overflow-hidden rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={logoUrl}
              alt={brand?.displayName || "Kundlogotyp"}
              className="max-h-full max-w-full object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </a>
        ) : (
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center shadow-lg shadow-primary/20 shrink-0">
            <Command className="h-4 w-4 text-primary-foreground" />
          </div>
        )}
        {!collapsed && !logoUrl && (
          <div className="flex flex-col min-w-0">
            <span className="font-display font-bold text-xl tracking-tight text-sidebar-foreground truncate" style={brand?.primaryColor ? { color: "hsl(var(--primary))" } : {}}>
              {brand?.displayName || (
                <>Traivo <span className="text-primary">Route</span></>
              )}
            </span>
            {brand?.websiteUrl && (
              <a href={brand.websiteUrl} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:underline truncate">
                {brand.websiteUrl.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        )}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className={cn(
              "absolute -right-[22px] top-5 h-11 w-11 rounded-full bg-sidebar border border-sidebar-border shadow-md flex items-center justify-center hover:bg-sidebar-accent transition-colors z-30 cursor-pointer",
            )}
            aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5 text-sidebar-foreground" />
            )}
          </button>
        )}
      </div>

      <TooltipProvider delayDuration={100} skipDelayDuration={0}>
        <nav
          aria-label={t("workspace.primaryNavigation", {
            defaultValue: language === "sv" ? "Huvudnavigation" : "Main navigation",
          })}
          className={cn("flex-1 overflow-y-auto overflow-x-hidden", collapsed ? "px-2" : "px-4")}
        >
          {visibleSections.map((section, sectionIdx) => (
            <div key={section.titleKey} className="space-y-1">
              {section.collapsible ? (
                <button
                  type="button"
                  aria-expanded={!!expandedSections[section.titleKey]}
                  aria-controls={`${sectionId}-${section.titleKey}`}
                  aria-label={t(section.titleKey)}
                  title={t(section.titleKey)}
                  onClick={() => setExpandedSections(current => ({
                    ...current,
                    [section.titleKey]: !current[section.titleKey],
                  }))}
                  className={cn(
                    "mt-2 flex min-h-11 w-full items-center rounded-lg text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    collapsed ? "justify-center" : "justify-between gap-2 px-3",
                  )}
                >
                  {!collapsed && <span>{t(section.titleKey)}</span>}
                  <ChevronRight aria-hidden="true" className={cn("h-4 w-4 shrink-0 transition-transform", expandedSections[section.titleKey] && "rotate-90")} />
                </button>
              ) : !collapsed ? (
                <p className="px-3 pt-4 [@media(max-height:820px)]:pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                  {t(section.titleKey, { defaultValue: section.titleKey === "sidebar.sections.aiSupport" ? (language === "sv" ? "AI" : "AI") : undefined })}
                </p>
              ) : (
                sectionIdx > 0 && <div className="my-2 mx-2 border-t border-sidebar-border/60" />
              )}
              <div id={`${sectionId}-${section.titleKey}`} hidden={section.collapsible && !expandedSections[section.titleKey]} className="space-y-1">
              {section.items.map((item) => {
                const pathname = location.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
                const itemPath = item.href.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
                const isNestedPathMatch = (path: string) =>
                  pathname === path || pathname.startsWith(`${path}/`);
                const isActive =
                  pathname === itemPath ||
                  (item.match?.some((path) => isNestedPathMatch(path)) ?? false);
                const label = item.fallbackLabel
                  ? t(item.labelKey, { defaultValue: item.fallbackLabel[language] })
                  : t(item.labelKey);
                const linkEl = (
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => guardWorkspaceNavigation(event, location, item.href)}
                    className={cn(
                      "flex items-center rounded-xl text-sm font-medium transition-all duration-200 group relative",
                      collapsed ? "justify-center px-2 py-2.5 [@media(max-height:820px)]:py-2" : "gap-3 px-3 py-2.5 [@media(max-height:820px)]:py-2",
                      isActive
                        ? "text-sidebar-foreground bg-sidebar-primary/10 shadow-sm"
                        : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    )}
                  >
                    {isActive && (
                      <div className="absolute inset-y-0 left-0 w-1 bg-primary rounded-r-full" />
                    )}
                    <item.icon className={cn("h-5 w-5 shrink-0", isActive ? "text-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80")} />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </Link>
                );
                if (collapsed) {
                  return (
                    <Tooltip key={item.href}>
                      <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8}>
                         {label}
                      </TooltipContent>
                    </Tooltip>
                  );
                }
                return <div key={item.href}>{linkEl}</div>;
              })}
              </div>
            </div>
          ))}
        </nav>
      </TooltipProvider>

      <div className={cn("mt-auto space-y-3", collapsed ? "p-2" : "p-4")}>
        {!collapsed && (
          <div className="p-3 rounded-xl bg-gradient-to-br from-sidebar-accent/50 to-sidebar-accent border border-sidebar-border">
            <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
              <div className="flex items-center gap-2 min-w-0">
                <Shield className={cn("h-4 w-4 shrink-0", user ? ROLE_COLORS[user.role] : "")} />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-sidebar-foreground truncate">{user?.name}</p>
                  <p className={cn("text-[10px] font-semibold uppercase tracking-wider", user ? ROLE_COLORS[user.role] : "")}>
                     {user?.isPlatformAdmin ? "Traivo Superuser" : user?.role}
                  </p>
                </div>
              </div>
              <button
                onClick={() => logout()}
                title={t("auth.logout")}
                aria-label={t("auth.logout")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-border transition-colors shrink-0"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
