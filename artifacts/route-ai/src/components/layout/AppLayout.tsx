import { ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative">
      {/* Desktop Sidebar */}
      <Sidebar className="hidden md:flex w-72 flex-shrink-0" />

      {/* Mobile Sidebar Overlay */}
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

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile Header */}
        <header className="md:hidden h-16 border-b border-border bg-card/50 backdrop-blur-md flex items-center px-4 shrink-0 z-10 sticky top-0">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="-ml-2">
            <Menu className="h-6 w-6" />
          </Button>
          <span className="font-display font-bold text-lg ml-2">Route<span className="text-primary">AI</span></span>
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
