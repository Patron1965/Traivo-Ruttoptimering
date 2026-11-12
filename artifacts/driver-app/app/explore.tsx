import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, Platform, Switch } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";

const c = Colors.light;

/* Visningsläge: all data below is synthetic and kept only in component state.
   No API calls, storage, permissions, uploads or operational navigation. */

type DemoStatus = "pending" | "completed" | "failed";
interface DemoStop {
  id: string;
  seq: number;
  address: string;
  window: string;
  minutes: number;
  note?: string;
  kind: "delivery" | "service";
  x: number; // schematic map position 0-1
  y: number;
}
const DEMO_STOPS: DemoStop[] = [
  { id: "d1", seq: 1, address: "Exempelgatan 4, Exempelstad", window: "08:00–09:00", minutes: 10, kind: "delivery", note: "Exempel: lämna vid bakre entrén.", x: 0.15, y: 0.75 },
  { id: "d2", seq: 2, address: "Provvägen 12, Exempelstad", window: "09:15–10:00", minutes: 25, kind: "service", note: "Exempel: kontrollera filter enligt checklista.", x: 0.35, y: 0.4 },
  { id: "d3", seq: 3, address: "Testallén 7, Exempelby", window: "10:30–11:30", minutes: 8, kind: "delivery", x: 0.6, y: 0.6 },
  { id: "d4", seq: 4, address: "Övningstorget 1, Exempelby", window: "12:30–13:30", minutes: 15, kind: "delivery", note: "Exempel: portkod finns i riktiga uppdrag.", x: 0.82, y: 0.25 },
];

type Tab = "route" | "map" | "messages" | "settings";
interface Msg { id: string; from: "driver" | "office"; text: string; time: string }
const START_MSGS: Msg[] = [
  { id: "m1", from: "office", text: "Exempelmeddelande från trafikledningen: kom ihåg rast efter stopp 2.", time: "07:42" },
];
const STATUS_META: Record<DemoStatus, { label: string; color: string; icon: keyof typeof Feather.glyphMap }> = {
  pending: { label: "Väntar", color: c.textTertiary, icon: "clock" },
  completed: { label: "Genomfört (exempel)", color: c.success, icon: "check-circle" },
  failed: { label: "Kunde inte genomföras (exempel)", color: c.danger, icon: "x-circle" },
};

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("route");
  const [status, setStatus] = useState<Record<string, DemoStatus>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [proof, setProof] = useState<Record<string, { photo: boolean; signature: boolean }>>({});
  const [msgs, setMsgs] = useState<Msg[]>(START_MSGS);
  const [draft, setDraft] = useState("");
  const [haptics, setHaptics] = useState(true);

  const st = (id: string): DemoStatus => status[id] ?? "pending";
  const nextStop = DEMO_STOPS.find((s) => st(s.id) === "pending");
  const doneCount = DEMO_STOPS.filter((s) => st(s.id) !== "pending").length;

  const reset = () => {
    setStatus({}); setProof({}); setMsgs(START_MSGS); setDraft(""); setOpenId(null); setTab("route");
    setHaptics(true);
  };
  const exit = () => {
    if (router.canGoBack()) router.back();
    else router.replace(user ? "/(tabs)" : "/login");
  };
  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    const now = new Date();
    const time = now.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    setMsgs((m) => [...m, { id: `l${now.getTime()}`, from: "driver", text, time }]);
    setDraft("");
  };

  const open = openId ? DEMO_STOPS.find((s) => s.id === openId) : null;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.banner} testID="demo-banner" accessibilityRole="alert">
        <View style={styles.demoPill}><Text style={styles.demoPillText}>DEMO</Text></View>
        <Text style={styles.bannerText} numberOfLines={2}>
          Visningsläge – exempeldata. Inget skickas eller sparas.
        </Text>
        <Pressable onPress={reset} testID="demo-reset" accessibilityLabel="Återställ exempel" style={styles.bannerBtn}>
          <Feather name="rotate-ccw" size={16} color={c.text} />
        </Pressable>
        <Pressable onPress={exit} testID="demo-exit" accessibilityLabel="Avsluta visningsläge" style={styles.bannerBtn}>
          <Feather name="x" size={18} color={c.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        {open ? (
          <StopDetail
            stop={open}
            status={st(open.id)}
            proof={proof[open.id] ?? { photo: false, signature: false }}
            onProof={(k) => setProof((p) => ({ ...p, [open.id]: { ...(p[open.id] ?? { photo: false, signature: false }), [k]: true } }))}
            onStatus={(s) => setStatus((p) => ({ ...p, [open.id]: s }))}
            onBack={() => setOpenId(null)}
          />
        ) : tab === "route" ? (
          <>
            <Text style={styles.title}>Exempelrutt</Text>
            <Text style={styles.sub}>Påhittad tur med {DEMO_STOPS.length} stopp · {doneCount}/{DEMO_STOPS.length} klara</Text>
            <View style={styles.progress}><View style={[styles.progressFill, { width: `${(doneCount / DEMO_STOPS.length) * 100}%` }]} /></View>
            {DEMO_STOPS.map((s) => {
              const meta = STATUS_META[st(s.id)];
              const active = nextStop?.id === s.id;
              return (
                <Pressable key={s.id} testID={`demo-stop-${s.id}`} onPress={() => setOpenId(s.id)}
                  style={({ pressed }) => [styles.card, active && styles.cardActive, pressed && { opacity: 0.8 }]}>
                  {active && <Text style={styles.nextLabel}>NÄSTA STOPP</Text>}
                  <View style={styles.row}>
                    <View style={[styles.badge, active && { backgroundColor: c.primaryDark }]}>
                      {s.kind === "service"
                        ? <Feather name="tool" size={15} color={active ? c.surface : c.primaryDark} />
                        : <Text style={[styles.badgeText, active && { color: c.surface }]}>{s.seq}</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.addr}>{s.address}</Text>
                      <Text style={styles.meta}>{s.window} · {s.minutes} min</Text>
                      {st(s.id) !== "pending" && (
                        <View style={[styles.row, { marginTop: 4, gap: 5 }]}>
                          <Feather name={meta.icon} size={13} color={meta.color} />
                          <Text style={[styles.meta, { color: meta.color, marginTop: 0 }]}>{meta.label}</Text>
                        </View>
                      )}
                    </View>
                    <Feather name="chevron-right" size={20} color={c.textTertiary} />
                  </View>
                </Pressable>
              );
            })}
            {!nextStop && <Info icon="check-circle" text="Alla exempelstopp är hanterade. Tryck på återställ för att börja om." />}
          </>
        ) : tab === "map" ? (
          <>
            <Text style={styles.title}>Kartöversikt</Text>
            <Text style={styles.sub}>Schematisk exempelkarta – inte en riktig karta eller position.</Text>
            <View style={styles.map} testID="demo-map">
              {DEMO_STOPS.slice(1).map((s, i) => {
                const a = DEMO_STOPS[i];
                const dx = (s.x - a.x) * 300, dy = (s.y - a.y) * 260;
                const len = Math.sqrt(dx * dx + dy * dy);
                const ang = Math.atan2(dy, dx);
                return <View key={`l${s.id}`} style={[styles.line, {
                  width: len, left: a.x * 300 + dx / 2 - len / 2, top: a.y * 260 + dy / 2,
                  transform: [{ rotate: `${ang}rad` }] }]} />;
              })}
              {DEMO_STOPS.map((s) => {
                const col = st(s.id) === "completed" ? c.success : st(s.id) === "failed" ? c.danger : nextStop?.id === s.id ? c.primaryDark : c.textTertiary;
                return (
                  <Pressable key={s.id} onPress={() => setOpenId(s.id)} testID={`demo-pin-${s.id}`}
                    style={[styles.pin, { backgroundColor: col, left: s.x * 300 - 15, top: s.y * 260 - 15 }]}>
                    <Text style={styles.pinText}>{s.seq}</Text>
                  </Pressable>
                );
              })}
              <Text style={styles.mapLabel}>SCHEMATISK EXEMPELKARTA</Text>
            </View>
            <Info icon="info" text="I riktiga uppdrag visas vägbaserad rutt och navigering öppnas endast för verifierade adresser. Här öppnas aldrig navigering." />
          </>
        ) : tab === "messages" ? (
          <>
            <Text style={styles.title}>Meddelanden</Text>
            <Text style={styles.sub}>Utkast stannar på enheten och försvinner när du lämnar visningsläget.</Text>
            {msgs.map((m) => (
              <View key={m.id} style={[styles.bubble, m.from === "driver" ? styles.bubbleMe : styles.bubbleThem]}>
                <Text style={[styles.bubbleText, m.from === "driver" && { color: c.surface }]}>{m.text}</Text>
                <Text style={[styles.bubbleTime, m.from === "driver" && { color: c.surface + "CC" }]}>
                  {m.time}{m.from === "driver" ? " · Endast lokalt, ej skickat" : ""}
                </Text>
              </View>
            ))}
            <View style={styles.composer}>
              <TextInput value={draft} onChangeText={setDraft} placeholder="Skriv ett exempelmeddelande" testID="demo-draft"
                placeholderTextColor={c.textTertiary} style={styles.input} multiline />
              <Pressable onPress={sendDraft} disabled={!draft.trim()} testID="demo-send"
                accessibilityLabel="Lägg till lokalt" style={[styles.sendBtn, !draft.trim() && { opacity: 0.5 }]}>
                <Feather name="send" size={18} color={c.surface} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>Inställningar</Text>
            <View style={styles.section}>
              <View style={styles.row}>
                <View style={styles.avatar}><Feather name="user" size={24} color={c.primary} /></View>
                <View><Text style={styles.addr}>Exempelförare</Text><Text style={styles.meta}>Ingen riktig profil</Text></View>
              </View>
            </View>
            <View style={styles.section}>
              <View style={styles.prefRow}>
                <Text style={styles.prefLabel}>Vibration (simulerat val)</Text>
                <Switch value={haptics} onValueChange={setHaptics} trackColor={{ false: c.border, true: c.primary + "80" }} thumbColor={haptics ? c.primary : c.surface} />
              </View>
              <View style={styles.prefRow}>
                <Text style={styles.prefLabel}>Språk</Text>
                <Text style={styles.meta}>Svenska i visningsläget</Text>
              </View>
              <Text style={styles.meta}>Ingen vibration aktiveras här. I riktiga appens inställningar finns svenska och engelska. Visningsläget ändrar inte dina inställningar.</Text>
            </View>
            <Pressable onPress={reset} style={styles.outlineBtn} testID="demo-reset-settings">
              <Feather name="rotate-ccw" size={17} color={c.primaryDark} />
              <Text style={[styles.btnText, { color: c.primaryDark }]}>Återställ exempelförlopp</Text>
            </Pressable>
            <Pressable onPress={exit} style={[styles.outlineBtn, { borderColor: c.danger + "40", backgroundColor: c.danger + "10" }]}>
              <Feather name="log-out" size={17} color={c.danger} />
              <Text style={[styles.btnText, { color: c.danger }]}>{user ? "Tillbaka till appen" : "Tillbaka till inloggning"}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <View style={[styles.tabBar, { paddingBottom: Platform.OS === "web" ? 34 : Math.max(insets.bottom, 8) }]}>
        {([
          ["route", "list", "Rutt"], ["map", "map", "Karta"], ["messages", "message-square", "Meddelanden"], ["settings", "settings", "Inställningar"],
        ] as const).map(([k, icon, label]) => {
          const on = tab === k && !open;
          return (
            <Pressable key={k} testID={`demo-tab-${k}`} onPress={() => { setOpenId(null); setTab(k); }} style={styles.tabItem}>
              <Feather name={icon} size={21} color={on ? c.primary : c.tabIconDefault} />
              <Text style={[styles.tabLabel, { color: on ? c.primary : c.tabIconDefault }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Info({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  return (
    <View style={styles.info}>
      <Feather name={icon} size={16} color={c.info} />
      <Text style={styles.infoText}>{text}</Text>
    </View>
  );
}

function StopDetail({ stop, status, proof, onProof, onStatus, onBack }: {
  stop: DemoStop; status: DemoStatus; proof: { photo: boolean; signature: boolean };
  onProof: (k: "photo" | "signature") => void; onStatus: (s: DemoStatus) => void; onBack: () => void;
}) {
  const meta = STATUS_META[status];
  return (
    <>
      <Pressable onPress={onBack} style={[styles.row, { gap: 6, marginBottom: 12 }]} testID="demo-stop-back">
        <Feather name="arrow-left" size={18} color={c.primaryDark} />
        <Text style={[styles.btnText, { color: c.primaryDark }]}>Alla exempelstopp</Text>
      </Pressable>
      <Text style={styles.title}>Stopp {stop.seq}</Text>
      <Text style={styles.addrLarge}>{stop.address}</Text>
      <View style={styles.timeGrid}>
        <View style={styles.timeCell}><Text style={styles.timeLabel}>Tidsfönster</Text><Text style={styles.timeValue}>{stop.window}</Text></View>
        <View style={styles.timeCell}><Text style={styles.timeLabel}>Stopptid</Text><Text style={styles.timeValue}>{stop.minutes} min</Text></View>
        <View style={styles.timeCell}><Text style={styles.timeLabel}>Typ</Text><Text style={styles.timeValue}>{stop.kind === "service" ? "Service" : "Leverans"}</Text></View>
      </View>
      {stop.note && (
        <View style={styles.note}><Text style={styles.noteLabel}>Stoppnotis</Text><Text style={styles.noteText}>{stop.note}</Text></View>
      )}
      <View style={[styles.quickBtn, { marginTop: 14 }]}>
        <Feather name="navigation" size={18} color={c.textTertiary} />
        <Text style={[styles.btnText, { color: c.textTertiary }]}>Navigering avstängd i visningsläge</Text>
      </View>

      <Text style={styles.sectionTitle}>Bevis (simulerat)</Text>
      <View style={styles.section}>
        <ProofRow done={proof.photo} icon="camera" title="Foto" testID="demo-proof-photo"
          desc="I riktiga uppdrag tas ett foto med kameran. Här används ingen kamera och inget laddas upp."
          onPress={() => onProof("photo")} />
        <ProofRow done={proof.signature} icon="edit-3" title="Signatur" testID="demo-proof-signature"
          desc="Mottagaren signerar på skärmen i riktiga uppdrag. Här markeras bara ett exempel."
          onPress={() => onProof("signature")} />
      </View>

      {status === "pending" ? (
        <View style={[styles.row, { gap: 8, marginTop: 4 }]}>
          <Pressable onPress={() => onStatus("completed")} testID="demo-complete" style={[styles.mainBtn, { flex: 1 }]}>
            <Feather name="check" size={20} color={c.surface} />
            <Text style={[styles.btnText, { color: c.surface, fontSize: 16 }]}>Genomfört</Text>
          </Pressable>
          <Pressable onPress={() => onStatus("failed")} testID="demo-failed" style={styles.failBtn}>
            <Feather name="x" size={18} color={c.danger} />
            <Text style={[styles.btnText, { color: c.danger }]}>Ej genomfört</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.section, { borderColor: meta.color + "55" }]}>
          <View style={[styles.row, { gap: 8 }]}>
            <Feather name={meta.icon} size={20} color={meta.color} />
            <Text style={[styles.addr, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Text style={styles.meta}>Simulerat lokalt. Ingenting har skickats till servern.</Text>
          <Pressable onPress={() => onStatus("pending")} style={styles.outlineBtn} testID="demo-undo">
            <Feather name="rotate-ccw" size={16} color={c.primaryDark} />
            <Text style={[styles.btnText, { color: c.primaryDark }]}>Ångra exempel</Text>
          </Pressable>
        </View>
      )}
    </>
  );
}

function ProofRow({ done, icon, title, desc, onPress, testID }: {
  done: boolean; icon: keyof typeof Feather.glyphMap; title: string; desc: string; onPress: () => void; testID: string;
}) {
  return (
    <View style={[styles.row, { gap: 12, alignItems: "flex-start" }]}>
      <View style={[styles.badge, done && { backgroundColor: c.success + "22" }]}>
        <Feather name={done ? "check" : icon} size={16} color={done ? c.success : c.primaryDark} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.addr}>{title}</Text>
        <Text style={styles.meta}>{done ? "Exempel markerat – ingen bild eller signatur finns." : desc}</Text>
      </View>
      {!done && (
        <Pressable onPress={onPress} testID={testID} style={styles.smallBtn}>
          <Text style={[styles.btnText, { color: c.primaryDark, fontSize: 13 }]}>Simulera</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.accent + "26", borderBottomWidth: 1, borderBottomColor: c.accent + "66", paddingHorizontal: 12, paddingVertical: 8 },
  demoPill: { backgroundColor: c.accent, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  demoPillText: { fontFamily: "Inter_700Bold", fontSize: 11, color: c.text, letterSpacing: 1 },
  bannerText: { flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 13, color: c.text },
  bannerBtn: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: c.surface },
  title: { fontFamily: "Inter_700Bold", fontSize: 28, color: c.text },
  sub: { fontFamily: "Inter_400Regular", fontSize: 14, color: c.textSecondary, marginTop: 4, marginBottom: 12 },
  progress: { height: 6, borderRadius: 3, backgroundColor: c.border, marginBottom: 16, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: c.primary },
  card: { backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 14, marginBottom: 10 },
  cardActive: { borderWidth: 2, borderColor: c.primaryDark },
  nextLabel: { fontFamily: "Inter_700Bold", fontSize: 11, letterSpacing: 1.2, color: c.primaryDark, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.primary + "18", alignItems: "center", justifyContent: "center" },
  badgeText: { fontFamily: "Inter_700Bold", fontSize: 15, color: c.primaryDark },
  addr: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: c.text },
  addrLarge: { fontFamily: "Inter_700Bold", fontSize: 19, color: c.text, marginTop: 4 },
  meta: { fontFamily: "Inter_500Medium", fontSize: 13, color: c.textSecondary, marginTop: 2 },
  info: { flexDirection: "row", gap: 8, backgroundColor: c.info + "12", borderRadius: 12, padding: 12, marginTop: 12 },
  infoText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 13, color: c.text, lineHeight: 18 },
  map: { width: 300, height: 260, alignSelf: "center", backgroundColor: c.surfaceSecondary, borderRadius: 16, borderWidth: 1, borderColor: c.border, overflow: "hidden" },
  line: { position: "absolute", height: 3, backgroundColor: c.primary + "88", borderRadius: 2 },
  pin: { position: "absolute", width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: c.surface },
  pinText: { fontFamily: "Inter_700Bold", fontSize: 13, color: c.surface },
  mapLabel: { position: "absolute", bottom: 8, left: 10, fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 1, color: c.textTertiary },
  bubble: { maxWidth: "85%", borderRadius: 14, padding: 10, marginBottom: 8 },
  bubbleMe: { alignSelf: "flex-end", backgroundColor: c.primaryDark },
  bubbleThem: { alignSelf: "flex-start", backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  bubbleText: { fontFamily: "Inter_400Regular", fontSize: 15, color: c.text },
  bubbleTime: { fontFamily: "Inter_500Medium", fontSize: 11, color: c.textTertiary, marginTop: 4 },
  composer: { flexDirection: "row", gap: 8, alignItems: "flex-end", marginTop: 8 },
  input: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 10, fontFamily: "Inter_400Regular", fontSize: 15, color: c.text },
  sendBtn: { width: 48, height: 48, borderRadius: 12, backgroundColor: c.primary, alignItems: "center", justifyContent: "center" },
  section: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 16, marginBottom: 16, gap: 14 },
  sectionTitle: { fontFamily: "Inter_600SemiBold", fontSize: 17, color: c.text, marginTop: 20, marginBottom: 8 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.primary + "20", alignItems: "center", justifyContent: "center" },
  prefRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  prefLabel: { fontFamily: "Inter_500Medium", fontSize: 15, color: c.text, flex: 1 },
  langToggle: { flexDirection: "row", borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" },
  langOpt: { paddingHorizontal: 14, paddingVertical: 7 },
  outlineBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.primary + "40", backgroundColor: c.primary + "10", marginBottom: 12 },
  btnText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  timeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  timeCell: { backgroundColor: c.surface, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 10, paddingVertical: 6, minWidth: 96 },
  timeLabel: { fontFamily: "Inter_500Medium", fontSize: 11, color: c.textSecondary },
  timeValue: { fontFamily: "Inter_700Bold", fontSize: 15, color: c.text, marginTop: 1 },
  note: { marginTop: 12, backgroundColor: c.accent + "14", borderLeftWidth: 3, borderLeftColor: c.accent, borderRadius: 8, padding: 10 },
  noteLabel: { fontFamily: "Inter_700Bold", fontSize: 11, color: c.text, textTransform: "uppercase", letterSpacing: 0.6 },
  noteText: { fontFamily: "Inter_400Regular", fontSize: 14, color: c.text, marginTop: 2 },
  quickBtn: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSecondary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  smallBtn: { borderWidth: 1, borderColor: c.primary + "55", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  mainBtn: { minHeight: 56, borderRadius: 14, backgroundColor: c.primaryDark, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  failBtn: { minHeight: 56, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: c.danger + "55", backgroundColor: c.surface, flexDirection: "row", alignItems: "center", gap: 6 },
  tabBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: "center", gap: 2 },
  tabLabel: { fontFamily: "Inter_500Medium", fontSize: 11 },
});
