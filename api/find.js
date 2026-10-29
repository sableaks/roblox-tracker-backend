export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const username = req.query.username || req.body?.username;
    if (!username) return res.status(400).json({ error: "Username required" });

    const PLACE_IDS = [
        "109983668079237",
        "78906538690694",
        "119594317142884",
        "128855408206367"
    ];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const chunkArray = (array, size) => {
        const chunked = [];
        for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size));
        return chunked;
    };

    // Fetch JSON with retry/backoff on 429 and transient errors
    const fetchJson = async (url, options = {}, retries = 4) => {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const r = await fetch(url, options);
                if (r.status === 429 || r.status >= 500) {
                    const retryAfter = Number(r.headers.get("retry-after")) || 0;
                    await sleep(Math.max(retryAfter * 1000, 800 * (attempt + 1)));
                    continue;
                }
                let body = null;
                try { body = await r.json(); } catch (_) {}
                return { ok: r.ok, status: r.status, body };
            } catch (e) {
                await sleep(800 * (attempt + 1));
            }
        }
        return { ok: false, status: 429, body: null };
    };

    try {
        const userRes = await fetchJson("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        const userData = userRes.body;

        if (!userData?.data || userData.data.length === 0) {
            return res.status(404).json({ error: "Roblox user not found", robloxData: userData });
        }
        const userId = userData.data[0].id;

        const thumbRes = await fetchJson(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );
        const targetImageUrl = thumbRes.body?.data?.[0]?.imageUrl;

        if (!targetImageUrl) {
            return res.status(400).json({ error: "Could not fetch target avatar", robloxData: thumbRes.body });
        }

        const placeErrors = [];

        for (const placeId of PLACE_IDS) {
            let cursor = "";
            let pageAttempts = 0;

            while (cursor !== null && pageAttempts < 10) {
                pageAttempts++;
                const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
                const serverRes = await fetchJson(
                    `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100${cursorParam}`
                );
                const serverData = serverRes.body;

                // Don't abort everything: record the failure and move to the next place
                if (!serverData?.data) {
                    placeErrors.push({ placeId, status: serverRes.status, response: serverData });
                    break;
                }

                // Process servers in small groups to avoid rate limits
                const servers = serverData.data.filter(
                    (s) => s.playerTokens && s.playerTokens.length > 0
                );

                for (const group of chunkArray(servers, 5)) {
                    const results = await Promise.all(
                        group.map(async (server) => {
                            for (const batch of chunkArray(server.playerTokens, 50)) {
                                const batchPayload = batch.map((token) => ({
                                    requestId: token,
                                    type: "AvatarHeadShot",
                                    token: token,
                                    size: "150x150",
                                    format: "Png",
                                    isCircular: false
                                }));

                                const tokenRes = await fetchJson("https://thumbnails.roblox.com/v1/batch", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(batchPayload)
                                });

                                const players = tokenRes.body?.data;
                                if (players) {
                                    for (const player of players) {
                                        if (player.imageUrl === targetImageUrl) return server.id;
                                    }
                                }
                            }
                            return null;
                        })
                    );

                    const foundJobId = results.find((id) => id);
                    if (foundJobId) {
                        return res.status(200).json({
                            success: true,
                            username,
                            placeId,
                            jobId: foundJobId
                        });
                    }
                }

                cursor = serverData.nextPageCursor || null;
                await sleep(300);
            }
        }

        return res.status(404).json({
            success: false,
            message: "Player not found. They might be offline or in a private server.",
            placeErrors
        });

    } catch (error) {
        return res.status(500).json({ error: "Server logic error", details: error.message });
    }
}
