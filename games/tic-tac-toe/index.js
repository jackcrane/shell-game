import {
  color,
  getTerminalSize,
  getVisibleWidth,
  parseInputTokens,
  renderCentered,
} from "../../lib/session-ui.js";

export const metadata = {
  description: "Play tic-tac-toe against an unbeatable computer opponent.",
};

const PLAYER_MARK = "X";
const COMPUTER_MARK = "O";
const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const MOVE_PRIORITY = [4, 0, 2, 6, 8, 1, 3, 5, 7];
const MIN_COLS = 72;
const MIN_ROWS = 18;
const CELL_WIDTH = 5;
const PANEL_GAP = "    ";
const X_ART = [" \\ / ", "  X  ", " / \\ "];
const O_ART = [" ╭─╮ ", " │ │ ", " ╰─╯ "];

const createBoard = () => Array(9).fill("");

const moveSelection = (index, rowDelta, colDelta) => {
  const row = Math.floor(index / 3);
  const col = index % 3;
  const nextRow = (row + rowDelta + 3) % 3;
  const nextCol = (col + colDelta + 3) % 3;
  return nextRow * 3 + nextCol;
};

const getResult = (board) => {
  for (const line of WIN_LINES) {
    const [first, second, third] = line;
    const mark = board[first];

    if (mark && mark === board[second] && mark === board[third]) {
      return { winner: mark, winningLine: line };
    }
  }

  if (board.every(Boolean)) {
    return { winner: "draw", winningLine: [] };
  }

  return null;
};

const getAvailableMoves = (board) =>
  MOVE_PRIORITY.filter((index) => board[index] === "");

const scoreResult = (result, depth) => {
  if (result.winner === COMPUTER_MARK) {
    return 10 - depth;
  }

  if (result.winner === PLAYER_MARK) {
    return depth - 10;
  }

  return 0;
};

const minimax = (board, currentMark, depth = 0) => {
  const result = getResult(board);

  if (result) {
    return scoreResult(result, depth);
  }

  const candidateScores = [];

  for (const index of getAvailableMoves(board)) {
    board[index] = currentMark;
    candidateScores.push(
      minimax(
        board,
        currentMark === COMPUTER_MARK ? PLAYER_MARK : COMPUTER_MARK,
        depth + 1,
      ),
    );
    board[index] = "";
  }

  if (currentMark === COMPUTER_MARK) {
    return Math.max(...candidateScores);
  }

  return Math.min(...candidateScores);
};

const chooseComputerMove = (board) => {
  let bestMove = null;
  let bestScore = -Infinity;

  for (const index of getAvailableMoves(board)) {
    board[index] = COMPUTER_MARK;
    const score = minimax(board, PLAYER_MARK, 1);
    board[index] = "";

    if (score > bestScore) {
      bestScore = score;
      bestMove = index;
    }
  }

  return bestMove;
};

const createRoundState = () => ({
  board: createBoard(),
  gameOver: false,
  selection: 0,
  status: "Your move. You are X.",
  winningLine: [],
  winner: null,
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

const getEmptyArt = (index) => [" ".repeat(CELL_WIDTH), `  ${index + 1}  `, " ".repeat(CELL_WIDTH)];

const styleArt = (art, code) => art.map((line) => color(line, code));

const formatCell = ({ board, selection, winningLine }, index) => {
  const selected = index === selection;
  const winning = winningLine.includes(index);
  const mark = board[index];
  const art = mark === PLAYER_MARK ? X_ART : mark === COMPUTER_MARK ? O_ART : getEmptyArt(index);

  if (selected && mark === PLAYER_MARK) {
    return styleArt(art, "1;36;47");
  }

  if (selected && mark === COMPUTER_MARK) {
    return styleArt(art, "1;35;47");
  }

  if (selected) {
    return styleArt(art, "1;30;47");
  }

  if (winning) {
    return styleArt(art, "1;32");
  }

  if (mark === PLAYER_MARK) {
    return styleArt(art, "1;36");
  }

  if (mark === COMPUTER_MARK) {
    return styleArt(art, "1;35");
  }

  return styleArt(art, "2;37");
};

const renderBoard = (roundState) => {
  const rows = ["+-----+-----+-----+"];

  for (let row = 0; row < 3; row += 1) {
    const start = row * 3;

    const cellArts = [
      formatCell(roundState, start),
      formatCell(roundState, start + 1),
      formatCell(roundState, start + 2),
    ];

    for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
      rows.push(
        `|${cellArts[0][lineIndex]}|${cellArts[1][lineIndex]}|${cellArts[2][lineIndex]}|`,
      );
    }

    rows.push("+-----+-----+-----+");
  }

  return rows;
};

const finalizeRound = (roundState, score) => {
  const result = getResult(roundState.board);

  if (!result) {
    roundState.status = "Your move. You are X.";
    return false;
  }

  roundState.gameOver = true;
  roundState.winner = result.winner;
  roundState.winningLine = result.winningLine;

  if (result.winner === PLAYER_MARK) {
    score.player += 1;
    roundState.status = "You win. Press r for a rematch.";
    return true;
  }

  if (result.winner === COMPUTER_MARK) {
    score.computer += 1;
    roundState.status = "Computer wins. Press r for a rematch.";
    return true;
  }

  score.draws += 1;
  roundState.status = "Draw. Press r for a rematch.";
  return true;
};

export const createGameSession = ({ closeConnection, stream, termSize: initialTermSize }) => {
  let termSize = initialTermSize;
  let roundState = createRoundState();
  let score = { player: 0, computer: 0, draws: 0 };

  const resetRound = (status = "Your move. You are X.") => {
    roundState = createRoundState();
    roundState.status = status;
  };

  const resetScore = () => {
    score = { player: 0, computer: 0, draws: 0 };
    resetRound("Score cleared. Your move.");
  };

  const render = () => {
    const { cols, rows } = getTerminalSize(termSize);

    if (cols < MIN_COLS || rows < MIN_ROWS) {
      renderCentered(stream, termSize, [
        "Terminal window is too small.",
        `Need at least ${MIN_COLS} columns x ${MIN_ROWS} rows.`,
        `Current size: ${cols} x ${rows}.`,
        "",
        "Resize the window to keep playing.",
      ]);
      return;
    }

    const boardLines = renderBoard(roundState);
    const infoLines = [
      roundState.status,
      "",
      `You: ${score.player}`,
      `Computer: ${score.computer}`,
      `Draws: ${score.draws}`,
      "",
      "Move: arrows or h/j/k/l",
      "Play: Enter, space, or 1-9",
      "Rematch: r",
      "Clear score: c",
      "Quit: q",
    ];
    const lines = joinColumns(boardLines, infoLines);

    renderCentered(stream, termSize, lines);
  };

  const playAt = (index) => {
    roundState.selection = index;

    if (roundState.gameOver) {
      roundState.status = "Round finished. Press r for a rematch.";
      render();
      return;
    }

    if (roundState.board[index]) {
      roundState.status = "That square is already taken.";
      render();
      return;
    }

    roundState.board[index] = PLAYER_MARK;

    if (finalizeRound(roundState, score)) {
      render();
      return;
    }

    const computerMove = chooseComputerMove(roundState.board);

    if (computerMove !== null) {
      roundState.board[computerMove] = COMPUTER_MARK;
      roundState.selection = computerMove;
    }

    finalizeRound(roundState, score);
    render();
  };

  return {
    start() {
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
          case "ESC[A":
          case "k":
            roundState.selection = moveSelection(roundState.selection, -1, 0);
            break;
          case "ESC[B":
          case "j":
            roundState.selection = moveSelection(roundState.selection, 1, 0);
            break;
          case "ESC[C":
          case "l":
            roundState.selection = moveSelection(roundState.selection, 0, 1);
            break;
          case "ESC[D":
          case "h":
            roundState.selection = moveSelection(roundState.selection, 0, -1);
            break;
          case "\r":
          case "\n":
          case " ":
            playAt(roundState.selection);
            return;
          case "r":
            resetRound();
            break;
          case "c":
            resetScore();
            break;
          default:
            if (/^[1-9]$/.test(token)) {
              playAt(Number(token) - 1);
              return;
            }
            break;
        }
      }

      render();
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
    onClose() {},
  };
};
