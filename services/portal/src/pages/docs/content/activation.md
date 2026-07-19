# Activation

After [installation](installation.md), the platform is running but not yet activated. Activation creates your admin account and unlocks the licensed capabilities of your deployment.

## First run

1. Open the dashboard at **`http://localhost:3001`**.
2. **Create your admin account.** On first run, the first account you create becomes the platform administrator.
3. **Enter your license key.**

## License key

License keys use the format:

```
GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX
```

> The value above is a **placeholder**. Enter the real key issued to your organization. Never share or commit a real key.

## What the license unlocks

The license **activates the platform**. For licensed tiers it also **unlocks the tuned entity-resolution profile** delivered to your deployment - a resolution configuration matched to your data and use case.

- **With a license:** FUSE runs the tuned entity-resolution profile shipped to your deployment.
- **Without a license:** the platform runs on **safe generic defaults** - fully functional, using a conservative baseline resolution configuration.

## Hardware-bound activation

Activation is **hardware-bound**: the license is tied to the deployment it is activated on. The local **license agent** (port `:7070`) handles validation against the host. Moving the deployment to new hardware may require re-activation.

## Everything stays local

Activation does **not** send your data anywhere. License validation concerns the license itself - **your ingested content, graphs, and memory never leave the machine**. GCTRL remains fully on-prem before and after activation.

## Next steps

With the platform activated, continue to [Quickstart](quickstart.md) to run your first ingest end to end.
