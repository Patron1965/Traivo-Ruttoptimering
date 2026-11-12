import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createRouteMessage,
  getListRouteMessagesQueryKey,
  useListRouteMessages,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { localizeError } from "@/lib/localize-error";
import {
  patchPending, prunePending, scopeKeyFor, senderLabel, upsertPending, visiblePending,
} from "@/lib/chat-display";
import { updatePendingChat, usePendingChat } from "@/lib/chat-pending-store";
import { ChatComposer, ChatMessageList, type ChatRow } from "./ChatParts";

function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `route-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const drafts = new Map<string, string>();

/**
 * Route-wide chat (the driver app's chat opened without a stop). Only the
 * selected route is fetched. The API has no read receipts for route messages,
 * so "Läst" is never shown here.
 */
export function RouteMessageThread({ routeId, readOnly = false, className, expanded = false, recipientLabel, active = true }: {
  routeId: string; readOnly?: boolean; className?: string; expanded?: boolean; recipientLabel?: string;
  /** Hidden threads do not poll. */
  active?: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canWrite = !readOnly && user?.role !== "viewer";
  const scopeKey = `${user?.id ?? "anon"}|${scopeKeyFor("route", routeId)}`;
  const [input, setInputState] = useState(() => drafts.get(scopeKey) ?? "");
  const activeScopeRef = useRef(scopeKey);
  const allPending = usePendingChat();

  const setInput = (v: string) => { drafts.set(activeScopeRef.current, v); setInputState(v); };

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    setInputState(drafts.get(scopeKey) ?? "");
  }, [scopeKey]);

  const { data, error, isLoading, isFetching, refetch } = useListRouteMessages(routeId, undefined, {
    query: {
      queryKey: getListRouteMessagesQueryKey(routeId),
      enabled: Boolean(user && routeId),
      refetchInterval: active ? 10_000 : false,
      refetchOnWindowFocus: active,
    },
  });

  const server = useMemo(() => (data?.messages ?? []).filter((m) => m.routeId === routeId), [data, routeId]);

  useEffect(() => {
    updatePendingChat((cur) => prunePending(cur, scopeKey, server.map((m) => m.clientMessageId)));
  }, [server, scopeKey]);

  const scopePending = visiblePending(allPending, scopeKey, server.map((m) => m.clientMessageId));
  const isSending = scopePending.some((p) => p.status === "sending");

  const send = async (body: string, clientMessageId = newClientMessageId()) => {
    const trimmed = body.trim();
    if (!trimmed || !canWrite || !user) return;
    const sentScope = scopeKey;
    const sentRoute = routeId;
    if (allPending.some((p) => p.scopeKey === sentScope && p.status === "sending")) return;
    updatePendingChat((cur) => upsertPending(cur, {
      scopeKey: sentScope, clientMessageId, body: trimmed, createdAt: new Date().toISOString(), status: "sending",
    }));
    if (activeScopeRef.current === sentScope) setInput("");
    try {
      await createRouteMessage(sentRoute, { body: trimmed, clientMessageId });
    } catch (cause) {
      updatePendingChat((cur) => patchPending(cur, clientMessageId, {
        status: "failed", error: localizeError(cause, t, { fallbackKey: "stopMessages.sendError" }),
      }));
      return;
    }
    // The POST succeeded: the message is stored. A failing refresh must not turn it into an error.
    updatePendingChat((cur) => patchPending(cur, clientMessageId, { status: "saved", error: undefined }));
    if (activeScopeRef.current === sentScope) void refetch();
  };

  const rows: ChatRow[] = [
    ...server.map((m) => {
      const own = m.authorId === user?.id;
      return {
        key: m.id, own, sender: senderLabel({ own, name: m.authorName }),
        body: m.body, createdAt: m.createdAt, delivery: own ? ("saved" as const) : undefined,
      };
    }),
    ...scopePending.map((p) => ({
      key: p.clientMessageId, own: true, sender: "Du", body: p.body, createdAt: p.createdAt,
      delivery: p.status, error: p.error,
      onRetry: p.status === "failed" ? () => void send(p.body, p.clientMessageId) : undefined,
    })),
  ];

  if (!user) return null;

  return (
    <section className={cn("overflow-hidden", className)} data-testid="route-message-thread">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 truncate">
          Gäller hela rutten{recipientLabel ? ` · till ${recipientLabel}` : ""}.
          {(data?.messages.length ?? 0) >= 200 && " Visar de 200 senaste."}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {isFetching && !isLoading && <Loader2 className="h-3 w-3 animate-spin" aria-label="Uppdaterar" />}
          <button type="button" onClick={() => void refetch()} className="rounded p-1 hover:bg-muted hover:text-foreground"
            aria-label="Uppdatera ruttchatt" title="Uppdatera" data-testid="button-refresh-route-messages">
            <RefreshCw className="h-3 w-3" />
          </button>
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2 px-3 py-3" aria-label="Laddar ruttchatt">
          <div className="h-8 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="ml-auto h-8 w-1/2 animate-pulse rounded-lg bg-primary/10" />
        </div>
      ) : error && !data ? (
        <div className="space-y-2 px-3 py-3 text-xs text-destructive">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>{localizeError(error, t, { fallbackKey: "stopMessages.loadError" })}</p>
          </div>
          <button type="button" onClick={() => void refetch()} data-testid="button-retry-route-messages"
            className="inline-flex min-h-8 items-center gap-1 rounded border border-border px-2 text-[11px] font-medium text-foreground hover:bg-muted">
            <RefreshCw className="h-3 w-3" /> Försök igen
          </button>
        </div>
      ) : (
        <ChatMessageList rows={rows} expanded={expanded} empty="Inga meddelanden för rutten ännu." />
      )}
      {error && data && (
        <p className="border-t border-border px-2.5 py-1 text-[10px] text-destructive" role="status">
          Kunde inte uppdatera listan. Visar senast hämtade.
        </p>
      )}
      {!isLoading && (!canWrite ? (
        <p className="border-t border-border px-2.5 py-2 text-[10px] text-muted-foreground">Endast läsning.</p>
      ) : (
        <ChatComposer value={input} onChange={setInput} onSend={() => void send(input)} sending={isSending}
          placeholder="Meddelande till hela rutten" label="Skicka till rutten" testId="route-message" />
      ))}
    </section>
  );
}
