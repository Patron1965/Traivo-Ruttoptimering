import React, { useState } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";

export function Disclosure({ title, children, initiallyOpen = false }: {
  title: string; children: React.ReactNode; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <View style={s.root}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={s.toggle}>
      <Text style={s.title}>{title}</Text>
      <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.textSecondary} />
    </Pressable>
    {open && <View style={s.content}>{children}</View>}
  </View>;
}
const s = StyleSheet.create({
  root: { borderTopWidth: 1, borderTopColor: Colors.light.border, marginTop: 8 },
  toggle: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text },
  content: { gap: 10, paddingBottom: 12 },
});
