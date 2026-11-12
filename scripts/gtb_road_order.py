"""Open, directed road-distance heuristic. No straight-line costs or fixed end."""
import heapq
import math


def score(order, matrix):
    return sum(matrix[first][second] for first, second in zip([0] + order, order))


def nearest_order(matrix, seed=None):
    remaining = set(range(1, len(matrix)))
    result = []
    previous = 0
    if seed is not None:
        result.append(seed)
        remaining.remove(seed)
        previous = seed
    while remaining:
        previous = min(remaining, key=matrix[previous].__getitem__)
        result.append(previous)
        remaining.remove(previous)
    return result


def relocate(order, matrix, neighbors, passes=12):
    """Directed one-node relocations, including free-tail moves; accept improvements only."""
    order = list(order)
    for _ in range(passes):
        positions = {node: i for i, node in enumerate(order)}
        changed = False
        for node in list(order):
            i = positions[node]
            before = 0 if i == 0 else order[i - 1]
            after = order[i + 1] if i + 1 < len(order) else None
            remove = -matrix[before][node]
            if after is not None:
                remove += matrix[before][after] - matrix[node][after]
            best_delta, best_before = -1e-6, None
            # Include placing the object first and last, not just near its road neighbors.
            candidates = [0, order[-1], *neighbors[node]]
            for anchor in candidates:
                if anchor == node or anchor == before:
                    continue
                j = -1 if anchor == 0 else positions[anchor]
                following = order[j + 1] if j + 1 < len(order) else None
                if following == node:
                    continue
                delta = remove + matrix[anchor][node]
                if following is not None:
                    delta += matrix[node][following] - matrix[anchor][following]
                if delta < best_delta:
                    best_delta, best_before = delta, anchor
            if best_before is not None:
                order.pop(i)
                j = -1 if best_before == 0 else order.index(best_before)
                order.insert(j + 1, node)
                positions = {value: index for index, value in enumerate(order)}
                changed = True
        if not changed:
            break
    return order


def directed_two_opt(order, matrix, neighbors, passes=8):
    """Reverse internal arcs explicitly; a symmetric 2-opt formula is unsafe here."""
    order = list(order)
    for _ in range(passes):
        positions = {node: i for i, node in enumerate(order)}
        reverse_extra = [0.0]
        for first, second in zip(order, order[1:]):
            reverse_extra.append(reverse_extra[-1] + matrix[second][first] - matrix[first][second])
        best_delta, best_pair = -1e-6, None
        for i in range(len(order) - 1):
            before = 0 if i == 0 else order[i - 1]
            candidates = neighbors[before] if before else neighbors[0]
            for node in candidates:
                j = positions.get(node, -1)
                if j <= i:
                    continue
                following = order[j + 1] if j + 1 < len(order) else None
                delta = matrix[before][order[j]] - matrix[before][order[i]]
                delta += reverse_extra[j] - reverse_extra[i]
                if following is not None:
                    delta += matrix[order[i]][following] - matrix[order[j]][following]
                if delta < best_delta:
                    best_delta, best_pair = delta, (i, j)
        if best_pair is None:
            break
        i, j = best_pair
        order[i:j + 1] = reversed(order[i:j + 1])
    return order


def optimize(matrix):
    width = len(matrix)
    if width < 2:
        raise ValueError("Inga stopp.")
    print(f"Optimerar {width - 1} unika positioner med riktade vägavstånd", flush=True)
    neighbors = [
        heapq.nsmallest(min(32, width - 1), (j for j in range(1, width) if j != i), key=row.__getitem__)
        for i, row in enumerate(matrix)
    ]
    seeds = [None, *heapq.nsmallest(min(3, width - 1), range(1, width), key=matrix[0].__getitem__)]
    best, best_score = None, math.inf
    for index, seed in enumerate(seeds, 1):
        order = nearest_order(matrix, seed)
        order = relocate(order, matrix, neighbors)
        order = directed_two_opt(order, matrix, neighbors)
        order = relocate(order, matrix, neighbors)
        value = score(order, matrix)
        print(f"Kandidat {index}/{len(seeds)}: {value / 1000:.1f} km", flush=True)
        if value < best_score:
            best, best_score = order, value
    if len(best) != width - 1 or set(best) != set(range(1, width)):
        raise RuntimeError("Stoppförlust i optimeringen.")
    return best


if __name__ == "__main__":
    # Reuse the exact validated directed matrix, rather than asking a provider
    # for a second, potentially different matrix. Binary keeps 6000² costs bounded.
    import argparse
    import array
    import hashlib
    import json
    from pathlib import Path
    import sys
    import time

    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    values = array.array("d")
    with open(args.matrix, "rb") as file:
        values.fromfile(file, args.width ** 2)
        if file.read(1):
            raise ValueError("Unexpected trailing matrix data")
    if sys.byteorder != "little":
        values.byteswap()
    if args.width < 2 or any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("Invalid directed matrix")
    rows = [memoryview(values)[i*args.width:(i+1)*args.width] for i in range(args.width)]
    started = time.perf_counter()
    order = optimize(rows)
    result = {"method": "GTB nearest-neighbor 4 seeds, relocate 12, directed 2-opt 8, relocate 12",
              "width": args.width, "distanceMeters": score(order, rows),
              "solverMilliseconds": (time.perf_counter() - started) * 1000,
              "order": order}
    h = hashlib.sha256()
    with open(args.matrix, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            h.update(block)
    result["matrixSha256"] = h.hexdigest()
    Path(args.output).write_text(json.dumps(result) + "\n")
