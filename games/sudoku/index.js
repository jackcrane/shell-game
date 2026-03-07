import { getSudoku } from "sudoku-gen";
import {
  ansiStyle,
  color,
  getTerminalSize,
  getVisibleWidth,
  parseInputTokens,
  renderCentered,
} from "../../lib/session-ui.js";

const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const GAME_MIN_COLS = 90;
const GAME_MIN_ROWS = 37;
const MENU_MIN_COLS = 60;
const MENU_MIN_ROWS = 22;
const CELL_WIDTH = 6;
const THEMES = {
  light: {
    name: "Light",
    baseStyle: "38;5;232;48;2;255;255;255",
    title: "1;38;5;31",
    sectionTitle: "1;38;5;130",
    minorBorder: "38;5;246",
    majorBorder: "38;5;238",
    candidate: "38;5;130",
    digit: "38;5;232",
    lockedDigit: "38;5;25",
    selectedBackground: "48;5;252",
    conflict: "1;38;5;160",
    menuSelected: "1;38;5;232;48;5;252",
    modalFrame: "38;5;232;48;5;252",
    modalTitle: "1;38;5;232;48;5;252",
  },
  dark: {
    name: "Dark",
    baseStyle: "38;5;252;48;2;0;0;0",
    title: "1;38;5;117",
    sectionTitle: "1;38;5;221",
    minorBorder: "38;5;240",
    majorBorder: "38;5;250",
    candidate: "38;5;221",
    digit: "38;5;255",
    lockedDigit: "38;5;117",
    selectedBackground: "48;5;239",
    conflict: "1;38;5;203",
    menuSelected: "1;38;5;255;48;5;239",
    modalFrame: "38;5;255;48;5;239",
    modalTitle: "1;38;5;255;48;5;239",
  },
};
const THEME_ORDER = ["light", "dark"];
const MENU_TITLE = [
  "███████╗██╗   ██╗██████╗  ██████╗ ██╗  ██╗██╗   ██╗",
  "██╔════╝██║   ██║██╔══██╗██╔═══██╗██║ ██╔╝██║   ██║",
  "███████╗██║   ██║██║  ██║██║   ██║█████╔╝ ██║   ██║",
  "╚════██║██║   ██║██║  ██║██║   ██║██╔═██╗ ██║   ██║",
  "███████║╚██████╔╝██████╔╝╚██████╔╝██║  ██╗╚██████╔╝",
  "╚══════╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ",
  "",
  "",
  "",
];
const EMPTY_CELL_ART = ["      ", "      ", "      "];
const DIGIT_ART = {
  1: ["╺┓ ", " ┃ ", "╺┻╸"],
  2: ["┏━┓", "┏━┛", "┗━╸"],
  3: ["┏━┓", "╺━┫", "┗━┛"],
  4: ["╻ ╻", "┗━┫", "  ╹"],
  5: ["┏━╸", "┗━┓", "┗━┛"],
  6: ["┏━┓", "┣━┓", "┗━┛"],
  7: ["┏━┓", "  ┃", "  ╹"],
  8: ["┏━┓", "┣━┫", "┗━┛"],
  9: ["┏━┓", "┗━┫", "┗━┛"],
};
const centerArtLine = (line) => ` ${line}  `;

const CENTERED_DIGIT_ART = Object.fromEntries(
  Object.entries(DIGIT_ART).map(([digit, lines]) => [
    digit,
    lines.map(centerArtLine),
  ]),
);

const createPainter = (theme) => {
  const themeReset = ansiStyle(theme.baseStyle);
  return (text, code) => color(text, code, themeReset);
};

const colorBorder = (paint, theme, text, weight = "minor") =>
  paint(text, weight === "major" ? theme.majorBorder : theme.minorBorder);

const createCell = (value) => (value === "-" ? "" : value);

const toBoard = (sequence) => sequence.split("").map(createCell);

const getCandidatesForCell = (board, index) => {
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

const padVisibleEnd = (text, targetWidth) => {
  const visibleWidth = getVisibleWidth(text);
  return `${text}${" ".repeat(Math.max(0, targetWidth - visibleWidth))}`;
};

const joinColumns = (leftLines, rightLines, gap = "    ") => {
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

const buildHorizontalBorder = ({
  paint,
  theme,
  left,
  minor,
  major,
  right,
  fill,
  leftWeight = "major",
  minorWeight = "minor",
  majorWeight = "major",
  rightWeight = "major",
  fillWeight = "minor",
}) => {
  let line = colorBorder(paint, theme, left, leftWeight);

  for (let col = 0; col < 9; col += 1) {
    line += colorBorder(paint, theme, fill.repeat(CELL_WIDTH), fillWeight);

    if (col === 8) {
      line += colorBorder(paint, theme, right, rightWeight);
    } else if ((col + 1) % 3 === 0) {
      line += colorBorder(paint, theme, major, majorWeight);
    } else {
      line += colorBorder(paint, theme, minor, minorWeight);
    }
  }

  return line;
};

const isSolvedBoard = (board, solution) =>
  board.every((value, index) => value === solution[index]);

const getCellColorCode = ({
  conflicts,
  cursor,
  index,
  lockedCells,
  theme,
  value,
}) => {
  const selectedDigitColor = `${theme.digit};${theme.selectedBackground}`;
  const selectedConflictColor = `${theme.conflict};${theme.selectedBackground}`;

  if (index === cursor && conflicts.has(index)) {
    return selectedConflictColor;
  }

  if (index === cursor && value) {
    return selectedDigitColor;
  }

  if (index === cursor) {
    return selectedDigitColor;
  }

  if (conflicts.has(index)) {
    return theme.conflict;
  }

  if (lockedCells[index]) {
    return theme.lockedDigit;
  }

  if (value) {
    return theme.digit;
  }

  return theme.baseStyle;
};

const getCandidateColorCode = ({ cursor, index, theme }) => {
  if (index === cursor) {
    return `${theme.candidate};${theme.selectedBackground}`;
  }

  return theme.candidate;
};

const getRenderedCellLines = ({
  board,
  conflicts,
  cursor,
  index,
  lockedCells,
  paint,
  showCandidates,
  theme,
}) => {
  const value = board[index];
  const isCandidateCell = !value && showCandidates;
  const art = value
    ? CENTERED_DIGIT_ART[value]
    : isCandidateCell
      ? buildCandidateArt(getCandidatesForCell(board, index))
      : EMPTY_CELL_ART;
  const colorCode = isCandidateCell
    ? getCandidateColorCode({ cursor, index, theme })
    : getCellColorCode({
        conflicts,
        cursor,
        index,
        lockedCells,
        theme,
        value,
      });

  return art.map((line) => paint(line, colorCode));
};

const buildCandidateArt = (candidates) => {
  const values = Array.from({ length: 9 }, (_, index) => {
    const digit = String(index + 1);
    return candidates.includes(digit) ? digit : " ";
  });

  return [
    `${values[0]} ${values[1]} ${values[2]} `,
    `${values[3]} ${values[4]} ${values[5]} `,
    `${values[6]} ${values[7]} ${values[8]} `,
  ];
};

const buildBoardLines = ({
  board,
  conflicts,
  cursor,
  lockedCells,
  paint,
  showCandidates,
  theme,
}) => {
  const lines = [
    buildHorizontalBorder({
      paint,
      theme,
      left: "┏",
      minor: "┯",
      major: "┳",
      right: "┓",
      fill: "━",
      minorWeight: "major",
      fillWeight: "major",
    }),
  ];

  for (let row = 0; row < 9; row += 1) {
    const renderedRow = [[], [], []];

    for (let col = 0; col < 9; col += 1) {
      const index = row * 9 + col;
      const cellLines = getRenderedCellLines({
        board,
        conflicts,
        cursor,
        index,
        lockedCells,
        paint,
        showCandidates,
        theme,
      });

      for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
        renderedRow[lineIndex].push(cellLines[lineIndex]);
      }
    }

    for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
      let line = colorBorder(paint, theme, "┃", "major");

      for (let col = 0; col < 9; col += 1) {
        line += renderedRow[lineIndex][col];

        if (col === 8) {
          line += colorBorder(paint, theme, "┃", "major");
        } else if ((col + 1) % 3 === 0) {
          line += colorBorder(paint, theme, "┃", "major");
        } else {
          line += colorBorder(paint, theme, "│");
        }
      }

      lines.push(line);
    }

    if (row === 8) {
      lines.push(
        buildHorizontalBorder({
          paint,
          theme,
          left: "┗",
          minor: "┷",
          major: "┻",
          right: "┛",
          fill: "━",
          minorWeight: "major",
          fillWeight: "major",
        }),
      );
    } else if ((row + 1) % 3 === 0) {
      lines.push(
        buildHorizontalBorder({
          paint,
          theme,
          left: "┣",
          minor: "╋",
          major: "╋",
          right: "┫",
          fill: "━",
          minorWeight: "major",
          fillWeight: "major",
        }),
      );
    } else {
      lines.push(
        buildHorizontalBorder({
          paint,
          theme,
          left: "┠",
          minor: "┼",
          major: "╂",
          right: "┨",
          fill: "─",
        }),
      );
    }
  }

  return lines;
};

const buildControlLines = (theme, paint) => [
  paint("Controls", theme.title),
  "",
  "Move:  arrows / hjkl",
  "Fill:  1-9",
  "Cand:  c",
  "Clear: 0 . backspace",
  "Reset: r",
  "New:   n",
  "Diff:  d",
  `Theme: m (${theme.name})`,
  "Quit:  q",
];

const buildWinModalLines = (theme, paint) => [
  paint("╔══════════════════════════╗", theme.modalFrame),
  paint("║                          ║", theme.modalFrame),
  paint("║", theme.modalFrame) +
    paint("         You Win          ", theme.modalTitle) +
    paint("║", theme.modalFrame),
  paint("║                          ║", theme.modalFrame),
  paint("║", theme.modalFrame) +
    paint("    Puzzle complete.      ", theme.modalFrame) +
    paint("║", theme.modalFrame),
  paint("║", theme.modalFrame) +
    paint("   Press n for a new one  ", theme.modalFrame) +
    paint("║", theme.modalFrame),
  paint("║                          ║", theme.modalFrame),
  paint("╚══════════════════════════╝", theme.modalFrame),
];

const renderOverlay = ({
  boardLines,
  layoutLines,
  overlayLines,
  stream,
  termSize,
  theme,
}) => {
  const { cols, rows } = getTerminalSize(termSize);
  const layoutWidth = layoutLines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const layoutHeight = layoutLines.length;
  const boardWidth = boardLines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const boardHeight = boardLines.length;
  const overlayWidth = overlayLines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const overlayHeight = overlayLines.length;
  const startCol = Math.max(1, Math.floor((cols - layoutWidth) / 2) + 1);
  const startRow = Math.max(1, Math.floor((rows - layoutHeight) / 2) + 1);
  const overlayCol = startCol + Math.max(0, Math.floor((boardWidth - overlayWidth) / 2));
  const overlayRow = startRow + Math.max(0, Math.floor((boardHeight - overlayHeight) / 2));

  overlayLines.forEach((line, index) => {
    stream.write(
      `\x1b[${overlayRow + index};${overlayCol}H${ansiStyle(theme.baseStyle)}${line}`,
    );
  });
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
  let showCandidates = false;
  let puzzleState = null;
  let themeName = THEME_ORDER[0];
  let difficultyMenu = {
    active: true,
    message: "Choose a difficulty for your new puzzle.",
    selectedIndex: DIFFICULTIES.indexOf("medium"),
  };

  const getTheme = () => THEMES[themeName] ?? THEMES.light;

  const toggleTheme = () => {
    const currentIndex = THEME_ORDER.indexOf(themeName);
    const nextIndex = (currentIndex + 1 + THEME_ORDER.length) % THEME_ORDER.length;
    themeName = THEME_ORDER[nextIndex];
  };

  const resetPuzzle = (difficulty) => {
    puzzleState = createPuzzleState(difficulty);
    cursor = 0;
    showCandidates = false;
  };

  const openDifficultyMenu = ({
    defaultDifficulty = puzzleState?.difficulty ?? "medium",
    message = "Choose a difficulty for your new puzzle.",
  } = {}) => {
    difficultyMenu = {
      active: true,
      message,
      selectedIndex: Math.max(0, DIFFICULTIES.indexOf(defaultDifficulty)),
    };
  };

  const closeDifficultyMenu = () => {
    difficultyMenu = {
      ...difficultyMenu,
      active: false,
    };
  };

  const confirmDifficultySelection = () => {
    const difficulty = DIFFICULTIES[difficultyMenu.selectedIndex] ?? "medium";
    resetPuzzle(difficulty);
    closeDifficultyMenu();
  };

  const render = () => {
    const theme = getTheme();
    const paint = createPainter(theme);
    const renderOptions = {
      lineStyleCode: theme.baseStyle,
      screenStyleCode: theme.baseStyle,
    };
    const requiredCols = difficultyMenu.active ? MENU_MIN_COLS : GAME_MIN_COLS;
    const requiredRows = difficultyMenu.active ? MENU_MIN_ROWS : GAME_MIN_ROWS;

    if (
      (termSize?.cols ?? 0) < requiredCols ||
      (termSize?.rows ?? 0) < requiredRows
    ) {
      renderCentered(
        stream,
        termSize,
        [
          paint("Terminal too small", theme.conflict),
          "",
          `Need at least ${requiredCols}x${requiredRows}`,
          `Current size: ${termSize?.cols ?? 0}x${termSize?.rows ?? 0}`,
          "",
          "Resize the terminal to continue.",
          "Press m to switch theme.",
        ],
        renderOptions,
      );
      return;
    }

    if (difficultyMenu.active) {
      const options = DIFFICULTIES.map((difficulty, index) => {
        const selected = index === difficultyMenu.selectedIndex;
        const label = difficulty[0].toUpperCase() + difficulty.slice(1);

        return selected ? paint(`> ${label}`, theme.menuSelected) : `  ${label}`;
      });

      renderCentered(
        stream,
        termSize,
        [
          ...MENU_TITLE.map((line) => (line ? paint(line, theme.title) : line)),
          paint("Select Difficulty", theme.sectionTitle),
          ...options,
          "",
          difficultyMenu.message,
          "Use arrows or hjkl to choose. Press Enter to start.",
          `Press m to switch theme (${theme.name}).`,
        ],
        renderOptions,
      );
      return;
    }

    const { board, lockedCells, solution } = puzzleState;
    const conflicts = buildConflicts(board, lockedCells);
    const isSolved = conflicts.size === 0 && isSolvedBoard(board, solution);
    const boardLines = buildBoardLines({
      board,
      conflicts,
      cursor,
      lockedCells,
      paint,
      showCandidates,
      theme,
    });
    const controlLines = buildControlLines(theme, paint);

    const lines = joinColumns(boardLines, controlLines);

    renderCentered(stream, termSize, lines, renderOptions);

    if (isSolved) {
      renderOverlay({
        boardLines,
        layoutLines: lines,
        overlayLines: buildWinModalLines(theme, paint),
        stream,
        termSize,
        theme,
      });
    }
  };

  const writeDigit = (digit) => {
    if (puzzleState.lockedCells[cursor]) {
      return;
    }

    puzzleState.board[cursor] = digit;
  };

  const clearDigit = () => {
    if (puzzleState.lockedCells[cursor]) {
      return;
    }

    if (!puzzleState.board[cursor]) {
      return;
    }

    puzzleState.board[cursor] = "";
  };

  const moveDifficultySelection = (delta) => {
    difficultyMenu.selectedIndex =
      (difficultyMenu.selectedIndex + delta + DIFFICULTIES.length) %
      DIFFICULTIES.length;
  };

  const handleDifficultyToken = (token) => {
    switch (token) {
      case "\u0003":
      case "q":
        closeConnection(0);
        return;
      case "m":
      case "M":
        toggleTheme();
        break;
      case "ESC[A":
      case "k":
        moveDifficultySelection(-1);
        break;
      case "ESC[B":
      case "j":
        moveDifficultySelection(1);
        break;
      case "\r":
      case "\n":
      case " ":
        confirmDifficultySelection();
        break;
      default:
        break;
    }

    render();
  };

  const handleToken = (token) => {
    if (difficultyMenu.active) {
      handleDifficultyToken(token);
      return;
    }

    switch (token) {
      case "\u0003":
      case "q":
        closeConnection(0);
        return;
      case "m":
      case "M":
        toggleTheme();
        break;
      case "ESC[A":
      case "k":
        cursor = moveSelection(cursor, -1, 0);
        break;
      case "ESC[B":
      case "j":
        cursor = moveSelection(cursor, 1, 0);
        break;
      case "ESC[C":
      case "l":
        cursor = moveSelection(cursor, 0, 1);
        break;
      case "ESC[D":
      case "h":
        cursor = moveSelection(cursor, 0, -1);
        break;
      case "r":
        puzzleState.board = [...puzzleState.initialBoard];
        break;
      case "c":
      case "C":
        showCandidates = !showCandidates;
        break;
      case "n":
        openDifficultyMenu({
          defaultDifficulty: puzzleState.difficulty,
          message: "Choose a difficulty for the next puzzle.",
        });
        break;
      case "d":
      case "D":
        openDifficultyMenu({
          defaultDifficulty: puzzleState.difficulty,
          message: "Choose a difficulty and press Enter to start a new puzzle.",
        });
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
      openDifficultyMenu({
        defaultDifficulty: "medium",
        message: "Choose a difficulty for your new puzzle.",
      });
      render();
    },
    onData(data) {
      const input = data.toString("utf8");

      for (const token of parseInputTokens(input)) {
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
