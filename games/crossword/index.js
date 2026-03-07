import fs from "fs";
import path from "path";
import {
  color,
  getTerminalSize,
  getVisibleWidth,
  parseInputTokens,
  renderCentered,
} from "../../lib/session-ui.js";

export const metadata = {
  description: "Solve a randomly selected crossword puzzle over SSH.",
};

const DATA_DIR = path.resolve(process.cwd(), "games", "crossword", "data");
const TYPOGRAPHY_PATH = path.resolve(process.cwd(), "typography.txt");
const MIN_COLS = 156;
const MIN_ROWS = 50;
const PANEL_GAP = "    ";
const MAX_PANEL_WIDTH = 58;
const GLYPH_WIDTH = 3;
const CELL_WIDTH = 6;
const CELL_HEIGHT = 3;
const EMPTY_CELL_ART = ["      ", "  ..  ", "      "];
const BLOCK_CELL_ART = ["      ", "      ", "      "];

const centerGlyphLine = (line) => {
  const trimmedLine = line.slice(0, GLYPH_WIDTH);
  const leftPadding = Math.floor((CELL_WIDTH - trimmedLine.length) / 2);
  const rightPadding = CELL_WIDTH - trimmedLine.length - leftPadding;
  return `${" ".repeat(leftPadding)}${trimmedLine}${" ".repeat(rightPadding)}`;
};

const loadTypography = () => {
  const fallbackCharacters = new Map();

  for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    fallbackCharacters.set(character, ["      ", `  ${character}   `, "      "]);
  }

  if (!fs.existsSync(TYPOGRAPHY_PATH)) {
    return fallbackCharacters;
  }

  const rawText = fs.readFileSync(TYPOGRAPHY_PATH, "utf8").replace(/\r\n/g, "\n");
  const lines = rawText.split("\n");
  const characters = new Map(fallbackCharacters);

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].trim();

    if (!/^[A-Z0-9]:$/.test(heading)) {
      continue;
    }

    const key = heading[0];

    while (index + 1 < lines.length && lines[index + 1].trim() === "") {
      index += 1;
    }

    const art = [];

    for (let lineIndex = 0; lineIndex < CELL_HEIGHT && index + 1 < lines.length; lineIndex += 1) {
      index += 1;
      art.push(centerGlyphLine(lines[index].padEnd(GLYPH_WIDTH, " ").slice(0, GLYPH_WIDTH)));
    }

    if (art.length === CELL_HEIGHT) {
      characters.set(key, art);
    }
  }

  return characters;
};

const LARGE_GLYPHS = loadTypography();

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

const truncateText = (text, width) => {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width <= 3) {
    return ".".repeat(width);
  }

  return `${text.slice(0, width - 3)}...`;
};

const wrapText = (text, width) => {
  if (width <= 0) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [""];
  }

  const lines = [];
  let currentLine = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const nextLine = `${currentLine} ${words[index]}`;

    if (nextLine.length <= width) {
      currentLine = nextLine;
      continue;
    }

    lines.push(currentLine);
    currentLine = words[index];
  }

  lines.push(currentLine);
  return lines;
};

const formatElapsed = (milliseconds) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const chooseRandomPuzzleFile = (rootDir) => {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  let selectedPath = null;
  let seenCount = 0;

  const visitDirectory = (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        visitDirectory(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".xd")) {
        continue;
      }

      seenCount += 1;

      if (Math.random() < 1 / seenCount) {
        selectedPath = fullPath;
      }
    }
  };

  visitDirectory(rootDir);
  return selectedPath;
};

const parseClueLine = (line) => {
  const match = /^([AD])(\d+)\.\s*(.*)$/.exec(line.trim());

  if (!match) {
    return null;
  }

  const [, cluePrefix, numberText, rest] = match;
  const answerSplitIndex = rest.lastIndexOf(" ~ ");
  const clueText =
    answerSplitIndex === -1 ? rest.trim() : rest.slice(0, answerSplitIndex).trim();
  const answer =
    answerSplitIndex === -1
      ? null
      : rest
          .slice(answerSplitIndex + 3)
          .trim()
          .toUpperCase();

  return {
    answer,
    direction: cluePrefix === "A" ? "across" : "down",
    number: Number(numberText),
    text: clueText,
  };
};

const parsePuzzleFile = (filePath) => {
  const rawText = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const lines = rawText.split("\n");
  const headers = {};
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor].trim();

    if (!line) {
      break;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      break;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
    cursor += 1;
  }

  while (cursor < lines.length && !lines[cursor].trim()) {
    cursor += 1;
  }

  const gridLines = [];

  while (cursor < lines.length) {
    const line = lines[cursor].trim();

    if (!line) {
      break;
    }

    gridLines.push(line.toUpperCase());
    cursor += 1;
  }

  while (cursor < lines.length && !lines[cursor].trim()) {
    cursor += 1;
  }

  if (gridLines.length === 0) {
    throw new Error(`Puzzle file "${filePath}" does not contain a grid.`);
  }

  const width = gridLines[0].length;

  if (width === 0 || gridLines.some((line) => line.length !== width)) {
    throw new Error(`Puzzle file "${filePath}" has an invalid grid.`);
  }

  const clueTextMap = new Map();

  for (; cursor < lines.length; cursor += 1) {
    const parsedClue = parseClueLine(lines[cursor]);

    if (!parsedClue) {
      continue;
    }

    clueTextMap.set(
      `${parsedClue.direction}:${parsedClue.number}`,
      parsedClue,
    );
  }

  const height = gridLines.length;
  const cells = [];
  const cluesById = new Map();
  const acrossClues = [];
  const downClues = [];
  let nextNumber = 1;
  let firstOpenCell = null;

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      const value = gridLines[row][col];
      const isBlock = value === "#";

      cells.push({
        acrossClueId: null,
        col,
        downClueId: null,
        index,
        isBlock,
        number: null,
        row,
        solution: isBlock ? "" : value,
      });

      if (!isBlock && firstOpenCell === null) {
        firstOpenCell = index;
      }
    }
  }

  const buildClue = (row, col, direction, number) => {
    const rowStep = direction === "across" ? 0 : 1;
    const colStep = direction === "across" ? 1 : 0;
    const clueCells = [];
    const letters = [];
    let currentRow = row;
    let currentCol = col;

    while (
      currentRow >= 0 &&
      currentRow < height &&
      currentCol >= 0 &&
      currentCol < width
    ) {
      const cell = cells[currentRow * width + currentCol];

      if (cell.isBlock) {
        break;
      }

      clueCells.push(cell.index);
      letters.push(cell.solution);
      currentRow += rowStep;
      currentCol += colStep;
    }

    const clueKey = `${direction}:${number}`;
    const clueText = clueTextMap.get(clueKey);
    const clue = {
      answer: letters.join(""),
      cells: clueCells,
      direction,
      id: `${direction[0].toUpperCase()}${number}`,
      length: clueCells.length,
      number,
      text: clueText?.text ?? "Clue text unavailable.",
    };

    cluesById.set(clue.id, clue);

    for (const index of clueCells) {
      if (direction === "across") {
        cells[index].acrossClueId = clue.id;
      } else {
        cells[index].downClueId = clue.id;
      }
    }

    if (direction === "across") {
      acrossClues.push(clue);
    } else {
      downClues.push(clue);
    }
  };

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const cell = cells[row * width + col];

      if (cell.isBlock) {
        continue;
      }

      const startsAcross =
        col === 0 || cells[row * width + (col - 1)].isBlock;
      const startsDown =
        row === 0 || cells[(row - 1) * width + col].isBlock;

      if (!startsAcross && !startsDown) {
        continue;
      }

      cell.number = nextNumber;

      if (startsAcross) {
        buildClue(row, col, "across", nextNumber);
      }

      if (startsDown) {
        buildClue(row, col, "down", nextNumber);
      }

      nextNumber += 1;
    }
  }

  if (firstOpenCell === null) {
    throw new Error(`Puzzle file "${filePath}" does not contain playable cells.`);
  }

  return {
    acrossClues,
    author: headers.author ?? "Unknown author",
    cluesById,
    date: headers.date ?? "Unknown date",
    downClues,
    filePath,
    firstOpenCell,
    height,
    relativePath: path.relative(DATA_DIR, filePath),
    source: path.relative(DATA_DIR, filePath).split(path.sep)[0] ?? "unknown",
    title: headers.title ?? path.basename(filePath),
    width,
    cells,
  };
};

const loadRandomPuzzle = () => {
  const puzzlePath = chooseRandomPuzzleFile(DATA_DIR);

  if (!puzzlePath) {
    throw new Error(`No crossword puzzles were found under ${DATA_DIR}.`);
  }

  return parsePuzzleFile(puzzlePath);
};

const getCluesForDirection = (puzzle, direction) =>
  direction === "across" ? puzzle.acrossClues : puzzle.downClues;

const getCell = (puzzle, index) => puzzle.cells[index];

const getClueForCell = (puzzle, index, direction) => {
  const cell = getCell(puzzle, index);
  const clueId = direction === "across" ? cell.acrossClueId : cell.downClueId;
  return clueId ? puzzle.cluesById.get(clueId) ?? null : null;
};

const findSelectionForDirection = (puzzle, index, direction) => {
  const cell = getCell(puzzle, index);

  if (cell.isBlock) {
    return puzzle.firstOpenCell;
  }

  const clue = getClueForCell(puzzle, index, direction);

  if (clue) {
    return index;
  }

  const fallbackDirection = direction === "across" ? "down" : "across";
  const fallbackClue = getClueForCell(puzzle, index, fallbackDirection);

  return fallbackClue ? index : puzzle.firstOpenCell;
};

const createSessionState = (puzzle) => ({
  direction: getClueForCell(puzzle, puzzle.firstOpenCell, "across")
    ? "across"
    : "down",
  entries: Array.from({ length: puzzle.cells.length }, (_, index) =>
    puzzle.cells[index].isBlock ? "#" : "",
  ),
  puzzle,
  selection: puzzle.firstOpenCell,
  solved: false,
  startedAt: Date.now(),
  status: "Type letters to fill the grid. Tab advances clues; space switches direction.",
});

const hasEnoughRoom = (termSize) => {
  const { cols, rows } = getTerminalSize(termSize);
  return cols >= MIN_COLS && rows >= MIN_ROWS;
};

const moveSelection = (state, rowDelta, colDelta) => {
  const { puzzle } = state;
  const currentCell = getCell(puzzle, state.selection);
  let row = currentCell.row + rowDelta;
  let col = currentCell.col + colDelta;

  while (row >= 0 && row < puzzle.height && col >= 0 && col < puzzle.width) {
    const nextCell = puzzle.cells[row * puzzle.width + col];

    if (!nextCell.isBlock) {
      state.selection = nextCell.index;
      return true;
    }

    row += rowDelta;
    col += colDelta;
  }

  return false;
};

const moveWithinClue = (state, step) => {
  const clue = getClueForCell(state.puzzle, state.selection, state.direction);

  if (!clue) {
    return false;
  }

  const currentIndex = clue.cells.indexOf(state.selection);
  const nextIndex = currentIndex + step;

  if (nextIndex < 0 || nextIndex >= clue.cells.length) {
    return false;
  }

  state.selection = clue.cells[nextIndex];
  return true;
};

const jumpToAdjacentClue = (state, delta) => {
  const clues = getCluesForDirection(state.puzzle, state.direction);
  const activeClue = getClueForCell(state.puzzle, state.selection, state.direction);

  if (!activeClue) {
    return;
  }

  const activeIndex = clues.findIndex((clue) => clue.id === activeClue.id);

  if (activeIndex === -1) {
    return;
  }

  const nextIndex = (activeIndex + delta + clues.length) % clues.length;
  state.selection = clues[nextIndex].cells[0];
};

const toggleDirection = (state) => {
  const nextDirection = state.direction === "across" ? "down" : "across";
  state.selection = findSelectionForDirection(
    state.puzzle,
    state.selection,
    nextDirection,
  );
  state.direction = getClueForCell(state.puzzle, state.selection, nextDirection)
    ? nextDirection
    : state.direction;
};

const clearCurrentEntry = (state) => {
  const cell = getCell(state.puzzle, state.selection);

  if (cell.isBlock) {
    return;
  }

  if (state.entries[cell.index]) {
    state.entries[cell.index] = "";
    state.solved = false;
    return;
  }

  if (moveWithinClue(state, -1)) {
    state.entries[state.selection] = "";
    state.solved = false;
  }
};

const checkSolved = (state) =>
  state.puzzle.cells.every((cell) => {
    if (cell.isBlock) {
      return true;
    }

    return state.entries[cell.index] === cell.solution;
  });

const fillLetter = (state, letter) => {
  const cell = getCell(state.puzzle, state.selection);

  if (cell.isBlock) {
    return;
  }

  state.entries[cell.index] = letter.toUpperCase();

  if (checkSolved(state)) {
    state.solved = true;
    state.status = `Puzzle solved in ${formatElapsed(Date.now() - state.startedAt)}. Press r for another puzzle.`;
    return;
  }

  moveWithinClue(state, 1);
  state.status = "Keep going. Tab advances clues, and space switches direction.";
};

const getArtForEntry = (entry) => {
  if (!entry) {
    return EMPTY_CELL_ART;
  }

  return LARGE_GLYPHS.get(entry) ?? ["      ", `  ${entry}   `, "      "];
};

const colorArt = (art, code) => art.map((line) => color(line, code));

const getCellDisplay = (state, cell, activeClue) => {
  if (cell.isBlock) {
    return colorArt(BLOCK_CELL_ART, "48;5;238");
  }

  const isInActiveClue = activeClue?.cells.includes(cell.index) ?? false;
  const isSelected = cell.index === state.selection;
  const entry = state.entries[cell.index];
  const art = getArtForEntry(entry);

  if (isSelected) {
    return colorArt(art, "1;30;48;5;226");
  }

  if (isInActiveClue) {
    return colorArt(art, "30;48;5;153");
  }

  if (entry) {
    return colorArt(art, "1;37");
  }

  return colorArt(art, "2;37");
};

const buildBoardLines = (state) => {
  const lines = [];
  const activeClue = getClueForCell(state.puzzle, state.selection, state.direction);
  const innerWidth = state.puzzle.width * CELL_WIDTH;

  lines.push(color(`┌${"─".repeat(innerWidth)}┐`, "38;5;245"));

  for (let row = 0; row < state.puzzle.height; row += 1) {
    const rowCells = [];

    for (let col = 0; col < state.puzzle.width; col += 1) {
      rowCells.push(
        getCellDisplay(
          state,
          state.puzzle.cells[row * state.puzzle.width + col],
          activeClue,
        ),
      );
    }

    for (let artLineIndex = 0; artLineIndex < CELL_HEIGHT; artLineIndex += 1) {
      lines.push(
        `${color("│", "38;5;245")}${rowCells.map((art) => art[artLineIndex]).join("")}${color("│", "38;5;245")}`,
      );
    }
  }

  lines.push(color(`└${"─".repeat(innerWidth)}┘`, "38;5;245"));

  return lines;
};

const buildClueWindow = (clues, activeClue, width, height) => {
  if (height <= 0 || clues.length === 0) {
    return [];
  }

  const activeIndex = Math.max(
    0,
    clues.findIndex((clue) => clue.id === activeClue?.id),
  );
  const before = Math.floor((height - 1) / 2);
  const after = height - before - 1;
  let start = Math.max(0, activeIndex - before);
  let end = Math.min(clues.length, start + height);

  if (end - start < height) {
    start = Math.max(0, end - height);
  }

  return clues.slice(start, end).map((clue) => {
    const label = `${clue.id} ${clue.text} [${clue.length}]`;
    const line = truncateText(label, width);
    return clue.id === activeClue?.id ? color(`> ${line}`, "1;30;47") : `  ${line}`;
  });
};

const buildPanelLines = (state, panelWidth, termRows) => {
  const activeClue = getClueForCell(state.puzzle, state.selection, state.direction);
  const otherDirection = state.direction === "across" ? "down" : "across";
  const crossingClue = getClueForCell(state.puzzle, state.selection, otherDirection);
  const pattern = activeClue
    ? activeClue.cells.map((index) => state.entries[index] || "_").join("")
    : "";
  const headerLines = [
    color(truncateText(state.puzzle.title, panelWidth), "1;36"),
    truncateText(`${state.puzzle.author} | ${state.puzzle.date}`, panelWidth),
    truncateText(`Source: ${state.puzzle.source}`, panelWidth),
    truncateText(state.puzzle.relativePath, panelWidth),
    "",
    truncateText(state.status, panelWidth),
    `Time: ${formatElapsed(Date.now() - state.startedAt)}`,
    `Cell: r${getCell(state.puzzle, state.selection).row + 1} c${getCell(state.puzzle, state.selection).col + 1}`,
    `Direction: ${state.direction}`,
    activeClue ? `${activeClue.id} [${activeClue.length}]` : "No active clue",
    ...wrapText(activeClue?.text ?? "", panelWidth),
    activeClue ? truncateText(`Pattern: ${pattern}`, panelWidth) : "",
    "",
    crossingClue
      ? truncateText(
          `Crossing ${crossingClue.id}: ${crossingClue.text} [${crossingClue.length}]`,
          panelWidth,
        )
      : `Crossing: none`,
    "",
    color(
      `Clues (${state.direction === "across" ? "across" : "down"})`,
      "1;33",
    ),
  ];

  const controls = [
    "",
    color("Controls", "1;33"),
    "Arrows move",
    "Type A-Z to fill",
    "Backspace clears",
    "Tab next clue",
    "Space switch direction",
    "n/p next or prev clue",
    "r new puzzle",
    "q quit",
  ];
  const clueWindowHeight = Math.max(
    3,
    termRows - headerLines.length - controls.length - 2,
  );
  const clueLines = buildClueWindow(
    getCluesForDirection(state.puzzle, state.direction),
    activeClue,
    Math.max(8, panelWidth - 2),
    clueWindowHeight,
  );

  return [...headerLines, ...clueLines, ...controls];
};

export const createGameSession = ({
  closeConnection,
  stream,
  termSize: initialTermSize,
}) => {
  let termSize = initialTermSize;
  let state = createSessionState(loadRandomPuzzle());

  const reloadPuzzle = () => {
    state = createSessionState(loadRandomPuzzle());
    state.status = "Loaded a new puzzle.";
  };

  const render = () => {
    const { cols, rows } = getTerminalSize(termSize);

    if (!hasEnoughRoom(termSize)) {
      renderCentered(stream, termSize, [
        "Terminal window is too small.",
        `Need at least ${MIN_COLS} columns x ${MIN_ROWS} rows.`,
        `Current size: ${cols} x ${rows}.`,
        "",
        "Resize the window to play crossword.",
      ]);
      return;
    }

    const boardLines = buildBoardLines(state);
    const boardWidth = boardLines.reduce(
      (max, line) => Math.max(max, getVisibleWidth(line)),
      0,
    );
    const panelWidth = Math.min(
      MAX_PANEL_WIDTH,
      Math.max(34, cols - boardWidth - PANEL_GAP.length - 2),
    );

    renderCentered(
      stream,
      termSize,
      joinColumns(boardLines, buildPanelLines(state, panelWidth, rows)),
    );
  };

  return {
    start() {
      render();
    },
    onClose() {},
    onData(data) {
      const input = data.toString("utf8");

      for (const token of parseInputTokens(input)) {
        if (token === "\u0003" || token.toLowerCase() === "q") {
          closeConnection(0);
          return;
        }

        if (token === "\t") {
          jumpToAdjacentClue(state, 1);
          render();
          continue;
        }

        if (token === " ") {
          toggleDirection(state);
          render();
          continue;
        }

        if (token === "ESC[A") {
          state.direction = "down";
          moveSelection(state, -1, 0);
          render();
          continue;
        }

        if (token === "ESC[B") {
          state.direction = "down";
          moveSelection(state, 1, 0);
          render();
          continue;
        }

        if (token === "ESC[C") {
          state.direction = "across";
          moveSelection(state, 0, 1);
          render();
          continue;
        }

        if (token === "ESC[D") {
          state.direction = "across";
          moveSelection(state, 0, -1);
          render();
          continue;
        }

        if (token === "\u007f" || token === "\b" || token === "ESC[3~") {
          clearCurrentEntry(state);
          state.status = "Entry cleared.";
          render();
          continue;
        }

        if (token.toLowerCase() === "n") {
          jumpToAdjacentClue(state, 1);
          render();
          continue;
        }

        if (token.toLowerCase() === "p") {
          jumpToAdjacentClue(state, -1);
          render();
          continue;
        }

        if (token.toLowerCase() === "r") {
          try {
            reloadPuzzle();
          } catch (error) {
            state.status = String(error.message || error);
          }

          render();
          continue;
        }

        if (/^[a-z]$/i.test(token) && !state.solved) {
          fillLetter(state, token);
          render();
        }
      }
    },
    onResize(nextTermSize) {
      termSize = nextTermSize;
      render();
    },
  };
};

export default createGameSession;
