export default async function handler(req, res) {
    // Allows your browser extension to bypass CORS blocks
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const username = req.query.username || req.body?.username;
    if (!username) return res.status(400).json({ error: "Username required" });

    // The three Place IDs you provided
    const PLACE_IDS = ["78906538690694", "119594317142884", "128855408206367"];

    // Helper to prevent URL length limits when hitting the Thumbnail API
    const chunkArray = (array, size) => {
        const chunked = [];
        for (let i = 0; i < array.length; i += size) {
            chunked.push(array.slice(i, i + size));
        }
        return chunked;
    };

    try {
        // 1. Convert Username to UserId
        const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        const userData = await userRes.json();
        
        if (!userData.data || userData.data.length === 0) {
            return res.status(404).json({ error: "Roblox user not found" });
        }
        const userId = userData.data[0].id;

        // 2. Grab the Target's Avatar Headshot Image URL
        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
        const thumbData = await thumbRes.json();
        const targetImageUrl = thumbData.data[0]?.imageUrl;

        if (!targetImageUrl) {
             return res.status(400).json({ error: "Could not fetch target avatar image" });
        }

        // 3. Scan the Place IDs
        for (const placeId of PLACE_IDS) {
            let cursor = "";
            let pageAttempts = 0; 

            // Scan up to 10 pages of servers (1000 servers total per place) to avoid Vercel timeout
            while (cursor !== null && pageAttempts < 10) {
                pageAttempts++;
                const serverRes = await fetch(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
                const serverData = await serverRes.json();

                if (!serverData.data) break;

                // 4. Batch process server player tokens in parallel
                const serverChecks = serverData.data.map(async (server) => {
                    if (!server.playerTokens || server.playerTokens.length === 0) return null;

                    // Chunk tokens into batches of 20 to prevent 414 URI Too Long errors
                    const tokenBatches = chunkArray(server.playerTokens, 20);
                    
                    for (const batch of tokenBatches) {
                        const tokensParam = batch.join(",");
                        const tokenThumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?format=Png&isCircular=false&size=150x150&playerTokens=${tokensParam}`);
                        const tokenThumbData = await tokenThumbRes.json();

                        if (tokenThumbData && tokenThumbData.data) {
                            for (const player of tokenThumbData.data) {
                                // THE MATCH: If the server player's avatar perfectly matches the target's avatar
                                if (player.imageUrl === targetImageUrl) {
                                    return server.id; 
                                }
                            }
                        }
                    }
                    return null;
                });

                // Wait for all 100 servers on this page to finish matching
                const results = await Promise.all(serverChecks);
                const foundJobId = results.find(id => id !== null);

                if (foundJobId) {
                    return res.status(200).json({
                        success: true,
                        username: username,
                        placeId: placeId,
                        jobId: foundJobId
                    });
                }

                cursor = serverData.nextPageCursor;
            }
        }

        return res.status(404).json({ success: false, message: "Player not found in any of the specified places. They might be offline or in a private server." });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
