import { Composio } from "@composio/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { z } from "zod";

const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_MESSAGE_LIMIT = 100;
const DISCORD_BOT_TOOLKIT = process.env.COMPOSIO_TOOLKIT ?? "DISCORDBOT";
const COMPOSIO_TOOLKIT_SLUG = DISCORD_BOT_TOOLKIT.toLowerCase();
const COMPOSIO_AUTH_CONFIG_ID = process.env.COMPOSIO_AUTH_CONFIG_ID;
const AUTO_OPEN_AUTH_BROWSER =
  process.env.OPEN_COMPOSIO_AUTH_BROWSER !== "false";

const configuredGuildIds = (process.env.DISCORD_GUILD_IDS ?? "")
  .split(",")
  .map((guildId) => guildId.trim())
  .filter(Boolean);

const composioApiKey = process.env.COMPOSIO_API_KEY;
const voiceOsUserId = process.env.VOICEOS_USER_ID;

if (!composioApiKey) {
  throw new Error("COMPOSIO_API_KEY environment variable is required.");
}

if (!voiceOsUserId) {
  throw new Error(
    "VOICEOS_USER_ID environment variable is required for local testing. Production VoiceOS should inject the logged-in user's internal ID automatically."
  );
}

const composioUserId = voiceOsUserId;

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

const composio = new Composio({
  apiKey: composioApiKey,
  host: "voiceos-discord-mcp",
});

let sessionPromise: ReturnType<typeof composio.create> | undefined;

function getSession() {
  const sessionConfig = {
    toolkits: [COMPOSIO_TOOLKIT_SLUG],
    ...(COMPOSIO_AUTH_CONFIG_ID
      ? { authConfigs: { [COMPOSIO_TOOLKIT_SLUG]: COMPOSIO_AUTH_CONFIG_ID } }
      : {}),
    manageConnections: true,
  };

  sessionPromise ??= composio.create(composioUserId, sessionConfig);

  return sessionPromise;
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

type ComposioExecutionData = Record<string, unknown>;

type ConnectionReady = {
  type: "ready";
};

type NeedsAuthLink = {
  type: "needs_auth";
  text: string;
};

type ConnectionState = ConnectionReady | NeedsAuthLink;

function textResponse(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function stringifyData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  return JSON.stringify(data, null, 2);
}

function normalizeComposioConnectUrl(url: string): string {
  return url
    .replace("https://connect.composio.dev", "https://platform.composio.dev")
    .replace("http://connect.composio.dev", "https://platform.composio.dev")
    .replace("https://connect..dev", "https://platform.composio.dev")
    .replace("http://connect..dev", "https://platform.composio.dev")
    .replace("https://connect.dev", "https://platform.composio.dev")
    .replace("http://connect.dev", "https://platform.composio.dev");
}

function openUrlInBrowser(url: string): boolean {
  if (!AUTO_OPEN_AUTH_BROWSER) {
    return false;
  }

  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function formatConnectLinkMessage(redirectUrl: string, openedBrowser: boolean): string {
  return [
    "Discord is connected to VoiceOS, but your Discord bot/account connection is not authenticated in Composio yet.",
    "",
    openedBrowser
      ? "I opened the Composio Discord connection page in your browser."
      : "I could not open the Composio Discord connection page automatically.",
    "",
    "I am intentionally not printing the Composio URL because VoiceOS link handling has been corrupting Composio hostnames in chat.",
    "",
    "After completing authentication, retry your Discord request.",
  ].join("\n");
}

function formatAuthRequiredMessage(details?: string): string {
  return [
    details ?? "Discord Bot authentication is required before I can access Discord.",
    "",
    "I will not open Composio automatically for normal Discord requests, to avoid an auth retry loop.",
    "",
    "Please explicitly ask: `Connect Discord` when you want me to open the Composio connection page.",
    "",
    "After completing authentication, retry your Discord request.",
  ].join("\n");
}

function formatInvalidDiscordBotAuthMessage({
  statusCode,
  errorBody,
  authConfigId,
  connectedAccountId,
  isComposioManaged,
}: {
  statusCode?: number;
  errorBody?: string;
  authConfigId?: string;
  connectedAccountId?: string;
  isComposioManaged?: boolean;
}): string {
  const configHint = COMPOSIO_AUTH_CONFIG_ID
    ? `The MCP is configured to use Composio auth config ${COMPOSIO_AUTH_CONFIG_ID}.`
    : "The MCP is not configured with COMPOSIO_AUTH_CONFIG_ID, so Composio is falling back to its default managed OAuth connection.";

  const managedHint = isComposioManaged
    ? [
        "The active Composio connection is Composio-managed OAuth. For the DISCORDBOT channel/message tools, that is not enough by itself: the auth config must include the Discord bot token.",
        "",
        "Create or select a custom DISCORDBOT auth config in Composio that includes the Discord client ID, client secret, bot token, and permission integer, then set COMPOSIO_AUTH_CONFIG_ID in this MCP environment.",
      ].join("\n")
    : "Reconnect the configured DISCORDBOT auth config and confirm it includes a valid Discord bot token.";

  return formatAuthRequiredMessage(
    [
      "Composio says Discord Bot is connected, but the actual bot-token check fails.",
      "",
      `Discord auth status: ${statusCode ?? "unknown"}`,
      errorBody ? `Discord error: ${errorBody}` : undefined,
      authConfigId ? `Active auth config: ${authConfigId}` : undefined,
      connectedAccountId ? `Active connected account: ${connectedAccountId}` : undefined,
      "",
      configHint,
      "",
      managedHint,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function createDiscordConnectLink(): Promise<string> {
  const connectionRequest = COMPOSIO_AUTH_CONFIG_ID
    ? await composio.toolkits.authorize(
        composioUserId,
        COMPOSIO_TOOLKIT_SLUG,
        COMPOSIO_AUTH_CONFIG_ID
      )
    : await (await getSession()).authorize(COMPOSIO_TOOLKIT_SLUG);
  const redirectUrl = connectionRequest.redirectUrl
    ? normalizeComposioConnectUrl(connectionRequest.redirectUrl)
    : null;

  if (!redirectUrl) {
    throw new Error(
      "Composio did not return a Discord connect link. Check the DISCORDBOT auth configuration in Composio."
    );
  }

  return redirectUrl;
}

async function ensureDiscordBotConnection(): Promise<ConnectionState> {
  const session = await getSession();
  const toolkits = await session.toolkits({
    toolkits: [COMPOSIO_TOOLKIT_SLUG],
  });

  const discordToolkit = toolkits.items.find(
    (toolkit) => toolkit.slug.toLowerCase() === COMPOSIO_TOOLKIT_SLUG
  );

  if (discordToolkit?.connection?.isActive) {
    const authTest = await session.execute("DISCORDBOT_TEST_AUTH", {});
    const authData = authTest.data as {
      auth_ok?: boolean;
      status_code?: number;
      error_body?: string;
    };

    if (authTest.error || authData.auth_ok === false) {
      return {
        type: "needs_auth",
        text: formatInvalidDiscordBotAuthMessage({
          statusCode: authData.status_code,
          errorBody: authData.error_body,
          authConfigId: discordToolkit.connection.authConfig?.id,
          connectedAccountId: discordToolkit.connection.connectedAccount?.id,
          isComposioManaged:
            discordToolkit.connection.authConfig?.isComposioManaged,
        }),
      };
    }

    return { type: "ready" };
  }

  return {
    type: "needs_auth",
    text: formatAuthRequiredMessage(),
  };
}

async function executeDiscordBotTool(
  toolSlug: string,
  args: Record<string, unknown>
): Promise<ComposioExecutionData> {
  const session = await getSession();
  const result = await session.execute(toolSlug, args);

  if (result.error) {
    throw new Error(`Composio ${toolSlug} failed: ${result.error}`);
  }

  return result.data;
}

function extractArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }

  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const candidates = [
      record.data,
      record.items,
      record.messages,
      record.channels,
      record.guilds,
      record.result,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate as T[];
      }
    }

    if (record.data && typeof record.data === "object") {
      return extractArray<T>(record.data);
    }
  }

  return [];
}

function extractObject<T extends Record<string, unknown>>(data: unknown): T | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;

  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as T;
  }

  return record as T;
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

function normalizeChannelName(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase();
}

async function listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
  const data = await executeDiscordBotTool("DISCORDBOT_LIST_GUILD_CHANNELS", {
    guild_id: guildId,
  });

  return extractArray<DiscordChannel>(data);
}

async function resolveChannelId({
  channelId,
  channelName,
  guildId,
}: {
  channelId?: string;
  channelName?: string;
  guildId?: string;
}): Promise<string | null> {
  if (channelId) {
    return channelId;
  }

  if (!channelName) {
    return null;
  }

  const guildIds = guildId ? [guildId] : configuredGuildIds;

  if (guildIds.length === 0) {
    return null;
  }

  const targetName = normalizeChannelName(channelName);

  for (const currentGuildId of guildIds) {
    const channels = await listGuildChannels(currentGuildId);
    const match = channels.find(
      (channel) =>
        channel.name &&
        isTextLikeChannel(channel) &&
        normalizeChannelName(channel.name) === targetName
    );

    if (match) {
      return match.id;
    }
  }

  return null;
}

const server = new McpServer({
  name: "voiceos-discord",
  version: "1.0.0",
});

/**
 * ## Composio DISCORDBOT Architecture
 *
 * This local MCP server keeps VoiceOS's stdio launch-command model, but delegates
 * Discord auth and tool execution to Composio's DISCORDBOT toolkit. Production
 * VoiceOS should inject its internal logged-in user ID as the Composio user_id;
 * local testing uses VOICEOS_USER_ID.
 *
 * NOTE: Composio DISCORDBOT supports bot-accessible channel messaging,
 * message reads, replies, guild channel listing, and bot-created DMs.
 * It does not grant broad access to a user's existing personal DMs.
 * Group DM operations require user OAuth2 access tokens with gdm.join and
 * remain constrained by Discord API limitations.
 */

server.tool(
  "connect_discord_bot",
  "Create a Composio Connect Link for authenticating the Discord bot/account connection. Use this whenever the user asks to connect Discord, or whenever another Discord tool reports that authentication is required.",
  {},
  async () => {
    const redirectUrl = await createDiscordConnectLink();
    const openedBrowser = openUrlInBrowser(redirectUrl);
    return textResponse(formatConnectLinkMessage(redirectUrl, openedBrowser));
  }
);

server.tool(
  "list_discord_servers",
  "Explain how to list Discord servers/guilds for this Composio DISCORDBOT integration. DISCORDBOT channel discovery requires a guild/server ID; if authentication is missing, this returns a Composio Connect Link.",
  {},
  async () => {
    const connection = await ensureDiscordBotConnection();

    if (connection.type === "needs_auth") {
      return textResponse(connection.text);
    }

    if (configuredGuildIds.length > 0) {
      const guilds = await Promise.all(
        configuredGuildIds.map(async (guildId) => {
          const data = await executeDiscordBotTool("DISCORDBOT_GET_GUILD", {
            guild_id: guildId,
            with_counts: false,
          });
          return extractObject<DiscordGuild>(data) ?? { id: guildId, name: "Unknown" };
        })
      );

      return textResponse(guilds.map(formatGuild).join("\n\n---\n\n"));
    }

    return textResponse(
      [
        "The Composio DISCORDBOT toolkit can list channels for a known Discord server/guild ID, but it does not expose a general bot guild-list tool in the current mapped MCP implementation.",
        "",
        "Set DISCORD_GUILD_IDS in the MCP .env file or provide a guild ID when asking to list channels.",
      ].join("\n")
    );
  }
);

server.tool(
  "list_discord_channels",
  "List Discord channels that the Composio DISCORDBOT connection can discover. Provide a server/guild ID when known. If authentication is missing, return a Composio Connect Link. Use this when the user asks what Discord channels or chats are available.",
  {
    guild_id: z
      .string()
      .optional()
      .describe("Optional Discord server/guild ID. If omitted, uses DISCORD_GUILD_IDS from the MCP environment."),
    text_only: z
      .boolean()
      .default(true)
      .describe("Only return text-like channels that can be used for reading or sending messages. Defaults to true."),
  },
  async ({ guild_id, text_only = true }) => {
    const connection = await ensureDiscordBotConnection();

    if (connection.type === "needs_auth") {
      return textResponse(connection.text);
    }

    let guildIds = guild_id ? [guild_id] : configuredGuildIds;

    if (guildIds.length === 0) {
      return textResponse(
        "Please provide a Discord guild/server ID, or set DISCORD_GUILD_IDS in the MCP .env file so I know which server's channels to list.",
        true
      );
    }

    const sections = await Promise.all(
      guildIds.map(async (currentGuildId) => {
        const data = await executeDiscordBotTool("DISCORDBOT_LIST_GUILD_CHANNELS", {
          guild_id: currentGuildId,
        });
        const channels = extractArray<DiscordChannel>(data);

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

    return textResponse(
      `${sections.join("\n\n---\n\n")}\n\nNote: Discord channel-level permissions can still block reading or sending even when a channel is listed.`
    );
  }
);

server.tool(
  "read_discord_messages",
  "Read recent messages from a specific Discord channel by channel ID. Use this when the user asks what is happening in a Discord channel or wants context from recent Discord messages. This is a read-only action.",
  {
    channel_id: z
      .string()
      .min(1)
      .optional()
      .describe("Discord channel ID to read messages from. If omitted, provide channel_name and a configured or explicit guild_id."),
    channel_name: z
      .string()
      .optional()
      .describe("Discord channel name, such as general. Used when channel_id is not provided."),
    guild_id: z
      .string()
      .optional()
      .describe("Optional Discord server/guild ID used to resolve channel_name. If omitted, uses DISCORD_GUILD_IDS from the MCP environment."),
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
    channel_name,
    guild_id,
    limit = DEFAULT_MESSAGE_LIMIT,
    before,
    after,
    around,
    author_filter,
  }) => {
    const connection = await ensureDiscordBotConnection();

    if (connection.type === "needs_auth") {
      return textResponse(connection.text);
    }

    const resolvedChannelId = await resolveChannelId({
      channelId: channel_id,
      channelName: channel_name,
      guildId: guild_id,
    });

    if (!resolvedChannelId) {
      return textResponse(
        "I need either a Discord channel ID, or a channel name with DISCORD_GUILD_IDS configured in the MCP .env file. For example, set DISCORD_GUILD_IDS to your server ID so I can resolve #general automatically.",
        true
      );
    }

    const args: Record<string, unknown> = {
      channel_id: resolvedChannelId,
      limit: clampMessageLimit(limit),
    };

    if (before) {
      args.before = before;
    }

    if (after) {
      args.after = after;
    }

    if (around) {
      args.around = around;
    }

    const data = await executeDiscordBotTool("DISCORDBOT_LIST_MESSAGES", args);
    const messages = extractArray<DiscordMessage>(data);

    const filteredMessages = messages.filter((message) =>
      messageMatchesAuthorFilter(message, author_filter)
    );

    const text =
      filteredMessages.length > 0
        ? filteredMessages.map(formatMessageForAgent).join("\n\n---\n\n")
        : `No Discord messages found in channel ${resolvedChannelId}${
            author_filter ? ` matching author filter "${author_filter}"` : ""
          }.`;

    return textResponse(text);
  }
);

server.tool(
  "send_discord_message",
  "Send a new message to a specific Discord channel by channel ID. This is a write action and should be shown to the user as a VoiceOS confirmation pill before execution. Confirm the channel ID and exact message content with the user before calling this tool.",
  {
    channel_id: z
      .string()
      .min(1)
      .optional()
      .describe("Discord channel ID where the message will be sent. If omitted, provide channel_name and a configured or explicit guild_id."),
    channel_name: z
      .string()
      .optional()
      .describe("Discord channel name, such as general. Used when channel_id is not provided."),
    guild_id: z
      .string()
      .optional()
      .describe("Optional Discord server/guild ID used to resolve channel_name. If omitted, uses DISCORD_GUILD_IDS from the MCP environment."),
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
  async ({
    channel_id,
    channel_name,
    guild_id,
    content,
    tts = false,
    allowed_mentions = "none",
  }) => {
    const connection = await ensureDiscordBotConnection();

    if (connection.type === "needs_auth") {
      return textResponse(connection.text);
    }

    const resolvedChannelId = await resolveChannelId({
      channelId: channel_id,
      channelName: channel_name,
      guildId: guild_id,
    });

    if (!resolvedChannelId) {
      return textResponse(
        "I need either a Discord channel ID, or a channel name with DISCORD_GUILD_IDS configured in the MCP .env file before I can send the message.",
        true
      );
    }

    const data = await executeDiscordBotTool("DISCORDBOT_CREATE_MESSAGE", {
      channel_id: resolvedChannelId,
      content,
      tts,
      allowed_mentions: allowedMentionsForPolicy(allowed_mentions),
    });
    const message = extractObject<DiscordMessage>(data);

    return textResponse(
      message
        ? `Sent Discord message ${message.id} to channel ${message.channel_id} at ${message.timestamp}:\n${message.content}`
        : `Sent Discord message to channel ${resolvedChannelId}.\n\n${stringifyData(data)}`
    );
  }
);

server.tool(
  "reply_discord_message",
  "Reply to a specific Discord message ID in a channel. This is a write action and should be shown to the user as a VoiceOS confirmation pill before execution. Confirm the channel ID, message ID, and exact reply content with the user before calling this tool.",
  {
    channel_id: z
      .string()
      .min(1)
      .optional()
      .describe("Discord channel ID containing the message being replied to. If omitted, provide channel_name and a configured or explicit guild_id."),
    channel_name: z
      .string()
      .optional()
      .describe("Discord channel name, such as general. Used when channel_id is not provided."),
    guild_id: z
      .string()
      .optional()
      .describe("Optional Discord server/guild ID used to resolve channel_name. If omitted, uses DISCORD_GUILD_IDS from the MCP environment."),
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
  async ({
    channel_id,
    channel_name,
    guild_id,
    message_id,
    content,
    allowed_mentions = "none",
  }) => {
    const connection = await ensureDiscordBotConnection();

    if (connection.type === "needs_auth") {
      return textResponse(connection.text);
    }

    const resolvedChannelId = await resolveChannelId({
      channelId: channel_id,
      channelName: channel_name,
      guildId: guild_id,
    });

    if (!resolvedChannelId) {
      return textResponse(
        "I need either a Discord channel ID, or a channel name with DISCORD_GUILD_IDS configured in the MCP .env file before I can reply.",
        true
      );
    }

    const data = await executeDiscordBotTool("DISCORDBOT_CREATE_MESSAGE", {
      channel_id: resolvedChannelId,
      content,
      message_reference: {
        message_id,
        channel_id: resolvedChannelId,
        fail_if_not_exists: true,
      },
      allowed_mentions: allowedMentionsForPolicy(allowed_mentions),
    });
    const message = extractObject<DiscordMessage>(data);

    return textResponse(
      message
        ? `Sent Discord reply ${message.id} to message ${message_id} in channel ${message.channel_id} at ${message.timestamp}:\n${message.content}`
        : `Sent Discord reply to message ${message_id} in channel ${resolvedChannelId}.\n\n${stringifyData(data)}`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
