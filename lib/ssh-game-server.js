import fs from "fs";
import path from "path";
import ssh2 from "ssh2";
import { discoverGameNames, loadGameModule } from "./game-registry.js";
import {
  clearScreen,
  color,
  enterScreen,
  leaveScreen,
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

const createMissingGameSession = ({
  client,
  closeConnection,
  stream,
  termSize,
}) => {
  const requestedGame = client.username || "unknown";
  const availableGames = discoverGameNames();
  let closed = false;

  const render = () => {
    const lines = [
      color("Game not found", "1;31"),
      "",
      `Requested game: ${requestedGame}`,
      "",
      availableGames.length > 0
        ? `Available games: ${availableGames.join(", ")}`
        : "No games are installed yet.",
      "",
      "Disconnecting...",
    ];

    renderCentered(stream, termSize, lines);
  };

  return {
    start() {
      render();
      setTimeout(() => {
        if (!closed && !stream.destroyed) {
          closeConnection(1);
        }
      }, 1200);
    },
    onData(data) {
      const input = data.toString("utf8");
      if (input === "\u0003" || input === "q") {
        closeConnection(1);
      }
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
    onClose() {
      closed = true;
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
    return createMissingGameSession({
      client,
      closeConnection,
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
