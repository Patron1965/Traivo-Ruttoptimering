"""Local-to-host OSRM tests using generated road-snapped points, never customer data."""
import argparse
import concurrent.futures
import json
import math
import random
import time
import urllib.request
from pathlib import Path


def request(base, path, timeout=120):
    start = time.monotonic()
    with urllib.request.urlopen(base + path, timeout=timeout) as response:
        body = json.load(response)
    if body.get("code") != "Ok":
        raise RuntimeError("OSRM rejected request: " + str(body.get("code")))
    return body, time.monotonic() - start


def generate_points(base, count):
    rng = random.Random(20261002)
    points = []
    seen = set()
    max_snap = 0
    for _ in range(count * 8):
        lng, lat = rng.uniform(11.90, 12.45), rng.uniform(57.60, 58.03)
        body, _ = request(base, f"/nearest/v1/driving/{lng:.6f},{lat:.6f}")
        point = body["waypoints"][0]
        xy = tuple(point["location"])
        if point["distance"] > 2000 or xy in seen:
            continue
        max_snap = max(max_snap, point["distance"])
        seen.add(xy)
        points.append(xy)
        if len(points) == count:
            return points, max_snap
    raise RuntimeError("Could not generate enough unique road-snapped public test points")


def table(base, points, block_size=50, workers=4):
    """Match Traivo's GET block protocol, including separate source/destination arrays."""
    size = len(points)
    distance = [[None] * size for _ in range(size)]
    duration = [[None] * size for _ in range(size)]
    calls = []

    def block(i, j):
        src = points[i:i + block_size]
        dst = points[j:j + block_size]
        same = i == j
        coords = src if same else src + dst
        cs = ";".join(f"{p[0]:.6f},{p[1]:.6f}" for p in coords)
        sources = ";".join(str(k) for k in range(len(src)))
        offset = 0 if same else len(src)
        destinations = ";".join(str(offset + k) for k in range(len(dst)))
        body, elapsed = request(base, "/table/v1/driving/" + cs +
                                "?annotations=distance,duration&sources=" + sources +
                                "&destinations=" + destinations)
        for kind in ("distances", "durations"):
            rows = body[kind]
            assert len(rows) == len(src) and all(len(row) == len(dst) for row in rows)
            assert all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0
                       for row in rows for x in row), "Missing or invalid road matrix cells"
        return i, j, body, elapsed

    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(block, i, j)
                   for i in range(0, size, block_size)
                   for j in range(0, size, block_size)]
        for future in concurrent.futures.as_completed(futures):
            i, j, body, elapsed = future.result()
            calls.append(elapsed)
            for k, row in enumerate(body["distances"]):
                distance[i + k][j:j + len(row)] = row
            for k, row in enumerate(body["durations"]):
                duration[i + k][j:j + len(row)] = row
    elapsed = time.monotonic() - start
    assert all(distance[i][i] == 0 and duration[i][i] == 0 for i in range(size))
    assert any(abs(distance[i][j] - distance[j][i]) > 1 for i in range(size)
               for j in range(i + 1, size)), "Directed road asymmetry was not observed"
    return {
        "points": size, "pairs": size * size, "block_requests": len(calls),
        "workers": workers, "seconds": round(elapsed, 3),
        "slowest_block_seconds": round(max(calls), 3),
        "finite_distance_and_duration_cells": True, "directed_asymmetry": True,
    }


def geometry(base, points):
    coords = ";".join(f"{p[0]:.6f},{p[1]:.6f}" for p in points)
    body, elapsed = request(base, "/route/v1/driving/" + coords +
                            "?overview=full&geometries=geojson&steps=false")
    coordinates = body["routes"][0]["geometry"]["coordinates"]
    assert len(body["waypoints"]) == len(points)
    assert len(coordinates) >= len(points)
    assert all(len(p) >= 2 and math.isfinite(p[0]) and math.isfinite(p[1]) and
               -180 <= p[0] <= 180 and -90 <= p[1] <= 90 for p in coordinates)
    return {"waypoints": len(points), "geometry_vertices": len(coordinates),
            "seconds": round(elapsed, 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:5000")
    parser.add_argument("--points-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--counts", default="289,500")
    parser.add_argument("--concurrent-jobs", type=int, default=0)
    args = parser.parse_args()
    path = Path(args.points_file)
    if path.exists():
        points = json.loads(path.read_text())
        max_snap = None
    else:
        points, max_snap = generate_points(args.base, 500)
        path.write_text(json.dumps(points))
    report = {"kind": "generated_public_road_points_not_customer_acceptance",
              "base": args.base, "max_snap_meters": max_snap, "tests": []}
    for count in (int(x) for x in args.counts.split(",")):
        sample = points[:count]
        assert len(sample) == count
        for label in ("first_pass", "warm_pass"):
            result = table(args.base, sample)
            result["pass"] = label
            report["tests"].append(result)
            print(json.dumps(result), flush=True)
        result = geometry(args.base, sample)
        report["tests"].append({"geometry": result})
        print(json.dumps({"geometry": result}), flush=True)
    if args.concurrent_jobs:
        start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrent_jobs) as pool:
            results = list(pool.map(lambda _: table(args.base, points),
                                    range(args.concurrent_jobs)))
        result = {"concurrent_jobs": args.concurrent_jobs,
                  "wall_seconds": round(time.monotonic() - start, 3), "jobs": results}
        report["tests"].append(result)
        print(json.dumps(result), flush=True)
    Path(args.output).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()