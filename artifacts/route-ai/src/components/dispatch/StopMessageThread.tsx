import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { isStopMessageAwaitingDispatch, localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import {
  patchPending, prunePending, unreadIdsToMark, scopeKeyFor, senderLabel, serverDeliveryState, upsertPending, visiblePending,
} from "@/lib/chat-display";
import { updatePendingChat, usePendingChat } from "@/lib/chat-pending-store";
import { ChatComposer, ChatMessageList, type ChatRow } from "./ChatParts";

interface StopMessageReceipt {
  userId: string;
  readAt: string;
}

interface StopMessage {
  id: string;
  threadId: string;
  senderUserId: string;
  senderRole: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  readReceipts?: StopMessageReceipt[];
}

interface StopMessagesResponse {
  thread: {
    id: string;
    stopId: string;
    driverId: string;
  } | null;
  messages: StopMessage[];
}

interface StopMessageThreadProps {
  stopId: string;
  readOnly?: boolean;
  className?: string;
  expanded?: boolean;
  contextLabel?: string;
  /** Hidden threads neither poll nor send read receipts. */
  active?: boolean;
}

function apiUrl(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/api${path}`;
}

function messageError(response: Response, fallback: string): Promise<never> {
  return response
    .json()
    .catch(() => ({}))
    .then((body: { error?: string }) => {
      const error = body.error
        ? new Error(body.error)
        : new TrustedLocalizedError(fallback);
      Object.assign(error, { status: response.status, data: body });
      throw error;
    });
}

function createClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `stop-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const drafts = new Map<string, string>();

export function StopMessageThread({
  stopId,
  readOnly = false,
  className,
  expanded = false,
  contextLabel,
  active = true,
}: StopMessageThreadProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canWrite = !readOnly && user?.role !== "viewer";
  const scopeKey = `${user?.id ?? "anon"}|${scopeKeyFor("stop", stopId)}`;
  const [input, setInputState] = useState(() => drafts.get(scopeKey) ?? "");
  const [readError, setReadError] = useState<string | null>(null);
  const markedReadRef = useRef(new Set<string>());
  const readingRef = useRef(false);
  const activeScopeRef = useRef(scopeKey);
  const allPending = usePendingChat();

  const setInput = (v: string) => { drafts.set(activeScopeRef.current, v); setInputState(v); };

  const queryKey = ["/api/stops", "messages", user?.organizationId, stopId];
  const {
    data,
    error,
    isLoading,
    isFetching,
    refetch,
  } = useQuery<StopMessagesResponse, Error>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(apiUrl(`/stops/${encodeURIComponent(stopId)}/messages`), {
        credentials: "include",
      });
      if (!response.ok) {
        return messageError(response, t("stopMessages.loadError"));
      }
      const result = await response.json() as StopMessagesResponse;
      if (!result || !Array.isArray(result.messages)) {
        throw new TrustedLocalizedError(t("stopMessages.invalidResponse"));
      }
      return result;
    },
    enabled: Boolean(user?.organizationId && stopId),
    retry: (failureCount, cause) => !isStopMessageAwaitingDispatch(cause) && failureCount < 3,
    refetchInterval: active ? 10000 : false,
    refetchOnWindowFocus: active,
  });

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    setInputState(drafts.get(scopeKey) ?? "");
    markedReadRef.current.clear();
    setReadError(null);
  }, [scopeKey]);

  useEffect(() => {
    if (!data?.messages.length || !user || readingRef.current) return;
    const unreadMessageIds = unreadIdsToMark(data.messages, user.id, markedReadRef.current, active);
    if (unreadMessageIds.length === 0) return;

    const readFor = stopId;
    readingRef.current = true;
    void fetch(apiUrl(`/stops/${encodeURIComponent(readFor)}/messages/read`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: unreadMessageIds }),
    })
      .then(async (response) => {
        if (!response.ok) {
          return messageError(response, t("stopMessages.readError"));
        }
        if (activeScopeRef.current !== scopeKey) return;
        unreadMessageIds.forEach((messageId) => markedReadRef.current.add(messageId));
        setReadError(null);
        await refetch();
      })
      .catch((cause: unknown) => {
        if (activeScopeRef.current === scopeKey) {
          setReadError(localizeError(cause, t, { fallbackKey: "stopMessages.readError" }));
        }
      })
      .finally(() => {
        readingRef.current = false;
      });
  }, [active, data, refetch, stopId, scopeKey, t, user]);

  const server = useMemo(() => data?.messages ?? [], [data]);

  useEffect(() => {
    updatePendingChat((cur) => prunePending(cur, scopeKey, server.map((m) => m.clientMessageId)));
  }, [server, scopeKey]);

  const scopePending = visiblePending(allPending, scopeKey, server.map((m) => m.clientMessageId));
  const isSending = scopePending.some((p) => p.status === "sending");

  const sendMessage = async (body: string, clientMessageId = createClientMessageId()) => {
    const trimmedBody = body.trim();
    if (!trimmedBody || !canWrite || !user) return;
    const sentScope = scopeKey;
    const sentStop = stopId;
    if (allPending.some((p) => p.scopeKey === sentScope && p.status === "sending")) return;
    updatePendingChat((cur) => upsertPending(cur, {
      scopeKey: sentScope, clientMessageId, body: trimmedBody, createdAt: new Date().toISOString(), status: "sending",
    }));
    if (activeScopeRef.current === sentScope) setInput("");

    try {
      const response = await fetch(apiUrl(`/stops/${encodeURIComponent(sentStop)}/messages`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientMessageId, body: trimmedBody }),
      });
      if (!response.ok) {
        await messageError(response, t("stopMessages.sendError"));
      }
    } catch (cause: unknown) {
      updatePendingChat((cur) => patchPending(cur, clientMessageId, {
        status: "failed", error: localizeError(cause, t, { fallbackKey: "stopMessages.sendError" }),
      }));
      return;
    }
    updatePendingChat((cur) => patchPending(cur, clientMessageId, { status: "saved", error: undefined }));
    if (activeScopeRef.current === sentScope) void refetch();
  };

  if (!user) return null;

  const rows: ChatRow[] = [
    ...server.map((message) => {
      const own = message.senderUserId === user.id;
      return {
        key: `${message.clientMessageId}-${message.id}`,
        own,
        sender: senderLabel({ own, role: message.senderRole }),
        body: message.body,
        createdAt: message.createdAt,
        delivery: own ? serverDeliveryState("stop", message.readReceipts, user.id) : undefined,
      };
    }),
    ...scopePending.map((p) => ({
      key: p.clientMessageId, own: true, sender: "Du", body: p.body, createdAt: p.createdAt,
      delivery: p.status, error: p.error,
      onRetry: p.status === "failed" ? () => void sendMessage(p.body, p.clientMessageId) : undefined,
    })),
  ];

  return (
    <section className={cn("overflow-hidden", className)} data-testid="stop-message-thread">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 truncate" data-testid="text-stop-chat-context">
          Gäller endast {contextLabel ?? "detta stopp"}.
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {isFetching && !isLoading && <Loader2 className="h-3 w-3 animate-spin" aria-label={t("stopMessages.refreshing")} />}
          <button type="button" onClick={() => void refetch()} className="rounded p-1 hover:bg-muted hover:text-foreground"
            aria-label={t("stopMessages.refresh")} title={t("stopMessages.refresh")} data-testid="button-refresh-stop-messages">
            <RefreshCw className="h-3 w-3" />
          </button>
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2 px-3 py-3" aria-label={t("stopMessages.loading")}>
          <div className="h-8 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="ml-auto h-8 w-1/2 animate-pulse rounded-lg bg-primary/10" />
        </div>
      ) : isStopMessageAwaitingDispatch(error) ? (
        <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
          {t("stopMessages.awaitingDispatch")}
        </p>
      ) : error && !data ? (
        <div className="space-y-2 px-3 py-3 text-xs text-destructive">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>{localizeError(error, t, { fallbackKey: "stopMessages.loadError" })}</p>
          </div>
          <button
            type="button"
            className="inline-flex min-h-8 items-center gap-1 rounded border border-border px-2 text-[11px] font-medium text-foreground hover:bg-muted"
            onClick={() => void refetch()}
            data-testid="button-retry-stop-messages"
          >
            <RefreshCw className="h-3 w-3" />
            {t("stopMessages.retry")}
          </button>
        </div>
      ) : (
        <>
          <ChatMessageList rows={rows} expanded={expanded} empty={t("stopMessages.empty")} />
          {error && data && (
            <p className="border-t border-border px-2.5 py-1 text-[10px] text-destructive" role="status">
              Kunde inte uppdatera listan. Visar senast hämtade.
            </p>
          )}
          {readError && (
            <p className="border-t border-border px-2.5 py-1.5 text-[10px] text-destructive">
              {readError}
            </p>
          )}
          {!canWrite ? (
            <p className="border-t border-border px-2.5 py-2 text-[10px] text-muted-foreground">
              {t("stopMessages.readOnly")}
            </p>
          ) : (
            <ChatComposer value={input} onChange={setInput} onSend={() => void sendMessage(input)} sending={isSending}
              placeholder={t("stopMessages.placeholder")} label={t("stopMessages.send")} testId="stop-message" />
          )}
        </>
      )}
    </section>
  );
}
