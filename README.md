# google-mcp

Gmail + Google Calendar MCP server for Claude. Works with **any Google account** — no gcloud CLI, no npm install, no external dependencies. Just Node.js (>= 18) and a Google Cloud OAuth client.

Uses OAuth2 refresh tokens stored in a local file, so it works in sandboxed desktop apps too. **Supports multiple accounts simultaneously.**

## Requirements

- **Node.js >= 18** — the only dependency. Everything uses Node's built-in stdlib (`https`, `readline`, `fs`). No `npm install` needed.
- **A Google Cloud project with OAuth credentials** — the setup below walks you through creating one (~5 minutes).

No gcloud CLI. No Google SDK. No `node_modules`.

---

## How it works

All accounts live in one local token file (`~/.config/google-mcp/tokens.json`), keyed by email. You run `setup.js` once per account you want to add. At call time:

- If you have **one account**, the plugin auto-selects it. No config needed.
- If you have **multiple accounts**, pass `account: "email@domain.com"` on each call, or set `GOOGLE_ACCOUNT` env var to choose a default.

Nothing in the plugin files has your identity baked in. Install once, add as many accounts as you like.

---

## Setup (one-time, ~5 minutes)

### Step 1: Create a Google Cloud project and OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or reuse an existing one). Name it something like "google-mcp".

2. **Enable the APIs** you need. At minimum:
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) — click **Enable**
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) — click **Enable**

3. **Configure the OAuth consent screen:**
   - Go to [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   - Choose **External** (unless you have a Google Workspace org and want Internal)
   - Fill in the required fields: app name (e.g. "google-mcp"), user support email (your email), developer contact email (your email). The rest can be left blank.
   - On the **Scopes** page, click **Add or Remove Scopes** and add:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
   - On the **Test users** page, click **Add Users** and enter the Google email address(es) you want to connect. While the app is in "Testing" status, only these accounts can authorize. You can add more later.
   - Click **Save and Continue** through to the summary, then **Back to Dashboard**.

4. **Create OAuth credentials:**
   - Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
   - Click **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name it "google-mcp" (or anything you'll recognize)
   - Click **Create**
   - Click **Download JSON** — this saves a `client_secret_*.json` file to your Downloads folder

> Each person using this plugin creates their own OAuth app and credentials. Google doesn't allow sharing client secrets across users.

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
