#!/usr/bin/env node
/**
 * One-time OAuth2 helper to get a Google Calendar refresh token.
 *
 * Usage:
 *   1. Create OAuth2 credentials in Google Cloud Console
 *      (Desktop app type, enable Calendar API)
 *   2. Set env vars:
 *        export GOOGLE_CLIENT_ID="your-client-id"
 *        export GOOGLE_CLIENT_SECRET="your-client-secret"
 *   3. Run:  node scripts/google-auth.js
 *   4. Open the URL in browser, authorize, paste the code back
 *   5. Copy the refresh_token and run:
 *        wrangler secret put GOOGLE_CALENDAR_REFRESH_TOKEN
 *        (paste the token when prompted)
 */

import http from "node:http";
import { URL } from "node:url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_PORT = 8099;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = "https://www.googleapis.com/auth/calendar";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log("\n📋 Open this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for callback...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error("Token exchange failed:", tokens);
      res.writeHead(500);
      res.end("Token exchange failed: " + tokens.error_description);
      process.exit(1);
    }

    console.log("✅ Success!\n");
    console.log("refresh_token:", tokens.refresh_token);
    console.log("\nNow run:");
    console.log('  wrangler secret put GOOGLE_CALENDAR_REFRESH_TOKEN');
    console.log("  (paste the refresh_token above when prompted)\n");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Done! Check your terminal for the refresh token.</h1>");

    server.close();
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500);
    res.end("Error: " + err.message);
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Listening on http://localhost:${REDIRECT_PORT}/callback`);
});
