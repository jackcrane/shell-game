export const ANSI = {
  altBuffer: "\x1b[?1049h",
  clear: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  mainBuffer: "\x1b[?1049l",
  reset: "\x1b[0m",
  showCursor: "\x1b[?25h",
};

export const ansiStyle = (code) => `\x1b[${code}m`;

export const safeWrite = (stream, text) => {
  if (!stream || !stream.writable || stream.destroyed) {
    return;
  }

  stream.write(text);
};

export const clearScreen = (stream, styleCode = null) => {
  safeWrite(
    stream,
    `${styleCode ? ansiStyle(styleCode) : ""}${ANSI.clear}${ANSI.home}`,
  );
};

export const enterScreen = (stream) => {
  safeWrite(stream, `${ANSI.altBuffer}${ANSI.hideCursor}`);
};

export const leaveScreen = (stream) => {
  safeWrite(stream, `${ANSI.showCursor}${ANSI.mainBuffer}`);
};

export const color = (text, code, resetCode = ANSI.reset) =>
  `${ansiStyle(code)}${text}${resetCode}`;

export const getTerminalSize = (termSize) => ({
  cols: Math.max(20, termSize?.cols ?? 80),
  rows: Math.max(10, termSize?.rows ?? 24),
});

export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export const getVisibleWidth = (text) => stripAnsi(text).length;

export const parseInputTokens = (chunk) => {
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

export const createCenteredLayout = (termSize, lines) => {
  const { cols, rows } = getTerminalSize(termSize);
  const contentWidth = lines.reduce(
    (max, line) => Math.max(max, getVisibleWidth(line)),
    0,
  );
  const contentHeight = lines.length;

  const startCol = Math.max(1, Math.floor((cols - contentWidth) / 2) + 1);
  const startRow = Math.max(1, Math.floor((rows - contentHeight) / 2) + 1);

  return { startCol, startRow };
};

export const renderCentered = (
  stream,
  termSize,
  lines,
  { lineStyleCode = null, screenStyleCode = null } = {},
) => {
  clearScreen(stream, screenStyleCode);

  const { startCol, startRow } = createCenteredLayout(termSize, lines);
  const linePrefix = lineStyleCode ? ansiStyle(lineStyleCode) : "";

  lines.forEach((line, index) => {
    safeWrite(
      stream,
      `\x1b[${startRow + index};${startCol}H${linePrefix}${line}${ANSI.reset}`,
    );
  });
};
