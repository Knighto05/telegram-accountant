import fs from "node:fs";
import "dotenv/config";

const src = process.env.ACCOUNTANT_DB_PATH ?? "./data/accountant.db";
if (!fs.existsSync(src)) {
  console.error(`no database at ${src} — nothing to back up`);
  process.exit(1);
}
const dest = `${src}.${new Date().toISOString().slice(0, 10)}.bak`;
fs.copyFileSync(src, dest);
console.log(`backup written: ${dest}`);
