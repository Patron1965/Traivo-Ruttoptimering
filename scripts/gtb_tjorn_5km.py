"""New lossless Tjörn district export; 5 km municipal margin and separate unbridged islands."""
import fcntl
import json
import math
import os
from collections import Counter

from openpyxl import Workbook, load_workbook

import gtb_road_provider as provider
from gtb_island_geometry import contains
from gtb_optimize_route_files import prepare_input, road_geometry
from gtb_revise_stenungsund import append_sheet, geography, strict_cost
from gtb_road_order import optimize, score
from gtb_route_export import DEPOT_ADDRESS, append_literal, style_sheet

SOURCE = "attached_assets/Tjorn_ruttunderlag_1792006691001.xlsx"
ROOT = "generated-artifacts/gtb-tjorn-5km"
OLD_ROOT = "generated-artifacts/gtb-routes"
MARGIN = 5000
META = ["Ordning (vägoptimerad)", "Planeringsfordon", "Källrad", "Områdeskontroll (5 km)",
        "Avstånd utanför kommungräns (m)", "Ny urvalsorsak", "Körsträcka från föregående (km)",
        "Körtid från föregående (min)", "Ackumulerad körsträcka (km)",
        "Avstånd till kartlagd bilväg (m)", "Väganknytning", "Beräkningslongitud", "Beräkningslatitud"]


def read_input(path):
    book = load_workbook(path, read_only=True, data_only=False)
    sheets = {sheet.title: [list(row) for row in sheet.values] for sheet in book}
    book.close()
    headers = sheets["Ruttunderlag"][0]
    rows = {}
    for title in ["Ruttunderlag", "Granskning", "Öar utan bro"]:
        assert sheets[title][0] == headers
        for row in sheets[title][1:]:
            assert row[2] not in rows
            rows[row[2]] = row
    assert len(rows) == 6644
    return headers, rows, sheets


def assess_geography(rows):
    boundary = json.load(open(os.path.join(OLD_ROOT, "municipal-boundaries.json")))
    rings = next(f["geometry"]["rings"] for f in boundary["features"]
                 if f["attributes"]["KOMMUNNAMN"] == "Tjörn")
    outlines = json.load(open(os.path.join(OLD_ROOT, "island-boundaries.json")))
    islands = {item["source_row"]: item["island"]
               for item in json.load(open(os.path.join(OLD_ROOT, "additional-island-rows.json")))}
    island_names = ["Stora Dyrön", "Åstol", "Härön", "Tjörnekalv", "Lilla Brattön",
                    "Kålhuvudet", "Risön", "Hättan"]
    cache, results = {}, {}
    for identity, row in rows.items():
        if row[13] is None or row[14] is None:
            results[identity] = ("Saknar koordinater", None)
            continue
        coordinate = (row[14], row[13])
        if coordinate not in cache:
            point = geography.projected(*coordinate)
            inside = geography.inside_polygon(point, rings)
            distance = 0 if inside else geography.boundary_distance(point, rings, coordinate[1])
            area = ("Inom kommunen" if inside else "Utanför kommunen, inom 5 km"
                    if distance <= MARGIN else "Mer än 5 km utanför kommunen")
            cache[coordinate] = (area, distance)
            hits = [name for name in island_names if name in outlines and contains(coordinate, outlines[name])]
            if hits:
                islands[identity] = hits[0]
        else:
            hits = [name for name in island_names if name in outlines and contains(coordinate, outlines[name])]
            if hits:
                islands[identity] = hits[0]
        results[identity] = cache[coordinate]
    return results, islands


def verify(path, original, headers, expected_route, road):
    book = load_workbook(path, read_only=True, data_only=False)
    recovered = {}
    distance, duration, route_count = 0, 0, 0
    for title in ["Rutt", "Granskning", "Öar utan bro"]:
        rows = iter(book[title].values)
        actual_headers = list(next(rows))
        assert actual_headers[len(META):] == ["Källfil – " + h if i < 7 else h for i, h in enumerate(headers)]
        for index, row in enumerate(rows, 1):
            identity = row[2]
            assert identity not in recovered
            recovered[identity] = list(row[len(META):])
            if title == "Rutt":
                assert row[0] == index and row[1] == "Fordon 1" and row[4] <= MARGIN
                route_count += 1
                distance += row[6] * 1000
                duration += row[7] * 60
    assert recovered.keys() == original.keys() and route_count == expected_route
    for identity, before in original.items():
        assert len(recovered[identity]) == len(before)
        for header, a, b in zip(headers, before, recovered[identity]):
            equal = a == b
            if isinstance(a, float) and isinstance(b, float):
                equal = math.isclose(a, b, rel_tol=0, abs_tol=1e-12)
            assert equal, f"Uppladdat fält ändrades: rad {identity}, {header}"
    assert math.isclose(distance, road["distance_meters"], abs_tol=1e-5)
    assert math.isclose(duration, road["drive_seconds"], abs_tol=1e-5)
    book.close()


def main():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1":
        raise RuntimeError("Beräkningen gäller endast testmiljön.")
    os.makedirs(ROOT, exist_ok=True)
    path = os.path.join(ROOT, "Tjorn_vagoptimerad_5km_med_oflik.xlsx")
    if os.path.exists(path):
        raise RuntimeError("Skriver inte över ett tidigare uttag.")
    headers, original, sheets = read_input(SOURCE)
    _, old_original, old_sheets = read_input(os.path.join(OLD_ROOT, "Tjorn_ruttunderlag.xlsx"))
    assert original == old_original and sheets == old_sheets, "Underlaget skiljer sig från tidigare kartkontroll."
    areas, mapped_islands = assess_geography(original)
    extra_islands = {item["source_row"]: item["island"]
                     for item in json.load(open(os.path.join(OLD_ROOT, "additional-island-rows.json")))}
    already_islands = {row[2] for row in sheets["Öar utan bro"][1:]}
    assert set(mapped_islands) - already_islands == set(extra_islands), "Öindelningen har ändrats; kräver nytt vägunderlag."
    checks = json.load(open(os.path.join(OLD_ROOT, "road-preflight.json")))["Tjorn_ruttunderlag.xlsx"]
    identity = provider.dataset_identity()
    assert checks["identity"] == identity
    h, partitions, coordinates, groups, snaps, warnings = prepare_input("Tjorn_ruttunderlag.xlsx", checks, extra_islands)
    assert headers == h
    assert all(areas[row[2]][1] is not None and areas[row[2]][1] <= MARGIN for group in groups for row in group)
    print(f"Urval: {sum(map(len, groups))} ruttstopp; {len(partitions['Granskning'])} granskning; "
          f"{len(partitions['Öar utan bro'])} östopp", flush=True)
    provider.valid_cost = strict_cost
    previous = json.load(open(os.path.join(OLD_ROOT, "cache/tjorn/matrix.json")))
    raw = os.path.join(OLD_ROOT, "cache/tjorn", "blocks-" + previous["fingerprint"])
    matrix, durations, manifest = provider.build_matrix(coordinates, os.path.join(ROOT, "cache"), identity, raw)
    order = optimize(matrix)
    source_order = [node for _, node in sorted((row[2], node) for node, group in enumerate(groups, 1) for row in group)]
    assert score(order, matrix) <= score(source_order, matrix) + 1e-5
    road = road_geometry([coordinates[0]] + [coordinates[node] for node in order])
    assert provider.dataset_identity() == identity
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Läs först"
    last = original[groups[order[-1] - 1][-1][2]]
    end = ", ".join(str(last[i] or "") for i in [9, 10, 11])
    count = sum(map(len, groups))
    stats = {"source_rows": len(original), "route_rows": count,
             "review_rows": len(partitions["Granskning"]), "island_rows": len(partitions["Öar utan bro"]),
             "road_warning_rows": sum(len(g) for g, w in zip(groups, warnings) if w),
             "distance_km": road["distance_meters"] / 1000, "drive_hours": road["drive_seconds"] / 3600,
             "end_address": end, "provider_identity": identity, "file": path}
    details = [
        ["Uppgift", "Värde"], ["Område", "Tjörn"], ["Status", "VÄGOPTIMERAD KÖRORDNING – inte en dagsplan"],
        ["Startadress", DEPOT_ADDRESS], ["Slutadress", end], ["Återresa till depå", "Nej"],
        ["Planeringsfordon", "Fordon 1 – ingen operativ tilldelning"], ["Källrader", len(original)],
        ["Stopp i Rutt", count], ["Rader i Granskning", stats["review_rows"]], ["Stopp i Öar utan bro", stats["island_rows"]],
        ["Kommungränsmarginal", "5 000 meter utanför Tjörns generaliserade kommungräns; ungefärliga lokalt skalkorrigerade avstånd."],
        ["Körsträcka (km)", stats["distance_km"]], ["Beräknad bilkörning (timmar)", stats["drive_hours"]],
        ["Metod", "Komplett riktad bilvägmatris, flera heuristiska starter, riktade flyttar och 2-opt. "
         "Ingen fågelvägsersättning eller garanti om globalt kortaste rutt."],
        ["Tider", "Ingen sotningstid, inga pauser, datum eller arbetspass inkluderade."],
        ["Öklassificering", "Källans öindelning samt återkontrollerade OSM-ökonturer. Åtta koordinatbaserade tillägg "
         "märks särskilt; de kan bero på felaktiga källpositioner. Östopp ingår inte i bilrutten."],
        ["Granskning", "149 rader saknar koordinater. En större gränsmarginal kan inte placera dem. Inga nya geokodningsanrop gjorda."],
        ["Källvärden", "Alla uppladdade värden bevaras i källkolumnerna. Följ Ordning (vägoptimerad), inte Källfil – Ordning."],
        ["Osäkra positioner", "Befintliga positioner behållna enligt geografiskt godkännande; vägberäkningen bevisar inte rätt byggnad."],
        ["Avståndsvarningar", stats["road_warning_rows"]],
        ["Vägåtkomst", "Tidigare godkända varningar bevaras; beräkning till närmaste bilväg bevisar inte infart till adressen."],
        ["Vägdata", identity["source"]], ["Licens", identity["attribution"]], ["Vägdata SHA-256", identity["graph_sha256"]],
    ]
    for index, row in enumerate(details, 1):
        append_literal(summary, row, index)
    style_sheet(summary, details[0], len(details) - 1)
    summary.auto_filter.ref = None
    summary.column_dimensions["A"].width = 40
    summary.column_dimensions["B"].width = 112
    for index in range(2, len(details) + 1):
        summary.row_dimensions[index].height = 44
    output_headers = META + ["Källfil – " + h if i < 7 else h for i, h in enumerate(headers)]
    rows, cumulative = [], 0
    for node, leg in zip(order, road["legs"]):
        for offset, values in enumerate(groups[node - 1]):
            source = original[values[2]]
            distance, duration = (leg["distance"], leg["duration"]) if offset == 0 else (0, 0)
            cumulative += distance
            area, outside = areas[source[2]]
            rows.append([len(rows) + 1, "Fordon 1", source[2], area, outside, area,
                         distance / 1000, duration / 60, cumulative / 1000, snaps[node - 1],
                         "AVSTÅNDSVARNING – tidigare godkänd bilvägsposition" if warnings[node - 1]
                         else "Väganknytning inom 250 m", *coordinates[node], *source])
    append_sheet(workbook, "Rutt", output_headers, rows)
    for title in ["Granskning", "Öar utan bro"]:
        rows = []
        for values in sorted(partitions[title], key=lambda r: r[2]):
            source = original[values[2]]
            area, outside = areas[source[2]]
            rows.append([None, None, source[2], area, outside, values[6], *([None] * 7), *source])
        append_sheet(workbook, title, output_headers, rows)
    append_sheet(workbook, "Tidigare läsanvisning", sheets["Läs först"][0], sheets["Läs först"][1:])
    workbook.save(path)
    verify(path, original, headers, count, road)
    with open(os.path.join(ROOT, "final-verification.json"), "w") as file:
        json.dump(stats, file, ensure_ascii=False, indent=2)
    with open(os.path.join(ROOT, "road-geometry.geojson"), "w") as file:
        json.dump({"type": "Feature", "properties": {"return_to_depot": False},
                   "geometry": {"type": "LineString", "coordinates": road["geometry"]}}, file)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    print("Verifierat: alla 6 644 uppladdade källrader och cellvärden bevarade.", flush=True)


if __name__ == "__main__":
    with open(".cache/district-road/prepare.lock", "a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        main()
