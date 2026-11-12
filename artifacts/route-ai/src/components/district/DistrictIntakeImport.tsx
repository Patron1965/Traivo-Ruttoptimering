import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form } from "@/components/ui/form";
import { parseImportFile, type ParsedImportFile } from "@/lib/import-file";
import { buildSourceRows } from "@/lib/district-source-rows";
import { intakeApi, intakeKey, intakeBalanced, intakeMappingValid, type Intake, type IntakeMapping, type IntakeRow } from "@/lib/district-intake";
import { ErrorLine } from "./DistrictImport";
import { PagedList } from "./Pager";

const fields: { key: keyof IntakeMapping; label: string; hint: RegExp }[] = [
  { key: "objectNumber", label: "Objektnummer (obligatoriskt)", hint: /^(objekt|obj|object|id)/i },
  { key: "address", label: "Adress (obligatoriskt)", hint: /(adress|address|gata)/i },
  { key: "postalCode", label: "Postnummer", hint: /^(postnummer|postnr|zip)/i },
  { key: "city", label: "Ort", hint: /^(ort|city|postort)$/i },
  { key: "latitude", label: "Latitud (valfri, WGS84)", hint: /^(lat|y_wgs)/i },
  { key: "longitude", label: "Longitud (valfri, WGS84)", hint: /^(lon|lng|x_wgs)/i },
];
const blank: IntakeMapping = { objectNumber: "", address: "", postalCode: "", city: "", latitude: "", longitude: "" };
const selectClass = "w-full rounded-md border border-input bg-background p-2 text-sm";

export function DistrictIntakeImport({ planId, hasDataset, onDone }: { planId: string; hasDataset: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: intakeKey(planId), queryFn: () => intakeApi.get(planId), refetchInterval: 30000 });
  const sources = useQuery({ queryKey: ["district", "intake-sources"], queryFn: intakeApi.sources, staleTime: 10000 });
  const [mode, setMode] = useState("file");
  const [sourceId, setSourceId] = useState("");
  const [parsed, setParsed] = useState<ParsedImportFile | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const form = useForm<IntakeMapping>({ defaultValues: blank });
  const mapping = form.watch();
  const source = sources.data?.sources.find(s => s.id === sourceId);
  const headers = mode === "file" ? parsed?.headers ?? [] : source?.headers ?? [];
  const guess = (headers: string[]) => form.reset(Object.fromEntries(fields.map(f => [f.key, headers.find(h => f.hint.test(h.trim())) ?? ""])) as IntakeMapping);
  const refresh = async (result: { intake: Intake }) => {
    qc.setQueryData(intakeKey(planId), result);
    await qc.invalidateQueries({ queryKey: ["district"] });
  };
  const save = useMutation({
    mutationFn: async (values: IntakeMapping) => {
      if (!intakeMappingValid(values)) throw new Error("Välj olika kolumner för objektnummer och adress samt eventuella tillval.");
      if (mode === "draft") {
        if (!source) throw new Error("Välj ett importutkast.");
        return intakeApi.copy(planId, { draftId: source.id, revision: source.revision, mapping: values });
      }
      if (!parsed || !bytes) throw new Error("Välj en fil.");
      const fileHash = await crypto.subtle.digest("SHA-256", bytes);
      const mapHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
      const hex = (v: ArrayBuffer) => Array.from(new Uint8Array(v), b => b.toString(16).padStart(2, "0")).join("");
      return intakeApi.create(planId, { sourceKey: `intake:v1:${hex(fileHash)}:${hex(mapHash)}`, rows: buildSourceRows(parsed), mapping: values });
    },
    onSuccess: refresh,
    onError: () => { void qc.invalidateQueries({ queryKey: ["district", "intake-sources"] }); void query.refetch(); },
  });
  const intake = query.data?.intake;
  if (query.isLoading) return <p role="status">Läser sparat underlag…</p>;
  if (query.error) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  if (intake) return <IntakeReview planId={planId} intake={intake} onSaved={refresh} onDone={onDone} />;
  if (hasDataset) return <p>Denna plan har redan ett underlag. Zonerna finns under Zoner. Skapa en ny plan för en ny fil.</p>;
  return <div className="space-y-4">
    <h2 className="font-semibold">Sotningsunderlag och adresser</h2>
    <p className="text-sm text-muted-foreground">Alla källrader sparas. Koordinater är valfria. Inga order eller chaufförsuppdrag skapas och ingen geokodning startar automatiskt.</p>
    <label className="block text-sm">Underlag<select className={selectClass} value={mode} disabled={save.isPending} onChange={e => { setMode(e.target.value); form.reset(blank); setSourceId(""); setParsed(null); setBytes(null); setFileBusy(false); generation.current++; }}><option value="file">Ny Excel- eller CSV-fil</option><option value="draft">Återanvänd importutkast</option></select></label>
    {mode === "file" ? <label className="block text-sm">Välj fil<Input type="file" accept=".xlsx,.xls,.csv" disabled={save.isPending} onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      const token = ++generation.current; setFileBusy(true); setError(null); setParsed(null); setBytes(null); save.reset();
      try { const [data, buffer] = await Promise.all([parseImportFile(file, { preserveValues: true }), file.arrayBuffer()]);
        if (token === generation.current) { setParsed(data); setBytes(buffer); setFileName(file.name); guess(data.headers); }
      } catch (e) { if (token === generation.current) setError(e); } finally { if (token === generation.current) setFileBusy(false); }
    }} />{fileBusy ? "Läser fil…" : parsed && `${fileName}: ${parsed.sourceRowCount} källrader`}</label> : <div className="space-y-2">
      <label className="block text-sm">Importutkast<select className={selectClass} value={sourceId} disabled={save.isPending || sources.isLoading} onChange={e => { setSourceId(e.target.value); guess(sources.data?.sources.find(s => s.id === e.target.value)?.headers ?? []); save.reset(); }}><option value="">Välj importutkast</option>{sources.data?.sources.filter(s => s.headers.length > 0).map(s => <option key={s.id} value={s.id}>{s.name} · {s.sourceRowCount} källrader</option>)}</select></label>
      {sources.error && <ErrorLine error={sources.error} onRetry={() => void sources.refetch()} />}
      {source && <p className="text-sm">Original: {source.sourceRowCount} rader. Bearbetade: {source.mappedRowCount}. Kopieringen utgår från originalraderna, även om chaufförsflödet visar färre. Granskade koordinater återanvänds; originalutkastet ändras inte.</p>}
    </div>}
    {headers.length > 0 && <Form {...form}><form className="space-y-3" onSubmit={form.handleSubmit(v => save.mutate(v))}>
      {fields.map(f => <label className="block text-sm" key={f.key}>{f.label}<select className={selectClass} {...form.register(f.key)} disabled={save.isPending}><option value="">Ingen kolumn vald</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}</select></label>)}
      <Button type="submit" disabled={!intakeMappingValid(mapping) || save.isPending || fileBusy}>{save.isPending ? "Sparar underlag…" : mode === "draft" ? "Kopiera alla källrader" : "Spara alla källrader"}</Button>
    </form></Form>}
    {!!error && <ErrorLine error={error} />}
    {save.error && <ErrorLine error={save.error} />}
  </div>;
}

function IntakeReview({ planId, intake, onSaved, onDone }: { planId: string; intake: Intake; onSaved: (data: { intake: Intake }) => Promise<void>; onDone: () => void }) {
  const [filter, setFilter] = useState("unresolved");
  const review = useMutation({
    mutationFn: (args: { row: number; action: "search" | "accept"; address?: string; objectNumber?: string; candidateIndex?: number }) =>
      intakeApi.review(planId, args.row, args.action, { revision: intake.revision, address: args.address, objectNumber: args.objectNumber, candidateIndex: args.candidateIndex }),
    onSuccess: onSaved,
  });
  const qc = useQueryClient();
  return <section className="space-y-4">
    <h2 className="font-semibold">Granska sotningsadresser</h2>
    <p data-testid="district-intake-counts" className="text-sm">{intake.total} källrader = {intake.ready} klara + {intake.unresolved} att granska + {intake.rejected} avvisade.</p>
    {!intakeBalanced(intake) && <ErrorLine error={new Error("Radantalet stämmer inte. Ladda om underlaget innan du fortsätter.")} />}
    <p className="text-sm text-muted-foreground">Endast klara objekt visas på zonkartan. Övriga rader finns kvar här. Sökning görs endast när du klickar och kan medföra leverantörskostnad. Varje träff måste bekräftas.</p>
    <Button onClick={onDone} disabled={!intake.ready || !intakeBalanced(intake)}>Gå till Zoner ({intake.ready})</Button>
    <label className="block text-sm">Visa rader<select className={selectClass} value={filter} onChange={e => setFilter(e.target.value)}><option value="unresolved">Att granska ({intake.unresolved})</option><option value="rejected">Avvisade ({intake.rejected})</option><option value="ready">Klara ({intake.ready})</option><option value="all">Alla ({intake.total})</option></select></label>
    {review.error && <ErrorLine error={review.error} onRetry={() => { review.reset(); void qc.invalidateQueries({ queryKey: ["district"] }); }} note="Läs om underlaget vid en revisionskonflikt. Starta därefter sökningen igen om det behövs." />}
    <PagedList testId="district-intake-rows" pageSize={20} items={intake.rows.filter(r => filter === "all" || r.status === filter)} empty={<p className="text-sm">Inga rader i detta urval.</p>} render={row =>
      <ReviewRow key={`${row.sourceRowNumber}:${row.address}:${row.status}`} row={row} busy={review.isPending} onSearch={address => review.mutate({ row: row.sourceRowNumber, action: "search", address })} onAccept={(candidateIndex, objectNumber) => review.mutate({ row: row.sourceRowNumber, action: "accept", candidateIndex, objectNumber })} />} />
  </section>;
}

function ReviewRow({ row, busy, onSearch, onAccept }: { row: IntakeRow; busy: boolean; onSearch: (address: string) => void; onAccept: (index: number, objectNumber: string) => void }) {
  const form = useForm({ defaultValues: { address: row.address, objectNumber: row.objectNumber } });
  const values = form.watch();
  return <li className="space-y-2 py-4 text-sm">
    <p className="font-semibold">Rad {row.sourceRowNumber} · {row.objectNumber || "Objektnummer saknas"}</p>
    <p>{row.address}</p>
    {row.reason && <p className="text-destructive-text">{row.reason}</p>}
    {row.status === "rejected" && <p>Rätta strukturfelet i grundfilen och skapa en ny plan. Originalraden finns kvar här.</p>}
    {row.status === "unresolved" && <Form {...form}><form className="space-y-2" onSubmit={form.handleSubmit(v => onSearch(v.address))}>
      <label className="block">Objektnummer<Input {...form.register("objectNumber")} disabled={busy} /></label>
      <label className="block">Adress för sökning<Input {...form.register("address")} disabled={busy} /></label>
      <Button type="submit" variant="outline" disabled={busy || !values.address.trim()}>{busy ? "Bearbetar…" : "Sök adress"}</Button>
      {row.candidates?.map((c, i) => <div key={i} className="space-y-2 rounded border p-2"><p>{c.displayName}</p><p className="text-xs text-muted-foreground">{c.latitude}, {c.longitude}</p><Button type="button" variant="outline" disabled={busy || !values.objectNumber.trim() || values.address !== row.address} onClick={() => onAccept(i, values.objectNumber)}>Bekräfta träff</Button></div>)}
      {values.address !== row.address && !!row.candidates?.length && <p>Sök igen efter adressändring innan en träff bekräftas.</p>}
    </form></Form>}
    <details><summary className="cursor-pointer text-muted-foreground">Originalvärden</summary><dl className="mt-2 break-words">{Object.entries(row.original).map(([key, value]) => <div key={key}><dt className="font-medium">{key}</dt><dd>{value || "—"}</dd></div>)}</dl></details>
  </li>;
}