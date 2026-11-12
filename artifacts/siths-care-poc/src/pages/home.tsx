import { 
  useGetSithsReadiness, 
  getGetSithsReadinessQueryKey,
  useGetSithsSession, 
  getGetSithsSessionQueryKey,
  useStartSithsLogin,
  useSelectSithsAssignment,
  useLogoutSiths,
  useRunSithsDevLogin
  ,getListSithsAuditEventsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter, Button, Badge, Skeleton } from '@/components/ui/core';
import { AlertCircle, CheckCircle2, UserCircle, Building2, LogOut, Loader2, Info } from 'lucide-react';

export function Home() {
  const queryClient = useQueryClient();
  const { data: readiness, isLoading: isReadinessLoading, isError: isReadinessError } = useGetSithsReadiness({
    query: { queryKey: getGetSithsReadinessQueryKey() }
  });
  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useGetSithsSession({
    query: { queryKey: getGetSithsSessionQueryKey(), refetchOnWindowFocus: true }
  });
  
  const startLogin = useStartSithsLogin();
  const devLogin = useRunSithsDevLogin();
  const selectAssignment = useSelectSithsAssignment();
  const logout = useLogoutSiths();

  const handleRealLogin = () => {
    startLogin.mutate({ data: { returnPath: import.meta.env.BASE_URL } }, {
      onSuccess: (res) => {
        window.location.assign(res.authorizationUrl);
      }
    });
  };

  const handleDevLogin = (scenario: 'valid' | 'valid_multiple_assignments') => {
    devLogin.mutate({ data: { scenario } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSithsSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSithsAuditEventsQueryKey() });
      }
    });
  };

  const handleSelectAssignment = (assignmentId: string) => {
    selectAssignment.mutate({ data: { assignmentId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSithsSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSithsAuditEventsQueryKey() });
      }
    });
  };

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSithsSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSithsAuditEventsQueryKey() });
      }
    });
  };

  if (isReadinessLoading || isSessionLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isBrokerReady = readiness?.oidcConfigured;
  const isDevHarness = readiness?.devHarnessEnabled && !isBrokerReady;
  const isLoggedIn = !!session?.identity;
  const mutationError = startLogin.error || devLogin.error || selectAssignment.error || logout.error;

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* System Status Banner */}
      {(isReadinessError || isSessionError || mutationError) && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm" data-testid="status-auth-error">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            <p className="font-semibold">Åtgärden kunde inte genomföras</p>
            <p className="mt-1 text-muted-foreground">Ingen session skapades. Kontrollera brokerstatus eller försök igen.</p>
          </div>
        </div>
      )}

      <div className="flex items-start gap-4 p-4 rounded-lg bg-card border shadow-sm">
        <div className="mt-0.5">
          {isBrokerReady ? (
            <CheckCircle2 className="w-5 h-5 text-green-600" />
          ) : isDevHarness ? (
            <Info className="w-5 h-5 text-blue-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-destructive" />
          )}
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">
            {isBrokerReady ? 'OIDC-broker konfigurerad' : isDevHarness ? 'Syntetisk Testmiljö Aktiv' : 'Systemet saknar anslutning'}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {isBrokerReady 
              ? 'En extern OIDC-broker är konfigurerad. Inera-profilen måste fortfarande verifieras före pilot.' 
              : isDevHarness 
              ? 'Broker-anslutning saknas. Systemet använder inbyggda testidentiteter (Dev Harness) för utvärdering utan patientdata.' 
              : 'Applikationen är varken konfigurerad mot SITHS IdP eller testläge.'}
          </p>
        </div>
        {readiness?.minimumLoa && (
          <Badge variant="outline" className="shrink-0" data-testid="badge-loa">Krav: LoA {readiness.minimumLoa}</Badge>
        )}
      </div>

      {!isLoggedIn && (
        <Card>
          <CardHeader>
            <CardTitle>Logga in som Vårdpersonal</CardTitle>
            <CardDescription>
              Identifiera dig för att få åtkomst till systemet och välja medarbetaruppdrag.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {isBrokerReady ? (
              <Button 
                className="w-full sm:w-auto" 
                onClick={handleRealLogin} 
                disabled={startLogin.isPending}
                data-testid="button-real-login"
              >
                {startLogin.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Logga in med SITHS e-id
              </Button>
            ) : isDevHarness ? (
              <div className="space-y-4">
                <div className="p-4 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-200 mb-2">Testscenarion (Inga patientuppgifter)</h4>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button 
                      variant="secondary" 
                      onClick={() => handleDevLogin('valid')}
                      disabled={devLogin.isPending}
                      data-testid="button-dev-login-single"
                    >
                      Enkelt medarbetaruppdrag
                    </Button>
                    <Button 
                      variant="secondary" 
                      onClick={() => handleDevLogin('valid_multiple_assignments')}
                      disabled={devLogin.isPending}
                      data-testid="button-dev-login-multiple"
                    >
                      Flera medarbetaruppdrag
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-destructive">Inloggning är inte tillgänglig för tillfället.</p>
            )}
          </CardContent>
        </Card>
      )}

      {isLoggedIn && session.identity && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Identity Card */}
          <Card className="md:col-span-1 border-primary/20">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-primary">
                <UserCircle className="w-5 h-5" />
                Identifierad
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">HSA-ID</div>
                <div className="font-mono text-sm mt-1" data-testid="text-hsaid">{session.identity.hsaId}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Tillitsnivå (LoA)</div>
                <Badge variant="success" className="mt-1" data-testid="badge-session-loa">LoA {session.identity.loa}</Badge>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Utgivare</div>
                <div className="text-sm mt-1 truncate" title={session.identity.issuer}>{session.identity.issuer}</div>
              </div>
            </CardContent>
            <CardFooter>
              <Button 
                variant="outline" 
                className="w-full" 
                onClick={handleLogout}
                disabled={logout.isPending}
                data-testid="button-logout"
              >
                {logout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogOut className="w-4 h-4 mr-2" />}
                Logga ut
              </Button>
            </CardFooter>
          </Card>

          {/* Assignments Area */}
          <div className="md:col-span-2 space-y-6">
            {session.activeAssignment ? (
              <Card className="border-green-200 dark:border-green-900 bg-green-50/30 dark:bg-green-900/10">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                    Aktivt Medarbetaruppdrag
                  </CardTitle>
                  <CardDescription>
                    Din behörighet är nu knuten till denna kontext.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Vårdgivare</div>
                      <div className="font-medium mt-1" data-testid="text-care-provider">{session.activeAssignment.careProviderName}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Enhet</div>
                      <div className="font-medium mt-1" data-testid="text-org-unit">{session.activeAssignment.organizationalUnitName}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Ändamål (Purpose)</div>
                    <div className="text-sm mt-1" data-testid="text-purpose">{session.activeAssignment.purpose || 'Ej angivet'}</div>
                  </div>
                </CardContent>
              </Card>
            ) : session.availableAssignments && session.availableAssignments.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Välj Medarbetaruppdrag</CardTitle>
                  <CardDescription>
                    För att arbeta i systemet måste du välja i vilken roll och för vilken enhet du agerar.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {session.availableAssignments.map((assignment) => (
                      <div 
                        key={assignment.id} 
                        className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-lg border hover:border-primary/50 transition-colors gap-4"
                        data-testid={`card-assignment-${assignment.id}`}
                      >
                        <div className="flex items-start gap-3">
                          <Building2 className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                          <div>
                            <div className="font-medium">{assignment.careProviderName}</div>
                            <div className="text-sm text-muted-foreground">{assignment.organizationalUnitName}</div>
                            {assignment.purpose && (
                              <Badge variant="secondary" className="mt-2 font-normal">{assignment.purpose}</Badge>
                            )}
                          </div>
                        </div>
                        <Button 
                          onClick={() => handleSelectAssignment(assignment.id)}
                          disabled={selectAssignment.isPending}
                          data-testid={`button-select-${assignment.id}`}
                        >
                          Välj uppdrag
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center text-muted-foreground">
                    <AlertCircle className="w-8 h-8 mx-auto mb-3 text-yellow-500" />
                    <p>Inga medarbetaruppdrag hittades för din identitet.</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
