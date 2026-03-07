import fs from "fs";
import path from "path";
import ssh2 from "ssh2";
import { discoverGameNames, loadGameModule } from "./game-registry.js";
import {
  clearScreen,
  color,
  enterScreen,
  leaveScreen,
  parseInputTokens,
  renderCentered,
  safeWrite,
} from "./session-ui.js";

const { Server } = ssh2;

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 22);
const HOST_KEY_PATH = path.resolve(
  process.cwd(),
  process.env.HOST_KEY_PATH ?? "host.key",
);
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "games.jackcrane.rocks";
const APP_BUILD_COMMIT =
  (process.env.APP_BUILD_COMMIT ?? "unknown").trim() || "unknown";

const ensureHostKey = () => {
  if (fs.existsSync(HOST_KEY_PATH)) {
    return fs.readFileSync(HOST_KEY_PATH);
  }

  throw new Error(
    `Missing SSH host key at ${HOST_KEY_PATH}. Generate one with:\nssh-keygen -t ed25519 -f host.key -N ""`,
  );
};

const getConnectExample = (gameName) => {
  if (PORT === 22) {
    return `ssh ${gameName}@${PUBLIC_HOST}`;
  }

  return `ssh -p ${PORT} ${gameName}@${PUBLIC_HOST}`;
};

const createLandingSession = ({
  client,
  closeConnection,
  command,
  stream,
  termSize,
}) => {
  const availableGames = discoverGameNames();
  const requestedGame = client.username?.trim() ?? "";
  let selectedIndex = 0;
  let activeSession = null;
  let currentTermSize = termSize;
  let isLaunching = false;
  let closed = false;
  let statusMessage =
    requestedGame && !availableGames.includes(requestedGame.toLowerCase())
      ? `No game matched "${requestedGame}".`
      : "Choose a game and press Enter.";

  const render = () => {
    if (activeSession) {
      return;
    }

    const options =
      availableGames.length > 0
        ? availableGames.map((gameName, index) => {
            const selected = index === selectedIndex;
            return selected
              ? color(`> ${gameName}`, "1;30;47")
              : `  ${gameName}`;
          })
        : ["No games are installed yet."];

    const lines = [
      color("Shell Game", "1;36"),
      "",
      statusMessage,
      "",
      ...(requestedGame ? [`Requested game: ${requestedGame}`, ""] : []),
      color("Available Games", "1;33"),
      ...options,
      "",
      availableGames.length > 0
        ? "Use arrows or j/k to choose. Press Enter to start."
        : "Add a game under ./games, then reconnect.",
      "Press q or Ctrl+C to disconnect.",
      "",
      color(`Build ${APP_BUILD_COMMIT}`, "30"),
    ];

    renderCentered(stream, currentTermSize, lines);
  };

  const launchSelectedGame = async () => {
    const gameName = availableGames[selectedIndex];

    if (!gameName || isLaunching || closed) {
      return;
    }

    isLaunching = true;
    statusMessage = `Launching ${gameName}...`;
    render();

    try {
      const game = await loadGameModule(gameName);

      if (!game) {
        throw new Error(`Game "${gameName}" is no longer available.`);
      }

      activeSession = game.createGameSession({
        client,
        closeConnection,
        command,
        gameName: game.gameName,
        gamePath: game.gamePath,
        metadata: game.metadata,
        stream,
        termSize: currentTermSize,
      });
      activeSession.start?.();
    } catch (error) {
      activeSession = null;
      isLaunching = false;
      statusMessage = String(error.message || error);
      render();
    }
  };

  const moveSelection = (delta) => {
    if (availableGames.length === 0) {
      return;
    }

    selectedIndex =
      (selectedIndex + delta + availableGames.length) % availableGames.length;
  };

  return {
    start() {
      render();
    },
    onData(data) {
      if (activeSession) {
        activeSession.onData?.(data);
        return;
      }

      const input = data.toString("utf8");

      for (const token of parseInputTokens(input)) {
        switch (token) {
          case "\u0003":
          case "q":
            closeConnection(0);
            return;
          case "ESC[A":
          case "k":
            moveSelection(-1);
            break;
          case "ESC[B":
          case "j":
            moveSelection(1);
            break;
          case "\r":
          case "\n":
          case " ":
            void launchSelectedGame();
            return;
          default:
            break;
        }
      }

      render();
    },
    onResize(nextTermSize) {
      currentTermSize = nextTermSize;

      if (activeSession) {
        activeSession.onResize?.(nextTermSize);
        return;
      }

      render();
    },
    onClose() {
      closed = true;
      activeSession?.onClose?.();
    },
  };
};

const createSessionRuntime = async ({
  client,
  closeConnection,
  command,
  stream,
  termSize,
}) => {
  const game = await loadGameModule(client.username || "");

  if (!game) {
    return createLandingSession({
      client,
      closeConnection,
      command,
      stream,
      termSize,
    });
  }

  return game.createGameSession({
    client,
    closeConnection,
    command,
    gameName: game.gameName,
    gamePath: game.gamePath,
    metadata: game.metadata,
    stream,
    termSize,
  });
};

const attachSessionHandlers = ({ client, session }) => {
  let termSize = { cols: 80, rows: 24 };
  let runtime = null;
  let streamRef = null;
  let cleanedUp = false;

  const cleanupStream = (stream) => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    runtime?.onClose?.();
    leaveScreen(stream);
  };

  const startRuntime = async (stream, command = null) => {
    streamRef = stream;

    enterScreen(stream);

    const closeConnection = (code = 0) => {
      if (stream.destroyed) {
        return;
      }

      cleanupStream(stream);
      stream.exit(code);
      stream.end();
    };

    try {
      runtime = await createSessionRuntime({
        client,
        closeConnection,
        command,
        stream,
        termSize,
      });
      runtime.start?.();
    } catch (error) {
      console.error(`Failed to start game "${client.username}":`, error);

      renderCentered(stream, termSize, [
        color("Unable to start game", "1;31"),
        "",
        String(error.message || error),
      ]);

      setTimeout(() => {
        if (!stream.destroyed) {
          closeConnection(1);
        }
      }, 1500);
    }

    stream.on("data", (data) => {
      runtime?.onData?.(data);
    });

    stream.on("close", () => {
      cleanupStream(stream);
      client.end();
    });

    stream.on("error", (error) => {
      console.error(`SSH stream error for "${client.username}":`, error);
      cleanupStream(stream);
    });
  };

  session.on("pty", (accept, reject, info) => {
    termSize = {
      cols: info?.cols ?? 80,
      rows: info?.rows ?? 24,
    };
    accept();
  });

  session.on("window-change", (accept, reject, info) => {
    termSize = {
      cols: info?.cols ?? termSize.cols ?? 80,
      rows: info?.rows ?? termSize.rows ?? 24,
    };

    runtime?.onResize?.(termSize);

    if (typeof accept === "function") {
      accept();
    }
  });

  session.on("shell", (accept) => {
    const stream = accept();
    void startRuntime(stream);
  });

  session.on("exec", (accept, reject, info) => {
    const stream = accept();
    void startRuntime(stream, info?.command ?? null);
  });

  session.on("error", (error) => {
    console.error("SSH session error:", error);
    runtime?.onClose?.();

    if (streamRef && !streamRef.destroyed) {
      clearScreen(streamRef);
      safeWrite(streamRef, "Session error.\r\n");
      cleanupStream(streamRef);
      streamRef.end();
    }
  });
};

export const createServer = async () => {
  const hostKey = ensureHostKey();
  const availableGames = discoverGameNames();

  if (availableGames.length === 0) {
    console.warn("No game folders found in ./games.");
  }

  const server = new Server(
    {
      hostKeys: [hostKey],
    },
    (client) => {
      client.username = null;

      client.on("authentication", (ctx) => {
        client.username = ctx.username;

        if (ctx.method === "none" || ctx.method === "publickey") {
          ctx.accept();
          return;
        }

        ctx.reject(["publickey", "none"]);
      });

      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          attachSessionHandlers({ client, session });
        });
      });

      client.on("error", (error) => {
        console.error("SSH client error:", error);
      });
    },
  );

  server.on("error", (error) => {
    console.error("SSH server error:", error);
  });

  return server;
};

export const startServer = async () => {
  const server = await createServer();

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      reject(error);
    };

    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(PORT, HOST);
  });

  console.log(`SSH game server listening on ${HOST}:${PORT}`);
  console.log(`Available games: ${discoverGameNames().join(", ") || "(none)"}`);
  console.log(`Example: ${getConnectExample("placeholder")}`);

  return server;
};
