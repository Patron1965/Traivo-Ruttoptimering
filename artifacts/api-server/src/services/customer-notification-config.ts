import { z } from "zod";

export const notificationFields = ["customer_name", "address", "date", "time_window", "resource_name", "company", "tracking_url"] as const;
const template = (max: number) => z.string().max(max).refine(
  (s) => [...s.matchAll(/\{\{([^{}]+)\}\}/g)].every((m) => notificationFields.includes(m[1].trim() as typeof notificationFields[number])),
  "Okänt mallfält",
);
const event = z.object({ enabled: z.boolean(), sms: template(1600), subject: template(200), email: template(5000) }).strict();
export const customerNotificationConfigSchema = z.object({
  channel: z.enum(["sms", "email", "both"]),
  events: z.object({ planned: event, approaching: event, completed: event }).strict(),
}).strict().superRefine((c, ctx) => {
  for (const [key, e] of Object.entries(c.events)) {
    if (!e.enabled) continue;
    for (const field of c.channel === "sms" ? ["sms"] : c.channel === "email" ? ["subject", "email"] : ["sms", "subject", "email"]) {
      if (!e[field as "sms"].trim()) ctx.addIssue({code:"custom", path:["events",key,field], message:"Aktiverade meddelanden får inte vara tomma"});
    }
  }
});
export type CustomerNotificationConfig = z.infer<typeof customerNotificationConfigSchema>;
export function renderNotification(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => values[key.trim()] ?? "");
}
export function escapeNotificationHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
}
