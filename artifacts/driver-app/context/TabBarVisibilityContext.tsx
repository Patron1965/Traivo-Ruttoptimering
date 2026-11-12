import React, { createContext, useContext, useMemo, useState } from "react";

type TabBarVisibility = {
  /** False when the user has explicitly hidden the bottom menu. */
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  /** True only where the collapsible classic bar is rendered (not NativeTabs). */
  collapsible: boolean;
};

const Ctx = createContext<TabBarVisibility>({ expanded: true, setExpanded: () => {}, collapsible: false });

export function TabBarVisibilityProvider({ children, collapsible }: { children: React.ReactNode; collapsible: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const value = useMemo(() => ({ expanded, setExpanded, collapsible }), [expanded, collapsible]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTabBarVisibility() {
  return useContext(Ctx);
}
