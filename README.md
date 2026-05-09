# VoiceOS Discord MCP Server

This is a standalone TypeScript MCP server that lets VoiceOS read and write Discord messages through Composio's `DISCORDBOT` toolkit.

VoiceOS still launches this as a local stdio MCP server, but Discord authentication and token handling are delegated to Composio.

## Features

- `connect_discord_bot`: Returns a Composio Connect Link for Discord bot/account authentication.
- `list_discord_servers`: Explains guild/server discovery for the Composio-backed bot flow.
- `list_discord_channels`: Lists channels for a known Discord guild/server ID.
- `read_discord_messages`: Fetches recent messages from a Discord channel ID.
- `send_discord_message`: Sends a message to a Discord channel ID.
- `reply_discord_message`: Replies to a specific Discord message ID.

Write actions are described clearly in the MCP tool definitions so VoiceOS can show its confirmation pill before sending anything to Discord.

## Requirements

- Node.js 20+
- Composio API key
- A stable user ID for local testing

For production VoiceOS, the user ID should be injected automatically from the logged-in VoiceOS account. Users should not manually determine or enter it.

## Install

```bash
npm install
```

## Configure Environment

Create a local `.env` file:

```bash
COMPOSIO_API_KEY=your_composio_api_key
VOICEOS_USER_ID=local-test-user
COMPOSIO_TOOLKIT=DISCORDBOT
# Recommended/required for reliable DISCORDBOT channel and message tools.
COMPOSIO_AUTH_CONFIG_ID=your_discordbot_auth_config_id
```

`COMPOSIO_AUTH_CONFIG_ID` should point to a custom Composio `DISCORDBOT` auth config that includes the Discord client ID, client secret, bot token, and permission integer. The default Composio-managed OAuth connection can show as `ACTIVE` while still lacking the bot token needed for server channel/message endpoints, which causes Discord `401 Unauthorized` responses.

Optional server IDs for channel discovery:

```bash
DISCORD_GUILD_IDS=server_id_1,server_id_2
```

`DISCORD_GUILD_IDS` is useful because the current Composio-backed MCP maps channel listing to `DISCORDBOT_LIST_GUILD_CHANNELS`, which requires a guild/server ID.

## Run Locally

```bash
npm run start
```

## Connect to VoiceOS

1. Open VoiceOS settings.
2. Go to **Custom Integrations**.
3. Click **Add**.
4. Name the integration, for example `Discord`.
5. Paste the launch command:

```bash
/Users/makslas/Desktop/Development-Repos/VoiceOS-Discord-MCP/run-discord-mcp.sh
```

6. Click **Connect**.

## Authentication Flow

After the MCP is connected in VoiceOS, ask:

```text
Connect Discord
```

VoiceOS should call `connect_discord_bot`, which opens a Composio Connect Link. If `COMPOSIO_AUTH_CONFIG_ID` is set, the link is created against that exact auth config instead of Composio's default managed OAuth config.

If the user tries any Discord action before authenticating, the MCP returns an auth-required message. Normal Discord actions intentionally do not open Composio automatically, which prevents auth retry loops.

```text
Discord Bot authentication is required before I can access Discord.

Please explicitly ask: `Connect Discord` when you want me to open the Composio connection page.
```

## Tool Details

### `connect_discord_bot`

Creates a Composio Connect Link for `DISCORDBOT`.

Use this when asking VoiceOS:

```text
Connect Discord
```

### `list_discord_servers`

If `DISCORD_GUILD_IDS` is configured, fetches details for those guilds. Otherwise, explains that Composio `DISCORDBOT` channel listing requires a guild/server ID.

### `list_discord_channels`

Lists Discord channels for a server/guild.

Parameters:

- `guild_id`: Optional Discord server/guild ID. If omitted, the tool uses `DISCORD_GUILD_IDS`.
- `text_only`: Defaults to `true`, returning only text-like channels suitable for read/send message workflows.

Use this when asking VoiceOS:

```text
What Discord channels do you have access to in server GUILD_ID?
```

### `read_discord_messages`

Reads recent messages from a channel via `DISCORDBOT_LIST_MESSAGES`.

Parameters:

- `channel_id`: Discord channel ID.
- `channel_name`: Discord channel name, such as `general`. Used when `channel_id` is omitted.
- `guild_id`: Optional Discord server/guild ID used to resolve `channel_name`. If omitted, the tool uses `DISCORD_GUILD_IDS`.
- `limit`: Number of messages to fetch, from 1 to 100. Defaults to 10.
- `before`: Optional message ID for pagination. Fetches messages before this message.
- `after`: Optional message ID for pagination. Fetches messages after this message.
- `around`: Optional message ID for pagination. Fetches messages around this message.
- `author_filter`: Optional user ID, username, or display-name filter.

### `send_discord_message`

Sends a message to a channel via `DISCORDBOT_CREATE_MESSAGE`.

Parameters:

- `channel_id`: Discord channel ID.
- `channel_name`: Discord channel name, such as `general`. Used when `channel_id` is omitted.
- `guild_id`: Optional Discord server/guild ID used to resolve `channel_name`. If omitted, the tool uses `DISCORD_GUILD_IDS`.
- `content`: Exact message content. Max 2000 characters.
- `tts`: Whether to send as text-to-speech. Defaults to `false`.
- `allowed_mentions`: Mention parsing policy. One of `none`, `users`, `users_and_roles`, or `everyone`. Defaults to `none`.

### `reply_discord_message`

Replies to a specific message via `DISCORDBOT_CREATE_MESSAGE` with `message_reference`.

Parameters:

- `channel_id`: Discord channel ID containing the original message.
- `channel_name`: Discord channel name, such as `general`. Used when `channel_id` is omitted.
- `guild_id`: Optional Discord server/guild ID used to resolve `channel_name`. If omitted, the tool uses `DISCORD_GUILD_IDS`.
- `message_id`: Discord message ID to reply to.
- `content`: Exact reply content. Max 2000 characters.
- `allowed_mentions`: Mention parsing policy. One of `none`, `users`, `users_and_roles`, or `everyone`. Defaults to `none`.

## Discord DM Limitations

Composio `DISCORDBOT` supports bot-accessible channel messaging, message reads, replies, guild channel listing, and bot-created DMs.

It does not grant broad access to a user's existing personal DMs. Group DM operations require user OAuth2 access tokens with `gdm.join` and remain constrained by Discord API limitations.

## Production VoiceOS User IDs

For production, VoiceOS should pass its internal logged-in user ID to Composio automatically. The user should never manually type a user ID.

Do not use Discord email as the primary Composio `user_id`:

- The connect link requires a user ID before Discord OAuth completes.
- Discord email may be unavailable depending on scopes.
- Email can change.
- One VoiceOS user may eventually connect multiple Discord accounts.

## Security Notes

- Do not commit `.env`.
- Do not commit `COMPOSIO_API_KEY`.
- Do not commit Discord bot tokens or connected-account credentials.
- `allowed_mentions` defaults to `none` so generated messages do not accidentally ping users, roles, `@everyone`, or `@here`.
