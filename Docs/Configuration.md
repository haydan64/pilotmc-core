# Central configuration

Backend stores deployment settings in PostgreSQL. Discord, Website, and each Instance download only their own settings with a separate read-only configuration token. Admins edit settings at `/admin/configuration`; credentials and host-specific paths are excluded.

## Installation and migration

1. As a PostgreSQL administrator, apply `Backend/database/migrations/001-central-configuration.sql` to the Core database. Supply the existing runtime role as `backend_role`, for example:

   ```powershell
   psql -U postgres -d pilotmc_core -v backend_role=pilotmc_backend_user -f Backend/database/migrations/001-central-configuration.sql
   ```

   This creates three tables and grants the runtime account only the permissions they need. It does not grant database-wide table creation.

2. New deployments: copy `Backend/config.initial.example.json` to the ignored `Backend/config.initial.json`. Fill in Discord application/guild IDs, the Admin role ID, website OAuth settings, and servers before first startup. Existing deployments using the `pilotmc-core` and `Minecraft/<instance>` layout can run `node scripts/migrateConfiguration.js <deployment-root>`. That command validates and imports existing JSON/environment settings, provisions distinct configuration-read tokens, and preserves originals in the deployment's private directory. It does not copy database passwords, Discord tokens, or host paths into the central document.

3. Configure Backend's `.env` with its database connection, existing API token, listener, and `CONFIG_SERVICE_TOKENS`. Its older `database/.env` remains supported. The token map has identities `discord`, `website`, and `instance:<server-key>`, each with a different strong random token. Give each service its corresponding `BACKEND_CONFIG_TOKEN`, `BACKEND_URL`, and existing `BACKEND_API_TOKEN`. Instance identity stays in local `SERVER_KEY`.

4. Start Backend first. It imports the initial configuration only if the database has no configuration row. Subsequent starts use the database; editing the old JSON files does not alter central settings. Start Discord, then Website and Instances. Sign into the website with a configured Discord Admin role and open **Admin → Configuration**.

## Local settings

- All services: backend URL, runtime authentication and scoped configuration-read token, local listener, logging paths.
- Discord: Discord bot token.
- Website: Discord OAuth client secret, session secret, paths to private branding asset files. Set central logo/favicon URLs to `/assets/brand-logo.png` and `/favicon.ico` to serve those existing files.
- Instances: `SERVER_KEY`, database credentials, local API/admin token, Bedrock binary/world path, `BACKUP_DIRECTORY`, and `SEVEN_ZIP_PATH`.
- Backend: database credentials, listener and CORS transport policy, service credentials, optional initial import path.
- Private module implementation files and Bedrock's native world/binary files remain host resources. This editor does not distribute executable code or rewrite `server.properties`.

## Validation, history, and activation

The editor supplies typed fields for Discord channels/roles/questions, website branding/OAuth settings, backend request timeouts, and each server's allowlist, chat relay, listing, backup and crash-restart behavior. Server listing text lives with the server policy. Embeds can be entered as JSON.

Saving validates the complete document, rejects unknown fields, duplicate identities, invalid role IDs, unsafe URL schemes, invalid backup ranges, and incomplete enabled features. A database transaction saves the new revision, immutable history, and audit event together. The editor uses a CSRF token and existing session/Admin checks; Backend verifies Admin access again. Concurrent changes return HTTP 409 and preserve the editor's draft. Earlier revisions can be loaded as drafts and saved as a new revision.

Services poll every 30 seconds, cache valid downloads atomically under their ignored `.cache` directory, and keep their active startup configuration unchanged. Restart the **Node service** to activate a saved revision; restarting Bedrock alone does not reload Instance configuration. The editor shows active and fetched revisions, pending restarts, and services that have stopped reporting. Backend behavior changes also require Backend restart. Unrelated services may report an older global revision even when their settings have not changed.

An established service can start from its validated last-known configuration during a backend outage. Cache identity includes backend URL, service identity, and a credential fingerprint. An empty/mismatched cache prevents startup. Authentication rejection or a deleted server prevents cache fallback. Invalid downloads never replace the previous valid cache. Access checks refuse new role-restricted grants when membership cannot be verified.

Without a configuration-read token, legacy installations still use their previous files. Provisioning the token opts a service into central configuration; it must obtain a valid snapshot and cannot silently fall back to legacy files.

## Development checks

Run `node --test tests/allowlistPolicy.test.js tests/configuration.test.js`. The PostgreSQL/API integration test uses `PILOTMC_INTEGRATION_ENV` pointing to a dedicated test database environment file; it creates and drops only a randomly named test schema. Run `node --test tests/configuration.integration.test.js` with that environment. Do not use the production runtime role for schema creation.

The Instance repository includes the same dependency-free configuration schema and client. Keep those two files synchronized when changing the protocol.
