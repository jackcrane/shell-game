import fs from "fs";
import path from "path";
import {
  ansiStyle,
  color,
  createCenteredLayout,
  getTerminalSize,
  getVisibleWidth,
  parseInputTokens,
  renderCentered,
  safeWrite,
} from "../../lib/session-ui.js";

export const metadata = {
  description: "Solve a randomly selected crossword puzzle over SSH.",
};

const DATA_DIR = path.resolve(process.cwd(), "games", "crossword", "data");
const TYPOGRAPHY_PATH = path.resolve(process.cwd(), "typography.txt");
const PANEL_GAP = "    ";
const HARD_MIN_COLS = 135;
const HARD_MIN_ROWS = 38;
const MIN_PANEL_WIDTH = 34;
const MIN_PANEL_ROWS = 21;
const MAX_PANEL_WIDTH = 58;
const TOP_FITTING_PUZZLE_COUNT = 150;
const CELL_WIDTH = 6;
const CELL_HEIGHT = 3;
const EMPTY_CELL_ART = ["      ", "  ..  ", "      "];
const BLOCK_CELL_ART = ["      ", "      ", "      "];
const GLYPH_LEFT_PADDING = " ";
const ROOM_PIN_LENGTH = 6;
const MAX_ROOM_PLAYERS = 2;
const JOIN_MODAL_INNER_WIDTH = 30;
const DEFAULT_STATUS =
  "Type letters to fill the grid. Tab advances clues; space switches direction.";
const PARTNER_CLUE_BACKGROUND = "48;5;225";
const PARTNER_SELECTION_BACKGROUND = "48;5;212";

const MULTIPLAYER_ROOMS = new Map();

const formatGlyphLine = (line) =>
  `${GLYPH_LEFT_PADDING}${line}`.slice(0, CELL_WIDTH).padEnd(CELL_WIDTH, " ");

const loadTypography = () => {
  const fallbackCharacters = new Map();

  for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    fallbackCharacters.set(character, [
      formatGlyphLine(""),
      formatGlyphLine(character),
      formatGlyphLine(""),
    ]);
  }

  if (!fs.existsSync(TYPOGRAPHY_PATH)) {
    return fallbackCharacters;
  }

  const rawText = fs
    .readFileSync(TYPOGRAPHY_PATH, "utf8")
    .replace(/\r\n/g, "\n");
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

    for (
      let lineIndex = 0;
      lineIndex < CELL_HEIGHT && index + 1 < lines.length;
      lineIndex += 1
    ) {
      index += 1;
      art.push(formatGlyphLine(lines[index]));
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

const listPuzzleFiles = (() => {
  const cache = new Map();

  return (rootDir) => {
    if (cache.has(rootDir)) {
      return cache.get(rootDir);
    }

    if (!fs.existsSync(rootDir)) {
      cache.set(rootDir, []);
      return [];
    }

    const puzzleFiles = [];

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

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".xd")) {
          puzzleFiles.push(fullPath);
        }
      }
    };

    visitDirectory(rootDir);
    cache.set(rootDir, puzzleFiles);
    return puzzleFiles;
  };
})();

const parseClueLine = (line) => {
  const match = /^([AD])(\d+)\.\s*(.*)$/.exec(line.trim());

  if (!match) {
    return null;
  }

  const [, cluePrefix, numberText, rest] = match;
  const answerSplitIndex = rest.lastIndexOf(" ~ ");
  const clueText =
    answerSplitIndex === -1
      ? rest.trim()
      : rest.slice(0, answerSplitIndex).trim();
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

    clueTextMap.set(`${parsedClue.direction}:${parsedClue.number}`, parsedClue);
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

      const startsAcross = col === 0 || cells[row * width + (col - 1)].isBlock;
      const startsDown = row === 0 || cells[(row - 1) * width + col].isBlock;

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
    throw new Error(
      `Puzzle file "${filePath}" does not contain playable cells.`,
    );
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

const getSelectedClueMetrics = (puzzle) => {
  if (puzzle.selectedClueMetrics) {
    return puzzle.selectedClueMetrics;
  }

  const totalWidth = puzzle.width * CELL_WIDTH + 2;
  const wrapWidth = Math.max(1, totalWidth - 2);
  let maxLineCount = 1;
  let maxLineWidth = totalWidth;

  for (const clue of puzzle.cluesById.values()) {
    const wrappedLines = wrapText(`${clue.id}. ${clue.text}`, wrapWidth);
    maxLineCount = Math.max(maxLineCount, wrappedLines.length);

    for (const line of wrappedLines) {
      maxLineWidth = Math.max(maxLineWidth, line.length + 2);
    }
  }

  puzzle.selectedClueMetrics = {
    maxLineCount,
    maxLineWidth,
  };
  return puzzle.selectedClueMetrics;
};

const meetsHardMinimum = (termSize) => {
  const { cols, rows } = getTerminalSize(termSize);
  return cols >= HARD_MIN_COLS && rows >= HARD_MIN_ROWS;
};

const getMinimumTermSizeForPuzzle = (puzzle) => {
  const { maxLineCount, maxLineWidth } = getSelectedClueMetrics(puzzle);

  return {
    cols: Math.max(
      HARD_MIN_COLS,
      maxLineWidth + PANEL_GAP.length + MIN_PANEL_WIDTH,
    ),
    rows: Math.max(
      HARD_MIN_ROWS,
      MIN_PANEL_ROWS,
      puzzle.height * CELL_HEIGHT + 3 + maxLineCount,
    ),
  };
};

const puzzleFitsTermSize = (puzzle, termSize) => {
  const { cols, rows } = getTerminalSize(termSize);
  const minimumSize = getMinimumTermSizeForPuzzle(puzzle);
  return cols >= minimumSize.cols && rows >= minimumSize.rows;
};

const comparePuzzleIndexEntries = (left, right) => {
  const areaDelta = right.area - left.area;

  if (areaDelta !== 0) {
    return areaDelta;
  }

  if (right.width !== left.width) {
    return right.width - left.width;
  }

  if (right.height !== left.height) {
    return right.height - left.height;
  }

  return left.filePath.localeCompare(right.filePath);
};

const buildPuzzleIndex = () => {
  const puzzleFiles = listPuzzleFiles(DATA_DIR);

  if (puzzleFiles.length === 0) {
    throw new Error(`No crossword puzzles were found under ${DATA_DIR}.`);
  }

  const puzzleIndex = [];
  let skippedCount = 0;

  for (const filePath of puzzleFiles) {
    try {
      const puzzle = parsePuzzleFile(filePath);
      const minimumSize = getMinimumTermSizeForPuzzle(puzzle);

      puzzleIndex.push({
        area: puzzle.width * puzzle.height,
        filePath,
        height: puzzle.height,
        minCols: minimumSize.cols,
        minRows: minimumSize.rows,
        width: puzzle.width,
      });
    } catch {
      skippedCount += 1;
    }
  }

  if (puzzleIndex.length === 0) {
    throw new Error(`No valid crossword puzzles were found under ${DATA_DIR}.`);
  }

  if (skippedCount > 0) {
    console.warn(
      `Skipped ${skippedCount} invalid crossword puzzle${skippedCount === 1 ? "" : "s"} while building the index.`,
    );
  }

  puzzleIndex.sort(comparePuzzleIndexEntries);
  return puzzleIndex;
};

const PUZZLE_INDEX = buildPuzzleIndex();

const chooseFittingPuzzle = (termSize, { excludeFilePath = null } = {}) => {
  const { cols, rows } = getTerminalSize(termSize);
  const candidates = [];
  let attempts = 0;

  for (const entry of PUZZLE_INDEX) {
    attempts += 1;

    if (cols < entry.minCols || rows < entry.minRows) {
      continue;
    }

    if (excludeFilePath && entry.filePath === excludeFilePath) {
      continue;
    }

    candidates.push(entry);

    if (candidates.length >= TOP_FITTING_PUZZLE_COUNT) {
      break;
    }
  }

  if (candidates.length === 0) {
    return { attempts, puzzle: null };
  }

  const selectedEntry =
    candidates[Math.floor(Math.random() * candidates.length)];

  return {
    attempts,
    puzzle: parsePuzzleFile(selectedEntry.filePath),
  };
};

const getCluesForDirection = (puzzle, direction) =>
  direction === "across" ? puzzle.acrossClues : puzzle.downClues;

const getCell = (puzzle, index) => puzzle.cells[index];

const getClueForCell = (puzzle, index, direction) => {
  const cell = getCell(puzzle, index);
  const clueId = direction === "across" ? cell.acrossClueId : cell.downClueId;
  return clueId ? (puzzle.cluesById.get(clueId) ?? null) : null;
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

const createRoomState = (puzzle) => ({
  entries: Array.from({ length: puzzle.cells.length }, (_, index) =>
    puzzle.cells[index].isBlock ? "#" : "",
  ),
  puzzle,
  solved: false,
  startedAt: Date.now(),
});

const getDefaultDirection = (puzzle) =>
  getClueForCell(puzzle, puzzle.firstOpenCell, "across") ? "across" : "down";

const createJoinModalState = () => ({
  error: "",
  input: "",
  open: false,
});

const createRoomPin = () => {
  for (;;) {
    const pin = String(
      100000 + Math.floor(Math.random() * 900000),
    ).padStart(ROOM_PIN_LENGTH, "0");

    if (!MULTIPLAYER_ROOMS.has(pin)) {
      return pin;
    }
  }
};

const createRoom = (puzzle) => {
  const room = {
    pin: createRoomPin(),
    sessions: new Set(),
    state: createRoomState(puzzle),
  };
  MULTIPLAYER_ROOMS.set(room.pin, room);
  return room;
};

const resetSessionForPuzzle = (session, status = DEFAULT_STATUS) => {
  const puzzle = session.room?.state.puzzle;

  if (!puzzle) {
    session.direction = "across";
    session.selection = null;
    session.status = status;
    return;
  }

  session.direction = getDefaultDirection(puzzle);
  session.selection = puzzle.firstOpenCell;
  session.status = status;
};

const renderRoom = (room) => {
  for (const session of room.sessions) {
    session.render();
  }
};

const detachSessionFromRoom = (
  session,
  { notifyRemaining = false, remainingMessage = "Partner left the game." } = {},
) => {
  const room = session.room;

  if (!room) {
    return;
  }

  room.sessions.delete(session);
  session.room = null;

  if (room.sessions.size === 0) {
    MULTIPLAYER_ROOMS.delete(room.pin);
    return;
  }

  if (notifyRemaining) {
    for (const remainingSession of room.sessions) {
      remainingSession.status = remainingMessage;
    }
  }

  renderRoom(room);
};

const attachSessionToRoom = (session, room, status = DEFAULT_STATUS) => {
  session.room = room;
  room.sessions.add(session);
  resetSessionForPuzzle(session, status);
};

const getSharedTermSize = (room) => {
  let cols = Infinity;
  let rows = Infinity;

  for (const session of room.sessions) {
    const termSize = getTerminalSize(session.termSize);
    cols = Math.min(cols, termSize.cols);
    rows = Math.min(rows, termSize.rows);
  }

  return {
    cols: Number.isFinite(cols) ? cols : HARD_MIN_COLS,
    rows: Number.isFinite(rows) ? rows : HARD_MIN_ROWS,
  };
};

const ensureRoomForSession = (session) => {
  if (session.room) {
    return true;
  }

  if (!meetsHardMinimum(session.termSize)) {
    session.searchAttempts = 0;
    return false;
  }

  const result = chooseFittingPuzzle(session.termSize);
  session.searchAttempts = result.attempts;

  if (!result.puzzle) {
    return false;
  }

  attachSessionToRoom(session, createRoom(result.puzzle));
  return true;
};

const moveSelection = (session, rowDelta, colDelta) => {
  const puzzle = session.room?.state.puzzle;

  if (!puzzle || session.selection === null) {
    return false;
  }

  const currentCell = getCell(puzzle, session.selection);
  let row = currentCell.row + rowDelta;
  let col = currentCell.col + colDelta;

  while (row >= 0 && row < puzzle.height && col >= 0 && col < puzzle.width) {
    const nextCell = puzzle.cells[row * puzzle.width + col];

    if (!nextCell.isBlock) {
      session.selection = nextCell.index;
      return true;
    }

    row += rowDelta;
    col += colDelta;
  }

  return false;
};

const moveWithinClue = (state, step) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return false;
  }

  const clue = getClueForCell(puzzle, state.selection, state.direction);

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

const getPreferredClueSelection = (state, clue) => {
  if (!clue || clue.cells.length === 0) {
    return state.selection;
  }

  return (
    clue.cells.find((cellIndex) => !state.room.state.entries[cellIndex]) ??
    clue.cells[0]
  );
};

const jumpToAdjacentClue = (state, delta) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return;
  }

  const clues = getCluesForDirection(puzzle, state.direction);
  const activeClue = getClueForCell(puzzle, state.selection, state.direction);

  if (!activeClue) {
    return;
  }

  const activeIndex = clues.findIndex((clue) => clue.id === activeClue.id);

  if (activeIndex === -1) {
    return;
  }

  const nextIndex = (activeIndex + delta + clues.length) % clues.length;
  state.selection = getPreferredClueSelection(state, clues[nextIndex]);
};

const moveToAdjacentClueEdge = (state, delta) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return false;
  }

  const clues = getCluesForDirection(puzzle, state.direction);
  const activeClue = getClueForCell(puzzle, state.selection, state.direction);

  if (!activeClue) {
    return false;
  }

  const activeIndex = clues.findIndex((clue) => clue.id === activeClue.id);

  if (activeIndex === -1) {
    return false;
  }

  const nextIndex = (activeIndex + delta + clues.length) % clues.length;
  const targetClue = clues[nextIndex];

  if (!targetClue) {
    return false;
  }

  state.selection =
    delta < 0
      ? targetClue.cells[targetClue.cells.length - 1]
      : targetClue.cells[0];

  return true;
};

const toggleDirection = (state) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return;
  }

  const nextDirection = state.direction === "across" ? "down" : "across";
  state.selection = findSelectionForDirection(
    puzzle,
    state.selection,
    nextDirection,
  );
  state.direction = getClueForCell(puzzle, state.selection, nextDirection)
    ? nextDirection
    : state.direction;
};

const clearCurrentEntry = (state) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return "none";
  }

  const roomState = state.room.state;
  const cell = getCell(puzzle, state.selection);
  const clue = getClueForCell(puzzle, state.selection, state.direction);

  if (cell.isBlock) {
    return;
  }

  const atClueStart = clue?.cells[0] === cell.index;

  if (atClueStart) {
    if (roomState.entries[cell.index]) {
      roomState.entries[cell.index] = "";
      roomState.solved = false;
    }

    if (moveToAdjacentClueEdge(state, -1)) {
      state.status = "Moved to previous clue.";
      return "moved";
    }

    return "cleared";
  }

  if (roomState.entries[cell.index]) {
    roomState.entries[cell.index] = "";
    roomState.solved = false;
    return "cleared";
  }

  if (moveWithinClue(state, -1)) {
    roomState.entries[state.selection] = "";
    roomState.solved = false;
    return "cleared";
  }

  return "none";
};

const checkSolved = (roomState) =>
  roomState.puzzle.cells.every((cell) => {
    if (cell.isBlock) {
      return true;
    }

    return roomState.entries[cell.index] === cell.solution;
  });

const fillLetter = (state, letter) => {
  const puzzle = state.room?.state.puzzle;

  if (!puzzle || state.selection === null) {
    return;
  }

  const roomState = state.room.state;
  const cell = getCell(puzzle, state.selection);

  if (cell.isBlock) {
    return;
  }

  roomState.entries[cell.index] = letter.toUpperCase();

  if (checkSolved(roomState)) {
    roomState.solved = true;
    const elapsed = formatElapsed(Date.now() - roomState.startedAt);

    for (const session of state.room.sessions) {
      session.status =
        session === state
          ? `Puzzle solved in ${elapsed}.`
          : `Your team solved the puzzle in ${elapsed}.`;
    }

    return;
  }

  if (!moveWithinClue(state, 1)) {
    jumpToAdjacentClue(state, 1);
  }

  state.status =
    "Keep going. Tab advances clues, and space switches direction.";
};

const isCellIncorrect = (state, cell) =>
  Boolean(
    state.checkMode &&
    !cell.isBlock &&
    state.room?.state.entries[cell.index] &&
    state.room.state.entries[cell.index] !== cell.solution,
  );

const getArtForEntry = (entry) => {
  if (!entry) {
    return EMPTY_CELL_ART;
  }

  return LARGE_GLYPHS.get(entry) ?? ["      ", `  ${entry}   `, "      "];
};

const shiftArtRight = (art) =>
  art.map((line) => ` ${line.slice(0, CELL_WIDTH - 1)}`);

const paintCellArt = (art, baseCode, number = null) => {
  const shiftedArt = number ? shiftArtRight(art) : art;

  if (!number) {
    return shiftedArt.map((line) => color(line, baseCode));
  }

  const digits = String(number).slice(0, 2);
  const numberCode = `${baseCode};1;33`;
  const baseReset = ansiStyle(baseCode);

  return shiftedArt.map((line, index) => {
    if (index !== 0) {
      return color(line, baseCode);
    }

    const suffix = line.slice(digits.length);
    return `${color(digits, numberCode, baseReset)}${color(suffix, baseCode)}`;
  });
};

const getPartnerSession = (session) =>
  session.room
    ? Array.from(session.room.sessions).find(
        (otherSession) => otherSession !== session,
      ) ?? null
    : null;

const getCellDisplay = (
  session,
  cell,
  activeClue,
  partnerActiveClue,
  partnerSelection,
) => {
  if (cell.isBlock) {
    return paintCellArt(BLOCK_CELL_ART, "48;5;238");
  }

  const isInActiveClue = activeClue?.cells.includes(cell.index) ?? false;
  const isInPartnerClue = partnerActiveClue?.cells.includes(cell.index) ?? false;
  const isSelected = cell.index === session.selection;
  const isPartnerSelected = cell.index === partnerSelection;
  const entry = session.room.state.entries[cell.index];
  const art = getArtForEntry(entry);
  const isIncorrect = isCellIncorrect(session, cell);
  const foregroundCode = isIncorrect ? "1;38;5;160" : entry ? "1;30" : "2;37";
  const baseCode = isSelected
    ? `${foregroundCode};48;5;226`
    : isPartnerSelected
      ? `${foregroundCode};${PARTNER_SELECTION_BACKGROUND}`
      : isInActiveClue
        ? `${foregroundCode};48;5;153`
      : isInPartnerClue
        ? `${foregroundCode};${PARTNER_CLUE_BACKGROUND}`
        : foregroundCode;

  return paintCellArt(art, baseCode, cell.number);
};

const buildBoardLines = (session) => {
  const puzzle = session.room.state.puzzle;
  const lines = [];
  const partnerSession = getPartnerSession(session);
  const activeClue = getClueForCell(puzzle, session.selection, session.direction);
  const partnerActiveClue = partnerSession
    ? getClueForCell(
        puzzle,
        partnerSession.selection,
        partnerSession.direction,
      )
    : null;
  const innerWidth = puzzle.width * CELL_WIDTH;

  lines.push(color(`┌${"─".repeat(innerWidth)}┐`, "38;5;245"));

  for (let row = 0; row < puzzle.height; row += 1) {
    const rowCells = [];

    for (let col = 0; col < puzzle.width; col += 1) {
      rowCells.push(
        getCellDisplay(
          session,
          puzzle.cells[row * puzzle.width + col],
          activeClue,
          partnerActiveClue,
          partnerSession?.selection ?? null,
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

const buildSelectedClueLines = (state) => {
  const puzzle = state.room.state.puzzle;
  const activeClue = getClueForCell(
    puzzle,
    state.selection,
    state.direction,
  );
  const totalWidth = puzzle.width * CELL_WIDTH + 2;
  const clueLabel = activeClue
    ? `${activeClue.id}. ${activeClue.text}`
    : "No clue selected.";
  const wrappedLines = wrapText(clueLabel, Math.max(1, totalWidth - 2));

  return wrappedLines.map((line) =>
    color(` ${padVisibleEnd(line, totalWidth - 2)} `, "30;48;5;153"),
  );
};

const buildClueWindow = (
  clues,
  activeClue,
  width,
  height,
  activeStyleCode = "1;30;47",
) => {
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
    return clue.id === activeClue?.id
      ? color(`> ${line}`, activeStyleCode)
      : `  ${line}`;
  });
};

const buildPanelLines = (state, panelWidth, termRows) => {
  const { room } = state;
  const { puzzle } = room.state;
  const partnerSession = getPartnerSession(state);
  const headerLines = [
    color(truncateText(puzzle.title, panelWidth), "1;36"),
    truncateText(`${puzzle.author} | ${puzzle.date}`, panelWidth),
    color(truncateText(`Game pin: ${room.pin}`, panelWidth), "1;35"),
    truncateText(`Players: ${room.sessions.size}/${MAX_ROOM_PLAYERS}`, panelWidth),
    truncateText(`Source: ${puzzle.source}`, panelWidth),
    truncateText(puzzle.relativePath, panelWidth),
    "",
  ];

  const presenceLines = [
    color("Multiplayer", "1;33"),
    partnerSession ? "Partner: connected" : "Partner: waiting",
    "Partner: pink clue/cursor",
    "",
  ];

  const controls = [
    "",
    color("Controls", "1;33"),
    "Move:     Arrows",
    "Clear:    Backspace",
    "Join:     =",
    "Next:     Tab",
    "New:      [",
    "Previous: Shift+Tab",
    "Switch:   Space",
    state.checkMode
      ? `Check:    / ${color("(on)", "38;5;240")}`
      : "Check:    /",
  ];
  const statusLines = wrapText(state.status, panelWidth);
  const clueSectionTitles = [color("Across", "1;33"), color("Down", "1;33")];
  const availableClueRows = Math.max(
    6,
    termRows -
      headerLines.length -
      presenceLines.length -
      controls.length -
      statusLines.length -
      clueSectionTitles.length -
      2,
  );
  const clueWindowHeight = Math.max(3, Math.floor(availableClueRows / 2));
  const acrossClue = getClueForCell(puzzle, state.selection, "across");
  const downClue = getClueForCell(puzzle, state.selection, "down");
  const acrossLines = buildClueWindow(
    puzzle.acrossClues,
    acrossClue,
    Math.max(8, panelWidth - 2),
    clueWindowHeight,
    state.direction === "across" ? "30;48;5;153" : "1;30;47",
  );
  const downLines = buildClueWindow(
    puzzle.downClues,
    downClue,
    Math.max(8, panelWidth - 2),
    clueWindowHeight,
    state.direction === "down" ? "30;48;5;153" : "1;30;47",
  );

  return [
    ...headerLines,
    ...presenceLines,
    clueSectionTitles[0],
    ...acrossLines,
    clueSectionTitles[1],
    ...downLines,
    ...controls,
    "",
    color("Status", "1;33"),
    ...statusLines,
  ];
};

const buildJoinModalLines = (session) => {
  const frameCode = "38;5;218";
  const titleCode = "1;30;48;5;218";
  const bodyCode = "38;5;255;48;5;236";
  const innerWidth = JOIN_MODAL_INNER_WIDTH;
  const pinDisplay =
    session.joinModal.input.padEnd(ROOM_PIN_LENGTH, ".").slice(0, ROOM_PIN_LENGTH);
  const message =
    session.joinModal.error || "Enter the 6-digit game pin to join.";

  const padLine = (text) => padVisibleEnd(text, innerWidth);

  return [
    color(`╔${"═".repeat(innerWidth)}╗`, frameCode),
    color(`║${padLine(" Join Multiplayer")}║`, titleCode),
    color(`║${padLine("")}║`, bodyCode),
    color(`║${padLine(` Pin: ${pinDisplay}`)}║`, bodyCode),
    color(`║${padLine("")}║`, bodyCode),
    color(`║${padLine(truncateText(message, innerWidth))}║`, bodyCode),
    color(`║${padLine(" Enter confirms, Esc cancels")}║`, bodyCode),
    color(`╚${"═".repeat(innerWidth)}╝`, frameCode),
  ];
};

const renderJoinModal = (session) => {
  if (!session.joinModal.open) {
    return;
  }

  const lines = buildJoinModalLines(session);
  const { startCol, startRow } = createCenteredLayout(session.termSize, lines);

  lines.forEach((line, index) => {
    safeWrite(
      session.stream,
      `\x1b[${startRow + index};${startCol}H${line}${ansiStyle(0)}`,
    );
  });
};

const renderSession = (session) => {
  const { cols, rows } = getTerminalSize(session.termSize);
  const roomState = session.room?.state ?? null;

  if (!roomState) {
    if (!meetsHardMinimum(session.termSize)) {
      renderCentered(session.stream, session.termSize, [
        "Terminal window is too small for crossword.",
        `Need at least ${HARD_MIN_COLS} columns x ${HARD_MIN_ROWS} rows.`,
        `Current size: ${cols} x ${rows}.`,
        "",
        "Press = to join an existing multiplayer game.",
        "Enlarge the window and I'll try again.",
      ]);
      renderJoinModal(session);
      return;
    }

    renderCentered(session.stream, session.termSize, [
      "Terminal window is too small.",
      `Current size: ${cols} x ${rows}.`,
      "",
      `Checked ${session.searchAttempts} indexed crosswords and couldn't find one that fits.`,
      "Press = to join an existing multiplayer game.",
      "Enlarge the window and I'll try again.",
    ]);
    renderJoinModal(session);
    return;
  }

  if (!puzzleFitsTermSize(roomState.puzzle, session.termSize)) {
    const minimumSize = getMinimumTermSizeForPuzzle(roomState.puzzle);
    const canHavePartner = session.room.sessions.size > 1;

    renderCentered(session.stream, session.termSize, [
      "Terminal window is too small for this crossword.",
      `Need at least ${minimumSize.cols} columns x ${minimumSize.rows} rows.`,
      `Current size: ${cols} x ${rows}.`,
      "",
      canHavePartner
        ? "Press [ to start a new shared game that fits both players."
        : "Press [ to start a new game that fits this window.",
      "Resize the window to keep playing.",
    ]);
    renderJoinModal(session);
    return;
  }

  const boardLines = [
    ...buildBoardLines(session),
    "",
    ...buildSelectedClueLines(session),
  ];
  const boardWidth = boardLines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const panelWidth = Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, cols - boardWidth - PANEL_GAP.length - 2),
  );

  renderCentered(
    session.stream,
    session.termSize,
    joinColumns(boardLines, buildPanelLines(session, panelWidth, rows)),
  );
  renderJoinModal(session);
};

const openJoinModal = (session) => {
  session.joinModal = createJoinModalState();
  session.joinModal.open = true;
};

const closeJoinModal = (session) => {
  session.joinModal = createJoinModalState();
};

const joinRoomByPin = (session, pin) => {
  if (!/^\d{6}$/.test(pin)) {
    return "Enter a 6-digit pin.";
  }

  const room = MULTIPLAYER_ROOMS.get(pin);

  if (!room) {
    return `Game ${pin} was not found.`;
  }

  if (room === session.room) {
    return "You're already in that game.";
  }

  if (room.sessions.size >= MAX_ROOM_PLAYERS) {
    return `Game ${pin} already has ${MAX_ROOM_PLAYERS} players.`;
  }

  detachSessionFromRoom(session, {
    notifyRemaining: true,
    remainingMessage: "Partner left for another game.",
  });
  attachSessionToRoom(session, room, `Joined game ${pin}.`);

  for (const roomSession of room.sessions) {
    if (roomSession !== session) {
      roomSession.status = "Partner joined your game.";
    }
  }

  closeJoinModal(session);
  renderRoom(room);
  return "";
};

const startNewGame = (session) => {
  if (!session.room) {
    return ensureRoomForSession(session);
  }

  const sharedTermSize = getSharedTermSize(session.room);

  if (!meetsHardMinimum(sharedTermSize)) {
    return false;
  }

  const result = chooseFittingPuzzle(sharedTermSize, {
    excludeFilePath: session.room.state.puzzle.filePath,
  });
  session.searchAttempts = result.attempts;

  if (!result.puzzle) {
    return false;
  }

  session.room.state = createRoomState(result.puzzle);

  for (const roomSession of session.room.sessions) {
    resetSessionForPuzzle(
      roomSession,
      roomSession === session
        ? "Loaded a new shared crossword."
        : "Your partner loaded a new shared crossword.",
    );
  }

  renderRoom(session.room);
  return true;
};

const handleJoinModalInput = (session, token) => {
  if (token === "\u001b") {
    closeJoinModal(session);
    renderSession(session);
    return;
  }

  if (token === "\r" || token === "\n") {
    const error = joinRoomByPin(session, session.joinModal.input);

    if (error) {
      session.joinModal.error = error;
      renderSession(session);
    }

    return;
  }

  if (token === "\u007f" || token === "\b" || token === "ESC[3~") {
    session.joinModal.input = session.joinModal.input.slice(0, -1);
    session.joinModal.error = "";
    renderSession(session);
    return;
  }

  if (/^\d$/.test(token) && session.joinModal.input.length < ROOM_PIN_LENGTH) {
    session.joinModal.input += token;
    session.joinModal.error = "";
    renderSession(session);
  }
};

export const createGameSession = ({
  closeConnection,
  stream,
  termSize: initialTermSize,
}) => {
  const session = {
    checkMode: false,
    closeConnection,
    direction: "across",
    joinModal: createJoinModalState(),
    render: () => {},
    room: null,
    searchAttempts: 0,
    selection: null,
    status: DEFAULT_STATUS,
    stream,
    termSize: initialTermSize,
  };

  session.render = () => renderSession(session);

  return {
    start() {
      ensureRoomForSession(session);
      renderSession(session);
    },
    onClose() {
      detachSessionFromRoom(session, { notifyRemaining: true });
    },
    onData(data) {
      const input = data.toString("utf8");

      for (const token of parseInputTokens(input)) {
        if (token === "\u0003") {
          closeConnection(0);
          return;
        }

        if (session.joinModal.open) {
          handleJoinModalInput(session, token);
          continue;
        }

        if (token === "=") {
          openJoinModal(session);
          renderSession(session);
          continue;
        }

        if (token === "[") {
          if (startNewGame(session)) {
            if (!session.room || session.room.sessions.size < 2) {
              renderSession(session);
            }
            continue;
          }

          session.status = session.room?.sessions.size > 1
            ? "No alternate crossword fits both players."
            : "No alternate crossword fits this window.";
          renderSession(session);

          continue;
        }

        if (!session.room) {
          continue;
        }

        if (token === "\t") {
          jumpToAdjacentClue(session, 1);
          renderRoom(session.room);
          continue;
        }

        if (token === "ESC[Z") {
          jumpToAdjacentClue(session, -1);
          renderRoom(session.room);
          continue;
        }

        if (token === " ") {
          toggleDirection(session);
          renderRoom(session.room);
          continue;
        }

        if (token === "/") {
          session.checkMode = !session.checkMode;
          renderSession(session);
          continue;
        }

        if (token === "ESC[A") {
          session.direction = "down";
          moveSelection(session, -1, 0);
          renderRoom(session.room);
          continue;
        }

        if (token === "ESC[B") {
          session.direction = "down";
          moveSelection(session, 1, 0);
          renderRoom(session.room);
          continue;
        }

        if (token === "ESC[C") {
          session.direction = "across";
          moveSelection(session, 0, 1);
          renderRoom(session.room);
          continue;
        }

        if (token === "ESC[D") {
          session.direction = "across";
          moveSelection(session, 0, -1);
          renderRoom(session.room);
          continue;
        }

        if (token === "\u007f" || token === "\b" || token === "ESC[3~") {
          const clearResult = clearCurrentEntry(session);

          if (clearResult === "cleared") {
            session.status = "Entry cleared.";
          }

          renderRoom(session.room);
          continue;
        }

        if (/^[a-z]$/i.test(token) && !session.room.state.solved) {
          fillLetter(session, token);
          renderRoom(session.room);
        }
      }
    },
    onResize(nextTermSize) {
      session.termSize = nextTermSize;

      if (!session.room) {
        ensureRoomForSession(session);
      }

      renderSession(session);
    },
  };
};

export default createGameSession;
