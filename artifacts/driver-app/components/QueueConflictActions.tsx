import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Colors from "@/constants/colors";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";
import {
  archiveStopConflicts, retryQueueConflict, getOfflineQueueScope,
  type OfflineQueueItem,
} from "@/lib/offline-queue";
import { conflictStopItems } from "@/lib/queue-conflict-policy";

export function QueueConflictActions({ item, items }: { item: OfflineQueueItem; items: OfflineQueueItem[] }) {
  const { lang } = useT();
  const sv = lang === "sv";
  const c = Colors.light;
  // Bind a rendered confirmation to its original account, not a later sign-in.
  const [owner] = useState(() => getOfflineQueueScope());
  const [selection, setSelection] = useState<OfflineQueueItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const action = async (archive: boolean) => {
    if (!owner || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (archive && selection) await archiveStopConflicts(selection, owner);
      else await retryQueueConflict(item, owner);
      setSelection(null);
      setMessage(sv
        ? archive ? "Arkiverat lokalt – inte skickat." : "Nytt försök köat. Samma rapport skickas efter sessionskontroll."
        : archive ? "Archived locally — not sent." : "Retry queued. The same report will be sent after session verification.");
    } catch {
      setMessage(sv ? "Kön ändrades eller synkning pågår. Vänta ett ögonblick och granska igen." : "The queue changed or sync is running. Wait a moment and review again.");
      setSelection(null);
    } finally {
      setBusy(false);
    }
  };
  const button = (title: string, onPress: () => void, testID: string) => (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: busy }}
      disabled={busy} onPress={onPress}
      style={{ paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8, opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold", fontSize: 13 }}>{title}</Text>
    </Pressable>
  );
  return <View style={{ gap: 8, marginTop: 6 }}>
    <Text style={{ color: c.textSecondary, fontSize: 12 }}>
      {localizeError({ code: item.lastError ?? "generic" }, lang)}
    </Text>
    <Text style={{ color: c.textSecondary, fontSize: 12 }}>
      {new Date(item.timestamp).toLocaleString(sv ? "sv-SE" : "en-GB")}
      {item.queueType === "stopReport" ? ` · ${sv ? { completed: "Genomfört", failed: "Misslyckat", skipped: "Överhoppat" }[item.outcome] : item.outcome} · ${item.proofs.length} ${sv ? "bilagor" : "attachments"}` : ""}
    </Text>
    {selection ? <>
      <Text style={{ color: c.text, fontSize: 13 }}>
        {sv
          ? `Arkivera ${selection.length} osynkade ändringar för detta stopp? De skickas inte till trafikledningen. Original och bilagor sparas lokalt. Redan skickade uppgifter påverkas inte. Övriga stopp kan därefter synkas.`
          : `Archive ${selection.length} unsynced changes for this stop? They will not be sent to dispatch. Originals and attachments remain on this device. Already sent data is unchanged. Other stops can then sync.`}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button(sv ? "Avbryt" : "Cancel", () => setSelection(null), "cancel-conflict-archive")}
        {button(sv ? "Bekräfta arkivering" : "Confirm archive", () => void action(true), "confirm-conflict-archive")}
      </View>
    </> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {button(sv ? "Försök igen" : "Retry", () => void action(false), "retry-conflict")}
      {"stopId" in item && item.stopId && button(sv ? "Arkivera för stoppet" : "Archive stop changes",
        () => { setMessage(null); setSelection(conflictStopItems(items, item)); }, "review-conflict-archive")}
    </View>}
    {message && <Text accessibilityRole="alert" style={{ color: c.textSecondary, fontSize: 13 }}>{message}</Text>}
  </View>;
}
