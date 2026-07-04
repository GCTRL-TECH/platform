# Embedding the Graph

GCTRL graphs can be embedded outside the portal — in a client deliverable, an internal wiki, a public page — as a read-only, interactive visual explorer. Two mechanisms, opened from the **Share** dialog on any knowledge graph (or built directly in Access Control).

## Private link (token-scoped)

Creates a read-only access token scoped to exactly one knowledge base — nothing else in the account is reachable through it — then builds the embed URL and iframe snippet around it. The Share dialog does this in one click; the token is shown once, exactly like any other Access Control token.

```
https://<your-install>/embed/graph/<compilation-id>?token=<token>&theme=galaxy
```

```html
<iframe src="https://<your-install>/embed/graph/<compilation-id>?token=<token>"
        width="800" height="600" style="border:0;border-radius:8px" title="My Graph"></iframe>
```

**Caveats:**

- The token is shown once at creation — copy it immediately.
- The token lives in the URL. Anyone with the link can view the graph at that token's clearance for as long as the token is valid — treat the link like a password, not a public asset.
- Revoke it any time from **Settings → Access Control → Access Tokens** (look for the `Embed: <name>` entry).

## Public link

Flip **`embed_public`** on for a compilation (Share dialog → "Public link" tab) and anyone with the URL — no token, no login — can view it:

```
https://<your-install>/embed/graph/<compilation-id>
```

The server enforces that a public embed serves **only `PUBLIC`-classified nodes and edges**, regardless of the graph's own overall classification — `INTERNAL` / `CONFIDENTIAL` / `RESTRICTED` content is never served through a public link, even if the compilation contains it.

## Theme parameter

Both link types accept a `theme` query parameter:

| Value | Look |
|---|---|
| `midnight` | Default dark canvas (matches the in-app explorer) |
| `galaxy` | Starfield background + glowing nodes |
| `paper` | Light mode |
| `terminal` | Black background, green hue |
| `synthwave` | Deep purple, magenta/cyan hue rotation |

Omit `theme` to use the default (`midnight`).

## See also

[Access Control](access-control.md) · [Compliance & Sovereignty](compliance.md)
