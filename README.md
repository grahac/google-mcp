# google-mcp

Gmail + Google Calendar MCP server for Claude. Works with **any Google account** — no gcloud CLI required. Uses OAuth2 refresh tokens stored in a local file, so it works in sandboxed desktop apps too.

**Supports multiple accounts simultaneously.** Share this plugin with anyone.

---

## How it works

All accounts live in one local token file (`~/.config/google-mcp/tokens.json`), keyed by email. You run `setup.js` once per account you want to add. At call time:

- If you have **one account**, the plugin auto-selects it. No config needed.
- If you have **multiple accounts**, pass `account: "email@domain.com"` on each call, or set `GOOGLE_ACCOUNT` env var to choose a default.

Nothing in the plugin files has your identity baked in. Install once, add as many accounts as you like.

---

## Setup (one-time, ~5 minutes)

### Step 1: Create a Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/) — create a project or reuse one.
2. Enable [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) and [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. **Credentials → Create Credentials → OAuth client ID → Desktop app** (name it "google-mcp").
4. Download the `client_secrets.json`.

> One OAuth app works for unlimited accounts. You only do this step once, even when sharing with other people (each person creates their own OAuth app — Google doesn't let you share client secrets).

### Step 2: Authorize your first account

```bash
node setup.js --client-secrets ~/Downloads/client_secret_*.json
```

Opens Google's consent screen → log in → paste the code back. Saves a refresh token to `~/.config/google-mcp/tokens.json`.

### Step 3: Install the MCP server

Claude Code and Claude Desktop / Cowork have **separate** MCP configurations — installing in one does not make it available in the other. Pick the option(s) that match where you use Claude.

#### Claude Code (CLI / VS Code / JetBrains)

```bash
claude mcp add google-mcp \
  -e GOOGLE_MCP_CONFIG="$HOME/.config/google-mcp/tokens.json" \
  -- node /path/to/google-mcp/server/index.js
```

Or via the UI: **Settings > Developer > MCP Servers > Add**, then fill in:

- **Name:** `google-mcp`
- **Command:** `node /path/to/google-mcp/server/index.js`
- **Environment:** `GOOGLE_MCP_CONFIG` = `~/.config/google-mcp/tokens.json`

#### Claude Desktop / Cowork

Add this under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
"google-mcp": {
  "command": "/usr/local/bin/node",
  "args": ["/path/to/google-mcp/server/index.js"],
  "env": { "GOOGLE_MCP_CONFIG": "${HOME}/.config/google-mcp/tokens.json" }
}
```

Tip: use an absolute path for `command` — a bare `"node"` can silently break when the GUI-launch PATH diverges from your shell PATH.

All options auto-select your account when only one is configured.

---

## Adding more accounts

Just run `setup.js` again with each account you want to add:

```bash
node setup.js --client-secrets ~/Downloads/client_secret_*.json
# (log in as your second account this time)
```

Each account gets appended to `tokens.json` — nothing is overwritten.

Once you have multiple accounts, use them per call:

> "Search my personal Gmail at alice@gmail.com for unread messages"
> "Check the calendar for bob@company.com for tomorrow"

Or set a default by editing `.mcp.json`:

```json
"env": {
  "GOOGLE_ACCOUNT": "alice@gmail.com"
}
```

---

## Token file format

`~/.config/google-mcp/tokens.json`:

```json
{
  "accounts": {
    "alice@example.com": { "client_id": "...", "client_secret": "...", "refresh_token": "..." },
    "bob@domain.com":    { "client_id": "...", "client_secret": "...", "refresh_token": "..." }
  }
}
```

Override the path with the `GOOGLE_MCP_CONFIG` env var.

---

## Available tools

| Tool | Description |
|------|-------------|
| `gmail_search` | Search Gmail with standard query syntax |
| `gmail_read` | Read a full message by ID |
| `gmail_create_draft` | Create a draft email |
| `calendar_list_events` | List upcoming events |
| `calendar_get_event` | Get a specific event's details |

All tools accept an optional `account: "email@domain.com"` parameter.

---

## Troubleshooting

**"Multiple accounts configured"** — Pass `account:` in the call, or set `GOOGLE_ACCOUNT` in `.mcp.json`.

**"No accounts configured"** — Run `setup.js` at least once.

**"No credentials found for X"** — Run `setup.js` for that account.

**"Token refresh failed: invalid_grant"** — Refresh token expired or revoked. Run `setup.js` again for that account; the old token is overwritten.

**"No refresh token returned"** — You already authorized this app for this Google account. Go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), revoke it, and run `setup.js` again.
