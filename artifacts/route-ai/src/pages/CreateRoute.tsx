import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  usePlanningDrafts,
  useCreatePlanningDraft,
} from "@/hooks/use-planning-drafts";
import { useAuth } from "@/lib/auth-context";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { localizeError } from "@/lib/localize-error";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";
import { sv, enGB } from "date-fns/locale";
import {
  CalendarDays,
  Plus,
  ArrowRight,
  Upload,
  MapPin,
  Loader2,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  canNavigateWorkspace,
  registerWorkspaceNavigationGuard,
  RouteBuilderTabs,
} from "@/components/layout/WorkspaceTabs";
import { useStops } from "@/hooks/use-stops";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";
import { MapAreaSelection } from "@/components/map/RouteMap";
import { isValidCoordinate } from "@/lib/map-utils";

function createStopIcon(selected: boolean, label: string) {
  return L.divIcon({
    className: "",
    html: renderToString(
      <div
        className={cn(
          "flex items-center justify-center h-7 w-7 rounded-full border-2 shadow-lg",
          selected
            ? "bg-amber-500 border-amber-300 text-white"
            : "bg-primary border-primary/60 text-white",
        )}
      >
        <span className="text-xs font-bold font-mono">{label}</span>
      </div>,
    ),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function FitBounds({
  stops,
}: {
  stops: Array<{ latitude: number; longitude: number }>;
}) {
  const map = useMap();
  useEffect(() => {
    if (stops.length === 0) return;
    const bounds = L.latLngBounds(stops.map((s) => [s.latitude, s.longitude]));
    map.fitBounds(bounds, { animate: false, padding: [40, 40], maxZoom: 13 });
  }, [stops, map]);
  return null;
}

export default function CreateRoute() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [location, navigate] = useLocation();
  const {
    data: drafts,
    isLoading,
    isError: isDraftsError,
    error: draftsError,
  } = usePlanningDrafts();
  const createDraft = useCreatePlanningDraft();
  const { data: allStops } = useStops();
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(
    new Set(),
  );
  const [markingArea, setMarkingArea] = useState(false);
  const [areaResult, setAreaResult] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [customerReference, setCustomerReference] = useState("");
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const initialDateRef = useRef(date);
  const [source, setSource] = useState<"import" | "manual">("import");
  const [choosingSource, setChoosingSource] = useState(false);
  const creatingRef = useRef(false);
  const hasUnsavedCreationRef = useRef(false);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");

  const hasUnsavedCreation =
    name.trim().length > 0 ||
    customerReference.trim().length > 0 ||
    date !== initialDateRef.current ||
    source !== "import" ||
    choosingSource ||
    selectedStopIds.size > 0;
  hasUnsavedCreationRef.current = hasUnsavedCreation;

  useEffect(() => {
    const allowNavigation = () => {
      if (!hasUnsavedCreationRef.current || creatingRef.current) return true;
      if (typeof window === "undefined" || typeof window.confirm !== "function") {
        return true;
      }
      const language = (i18n.resolvedLanguage ?? i18n.language).startsWith("sv")
        ? "sv"
        : "en";
      return window.confirm(
        t("createRoute.unsavedChangesConfirm", {
          defaultValue:
            language === "sv"
              ? "Du har osparade val i planeringen. Vill du lämna sidan och förlora dem?"
              : "You have unsaved planning selections. Leave this page and discard them?",
        }),
      );
    };

    const unregisterNavigationGuard = registerWorkspaceNavigationGuard(allowNavigation);
    if (typeof window === "undefined") return unregisterNavigationGuard;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedCreationRef.current || creatingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      unregisterNavigationGuard();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [i18n, t]);

  const filteredDrafts = drafts?.filter(d => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const nameMatch = d.name?.toLowerCase().includes(q);
    const refMatch = d.state?.planningMetadata?.customerReference?.toLowerCase().includes(q);
    return nameMatch || refMatch;
  });

  const isValidLocalDate = (value: string) => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const parsed = new Date(`${value}T12:00:00`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.getFullYear() === Number(match[1]) &&
      parsed.getMonth() + 1 === Number(match[2]) &&
      parsed.getDate() === Number(match[3])
    );
  };
  const isValidStart = isValidLocalDate(date);
  // Planning APIs read the UTC calendar components, not a departure time.
  // Optimization derives each route's hours from its vehicle–driver pair.
  const startAt = isValidStart
    ? new Date(`${date}T00:00:00Z`).toISOString()
    : null;
  const selectedCalendarDate = isValidLocalDate(date)
    ? new Date(`${date}T12:00:00`)
    : undefined;

  const mapStops = useMemo(() => (allStops || []).filter(
    (s) =>
      s.status !== "completed" &&
      s.status !== "skipped" &&
      !s.routeId &&
      isValidCoordinate(s.latitude, s.longitude),
  ), [allStops]);
  const toggleStop = (id: string) => {
    setSelectedStopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async (selectedSource: "import" | "manual" = source) => {
    if (creatingRef.current || !name.trim()) return;
    if (!startAt) {
      setErrorMsg(t("createRoute.invalidDateTime"));
      return;
    }
    creatingRef.current = true;
    setIsCreating(true);
    setErrorMsg(null);
    try {
      const draft = await createDraft.mutateAsync({
        name: name.trim(),
        startAt,
        state: {
          step: selectedSource === "import" ? 1 : 5,
          source: selectedSource,
          selectedStopIds: Array.from(selectedStopIds),
          planningMetadata: {
            customerReference: customerReference.trim() || null,
          }
        },
      });
      const target = `/routes/drafts/${draft.id}`;
      if (canNavigateWorkspace(location, target)) {
        navigate(target);
      }
    } catch (e) {
      console.error(e);
      setErrorMsg(
        localizeError(e, t, { fallbackKey: "common.errorRequestFailed" }),
      );
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
        <RouteBuilderTabs />
        <div className="flex flex-1 min-h-0 overflow-hidden flex-col-reverse xl:flex-row">
          <div className={cn(
            "w-full overflow-y-auto bg-background p-4 md:p-6",
            choosingSource && source === "manual"
              ? "h-1/2 xl:h-full xl:w-[500px] shrink-0 border-t xl:border-t-0 xl:border-r border-border"
              : "h-full max-w-3xl mx-auto",
          )}>
            <div className="mb-6">
              <h1 className="text-2xl font-display font-bold">
                {t("createRoute.planningTitle")}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("createRoute.planningSubtitle")}
              </p>
            </div>

            <div className="bg-card border border-border rounded-xl p-5 shadow-sm mb-6">
              <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
                <Plus className="h-4 w-4 text-primary" />
                {t(choosingSource ? "createRoute.addStops" : "createRoute.newDraft")}
              </h2>

              <div className="space-y-4">
                {errorMsg && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{errorMsg}</AlertDescription>
                  </Alert>
                )}
                {!choosingSource ? <>
                <div>
                  <label className="text-xs font-medium mb-1.5 block text-foreground">
                    {t("createRoute.draftName")}
                  </label>
                  <input
                    type="text"
                    data-testid="input-draft-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("createRoute.draftNamePlaceholder")}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium mb-1.5 block text-foreground">
                    {t("createRoute.customerReference")} <span className="text-muted-foreground font-normal">({t("common.optional")})</span>
                  </label>
                  <input
                    type="text"
                    data-testid="input-draft-customer-reference"
                    value={customerReference}
                    onChange={(e) => setCustomerReference(e.target.value)}
                    placeholder={t("createRoute.customerReferencePlaceholder")}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
                  />
                </div>

                <div className="grid gap-3">
                  <div>
                    <label className="text-xs font-medium mb-1.5 block text-foreground">
                      {t("createRoute.date")}
                    </label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <div
                          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 transition-shadow focus-within:ring-2 focus-within:ring-primary/40"
                          aria-label={t("createRoute.date")}
                        >
                          <input
                            type="text"
                            data-testid="input-draft-date"
                            value={date}
                            inputMode="numeric"
                            placeholder={t("createRoute.datePlaceholder")}
                            onChange={(e) => setDate(e.target.value)}
                            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                            aria-label={t("createRoute.date")}
                          />
                          <CalendarDays
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </div>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-auto p-0">
                        <Calendar
                          mode="single"
                          required
                          locale={i18n.language.startsWith("sv") ? sv : enGB}
                          selected={selectedCalendarDate}
                          defaultMonth={selectedCalendarDate}
                          onSelect={(selected) => {
                            if (selected)
                              setDate(format(selected, "yyyy-MM-dd"));
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                <Button
                  data-testid="button-draft-continue"
                  disabled={!name.trim() || !isValidStart}
                  onClick={() => setChoosingSource(true)}
                  className="w-full h-10"
                >
                  {t("createRoute.continue")}
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
                </> : <>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground break-words">{name} · {date}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isCreating}
                    data-testid="button-draft-back"
                    onClick={() => setChoosingSource(false)}
                  >{t("common.back")}</Button>
                </div>
                <div className="pt-2">
                  <label className="text-xs font-medium mb-2 block text-foreground">
                    {t("createRoute.addStops")}
                  </label>
                  <div className="grid gap-2">
                    <button
                      type="button"
                      data-testid="button-draft-start-import"
                      onClick={() => void handleCreate("import")}
                      disabled={!name.trim() || !isValidStart || isCreating}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed",
                        source === "import"
                          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                          : "border-border hover:bg-muted/50 hover:border-border/80",
                      )}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                          source === "import"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        <Upload className="h-4 w-4" />
                      </div>
                      <div>
                        <div
                          className={cn(
                            "font-medium text-sm",
                            source === "import" && "text-primary",
                          )}
                        >
                          {t("createRoute.goToMapping")}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t("createRoute.uploadFileDescription")}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      data-testid="button-draft-start-manual"
                      onClick={() => setSource("manual")}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all duration-200",
                        source === "manual"
                          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                          : "border-border hover:bg-muted/50 hover:border-border/80",
                      )}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                          source === "manual"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        <MapPin className="h-4 w-4" />
                      </div>
                      <div>
                        <div
                          className={cn(
                            "font-medium text-sm",
                            source === "manual" && "text-primary",
                          )}
                        >
                          {t("createRoute.selectExistingStops")}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t("createRoute.selectExistingStopsDescription")}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {source === "manual" && <Button
                  onClick={() => void handleCreate("manual")}
                  disabled={
                    !name.trim() ||
                    !isValidStart ||
                    isCreating ||
                    (source === "manual" && selectedStopIds.size === 0)
                  }
                  className="w-full h-10 mt-2"
                >
                  {isCreating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      {t("createRoute.createDraft")}
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </>
                  )}
                </Button>}
                </>}
              </div>
            </div>

            {!choosingSource && <div>
              <div className="flex items-center justify-between gap-4 mb-4">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  {t("createRoute.draftsTitle")}
                </h2>
                {(drafts?.length ?? 0) > 0 && (
                  <input
                    type="search"
                    data-testid="input-draft-search"
                    placeholder={t("common.search")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-8 w-40 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
                  />
                )}
              </div>

              {isDraftsError ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {localizeError(draftsError, t, {
                      fallbackKey: "common.errorRequestFailed",
                    })}
                  </AlertDescription>
                </Alert>
              ) : isLoading ? (
                <div className="h-32 flex items-center justify-center text-muted-foreground bg-muted/20 rounded-xl border border-border border-dashed">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : drafts?.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center bg-muted/20 rounded-xl border border-border border-dashed text-xs text-muted-foreground">
                  <p>{t("createRoute.noDrafts")}</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredDrafts?.map((draft) => (
                    <div
                      key={draft.id}
                      className="group border border-border rounded-lg p-3 bg-card hover:border-primary/40 hover:shadow-sm transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div>
                        <h3 className="font-semibold text-sm flex items-center gap-1.5">
                          {draft.name}
                          <span className="text-[9px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded uppercase">
                            {draft.state?.source === "manual"
                              ? t("createRoute.manual")
                              : t("createRoute.import")}
                          </span>
                        </h3>
                        {draft.state?.planningMetadata?.customerReference && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                            {t("createRoute.customerReference")}: {draft.state.planningMetadata.customerReference}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {format(
                              new Date(draft.startAt),
                              "yyyy-MM-dd",
                            )}
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0 h-8 text-xs w-full sm:w-auto"
                        data-testid={`button-draft-resume-${draft.id}`}
                        onClick={() => {
                          const target = `/routes/drafts/${draft.id}`;
                          if (canNavigateWorkspace(location, target)) {
                            navigate(target);
                          }
                        }}
                      >
                        {t("createRoute.resume")}
                        <Play className="h-3 w-3 ml-1.5 text-primary" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>}
          </div>

          {choosingSource && source === "manual" && <div className="flex-1 relative bg-muted/20" data-testid="draft-existing-stops-map">
            <MapContainer
              center={[59.33, 18.07]}
              zoom={11}
              className="h-full w-full z-0"
              zoomControl={false}
            >
              <TileLayer
                attribution="&copy; OpenStreetMap"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {mapStops.length > 0 && <FitBounds stops={mapStops} />}
              <MapAreaSelection active={markingArea} stops={mapStops}
                onCancel={() => setMarkingArea(false)}
                onFinish={(ids) => {
                  setSelectedStopIds(previous => new Set([...previous, ...ids]));
                  setMarkingArea(false);
                  setAreaResult(i18n.language.startsWith("sv")
                    ? `${ids.length} stopp inom området. Tidigare val behålls.`
                    : `${ids.length} stops inside the area. Previous selections are kept.`);
                }} />
              {mapStops.map((stop, index) => (
                <Marker
                  key={`${stop.id}:${markingArea}`}
                  interactive={!markingArea}
                  position={[stop.latitude, stop.longitude]}
                  icon={createStopIcon(
                    selectedStopIds.has(stop.id),
                    (index + 1).toString(),
                  )}
                  eventHandlers={{ click: () => { if (!markingArea) toggleStop(stop.id); } }}
                >
                  <Popup className="dark-popup text-xs">
                    <p className="font-bold">{stop.address}</p>
                    {stop.notes && (
                      <p className="text-muted-foreground mt-1">{stop.notes}</p>
                    )}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>

            <div className="absolute top-4 left-4 right-4 z-[400] pointer-events-none">
              {source === "manual" && !markingArea && (
                <div className="bg-card/90 backdrop-blur border border-border shadow-lg rounded-lg p-3 inline-block pointer-events-auto">
                  <p className="text-sm font-medium">
                    {t("createRoute.selectedStops", {
                      count: selectedStopIds.size,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("createRoute.mapSelectionHint")}
                  </p>
                  <Button type="button" size="sm" variant="secondary" className="mt-2 h-8 text-xs"
                    data-testid="button-project-polygon" disabled={mapStops.length === 0}
                    onClick={() => { setAreaResult(null); setMarkingArea(true); }}>
                    {i18n.language.startsWith("sv") ? "Markera med polygon" : "Select with polygon"}
                  </Button>
                  {areaResult && <p role="status" className="mt-2 text-xs text-muted-foreground">{areaResult}</p>}
                </div>
              )}
            </div>
          </div>}
        </div>
      </div>
    </AppLayout>
  );
}
