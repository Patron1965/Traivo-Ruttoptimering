import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;

  return (
    <div className={cn(
      "flex items-center rounded-lg border",
      compact
        ? "h-10 gap-1 border-border bg-card/70 px-1.5"
        : "gap-2 border-sidebar-border bg-sidebar-accent px-3 py-2",
    )}>
      <Globe className={cn("h-4 w-4", compact ? "text-muted-foreground" : "text-sidebar-foreground/50")} />
      <div className={cn("flex items-center", compact ? "gap-0.5" : "gap-1")}>
        <button
          onClick={() => i18n.changeLanguage("sv")}
          aria-pressed={currentLang === "sv"}
          aria-label={t("common.switchToSwedish", "Byt till svenska")}
          className={cn(
            "flex items-center justify-center rounded text-xs font-bold transition-all",
            compact ? "h-8 min-w-8 px-1.5" : "min-h-[44px] min-w-[44px]",
            currentLang === "sv"
              ? "bg-primary text-primary-foreground shadow-sm"
              : compact
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          )}
        >
          SV
        </button>
        <button
          onClick={() => i18n.changeLanguage("en")}
          aria-pressed={currentLang === "en"}
          aria-label={t("common.switchToEnglish", "Switch to English")}
          className={cn(
            "flex items-center justify-center rounded text-xs font-bold transition-all",
            compact ? "h-8 min-w-8 px-1.5" : "min-h-[44px] min-w-[44px]",
            currentLang === "en"
              ? "bg-primary text-primary-foreground shadow-sm"
              : compact
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          )}
        >
          EN
        </button>
      </div>
    </div>
  );
}
