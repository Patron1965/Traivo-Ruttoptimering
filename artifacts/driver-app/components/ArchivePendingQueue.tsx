import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Colors from "@/constants/colors";
import { useT } from "@/lib/i18n";
import { archivePendingQueue, getOfflineQueueScope, type OfflineQueueItem } from "@/lib/offline-queue";

export function ArchivePendingQueue({ items }: { items: OfflineQueueItem[] }) {
  const { lang } = useT();
  const sv = lang === "sv";
  const c = Colors.light;
  const [review, setReview] = useState<{ items: OfflineQueueItem[]; owner: ReturnType<typeof getOfflineQueueScope> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = items.filter(item => item.syncStatus !== "synced");
  const confirm = async () => {
    if (!review?.owner || busy) return;
    setBusy(true);
    try {
      await archivePendingQueue(review.items, review.owner);
      setMessage(sv ? "Kön är arkiverad lokalt, inte skickad. Nya rapporter kan nu synkas." : "Queue archived locally, not sent. New reports can now sync.");
    } catch {
      setMessage(sv ? "Kön ändrades eller synkning pågår. Granska igen om en stund." : "The queue changed or sync is running. Review again shortly.");
    } finally { setBusy(false); setReview(null); }
  };
  const button = (label: string, action: () => void, id: string) => (
    <Pressable testID={id} accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}
      onPress={action} style={{ padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
      <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{label}</Text>
    </Pressable>
  );
  return <View style={{ gap: 8 }}>
    {review ? <>
      <Text style={{ color: c.text }}>{sv
        ? `Arkivera alla ${review.items.length} osynkade ändringar? Rapporter, bilder och meddelanden i denna kö skickas INTE till trafikledningen. Originalen behålls på denna enhet. Redan synkat arbete påverkas inte.`
        : `Archive all ${review.items.length} unsynced changes? Reports, photos and messages in this queue will NOT be sent to dispatch. Originals remain on this device. Synced work is unchanged.`}</Text>
      {button(sv ? "Avbryt" : "Cancel", () => setReview(null), "cancel-queue-archive")}
      {button(sv ? "Bekräfta arkivering av hela kön" : "Confirm archive of entire queue", () => void confirm(), "confirm-queue-archive")}
    </> : pending.length > 0 && button(sv ? "Arkivera hela väntande kön…" : "Archive entire pending queue…",
      () => { setMessage(null); setReview({ items: pending, owner: getOfflineQueueScope() }); }, "review-queue-archive")}
    {message && <Text accessibilityRole="alert" style={{ color: c.textSecondary }}>{message}</Text>}
  </View>;
}
