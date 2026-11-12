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
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";

export default function ResetPasswordScreen() {
  const { token: rawToken } = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const { t, lang } = useT();
  const c = Colors.light;
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token || !password || password !== confirmation || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(localizeError(err, lang, { fallback: t("login.resetInvalid") }));
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
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>{t("login.resetTitle")}</Text>
        {done ? (
          <>
            <Text style={{ color: c.text, fontFamily: "Inter_400Regular" }}>{t("login.resetDone")}</Text>
            <Pressable onPress={() => router.replace("/login")} style={[styles.button, { backgroundColor: c.primary }]}>
              <Text style={styles.buttonText}>{t("login.backToLogin")}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={t("login.resetPassword")}
              placeholderTextColor={c.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
            />
            <TextInput
              value={confirmation}
              onChangeText={setConfirmation}
              placeholder={t("login.resetPasswordConfirm")}
              placeholderTextColor={c.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              onSubmitEditing={submit}
              style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
            />
            {confirmation && password !== confirmation && <Text style={{ color: c.danger }}>{t("login.passwordsDoNotMatch")}</Text>}
            {error && <Text style={{ color: c.danger }}>{error}</Text>}
            <Pressable onPress={submit} disabled={!token || !password || password !== confirmation || submitting} style={[styles.button, { backgroundColor: c.primary, opacity: !token || !password || password !== confirmation || submitting ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.buttonText}>{t("login.resetSubmit")}</Text>}
            </Pressable>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center" },
  content: { width: "100%", maxWidth: 420, paddingHorizontal: 24, gap: 16 },
  title: { fontSize: 28 },
  input: { height: 50, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  button: { height: 52, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 16 },
});