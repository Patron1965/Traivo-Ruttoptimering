import { useGetPlatformCuoptStatus, useTestPlatformCuoptConnection } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function CuoptConnection() {
  const { data, isLoading, isError } = useGetPlatformCuoptStatus();
  const test = useTestPlatformCuoptConnection();
  const status = test.data ?? data;

  return (
    <section className="rounded-lg border border-border bg-card p-3 space-y-2 text-left" aria-label="NVIDIA cuOpt-anslutning">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-sm">NVIDIA cuOpt · värdtjänst</h2>
        <Button data-testid="button-test-cuopt-connection" type="button" variant="outline" size="sm"
          disabled={test.isPending || isLoading} onClick={() => test.mutate()}>
          {test.isPending ? "Kontrollerar…" : "Testa anslutning"}
        </Button>
      </div>
      <p data-testid="status-cuopt-connection" className="text-xs text-muted-foreground" role="status">
        {test.isPending ? "Läser funktionsmetadata från NVIDIA utan att starta optimering…" :
          test.isError ? "Kunde inte köra anslutningstestet via servern. Försök igen senare." :
          status ? status.message : isLoading ? "Läser serverkonfiguration…" :
          isError ? "Kunde inte läsa anslutningsstatus från servern." : "Ingen status tillgänglig."}
      </p>
      {status && <p data-testid="text-cuopt-configuration" className="text-xs text-muted-foreground">
        Servernyckel: {status.keyPresent ? "finns" : "saknas"} · Funktions-ID: {status.functionIdConfigured ? "finns" : "saknas"} · Versions-ID: {status.versionIdConfigured ? "finns" : "ej angivet"}
      </p>}
      <p className="text-xs text-muted-foreground">
        Testet verifierar endast åtkomst till aktiv NVCF-funktionsmetadata, inte att funktionen är cuOpt eller att en lösning fungerar. Ingen kunddata skickas.
      </p>
    </section>
  );
}