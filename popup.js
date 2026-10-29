if (data.success) {
    console.log(`Found ${username} in Place: ${data.placeId}, Job: ${data.jobId}`);
    
    // This deep-link forces the Roblox app to open directly into the server
    window.location.href = `roblox://placeId=${data.placeId}&gameInstanceId=${data.jobId}`;
} else {
    alert(data.message || data.error);
}
