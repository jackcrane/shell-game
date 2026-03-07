import { readFile, writeFile } from "node:fs/promises";

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

async function updateJsonFile(filePath, updater) {
  const raw = await readFile(filePath, "utf8");
  const json = JSON.parse(raw);
  const changed = updater(json);

  if (!changed) {
    return false;
  }

  await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

export async function bumpVersion() {
  const packageRaw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const packageJson = JSON.parse(packageRaw);
  const nextVersion = bumpPatch(packageJson.version);

  await updateJsonFile(new URL("../package.json", import.meta.url), (json) => {
    json.version = nextVersion;
    return true;
  });

  await updateJsonFile(new URL("../package-lock.json", import.meta.url), (json) => {
    let changed = false;

    if (json.version !== nextVersion) {
      json.version = nextVersion;
      changed = true;
    }

    if (json.packages?.[""]?.version !== nextVersion) {
      json.packages[""].version = nextVersion;
      changed = true;
    }

    return changed;
  });

  return nextVersion;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nextVersion = await bumpVersion();
  console.log(nextVersion);
}
