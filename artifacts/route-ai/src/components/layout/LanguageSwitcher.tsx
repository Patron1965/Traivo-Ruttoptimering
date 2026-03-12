import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sidebar-accent border border-sidebar-border">
      <Globe className="h-4 w-4 text-sidebar-foreground/50" />
      <div className="flex items-center gap-1">
        <button
          onClick={() => i18n.changeLanguage("sv")}
          className={cn(
            "px-2.5 py-1 rounded text-xs font-bold transition-all",
            currentLang === "sv"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          )}
        >
          SV
        </button>
        <button
          onClick={() => i18n.changeLanguage("en")}
          className={cn(
            "px-2.5 py-1 rounded text-xs font-bold transition-all",
            currentLang === "en"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          )}
        >
          EN
        </button>
      </div>
    </div>
  );
}
