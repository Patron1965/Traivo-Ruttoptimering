import React, { useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, CircleAlert, SkipForward } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function ReportOutcome() {
  const [outcome, setOutcome] = useState("Genomfört");
  return <DriverSeriesShell title="Rapportera stopp" subtitle="04 · Ateljé Linden" step="Steg 1 av 2">
    <a className="d-tap" href={`${route}StopWork`} style={{display:"inline-flex",alignItems:"center",gap:6,margin:"16px 0 4px"}}><ArrowLeft size={15}/>Tillbaka till stoppet</a>
    <section className="d-card" style={{marginTop:10}}><p className="d-label">Exempelgatan 24</p><h2 className="d-section-title">Hur gick stoppet?</h2><div className="d-list" role="radiogroup" aria-label="Välj resultat">
      {[["Genomfört",CheckCircle2],["Kunde inte genomföras",CircleAlert],["Hoppa över",SkipForward]].map(([label,Icon]:any)=><label className="d-choice" key={label}><input type="radio" name="status" value={label} checked={outcome===label} onChange={()=>setOutcome(label)}/><Icon size={19} color="var(--green)"/>{label}</label>)}
    </div><label className="d-field-label" htmlFor="d-note">Anteckning <span style={{color:"var(--muted)",fontWeight:500}}>· valfritt</span></label><textarea className="d-field" id="d-note" placeholder={outcome==="Genomfört"?"Exempel: Leverans lämnad i receptionen":"Beskriv kort vad som hände…"}/></section>
    <div className="d-status d-status-warn"><CircleAlert/><div><b>Designprototyp</b><p>Detta val sparas inte i det verkliga chaufförssystemet.</p></div></div>
    <a className="d-button" href={`${route}ReportSaved`}>Granska rapport <ChevronRight/></a>
  </DriverSeriesShell>;
}
