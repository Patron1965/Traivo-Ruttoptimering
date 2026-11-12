import React, { useState, useRef, useEffect } from "react";
import { prepareBrowserPhoto } from "@/lib/photo-input";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Image,
  ActivityIndicator,
  Platform,
  Alert,
  Modal,
  PanResponder,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, router } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { api, isStalePlanError, type Stop } from "@/lib/api";
import { enqueueException, enqueueProof, getProofQueue, markQueueItemStatus } from "@/lib/offline-queue";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import { signaturePngDataUrl } from "@/lib/signature-image";
import { useSelectedRoute } from "@/context/SelectedRouteContext";
import { enqueueStopReport, readReportDraft, writeReportDraft, clearReportDraft, getCachedData, acquireOfflineSyncLease, getStopReportQueue, getOfflineQueueScope } from "@/lib/offline-queue";
import { sendStopReport, isSkipReason, SKIP_REASONS, type StopReport, type SkipReason } from "@/lib/stop-report";
import { loadReportCategories, restoreCustomCategory, customCategoryLine, skipReasonLine, type ReportCategory, type CustomCategoryChoice } from "@/lib/report-categories";
import { stopReportPort } from "@/lib/report-port";
import { isRetryableWorkFailure } from "@/lib/work-execution";
import { evaluateProximity, type ProximityResult } from "@/lib/proximity";
import { REPORT_FAILURE_REASONS, restoreReportFailureReason, needsReportFailureReason, type ReportFailureReason } from "@/lib/report-failure-reason";

type ProofType = "photo" | "signature" | "barcode";

interface Proof {
  type: ProofType;
  data: string;
  notes?: string;
}

function SignaturePad({ onSave, onCancel }: { onSave: (data: string) => void; onCancel: () => void }) {
  const c = Colors.light;
  const { t } = useT();
  const pathsRef = useRef<{ x: number; y: number }[][]>([]);
  const currentPathRef = useRef<{ x: number; y: number }[]>([]);
  const [pathCount, setPathCount] = useState(0);
  const canvasSize = useRef({ width: 300, height: 200 });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        currentPathRef.current = [{ x: locationX, y: locationY }];
      },
      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        currentPathRef.current.push({ x: locationX, y: locationY });
        setPathCount((c) => c + 1);
      },
      onPanResponderRelease: () => {
        if (currentPathRef.current.length > 1) {
          pathsRef.current.push([...currentPathRef.current]);
        }
        currentPathRef.current = [];
        setPathCount((c) => c + 1);
      },
    })
  ).current;

  const allPaths = [...pathsRef.current];
  if (currentPathRef.current.length > 1) {
    allPaths.push(currentPathRef.current);
  }

  const handleClear = () => {
    pathsRef.current = [];
    currentPathRef.current = [];
    setPathCount(0);
  };

  const handleSave = () => {
    if (pathsRef.current.length === 0) return;
    onSave(signaturePngDataUrl(pathsRef.current, canvasSize.current.width, canvasSize.current.height));
  };

  return (
    <View style={signStyles.container}>
      <View
        style={[signStyles.canvas, { borderColor: c.border }]}
        onLayout={({ nativeEvent }) => { canvasSize.current = nativeEvent.layout; }}
        {...panResponder.panHandlers}
      >
        {allPaths.length === 0 && (
          <Text style={[signStyles.placeholder, { color: c.textTertiary }]}>
            {t("proof.signHere")}
          </Text>
        )}
        {allPaths.map((pts, i) =>
          pts.length > 1 ? (
            <View
              key={`${i}-${pathCount}`}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              {pts.slice(1).map((pt, j) => {
                const prev = pts[j];
                const dx = pt.x - prev.x;
                const dy = pt.y - prev.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                return (
                  <View
                    key={j}
                    style={{
                      position: "absolute",
                      left: prev.x,
                      top: prev.y - 1,
                      width: len,
                      height: 2,
                      backgroundColor: "#000",
                      transform: [{ rotate: `${angle}deg` }],
                      transformOrigin: "left center",
                    }}
                  />
                );
              })}
            </View>
          ) : null
        )}
      </View>
      <View style={signStyles.actions}>
        <Pressable
          onPress={handleClear}
          style={({ pressed }) => [
            signStyles.btn,
            { borderColor: c.border, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Feather name="trash-2" size={16} color={c.textSecondary} />
          <Text style={[signStyles.btnText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {t("proof.clear")}
          </Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [
            signStyles.btn,
            { borderColor: c.border, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Text style={[signStyles.btnText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {t("proof.cancel")}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          disabled={pathsRef.current.length === 0}
          style={({ pressed }) => [
            signStyles.btn,
            signStyles.btnPrimary,
            {
              backgroundColor: pathsRef.current.length === 0 ? c.textTertiary : c.primary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Feather name="check" size={16} color="#FFF" />
          <Text style={[signStyles.btnText, { color: "#FFF", fontFamily: "Inter_600SemiBold" }]}>
            {t("proof.accept")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const signStyles = StyleSheet.create({
  container: { gap: 12, width: "100%", maxWidth: 900, alignSelf: "center" },
  canvas: {
    width: "100%",
    height: 320,
    borderWidth: 2,
    borderRadius: 12,
    borderStyle: "dashed",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    backgroundColor: "#FAFAFA",
  },
  placeholder: { fontSize: 16, position: "absolute" },
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  btnPrimary: { borderWidth: 0 },
  btnText: { fontSize: 14 },
});

export default function ProofScreen() {
  const returnToRoute = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };
  const { stopId, routeId, step, planVersion, outcome, quick } = useLocalSearchParams<{ stopId: string; routeId?: string; step?: string; planVersion?: string; outcome?: string; quick?: string }>();
  const proofStage: "pickup" | "delivery" = step === "pickup" ? "pickup" : "delivery";
  const c = Colors.light;
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [barcodeValue, setBarcodeValue] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [proofDelivery, setProofDelivery] = useState<"synced" | "queued" | "partial">("queued");
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerLocked, setScannerLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [exceptionVisible, setExceptionVisible] = useState(false);
  const [exceptionCategory, setExceptionCategory] = useState("customer_unavailable");
  const [reportFailureReason, setReportFailureReason] = useState<ReportFailureReason | "">("");
  const [exceptionComment, setExceptionComment] = useState("");
  const [exceptionPhoto, setExceptionPhoto] = useState<string | undefined>();
  const [exceptionSubmitting, setExceptionSubmitting] = useState(false);
  const { isOnline } = useNetworkStatus();
  const { isAssisting } = useDriverAssistance();
  const { activeRoute, routeScopeKey } = useSelectedRoute();
  const queryClient = useQueryClient();
  const isReporting = outcome === "completed" || outcome === "failed" || outcome === "skipped";
  const initialOutcome: "completed" | "failed" | "skipped" = outcome === "failed" ? "failed" : outcome === "skipped" ? "skipped" : "completed";
  const [reportOutcome, setReportOutcome] = useState<"completed" | "failed" | "skipped">(initialOutcome);
  const [skipReason, setSkipReason] = useState<SkipReason | "">("");
  const [customCategory, setCustomCategory] = useState<CustomCategoryChoice | null>(null);
  const [exceptionCustom, setExceptionCustom] = useState<CustomCategoryChoice | null>(null);
  const [categories, setCategories] = useState<ReportCategory[]>([]);
  const skipLabel = (reason: SkipReason) => t(({ CUSTOMER_UNAVAILABLE: "stop.skipCustomer", ACCESS_BLOCKED: "stop.skipAccess", ADDRESS_NOT_FOUND: "stop.skipAddress", VEHICLE_OR_SAFETY: "stop.skipVehicle", OTHER: "stop.skipOther" } as const)[reason]);
  const [stop, setStop] = useState<Stop | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<"local" | "synced" | null>(null);
  const [proximity, setProximity] = useState<ProximityResult | null>(null);
  const [positionCheckedAt, setPositionCheckedAt] = useState(0);
  const [overrideReason, setOverrideReason] = useState("");
  const draftIdentity = `${routeId}:${stopId}:${planVersion}:${proofStage}`;
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const reportRef = useRef<StopReport | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!submitted || !isReporting || isAssisting || reportStatus === "synced") return;
    const reportId = reportRef.current?.id;
    const owner = JSON.stringify(getOfflineQueueScope());
    let active = true;
    const refresh = async () => {
      try {
        const queue = await getStopReportQueue();
        if (!active || owner !== JSON.stringify(getOfflineQueueScope())) return;
        const report = queue.find(item => item.id === reportId && item.routeId === routeId && item.stopId === stopId);
        // Absence is not delivery evidence: only an acknowledged queue entry is.
        if (report?.syncStatus === "synced") {
          setReportStatus("synced");
          setSaveError(null);
        } else if (report?.syncStatus === "conflict") {
          setSaveError(lang === "sv" ? "Rapporten finns kvar på enheten men kunde inte synkas. Gå tillbaka till rutten och granska synkningskonflikten." : "The report remains on this device but could not sync. Return to the route and review the sync conflict.");
        }
      } catch {
        if (active) setSaveError(lang === "sv" ? "Synkningsstatus kunde inte läsas. Rapporten är inte bekräftad av trafikledningen ännu." : "Sync status could not be read. Dispatch has not confirmed the report yet.");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, [submitted, isReporting, isAssisting, reportStatus, routeId, stopId, routeScopeKey, lang]);

  useEffect(() => {
    let active = true;
    void loadReportCategories(isOnline).then((list) => { if (active) setCategories(list); });
    return () => { active = false; };
  }, [routeScopeKey, isOnline]);

  useEffect(() => {
    let mounted = true;
    setDraftReady(false);
    setDraftError(null); setStop(null); setProofs([]); setNotes("");
    setReportFailureReason(""); setSkipReason(""); setCustomCategory(null);
    setReportOutcome(initialOutcome);
    setProximity(null); setOverrideReason(""); setSubmitted(false);
    reportRef.current = null;
    void (async () => {
      const restored = await readReportDraft<{
        proofs: Proof[]; notes: string; reportOutcome: "completed" | "failed" | "skipped"; skipReason?: string; customCategory?: unknown;
        exceptionCategory: string; reportFailureReason?: string; overrideReason: string; report?: StopReport;
      }>(draftIdentity);
      if (!mounted) return;
      if (restored) {
        setProofs(restored.proofs); setNotes(restored.notes);
        setReportOutcome(restored.reportOutcome); setExceptionCategory(restored.exceptionCategory);
        // Legacy exceptionCategory may have been an automatic default, not a choice.
        setReportFailureReason(restoreReportFailureReason(restored.reportFailureReason));
        setOverrideReason(restored.overrideReason);
        setSkipReason(isSkipReason(restored.skipReason) ? restored.skipReason : "");
        setCustomCategory(restoreCustomCategory(restored.customCategory));
        reportRef.current = restored.report ?? null;
        if (restored.report?.outcome === "failed" && !restoreReportFailureReason(restored.reportFailureReason) && !restoreCustomCategory(restored.customCategory)) {
          throw new Error(lang === "sv"
            ? "En äldre rapport finns redan sparad för synkning. Granska dess status i ruttöversiktens synklista; rapportens orsak ändras inte i efterhand."
            : "An older report is already saved for sync. Review its status in the route overview sync list; its reason cannot be changed retroactively.");
        }
      }
      const cached = routeId ? await getCachedData<Stop[]>(`stops_${routeId}`) : null;
      if (mounted) setStop(cached?.find((item) => item.id === stopId) ?? null);
      if (isOnline) {
        try {
          const current = await api.getStop(stopId);
          if (mounted) setStop(current);
        } catch (err) {
          if (!isRetryableWorkFailure(err) || !cached?.some(item => item.id === stopId)) throw err;
        }
      }
      if (mounted) setDraftReady(true);
    })().catch((err) => {
      if (mounted) setDraftError(localizeError(err, lang));
    });
    return () => { mounted = false; };
  }, [draftIdentity, routeScopeKey]);

  useEffect(() => {
    if (!draftReady || submitted) return;
    const value = { proofs, notes, reportOutcome, exceptionCategory, reportFailureReason, skipReason, customCategory, overrideReason, report: reportRef.current };
    const owner = getOfflineQueueScope();
    draftWrites.current = draftWrites.current.catch(() => {}).then(() => writeReportDraft(draftIdentity, value, owner))
      .then(() => setDraftError(null), (err) => { setDraftError(localizeError(err, lang)); throw err; });
    void draftWrites.current.catch(() => {});
  }, [proofs, notes, reportOutcome, exceptionCategory, reportFailureReason, skipReason, customCategory, overrideReason, draftReady, submitted, draftIdentity]);

  const submitReport = async () => {
    if (reportOutcome === "skipped" && !skipReason && !customCategory) {
      setSaveError(lang === "sv" ? "Välj varför stoppet hoppas över innan du sparar." : "Choose why the stop is skipped before saving.");
      return;
    }
    if (needsReportFailureReason(reportOutcome, reportFailureReason) && !customCategory) {
      setSaveError(lang === "sv" ? "Välj varför stoppet inte kunde genomföras innan du sparar." : "Choose why the stop could not be completed before saving.");
      return;
    }
    if (submitting || !draftReady || !stop || stop.routeId !== routeId ||
      activeRoute?.id !== routeId || activeRoute.planRevision !== Number(planVersion) ||
      activeRoute.handoffVersion !== Number(planVersion) ||
      activeRoute.handoffStatus !== "accepted" || stop.jobType === "field_service") {
      setSaveError(lang === "sv" ? "Stoppet eller planversionen har ändrats. Öppna aktuell rutt och försök igen." : "The stop or plan version has changed. Open the current route and try again.");
      return;
    }
    if (proximity && Date.now() - positionCheckedAt > 60_000) {
      setProximity(null);
      setSaveError(lang === "sv" ? "Platskontrollen har blivit för gammal. Tryck Spara igen för en ny kontroll." : "The location check has expired. Press Save again to check your location.");
      return;
    }
    if (proximity?.state === "far" && !overrideReason.trim()) {
      setSaveError(lang === "sv" ? "Ange varför du rapporterar trots avståndet." : "Explain why you are reporting despite the distance."); return;
    }
    setSubmitting(true); setSaveError(null);
    const release = await acquireOfflineSyncLease();
    try {
      await draftWrites.current;
      if (!isAssisting && !proximity && !reportRef.current) {
        let result: ProximityResult;
        try {
          const permission = await Location.requestForegroundPermissionsAsync();
          const sample = permission.granted ? await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
          ]) : null;
          result = evaluateProximity(sample ? {
            latitude: sample.coords.latitude, longitude: sample.coords.longitude,
            accuracy: sample.coords.accuracy, recordedAt: sample.timestamp,
          } : null, proofStage === "pickup" ? { latitude: stop.pickupLatitude, longitude: stop.pickupLongitude } : stop);
        } catch { result = { state: "unknown", reason: "missing", distanceM: null }; }
        setProximity(result);
        setPositionCheckedAt(Date.now());
        if (result.state === "far") return;
      }
      const report = reportRef.current ?? {
        id: `${stopId}:report:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
        stopId, routeId: routeId!, planVersion: Number(planVersion),
        occurredAt: new Date().toISOString(), outcome: reportOutcome, stage: proofStage,
        ...(reportOutcome === "skipped" ? { skipReason: customCategory ? "OTHER" as const : skipReason as SkipReason } : {}),
        comment: [
          reportOutcome !== "completed" && customCategory ? customCategoryLine(customCategory)
            : reportOutcome === "failed" ? `Orsak: ${t(`deviation.categories.${reportFailureReason}`)} (${reportFailureReason})`
            : reportOutcome === "skipped" && skipReason ? skipReasonLine(skipReason, skipLabel(skipReason)) : "",
          notes.trim(), proximity?.state === "far" ? `Platsvarning (${proximity.distanceM} m): ${overrideReason.trim()}` : ""]
          .filter(Boolean).join("\n") || undefined,
        proofs: proofs.map(({ type, data }) => ({ type, data })),
      } satisfies StopReport;
      reportRef.current = report;
      // Freeze stable IDs before an uncertain online result; never recreate on retry.
      await writeReportDraft(draftIdentity, { proofs, notes, reportOutcome, exceptionCategory, reportFailureReason, skipReason, customCategory, overrideReason, report });
      if (isAssisting) {
        if (!isOnline) throw new Error("Live assistance requires an online connection.");
        await sendStopReport(report, stopReportPort);
        setReportStatus("synced");
      } else {
        await enqueueStopReport(report);
        setReportStatus("local");
      }
      await clearReportDraft(draftIdentity);
      setSubmitted(true);
      // Refresh is not delivery evidence and must not turn a committed report
      // into a save failure. Queue acknowledgements own the sync confirmation.
      void queryClient.invalidateQueries({ queryKey: ["stops", routeId] })
        .catch((err) => console.warn("[REPORT] Saved report; stop refresh failed:", err));
    } catch (err) {
      setSaveError(localizeError(err, lang));
    } finally { release(); setSubmitting(false); }
  };

  // Quick "Genomfört utan noteringar": run the SAME submitReport once the draft
  // and stop are loaded, so plan, location and override gates still apply.
  const quickTriggered = useRef(false);
  const submitReportRef = useRef(submitReport);
  submitReportRef.current = submitReport;
  useEffect(() => {
    if (quick !== "1" || outcome !== "completed" || quickTriggered.current) return;
    if (!draftReady || !stop || !activeRoute || submitted || proofs.length > 0 || notes.trim() || reportRef.current) return;
    if (stop.status !== "pending" && stop.status !== "in_progress") return;
    if (reportOutcome !== "completed") return;
    quickTriggered.current = true;
    void submitReportRef.current();
  }, [quick, outcome, draftReady, stop, activeRoute, submitted, proofs.length, notes, reportOutcome]);

  // Return to assignments only after the queue confirms server acknowledgement.
  useEffect(() => {
    if (!submitted || !isReporting || reportStatus !== "synced") return;
    const timer = setTimeout(() => router.replace("/(tabs)"), 1200);
    return () => clearTimeout(timer);
  }, [submitted, isReporting, reportStatus]);

  const webPhotoInput = useRef<HTMLInputElement | null>(null);
  const webLibraryInput = useRef<HTMLInputElement | null>(null);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const readWebPhoto = async (file?: File) => {
    if (!file) return;
    setReadingPhoto(true);
    try {
      const data = await prepareBrowserPhoto(file);
      setSaveError(null);
      setProofs(items => [...items, { type: "photo", data }]);
    } catch {
      setSaveError(lang === "sv"
        ? "Bilden kunde inte läsas eller är för stor. Ta ett nytt foto eller välj en JPEG/PNG-bild. Bilden har inte lagts i synkkön."
        : "The image could not be read or is too large. Take a new photo or choose JPEG/PNG. It has not been added to the sync queue.");
    } finally {
      setReadingPhoto(false);
    }
  };
  const takePhoto = async () => {
    if (Platform.OS === "web") {
      // Persistent native browser input: no temporary picker removed on
      // focus/cancel, and no asynchronous permission prompt before the click.
      webPhotoInput.current?.click();
      return;
    }
    const permResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permResult.granted) {
      const libResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libResult.granted) {
        setSaveError(lang === "sv" ? "Tillåt kamera eller bilder i telefonens inställningar för att lägga till foto." : "Allow camera or photo access in your phone settings to attach a photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.7,
        base64: true,
      });
      if (!result.canceled && result.assets[0].base64) {
        setProofs((p) => [...p, { type: "photo", data: `data:image/jpeg;base64,${result.assets[0].base64}` }]);
      }
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setProofs((p) => [...p, { type: "photo", data: `data:image/jpeg;base64,${result.assets[0].base64}` }]);
    }
  };

  const handleSignatureSave = (data: string) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setProofs((p) => [...p, { type: "signature", data }]);
    setShowSignaturePad(false);
  };

  const addBarcode = () => {
    if (!barcodeValue.trim()) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setProofs((p) => [...p, { type: "barcode", data: barcodeValue.trim() }]);
    setBarcodeValue("");
  };

  const openBarcodeScanner = async () => {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      Alert.alert(t("proof.cameraPermissionMissing"), t("proof.cameraBarcodeMessage"));
      return;
    }
    setScannerLocked(false);
    setScannerVisible(true);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scannerLocked || !data.trim()) return;
    setScannerLocked(true);
    setProofs((p) => [...p, { type: "barcode", data: data.trim() }]);
    setScannerVisible(false);
  };

  const captureExceptionPhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(t("proof.cameraPermissionMissing"), t("proof.cameraEvidenceMessage"));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (!result.canceled && result.assets[0].base64) {
      setExceptionPhoto(`data:image/jpeg;base64,${result.assets[0].base64}`);
    }
  };

  const submitException = async () => {
    if (!stopId || !exceptionComment.trim() || !exceptionPhoto || exceptionSubmitting) {
      if (!exceptionPhoto) {
         Alert.alert(t("proof.photoRequired"), t("proof.photoRequiredMessage"));
      }
      return;
    }
    setExceptionSubmitting(true);
    let exceptionSent = false;
    const occurredAt = new Date().toISOString();
    const item = {
      stopId,
      // Custom labels are text only; the exception API keeps its standard enum.
      category: exceptionCustom ? "other" : exceptionCategory,
      comment: exceptionCustom ? `${customCategoryLine(exceptionCustom)}\n${exceptionComment.trim()}` : exceptionComment.trim(),
      photoData: exceptionPhoto,
      proofStage,
      clientEventId: `${stopId}_exception_${Date.now()}`,
      planVersion: Number(planVersion ?? 0),
      occurredAt,
    };
    try {
      if (!isOnline) {
        if (isAssisting) {
          throw new Error("Live assistance requires an online connection. No exception was queued.");
        }
        await enqueueException(item);
      } else {
        try {
          await api.createStopException(stopId, item);
          exceptionSent = true;
        } catch (err) {
          if (isAssisting) throw err;
          await enqueueException(item);
          if (isStalePlanError(err)) {
            const { getExceptionQueue, markQueueItemStatus } = await import("@/lib/offline-queue");
            const queued = await getExceptionQueue();
            const queuedItem = queued.find((entry) => entry.clientEventId === item.clientEventId);
            if (queuedItem) await markQueueItemStatus("exception", queuedItem.id, "conflict", "Planversionen är inte längre aktuell.");
          }
        }
      }
      setExceptionVisible(false);
      setExceptionComment("");
      setExceptionPhoto(undefined);
      setExceptionCustom(null);
      Alert.alert(t("proof.exceptionSaved"), exceptionSent ? t("proof.exceptionSent") : t("proof.exceptionOffline"));
    } catch (err) {
      Alert.alert(
        t("proof.exceptionSaveFailed"),
        localizeError(err, lang, { fallback: t("proof.tryAgain") }),
      );
    } finally {
      setExceptionSubmitting(false);
    }
  };

  const removeProof = (index: number) => {
    setProofs((p) => p.filter((_, i) => i !== index));
  };

  const submitAll = async () => {
    if (!stopId || proofs.length === 0) return;
    setSubmitting(true);
    const occurredAt = new Date().toISOString();
    const currentPlanVersion = Number(planVersion ?? 0);

    if (!isOnline) {
      if (isAssisting) {
        Alert.alert(t("proof.offlineQueueFailed"), "Live assistance requires an online connection. No proof was queued.");
        setSubmitting(false);
        return;
      }
      try {
        for (const [index, proof] of proofs.entries()) {
          await enqueueProof({
            stopId,
            proofType: proof.type,
            proofStage,
            data: proof.data,
            notes: notes || undefined,
            clientEventId: `${stopId}_proof_${index}_${Date.now()}`,
            planVersion: currentPlanVersion,
            occurredAt,
          });
        }
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setProofDelivery("queued");
        setSubmitted(true);
      } catch (err: any) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(t("proof.offlineQueueFailed"), localizeError(err, lang, { fallback: t("proof.offlineQueueFailedMsg") }));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    let queuedProofs = 0;
    try {
      for (const [index, proof] of proofs.entries()) {
        const clientEventId = `${stopId}_proof_${index}_${Date.now()}`;
        try {
          await api.submitProof(stopId, {
            proofType: proof.type,
            proofStage,
            data: proof.data,
            notes: notes || undefined,
            clientEventId,
            planVersion: currentPlanVersion,
            occurredAt,
          });
        } catch (uploadErr) {
          if (isAssisting || !isRetryableWorkFailure(uploadErr)) throw uploadErr;
          await enqueueProof({
            stopId,
            proofType: proof.type,
            proofStage,
            data: proof.data,
            notes: notes || undefined,
            clientEventId,
            planVersion: currentPlanVersion,
            occurredAt,
          });
          queuedProofs += 1;
          if (isStalePlanError(uploadErr)) {
            const queued = await getProofQueue();
            const item = queued.find((entry) => entry.clientEventId === clientEventId);
            if (item) await markQueueItemStatus("proof", item.id, "conflict", "Planversionen är inte längre aktuell.");
          }
          console.warn("[POD] Upload failed, queued for retry:", uploadErr);
        }
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setProofDelivery(queuedProofs === 0 ? "synced" : queuedProofs === proofs.length ? "queued" : "partial");
      setSubmitted(true);
    } catch (err: any) {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t("proof.submissionFailed"), localizeError(err, lang, { fallback: t("proof.submissionFailedMsg") }));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    const confirmed = isReporting ? reportStatus === "synced" : proofDelivery === "synced";
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <View style={[styles.successCircle, { backgroundColor: confirmed ? c.primary : c.warning }]}>
          <Feather name={confirmed ? "check" : "cloud"} size={28} color="#FFF" />
        </View>
        <Text style={[styles.successText, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
          {confirmed
            ? lang === "sv" ? "Synkat med trafikledningen" : "Synced with dispatch"
            : !isReporting && proofDelivery === "partial"
              ? lang === "sv" ? "Delvis skickat – bevis väntar på synkning" : "Partly uploaded – evidence waiting to sync"
              : lang === "sv" ? "Sparat på enheten" : "Saved on this device"}
        </Text>
        {!confirmed && <Text style={styles.confirmationDescription}>
          {lang === "sv" ? "Väntar på synkning. Se kö och eventuella konflikter i Inställningar." : "Waiting to sync. Check Settings for the queue and any conflicts."}
        </Text>}
        {isReporting && proximity?.state === "unknown" && <Text style={styles.confirmationDescription}>{lang === "sv" ? "Platsen kunde inte kontrolleras tillförlitligt. Rapporten är sparad." : "Location could not be reliably checked. The report is saved."}</Text>}
        {saveError && <Text accessibilityRole="alert" style={{ color: c.danger, marginTop: 12, paddingHorizontal: 20 }}>{saveError}</Text>}
        <Pressable accessibilityRole="button" onPress={returnToRoute} style={[styles.submitBtn, { backgroundColor: c.primary, alignSelf: "stretch" }]}>
          <Text style={styles.submitBtnText}>{lang === "sv" ? "Till ruttöversikten" : "Back to route"}</Text>
        </Pressable>
      </View>
    );
  }

  const customOptions = categories.length > 0 ? (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 4 }}>{lang === "sv" ? "Organisationens kategorier" : "Organization categories"}</Text>
      {categories.map((cat) => {
        const on = customCategory?.id === cat.id;
        return (
          <Pressable key={cat.id} accessibilityRole="radio" testID={`report-custom-category-${cat.id}`}
            accessibilityState={{ checked: on }}
            onPress={() => { if (!reportRef.current) { setCustomCategory({ id: cat.id, label: cat.label }); setSaveError(null); } }}
            style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 8, borderColor: on ? c.primary : c.border }}>
            <Text style={{ color: c.text }}>{cat.label}</Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;

  return (
    <>
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
      >
        <View style={[styles.scanner, { backgroundColor: "#000" }]}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39", "upc_a", "upc_e", "itf14", "datamatrix"] }}
            onBarcodeScanned={scannerLocked ? undefined : handleBarcodeScanned}
          />
          <View style={styles.scannerOverlay}>
            <Text style={styles.scannerTitle}>{t("proof.scannerTitle")}</Text>
            <View style={styles.scannerFrame} />
            <Pressable onPress={() => setScannerVisible(false)} style={styles.scannerClose}>
              <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold" }}>{t("proof.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        visible={exceptionVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setExceptionVisible(false)}
      >
        <View style={styles.exceptionOverlay}>
          <View style={[styles.exceptionSheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>{t("proof.reportException")}</Text>
            <Text style={{ color: c.textSecondary }}>{t("proof.exceptionDescription")}</Text>
            <View style={styles.exceptionCategories}>
              {["customer_unavailable", "access_problem", "vehicle_issue", "other"].map((category) => (
                <Pressable key={category} onPress={() => { setExceptionCategory(category); setExceptionCustom(null); }} style={[styles.exceptionChip, { borderColor: !exceptionCustom && exceptionCategory === category ? c.primary : c.border, backgroundColor: !exceptionCustom && exceptionCategory === category ? c.primary + "15" : c.background }]}>
                   <Text style={{ color: !exceptionCustom && exceptionCategory === category ? c.primary : c.text, fontSize: 12 }}>{t(`deviation.categories.${category}`)}</Text>
                </Pressable>
              ))}
              {categories.map((cat) => {
                const on = exceptionCustom?.id === cat.id;
                return (
                  <Pressable key={cat.id} testID={`exception-custom-${cat.id}`} onPress={() => setExceptionCustom({ id: cat.id, label: cat.label })} style={[styles.exceptionChip, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary + "15" : c.background }]}>
                    <Text style={{ color: on ? c.primary : c.text, fontSize: 12 }}>{cat.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={exceptionComment}
              onChangeText={setExceptionComment}
              multiline
              placeholder={t("proof.exceptionPlaceholder")}
              placeholderTextColor={c.textTertiary}
              style={[styles.notesInput, { color: c.text, borderColor: c.border }]}
            />
            <Pressable onPress={captureExceptionPhoto} style={[styles.exceptionPhotoButton, { borderColor: c.info }]}>
              <Feather name="camera" size={18} color={c.info} />
              <Text style={{ color: c.info, fontFamily: "Inter_600SemiBold" }}>{exceptionPhoto ? t("proof.photoAttached") : t("proof.attachPhoto")}</Text>
            </Pressable>
            <View style={styles.exceptionActions}>
              <Pressable onPress={() => setExceptionVisible(false)}><Text style={{ color: c.textSecondary }}>{t("proof.cancel")}</Text></Pressable>
              <Pressable onPress={submitException} disabled={!exceptionComment.trim() || !exceptionPhoto || exceptionSubmitting} style={[styles.exceptionSubmit, { backgroundColor: c.danger, opacity: !exceptionComment.trim() || !exceptionPhoto || exceptionSubmitting ? 0.5 : 1 }]}>
                <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold" }}>{t("proof.saveReport")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
      <View style={styles.section}>
        {isReporting && (
          <View style={{ gap: 14, marginBottom: 20 }}>
            <Text style={styles.eyebrow}>{lang === "sv" ? "Rapportera stopp" : "Report stop"}</Text>
            <Text style={{ color: c.text, fontSize: 24, lineHeight: 30, fontFamily: "Inter_700Bold" }}>{stop?.address ?? t("proof.captureEvidence")}</Text>
            <Text style={[styles.sectionTitle, { color: c.text }]}>{lang === "sv" ? "Hur gick stoppet?" : "How did the stop go?"}</Text>
            <View style={{ gap: 10 }}>
              {(outcome === "skipped" ? ["skipped"] as const : ["completed", "failed"] as const).map((value) => (
                <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: reportOutcome === value }}
                  onPress={() => { if (!reportRef.current) setReportOutcome(value); }}
                   style={{ minHeight: 56, padding: 14, flexDirection: "row", gap: 12, alignItems: "center", borderRadius: 13,
                     borderWidth: 1, borderColor: reportOutcome === value ? c.primary : c.border,
                     backgroundColor: reportOutcome === value ? c.primary + "10" : c.surface }}>
                   <Feather name={reportOutcome === value ? "check-circle" : "circle"} size={20} color={c.primary} />
                   <Text style={{ color: c.text, fontSize: 15, flex: 1, fontFamily: "Inter_600SemiBold" }}>
                     {value === "completed" ? lang === "sv" ? "Genomfört" : "Completed" : value === "skipped" ? lang === "sv" ? "Hoppas över" : "Skipped" : lang === "sv" ? "Kunde inte genomföras" : "Could not complete"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {reportOutcome === "failed" && (
              <View style={{ gap: 8 }}>
                <Text style={[styles.sectionTitle, { color: c.text }]}>{lang === "sv" ? "Orsak" : "Reason"}</Text>
                {!reportFailureReason && !customCategory && <Text accessibilityRole="alert" style={{ color: c.danger }}>
                  {lang === "sv" ? "Välj varför stoppet inte kunde genomföras innan du sparar." : "Choose why the stop could not be completed before saving."}
                </Text>}
                {REPORT_FAILURE_REASONS.map((category) => (
                  <Pressable key={category} accessibilityRole="radio"
                    testID={`report-failure-reason-${category}`}
                    accessibilityState={{ checked: !customCategory && category === reportFailureReason }}
                    aria-checked={!customCategory && category === reportFailureReason}
                    onPress={() => { if (!reportRef.current) { setReportFailureReason(category); setCustomCategory(null); setSaveError(null); } }}
                    style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 8,
                      borderColor: !customCategory && category === reportFailureReason ? c.primary : c.border }}>
                    <Text style={{ color: c.text }}>{t(`deviation.categories.${category}`)}</Text>
                  </Pressable>
                ))}
                {customOptions}
              </View>
            )}
            {reportOutcome === "skipped" && (
              <View style={{ gap: 8 }}>
                <Text style={[styles.sectionTitle, { color: c.text }]}>{lang === "sv" ? "Orsak" : "Reason"}</Text>
                {!skipReason && !customCategory && <Text accessibilityRole="alert" style={{ color: c.danger }}>
                  {lang === "sv" ? "Välj varför stoppet hoppas över innan du sparar." : "Choose why the stop is skipped before saving."}
                </Text>}
                {SKIP_REASONS.map((reason) => (
                  <Pressable key={reason} accessibilityRole="radio" testID={`skip-reason-${reason}`}
                    accessibilityState={{ checked: !customCategory && reason === skipReason }}
                    onPress={() => { if (!reportRef.current) { setSkipReason(reason); setCustomCategory(null); setSaveError(null); } }}
                    style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 8,
                      borderColor: !customCategory && reason === skipReason ? c.primary : c.border }}>
                    <Text style={{ color: c.text }}>{skipLabel(reason)}</Text>
                  </Pressable>
                ))}
                {customOptions}
              </View>
            )}
            {(draftError || saveError) && <Text accessibilityRole="alert" style={{ color: c.danger }}>{saveError ?? draftError}</Text>}
            {proximity && (
              <View style={{ padding: 14, borderWidth: 1, borderColor: c.warning, borderRadius: 10, gap: 10 }}>
                <Text style={{ color: c.text }}>
                  {proximity.state === "far"
                    ? lang === "sv" ? `Du verkar vara ${proximity.distanceM} meter från stoppet. Kontrollera att du rapporterar rätt uppdrag.` : `You appear to be ${proximity.distanceM} metres from the stop. Check that you are reporting the correct job.`
                    : proximity.state === "unknown"
                      ? lang === "sv" ? "Platsen kunde inte kontrolleras tillförlitligt. Du kan fortfarande rapportera uppdraget." : "Location could not be reliably checked. You can still report the job."
                      : lang === "sv" ? "Positionen är nära stoppet." : "Your location is near the stop."}
                </Text>
                {proximity.state === "far" && <>
                  <Pressable accessibilityRole="button" onPress={() => { setProximity(null); setSaveError(null); }} style={{ minHeight: 48, justifyContent: "center" }}>
                    <Text style={{ color: c.primary }}>{lang === "sv" ? "Kontrollera plats igen" : "Check location again"}</Text>
                  </Pressable>
                  <TextInput accessibilityLabel={lang === "sv" ? "Motivering till platsundantag" : "Location exception reason"} placeholder={lang === "sv" ? "Varför rapporterar du ändå?" : "Why are you reporting anyway?"}
                    value={overrideReason} onChangeText={setOverrideReason}
                    style={[styles.notesInput, { color: c.text, borderColor: c.border }]} />
                  <Pressable accessibilityRole="button" onPress={returnToRoute} style={{ minHeight: 48, justifyContent: "center" }}>
                    <Text style={{ color: c.primary }}>{lang === "sv" ? "Tillbaka till stoppet" : "Back to stop"}</Text>
                  </Pressable>
                </>}
              </View>
            )}
          </View>
        )}
        <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
          {t("proof.captureEvidence")}
        </Text>
        {routeId && (
          <Pressable
            onPress={() => router.push({ pathname: "/messages/[routeId]", params: { routeId, stopId } })}
            style={[styles.stopMessageButton, { borderColor: c.border, backgroundColor: c.surface }]}
          >
            <Feather name="message-circle" size={17} color={c.primary} />
            <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{t("proof.stopMessages")}</Text>
          </Pressable>
        )}

        <View style={styles.captureRow}>
          {Platform.OS === "web" && <input
            ref={webPhotoInput} type="file" accept="image/*" capture="environment"
            disabled={readingPhoto || submitting}
            aria-label={lang === "sv" ? "Ta foto" : "Take photo"}
            data-testid="proof-photo-file-input"
            style={{ display: "none" }}
            onChange={event => {
              readWebPhoto(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />}
          {Platform.OS === "web" && <>
            <input ref={webLibraryInput} type="file" accept="image/*" style={{ display: "none" }}
              disabled={readingPhoto || submitting} aria-label={lang === "sv" ? "Välj bild" : "Choose image"}
              onChange={event => {
                readWebPhoto(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }} />
            <Pressable accessibilityRole="button" disabled={readingPhoto || submitting}
              onPress={() => webLibraryInput.current?.click()} style={styles.captureBtn}>
              <Text style={{ color: c.primary }}>{lang === "sv" ? "Välj bild" : "Choose image"}</Text>
            </Pressable>
          </>}
          <Pressable
            onPress={takePhoto}
            disabled={readingPhoto || submitting}
            style={({ pressed }) => [
              styles.captureBtn,
              { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="camera" size={20} color={c.primary} />
            <Text style={[styles.captureBtnText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
              {readingPhoto ? (lang === "sv" ? "Läser bild…" : "Reading image…") : (lang === "sv" ? "Ta foto" : "Take photo")}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setShowSignaturePad(true)}
            style={({ pressed }) => [
              styles.captureBtn,
              { backgroundColor: c.primary + "10", borderColor: c.primary + "20", opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="edit-3" size={24} color={c.primary} />
            <Text style={[styles.captureBtnText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
              {t("proof.signature")}
            </Text>
          </Pressable>
        </View>

        <Modal visible={showSignaturePad} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setShowSignaturePad(false)}>
        <View style={{ flex: 1, padding: 20, paddingTop: insets.top + 24, backgroundColor: c.surface, justifyContent: "center" }}>
          <Text style={{ fontSize: 24, color: c.text, fontFamily: "Inter_700Bold", marginBottom: 24 }}>{lang === "sv" ? "Kundens signatur" : "Customer signature"}</Text>
          <SignaturePad
            onSave={handleSignatureSave}
            onCancel={() => setShowSignaturePad(false)}
          />
        </View>
        </Modal>

        <View style={styles.barcodeRow}>
          <TextInput
            style={[styles.barcodeInput, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" }]}
            value={barcodeValue}
            onChangeText={setBarcodeValue}
            placeholder={t("proof.enterBarcode")}
            placeholderTextColor={c.textTertiary}
          />
          <Pressable
            onPress={addBarcode}
            style={({ pressed }) => [
              styles.barcodeBtn,
              { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="plus" size={20} color="#FFF" />
          </Pressable>
        </View>
        <View style={styles.secondaryActionRow}>
          <Pressable onPress={openBarcodeScanner} style={[styles.secondaryAction, { borderColor: c.primary, backgroundColor: c.primary + "10" }]}>
            <Feather name="maximize" size={17} color={c.primary} />
            <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{t("proof.scanBarcode")}</Text>
          </Pressable>
          <Pressable onPress={() => setExceptionVisible(true)} style={[styles.secondaryAction, { borderColor: c.danger, backgroundColor: c.danger + "10" }]}>
            <Feather name="alert-triangle" size={17} color={c.danger} />
            <Text style={{ color: c.danger, fontFamily: "Inter_600SemiBold" }}>{t("proof.reportException")}</Text>
          </Pressable>
        </View>
      </View>

      {proofs.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            {t("proof.collected", { count: proofs.length })}
          </Text>
          {proofs.map((proof, idx) => (
            <View
              key={idx}
              style={[styles.proofItem, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              {proof.type === "photo" ? (
                <Image source={{ uri: proof.data }} style={styles.proofThumb} />
              ) : (
                <View style={[styles.proofIcon, { backgroundColor: c.primary + "15" }]}>
                  <Feather
                    name={proof.type === "barcode" ? "hash" : "edit-3"}
                    size={20}
                    color={c.primary}
                  />
                </View>
              )}
              <View style={styles.proofInfo}>
                <Text style={[styles.proofType, { color: c.text, fontFamily: "Inter_500Medium" }]}>
                  {proof.type === "photo" ? t("proof.photo") : proof.type === "barcode" ? t("proof.barcode") : t("proof.signature")}
                </Text>
                {proof.type === "barcode" && (
                  <Text style={[styles.proofData, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    {proof.data}
                  </Text>
                )}
              </View>
              <Pressable onPress={() => removeProof(idx)}>
                <Feather name="x" size={20} color={c.textTertiary} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
          {t("proof.notesOptional")}
        </Text>
        <TextInput
          style={[styles.notesInput, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" }]}
          value={notes}
          onChangeText={setNotes}
          placeholder={t("proof.addNotes")}
          placeholderTextColor={c.textTertiary}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      <Pressable
        onPress={isReporting ? submitReport : submitAll}
        testID="save-stop-report"
        accessibilityRole="button"
        disabled={submitting || readingPhoto || (isReporting ? !draftReady || !!draftError || (reportOutcome === "skipped" && !skipReason && !customCategory) || (needsReportFailureReason(reportOutcome, reportFailureReason) && !customCategory) : proofs.length === 0)}
        style={({ pressed }) => [
          styles.submitBtn,
          {
            backgroundColor: !isReporting && proofs.length === 0 ? c.textTertiary : c.primary,
            minHeight: 56,
            opacity: pressed || submitting ? 0.8 : 1,
            marginHorizontal: 20,
          },
        ]}
      >
        {submitting ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <>
            <Feather name="upload" size={18} color="#FFF" />
            <Text style={[styles.submitBtnText, { fontFamily: "Inter_600SemiBold" }]}>
              {isReporting ? proximity?.state === "far" ? lang === "sv" ? "Rapportera ändå och spara" : "Report anyway and save" : lang === "sv" ? "Spara rapport" : "Save report"
                : t(proofs.length === 1 ? "proof.submitOne" : "proof.submitMany", { count: proofs.length })}
            </Text>
          </>
        )}
      </Pressable>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  successCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  successText: { fontSize: 24, lineHeight: 31, textAlign: "center", letterSpacing: -0.6 },
  confirmationDescription: { fontSize: 14, lineHeight: 21, textAlign: "center", color: Colors.light.textSecondary, fontFamily: "Inter_400Regular" },
  eyebrow: { fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Colors.light.textSecondary, fontFamily: "Inter_700Bold" },
  section: {
    padding: 16,
    marginHorizontal: 20,
    marginTop: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 18,
    backgroundColor: Colors.light.surface,
    gap: 12,
  },
  sectionTitle: { fontSize: 15, lineHeight: 21, fontFamily: "Inter_600SemiBold" },
  captureRow: {
    flexDirection: "column",
    gap: 12,
  },
  captureBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    minHeight: 54,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
  },
  captureBtnText: { fontSize: 14 },
  secondaryActionRow: { gap: 8 },
  secondaryAction: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12 },
  stopMessageButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10 },
  barcodeRow: {
    flexDirection: "row",
    gap: 10,
  },
  barcodeInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  barcodeBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  proofItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  proofThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
  },
  proofIcon: {
    width: 48,
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  proofInfo: { flex: 1, gap: 2 },
  proofType: { fontSize: 15 },
  proofData: { fontSize: 13 },
  notesInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    minHeight: 80,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    paddingVertical: 16,
    borderRadius: 14,
  },
  submitBtnText: { fontSize: 15, color: "#FFF", fontFamily: "Inter_600SemiBold" },
  scanner: { flex: 1 },
  scannerOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: 28, paddingTop: 60 },
  scannerTitle: { color: "#FFF", fontSize: 18, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  scannerFrame: { width: 260, height: 160, borderWidth: 2, borderColor: "#FFF", borderRadius: 12 },
  scannerClose: { backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 22 },
  exceptionOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  exceptionSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 14 },
  exceptionCategories: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  exceptionChip: { paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderRadius: 16 },
  exceptionPhotoButton: { minHeight: 44, borderWidth: 1, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  exceptionActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 20 },
  exceptionSubmit: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 10 },
});
