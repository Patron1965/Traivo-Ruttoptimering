"""Prepare lossless GTB route workbooks; do not fabricate a road optimization."""
import collections
import datetime
import glob
import json
import math
import os
import re
import urllib.parse
import urllib.request

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

OUTPUT = "generated-artifacts/gtb-routes"
SOURCE_URL = "https://services9.arcgis.com/BH6j7VrWdIXhhNYw/arcgis/rest/services/Kommungränser_Lantmäteriet/FeatureServer/0/query"
ISLAND_SOURCE = "https://www.tjorn.se/kultur-fritid-och-turism/turism-och-sevardheter/oar-runt-tjorn"
BUFFER_METERS = 500
DEPOT = "Ruskvädersgatan 13, 418 34 Göteborg"
ISLAND_NAMES = {
    "Dyrön": ["dyrön"],
    "Åstol": ["åstol"],
    "Härön": ["härön"],
    "Tjörnekalv": ["tjörnekalv", "stora kalv", "lilla kalv"],
    "Lilla Brattön": ["lilla brattön"],
    "Risön": ["risön"],
    "Hättan": ["hättan"],
}


def download_json(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        return json.load(response)


def projected(longitude, latitude):
    radius = 6378137.0
    return (radius * math.radians(longitude),
            radius * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)))


def inside_polygon(point, rings):
    x, y = point
    inside = False
    for ring in rings:
        for first, second in zip(ring, ring[1:] + ring[:1]):
            ax, ay = first
            bx, by = second
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                inside = not inside
    return inside


def boundary_distance(point, rings, latitude):
    x, y = point
    best = float("inf")
    for ring in rings:
        for first, second in zip(ring, ring[1:] + ring[:1]):
            ax, ay = first
            bx, by = second
            dx, dy = bx - ax, by - ay
            length = dx * dx + dy * dy
            fraction = min(1, max(0, ((x - ax) * dx + (y - ay) * dy) / length)) if length else 0
            best = min(best, math.hypot(x - ax - fraction * dx, y - ay - fraction * dy))
    # Correct local Web Mercator scale; distances are indicative, not cadastral measurements.
    return best * math.cos(math.radians(latitude))


def island_name(record):
    text = " ".join(str(record.get(key) or "") for key in
                    ["Ort", "Adress", "Fastighetsbeteckning"]).casefold()
    for name, aliases in ISLAND_NAMES.items():
        if any(re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text) for alias in aliases):
            return name
    return None


def append_row(sheet, values):
    sheet.append(values)
    # Source strings remain literal, including Excel-looking prefixes.
    for cell in sheet[sheet.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = "s"


def format_sheet(sheet, header=True):
    sheet.freeze_panes = "A2"
    if header:
        sheet.auto_filter.ref = sheet.dimensions
    for cell in sheet[1]:
        cell.fill = PatternFill("solid", fgColor="173B52")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    sheet.row_dimensions[1].height = 42
    for index, column in enumerate(sheet.iter_cols(min_row=1, max_row=min(sheet.max_row, 70)), 1):
        width = min(48, max(13, max(len(str(cell.value or "")) for cell in column) + 2))
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.sheet_view.zoomScale = 80


def prepare(path, municipality, vehicle, boundary):
    original = load_workbook(path, read_only=True, data_only=False)
    source = original.active
    iterator = source.iter_rows(values_only=True)
    headers = list(next(iterator))
    partitions = {"Ruttunderlag": [], "Granskning": [], "Öar utan bro": []}
    source_count = 0
    identifiers = collections.Counter()
    for row_number, row in enumerate(iterator, 2):
        if not any(value is not None for value in row):
            continue
        source_count += 1
        identifiers[row_number] += 1
        record = dict(zip(headers, row))
        lat, lon = record.get("Latitud"), record.get("Longitud")
        has_coordinates = (
            isinstance(lat, (float, int)) and not isinstance(lat, bool) and
            isinstance(lon, (float, int)) and not isinstance(lon, bool) and
            math.isfinite(lat) and math.isfinite(lon) and -85 < lat < 85 and -180 <= lon <= 180
        )
        distance = None
        area_status = "Saknar koordinater"
        in_area = False
        if has_coordinates:
            point = projected(lon, lat)
            if inside_polygon(point, boundary):
                area_status, in_area = "Inom kommunen", True
                distance = 0
            else:
                distance = round(boundary_distance(point, boundary, lat), 1)
                in_area = distance <= BUFFER_METERS
                area_status = "Nära gränsen – inkluderad" if in_area else "Utanför kommunen och 500 m marginal"
        island = island_name(record) if municipality == "Tjörn" else None
        quality = record.get("Geokodningskvalitet")
        position_note = (
            "Saknar koordinater" if not has_coordinates else
            "Osäker position – enligt källfil" if record.get("Behöver granskas") == "Ja"
            or quality in {"Ortsnivå", "Bynamn", "Ej hittad"} else
            "Gatunivå – enligt källfil" if quality == "Gatunivå" else "Enligt källfil"
        )
        target = "Öar utan bro" if island else "Ruttunderlag" if in_area else "Granskning"
        reason = f"{island}: saknar broförbindelse" if island else area_status
        partitions[target].append((row_number, area_status, distance, position_note, reason, list(row)))
    original.close()
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Läs först"
    route = partitions["Ruttunderlag"]
    last_record = dict(zip(headers, route[-1][-1])) if route else {}
    end_address = ", ".join(str(last_record.get(key) or "") for key in ["Adress", "Postnummer", "Ort"])
    details = [
        ["Uppgift", "Värde"],
        ["Område", municipality],
        ["Status", "FÖRBERETT RUTTUNDERLAG – EJ VÄGOPTIMERAT"],
        ["Körordning", "Ursprunglig filordning efter områdes-/öfiltrering. Ingen optimering har genomförts."],
        ["Fordon", f"{vehicle}: 1 planeringsfordon, ingen operativ tilldelning"],
        ["Startadress", DEPOT],
        ["Slutadress i nuvarande ordning", end_address],
        ["Återresa till startadressen", "Nej"],
        ["Ursprungliga stopp", source_count],
        ["Stopp i ruttunderlaget", len(route)],
        ["Stopp i granskningsflik", len(partitions["Granskning"])],
        ["Stopp på öar utan bro", len(partitions["Öar utan bro"])],
        ["Kontrollsumma stopp", sum(map(len, partitions.values()))],
        ["Utanför gränsen men högst 500 m", sum(r[1] == "Nära gränsen – inkluderad" for r in route)],
        ["Osäkra positioner inkluderade", sum("Osäker" in r[3] or "Gatunivå" in r[3] for r in route)],
        ["Källfil", os.path.basename(path)],
        ["Kommungräns", "Lantmäteriets generaliserade kommungränser via ArcGIS; inte fastighetsgränser."],
        ["Gränsmarginal", "500 meter. Avstånd är ungefärliga och lokalt skalkorrigerade."],
        ["Ökontroll", "Adress, ort och fastighetsbeteckning; okänd ö eller felaktig koordinat kan kräva manuell kontroll."],
        ["Källor", SOURCE_URL],
        ["Öar utan bro – kommunens uppgifter", ISLAND_SOURCE],
        ["Vägoptimering återstår", "Konfigurerad OSRM saknar dataset. Befintlig distriktsmotor begränsas till 750 stopp per jobb."],
        ["Tider och kilometer", "Ej beräknade. Inga sotningstider, arbetstider eller vägavstånd har antagits."],
        ["Skapad UTC", datetime.datetime.now(datetime.timezone.utc).isoformat()],
    ]
    for values in details:
        append_row(summary, values)
    metadata = ["Ordning (ej optimerad)", "Fordon", "Källrad", "Områdeskontroll",
                "Avstånd utanför gräns (m)", "Positionsanmärkning", "Urvalsorsak"]
    for name, records in partitions.items():
        if name == "Öar utan bro" and municipality != "Tjörn":
            continue
        sheet = workbook.create_sheet(name)
        append_row(sheet, metadata + headers)
        for index, (row_number, area_status, distance, note, reason, values) in enumerate(records, 1):
            order = index if name == "Ruttunderlag" else None
            append_row(sheet, [order, vehicle if order else None, row_number,
                               area_status, distance, note, reason] + values)
        format_sheet(sheet)
    format_sheet(summary, header=False)
    summary.column_dimensions["A"].width = 34
    summary.column_dimensions["B"].width = 105
    for row in summary:
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    summary["B3"].fill = PatternFill("solid", fgColor="FFF2CC")
    summary["B3"].font = Font(bold=True, color="8A5200")
    file_name = "Tjorn_ruttunderlag.xlsx" if municipality == "Tjörn" else "Stenungsund_ruttunderlag.xlsx"
    output = os.path.join(OUTPUT, file_name)
    workbook.save(output)
    # Reopen the artifact and verify exact row/value conservation, not just counts.
    check = load_workbook(output, read_only=True)
    recovered = {}
    for sheet in check:
        if sheet.title == "Läs först":
            continue
        for values in sheet.iter_rows(min_row=2, values_only=True):
            row_number = values[2]
            assert row_number not in recovered, "A source row appeared twice"
            recovered[row_number] = list(values[len(metadata):])
    check.close()
    expected = {r[0]: r[-1] for records in partitions.values() for r in records}
    assert set(recovered) == set(expected) and len(recovered) == source_count, "Source rows were lost"
    for row_number, values in expected.items():
        assert len(recovered[row_number]) == len(values)
        for column, before, after in zip(headers, values, recovered[row_number]):
            equal = before == after
            if column in {"Latitud", "Longitud"} and isinstance(before, (int, float)) and isinstance(after, (int, float)):
                # Excel's decimal serialization may round the final floating-point bit.
                equal = math.isclose(before, after, rel_tol=0, abs_tol=1e-12)
            assert equal, f"Source value changed at row {row_number}, column {column}"
    assert sum(map(len, partitions.values())) == source_count
    return {"municipality": municipality, "file": output, "total": source_count,
            "route": len(route), "review": len(partitions["Granskning"]),
            "islands": len(partitions["Öar utan bro"]),
            "island_counts": dict(collections.Counter(r[4].split(":")[0] for r in partitions["Öar utan bro"])),
            "buffer_included": sum(r[1] == "Nära gränsen – inkluderad" for r in route),
            "end_address_unoptimized": end_address}


def main():
    os.makedirs(OUTPUT, exist_ok=True)
    parameters = {"where": "KOMMUNNAMN IN ('Tjörn','Stenungsund')",
                  "outFields": "KOMMUNNAMN,ADAT,KOM_KOD", "returnGeometry": "true",
                  "outSR": "3857", "f": "json"}
    cache_path = os.path.join(OUTPUT, "municipal-boundaries.json")
    if os.path.exists(cache_path):
        with open(cache_path) as file:
            data = json.load(file)
    else:
        data = download_json(urllib.parse.quote(SOURCE_URL, safe=":/") + "?" + urllib.parse.urlencode(parameters))
    if data.get("error"):
        raise RuntimeError("Municipal boundary service rejected the request")
    boundaries = {f["attributes"]["KOMMUNNAMN"]: f["geometry"]["rings"] for f in data["features"]}
    assert set(boundaries) == {"Tjörn", "Stenungsund"}
    with open(os.path.join(OUTPUT, "municipal-boundaries.json"), "w") as file:
        json.dump(data, file)
    results = []
    for pattern, name, vehicle in [
        ("attached_assets/*1791979011255.xlsx", "Tjörn", "Fordon 1"),
        ("attached_assets/*1791979015894.xlsx", "Stenungsund", "Fordon 2"),
    ]:
        matches = glob.glob(pattern)
        assert len(matches) == 1
        results.append(prepare(matches[0], name, vehicle, boundaries[name]))
    with open(os.path.join(OUTPUT, "verification.json"), "w") as file:
        json.dump(results, file, ensure_ascii=False, indent=2)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
