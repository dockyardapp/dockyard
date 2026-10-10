# Dockyard documentation

Dockyard is a Docker control panel: containers, app templates and Cloudflare tunnels on one screen,
backed by Postgres. The [README](../README.md) is the front door and the quick start. These pages go
deeper.

| Page | What it covers |
|---|---|
| [installation.md](installation.md) | Requirements, the interactive setup, every flag, the deployment modes, ports, re-running, and how to verify an install. |
| [configuration.md](configuration.md) | Every environment variable the panel reads, with defaults and the security consequences. |
| [architecture.md](architecture.md) | How the panel is put together: boot sequence, module layout, data model, and how the frontend is served. |
| [api.md](api.md) | The HTTP and WebSocket API, by resource, with the role each endpoint requires. |
| [security.md](security.md) | The threat model and the controls, including the Docker socket and the session cookie rules. |
| [troubleshooting.md](troubleshooting.md) | The failure modes that actually happen, and how to confirm and fix each one. |
| [../CONTRACT.md](../CONTRACT.md) | The frozen interface specification the project was built against. |

## Where to start

- **Installing it:** [installation.md](installation.md).
- **It is not working:** [troubleshooting.md](troubleshooting.md).
- **Putting it on a public address:** [security.md](security.md) first, then
  [installation.md](installation.md#behind-nginx).
- **Changing it:** [architecture.md](architecture.md), then [CONTRACT.md](../CONTRACT.md) for the
  interfaces you must not break.
