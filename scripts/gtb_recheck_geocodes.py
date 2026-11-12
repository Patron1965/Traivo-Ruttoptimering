"""Bounded, resumable address investigation for the explicitly requested file revision."""
import collections
import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request

from openpyxl import load_workbook

SOURCE = "attached_assets/Stenungsund_ruttunderlag_(1)_1791991688783.xlsx"
ROOT = "generated-artifacts/gtb-stenungsund-10km"


def normalize(value):
    return re.sub(r"[\s,.\-]+", "", str(value or "").casefold())


def google(query):
    # Runtime consumes the existing credential; neither URLs nor credentials are logged.
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise RuntimeError("Google-geokodning saknar konfigurerad behörighet.")
    params = {"address": query, "components": "country:SE", "language": "sv", "key": key}
    request = urllib.request.Request(
        "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(params))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
    except Exception:
        raise RuntimeError("Geokodningens nätverksanrop misslyckades; ingen ny position antas.") from None
    if body.get("status") not in {"OK", "ZERO_RESULTS"}:
        raise RuntimeError("Geokodning avvisad: " + str(body.get("status", "invalid")))
    return body


def source_rows():
    workbook = load_workbook(SOURCE, read_only=True, data_only=False)
    headers = list(next(workbook["Ruttunderlag"].values))
    rows = []
    for title in ["Ruttunderlag", "Granskning"]:
        values = iter(workbook[title].values)
        assert list(next(values)) == headers
        rows.extend(list(row) for row in values)
    workbook.close()
    assert len(rows) == 5165 and len({row[2] for row in rows}) == 5165
    return headers, sorted(rows, key=lambda row: row[2])


def exact_candidates(record, body):
    address = str(record["Adress"] or "").strip()
    match = re.fullmatch(r"(.+?)\s+(\d+\s*[A-Za-zÅÄÖåäö]?)", address)
    if not match:
        return []
    street, house = match.groups()
    candidates = []
    for result in body.get("results", []):
        components = {kind: c["long_name"] for c in result["address_components"] for kind in c["types"]}
        localities = [components.get(k) for k in ["postal_town", "locality", "sublocality"]]
        if (result.get("partial_match") is True
                or not set(result.get("types", [])) & {"street_address", "premise", "subpremise"}
                or normalize(components.get("route")) != normalize(street)
                or normalize(components.get("street_number")) != normalize(house)
                or normalize(record["Ort"]) not in [normalize(v) for v in localities]
                or not components.get("postal_code")
                or components.get("country") != "Sverige"
                or result["geometry"].get("location_type") not in {"ROOFTOP", "RANGE_INTERPOLATED"}):
            continue
        location = result["geometry"]["location"]
        candidate = {"longitude": location["lng"], "latitude": location["lat"],
                     "display": result["formatted_address"], "postcode": components["postal_code"],
                     "precision": result["geometry"]["location_type"], "place_id": result.get("place_id")}
        if not any(abs(candidate["latitude"] - c["latitude"]) < 1e-7
                   and abs(candidate["longitude"] - c["longitude"]) < 1e-7 for c in candidates):
            candidates.append(candidate)
    return candidates


def candidates_for_record(record, evidence):
    query = ", ".join(str(record.get(k) or "") for k in ["Adress", "Postnummer", "Ort"])
    body = evidence[query]
    candidates = exact_candidates(record, body)
    if not candidates:
        retry = ", ".join(str(record.get(k) or "") for k in ["Adress", "Ort"])
        if retry in evidence:
            body = evidence[retry]
            candidates = exact_candidates(record, body)
    return candidates, body


def investigate():
    os.makedirs(ROOT, exist_ok=True)
    headers, rows = source_rows()
    missing = [dict(zip(headers, row)) for row in rows if row[13] is None or row[14] is None]
    cache_path = os.path.join(ROOT, "geocoding-evidence.json")
    evidence = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    queries = list(dict.fromkeys(
        ", ".join(str(record.get(k) or "") for k in ["Adress", "Postnummer", "Ort"])
        for record in missing))
    for index, query in enumerate(queries, 1):
        if query not in evidence:
            evidence[query] = google(query)
            with open(cache_path + ".tmp", "w") as file:
                json.dump(evidence, file, ensure_ascii=False, indent=2)
            os.replace(cache_path + ".tmp", cache_path)
            time.sleep(0.1)
        if index % 20 == 0 or index == len(queries):
            print(f"Adresskontroll: {index}/{len(queries)} sökningar", flush=True)
    print("Resultat:", dict(collections.Counter(v["status"] for v in evidence.values())), flush=True)
    # A postcode may belong to the owner's correspondence address rather than the object.
    # Retry only nonmatching addresses without that field, retaining both responses.
    for record in missing:
        query = ", ".join(str(record.get(k) or "") for k in ["Adress", "Postnummer", "Ort"])
        if exact_candidates(record, evidence[query]):
            continue
        retry = ", ".join(str(record.get(k) or "") for k in ["Adress", "Ort"])
        if retry not in evidence:
            evidence[retry] = google(retry)
            with open(cache_path + ".tmp", "w") as file:
                json.dump(evidence, file, ensure_ascii=False, indent=2)
            os.replace(cache_path + ".tmp", cache_path)
            time.sleep(0.1)
    for record in missing:
        candidates, _ = candidates_for_record(record, evidence)
        if candidates:
            continue
        # Broader searches are suggestions only, never an automatic address replacement.
        query = str(record["Adress"])
        if query.startswith("Stora Askerön "):
            house = re.search(r"(\d+\s*[A-Za-zÅÄÖåäö]?)$", query)
            if house:
                query = "Stora Askerön " + house.group(1)
        query += ", Sverige"
        if query not in evidence:
            evidence[query] = google(query)
            with open(cache_path + ".tmp", "w") as file:
                json.dump(evidence, file, ensure_ascii=False, indent=2)
            os.replace(cache_path + ".tmp", cache_path)
            time.sleep(0.1)
    print(f"Totalt {len(evidence)} sparade adressanrop inklusive riktade omförsök.", flush=True)
    return evidence


if __name__ == "__main__":
    investigate()
