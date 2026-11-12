import { ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, Moon, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useTheme } from "@/context/ThemeContext";
import { useBrand } from "@/context/BrandingContext";
import { ChatTrigger } from "@/components/chat/ChatPanel";
import { initialSidebarCollapsed } from "@/lib/compact-layout";

const SIDEBAR_COLLAPSED_KEY = "traivo.sidebar.collapsed";

export function AppLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const { brand } = useBrand();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return initialSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY), window.innerWidth);
  });

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      // Persist only explicit choices so small laptops keep the compact default.
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="flex h-dvh w-full bg-background overflow-hidden relative">
      <Sidebar
        className={`hidden md:flex flex-shrink-0 ${collapsed ? "w-16" : "w-60 2xl:w-72"}`}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
      />

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="relative w-72 max-w-[80%] flex-shrink-0 bg-sidebar shadow-2xl h-full flex flex-col animate-in slide-in-from-left">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 text-sidebar-foreground min-h-[44px] min-w-[44px]"
              onClick={() => setMobileOpen(false)}
              aria-label={t("common.closeMenu", { defaultValue: "Close menu" })}
            >
              <X className="h-5 w-5" />
            </Button>
            <Sidebar className="w-full flex-1" />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 [@media(max-height:820px)]:h-12 border-b border-border bg-card/50 backdrop-blur-md flex items-center px-4 shrink-0 z-10 sticky top-0 justify-between">
          <div className="flex items-center">
            <span className="hidden md:block text-sm font-semibold truncate max-w-[320px]">{brand?.displayName || "Min organisations arbetsmiljö"}</span>
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="-ml-2 md:hidden" aria-label={t("common.openMenu", { defaultValue: "Open menu" })}>
              <Menu className="h-6 w-6" />
            </Button>
            <div className="md:hidden flex items-center ml-2 h-8 max-w-[150px]">
              {brand && (brand.logoUrl || (theme === "dark" && brand.logoDarkUrl)) ? (
                <img
                  src={(theme === "dark" && brand.logoDarkUrl) ? brand.logoDarkUrl : brand.logoUrl!}
                  alt={brand.displayName || "Logo"}
                  className="max-h-full object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <span className="font-display font-bold text-lg truncate" style={brand?.primaryColor ? { color: "hsl(var(--primary))" } : {}}>
                  {brand?.displayName || (
                    <>Traivo <span className="text-primary">Route</span></>
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ChatTrigger />
            <LanguageSwitcher compact />
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card/70 transition-colors hover:bg-muted"
              title={theme === "dark" ? t("common.lightMode", { defaultValue: "Light mode" }) : t("common.darkMode", { defaultValue: "Dark mode" })}
              aria-label={theme === "dark" ? t("common.switchToLightMode", { defaultValue: "Switch to light mode" }) : t("common.switchToDarkMode", { defaultValue: "Switch to dark mode" })}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4 text-amber-400" />
              ) : (
                <Moon className="h-4 w-4 text-indigo-500" />
              )}
            </button>
            <NotificationBell />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto bg-background/50 relative">
          <div className="h-full relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
