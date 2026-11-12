"""Approved one-off road optimization, without app/DB mutations or public providers."""
import fcntl
import json
import math
import os
import urllib.request

from openpyxl import load_workbook

from gtb_road_order import optimize, score
from gtb_road_provider import (BASE_URL, MAX_SNAP_METERS, assert_snaps, build_matrix,
                               dataset_identity, haversine)
from gtb_route_export import ROOT, export_workbook


def road_geometry(coordinates):
    geometry, legs = [], []
    previous_snap = None
    for start in range(0, len(coordinates) - 1, 49):
        points = coordinates[start:start + 50]
        encoded = ";".join(f"{lon},{lat}" for lon, lat in points)
        url = (f"{BASE_URL}/route/v1/driving/{encoded}?overview=full&geometries=geojson"
               f"&steps=false&continue_straight=false&radiuses={';'.join(str(MAX_SNAP_METERS) for _ in points)}")
        with urllib.request.urlopen(url, timeout=120) as response:
            body = json.load(response)
        if body.get("code") != "Ok" or len(body.get("routes", [])) != 1:
            raise RuntimeError("Ofullständig väggeometri.")
        snaps = assert_snaps(points, body["waypoints"])
        route = body["routes"][0]
        shape = route.get("geometry", {}).get("coordinates")
        if not shape or len(shape) < 2 or len(route.get("legs", [])) != len(points) - 1:
            raise RuntimeError("Väggeometrin saknar en sträcka för varje stopp.")
        if not all(len(point) == 2 and all(math.isfinite(v) for v in point) for point in shape):
            raise RuntimeError("Ogiltig väggeometri.")
        if haversine(shape[0], snaps[0][0]) > 1 or haversine(shape[-1], snaps[-1][0]) > 1:
            raise RuntimeError("Väggeometrins start/slut stämmer inte med stoppens väganknytning.")
        if previous_snap is not None and (haversine(previous_snap, snaps[0][0]) > 1 or haversine(geometry[-1], shape[0]) > 1):
            raise RuntimeError("Väggeometrin har en bruten skarv.")
        for leg in route["legs"]:
            if not all(isinstance(leg.get(k), (int, float)) and math.isfinite(leg[k]) and leg[k] >= 0
                       for k in ["distance", "duration"]):
                raise RuntimeError("En ruttsträcka saknar giltig körsträcka eller tid.")
        geometry.extend(shape if not geometry else shape[1:])
        legs.extend(route["legs"])
        previous_snap = snaps[-1][0]
    assert len(legs) == len(coordinates) - 1
    return {"geometry": geometry, "legs": legs, "distance_meters": sum(leg["distance"] for leg in legs),
            "drive_seconds": sum(leg["duration"] for leg in legs)}


def prepare_input(file_name, preflight, island_rows):
    original = load_workbook(os.path.join(ROOT, file_name), read_only=True)
    headers = None
    partitions = {}
    for sheet in original:
        if sheet.title == "Läs först":
            continue
        iterator = sheet.iter_rows(values_only=True)
        current_headers = list(next(iterator))
        if headers is not None:
            assert headers == current_headers
        headers = current_headers
        partitions[sheet.title] = [list(row) for row in iterator]
    original.close()
    lon_column, lat_column = headers.index("Longitud"), headers.index("Latitud")
    grouped = {}
    # Require the exact coordinate snapshot that was examined before approval.
    all_groups = {}
    for values in partitions["Ruttunderlag"]:
        coordinate = (values[lon_column], values[lat_column])
        all_groups.setdefault(coordinate, []).append(values)
    assert [tuple(point) for point in preflight["coordinates"][1:]] == list(all_groups)
    for values in partitions["Ruttunderlag"]:
        if file_name.startswith("Tjorn") and values[2] in island_rows:
            values[0:2] = [None, None]
            values[6] = (
                f"{island_rows[values[2]]}: koordinat på ö utan kartlagd bilförbindelse. "
                "Källans adress/fastighet kan motsäga koordinaten och måste vid behov granskas."
            )
            partitions["Öar utan bro"].append(values)
        else:
            coordinate = (values[lon_column], values[lat_column])
            grouped.setdefault(coordinate, []).append(values)
    partitions["Ruttunderlag"] = [row for rows in grouped.values() for row in rows]
    original_indices = {tuple(point): i for i, point in enumerate(preflight["coordinates"])}
    failures = {f["node_index"]: f for f in preflight["failures"]}
    coordinates, groups, source_snap_distances, warnings = [tuple(preflight["depot"])], [], [], []
    for coordinate, rows in grouped.items():
        original_index = original_indices[coordinate]
        failure = failures.get(original_index)
        calculation_coordinate = coordinate
        snap_distance = preflight["snap_distances"][original_index]
        if failure:
            if failure["reason"] != "Ingen verifierad väganknytning inom 250 m":
                raise RuntimeError("En frånkopplad punkt omfattas inte av godkännandet för avståndsvarningar.")
            snap_distance = failure["nearest_distance"]
            # Approval applies only to these diagnosed exceptions, not a global wider radius.
            if not isinstance(snap_distance, (int, float)) or not 250 < snap_distance < 724:
                raise RuntimeError("Avståndsvarningen ligger utanför det godkända intervallet.")
            calculation_coordinate = tuple(failure["nearest_road"])
            if abs(haversine(coordinate, calculation_coordinate) - snap_distance) > 2:
                raise RuntimeError("Den godkända väganknytningen stämmer inte med källpositionen.")
        assert snap_distance is not None
        coordinates.append(calculation_coordinate)
        groups.append(rows)
        source_snap_distances.append(snap_distance)
        warnings.append(bool(failure))
    expected_warning_count = 8 if file_name.startswith("Tjorn") else 7
    assert sum(len(rows) for rows, warning in zip(groups, warnings) if warning) == expected_warning_count
    return headers, partitions, coordinates, groups, source_snap_distances, warnings


def main():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1":
        raise RuntimeError("Beräkningen är godkänd endast i testmiljön.")
    with open(os.path.join(ROOT, "road-preflight.json")) as file:
        checks = json.load(file)
    with open(os.path.join(ROOT, "additional-island-rows.json")) as file:
        island_rows = {entry["source_row"]: entry["island"] for entry in json.load(file)}
    identity = dataset_identity()
    results = []
    for file_name, name, vehicle in [
        ("Tjorn_ruttunderlag.xlsx", "Tjörn", "Fordon 1"),
        ("Stenungsund_ruttunderlag.xlsx", "Stenungsund", "Fordon 2"),
    ]:
        preflight = checks[file_name]
        assert preflight["identity"] == identity
        headers, partitions, coordinates, groups, snaps, warnings = prepare_input(file_name, preflight, island_rows)
        slug = "tjorn" if name == "Tjörn" else "stenungsund"
        print(f"{name}: {sum(map(len, groups))} stopp, {len(groups)} unika positioner", flush=True)
        matrix, durations, manifest = build_matrix(coordinates, os.path.join(ROOT, "cache", slug), identity)
        order = optimize(matrix)
        optimized_score = score(order, matrix)
        # Compare against the real original row order, including revisits to shared coordinates.
        row_nodes = sorted((row[2], node) for node, rows in enumerate(groups, 1) for row in rows)
        original_score = score([node for _, node in row_nodes], matrix)
        if optimized_score > original_score + 1e-5:
            raise RuntimeError("Den beräknade ordningen förbättrar inte källfilens vägsträcka.")
        print(f"{name}: verifierar sammanhängande väggeometri utan depotretur", flush=True)
        road = road_geometry([coordinates[0]] + [coordinates[node] for node in order])
        records = []
        for node, leg in zip(order, road["legs"]):
            for offset, values in enumerate(groups[node - 1]):
                records.append({"values": values, "distance_meters": leg["distance"] if offset == 0 else 0,
                                "drive_seconds": leg["duration"] if offset == 0 else 0,
                                "snap_distance_meters": snaps[node - 1], "road_warning": warnings[node - 1],
                                "calculation_coordinate": coordinates[node]})
        assert len(records) == len(partitions["Ruttunderlag"])
        if dataset_identity() != identity:
            raise RuntimeError("Vägdata ändrades under beräkningen; inget slututtag godkänns.")
        result = export_workbook(name, vehicle, headers, partitions, records, road, identity,
                                 coordinates[0], preflight["depot_evidence"])
        result.update({"matrix_distance_km": optimized_score / 1000,
                       "source_order_distance_km": original_score / 1000,
                       "matrix_cells": manifest["cells"], "provider_identity": identity})
        with open(os.path.join(ROOT, slug + "-road-geometry.geojson"), "w") as file:
            json.dump({"type": "Feature", "properties": {"area": name, "return_to_depot": False,
                       "source": identity["attribution"]},
                       "geometry": {"type": "LineString", "coordinates": road["geometry"]}}, file)
        with open(os.path.join(ROOT, slug + "-route-evidence.json"), "w") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)
        results.append(result)
        print(f"{name}: slutfil verifierad, {len(records)} stopp, {result['distance_km']:.1f} km", flush=True)
        del matrix, durations
    with open(os.path.join(ROOT, "final-verification.json"), "w") as file:
        json.dump(results, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    with open(".cache/district-road/prepare.lock", "a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        main()
