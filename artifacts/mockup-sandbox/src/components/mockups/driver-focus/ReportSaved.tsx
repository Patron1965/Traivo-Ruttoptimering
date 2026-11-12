import React from "react";
import { ArrowRight, Check, Clock3, Cloud, Route } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function ReportSaved() {
  return <DriverSeriesShell title="Rapport klar" subtitle="Stopp 04 · Exempelgatan 24" step="Bekräftelse">
    <section className="d-card" style={{textAlign:"center",marginTop:25,padding:"25px 18px"}}><div className="d-checkmark"><Check/></div><p className="d-eyebrow" style={{marginBottom:8}}>Simulerad bekräftelse</p><h2 style={{fontSize:22,letterSpacing:"-.7px",margin:"0 0 8px"}}>Rapporten är sparad</h2><p className="d-muted" style={{maxWidth:280,margin:"0 auto"}}>Den här skissen visar hur återkopplingen kan se ut. Ingen uppgift har skickats.</p></section>
    <div className="d-status d-status-warn"><Cloud/><div><b>Inte skickad till trafikledningen</b><p>I den riktiga appen visas här om rapporten skickades eller väntar på uppkoppling.</p></div></div>
    <section className="d-card"><p className="d-label">Nästa steg</p><div className="d-list-check"><Check/>Stopp 04 markeras som rapporterat</div><div className="d-list-check"><Clock3/>Nästa uppgift: Studio Norr · 10:15</div></section>
    <a className="d-button" href={`${route}RouteOverview`}>Till ruttöversikten <Route/></a><a className="d-button d-button-secondary" href={`${route}StopWork`}>Visa nästa stopp <ArrowRight/></a>
  </DriverSeriesShell>;
}
