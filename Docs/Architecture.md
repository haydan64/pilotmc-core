# Architecture

PilotMC Core coordinates multiple independent `pilotmc-instance` deployments. Core never contains Bedrock installations, worlds, backups, production credentials, or community-specific modules.

Each instance has a unique `SERVER_KEY`, its own database and Bedrock files, and a shared API token for authenticated communication with Core. Discord and Website communicate with instances through Backend instead of accessing instance files directly.

Optional modules are discovered dynamically from each application's `modules` directory. Base services do not import a named module or assume that any module is installed.

## Per-server allowlist policy

Each entry in `Discord/botConfig.json` can include an `allowlist` object:

```json
{
  "key": "survival",
  "name": "Survival",
  "allowlist": {
    "autoAllowlist": true,
    "requiredRoleIds": ["DISCORD_MEMBER_ROLE_ID"],
    "blockedRoleIds": ["DISCORD_BLOCKED_ROLE_ID"],
    "requireDiscordMembership": true,
    "removeOnDiscordLeave": true
  }
}
```

Role values are Discord role IDs. Any blocked role denies access, even if a required role is also present. Any required role suffices; an empty list imposes no required-role restriction. Rules apply to automatic allowlisting, staff allowlisting, username refreshes, and Minecraft joins. Membership lookups use fresh Discord data. Enabling auto-allowlist does not bypass role rules.

All switches default to false and role lists default to empty. The older `autoAllowlistOnSetMinecraftUsername` flag remains supported when `allowlist.autoAllowlist` is omitted. Deployments that relied on the previous global Member-role gate or automatic removal on Discord departure must explicitly configure those rules per server.

Set `channels.usernameChangeReview` to the staff review channel ID. First-time `/setminecraftusername` linking saves immediately. Changing an existing username posts Accept/Deny buttons and leaves the saved identity unchanged until approval by a configured staff, admin, or developer role. Approval rechecks name ownership and rejects stale requests. It preserves existing eligible allowlist access and player-limit exemptions, and adds newly eligible players only on servers with auto-allowlist enabled. Existing server profiles must be available before approval. Per-server update failures are reported to the reviewer. Requests survive bot restarts in Discord messages; no private module is needed.

## Optional application forms and server listings

Applications activate when `questions` is nonempty in `botConfig.json`. Each question supplies `id`, `label`, `prompt`, and `required`; `formLabel` and `formDescription` customize its form display. Set `channels.applyHere` and `channels.applications` for private forms and staff review. Forms support 1–10 questions. Set `requireAcceptedApplicationForLinking` to require accepted applications before using `/setminecraftusername`; its default is false. Application acceptance and reset use the configured Member and Guest roles.

Copy `Discord/serverListings.example.json` to the ignored `Discord/serverListings.json` to enable listings. Listing content, channel IDs, and application requirements belong in that deployment file. Listings use the same per-server allowlist role policy as commands and joins; `requiredRoleId` can impose an additional listing role. A listing never changes an existing linked username: users request changes through `/setminecraftusername`.

Develop shared code in the base PilotMC checkout and commit it to the shared repository. Deployment checkouts receive that code through Git. Keep credentials, branding assets, role IDs, application questions, and listing text in ignored configuration or private modules.
