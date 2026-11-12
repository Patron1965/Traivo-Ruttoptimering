import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import { useBranding, type Brand } from "@/hooks/use-branding";
import { useAuth } from "@/lib/auth-context";
import { THEME_CSS_VARS } from "@/lib/theme-utils";
import * as themeUtils from "@/lib/theme-utils";
import { useTheme } from "@/context/ThemeContext";

interface BrandingContextValue {
  brand: Brand | null;
  isLoading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  brand: null,
  isLoading: true,
});

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { data: brand, isLoading } = useBranding();
  const { user } = useAuth();
  const { theme } = useTheme();
  
  // Clear branding if user logs out or switches
  const currentBrand = user ? brand || null : null;

  useLayoutEffect(() => {
    if (!currentBrand) {
      THEME_CSS_VARS.forEach(v => document.documentElement.style.removeProperty(v));
      return;
    }

    const vars = themeUtils.computeThemeVariables(currentBrand, theme);
    
    // Set all computed variables
    Object.entries(vars).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
    
    // Clean up variables that are not computed (e.g. if we removed background color)
    THEME_CSS_VARS.forEach(v => {
      if (!vars[v]) document.documentElement.style.removeProperty(v);
    });
    
    return () => {
      THEME_CSS_VARS.forEach(v => document.documentElement.style.removeProperty(v));
    };
  }, [currentBrand, theme]);

  const value = useMemo(() => ({ brand: currentBrand, isLoading }), [currentBrand, isLoading]);

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBrand() {
  return useContext(BrandingContext);
}
