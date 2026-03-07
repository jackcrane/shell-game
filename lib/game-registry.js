import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const GAMES_DIR = path.resolve(process.cwd(), "games");

const normalizeGameName = (value) => value.trim().toLowerCase();

const isValidGameName = (value) => /^[a-z0-9-]+$/.test(value);

export const getGamesDirectory = () => GAMES_DIR;

export const discoverGameNames = () => {
  if (!fs.existsSync(GAMES_DIR)) {
    return [];
  }

  return fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidGameName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
};

export const loadGameModule = async (gameName) => {
  const normalizedGameName = normalizeGameName(gameName);

  if (!isValidGameName(normalizedGameName)) {
    return null;
  }

  const modulePath = path.join(GAMES_DIR, normalizedGameName, "index.js");

  if (!fs.existsSync(modulePath)) {
    return null;
  }

  const gameModule = await import(pathToFileURL(modulePath).href);
  const createGameSession = gameModule.createGameSession ?? gameModule.default;

  if (typeof createGameSession !== "function") {
    throw new Error(
      `Game "${normalizedGameName}" must export createGameSession().`,
    );
  }

  return {
    createGameSession,
    gameName: normalizedGameName,
    gamePath: path.dirname(modulePath),
    metadata: gameModule.metadata ?? {},
  };
};
