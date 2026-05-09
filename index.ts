import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DISCORD_API_BASE_URL =
  process.env.DISCORD_API_BASE ?? "https://discord.com/api/v10";
const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_MESSAGE_LIMIT = 100;

const botToken = process.env.DISCORD_BOT_TOKEN;
const configuredGuildIds = (process.env.DISCORD_GUILD_IDS ?? "")
  .split(",")
  .map((guildId) => guildId.trim())
  .filter(Boolean);

if (!botToken) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
};

type DiscordAttachment = {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size: number;
};

type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  type?: string;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: DiscordUser;
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
  referenced_message?: DiscordMessage | null;
};

type DiscordApiError = {
  message?: string;
  code?: number;
  errors?: unknown;
};

type DiscordGuild = {
  id: string;
  name: string;
  owner?: boolean;
  permissions?: string;
};

type DiscordChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
  parent_id?: string | null;
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
};

const mentionPolicySchema = z
  .enum(["none", "users", "users_and_roles", "everyone"])
  .default("none")
  .describe(
    "Allowed Discord mention parsing policy. Use 'none' unless the user explicitly asks to ping users, roles, @everyone, or @here."
  );

async function discordRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "VoiceOS-Discord-MCP (https://voiceos.com, 1.0.0)",
      ...options.headers,
    },
  });

  if (!response.ok) {
    let errorBody: DiscordApiError | string;

    try {
      errorBody = (await response.json()) as DiscordApiError;
    } catch {
      errorBody = await response.text();
    }

    const errorMessage =
      typeof errorBody === "string"
        ? errorBody
        : errorBody.message ?? JSON.stringify(errorBody);

    throw new Error(
      `Discord API request failed (${response.status} ${response.statusText}): ${errorMessage}`
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function clampMessageLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), MAX_MESSAGE_LIMIT);
}

function formatAuthor(author: DiscordUser): string {
  const displayName = author.global_name ?? author.username;
  return `${displayName} (${author.username}, id: ${author.id})`;
}

function messageMatchesAuthorFilter(
  message: DiscordMessage,
  authorFilter?: string
): boolean {
  if (!authorFilter) {
    return true;
  }

  const normalizedFilter = authorFilter.toLowerCase();
  const candidates = [
    message.author.id,
    message.author.username,
    message.author.global_name ?? "",
  ].map((value) => value.toLowerCase());

  return candidates.some((value) => value.includes(normalizedFilter));
}

function formatMessageForAgent(message: DiscordMessage): string {
  const attachments =
    message.attachments && message.attachments.length > 0
      ? `\n  Attachments: ${message.attachments
          .map((attachment) => `${attachment.filename} (${attachment.url})`)
          .join(", ")}`
      : "";

  const embeds =
    message.embeds && message.embeds.length > 0
      ? `\n  Embeds: ${message.embeds
          .map((embed) => {
            const parts = [
              embed.type ? `type=${embed.type}` : undefined,
              embed.title ? `title="${embed.title}"` : undefined,
              embed.description
                ? `description="${embed.description.slice(0, 160)}${
                    embed.description.length > 160 ? "..." : ""
                  }"`
                : undefined,
              embed.url ? `url=${embed.url}` : undefined,
            ].filter(Boolean);

            return parts.length > 0 ? parts.join(", ") : "embed";
          })
          .join(" | ")}`
      : "";

  const replyContext = message.referenced_message
    ? `\n  Replying to: ${formatAuthor(message.referenced_message.author)} - ${
        message.referenced_message.content || "[no text content]"
      }`
    : "";

  return [
    `Message ID: ${message.id}`,
    `Channel ID: ${message.channel_id}`,
    `Author: ${formatAuthor(message.author)}`,
    `Created: ${message.timestamp}`,
    `Edited: ${message.edited_timestamp ?? "no"}`,
    `Content: ${message.content || "[no text content]"}${attachments}${embeds}${replyContext}`,
  ].join("\n");
}

function allowedMentionsForPolicy(policy: z.infer<typeof mentionPolicySchema>) {
  switch (policy) {
    case "users":
      return { parse: ["users"] };
    case "users_and_roles":
      return { parse: ["users", "roles"] };
    case "everyone":
      return { parse: ["users", "roles", "everyone"] };
    case "none":
    default:
      return { parse: [] };
  }
}

function formatChannelType(type: number): string {
  const channelTypes: Record<number, string> = {
    0: "text",
    2: "voice",
    4: "category",
    5: "announcement",
    10: "announcement_thread",
    11: "public_thread",
    12: "private_thread",
    13: "stage_voice",
    15: "forum",
    16: "media",
  };

  return channelTypes[type] ?? `unknown_${type}`;
}

function isTextLikeChannel(channel: DiscordChannel): boolean {
  return [0, 5, 10, 11, 12].includes(channel.type);
}

function formatGuild(guild: DiscordGuild): string {
  return `Server: ${guild.name}\nServer ID: ${guild.id}`;
}

function formatChannel(channel: DiscordChannel): string {
  const name = channel.name ? `#${channel.name}` : "[unnamed channel]";
  const details = [
    `Channel: ${name}`,
    `Channel ID: ${channel.id}`,
    channel.guild_id ? `Server ID: ${channel.guild_id}` : undefined,
    `Type: ${formatChannelType(channel.type)}`,
    channel.parent_id ? `Parent ID: ${channel.parent_id}` : undefined,
    channel.topic ? `Topic: ${channel.topic}` : undefined,
  ].filter(Boolean);

  return details.join("\n");
}

async function listBotGuilds(): Promise<DiscordGuild[]> {
  return discordRequest<DiscordGuild[]>("/users/@me/guilds");
}

const server = new McpServer({
  name: "voiceos-discord",
  version: "1.0.0",
});

/**
 * ## Future Discord OAuth Architecture
 *
 * The current local MCP server uses `DISCORD_BOT_TOKEN`. For a seamless
 * VoiceOS "Connect Discord" flow, VoiceOS should own a first-party Discord
 * application and bot:
 *
 * 1. User clicks "Connect Discord" in VoiceOS settings.
 * 2. VoiceOS opens Discord OAuth2 with scopes: `bot`, `identify`, and `guilds`.
 * 3. User selects a server and authorizes the VoiceOS bot with permissions:
 *    `View Channels`, `Read Message History`, and `Send Messages`.
 * 4. Discord redirects to the VoiceOS backend OAuth callback.
 * 5. VoiceOS stores the Discord user ID, guild installation metadata, and any
 *    setup OAuth tokens. The first-party bot token stays in VoiceOS secret
 *    storage, not on the user's device.
 * 6. The VoiceOS MCP runtime calls Discord through the managed bot installation.
 *
 * Discord's `messages.read` scope does not replace bot permissions for normal
 * server/channel access. For this use case, bot installation plus least-privilege
 * channel permissions is the recommended architecture.
 */

server.tool(
  "list_discord_servers",
  "List Discord servers/guilds that the bot can see. Use this when the user asks what Discord servers are connected or available.",
  {},
  async () => {
    const guilds = await listBotGuilds();

    const text =
      guilds.length > 0
        ? guilds.map(formatGuild).join("\n\n---\n\n")
        : "No Discord servers found for this bot. Make sure the bot has been invited to a server.";

    return {
      content: [{ type: "text", text }],
    };
  }
);

server.tool(
  "list_discord_channels",
  "List Discord channels that the bot can discover. Provide a server/guild ID when known. If no server ID is provided, this tool uses DISCORD_GUILD_IDS from the environment or tries to list all bot servers first. Use this when the user asks what Discord channels or chats are available.",
  {
    guild_id: z
      .string()
      .optional()
      .describe("Optional Discord server/guild ID. If omitted, uses DISCORD_GUILD_IDS or all bot servers."),
    text_only: z
      .boolean()
      .default(true)
      .describe("Only return text-like channels that can be used for reading or sending messages. Defaults to true."),
  },
  async ({ guild_id, text_only = true }) => {
    let guildIds = guild_id ? [guild_id] : configuredGuildIds;

    if (guildIds.length === 0) {
      const guilds = await listBotGuilds();
      guildIds = guilds.map((guild) => guild.id);
    }

    if (guildIds.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No Discord servers found. Invite the bot to a server or set DISCORD_GUILD_IDS in the MCP .env file.",
          },
        ],
      };
    }

    const sections = await Promise.all(
      guildIds.map(async (currentGuildId) => {
        const channels = await discordRequest<DiscordChannel[]>(
          `/guilds/${currentGuildId}/channels`
        );

        const filteredChannels = text_only
          ? channels.filter(isTextLikeChannel)
          : channels;

        const channelText =
          filteredChannels.length > 0
            ? filteredChannels.map(formatChannel).join("\n\n")
            : "No matching channels found.";

        return `Server ID: ${currentGuildId}\n\n${channelText}`;
      })
    );

    return {
      content: [
        {
          type: "text",
          text: `${sections.join("\n\n---\n\n")}\n\nNote: Discord channel-level permissions can still block reading or sending even when a channel is listed.`,
        },
      ],
    };
  }
);

server.tool(
  "read_discord_messages",
  "Read recent messages from a specific Discord channel by channel ID. Use this when the user asks what is happening in a Discord channel or wants context from recent Discord messages. This is a read-only action.",
  {
    channel_id: z
      .string()
      .min(1)
      .describe("Discord channel ID to read messages from."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MESSAGE_LIMIT)
      .default(DEFAULT_MESSAGE_LIMIT)
      .describe("Number of recent messages to fetch. Maximum is 100."),
    before: z
      .string()
      .optional()
      .describe("Optional Discord message ID. Fetch messages before this message."),
    after: z
      .string()
      .optional()
      .describe("Optional Discord message ID. Fetch messages after this message."),
    around: z
      .string()
      .optional()
      .describe("Optional Discord message ID. Fetch messages around this message."),
    author_filter: z
      .string()
      .optional()
      .describe(
        "Optional author filter. Matches Discord user ID, username, or display name in the fetched messages."
      ),
  },
  async ({
    channel_id,
    limit = DEFAULT_MESSAGE_LIMIT,
    before,
    after,
    around,
    author_filter,
  }) => {
    const params = new URLSearchParams({
      limit: String(clampMessageLimit(limit)),
    });

    if (before) {
      params.set("before", before);
    }

    if (after) {
      params.set("after", after);
    }

    if (around) {
      params.set("around", around);
    }

    const messages = await discordRequest<DiscordMessage[]>(
      `/channels/${channel_id}/messages?${params.toString()}`
    );

    const filteredMessages = messages.filter((message) =>
      messageMatchesAuthorFilter(message, author_filter)
    );

    const text =
      filteredMessages.length > 0
        ? filteredMessages.map(formatMessageForAgent).join("\n\n---\n\n")
        : `No Discord messages found in channel ${channel_id}${
            author_filter ? ` matching author filter "${author_filter}"` : ""
          }.`;

    return {
      content: [{ type: "text", text }],
    };
  }
);

server.tool(
  "send_discord_message",
  "Send a new message to a specific Discord channel by channel ID. This is a write action and should be shown to the user as a VoiceOS confirmation pill before execution. Confirm the channel ID and exact message content with the user before calling this tool.",
  {
    channel_id: z
      .string()
      .min(1)
      .describe("Discord channel ID where the message will be sent."),
    content: z
      .string()
      .min(1)
      .max(2000)
      .describe("Exact Discord message content to send. Discord messages are limited to 2000 characters."),
    tts: z
      .boolean()
      .default(false)
      .describe("Whether this message should be sent as text-to-speech. Defaults to false."),
    allowed_mentions: mentionPolicySchema,
  },
  async ({ channel_id, content, tts = false, allowed_mentions = "none" }) => {
    const message = await discordRequest<DiscordMessage>(
      `/channels/${channel_id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          tts,
          allowed_mentions: allowedMentionsForPolicy(allowed_mentions),
        }),
      }
    );

    return {
      content: [
        {
          type: "text",
          text: `Sent Discord message ${message.id} to channel ${message.channel_id} at ${message.timestamp}:\n${message.content}`,
        },
      ],
    };
  }
);

server.tool(
  "reply_discord_message",
  "Reply to a specific Discord message ID in a channel. This is a write action and should be shown to the user as a VoiceOS confirmation pill before execution. Confirm the channel ID, message ID, and exact reply content with the user before calling this tool.",
  {
    channel_id: z
      .string()
      .min(1)
      .describe("Discord channel ID containing the message being replied to."),
    message_id: z
      .string()
      .min(1)
      .describe("Discord message ID to reply to."),
    content: z
      .string()
      .min(1)
      .max(2000)
      .describe("Exact Discord reply content to send. Discord messages are limited to 2000 characters."),
    allowed_mentions: mentionPolicySchema,
  },
  async ({ channel_id, message_id, content, allowed_mentions = "none" }) => {
    const message = await discordRequest<DiscordMessage>(
      `/channels/${channel_id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          message_reference: {
            message_id,
            channel_id,
            fail_if_not_exists: true,
          },
          allowed_mentions: allowedMentionsForPolicy(allowed_mentions),
        }),
      }
    );

    return {
      content: [
        {
          type: "text",
          text: `Sent Discord reply ${message.id} to message ${message_id} in channel ${message.channel_id} at ${message.timestamp}:\n${message.content}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
