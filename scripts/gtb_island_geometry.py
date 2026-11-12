"""Resolve locally available named OSM island outlines without geocoding source rows."""
import subprocess
import xml.etree.ElementTree as ET


def join_rings(parts):
    parts = [list(part) for part in parts]
    result = []
    while parts:
        ring = parts.pop()
        while ring[-1] != ring[0]:
            for i, other in enumerate(parts):
                if other[0] == ring[-1]:
                    ring.extend(other[1:])
                    parts.pop(i)
                    break
                if other[-1] == ring[-1]:
                    ring.extend(list(reversed(other))[1:])
                    parts.pop(i)
                    break
            else:
                raise RuntimeError("Öns polygon är inte sluten; ingen geografisk klassificering görs.")
        result.append(ring)
    return result


def island_outlines():
    xml = subprocess.check_output([
        "osmium", "tags-filter", ".cache/district-road/west-sweden.osm.pbf",
        "w/place=island", "r/place=island", "w/place=islet", "r/place=islet", "-f", "osm",
    ], stderr=subprocess.DEVNULL)
    root = ET.fromstring(xml)
    nodes = {n.attrib["id"]: (float(n.attrib["lon"]), float(n.attrib["lat"])) for n in root.findall("node")}
    ways = {w.attrib["id"]: [nd.attrib["ref"] for nd in w.findall("nd")] for w in root.findall("way")}
    islands = {}
    for element in root:
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
        if tags.get("place") not in {"island", "islet"} or not tags.get("name"):
            continue
        try:
            if element.tag == "way":
                rings = join_rings([ways[element.attrib["id"]]])
            elif element.tag == "relation":
                parts = [ways[m.attrib["ref"]] for m in element.findall("member")
                         if m.attrib["type"] == "way" and m.attrib.get("role", "") in {"", "outer"}]
                rings = join_rings(parts)
            else:
                continue
            islands[tags["name"]] = [[nodes[node] for node in ring] for ring in rings]
        except (KeyError, RuntimeError):
            # This is an inventory of usable geometries, never an invented closure.
            continue
    return islands


def contains(point, rings):
    x, y = point
    inside = False
    for ring in rings:
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                inside = not inside
    return inside
