export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const username = req.query.username || req.body?.username;
    if (!username) return res.status(400).json({ error: "Username required" });

    // Ensure these are Place IDs, not Universe IDs
// Scan the Main Game first, then the sub-places
const PLACE_IDS = [
    "109983668079237", 
    "78906538690694", 
    "119594317142884", 
    "128855408206367"
];

    const chunkArray = (array, size) => {
        const chunked = [];
        for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size));
        return chunked;
    };

    try {
        const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        const userData = await userRes.json();
        
        if (!userData.data || userData.data.length === 0) {
            return res.status(404).json({ error: "Roblox user not found", robloxData: userData });
        }
        const userId = userData.data[0].id;

        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
        const thumbData = await thumbRes.json();
        const targetImageUrl = thumbData.data[0]?.imageUrl;

        if (!targetImageUrl) {
             return res.status(400).json({ error: "Could not fetch target avatar", robloxData: thumbData });
        }

        for (const placeId of PLACE_IDS) {
            let cursor = "";
            let pageAttempts = 0; 

            while (cursor !== null && pageAttempts < 10) {
                pageAttempts++;
                const serverRes = await fetch(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&cursor=${cursor}`);
                const serverData = await serverRes.json();

                // THE FIX: Instead of breaking silently, show exactly what Roblox returned
                if (!serverData.data) {
                    return res.status(400).json({ 
                        error: `Roblox rejected the server request for Place ID: ${placeId}. Ensure this is a valid Place ID, not a Universe ID.`, 
                        robloxResponse: serverData 
                    });
                }

                const serverChecks = serverData.data.map(async (server) => {
                    if (!server.playerTokens || server.playerTokens.length === 0) return null;
                    const tokenBatches = chunkArray(server.playerTokens, 20);
                    
                    for (const batch of tokenBatches) {
                        const tokensParam = batch.join(",");
                        const tokenThumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?format=Png&isCircular=false&size=150x150&playerTokens=${tokensParam}`);
                        const tokenThumbData = await tokenThumbRes.json();

                        if (tokenThumbData && tokenThumbData.data) {
                            for (const player of tokenThumbData.data) {
                                if (player.imageUrl === targetImageUrl) return server.id; 
                            }
                        }
                    }
                    return null;
                });

                const results = await Promise.all(serverChecks);
                const foundJobId = results.find(id => id !== null);

                if (foundJobId) {
                    return res.status(200).json({ success: true, username: username, placeId: placeId, jobId: foundJobId });
                }

                cursor = serverData.nextPageCursor;
            }
        }

        return res.status(404).json({ success: false, message: "Player not found. They might be offline or in a private server." });

    } catch (error) {
        return res.status(500).json({ error: "Server logic error", details: error.message });
    }
}
