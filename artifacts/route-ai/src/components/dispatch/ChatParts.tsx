import { useRef } from "react";
import { AlertCircle, CheckCheck, Check, Loader2, Send, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { DELIVERY_LABEL, formatChatTime, type DeliveryState } from "@/lib/chat-display";

export interface ChatRow {
  key: string;
  own: boolean;
  sender: string;
  body: string;
  createdAt: string;
  /** Only set for own messages, and for incoming stop messages already read by the viewer. */
  delivery?: DeliveryState;
  error?: string;
  onRetry?: () => void;
}

function DeliveryLine({ state, error, onRetry }: { state: DeliveryState; error?: string; onRetry?: () => void }) {
  const icon = state === "sending" ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
    : state === "failed" ? <AlertCircle className="h-2.5 w-2.5" />
    : state === "queued" ? <WifiOff className="h-2.5 w-2.5" />
    : state === "read" ? <CheckCheck className="h-2.5 w-2.5" />
    : <Check className="h-2.5 w-2.5" />;
  return (
    <div className={cn("mt-1 flex flex-wrap items-center justify-end gap-1 text-[9.5px] font-medium",
      state === "failed" ? "text-destructive" : state === "read" ? "text-primary" : "text-muted-foreground")}
      data-testid={`status-chat-delivery-${state}`}>
      {icon}
      <span>{DELIVERY_LABEL[state]}</span>
      {state === "failed" && error && <span className="basis-full text-right font-normal">{error}</span>}
      {state === "failed" && onRetry && (
        <button type="button" onClick={onRetry} data-testid="button-retry-chat-message"
          className="ml-1 rounded border border-destructive/40 px-1.5 py-0.5 font-semibold text-destructive hover:bg-destructive/10">
          Försök igen
        </button>
      )}
    </div>
  );
}

export function ChatMessageList({ rows, empty, expanded }: { rows: ChatRow[]; empty: string; expanded?: boolean }) {
  return (
    <div className={cn("space-y-2 overflow-y-auto px-2.5 py-2.5", expanded ? "max-h-[min(62vh,620px)]" : "max-h-64")}
      aria-live="polite" data-testid="list-chat-messages">
      {rows.length === 0 ? (
        <p className="py-4 text-center text-[11px] text-muted-foreground">{empty}</p>
      ) : rows.map((m) => (
        <div key={m.key} className={cn("flex", m.own ? "justify-end" : "justify-start")}>
          <div className={cn("max-w-[88%] rounded-xl border px-2.5 py-1.5 text-[12px] shadow-[0_1px_0_hsl(var(--border)/0.5)]",
            m.own
              ? "rounded-br-sm border-primary/30 bg-primary/10 text-foreground"
              : "rounded-bl-sm border-border bg-card text-foreground")}
            data-testid={m.own ? "bubble-chat-own" : "bubble-chat-incoming"}>
            <div className={cn("mb-0.5 flex items-baseline gap-1.5 text-[10px]", m.own ? "justify-end" : "justify-start")}>
              <span className={cn("font-semibold", m.own ? "text-primary" : "text-foreground")} data-testid="text-chat-sender">{m.sender}</span>
              <time dateTime={m.createdAt} className="tabular-nums text-muted-foreground" title="Svensk tid">
                {formatChatTime(m.createdAt)}
              </time>
            </div>
            <p className="whitespace-pre-wrap break-words leading-snug">{m.body}</p>
            {m.delivery && <DeliveryLine state={m.delivery} error={m.error} onRetry={m.onRetry} />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatComposer({ value, onChange, onSend, sending, placeholder, label, testId }: {
  value: string; onChange: (v: string) => void; onSend: () => void; sending: boolean;
  placeholder: string; label: string; testId: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <form className="flex items-end gap-1.5 border-t border-border bg-muted/10 p-2"
      onSubmit={(e) => { e.preventDefault(); onSend(); ref.current?.focus(); }}>
      <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} rows={2} maxLength={4000}
        placeholder={placeholder} aria-label={placeholder} data-testid={`input-${testId}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); }
        }}
        className="min-h-10 flex-1 resize-none rounded border border-input bg-background px-2 py-1.5 text-[12px] leading-snug outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
      <button type="submit" disabled={!value.trim() || sending} aria-label={label} data-testid={`button-send-${testId}`}
        className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        Skicka
      </button>
    </form>
  );
}
