"""Create a local-only coordinate-review workbook without changing source data."""

import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell import _writer
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo


def normalized(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def coordinate(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        result = float(str(value).replace(",", "."))
        return result if math.isfinite(result) else None
    except ValueError:
        return None


def build_review(source_path, output_path):
    if source_path.resolve() == output_path.resolve():
        raise ValueError("Output must not overwrite the original workbook.")
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    workbook = load_workbook(source_path)
    if len(workbook.worksheets) != 1:
        raise ValueError("Select a single-sheet stop workbook for this review.")
    source = workbook.worksheets[0]
    if any(cell.data_type == "f" for row in source for cell in row):
        raise ValueError("Formula-based source data requires a separate cached-value review.")
    headers = [cell.value for cell in source[1]]
    required = ["StoppID", "Adress", "Postnummer", "Ort", "Latitud", "Longitud",
                "Geokodningskvalitet", "Behöver granskas", "Antal objekt", "Objekt-ID-lista"]
    if any(name not in headers for name in required):
        raise ValueError("Missing required stop-file columns.")
    records = []
    groups = defaultdict(list)
    for excel_row, values in enumerate(source.iter_rows(min_row=2, values_only=True), 2):
        if not any(value is not None and str(value).strip() for value in values):
            continue
        record = dict(zip(headers, values))
        lat, lon = coordinate(record["Latitud"]), coordinate(record["Longitud"])
        missing = any(record[field] is None or str(record[field]).strip() == ""
                      for field in ["Latitud", "Longitud"])
        valid = lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 and (lat, lon) != (0, 0)
        record.update(excel_row=excel_row, missing=missing, valid=valid,
                      coordinate_key=(lat, lon) if valid else None)
        records.append(record)
        if valid:
            groups[(lat, lon)].append(record)

    def address_key(record):
        return tuple(normalized(record[field]) for field in ["Adress", "Postnummer", "Ort"])

    conflicts = {key: group for key, group in groups.items()
                 if len({address_key(record) for record in group}) > 1}
    group_ids = {key: f"K{index:04d}" for index, key in enumerate(sorted(conflicts), 1)}
    reviewed = []
    reason_counts = Counter()
    for record in records:
        reasons = []
        priority = 4
        quality = normalized(record["Geokodningskvalitet"])
        if record["missing"]:
            reasons.append("Koordinater saknas")
            priority = 1
        elif not record["valid"]:
            reasons.append("Ogiltiga koordinater")
            priority = 1
        if record["coordinate_key"] in conflicts:
            reasons.append("Samma koordinater för olika adresser")
            priority = min(priority, 2)
        if quality in {"ortsnivå", "bynamn"}:
            reasons.append("Koordinater anger ort eller by, inte verifierad besöksadress")
            priority = min(priority, 2)
        elif quality == "gatunivå":
            reasons.append("Gatunivå: besöksadressens position behöver kontrolleras")
            priority = min(priority, 3)
        elif quality != "exakt":
            reasons.append("Ingen verifierad exakt geokodningskvalitet i källfilen")
            priority = min(priority, 2)
        if normalized(record["Behöver granskas"]) in {"ja", "true", "1"}:
            reasons.append("Flaggad för granskning i originalfilen")
            priority = min(priority, 3)
        if not all(normalized(record[field]) for field in ["Adress", "Postnummer", "Ort"]):
            reasons.append("Adress, postnummer eller ort saknas")
            priority = min(priority, 2)
        if reasons:
            reason_counts.update(reasons)
            reviewed.append((priority, record["excel_row"], record, reasons))

    summary = workbook.create_sheet("Läs mig", 0)
    review = workbook.create_sheet("Granskning", 1)
    review_headers = [
        "Prioritet", "Originalrad", "StoppID", "Adress", "Postnummer", "Ort",
        "Latitud original", "Longitud original", "Geokodningskvalitet original",
        "Behöver granskas original", "Kontrollorsaker", "Koordinatgrupp",
        "Stopp i koordinatgruppen", "Olika adresser i gruppen", "Antal objekt",
        "Objekt-ID-lista", "Rättad latitud", "Rättad longitud",
        "Granskningsstatus", "Verifieringskälla", "Kommentar",
    ]
    review.append(review_headers)
    priority_labels = {1: "1 · Koordinater saknas eller är ogiltiga",
                       2: "2 · Kontrollera plats/adress",
                       3: "3 · Kontrollera precision"}
    for priority, _, record, reasons in sorted(reviewed, key=lambda item: item[:2]):
        key = record["coordinate_key"]
        group = conflicts.get(key, [])
        review.append([
            priority_labels[priority], record["excel_row"], record["StoppID"],
            record["Adress"], record["Postnummer"], record["Ort"],
            record["Latitud"], record["Longitud"], record["Geokodningskvalitet"],
            record["Behöver granskas"], "; ".join(reasons), group_ids.get(key, ""),
            len(group) if group else None,
            len({address_key(member) for member in group}) if group else None,
            record["Antal objekt"], record["Objekt-ID-lista"], None, None,
            "Ej granskad", None, None,
        ])
        # Uploaded text is data, never an executable Excel formula.
        for cell in review[review.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"

    review.freeze_panes = "D2"
    review.sheet_view.zoomScale = 85
    widths = [38, 13, 18, 32, 13, 22, 19, 19, 23, 23, 85, 18, 22, 25,
              16, 42, 19, 19, 28, 38, 48]
    for index, width in enumerate(widths, 1):
        review.column_dimensions[get_column_letter(index)].width = width
    for row in review.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        review.row_dimensions[row[0].row].height = 58
        for column in (7, 8, 17, 18):
            review.cell(row[0].row, column).number_format = "0.000000"
        for column in range(17, 22):
            review.cell(row[0].row, column).fill = PatternFill("solid", fgColor="FFF2CC")
    for cell in review[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="17475E")
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    review.row_dimensions[1].height = 44
    if reviewed:
        table = Table(displayName="CoordinateReview", ref=f"A1:U{review.max_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        review.add_table(table)
        for column, lower, upper in [("Q", -90, 90), ("R", -180, 180)]:
            validation = DataValidation(type="decimal", operator="between",
                                        formula1=lower, formula2=upper, allow_blank=True)
            validation.showErrorMessage = True
            validation.errorTitle = "Ogiltig koordinat"
            validation.error = "Ange en giltig WGS84-koordinat inom det tillåtna intervallet."
            review.add_data_validation(validation)
            validation.add(f"{column}2:{column}{review.max_row}")
        status = DataValidation(type="list", allow_blank=False,
                                formula1='"Ej granskad,Verifierad befintlig,Rättad,Kan inte verifieras"')
        status.showErrorMessage = True
        review.add_data_validation(status)
        status.add(f"S2:S{review.max_row}")
    summary_rows = [
        ["KOORDINATGRANSKNING – STENUNGSUND", ""],
        ["Underlag", source_path.name],
        ["Stopp i originalfilen", len(records)],
        ["Originalkolumner", len(headers)],
        ["Objekt enligt Antal objekt", sum(int(record["Antal objekt"] or 0) for record in records)],
        ["Stopp i granskningsbladet", len(reviewed)],
        ["Stopp utan automatiskt granskningsfynd", len(records) - len(reviewed)],
        ["Stopp med giltiga koordinatvärden", sum(record["valid"] for record in records)],
        ["Stopp utan koordinater", sum(record["missing"] for record in records)],
        ["Koordinatgrupper med olika adresser", len(conflicts)],
        ["Stopp i dessa koordinatgrupper", sum(len(group) for group in conflicts.values())],
        ["", ""],
        ["SÅ ANVÄNDER DU FILEN", ""],
        ["1. Börja med prioritet 1", "Komplettera saknade eller ogiltiga koordinater."],
        ["2. Fortsätt med prioritet 2", "Kontrollera olika adresser som delar koordinater samt ort-/byträffar."],
        ["3. Kontrollera prioritet 3", "Kontrollera gatuträffarnas precision mot den verkliga besöksadressen."],
        ["Gula kolumner i Granskning", "Fyll i rättad latitud/longitud som ett par vid rättning. Ange status, verifieringskälla och kommentar."],
        ["Verifierad befintlig", "Använd endast när du faktiskt har kontrollerat den befintliga koordinaten. Lämna rättade koordinater tomma om inget ändras."],
        ["Koordinatgrupp", "Filtrera på K-nummer för att se alla stopp med samma koordinater men olika adresser. Likhet är en granskningssignal, inte bevis på fel."],
        ["Originalrad", f"Radnumret i originalbladet {source.title}. StoppID är kopplingen mellan granskningen och originalunderlaget."],
        ["Originaldata", f"Bladet {source.title} innehåller alla originalrader och originalkolumner. Inga källkoordinater har ändrats."],
        ["Ingen automatisk korrigering", "Granskningsfält tillämpas inte på originalbladet. Rättningar behöver kontrolleras innan de återförs till planeringen."],
        ["Ingen automatisk sammanslagning", "Stopp eller objekt med samma koordinater har inte slagits samman eller tagits bort."],
        ["Inte ett godkännande", "Giltiga koordinatvärden eller avsaknad av granskningsfynd bevisar inte adressprecision, väganslutning eller körbarhet."],
        ["Ingen optimering", "Inga externa anrop, geokodningar, vägkontroller, databasimporter eller ruttoptimeringar har utförts."],
        ["", ""],
        ["KONTROLLORSAKER (KAN ÖVERLAPPA)", "Antal stopp"],
    ]
    summary_rows.extend([reason, count] for reason, count in reason_counts.items())
    summary_rows.extend([["", ""], ["GEOKODNINGSKVALITET I ORIGINALFILEN", "Antal stopp"]])
    summary_rows.extend([quality or "(saknas)", count]
                        for quality, count in Counter(record["Geokodningskvalitet"] for record in records).items())
    for row in summary_rows:
        summary.append(row)
    summary.column_dimensions["A"].width = 54
    summary.column_dimensions["B"].width = 112
    summary.freeze_panes = "A3"
    for row in summary:
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        summary.row_dimensions[row[0].row].height = 38
        if row[0].value and str(row[0].value).isupper():
            for cell in row:
                cell.font = Font(bold=True, color="FFFFFF", size=12)
                cell.fill = PatternFill("solid", fgColor="17475E")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # openpyxl's default 16-digit numeric serializer can change a source
    # coordinate by one floating-point unit. Retain exact numeric round trips.
    previous_serializer = _writer.safe_string
    def exact_numeric_string(value):
        if isinstance(value, float) and math.isfinite(value):
            return repr(value)
        return previous_serializer(value)
    try:
        _writer.safe_string = exact_numeric_string
        workbook.save(output_path)
    finally:
        _writer.safe_string = previous_serializer
    workbook.close()

    # Round-trip verification of every original value and type, not only row counts.
    original = load_workbook(source_path, read_only=True)
    generated = load_workbook(output_path, read_only=True)
    original_rows = [[(cell.value, cell.data_type) for cell in row]
                     for row in original.worksheets[0]]
    generated_rows = [[(cell.value, cell.data_type) for cell in row]
                      for row in generated[original.sheetnames[0]]]
    assert original_rows == generated_rows, "Original cells changed in generated workbook."
    assert generated["Granskning"].max_row - 1 == len(reviewed)
    assert len({record["StoppID"] for _, _, record, _ in reviewed}) == len(reviewed)
    for row in generated["Granskning"].iter_rows(min_row=2):
        assert row[16].value is None and row[17].value is None, "Invented corrected coordinates."
    assert source_hash == hashlib.sha256(source_path.read_bytes()).hexdigest()
    original.close()
    generated.close()
    return {"source_rows": len(records), "review_rows": len(reviewed),
            "source_columns": len(headers), "conflict_groups": len(conflicts),
            "priority_counts": dict(Counter(priority for priority, _, _, _ in reviewed)),
            "original_values_preserved": True, "output": str(output_path)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(build_review(arguments.source, arguments.output), ensure_ascii=False))
