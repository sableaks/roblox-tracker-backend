// Streams NDJSON events (one JSON object per line) so the page can show live progress.
// Each request scans for ~45s, then returns a "continue" event with a resume point;
// the page automatically calls again, so Vercel's function timeout never kills a search.

const PLACES = [
    { id: "109983668079237", label: "Main game" },        // [💀] Steal a Brainrot
    { id: "78906538690694",  label: "Sub-place 1" },
    { id: "119594317142884", label: "Sub-place 2" },
    { id: "128855408206367", label: "Sub-place 3" }
];

const TIME_BUDGET_MS = 45000;   // must stay below maxDuration in vercel.json (60s)
const CONCURRENCY = 3;          // parallel thumbnail batch requests
const BATCH_SIZE = 100;         // max tokens per thumbnails batch request

// Optional env vars (Vercel -> Settings -> Environment Variables):
//   ROBLOX_DOMAIN  - host to use instead of roblox.com (e.g. a proxy domain). Default: roblox.com
//   ROBLOX_COOKIE  - .ROBLOSECURITY of a THROWAWAY account; logged-in requests are rate-limited far less
const ROBLOX_DOMAIN = (process.env.ROBLOX_DOMAIN || "roblox.com").trim();
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || "").trim();
const rb = (url) => url.replace(/^https:\/\/([a-z]+)\.roblox\.com/, `https://$1.${ROBLOX_DOMAIN}`);

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const started = Date.now();
    const deadline = started + TIME_BUDGET_MS;

    const username = String(req.query.username || req.body?.username || "").trim();
    const startPlaceIdx = Math.max(0, Number(req.query.placeIdx) || 0);
    const startCursor = String(req.query.cursor || "");
    const knownEstimate = req.query.est ? Number(req.query.est) : null;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
    const finish = (obj) => { send(obj); res.end(); };

    if (!username) return finish({ type: "error", error: "Username required" });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chunk = (arr, size) => {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    };

    const fetchJson = async (url, options = {}, retries = 3) => {
        let status = 0, retryAfter = 0;
        const headers = { ...(options.headers || {}) };
        if (ROBLOX_COOKIE) headers["Cookie"] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const r = await fetch(rb(url), { ...options, headers });
                status = r.status;
                if (r.status === 429 || r.status >= 500) {
                    retryAfter = Number(r.headers.get("retry-after")) || 0;
                    if (attempt < retries) await sleep(Math.min(Math.max(retryAfter * 1000, 700 * (attempt + 1)), 5000));
                    continue;
                }
                let body = null;
                try { body = await r.json(); } catch (_) {}
                return { ok: r.ok, status: r.status, body, retryAfter: 0 };
            } catch (e) {
                if (attempt < retries) await sleep(700 * (attempt + 1));
            }
        }
        return { ok: false, status: status || 429, body: null, retryAfter };
    };

    try {
        // 1) username -> userId
        const userRes = await fetchJson("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        if (!userRes.body?.data?.length) {
            return finish({ type: "error", error: "Roblox user not found (or Roblox rate-limited us, status " + userRes.status + ")" });
        }
        const userId = userRes.body.data[0].id;

        // 2) target avatar headshot
        const thumbRes = await fetchJson(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );
        const targetImageUrl = thumbRes.body?.data?.[0]?.imageUrl;
        if (!targetImageUrl) {
            return finish({ type: "error", error: "Could not fetch target avatar (status " + thumbRes.status + ")" });
        }

        // 3) rough number of players online in the whole game (all 4 places share one universe)
        let estimate = knownEstimate;
        if (!estimate) {
            try {
                const u = await fetchJson(`https://apis.roblox.com/universes/v1/places/${PLACES[0].id}/universe`, {}, 1);
                const universeId = u.body?.universeId;
                if (universeId) {
                    const g = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`, {}, 1);
                    estimate = g.body?.data?.[0]?.playing || null;
                }
            } catch (_) {}
        }

        send({ type: "start", userId, estimate, places: PLACES.map((p) => p.label), resumed: startPlaceIdx > 0 || !!startCursor });

        const counts = { servers: 0, players: 0, pages: 0 };
        const placeErrors = [];
        let next = { placeIdx: startPlaceIdx, cursor: startCursor };

        const progress = (placeIdx, extra = {}) =>
            send({
                type: "progress",
                placeIdx,
                placeCount: PLACES.length,
                placeLabel: PLACES[placeIdx].label,
                placeId: PLACES[placeIdx].id,
                counts: { ...counts },
                next: { ...next },
                ...extra
            });

        for (let pi = startPlaceIdx; pi < PLACES.length; pi++) {
            const place = PLACES[pi];
            let cursor = pi === startPlaceIdx ? startCursor : "";
            next = { placeIdx: pi, cursor };
            progress(pi);

            while (true) {
                if (Date.now() > deadline) {
                    return finish({ type: "continue", next: { placeIdx: pi, cursor }, counts });
                }

                const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
                const pageUrl = `https://games.roblox.com/v1/games/${place.id}/servers/Public?sortOrder=Desc&limit=100${cursorParam}`;

                let serverRes;
                for (let attempt = 0; ; attempt++) {
                    serverRes = await fetchJson(pageUrl, {}, 0);
                    if (serverRes.body?.data) break;
                    if (serverRes.status === 429 || serverRes.status >= 500) {
                        const wait = Math.min(Math.max(serverRes.retryAfter * 1000, 2000 * (attempt + 1)), 10000);
                        if (Date.now() + wait > deadline) {
                            return finish({ type: "continue", next: { placeIdx: pi, cursor }, counts, rateLimited: true });
                        }
                        send({ type: "warn", message: `Roblox is rate-limiting us (HTTP ${serverRes.status}). Waiting ${Math.round(wait / 1000)}s and retrying…` });
                        await sleep(wait);
                        continue;
                    }
                    break; // some other error (403/404…)
                }

                if (!serverRes.body?.data) {
                    placeErrors.push({ placeId: place.id, status: serverRes.status });
                    send({ type: "warn", message: `${place.label}: Roblox returned HTTP ${serverRes.status}, skipping this place` });
                    break;
                }

                const servers = serverRes.body.data.filter((s) => s.playerTokens && s.playerTokens.length > 0);

                // Flatten every player token on this page, remember which server it belongs to
                const tokenToServer = new Map();
                for (const s of servers) for (const t of s.playerTokens) tokenToServer.set(t, s.id);
                const batches = chunk([...tokenToServer.keys()], BATCH_SIZE);

                let pageInterrupted = false;
                for (const group of chunk(batches, CONCURRENCY)) {
                    if (Date.now() > deadline + 5000) { pageInterrupted = true; break; }

                    const results = await Promise.all(group.map(async (tokens) => {
                        const payload = tokens.map((token) => ({
                            requestId: token, type: "AvatarHeadShot", token,
                            size: "150x150", format: "Png", isCircular: false
                        }));
                        for (let attempt = 0; attempt < 3; attempt++) {
                            const r = await fetchJson("https://thumbnails.roblox.com/v1/batch", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(payload)
                            }, 0);
                            if (r.body?.data) {
                                for (const p of r.body.data) {
                                    if (p.imageUrl === targetImageUrl) return { found: tokenToServer.get(p.requestId) || null, checked: tokens.length, failed: 0 };
                                }
                                return { found: null, checked: tokens.length, failed: 0 };
                            }
                            if (Date.now() > deadline) break;
                            await sleep(Math.min(Math.max(r.retryAfter * 1000, 1500 * (attempt + 1)), 6000));
                        }
                        return { found: null, checked: 0, failed: tokens.length };
                    }));

                    counts.players += results.reduce((n, r) => n + r.checked, 0);
                    const failedNow = results.reduce((n, r) => n + r.failed, 0);
                    if (failedNow) {
                        counts.failed = (counts.failed || 0) + failedNow;
                        send({ type: "warn", message: `${counts.failed} players could not be checked (Roblox rate limit) – they may be skipped` });
                    }

                    const jobId = results.map((r) => r.found).find((id) => id);
                    if (jobId) {
                        return finish({ type: "found", username, placeId: place.id, placeLabel: place.label, jobId, counts });
                    }
                    progress(pi);
                }

                if (pageInterrupted) {
                    return finish({ type: "continue", next: { placeIdx: pi, cursor }, counts });
                }

                counts.servers += servers.length;
                counts.pages += 1;

                cursor = serverRes.body.nextPageCursor || null;
                next = cursor ? { placeIdx: pi, cursor } : { placeIdx: pi + 1, cursor: "" };
                progress(pi);

                if (!cursor) break;
                await sleep(250);
            }
        }

        return finish({
            type: "notfound",
            message: "Player not found. They might be offline, in a private server, or joined after the scan passed their server.",
            placeErrors,
            counts
        });
    } catch (error) {
        return finish({ type: "error", error: "Server logic error: " + error.message });
    }
}
