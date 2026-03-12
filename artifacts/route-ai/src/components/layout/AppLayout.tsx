import { ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative">
      <Sidebar className="hidden md:flex w-72 flex-shrink-0" />

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="relative w-72 max-w-[80%] flex-shrink-0 bg-sidebar shadow-2xl h-full flex flex-col animate-in slide-in-from-left">
            <Button 
              variant="ghost" 
              size="icon" 
              className="absolute top-4 right-4 text-sidebar-foreground"
              onClick={() => setMobileOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
            <Sidebar className="w-full flex-1" />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 border-b border-border bg-card/50 backdrop-blur-md flex items-center px-4 shrink-0 z-10 sticky top-0 justify-between">
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="-ml-2 md:hidden">
              <Menu className="h-6 w-6" />
            </Button>
            <span className="font-display font-bold text-lg ml-2 md:hidden">Route<span className="text-primary">AI</span></span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-background/50 relative">
          <div className="h-full relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
