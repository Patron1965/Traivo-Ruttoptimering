import React from "react";
import { View, Text, StyleSheet, Pressable, Linking, Alert } from "./native-adapter";
import { Feather, router, useT, availableNavigationApps, buildNavigationUrl, getVerifiedNavigationDestination, navigationAppLabel } from "./native-adapter";

import Colors from "./colors";

type Stop = any;


const c = Colors.light;

type StatusKey = "pending" | "in_progress" | "completed" | "failed" | "skipped";
const STATUS: Record<StatusKey, { color: string; icon: keyof typeof Feather.glyphMap; sv: string; en: string }> = {
  pending: { color: c.textTertiary, icon: "clock", sv: "Väntar", en: "Pending" },
  in_progress: { color: c.warning, icon: "arrow-right-circle", sv: "Pågår", en: "In progress" },
  completed: { color: c.success, icon: "check-circle", sv: "Genomfört", en: "Completed" },
  failed: { color: c.danger, icon: "x-circle", sv: "Kunde inte genomföras", en: "Not completed" },
  skipped: { color: c.warning, icon: "skip-forward", sv: "Hoppades över", en: "Skipped" },
};
const statusOf = (s: string) => STATUS[(s as StatusKey)] ?? STATUS.pending;
const isDoneStatus = (s: string) => s === "completed" || s === "failed" || s === "skipped";

export interface StopCardProps {
  stop: Stop;
  isActive: boolean;
  onStatusUpdate: (id: string, status: string) => void;
  isUpdating: boolean;
  planVersion: number;
  routeId?: string;
  /** Planned start from the route's workday timeline (ISO). Never estimated client-side. */
  plannedAt?: string | null;
}

function hhmm(val: string | null | undefined): string | null {
  if (!val) return null;
  if (val.includes("T")) {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  }
  return val.slice(0, 5);
}

/* ---------- Shared pieces ---------- */

function NextBanner({ label }: { label: string }) {
  return (
    <View style={s.nextBanner}>
      <View style={s.nextDot} />
      <Text style={s.nextBannerText}>{label}</Text>
    </View>
  );
}

function TimeRows({ stop, plannedAt }: { stop: Stop; plannedAt?: string | null }) {
  const { lang } = useT();
  const sv = lang === "sv";
  const win = hhmm(stop.timeWindowStart);
  const winEnd = hhmm(stop.timeWindowEnd);
  const planned = hhmm(plannedAt ?? null);
  const actual = isDoneStatus(stop.status) ? hhmm(stop.completedAt) : null;
  if (!win && !planned && !actual && !stop.serviceDurationMin && !stop.arrival?.estimatedAt) return null;
  return (
    <View style={s.timeGrid}>
      {stop.arrival?.estimatedAt && (
        <View style={s.timeCell}>
          <Text style={s.timeLabel}>{sv ? "Beräknad ankomst" : "Estimated arrival"}</Text>
          <Text style={s.timeValue}>{hhmm(stop.arrival.estimatedAt)}</Text>
          <Text style={s.timeLabel}>
            {stop.arrival.source === "plan_shift" ? "Förskjutning av planerad tid" : "Vägbaserad uppskattning"}
          </Text>
          <Text style={s.timeLabel}>
            Uppdaterad {hhmm(stop.arrival.calculatedAt)} · {stop.arrival.positionAt && Date.now() - Date.parse(stop.arrival.positionAt) > 120_000 ? "Äldre position" : "Senaste position"}
          </Text>
        </View>
      )}
      {!stop.arrival?.estimatedAt && <View style={s.timeCell}><Text style={s.timeLabel}>Beräknad ankomst</Text><Text style={s.timeValue}>Ej tillgänglig</Text></View>}
      {win && (
        <View style={s.timeCell} testID={`stop-time-window-${stop.id}`}>
          <Text style={s.timeLabel}>{sv ? "Kundens tidsfönster" : "Customer window"}</Text>
          <Text style={s.timeValue}>{win}{winEnd ? `–${winEnd}` : ""}</Text>
        </View>
      )}
      {planned && (
        <View style={s.timeCell} testID={`stop-planned-time-${stop.id}`}>
          <Text style={s.timeLabel}>{sv ? "Planerad tid" : "Planned"}</Text>
          <Text style={s.timeValue}>{planned}</Text>
        </View>
      )}
      {actual && (
        <View style={s.timeCell}>
          <Text style={s.timeLabel}>{sv ? "Faktisk tid" : "Actual"}</Text>
          <Text style={s.timeValue}>{actual}</Text>
        </View>
      )}
      {!!stop.serviceDurationMin && (
        <View style={s.timeCell}>
          <Text style={s.timeLabel}>{sv ? "Stopptid" : "Duration"}</Text>
          <Text style={s.timeValue}>{stop.serviceDurationMin} min</Text>
        </View>
      )}
    </View>
  );
}

function NoteBlock({ label, text }: { label: string; text: string }) {
  return (
    <View style={s.note}>
      <Text style={s.noteLabel}>{label}</Text>
      <Text style={s.noteText}>{text}</Text>
    </View>
  );
}

/** Navigation + contact quick actions. Navigation only for verified destinations. */
function QuickActions({ stop }: { stop: Stop }) {
  const { lang } = useT();
  const sv = lang === "sv";
  const destination = getVerifiedNavigationDestination(stop);
  const email = stop.contactEmail?.trim();

  const openNavigation = () => {
    if (!destination) return;
    const apps = availableNavigationApps();
    const open = (app: (typeof apps)[number]) =>
      Linking.openURL(buildNavigationUrl(app, destination)).catch(() =>
        Alert.alert(sv ? "Kunde inte öppna navigering" : "Could not open navigation"),
      );
    if (apps.length === 1) return void open(apps[0]);
    Alert.alert(sv ? "Navigera med" : "Navigate with", destination.address, [
      ...apps.map((app) => ({ text: navigationAppLabel(app), onPress: () => void open(app) })),
      { text: sv ? "Avbryt" : "Cancel", style: "cancel" as const },
    ]);
  };

  return (
    <View style={s.quickRow}>
      <Pressable
        onPress={openNavigation}
        disabled={!destination}
        accessibilityRole="button"
        testID={`navigate-stop-${stop.id}`}
        style={({ pressed }) => [s.quickBtn, s.quickBtnPrimary, !destination && s.quickBtnDisabled, pressed && s.pressed]}
      >
        <Feather name="navigation" size={18} color={destination ? c.primaryDark : c.textTertiary} />
        <Text style={[s.quickText, { color: destination ? c.primaryDark : c.textTertiary }]}>
          {destination ? (sv ? "Navigera" : "Navigate") : (sv ? "Adress ej verifierad" : "Address not verified")}
        </Text>
      </Pressable>
      {email ? (
        <Pressable
          onPress={() => Linking.openURL(`mailto:${email}`).catch(() => {})}
          accessibilityRole="button"
          accessibilityLabel={sv ? `Kontakta ${stop.contactName ?? email}` : `Contact ${stop.contactName ?? email}`}
          testID={`contact-stop-${stop.id}`}
          style={({ pressed }) => [s.quickBtn, pressed && s.pressed]}
        >
          <Feather name="mail" size={18} color={c.text} />
          <Text style={s.quickText}>{sv ? "Kontakta" : "Contact"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ContactLine({ stop }: { stop: Stop }) {
  if (!stop.contactName && !stop.contactEmail) return null;
  return (
    <View style={s.contactRow}>
      <Feather name="user" size={13} color={c.textSecondary} />
      <Text style={s.contactText} numberOfLines={1}>
        {[stop.contactName, stop.contactEmail].filter(Boolean).join(" · ")}
      </Text>
    </View>
  );
}

function SkipBtn({ onPress, disabled, id }: { onPress: () => void; disabled: boolean; id: string }) {
  const { lang } = useT();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={lang === "sv" ? "Hoppa över" : "Skip"}
      testID={`skip-stop-${id}`}
      style={({ pressed }) => [s.iconBtn, { borderColor: c.warning + "55" }, (pressed || disabled) && s.pressed]}
    >
      <Feather name="skip-forward" size={20} color={c.warning} />
    </Pressable>
  );
}

function openProof(stop: Stop, routeId: string | undefined, planVersion: number, step: "pickup" | "delivery", outcome?: "completed" | "failed") {
  router.push({
    pathname: "/proof/[stopId]",
    params: { stopId: stop.id, routeId, planVersion, step, ...(outcome ? { outcome } : {}) },
  });
}

function ReportButtons({ stop, routeId, planVersion, onSkip, isUpdating }: {
  stop: Stop; routeId?: string; planVersion: number; onSkip: () => void; isUpdating: boolean;
}) {
  const { lang } = useT();
  const sv = lang === "sv";
  return (
    <View style={s.actionRow}>
      <Pressable
        onPress={() => openProof(stop, routeId, planVersion, "delivery", "completed")}
        testID={`report-completed-${stop.id}`}
        style={({ pressed }) => [s.mainBtn, { backgroundColor: c.primaryDark }, pressed && s.pressed]}
      >
        <Feather name="check" size={20} color={c.surface} />
        <Text style={s.mainBtnText}>{sv ? "Genomfört" : "Completed"}</Text>
      </Pressable>
      <Pressable
        onPress={() => openProof(stop, routeId, planVersion, "delivery", "failed")}
        testID={`report-failed-${stop.id}`}
        accessibilityLabel={sv ? "Kunde inte genomföras" : "Could not complete"}
        style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
      >
        <Feather name="x" size={18} color={c.danger} />
        <Text style={[s.secondaryText, { color: c.danger }]} numberOfLines={1}>{sv ? "Ej genomfört" : "Not done"}</Text>
      </Pressable>
      <SkipBtn id={stop.id} onPress={onSkip} disabled={isUpdating} />
    </View>
  );
}

function CardShell({ stop, isActive, done, children, testID }: {
  stop: Stop; isActive: boolean; done: boolean; children: React.ReactNode; testID?: string;
}) {
  const { lang } = useT();
  return (
    <View
      testID={testID ?? `stop-card-${stop.id}`}
      style={[s.card, isActive && s.cardActive, done && s.cardDone]}
    >
      {isActive && <NextBanner label={lang === "sv" ? "Nästa stopp" : "Next stop"} />}
      <View style={isActive ? s.activeBody : undefined}>{children}</View>
    </View>
  );
}

function Header({ badge, title, done, status, isActive, tag }: {
  badge: React.ReactNode; title: string; done: boolean; status: string; isActive: boolean; tag?: React.ReactNode;
}) {
  const { lang } = useT();
  const cfg = statusOf(status);
  return (
    <View style={s.header}>
      <View style={[s.badge, isActive && s.badgeActive, done && { backgroundColor: cfg.color + "1F" }]}>{badge}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.address, isActive && s.addressActive, done && s.addressDone]} numberOfLines={isActive ? 3 : 2}>
          {title}
        </Text>
        {done && (
          <View style={s.statusLine}>
            <Feather name={cfg.icon} size={13} color={cfg.color} />
            <Text style={[s.statusText, { color: cfg.color }]}>{lang === "sv" ? cfg.sv : cfg.en}</Text>
          </View>
        )}
      </View>
      {tag}
    </View>
  );
}

/* ---------- Cards ---------- */

export function StopCard({ stop, isActive, onStatusUpdate, isUpdating, planVersion, routeId, plannedAt }: StopCardProps) {
  const { lang } = useT();
  const done = isDoneStatus(stop.status);
  const fg = isActive ? c.surface : done ? statusOf(stop.status).color : c.primaryDark;
  return (
    <CardShell stop={stop} isActive={isActive} done={done}>
      <Header
        isActive={isActive}
        done={done}
        status={stop.status}
        title={stop.address}
        badge={<Text style={[s.badgeText, { color: fg }]}>{stop.sequenceOrder ?? "?"}</Text>}
      />
      {!done || isActive ? <TimeRows stop={stop} plannedAt={plannedAt} /> : null}
      {!done && <ContactLine stop={stop} />}
      {!done && stop.notes && <NoteBlock label={lang === "sv" ? "Stoppnotis" : "Stop note"} text={stop.notes} />}
      {isActive && !done && (
        <>
          <QuickActions stop={stop} />
          <ReportButtons
            stop={stop}
            routeId={routeId}
            planVersion={planVersion}
            isUpdating={isUpdating}
            onSkip={() => onStatusUpdate(stop.id, "skipped")}
          />
        </>
      )}
    </CardShell>
  );
}

export function ServiceStopCard({ stop, isActive, onStatusUpdate, isUpdating, routeId, plannedAt }: StopCardProps) {
  const { t, lang } = useT();
  const sv = lang === "sv";
  const done = isDoneStatus(stop.status);
  const fg = isActive ? c.surface : done ? statusOf(stop.status).color : c.primaryDark;
  const chips = [...(stop.requiredSkills ?? []), ...(stop.requiredEquipment ?? [])];
  return (
    <CardShell stop={stop} isActive={isActive} done={done} testID={`service-card-${stop.id}`}>
      <Header
        isActive={isActive}
        done={done}
        status={stop.status}
        title={stop.address}
        badge={<Feather name="tool" size={16} color={fg} />}
        tag={stop.priority !== null && stop.priority !== undefined ? (
          <View style={[s.tag, { backgroundColor: (stop.priority <= 2 ? c.danger : c.primary) + "18" }]}>
            <Text style={[s.tagText, { color: stop.priority <= 2 ? c.danger : c.primaryDark }]}>P{stop.priority}</Text>
          </View>
        ) : undefined}
      />
      {!done && (
        <>
          {(stop.serviceCategory || stop.slaDeadline) && (
            <Text style={s.metaLine}>
              {[stop.serviceCategory, stop.slaDeadline ? `SLA ${stop.slaDeadline.slice(0, 5)}` : null].filter(Boolean).join(" · ")}
            </Text>
          )}
          <TimeRows stop={stop} plannedAt={plannedAt} />
          <ContactLine stop={stop} />
          {stop.serviceInstructions && (
            <NoteBlock label={sv ? "Stoppspecifik instruktion" : "Stop-specific instruction"} text={stop.serviceInstructions} />
          )}
          {stop.notes && stop.notes !== stop.serviceInstructions && (
            <NoteBlock label={sv ? "Stoppnotis" : "Stop note"} text={stop.notes} />
          )}
          {chips.length > 0 && (
            <View style={s.chipRow}>
              {chips.map((label, i) => (
                <View key={`${label}-${i}`} style={s.chip}><Text style={s.chipText}>{label}</Text></View>
              ))}
            </View>
          )}
        </>
      )}
      {isActive && !done && (
        <>
          <QuickActions stop={stop} />
          <View style={s.actionRow}>
            <Pressable
              onPress={() => router.push({ pathname: "/service/[stopId]", params: { stopId: stop.id, routeId } })}
              style={({ pressed }) => [s.mainBtn, { backgroundColor: c.primaryDark }, pressed && s.pressed]}
              testID={`open-service-job-${stop.id}`}
            >
              <Feather name="tool" size={20} color={c.surface} />
              <Text style={s.mainBtnText}>{t("routes.openJob")}</Text>
            </Pressable>
            <SkipBtn id={stop.id} onPress={() => onStatusUpdate(stop.id, "skipped")} disabled={isUpdating} />
          </View>
        </>
      )}
    </CardShell>
  );
}

/**
 * Pickup & delivery. Pickup and delivery remain separate steps derived from
 * stop.status: pending = pickup open, in_progress = picked up / delivery open.
 */
export function PdStopCard({ stop, isActive, onStatusUpdate, isUpdating, planVersion, routeId, plannedAt }: StopCardProps) {
  const { t, lang } = useT();
  const sv = lang === "sv";
  const pickupPending = stop.status === "pending";
  const pickupDone = !pickupPending;
  const done = isDoneStatus(stop.status);
  const deliveryOpen = stop.status === "in_progress";
  const finalCfg = statusOf(stop.status);
  const fg = isActive ? c.surface : done ? finalCfg.color : c.primaryDark;

  const step = (n: number, label: string, address: string | null, state: "open" | "current" | "done" | "locked", doneColor: string, doneLabel?: string) => (
    <View style={[s.step, state === "current" && s.stepCurrent, state === "locked" && { opacity: 0.55 }]}>
      <View style={[s.stepNum, state === "done" && { backgroundColor: doneColor }, state === "current" && { backgroundColor: c.primaryDark }]}>
        {state === "done" ? <Feather name="check" size={13} color={c.surface} /> : (
          <Text style={[s.stepNumText, state === "current" && { color: c.surface }]}>{n}</Text>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.stepLabel}>{label}{doneLabel && state === "done" ? ` · ${doneLabel}` : ""}</Text>
        <Text style={[s.stepAddr, state === "done" && { color: c.textSecondary }]} numberOfLines={2}>{address}</Text>
      </View>
    </View>
  );

  return (
    <CardShell stop={stop} isActive={isActive} done={done}>
      <Header
        isActive={isActive}
        done={done}
        status={stop.status}
        title={t("routes.pickupAndDelivery")}
        badge={<Text style={[s.badgeText, { color: fg }]}>{stop.sequenceOrder ?? "?"}</Text>}
        tag={<View style={[s.tag, { backgroundColor: c.primary + "18" }]}><Text style={[s.tagText, { color: c.primaryDark }]}>P&D</Text></View>}
      />
      <View style={s.steps}>
        {step(1, t("routes.pickup"), stop.pickupAddress, pickupDone ? "done" : isActive ? "current" : "open", c.success, t("routes.pickupDone"))}
        <View style={[s.stepLine, pickupDone && { backgroundColor: c.success }]} />
        {step(2, t("routes.delivery"), stop.address, done ? "done" : pickupPending ? "locked" : isActive && deliveryOpen ? "current" : "open", finalCfg.color, sv ? finalCfg.sv : finalCfg.en)}
      </View>
      {!done && <TimeRows stop={stop} plannedAt={plannedAt} />}
      {!done && <ContactLine stop={stop} />}
      {!done && stop.notes && <NoteBlock label={sv ? "Stoppnotis" : "Stop note"} text={stop.notes} />}
      {isActive && !done && (pickupPending ? (
        <View style={s.actionRow}>
          <Pressable
            onPress={() => openProof(stop, routeId, planVersion, "pickup")}
            testID={`pickup-proof-${stop.id}`}
            style={({ pressed }) => [s.secondaryBtn, { borderColor: c.info + "55" }, pressed && s.pressed]}
          >
            <Feather name="camera" size={18} color={c.info} />
            <Text style={[s.secondaryText, { color: c.info }]}>{sv ? "Hämtbevis" : "Pickup proof"}</Text>
          </Pressable>
          <Pressable
            onPress={() => onStatusUpdate(stop.id, "in_progress")}
            disabled={isUpdating}
            testID={`confirm-pickup-${stop.id}`}
            style={({ pressed }) => [s.mainBtn, { backgroundColor: c.primaryDark }, (pressed || isUpdating) && s.pressed]}
          >
            <Feather name="package" size={20} color={c.surface} />
            <Text style={s.mainBtnText}>{t("routes.confirmPickup")}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <QuickActions stop={stop} />
          <ReportButtons
            stop={stop}
            routeId={routeId}
            planVersion={planVersion}
            isUpdating={isUpdating}
            onSkip={() => onStatusUpdate(stop.id, "skipped")}
          />
        </>
      ))}
    </CardShell>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 14, marginBottom: 10, overflow: "hidden" },
  cardActive: { borderWidth: 2, borderColor: c.primaryDark, padding: 0, marginBottom: 16, shadowColor: c.primaryDark, shadowOpacity: 0.14, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  cardDone: { backgroundColor: c.surfaceSecondary, borderColor: c.surfaceSecondary, paddingVertical: 10 },
  activeBody: { padding: 16, gap: 2 },
  nextBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.primaryDark, paddingHorizontal: 16, paddingVertical: 8 },
  nextDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent },
  nextBannerText: { color: c.surface, fontFamily: "Inter_700Bold", fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  badge: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.primary + "18", alignItems: "center", justifyContent: "center" },
  badgeActive: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.primaryDark },
  badgeText: { fontFamily: "Inter_700Bold", fontSize: 15 },
  address: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: c.text, lineHeight: 20 },
  addressActive: { fontSize: 19, lineHeight: 25, fontFamily: "Inter_700Bold" },
  addressDone: { color: c.textSecondary, fontFamily: "Inter_500Medium", fontSize: 14 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  statusText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  tagText: { fontFamily: "Inter_700Bold", fontSize: 11 },
  metaLine: { marginTop: 8, fontFamily: "Inter_500Medium", fontSize: 13, color: c.textSecondary },
  timeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  timeCell: { backgroundColor: c.background, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 10, paddingVertical: 6, minWidth: 96 },
  timeLabel: { fontFamily: "Inter_500Medium", fontSize: 11, color: c.textSecondary },
  timeValue: { fontFamily: "Inter_700Bold", fontSize: 15, color: c.text, marginTop: 1, fontVariant: ["tabular-nums"] },
  contactRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  contactText: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 13, color: c.textSecondary },
  note: { marginTop: 10, backgroundColor: c.accent + "14", borderLeftWidth: 3, borderLeftColor: c.accent, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  noteLabel: { fontFamily: "Inter_700Bold", fontSize: 11, color: c.text, textTransform: "uppercase", letterSpacing: 0.6 },
  noteText: { fontFamily: "Inter_400Regular", fontSize: 14, color: c.text, marginTop: 2, lineHeight: 19 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  chip: { backgroundColor: c.background, borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  chipText: { fontFamily: "Inter_500Medium", fontSize: 11, color: c.textSecondary },
  quickRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  quickBtn: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: c.surface },
  quickBtnPrimary: { flex: 1.4, backgroundColor: c.primary + "14", borderColor: c.primary + "40" },
  quickBtnDisabled: { backgroundColor: c.surfaceSecondary, borderColor: c.border },
  quickText: { fontFamily: "Inter_600SemiBold", fontSize: 14, color: c.text },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "stretch" },
  mainBtn: { flex: 1, minHeight: 56, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  mainBtnText: { color: c.surface, fontFamily: "Inter_700Bold", fontSize: 16 },
  secondaryBtn: { minHeight: 56, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: c.danger + "55", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: c.surface },
  secondaryText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  iconBtn: { width: 56, minHeight: 56, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.surface },
  pressed: { opacity: 0.75 },
  steps: { marginTop: 12 },
  step: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 12, backgroundColor: c.background },
  stepCurrent: { backgroundColor: c.primary + "14", borderWidth: 1, borderColor: c.primary + "55" },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: c.border, alignItems: "center", justifyContent: "center" },
  stepNumText: { fontFamily: "Inter_700Bold", fontSize: 12, color: c.textSecondary },
  stepLabel: { fontFamily: "Inter_600SemiBold", fontSize: 11, color: c.textSecondary, textTransform: "uppercase", letterSpacing: 0.5 },
  stepAddr: { fontFamily: "Inter_500Medium", fontSize: 14, color: c.text, marginTop: 1 },
  stepLine: { width: 2, height: 10, marginLeft: 22, backgroundColor: c.border },
});
