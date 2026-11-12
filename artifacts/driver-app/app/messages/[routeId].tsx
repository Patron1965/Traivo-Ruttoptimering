import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Colors from "@/constants/colors";
import { api, type RouteMessage, type StopMessage } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import {
  enqueueRouteMessage, getOfflineQueueScope, getRouteMessageQueue, sameOfflineQueueOwner,
  type OfflineQueueScope, type QueuedRouteMessage,
} from "@/lib/offline-queue";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/error-localizer";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import {
  DELIVERY_LABEL,
  formatChatTime,
  isOpaqueIdentifier,
  messageScopeKey,
  pendingForScope,
  queuedDeliveryState,
  queuedForScope,
  senderLabel,
  serverDeliveryState,
  shouldQueueSendFailure,
  type DeliveryState,
  type LocalPending,
} from "@/lib/message-display";

function newClientMessageId() {
  return `message_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

type MessageView = RouteMessage & {
  stopId?: string;
  senderUserId?: string;
  senderRole?: string;
  readAt?: string | null;
  readReceipts?: Array<{ userId: string; readAt: string }>;
};
type MessagesData = { messages: MessageView[]; nextCursor: string | null };

interface Row {
  key: string;
  own: boolean;
  sender: string;
  body: string;
  createdAt: string;
  delivery?: DeliveryState;
  note?: string;
  onRetry?: () => void;
}

function fromStopMessage(message: StopMessage, routeId: string, stopId: string): MessageView {
  return {
    id: message.id,
    routeId,
    stopId,
    authorId: message.senderUserId,
    authorName: "",
    body: message.body,
    createdAt: message.createdAt,
    clientMessageId: message.clientMessageId,
    senderUserId: message.senderUserId,
    senderRole: message.senderRole,
    readAt: message.readAt,
    readReceipts: message.readReceipts,
  };
}

const messagesKey = (actorId: string | undefined, routeId: string, stopId: string | null) =>
  ["route-messages", actorId ?? "anon", routeId, stopId ?? null] as const;

export default function RouteMessagesScreen() {
  const params = useLocalSearchParams<{ routeId: string; stopId?: string | string[] }>();
  const routeId = Array.isArray(params.routeId) ? params.routeId[0] : params.routeId;
  const paramStopId = Array.isArray(params.stopId) ? params.stopId[0] : params.stopId;
  const { user } = useAuth();
  // Remount per actor + route + entry stop so no chosen stop, draft or pending send leaks across them.
  return <ScopedMessagesScreen key={`${user?.id ?? "anon"}|${routeId}|${paramStopId ?? ""}`} />;
}

function ScopedMessagesScreen() {
  const params = useLocalSearchParams<{ routeId: string; stopId?: string | string[] }>();
  const routeId = Array.isArray(params.routeId) ? params.routeId[0] : params.routeId;
  const paramStopId = Array.isArray(params.stopId) ? params.stopId[0] : params.stopId;
  const { user } = useAuth();
  const { t, lang } = useT();
  const c = Colors.light;
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { isOnline } = useNetworkStatus();
  const { isAssisting, selection } = useDriverAssistance();

  const [chosenStopId, setChosenStopId] = useState<string | null>(paramStopId ?? null);
  const [scope, setScope] = useState<"route" | "stop">(paramStopId ? "stop" : "route");
  const stopId = scope === "stop" ? chosenStopId : null;
  const scopeKey = messageScopeKey(user?.id, routeId, stopId);
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;

  const [drafts, setDrafts] = useState<Record<string, { text: string; clientMessageId: string }>>({});
  const [pending, setPending] = useState<LocalPending[]>([]);
  const [queue, setQueue] = useState<QueuedRouteMessage[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ scopeKey: string; text: string } | null>(null);
  const inputRef = useRef<React.ElementRef<typeof TextInput>>(null);

  const draft = drafts[scopeKey]?.text ?? "";
  const setDraft = (text: string) => setDrafts((cur) => {
    const prev = cur[scopeKey];
    // A new text gets a new clientMessageId; an unchanged draft keeps its id so retries never duplicate.
    const clientMessageId = prev && prev.text.trim() === text.trim() ? prev.clientMessageId : newClientMessageId();
    return { ...cur, [scopeKey]: { text, clientMessageId } };
  });

  const assistOk = !isAssisting || selection?.routeId === routeId;
  const queryKey = messagesKey(user?.id, routeId, stopId);

  const messagesQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<MessagesData> => {
      if (stopId) {
        const result = await api.getStopMessages(stopId);
        return { nextCursor: null, messages: result.messages.map((m) => fromStopMessage(m, routeId, stopId)) };
      }
      return api.getRouteMessages(routeId);
    },
    enabled: !!routeId && !!user && (scope === "route" || !!stopId) && assistOk,
    refetchInterval: 15000,
  });

  const stopsQuery = useQuery({
    queryKey: ["message-context-stops", user?.id ?? "anon", routeId],
    queryFn: () => api.getRouteStops(routeId),
    enabled: !!routeId && !!user && assistOk,
    staleTime: 60_000,
  });
  const routeQuery = useQuery({
    queryKey: ["message-context-route", user?.id ?? "anon", routeId],
    queryFn: () => api.getRoute(routeId),
    enabled: !!routeId && !!user && assistOk,
    staleTime: 60_000,
  });
  const currentStop = stopsQuery.data?.find((s) => s.id === chosenStopId) ?? null;

  const [queueError, setQueueError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const refreshQueue = useCallback(() => {
    const owner = getOfflineQueueScope();
    if (!owner || owner.userId !== user?.id) {
      setQueue([]);
      return;
    }
    getRouteMessageQueue().then((next) => {
      if (!mountedRef.current || !sameOfflineQueueOwner(owner, getOfflineQueueScope())) return;
      setQueue(next);
      setQueueError(null);
    }).catch((error) => {
      if (!mountedRef.current || !sameOfflineQueueOwner(owner, getOfflineQueueScope())) return;
      setQueueError(localizeError(error, lang, { fallback: t("messages.queueFailed") }));
    });
  }, [user?.id, lang, t]);
  useEffect(() => {
    refreshQueue();
    const timer = setInterval(refreshQueue, 4000);
    return () => clearInterval(timer);
  }, [refreshQueue]);

  const serverMessages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data?.messages]);
  const serverIds = useMemo(() => serverMessages.map((m) => m.clientMessageId), [serverMessages]);

  useEffect(() => {
    if (!stopId || !user?.id || !serverMessages.length) return;
    const unreadIds = serverMessages
      .filter((m) => m.readAt == null && m.authorId !== user.id)
      .map((m) => m.id);
    if (!unreadIds.length) return;
    const key = messagesKey(user.id, routeId, stopId);
    api.markStopMessagesRead(stopId, unreadIds).then(() => {
      queryClient.setQueryData<MessagesData>(key, (current) => current
        ? { ...current, messages: current.messages.map((m) => unreadIds.includes(m.id) ? { ...m, readAt: new Date().toISOString() } : m) }
        : current);
    }).catch((error) => setReadError(localizeError(error, lang, { fallback: t("messages.readFailed") })));
  }, [serverMessages, queryClient, routeId, stopId, user?.id, lang, t]);

  const enqueue = async (sent: { routeId: string; stopId: string | null; text: string; clientId: string; owner: OfflineQueueScope | null }) => {
    if (!sent.owner || sent.owner.userId !== user?.id) throw new Error("OFFLINE_QUEUE_OWNER_CHANGED");
    await enqueueRouteMessage({
      routeId: sent.routeId,
      ...(sent.stopId ? { stopId: sent.stopId } : {}),
      body: sent.text,
      clientMessageId: sent.clientId,
      occurredAt: new Date().toISOString(),
    }, sent.owner);
    if (mountedRef.current) refreshQueue();
  };

  const clearDraftIf = (key: string, clientId: string) => setDrafts((cur) => {
    if (cur[key]?.clientMessageId !== clientId) return cur;
    const next = { ...cur };
    delete next[key];
    return next;
  });

  const send = async (retry?: { text: string; clientId: string }) => {
    const sentKey = scopeKey;
    const sentRoute = routeId;
    const sentStop = stopId;
    const actor = user?.id;
    const owner = getOfflineQueueScope();
    const current = drafts[sentKey];
    const text = (retry?.text ?? current?.text ?? "").trim();
    const clientId = retry?.clientId ?? current?.clientMessageId ?? newClientMessageId();
    if (!text || !actor) return;
    if (scope === "stop" && !sentStop) return;
    if (pending.some((p) => p.scopeKey === sentKey && p.status === "sending")) return;
    setNotice(null);
    if (isAssisting && selection?.routeId !== sentRoute) {
      setNotice({ scopeKey: sentKey, text: "Den här rutten är inte längre vald för assistans. Meddelandet skickades inte." });
      return;
    }
    if (!isOnline) {
      if (isAssisting) {
        setNotice({ scopeKey: sentKey, text: "Assistans kräver anslutning. Meddelandet sparades inte i kön." });
        return;
      }
      try {
        await enqueue({ routeId: sentRoute, stopId: sentStop, text, clientId, owner });
        clearDraftIf(sentKey, clientId);
        setPending((cur) => cur.filter((p) => p.clientMessageId !== clientId));
      } catch (error) {
        setNotice({ scopeKey: sentKey, text: localizeError(error, lang, { fallback: t("messages.queueFailed") }) });
      }
      return;
    }

    setPending((cur) => [...cur.filter((p) => p.clientMessageId !== clientId),
      { scopeKey: sentKey, clientMessageId: clientId, body: text, createdAt: new Date().toISOString(), status: "sending" }]);
    try {
      const result = sentStop
        ? await api.createStopMessage(sentStop, { body: text, clientMessageId: clientId })
        : await api.createRouteMessage(sentRoute, { body: text, clientMessageId: clientId });
      const normalized: MessageView = "message" in result
        ? fromStopMessage(result.message, sentRoute, sentStop!)
        : result;
      // Write into the cache of the scope the message was sent from, never the currently visible one.
      queryClient.setQueryData<MessagesData>(messagesKey(actor, sentRoute, sentStop), (cur) => ({
        messages: [...(cur?.messages ?? []).filter((m) => m.clientMessageId !== clientId), normalized],
        nextCursor: cur?.nextCursor ?? null,
      }));
      setPending((cur) => cur.filter((p) => p.clientMessageId !== clientId));
      clearDraftIf(sentKey, clientId);
    } catch (error) {
      if (shouldQueueSendFailure(error) && !isAssisting) {
        try {
          await enqueue({ routeId: sentRoute, stopId: sentStop, text, clientId, owner });
          setPending((cur) => cur.filter((p) => p.clientMessageId !== clientId));
          clearDraftIf(sentKey, clientId);
          return;
        } catch (queueError) {
          error = queueError;
        }
      }
      setPending((cur) => cur.map((p) => p.clientMessageId === clientId
        ? { ...p, status: "failed", error: localizeError(error, lang, { fallback: t("messages.sendFailed") }) }
        : p));
    }
  };

  const rows = useMemo<Row[]>(() => {
    const ownId = user?.id ?? "";
    const isStop = !!stopId;
    const list: Row[] = [
      ...serverMessages.map((m) => {
        const own = (m.senderUserId ?? m.authorId) === ownId;
        return {
          key: m.id || m.clientMessageId || m.createdAt,
          own,
          sender: senderLabel({ own, name: isStop ? null : m.authorName, role: m.senderRole }),
          body: m.body,
          createdAt: m.createdAt,
          delivery: own ? serverDeliveryState(isStop, m.readReceipts, ownId) : undefined,
        };
      }),
      ...queuedForScope(queue, routeId, stopId, serverIds).map((q) => {
        const delivery = queuedDeliveryState(q.syncStatus);
        return {
          key: `q-${q.clientMessageId}`, own: true, sender: "Du", body: q.body, createdAt: q.occurredAt,
          delivery, note: delivery === "failed" ? "Hanteras under Synkkö i inställningar." : undefined,
        };
      }),
      ...pendingForScope(pending, scopeKey, serverIds)
        .filter((p) => !queue.some((q) => q.clientMessageId === p.clientMessageId))
        .map((p) => ({
          key: `p-${p.clientMessageId}`, own: true, sender: "Du", body: p.body, createdAt: p.createdAt,
          delivery: p.status, note: p.error,
          onRetry: p.status === "failed" ? () => void send({ text: p.body, clientId: p.clientMessageId }) : undefined,
        })),
    ];
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMessages, serverIds, queue, pending, scopeKey, routeId, stopId, user?.id]);

  const isSendingHere = pending.some((p) => p.scopeKey === scopeKey && p.status === "sending");
  const needsStopChoice = scope === "stop" && !stopId;
  const canSend = !!draft.trim() && !isSendingHere && !needsStopChoice;
  const stopLine = currentStop
    ? `Stopp ${currentStop.sequenceOrder ?? "–"} · ${currentStop.address}`
    : chosenStopId ? "Valt stopp" : null;
  const headerOffset = Platform.OS === "web" ? 0 : insets.top + (Platform.OS === "ios" ? 44 : 56);

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: c.background }]} behavior="padding" keyboardVerticalOffset={headerOffset}>
      <View style={[styles.context, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.contextRow}>
          <Feather name="send" size={13} color={c.textSecondary} />
          <Text style={[styles.contextText, { color: c.text }]} numberOfLines={1} testID="text-chat-recipient">
            Till trafikledningen{routeQuery.data?.name && !isOpaqueIdentifier(routeQuery.data.name) ? ` · ${routeQuery.data.name}` : ""}
          </Text>
        </View>
        <View style={[styles.segment, { borderColor: c.border, backgroundColor: c.background }]} accessibilityRole="tablist">
          {(["route", "stop"] as const).map((s) => {
            const active = scope === s;
            return (
              <Pressable key={s} onPress={() => setScope(s)} accessibilityRole="tab" accessibilityState={{ selected: active }}
                testID={`tab-chat-${s}`}
                style={[styles.segmentItem, active && { backgroundColor: c.primary }]}>
                <Text style={[styles.segmentText, { color: active ? c.surface : c.textSecondary }]}>
                  {s === "route" ? "Hela rutten" : `Detta stopp${currentStop?.sequenceOrder != null ? ` (${currentStop.sequenceOrder})` : ""}`}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {scope === "stop" && stopLine && (
          <Pressable onPress={() => setChosenStopId(null)} disabled={!!paramStopId} testID="text-chat-stop-context" style={styles.contextRow}>
            <Feather name="map-pin" size={13} color={c.primary} />
            <Text style={[styles.contextText, { color: c.text, fontFamily: "Inter_600SemiBold" }]} numberOfLines={1}>{stopLine}</Text>
            {!paramStopId && <Text style={[styles.small, { color: c.primary }]}>Byt</Text>}
          </Pressable>
        )}
        {scope === "route" && (
          <Text style={[styles.small, { color: c.textSecondary }]}>Gäller hela rutten, inte ett enskilt stopp.</Text>
        )}
      </View>

      {needsStopChoice ? (
        <FlatList
          data={(stopsQuery.data ?? []).slice().sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 12, gap: 6, flexGrow: 1 }}
          ListHeaderComponent={<Text style={[styles.small, { color: c.textSecondary, marginBottom: 4 }]}>Välj vilket stopp meddelandet gäller:</Text>}
          renderItem={({ item }) => (
            <Pressable onPress={() => setChosenStopId(item.id)} testID={`button-chat-choose-stop-${item.id}`}
              style={[styles.stopChoice, { borderColor: c.border, backgroundColor: c.surface }]}>
              <Text style={[styles.stopNum, { color: c.primary }]}>{item.sequenceOrder ?? "–"}</Text>
              <Text style={{ flex: 1, color: c.text, fontFamily: "Inter_400Regular" }} numberOfLines={2}>{item.address}</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Feather name="map-pin" size={28} color={c.textTertiary} />
              <Text style={{ color: c.textSecondary, textAlign: "center", paddingHorizontal: 24 }} testID="text-chat-no-stop">
                {stopsQuery.isLoading ? "Hämtar stopp..." : "Stopplistan är inte tillgänglig just nu. Öppna chatten från ett stopp, eller skriv till hela rutten."}
              </Text>
            </View>
          }
        />
      ) : messagesQuery.isLoading ? (
        <View style={styles.centered}><ActivityIndicator color={c.primary} /></View>
      ) : (
        <FlatList
          data={rows}
          inverted={rows.length > 0}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          scrollEnabled={rows.length > 0}
          contentContainerStyle={{ padding: 14, gap: 10, flexGrow: 1 }}
          renderItem={({ item }) => (
            <View style={[styles.message, item.own
              ? { alignSelf: "flex-end", backgroundColor: c.surfaceSecondary, borderColor: c.primary, borderBottomRightRadius: 4 }
              : { alignSelf: "flex-start", backgroundColor: c.surface, borderColor: c.border, borderBottomLeftRadius: 4 }]}
              testID={item.own ? "bubble-chat-own" : "bubble-chat-incoming"}>
              <View style={styles.meta}>
                <Text style={[styles.sender, { color: item.own ? c.primaryDark : c.text }]}>{item.sender}</Text>
                <Text style={[styles.small, { color: c.textSecondary }]}>{formatChatTime(item.createdAt)}</Text>
              </View>
              <Text style={[styles.body, { color: c.text }]}>{item.body}</Text>
              {item.delivery && (
                <View style={styles.delivery}>
                  <Text style={[styles.small, {
                    color: item.delivery === "failed" ? c.danger : item.delivery === "read" ? c.primary : c.textSecondary,
                    fontFamily: "Inter_600SemiBold",
                  }]} testID={`status-chat-delivery-${item.delivery}`}>
                    {DELIVERY_LABEL[item.delivery]}
                  </Text>
                  {item.onRetry && (
                    <Pressable onPress={item.onRetry} hitSlop={8} testID="button-retry-chat-message" accessibilityLabel="Försök igen">
                      <Feather name="refresh-cw" size={15} color={c.danger} />
                    </Pressable>
                  )}
                </View>
              )}
              {item.note && <Text style={[styles.small, { color: item.delivery === "failed" ? c.danger : c.textSecondary }]}>{item.note}</Text>}
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Feather name="message-circle" size={32} color={c.textTertiary} />
              <Text style={{ color: c.textSecondary }}>{t("messages.empty")}</Text>
            </View>
          }
        />
      )}

      {messagesQuery.isError && !needsStopChoice && (
        <Pressable onPress={() => void messagesQuery.refetch()} style={styles.errorRow}>
          <Text style={[styles.error, { color: c.danger }]}>
            {localizeError(messagesQuery.error, lang, { fallback: t("messages.readFailed") })} Tryck för att försöka igen.
          </Text>
        </Pressable>
      )}
      {queueError && <Text style={[styles.error, { color: c.danger }]}>Kön kunde inte läsas: {queueError}</Text>}
      {readError && <Text style={[styles.error, { color: c.danger }]}>{readError}</Text>}
      {notice && notice.scopeKey === scopeKey && <Text style={[styles.error, { color: c.danger }]}>{notice.text}</Text>}
      {!isOnline && !isAssisting && (
        <Text style={[styles.error, { color: c.warning }]}>Ingen anslutning. Nya meddelanden sparas på telefonen och skickas när anslutningen är tillbaka.</Text>
      )}

      <View style={[styles.composer, {
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 10, backgroundColor: c.surface, borderTopColor: c.border,
      }]}>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={4000}
          editable={!needsStopChoice}
          placeholder={needsStopChoice ? "Välj ett stopp först" : scope === "stop" ? "Meddelande om detta stopp" : "Meddelande till hela rutten"}
          placeholderTextColor={c.textTertiary}
          style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
          testID="input-chat-message"
        />
        <Pressable
          onPress={() => { void send(); inputRef.current?.focus(); }}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Skicka"
          testID="button-send-chat-message"
          style={[styles.send, { backgroundColor: c.primary, opacity: canSend ? 1 : 0.45 }]}
        >
          {isSendingHere ? <ActivityIndicator size="small" color={c.surface} /> : <Feather name="send" size={16} color={c.surface} />}
          <Text style={[styles.sendText, { color: c.surface }]}>Skicka</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  context: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, gap: 8 },
  contextRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  contextText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium" },
  segment: { flexDirection: "row", borderWidth: 1, borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, minHeight: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  segmentText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 24 },
  message: { maxWidth: "84%", paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, borderWidth: 1, gap: 3 },
  meta: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  sender: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  body: { fontSize: 15, lineHeight: 21, fontFamily: "Inter_400Regular" },
  delivery: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  small: { fontSize: 11, fontFamily: "Inter_400Regular" },
  stopChoice: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderRadius: 10, minHeight: 48 },
  stopNum: { width: 28, fontSize: 15, fontFamily: "Inter_700Bold", textAlign: "center" },
  errorRow: { paddingVertical: 2 },
  error: { paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1 },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { height: 44, paddingHorizontal: 14, borderRadius: 22, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  sendText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
