document.getElementById("findBtn").addEventListener("click", async () => {
    const username = document.getElementById("usernameInput").value;
    
    // Replace with your actual Vercel URL
    const vercelUrl = `https://your-vercel-app.vercel.app/api/find?username=${username}`;
    
    try {
        const response = await fetch(vercelUrl);
        const data = await response.json();
        
        if (data.success) {
            console.log(`Found ${username} in Place: ${data.placeId}, Job: ${data.jobId}`);
            
            // This triggers the Roblox client to open and join that exact server
            if (typeof window.Roblox !== "undefined" && window.Roblox.GameLauncher) {
                window.Roblox.GameLauncher.joinGameInstance(data.placeId, data.jobId);
            } else {
                alert("Please run this on the Roblox website so the GameLauncher can trigger!");
            }
        } else {
            alert(data.message || data.error);
        }
    } catch (err) {
        console.error("Scan failed", err);
    }
});
