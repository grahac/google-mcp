#!/usr/bin/env node
/**
 * google-mcp setup wizard
 *
 * One-time OAuth2 flow to get a refresh token for any Google account.
 * Saves credentials to ~/.config/google-mcp/tokens.json
 *
 * Usage:
 *   node setup.js
 *   node setup.js --config /path/to/custom/tokens.json
 *   node setup.js --client-secrets /path/to/client_secrets.json
 *
 * You can run this multiple times to add more accounts.
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { request as httpsRequest } from "https";
import { createInterface } from "readline";
import { execSync } from "child_process";

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const CONFIG_PATH =
  getArg("--config") ||
  process.env.GOOGLE_MCP_CONFIG ||
  join(homedir(), ".config", "google-mcp", "tokens.json");

const CLIENT_SECRETS_PATH = getArg("--client-secrets");

const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// ── Helpers ───────────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function loadTokens() {
  if (existsSync(CONFIG_PATH)) {
    try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  }
  return { accounts: {} };
}

function saveTokens(data) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf8");
  console.log(`\n✅ Saved to ${CONFIG_PATH}`);
}

function postJSON(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : new URLSearchParams(body).toString();
    const req = httpsRequest(
      {
        hostname, path, method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getJSON(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { hostname, path, method: "GET", headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open "${url}"`);
    else if (platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔑 google-mcp Setup Wizard");
  console.log("─────────────────────────────────────────\n");

  // Step 1: Get client credentials
  let client_id, client_secret;

  if (CLIENT_SECRETS_PATH) {
    const secrets = JSON.parse(readFileSync(CLIENT_SECRETS_PATH, "utf8"));
    const app = secrets.installed || secrets.web;
    client_id = app.client_id;
    client_secret = app.client_secret;
    console.log(`✅ Loaded client credentials from ${CLIENT_SECRETS_PATH}`);
  } else {
    console.log("You need a Google OAuth2 Client ID and Secret.");
    console.log("Create one at: https://console.cloud.google.com/apis/credentials");
    console.log("  1. Click 'Create Credentials' → 'OAuth client ID'");
    console.log("  2. Choose 'Desktop app'");
    console.log("  3. Enable Gmail API and Google Calendar API in your project");
    console.log("  4. Copy the Client ID and Secret below\n");

    client_id = await prompt("Client ID: ");
    client_secret = await prompt("Client Secret: ");
  }

  if (!client_id || !client_secret) {
    console.error("❌ Client ID and Secret are required.");
    process.exit(1);
  }

  // Step 2: Build auth URL
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",  // force refresh token even if previously granted
  });

  console.log("\n📋 Step 2: Authorize access");
  console.log("Opening your browser. If it doesn't open, paste this URL manually:\n");
  console.log(authUrl);
  console.log();

  const opened = openBrowser(authUrl);
  if (!opened) console.log("(Could not open browser automatically — please open the URL above.)");

  // Step 3: Local server to capture OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") return;

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end(`<h2>❌ Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      } else {
        res.end(`<h2>✅ Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>`);
        server.close();
        resolve(code);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`⏳ Waiting for authorization (listening on port ${REDIRECT_PORT})...`);
    });

    server.on("error", (e) => {
      console.error(`\n❌ Could not start local server on port ${REDIRECT_PORT}: ${e.message}`);
      console.error("Make sure nothing else is using that port and try again.");
      reject(e);
    });
  });

  console.log("✅ Authorization code received.\n");

  // Step 4: Exchange code for tokens
  const tokens = await postJSON("oauth2.googleapis.com", "/token", {
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  if (tokens.error) {
    console.error(`❌ Token exchange failed: ${tokens.error} — ${tokens.error_description}`);
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    console.error("❌ No refresh token returned. This usually means you've already authorized this app.");
    console.error("   Visit https://myaccount.google.com/permissions, revoke access for your app, and try again.");
    process.exit(1);
  }

  // Step 5: Get email address
  const userInfo = await getJSON("www.googleapis.com", "/oauth2/v2/userinfo", tokens.access_token);
  const email = userInfo.email;

  if (!email) {
    console.error("❌ Could not determine account email. Got:", JSON.stringify(userInfo));
    process.exit(1);
  }

  console.log(`✅ Authorized as: ${email}`);

  // Step 6: Save
  const config = loadTokens();
  config.accounts = config.accounts || {};
  config.accounts[email] = { client_id, client_secret, refresh_token: tokens.refresh_token };
  saveTokens(config);

  // Summary
  const accountCount = Object.keys(config.accounts).length;
  console.log(`\n🎉 Done! ${accountCount} account(s) configured:`);
  Object.keys(config.accounts).forEach((e) => console.log(`   • ${e}`));
  console.log(`\nTo add another account, run: node setup.js`);
  console.log(`To use in MCP config, set: GOOGLE_ACCOUNT=${email}`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
