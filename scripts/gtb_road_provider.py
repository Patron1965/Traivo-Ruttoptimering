"""Private, local OSRM road matrices for the approved GTB file calculation."""
import array
import concurrent.futures
import hashlib
import gzip
import json
import math
import os
import subprocess
import threading
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

BASE_URL = "http://127.0.0.1:5001"
MAX_SNAP_METERS = 250
BLOCK_SIZE = 400
DATASET = ".cache/district-road/west-sweden.osrm.hsgr"


def haversine(first, second):
    lon1, lat1 = map(math.radians, first)
    lon2, lat2 = map(math.radians, second)
    value = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, max(0, value))))


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def dataset_identity():
    binary = subprocess.check_output(["which", "osrm-routed"], text=True).strip()
    profile = os.path.join(os.path.dirname(os.path.dirname(binary)), "share/osrm/profiles/car.lua")
    return {"graph_sha256": file_hash(DATASET), "profile_sha256": file_hash(profile),
            "algorithm": "CH", "profile": "car",
            "engine": subprocess.check_output(["osrm-routed", "--version"], text=True).strip(),
            "source": "OpenStreetMap via Geofabrik, west-Sweden extract",
            "attribution": "© OpenStreetMap contributors; ODbL 1.0"}


def depot_from_osm():
    xml = subprocess.check_output([
        "osmium", "tags-filter", ".cache/district-road/west-sweden.osm.pbf",
        "n/addr:street=Ruskvädersgatan", "w/addr:street=Ruskvädersgatan", "-f", "osm",
    ], stderr=subprocess.DEVNULL)
    root = ET.fromstring(xml)
    nodes = {node.attrib["id"]: (float(node.attrib["lon"]), float(node.attrib["lat"]))
             for node in root.findall("node")}
    matches = []
    for element in root:
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
        if tags.get("addr:street") != "Ruskvädersgatan" or tags.get("addr:housenumber") != "13":
            continue
        if element.tag == "node":
            coordinate = nodes[element.attrib["id"]]
        elif element.tag == "way":
            ring = [nodes[nd.attrib["ref"]] for nd in element.findall("nd")]
            if ring[-1] == ring[0]:
                ring.pop()
            # A building reference point, not a claim about its driveway or entrance.
            coordinate = tuple(sum(point[i] for point in ring) / len(ring) for i in range(2))
        else:
            continue
        matches.append((coordinate, {"osm_type": element.tag, "osm_id": element.attrib["id"],
                                    "osm_timestamp": element.attrib.get("timestamp"),
                                    "method": "Exact street and house number; building reference point"}))
    if len(matches) != 1:
        raise RuntimeError("Startadressen saknar en unik exakt matchning i kartdata.")
    return matches[0]


def request_table(coordinates, sources, destinations):
    encoded = ";".join(f"{lon},{lat}" for lon, lat in coordinates)
    url = (f"{BASE_URL}/table/v1/driving/{encoded}?annotations=distance,duration"
           f"&sources={';'.join(map(str, sources))}&destinations={';'.join(map(str, destinations))}"
           f"&radiuses={';'.join(str(MAX_SNAP_METERS) for _ in coordinates)}")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        body = json.load(error)
    if body.get("code") != "Ok":
        raise RuntimeError(f"OSRM: {body.get('code', 'invalid response')}")
    return body


def assert_snaps(requested, waypoints):
    if not isinstance(waypoints, list) or len(requested) != len(waypoints):
        raise RuntimeError("Vägleverantören saknar verifierbara väganknytningar.")
    result = []
    for coordinate, waypoint in zip(requested, waypoints):
        snapped = waypoint.get("location")
        if (not isinstance(snapped, list) or len(snapped) != 2
                or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in snapped)):
            raise RuntimeError("Ogiltig väganknytning.")
        distance = haversine(coordinate, snapped)
        if distance > MAX_SNAP_METERS:
            raise RuntimeError("En efterfrågad punkt saknar väganknytning inom 250 meter.")
        result.append((snapped, distance))
    return result


def valid_cost(distance, duration, first_snap, second_snap):
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in [distance, duration]):
        raise RuntimeError("Vägförbindelse saknas; ingen fågelvägsersättning används.")
    # Match the existing district provider's narrowly verified CH rounding correction.
    corrected = False
    if -0.5 <= distance < 0 and duration == 0 and haversine(first_snap, second_snap) <= 0.5:
        distance, corrected = 0, True
    if distance < 0 or duration < 0:
        raise RuntimeError("Ogiltig negativ vägkostnad.")
    return distance, duration, corrected


def preflight(coordinates):
    """Check every supplied point against the depot, isolating failures without dropping rows."""
    failures = []
    snap_distances = [None] * len(coordinates)
    snaps = [None] * len(coordinates)

    def check(indices):
        selected = [coordinates[0]] + [coordinates[i] for i in indices]
        try:
            body = request_table(selected, [0], list(range(1, len(selected))))
            source = assert_snaps([coordinates[0]], body["sources"])[0]
            destinations = assert_snaps(selected[1:], body["destinations"])
        except RuntimeError:
            if len(indices) > 1:
                split = len(indices) // 2
                check(indices[:split])
                check(indices[split:])
            else:
                failures.append({"node_index": indices[0], "reason": "Ingen verifierad väganknytning inom 250 m"})
            return
        snaps[0], snap_distances[0] = source
        for offset, index in enumerate(indices):
            snapped, distance = destinations[offset]
            try:
                valid_cost(body["distances"][0][offset], body["durations"][0][offset], source[0], snapped)
            except RuntimeError:
                failures.append({"node_index": index, "reason": "Ingen giltig vägförbindelse från startadressen"})
            snaps[index], snap_distances[index] = snapped, distance

    for start in range(1, len(coordinates), BLOCK_SIZE):
        check(list(range(start, min(start + BLOCK_SIZE, len(coordinates)))))
    return failures, snaps, snap_distances


def verified_pair_cost(first, second):
    """Re-query a numerically invalid table cell as an actual car-road route, never clamp it."""
    encoded = ";".join(f"{lon},{lat}" for lon, lat in [first, second])
    url = (f"{BASE_URL}/route/v1/driving/{encoded}?overview=full&geometries=geojson"
           f"&steps=false&continue_straight=false&radiuses={MAX_SNAP_METERS};{MAX_SNAP_METERS}")
    with urllib.request.urlopen(url, timeout=120) as response:
        body = json.load(response)
    if body.get("code") != "Ok" or len(body.get("routes", [])) != 1:
        raise RuntimeError("Den negativa matrisposten kunde inte verifieras som en bilväg.")
    snaps = assert_snaps([first, second], body.get("waypoints"))
    route = body["routes"][0]
    shape = route.get("geometry", {}).get("coordinates")
    legs = route.get("legs", [])
    if not shape or len(shape) < 2 or len(legs) != 1:
        raise RuntimeError("Den negativa matrisposten saknar fullständig bilvägsgeometri.")
    if (not all(len(point) == 2 and all(math.isfinite(v) for v in point) for point in shape)
            or haversine(shape[0], snaps[0][0]) > 1 or haversine(shape[-1], snaps[-1][0]) > 1):
        raise RuntimeError("Verifieringsvägen stämmer inte med de efterfrågade punkterna.")
    distance, duration, _ = valid_cost(legs[0].get("distance"), legs[0].get("duration"),
                                     snaps[0][0], snaps[1][0])
    return distance, duration


def build_matrix(coordinates, cache_directory, identity, raw_block_directory=None):
    """Complete directed matrix; bounded two-request concurrency, no partition approximation."""
    os.makedirs(cache_directory, exist_ok=True)
    fingerprint = hashlib.sha256(json.dumps(
        {"coordinates": coordinates, "identity": identity, "snap_limit": MAX_SNAP_METERS},
        sort_keys=True).encode()).hexdigest()
    manifest_path = os.path.join(cache_directory, "matrix.json")
    width = len(coordinates)
    if os.path.exists(manifest_path):
        with open(manifest_path) as file:
            manifest = json.load(file)
        if manifest["fingerprint"] != fingerprint:
            raise RuntimeError("Vägmatrisens identitet har ändrats; äldre beräkning ersätts inte tyst.")
        matrices = []
        for name in ["distance", "duration"]:
            path = os.path.join(cache_directory, name + ".bin")
            if file_hash(path) != manifest[name + "_sha256"]:
                raise RuntimeError("Den sparade vägmatrisen har ändrats.")
            values = array.array("d")
            with open(path, "rb") as file:
                values.fromfile(file, width * width)
            matrices.append([values[i * width:(i + 1) * width] for i in range(width)])
        return *matrices, manifest
    distances = [array.array("d", [math.nan]) * width for _ in coordinates]
    durations = [array.array("d", [math.nan]) * width for _ in coordinates]
    blocks = [list(range(i, min(i + BLOCK_SIZE, width))) for i in range(0, width, BLOCK_SIZE)]
    pairs = [(a, b) for a in blocks for b in blocks]
    if len(pairs) > 256:
        raise RuntimeError("Den godkända engångsberäkningens matrisbudget överskrids.")
    block_directory = os.path.join(cache_directory, "blocks-" + fingerprint)
    if raw_block_directory is not None and os.path.basename(raw_block_directory) != "blocks-" + fingerprint:
        raise RuntimeError("Tidigare råmatris gäller inte samma koordinater och vägdata.")
    os.makedirs(block_directory, exist_ok=True)
    repair_lock = threading.Lock()
    repair_count = 0

    def fill(pair):
        nonlocal repair_count
        sources, destinations = pair
        same = sources is destinations
        indices = sources if same else sources + destinations
        points = [coordinates[i] for i in indices]
        source_indices = list(range(len(sources)))
        destination_indices = list(range(0 if same else len(sources), len(points)))
        block_path = os.path.join(block_directory, f"{sources[0]}-{destinations[0]}.json.gz")
        previous_path = (os.path.join(raw_block_directory, os.path.basename(block_path))
                         if raw_block_directory is not None else None)
        response_path = block_path if os.path.exists(block_path) else previous_path
        if response_path is not None and os.path.exists(response_path):
            with gzip.open(response_path, "rt") as file:
                body = json.load(file)
        else:
            body = request_table(points, source_indices, destination_indices)
            # Raw responses are retained as evidence; every cell is still validated below.
            with gzip.open(block_path + ".tmp", "wt") as file:
                json.dump(body, file)
            os.replace(block_path + ".tmp", block_path)
        source_snaps = assert_snaps([coordinates[i] for i in sources], body["sources"])
        destination_snaps = assert_snaps([coordinates[i] for i in destinations], body["destinations"])
        if len(body["distances"]) != len(sources) or len(body["durations"]) != len(sources):
            raise RuntimeError("Vägmatrisen saknar rader.")
        corrections = 0
        for i, source in enumerate(sources):
            if len(body["distances"][i]) != len(destinations) or len(body["durations"][i]) != len(destinations):
                raise RuntimeError("Vägmatrisen saknar kolumner.")
            drow, trow = distances[source], durations[source]
            for j, destination in enumerate(destinations):
                raw_distance, raw_duration = body["distances"][i][j], body["durations"][i][j]
                try:
                    d, t, corrected = valid_cost(raw_distance, raw_duration,
                                                  source_snaps[i][0], destination_snaps[j][0])
                except RuntimeError:
                    if not (isinstance(raw_distance, (int, float)) and math.isfinite(raw_distance) and raw_distance < 0
                            and isinstance(raw_duration, (int, float)) and math.isfinite(raw_duration) and raw_duration >= 0):
                        raise
                    with repair_lock:
                        repair_count += 1
                        if repair_count > 256:
                            raise RuntimeError("För många felaktiga matrisposter; vägdatatjänsten måste granskas.")
                    # No cost is accepted without a second provider response and complete road evidence.
                    d, t = verified_pair_cost(coordinates[source], coordinates[destination])
                    corrected = False
                    repair_path = os.path.join(block_directory, f"repair-{source}-{destination}.json")
                    with open(repair_path, "w") as file:
                        json.dump({"table_distance": raw_distance, "table_duration": raw_duration,
                                   "verified_route_distance": d, "verified_route_duration": t}, file)
                drow[destination] = 0 if source == destination else d
                trow[destination] = 0 if source == destination else t
                corrections += corrected
        return corrections

    corrections = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(fill, pair) for pair in pairs]
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            corrections += future.result()
            if completed % 10 == 0 or completed == len(pairs):
                print(f"Vägmatris: {completed}/{len(pairs)} block klara", flush=True)
    # All square blocks were checked cell by cell, including both directions.
    manifest = {"fingerprint": fingerprint, "width": width, "cells": width * width,
                "table_requests": len(pairs), "ch_rounding_corrections": corrections,
                "verified_route_repairs": repair_count,
                "identity": identity}
    for name, matrix in [("distance", distances), ("duration", durations)]:
        path = os.path.join(cache_directory, name + ".bin")
        with open(path, "wb") as file:
            for row in matrix:
                row.tofile(file)
        manifest[name + "_sha256"] = file_hash(path)
    with open(manifest_path, "w") as file:
        json.dump(manifest, file, indent=2)
    return distances, durations, manifest
