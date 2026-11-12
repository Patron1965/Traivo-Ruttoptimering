"""Deterministic synthetic road objects, exclusively from the existing public OSM extract."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1" or os.environ.get("NODE_ENV") == "production":
        raise RuntimeError("Synthetic district benchmark input is development-only")
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=6000)
    parser.add_argument("--output", default="generated-artifacts/district-benchmark/input.json")
    args = parser.parse_args()
    if not 751 <= args.count <= 6500:
        parser.error("count must be 751–6500")
    source = Path(".cache/district-road/west-sweden.osm.pbf")
    out = Path(args.output)
    if not out.is_relative_to("generated-artifacts"):
        parser.error("output must be under generated-artifacts")
    out.parent.mkdir(parents=True, exist_ok=True)
    # Public mapped road nodes, not addresses, properties or geocoded customer objects.
    bbox = [11.7, 57.5, 12.5, 58.1]
    clipped = out.parent / "roads-bbox.osm.pbf"
    roads = out.parent / "roads.osm.pbf"
    subprocess.run(["osmium", "extract", "-b", ",".join(map(str, bbox)), str(source),
                    "-o", str(clipped), "--overwrite"], check=True)
    subprocess.run(["osmium", "tags-filter", str(clipped),
                    "w/highway=primary,secondary,tertiary,residential,unclassified",
                    "-o", str(roads), "--overwrite"], check=True)
    process = subprocess.Popen(["osmium", "export", str(roads), "-f", "geojsonseq",
                                "--geometry-types=linestring"], stdout=subprocess.PIPE)
    cells = {}
    for line in process.stdout:
        feature = json.loads(line.lstrip(b"\x1e"))
        for lon, lat, *_ in feature["geometry"]["coordinates"]:
            if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue
            # One point per ~100 m cell reduces dense fractional-edge pairs.
            cell = (math.floor(lon * 111320 * math.cos(math.radians(57.8)) / 100),
                    math.floor(lat * 111320 / 100))
            cells[cell] = min(cells.get(cell, (lon, lat)), (lon, lat))
    if process.wait() != 0:
        raise RuntimeError("OSM export failed")
    candidates = sorted(cells.values(), key=lambda p: hashlib.sha256(
        json.dumps(p, separators=(",", ":")).encode()).digest())
    if len(candidates) < args.count + 1:
        raise RuntimeError(f"Only {len(candidates)} mapped positions; no repetition or truncation allowed")
    manifest = json.loads(Path(".cache/district-road/bulk-provider-identity.json").read_text())
    if not manifest.get("bulkApproved") or manifest.get("algorithm") != "CH" or manifest.get("profile") != "car":
        raise RuntimeError("Existing native approval required")
    # Dataset construction (not solver filtering): only retain synthetic nodes
    # with finite, nonnegative directed start->node AND node->start road costs.
    # This establishes one strongly connected component without geocoding.
    start = candidates[0]
    selected = [start]
    examined = rejected = 0
    for offset in range(1, len(candidates), 200):
        batch = candidates[offset:offset + 200]
        coordinates = [start, *batch]
        url = "http://127.0.0.1:5001/table/v1/driving/" + ";".join(
            f"{lon},{lat}" for lon, lat in coordinates)
        results = []
        for outbound in (True, False):
            query = urllib.parse.urlencode({
                "sources": "0" if outbound else ";".join(map(str, range(1, len(coordinates)))),
                "destinations": ";".join(map(str, range(1, len(coordinates)))) if outbound else "0",
                "annotations": "distance,duration"})
            with urllib.request.urlopen(url + "?" + query, timeout=20) as response:
                if response.headers.get("x-osrm-dataset-id") != manifest["datasetIdentity"]:
                    raise RuntimeError("Road dataset changed during input construction")
                body = json.load(response)
                if body.get("code") != "Ok":
                    raise RuntimeError("Road input connectivity verification failed")
                results.append(body)
        for i, coordinate in enumerate(batch):
            examined += 1
            values = [results[0][key][0][i] for key in ("distances", "durations")]
            values += [results[1][key][i][0] for key in ("distances", "durations")]
            snaps = [results[0]["destinations"][i]["location"], results[1]["sources"][i]["location"]]
            snap_meters = [math.hypot((coordinate[0] - snap[0]) * 111320 * math.cos(math.radians(coordinate[1])),
                                     (coordinate[1] - snap[1]) * 111320) for snap in snaps]
            if max(snap_meters) <= 250 and all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in values):
                selected.append(coordinate)
            else:
                rejected += 1
            if len(selected) == args.count + 1:
                break
        if len(selected) == args.count + 1:
            break
    if len(selected) != args.count + 1:
        raise RuntimeError("Insufficient bidirectionally connected public road positions")
    positions = [{"latitude": lat, "longitude": lon} for lon, lat in selected]
    identity = hashlib.sha256(json.dumps(positions, separators=(",", ":")).encode()).hexdigest()
    data = {"version": 1, "source": "Existing Geofabrik west-Sweden OSM extract",
            "sourceSha256": digest(source), "positionsSha256": identity,
            "selection": "sha256-sorted road nodes; lexicographic representative per 100m grid cell; bidirectional start connectivity",
            "preflightDatasetIdentity": manifest["datasetIdentity"],
            "connectivityCandidatesExamined": examined, "connectivityRejected": rejected,
            "roadClasses": ["primary", "secondary", "tertiary", "residential", "unclassified"],
            "bbox": bbox, "candidateCount": len(candidates),
            "attribution": "© OpenStreetMap contributors; ODbL 1.0",
            "start": positions[0],
            "points": [dict(id=f"synthetic-road-{i+1}", **p) for i, p in enumerate(positions[1:])]}
    out.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(json.dumps({k: data[k] for k in ("positionsSha256", "sourceSha256", "candidateCount", "bbox")}))


if __name__ == "__main__":
    main()
