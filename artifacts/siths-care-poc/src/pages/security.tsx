import {
  getGetSithsSessionQueryKey,
  getListSithsAuditEventsQueryKey,
  useGetSithsSession,
  useListSithsAuditEvents,
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Badge, Skeleton } from '@/components/ui/core';
import { Shield, ShieldAlert, Key, Activity } from 'lucide-react';
import { format } from 'date-fns';

export function Security() {
  const { data: session, isLoading: isSessionLoading } = useGetSithsSession({
    query: { queryKey: getGetSithsSessionQueryKey() },
  });
  const hasVerifiedIdentity = Boolean(session?.identity);
  const { data: events, isLoading, isError } = useListSithsAuditEvents({
    query: {
      enabled: hasVerifiedIdentity,
      queryKey: getListSithsAuditEventsQueryKey(),
    },
  });

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Säkerhet & Dataskydd</h1>
        <p className="text-muted-foreground text-lg">
          Transparens i hur autentiseringsflöden loggas.
        </p>
      </div>

      <Card className="bg-primary/5 border-primary/20 shadow-none">
        <CardContent className="p-6">
          <div className="flex gap-4 items-start">
            <Shield className="w-6 h-6 text-primary shrink-0 mt-1" />
            <div className="space-y-2">
              <h3 className="font-semibold text-primary-foreground text-primary">Viktig information om Proof-of-Concept</h3>
              <p className="text-sm leading-relaxed">
                Detta är en isolerad demonstrationsmiljö. <strong>Inga patientuppgifter, journaler eller känslig hälsodata lagras, bearbetas eller överförs.</strong> 
                Systemet är enbart till för att demonstrera integrationen av SITHS-autentisering och hantering av HSA-ID och medarbetaruppdrag.
              </p>
              <p className="text-sm leading-relaxed">
                Om utvecklingsläget (Dev Harness) är aktiverat används endast förutbestämda, syntetiska identiteter som inte kan kopplas till verkliga personer. All loggning är sanerad och sparar endast händelsetyp och status utan PII (personally identifiable information).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Autentiseringsloggar
          </CardTitle>
          <CardDescription>
            Sanerade säkerhetshändelser för den aktuella sessionen. Dessa loggar motsvarar vad som skickas till en central SIEM-lösning i en produktionsmiljö.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSessionLoading || (hasVerifiedIdentity && isLoading) ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !hasVerifiedIdentity ? (
            <div className="text-center py-12 text-muted-foreground border rounded-md border-dashed" data-testid="status-audit-auth-required">
              <ShieldAlert className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>Verifiera en syntetisk identitet eller logga in med SITHS för att se sessionsloggen.</p>
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-destructive border border-destructive/30 rounded-md" data-testid="status-audit-error">
              <ShieldAlert className="w-8 h-8 mx-auto mb-3" />
              <p>Säkerhetshändelserna kunde inte hämtas.</p>
            </div>
          ) : events && events.length > 0 ? (
            <div className="border rounded-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted text-muted-foreground border-b">
                    <tr>
                      <th className="px-4 py-3 font-medium">Tidpunkt</th>
                      <th className="px-4 py-3 font-medium">Händelse</th>
                      <th className="px-4 py-3 font-medium">Resultat</th>
                      <th className="px-4 py-3 font-medium">Detaljer / Korrelation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {events.map((event, idx) => (
                      <tr key={idx} className="bg-card hover:bg-muted/50 transition-colors" data-testid={`row-audit-${idx}`}>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {format(new Date(event.occurredAt), 'yyyy-MM-dd HH:mm:ss')}
                        </td>
                        <td className="px-4 py-3 font-medium flex items-center gap-2">
                          <Key className="w-4 h-4 text-muted-foreground" />
                          {event.eventType}
                        </td>
                        <td className="px-4 py-3">
                          {event.result === 'success' ? (
                            <Badge variant="success" data-testid={`badge-result-${idx}`}>Success</Badge>
                          ) : (
                            <Badge variant="destructive" data-testid={`badge-result-${idx}`}>Failed</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                          {event.reasonCode && <span className="block mb-1">Reason: {event.reasonCode}</span>}
                          {event.correlationId && <span className="opacity-70">ID: {event.correlationId.substring(0, 8)}...</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground border rounded-md border-dashed">
              <ShieldAlert className="w-8 h-8 mx-auto mb-3 opacity-20" />
              <p>Inga säkerhetshändelser registrerade i denna session ännu.</p>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
