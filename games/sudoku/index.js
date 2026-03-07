import { getSudoku } from "sudoku-gen";
import { color, renderCentered } from "../../lib/session-ui.js";

const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const MIN_COLS = 58;
const MIN_ROWS = 22;

const createCell = (value) => (value === "-" ? "" : value);

const toBoard = (sequence) => sequence.split("").map(createCell);

const formatPosition = (index) => {
  const row = Math.floor(index / 9) + 1;
  const col = (index % 9) + 1;
  return `r${row}c${col}`;
};

const getCandidates = (board, index) => {
  if (board[index]) {
    return [];
  }

  const row = Math.floor(index / 9);
  const col = index % 9;
  const used = new Set();

  for (let step = 0; step < 9; step += 1) {
    used.add(board[row * 9 + step]);
    used.add(board[step * 9 + col]);
  }

  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;

  for (let rowOffset = 0; rowOffset < 3; rowOffset += 1) {
    for (let colOffset = 0; colOffset < 3; colOffset += 1) {
      used.add(board[(boxRow + rowOffset) * 9 + boxCol + colOffset]);
    }
  }

  return ["1", "2", "3", "4", "5", "6", "7", "8", "9"].filter(
    (digit) => !used.has(digit),
  );
};

const buildConflicts = (board, lockedCells) => {
  const conflicts = new Set();
  const groups = [];

  for (let row = 0; row < 9; row += 1) {
    groups.push(Array.from({ length: 9 }, (_, col) => row * 9 + col));
  }

  for (let col = 0; col < 9; col += 1) {
    groups.push(Array.from({ length: 9 }, (_, row) => row * 9 + col));
  }

  for (let boxRow = 0; boxRow < 3; boxRow += 1) {
    for (let boxCol = 0; boxCol < 3; boxCol += 1) {
      const indices = [];

      for (let rowOffset = 0; rowOffset < 3; rowOffset += 1) {
        for (let colOffset = 0; colOffset < 3; colOffset += 1) {
          indices.push((boxRow * 3 + rowOffset) * 9 + boxCol * 3 + colOffset);
        }
      }

      groups.push(indices);
    }
  }

  for (const group of groups) {
    const seen = new Map();

    for (const index of group) {
      const value = board[index];

      if (!value) {
        continue;
      }

      const matches = seen.get(value) ?? [];
      matches.push(index);
      seen.set(value, matches);
    }

    for (const indices of seen.values()) {
      if (indices.length < 2) {
        continue;
      }

      for (const index of indices) {
        if (!lockedCells[index]) {
          conflicts.add(index);
        }
      }
    }
  }

  return conflicts;
};

const moveSelection = (index, rowDelta, colDelta) => {
  const row = Math.floor(index / 9);
  const col = index % 9;
  const nextRow = (row + rowDelta + 9) % 9;
  const nextCol = (col + colDelta + 9) % 9;
  return nextRow * 9 + nextCol;
};

const parseTokens = (chunk) => {
  const tokens = [];

  for (let index = 0; index < chunk.length; index += 1) {
    const character = chunk[index];

    if (character !== "\u001b") {
      tokens.push(character);
      continue;
    }

    if (chunk[index + 1] === "[") {
      const third = chunk[index + 2];

      if (["A", "B", "C", "D", "H", "F"].includes(third)) {
        tokens.push(`ESC[${third}`);
        index += 2;
        continue;
      }

      if (third === "3" && chunk[index + 3] === "~") {
        tokens.push("ESC[3~");
        index += 3;
        continue;
      }
    }

    tokens.push(character);
  }

  return tokens;
};

const cycleDifficulty = (difficulty) => {
  const currentIndex = DIFFICULTIES.indexOf(difficulty);
  return DIFFICULTIES[(currentIndex + 1) % DIFFICULTIES.length];
};

const createPuzzleState = (difficulty) => {
  const puzzle = getSudoku(difficulty);
  const initialBoard = toBoard(puzzle.puzzle);

  return {
    board: [...initialBoard],
    difficulty: puzzle.difficulty,
    initialBoard,
    lockedCells: initialBoard.map(Boolean),
    solution: puzzle.solution.split(""),
  };
};

const getCompletionCount = (board) => board.filter(Boolean).length;

const buildBoardLines = ({ board, conflicts, cursor, lockedCells }) => {
  const lines = ["    1 2 3   4 5 6   7 8 9", "  +-------+-------+-------+"];

  for (let row = 0; row < 9; row += 1) {
    const cells = [];

    for (let col = 0; col < 9; col += 1) {
      const index = row * 9 + col;
      const isCursor = index === cursor;
      const rawValue = board[index] || ".";
      let text = rawValue;

      if (isCursor && lockedCells[index]) {
        text = color(rawValue, "1;30;46");
      } else if (isCursor && conflicts.has(index)) {
        text = color(rawValue, "1;37;41");
      } else if (isCursor && board[index]) {
        text = color(rawValue, "1;30;47");
      } else if (isCursor) {
        text = color(rawValue, "2;30;47");
      } else if (lockedCells[index]) {
        text = color(rawValue, "1;36");
      } else if (conflicts.has(index)) {
        text = color(rawValue, "1;31");
      } else if (board[index]) {
        text = color(rawValue, "1;37");
      } else {
        text = color(rawValue, "2;37");
      }

      cells.push(text);
    }

    const rowLabel = String.fromCharCode(65 + row);
    lines.push(
      `${rowLabel} | ${cells.slice(0, 3).join(" ")} | ${cells.slice(3, 6).join(" ")} | ${cells.slice(6, 9).join(" ")} |`,
    );

    if ((row + 1) % 3 === 0) {
      lines.push("  +-------+-------+-------+");
    }
  }

  return lines;
};

export const metadata = {
  description: "Interactive Sudoku served over SSH.",
};

export const createGameSession = ({
  closeConnection,
  stream,
  termSize: initialTermSize,
}) => {
  let termSize = initialTermSize;
  let cursor = 0;
  let lastMessage = "Use arrows or hjkl to move. Type 1-9 to fill a square.";
  let puzzleState = createPuzzleState("medium");

  const resetPuzzle = (difficulty = puzzleState.difficulty) => {
    puzzleState = createPuzzleState(difficulty);
    cursor = 0;
  };

  const render = () => {
    if ((termSize?.cols ?? 0) < MIN_COLS || (termSize?.rows ?? 0) < MIN_ROWS) {
      renderCentered(stream, termSize, [
        color("Terminal too small", "1;31"),
        "",
        `Need at least ${MIN_COLS}x${MIN_ROWS}`,
        `Current size: ${termSize?.cols ?? 0}x${termSize?.rows ?? 0}`,
        "",
        "Resize the terminal to continue.",
      ]);
      return;
    }

    const { board, difficulty, lockedCells, solution } = puzzleState;
    const conflicts = buildConflicts(board, lockedCells);
    const isSolved = board.every((value, index) => value === solution[index]);
    const completionCount = getCompletionCount(board);
    const candidates = getCandidates(board, cursor);

    const lines = [
      color("Sudoku", "1;33"),
      "",
      `Difficulty: ${difficulty}   Filled: ${completionCount}/81   Conflicts: ${conflicts.size}`,
      `Selected: ${formatPosition(cursor)}   Candidates: ${candidates.join(" ") || "-"}`,
      "",
      ...buildBoardLines({ board, conflicts, cursor, lockedCells }),
      "",
      isSolved
        ? color("Solved. Press n for a new puzzle, d to change difficulty, or q to quit.", "1;32")
        : lastMessage,
      "Controls: arrows/hjkl move, 1-9 fill, 0/. or Backspace clear, r reset, n new, d difficulty, q quit",
    ];

    renderCentered(stream, termSize, lines);
  };

  const updateMessage = (message) => {
    lastMessage = message;
  };

  const writeDigit = (digit) => {
    if (puzzleState.lockedCells[cursor]) {
      updateMessage("Clue cells are fixed.");
      return;
    }

    puzzleState.board[cursor] = digit;

    if (puzzleState.board.every((value, index) => value === puzzleState.solution[index])) {
      updateMessage("Puzzle solved.");
    } else {
      updateMessage(`Placed ${digit} at ${formatPosition(cursor)}.`);
    }
  };

  const clearDigit = () => {
    if (puzzleState.lockedCells[cursor]) {
      updateMessage("Clue cells are fixed.");
      return;
    }

    if (!puzzleState.board[cursor]) {
      updateMessage(`Cell ${formatPosition(cursor)} is already empty.`);
      return;
    }

    puzzleState.board[cursor] = "";
    updateMessage(`Cleared ${formatPosition(cursor)}.`);
  };

  const handleToken = (token) => {
    switch (token) {
      case "\u0003":
      case "q":
        closeConnection(0);
        return;
      case "ESC[A":
      case "k":
        cursor = moveSelection(cursor, -1, 0);
        updateMessage(`Moved to ${formatPosition(cursor)}.`);
        break;
      case "ESC[B":
      case "j":
        cursor = moveSelection(cursor, 1, 0);
        updateMessage(`Moved to ${formatPosition(cursor)}.`);
        break;
      case "ESC[C":
      case "l":
        cursor = moveSelection(cursor, 0, 1);
        updateMessage(`Moved to ${formatPosition(cursor)}.`);
        break;
      case "ESC[D":
      case "h":
        cursor = moveSelection(cursor, 0, -1);
        updateMessage(`Moved to ${formatPosition(cursor)}.`);
        break;
      case "r":
        puzzleState.board = [...puzzleState.initialBoard];
        updateMessage("Puzzle reset.");
        break;
      case "n":
        resetPuzzle(puzzleState.difficulty);
        updateMessage(`New ${puzzleState.difficulty} puzzle ready.`);
        break;
      case "D":
        resetPuzzle(cycleDifficulty(puzzleState.difficulty));
        updateMessage(`Difficulty changed to ${puzzleState.difficulty}.`);
        break;
      case ".":
      case "0":
      case " ":
      case "\u007f":
      case "ESC[3~":
        clearDigit();
        break;
      default:
        if (/^[1-9]$/.test(token)) {
          writeDigit(token);
        }
        break;
    }

    render();
  };

  return {
    start() {
      updateMessage("Use arrows or hjkl to move. Press d to cycle difficulty.");
      render();
    },
    onData(data) {
      const input = data.toString("utf8");

      for (const token of parseTokens(input)) {
        handleToken(token);
      }
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
    onClose() {},
  };
};
