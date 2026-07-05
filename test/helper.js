import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');

export function loadFixture(relativePath) {
  const filePath = path.join(fixturesDir, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
