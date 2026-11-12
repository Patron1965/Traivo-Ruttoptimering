import React from "react";
import { ArrowLeft, ChevronDown, Clock3, FileText, MapPin, Navigation, Phone, UserRound } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function StopWork() {
  return <DriverSeriesShell title="Nästa stopp" subtitle="Ateljé Linden" step="04 / 12">
    <section className="d-card" style={{marginTop:15}}>
      <p className="d-label">Leverans · Exempelgatan 24</p><h2 style={{fontSize:23,lineHeight:1.15,letterSpacing:"-.7px",margin:"0 0 4px"}}>Exempelgatan 24</h2><p className="d-muted" style={{margin:"0"}}>113 00 Stockholm · demoadress</p>
      <div className="d-eta"><div><span>Beräknad ankomst</span><strong style={{color:"var(--green)"}}>09:06</strong><small>Uppdaterad 08:42</small></div><div><span>Kundens tidsfönster</span><strong>09:00–09:30</strong><small>Överenskommen tid</small></div></div>
      <div className="d-instruction"><FileText/><span>Använd entrén mot gården.<br/>Ring på vid ankomst.</span></div>
      <a className="d-button" href={`${route}DriverMap`}><Navigation/>Navigera</a>
      <a className="d-button d-button-secondary" href={`${route}ReportOutcome`}><FileText/>Rapportera stopp</a>
    </section>
    <details className="d-card"><summary style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:13,fontWeight:750,cursor:"pointer",listStyle:"none"}}>Stoppdetaljer & kontakt <ChevronDown size={17}/></summary><div className="d-issue-row"><span><Clock3 size={15}/> Planerad tid</span><b>09:10</b></div><div className="d-issue-row"><span>Stopptid</span><b>10 min</b></div><div className="d-issue-row"><span><UserRound size={15}/> Kontakt</span><b>Reception</b></div><div className="d-issue-row"><span><Phone size={15}/> Kontaktalternativ</span><b>E-post</b></div><p className="d-muted">Uppskattad ankomst bygger på aktuell ruttinformation. Tidsfönstret är kundens bokade tid.</p></details>
    <div className="d-status d-status-ok"><MapPin/><div><b>Adress verifierad</b><p>Prototyp: ingen extern kartapp öppnas.</p></div></div>
  </DriverSeriesShell>;
}
