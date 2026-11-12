import { useEffect, useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useCustomers, useCustomerMutations } from "@/hooks/use-customers";
import { usePlanningDrafts } from "@/hooks/use-planning-drafts";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { Plus, Search, Archive, Edit2, Users, MapPin, X, ChevronDown, ChevronRight, Route as RouteIcon, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { CustomerImportDialog } from "@/components/customers/CustomerImportDialog";
import { CustomerForm, type CustomerFormValues } from "@/components/customers/CustomerForm";
import { SiteForm, type SiteFormInitialData, type SiteFormValues } from "@/components/customers/SiteForm";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Customer, CustomerSite } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  activeCustomerSites,
  customerAddressCandidates,
  customerSelectionReadiness,
  isCustomerDraftEligible,
  reconcileCustomerSelection,
  toggleCustomerSelection,
  toggleCustomerSiteSelection,
} from "@/lib/customer-planning";
import { localizeError } from "@/lib/localize-error";
import { duplicateVisitSiteIds } from "@/lib/stop-register";
import { Alert, AlertDescription } from "@/components/ui/alert";

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export default function Customers() {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  const canWrite = hasRole("admin", "dispatcher");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: customers = [], isLoading } = useCustomers(includeArchived);
  const { createCustomer, updateCustomer, archiveCustomer, createSite, updateSite, archiveSite, planVisits } = useCustomerMutations();
  const { data: drafts } = usePlanningDrafts();

  const [search, setSearch] = useState("");
  const [expandedCustomerIds, setExpandedCustomerIds] = useState<Set<string>>(new Set());
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [selectedSiteIds, setSelectedSiteIds] = useState<Set<string>>(new Set());

  // Dialogs
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<{
    customerId: string;
    site?: CustomerSite;
    initialData?: SiteFormInitialData;
    returnToPlan?: boolean;
  } | null>(null);
  const [siteError, setSiteError] = useState<{ message: string, candidates?: any[] } | null>(null);

  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [planDate, setPlanDate] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date()));
  const [planName, setPlanName] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [duplicateSiteIds, setDuplicateSiteIds] = useState<string[] | null>(null);
  const [allowDuplicateVisits, setAllowDuplicateVisits] = useState(false);
  // A changed request must never be confirmed by an older duplicate consent.
  useEffect(() => {
    setDuplicateSiteIds(null);
    setAllowDuplicateVisits(false);
  }, [selectedSiteIds, selectedDraftId, planDate]);

  const selectionReadiness = useMemo(
    () => customerSelectionReadiness(customers, {
      customerIds: selectedCustomerIds,
      siteIds: selectedSiteIds,
    }),
    [customers, selectedCustomerIds, selectedSiteIds],
  );
  const selectedCustomers = useMemo(
    () => customers.filter((customer) => selectedCustomerIds.has(customer.id) && !customer.archivedAt),
    [customers, selectedCustomerIds],
  );
  const customersNeedingFirstSite = useMemo(
    () => selectedCustomers.filter((customer) => activeCustomerSites(customer).length === 0),
    [selectedCustomers],
  );
  const customersMissingSelectedSite = useMemo(
    () => selectedCustomers.filter((customer) => (
      activeCustomerSites(customer).length > 0
      && !activeCustomerSites(customer).some((site) => selectedSiteIds.has(site.id))
    )),
    [selectedCustomers, selectedSiteIds],
  );

  // Queries can refresh while a planner is working. Drop archived/deleted
  // customers and sites, but retain selected customers that still need a site.
  useEffect(() => {
    const reconciled = reconcileCustomerSelection(customers, {
      customerIds: selectedCustomerIds,
      siteIds: selectedSiteIds,
    });
    if (!setsEqual(reconciled.customerIds, selectedCustomerIds)) {
      setSelectedCustomerIds(reconciled.customerIds);
    }
    if (!setsEqual(reconciled.siteIds, selectedSiteIds)) {
      setSelectedSiteIds(reconciled.siteIds);
    }
  }, [customers, selectedCustomerIds, selectedSiteIds]);

  const openPlanDialog = () => {
    if (selectedCustomerIds.size === 0 && selectedSiteIds.size === 0) return;
    setPlanDialogOpen(true);
  };

  const removeSiteFromPlan = (siteId: string) => {
    const next = new Set(selectedSiteIds);
    next.delete(siteId);
    setSelectedSiteIds(next);
    if (next.size === 0 && selectedCustomerIds.size === 0) setPlanDialogOpen(false);
    setIdempotencyKey(crypto.randomUUID());
  };

  const filteredCustomers = useMemo(() => {
    const q = search.toLowerCase();
    return customers.filter(c => 
      c.name.toLowerCase().includes(q) || 
      c.email?.toLowerCase().includes(q) || 
      c.phone?.toLowerCase().includes(q) ||
      c.sites.some(s => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q))
    );
  }, [customers, search]);

  const toggleCustomer = (id: string) => {
    const next = new Set(expandedCustomerIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedCustomerIds(next);
  };

  const toggleSiteSelect = (siteId: string, checked: boolean) => {
    const next = toggleCustomerSiteSelection(customers, {
      customerIds: selectedCustomerIds,
      siteIds: selectedSiteIds,
    }, siteId, checked);
    setSelectedCustomerIds(next.customerIds);
    setSelectedSiteIds(next.siteIds);
    setIdempotencyKey(crypto.randomUUID());
  };

  const toggleCustomerSites = (customer: Customer, checked: boolean) => {
    const next = toggleCustomerSelection(customers, {
      customerIds: selectedCustomerIds,
      siteIds: selectedSiteIds,
    }, customer.id, checked);
    setSelectedCustomerIds(next.customerIds);
    setSelectedSiteIds(next.siteIds);
    setIdempotencyKey(crypto.randomUUID());
  };

  const handleCustomerSubmit = async (values: CustomerFormValues) => {
    try {
      if (editingCustomer) {
        await updateCustomer.mutateAsync({ id: editingCustomer.id, data: values });
      } else {
        await createCustomer.mutateAsync({ data: values });
      }
      setCustomerDialogOpen(false);
      setEditingCustomer(null);
      toast({ title: t("customers.saveSuccess", "Sparad framgångsrikt") });
    } catch (e: any) {
      toast({ title: t("customers.errorSaving", "Kunde inte spara"), description: localizeError(e, t), variant: "destructive" });
    }
  };

  const handleSiteSubmit = async (values: SiteFormValues) => {
    if (!editingSite) return;
    setSiteError(null);
    const siteContext = editingSite;
    const previousSiteIds = new Set(
      customers.find((customer) => customer.id === siteContext.customerId)?.sites.map((site) => site.id) ?? [],
    );
    try {
      const payload = {
        name: values.name,
        address: values.address,
        verificationCandidateId: values.verificationCandidateId || undefined,
        contactName: values.contactName || null,
        contactPhone: values.contactPhone || null,
        contactEmail: values.contactEmail || null,
        windowStart: values.windowStart || null,
        windowEnd: values.windowEnd || null,
        serviceDurationMin: values.serviceDurationMin,
        instructions: values.instructions || null,
        isPrioritized: values.isPrioritized === true,
      };

      if (editingSite.site) {
        await updateSite.mutateAsync({ 
          id: editingSite.customerId, 
          siteId: editingSite.site.id, 
          data: { ...payload, expectedRevision: editingSite.site.revision } 
        });
      } else {
        const savedCustomer = await createSite.mutateAsync({ id: editingSite.customerId, data: payload });
        if (siteContext.returnToPlan) {
          const createdSite = savedCustomer.sites.find((site) => (
            !site.archivedAt && !previousSiteIds.has(site.id)
          ));
          if (!createdSite) {
            throw new Error(t("customers.createdSiteUnavailable", "Den nya platsen kunde inte väljas för rutten."));
          }
          setSelectedCustomerIds((current) => new Set(current).add(siteContext.customerId));
          setSelectedSiteIds((current) => new Set(current).add(createdSite.id));
          setIdempotencyKey(crypto.randomUUID());
        }
      }
      setSiteDialogOpen(false);
      setEditingSite(null);
      toast({ title: t("customers.saveSuccess", "Sparad framgångsrikt") });
      if (siteContext.returnToPlan) {
        setPlanDialogOpen(true);
      }
    } catch (e: any) {
      const candidates = customerAddressCandidates(e);
      if (candidates !== null) {
        setSiteError({ 
          message: t("customers.verificationRequired", "Adressen måste väljas från förslagen"), 
          candidates: candidates 
        });
      } else {
        setSiteError({ message: localizeError(e, t) });
      }
    }
  };

  const openSitePreparation = (customer: Customer) => {
    if (!canWrite || customer.archivedAt) return;
    const customerContactName = (customer as Customer & { contactName?: string | null }).contactName;
    setSiteError(null);
    setEditingSite({
      customerId: customer.id,
      returnToPlan: true,
      initialData: {
        name: customer.name,
        address: customer.address || "",
        contactName: customerContactName || "",
        contactPhone: customer.phone || "",
        contactEmail: customer.email || "",
        serviceDurationMin: 15,
      },
    });
    // Keep all selected ids in state while moving through the verified address
    // form, then reopen the preparation step after the create response.
    setPlanDialogOpen(false);
    setSiteDialogOpen(true);
  };

  const handlePlanSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentSelection = customerSelectionReadiness(customers, {
      customerIds: selectedCustomerIds,
      siteIds: selectedSiteIds,
    });
    if (duplicateSiteIds && !allowDuplicateVisits) return;
    if (!currentSelection.isReady) {
      toast({
        title: t("customers.selectionIncomplete", "Komplettera kundvalet innan du skapar rutten."),
        description: t("customers.selectionIncompleteDescription", "Alla valda kunder måste ha minst en vald, aktiv besöksplats."),
        variant: "destructive",
      });
      return;
    }
    
    try {
      let draftId = (selectedDraftId && selectedDraftId !== "none") ? selectedDraftId : undefined;
      let draftRevision = 0;
      if (draftId && drafts) {
        const draft = drafts.find(d => d.id === draftId);
        if (!draft || !isCustomerDraftEligible(draft, planDate)) {
          setSelectedDraftId("none");
          toast({ title: t("customers.errorPlanning"), description: t("customers.selectCurrentDraft", "Välj ett redigerbart utkast för det valda datumet, eller skapa en ny plan."), variant: "destructive" });
          return;
        }
        draftRevision = draft.revision;
      }
      
      const res = await planVisits.mutateAsync({
        data: {
          siteIds: currentSelection.selectedSiteIds,
          date: planDate,
          planName: planName || undefined,
          draftId,
          draftRevision,
          idempotencyKey,
          ...(duplicateSiteIds && allowDuplicateVisits ? { allowDuplicateVisits: true } : {}),
        }
      });
      
      toast({
        title: draftId
          ? t("customers.planUpdated", "Besöken har lagts till i planen")
          : t("customers.planCreated", "Planen har skapats"),
      });
      setPlanDialogOpen(false);
      setSelectedCustomerIds(new Set());
      setSelectedSiteIds(new Set());
      setIdempotencyKey(crypto.randomUUID());
      if (res.draftId) setLocation(`/routes/drafts/${res.draftId}`);
    } catch (e: unknown) {
      const duplicates = duplicateVisitSiteIds(e);
      if (duplicates !== null) {
        setDuplicateSiteIds(duplicates.length > 0 ? duplicates : currentSelection.selectedSiteIds);
        setAllowDuplicateVisits(false);
        return;
      }
      toast({ title: t("customers.errorPlanning"), description: localizeError(e, t), variant: "destructive" });
    }
  };

  if (!hasRole("admin", "dispatcher", "viewer")) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">{t("stops.accessDenied")}</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="p-5 flex-shrink-0 border-b bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Users className="h-6 w-6 text-primary" />
                <h1 className="text-2xl font-bold text-foreground">{t("customers.title", "Kunder")}</h1>
              </div>
              <p className="text-muted-foreground text-sm mt-0.5">{t("customers.registerSubtitle", "Kundregister för återkommande stopp och enstaka bokningar. Välj kunder och platser och boka stopp i en ny eller befintlig plan.")}</p>
            </div>
            
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground mr-2 cursor-pointer">
                <Checkbox 
                  checked={includeArchived} 
                  onCheckedChange={(c) => setIncludeArchived(c === true)} 
                  aria-label={t("customers.showArchived", "Visa arkiverade")}
                />
                {t("customers.showArchived", "Visa arkiverade")}
              </label>
              
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setImportDialogOpen(true)} data-testid="button-import-customers">
                  <FileSpreadsheet className="h-4 w-4 mr-1.5" />
                  {t("customers.importExcel", "Importera Excel")}
                </Button>
              )}
              {canWrite && (
                <Button 
                  size="sm" 
                  onClick={() => { setEditingCustomer(null); setCustomerDialogOpen(true); }}
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  {t("customers.newCustomer", "Ny kund")}
                </Button>
              )}
            </div>
          </div>
          
          <div className="mt-4 max-w-md relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder={t("customers.search", "Sök kund eller plats...")} 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 bg-background">
          {isLoading ? (
            <LoadingState />
          ) : filteredCustomers.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              {t("customers.noCustomers", "Inga kunder hittades.")}
            </div>
          ) : (
            <div className="space-y-4 max-w-5xl mx-auto">
              {filteredCustomers.map(customer => {
                const isExpanded = expandedCustomerIds.has(customer.id);
                const isArchived = !!customer.archivedAt;
                const activeSites = activeCustomerSites(customer);
                const visibleSites = includeArchived ? customer.sites : activeSites;
                const allSelected = activeSites.length > 0 && activeSites.every(s => selectedSiteIds.has(s.id));
                const someSelected = activeSites.some(s => selectedSiteIds.has(s.id));
                const customerCheckboxState = allSelected || (selectedCustomerIds.has(customer.id) && !someSelected)
                  ? true
                  : someSelected ? "indeterminate" : false;

                return (
                  <div key={customer.id} className={cn("border rounded-xl bg-card overflow-hidden transition-all shadow-sm", isArchived && "opacity-70")}>
                    <div className="flex items-center p-4 hover:bg-accent/50 transition-colors">
                      <div className="mr-4">
                        <Checkbox 
                          checked={customerCheckboxState}
                          className={someSelected && !allSelected ? "bg-primary/50" : ""}
                          onCheckedChange={(c) => toggleCustomerSites(customer, c === true)}
                          disabled={!canWrite || isArchived}
                          aria-label={t("customers.selectCustomerLabel", {
                            defaultValue: "Välj kund {{name}} för rutt",
                            name: customer.name,
                          })}
                          data-testid={`customer-selection-${customer.id}`}
                        />
                      </div>
                      
                      <button 
                        className="flex-1 flex items-center justify-between text-left focus:outline-none"
                        onClick={() => toggleCustomer(customer.id)}
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-base">{customer.name}</span>
                            {isArchived && <span className="text-[10px] uppercase bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{t("customers.archived", "Arkiverad")}</span>}
                          </div>
                          <div className="text-sm text-muted-foreground mt-0.5 flex items-center gap-3">
                            {customer.email && <span>{customer.email}</span>}
                            {customer.phone && <span>{customer.phone}</span>}
                            <span>• {activeSites.length} {t("customers.sites", "platser").toLowerCase()}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
                        </div>
                      </button>
                      
                      {canWrite && !isArchived && (
                        <div className="ml-4 flex items-center gap-1">
                          <Button variant="ghost" size="icon" onClick={() => { setEditingCustomer(customer); setCustomerDialogOpen(true); }}>
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => {
                            if (confirm(t("customers.archiveConfirm", "Är du säker?"))) {
                              archiveCustomer.mutate({ id: customer.id });
                            }
                          }}>
                            <Archive className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>

                    {isExpanded && (
                      <div className="border-t bg-muted/20 p-4">
                        <div className="flex justify-between items-center mb-3">
                          <h4 className="text-sm font-medium">{t("customers.sites", "Besöksplatser")}</h4>
                          {canWrite && !isArchived && (
                            <Button size="sm" variant="outline" onClick={() => {
                              setSiteError(null);
                              setEditingSite({ customerId: customer.id });
                              setSiteDialogOpen(true);
                            }}>
                              <MapPin className="h-3.5 w-3.5 mr-1.5" />
                              {t("customers.addSite", "Lägg till plats")}
                            </Button>
                          )}
                        </div>
                        
                        {visibleSites.length === 0 ? (
                          <p className="text-sm text-muted-foreground italic py-2">{t("customers.noSites", "Inga besöksplatser tillagda ännu.")}</p>
                        ) : (
                          <div className="grid gap-3">
                            {visibleSites.map(site => {
                              const siteArchived = !!site.archivedAt;
                              return (
                                <div key={site.id} className={cn("flex items-start gap-3 p-3 bg-background border rounded-lg", siteArchived && "opacity-60")}>
                                  <div className="pt-0.5">
                                    <Checkbox 
                                      checked={selectedSiteIds.has(site.id)}
                                      onCheckedChange={(c) => toggleSiteSelect(site.id, c === true)}
                                      disabled={!canWrite || siteArchived || isArchived}
                                      aria-label={t("customers.selectSiteLabel", {
                                        defaultValue: "Välj plats {{name}} för rutt",
                                        name: site.name,
                                      })}
                                      data-testid={`site-selection-${site.id}`}
                                    />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-start">
                                      <div>
                                        <p className="font-medium text-sm">{site.name}{site.isPrioritized && <span className="ml-2 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300" data-testid={`badge-site-prioritized-${site.id}`}>{t("customers.prioritized")}</span>} {siteArchived && <span className="text-[10px] uppercase bg-secondary px-1.5 py-0.5 rounded text-muted-foreground ml-2">{t("customers.archived", "Arkiverad")}</span>}</p>
                                        <p className="text-xs text-muted-foreground mt-0.5 truncate" title={site.address}>{site.address}</p>
                                      </div>
                                      {canWrite && !siteArchived && !isArchived && (
                                        <div className="flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity">
                                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
                                             setSiteError(null);
                                            setEditingSite({ customerId: customer.id, site });
                                            setSiteDialogOpen(true);
                                          }}>
                                            <Edit2 className="h-3.5 w-3.5" />
                                          </Button>
                                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={() => {
                                            if (confirm(t("customers.archiveSiteConfirm", "Är du säker?"))) {
                                              archiveSite.mutate({ id: customer.id, siteId: site.id, params: { expectedRevision: site.revision } });
                                            }
                                          }}>
                                            <Archive className="h-3.5 w-3.5" />
                                          </Button>
                                        </div>
                                      )}
                                    </div>
                                    
                                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
                                      {site.contactName && <div><span className="font-medium">{t("customers.contact")}:</span> {site.contactName}</div>}
                                      {site.contactPhone && <div><span className="font-medium">{t("customers.phone")}:</span> {site.contactPhone}</div>}
                                      {(site.windowStart || site.windowEnd) && <div><span className="font-medium">Tid:</span> {site.windowStart || "00:00"} - {site.windowEnd || "23:59"}</div>}
                                      <div><span className="font-medium">Duration:</span> {site.serviceDurationMin}m</div>
                                    </div>
                                    {site.instructions && (
                                      <p className="mt-2 text-xs bg-muted/50 p-2 rounded italic text-muted-foreground line-clamp-2" title={site.instructions}>
                                        {site.instructions}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Keep the route action visible even before the first site is selected. */}
        {canWrite && (
          <div className="border-t bg-card p-4 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-in slide-in-from-bottom-2">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-8 w-8 bg-primary/20 text-primary rounded-full flex items-center justify-center font-bold text-sm shrink-0">
                {selectedCustomerIds.size}
              </div>
              <span className="font-medium text-sm">
                {t("customers.selectionSummary", {
                  defaultValue: "{{customers}} kunder · {{sites}} platser valda",
                  customers: selectedCustomerIds.size,
                  sites: selectedSiteIds.size,
                })}
              </span>
              {(selectedCustomerIds.size > 0 || selectedSiteIds.size > 0) && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setSelectedCustomerIds(new Set());
                    setSelectedSiteIds(new Set());
                    setIdempotencyKey(crypto.randomUUID());
                  }}
                  className="text-muted-foreground h-auto p-0 ml-2"
                >
                  {t("customers.clearSelection", "Rensa val")}
                </Button>
              )}
            </div>
            <Button
              onClick={openPlanDialog}
              disabled={selectedCustomerIds.size === 0 && selectedSiteIds.size === 0}
              data-testid="create-route-button"
            >
              <RouteIcon className="h-4 w-4 mr-2" />
              {t("customers.bookStops", "Boka stopp")}
            </Button>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {canWrite && <CustomerImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />}
      <Dialog open={customerDialogOpen} onOpenChange={setCustomerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCustomer ? t("customers.editCustomer") : t("customers.newCustomer")}</DialogTitle>
          </DialogHeader>
          <CustomerForm 
            initialData={editingCustomer || undefined} 
            onSubmit={handleCustomerSubmit} 
            isLoading={createCustomer.isPending || updateCustomer.isPending}
            onCancel={() => setCustomerDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={siteDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            const returnToPlan = editingSite?.returnToPlan;
            setSiteDialogOpen(false);
            setSiteError(null);
            if (returnToPlan) setPlanDialogOpen(true);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingSite?.site ? t("customers.editSite") : t("customers.newSite")}</DialogTitle>
          </DialogHeader>
          {editingSite && (
            <SiteForm 
              initialData={editingSite.site ?? editingSite.initialData}
              onSubmit={handleSiteSubmit} 
              isLoading={createSite.isPending || updateSite.isPending}
              onCancel={() => {
                const returnToPlan = editingSite.returnToPlan;
                setSiteDialogOpen(false);
                setSiteError(null);
                if (returnToPlan) setPlanDialogOpen(true);
              }}
              serverError={siteError}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog 
        open={planDialogOpen} 
        onOpenChange={(open) => {
          if (!open && !planVisits.isPending) setPlanDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-xl" data-testid="create-route-dialog">
          <DialogHeader>
            <DialogTitle>{t("customers.createRoute", "Skapa ny rutt")}</DialogTitle>
          </DialogHeader>

          {(customersNeedingFirstSite.length > 0 || customersMissingSelectedSite.length > 0) && (
            <section
              aria-labelledby="route-preparation-heading"
              data-testid="route-preparation"
              className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 mb-4 space-y-2"
            >
              <h3 id="route-preparation-heading" className="text-sm font-medium">
                {t("customers.routePreparation", "Förbered valda kunder")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("customers.routePreparationDescription", "Varje vald kund måste ha minst en aktiv, verifierad besöksplats vald.")}
              </p>
              {customersNeedingFirstSite.map((customer) => (
                <div key={customer.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded border bg-background px-2 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{customer.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("customers.firstSiteRequired", "Kunden saknar en aktiv besöksplats.")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openSitePreparation(customer)}
                    disabled={planVisits.isPending || createSite.isPending}
                    data-testid={`complete-address-${customer.id}`}
                  >
                    <MapPin className="h-3.5 w-3.5 mr-1.5" />
                    {t("customers.completeAddress", "Komplettera adress")}
                  </Button>
                </div>
              ))}
              {customersMissingSelectedSite.map((customer) => (
                <p key={customer.id} className="text-xs text-muted-foreground">
                  {t("customers.selectActiveSiteForCustomer", {
                    defaultValue: "Välj minst en aktiv besöksplats för {{name}}.",
                    name: customer.name,
                  })}
                </p>
              ))}
            </section>
          )}

          <div className="max-h-40 overflow-y-auto bg-muted/30 rounded-md border p-2 mb-4 space-y-1">
            {customers.flatMap(c => c.archivedAt ? [] : c.sites)
              .filter(s => selectedSiteIds.has(s.id) && !s.archivedAt)
              .map(site => {
                const customer = customers.find(c => c.id === site.customerId && !c.archivedAt);
                return (
                  <div key={site.id} className="flex items-center justify-between text-sm py-1.5 px-2 bg-background rounded border shadow-sm">
                    <div className="truncate pr-2">
                      <span className="font-medium">{customer?.name}</span>
                      <span className="text-muted-foreground mx-1">•</span>
                      <span>{site.name}</span>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-destructive hover:bg-destructive/10 shrink-0" 
                      onClick={() => removeSiteFromPlan(site.id)}
                      disabled={planVisits.isPending || createSite.isPending}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
          </div>

          <form onSubmit={handlePlanSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>{t("customers.date", "Datum")}</Label>
              <Input type="date" required value={planDate} onChange={e => {
                setPlanDate(e.target.value);
                setSelectedDraftId("none");
                setIdempotencyKey(crypto.randomUUID());
              }} disabled={planVisits.isPending} />
            </div>
            
            <div className="space-y-2">
              <Label>{t("customers.draftId", "Lägg till i befintligt utkast")}</Label>
              <Select value={selectedDraftId} onValueChange={(val) => {
                setSelectedDraftId(val);
                setIdempotencyKey(crypto.randomUUID());
              }} disabled={planVisits.isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Skapa ny plan..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">-- Skapa ny plan --</SelectItem>
                  {drafts?.filter(d => isCustomerDraftEligible(d, planDate)).map(d => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name || d.id.slice(0, 8)} ({new Date(d.startAt).toLocaleDateString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(!selectedDraftId || selectedDraftId === "none") && (
              <div className="space-y-2">
                <Label>{t("customers.planName", "Plannamn (Frivilligt)")}</Label>
                <Input value={planName} onChange={e => {
                  setPlanName(e.target.value);
                  setIdempotencyKey(crypto.randomUUID());
                }} placeholder="Ex. Södra rutten" disabled={planVisits.isPending} />
              </div>
            )}

            {duplicateSiteIds && (
              <Alert className="border-amber-500/40 bg-amber-500/10" data-testid="plan-duplicate-warning">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="space-y-2 text-xs">
                  <p className="font-medium text-foreground">{t("stopRegister.duplicateTitle", { count: duplicateSiteIds.length })}</p>
                  <ul className="max-h-20 list-disc overflow-y-auto pl-4">
                    {duplicateSiteIds.map((id) => {
                      const site = customers.flatMap((customer) => customer.sites).find((entry) => entry.id === id);
                      return <li key={id}>{site?.name ?? id}</li>;
                    })}
                  </ul>
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
                    <Checkbox
                      checked={allowDuplicateVisits}
                      onCheckedChange={(checked) => {
                        setAllowDuplicateVisits(checked === true);
                        // Different payload: needs its own idempotency key.
                        setIdempotencyKey(crypto.randomUUID());
                      }}
                      data-testid="checkbox-plan-allow-duplicates"
                    />
                    {t("stopRegister.allowDuplicates")}
                  </label>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setPlanDialogOpen(false)} disabled={planVisits.isPending}>
                {t("customers.cancel", "Avbryt")}
              </Button>
              <Button
                type="submit"
                disabled={planVisits.isPending || !selectionReadiness.isReady || Boolean(duplicateSiteIds && !allowDuplicateVisits)}
                data-testid="create-plan-submit"
              >
                {(selectedDraftId && selectedDraftId !== "none") ? t("customers.addToPlan", "Lägg till i plan") : t("customers.createPlan", "Skapa plan")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
