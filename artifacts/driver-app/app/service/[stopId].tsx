import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Image,
  ActivityIndicator,
  Platform,
  Alert,
  PanResponder,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import Colors from "@/constants/colors";
import { api, ensureRouteExecutionForWork, ServiceReport, PutServiceReportPayload, ServiceMaterial, Stop } from "@/lib/api";
import { enqueueServiceReport, enqueueProof, enqueueStopStatusUpdate, getCachedData, readReportDraft, writeReportDraft, getOfflineQueueScope } from "@/lib/offline-queue";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/context/AuthContext";
import { useSelectedRoute } from "@/context/SelectedRouteContext";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import { localizeError } from "@/lib/error-localizer";
import { signaturePngDataUrl } from "@/lib/signature-image";
import { isRetryableWorkFailure } from "@/lib/work-execution";

type ProofType = "photo" | "signature";
interface Proof { type: ProofType; data: string; }

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
      <View style={[signStyles.canvas, { borderColor: c.border }]} onLayout={({ nativeEvent }) => { canvasSize.current = nativeEvent.layout; }} {...panResponder.panHandlers}>
        {allPaths.length === 0 && (
          <Text style={[signStyles.placeholder, { color: c.textTertiary }]}>{t("proof.signHere")}</Text>
        )}
        {allPaths.map((pts, i) =>
          pts.length > 1 ? (
            <View key={`${i}-${pathCount}`} style={StyleSheet.absoluteFill} pointerEvents="none">
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
        <Pressable onPress={handleClear} style={({ pressed }) => [signStyles.btn, { borderColor: c.border, opacity: pressed ? 0.8 : 1 }]}>
          <Feather name="trash-2" size={16} color={c.textSecondary} />
          <Text style={[signStyles.btnText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>{t("proof.clear")}</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={({ pressed }) => [signStyles.btn, { borderColor: c.border, opacity: pressed ? 0.8 : 1 }]}>
          <Text style={[signStyles.btnText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>{t("proof.cancel")}</Text>
        </Pressable>
        <Pressable onPress={handleSave} disabled={pathsRef.current.length === 0} style={({ pressed }) => [signStyles.btn, signStyles.btnPrimary, { backgroundColor: pathsRef.current.length === 0 ? c.textTertiary : c.primary, opacity: pressed ? 0.8 : 1 }]}>
          <Feather name="check" size={16} color="#FFF" />
          <Text style={[signStyles.btnText, { color: "#FFF", fontFamily: "Inter_600SemiBold" }]} testID="signature-accept-btn">{t("proof.accept")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const signStyles = StyleSheet.create({
  container: { gap: 12, width: "100%", maxWidth: 900, alignSelf: "center" },
  canvas: { width: "100%", height: 200, borderWidth: 2, borderRadius: 12, borderStyle: "dashed", justifyContent: "center", alignItems: "center", overflow: "hidden", backgroundColor: "#FAFAFA" },
  placeholder: { fontSize: 16, position: "absolute" },
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  btn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: "transparent" },
  btnPrimary: { borderWidth: 0 },
  btnText: { fontSize: 14 },
});

export default function ServiceScreen() {
  const { stopId, routeId, planVersion } = useLocalSearchParams<{ stopId: string; routeId?: string; planVersion?: string }>();
  const c = Colors.light;
  const { t, lang } = useT();
  const { driver } = useAuth();
  const { assistedDriver, isAssisting } = useDriverAssistance();
  const operatingDriver = assistedDriver ?? driver;
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { isOnline } = useNetworkStatus();

  const { activeRoute: selectedRoute, routeScopeKey } = useSelectedRoute();
  const activeRoute = !routeId || routeId === selectedRoute?.id ? selectedRoute : null;
  const expectedPlanVersion = useRef<number | null>(null);
  if (expectedPlanVersion.current === null && activeRoute) {
    expectedPlanVersion.current = Number(planVersion ?? activeRoute.planRevision);
  }
  const planChanged = !!activeRoute && activeRoute.planRevision !== expectedPlanVersion.current;
  
  const { data: stops } = useQuery({ 
    queryKey: ["stops", activeRoute?.id], 
    queryFn: async () => {
      if (isOnline) return api.getRouteStops(activeRoute!.id);
      const cached = await getCachedData<Stop[]>(`stops_${activeRoute?.id}`);
      return cached || [];
    },
    enabled: !!activeRoute?.id 
  });
  
  const stop = stops?.find(s => s.id === stopId);

  const { data: initialReport, isLoading: reportLoading } = useQuery({
    queryKey: ["serviceReport", stopId],
    queryFn: () => api.getServiceReport(stopId),
    enabled: !!stopId && isOnline,
    staleTime: 0,
  });

  const [status, setStatus] = useState<"draft" | "submitted" | "billing_ready">("draft");
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [materials, setMaterials] = useState<ServiceMaterial[]>([]);
  const [customerSignatoryName, setCustomerSignatoryName] = useState("");
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "synced" | "local">("idle");

  const [submitting, setSubmitting] = useState(false);
  const [elapsedMin, setElapsedMin] = useState(0);

  const initRef = useRef(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const draftIdentity = `service:${routeId}:${stopId}:${expectedPlanVersion.current}`;

  useEffect(() => {
    if (expectedPlanVersion.current === null) return;
    let mounted = true;
    setDraftReady(false);
    void readReportDraft<{
      status: typeof status; startedAt: string | null; notes: string; materials: ServiceMaterial[];
      customerSignatoryName: string; proofs: Proof[];
    }>(draftIdentity).then(draft => {
      if (!mounted) return;
      if (draft) {
        initRef.current = true;
        setStatus(draft.status); setStartedAt(draft.startedAt); setNotes(draft.notes);
        setMaterials(draft.materials); setCustomerSignatoryName(draft.customerSignatoryName);
        setProofs(draft.proofs);
      }
      setDraftReady(true);
    }).catch(err => { if (mounted) setDraftError(localizeError(err, lang)); });
    return () => { mounted = false; };
  }, [draftIdentity, routeScopeKey]);

  useEffect(() => {
    if (!draftReady) return;
    const value = { status, startedAt, notes, materials, customerSignatoryName, proofs };
    const owner = getOfflineQueueScope();
    draftWrites.current = draftWrites.current.catch(() => {})
      .then(() => writeReportDraft(draftIdentity, value, owner))
      .then(() => setDraftError(null), err => { setDraftError(localizeError(err, lang)); throw err; });
    void draftWrites.current.catch(() => {});
  }, [draftReady, draftIdentity, status, startedAt, notes, materials, customerSignatoryName, proofs]);

  useEffect(() => {
    if (draftReady && initialReport?.report && !initRef.current) {
      initRef.current = true;
      setStatus(initialReport.report.status);
      setStartedAt(initialReport.report.startedAt || null);
      setNotes(initialReport.report.notes || "");
      setMaterials(initialReport.materials || []);
      setCustomerSignatoryName(initialReport.report.customerSignatoryName || "");
      setSaveState("synced");
    }
  }, [initialReport, draftReady]);

  useEffect(() => {
    if (!startedAt || status === "submitted" || status === "billing_ready") return;
    const interval = setInterval(() => {
      const ms = Date.now() - new Date(startedAt).getTime();
      setElapsedMin(Math.floor(ms / 60000));
    }, 10000);
    const ms = Date.now() - new Date(startedAt).getTime();
    setElapsedMin(Math.floor(ms / 60000));
    return () => clearInterval(interval);
  }, [startedAt, status]);

  const takePhoto = async () => {
    const permResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permResult.granted) {
      Alert.alert(t("proof.cameraPermissionMissing"), t("proof.cameraEvidenceMessage"));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (!result.canceled && result.assets[0].base64) {
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setProofs((p) => [...p, { type: "photo", data: `data:image/jpeg;base64,${result.assets[0].base64}` }]);
    }
  };

  const handleSignatureSave = (data: string) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setProofs((p) => [...p, { type: "signature", data }]);
    setShowSignaturePad(false);
  };

  const removeProof = (index: number) => {
    setProofs((p) => p.filter((_, i) => i !== index));
  };

  const addMaterial = () => {
    initRef.current = true;
    setMaterials([...materials, { itemCode: "", description: "", quantity: 1, unit: "pcs", unitCost: 0 }]);
  };

  const updateMaterial = (index: number, field: keyof ServiceMaterial, value: string | number) => {
    initRef.current = true;
    const next = [...materials];
    (next[index] as any)[field] = value;
    setMaterials(next);
  };

  const removeMaterial = (index: number) => {
    initRef.current = true;
    setMaterials(materials.filter((_, i) => i !== index));
  };

  const handleStartWork = async () => {
    if (planChanged || !draftReady || draftError) {
      Alert.alert("Kan inte starta", draftError ?? (planChanged ? "Planen har ändrats. Öppna uppdraget från aktuell rutt." : "Vänta tills rapporten har lästs in.")); return;
    }
    const now = new Date().toISOString();
    if (!operatingDriver?.id || !activeRoute || !stop) {
      Alert.alert(t("handoff.updateFailed"), t("routes.noActiveRouteHeader"));
      return;
    }
    const report: PutServiceReportPayload = {
      driverId: operatingDriver.id,
      status: "draft",
      startedAt: now,
      notes,
      materials,
      customerSignatoryName,
    };
    
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (isAssisting && !isOnline) {
      Alert.alert(t("handoff.updateFailed"), "Live assistance requires an online connection. No action was queued.");
      return;
    }
    if (isOnline) {
      try {
        await ensureRouteExecutionForWork(activeRoute.id, activeRoute.planRevision, now);
      } catch (error) {
        Alert.alert(t("handoff.updateFailed"), localizeError(error, lang));
        return;
      }
    }
    // Server refetches must not overwrite a locally edited draft.
    initRef.current = true;
    setStartedAt(now);
    // Update local cache optimistically only after an action is allowed.
    queryClient.setQueryData(["stops", activeRoute?.id], (old: Stop[] | undefined) =>
      old ? old.map((s) => (s.id === stopId ? { ...s, status: "in_progress" } : s)) : old
    );
    let savedLocally = !isOnline;
    if (isOnline) {
      try {
        await api.putServiceReport(stopId, report);
      } catch (error) {
        if (isAssisting || !isRetryableWorkFailure(error)) {
          Alert.alert(t("handoff.updateFailed"), localizeError(error, lang));
          return;
        }
        await enqueueServiceReport(stopId, report);
        savedLocally = true;
      }
      try {
        await api.updateStop(stopId, { status: "in_progress" } as any);
      } catch (error) {
        if (isAssisting || !isRetryableWorkFailure(error)) {
          Alert.alert(t("handoff.updateFailed"), localizeError(error, lang));
          return;
        }
        await enqueueStopStatusUpdate(stopId, "in_progress", activeRoute.planRevision, { routeId: activeRoute.id });
        savedLocally = true;
      }
    } else {
      await enqueueServiceReport(stopId, report);
      await enqueueStopStatusUpdate(stopId, "in_progress", activeRoute.planRevision, { routeId: activeRoute.id });
    }
    setSaveState(savedLocally ? "local" : "synced");
  };

  const handleCompleteWork = async () => {
    if (planChanged) {
      Alert.alert("Planen har ändrats", "Öppna uppdraget från aktuell rutt. Det sparade utkastet har behållit sin ursprungliga planversion."); return;
    }
    if (!draftReady || draftError) {
      Alert.alert("Kunde inte spara", draftError ?? "Vänta tills rapporten har lästs in.");
      return;
    }
    try { await draftWrites.current; } catch (err) {
      Alert.alert("Kunde inte spara", localizeError(err, lang)); return;
    }
    if (!operatingDriver?.id || !activeRoute || !stop) {
      Alert.alert(t("handoff.updateFailed"), t("routes.noActiveRouteHeader"));
      return;
    }
    setSubmitting(true);
    const now = new Date().toISOString();
    const actualDuration = startedAt ? Math.max(1, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)) : 0;
    
    const report: PutServiceReportPayload = {
      driverId: operatingDriver.id,
      status: "billing_ready",
      startedAt: startedAt || now,
      completedAt: now,
      actualDurationMin: actualDuration,
      notes,
      materials,
      customerSignatoryName,
    };

    if (isAssisting && !isOnline) {
      Alert.alert(t("handoff.updateFailed"), "Live assistance requires an online connection. No action was queued.");
      setSubmitting(false);
      return;
    }
    try {
      if (!isOnline) {
        await enqueueServiceReport(stopId, report, proofs.map((p, index) => ({
          type: p.type,
          data: p.data,
          notes: t("service.completionEvidence"),
          clientEventId: `${stopId}_service_proof_${index}_${Date.now()}`,
          planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
          occurredAt: now,
        })));
        await enqueueStopStatusUpdate(
          stopId,
          "completed",
          activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
          { actualDurationMin: actualDuration, comment: notes || undefined },
        );
        
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        
        queryClient.setQueryData(["stops", activeRoute?.id], (old: Stop[] | undefined) =>
          old ? old.map((s) => (s.id === stopId ? { ...s, status: "completed" } : s)) : old
        );
        Alert.alert(t("service.savedLocally"), t("tabs.offline"));
        router.back();
        return;
      }

      // Online
      let sigId: string | undefined;
      const failedProofs: Array<Proof & { clientEventId: string }> = [];
      for (const [index, proof] of proofs.entries()) {
        const clientEventId = `${stopId}_service_proof_${index}_${Date.now()}`;
        try {
          const res = await api.submitProof(stopId, {
            proofType: proof.type,
            proofStage: "delivery",
            data: proof.data,
            notes: t("service.completionEvidence"),
            clientEventId,
            planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
            occurredAt: now,
          });
          if (proof.type === "signature" && res?.id) {
            sigId = res.id;
          }
        } catch (uploadErr) {
          if (isAssisting || !isRetryableWorkFailure(uploadErr)) {
            // Assistance may not complete service while required evidence is
            // unsafely deferred to an offline queue.
            throw uploadErr;
          }
          failedProofs.push({ ...proof, clientEventId });
        }
      }

      if (sigId) report.signatureEvidenceRef = sigId;

      try {
        await api.putServiceReport(stopId, report);
        await api.createStopExecutionEvent(stopId, {
          clientEventId: `${stopId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "completed",
          planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
          occurredAt: now,
          actualDurationMin: actualDuration,
          comment: notes || undefined,
        });
        if (failedProofs.length > 0) {
          await enqueueServiceReport(stopId, report, failedProofs.map((proof, index) => ({
            type: proof.type,
            data: proof.data,
            notes: t("service.completionEvidence"),
            clientEventId: proof.clientEventId,
            planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
            occurredAt: now,
          })));
          Alert.alert(t("service.savedLocally"), t("service.pendingEvidence"));
        }
      } catch (submitErr) {
        if (isAssisting || !isRetryableWorkFailure(submitErr)) {
          Alert.alert(t("handoff.updateFailed"), localizeError(submitErr, lang));
          return;
        }
        // Fallback to queue if it fails but we thought we were online
        await enqueueServiceReport(stopId, report, failedProofs.length > 0 ? failedProofs.map((p, index) => ({
          type: p.type,
          data: p.data,
          notes: t("service.completionEvidence"),
          clientEventId: p.clientEventId,
          planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
          occurredAt: now,
        })) : undefined);
        await enqueueStopStatusUpdate(
          stopId,
          "completed",
          activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
          { actualDurationMin: actualDuration, comment: notes || undefined },
        );
        Alert.alert(t("service.savedLocally"), t("tabs.offline"));
      }
      
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ["stops", activeRoute?.id] });
      queryClient.invalidateQueries({ queryKey: ["routes", routeScopeKey] });
      router.back();

    } catch (err: any) {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t("proof.submissionFailed"), localizeError(err, lang, { fallback: t("proof.submissionFailedMsg") }));
    } finally {
      setSubmitting(false);
    }
  };

  if (reportLoading && !initialReport) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  const isStarted = !!startedAt;

  return (
    <KeyboardAwareScrollViewCompat
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 32 }}
      testID="service-screen"
    >
      {draftError && <Text accessibilityRole="alert" style={{ color: c.danger, padding: 16 }}>{draftError}</Text>}
      {planChanged && <Text accessibilityRole="alert" style={{ color: c.danger, padding: 16 }}>Planen har ändrats. Öppna uppdraget från aktuell rutt.</Text>}
      {/* Header Info */}
      <View style={[styles.section, { backgroundColor: c.surface, borderBottomWidth: 1, borderColor: c.border }]}>
        <Text style={styles.eyebrow}>{t("service.jobDetails")}</Text>
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>
          {stop?.address || t("service.jobDetails")}
        </Text>
        {(routeId || activeRoute?.id) && (
          <Pressable
            onPress={() => router.push({ pathname: "/messages/[routeId]", params: { routeId: routeId || activeRoute!.id, stopId } })}
            style={[styles.stopMessageButton, { borderColor: c.border, backgroundColor: c.surface }]}
          >
            <Feather name="message-circle" size={17} color={c.primary} />
            <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{t("proof.stopMessages")}</Text>
          </Pressable>
        )}
        {stop?.serviceInstructions && (
          <View style={[styles.infoBox, { backgroundColor: c.surfaceSecondary, borderColor: c.border }]}>
            <Feather name="info" size={16} color={c.primary} />
            <Text style={[styles.infoText, { color: c.text, fontFamily: "Inter_400Regular" }]}>
              {stop.serviceInstructions}
            </Text>
          </View>
        )}
      </View>

      {/* Action Row */}
      <View style={styles.section}>
        {!isStarted ? (
          <Pressable
            onPress={handleStartWork}
            style={({ pressed }) => [styles.primaryBtn, { backgroundColor: c.primary, opacity: pressed ? 0.8 : 1 }]}
            testID="start-work-btn"
          >
            <Feather name="play" size={20} color="#FFF" />
            <Text style={[styles.primaryBtnText, { fontFamily: "Inter_600SemiBold" }]}>{t("service.startWork")}</Text>
          </Pressable>
        ) : (
          <View style={[styles.statusRow, { backgroundColor: c.primary + "15", borderColor: c.primary + "30" }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Feather name="clock" size={20} color={c.primary} />
              <View>
                <Text style={{ fontSize: 13, color: c.primary, fontFamily: "Inter_500Medium" }}>{t("service.inProgress")}</Text>
                <Text style={{ fontSize: 16, color: c.text, fontFamily: "Inter_700Bold" }}>{elapsedMin} {t("common.min")}</Text>
              </View>
            </View>
            {(!isOnline || saveState !== "idle") && (
              <View
                style={{
                  backgroundColor: saveState === "synced" ? c.success + "20" : c.warning + "20",
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 12,
                }}
                testID="service-save-state"
              >
                <Text
                  style={{
                    fontSize: 11,
                    color: saveState === "synced" ? c.success : c.warning,
                    fontFamily: "Inter_600SemiBold",
                  }}
                >
                  {saveState === "synced" ? t("service.synced") : t("service.savedLocally")}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {isStarted && status !== "submitted" && status !== "billing_ready" && (
        <>
          {/* Notes */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>{t("service.notes")}</Text>
            <TextInput
              style={[styles.input, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular", minHeight: 100 }]}
              value={notes}
              onChangeText={(value) => { initRef.current = true; setNotes(value); }}
              placeholder={t("service.notesPlaceholder")}
              placeholderTextColor={c.textTertiary}
              multiline
              textAlignVertical="top"
              testID="service-notes-input"
            />
          </View>

          {/* Materials */}
          <View style={styles.section}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>{t("service.materials")}</Text>
              <Pressable onPress={addMaterial} style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]} testID="add-material-btn">
                <Text style={{ color: c.primary, fontFamily: "Inter_500Medium", fontSize: 14 }}>+ {t("service.addMaterial")}</Text>
              </Pressable>
            </View>
            
            {materials.map((mat, idx) => (
              <View key={idx} style={[styles.materialRow, { borderColor: c.border }]} testID={`material-row-${idx}`}>
                <View style={{ flex: 1, gap: 8 }}>
                  <TextInput
                    style={[styles.input, { borderColor: c.border, color: c.text }]}
                    value={mat.description}
                    onChangeText={(val) => updateMaterial(idx, "description", val)}
                    placeholder={t("service.description")}
                    testID={`material-desc-${idx}`}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderColor: c.border, color: c.text }]}
                      value={mat.itemCode}
                      onChangeText={(val) => updateMaterial(idx, "itemCode", val)}
                      placeholder={t("service.code")}
                      testID={`material-code-${idx}`}
                    />
                    <TextInput
                      style={[styles.input, { width: 60, borderColor: c.border, color: c.text }]}
                      value={String(mat.quantity)}
                      onChangeText={(val) => updateMaterial(idx, "quantity", parseInt(val) || 0)}
                      keyboardType="numeric"
                      placeholder={t("service.qty")}
                      testID={`material-qty-${idx}`}
                    />
                  </View>
                </View>
                <Pressable onPress={() => removeMaterial(idx)} style={{ padding: 8 }} testID={`remove-material-${idx}`}>
                  <Feather name="trash-2" size={20} color={c.danger} />
                </Pressable>
              </View>
            ))}
          </View>

          {/* Signatory & Proof */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>{t("service.customerSignatory")}</Text>
            <TextInput
              style={[styles.input, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" }]}
              value={customerSignatoryName}
              onChangeText={(value) => { initRef.current = true; setCustomerSignatoryName(value); }}
              placeholder={t("service.customerSignatory")}
              placeholderTextColor={c.textTertiary}
              testID="customer-signatory-input"
            />

            <View style={styles.captureRow}>
              <Pressable
                onPress={takePhoto}
                style={({ pressed }) => [styles.captureBtn, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.85 : 1 }]}
                testID="capture-photo-btn"
              >
                <Feather name="camera" size={20} color={c.primary} />
                <Text style={[styles.captureBtnText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>{t("service.capturePhotos")}</Text>
              </Pressable>

              <Pressable
                onPress={() => setShowSignaturePad(true)}
                style={({ pressed }) => [styles.captureBtn, { backgroundColor: c.primary + "10", borderColor: c.primary + "20", opacity: pressed ? 0.85 : 1 }]}
                testID="capture-signature-btn"
              >
                <Feather name="edit-3" size={24} color={c.primary} />
                <Text style={[styles.captureBtnText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>{t("service.signHere")}</Text>
              </Pressable>
            </View>

            {showSignaturePad && (
              <SignaturePad
                onSave={handleSignatureSave}
                onCancel={() => setShowSignaturePad(false)}
              />
            )}

            {proofs.length > 0 && (
              <View style={{ gap: 12, marginTop: 12 }}>
                {proofs.map((proof, idx) => (
                  <View key={idx} style={[styles.proofItem, { backgroundColor: c.surface, borderColor: c.border }]} testID={`proof-item-${idx}`}>
                    {proof.type === "photo" ? (
                      <Image source={{ uri: proof.data }} style={styles.proofThumb} />
                    ) : (
                      <View style={[styles.proofIcon, { backgroundColor: c.primary + "15" }]}>
                        <Feather name="edit-3" size={20} color={c.primary} />
                      </View>
                    )}
                    <View style={styles.proofInfo}>
                      <Text style={[styles.proofType, { color: c.text, fontFamily: "Inter_500Medium" }]}>
                        {proof.type === "photo" ? t("proof.photo") : t("proof.signature")}
                      </Text>
                    </View>
                    <Pressable onPress={() => removeProof(idx)} testID={`remove-proof-${idx}`}>
                      <Feather name="x" size={20} color={c.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Submit */}
          <View style={[styles.section, { paddingBottom: 40 }]}>
            <Pressable
              onPress={handleCompleteWork}
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: c.success, opacity: pressed || submitting ? 0.8 : 1 }
              ]}
              testID="complete-work-btn"
            >
              {submitting ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <>
                  <Feather name="check-circle" size={20} color="#FFF" />
                  <Text style={[styles.primaryBtnText, { fontFamily: "Inter_600SemiBold" }]}>{t("service.completeWork")}</Text>
                </>
              )}
            </Pressable>
          </View>
        </>
      )}

      {(status === "submitted" || status === "billing_ready") && (
        <View style={styles.centered}>
          <View style={[styles.successCircle, { backgroundColor: c.success }]}>
            <Feather name="check" size={40} color="#FFF" />
          </View>
          <Text style={[{ fontSize: 20, color: c.text, fontFamily: "Inter_600SemiBold", marginTop: 16 }]}>
            {t("routes.completed")}
          </Text>
        </View>
      )}
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  section: { marginHorizontal: 20, marginTop: 12, padding: 16, gap: 16, borderRadius: 18, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.surface },
  eyebrow: { fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Colors.light.textSecondary, fontFamily: "Inter_700Bold" },
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6 },
  stopMessageButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10 },
  infoBox: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
  infoText: { flex: 1, fontSize: 14, lineHeight: 20 },
  primaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 18, borderRadius: 14 },
  primaryBtnText: { color: "#FFF", fontSize: 16 },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderRadius: 14, borderWidth: 1 },
  sectionTitle: { fontSize: 15, lineHeight: 21 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: "Inter_400Regular", backgroundColor: Colors.light.surface },
  materialRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, borderTopWidth: 1 },
  captureRow: { gap: 10, marginTop: 8 },
  captureBtn: { flexDirection: "row", minHeight: 54, alignItems: "center", justifyContent: "center", paddingVertical: 14, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, gap: 9 },
  captureBtnText: { fontSize: 14 },
  proofItem: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 12, borderWidth: 1, gap: 12 },
  proofThumb: { width: 48, height: 48, borderRadius: 8 },
  proofIcon: { width: 48, height: 48, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  proofInfo: { flex: 1 },
  proofType: { fontSize: 15 },
  successCircle: { width: 80, height: 80, borderRadius: 40, alignItems: "center", justifyContent: "center" },
});
