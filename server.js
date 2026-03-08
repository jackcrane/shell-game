import "./games/crossword/index.js";
import { startServer } from "./lib/ssh-game-server.js";

startServer().catch((error) => {
  console.error("Failed to start SSH game server:", error);
  process.exitCode = 1;
});
