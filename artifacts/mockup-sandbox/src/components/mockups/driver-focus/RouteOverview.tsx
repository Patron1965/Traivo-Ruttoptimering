import React from "react";
import { ArrowRight, Check, ChevronRight, Clock3, MapPin, Route, Truck } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function RouteOverview() {
  return <DriverSeriesShell title="Din arbetsdag." subtitle="Rutt 04 · Stockholm Norr">
    <section className="d-prog"><div className="d-prog-top"><span>3 av 12 stopp klara</span><span>25 %</span></div><div className="d-track"><div className="d-fill"/></div></section>
    <div className="d-status d-status-ok"><Check/><div><b>Allt skickat till trafikledningen</b><p>Senast synkat 08:42 · inga väntande rapporter</p></div></div>
    <section className="d-card"><div className="d-row"><p className="d-label">Nästa stopp</p><span className="d-time">04 / 12</span></div>
      <a className="d-stop d-stop-current" href={`${route}StopWork`}><span className="d-stop-n">04</span><span><strong>Ateljé Linden</strong><small>Exempelgatan 24 · 09:00–09:30</small></span><span className="d-time">09:06</span></a>
    </section>
    <section className="d-card"><h2 className="d-section-title">Resten av rutten</h2><div className="d-list">
      <div className="d-stop"><span className="d-stop-n"><Check size={15}/></span><span><strong>Blom & Form</strong><small>Storgatan 7 · Genomfört</small></span><span className="d-time">08:32</span></div>
      <div className="d-stop"><span className="d-stop-n">05</span><span><strong>Studio Norr</strong><small>Vasavägen 18</small></span><span className="d-time">10:15</span></div>
      <div className="d-stop"><span className="d-stop-n">06</span><span><strong>Ekbackens gård</strong><small>Frejgatan 3</small></span><span className="d-time">11:05</span></div>
    </div><a className="d-tap" href={`${route}StopWork`} style={{display:"flex",justifyContent:"space-between",paddingTop:14}}>Visa alla 12 stopp <ChevronRight size={16}/></a></section>
    <section className="d-card d-card-soft"><div className="d-row"><span style={{display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:700}}><Truck size={16}/> Testbil 2 · ABC 123</span><a className="d-tap" href={`${route}DriverMap`}>Öppna karta <ArrowRight size={14}/></a></div><p className="d-muted" style={{marginBottom:0}}>Planerat ruttslut 15:25 · rast 11:30</p></section>
  </DriverSeriesShell>;
}
