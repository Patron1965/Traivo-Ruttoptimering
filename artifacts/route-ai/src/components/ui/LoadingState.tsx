import { Loader2 } from "lucide-react";

export function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] w-full gap-4 text-muted-foreground">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="font-medium animate-pulse">{message}</p>
    </div>
  );
}

export function ErrorState({ error }: { error: Error | unknown }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] w-full gap-4 p-6 bg-destructive/5 rounded-2xl border border-destructive/20">
      <div className="h-12 w-12 rounded-full bg-destructive/20 flex items-center justify-center text-destructive">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div className="text-center">
        <h3 className="text-lg font-bold text-foreground">Something went wrong</h3>
        <p className="mt-1 text-sm text-muted-foreground">{error instanceof Error ? error.message : "Failed to load data"}</p>
      </div>
    </div>
  );
}
