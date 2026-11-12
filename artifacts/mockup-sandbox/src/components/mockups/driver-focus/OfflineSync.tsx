import React from "react";
import { AlertTriangle, Cloud, RefreshCw, WifiOff } from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";
export default function OfflineSync() {
  return <DriverSeriesShell title="Synkstatus" subtitle="Rutt 04 · Stockholm Norr" active="Synk" connection="Offline">
    <div className="d-status d-status-warn" style={{marginTop:18}}><WifiOff/><div><b>Ingen uppkoppling</b><p>Offline sedan 08:38 · sparat arbete ligger kvar på enheten.</p></div></div>
    <section className="d-card"><div className="d-row"><h2 className="d-section-title" style={{margin:0}}>Väntar på synkning</h2><span style={{fontSize:20,fontWeight:800,color:"var(--amber)"}}>2</span></div><p className="d-muted">Dessa rapporter är sparade lokalt men har inte nått trafikledningen.</p><div className="d-issue-row"><span><Cloud size={15}/> Stopp 02 · Blom & Form</span><b>08:20</b></div><div className="d-issue-row"><span><Cloud size={15}/> Stopp 03 · Kvartersbageriet</span><b>08:35</b></div></section>
    <div className="d-status d-status-issue"><AlertTriangle/><div><b>Planen kan ha ändrats</b><p>Uppdrag och tider är från senaste synkning 08:38. Kontrollera planen när du får uppkoppling.</p></div></div>
    <section className="d-card d-card-soft"><div className="d-row" style={{justifyContent:"flex-start",gap:10}}><RefreshCw color="var(--green)"/><b style={{fontSize:13}}>Automatisk synkning</b></div><p className="d-muted" style={{marginBottom:0}}>När anslutningen återkommer skickar den riktiga appen väntande rapporter och visar resultatet för varje rapport.</p></section>
    <a className="d-button" href={`${route}RouteOverview`}>Tillbaka till rutten</a>
    <p className="d-muted" style={{fontSize:11,textAlign:"center"}}>I den här designprototypen sker ingen nätverksanslutning eller synkning.</p>
  </DriverSeriesShell>;
}
