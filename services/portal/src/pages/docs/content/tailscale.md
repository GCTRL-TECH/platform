# Private access with Tailscale

The recommended pattern for VPS installs (Hostinger, Hetzner, or any box you don't want on the public internet): put GCTRL behind Tailscale instead of a public reverse proxy. Zero public ports, identity-based access, and it fits the [one-port model](networking.md) exactly — Tailscale just gives the single port (3001) a private, authenticated front door instead of a public one.

## Why

- **No public port.** Port 3001 is never exposed to the internet; only devices on your tailnet can reach it.
- **Identity-based access**, not IP allowlists — access is granted per-device/per-user via your Tailscale account, and can be revoked instantly.
- **Remote agents just work.** An agent on your dev machine (already on the tailnet) reaches the install at its tailnet hostname exactly like any other origin — same MCP config shape as a public install, just with a `.ts.net` URL:

  ```jsonc
  {
    "mcpServers": {
      "gctrl": {
        "type": "http",
        "url": "https://<machine>.<tailnet>.ts.net/api/agent/mcp",
        "headers": { "Authorization": "ApiKey <token>" }
      }
    }
  }
  ```

## Option A: host Tailscale + `tailscale serve` (recommended, no compose change)

Install Tailscale on the VPS itself and let it proxy straight to the already-running web container — nothing in `docker-compose.yml` changes.

```bash
# On the VPS
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Proxy tailnet HTTPS (443) → the GCTRL web container on localhost:3001,
# with automatic TLS certs from Tailscale's own CA
sudo tailscale serve --bg 3001
```

That's it. GCTRL is now reachable at `https://<machine-name>.<your-tailnet>.ts.net` to every device on your tailnet, with a valid TLS certificate and no port forwarding anywhere. Check the assigned hostname with `tailscale status` or `tailscale serve status`.

**Optional public exposure:** `tailscale funnel 3001` extends the same serve config to the public internet (Tailscale's Funnel feature) instead of just the tailnet. This is explicitly opt-in and changes the threat model back to "public install" — read [Networking & Ports](networking.md) and [Securing Your Deployment](security.md) before turning it on.

## Option B: sidecar container (advanced, self-managed)

If you'd rather keep Tailscale inside Docker instead of installing it on the host, add a `tailscale/tailscale` sidecar joined to the `gctrl` network. This is **not** part of the shipped compose template — copy it in and manage the auth key yourself:

```yaml
  gctrl-tailscale:
    image: tailscale/tailscale:latest
    container_name: gctrl-tailscale
    hostname: gctrl
    restart: unless-stopped
    environment:
      - TS_AUTHKEY=${TS_AUTHKEY}                 # generate in the Tailscale admin console
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_SERVE_CONFIG=/config/serve.json        # or use TS_EXTRA_ARGS instead, see below
    volumes:
      - gctrl-tailscale-state:/var/lib/tailscale
      - ./tailscale:/config
    cap_add:
      - NET_ADMIN
    networks:
      - gctrl

volumes:
  gctrl-tailscale-state:
```

`serve.json` (or `TS_EXTRA_ARGS=--serve=443,https,/,http://gctrl-web:80` as a one-line alternative to a config file) points the sidecar's serve config at `gctrl-web:80` — the container, not `localhost`, since the sidecar reaches it over the Docker network rather than the host loopback. This mirrors Option A's `tailscale serve` behavior but keeps the Tailscale node's lifecycle tied to the compose stack.

Treat this as advanced/self-managed: you own the auth key rotation, the state volume backup, and any serve-config changes across upgrades. Most installs should use Option A.

## Access tokens still apply

Tailnet membership and GCTRL access tokens are two independent layers — Tailscale gates the network path (who can reach the origin at all), GCTRL's `Authorization: ApiKey` tokens gate the data (what that connection is allowed to see and do). Being on the tailnet does not skip login or token scoping; create and scope tokens exactly as you would for a public install, in [Access Control](access-control.md).

## Embeds over the tailnet

Graph embed links (see [Embedding the Graph](graph-embed.md)) work the same way over a tailnet origin — swap `https://<your-install>/embed/graph/...` for `https://<machine>.<tailnet>.ts.net/embed/graph/...`. Anyone you share the link with still needs to be on the tailnet (Option A/B) or the link needs Funnel enabled if you intend it for people outside your tailnet.

## See also

[Networking & Ports](networking.md) · [Securing Your Deployment](security.md) · [Access Control](access-control.md)
