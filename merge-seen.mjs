// Merges this run's new-guids.json into seen.json as a JSON-level set union, and nothing
// else — it does no git operations itself. It relies on the caller (the workflow) having
// already fetched origin/main and hard-reset the working tree to it immediately beforehand,
// so the seen.json this script reads is guaranteed to be the true latest committed version,
// not a stale local copy. That's what makes the union deterministic and safe to re-run: two
// runs merging against the same starting point and then racing to push will each produce a
// correct superset, and the loser of the push race just retries with the freshly-fetched
// state instead of ever asking git to reconcile two diverging copies of the file.
import fs from 'fs';
import path from 'path';

const SEEN_PATH = path.join(process.cwd(), 'seen.json');
const NEW_GUIDS_PATH = path.join(process.cwd(), 'new-guids.json');
const MAX_SEEN = 5000;

function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const currentSeen = readJsonArray(SEEN_PATH);
const newGuids = readJsonArray(NEW_GUIDS_PATH);

const merged = Array.from(new Set([...currentSeen, ...newGuids]));
const trimmed = merged.slice(Math.max(0, merged.length - MAX_SEEN));

fs.writeFileSync(SEEN_PATH, JSON.stringify(trimmed, null, 2));
console.log(`seen.json merge: ${currentSeen.length} existing + ${newGuids.length} new -> ${trimmed.length} after union/trim.`);
