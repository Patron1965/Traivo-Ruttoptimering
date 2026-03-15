import React, { useState, useRef } from "react";
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
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, router } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { api } from "@/lib/api";

type ProofType = "photo" | "signature" | "barcode";

interface Proof {
  type: ProofType;
  data: string;
  notes?: string;
}

export default function ProofScreen() {
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const c = Colors.light;
  const insets = useSafeAreaInsets();
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [barcodeValue, setBarcodeValue] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const takePhoto = async () => {
    const permResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permResult.granted) {
      const libResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libResult.granted) return;
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
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setProofs((p) => [...p, { type: "photo", data: `data:image/jpeg;base64,${result.assets[0].base64}` }]);
    }
  };

  const addBarcode = () => {
    if (!barcodeValue.trim()) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setProofs((p) => [...p, { type: "barcode", data: barcodeValue.trim() }]);
    setBarcodeValue("");
  };

  const removeProof = (index: number) => {
    setProofs((p) => p.filter((_, i) => i !== index));
  };

  const submitAll = async () => {
    if (!stopId || proofs.length === 0) return;
    setSubmitting(true);
    try {
      for (const proof of proofs) {
        await api.submitProof(stopId, {
          proofType: proof.type,
          data: proof.data,
          notes: notes || undefined,
        });
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSubmitted(true);
      setTimeout(() => router.back(), 1200);
    } catch (err: any) {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Submission Failed", err?.message || "Could not submit proofs. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <View style={[styles.successCircle, { backgroundColor: c.success }]}>
          <Feather name="check" size={40} color="#FFF" />
        </View>
        <Text style={[styles.successText, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
          Proofs Submitted
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
          Capture Evidence
        </Text>

        <View style={styles.captureRow}>
          <Pressable
            onPress={takePhoto}
            style={({ pressed }) => [
              styles.captureBtn,
              { backgroundColor: c.info + "15", borderColor: c.info + "30", opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="camera" size={24} color={c.info} />
            <Text style={[styles.captureBtnText, { color: c.info, fontFamily: "Inter_600SemiBold" }]}>
              Photo
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              Alert.alert("Coming Soon", "Signature capture will be available in a future update.");
            }}
            style={({ pressed }) => [
              styles.captureBtn,
              { backgroundColor: c.primary + "10", borderColor: c.primary + "20", opacity: pressed ? 0.85 : 0.6 },
            ]}
          >
            <Feather name="edit-3" size={24} color={c.primary} />
            <Text style={[styles.captureBtnText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
              Signature
            </Text>
            <Text style={{ fontSize: 10, color: c.textTertiary, fontFamily: "Inter_400Regular" }}>
              Coming soon
            </Text>
          </Pressable>
        </View>

        <View style={styles.barcodeRow}>
          <TextInput
            style={[styles.barcodeInput, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" }]}
            value={barcodeValue}
            onChangeText={setBarcodeValue}
            placeholder="Enter barcode..."
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
      </View>

      {proofs.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            Collected ({proofs.length})
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
                  {proof.type === "photo" ? "Photo" : proof.type === "barcode" ? "Barcode" : "Signature"}
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
          Notes (optional)
        </Text>
        <TextInput
          style={[styles.notesInput, { borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" }]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Add delivery notes..."
          placeholderTextColor={c.textTertiary}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      <Pressable
        onPress={submitAll}
        disabled={proofs.length === 0 || submitting}
        style={({ pressed }) => [
          styles.submitBtn,
          {
            backgroundColor: proofs.length === 0 ? c.textTertiary : c.primary,
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
              Submit {proofs.length} Proof{proofs.length !== 1 ? "s" : ""}
            </Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  successCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  successText: { fontSize: 20 },
  section: {
    padding: 20,
    gap: 12,
  },
  sectionTitle: { fontSize: 17 },
  captureRow: {
    flexDirection: "row",
    gap: 12,
  },
  captureBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
  },
  captureBtnText: { fontSize: 14 },
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
    paddingVertical: 16,
    borderRadius: 14,
  },
  submitBtnText: { fontSize: 16, color: "#FFF" },
});
