/**
 * Turn a downloaded service-account JSON into the exact values a hosting
 * panel needs, without any of them passing through a chat window or a
 * terminal scrollback.
 *
 *   node scripts/google-env.mjs [path-to-service-account.json]
 *
 * Writes _reference/panel-values.txt (gitignored) with one KEY=value per
 * line, ready to copy into the panel. Prints only lengths and fingerprints,
 * never the key itself.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const source = process.argv[2] ?? "_reference/service-account.json";

if (!existsSync(source)) {
  console.error(`\n  Not found: ${source}`);
  console.error("  Download the service account JSON key and save it there.\n");
  process.exit(1);
}

let key;
try {
  key = JSON.parse(readFileSync(source, "utf8"));
} catch (error) {
  console.error(`\n  ${source} is not valid JSON: ${error.message}\n`);
  process.exit(1);
}

for (const field of ["client_email", "private_key", "project_id"]) {
  if (typeof key[field] !== "string" || key[field].length === 0) {
    console.error(`\n  ${source} has no "${field}". Is it a service account key?\n`);
    process.exit(1);
  }
}

const pem = key.private_key;
if (!pem.includes("-----BEGIN PRIVATE KEY-----") || !pem.includes("-----END PRIVATE KEY-----")) {
  console.error("\n  The private_key is missing its BEGIN/END lines. Use the value");
  console.error("  straight out of the JSON, not just the base64 in the middle.\n");
  process.exit(1);
}

// Panels take one line, so the newlines are escaped. The app turns them back.
const oneLine = pem.replace(/\r?\n/g, "\\n");

const out = [
  `GOOGLE_SERVICE_ACCOUNT_EMAIL=${key.client_email}`,
  `GOOGLE_PRIVATE_KEY=${oneLine}`,
].join("\n") + "\n";

const target = path.join("_reference", "panel-values.txt");
writeFileSync(target, out);

const fingerprint = createHash("sha256").update(pem).digest("hex").slice(0, 16);

console.log("");
console.log(`  Wrote ${target}`);
console.log("");
console.log(`  project        ${key.project_id}`);
console.log(`  service account ${key.client_email}`);
console.log(`  PEM lines      ${pem.split("\n").filter(Boolean).length} (28 is normal)`);
console.log(`  one-line value ${oneLine.length} chars`);
console.log(`  fingerprint    ${fingerprint}`);
console.log("");
console.log("  Open that file and copy the two values into the hosting panel.");
console.log("  Paste GOOGLE_PRIVATE_KEY WITHOUT adding quotes around it.");
console.log("");
