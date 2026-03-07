import {
  color,
  getTerminalSize,
  getVisibleWidth,
  parseInputTokens,
  renderCentered,
} from "../../lib/session-ui.js";

export const metadata = {
  description: "Arcade-style Flappy Bird over SSH.",
};

const MIN_COLS = 72;
const MIN_ROWS = 22;
const FRAME_MS = 80;
const PIPE_WIDTH = 4;
const PIPE_GAP_HEIGHT = 5;
const PIPE_SPAWN_DELAY = 14;
const PIPE_SPAWN_INTERVAL = 18;
const MIN_PIPE_SPAWN_INTERVAL = 12;
const BIRD_X = 10;
const GRAVITY = 0.38;
const FLAP_VELOCITY = -1.45;
const MAX_FALL_SPEED = 1.85;
const PANEL_GAP = "    ";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const createRoundState = () => ({
  birdVelocity: 0,
  birdY: 6,
  mode: "ready",
  pipes: [],
  score: 0,
  tick: 0,
});

const padVisibleEnd = (text, targetWidth) => {
  const visibleWidth = getVisibleWidth(text);
  return `${text}${" ".repeat(Math.max(0, targetWidth - visibleWidth))}`;
};

const joinColumns = (leftLines, rightLines, gap = PANEL_GAP) => {
  const leftWidth = leftLines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const lineCount = Math.max(leftLines.length, rightLines.length);
  const lines = [];

  for (let index = 0; index < lineCount; index += 1) {
    const leftLine = leftLines[index] ?? "";
    const rightLine = rightLines[index] ?? "";
    lines.push(`${padVisibleEnd(leftLine, leftWidth)}${gap}${rightLine}`);
  }

  return lines;
};

const getLayout = (termSize) => {
  const { cols, rows } = getTerminalSize(termSize);

  return {
    cols,
    rows,
    fieldHeight: clamp(rows - 8, 12, 18),
    fieldWidth: clamp(cols - 30, 30, 46),
  };
};

const hasEnoughRoom = (termSize) => {
  const { cols, rows } = getTerminalSize(termSize);
  return cols >= MIN_COLS && rows >= MIN_ROWS;
};

const getBirdRow = (roundState) => Math.round(roundState.birdY);

const createPipe = (fieldWidth, fieldHeight) => {
  const flightRows = fieldHeight - 1;
  const gapStartMin = 1;
  const gapStartMax = Math.max(
    gapStartMin,
    flightRows - PIPE_GAP_HEIGHT - gapStartMin,
  );
  const gapStart =
    gapStartMin + Math.floor(Math.random() * (gapStartMax - gapStartMin + 1));

  return {
    gapStart,
    passed: false,
    x: fieldWidth + 1,
  };
};

const getPipeSpawnInterval = (score) =>
  clamp(
    PIPE_SPAWN_INTERVAL - Math.floor(score / 4),
    MIN_PIPE_SPAWN_INTERVAL,
    PIPE_SPAWN_INTERVAL,
  );

const buildFieldRows = (roundState, layout) => {
  const { fieldHeight, fieldWidth } = layout;
  const floorRow = fieldHeight - 1;
  const birdRow = getBirdRow(roundState);
  const border = color(`+${"-".repeat(fieldWidth)}+`, "38;5;245");
  const rows = [border];

  for (let row = 0; row < fieldHeight; row += 1) {
    let content = "";

    for (let col = 0; col < fieldWidth; col += 1) {
      let cell = " ";

      if (row === floorRow) {
        cell = color("=", "1;33");
      } else {
        const cloudShift = Math.floor(roundState.tick / 4);
        const cloud =
          row > 1 &&
          row < floorRow - 2 &&
          ((col + cloudShift) % 19 === 0 || (col + cloudShift + row) % 23 === 0);

        if (cloud) {
          cell = color(".", "2;37");
        }
      }

      for (const pipe of roundState.pipes) {
        const withinPipe = col >= pipe.x && col < pipe.x + PIPE_WIDTH;
        const withinGap =
          row >= pipe.gapStart && row < pipe.gapStart + PIPE_GAP_HEIGHT;

        if (withinPipe && !withinGap && row !== floorRow) {
          cell = color("#", "1;32");
          break;
        }
      }

      if (col === BIRD_X && row === birdRow) {
        cell =
          roundState.mode === "game-over"
            ? color("@", "1;31")
            : color("@", "1;33");
      }

      content += cell;
    }

    rows.push(`${color("|", "38;5;245")}${content}${color("|", "38;5;245")}`);
  }

  rows.push(border);
  return rows;
};

const buildPanelLines = ({ highScore, roundState }) => {
  const statusLine =
    roundState.mode === "ready"
      ? "Press space, Enter, or w to launch."
      : roundState.mode === "playing"
        ? "Tap to stay between the pipes."
        : "Crash. Press r, space, or Enter.";

  const detailLine =
    roundState.mode === "ready"
      ? "q quits the session."
      : roundState.mode === "playing"
        ? "Pipes speed up as the score climbs."
        : `Best run this session: ${highScore}.`;

  return [
    color("Flappy Bird", "1;36"),
    "",
    `Score: ${roundState.score}`,
    `Best: ${highScore}`,
    "",
    statusLine,
    detailLine,
    "",
    "Controls",
    "Flap: space, Enter, w, or up",
    "Restart: r",
    "Quit: q or Ctrl+C",
    "",
    roundState.mode === "ready"
      ? "Fly through the gaps."
      : roundState.mode === "playing"
        ? "One point per cleared pipe."
        : `Final score: ${roundState.score}`,
  ];
};

const buildRenderLines = ({ highScore, layout, roundState }) => {
  const fieldRows = buildFieldRows(roundState, layout);
  const panelLines = buildPanelLines({ highScore, roundState });
  return joinColumns(fieldRows, panelLines);
};

const pipeHitsBird = (pipe, birdRow) => {
  const withinPipe = BIRD_X >= pipe.x && BIRD_X < pipe.x + PIPE_WIDTH;
  const withinGap =
    birdRow >= pipe.gapStart && birdRow < pipe.gapStart + PIPE_GAP_HEIGHT;

  return withinPipe && !withinGap;
};

export const createGameSession = ({
  closeConnection,
  stream,
  termSize: initialTermSize,
}) => {
  let termSize = initialTermSize;
  let highScore = 0;
  let roundState = createRoundState();
  let frameTimer = null;

  const stopLoop = () => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  };

  const resetRound = (mode = "ready") => {
    const layout = getLayout(termSize);
    roundState = createRoundState();
    roundState.mode = mode;
    roundState.birdY = Math.floor((layout.fieldHeight - 1) / 2);
    roundState.tick = 0;
  };

  const render = () => {
    const { cols, rows } = getTerminalSize(termSize);

    if (!hasEnoughRoom(termSize)) {
      renderCentered(stream, termSize, [
        "Terminal window is too small.",
        `Need at least ${MIN_COLS} columns x ${MIN_ROWS} rows.`,
        `Current size: ${cols} x ${rows}.`,
        "",
        "Resize the window to keep playing.",
      ]);
      return;
    }

    const layout = getLayout(termSize);
    renderCentered(stream, termSize, buildRenderLines({
      highScore,
      layout,
      roundState,
    }));
  };

  const endRound = () => {
    roundState.mode = "game-over";
    highScore = Math.max(highScore, roundState.score);
    stopLoop();
    render();
  };

  const flap = () => {
    if (roundState.mode === "ready" || roundState.mode === "game-over") {
      resetRound("playing");
      roundState.birdVelocity = FLAP_VELOCITY;
      ensureLoop();
      render();
      return;
    }

    if (roundState.mode === "playing") {
      roundState.birdVelocity = FLAP_VELOCITY;
      render();
    }
  };

  const tick = () => {
    if (roundState.mode !== "playing") {
      return;
    }

    if (!hasEnoughRoom(termSize)) {
      render();
      return;
    }

    const layout = getLayout(termSize);
    const floorRow = layout.fieldHeight - 1;

    roundState.tick += 1;
    roundState.birdVelocity = Math.min(
      MAX_FALL_SPEED,
      roundState.birdVelocity + GRAVITY,
    );
    roundState.birdY += roundState.birdVelocity;

    roundState.pipes = roundState.pipes
      .map((pipe) => ({ ...pipe, x: pipe.x - 1 }))
      .filter((pipe) => pipe.x + PIPE_WIDTH > 0);

    if (roundState.tick >= PIPE_SPAWN_DELAY) {
      const interval = getPipeSpawnInterval(roundState.score);
      const shouldSpawn =
        (roundState.tick - PIPE_SPAWN_DELAY) % interval === 0 &&
        (roundState.pipes.length === 0 ||
          roundState.pipes[roundState.pipes.length - 1].x <
            layout.fieldWidth - PIPE_WIDTH - 6);

      if (shouldSpawn) {
        roundState.pipes.push(createPipe(layout.fieldWidth, layout.fieldHeight));
      }
    }

    for (const pipe of roundState.pipes) {
      if (!pipe.passed && pipe.x + PIPE_WIDTH - 1 < BIRD_X) {
        pipe.passed = true;
        roundState.score += 1;
      }
    }

    const birdRow = getBirdRow(roundState);
    const hitFloor = birdRow >= floorRow;
    const hitCeiling = birdRow < 0;
    const hitPipe = roundState.pipes.some((pipe) => pipeHitsBird(pipe, birdRow));

    if (hitFloor || hitCeiling || hitPipe) {
      endRound();
      return;
    }

    render();
  };

  const ensureLoop = () => {
    if (!frameTimer) {
      frameTimer = setInterval(tick, FRAME_MS);
    }
  };

  return {
    start() {
      resetRound("ready");
      ensureLoop();
      render();
    },
    onData(data) {
      const input = data.toString("utf8");

      for (const token of parseInputTokens(input)) {
        switch (token) {
          case "\u0003":
          case "q":
            closeConnection(0);
            return;
          case "r":
            resetRound("ready");
            render();
            return;
          case "\r":
          case "\n":
          case " ":
          case "w":
          case "k":
          case "ESC[A":
            flap();
            return;
          default:
            break;
        }
      }
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
    onClose() {
      stopLoop();
    },
  };
};
