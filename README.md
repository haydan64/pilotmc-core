# PilotMC Core

PilotMC Core provides the shared services around one or more Minecraft Bedrock server instances:

- `Backend`: HTTP API, Socket.IO hub, shared player identities, and service discovery.
- `Discord`: Discord commands and Minecraft event relays.
- `Website`: public site, authentication, player profiles, and administration.
- `Docs`: public architecture and configuration notes.

Community-specific behavior does not belong in this repository. Each service discovers optional JavaScript modules from its local `modules` directory at runtime. Module contents are intentionally ignored by Git.

## Requirements

- Node.js 20 or newer
- PostgreSQL
- A Discord application for Discord commands and OAuth
- One or more separately deployed `pilotmc-instance` controllers

## Configuration

Copy each `.env.example` file to `.env` in the same application directory and provide deployment-specific values. Copy `Discord/botConfig.example.json` to `Discord/botConfig.json` and configure channel IDs, role IDs, and Minecraft instances. Real configuration files are ignored.

Role keys are generic: `admin`, `staff`, `member`, `guest`, and `developer`.

## Development

Install locked dependencies and run checks independently for each application:

```powershell
npm --prefix Backend ci
npm --prefix Discord ci
npm --prefix Website ci
npm --prefix Backend run check
npm --prefix Discord run check
npm --prefix Website run check
```

The check command recursively validates every JavaScript file in the application, including locally installed optional modules.

Use the same strong `BACKEND_API_TOKEN` for Core services and instances. Backend HTTP and Socket.IO access fails closed when the token is absent or incorrect.

## Central configuration

Admins can manage deployment settings from Website at `/admin/configuration`. Backend stores validated revisions and history; services fetch scoped configuration and cache the last valid version. See [Configuration](Docs/Configuration.md) for the database migration, bootstrap credentials, and restart behavior. Legacy JSON files remain supported until a service is opted into central configuration.
