import { AppLayout } from "@/components/layout/AppLayout";
import { useTranslation } from "react-i18next";
import { Sparkles, CalendarClock, AlertTriangle, RefreshCw, ClipboardCheck, MessageSquareText, UserCheck } from "lucide-react";

const COPY = {
  sv: {
    title: "AI-stöd",
    status: "Under utveckling",
    ready: "Planerat klart 15 december 2026",
    intro: "AI-stödet är inte tillgängligt ännu. Här beskriver vi vad det är tänkt att hjälpa planerare med när det lanseras.",
    approveTitle: "Planeraren bestämmer alltid",
    approve: "AI-stödet kommer bara att ge förslag och förklaringar. Inga ändringar i planer, rutter eller utskick görs automatiskt – planeraren granskar och godkänner varje ändring.",
    plannedTitle: "Planerat stöd",
    items: [
      ["Planeringsförslag", "Förslag på fördelning av uppdrag utifrån tidsfönster, kapacitet och arbetstider."],
      ["Förklaring av konflikter", "Tydliga förklaringar av varför ett stopp eller en rutt inte går ihop, till exempel krockande tidsfönster eller överskriden kapacitet."],
      ["Omplanering vid förseningar", "Förslag på hur sena eller försenade uppdrag kan planeras om."],
      ["Kontroll av orderdata", "Påminnelser om saknade eller ofullständiga uppgifter i order, som adress, tidsfönster eller vikt."],
      ["Underlag för kundfrågor", "Sammanfattningar baserade på befintlig spårning som stöd när kunder hör av sig."],
    ],
  },
  en: {
    title: "AI support",
    status: "In development",
    ready: "Planned ready December 15, 2026",
    intro: "AI support is not available yet. This page describes what it is intended to help planners with once it launches.",
    approveTitle: "The planner always decides",
    approve: "AI support will only provide suggestions and explanations. No changes to plans, routes or dispatch are made automatically – the planner reviews and approves every change.",
    plannedTitle: "Planned assistance",
    items: [
      ["Planning suggestions", "Suggested job allocation based on time windows, capacity and working hours."],
      ["Conflict explanations", "Clear explanations of why a stop or route does not fit, such as overlapping time windows or exceeded capacity."],
      ["Replanning for delays", "Suggestions for how late or delayed jobs can be replanned."],
      ["Order data checks", "Reminders about missing or incomplete order details, such as address, time window or weight."],
      ["Customer inquiry support", "Summaries based on existing tracking to support customer inquiries."],
    ],
  },
} as const;

const ICONS = [CalendarClock, AlertTriangle, RefreshCw, ClipboardCheck, MessageSquareText];

export default function AiSupport() {
  const { i18n } = useTranslation();
  const c = COPY[(i18n.resolvedLanguage ?? i18n.language).startsWith("sv") ? "sv" : "en"];

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="text-ai-title">{c.title}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-amber-400/50 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" data-testid="status-ai-development">{c.status}</span>
            <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground" data-testid="text-ai-ready-date">{c.ready}</span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{c.intro}</p>
        </header>

        <section className="flex gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
          <UserCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">{c.approveTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{c.approve}</p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.plannedTitle}</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {c.items.map(([title, desc], i) => {
              const Icon = ICONS[i];
              return (
                <li key={title} className="flex gap-3 rounded-xl border border-border bg-card p-4" data-testid={`card-ai-feature-${i}`}>
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AppLayout>
  );
}
