import React, { useState } from "react";
import {
  ArrowUpRight, LocateFixed, MapPin, Minus, Navigation, Plus, Route as RouteIcon,
} from "lucide-react";
import { DriverSeriesShell, route } from "./DriverSeriesShell";

const stops = [
  { n: "04", street: "Exempelgatan 24", customer: "Ateljé Linden", eta: "09:06" },
  { n: "05", street: "Sankt Eriksgatan 18", customer: "Kvartersbutiken", eta: "09:24" },
  { n: "06", street: "Torsgatan 7", customer: "Studio Gran", eta: "09:41" },
];

export default function DriverMap() {
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(1);
  const nextStop = stops[0];
  const selectedStop = stops[selected];

  return <DriverSeriesShell title="Ruttkarta" subtitle="12 stopp · Stockholm Norr" active="Karta">
    <section className="d-map-wrap" aria-label="Ruttkarta">
      <div className="d-map" role="img" aria-label={`Illustrerad demokarta. Nästa stopp ${nextStop.n}, ${nextStop.street}.`}>
        <svg viewBox="0 0 390 280" preserveAspectRatio="none">
          <rect width="390" height="280" fill="#e7eee3"/>
          <g transform={`translate(${195 - 195 * zoom} ${140 - 140 * zoom}) scale(${zoom})`}>
            <path d="M-20 60 C70 90 100 10 180 40S270 110 420 45M-30 170C70 120 110 230 190 170s120-30 230 55M80-20C100 60 175 80 155 150s20 95 50 160M300-10c-30 50-50 95-10 150s30 80 10 160" fill="none" stroke="#fffefb" strokeWidth="18"/>
            <path d="M-20 60 C70 90 100 10 180 40S270 110 420 45M-30 170C70 120 110 230 190 170s120-30 230 55" fill="none" stroke="#d1ddd0" strokeWidth="2"/>
            <g fill="#d5e2d6"><rect x="28" y="102" width="38" height="24" rx="4"/><rect x="226" y="170" width="44" height="29" rx="4"/><rect x="322" y="117" width="34" height="21" rx="4"/><rect x="122" y="45" width="28" height="25" rx="4"/></g>
            <path d="M80 210 C110 175 135 170 180 140S220 120 260 80" fill="none" stroke="#a9c5b5" strokeWidth="11" strokeLinecap="round"/>
            <path d="M80 210 C110 175 135 170 180 140S220 120 260 80" fill="none" stroke="#087A5B" strokeWidth="5" strokeLinecap="round"/>
            <circle cx="80" cy="210" r="9" fill="#fff" stroke="#087A5B" strokeWidth="4"/>
            <circle cx="80" cy="210" r="3" fill="#087A5B"/>
            <circle cx="180" cy="140" r="7" fill="#FFFEFA" stroke="#087A5B" strokeWidth="3"/>
            <circle cx="260" cy="80" r="8" fill="#087A5B" stroke="#FFFEFA" strokeWidth="3"/>
          </g>
        </svg>
        <span className="d-map-label" style={{top:"20%",left:"14%"}}>ODENGATAN</span>
        <span className="d-map-label" style={{top:"63%",left:"51%"}}>VASASTAN</span>
        <span className="d-map-label" style={{top:"13%",left:"63%"}}>SVEAVÄGEN</span>
        <span className="d-map-next"><span className="d-map-next-dot"/>ST {nextStop.n} · NÄSTA</span>
        <div className="d-map-tools" aria-label="Kartkontroller">
          <button type="button" aria-label="Zooma in" onClick={() => setZoom(value => Math.min(1.35, value + .1))}><Plus/></button>
          <button type="button" aria-label="Zooma ut" onClick={() => setZoom(value => Math.max(.85, value - .1))}><Minus/></button>
          <button type="button" aria-label="Centrera på demoplatsen" onClick={() => setZoom(1)}><LocateFixed/></button>
        </div>
        <span className="d-map-scale">Kartvy · exempel</span>
      </div>
    </section>

    <section className="d-map-progress" aria-label="Ruttens framsteg">
      <div className="d-map-progress-top"><span><RouteIcon size={15}/> RUTTENS FRAMSTEG</span><b>3 av 12 klara</b></div>
      <div className="d-map-progress-track"><span/></div>
      <div className="d-map-stop-strip" role="group" aria-label="Förhandsvisa ett stopp på rutten">
        {stops.map((stop, index) => <React.Fragment key={stop.n}>
          {index > 0 && <span className="d-map-connector" aria-hidden="true"/>}
          <button type="button" aria-pressed={selected === index} aria-label={`Förhandsvisa stopp ${stop.n}, beräknad ankomst ${stop.eta}`} onClick={() => setSelected(index)} className={`d-map-stop ${selected === index ? "d-map-stop-active" : ""}`}>
            <span>{stop.n}</span><small>{stop.eta}</small>
          </button>
        </React.Fragment>)}
        <span className="d-map-more">+6</span>
      </div>
      {selected !== 0 && <div className="d-map-stop-preview" aria-live="polite">
        <span className="d-map-stop-preview-label">FÖRHANDSVISAR · STOPP {selectedStop.n}</span>
        <strong>{selectedStop.street}</strong>
        <span>{selectedStop.customer} · ca {selectedStop.eta}</span>
        <span className="d-map-preview-note">Ruttordningen påverkas inte av förhandsvisningen.</span>
      </div>}
    </section>

    <section className="d-card d-map-next-card">
      <div className="d-map-arrival"><p className="d-label"><span className="d-map-next-dot"/>NÄSTA STOPP · {nextStop.n} AV 12</p><span className="d-map-distance">1,8 km <i/> 6 min</span></div>
      <div className="d-row"><strong className="d-map-address">{nextStop.street}</strong><span className="d-map-eta">{nextStop.eta}</span></div>
      <p className="d-muted d-map-customer">{nextStop.customer} · beräknad ankomst</p>
      <a className="d-button" href={`${route}StopWork`}><Navigation/>Visa stopp och instruktion<ArrowUpRight className="d-map-link-icon"/></a>
    </section>
    <div className="d-status d-status-warn d-map-disclaimer"><MapPin/><div><b>Illustrerad karta</b><p>Ingen GPS-position eller vägnavigering visas i denna prototyp.</p></div></div>
    <style>{`
      .d-map-wrap{position:relative;margin:13px -4px 0}
      .d-map{height:clamp(230px,34dvh,310px);margin:0;border-radius:20px;border-color:#d6e1d6;box-shadow:0 6px 24px #173a3210}
      .d-map-next{position:absolute;left:12px;top:12px;padding:8px 10px;border-radius:11px;background:#fffefaf2;border:1px solid #dce4dc;color:#173a32;font-size:9px;letter-spacing:.7px;font-weight:850;display:flex;align-items:center;gap:7px;box-shadow:0 2px 8px #173a3210}
      .d-map-next-dot{width:8px;height:8px;display:inline-block;flex:none;border-radius:50%;background:#087a5b;box-shadow:0 0 0 3px #087a5b20}
      .d-map-tools{position:absolute;right:11px;top:11px;display:grid;gap:5px}
      .d-map-tools button{width:37px;height:37px;border:1px solid #dce4dc;border-radius:12px;background:#fffefaf2;color:#173a32;display:grid;place-items:center;box-shadow:0 2px 8px #173a3210;cursor:pointer}
      .d-map-tools button:hover{background:#eaf2ec;color:#075542}
      .d-map-tools button:focus-visible,.d-map-stop:focus-visible{outline:3px solid #168267;outline-offset:2px}
      .d-map-tools svg{position:static;inset:auto;width:17px;height:17px}
      .d-map-scale{position:absolute;right:11px;bottom:10px;padding:5px 8px;border-radius:8px;background:#fffefae8;color:#66766f;font-size:9px;font-weight:650}
      .d-map-progress{padding:15px 2px 5px}
      .d-map-progress-top{display:flex;align-items:center;justify-content:space-between;color:#66766f;font-size:10px;letter-spacing:.7px;font-weight:800}
      .d-map-progress-top span{display:flex;align-items:center;gap:7px}
      .d-map-progress-top b{letter-spacing:0;color:#173a32;font-size:11px}
      .d-map-progress-track{height:4px;margin:10px 2px 12px;background:#dce4dc;border-radius:8px;overflow:hidden}
      .d-map-progress-track span{display:block;width:25%;height:100%;background:#087a5b;border-radius:8px}
      .d-map-stop-strip{display:flex;align-items:center;padding:0 2px}
      .d-map-stop{position:relative;z-index:1;display:grid;justify-items:center;gap:4px;min-width:40px;padding:0;border:0;background:transparent;color:#66766f;cursor:pointer}
      .d-map-stop>span{width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:#e8efe8;border:1px solid #dce4dc;color:#53655b;font:750 11px "DM Sans",sans-serif}
      .d-map-stop small{font:650 9px "DM Sans",sans-serif}
      .d-map-stop-active>span{background:#087a5b;border-color:#087a5b;color:#fff;box-shadow:0 0 0 4px #087a5b1a}
      .d-map-stop-active small{color:#075542}
      .d-map-connector{height:2px;flex:1;background:#dce4dc;margin:-14px -1px 0}
      .d-map-more{margin:-13px 0 0 8px;color:#66766f;font-size:10px;font-weight:800}
      .d-map-next-card{margin-top:13px;padding:15px}
      .d-map-arrival{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .d-map-arrival .d-label{display:flex;align-items:center;gap:8px;margin:0}
      .d-map-distance{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:750;color:#53655b;white-space:nowrap}
      .d-map-distance i{height:3px;width:3px;border-radius:50%;background:#9eaaa2}
      .d-map-address{font-size:17px;letter-spacing:-.35px}
      .d-map-eta{font-size:12px;font-weight:800;color:#087a5b}
      .d-map-customer{margin:4px 0 0}
      .d-map-next-card .d-button{min-height:48px;margin:13px 0 0;font-size:13px}
      .d-map-link-icon{margin-left:auto;width:16px!important;height:16px!important}
      .d-map-stop-preview{display:grid;gap:3px;margin:12px 2px 0;padding:10px 12px;border:1px solid #dce4dc;border-radius:13px;background:#fffef8}
      .d-map-stop-preview-label{font-size:9px;font-weight:850;letter-spacing:.65px;color:#087a5b}
      .d-map-stop-preview strong{font-size:13px;color:#173a32}
      .d-map-stop-preview>span:not(.d-map-stop-preview-label){font-size:11px;color:#66766f}
      .d-map-stop-preview .d-map-preview-note{margin-top:2px;color:#53655b}
      .d-map-disclaimer{margin:9px 0 0;padding:10px 12px}
      .d-map-disclaimer p{font-size:11px}
      @media(max-width:360px){.d-map-stop{min-width:34px}.d-map-stop>span{width:30px;height:30px}.d-map-arrival .d-label{font-size:9px}.d-map-distance{font-size:9px}}
    `}</style>
  </DriverSeriesShell>;
}
