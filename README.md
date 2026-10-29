# If you see HTTP 429 / "0 players, 0 servers"

Roblox rate-limits requests coming from Vercel's shared datacenter IPs. Try these, in order:

1. **Redeploy** with this version (it now uses the `fra1` region and waits/retries on 429 instead of giving up).
2. **ROBLOX_COOKIE** (best fix): Vercel -> Project -> Settings -> Environment Variables, add
   `ROBLOX_COOKIE` = the `.ROBLOSECURITY` value of a THROWAWAY Roblox account (never your main one,
   never share it or commit it to GitHub). Logged-in requests are limited far less. Redeploy.
3. **ROBLOX_DOMAIN**: if you know a working Roblox API proxy, set e.g. `ROBLOX_DOMAIN` = `yourproxy.example`
   (requests go to games.yourproxy.example, users.yourproxy.example, ...). Only use a proxy you trust.
