const express = require("express");
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");
const { createBareServer } = require("@tomphttp/bare-server-node");

const app = express();
const bare = createBareServer("/bare/");

// Serve UV static client files
app.use(express.static(uvPath));

// Handle everything else with Bare
app.use((req, res) => {
  bare.routeRequest(req, res);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Ultraviolet running on port ${PORT}`);
});
