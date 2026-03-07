export const ANSI = {
  altBuffer: "\x1b[?1049h",
  clear: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  mainBuffer: "\x1b[?1049l",
  reset: "\x1b[0m",
  showCursor: "\x1b[?25h",
};

export const safeWrite = (stream, text) => {
  if (!stream || !stream.writable || stream.destroyed) {
    return;
  }

  stream.write(text);
};

export const clearScreen = (stream) => {
  safeWrite(stream, `${ANSI.clear}${ANSI.home}`);
};

export const enterScreen = (stream) => {
  safeWrite(stream, `${ANSI.altBuffer}${ANSI.hideCursor}`);
};

export const leaveScreen = (stream) => {
  safeWrite(stream, `${ANSI.showCursor}${ANSI.mainBuffer}`);
};

export const color = (text, code) => `\x1b[${code}m${text}${ANSI.reset}`;

export const getTerminalSize = (termSize) => ({
  cols: Math.max(20, termSize?.cols ?? 80),
  rows: Math.max(10, termSize?.rows ?? 24),
});

export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export const getVisibleWidth = (text) => stripAnsi(text).length;

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

export const renderCentered = (stream, termSize, lines) => {
  clearScreen(stream);

  const { startCol, startRow } = createCenteredLayout(termSize, lines);

  lines.forEach((line, index) => {
    safeWrite(stream, `\x1b[${startRow + index};${startCol}H${line}`);
  });
};
