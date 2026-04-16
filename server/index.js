#!/usr/bin/env node
/**
 * google-mcp — Gmail + Google Calendar MCP server
 *
 * Uses OAuth2 refresh tokens stored in a local config file.
 * No gcloud required. Works for any Google account.
 * Supports multiple accounts simultaneously.
 *
 * Setup: node setup.js
 * Config file: ~/.config/google-mcp/tokens.json  (override with GOOGLE_MCP_CONFIG env var)
 *
 * Token file format:
 * {
 *   "accounts": {
 *     "you@example.com": {
 *       "client_id": "...",
 *       "client_secret": "...",
 *       "refresh_token": "..."
 *     }
 *   }
 * }
 */

import { createInterface } from "readline";
import { request as httpsRequest } from "https";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH =
  process.env.GOOGLE_MCP_CONFIG ||
  join(homedir(), ".config", "google-mcp", "tokens.json");

const DEFAULT_ACCOUNT = process.env.GOOGLE_ACCOUNT || "";

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(
      `Cannot read token config at ${CONFIG_PATH}.\n` +
      `Run the setup wizard first: node setup.js\n` +
      `(original error: ${e.message})`
    );
  }
}

// ── Token cache (in-memory, per account) ────────────────────────────────────

const tokenCache = {}; // { email: { access_token, expires_at } }

async function getAccessToken(account) {
  let email = account || DEFAULT_ACCOUNT;

  // If no account specified, auto-select when exactly one is configured.
  if (!email) {
    const config = loadConfig();
    const emails = Object.keys(config.accounts || {});
    if (emails.length === 1) {
      email = emails[0];
    } else if (emails.length === 0) {
      throw new Error(
        `No accounts configured in ${CONFIG_PATH}. Run the setup wizard: node setup.js`
      );
    } else {
      throw new Error(
        `Multiple accounts configured (${emails.join(", ")}). ` +
        `Pass \`account\` in the tool call or set GOOGLE_ACCOUNT env var.`
      );
    }
  }

  const now = Date.now();
  const cached = tokenCache[email];
  if (cached && cached.expires_at > now + 60_000) {
    return cached.access_token;
  }

  const config = loadConfig();
  const acct = config.accounts?.[email];
  if (!acct) {
    throw new Error(
      `No credentials found for ${email} in ${CONFIG_PATH}.\n` +
      `Run the setup wizard: node setup.js`
    );
  }

  const { client_id, client_secret, refresh_token } = acct;
  const token = await refreshAccessToken(client_id, client_secret, refresh_token);
  tokenCache[email] = { access_token: token.access_token, expires_at: now + token.expires_in * 1000 };
  return token.access_token;
}

function refreshAccessToken(client_id, client_secret, refresh_token) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }).toString();

    const req = httpsRequest(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Token refresh failed: ${parsed.error} — ${parsed.error_description}`));
          } else {
            resolve(parsed);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function handleApiResponse(res, data, resolve, reject) {
  let parsed;
  try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg =
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.raw ||
      `HTTP ${res.statusCode}`;
    return reject(new Error(`Google API ${res.statusCode}: ${msg}`));
  }
  if (parsed?.error) {
    return reject(new Error(
      `Google API error: ${parsed.error.message || JSON.stringify(parsed.error)}`
    ));
  }
  resolve(parsed);
}

function apiGet(token, host, path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { hostname: host, path, method: "GET", headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => handleApiResponse(res, data, resolve, reject));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function apiPost(token, host, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: host, path, method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => handleApiResponse(res, data, resolve, reject));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function gmailSearch({ q, maxResults = 20, account }) {
  const token = await getAccessToken(account);
  const params = new URLSearchParams({ q, maxResults });
  const list = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages?${params}`);
  if (!list.messages) return { messages: [], total: 0 };

  const messages = await Promise.all(
    list.messages.map(async ({ id }) => {
      const msg = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      const headers = {};
      (msg.payload?.headers || []).forEach(({ name, value }) => { headers[name] = value; });
      return {
        messageId: msg.id,
        threadId: msg.threadId,
        snippet: msg.snippet,
        headers,
        labelIds: msg.labelIds,
      };
    })
  );
  return { messages, total: list.resultSizeEstimate };
}

async function gmailRead({ messageId, account }) {
  const token = await getAccessToken(account);
  const msg = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages/${messageId}?format=full`);
  const headers = {};
  (msg.payload?.headers || []).forEach(({ name, value }) => { headers[name] = value; });

  function extractBody(payload) {
    if (!payload) return "";
    if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf8");
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf8");
        }
      }
      for (const part of payload.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    return "";
  }

  return { messageId: msg.id, threadId: msg.threadId, headers, snippet: msg.snippet, body: extractBody(msg.payload), labelIds: msg.labelIds };
}

async function gmailCreateDraft({ to, subject, body, account }) {
  const token = await getAccessToken(account);
  const email = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  const encoded = Buffer.from(email).toString("base64url");
  const result = await apiPost(token, "gmail.googleapis.com", "/gmail/v1/users/me/drafts", {
    message: { raw: encoded },
  });
  return { draftId: result.id, message: result.message };
}

async function calendarListEvents({ timeMin, timeMax, maxResults = 20, calendarId = "primary", account }) {
  const token = await getAccessToken(account);
  const params = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    maxResults,
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (timeMax) params.set("timeMax", timeMax);
  if (calendarId) params.set("calendarId", calendarId);
  return apiGet(token, "www.googleapis.com", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
}

async function calendarGetEvent({ eventId, calendarId = "primary", account }) {
  const token = await getAccessToken(account);
  return apiGet(token, "www.googleapis.com", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
}

// ── MCP protocol ─────────────────────────────────────────────────────────────

const ACCOUNT_PROP = {
  account: {
    type: "string",
    description: `Google account email (e.g. you@example.com). Overrides GOOGLE_ACCOUNT env var. Default: "${DEFAULT_ACCOUNT || "(none set)"}"`,
  },
};

const TOOLS = [
  {
    name: "gmail_search",
    description: "Search Gmail messages using standard Gmail search syntax",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Gmail search query (e.g. 'from:alice@example.com is:unread')" },
        maxResults: { type: "number", description: "Max results (default 20)" },
        ...ACCOUNT_PROP,
      },
      required: ["q"],
    },
  },
  {
    name: "gmail_read",
    description: "Read a full Gmail message by ID",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID" },
        ...ACCOUNT_PROP,
      },
      required: ["messageId"],
    },
  },
  {
    name: "gmail_create_draft",
    description: "Create a Gmail draft email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        ...ACCOUNT_PROP,
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_list_events",
    description: "List upcoming Google Calendar events",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Start time (ISO 8601). Default: now" },
        timeMax: { type: "string", description: "End time (ISO 8601)" },
        maxResults: { type: "number", description: "Max events (default 20)" },
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "calendar_get_event",
    description: "Get full details of a Google Calendar event",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Calendar event ID" },
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        ...ACCOUNT_PROP,
      },
      required: ["eventId"],
    },
  },
];

const HANDLERS = {
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  gmail_create_draft: gmailCreateDraft,
  calendar_list_events: calendarListEvents,
  calendar_get_event: calendarGetEvent,
};

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "google-mcp", version: "2.0.0" } } });
    return;
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const handler = HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    try {
      const result = await handler(args || {});
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
