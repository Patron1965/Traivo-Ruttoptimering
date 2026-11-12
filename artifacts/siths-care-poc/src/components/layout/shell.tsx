import { Link, useLocation } from 'wouter';
import { cn } from '@/lib/utils';
import { Activity, ShieldCheck } from 'lucide-react';
import React from 'react';

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: '/', label: 'Arbetspass', icon: Activity },
    { href: '/säkerhet', label: 'Säkerhet & Loggar', icon: ShieldCheck },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-40 w-full border-b bg-card/80 backdrop-blur-md">
        <div className="container mx-auto px-3 sm:px-4 h-16 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex shrink-0 items-center justify-center w-8 h-8 rounded-lg bg-primary/10 text-primary">
              <Activity className="w-5 h-5" />
            </div>
            <span className="truncate font-semibold text-sm tracking-tight text-foreground sm:text-lg">
              Vård-PoC <span className="hidden text-muted-foreground font-normal md:inline">| SITHS Autentisering</span>
            </span>
          </div>
          <nav className="flex shrink-0 items-center gap-1" aria-label="Huvudnavigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center"
                  aria-label={item.label}
                  data-testid={`link-nav-${item.href === '/' ? 'home' : 'security'}`}
                >
                  <span 
                    className={cn(
                      "flex items-center gap-2 px-2 py-2 rounded-md text-sm font-medium transition-colors sm:px-3",
                      isActive 
                        ? "bg-secondary text-secondary-foreground" 
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      <footer className="border-t bg-card py-6 mt-auto">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>Endast för utvärdering (Proof of Concept). Inga verkliga patientuppgifter hanteras.</p>
        </div>
      </footer>
    </div>
  );
}
