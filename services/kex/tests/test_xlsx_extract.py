"""Excel extraction: cached values first, formulas as fallback, legacy .xls routed to xlrd.

The Asgard failure of 2026-09-07 ("Excel file contained no data" on a financial model) was a
workbook whose formulas carried no cached results — data_only=True saw only None.
"""
import io
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sources.file_handler import _extract_xlsx, extract_text  # noqa: E402


def _workbook_bytes(fill) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Model"
    fill(ws)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_values_are_extracted_normally():
    data = _workbook_bytes(lambda ws: ws.append(["Revenue", 1200, "EUR"]))
    text = _extract_xlsx(data)
    assert "Sheet: Model" in text
    assert "Revenue | 1200 | EUR" in text
    assert "formulas without cached results" not in text


def test_formula_only_workbook_falls_back_to_formulas():
    def fill(ws):
        ws["A1"] = "=SUM(B2:B13)"
        ws["A2"] = "=A1*1.19"

    data = _workbook_bytes(fill)  # openpyxl writes formulas WITHOUT cached values
    text = _extract_xlsx(data)
    assert "formulas without cached results" in text
    assert "=SUM(B2:B13)" in text
    assert "=A1*1.19" in text


def test_truly_empty_workbook_still_raises():
    data = _workbook_bytes(lambda ws: None)
    with pytest.raises(ValueError, match="contained no data"):
        _extract_xlsx(data)


def test_legacy_xls_is_routed_to_xlrd_not_rejected():
    # Not a real .xls body — the point is the ROUTE: .xls must reach xlrd (which then
    # complains about the bytes) instead of the "convert to .xlsx" rejection.
    with pytest.raises(Exception) as exc:
        extract_text(b"not-an-xls", "application/octet-stream", "legacy.xls")
    assert "convert to the modern format" not in str(exc.value)
