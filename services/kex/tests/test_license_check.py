from unittest.mock import MagicMock, patch

import pytest


def test_check_credits_raises_on_denial():
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"allowed": False, "reason": "No credits"}
    with patch("httpx.post", return_value=mock_resp):
        from src.middleware.license_check import check_credits
        with pytest.raises(PermissionError, match="No credits"):
            check_credits("kex_extract", 1000)


def test_check_credits_passes_when_allowed():
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"allowed": True, "credits_spent": 25}
    with patch("httpx.post", return_value=mock_resp):
        from src.middleware.license_check import check_credits
        result = check_credits("kex_extract", 1000)
        assert result["credits_spent"] == 25


def test_check_credits_grace_mode_on_connect_error():
    import httpx as _httpx
    with patch("httpx.post", side_effect=_httpx.ConnectError("refused")):
        from src.middleware.license_check import check_credits
        result = check_credits("kex_extract", 1000)
        assert result["allowed"] is True
        assert result["credits_spent"] == 0
