import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";

interface MapStop {
  id: string;
  latitude: number;
  longitude: number;
  sequence: number | null;
  address: string;
  status: string;
  color: string;
}

interface NativeMapProps {
  stops: MapStop[];
  polylineCoords: { latitude: number; longitude: number }[];
  primaryColor: string;
  bottomPadding: number;
}

export default function NativeMap({ stops }: NativeMapProps) {
  const c = Colors.light;

  return (
    <View style={[styles.container, { paddingTop: 67 }]}>
      <Feather name="map" size={48} color={c.textTertiary} />
      <Text style={[styles.text, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
        Map view available on mobile device
      </Text>
      {stops.length > 0 && (
        <View style={styles.list}>
          {stops.map((stop) => (
            <View
              key={stop.id}
              style={[styles.item, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View style={[styles.badge, { backgroundColor: stop.color + "20" }]}>
                <Text style={[styles.badgeText, { color: stop.color, fontFamily: "Inter_700Bold" }]}>
                  {stop.sequence ?? "?"}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                style={[styles.addr, { color: c.text, fontFamily: "Inter_500Medium" }]}
              >
                {stop.address}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 20,
  },
  text: { fontSize: 16, textAlign: "center" },
  list: { width: "100%", maxWidth: 400, gap: 8, marginTop: 12 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 14 },
  addr: { fontSize: 14, flex: 1 },
});
