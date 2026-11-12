"""Lossless revision of the uploaded district workbook, isolated from app and database."""
import fcntl
import importlib.util
import json
import math
import os
import re
import urllib.request
from collections import Counter

from openpyxl import Workbook, load_workbook

import gtb_road_provider as provider
from gtb_optimize_route_files import road_geometry
from gtb_recheck_geocodes import (ROOT, SOURCE, candidates_for_record, normalize, source_rows)
from gtb_road_order import optimize, score
from gtb_route_export import DEPOT_ADDRESS, append_literal, style_sheet

spec = importlib.util.spec_from_file_location("gtb_prepare", "scripts/gtb-prepare-route-files.py")
geography = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geography)
BUFFER_METERS = 10000
META = ["Ordning (vägoptimerad)", "Planeringsfordon", "Källrad", "Områdeskontroll (10 km)",
        "Avstånd utanför kommungräns (m)", "Adresskontroll", "Planeringslongitud",
        "Planeringslatitud", "Positionsunderlag", "Körsträcka från föregående (km)",
        "Körtid från föregående (min)", "Ackumulerad körsträcka (km)",
        "Avstånd till kartlagd bilväg (m)", "Väganknytning", "Beräkningslongitud",
        "Beräkningslatitud", "Urvalsorsak (ny bedömning)"]


def strict_cost(distance, duration, first_snap, second_snap):
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0
               for v in [distance, duration]):
        raise RuntimeError("Ogiltig vägkostnad kräver separat verifierad bilväg.")
    return distance, duration, False


def geocode_assessment(record, evidence):
    candidates, body = candidates_for_record(record, evidence)
    if len(candidates) == 1:
        chosen = candidates[0]
        changed = normalize(chosen["postcode"]) != normalize(record["Postnummer"])
        note = ("Unik adressmatchning; gata, husnummer och ort stämmer. "
                + ("Annat postnummer hos leverantören: " + chosen["postcode"] + ". " if changed else "")
                + "Källadress och källkoordinater har inte ändrats.")
        return chosen, note, body
    if len(candidates) > 1:
        note = "Flera exakta adresspositioner; ingen vald automatiskt."
    else:
        note = "Ingen verifierad matchning av gata, husnummer och ort."
    return None, note, body


def partition_rows(headers, rows, evidence):
    boundaries = json.load(open("generated-artifacts/gtb-routes/municipal-boundaries.json"))
    rings = next(f["geometry"]["rings"] for f in boundaries["features"]
                 if f["attributes"]["KOMMUNNAMN"] == "Stenungsund")
    depot, depot_evidence = provider.depot_from_osm()
    pending, review, address_checks = [], [], []
    for values in rows:
        record = dict(zip(headers, values))
        coordinate = None
        if isinstance(record["Latitud"], (int, float)) and isinstance(record["Longitud"], (int, float)):
            coordinate = (record["Longitud"], record["Latitud"])
            assert all(math.isfinite(v) for v in coordinate)
            note = "Befintlig källposition – " + str(record["Geokodningskvalitet"] or "okänd kvalitet")
            position_source = "Befintliga koordinater enligt användarens geografiska godkännande"
        else:
            chosen, note, body = geocode_assessment(record, evidence)
            if chosen:
                coordinate = (chosen["longitude"], chosen["latitude"])
                position_source = f"Google, {chosen['precision']}, {chosen['display']}"
            else:
                position_source = "Ingen ny position accepterad"
            address_checks.append({"source_row": values[2], "record": record, "note": note,
                                   "chosen": chosen, "body": body})
        item = {"values": values, "coordinate": coordinate, "address_note": note,
                "position_source": position_source, "distance": None,
                "area": "Saknar verifierad position", "reason": note}
        if coordinate:
            point = geography.projected(*coordinate)
            inside = geography.inside_polygon(point, rings)
            distance = 0 if inside else geography.boundary_distance(point, rings, coordinate[1])
            item.update(distance=distance, area=("Inom kommunen" if inside else
                        f"Utanför kommunen, inom {BUFFER_METERS // 1000} km" if distance <= BUFFER_METERS else
                        f"Mer än {BUFFER_METERS // 1000} km utanför kommunen"))
            item["reason"] = item["area"]
            (pending if distance <= BUFFER_METERS else review).append(item)
        else:
            review.append(item)
    # The older seven warned source rows keep their specifically approved road point.
    old = json.load(open("generated-artifacts/gtb-routes/road-preflight.json"))["Stenungsund_ruttunderlag.xlsx"]
    approved = {tuple(old["coordinates"][f["node_index"]]): f
                for f in old["failures"]
                if f["reason"] == "Ingen verifierad väganknytning inom 250 m"}
    grouped = {}
    for item in pending:
        grouped.setdefault(item["coordinate"], []).append(item)
    coordinates = [depot] + list(grouped)
    failures, snaps, distances = provider.preflight(coordinates)
    failure_by_node = {f["node_index"]: f for f in failures}
    routed_groups, calculation_coordinates = [], [depot]
    for node, (coordinate, items) in enumerate(grouped.items(), 1):
        failure = failure_by_node.get(node)
        snap_distance = distances[node]
        calculation_coordinate = coordinate
        warning = False
        if failure:
            consent = approved.get(coordinate)
            if consent and failure["reason"] == "Ingen verifierad väganknytning inom 250 m":
                calculation_coordinate = tuple(consent["nearest_road"])
                snap_distance = provider.haversine(coordinate, calculation_coordinate)
                assert 250 < snap_distance < 724
                warning = True
            else:
                for item in items:
                    item["reason"] = failure["reason"] + "; ingen vidare väganknytning automatiskt godkänd"
                    review.append(item)
                continue
        for item in items:
            item.update(snap_distance=snap_distance, calculation_coordinate=calculation_coordinate,
                        road_warning=warning)
        calculation_coordinates.append(calculation_coordinate)
        routed_groups.append(items)
    print("Urval:", len(rows), "källrader;", sum(map(len, routed_groups)), "rutt;",
          len(review), "granskning;", len(address_checks), "adresser kontrollerade", flush=True)
    return calculation_coordinates, routed_groups, review, address_checks, depot_evidence


def append_sheet(workbook, title, headers, rows):
    sheet = workbook.create_sheet(title)
    append_literal(sheet, headers, 1)
    for index, values in enumerate(rows, 2):
        append_literal(sheet, values, index)
    style_sheet(sheet, headers, len(rows))
    return sheet


def export(headers, source, ordered, review, checks, road, identity, depot, depot_evidence, evidence):
    margin_km = BUFFER_METERS // 1000
    path = os.path.join(ROOT, f"Stenungsund_vagoptimerad_{margin_km}km_adressgranskad.xlsx")
    if os.path.exists(path):
        raise RuntimeError("En tidigare ny export finns redan; skriver inte över.")
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Läs först"
    final = dict(zip(headers, ordered[-1]["values"]))
    accepted = sum(c["chosen"] is not None for c in checks)
    newly_routed = sum(item["values"][13] is None for item in ordered)
    outside = sum(item["distance"] > 500 for item in ordered if item["distance"] is not None)
    end = ", ".join(str(final.get(k) or "") for k in ["Adress", "Postnummer", "Ort"])
    stats = {"source_rows": len(source), "route_rows": len(ordered), "review_rows": len(review),
             "missing_coordinates_checked": len(checks), "new_address_matches": accepted,
             "newly_geocoded_route_rows": newly_routed, "route_rows_outside_old_500m": outside,
             "road_warning_rows": sum(item["road_warning"] for item in ordered),
             "distance_km": road["distance_meters"] / 1000,
             "drive_hours": road["drive_seconds"] / 3600, "end_address": end,
             "geocoding_requests": len(evidence), "review_reasons": dict(Counter(i["reason"] for i in review))}
    details = [
        ["Uppgift", "Värde"], ["Område", "Stenungsund"],
        ["Status", "VÄGOPTIMERAD KÖRORDNING – inte en dagsplan eller operativ tilldelning"],
        ["Startadress", DEPOT_ADDRESS], ["Slutadress", end], ["Återresa till depå", "Nej"],
        ["Planeringsfordon", "Fordon 2 – ett fordon för hela rutten"],
        ["Källrader", len(source)], ["Stopp i Rutt", len(ordered)], ["Rader i Granskning", len(review)],
        ["Kontrollerade rader utan koordinater", len(checks)], ["Nya verifierade adresspositioner", accepted],
        ["Nya adresspositioner i rutten", newly_routed],
        ["Ruttstopp utanför tidigare 500 m marginal", outside],
        ["Kommungränsmarginal", f"{BUFFER_METERS:,} meter utanför Stenungsunds generaliserade kommungräns. "
         "Gränsavstånd är ungefärliga, lokalt skalkorrigerade avstånd, inte körsträcka."],
        ["Körsträcka (km)", stats["distance_km"]], ["Beräknad bilkörning (timmar)", stats["drive_hours"]],
        ["Tider", "Endast bilkörning; inga sotningstider, pauser, datum eller arbetspass."],
        ["Metod", "Komplett riktad OSRM-vägmatris, flera heuristiska starter, riktade flyttar och 2-opt. "
         "Ingen fågelvägsersättning; ingen garanti om globalt kortaste körordning."],
        ["Befintliga osäkra positioner", "Behållna enligt geografiskt godkännande. Ort-/gatunivå är inte bevis för rätt hus."],
        ["Nya geokodningsregler", "En unik icke-partiell adressmatchning med samma gata, husnummer och ort; "
         "annat postnummer tillåts men redovisas. Flera positioner eller annan ort kvarstår för granskning."],
        ["Ursprungsdata", "Samtliga uppladdade värden finns oförändrade i källkolumnerna. "
         "Nya positioner ligger separat i Planeringslongitud/Planeringslatitud. Tomma originalkoordinater förblir tomma."],
        ["Adresskontroll", f"Diagnosflik för de {len(checks)} raderna som ursprungligen saknade koordinater. "
         "Detta är referenser till samma källrader, inte extra stopp."],
        ["Avståndsvarningar", stats["road_warning_rows"]],
        ["Vägåtkomst", "Tidigare uttryckligen godkända avståndsvarningar bevaras. Övriga punkter måste ha "
         "verifierad väganknytning inom 250 m; körningen bevisar inte infart eller bilåtkomst till byggnaden."],
        ["Gränskälla", "Lantmäteriets generaliserade kommungränser via ArcGIS, samma underlag som tidigare uttag."],
        ["Vägdata", identity["source"]], ["Licens", identity["attribution"]],
        ["Motor", identity["engine"] + ", CH, car"], ["Vägdata SHA-256", identity["graph_sha256"]],
        ["Startpunkt", f"OSM {depot_evidence['osm_type']} {depot_evidence['osm_id']}; byggnadsreferens, inte verifierad infart."],
        ["Geokodningsanrop", len(evidence)],
    ]
    for index, row in enumerate(details, 1):
        append_literal(summary, row, index)
    style_sheet(summary, details[0], len(details) - 1)
    summary.auto_filter.ref = None
    summary.column_dimensions["A"].width = 42
    summary.column_dimensions["B"].width = 112
    for index in range(2, len(details) + 1):
        summary.row_dimensions[index].height = 48
    source_headers = ["Källfil – " + h if i < 7 else h for i, h in enumerate(headers)]
    output_headers = META + source_headers
    output_rows = []
    cumulative = 0
    for index, item in enumerate(ordered, 1):
        cumulative += item["leg_distance"]
        output_rows.append([
            index, "Fordon 2", item["values"][2], item["area"], item["distance"], item["address_note"],
            *item["coordinate"], item["position_source"], item["leg_distance"] / 1000,
            item["leg_duration"] / 60, cumulative / 1000, item["snap_distance"],
            "AVSTÅNDSVARNING – tidigare godkänd körning till närmaste kartlagda bilväg"
            if item["road_warning"] else "Väganknytning inom 250 m",
            *item["calculation_coordinate"], item["reason"], *item["values"]])
    append_sheet(workbook, "Rutt", output_headers, output_rows)
    review_rows = []
    for item in sorted(review, key=lambda i: i["values"][2]):
        coordinate = item["coordinate"] or (None, None)
        review_rows.append([None, None, item["values"][2], item["area"], item["distance"],
                            item["address_note"], *coordinate, item["position_source"],
                            None, None, None, None, None, None, None, item["reason"], *item["values"]])
    append_sheet(workbook, "Granskning", output_headers, review_rows)
    diagnostic_rows = []
    for check in checks:
        record = check["record"]
        candidates = list(check["body"].get("results", []))
        if not check["chosen"]:
            query = str(record["Adress"])
            if query.startswith("Stora Askerön "):
                house = re.search(r"(\d+\s*[A-Za-zÅÄÖåäö]?)$", query)
                if house:
                    query = "Stora Askerön " + house.group(1)
            candidates += evidence.get(query + ", Sverige", {}).get("results", [])
        displays = list(dict.fromkeys(
            f"{c['formatted_address']} | {c['geometry']['location']['lng']}, "
            f"{c['geometry']['location']['lat']} | {c['geometry']['location_type']}"
            for c in candidates))
        chosen = check["chosen"]
        diagnostic_rows.append([check["source_row"], record["StoppID"], record["Adress"],
                                record["Postnummer"], record["Ort"], check["note"],
                                chosen["display"] if chosen else None,
                                chosen["longitude"] if chosen else None,
                                chosen["latitude"] if chosen else None,
                                "\n".join(displays)[:32000]])
    append_sheet(workbook, "Adresskontroll", [
        "Källrad", "StoppID", "Källadress", "Källpostnummer", "Källort", "Bedömning",
        "Verifierad leverantörsadress", "Ny longitud", "Ny latitud",
        "Leverantörsförslag – ej automatiskt valda om bedömningen kräver granskning"], diagnostic_rows)
    workbook.save(path)
    # Reopen, compare every original field and enforce exactly one outcome per source row.
    verify_output(path, headers, source, ordered, road)
    stats["file"] = path
    stats["provider_identity"] = identity
    with open(os.path.join(ROOT, "final-verification.json"), "w") as file:
        json.dump(stats, file, ensure_ascii=False, indent=2)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    return path


def verify_output(path, headers, source, ordered, road):
    expected = {r[2]: r for r in source}
    recovered = {}
    book = load_workbook(path, read_only=True, data_only=False)
    total_distance, total_duration = 0, 0
    for title in ["Rutt", "Granskning"]:
        rows = iter(book[title].values)
        out_headers = list(next(rows))
        assert out_headers[len(META):] == ["Källfil – " + h if i < 7 else h for i, h in enumerate(headers)]
        for index, values in enumerate(rows, 1):
            assert values[2] not in recovered
            original = list(values[len(META):])
            assert len(original) == len(headers)
            recovered[values[2]] = original
            if title == "Rutt":
                assert values[0] == index and values[1] == "Fordon 2"
                assert values[4] <= BUFFER_METERS
                total_distance += values[9] * 1000
                total_duration += values[10] * 60
    assert recovered.keys() == expected.keys()
    for row, before in expected.items():
        for column, a, b in zip(headers, before, recovered[row]):
            equal = a == b
            if isinstance(a, float) and isinstance(b, float):
                equal = math.isclose(a, b, rel_tol=0, abs_tol=1e-12)
            assert equal, f"Källfält ändrat: rad {row}, {column}"
    assert book["Rutt"].max_row - 1 == len(ordered)
    assert math.isclose(total_distance, road["distance_meters"], abs_tol=1e-5)
    assert math.isclose(total_duration, road["drive_seconds"], abs_tol=1e-5)
    book.close()


def main():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1":
        raise RuntimeError("Endast godkänd i testmiljön.")
    provider.valid_cost = strict_cost
    headers, rows = source_rows()
    evidence = json.load(open(os.path.join(ROOT, "geocoding-evidence.json")))
    identity = provider.dataset_identity()
    coordinates, groups, review, checks, depot_evidence = partition_rows(headers, rows, evidence)
    matrix, durations, manifest = provider.build_matrix(coordinates, os.path.join(ROOT, "cache"), identity)
    order = optimize(matrix)
    original_order = [node for _, node in sorted(
        (item["values"][2], node) for node, items in enumerate(groups, 1) for item in items)]
    assert score(order, matrix) <= score(original_order, matrix) + 1e-5
    road = road_geometry([coordinates[0]] + [coordinates[node] for node in order])
    ordered = []
    for node, leg in zip(order, road["legs"]):
        for offset, item in enumerate(groups[node - 1]):
            item.update(leg_distance=leg["distance"] if offset == 0 else 0,
                        leg_duration=leg["duration"] if offset == 0 else 0)
            ordered.append(item)
    assert len(ordered) + len(review) == len(rows)
    assert provider.dataset_identity() == identity
    with open(os.path.join(ROOT, "road-geometry.geojson"), "w") as file:
        json.dump({"type": "Feature", "properties": {"return_to_depot": False},
                   "geometry": {"type": "LineString", "coordinates": road["geometry"]}}, file)
    export(headers, rows, ordered, review, checks, road, identity, coordinates[0], depot_evidence, evidence)


if __name__ == "__main__":
    with open(".cache/district-road/prepare.lock", "a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        main()
