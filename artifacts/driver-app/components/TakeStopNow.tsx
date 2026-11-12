import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { api, ApiError, type Stop } from "@/lib/api";
import { useSelectedRoute } from "@/context/SelectedRouteContext";
import { useAuth } from "@/context/AuthContext";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { getOfflineQueueItems } from "@/lib/offline-queue";
import { localizeError } from "@/lib/error-localizer";
import { useT } from "@/lib/i18n";

export function TakeStopNow({ stop }: { stop: Stop }) {
  const c = Colors.light;
  const { activeRoute, refetchRoutes } = useSelectedRoute();
  const { user, isOfflineRestored } = useAuth();
  const { isOnline } = useNetworkStatus();
  const { lang } = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unavailable = !isOnline || isOfflineRestored
    ? "Kräver uppkoppling. Stoppval sparas aldrig i offlinekön."
    : stop.status !== "pending" ? "Stoppet är redan påbörjat eller hanterat."
      : activeRoute?.handoffStatus !== "accepted" ? "Kvittera det aktuella utskicket först."
        : !activeRoute.executionProjection?.selectionRevision ? "Läs in rutten igen innan du väljer stopp." : null;
  if (user?.role !== "driver") return null;
  const select = async () => {
    if (busy || unavailable || !activeRoute) return;
    setBusy(true); setMessage(null);
    try {
      const queued = await getOfflineQueueItems();
      if (queued.some(item => item.syncStatus !== "synced")) {
        setMessage("Synkronisera väntande rapporter och lös eventuella konflikter innan du byter stopp.");
        return;
      }
      await api.createStopExecutionEvent(stop.id, {
        type: "select_next", planVersion: activeRoute.handoffVersion,
        expectedSelectionRevision: activeRoute.executionProjection!.selectionRevision,
        clientEventId: `select-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        occurredAt: new Date().toISOString(),
      });
      setMessage("Stoppet är valt som nästa mål. Övriga stopp följer planen.");
    } catch (error) {
      let explanation: string | undefined;
      if (error instanceof ApiError && error.status === 409) {
        try {
          const body = JSON.parse(error.body);
          if (body.code === "STOP_SELECTION_BLOCKED") explanation = body.error;
        } catch { /* Non-JSON errors use the regular localizer. */ }
      }
      setMessage(explanation ?? localizeError(error, lang, {
        fallback: "Stoppvalet kunde inte bekräftas. Läs in rutten innan du försöker igen.",
      }));
    } finally {
      // Also reconcile a lost response: never queue or replay a choice.
      await Promise.all([refetchRoutes(), client.invalidateQueries({ queryKey: ["stops"] })]);
      setBusy(false);
    }
  };
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!unavailable || busy }}
      disabled={!!unavailable || busy} onPress={select} testID="take-stop-now"
      style={{ minHeight: 44, justifyContent: "center", opacity: unavailable || busy ? 0.5 : 1 }}>
      <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{busy ? "Bekräftar stoppval…" : "Ta detta stopp nu"}</Text>
    </Pressable>
    <Text style={{ color: c.textSecondary }}>
      {unavailable ?? "Förstastopp, pågående hämtning/leverans, låsta tider och laddning kan blockera byte."}
    </Text>
    {message && <Text accessibilityLiveRegion="polite" style={{ color: c.text }}>{message}</Text>}
  </View>;
}
