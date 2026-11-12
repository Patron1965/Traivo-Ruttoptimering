import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useAuth, isNotADriverError } from "@/context/AuthContext";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";
import { api, ApiError } from "@/lib/api";

export default function LoginScreen() {
  const { isLoading, login, verifyEmailCode } = useAuth();
  const insets = useSafeAreaInsets();
  const c = Colors.light;
  const { t, lang } = useT();
  const { routeId } = useLocalSearchParams<{ routeId?: string | string[] }>();
  const requestedRouteId = Array.isArray(routeId) ? routeId[0] : routeId;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (submitting || (mfa ? !/^\d{6}$/.test(code) : !email.trim() || !password)) return;
    setError(null);
    setSubmitting(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    try {
      if (mfa) {
        await verifyEmailCode(code);
        setCode("");
      } else if (await login(email, password)) {
        setMfa(true);
        setPassword("");
        return;
      }
      router.replace({
        pathname: "/(tabs)",
        params: requestedRouteId ? { routeId: requestedRouteId } : {},
      });
    } catch (err) {
      if (mfa && err instanceof ApiError && err.status === 401) {
        setError(lang === "sv" ? "Koden är felaktig eller har gått ut. Försök igen eller börja om inloggningen." : "The code is invalid or expired. Try again or restart sign-in.");
      } else if (isNotADriverError(err)) {
        setError(t("login.notADriver"));
      } else {
        setError(localizeError(err, lang, { fallback: t("login.signInFailed") }));
      }
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        styles.container,
        {
          backgroundColor: c.background,
          paddingTop: insets.top + 40,
          paddingBottom: Platform.OS === "web" ? 34 : insets.bottom,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.iconCircle, { backgroundColor: c.primary }]}>
          <Feather name="truck" size={32} color="#FFF" />
        </View>
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>
          {t("login.title")}
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
          {t("login.subtitle")}
        </Text>
      </View>

      <View style={styles.form}>
        {mfa ? (
          <>
            <Text style={[styles.label, { color: c.text }]}>
              {lang === "sv" ? "Ange den sexsiffriga koden från mejlet" : "Enter the six-digit code from your email"}
            </Text>
            <TextInput
              accessibilityLabel={lang === "sv" ? "Engångskod via mejl" : "Email verification code"}
              value={code}
              onChangeText={value => setCode(value.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
              editable={!submitting}
              onSubmitEditing={handleSubmit}
              style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.text }]}
            />
          </>
        ) : (
          <>
        <Text style={[styles.label, { color: c.text, fontFamily: "Inter_500Medium" }]}>
          {t("login.email")}
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder={t("login.emailPlaceholder")}
          placeholderTextColor={c.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!submitting}
          style={[
            styles.input,
            { backgroundColor: c.surface, borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" },
          ]}
        />

        <Text style={[styles.label, { color: c.text, fontFamily: "Inter_500Medium", marginTop: 16 }]}>
          {t("login.password")}
        </Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={t("login.passwordPlaceholder")}
          placeholderTextColor={c.textTertiary}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          editable={!submitting}
          onSubmitEditing={handleSubmit}
          returnKeyType="go"
          style={[
            styles.input,
            { backgroundColor: c.surface, borderColor: c.border, color: c.text, fontFamily: "Inter_400Regular" },
          ]}
        />
          </>
        )}

        {error && (
          <View style={styles.errorRow}>
            <Feather name="alert-circle" size={16} color={c.danger} />
            <Text style={[styles.errorText, { color: c.danger, fontFamily: "Inter_400Regular" }]}>
              {error}
            </Text>
          </View>
        )}

        <Pressable
          onPress={handleSubmit}
          disabled={submitting || (mfa ? code.length !== 6 : !email.trim() || !password)}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: c.primary,
              opacity: submitting || (mfa ? code.length !== 6 : !email.trim() || !password) ? 0.6 : pressed ? 0.9 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={[styles.buttonText, { fontFamily: "Inter_600SemiBold" }]}>
              {mfa ? (lang === "sv" ? "Verifiera och logga in" : "Verify and sign in") : t("login.signIn")}
            </Text>
          )}
        </Pressable>
        {mfa && (
          <>
            {notice && <Text style={{ color: c.textSecondary }}>{notice}</Text>}
            <Pressable disabled={submitting} style={styles.forgotButton} onPress={async () => {
              setSubmitting(true); setError(null); setNotice(null);
              try {
                await api.resendEmailCode();
                setNotice(lang === "sv" ? "En ny kod har begärts. Kontrollera din mejl." : "A new code was requested. Check your email.");
              } catch (err) { setError(localizeError(err, lang)); }
              finally { setSubmitting(false); }
            }}>
              <Text style={{ color: c.primary }}>{lang === "sv" ? "Skicka ny kod" : "Send a new code"}</Text>
            </Pressable>
            <Pressable disabled={submitting} style={styles.forgotButton} onPress={() => {
              setMfa(false); setCode(""); setPassword(""); setNotice(null); setError(null);
            }}>
              <Text style={{ color: c.primary }}>{lang === "sv" ? "Börja om inloggningen" : "Restart sign-in"}</Text>
            </Pressable>
          </>
        )}
        <Pressable
          onPress={() => router.push("/forgot-password")}
          disabled={submitting}
          style={styles.forgotButton}
        >
          <Text style={[styles.forgotText, { color: c.primary, fontFamily: "Inter_500Medium" }]}>
            {t("login.forgotPassword")}
          </Text>
        </Pressable>
        <Pressable testID="login-explore" onPress={() => router.push("/explore")} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12 }}>
          <Feather name="compass" size={16} color={c.primary} />
          <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Utforska appen utan uppdrag</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 32,
    paddingHorizontal: 24,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    textAlign: "center",
  },
  form: {
    width: "100%",
    maxWidth: 420,
    paddingHorizontal: 24,
  },
  label: {
    fontSize: 14,
    marginBottom: 6,
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 14,
  },
  errorText: {
    fontSize: 14,
    flex: 1,
  },
  button: {
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  buttonText: {
    fontSize: 16,
    color: "#FFF",
  },
  forgotButton: {
    alignItems: "center",
    paddingVertical: 16,
  },
  forgotText: {
    fontSize: 14,
  },
});
