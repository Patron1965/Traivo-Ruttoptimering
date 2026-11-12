"""Lossless, literal-cell GTB route exports with road evidence and separate review sheets."""
import datetime
import glob
import math
import os

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = "generated-artifacts/gtb-routes"
DEPOT_ADDRESS = "Ruskvädersgatan 13, 418 34 Göteborg"
EXTRA_HEADERS = [
    "Körsträcka från föregående (km)", "Beräknad körtid från föregående (min)",
    "Ackumulerad körsträcka (km)", "Avstånd till kartlagd bilväg (m)",
    "Väganknytning – anmärkning", "Beräkningslongitud", "Beräkningslatitud",
]


def append_literal(sheet, values, number):
    sheet.append(values)
    for column, value in enumerate(values, 1):
        if isinstance(value, str):
            sheet.cell(number, column).data_type = "s"


def style_sheet(sheet, headers, count):
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{count + 1}"
    sheet.row_dimensions[1].height = 54
    for column, title in enumerate(headers, 1):
        cell = sheet.cell(1, column)
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = PatternFill("solid", fgColor="173B52")
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        sheet.column_dimensions[get_column_letter(column)].width = min(42, max(13, len(str(title)) + 2))
    sheet.sheet_view.zoomScale = 80


def export_workbook(name, vehicle, headers, partitions, records, route_evidence, identity, depot, depot_evidence):
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Läs först"
    final = dict(zip(headers, records[-1]["values"]))
    end_address = ", ".join(str(final.get(key) or "") for key in ["Adress", "Postnummer", "Ort"])
    total_source = sum(len(rows) for rows in partitions.values())
    warnings = sum(record["road_warning"] for record in records)
    details = [
        ["Uppgift", "Värde"],
        ["Område", name],
        ["Status", "VÄGOPTIMERAD KÖRORDNING – befintliga positioner; inte en dagsplan"],
        ["Fordon", f"{vehicle}: ett planeringsfordon, ingen operativ tilldelning"],
        ["Startadress", DEPOT_ADDRESS],
        ["Slutadress – sista stoppet", end_address],
        ["Återresa till startadressen", "Nej – öppen rutt, inget depotben efter sista stoppet"],
        ["Stopp i rutten", len(records)],
        ["Stopp för granskning", len(partitions["Granskning"])],
        ["Stopp på öar utan bilförbindelse", len(partitions.get("Öar utan bro", []))],
        ["Ursprungliga stopp / kontrollsumma", total_source],
        ["Körsträcka enligt väggeometri (km)", route_evidence["distance_meters"] / 1000],
        ["Beräknad körtid (timmar)", route_evidence["drive_seconds"] / 3600],
        ["Tider", "Endast beräknad bilkörning. Inga sotningstider, pauser, arbetspass eller datum har antagits."],
        ["Optimeringsmetod", "Komplett riktad vägmatris; flera närmaste-granne-starter, riktade flyttar och 2-opt. Heuristiskt resultat, ingen garanti om globalt kortaste rutt."],
        ["Vägsträckor", "OSRM:s bilprofil väljer vägförbindelser; sträckan mellan stoppen används som optimeringsmått. Ingen fågelvägsersättning."],
        ["Samplacerade objekt", "Varje ursprungsrad finns kvar. Exakt samplacerade objekt besöks tillsammans och delar vägberäkning."],
        ["Osäkra positioner", "Inkluderade enligt ditt geografiska urval. Originalkoordinater och kvalitetsfält har inte ändrats; körningen bevisar inte att varje adressposition är korrekt."],
        ["Stopp längre än 250 m från bilväg", warnings],
        ["Godkänd avståndsvarning", "Dessa stopp är inkluderade enligt ditt val. Körningen beräknas till närmaste kartlagda bilväg; det bevisar inte bilåtkomst till själva adressen."],
        ["Kommungränser", "Lantmäteriets generaliserade kommungränser via ArcGIS, med 500 meters marginal. Alla utanförurval bevaras i Granskning."],
        ["Öklassificering", "Källans adress/ort/fastighet samt OSM:s ökonturer. Koordinatbaserade tillägg märks uttryckligen; de kan bero på felaktiga källkoordinater."],
        ["Startpunkt i kartdata", f"Exakt gata och husnummer i OSM, {depot_evidence['osm_type']} {depot_evidence['osm_id']}; byggnadens referenspunkt, inte verifierad infart."],
        ["Startlongitud", depot[0]],
        ["Startlatitud", depot[1]],
        ["Vägdatakälla", identity["source"]],
        ["Vägdata / licens", identity["attribution"]],
        ["Motor / profil", f"{identity['engine']}, CH, car"],
        ["Vägdatans SHA-256", identity["graph_sha256"]],
        ["Bilprofilens SHA-256", identity["profile_sha256"]],
        ["Skapad UTC", datetime.datetime.now(datetime.timezone.utc).isoformat()],
    ]
    for index, values in enumerate(details, 1):
        append_literal(summary, values, index)
    style_sheet(summary, details[0], len(details) - 1)
    summary.auto_filter.ref = None
    summary.column_dimensions["A"].width = 38
    summary.column_dimensions["B"].width = 108
    for row in summary:
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for index in range(2, len(details) + 1):
        summary.row_dimensions[index].height = 40
    output_headers = ["Ordning (vägoptimerad)", *headers[1:7], *EXTRA_HEADERS, *headers[7:]]
    route_sheet = workbook.create_sheet("Rutt")
    append_literal(route_sheet, output_headers, 1)
    cumulative = 0
    for index, record in enumerate(records, 1):
        cumulative += record["distance_meters"]
        values = record["values"]
        meta = [index, vehicle, *values[2:7]]
        warning = (
            "AVSTÅNDSVARNING – körning till närmaste bilväg, inte verifierad åtkomst till adressen"
            if record["road_warning"] else "Väganknytning verifierad inom 250 m; källposition kan vara osäker"
        )
        added = [record["distance_meters"] / 1000, record["drive_seconds"] / 60,
                 cumulative / 1000, record["snap_distance_meters"], warning, *record["calculation_coordinate"]]
        append_literal(route_sheet, meta + added + values[7:], index + 1)
        for column in range(8, 12):
            route_sheet.cell(index + 1, column).number_format = "0.00"
        if record["road_warning"]:
            for column in [11, 12]:
                route_sheet.cell(index + 1, column).fill = PatternFill("solid", fgColor="FFF2CC")
    style_sheet(route_sheet, output_headers, len(records))
    route_sheet.column_dimensions["L"].width = 62
    for title in ["Granskning", "Öar utan bro"]:
        if title not in partitions:
            continue
        sheet = workbook.create_sheet(title)
        append_literal(sheet, output_headers, 1)
        for index, values in enumerate(sorted(partitions[title], key=lambda row: row[2]), 2):
            append_literal(sheet, list(values[:7]) + [None] * len(EXTRA_HEADERS) + list(values[7:]), index)
        style_sheet(sheet, output_headers, len(partitions[title]))
    file_name = "Tjorn_vagoptimerad_rutt.xlsx" if name == "Tjörn" else "Stenungsund_vagoptimerad_rutt.xlsx"
    path = os.path.join(ROOT, file_name)
    if os.path.exists(path):
        raise RuntimeError("Ett tidigare slututtag finns redan; historisk export ersätts inte.")
    workbook.save(path)
    verify_export(path, name, len(records), len(output_headers) - (len(headers) - 7), route_evidence)
    return {"file": path, "municipality": name, "source_count": total_source, "route_count": len(records),
            "review_count": len(partitions["Granskning"]), "island_count": len(partitions.get("Öar utan bro", [])),
            "road_warning_count": warnings, "end_address": end_address,
            "distance_km": route_evidence["distance_meters"] / 1000,
            "drive_hours": route_evidence["drive_seconds"] / 3600}


def verify_export(path, municipality, count, metadata_count, road_evidence):
    source_pattern = "*1791979011255.xlsx" if municipality == "Tjörn" else "*1791979015894.xlsx"
    matches = glob.glob("attached_assets/" + source_pattern)
    if len(matches) != 1:
        raise RuntimeError("Källfilen kunde inte identifieras entydigt.")
    source = load_workbook(matches[0], read_only=True, data_only=False)
    iterator = source.active.iter_rows(values_only=True)
    original_headers = list(next(iterator))
    expected = {index: list(values) for index, values in enumerate(iterator, 2) if any(v is not None for v in values)}
    source.close()
    output = load_workbook(path, read_only=True, data_only=False)
    recovered = {}
    distances, durations = [], []
    for sheet in output:
        if sheet.title == "Läs först":
            continue
        iterator = sheet.iter_rows(values_only=True)
        output_headers = list(next(iterator))
        if output_headers[metadata_count:] != original_headers:
            raise RuntimeError("Källkolumnerna har ändrats.")
        for index, values in enumerate(iterator, 1):
            if values[2] in recovered:
                raise RuntimeError("En källrad förekommer två gånger.")
            recovered[values[2]] = list(values[metadata_count:])
            if sheet.title == "Rutt":
                assert values[0] == index
                assert values[1] == ("Fordon 1" if municipality == "Tjörn" else "Fordon 2")
                distances.append(values[7] * 1000)
                durations.append(values[8] * 60)
    output.close()
    assert len(distances) == count and set(recovered) == set(expected)
    for row_number, before in expected.items():
        after = recovered[row_number]
        assert len(before) == len(after)
        for column, a, b in zip(original_headers, before, after):
            equal = a == b
            if column in {"Latitud", "Longitud"} and isinstance(a, (int, float)) and isinstance(b, (int, float)):
                equal = math.isclose(a, b, rel_tol=0, abs_tol=1e-12)
            assert equal, f"Källvärde ändrat på rad {row_number}, kolumn {column}"
    assert math.isclose(sum(distances), road_evidence["distance_meters"], abs_tol=1e-5)
    assert math.isclose(sum(durations), road_evidence["drive_seconds"], abs_tol=1e-5)
