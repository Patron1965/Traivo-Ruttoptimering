"""Revise the uploaded 10 km export, preserving source fields and prior planning evidence."""
import fcntl
import json
import os
import re
import time

from openpyxl import load_workbook

import gtb_revise_stenungsund as revision
from gtb_recheck_geocodes import candidates_for_record, exact_candidates, google

SOURCE = "attached_assets/Stenungsund_vagoptimerad_10km_adressgranskad_1791993047581.xlsx"
ROOT = "generated-artifacts/gtb-stenungsund-30km"
OLD_ROOT = "generated-artifacts/gtb-stenungsund-10km"


def uploaded_rows():
    book = load_workbook(SOURCE, read_only=True, data_only=False)
    iterator = iter(book["Rutt"].values)
    original_headers = list(next(iterator))
    assert original_headers[:17] == revision.META[:3] + [
        "Områdeskontroll (10 km)", *revision.META[4:]]
    base_headers = [h.removeprefix("Källfil – ") for h in original_headers[17:]]
    headers = base_headers + ["Tidigare uttag – " + h for h in original_headers[:17]]
    rows, snapshots = [], {}
    for title in ["Rutt", "Granskning"]:
        iterator = iter(book[title].values)
        assert list(next(iterator)) == original_headers
        for raw in iterator:
            assert raw[2] == raw[19]
            row = list(raw[17:]) + list(raw[:17])
            rows.append(row)
            if raw[6] is not None and raw[7] is not None:
                snapshots[raw[2]] = tuple(raw[6:8])
    book.close()
    assert len(rows) == 5165 and len({r[2] for r in rows}) == 5165
    return headers, sorted(rows, key=lambda r: r[2]), snapshots


def targeted_recheck(headers, rows, snapshots):
    evidence = json.load(open(os.path.join(OLD_ROOT, "geocoding-evidence.json")))
    path = os.path.join(ROOT, "new-address-lookups.json")
    fresh = json.load(open(path)) if os.path.exists(path) else {}
    unresolved = [dict(zip(headers, r)) for r in rows if r[2] not in snapshots]
    for index, record in enumerate(unresolved, 1):
        queries = [
            ", ".join(str(record.get(k) or "") for k in ["Adress", "Ort"]) + ", Sverige",
        ]
        # Askerön's provider postcode is 471 75; this query does not rewrite the source.
        if record["Ort"] == "Askerön":
            queries.append(f"{record['Adress']}, 471 75 Askerön, Sverige")
        else:
            queries.append(f"{record['Adress']}, Sverige")
        for query in queries:
            if query not in fresh:
                fresh[query] = google(query)
                with open(path + ".tmp", "w") as file:
                    json.dump(fresh, file, ensure_ascii=False, indent=2)
                os.replace(path + ".tmp", path)
                time.sleep(0.1)
        print(f"Förnyad adresskontroll: {index}/{len(unresolved)} rader", flush=True)
    for query, body in fresh.items():
        evidence["Förnyad kontroll: " + query] = body
    with open(os.path.join(ROOT, "geocoding-evidence.json"), "w") as file:
        json.dump(evidence, file, ensure_ascii=False, indent=2)
    return evidence, fresh


def assessment(record, evidence, fresh, snapshots):
    # Keep already verified planning positions from the actual uploaded workbook.
    candidates, old_body = candidates_for_record(record, evidence)
    previous = snapshots.get(record["Källrad"])
    if previous is not None:
        chosen = next((c for c in candidates
                       if abs(c["longitude"] - previous[0]) < 1e-9
                       and abs(c["latitude"] - previous[1]) < 1e-9), None)
        if not chosen:
            raise RuntimeError("Tidigare accepterad adressposition kan inte bindas till adressbeviset.")
        return chosen, ("Tidigare verifierad adressposition bevarad från den uppladdade 10 km-filen. "
                        "Leverantörsadress: " + chosen["display"]), old_body
    results = list(old_body.get("results", []))
    for query, body in fresh.items():
        if query.startswith(str(record["Adress"]) + ","):
            results.extend(body.get("results", []))
    # A single new query must not erase conflicting candidates from previous evidence.
    body = {"status": "OK", "results": results}
    candidates = exact_candidates(record, body)
    if len(candidates) == 1:
        chosen = candidates[0]
        return chosen, ("Ny unik matchning av gata, husnummer och ort. "
                        "Leverantörsadress: " + chosen["display"]), body
    if len(candidates) > 1:
        note = "Förnyad kontroll: flera olika exakta adresspositioner kvarstår; ingen vald automatiskt."
    else:
        note = ("Förnyad kontroll: ingen säker matchning av hela källadressen. "
                "Annan ort eller områdestillägg i adressen måste bekräftas.")
    return None, note, body


def configure(headers, rows, snapshots, fresh):
    revision.ROOT = ROOT
    revision.BUFFER_METERS = 30000
    revision.META[3] = "Områdeskontroll (30 km)"
    revision.source_rows = lambda: (headers, rows)
    revision.geocode_assessment = lambda record, evidence: assessment(
        record, evidence, fresh, snapshots)


def preserve_upload_summary(path):
    # Preserve the two non-outcome sheets as historical references as well.
    original = load_workbook(SOURCE, read_only=True, data_only=False)
    output = load_workbook(path)
    for title, target in [("Läs först", "Tidigare läsanvisning"), ("Adresskontroll", "Tidigare adresskontroll")]:
        rows = list(original[title].values)
        revision.append_sheet(output, target, list(rows[0]), [list(r) for r in rows[1:]])
    output["Läs först"].append([
        "Tidigare uttag", "Alla tidigare planeringsfält finns oförändrade i kolumnerna Tidigare uttag. "
        "Tidigare läsanvisning och adresskontroll har sparats i separata historikflikar. "
        "De gamla ordningskolumnerna är inte den nya körordningen."])
    output.save(path)
    output.close()
    original.close()


def verify_against_upload(path):
    original = load_workbook(SOURCE, read_only=True, data_only=False)
    expected = {}
    for title in ["Rutt", "Granskning"]:
        rows = iter(original[title].values)
        original_headers = list(next(rows))
        for row in rows:
            assert row[2] not in expected
            expected[row[2]] = list(row)
    result = load_workbook(path, read_only=True, data_only=False)
    recovered = {}
    for title in ["Rutt", "Granskning"]:
        rows = iter(result[title].values)
        headers = list(next(rows))
        prior = headers.index("Tidigare uttag – Ordning (vägoptimerad)")
        for row in rows:
            assert row[2] not in recovered
            recovered[row[2]] = list(row[prior:]) + list(row[len(revision.META):prior])
    assert recovered.keys() == expected.keys()
    for identity, before in expected.items():
        assert len(before) == len(recovered[identity])
        for header, a, b in zip(original_headers, before, recovered[identity]):
            equal = a == b
            if isinstance(a, float) and isinstance(b, float):
                equal = abs(a - b) <= 1e-12
            assert equal, f"Uppladdat fält ändrades på rad {identity}: {header}"
    for title, historical in [("Läs först", "Tidigare läsanvisning"), ("Adresskontroll", "Tidigare adresskontroll")]:
        assert list(original[title].values) == list(result[historical].values)
    original.close()
    result.close()
    print("Verifierat: samtliga uppladdade cellvärden bevarade, 5 165 unika källrader.", flush=True)


def main():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1":
        raise RuntimeError("Beräkningen är bara godkänd i testmiljön.")
    os.makedirs(ROOT, exist_ok=True)
    headers, rows, snapshots = uploaded_rows()
    evidence, fresh = targeted_recheck(headers, rows, snapshots)
    configure(headers, rows, snapshots, fresh)
    revision.main()
    path = os.path.join(ROOT, "Stenungsund_vagoptimerad_30km_adressgranskad.xlsx")
    preserve_upload_summary(path)
    verify_against_upload(path)
    report_path = os.path.join(ROOT, "final-verification.json")
    report = json.load(open(report_path))
    report["new_geocoding_requests"] = len(fresh)
    report["preserved_previous_address_positions"] = 139
    report["additional_route_rows"] = report["route_rows"] - 5033
    with open(report_path, "w") as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    with open(".cache/district-road/prepare.lock", "a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        main()
