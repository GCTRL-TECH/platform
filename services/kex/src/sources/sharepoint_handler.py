"""SharePoint file handler for GCTRL KEX service.

Fetches file content from Microsoft SharePoint via Graph API using
client_credentials auth (app-only, no user OAuth needed for KEX worker).
"""

import requests
import logging
from typing import Optional

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL_TMPL = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"


def get_app_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    """Get an app-only access token for Microsoft Graph API."""
    resp = requests.post(
        TOKEN_URL_TMPL.format(tenant_id=tenant_id),
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_sharepoint_file(
    tenant_id: str,
    client_id: str,
    client_secret: str,
    drive_id: str,
    item_id: str,
) -> tuple[bytes, str]:
    """Fetch a SharePoint file's raw bytes via Graph API.

    Returns (file_bytes, mime_type).
    """
    token = get_app_token(tenant_id, client_id, client_secret)
    headers = {"Authorization": f"Bearer {token}"}

    # First get metadata to determine mime type
    meta_resp = requests.get(
        f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}",
        headers=headers,
        params={"$select": "id,name,file"},
        timeout=15,
    )
    meta_resp.raise_for_status()
    meta = meta_resp.json()
    mime_type = meta.get("file", {}).get("mimeType", "application/octet-stream")

    # Download content
    content_resp = requests.get(
        f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}/content",
        headers=headers,
        allow_redirects=True,
        timeout=60,
    )
    content_resp.raise_for_status()
    return content_resp.content, mime_type
