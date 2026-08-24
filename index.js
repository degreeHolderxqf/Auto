const { main } = require("./src/cli");
const { startServer } = require("./src/server");

const args = process.argv.slice(2);

// If CLI command is passed (e.g. "node index.js leads", "node index.js send"), run CLI
if (args.length > 0) {
  main();
} else {
  // If run without arguments (e.g. on Render or cloud host), start the HTTP server
  startServer(process.env.PORT || 3000);
}
