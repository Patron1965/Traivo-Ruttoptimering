import React, { useState } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ChevronDown } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function ExceptionReport() {
  const [reason,setReason]=useState("Mottagaren ej på plats");
  return <DriverSeriesShell title="Avvikelse" subtitle="04 · Ateljé Linden" step="Särskild rapport">
    <a className="d-tap" href={`${route}ReportOutcome`} style={{display:"inline-flex",alignItems:"center",gap:6,margin:"16px 0 4px"}}><ArrowLeft size={15}/>Tillbaka</a>
    <div className="d-status d-status-issue"><AlertTriangle/><div><b>Stoppet kunde inte genomföras</b><p>Välj orsak så trafikledningen ser vad som behöver följas upp.</p></div></div>
    <section className="d-card"><label className="d-field-label" htmlFor="d-reason">Orsak</label><select id="d-reason" value={reason} onChange={e=>setReason(e.target.value)} style={{width:"100%",padding:14,border:"1px solid var(--line)",borderRadius:12,background:"var(--white)",font:"inherit",color:"var(--ink)"}}><option>Mottagaren ej på plats</option><option>Adress kunde inte hittas</option><option>Åtkomst saknas</option><option>Skadat gods</option><option>Annat</option></select>
      <label className="d-field-label" htmlFor="d-detail">Kommentar</label><textarea id="d-detail" className="d-field" placeholder="Lägg till en kort beskrivning…"/>
      <button type="button" className="d-button d-button-secondary"><Camera/>Lägg till foto <span style={{fontSize:10,color:"var(--muted)",fontWeight:500}}>· demo</span></button><p className="d-muted">Foto bifogas bara i det riktiga appflödet. Inget laddas upp här.</p></section>
    <a className="d-button" href={`${route}ReportSaved`}><CheckCircle2/>Fortsätt till bekräftelse</a>
  </DriverSeriesShell>;
}
