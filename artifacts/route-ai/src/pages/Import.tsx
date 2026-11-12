import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { ImportViewport } from "@/components/import/ImportViewport";
import { useTranslation } from "react-i18next";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import type {
  ImportRoutePlanDiagnostic,
  ImportStopsResponse,
  ImportStopsValidationError,
  PlanningInputs,
  PlanningInputsReoptimizationResult,
  PlanningSummaryResponse,
  Route,
} from "@workspace/api-client-react";
import {
  getGetImportRoutePlanApprovalQueryKey,
  getGetImportRoutePlanPlanningSummaryQueryKey,
  useGetImportRoutePlanApproval,
  useGetImportRoutePlanPlanningSummary,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  Check,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  FileDown,
  Cpu,
  Smartphone,
  Users,
  CheckCircle2,
  XCircle,
  Loader2,
  Truck,
  Zap,
  Send,
  MapPin,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isValidCoordinate } from "@/lib/map-utils";
import { useAuth } from "@/lib/auth-context";
import { Step3Review } from "@/components/import/Step3Review";
import { Step4Addresses } from "@/components/import/Step4Addresses";
import { Step6Vehicles, type PlanningMetadata } from "@/components/import/Step6Vehicles";
import { Step7Adjust } from "@/components/import/Step7Adjust";
import { Step7Dispatch } from "@/components/import/Step7Dispatch";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { useStops } from "@/hooks/use-stops";
import { PlanStatusChain } from "@/components/planning/PlanStatusChain";
import { ImportInfoMenu, ImportInfoProvider, useImportInfo } from "@/components/import/ImportInfoDisclosure";
import { isAlwaysVisibleCount } from "@/lib/import-info-disclosure";
import {
  usePlanningDraft,
  usePlanningDraftAutosave,
  type PlanningDraft,
} from "@/hooks/use-planning-drafts";
import type {
  ImportAssignedRoute,
  ImportDriver,
  ImportStop,
  ImportVehicle,
  MappedRow,
  RejectedImportRow,
} from "@/components/import/types";
import {
  normalizeImportDate,
  normalizeImportTime,
  parseImportFile,
  parseLocalizedNumber,
  type ParsedImportRow,
} from "@/lib/import-file";
import { routePlanSelectionStorageKey } from "@/lib/route-plan-export-selection";
import { getErrorStatus, localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import {
  buildHydratedImportRoutes,
  isImportApprovalResumeState,
} from "@/lib/import-resume";
import { reconcileImportReviewCounts } from "@/components/import/import-review";
import { resolvePlanResumeStep, resolvePlanReviewDepot } from "@/lib/plan-review";
import {
  readImportEvidence,
  resolveImportCounts,
  resolveImportOrderCount,
} from "@/lib/import-counts";
import { resolveImportResumeStep } from "@/lib/import-navigation";
import { getInitialPlanReadiness } from "@/lib/import-planning-readiness";
import { projectImportDraftState, supplementalDraftStopIds } from "@/lib/import-draft-state";
import {
  composeDeliveryAddress,
  deliveryAddressPreview,
  getDeliveryAddressMapping,
  resolveDeliveryAddressValues,
  type DeliveryAddressComponent,
  type DeliveryAddressMappingPart,
} from "@/lib/delivery-address";
import {
  loadImportMappingProfile,
  mergeSavedImportMapping,
  normalizePreImportDraftMapping,
  saveImportMappingProfile,
  type PersistedColumnMapping,
} from "@/lib/import-mapping";
import { useLocation, useSearch } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { StopRegisterDialog, type StopRegisterResult } from "@/components/customers/StopRegisterDialog";
import { clearSelectedImportMappings, restoreSelectedImportMappings } from "@/lib/import-mapping-selection";

type SystemField = {
  key: string;
  labelKey: string;
  required: boolean;
  description: string;
  apiField: string;
  exampleValue: string;
  forMode?: "transport" | "field_service";
};

const SYSTEM_FIELDS: SystemField[] = [
  { key: "referenceNumber", labelKey: "importPage.field.referenceNumber", required: false, description: "importPage.fieldDesc.referenceNumber", apiField: "reference_number", exampleValue: "ORD-2026-001" },
  { key: "date", labelKey: "importPage.field.date", required: true, description: "importPage.fieldDesc.date", apiField: "date", exampleValue: "2026-04-10" },
  { key: "contactName", labelKey: "importPage.field.contactName", required: false, description: "importPage.fieldDesc.contactName", apiField: "contact_name", exampleValue: "Anna Svensson" },
  { key: "contactPhone", labelKey: "importPage.field.contactPhone", required: false, description: "importPage.fieldDesc.contactPhone", apiField: "contact_phone", exampleValue: "+46701234567" },
  { key: "contactEmail", labelKey: "importPage.field.contactEmail", required: false, description: "importPage.fieldDesc.contactEmail", apiField: "contact_email", exampleValue: "anna@example.com" },
  { key: "address", labelKey: "importPage.field.address", required: true, description: "importPage.fieldDesc.address", apiField: "address", exampleValue: "Storgatan 12" },
  { key: "postalCode", labelKey: "importPage.field.postalCode", required: false, description: "importPage.fieldDesc.postalCode", apiField: "postal_code", exampleValue: "114 35" },
  { key: "city", labelKey: "importPage.field.city", required: false, description: "importPage.fieldDesc.city", apiField: "city", exampleValue: "Stockholm" },
  { key: "pickupAddress", labelKey: "import.field.pickupAddress", required: false, description: "importPage.fieldDesc.pickupAddress", apiField: "pickup_address", exampleValue: "Terminalvägen 1", forMode: "transport" },
  { key: "latitude", labelKey: "importPage.field.latitude", required: false, description: "importPage.fieldDesc.latitude", apiField: "latitude", exampleValue: "59.3293" },
  { key: "longitude", labelKey: "importPage.field.longitude", required: false, description: "importPage.fieldDesc.longitude", apiField: "longitude", exampleValue: "18.0686" },
  { key: "pickupLatitude", labelKey: "import.field.pickupLatitude", required: false, description: "importPage.fieldDesc.pickupLatitude", apiField: "pickup_latitude", exampleValue: "59.3323", forMode: "transport" },
  { key: "pickupLongitude", labelKey: "import.field.pickupLongitude", required: false, description: "importPage.fieldDesc.pickupLongitude", apiField: "pickup_longitude", exampleValue: "18.0626", forMode: "transport" },
  { key: "timeWindowStart", labelKey: "importPage.field.timeWindowStart", required: false, description: "importPage.fieldDesc.timeWindowStart", apiField: "time_window_start", exampleValue: "08:00" },
  { key: "timeWindowEnd", labelKey: "importPage.field.timeWindowEnd", required: false, description: "importPage.fieldDesc.timeWindowEnd", apiField: "time_window_end", exampleValue: "12:00" },
  { key: "serviceDurationMin", labelKey: "importPage.field.serviceDurationMin", required: false, description: "importPage.fieldDesc.serviceDurationMin", apiField: "service_duration_min", exampleValue: "5" },
  { key: "weightKg", labelKey: "importPage.field.weightKg", required: false, description: "importPage.fieldDesc.weightKg", apiField: "weight_kg", exampleValue: "25.5", forMode: "transport" },
  { key: "volumeM3", labelKey: "importPage.field.volumeM3", required: false, description: "importPage.fieldDesc.volumeM3", apiField: "volume_m3", exampleValue: "0.5", forMode: "transport" },
  { key: "notes", labelKey: "importPage.field.notes", required: false, description: "importPage.fieldDesc.notes", apiField: "notes", exampleValue: "Portkod 1234" },
  { key: "jobType", labelKey: "importPage.field.jobType", required: false, description: "importPage.fieldDesc.jobType", apiField: "job_type", exampleValue: "delivery" },
  { key: "serviceCategory", labelKey: "importPage.field.serviceCategory", required: false, description: "importPage.fieldDesc.serviceCategory", apiField: "service_category", exampleValue: "HVAC", forMode: "field_service" },
  { key: "priority", labelKey: "importPage.field.priority", required: false, description: "importPage.fieldDesc.priority", apiField: "priority", exampleValue: "1", forMode: "field_service" },
  { key: "slaDeadline", labelKey: "importPage.field.slaDeadline", required: false, description: "importPage.fieldDesc.slaDeadline", apiField: "sla_deadline", exampleValue: "2026-04-10T12:00", forMode: "field_service" },
  { key: "serviceInstructions", labelKey: "importPage.field.serviceInstructions", required: false, description: "importPage.fieldDesc.serviceInstructions", apiField: "service_instructions", exampleValue: "Call before arriving", forMode: "field_service" },
  { key: "requiredSkills", labelKey: "importPage.field.requiredSkills", required: false, description: "importPage.fieldDesc.requiredSkills", apiField: "required_skills", exampleValue: "Electrical", forMode: "field_service" },
  { key: "requiredCertifications", labelKey: "importPage.field.requiredCertifications", required: false, description: "importPage.fieldDesc.requiredCertifications", apiField: "required_certifications", exampleValue: "CERT-123", forMode: "field_service" },
  { key: "requiredEquipment", labelKey: "importPage.field.requiredEquipment", required: false, description: "importPage.fieldDesc.requiredEquipment", apiField: "required_equipment", exampleValue: "Ladder", forMode: "field_service" },
];

const ALIAS_MAP: Record<string, string> = {
  referensnummer: "referenceNumber", reference: "referenceNumber", reference_number: "referenceNumber",
  ref: "referenceNumber", ordernummer: "referenceNumber", order_number: "referenceNumber", ordernr: "referenceNumber",
  "order_id": "referenceNumber", orderid: "referenceNumber", "uppgifts_id": "referenceNumber",
  "summa_av_uppgifts_id": "referenceNumber", id: "referenceNumber", nummer: "referenceNumber",
  datum: "date", date: "date", leveransdatum: "date", delivery_date: "date",
  "leverans_datum": "date", dag: "date", "delivery_day": "date",
  namn: "contactName", name: "contactName", contact_name: "contactName", kontaktnamn: "contactName",
  mottagare: "contactName", recipient: "contactName", customer_name: "contactName", kundnamn: "contactName",
  kund: "contactName", customer: "contactName", "contact": "contactName", förnamn: "contactName",
  telefonnummer: "contactPhone", telefon: "contactPhone", phone: "contactPhone", tel: "contactPhone",
  contact_phone: "contactPhone", mobilnummer: "contactPhone", mobil: "contactPhone", mobile: "contactPhone",
  tele: "contactPhone", "tel_nr": "contactPhone", "phone_number": "contactPhone",
  epost: "contactEmail", "e-post": "contactEmail", email: "contactEmail", mail: "contactEmail", contact_email: "contactEmail",
  "e_post": "contactEmail", "customer_email": "contactEmail",
  address: "address", adress: "address", gatuadress: "address", street: "address",
  street_address: "address", leveransadress: "address", delivery_address: "address",
  gata: "address", "gata_och_nummer": "address", "full_address": "address", "fullständig_adress": "address",
  pickup_address: "pickupAddress", upphämtningsadress: "pickupAddress", "upphämtning": "pickupAddress", hämtadress: "pickupAddress",
  postnummer: "postalCode", postnr: "postalCode", postal_code: "postalCode", zip: "postalCode",
  zipcode: "postalCode", zip_code: "postalCode", "post_code": "postalCode", plz: "postalCode",
  ort: "city", stad: "city", city: "city", postort: "city", town: "city",
  kommun: "city", "delivery_city": "city", leveransort: "city",
  latitude: "latitude", lat: "latitude", latitud: "latitude", delivery_latitude: "latitude",
  longitude: "longitude", lng: "longitude", lon: "longitude", long: "longitude", longitud: "longitude", delivery_longitude: "longitude",
  leverans_från_kl: "timeWindowStart", "leverans från kl": "timeWindowStart", time_window_start: "timeWindowStart",
  start_time: "timeWindowStart", starttid: "timeWindowStart", från: "timeWindowStart",
  tid: "timeWindowStart", time: "timeWindowStart", "leveranstid": "timeWindowStart", "klockan": "timeWindowStart",
  leverans_till_kl: "timeWindowEnd", "leverans till kl": "timeWindowEnd", time_window_end: "timeWindowEnd",
  end_time: "timeWindowEnd", sluttid: "timeWindowEnd", till: "timeWindowEnd",
  servicetid: "serviceDurationMin", service_duration_min: "serviceDurationMin", duration: "serviceDurationMin", minuter: "serviceDurationMin",
  "service_time": "serviceDurationMin", "tid_min": "serviceDurationMin",
  vikt: "weightKg", weight: "weightKg", weight_kg: "weightKg", kg: "weightKg",
  antal: "weightKg", quantity: "weightKg", "summa_av_pris": "weightKg", amount: "weightKg",
  volym: "volumeM3", volume: "volumeM3", volume_m3: "volumeM3", m3: "volumeM3",
  notering: "notes", notes: "notes", anteckning: "notes", kommentar: "notes", comment: "notes", beskrivning: "notes", description: "notes",
  info: "notes", "extra_info": "notes", meddelande: "notes", message: "notes",
  "job_type": "jobType", "jobbtyp": "jobType", type: "jobType", typ: "jobType",
  "service_category": "serviceCategory", category: "serviceCategory", kategori: "serviceCategory",
  priority: "priority", prioritet: "priority", prio: "priority",
  "sla_deadline": "slaDeadline", sla: "slaDeadline", deadline: "slaDeadline",
  "service_instructions": "serviceInstructions", instruktioner: "serviceInstructions", instructions: "serviceInstructions",
  "required_skills": "requiredSkills", skills: "requiredSkills", kompetens: "requiredSkills",
  "required_certifications": "requiredCertifications", certifications: "requiredCertifications", certifikat: "requiredCertifications", cert: "requiredCertifications",
  "required_equipment": "requiredEquipment", equipment: "requiredEquipment", utrustning: "requiredEquipment", maskin: "requiredEquipment",
};

const FIELD_KEYWORDS: Record<string, string[]> = {
  referenceNumber: ["ref", "id", "nummer", "order", "uppgift", "reference", "number"],
  date: ["datum", "date", "dag", "day", "leverans"],
  contactName: ["namn", "name", "kund", "mottagare", "kontakt", "recipient", "customer"],
  contactPhone: ["telefon", "phone", "tel", "mobil", "mobile", "nummer"],
  contactEmail: ["mail", "epost", "e-post", "email"],
  address: ["adress", "address", "gata", "street", "leverans", "väg"],
  pickupAddress: ["upphämtning", "pickup", "hämt", "terminal"],
  postalCode: ["postnr", "postnummer", "postal", "zip", "plz", "post"],
  city: ["ort", "stad", "city", "town", "kommun", "postort"],
  latitude: ["lat", "latitud", "latitude"],
  longitude: ["lon", "lng", "long", "longitud", "longitude"],
  timeWindowStart: ["tid", "time", "start", "från", "kl", "leveranstid"],
  timeWindowEnd: ["slut", "till", "end", "stop"],
  serviceDurationMin: ["service", "tid", "min", "duration", "minut"],
  weightKg: ["vikt", "weight", "kg", "antal", "quantity", "amount", "pris", "summa"],
  volumeM3: ["volym", "volume", "m3", "kubik"],
  notes: ["not", "anteck", "kommentar", "comment", "beskrivning", "info", "meddelande", "message"],
};

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface ParsedData {
  headers: string[];
  rows: ParsedImportRow[];
  sourceRowCount: number;
}

interface ColumnMapping {
  [systemField: string]: string | DeliveryAddressMappingPart[] | null | undefined;
}

class ImportRequestError extends Error {
  rowResults: Array<{ sourceRowNumber: number; reasons: string[] }>;
  constructor(message: string, rowResults: Array<{ sourceRowNumber: number; reasons: string[] }> = []) {
    super(message);
    this.rowResults = rowResults;
  }
}

function downloadTemplate(fields: SystemField[]) {
  const headers = fields.map(f => f.apiField);
  const examples = fields.map(f => f.exampleValue);
  const csv = [headers.join(";"), examples.join(";")].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "traivo_import_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const STEP_ICONS = [Upload, ArrowRight, CheckCircle2, MapPin, Truck, SlidersHorizontal, Send] as const;
const DEFAULT_DEPOT_LATITUDE = 59.3293;
const DEFAULT_DEPOT_LONGITUDE = 18.0686;

interface ImportWorkflowProps {
  optimizationRequested?: boolean;
  embedded?: boolean;
  draftId?: string;
  onComplete?: (selection: { planId: string; planningDate: string; validated?: boolean; previewMap?: boolean }) => void;
}

type ResourceSelection = {
  pairValues: string[];
  optimizationProfile: "balanced" | "shortest" | "geographic" | "areas_worktime";
};

const DEFAULT_RESOURCE_SELECTION: ResourceSelection = {
  pairValues: [],
  optimizationProfile: "geographic",
};

function localCalendarDate(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso.slice(0, 10);
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

const IMPORT_DATA_QUERY_KEYS = [
  ["/api/orders"],
  ["/api/stops"],
  ["/api/routes"],
  ["/api/plans"],
  ["orders"],
  ["stops"],
  ["routes"],
  ["plans"],
] as const;

async function fetchPlanningRead(input: RequestInfo | URL): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(input, { credentials: "include" });
    if (![502, 503, 504].includes(response.status)) return response;
    await new Promise((resolve) => window.setTimeout(resolve, 200 * (attempt + 1)));
  }
  return response!;
}

class PlanningReadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlanningReadError";
    this.status = status;
  }
}

async function planningReadError(
  response: Response,
  fallback: string,
): Promise<PlanningReadError> {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  return new PlanningReadError(payload.error || fallback, response.status);
}

function localizePlanHydrationError(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const status = getErrorStatus(error)
    ?? (error instanceof Error
      ? Number(error.message.match(/\b(403|404|410)\b/)?.[1])
      : undefined);
  if (status === 404 || status === 410) {
    return t("import.planUnavailable");
  }
  if (status === 403) {
    return t("import.planAccessDenied");
  }
  if (error instanceof Error && error.message === "IMPORT_HYDRATION_STALE") {
    return t("import.planHydrationCancelled");
  }
  if (error instanceof Error && error.message.startsWith("IMPORT_ROUTE_DRIVER_MISSING:")) {
    return t("import.routeDriverMissing", {
      routeId: error.message.slice("IMPORT_ROUTE_DRIVER_MISSING:".length),
    });
  }
  if (error instanceof Error && error.message === "IMPORT_ROUTE_HYDRATION_INCOMPLETE") {
    return t("import.planStatusLoadFailed");
  }
  return localizeError(error, t, { fallbackKey: "import.planStatusLoadFailed" });
}

export function ImportWorkflow(props: ImportWorkflowProps) {
  return (
    <ImportInfoProvider>
      <ImportWorkflowInner {...props} />
    </ImportInfoProvider>
  );
}

function ImportWorkflowInner({ embedded = false, draftId, onComplete, optimizationRequested = false }: ImportWorkflowProps) {
  const importInfo = useImportInfo();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const reviewRequested = useMemo(
    () => optimizationRequested || new URLSearchParams(search).get("review") === "1",
    [search, optimizationRequested],
  );
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>(1);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);

  const {
    data: draft,
    isLoading: isLoadingDraft,
    isError: isDraftQueryError,
    error: draftQueryError,
    refetch: refetchDraft,
  } = usePlanningDraft(draftId || null);
  const draftAutosave = usePlanningDraftAutosave(draftId || null, draft?.revision);

  const prevDraftId = useRef(draftId);
  const [hasLoadedDraft, setHasLoadedDraft] = useState(false);
  const [draftHydrating, setDraftHydrating] = useState(Boolean(draftId));
  const { data: allStops } = useStops();
  const refreshedPlanStopsId = useRef<string | null>(null);

  // A plan can be created by an authenticated import request in another tab
  // (and the acceptance fixture does this deliberately). Refresh the broad
  // stop list once per plan so omitted-stop labels do not depend on the list
  // query having happened after those writes.
  useEffect(() => {
    if (!draft?.planId || refreshedPlanStopsId.current === draft.planId) return;
    refreshedPlanStopsId.current = draft.planId;
    void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
  }, [draft?.planId, queryClient]);

  useEffect(() => {
    if (prevDraftId.current !== draftId) {
      prevDraftId.current = draftId;
      hydrationGeneration.current += 1;
      refreshedPlanStopsId.current = null;
      setHasLoadedDraft(false);
      setDraftHydrating(Boolean(draftId));
      setStep(1);
      setParsedData(null);
      setMapping({});
      setMappedRows([]);
      setSavedStops([]);
      setAssignedRoutes([]);
      setAssignedPlanId(null);
      setResourceSelection(DEFAULT_RESOURCE_SELECTION);
      setUnplannedStopIds([]);
      setUnplannedDiagnostics([]);
      setPlanPublished(false);
      setValidationErrors([]);
      setError(null);
      setPlanHydrationError(null);
      setFileName("");
      setCustomFields([]);
      setImportedStopIds([]);
      setRejectedRows([]);
      setSentRowCount(0);
      setSavedRowCount(0);
    }
  }, [draftId]);

  const { data: orgSettings } = useQuery({
    queryKey: ["/api/org-settings", organizationId],
    queryFn: () => fetch(`${import.meta.env.VITE_API_URL || ""}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`).then(r => r.json()),
    enabled: !!organizationId,
  });
  const opMode = orgSettings?.operatingMode || "transport";

  const [importIntent, setImportIntent] = useState<"transport" | "field_service">(opMode === "field_service" ? "field_service" : "transport");

  useEffect(() => {
    if (opMode !== "mixed") {
      setImportIntent(opMode);
    }
  }, [opMode]);

  const availableSystemFields = useMemo(() => {
    return SYSTEM_FIELDS.filter(f => !f.forMode || f.forMode === importIntent);
  }, [importIntent]);

  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [selectedMappingKeys, setSelectedMappingKeys] = useState<string[]>([]);
  const [clearedMappingSnapshot, setClearedMappingSnapshot] = useState<{
    source: ParsedData | null;
    mapping: ColumnMapping;
  }>({ source: null, mapping: {} });
  const [mappedRows, setMappedRows] = useState<MappedRow[]>([]);
  const [savedStops, setSavedStops] = useState<ImportStop[]>([]);
  const [assignedRoutes, setAssignedRoutes] = useState<ImportAssignedRoute[]>([]);
  const [assignedPlanId, setAssignedPlanId] = useState<string | null>(null);
  const authoritativePlanQuery = useGetImportRoutePlanPlanningSummary(assignedPlanId ?? "", {
    query: {
      queryKey: getGetImportRoutePlanPlanningSummaryQueryKey(assignedPlanId ?? ""),
      enabled: Boolean(assignedPlanId),
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });
  const authoritativeApprovalQuery = useGetImportRoutePlanApproval(assignedPlanId ?? "", {
    query: {
      queryKey: getGetImportRoutePlanApprovalQueryKey(assignedPlanId ?? ""),
      enabled: Boolean(assignedPlanId),
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });
  const [resourceSelection, setResourceSelection] = useState<ResourceSelection>(
    DEFAULT_RESOURCE_SELECTION,
  );
  const [unplannedStopIds, setUnplannedStopIds] = useState<string[]>([]);
  const [unplannedDiagnostics, setUnplannedDiagnostics] = useState<ImportRoutePlanDiagnostic[]>([]);
  const [planningInputs, setPlanningInputs] = useState<PlanningInputs>({
    version: 1,
    objective: "balanced",
    travelReservePercent: 0,
    stopReserveMin: 0,
    stopPriorities: {},
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
  });
  const [planningMetadata, setPlanningMetadata] = useState<PlanningMetadata>({
    customerReference: null,
    sharedInstructions: null,
  });
  const [planPublished, setPlanPublished] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [planHydrationError, setPlanHydrationError] = useState<string | null>(null);
  const [mappingStorageWarning, setMappingStorageWarning] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [localDrag, setLocalDrag] = useState(false);
  const localDragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [defaultDate, setDefaultDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [customFields, setCustomFields] = useState<SystemField[]>([]);
  const [showAddField, setShowAddField] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [importedStopIds, setImportedStopIds] = useState<string[]>([]);
  const [rejectedRows, setRejectedRows] = useState<RejectedImportRow[]>([]);
  const [sentRowCount, setSentRowCount] = useState(0);
  const [savedRowCount, setSavedRowCount] = useState(0);
  const hydrationGeneration = useRef(0);
  const mountedRef = useRef(true);
  const [planRecoveryPending, setPlanRecoveryPending] = useState<"retry" | "open" | "review" | null>(null);
  const planRecoveryRef = useRef<"retry" | "open" | "review" | null>(null);
  const stopRegisterBusyRef = useRef(false);
  const deferredSaveRef = useRef<{ step: WizardStep; partial: Record<string, any> } | null>(null);
  const draftStateRef = useRef<{ draftId: string | null; state: Record<string, any> }>({
    draftId: null,
    state: {},
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      hydrationGeneration.current += 1;
    };
  }, []);

  // Keep a render-time snapshot so a queued save never captures an older
  // closure while React is processing a fast sequence of address edits.
  if (draftStateRef.current.draftId !== (draft?.id ?? null)) {
    draftStateRef.current = {
      draftId: draft?.id ?? null,
      state: { ...(draft?.state ?? {}) },
    };
  }
  draftStateRef.current.state = {
    ...draftStateRef.current.state,
    parsedData,
    mapping,
    mappedRows,
    savedStops,
    assignedRoutes,
    assignedPlanId,
    unplannedStopIds,
    unplannedDiagnostics,
    planPublished,
    fileName,
    customFields,
    importedStopIds,
    rejectedRows,
    resourceSelection,
    planningInputs,
    planningMetadata,
  };

  const hydrateAuthoritativePlan = useCallback(async (
    planId: string,
    generation: number,
  ): Promise<{ routes: ImportAssignedRoute[]; allApproved: boolean; hasSentRoute: boolean }> => {
    const [approvalResponse, summaryResponse] = await Promise.all([
      fetchPlanningRead(`/api/import/route-plans/${encodeURIComponent(planId)}/approval`),
      fetchPlanningRead(`/api/import/route-plans/${encodeURIComponent(planId)}/planning-summary`),
    ]);
    if (!approvalResponse.ok) {
      throw await planningReadError(approvalResponse, t("import.approvalStatusLoadFailed"));
    }
    if (!summaryResponse.ok) {
      throw await planningReadError(summaryResponse, t("import.planningSummaryLoadFailed"));
    }
    const approvalData: unknown = await approvalResponse.json();
    const summaryData = await summaryResponse.json() as PlanningSummaryResponse;
    if (!isImportApprovalResumeState(approvalData, planId)) {
      throw new Error(t("import.approvalStatusLoadFailed"));
    }
    if (generation !== hydrationGeneration.current || !mountedRef.current) {
      throw new Error("IMPORT_HYDRATION_STALE");
    }

    const routeResponses = await Promise.all(
      approvalData.routes.map(async (summary) => {
        const response = await fetchPlanningRead(`/api/routes/${encodeURIComponent(summary.routeId)}`);
        if (!response.ok) {
          throw await planningReadError(
            response,
            t("import.routeLoadFailed", { routeId: summary.routeId }),
          );
        }
        return { summary, route: await response.json() as Record<string, unknown> };
      }),
    );
    if (generation !== hydrationGeneration.current || !mountedRef.current) {
      throw new Error("IMPORT_HYDRATION_STALE");
    }

    const hydratedRoutes = buildHydratedImportRoutes(approvalData, routeResponses);
    const routes = hydratedRoutes as ImportAssignedRoute[];
    const allApproved = hydratedRoutes.length > 0 && hydratedRoutes.every((route) => route.approval?.approved === true);
    const hasSentRoute = hydratedRoutes.some((route) =>
      ["sent", "received", "opened", "accepted", "rejected"].includes(route.handoffStatus ?? ""),
    );
    // Replace cached projections only after every authoritative read succeeds.
    queryClient.setQueryData(
      getGetImportRoutePlanApprovalQueryKey(planId),
      approvalData,
    );
    queryClient.setQueryData(
      getGetImportRoutePlanPlanningSummaryQueryKey(planId),
      summaryData,
    );
    setAssignedPlanId(planId);
    setAssignedRoutes(routes);
    if (summaryData.planningSummary) {
      setUnplannedStopIds(summaryData.planningSummary.unplanned.map(item => item.stopId));
    }
    const routeMetadata = routeResponses
      .map(({ route }) => route)
      .find((route) => route.customerReference || route.sharedInstructions);
    if (routeMetadata) {
      setPlanningMetadata((current) => ({
        customerReference: current.customerReference
          ?? (typeof routeMetadata.customerReference === "string" ? routeMetadata.customerReference : null)
          ?? null,
        sharedInstructions: current.sharedInstructions
          ?? (typeof routeMetadata.sharedInstructions === "string" ? routeMetadata.sharedInstructions : null)
          ?? null,
      }));
    }
    return { routes, allApproved, hasSentRoute };
  }, [queryClient, t]);

  useEffect(() => {
    if (draft && !hasLoadedDraft) {
      setHasLoadedDraft(true);
      const generation = ++hydrationGeneration.current;
      const loadDraft = async () => {
        if (draft.startAt) {
          setDefaultDate(localCalendarDate(draft.startAt));
        }

        let targetStep = draft.state?.step || 1;
        // Recover customer-created manual drafts saved before the resource
        // step was persisted; the visits already exist and need no upload.
        if (draft.state?.source === "manual" && draft.state?.customerVisitStopIds?.length && targetStep < 5) {
          targetStep = 5;
        }

        if (draft.state) {
          if (draft.state.parsedData) setParsedData(draft.state.parsedData);
          const normalizedDraft = normalizePreImportDraftMapping(
            { ...draft.state, importedResult: draft.importedResult },
            (header) => header.trim().toLocaleLowerCase("sv-SE")
              .normalize("NFD")
              .replace(/\p{Diacritic}/gu, "")
              .replace(/[\s\-\.]+/g, "_"),
          );
          if (normalizedDraft) {
            setMapping(normalizedDraft.mapping);
            setCustomFields(normalizedDraft.customFields);
          } else if (draft.state.mapping) {
            setMapping(draft.state.mapping);
          }
          if (draft.state.mappedRows) setMappedRows(draft.state.mappedRows);
          if (draft.state.fileName) setFileName(draft.state.fileName);
          if (draft.state.customFields && !normalizedDraft) {
            setCustomFields(draft.state.customFields);
          }
          if (draft.state.rejectedRows) setRejectedRows(draft.state.rejectedRows);
          if (draft.state.unplannedStopIds) setUnplannedStopIds(draft.state.unplannedStopIds);
          if (draft.state.unplannedDiagnostics) setUnplannedDiagnostics(draft.state.unplannedDiagnostics);
          if (draft.state.planningInputs) {
            setPlanningInputs({
              ...draft.state.planningInputs,
              stopPriorities: draft.state.planningInputs.stopPriorities || {},
              excludedPairValues: draft.state.planningInputs.excludedPairValues || [],
            });
          }
          if (draft.state.planningMetadata) {
            setPlanningMetadata(draft.state.planningMetadata);
          }
          if (draft.state.resourceSelection) {
            setResourceSelection({
              ...DEFAULT_RESOURCE_SELECTION,
              ...draft.state.resourceSelection,
              pairValues: Array.isArray(draft.state.resourceSelection.pairValues)
                ? draft.state.resourceSelection.pairValues
                : [],
            });
          }
          if (draft.state.source === "manual" && draft.state.selectedStopIds) {
            setImportedStopIds(draft.state.selectedStopIds);
          } else if (draft.state.importedStopIds) {
            setImportedStopIds(draft.state.importedStopIds);
          }
        }

        // importedResult and planId are server-owned. They must be hydrated
        // independently: a completed import can exist before optimization,
        // and a planned draft still needs its imported stops for diagnostics.
        const importEvidence = readImportEvidence(draft.importedResult);
        if (importEvidence.receivedRowCount != null) {
          setSentRowCount(importEvidence.receivedRowCount);
        }
        if (importEvidence.savedRowCount != null) {
          setSavedRowCount(importEvidence.savedRowCount);
        }
        let nextSavedStops: any[] = [];
        let nextImportedStopIds = draft.state?.source === "manual" && draft.state?.selectedStopIds 
          ? [...draft.state.selectedStopIds] 
          : draft.state?.importedStopIds 
            ? [...draft.state.importedStopIds] 
            : [];

        if (draft.importedResult?.stops) {
          nextSavedStops = [...draft.importedResult.stops];
          nextImportedStopIds = importEvidence.stopIds.length > 0
            ? importEvidence.stopIds
            : draft.importedResult.stops.map((s: ImportStop) => s.id);
          if (targetStep < 5) targetStep = 5;
        } else if (draft.state?.savedStops) {
          nextSavedStops = [...draft.state.savedStops];
        }
        if (importEvidence.stopIds.length > 0) {
          nextImportedStopIds = importEvidence.stopIds;
        }

        if (supplementalDraftStopIds(draft.state).length > 0) {
          const visitIds = supplementalDraftStopIds(draft.state);
          // Load the selected records directly: an organization-wide page cap
          // must never silently omit a visit from an existing imported draft.
          for (let offset = 0; offset < visitIds.length; offset += 10) {
            const customerStops = await Promise.all(
              visitIds.slice(offset, offset + 10).map(async (id) => {
                const response = await fetchPlanningRead(`/api/stops/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error(t("import.routeLoadFailed", { routeId: id }));
                const stop = await response.json();
                if (stop.id !== id || stop.archivedAt) {
                  throw new Error(t("import.routeLoadFailed", { routeId: id }));
                }
                return stop;
              }),
            );
            if (generation !== hydrationGeneration.current) return;
            for (const stop of customerStops) {
              if (!nextSavedStops.some((saved) => saved.id === stop.id)) nextSavedStops.push(stop);
              if (!nextImportedStopIds.includes(stop.id)) nextImportedStopIds.push(stop.id);
            }
          }
        }

        if (nextSavedStops.length > 0) {
          setSavedStops(nextSavedStops);
        }
        if (nextImportedStopIds.length > 0) {
          setImportedStopIds(nextImportedStopIds);
        }

        const persistedStopsReady = getInitialPlanReadiness(
          nextImportedStopIds,
          nextSavedStops,
        ).ready;
        if (!draft.planId) {
          targetStep = resolveImportResumeStep(
            targetStep,
            draft.planId,
            persistedStopsReady,
          );
        }
        if (draft.planId) setAssignedPlanId(draft.planId);

        // Authoritative approval state and route identities. Do not infer a
        // driver from the draft's assignedRoutes snapshot.
        if (draft.planId) {
          const hydrated = await hydrateAuthoritativePlan(draft.planId, generation);
          if (hydrated.routes.length === 0) {
            const importedStopIdsFromResult = Array.isArray(draft.importedResult?.stops)
              ? draft.importedResult.stops
                .map((stop: ImportStop) => stop.id)
                .filter((stopId: unknown): stopId is string => typeof stopId === "string")
              : [];
            const savedUnplannedStopIds = Array.isArray(draft.state?.unplannedStopIds)
              ? draft.state.unplannedStopIds.filter(
                (stopId: unknown): stopId is string => typeof stopId === "string",
              )
              : [];
            const selectedManualStopIds = draft.state?.source === "manual"
              && Array.isArray(draft.state.selectedStopIds)
              ? draft.state.selectedStopIds.filter(
                (stopId: unknown): stopId is string => typeof stopId === "string",
              )
              : [];
            setUnplannedStopIds(Array.from(new Set([
              ...importedStopIdsFromResult,
              ...savedUnplannedStopIds,
              ...selectedManualStopIds,
            ])));
            targetStep = 6;
          } else {
            targetStep = resolvePlanResumeStep(
              reviewRequested,
              hydrated.routes.length,
              hydrated.allApproved,
            );
          }
        }

        if (generation === hydrationGeneration.current) setStep(targetStep);
      };

      void loadDraft()
        .then(() => {
          if (generation !== hydrationGeneration.current) return;
          setError(null);
          setPlanHydrationError(null);
        })
        .catch((loadError) => {
          if (generation !== hydrationGeneration.current) return;
          const message = localizePlanHydrationError(loadError, t);
          setPlanHydrationError(message);
          setError(message);
        })
        .finally(() => {
          if (generation === hydrationGeneration.current) setDraftHydrating(false);
        });
    }
  }, [draft, hasLoadedDraft, hydrateAuthoritativePlan, reviewRequested, t]);

  useEffect(() => {
    if (isDraftQueryError) {
      setError(localizeError(draftQueryError, t, { fallbackKey: "common.errorRequestFailed" }));
    }
  }, [draftQueryError, isDraftQueryError, t]);

  useEffect(() => {
    if (draft?.state?.source === "manual" && draft.state.selectedStopIds && allStops && savedStops.length === 0) {
      const selected = allStops.filter(s => draft.state.selectedStopIds.includes(s.id));
      setSavedStops(selected);
    }
  }, [draft?.state?.source, draft?.state?.selectedStopIds, allStops, savedStops.length]);

  const {
    data: vehicles,
    isLoading: isVehiclesLoading,
    isError: isVehiclesError,
    error: vehiclesError,
  } = useQuery<ImportVehicle[]>({
    queryKey: ["vehicles", organizationId],
    queryFn: async () => {
      const res = await fetch(`/api/vehicles?organizationId=${organizationId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t("import.resourcesLoadFailed"));
      }
      return res.json();
    },
    enabled: !!organizationId && step >= 4,
  });

  const {
    data: drivers,
    isLoading: isDriversLoading,
    isError: isDriversError,
    error: driversError,
  } = useQuery<ImportDriver[]>({
    queryKey: ["drivers", organizationId],
    queryFn: async () => {
      const res = await fetch(`/api/drivers?organizationId=${organizationId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t("import.resourcesLoadFailed"));
      }
      return res.json();
    },
    enabled: !!organizationId && step >= 4,
  });
  const step7Depot = useMemo(
    () => resolvePlanReviewDepot(
      assignedRoutes,
      drivers ?? [],
      new Set((vehicles ?? [])
        .filter((vehicle) => vehicle.isActive)
        .map((vehicle) => vehicle.id)),
    ),
    [assignedRoutes, drivers, vehicles],
  );

  const importMutation = useMutation<ImportStopsResponse, Error, { stops: Record<string, unknown>[]; expectedRowCount: number; draftId?: string }>({
    mutationFn: async ({ stops, expectedRowCount, draftId }) => {
      if (!organizationId) throw new TrustedLocalizedError(t("common.errorUnauthorized"));
      const res = await fetch(`/api/stops/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, expectedRowCount, stops, draftId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as ImportStopsValidationError | { error?: string } | null;
        const rowResults = payload && "rowResults" in payload ? payload.rowResults : [];
        throw new ImportRequestError(payload?.error || t("import.importFailed"), rowResults);
      }
      return res.json() as Promise<ImportStopsResponse>;
    },
  });

  const stepLabels = [
    t("wizard.step1"),
    t("wizard.step2"),
    t("wizard.step3"),
    t("wizard.step4"),
    t("wizard.step6"),
    t("wizard.step7", "Review Routes"),
    t("wizard.step8", "Dispatch"),
  ];

  const saveToDraftRef = useRef<
    ((
      nextStep: WizardStep,
      partialState?: any,
      options?: { debounce?: boolean; throwOnError?: boolean },
    ) => Promise<void>) | null
  >(null);

  const saveToDraft = async (
    nextStep: WizardStep,
    partialState: any = {},
    options: { debounce?: boolean; throwOnError?: boolean } = {},
  ) => {
    if (!draft) {
      setError(
        draftId
          ? t("import.draftNotReady")
          : t("import.namedDraftRequired"),
      );
      return;
    }
    if (stopRegisterBusyRef.current) {
      // A stop-register mutation owns the draft revision right now. Keep the
      // newest local intent and write it after hydration has merged visits.
      deferredSaveRef.current = {
        step: nextStep,
        partial: { ...(deferredSaveRef.current?.partial ?? {}), ...partialState },
      };
      draftStateRef.current.state = { ...draftStateRef.current.state, ...partialState };
      return;
    }
    const saveGeneration = hydrationGeneration.current;
    const localState = {
      ...draftStateRef.current.state,
      ...partialState,
      step: nextStep,
      source: draft.state?.source,
      selectedStopIds: draft.state?.selectedStopIds,
    };
    const state = projectImportDraftState(localState, {
      hasAuthoritativeImportedResult: draft.importedResult != null || savedRowCount > 0,
      serverPlanId: partialState?.assignedPlanId ?? draft.planId,
    });
    draftStateRef.current.state = localState;
    const debounced = options.debounce === true;
    const savePromise = draftAutosave.schedule(
      { state },
      { immediate: !debounced },
    );
    if (debounced) {
      void savePromise.catch((saveError) => {
        if (saveGeneration !== hydrationGeneration.current) return;
        setError(localizeError(saveError, t, { fallbackKey: "common.errorRequestFailed" }));
      });
      return;
    }
    try {
      const savedDraft = await savePromise;
      if (savedDraft?.state) {
        // Keep local projections available to the current UI while ensuring
        // the next request is compacted again at the request boundary.
        draftStateRef.current.state = {
          ...draftStateRef.current.state,
          ...savedDraft.state,
        };
      }
      // Explicit navigation and save actions wait for the entire queue,
      // including a write that was already in flight.
      await draftAutosave.flush();
      if (saveGeneration !== hydrationGeneration.current) return;
      setStep(nextStep);
    } catch (saveError) {
      if (saveGeneration !== hydrationGeneration.current) return;
      setError(localizeError(saveError, t, { fallbackKey: "common.errorRequestFailed" }));
      if (options.throwOnError) throw saveError;
    }
  };
  // Memoized event handlers (notably file parsing) can outlive the render that
  // created them. Always expose the current draft-aware saver to those
  // handlers so a draft query that finished loading is never bypassed.
  saveToDraftRef.current = saveToDraft;

  const runPlanRecovery = useCallback(async (intent: "retry" | "open" | "review") => {
    if (planRecoveryRef.current || !mountedRef.current) return;
    const generation = ++hydrationGeneration.current;
    planRecoveryRef.current = intent;
    setPlanRecoveryPending(intent);
    setError(null);
    setPlanHydrationError(null);
    try {
      // A step transition can still be queued while the status action is
      // clicked. Persist it before deciding whether a server plan exists.
      await draftAutosave.flush();
      // Always begin with a fresh draft read. The persisted assignedRoutes
      // value is not a source of truth and may be [] after a successful plan.
      const latestDraftResult = await refetchDraft();
      if (latestDraftResult.isError) throw latestDraftResult.error;
      const latestDraft = latestDraftResult.data;
      const planId = latestDraft?.planId;
      if (!planId) {
        // A retained draft may remember review step 6 even though no plan was
        // ever created. Return to resources only for this no-plan case. If a
        // plan existed in this UI/draft before disappearing, preserve the
        // existing missing/deleted-plan error instead of silently reopening
        // planning against a different snapshot.
        if (assignedPlanId || draft?.planId) {
          throw new PlanningReadError(t("import.planUnavailable"), 404);
        }
        const evidence = readImportEvidence(latestDraft?.importedResult);
        const recoveryStopIds = evidence.stopIds.length > 0
          ? evidence.stopIds
          : importedStopIds;
        const recoveryStops = Array.isArray(latestDraft?.importedResult?.stops)
          ? latestDraft.importedResult.stops
          : savedStops;
        if (!getInitialPlanReadiness(recoveryStopIds, recoveryStops).ready) {
          throw new TrustedLocalizedError(t("import.planStopsNotReady"));
        }
        const save = saveToDraftRef.current;
        if (!save) throw new TrustedLocalizedError(t("import.draftNotReady"));
        await save(5, {
          assignedRoutes: [],
          assignedPlanId: null,
          unplannedStopIds: [],
          unplannedDiagnostics: [],
        }, { throwOnError: true });
        setAssignedRoutes([]);
        setAssignedPlanId(null);
        setUnplannedStopIds([]);
        setUnplannedDiagnostics([]);
        setStep(5);
        return;
      }
      const hydrated = await hydrateAuthoritativePlan(planId, generation);
      if (generation !== hydrationGeneration.current || !mountedRef.current) return;
      const destination: WizardStep = intent === "review"
        ? 6
        : hydrated.hasSentRoute || hydrated.allApproved
          ? 7
          : 6;
      if (intent === "review") {
        const save = saveToDraftRef.current;
        if (!save) throw new TrustedLocalizedError(t("import.draftNotReady"));
        // Persist the review transition only after authoritative routes have
        // loaded, so a transient read failure cannot reopen a blank step.
        await save(6, { assignedRoutes: hydrated.routes }, { throwOnError: true });
      } else {
        setStep(destination);
      }
    } catch (recoveryError) {
      if (generation === hydrationGeneration.current && mountedRef.current) {
        const message = localizePlanHydrationError(recoveryError, t);
        setPlanHydrationError(message);
        setError(message);
      }
    } finally {
      if (planRecoveryRef.current === intent) {
        planRecoveryRef.current = null;
        if (mountedRef.current) setPlanRecoveryPending(null);
      }
    }
  }, [
    assignedPlanId,
    draft?.planId,
    draftAutosave,
    hydrateAuthoritativePlan,
    importedStopIds,
    refetchDraft,
    savedStops,
    t,
  ]);

  const returnToExistingPlanReview = () => {
    void runPlanRecovery("review");
  };

  const handlePlanningReoptimized = async (
    result: PlanningInputsReoptimizationResult,
    summary: PlanningSummaryResponse,
  ): Promise<ImportAssignedRoute[]> => {
    const revisionsByRouteId = new Map(
      result.routes.map((route) => [route.routeId, route]),
    );
    const canonicalRoutes = await Promise.all(summary.routes.map(async (routeSummary) => {
      const revision = revisionsByRouteId.get(routeSummary.routeId);
      if (
        !revision
        || revision.status !== "optimized"
        || !routeSummary.driverId
        || !routeSummary.vehicleId
      ) {
        throw new TrustedLocalizedError(t("import.planningSummaryLoadFailed"));
      }
      const response = await fetch(`/api/routes/${routeSummary.routeId}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || t("import.routeLoadFailed", { routeId: routeSummary.routeId }));
      }
      const route = await response.json() as Route;
      if (
        route.planRevision !== revision.planRevision ||
        routeSummary.planRevision !== revision.planRevision
      ) {
        throw new TrustedLocalizedError(
          "Arbetsplanen har ändrats igen efter sparandet. Öppna planen på nytt för att granska den aktuella versionen.",
        );
      }
      return {
        routeId: routeSummary.routeId,
        planId: routeSummary.planId,
        planRevision: revision.planRevision,
        vehicleId: routeSummary.vehicleId,
        driverId: routeSummary.driverId,
        handoffStatus: route.handoffStatus,
        handoffDriverId: route.handoffDriverId,
        handoffVersion: route.handoffVersion,
        name: route.name,
        totalDistanceKm: route.totalDistanceKm ?? 0,
        totalDurationMin: route.totalDurationMin ?? 0,
        stopCount: route.totalStops ?? 0,
        depotSnapshot: route.depotSnapshot ?? null,
        status: revision.status,
      };
    }));
    const nextPlanningInputs = summary.planningInputs ?? planningInputs;
    const nextPlanningMetadata: PlanningMetadata = {
      customerReference: summary.customerReference,
      sharedInstructions: summary.sharedInstructions,
    };
    const nextUnplannedStopIds = result.planningSummary.unplanned.map((item) => item.stopId);
    const nextState = projectImportDraftState({
      ...draftStateRef.current.state,
      planningInputs: nextPlanningInputs,
      planningMetadata: nextPlanningMetadata,
      assignedRoutes: canonicalRoutes,
      assignedPlanId: result.planId,
      unplannedStopIds: nextUnplannedStopIds,
      unplannedDiagnostics: [],
      step: 6,
    }, {
      hasAuthoritativeImportedResult: draft?.importedResult != null || savedRowCount > 0,
      serverPlanId: result.planId,
    });
    draftStateRef.current.state = nextState;
    setPlanningInputs(nextPlanningInputs);
    setPlanningMetadata(nextPlanningMetadata);
    setAssignedPlanId(result.planId);
    setAssignedRoutes(canonicalRoutes);
    setUnplannedStopIds(nextUnplannedStopIds);
    setUnplannedDiagnostics([]);
    if (draftId && organizationId) {
      queryClient.setQueryData<PlanningDraft>(
        ["planning-drafts", organizationId, draftId],
        (current) => current ? {
          ...current,
          revision: result.draftRevision,
          state: nextState,
          planId: result.planId,
        } : current,
      );
      await queryClient.invalidateQueries({
        queryKey: ["planning-drafts", organizationId],
        exact: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ["planning-drafts", organizationId, draftId],
        exact: true,
      });
    }
    await Promise.all(
      IMPORT_DATA_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
    return canonicalRoutes;
  };

  const fullReset = useCallback(() => {
    setStep(1);
    setParsedData(null);
    setMapping({});
    setMappedRows([]);
    setValidationErrors([]);
    setError(null);
    setFileName("");
    setDefaultDate(
      draft?.startAt
        ? localCalendarDate(draft.startAt)
        : new Date().toISOString().split("T")[0],
    );
    setCustomFields([]);
    setShowAddField(false);
    setNewFieldName("");
    setImportedStopIds([]);
    setSavedStops([]);
    setAssignedRoutes([]);
    setAssignedPlanId(null);
    setResourceSelection(DEFAULT_RESOURCE_SELECTION);
    setUnplannedStopIds([]);
    setUnplannedDiagnostics([]);
    setPlanPublished(false);
    setRejectedRows([]);
    setSentRowCount(0);
    setSavedRowCount(0);
  }, [draft?.startAt]);

  const normalizeHeader = useCallback((header: string) =>
    header.trim().toLocaleLowerCase("sv-SE").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[\s\-\.]+/g, "_"), []);

  const autoMatchColumns = useCallback((headers: string[]): ColumnMapping => {
    const result: ColumnMapping = {};
    for (const field of availableSystemFields) { result[field.key] = null; }
    for (const header of headers) {
      const normalized = normalizeHeader(header);
      const matchedField = ALIAS_MAP[normalized] ?? ALIAS_MAP[header.trim().toLocaleLowerCase("sv-SE").replace(/[\s\-\.]+/g, "_")];
      if (matchedField && availableSystemFields.some(f => f.key === matchedField) && !result[matchedField]) { result[matchedField] = header; }
    }
    // Present the three conventional delivery columns as one target while
    // retaining the legacy fields in the saved mapping for old consumers.
    const deliveryParts = getDeliveryAddressMapping(result);
    if (deliveryParts.length > 1) result.address = deliveryParts;
    return result;
  }, [availableSystemFields, normalizeHeader]);

  const isValidFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase();
    return ext.endsWith(".csv") || ext.endsWith(".xlsx") || ext.endsWith(".xls") || ext.endsWith(".xlsb");
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      const requestGeneration = hydrationGeneration.current;
      setError(null);
      setFileName(file.name);
      if (!isValidFile(file)) {
        setError(t("import.unsupportedFile"));
        return;
      }
      try {
        const parsed = await parseImportFile(file);
        if (requestGeneration !== hydrationGeneration.current) return;
        const suggestedMapping = autoMatchColumns(parsed.headers);
        // The saved profile is metadata only. Draft state above remains the
        // source of truth when resuming an existing import; this profile is
        // consulted only while preparing a newly parsed file.
        const storageResult = organizationId && user?.id
          ? loadImportMappingProfile(organizationId, user.id)
          : { status: "missing" as const };
        if (storageResult.status === "unavailable" || storageResult.status === "invalid") {
          setMappingStorageWarning(t("import.mappingStorageWarning"));
        } else {
          setMappingStorageWarning(null);
        }
        const reused = mergeSavedImportMapping({
          headers: parsed.headers,
          fallbackMapping: suggestedMapping,
          savedProfile: storageResult.profile,
          systemFieldKeys: availableSystemFields.map((field) => field.key),
          normalizeHeader,
        });
        const nextMapping = reused.mapping as ColumnMapping;
        const nextCustomFields = reused.customFields as SystemField[];
        setCustomFields(nextCustomFields);
        setParsedData({
          headers: parsed.headers,
          rows: parsed.rows,
          sourceRowCount: parsed.sourceRowCount,
        });
        setRejectedRows(parsed.rejectedRows);
        setMapping(nextMapping);
        setSelectedMappingKeys([]);
        setSentRowCount(0);
        setSavedRowCount(0);
        const save = saveToDraftRef.current;
        if (!save) {
          setError(t("import.draftNotReady"));
          return;
        }
        await save(2, {
          parsedData: {
            headers: parsed.headers,
            rows: parsed.rows,
            sourceRowCount: parsed.sourceRowCount,
          },
          mapping: nextMapping,
          fileName: file.name,
          customFields: nextCustomFields,
          rejectedRows: parsed.rejectedRows
        });
      } catch (parseError) {
        if (requestGeneration !== hydrationGeneration.current) return;
        setError(localizeError(parseError, t, { fallbackKey: "import.parseFailed" }));
      }
    },
    [
      t,
      autoMatchColumns,
      isValidFile,
      normalizeHeader,
      organizationId,
      user?.id,
      availableSystemFields,
    ],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDraggingOver(true);
  }, []);
  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDraggingOver(false);
  }, []);
  const handlePageDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); }, []);
  const handlePageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current = 0;
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && isValidFile(file)) processFile(file);
  }, [isValidFile, processFile]);

  const updateMapping = useCallback((systemField: string, fileColumn: string | null) => {
    setMapping((prev) => ({ ...prev, [systemField]: fileColumn === "__none__" ? null : fileColumn }));
  }, []);

  const allFields = useMemo(() => [...availableSystemFields, ...customFields], [availableSystemFields, customFields]);
  const mappingFields = useMemo(
    () => allFields.filter((field) => field.key !== "postalCode" && field.key !== "city"),
    [allFields],
  );
  const clearableMappingKeys = useMemo(
    () => mappingFields
      .filter((field) => !field.required && typeof mapping[field.key] === "string" && Boolean(mapping[field.key]))
      .map((field) => field.key),
    [mappingFields, mapping],
  );
  const activeMappingSelection = selectedMappingKeys.filter((key) => clearableMappingKeys.includes(key));
  const previousClearedMapping = clearedMappingSnapshot.source === parsedData ? clearedMappingSnapshot.mapping : {};
  const restorableMappingKeys = mappingFields.filter((field) =>
    !field.required && mapping[field.key] === null
    && typeof previousClearedMapping[field.key] === "string"
    && parsedData?.headers.includes(previousClearedMapping[field.key] as string)
  ).map((field) => field.key);
  const allOptionalMappingsSelected = clearableMappingKeys.length > 0
    && activeMappingSelection.length === clearableMappingKeys.length;
  const clearMappings = (keys: string[]) => {
    setClearedMappingSnapshot({
      source: parsedData,
      mapping: {
        ...previousClearedMapping,
        ...Object.fromEntries(keys.filter((key) => clearableMappingKeys.includes(key))
          .map((key) => [key, mapping[key]])),
      },
    });
    setMapping((previous) => clearSelectedImportMappings(previous, mappingFields, keys));
    setSelectedMappingKeys([]);
  };
  const restoreMappings = (keys: string[]) => {
    setMapping((previous) => restoreSelectedImportMappings(
      previous, mappingFields, keys, previousClearedMapping, parsedData?.headers ?? [],
    ));
  };

  const updateDeliveryAddressComponent = useCallback((
    component: DeliveryAddressComponent,
    fileColumn: string | null,
  ) => {
    setMapping((previous) => {
      const current = getDeliveryAddressMapping(previous);
      const withoutComponent = current.filter((part) => part.component !== component);
      if (fileColumn && fileColumn !== "__none__") {
        withoutComponent.push({ component, column: fileColumn });
      }
      const nextParts = getDeliveryAddressMapping({
        ...previous,
        address: withoutComponent,
        // An explicit parts array is authoritative. Clear the old direct
        // fields so removing a chip does not make it reappear on render.
        postalCode: null,
        city: null,
      });
      return {
        ...previous,
        address: nextParts,
        postalCode: null,
        city: null,
      };
    });
  }, []);

  const addCustomField = useCallback((name: string) => {
    if (!name.trim()) return;
    const key = `custom_${name.trim().toLowerCase().replace(/[\s\-\.]+/g, "_")}`;
    if (allFields.some(f => f.key === key)) return;
    setCustomFields(prev => [...prev, {
      key,
      labelKey: name.trim(),
      required: false,
      description: "",
      apiField: key,
      exampleValue: "",
    }]);
    setNewFieldName("");
    setShowAddField(false);
  }, [allFields]);

  const removeCustomField = useCallback((key: string) => {
    setCustomFields(prev => prev.filter(f => f.key !== key));
    setMapping(prev => { const next = { ...prev }; delete next[key]; return next; });
  }, []);

  const mappingSummary = useMemo(() => {
    const isSatisfied = (field: (typeof allFields)[number]) =>
      (field.key === "address"
        ? getDeliveryAddressMapping(mapping).some((part) => part.component === "address")
        : Boolean(mapping[field.key]))
      || (field.key === "date" && Boolean(defaultDate));
    return {
      matched: mappingFields.filter(isSatisfied).length,
      requiredMissing: mappingFields.filter((field) => field.required && !isSatisfied(field)).length,
      optionalMissing: mappingFields.filter((field) => !field.required && !isSatisfied(field)).length,
    };
  }, [allFields, defaultDate, mapping, mappingFields]);
  const requiredMapped = useMemo(
    () => availableSystemFields.filter((f) => f.required).every((f) => {
      if (f.key === "date" && defaultDate) return true;
      if (f.key === "address") {
        return getDeliveryAddressMapping(mapping).some((part) => part.component === "address");
      }
      return mapping[f.key];
    }),
    [mapping, defaultDate, availableSystemFields],
  );

  const handleApplyMapping = useCallback(async () => {
    if (!parsedData) return;

    const rows: MappedRow[] = [];
    const getColIdx = (sf: string): number => {
      const colName = mapping[sf];
      return typeof colName === "string" ? parsedData.headers.indexOf(colName) : -1;
    };

    const num = (v?: string): number | undefined => {
      if (v == null || String(v).trim() === "") return undefined;
      return parseLocalizedNumber(v);
    };

    for (let i = 0; i < parsedData.rows.length; i++) {
      const sourceRow = parsedData.rows[i];
      const row = sourceRow.values;
      const mappingErrors: string[] = [];
      const getVal = (key: string) => {
        const idx = getColIdx(key);
        return idx >= 0 && row[idx]?.trim() ? row[idx].trim() : undefined;
      };
      const deliveryAddress = resolveDeliveryAddressValues(mapping, parsedData.headers, row);

      const rowJobType = importIntent === "field_service"
        ? "field_service"
        : getVal("pickupAddress")
          ? "pickup_delivery"
          : "delivery";

      const numericValue = (key: string, label: string) => {
        const raw = getVal(key);
        const parsed = num(raw);
        if (raw !== undefined && parsed === undefined) {
          mappingErrors.push(t("import.invalidNumberFormat", { label, value: raw }));
        }
        return parsed;
      };
      const rawDate = getVal("date");
      const normalizedDate = normalizeImportDate(rawDate) ?? (rawDate ? undefined : defaultDate);
      if (rawDate && !normalizedDate) {
        mappingErrors.push(t("import.invalidDateFormat", { value: rawDate }));
      }
      const planningDate = draft?.startAt ? localCalendarDate(draft.startAt) : undefined;
      if (normalizedDate && planningDate && normalizedDate !== planningDate) {
        mappingErrors.push(
          t("import.dateConflictsWithPlan", {
            rowDate: normalizedDate,
            planningDate,
          }),
        );
      }
      const timeValue = (key: string, label: string) => {
        const raw = getVal(key);
        const parsed = normalizeImportTime(raw);
        if (raw !== undefined && parsed === undefined) {
          mappingErrors.push(t("import.invalidTimeFormat", { label, value: raw }));
        }
        return parsed;
      };
      const timeWindowStart = timeValue("timeWindowStart", t("import.field.timeWindowStart"));
      const timeWindowEnd = timeValue("timeWindowEnd", t("import.field.timeWindowEnd"));
      const slaDeadline = timeValue("slaDeadline", t("import.field.slaDeadline"));
      const latitude = numericValue("latitude", t("import.field.latitude"));
      const longitude = numericValue("longitude", t("import.field.longitude"));
      const pickupLatitude = numericValue("pickupLatitude", t("import.field.pickupLatitude"));
      const pickupLongitude = numericValue("pickupLongitude", t("import.field.pickupLongitude"));
      const serviceDurationMin = numericValue("serviceDurationMin", t("import.field.serviceDurationMin"));
      const weightKg = numericValue("weightKg", t("import.field.weightKg"));
      const volumeM3 = numericValue("volumeM3", t("import.field.volumeM3"));
      const priority = numericValue("priority", t("import.field.priority"));

      const mapped: MappedRow = {
        _id: crypto.randomUUID(),
        _sourceRowNumber: sourceRow.sourceRowNumber,
        _sourceValues: sourceRow.values,
        _mappingErrors: mappingErrors,
        address: deliveryAddress.address || getVal("address") || "",
        pickupAddress: getVal("pickupAddress"),
        postalCode: deliveryAddress.postalCode ?? getVal("postalCode"),
        city: deliveryAddress.city ?? getVal("city"),
        _deliveryAddressComposed: deliveryAddress.composed,
        latitude,
        longitude,
        pickupLatitude,
        pickupLongitude,
        referenceNumber: getVal("referenceNumber"),
        date: normalizedDate,
        contactName: getVal("contactName"),
        contactPhone: getVal("contactPhone"),
        contactEmail: getVal("contactEmail"),
        timeWindowStart,
        timeWindowEnd,
        serviceDurationMin,
        weightKg,
        volumeM3,
        notes: getVal("notes"),
        jobType: rowJobType,
        serviceCategory: getVal("serviceCategory"),
        priority,
        slaDeadline,
        serviceInstructions: getVal("serviceInstructions"),
        requiredSkills: getVal("requiredSkills"),
        requiredCertifications: getVal("requiredCertifications"),
        requiredEquipment: getVal("requiredEquipment"),
      };

      for (const cf of customFields) {
        const val = getVal(cf.key);
        if (val) mapped[cf.key] = val;
      }
      rows.push(mapped);
    }
    setMappedRows(rows);
    const save = saveToDraftRef.current;
    if (!save) {
      setError(t("import.draftNotReady"));
      return;
    }
    await save(3, { mappedRows: rows });
    if (organizationId && user?.id) {
      const storageStatus = saveImportMappingProfile(
        organizationId,
        user.id,
        mapping as PersistedColumnMapping,
        customFields,
      );
      if (storageStatus === "unavailable") {
        setMappingStorageWarning(t("import.mappingStorageWarning"));
      } else {
        setMappingStorageWarning(null);
      }
    }
  }, [
    parsedData,
    mapping,
    t,
    defaultDate,
    customFields,
    importIntent,
    draft?.startAt,
    organizationId,
    user?.id,
  ]);

  const handleSaveStopsAndContinue = useCallback(() => {
    if (importMutation.isPending) return;
    const invalidRow = mappedRows.find((row) =>
      !isValidCoordinate(row.latitude, row.longitude)
      || (
        Boolean(row.pickupAddress?.trim())
        && !isValidCoordinate(row.pickupLatitude, row.pickupLongitude)
      ));
    if (invalidRow) {
      setError(t("import.invalidCoordinates"));
      return;
    }

    const combineDateTime = (dateStr?: string, timeStr?: string): string | undefined => {
      if (timeStr == null || String(timeStr).trim() === "") return undefined;
      const raw = String(timeStr).trim();
      if (/\d{4}-\d{2}-\d{2}/.test(raw) || raw.includes("T")) {
        const full = new Date(raw);
        if (!isNaN(full.getTime())) return full.toISOString();
      }
      const datePart = dateStr && /^\d{4}-\d{2}-\d{2}/.test(String(dateStr))
        ? String(dateStr).slice(0, 10)
        : defaultDate;
      const m = raw.match(/^(\d{1,2})(?:[:.h](\d{1,2}))?/);
      if (!m) return undefined;
      const h = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      if (isNaN(h) || h > 23 || min > 59) return undefined;
      const dt = new Date(`${datePart}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
      return isNaN(dt.getTime()) ? undefined : dt.toISOString();
    };

    const stops = mappedRows.map((row) => {
      const fullAddress = composeDeliveryAddress(
        row.address,
        row.postalCode,
        row.city,
        { composed: row._deliveryAddressComposed === true },
      );
      const stop: Record<string, unknown> = {
        address: fullAddress || "",
        latitude: row.latitude,
        longitude: row.longitude,
        sourceRowNumber: row._sourceRowNumber,
      };

      if (row.pickupAddress) {
        stop.pickupAddress = row.pickupAddress;
        stop.pickupLatitude = row.pickupLatitude;
        stop.pickupLongitude = row.pickupLongitude;
      }
      if (row.notes) stop.notes = row.notes;
      if (row.referenceNumber) stop.externalRef = row.referenceNumber;
      if (row.contactName) stop.contactName = row.contactName;
      if (row.contactPhone) stop.contactPhone = row.contactPhone;
      if (row.contactEmail) stop.contactEmail = row.contactEmail;

      const tws = combineDateTime(row.date, row.timeWindowStart);
      const twe = combineDateTime(row.date, row.timeWindowEnd);
      if (tws) stop.timeWindowStart = tws;
      if (twe) stop.timeWindowEnd = twe;

      if (row.serviceDurationMin !== undefined) stop.serviceDurationMin = Math.round(row.serviceDurationMin);
      if (row.weightKg !== undefined) stop.weightKg = row.weightKg;
      if (row.volumeM3 !== undefined) stop.volumeM3 = row.volumeM3;

      const splitArr = (str?: string) => str ? str.split(",").map(s => s.trim()).filter(Boolean) : null;
      if (row.jobType) stop.jobType = row.jobType;
      if (row.serviceCategory) stop.serviceCategory = row.serviceCategory;
      if (row.priority !== undefined) stop.priority = row.priority;
      if (row.slaDeadline) {
        const sla = combineDateTime(row.date, row.slaDeadline);
        if (sla) stop.slaDeadline = sla;
      }
      if (row.serviceInstructions) stop.serviceInstructions = row.serviceInstructions;

      const rSkills = splitArr(row.requiredSkills);
      if (rSkills) stop.requiredSkills = rSkills;

      const rCerts = splitArr(row.requiredCertifications);
      if (rCerts) stop.requiredCertifications = rCerts;

      const rEquip = splitArr(row.requiredEquipment);
      if (rEquip) stop.requiredEquipment = rEquip;

      const customData: Record<string, string> = {};
      for (const cf of customFields) {
        if (row[cf.key]) customData[cf.labelKey] = String(row[cf.key]);
      }
      if (Object.keys(customData).length > 0) stop.customFields = customData;
      return stop;
    });

    setSentRowCount(stops.length);
    const requestGeneration = hydrationGeneration.current;
    importMutation.mutate({ stops, expectedRowCount: stops.length, draftId }, {
      onSuccess: async (data) => {
        if (requestGeneration !== hydrationGeneration.current) return;
        if (data.receivedRowCount !== stops.length || data.savedRowCount !== stops.length) {
          setError(
            t("import.rowCountChanged", {
              sent: stops.length,
              saved: data.savedRowCount,
            }),
          );
          return;
        }
        setSavedRowCount(data.savedRowCount);
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        let latestStops = savedStops;
        if (data?.stops) {
          const ids = data.stops.map((stop) => stop.id);
          setImportedStopIds(ids);
          setSavedStops(data.stops);
          latestStops = data.stops;
        }
        // Import owns importedResult on the server. Refresh the detail query
        // before the next draft PUT so a retry cannot use a stale snapshot.
        if (draftId && organizationId) {
          await queryClient.invalidateQueries({
            queryKey: ["planning-drafts", organizationId, draftId],
          });
        }
        if (requestGeneration !== hydrationGeneration.current) return;
        const save = saveToDraftRef.current;
        if (!save) {
          setError(t("import.draftNotReady"));
          return;
        }
        await save(5, {
          savedStops: latestStops,
          importedStopIds: latestStops.map((s: any) => s.id),
        });
      },
      onError: (mutationError) => {
        if (requestGeneration !== hydrationGeneration.current) return;
        if (mutationError instanceof ImportRequestError && mutationError.rowResults.length > 0) {
          const reasonsByRow = new Map(
            mutationError.rowResults.map((result) => [result.sourceRowNumber, result.reasons]),
          );
          setMappedRows((current) => current.map((row) => {
            const reasons = reasonsByRow.get(row._sourceRowNumber);
            return reasons ? {
              ...row,
              _mappingErrors: [...(row._mappingErrors ?? []), ...reasons],
            } : row;
          }));
        }
        setError(localizeError(mutationError, t, { fallbackKey: "import.importFailed" }));
      },
    });
  }, [mappedRows, importMutation, queryClient, t, defaultDate, customFields, draftId, organizationId]);

  const handleUpdateRow = useCallback((id: string, updates: Partial<MappedRow>) => {
    setMappedRows((prev) => prev.map((r) => (r._id === id ? { ...r, ...updates } : r)));
  }, []);

  const handleDeleteRow = useCallback((id: string) => {
    setMappedRows((prev) => {
      const removed = prev.find((row) => row._id === id);
      if (removed) {
        setRejectedRows((current) => [...current, {
          sourceRowNumber: removed._sourceRowNumber,
          values: removed._sourceValues,
          reasons: [t("import.rowManuallyRejected")],
        }]);
      }
      return prev.filter((r) => r._id !== id);
    });
  }, [t]);

  const [stopRegisterOpen, setStopRegisterOpen] = useState(false);
  const canUseStopRegister = Boolean(
    draft && !draft.planId && !assignedPlanId && user && ["admin", "dispatcher"].includes(user.role),
  );
  const mergeCustomerVisitIds = (ids: string[]) => {
    const current = draftStateRef.current.state.customerVisitStopIds;
    draftStateRef.current.state = {
      ...draftStateRef.current.state,
      customerVisitStopIds: [...new Set([...(Array.isArray(current) ? current : []), ...ids])],
    };
  };
  const releaseStopRegisterSaves = useCallback(() => {
    if (!stopRegisterBusyRef.current) return;
    stopRegisterBusyRef.current = false;
    const deferred = deferredSaveRef.current;
    deferredSaveRef.current = null;
    if (deferred) void saveToDraftRef.current?.(deferred.step, deferred.partial, { debounce: true });
  }, []);
  const prepareStopRegister = useCallback(async () => {
    // Block new wizard autosaves for the whole mutation + hydration window,
    // then drain any queued (including debounced) write before reading the
    // authoritative revision. A later stale write cannot erase the visits.
    stopRegisterBusyRef.current = true;
    await draftAutosave.flush();
    const latest = await refetchDraft();
    if (latest.isError || !latest.data) {
      throw latest.error ?? new TrustedLocalizedError(t("import.draftNotReady"));
    }
    if (latest.data.planId) throw new TrustedLocalizedError(t("stopRegister.importUnavailable"));
    if (latest.data.id !== draftId) throw new TrustedLocalizedError(t("stopRegister.scopeChanged"));
    return { draftRevision: latest.data.revision };
  }, [draftAutosave, draftId, refetchDraft, t]);
  const savedStopsRef = useRef(savedStops);
  savedStopsRef.current = savedStops;
  const stopRegisterTargetRef = useRef<{ draftId: string; date: string } | null>(null);
  const hydrateStopRegisterResult = useCallback(async (result: StopRegisterResult) => {
    // Record committed membership locally before any fallible read so that a
    // later autosave can never drop the server-added visits.
    mergeCustomerVisitIds(result.stopIds);
    const generation = hydrationGeneration.current;
    const latest = await refetchDraft();
    if (latest.isError || !latest.data) {
      throw latest.error ?? new TrustedLocalizedError(t("import.draftNotReady"));
    }
    if (generation !== hydrationGeneration.current || !mountedRef.current) return;
    const latestDraft = latest.data;
    // The committed result must belong to the draft/day that was confirmed.
    const confirmed = stopRegisterTargetRef.current;
    const latestDate = latestDraft.startAt ? localCalendarDate(latestDraft.startAt) : null;
    if (
      latestDraft.id !== draftId
      || (result.draftId && result.draftId !== latestDraft.id)
      || (confirmed && (confirmed.draftId !== latestDraft.id || (latestDate && confirmed.date !== latestDate)))
    ) {
      throw new TrustedLocalizedError(t("stopRegister.scopeChanged"));
    }
    mergeCustomerVisitIds(supplementalDraftStopIds(latestDraft.state));
    const newIds = [...new Set([...supplementalDraftStopIds(latestDraft.state), ...result.stopIds])];
    const known = new Set(savedStopsRef.current.map((stop) => stop.id));
    const fromDraft: ImportStop[] = Array.isArray(latestDraft.importedResult?.stops)
      ? latestDraft.importedResult.stops.filter((stop: ImportStop) => newIds.includes(stop.id) && !known.has(stop.id))
      : [];
    fromDraft.forEach((stop) => known.add(stop.id));
    const missing = newIds.filter((id) => !known.has(id));
    const fetched: ImportStop[] = [];
    for (let offset = 0; offset < missing.length; offset += 10) {
      const batch = await Promise.all(missing.slice(offset, offset + 10).map(async (id) => {
        const response = await fetchPlanningRead(`/api/stops/${encodeURIComponent(id)}`);
        if (!response.ok) throw new TrustedLocalizedError(t("stopRegister.stopLoadFailed"));
        const stop = await response.json();
        if (!stop || stop.id !== id || stop.archivedAt) {
          throw new TrustedLocalizedError(t("stopRegister.stopLoadFailed"));
        }
        return stop as ImportStop;
      }));
      if (generation !== hydrationGeneration.current || !mountedRef.current) return;
      fetched.push(...batch);
    }
    const additions = [...fromDraft, ...fetched];
    setSavedStops((current) => [
      ...current,
      ...additions.filter((stop) => !current.some((existing) => existing.id === stop.id)),
    ]);
    setImportedStopIds((current) => [...new Set([...current, ...newIds])]);
    // The server bumped the revision; align the serialized saver before
    // releasing queued writes.
    draftAutosave.revisionRef.current = latestDraft.revision;
    releaseStopRegisterSaves();
    void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
  }, [draftAutosave, draftId, queryClient, refetchDraft, releaseStopRegisterSaves, t]);

  const importCounts = useMemo(() => {
    const reviewCounts = reconcileImportReviewCounts(mappedRows, rejectedRows, {
      // Coordinates are a hard gate for a row to be ready. This prevents the
      // central counter from calling unresolved geocodes approved.
      addressesResolved: true,
    });
    const manualSelectedCount = draft?.state?.source === "manual"
      && Array.isArray(draft.state.selectedStopIds)
      ? draft.state.selectedStopIds.length
      : 0;
    const hasParsedSourceState = Boolean(parsedData || draft?.state?.parsedData);
    const counts = resolveImportCounts({
      importedResult: draft?.importedResult,
      parsedSourceRowCount: parsedData?.sourceRowCount
        ?? draft?.state?.parsedData?.sourceRowCount,
      hasParsedSourceState,
      localReceivedRowCount: sentRowCount,
      localSavedRowCount: savedRowCount,
      manualSelectedCount,
    });
    const persistedReceivedRowCount = readImportEvidence(draft?.importedResult).receivedRowCount;
    return {
      read: counts.read,
      validated: step >= 3 ? reviewCounts.validated : 0,
      ready: step >= 3 ? reviewCounts.ready : 0,
      action: step >= 3 ? reviewCounts.action : 0,
      approved: step >= 3 ? reviewCounts.ready : 0,
      rejected: reviewCounts.rejected,
      // This is the import request row count, not route dispatch progress.
      // Never feed it into PlanStatusChain's handoff counts.
      sent: persistedReceivedRowCount ?? sentRowCount,
      saved: counts.saved,
    };
  }, [
    draft?.importedResult,
    draft?.state?.parsedData,
    draft?.state?.selectedStopIds,
    draft?.state?.source,
    mappedRows,
    parsedData,
    rejectedRows,
    savedRowCount,
    sentRowCount,
    step,
  ]);
  const refreshPlanRouteHandoffs = useCallback(async () => {
    if (assignedRoutes.length === 0) return;
    const refreshed = await Promise.all(assignedRoutes.map(async (assignedRoute) => {
      const response = await fetchPlanningRead(`/api/routes/${assignedRoute.routeId}`);
      if (!response.ok) return null;
      return {
        routeId: assignedRoute.routeId,
        route: await response.json() as Route,
      };
    }));
    const byId = new Map(
      refreshed
        .filter((item): item is { routeId: string; route: Route } => Boolean(item))
        .map((item) => [item.routeId, item.route]),
    );
    setAssignedRoutes((current) => current.map((assignedRoute) => {
      const route = byId.get(assignedRoute.routeId);
      return route
        ? {
            ...assignedRoute,
            handoffStatus: route.handoffStatus,
            handoffDriverId: route.handoffDriverId,
            handoffVersion: route.handoffVersion,
          }
        : assignedRoute;
    }));
  }, [assignedRoutes]);
  const handleStep7RouteChanged = useCallback(async (_routeId: string) => {
    try {
      await Promise.all(
        IMPORT_DATA_QUERY_KEYS
          .filter(([key]) => key === "/api/routes" || key === "routes")
          .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      if (assignedPlanId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetImportRoutePlanApprovalQueryKey(assignedPlanId),
          }),
          queryClient.invalidateQueries({
            queryKey: getGetImportRoutePlanPlanningSummaryQueryKey(assignedPlanId),
          }),
        ]);
      }
      await refreshPlanRouteHandoffs();
    } catch {
      // Dispatch result remains authoritative even if the follow-up refresh
      // is temporarily unavailable; the next status poll will recover it.
    }
  }, [assignedPlanId, queryClient, refreshPlanRouteHandoffs]);
  const planStatusRoutes = useMemo(() => {
    const summaries = authoritativePlanQuery.data?.routes;
    // Lightweight summaries are not enough to restore the review surface.
    // Until every route detail has loaded, keep status actions in recovery
    // mode instead of presenting a stale/optimistic lifecycle.
    if (assignedRoutes.length === 0 || !summaries) return assignedRoutes;
    const assignedById = new Map(assignedRoutes.map((route) => [route.routeId, route]));
    return summaries.map((summary) => ({
      ...summary,
      ...(assignedById.get(summary.routeId) ?? {}),
      id: summary.routeId,
      routeId: summary.routeId,
      planRevision: summary.planRevision,
      status: summary.status,
    }));
  }, [assignedRoutes, authoritativePlanQuery.data?.routes]);

  if (!draftId) {
    const content = (
      <Alert variant="destructive" className="m-6">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          {t("import.namedDraftRequired")}
        </AlertDescription>
      </Alert>
    );
    return embedded ? content : <AppLayout>{content}</AppLayout>;
  }

  if (isLoadingDraft) {
    const content = (
      <div className="flex h-full min-h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
    return embedded ? content : <AppLayout>{content}</AppLayout>;
  }

  if (isDraftQueryError || !draft) {
    const content = (
      <Alert variant="destructive" className="m-6">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          {error || localizeError(draftQueryError, t, { fallbackKey: "common.errorRequestFailed" })}
        </AlertDescription>
      </Alert>
    );
    return embedded ? content : <AppLayout>{content}</AppLayout>;
  }

  if (draftId && (draftHydrating || !hasLoadedDraft) && !planHydrationError) {
    const loading = <div role="status" className="p-6">Läser in sparad planering…</div>;
    return embedded ? loading : <AppLayout>{loading}</AppLayout>;
  }

  const workflow = (
      <ImportViewport embedded={embedded}
        className={cn(
          "flex overflow-hidden relative",
          "h-full min-h-0",
        )}
        onDragEnter={handlePageDragEnter}
        onDragLeave={handlePageDragLeave}
        onDragOver={handlePageDragOver}
        onDrop={handlePageDrop}
      >
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="border-2 border-dashed border-primary rounded-2xl p-16 text-center bg-primary/5">
              <Upload className="h-16 w-16 mx-auto text-primary mb-4 animate-bounce" />
              <p className="text-xl font-semibold text-primary">{t("import.dropFileHere")}</p>
              <p className="text-sm text-muted-foreground mt-2">{t("import.supportedFormats")}</p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto overscroll-contain p-3 sm:p-4 md:p-6">
          <div className="max-w-5xl mx-auto">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-xl font-bold leading-tight">{t("wizard.title")}</h1>
                {importInfo.visible.help && <p className="text-sm text-muted-foreground mt-0.5">{t("wizard.subtitle")}</p>}
              </div>
              <ImportInfoMenu />
            </div>
             {error && (
               <Alert variant="destructive" className="mb-5">
                 <AlertTriangle className="h-4 w-4" />
                 <AlertDescription>{error}</AlertDescription>
               </Alert>
             )}
              {mappingStorageWarning && (
                <Alert className="mb-5">
                  <Info className="h-4 w-4" />
                  <AlertDescription>{mappingStorageWarning}</AlertDescription>
                </Alert>
              )}
            <PlanStatusChain
              className="mb-3"
              compact
              importVariant
              stage={planPublished ? 5 : step <= 2 ? 0 : step <= 4 ? 1 : step <= 5 ? 2 : step === 6 ? 3 : 4}
              routes={planStatusRoutes.length > 0
                ? planStatusRoutes
                : undefined}
              approval={authoritativeApprovalQuery.data}
              unplannedCount={authoritativePlanQuery.data?.planningSummary?.unplanned.length ?? unplannedStopIds.length}
              planId={assignedPlanId ?? assignedRoutes[0]?.planId}
              planName={planningMetadata.customerReference ?? draft?.name}
              date={defaultDate}
              orderCount={resolveImportOrderCount({
                importedStopIds: [
                  ...(readImportEvidence(draft?.importedResult).stopIds.length > 0
                    ? readImportEvidence(draft?.importedResult).stopIds
                    : importedStopIds),
                  ...supplementalDraftStopIds(draft?.state),
                ],
                importedTotal: importCounts.saved,
                fallbackCount: savedStops.length,
              })}
              resourceCount={assignedRoutes.length}
              resourceNames={{
                vehicles: Object.fromEntries((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle.name])),
                drivers: Object.fromEntries((drivers ?? []).map((driver) => [driver.id, driver.name])),
              }}
              revision={planStatusRoutes.length
                ? Math.max(...planStatusRoutes.map((route) => route.planRevision))
                : undefined}
              stateLoading={Boolean(assignedPlanId) && (authoritativePlanQuery.isLoading || authoritativeApprovalQuery.isLoading)}
               actionPending={Boolean(planRecoveryPending)}
               stateError={planHydrationError || (
                 authoritativePlanQuery.error || authoritativeApprovalQuery.error
                   ? [404, 410].includes(
                     getErrorStatus(authoritativePlanQuery.error || authoritativeApprovalQuery.error) ?? 0,
                   )
                     ? t("import.planUnavailable")
                     : t("import.planStatusLoadFailed")
                   : null
               )}
              onRetry={() => {
                 void runPlanRecovery("retry");
              }}
              onNextAction={() => {
                 void runPlanRecovery("open");
              }}
            />
            {step >= 2 && (() => {
              const countItems = [
                  { label: t("import.countRead"), testId: "Inlästa", count: importCounts.read, key: "read" },
                  { label: t("import.countValidated"), testId: "Validerade", count: importCounts.validated, key: "validated" },
                  { label: t("import.countReady"), testId: "Klara", count: importCounts.ready, key: "ready" },
                  { label: t("import.countAction"), testId: "Åtgärd", count: importCounts.action, key: "action" },
                  { label: t("import.countRejected"), testId: "Avvisade", count: importCounts.rejected, key: "rejected" },
                  { label: t("import.countSent"), testId: "Skickade", count: importCounts.sent, key: "sent" },
                  { label: t("import.countSaved"), testId: "Sparade", count: importCounts.saved, key: "saved" },
                ];
              const visibleItems = importInfo.visible.stats
                ? countItems
                : countItems.filter((item) => isAlwaysVisibleCount(item.key, item.count));
              return (
                <div className="mb-3 space-y-1.5">
                  <button
                    type="button"
                    aria-expanded={importInfo.visible.stats}
                    onClick={() => importInfo.set("stats")}
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    data-testid="import-stats-toggle"
                  >
                    <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", importInfo.visible.stats && "rotate-90")} />
                    Importstatistik
                  </button>
                  {visibleItems.length > 0 && (
                <div className={cn("grid gap-1.5 rounded-xl border bg-card px-3 py-2 text-center", importInfo.visible.stats ? "grid-cols-3 sm:grid-cols-7" : "grid-cols-2 sm:grid-cols-4")}>
                {visibleItems.map(({ label, testId, count }) => (
                  <div
                    key={testId}
                    data-testid={`import-count-${testId.toLocaleLowerCase("sv-SE")}`}
                  >
                    <div className="text-base font-semibold leading-tight">{count}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
                  )}
                </div>
              );
            })()}

            <nav aria-label={t("wizard.title")} className="mb-4 overflow-x-auto pb-1">
              <div className="flex items-center gap-0 min-w-max">
                {stepLabels.map((label, idx) => {
                  const stepNum = (idx + 1) as WizardStep;
                  const Icon = STEP_ICONS[idx];
                  const isActive = step === stepNum;
                  const isDone = step > stepNum;
                  return (
                    <div key={idx} className="flex items-center flex-1 last:flex-none">
                      <div className="flex flex-col items-center">
                        <div
                          className={cn(
                            "w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 shrink-0",
                            isDone
                              ? "bg-primary text-primary-foreground"
                              : isActive
                                ? "bg-primary/20 text-primary ring-2 ring-primary ring-offset-1 ring-offset-background"
                                : "bg-muted text-muted-foreground"
                          )}
                        >
                          {isDone ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                        </div>
                        <span className={cn(
                          "text-[10px] mt-1 font-medium text-center leading-tight w-16",
                          !isActive && "hidden sm:block",
                          isActive ? "text-primary" : isDone ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {label}
                        </span>
                      </div>
                      {idx < 7 && (
                        <div className={cn(
                          "h-0.5 w-4 sm:w-8 md:flex-1 mx-1 sm:mt-[-14px] transition-colors",
                          isDone ? "bg-primary" : "bg-muted"
                        )} />
                      )}
                    </div>
                  );
                })}
              </div>
            </nav>

            {step === 1 && (
              <div className="space-y-4">
                {opMode === "mixed" && (
                  <div className="bg-card border border-border rounded-xl p-6 mb-4">
                    <Label className="mb-3 block text-base font-medium">{t("import.intentLabel", "Import Type")}</Label>
                    <div className="flex gap-4">
                      <Button
                        variant={importIntent === "transport" ? "default" : "outline"}
                        onClick={() => setImportIntent("transport")}
                        className="flex-1 gap-2 h-auto py-3"
                      >
                        <Truck className="h-5 w-5" />
                        <div className="text-left">
                          <div className="font-semibold">{t("import.intentTransport", "Transport / Delivery")}</div>
                        </div>
                      </Button>
                      <Button
                        variant={importIntent === "field_service" ? "default" : "outline"}
                        onClick={() => setImportIntent("field_service")}
                        className="flex-1 gap-2 h-auto py-3"
                      >
                        <Wrench className="h-5 w-5" />
                        <div className="text-left">
                          <div className="font-semibold">{t("import.intentService", "Field Service")}</div>
                        </div>
                      </Button>
                    </div>
                  </div>
                )}
                <div className="rounded-xl border border-border bg-card p-6">
                  <div
                    className={cn(
                      "border-2 border-dashed rounded-xl p-10 text-center transition-all duration-200 cursor-pointer",
                      localDrag ? "border-primary bg-primary/5 scale-[1.01]" : "border-border hover:border-primary/50"
                    )}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current++; setLocalDrag(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current--; if (localDragCounter.current === 0) setLocalDrag(false); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current = 0; setLocalDrag(false); const file = e.dataTransfer.files?.[0]; if (file) processFile(file); }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className={cn("h-12 w-12 mx-auto mb-4 transition-colors", localDrag ? "text-primary" : "text-muted-foreground")} />
                    <p className="font-medium mb-1">{t("import.dragOrClick")}</p>
                    <p className="text-xs text-muted-foreground mb-4">{t("import.supportedFormats")}</p>
                    <input
                      ref={fileInputRef}
                      data-testid="import-file-input"
                      type="file"
                      accept=".csv,.xlsx,.xls,.xlsb"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <span
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      {t("import.selectFile")}
                    </span>
                    {fileName && <p className="mt-3 text-sm text-muted-foreground">{fileName}</p>}
                  </div>
                  {error && (
                    <div role="alert" className="mt-4 p-3 rounded-lg border border-destructive-text/40 bg-destructive/10 text-destructive-text text-sm flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      {error}
                    </div>
                  )}
                </div>
                <div className="p-4 rounded-xl border border-border bg-card">
                  <h3 className="font-semibold text-sm mb-2">{t("importPage.excelTemplate")}</h3>
                  <p className="text-xs text-muted-foreground mb-3">{t("importPage.excelTemplateDesc")}</p>
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => downloadTemplate(availableSystemFields)}>
                    <FileDown className="h-4 w-4" />
                    {t("importPage.downloadTemplate")}
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && parsedData && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}><div className="rounded-xl border border-border bg-card p-6 space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="font-medium text-sm">{t("import.matchColumns")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("import.mappingHelp")}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="min-w-24 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/40">
                      <p className="font-bold text-emerald-700 dark:text-emerald-300">{mappingSummary.matched} / {mappingFields.length}</p>
                      <p className="text-emerald-700/75 dark:text-emerald-300/75">{t("import.mappingMatched")}</p>
                    </div>
                    <div className={cn(
                      "min-w-24 rounded-lg border px-3 py-2",
                      mappingSummary.requiredMissing > 0
                        ? "border-destructive/30 bg-destructive/10"
                        : "border-border bg-muted/30",
                    )}>
                      <p className={cn("font-bold", mappingSummary.requiredMissing > 0 ? "text-destructive" : "text-foreground")}>
                        {mappingSummary.requiredMissing}
                      </p>
                      <p className="text-muted-foreground">{t("import.mappingRequired")}</p>
                    </div>
                    <div className="min-w-24 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <p className="font-bold text-foreground">{mappingSummary.optionalMissing}</p>
                      <p className="text-muted-foreground">{t("import.mappingSkipped")}</p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2" data-testid="mapping-bulk-actions">
                  <Button type="button" variant="outline" size="sm"
                    disabled={activeMappingSelection.length === 0}
                    onClick={() => clearMappings(activeMappingSelection)}>
                    {t("import.mappingClearSelected", { count: activeMappingSelection.length })}
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    disabled={clearableMappingKeys.length === 0}
                    onClick={() => clearMappings(clearableMappingKeys)}>
                    {t("import.mappingClearOptional")}
                  </Button>
                  <Button type="button" variant="outline" size="sm"
                    disabled={restorableMappingKeys.length === 0}
                    onClick={() => restoreMappings(restorableMappingKeys)}>
                    {t("import.mappingRestore")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("import.mappingClearHelp")}</p>
                </div>
                 <div className="rounded-lg border border-border overflow-hidden">
                   <DualHorizontalScroll label={t("common.horizontalScroll")} contentProps={{ className: "md:max-h-[60dvh] md:overflow-y-auto md:overscroll-contain" }}>
                     <table className="w-full text-sm">
                    <thead className="bg-muted md:sticky md:top-0 md:z-10">
                      <tr>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[5%]">
                          <Checkbox
                            aria-label={t("import.mappingSelectAll")}
                            disabled={clearableMappingKeys.length === 0}
                            checked={allOptionalMappingsSelected ? true : activeMappingSelection.length > 0 ? "indeterminate" : false}
                            onCheckedChange={(checked) => setSelectedMappingKeys(checked === true ? clearableMappingKeys : [])}
                          />
                        </th>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[35%]">{t("import.systemField")}</th>
                        <th className="p-2.5 text-center w-[5%]"><ArrowRight className="h-4 w-4 mx-auto text-muted-foreground" /></th>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[55%]">{t("import.fileColumn")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {mappingFields.map((field, idx) => {
                        const isCustom = field.key.startsWith("custom_");
                        const mapped = mapping[field.key];
                        const mappedColumn = typeof mapped === "string" ? mapped : undefined;
                        const colIdx = typeof mapped === "string" ? parsedData.headers.indexOf(mapped) : -1;
                        const sampleValue = colIdx >= 0 && parsedData.rows[0] ? parsedData.rows[0].values[colIdx] : null;
                        const deliveryParts = field.key === "address" ? getDeliveryAddressMapping(mapping) : [];
                        const isSatisfied = field.key === "address"
                          ? deliveryParts.some((part) => part.component === "address")
                          : Boolean(mapped) || (field.key === "date" && !!defaultDate);
                        return (
                          <tr key={field.key} className={cn(
                            "transition-colors",
                            isSatisfied
                              ? "bg-emerald-50/70 dark:bg-emerald-950/20"
                              : field.required
                                ? "bg-destructive/5"
                                : "bg-background text-muted-foreground",
                          )}>
                            <td className={cn(
                              "border-l-4 p-2.5 font-bold text-xs",
                              isSatisfied
                                ? "border-l-emerald-500 text-emerald-800 dark:text-emerald-300"
                                : field.required
                                  ? "border-l-destructive text-destructive"
                                  : "border-l-transparent",
                            )}>
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  aria-label={t(restorableMappingKeys.includes(field.key) ? "import.mappingRestoreField" : "import.mappingSelectField", { field: isCustom ? field.labelKey : t(field.labelKey) })}
                                  disabled={!clearableMappingKeys.includes(field.key) && !restorableMappingKeys.includes(field.key)}
                                  checked={activeMappingSelection.includes(field.key)}
                                  onCheckedChange={(checked) => {
                                    if (checked === true && restorableMappingKeys.includes(field.key)) restoreMappings([field.key]);
                                    setSelectedMappingKeys((previous) =>
                                    checked === true
                                      ? [...previous.filter((key) => key !== field.key), field.key]
                                      : previous.filter((key) => key !== field.key));
                                  }}
                                />
                                <span>{idx + 1}</span>
                              </div>
                            </td>
                            <td className="p-2.5">
                              <div className="flex items-center gap-2">
                                <span className={cn("w-2 h-2 rounded-full shrink-0", isSatisfied ? "bg-emerald-500" : field.required ? "bg-destructive" : isCustom ? "bg-blue-400" : "bg-muted-foreground/50")} />
                                <span className={cn("font-medium text-xs", isSatisfied && "text-foreground")}>{isCustom ? field.labelKey : t(field.labelKey)}</span>
                                {field.required && <span className="text-[9px] font-semibold uppercase tracking-wider text-destructive/70">{t("import.requiredTag")}</span>}
                                {isCustom && (
                                  <button
                                    type="button"
                                    onClick={() => removeCustomField(field.key)}
                                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
                                    title={t("common.delete")}
                                    aria-label={t("common.delete")}
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {isSatisfied ? (
                                  <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                                    <Check className="h-3 w-3" />
                                    {t("import.mappingMatchedStatus")}
                                  </span>
                                ) : field.required ? (
                                  <span className="ml-auto rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                                    {t("import.mappingChooseColumn")}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="p-2.5 text-center">
                              <div className={cn(
                                "mx-auto flex h-7 w-7 items-center justify-center rounded-full border",
                                isSatisfied
                                  ? "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                  : "border-border bg-muted/30 text-muted-foreground/30",
                              )}>
                                <ArrowRight className="h-3.5 w-3.5" />
                              </div>
                            </td>
                            <td className="p-2.5">
                              {(() => {
                                 if (field.key === "address") {
                                   const mappedComponents = new Set(deliveryParts.map((part) => part.component));
                                   const componentLabels: Record<DeliveryAddressComponent, string> = {
                                     address: t("import.field.address"),
                                     postalCode: t("importPage.field.postalCode"),
                                     city: t("importPage.field.postalCity", "Postort"),
                                   };
                                   const availableComponents = (["address", "postalCode", "city"] as const)
                                     .filter((component) => !mappedComponents.has(component));
                                   const sampleForColumn = (column: string) => {
                                     const index = parsedData.headers.indexOf(column);
                                     return index >= 0 && parsedData.rows[0]
                                       ? parsedData.rows[0].values[index]?.trim()
                                       : "";
                                   };
                                   const preview = deliveryAddressPreview(
                                     mapping,
                                     parsedData.headers,
                                     parsedData.rows[0]?.values,
                                   );
                                   return (
                                     <div className="space-y-2">
                                       <div className="flex flex-wrap items-center gap-1.5">
                                         {deliveryParts.map((part) => (
                                           <span
                                             key={`${part.component}-${part.column}`}
                                             data-testid={`delivery-address-chip-${part.component}`}
                                             className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-1 text-xs"
                                           >
                                             <span className="font-medium">{componentLabels[part.component]}</span>
                                             <span className="text-muted-foreground">{part.column}</span>
                                             <button
                                               type="button"
                                               data-testid={`remove-delivery-address-chip-${part.component}`}
                                               onClick={() => updateDeliveryAddressComponent(part.component, null)}
                                               className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                               aria-label={`${t("common.delete")} ${componentLabels[part.component]}`}
                                             >
                                               <XCircle className="h-3.5 w-3.5" />
                                             </button>
                                           </span>
                                         ))}
                                         {availableComponents.length > 0 && (
                                           <Select
                                             value="__none__"
                                             onValueChange={(value) => {
                                               if (value === "__none__") return;
                                               const [component, column] = JSON.parse(value) as [DeliveryAddressComponent, string];
                                               updateDeliveryAddressComponent(component, column);
                                             }}
                                           >
                                             <SelectTrigger
                                               data-testid="select-delivery-address-component"
                                               className="h-8 w-auto min-w-32 text-xs"
                                             >
                                               <SelectValue placeholder={t("import.selectColumn")} />
                                             </SelectTrigger>
                                             <SelectContent>
                                               <SelectItem value="__none__">
                                                 <span className="text-muted-foreground">+ {t("import.selectColumn")}</span>
                                               </SelectItem>
                                               {availableComponents.flatMap((component) =>
                                                 parsedData.headers.filter((header) => header.trim()).map((header) => (
                                                   <SelectItem
                                                     key={`${component}-${header}`}
                                                     value={JSON.stringify([component, header])}
                                                   >
                                                     <span className="font-medium">{componentLabels[component]}</span>
                                                     <span className="text-muted-foreground ml-1.5">{header}</span>
                                                     {sampleForColumn(header) && (
                                                       <span className="text-muted-foreground ml-1 text-[10px]">
                                                         ({sampleForColumn(header)})
                                                       </span>
                                                     )}
                                                   </SelectItem>
                                                 )),
                                               )}
                                             </SelectContent>
                                           </Select>
                                         )}
                                       </div>
                                       {preview && (
                                         <p
                                           data-testid="delivery-address-preview"
                                           className="truncate text-[11px] text-muted-foreground"
                                         >
                                           {t("import.example")}: {preview}
                                         </p>
                                       )}
                                     </div>
                                   );
                                 }
                                const keywords = FIELD_KEYWORDS[field.key] || [];
                                const headers = parsedData.headers.filter(h => h.trim());
                                const scored = headers.map(h => {
                                  const norm = h.toLowerCase().replace(/[\s\-\.]+/g, "_");
                                  const exactAlias = ALIAS_MAP[norm] === field.key;
                                  const keywordHits = keywords.filter(kw => norm.includes(kw)).length;
                                  return { header: h, score: exactAlias ? 100 : keywordHits };
                                });
                                const suggested = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
                                const rest = scored.filter(s => s.score === 0);
                                const sampleForHeader = (h: string) => {
                                  const ci = parsedData.headers.indexOf(h);
                                  return ci >= 0 && parsedData.rows[0] ? parsedData.rows[0].values[ci]?.trim() : "";
                                };
                                const isDateWithNoColumn = field.key === "date" && suggested.length === 0;
                                if (isDateWithNoColumn) {
                                  return (
                                    <div>
                                      <input
                                        type="date"
                                        value={defaultDate}
                                        disabled={!!draft?.planId}
                                        onChange={(e) => setDefaultDate(e.target.value)}
                                        className="h-8 w-full px-3 text-xs rounded-md border border-border bg-background text-foreground disabled:opacity-50"
                                      />
                                      <p className="text-[10px] text-muted-foreground mt-1">{t("import.dateAppliedToAll")}</p>
                                    </div>
                                  );
                                }
                                return (
                                  <>
                                     <Select value={mappedColumn || "__none__"} onValueChange={(val) => updateMapping(field.key, val)}>
                                      <SelectTrigger className={cn(
                                        "h-9 text-xs",
                                         mappedColumn
                                          ? "border-emerald-400 bg-background ring-1 ring-emerald-200 dark:ring-emerald-900"
                                          : field.required
                                            ? "border-destructive/60 bg-destructive/5"
                                            : "bg-muted/20",
                                      )}>
                                        <SelectValue placeholder={t("import.selectColumn")} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__"><span className="text-muted-foreground">— {t("import.skip")} —</span></SelectItem>
                                        {suggested.length > 0 && (
                                          <>
                                            <div className="px-2 py-1 text-[10px] font-semibold text-primary uppercase tracking-wider">{t("import.suggested")}</div>
                                            {suggested.map(({ header }) => {
                                              const sample = sampleForHeader(header);
                                              return (
                                                <SelectItem key={header} value={header}>
                                                  <span className="font-medium">{header}</span>
                                                  {sample && <span className="text-muted-foreground ml-1.5 text-[10px]">({sample})</span>}
                                                </SelectItem>
                                              );
                                            })}
                                            {rest.length > 0 && <div className="h-px bg-border my-1" />}
                                          </>
                                        )}
                                        {rest.map(({ header }) => (
                                          <SelectItem key={header} value={header}>{header}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {sampleValue && <p className="text-[10px] text-muted-foreground mt-1 truncate">{t("import.example")}: {sampleValue}</p>}
                                  </>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                     </table>
                   </DualHorizontalScroll>
                </div>

                {showAddField ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg border border-blue-400/30 bg-blue-400/5">
                    <input
                      type="text"
                      value={newFieldName}
                      onChange={(e) => setNewFieldName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addCustomField(newFieldName); if (e.key === "Escape") { setShowAddField(false); setNewFieldName(""); } }}
                      placeholder={t("import.customFieldName")}
                      className="flex-1 h-8 px-3 text-sm rounded-md border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus
                    />
                    <Button size="sm" variant="default" onClick={() => addCustomField(newFieldName)} disabled={!newFieldName.trim()} className="h-8 px-3 text-xs">
                      {t("import.addField")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setShowAddField(false); setNewFieldName(""); }} className="h-8 px-3 text-xs">
                      {t("common.cancel")}
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowAddField(true)}
                    className="w-full py-2 text-xs text-primary hover:text-primary/80 font-medium border border-dashed border-primary/30 rounded-lg hover:bg-primary/5 transition-colors flex items-center justify-center gap-1.5"
                  >
                    + {t("import.addCustomField")}
                  </button>
                )}

                <div className="sticky bottom-0 z-20 -mx-1 border-t bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex justify-between" data-testid="import-mapping-actions">
                  <Button variant="outline" size="sm" onClick={fullReset} className="gap-1">
                    <ChevronLeft className="h-4 w-4" /> {t("common.back")}
                  </Button>
                  <Button size="sm" onClick={handleApplyMapping} disabled={!requiredMapped} className="gap-1">
                    {t("wizard.next")} <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              </div>
            )}

            {step === 3 && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}><Step3Review
                rows={mappedRows}
                onUpdateRow={handleUpdateRow}
                onDeleteRow={handleDeleteRow}
                onNext={() => saveToDraftRef.current?.(4)}
                data-testid="planning-draft-next"
                onBack={() => saveToDraftRef.current?.(2)}
                rejectedRows={rejectedRows}
              />
              </div>
            )}

            {step === 4 && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}><Step4Addresses
                organizationId={organizationId!}
                rows={mappedRows}
                onRowsChange={(newRows) => {
                  setMappedRows(newRows);
                   void saveToDraftRef.current?.(
                     4,
                     { mappedRows: newRows },
                     { debounce: true },
                   );
                }}
                isSaving={importMutation.isPending}
                onNext={handleSaveStopsAndContinue}
                onBack={() => saveToDraftRef.current?.(3)}
                rejectedRows={rejectedRows}
              />
              </div>
            )}

            {step === 5 && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}>
                {(isVehiclesError || isDriversError) ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      {localizeError(
                        vehiclesError || driversError,
                        t,
                        { fallbackKey: "import.resourcesLoadFailed" },
                      )}
                    </AlertDescription>
                  </Alert>
                ) : assignedPlanId ? (
                  <div className="space-y-4">
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertDescription>
                        {t("import.replanResourcesDescription")}
                      </AlertDescription>
                    </Alert>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        onClick={() => void returnToExistingPlanReview()}
                         disabled={Boolean(planRecoveryPending)}
                        className="gap-1"
                      >
                         {planRecoveryPending === "review" && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t("import.reviewAndAdjustRoutes")}
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2" data-testid="import-stop-register-bar">
                    <p className="text-xs text-muted-foreground">
                      {canUseStopRegister
                        ? t("stopRegister.importHint")
                        : t("stopRegister.importUnavailable")}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      disabled={!canUseStopRegister}
                      onClick={() => {
                        if (draft) {
                          stopRegisterTargetRef.current = {
                            draftId: draft.id,
                            date: draft.startAt ? localCalendarDate(draft.startAt) : defaultDate,
                          };
                        }
                        setStopRegisterOpen(true);
                      }}
                      data-testid="button-import-stop-register"
                    >
                      <Users className="h-3.5 w-3.5" />
                      {t("stopRegister.title")}
                    </Button>
                  </div>
                  <StopRegisterDialog
                    open={stopRegisterOpen}
                    onOpenChange={(open) => {
                      if (open && draft) {
                        stopRegisterTargetRef.current = {
                          draftId: draft.id,
                          date: draft.startAt ? localCalendarDate(draft.startAt) : defaultDate,
                        };
                      }
                      setStopRegisterOpen(open);
                      if (!open) releaseStopRegisterSaves();
                    }}
                    target={draft ? { kind: "draft", draftId: draft.id, name: planningMetadata.customerReference || draft.name, date: draft.startAt ? localCalendarDate(draft.startAt) : defaultDate } : null}
                    prepare={prepareStopRegister}
                    onSuccess={async (result) => {
                      await hydrateStopRegisterResult(result);
                      toast({ title: t("stopRegister.added", { count: result.count }) });
                    }}
                  />
                  <Step6Vehicles
                draftId={draft?.id}
                 organizationId={organizationId}
                 userId={user?.id}
                stopIds={importedStopIds.length > 0 ? importedStopIds : draft?.state?.selectedStopIds || []}
                stops={savedStops}
                vehicles={vehicles || []}
                drivers={drivers || []}
                 // The optimizer validates this exact instant against the
                 // draft. Never reconstruct it from a calendar date or a
                 // fixed 08:00 fallback.
                 date={draft?.startAt ?? new Date(`${defaultDate}T00:00:00`).toISOString()}
                depotLatitude={DEFAULT_DEPOT_LATITUDE}
                depotLongitude={DEFAULT_DEPOT_LONGITUDE}
                 selectedPairValues={resourceSelection.pairValues}
                 onChangeSelectedPairValues={(pairValues) => {
                   const nextResourceSelection = {
                     ...resourceSelection,
                     pairValues,
                   };
                   setResourceSelection(nextResourceSelection);
                   void saveToDraftRef.current?.(
                     5,
                     { resourceSelection: nextResourceSelection },
                     { debounce: true },
                   );
                 }}
                planningInputs={planningInputs}
                planningMetadata={planningMetadata}
                onBeforePlan={async () => {
                  const save = saveToDraftRef.current;
                  if (!save) {
                    throw new TrustedLocalizedError(t("import.draftNotReady"));
                  }
                  await save(5, {}, { throwOnError: true });
                }}
                onChangePlanningInputs={(inputs) => {
                  setPlanningInputs(inputs);
                  void saveToDraftRef.current?.(5, { planningInputs: inputs }, { debounce: true });
                }}
                onChangePlanningMetadata={(meta) => {
                  setPlanningMetadata(meta);
                  void saveToDraftRef.current?.(5, { planningMetadata: meta }, { debounce: true });
                }}
                 onNext={async (res) => {
                  setAssignedPlanId(res.planId);
                  if (organizationId) {
                    sessionStorage.setItem(
                      routePlanSelectionStorageKey(organizationId),
                      res.planId,
                    );
                  }
                   const nextRoutes = res.routes || [];
                   const nextUnplannedStopIds = res.unassignedStopIds || [];
                   const nextDiagnostics = res.diagnostics || [];
                   setAssignedRoutes(nextRoutes);
                   setUnplannedStopIds(nextUnplannedStopIds);
                   setUnplannedDiagnostics(nextDiagnostics);
                  // Planning persists both new routes and stop assignments. Refresh
                  // the dispatch data immediately, not only after the wizard closes,
                  // so closing the modal cannot reveal stale unplanned stops.
                  void Promise.all(
                    IMPORT_DATA_QUERY_KEYS.map((queryKey) =>
                      queryClient.invalidateQueries({ queryKey }),
                    ),
                  );
                   const save = saveToDraftRef.current;
                   if (!save) {
                     setError(t("import.draftNotReady"));
                     return;
                   }
                   await save(6, {
                     assignedRoutes: nextRoutes,
                     assignedPlanId: res.planId,
                     unplannedStopIds: nextUnplannedStopIds,
                     unplannedDiagnostics: nextDiagnostics,
                   });
                }}
                onBack={() => void saveToDraftRef.current?.(4)}
               />
                  </>
                )}
              </div>
            )}

            {step === 6 && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}>
                {(isVehiclesError || isDriversError) ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      {localizeError(
                        vehiclesError || driversError,
                        t,
                        { fallbackKey: "import.resourcesLoadFailed" },
                      )}
                    </AlertDescription>
                  </Alert>
                ) : (isVehiclesLoading || isDriversLoading) ? (
                  <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("import.loadingRoutesAndStops")}
                  </div>
                ) : (
                 <div className="space-y-3">
                 {!step7Depot && (
                   <Alert variant="destructive" data-testid="plan-review-depot-unavailable">
                     <AlertTriangle className="h-4 w-4" />
                     <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                       <span>{t("dispatch.adjustPlanRecoveryError")}</span>
                       <Button
                         type="button"
                         variant="outline"
                         size="sm"
                         onClick={() => navigate("/vehicles")}
                       >
                         {t("dispatch.fixResource")}
                       </Button>
                     </AlertDescription>
                   </Alert>
                 )}
                 <Step7Adjust
                   focusOptimization={optimizationRequested}
                draftId={draft?.id}
                planId={assignedPlanId ?? undefined}
                draftRevision={draft?.revision}
                routes={assignedRoutes}
                unplannedStops={Array.from(
                  new Map(
                    [...(allStops || []), ...savedStops].map((stop) => [stop.id, stop]),
                  ).values(),
                ).filter((stop) => unplannedStopIds.includes(stop.id))}
                availableStops={allStops || []}
                unplannedStopIds={unplannedStopIds}
                unplannedDiagnostics={unplannedDiagnostics}
                vehicles={vehicles || []}
                drivers={drivers || []}
                 depotLatitude={step7Depot?.depotLatitude}
                 depotLongitude={step7Depot?.depotLongitude}
                 readOnly={!step7Depot || assignedRoutes.some((route) =>
                   (route as ImportAssignedRoute & { status?: string }).status !== "optimized")}
                allowResourceSelection={Boolean(assignedPlanId)}
                planningInputs={planningInputs}
                planningMetadata={planningMetadata}
                onChangePlanningInputs={setPlanningInputs}
                onChangePlanningMetadata={(meta) => {
                  setPlanningMetadata(meta);
                }}
                onSaveCustomerReference={async (meta) => {
                  if (!draft) throw new TrustedLocalizedError(t("import.draftNotReady"));
                  const state = projectImportDraftState({
                    ...draft.state,
                    planningMetadata: {
                      ...draft.state.planningMetadata,
                      customerReference: meta.customerReference,
                    },
                  }, {
                    hasAuthoritativeImportedResult: draft.importedResult != null || savedRowCount > 0,
                    serverPlanId: draft.planId ?? assignedPlanId,
                  });
                  const savedDraft = await draftAutosave.schedule(
                    { state },
                    { immediate: true },
                  );
                  await draftAutosave.flush();
                  if (!savedDraft) throw new TrustedLocalizedError(t("import.draftNotReady"));
                  draftStateRef.current.state = {
                    ...savedDraft.state,
                    planningInputs,
                    planningMetadata: meta,
                  };
                  setPlanningMetadata(meta);
                }}
                onPlanningReoptimized={handlePlanningReoptimized}
                onValidated={async (routes) => {
                  const planId = routes[0]?.planId;
                  if (!planId || routes.some((route) => route.planId !== planId)) {
                    throw new TrustedLocalizedError(t("import.planIdMissing"));
                  }
                  setAssignedRoutes(routes);
                  // The adjustment has changed the persisted route revision.
                  // Refresh both sides of the approval comparison before the
                  // traffic view can render a cached, mismatched pair.
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
                    queryClient.invalidateQueries({
                      queryKey: getGetImportRoutePlanApprovalQueryKey(planId),
                    }),
                  ]);
                   // The adjustment endpoint has already persisted the
                   // authoritative route result. Do not issue a second draft
                   // PUT here: assignedRoutes is a server projection, while
                   // planning inputs after plan lock require protected
                   // reoptimization, and metadata uses its allowed save path.
                   // A draft conflict must not turn a successful route
                   // mutation into a misleading save error.
                  if (onComplete) {
                    onComplete({ planId, planningDate: defaultDate, validated: true });
                    return;
                  }
                  const params = new URLSearchParams({ view: "traffic", planId, validated: "1" });
                  navigate(`/dispatch?${params.toString()}`);
                }}
                onNext={(routes) => {
                  setAssignedRoutes(routes);
                  return saveToDraftRef.current?.(7, {
                    assignedRoutes: routes,
                    planningInputs,
                    planningMetadata,
                  });
                }}
                onBack={() => void saveToDraftRef.current?.(5)}
                />
                </div>
                )}
              </div>
            )}

            {step === 7 && (
              <div data-testid="planning-draft-flow" data-draft-id={draft?.id}><Step7Dispatch
                routes={assignedRoutes}
                unplannedCount={unplannedStopIds.length}
                planningMetadata={planningMetadata}
                onAllPublished={() => {
                  setPlanPublished(true);
                  void handleStep7RouteChanged("");
                }}
                onRouteChanged={handleStep7RouteChanged}
                onFinish={async () => {
                  await Promise.all(
                    IMPORT_DATA_QUERY_KEYS.map((queryKey) =>
                      queryClient.invalidateQueries({ queryKey }),
                    ),
                  );
                  if (onComplete) {
                    if (!assignedPlanId) {
                      throw new TrustedLocalizedError(t("import.planIdMissing"));
                    }
                    onComplete({ planId: assignedPlanId, planningDate: defaultDate, previewMap: true });
                    return;
                  }
                  const params = new URLSearchParams({ view: "traffic" });
                  if (assignedPlanId) params.set("planId", assignedPlanId);
                  window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/dispatch?${params.toString()}`;
                }}
              />
              </div>
            )}
          </div>
        </div>
      </ImportViewport>
  );

  return embedded ? workflow : <AppLayout>{workflow}</AppLayout>;
}

export default function Import({ draftId }: { draftId?: string }) {
  return <ImportWorkflow draftId={draftId} />;
}

/**
 * The legacy /import URL remains supported, but it must enter the named-draft
 * surface. That surface owns naming, date/time selection, and resume choices.
 */
export function ImportEntry() {
  const [, navigate] = useLocation();

  useEffect(() => {
    navigate("/routes/create", { replace: true });
  }, [navigate]);

  return (
    <AppLayout>
      <div className="flex h-full min-h-0 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    </AppLayout>
  );
}
