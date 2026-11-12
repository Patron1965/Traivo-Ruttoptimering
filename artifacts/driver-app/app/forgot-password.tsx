import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";

export default function ForgotPasswordScreen() {
  const { t, lang } = useT();
  const c = Colors.light;
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(localizeError(err, lang, { fallback: t("login.signInFailed") }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: c.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.content}>
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>{t("login.forgotTitle")}</Text>
        <Text style={[styles.description, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>{t("login.forgotDescription")}</Text>
        {sent ? (
          <View style={[styles.success, { backgroundColor: c.success + "15", borderColor: c.success + "40" }]}>
            <Text style={{ color: c.text, fontFamily: "Inter_500Medium" }}>{t("login.resetSent")}</Text>
          </View>
        ) : (
          <>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={t("login.emailPlaceholder")}
              placeholderTextColor={c.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
            />
            {error && <Text style={{ color: c.danger }}>{error}</Text>}
            <Pressable onPress={submit} disabled={!email.trim() || submitting} style={[styles.button, { backgroundColor: c.primary, opacity: !email.trim() || submitting ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.buttonText}>{t("login.sendReset")}</Text>}
            </Pressable>
          </>
        )}
        <Pressable onPress={() => router.replace("/login")} style={styles.back}>
          <Text style={{ color: c.primary, fontFamily: "Inter_500Medium" }}>{t("login.backToLogin")}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center" },
  content: { width: "100%", maxWidth: 420, paddingHorizontal: 24, gap: 16 },
  title: { fontSize: 28 },
  description: { fontSize: 16, lineHeight: 23 },
  input: { height: 50, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  button: { height: 52, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 16 },
  success: { padding: 14, borderRadius: 10, borderWidth: 1 },
  back: { alignItems: "center", paddingVertical: 12 },
});