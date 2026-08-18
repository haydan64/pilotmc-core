# Architecture

PilotMC Core coordinates multiple independent `pilotmc-instance` deployments. Core never contains Bedrock installations, worlds, backups, production credentials, or community-specific modules.

Each instance has a unique `SERVER_KEY`, its own database and Bedrock files, and a shared API token for authenticated communication with Core. Discord and Website communicate with instances through Backend instead of accessing instance files directly.

Optional modules are discovered dynamically from each application's `modules` directory. Base services do not import a named module or assume that any module is installed.
