import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./focus-home.css";

type IconName = "signal" | "offline" | "check" | "cloud" | "arrow" | "report" | "chevron" | "note" | "warning" | "close";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    signal: <><path d="M4 16v4M9 12v8M14 8v12M19 4v16" /></>,
    offline: <><path d="m3 3 18 18M8.5 8.5A12 12 0 0 1 21 9M3 9a12 12 0 0 1 2-1.5M6 13a9 9 0 0 1 3-1.5M10 16a4 4 0 0 1 4 0M12 20h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    cloud: <><path d="M7 18H6a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 8a5 5 0 0 1 .5 10H17" /><path d="M12 20V12m-3 3 3-3 3 3" /></>,
    arrow: <path d="m20 4-6 16-3-7-7-3 16-6Z" />,
    report: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v4H9zM9 12h6M9 16h4" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    note: <><path d="M15 3H5v18h14V7l-4-4Zm0 0v5h4M8 12h8M8 16h5" /></>,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

type Modal = "report" | "navigation" | "saved" | null;
const outcomes = ["Genomfört", "Kunde inte genomföras", "Hoppa över"] as const;

export default function DriverFocusHome({ offline = false }: { offline?: boolean }) {
  const [modal, setModal] = useState<Modal>(null);
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const [localReports, setLocalReports] = useState(offline ? 2 : 0);
  const [reported, setReported] = useState(false);
  const [lastOutcome, setLastOutcome] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  function openModal(value: Modal) {
    triggerRef.current = document.activeElement as HTMLElement;
    setModal(value);
  }
  function closeModal() {
    setModal(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }
  useEffect(() => {
    if (!modal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModal(null);
        triggerRef.current?.focus();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); };
  }, [modal]);

  function saveSimulation() {
    if (!outcome) return;
    setLocalReports(value => value + 1);
    setLastOutcome(outcome);
    setReported(true);
    setModal("saved");
  }

  return (
    <main className="tf-home">
      <header className="tf-top">
        <div className="tf-brand">
          <svg viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M4 7h22L15 26 4 7Z" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" /><path d="m15 7 5.5 9.5" stroke="currentColor" strokeWidth="3.5" /></svg>
          traivo<span>GO</span>
        </div>
        <div className={`tf-connection ${offline ? "tf-is-offline" : ""}`}><Icon name={offline ? "offline" : "signal"} />{offline ? "Offline" : "Ansluten"}</div>
      </header>

      <div className="tf-intro">
        <div><p className="tf-eyebrow">Måndag 18 maj</p><h1>Din arbetsdag.</h1></div>
        <span className="tf-route-code">Rutt 04</span>
      </div>

      <section className="tf-route" aria-label="Dagens rutt">
        <div className="tf-route-line"><b>3 av 12 stopp klara</b><span>Stockholm · Norr</span></div>
        <div className="tf-progress" aria-label="3 av 12 stopp klara">{Array.from({ length: 12 }, (_, index) => <span key={index} className={index < 3 ? "tf-done" : index === 3 ? "tf-current" : ""} />)}</div>
      </section>

      <section className={`tf-sync ${offline || localReports > 0 ? "tf-is-offline" : ""}`} aria-label="Synkstatus" aria-live="polite">
        <Icon name={localReports > 0 ? "cloud" : "check"} />
        <div>
          <strong>{localReports > 0 ? `${localReports} rapporter sparade lokalt` : "Allt skickat till trafikledningen"}</strong>
          <p>{localReports > 0 ? "Inte skickade till trafikledningen." : "Senast synkat 08:42 · inga väntande rapporter"}</p>
          {offline && <p>Offline sedan 08:38 · planen kan ha ändrats.</p>}
          {!offline && localReports > 0 && <p>Demo: inga rapporter skickas från prototypen.</p>}
        </div>
      </section>

      <article className="tf-stop">
        <div className="tf-stop-top"><div className="tf-next">Nästa stopp</div><span>04 / 12</span></div>
        <div className="tf-stop-body">
          <p className="tf-recipient">Exempelmottagare · Ateljé Linden</p>
          <h2>Exempelgatan 24</h2>
          <p className="tf-city">113 00 Stockholm · demoadress</p>
          <div className="tf-times">
            <div className={offline ? "tf-stale" : "tf-estimate"}>
              <span>Beräknad ankomst</span>
              <strong>{offline ? "Ej aktuell" : "09:06"}</strong>
              <small>{offline ? "Senast 09:06 · kl. 08:38" : "Uppdaterad 08:42"}</small>
            </div>
            <div><span>Kundens tidsfönster</span><strong>09:00–09:30</strong><small>Överenskommen tid</small></div>
          </div>
          {offline && <p className="tf-uncertainty"><Icon name="warning" />Ankomsttiden kan inte uppdateras offline.</p>}
          <div className="tf-note"><Icon name="note" /><p>Använd entrén mot gården.<br />Ring på vid ankomst.</p></div>
          {reported && <p className="tf-feedback" role="status">Demorapport: {lastOutcome.toLocaleLowerCase("sv-SE")}. Stoppet ändras inte i prototypen.</p>}
          <div className="tf-actions">
            <button className="tf-button" onClick={() => openModal("navigation")}><Icon name="arrow" />Navigera</button>
            <button className="tf-button tf-secondary" onClick={() => { setOutcome(""); setNote(""); openModal("report"); }}><Icon name="report" />Rapportera stopp</button>
          </div>
          <details className="tf-details">
            <summary>Stoppdetaljer & kontakt<Icon name="chevron" /></summary>
            <div className="tf-detail-body">
              <dl><dt>Planerad tid</dt><dd>09:10</dd><dt>Stopptid</dt><dd>10 min</dd><dt>Kontakt</dt><dd>Reception</dd></dl>
              <p>reception@example.test</p>
              <p>Demo · kontaktuppgifter kan inte öppnas.</p>
              <p>Ankomst 09:06 är en vägbaserad uppskattning, inte kundens bokade tid. {offline ? "Underlaget är äldre och kan inte verifieras offline." : "Senaste positionsunderlag 08:42."}</p>
            </div>
          </details>
        </div>
      </article>

      <details className="tf-details tf-footer-details">
        <summary>Rutt & dagens tider<Icon name="chevron" /></summary>
        <div className="tf-detail-body"><dl><dt>Planerat ruttslut</dt><dd>15:25</dd><dt>Planerad rast</dt><dd>11:30–12:00</dd><dt>Planversion</dt><dd>3 · hämtad 08:35</dd><dt>Skickade rapporter</dt><dd>{offline ? "1" : "3"}</dd><dt>Lokalt i demo</dt><dd>{localReports}</dd></dl><p>{offline ? "Två av de tre klara stoppen väntar på att skickas. Ingen ny plan kan hämtas offline." : "Tiderna är planerade och kan ändras under dagen."} Ingen liveposition används i prototypen.</p></div>
      </details>
      <p className="tf-prototype">PROTOTYP · fiktiv rutt · inga riktiga åtgärder</p>

      {modal && <div className="tf-overlay" onClick={event => { if (event.target === event.currentTarget) closeModal(); }}>
        <div className="tf-sheet" role="dialog" aria-modal="true" aria-labelledby="tf-modal-title" ref={dialogRef}>
          <div className="tf-handle" />
          <div className="tf-sheet-head"><h2 id="tf-modal-title">{modal === "report" ? "Rapportera stopp" : modal === "navigation" ? "Navigering · demo" : "Sparat i denna demo"}</h2><button className="tf-close" onClick={closeModal} aria-label="Stäng"><Icon name="close" /></button></div>
          {modal === "report" && <>
            <p className="tf-sheet-description">04 · Exempelgatan 24</p>
            <fieldset className="tf-outcomes"><legend>Hur gick stoppet?</legend>{outcomes.map(value => <label className="tf-outcome" key={value}><input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} />{value}</label>)}</fieldset>
            <label className="tf-label" htmlFor="tf-report-note">Anteckning <span>(valfritt)</span></label>
            <textarea id="tf-report-note" value={note} onChange={event => setNote(event.target.value)} placeholder="Lägg till en kort kommentar…" />
            <p className="tf-demo-notice">Simulerad lokal lagring, endast i denna vy. Inget skickas till trafikledningen. Uppgifterna försvinner vid omladdning.</p>
            <button className="tf-button" disabled={!outcome} onClick={saveSimulation}>Spara lokalt · simulering</button>
          </>}
          {modal === "navigation" && <>
            <p className="tf-sheet-copy">Exempelgatan 24<br />113 00 Stockholm</p>
            <p className="tf-demo-notice">I den riktiga appen öppnas en navigeringsapp för en verifierad adress. Detta är en fiktiv demoadress. Ingen karta, GPS eller extern app öppnas här.</p>
            {offline && <p className="tf-sheet-description">Offline: aktuell framkomlighet och ankomsttid kan inte kontrolleras.</p>}
            <button className="tf-button" onClick={closeModal}>Tillbaka till stoppet</button>
          </>}
          {modal === "saved" && <>
            <div className="tf-success-icon"><Icon name="check" /></div>
            <p className="tf-sheet-copy"><strong>{lastOutcome}</strong>{note && <><br />{note}</>}</p>
            <p className="tf-demo-notice">Simulerat sparad · inte skickad till trafikledningen. {localReports} rapporter finns nu lokalt i denna vy. Ingen beständig lagring eller synkronisering sker.</p>
            <button className="tf-button" onClick={closeModal}>Tillbaka till stoppet</button>
          </>}
        </div>
      </div>}
    </main>
  );
}
