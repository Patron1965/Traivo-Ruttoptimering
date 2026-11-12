import "./_group.css";
import { StopCard } from "./_shared/ExtractedStopCards";
export default function Current() {
  return <main className="driver-focus-root" style={{ padding: 16 }}>
    <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 20 }}>Nuvarande stoppkort · isolerad kodreferens</p>
    <StopCard stop={{ id: "demo", address: "Odengatan 42, Stockholm", status: "pending", sequenceOrder: 4, timeWindowStart: "09:00", timeWindowEnd: "09:30", serviceDurationMin: 10, notes: "Använd entrén mot gården. Ring på vid ankomst.", contactName: "Reception", contactEmail: "reception@example.test" }} isActive onStatusUpdate={() => {}} isUpdating={false} planVersion={1} plannedAt="09:10" />
    <p style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.5 }}>Utdrag ur appens riktiga stoppkort med syntetiska uppgifter. Native-komponenterna är anpassade för webbvisning. Knapparna utför inga åtgärder.</p>
  </main>;
}
