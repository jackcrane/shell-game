import { color, renderCentered } from "../../lib/session-ui.js";

export const metadata = {
  description: "Placeholder game used to validate SSH routing.",
};

export const createGameSession = ({
  command,
  closeConnection,
  gameName,
  gamePath,
  metadata,
  stream,
  termSize: initialTermSize,
}) => {
  let termSize = initialTermSize;

  const render = () => {
    const lines = [
      color("Placeholder Game", "1;36"),
      "",
      `Game folder: ${gameName}`,
      `Path: ${gamePath}`,
      `Description: ${metadata.description}`,
      command ? `Exec command: ${command}` : "Mode: interactive shell",
      "",
      "This is only a placeholder.",
      "Add a real game in its own folder under ./games.",
      "",
      "Press q, Enter, or Ctrl+C to disconnect.",
    ];

    renderCentered(stream, termSize, lines);
  };

  return {
    start() {
      render();
    },
    onData(data) {
      const input = data.toString("utf8");

      if (input === "\u0003" || input === "q" || input === "\r" || input === "\n") {
        closeConnection(0);
      }
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
    onClose() {},
  };
};
