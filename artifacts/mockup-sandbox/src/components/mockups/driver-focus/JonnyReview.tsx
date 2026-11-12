import React from "react";
import { Download, Printer, Star, MessageSquareText } from "lucide-react";

const pages = [
  {
    number: "01", title: "Ruttöversikt", subtitle: "Hitta rätt uppdrag utan att leta.",
    summary: "Visar dagens rutt, hur många stopp som är klara, skickstatus, nästa stopp och de närmaste stoppen.",
    questions: ["Ser du direkt vilket stopp du ska till härnäst?", "Är det lätt att förstå hur många stopp som återstår?", "Saknar du någon viktig information i överblicken?"],
  },
  {
    number: "02", title: "Karta", subtitle: "Få en snabb geografisk överblick.",
    summary: "En illustrerad kartvy markerar rutten och nästa destination. Kartan är bara ett designförslag; den startar ingen navigering.",
    questions: ["Hjälper kartan dig att förstå rutten?", "Är nästa stopp tydligt markerat?", "Skulle du föredra karta, lista eller båda samtidigt?"],
  },
  {
    number: "03", title: "Arbeta med stopp", subtitle: "Se uppgiften och välj nästa åtgärd.",
    summary: "Visar adress, beräknad ankomst, kundens tidsfönster och instruktion. Navigera och rapportera stopp är huvudvalen.",
    questions: ["Är adress och tider lätta att hitta och läsa?", "Är instruktionen tydlig där den visas?", "Är det självklart vad knapparna gör?"],
  },
  {
    number: "04", title: "Rapportera stopp", subtitle: "Berätta kort vad som hände.",
    summary: "Välj Genomfört, Kunde inte genomföras eller Hoppa över. En anteckning kan läggas till innan rapporten granskas.",
    questions: ["Är utfallen begripliga och tillräckligt olika?", "Saknas ett vanligt utfall eller en viktig uppgift?", "Fungerar detta när du har bråttom eller handskar på?"],
  },
  {
    number: "05", title: "Rapportera avvikelse", subtitle: "Lämna det som trafikledningen behöver veta.",
    summary: "Avvikelsevyn samlar orsak och kommentar. Fotoflödet i serien är ett förslag, inte en verklig kamerafunktion.",
    questions: ["Går det snabbt att välja rätt avvikelse?", "Är det tydligt vilken information som behövs?", "Vilken avvikelse eller förklaring saknas?"],
  },
  {
    number: "06", title: "Rapport bekräftad", subtitle: "Förstå vad som faktiskt sparades.",
    summary: "Bekräftelsevyn visar att rapporten sparats i prototypen. Den påstår inte att trafikledningen har tagit emot något.",
    questions: ["Förstår du om rapporten är sparad eller skickad?", "Är det lätt att se vad nästa steg är?", "Vilken bekräftelse skulle du vilja få?"],
  },
  {
    number: "07", title: "Offline och synkning", subtitle: "Se skillnaden på sparat och levererat.",
    summary: "Visar lokalt sparade rapporter separat från skickade och varnar för inaktuell ankomsttid eller plan.",
    questions: ["Är det tydligt vad som väntar på att skickas?", "Förstår du vilken information som kan vara inaktuell?", "Vad behöver du kunna göra när nätet försvinner?"],
  },
];

function printReview() {
  window.print();
}

export default function JonnyReview() {
  return (
    <main className="jr-document">
      <header className="jr-toolbar">
        <div className="jr-brand"><span className="jr-mark">T</span><span>TRAIVO <small>FÖRARAPP · DESIGNFÖRSLAG</small></span></div>
        <button className="jr-print" onClick={printReview}><Printer size={17} /> Skriv ut / spara som PDF</button>
      </header>
      <article className="jr-sheet jr-cover">
        <div className="jr-kicker">FÖRARTEST · ÅTERKOPPLING</div>
        <div className="jr-cover-content">
          <span className="jr-stamp">JONNY · FÖRARE</span>
          <h1>En arbetsdag,<br /><em>ur ditt perspektiv.</em></h1>
          <p className="jr-lead">Vi har tagit fram ett förslag på hur chaufförsappens arbetsflöde kan bli tydligare. Dina erfarenheter hjälper oss att prioritera rätt innan något ändras.</p>
          <div className="jr-meta-grid">
            <label>Ditt namn <span>Jonny Förare</span></label>
            <label>Datum <span className="jr-line" /></label>
            <label>Rutt / typ av körning <span className="jr-line" /></label>
          </div>
          <div className="jr-callout"><MessageSquareText size={19} /><p><strong>Du behöver inte vara snäll.</strong> Markera det som känns oklart, onödigt eller saknas. Skriv gärna hur du brukar göra i dag.</p></div>
        </div>
        <footer className="jr-footer"><span>PROTOTYP · INGA RIKTIGA UPPDRAG ELLER RAPPORTER</span><span>01 / 08</span></footer>
      </article>

      {pages.map((page, index) => (
        <article className="jr-sheet jr-review-page" key={page.number}>
          <header className="jr-page-head"><span className="jr-kicker">VY {page.number} · CHAUFFÖRENS ARBETSFLÖDE</span><span className="jr-page-tag">JONNYS BEDÖMNING</span></header>
          <div className="jr-page-title"><span className="jr-index">{page.number}</span><div><h2>{page.title}</h2><p>{page.subtitle}</p></div></div>
          <div className="jr-description"><b>Vad du ser</b><p>{page.summary}</p></div>
          <div className="jr-scale-head"><span>Hur fungerar vyn för dig?</span><small>Ringa in ett betyg för varje rad</small></div>
          <div className="jr-questions">
            {page.questions.map((question, qi) => (
              <div className="jr-question" key={question}>
                <p><b>{String(qi + 1).padStart(2, "0")}</b>{question}</p>
                <div className="jr-rating" aria-label={`Betyg för fråga ${qi + 1}`}>
                  <span>Inte alls</span>{[1, 2, 3, 4, 5].map((rating) => <i key={rating}>{rating}</i>)}<span>Mycket</span>
                </div>
              </div>
            ))}
          </div>
          <div className="jr-note"><label>Vad skulle du ändra, lägga till eller ta bort?</label><div className="jr-writing-lines" /></div>
          <div className="jr-prompt"><Star size={15} /><span>{index === 0 ? "Om du bara fick ändra en sak i den här vyn, vad skulle du välja?" : index === 6 ? "Vad händer i verkligheten när du tappar täckning?" : "Skulle du använda detta under en vanlig arbetsdag? Varför eller varför inte?"}</span></div>
          <footer className="jr-footer"><span>PROTOTYP · DEMODATA · INGA ÅTGÄRDER SKICKAS</span><span>{String(index + 2).padStart(2, "0")} / 08</span></footer>
        </article>
      ))}

      <article className="jr-sheet jr-final">
        <div className="jr-kicker">SISTA SIDAN · HELHETSBEDÖMNING</div>
        <h2>Din arbetsdag.<br /><em>Dina önskemål.</em></h2>
        <div className="jr-final-field"><label>Vad fungerar bäst i förslaget?</label><div className="jr-writing-lines jr-lines-tall" /></div>
        <div className="jr-final-field"><label>Vad skulle göra störst skillnad för dig i vardagen?</label><div className="jr-writing-lines jr-lines-tall" /></div>
        <div className="jr-final-field"><label>Är det något vi missat helt?</label><div className="jr-writing-lines jr-lines-tall" /></div>
        <div className="jr-priority"><b>Om vi bara hinner göra en förbättring först, välj en:</b><div><span className="jr-check" /> Nästa stopp snabbare att hitta</div><div><span className="jr-check" /> Tydligare navigering</div><div><span className="jr-check" /> Enklare återrapportering</div><div><span className="jr-check" /> Bättre offlineinformation</div><div><span className="jr-check" /> Annat: <span className="jr-line" /></div></div>
        <footer className="jr-footer"><span>TACK FÖR ATT DU HJÄLPER OSS BYGGA FÖR VERKLIGA ARBETSDAGAR</span><span>08 / 08</span></footer>
      </article>
      <style>{`
        *{box-sizing:border-box}.jr-document{--ink:#173c32;--green:#08785f;--mint:#e8f2ec;--paper:#fbfaf6;--muted:#71817a;--line:#d8e0d9;min-height:100vh;padding:28px 20px 60px;background:#e8ece7;color:var(--ink);font-family:"DM Sans",Arial,sans-serif}
        .jr-toolbar{max-width:820px;margin:0 auto 20px;display:flex;justify-content:space-between;align-items:center}.jr-brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.07em;font-size:14px}.jr-brand small{display:block;font-size:9px;letter-spacing:.13em;color:var(--muted);margin-top:3px}.jr-mark{width:32px;height:32px;background:var(--green);color:white;display:grid;place-items:center;clip-path:polygon(0 0,100% 0,100% 70%,50% 100%,0 70%);font-weight:800}.jr-print{border:0;background:var(--green);color:white;border-radius:9px;padding:12px 16px;display:flex;gap:9px;align-items:center;font-weight:700;cursor:pointer}.jr-print:hover{background:var(--ink)}
        .jr-sheet{position:relative;width:min(100%,794px);min-height:1122px;margin:0 auto 28px;padding:56px 64px 68px;background:var(--paper);box-shadow:0 12px 34px #263f3314;display:flex;flex-direction:column;overflow:hidden}.jr-kicker{font-size:10px;letter-spacing:.17em;font-weight:800;color:var(--green)}.jr-cover{background:radial-gradient(ellipse at 100% 5%,#e8f2ec 0,#e8f2ec 17%,transparent 17.2%),var(--paper)}.jr-cover-content{margin:auto 0}.jr-stamp{display:inline-flex;padding:8px 11px;background:#f4ead6;color:#86652d;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.14em}.jr-cover h1{font-family:Georgia,serif;font-weight:500;font-size:56px;line-height:1.04;letter-spacing:-.045em;margin:26px 0 18px;color:var(--ink)}.jr-cover h1 em,.jr-final h2 em{color:var(--green);font-weight:400}.jr-lead{max-width:515px;color:#54665e;font-size:16px;line-height:1.75}.jr-meta-grid{display:grid;gap:0;margin-top:42px;border-top:1px solid var(--line)}.jr-meta-grid label{font-size:11px;color:var(--muted);padding:14px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.jr-meta-grid label span{color:var(--ink);font-weight:700}.jr-line{display:inline-block;min-width:180px;border-bottom:1px solid var(--line);height:16px}.jr-callout{display:flex;gap:13px;align-items:flex-start;background:var(--mint);padding:15px 17px;border-radius:8px;margin-top:28px;color:var(--green)}.jr-callout p{margin:0;color:var(--ink);font-size:12px;line-height:1.65}
        .jr-footer{position:absolute;bottom:30px;left:64px;right:64px;border-top:1px solid var(--line);padding-top:12px;display:flex;justify-content:space-between;color:#829087;font-size:8px;font-weight:800;letter-spacing:.12em}.jr-page-head{display:flex;justify-content:space-between;align-items:center}.jr-page-tag{font-size:9px;font-weight:800;letter-spacing:.1em;color:#9a7a3c}.jr-page-title{display:flex;align-items:center;gap:17px;margin:44px 0 28px}.jr-index{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:var(--green);color:white;font-weight:800;font-size:14px}.jr-page-title h2{font-size:29px;letter-spacing:-.04em;margin:0;color:var(--ink)}.jr-page-title p{margin:4px 0 0;color:var(--muted);font-size:13px}.jr-description{background:var(--mint);padding:15px 18px;border-left:3px solid var(--green);margin-bottom:34px}.jr-description b{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--green)}.jr-description p{font-size:12px;line-height:1.6;margin:5px 0 0;color:#43584f}.jr-scale-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:8px}.jr-scale-head>span{font-weight:800;font-size:15px}.jr-scale-head small{font-size:10px;color:var(--muted)}.jr-questions{border-top:1px solid var(--line)}.jr-question{padding:17px 0 15px;border-bottom:1px solid var(--line)}.jr-question p{display:flex;gap:11px;align-items:flex-start;font-size:13px;line-height:1.5;margin:0 0 12px}.jr-question p b{font-size:10px;color:var(--green);padding-top:2px}.jr-rating{display:flex;align-items:center;gap:8px;color:var(--muted)}.jr-rating>span{font-size:9px}.jr-rating i{font-style:normal;border:1px solid #afc0b4;border-radius:50%;width:25px;height:25px;display:grid;place-items:center;font-size:10px;color:var(--ink)}.jr-note{margin-top:29px}.jr-note label,.jr-final-field label{display:block;font-size:12px;font-weight:800;margin-bottom:11px}.jr-writing-lines{height:150px;background:repeating-linear-gradient(to bottom,transparent 0,transparent 31px,var(--line) 32px,var(--line) 33px)}.jr-prompt{margin-top:24px;background:#f3efe4;padding:12px 14px;display:flex;gap:9px;align-items:flex-start;border-radius:5px;font-size:11px;line-height:1.5;color:#695734}.jr-final h2{font-family:Georgia,serif;font-size:42px;line-height:1.1;font-weight:500;letter-spacing:-.04em;margin:25px 0 26px}.jr-final-field{margin:9px 0 19px}.jr-lines-tall{height:80px}.jr-priority{margin-top:4px;padding:18px;background:var(--mint);display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:11px}.jr-priority>b{grid-column:1/-1}.jr-priority>div{display:flex;align-items:center;gap:8px}.jr-check{width:13px;height:13px;border:1px solid #799489;display:inline-block;flex:none}
        @media(max-width:600px){.jr-document{padding:12px 8px 32px}.jr-sheet{min-height:1000px;padding:34px 25px 62px}.jr-footer{left:25px;right:25px;bottom:22px;font-size:7px}.jr-cover h1{font-size:43px}.jr-toolbar{padding:0 3px}.jr-print{font-size:11px;padding:10px}.jr-page-title{margin:36px 0 25px}.jr-page-title h2{font-size:24px}.jr-scale-head{align-items:flex-start;gap:8px;flex-direction:column}.jr-rating{gap:6px}.jr-rating i{width:24px;height:24px}.jr-priority{grid-template-columns:1fr}}
        @media print{@page{size:A4;margin:0}.jr-document{padding:0;background:white}.jr-toolbar{display:none}.jr-sheet{width:210mm;height:297mm;min-height:297mm;margin:0;padding:17mm 18mm 21mm;box-shadow:none;break-after:page;page-break-after:always}.jr-sheet:last-child{break-after:auto;page-break-after:auto}.jr-footer{left:18mm;right:18mm;bottom:10mm}.jr-cover{background:radial-gradient(ellipse at 100% 5%,#e8f2ec 0,#e8f2ec 17%,transparent 17.2%),#fbfaf6}.jr-cover h1{font-size:48pt}.jr-page-title{margin:35px 0 24px}.jr-question{padding:14px 0 12px}.jr-writing-lines{height:140px}.jr-lines-tall{height:70px}}
      `}</style>
    </main>
  );
}
