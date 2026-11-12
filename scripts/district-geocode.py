"""Approved, resumable real-address acceptance preparation; never a production import."""
import datetime
import atexit
import glob
import hashlib
import json
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

import openpyxl
from district_cache import ROOT, cache_lock, cleanup_expired, save

lease = cache_lock(ROOT)
try:
    lease.__enter__()
except BlockingIOError:
    raise SystemExit("District sample is in use; no extra requests permitted.")
def release():
    try:
        cleanup_expired(ROOT)
    finally:
        lease.__exit__(None, None, None)
atexit.register(release)
cleanup_expired(ROOT)
STATE = ROOT / "geocoding-state.json"
OUTPUT = ROOT / "real-stenungsund-500.json"
LIMIT = 1000  # Approved maximum: $5 at $5/1000, before tax.


def normalized(value):
    return re.sub(r"\W", "", unicodedata.normalize("NFKC", value).casefold())


source = Path(sorted(glob.glob("attached_assets/Kontrollbok*"))[0])
workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
sheet = workbook["Stenungsund"]
iterator = sheet.iter_rows(values_only=True)
columns = list(next(iterator))
addresses = {}
for row_number, values in enumerate(iterator, 2):
    original = dict(zip(columns, ["" if v is None else str(v) for v in values]))
    address = original["Fastighetsadress"].strip()
    locality = re.sub(r"^\d{3}\s*\d{2}\s*", "", original["Fastighetspostadress"]).strip()
    if locality.casefold() != "stenungsund" or not re.search(r"\d", address):
        continue
    # Separate objects remain separate source rows. This sample deliberately uses
    # one object per address, to exercise 500 distinct matrix coordinates.
    addresses.setdefault(address, {
        "sourceRowNumber": row_number,
        "objectNumber": original["Objektid"],
        "address": address,
        "original": original,
    })

state = json.loads(STATE.read_text()) if STATE.exists() else {"calls": 0, "results": {}}
if any(result.get("reason") == "expired_requires_new_approval" for result in state["results"].values()):
    raise SystemExit("Coordinates expired and were removed; a new explicit approval is required. Budget retained.")
key = os.environ.get("GOOGLE_MAPS_API_KEY")
if not key:
    raise SystemExit("GOOGLE_MAPS_API_KEY is not configured; no calls made.")
selected = []
coordinates = set()
for address, row in sorted(addresses.items()):
    if len(selected) == 500:
        break
    if address not in state["results"]:
        if state["calls"] >= LIMIT:
            break
        # Reserve before sending. A crash/timeout consumes budget rather than
        # permitting an accidental uncounted retry.
        state["calls"] += 1
        state["results"][address] = {"accepted": False, "reason": "reserved_or_failed"}
        save(STATE, state)
        query = urllib.parse.urlencode({
            "address": f"{address}, Stenungsund, Sweden",
            "components": "country:SE",
            "language": "sv",
            "key": key,
        })
        try:
            with urllib.request.urlopen(
                "https://maps.googleapis.com/maps/api/geocode/json?" + query, timeout=20
            ) as response:
                body = json.load(response)
        except Exception:
            # Exceptions can contain the credential-bearing URL. Do not log them.
            save(STATE, state)
            continue
        status = body.get("status")
        if status not in ("OK", "ZERO_RESULTS"):
            print("Google rejected request:", status, flush=True)
            save(STATE, state)
            raise SystemExit("Stopped on provider error; request budget retained.")
        accepted = None
        for result in body.get("results", []):
            components = {
                t: c["long_name"] for c in result.get("address_components", [])
                for t in c.get("types", [])
            }
            number = re.search(r"(\d+\s*[A-Za-z]?)$", address)
            street = re.sub(r"\s+\d+\s*[A-Za-z]?$", "", address)
            location = result.get("geometry", {}).get("location", {})
            if (number and not result.get("partial_match")
                and result.get("geometry", {}).get("location_type") in ("ROOFTOP", "RANGE_INTERPOLATED")
                and "street_address" in result.get("types", [])
                and normalized(number.group(1)) == normalized(components.get("street_number", ""))
                and normalized(street) == normalized(components.get("route", ""))
                and components.get("country") == "Sverige"
                and 57.95 < location.get("lat", 0) < 58.18
                and 11.7 < location.get("lng", 0) < 12.1):
                accepted = {
                    "accepted": True, "latitude": location["lat"], "longitude": location["lng"],
                    "placeId": result["place_id"],
                    "locationType": result["geometry"]["location_type"],
                    "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
                break
        state["results"][address] = accepted or {"accepted": False, "reason": "not_exact_address"}
        save(STATE, state)
        if state["calls"] % 25 == 0:
            print(f"Google calls={state['calls']}, selected={len(selected)}", flush=True)
        time.sleep(0.1)
    resolved = state["results"][address]
    if resolved["accepted"] and (
        datetime.datetime.now(datetime.timezone.utc) -
        datetime.datetime.fromisoformat(resolved["verifiedAt"])
    ).days >= 30:
        raise SystemExit("Cached coordinates have expired. A new budget approval and cache cleanup are required.")
    coordinate = (resolved.get("latitude"), resolved.get("longitude"))
    if resolved["accepted"] and coordinate not in coordinates:
        coordinates.add(coordinate)
        selected.append({**row, **resolved})

save(OUTPUT, {
    "source": source.name,
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "sheet": "Stenungsund",
    "provider": "Google Geocoding API",
    "calls": state["calls"], "approvedCallLimit": LIMIT,
    "coordinateExpiryDays": 30,
    "rows": selected,
})
print(f"Verified rows={len(selected)}, unique coordinates={len(coordinates)}, calls={state['calls']}")
if len(selected) != 500:
    raise SystemExit("Could not obtain 500 verified distinct addresses within approved budget.")