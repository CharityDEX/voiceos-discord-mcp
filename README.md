# VoiceOS Discord MCP Server

This is a standalone TypeScript MCP server that lets VoiceOS read and write Discord messages through a Discord bot.

## Features

- `read_discord_messages`: Fetch recent messages from a Discord channel ID.
- `send_discord_message`: Send a message to a Discord channel ID.
- `reply_discord_message`: Reply to a specific Discord message ID.
- `list_discord_servers`: List servers/guilds the bot can see.
- `list_discord_channels`: List channels by server/guild ID, or from configured guild IDs.

Write actions are described clearly in the MCP tool definitions so VoiceOS can show its confirmation pill before sending anything to Discord.

## Requirements

- Node.js 20+
- A Discord bot token
- The bot must be invited to the Discord server with access to the target channels

## Install

```bash
npm install
```

## Create a Discord Bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**.
3. Open **Bot** in the sidebar.
4. Click **Add Bot** if one does not already exist.
5. Click **Reset Token** or **Copy Token** and save it securely.
6. Enable **Message Content Intent** under **Privileged Gateway Intents** if you need the bot to read message text in servers.

## Invite the Bot to a Server

1. In the Discord Developer Portal, open your application.
2. Go to **OAuth2** -> **URL Generator**.
3. Select scopes:
   - `bot`
4. Select bot permissions:
   - `View Channels`
   - `Read Message History`
   - `Send Messages`
5. Copy the generated URL, open it in a browser, and add the bot to your server.

The bot also needs channel-level permissions for every channel VoiceOS should access.

## Configure Environment

Set the bot token before launching the MCP server:

```bash
export DISCORD_BOT_TOKEN="your_discord_bot_token"
```

Optional API base override:

```bash
export DISCORD_API_BASE="https://discord.com/api/v10"
```

Optional server IDs for channel discovery:

```bash
export DISCORD_GUILD_IDS="server_id_1,server_id_2"
```

## Run Locally

```bash
npm run start
```

For direct VoiceOS setup, use a launch command like:

```bash
DISCORD_BOT_TOKEN="your_discord_bot_token" npx tsx /path/to/index.ts
```

Replace `/path/to/index.ts` with the absolute path to this repository's `index.ts`.

## Connect to VoiceOS

1. Open VoiceOS settings.
2. Go to **Custom Integrations**.
3. Click **Add**.
4. Name the integration, for example `Discord`.
5. Paste the launch command:

```bash
DISCORD_BOT_TOKEN="your_discord_bot_token" npx tsx /path/to/index.ts
```

6. Click **Connect**.

## Tool Details

### `list_discord_servers`

Lists Discord servers/guilds the bot can see.

Use this when asking VoiceOS:

```text
What Discord servers are connected?
```

### `list_discord_channels`

Lists Discord channels for a server/guild.

Parameters:

- `guild_id`: Optional Discord server/guild ID. If omitted, the tool uses `DISCORD_GUILD_IDS` or tries to list all bot servers first.
- `text_only`: Defaults to `true`, returning only text-like channels suitable for read/send message workflows.

Use this when asking VoiceOS:

```text
What Discord channels do you have access to?
```

### `read_discord_messages`

Reads recent messages from a channel.

Parameters:

- `channel_id`: Discord channel ID.
- `limit`: Number of messages to fetch, from 1 to 100. Defaults to 10.
- `before`: Optional message ID for pagination. Fetches messages before this message.
- `after`: Optional message ID for pagination. Fetches messages after this message.
- `around`: Optional message ID for pagination. Fetches messages around this message.
- `author_filter`: Optional user ID, username, or display-name filter.

Returns author, timestamp, message ID, channel ID, content, attachments, embed summaries, and reply reference context when available.

### `send_discord_message`

Sends a message to a channel.

Parameters:

- `channel_id`: Discord channel ID.
- `content`: Exact message content. Max 2000 characters.
- `tts`: Whether to send as text-to-speech. Defaults to `false`.
- `allowed_mentions`: Mention parsing policy. One of `none`, `users`, `users_and_roles`, or `everyone`. Defaults to `none`.

### `reply_discord_message`

Replies to a specific message.

Parameters:

- `channel_id`: Discord channel ID containing the original message.
- `message_id`: Discord message ID to reply to.
- `content`: Exact reply content. Max 2000 characters.
- `allowed_mentions`: Mention parsing policy. One of `none`, `users`, `users_and_roles`, or `everyone`. Defaults to `none`.

## Discord IDs

To copy Discord channel or message IDs:

1. Open Discord settings.
2. Go to **Advanced**.
3. Enable **Developer Mode**.
4. Right-click a channel or message.
5. Click **Copy Channel ID** or **Copy Message ID**.

## Troubleshooting

- `DISCORD_BOT_TOKEN environment variable is required`: Set the environment variable in the VoiceOS launch command.
- `Missing Access`: The bot is not in the server or cannot access the channel.
- `Missing Permissions`: The bot lacks channel permissions such as `View Channels`, `Read Message History`, or `Send Messages`.
- Empty message content: Enable **Message Content Intent** in the Discord Developer Portal and confirm the bot has permission to read the channel.

## Security Notes

- Do not commit bot tokens.
- Prefer a bot with the minimum required permissions.
- `allowed_mentions` defaults to `none` so generated messages do not accidentally ping users, roles, `@everyone`, or `@here`.
