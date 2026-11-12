import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import Colors from "@/constants/colors";
import { useT } from "@/lib/i18n";

export function SyncSummary({ online, pending, conflicts, legacy, error, loaded }: {
  online: boolean; pending: number; conflicts: number; legacy: number; error: string | null; loaded: boolean;
}) {
  const { lang } = useT();
  const sv = lang === "sv";
  const problem = !!error || conflicts > 0 || legacy > 0;
  const waiting = !online || pending > 0 || !loaded;
  const title = !loaded ? (sv ? "Kontrollerar sparade ändringar…" : "Checking saved changes…")
    : problem ? (sv ? "Sparade ändringar behöver kontrolleras" : "Saved changes need attention")
    : pending > 0 ? (sv ? `${pending} ändringar väntar på synkning` : `${pending} changes waiting to sync`)
    : !online ? (sv ? "Offline · inga väntande ändringar" : "Offline · no pending changes")
    : (sv ? "Inga väntande ändringar på enheten" : "No pending changes on this device");
  return <Pressable testID="route-sync-summary" accessibilityRole="button"
    accessibilityLabel={sv ? `${title}. Visa synkstatus` : `${title}. View sync status`}
    onPress={() => router.push("/(tabs)/settings")}
    style={[s.box, { backgroundColor: problem || waiting ? Colors.light.warningSurface : Colors.light.surfaceSecondary }]}>
    <Feather name={problem ? "alert-triangle" : waiting ? "upload-cloud" : "check-circle"} size={19} color={problem || waiting ? Colors.light.warning : Colors.light.primary} />
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.detail}>{!online
        ? (sv ? "Plan och ankomsttider kan vara inaktuella." : "Plan and arrival times may be out of date.")
        : (sv ? "Visa rapporter och synkstatus" : "View reports and sync status")}</Text>
    </View>
    <Feather name="chevron-right" size={17} color={Colors.light.textSecondary} />
  </Pressable>;
}
const s = StyleSheet.create({
  box: { padding: 14, borderRadius: 14, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  title: { color: Colors.light.text, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  detail: { color: Colors.light.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 18 },
});
