"""Bounded Google address lookup and Excel export; no database or source writes."""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell import _writer
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo


def normalize(value):
    value = unicodedata.normalize("NFKD", str(value or "")).casefold()
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]", "", value)


def components(result):
    return {kind: component["long_name"]
            for component in result.get("address_components", [])
            for kind in component["types"]}


def assess(record, result, bounds):
    fields = components(result)
    address = re.fullmatch(r"\s*(.+?)\s+(\d+\s*[a-zA-Z]?)\s*", str(record["Adress"]))
    location = result.get("geometry", {}).get("location", {})
    lat, lon = location.get("lat"), location.get("lng")
    valid = (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
             and math.isfinite(lat) and math.isfinite(lon)
             and -90 <= lat <= 90 and -180 <= lon <= 180)
    inside = bool(valid and bounds[0] <= lat <= bounds[2] and bounds[1] <= lon <= bounds[3])
    street_match = bool(address and normalize(address[1]) == normalize(fields.get("route")))
    number_match = bool(address and normalize(address[2]) == normalize(fields.get("street_number")))
    postcode_match = bool(normalize(record["Postnummer"])
                          and normalize(record["Postnummer"]) == normalize(fields.get("postal_code")))
    localities = [component["long_name"] for component in result.get("address_components", [])
                  if any(kind in {"postal_town", "locality", "sublocality",
                                  "sublocality_level_1", "sublocality_level_2"}
                         for kind in component["types"])]
    locality_match = normalize(record["Ort"]) in {normalize(value) for value in localities}
    country_match = any("country" in component["types"] and component.get("short_name") == "SE"
                        for component in result.get("address_components", []))
    address_level = bool(set(result.get("types", [])) & {"street_address", "premise"})
    location_type = result.get("geometry", {}).get("location_type")
    reasons = []
    for condition, reason in [
        (valid, "Ogiltiga koordinatvärden"),
        (country_match, "Landet matchar inte Sverige"),
        (inside, "Utanför originalfilens koordinatområde"),
        (address_level, "Inte en träff på besöksadress"),
        (street_match, "Gata/adressnamn matchar inte"),
        (number_match, "Husnummer matchar inte"),
        (postcode_match, "Postnummer avviker eller saknas"),
        (locality_match, "Ort avviker eller saknas"),
        (not result.get("partial_match", False), "Leverantören markerar delvis matchning"),
        (location_type == "ROOFTOP", "Positionen är interpolerad eller ungefärlig"),
    ]:
        if not condition:
            reasons.append(reason)
    # One exact street/number candidate is useful for manual review even with
    # conflicting source postcodes; those conflicts must never be auto-approved.
    rank = (int(country_match and valid), int(street_match and number_match and address_level),
            int(inside), int(postcode_match), int(locality_match),
            int(location_type == "ROOFTOP"), int(not result.get("partial_match", False)))
    return {"accepted": not reasons, "reasons": reasons, "latitude": lat, "longitude": lon,
            "postcode": fields.get("postal_code"), "localities": "; ".join(localities),
            "address": result.get("formatted_address"), "location_type": location_type,
            "place_id": result.get("place_id"), "rank": rank,
            "street_number_match": street_match and number_match and address_level}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def lookup(query, key, bounds):
    parameters = urllib.parse.urlencode({
        "address": query, "components": "country:SE", "language": "sv",
        "bounds": f"{bounds[0]},{bounds[1]}|{bounds[2]},{bounds[3]}", "key": key,
    })
    try:
        with urllib.request.urlopen(
                "https://maps.googleapis.com/maps/api/geocode/json?" + parameters, timeout=25) as response:
            return json.load(response)
    except Exception:
        # urllib exceptions may contain the credential-bearing request URL.
        return {"status": "NETWORK_ERROR", "results": []}


def decorate(sheet, widths):
    sheet.freeze_panes = "D2"
    for index, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    for cell in sheet[1]:
        cell.fill = PatternFill("solid", fgColor="17475E")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    sheet.row_dimensions[1].height = 42
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        sheet.row_dimensions[row[0].row].height = 52


def run(source_path, output_path, state_path, max_calls, approve_postcode_only=False):
    if source_path.resolve() == output_path.resolve():
        raise ValueError("Do not overwrite the original workbook.")
    fingerprint = hashlib.sha256(source_path.read_bytes()).hexdigest()
    workbook = load_workbook(source_path)
    original = workbook.worksheets[0]
    original_title = original.title
    header = [cell.value for cell in original[1]]
    records = [dict(zip(header, values), original_row=row)
               for row, values in enumerate(original.iter_rows(min_row=2, values_only=True), 2)]
    missing = [record for record in records
               if record["Latitud"] is None or record["Longitud"] is None]
    if len(missing) != 161:
        raise ValueError("This approved batch must contain precisely the 161 missing stops.")
    good = [record for record in records if record not in missing]
    bounds = [min(record["Latitud"] for record in good), min(record["Longitud"] for record in good),
              max(record["Latitud"] for record in good), max(record["Longitud"] for record in good)]
    state = (json.loads(state_path.read_text()) if state_path.exists() else
             {"source_sha256": fingerprint, "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "calls": 0, "requests": {}, "results": {}})
    if state["source_sha256"] != fingerprint:
        raise ValueError("Saved lookup state belongs to a different original file.")
    if (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(state["started_at"])).days >= 30:
        raise ValueError("Lookup cache expired. A new authorized lookup is required.")
    cached_batch = all(str(record["original_row"]) in state["results"] for record in missing)
    if approve_postcode_only and not cached_batch:
        raise ValueError("Postcode approval is export-only; all 161 lookup results must already exist.")
    key = None if cached_batch else os.environ.get("GOOGLE_MAPS_API_KEY")
    if not cached_batch and not key:
        raise ValueError("Google Maps credential is not configured; no requests sent.")
    for count, record in enumerate(missing, 1):
        identity = str(record["original_row"])
        if identity in state["results"]:
            continue
        queries = [
            f'{record["Adress"]}, {record["Postnummer"] or ""} {record["Ort"]}, Sverige',
            f'{record["Adress"]}, {record["Ort"]}, Sverige',
        ]
        candidates = {}
        statuses = []
        used_queries = []
        for query in dict.fromkeys(queries):
            if query not in state["requests"]:
                if state["calls"] >= max_calls:
                    raise ValueError("Lookup request budget reached; no further requests sent.")
                state["calls"] += 1
                state["requests"][query] = {"status": "RESERVED_OR_FAILED", "results": []}
                save_state(state_path, state)
                body = lookup(query, key, bounds)
                if body.get("status") not in {"OK", "ZERO_RESULTS", "NETWORK_ERROR"}:
                    save_state(state_path, state)
                    raise ValueError(f'Google rejected the request: {body.get("status")}. Batch stopped.')
                # Store only provider address evidence, not owners or object lists.
                state["requests"][query] = {
                    "status": body.get("status"),
                    "results": [{field: result.get(field) for field in
                                 ["address_components", "formatted_address", "geometry",
                                  "partial_match", "place_id", "types"]}
                                for result in body.get("results", [])],
                }
                save_state(state_path, state)
                time.sleep(0.1)
            body = state["requests"][query]
            statuses.append(body["status"])
            used_queries.append(query)
            for result in body["results"]:
                evaluated = assess(record, result, bounds)
                candidate_key = evaluated["place_id"] or str((evaluated["latitude"], evaluated["longitude"]))
                # Do not let a later partial response replace stronger evidence.
                if candidate_key not in candidates or tuple(evaluated["rank"]) > tuple(candidates[candidate_key]["rank"]):
                    candidates[candidate_key] = evaluated
            best = sorted(candidates.values(), key=lambda item: tuple(item["rank"]), reverse=True)
            # No need for a fallback if the exact street/number was already found:
            # a mismatching postcode is a data-review issue, not a search failure.
            if best and best[0]["street_number_match"]:
                break
        eligible = [item for item in candidates.values() if item["accepted"]]
        best = sorted(candidates.values(), key=lambda item: tuple(item["rank"]), reverse=True)
        chosen = best[0] if best else None
        accepted = len(eligible) == 1
        if accepted:
            chosen = eligible[0]
        elif len(eligible) > 1:
            chosen["reasons"].append("Flera verifierade kandidater – kräver val")
        state["results"][identity] = {
            "accepted": accepted, "candidate": chosen, "candidate_count": len(candidates),
            "queries": used_queries, "statuses": statuses,
            "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        save_state(state_path, state)
        if count % 25 == 0 or count == len(missing):
            print(f"Reviewed {count}/{len(missing)}; provider requests={state['calls']}", flush=True)

    results = state["results"]
    postcode_only_rows = {
        record["original_row"] for record in missing
        if results[str(record["original_row"])]["candidate"]
        and not results[str(record["original_row"])]["accepted"]
        and results[str(record["original_row"])]["candidate"]["reasons"] == ["Postnummer avviker eller saknas"]
    }
    if approve_postcode_only and len(postcode_only_rows) != 145:
        raise ValueError("The authorized approval covers precisely the 145 postcode-only proposals.")
    approved_rows = postcode_only_rows if approve_postcode_only else set()
    approval_time = dt.datetime.now(dt.timezone.utc).isoformat() if approved_rows else None
    completed = workbook.copy_worksheet(original)
    completed.title = "Kompletterat underlag"
    metadata_headers = ["Ny koordinatstatus", "Ny koordinatkälla", "Sökdatum UTC", "Kontrollnotering"]
    for offset, name in enumerate(metadata_headers, len(header) + 1):
        completed.cell(1, offset, name)
        completed.column_dimensions[get_column_letter(offset)].width = 32 if offset < len(header) + 4 else 75
    search = workbook.create_sheet("Sökresultat 161")
    search.append([
        "Originalrad", "StoppID", "Adress original", "Postnummer original", "Ort original",
        "Resultatstatus", "Latitud hittad", "Longitud hittad", "Träffadress",
        "Postnummer hittat", "Ort hittad", "Positionstyp", "Kontrollorsak",
        "Antal kandidater", "Källa", "Sökdatum UTC", "Google Place ID", "Sökfrågor",
    ])
    counts = Counter()
    updated_rows = set()
    for record in missing:
        result = results[str(record["original_row"])]
        candidate = result["candidate"]
        manually_approved = record["original_row"] in approved_rows
        status = ("Kompletterad – verifierad adress" if result["accepted"] else
                  "Kompletterad – godkänd postnummeravvikelse" if manually_approved else
                  "Kandidat – behöver granskas" if candidate else "Ingen träff")
        counts[status] += 1
        note = ("Gata, husnummer, postnummer och ort matchar. ROOFTOP inom underlagets koordinatområde."
                if result["accepted"] else "; ".join(candidate["reasons"]) if candidate else
                "Ingen kandidat efter sökning. Leverantörsstatus: " + ", ".join(result["statuses"]))
        if manually_approved:
            note += (
                f". Koordinater införda med användarens uttryckliga godkännande {approval_time}. "
                f"Originalpostnummer {record['Postnummer']} behållet; Google anger {candidate['postcode']}. "
                "Godkännandet avser koordinatförslaget, inte en fullständig automatisk adressverifiering."
            )
        source_row = record["original_row"]
        if result["accepted"] or manually_approved:
            completed.cell(source_row, header.index("Latitud") + 1, candidate["latitude"])
            completed.cell(source_row, header.index("Longitud") + 1, candidate["longitude"])
            completed.cell(source_row, header.index("Geokodningskvalitet") + 1, "Exakt")
            updated_rows.add(source_row)
        for offset, value in enumerate([status, "Google Maps – Geocoding API", result["checked_at"], note], len(header) + 1):
            completed.cell(source_row, offset, value)
        search.append([
            source_row, record["StoppID"], record["Adress"], record["Postnummer"], record["Ort"],
            status, candidate["latitude"] if candidate else None,
            candidate["longitude"] if candidate else None, candidate["address"] if candidate else None,
            candidate["postcode"] if candidate else None, candidate["localities"] if candidate else None,
            candidate["location_type"] if candidate else None, note, result["candidate_count"],
            "Google Maps – Geocoding API", result["checked_at"],
            candidate["place_id"] if candidate else None, "\n".join(result["queries"]),
        ])
        for cell in search[search.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    decorate(search, [13, 17, 32, 20, 20, 39, 19, 19, 56, 20, 25, 24, 86, 18, 30, 30, 32, 70])
    for row in search.iter_rows(min_row=2):
        for cell in row[6:8]:
            cell.number_format = "0.000000"
        row[5].fill = PatternFill("solid", fgColor="E2F0D9" if row[5].value.startswith("Kompletterad") else "FFF2CC")
    table = Table(displayName="MissingCoordinateResults", ref=f"A1:R{search.max_row}")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
    search.add_table(table)
    completed.freeze_panes = "G2"
    completed.auto_filter.ref = f"A1:{get_column_letter(completed.max_column)}{completed.max_row}"
    for row in updated_rows:
        for name in ["Latitud", "Longitud", "Geokodningskvalitet"]:
            completed.cell(row, header.index(name) + 1).fill = PatternFill("solid", fgColor="E2F0D9")
    summary = workbook.create_sheet("Läs mig", 0)
    postcode_only = len(postcode_only_rows)
    summary_rows = [
        ["KOORDINATKOMPLETTERING – STENUNGSUNDSUNDERLAG", ""],
        ["Originalfil", source_path.name],
        ["Originalstopp / originalkolumner", f"{len(records)} / {len(header)}"],
        ["Sökta stopp utan koordinater", len(missing)],
        ["Kompletterade totalt", len(updated_rows)],
        ["Kompletterade med fullständig adressmatchning", sum(result["accepted"] for result in results.values())],
        ["Kompletterade efter användarens godkännande av postnummeravvikelse", len(approved_rows)],
        ["Kandidater som behöver godkännas", counts["Kandidat – behöver granskas"]],
        ["Kvarvarande förslag där endast postnummer avviker", postcode_only - len(approved_rows)],
        ["Kandidater med andra osäkerheter", counts["Kandidat – behöver granskas"] - (postcode_only - len(approved_rows))],
        ["Stopp utan träff", counts["Ingen träff"]],
        ["Fortfarande utan koordinater i kompletterat underlag", len(missing) - len(updated_rows)],
        ["Provideranrop i detta körbara batchflöde", state["calls"]],
        ["Inledande stickprov utöver batchen", "4 anrop"],
        ["", ""],
        ["BLAD OCH GRANSKNING", ""],
        ["Kompletterat underlag", "Alla originalrader och originalkolumner plus fyra spårbarhetsfält. Endast verifierade eller uttryckligen godkända saknade koordinater och deras geokodningskvalitet har uppdaterats. Gröna celler visar ändringar."],
        ["Sökresultat 161", "Alla 161 sökta stopp och hittade kandidater. Godkända träffar är gröna. Gula rader är fortfarande osäkra och deras koordinater har INTE överförts till underlaget."],
        ["Godkännande av postnummeravvikelser", f"{len(approved_rows)} förslag införda efter användarens uttryckliga godkännande. Originalpostnumren är oförändrade. Avvikelsen, leverantörens postnummer och godkännandets tidpunkt anges per stopp."],
        [original_title, "Oförändrade originalvärden, inklusive de ursprungliga koordinaterna."],
        ["Varför en kandidat kan behöva granskas", "Även en tydlig träff på rätt gata och husnummer måste kontrolleras om originalets postnummer eller ort avviker. Interpolerade, delvisa eller breda träffar har inte godkänts automatiskt."],
        ["Geografisk kontroll", "Träffen måste ligga inom min-/maxområdet för originalfilens befintliga koordinater. Detta är ett områdesfilter, INTE en verifiering av Stenungsunds kommungräns eller vägnät."],
        ["Områdesfilter WGS84", f"Latitud {bounds[0]}–{bounds[2]}, longitud {bounds[1]}–{bounds[3]}"],
        ["Originalets granskningsflaggor", "Granskningsprioritet och Behöver granskas har behållits från originalet även för kompletterade stopp. Övriga tidigare koordinatproblem har inte lösts i denna körning."],
        ["Källa och tid", f"Google Maps – Geocoding API. Sökning påbörjad {state['started_at']}. Datum och källa finns per sökt stopp."],
        ["Färskhet", "Google-koordinater i arbetsunderlaget ska inte användas som en permanent adressdatabas. Om underlaget återanvänds efter 30 dagar behöver koordinaternas aktualitet och användningsvillkor kontrolleras."],
        ["Vad som inte har gjorts", "Ingen ruttoptimering, väganslutningskontroll, databasimport, ändring av adresser/postnummer/orter, sammanslagning eller borttagning av stopp/objekt."],
    ]
    for row in summary_rows:
        summary.append(row)
    summary.column_dimensions["A"].width = 58
    summary.column_dimensions["B"].width = 112
    for row in summary:
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        summary.row_dimensions[row[0].row].height = 52
    for row in summary:
        if row[0].value and str(row[0].value).isupper():
            for cell in row:
                cell.fill = PatternFill("solid", fgColor="17475E")
                cell.font = Font(color="FFFFFF", bold=True, size=12)
    # Put the intended import sheet before the unchanged original sheet.
    workbook._sheets = [summary, completed, search, original]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    previous = _writer.safe_string
    try:
        _writer.safe_string = lambda value: repr(value) if isinstance(value, float) and math.isfinite(value) else previous(value)
        workbook.save(output_path)
    finally:
        _writer.safe_string = previous
        workbook.close()

    generated = load_workbook(output_path, read_only=True)
    baseline = load_workbook(source_path, read_only=True)
    before = list(baseline.worksheets[0].iter_rows(values_only=True))
    after = list(generated[original_title].iter_rows(values_only=True))
    assert before == after, "Original sheet changed."
    assert generated["Kompletterat underlag"].max_row == len(before)
    allowed_columns = {header.index(name) for name in ["Latitud", "Longitud", "Geokodningskvalitet"]}
    for row_index, row in enumerate(generated["Kompletterat underlag"].iter_rows(values_only=True), 1):
        for column, old_value in enumerate(before[row_index - 1]):
            if row_index not in updated_rows or column not in allowed_columns:
                assert row[column] == old_value, f"Unexpected source change at row {row_index}, col {column + 1}"
        if row_index in updated_rows:
            assert row[header.index("Latitud")] is not None and row[header.index("Longitud")] is not None
    assert generated["Sökresultat 161"].max_row == 162
    assert fingerprint == hashlib.sha256(source_path.read_bytes()).hexdigest()
    assert len(updated_rows) == sum(result["accepted"] for result in results.values()) + len(approved_rows)
    generated.close()
    baseline.close()
    print(json.dumps({"source_rows": len(records), "searched": len(missing), "filled": len(updated_rows),
                      "results": dict(counts), "calls": state["calls"],
                      "manually_approved_postcode_discrepancies": len(approved_rows),
                      "original_values_preserved": True, "output": str(output_path)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--max-calls", type=int, default=322)
    parser.add_argument("--approve-postcode-only", action="store_true",
                        help="Export the explicitly user-approved 145 postcode-only proposals without new lookups.")
    arguments = parser.parse_args()
    run(arguments.source, arguments.output, arguments.state, arguments.max_calls,
        arguments.approve_postcode_only)
