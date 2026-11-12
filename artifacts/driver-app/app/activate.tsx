import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useT } from "@/lib/i18n";
import { classifyDriverLinkError, parseAccessFragment, parseAccessUrl, type DriverLinkFailure } from "@/lib/driver-link";

// Web: capture the fragment once at module evaluation-time access and strip it
// from the address bar immediately. The token lives only in memory.
let capturedWebToken: string | null | undefined;
function captureWebToken(): string | null {
  if (typeof window === "undefined") return null;
  if (window.location.hash) {
    capturedWebToken = parseAccessFragment(window.location.hash);
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    // Keep Expo's navigation state in sync. Otherwise a later failed render
    // can restore the original fragment from the router's initial location.
    router.replace("/activate");
  }
  return capturedWebToken ?? null;
}

type Phase = { kind: "loading" } | { kind: "error"; failure: DriverLinkFailure | "missing" };

const COPY = {
  sv: {
    loading: "Öppnar din rutt…",
    loadingHint: "Du behöver inte skriva något.",
    invalid: "Länken fungerar inte längre",
    invalidBody: "Länken har gått ut, återkallats eller hör inte till den här telefonens sparade åtkomst. Öppna den i samma webbläsare som tidigare. Kontakta trafikledningen om problemet kvarstår.",
    unavailable: "Mobilåtkomst är inte tillgänglig",
    unavailableBody: "Ditt konto kan inte öppnas med länk just nu. Kontakta din trafikledare.",
    network: "Ingen anslutning",
    networkBody: "Vi kunde inte nå servern och vet inte om länken hann användas. Kontrollera anslutningen och öppna länken från SMS:et igen. Fungerar den inte, be trafikledaren om en ny.",
    notDriver: "Länken gäller inte en chaufför",
    generic: "Något gick fel",
    genericBody: "Försök öppna länken igen eller be din trafikledare om en ny.",
    missing: "Ingen åtkomstlänk hittades",
    missingBody: "Öppna länken direkt från SMS:et från din trafikledare.",
    openApp: "Öppna appen",
    openAppHint: "Redan inloggad på den här telefonen? Fortsätt där du var.",
  },
  en: {
    loading: "Opening your route…",
    loadingHint: "No typing needed.",
    invalid: "This link no longer works",
    invalidBody: "The link has expired, been revoked, or does not match this phone's saved access. Open it in the same browser as before. Contact your dispatcher if the problem persists.",
    unavailable: "Mobile access unavailable",
    unavailableBody: "Your account can't be opened by link right now. Contact your dispatcher.",
    network: "No connection",
    networkBody: "We couldn't reach the server and don't know if the link was used. Check your connection and open the SMS link again. If it fails, ask your dispatcher for a new one.",
    notDriver: "This link is not for a driver",
    generic: "Something went wrong",
    genericBody: "Try opening the link again or ask your dispatcher for a new one.",
    missing: "No access link found",
    missingBody: "Open the link directly from your dispatcher's SMS.",
    openApp: "Open app",
    openAppHint: "Already signed in on this phone? Continue where you left off.",
  },
};

export default function ActivateScreen() {
  const { activateDriverLink, isLoading } = useAuth();
  const { lang } = useT();
  const copy = COPY[lang === "en" ? "en" : "sv"];
  const c = Colors.light;
  const insets = useSafeAreaInsets();
  const topPad = insets.top + 8;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (Platform.OS === "web") captureWebToken();
    if (isLoading) return;
    let active = true;
    (async () => {
      const token = Platform.OS === "web" ? captureWebToken() : parseAccessUrl(await Linking.getInitialURL());
      if (!token) { if (active) setPhase({ kind: "error", failure: "missing" }); return; }
      try {
        // Single-flight per token: strict-mode re-runs share this promise.
        const routeId = await activateDriverLink(token);
        if (active) router.replace({ pathname: "/(tabs)", params: { routeId } });
      } catch (err) {
        if (active) setPhase({ kind: "error", failure: classifyDriverLinkError(err) });
      }
    })();
    return () => { active = false; };
  }, [isLoading]);

  if (phase.kind === "loading") {
    return (
      <View style={[styles.container, { backgroundColor: c.background, paddingTop: topPad }]} testID="activate-loading">
        <ActivityIndicator size="large" color={c.primary} />
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_600SemiBold", marginTop: 20 }]}>{copy.loading}</Text>
        <Text style={[styles.body, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>{copy.loadingHint}</Text>
      </View>
    );
  }

  const f = phase.failure;
  const title = f === "invalid" ? copy.invalid : f === "unavailable" ? copy.unavailable : f === "network" ? copy.network
    : f === "notDriver" ? copy.notDriver : f === "missing" ? copy.missing : copy.generic;
  const body = f === "invalid" ? copy.invalidBody : f === "unavailable" ? copy.unavailableBody : f === "network" ? copy.networkBody
    : f === "missing" ? copy.missingBody : f === "notDriver" ? copy.invalidBody : copy.genericBody;

  return (
    <View style={[styles.container, { backgroundColor: c.background, paddingTop: topPad, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom }]} testID="activate-error">
      <View style={[styles.iconCircle, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Feather name={f === "network" ? "wifi-off" : "link-2"} size={28} color={c.danger} />
      </View>
      <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>{title}</Text>
      <Text style={[styles.body, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>{body}</Text>
      <View style={styles.actions}>
        <Text style={[styles.hint, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>{copy.openAppHint}</Text>
        <Pressable
          testID="activate-open-app"
          onPress={() => router.replace("/")}
          style={({ pressed }) => [styles.button, { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.buttonText, { fontFamily: "Inter_600SemiBold" }]}>{copy.openApp}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  iconCircle: { width: 64, height: 64, borderRadius: 32, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  title: { fontSize: 22, textAlign: "center", marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 22, textAlign: "center", maxWidth: 380 },
  actions: { width: "100%", maxWidth: 420, marginTop: 32, alignItems: "center" },
  hint: { fontSize: 13, textAlign: "center", marginBottom: 10 },
  button: { height: 50, borderRadius: 12, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  buttonText: { color: "#fff", fontSize: 16 },
});
