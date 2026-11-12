import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = resolve(
  process.env.ACCEPTANCE_OUTPUT_DIR ??
    join(root, "acceptance-evidence", "runs", stamp),
);
const baseUrl = process.env.E2E_BASE_URL;
const systemVersion = process.env.ACCEPTANCE_SYSTEM_VERSION;
const operator = process.env.ACCEPTANCE_OPERATOR;
const e2eEmail = process.env.E2E_EMAIL;
const e2ePassword = process.env.E2E_PASSWORD;

if (!baseUrl) {
  console.error(
    "E2E_BASE_URL måste vara acceptansmiljöns publicerade HTTPS-URL.",
  );
  process.exit(2);
}
if (!baseUrl.startsWith("https://") || baseUrl.includes(".replit.dev")) {
  console.error(
    "E2E_BASE_URL måste vara en publicerad HTTPS-URL, aldrig en utvecklings-URL.",
  );
  process.exit(2);
}
if (!systemVersion || !operator) {
  console.error(
    "ACCEPTANCE_SYSTEM_VERSION och ACCEPTANCE_OPERATOR måste anges för spårbar evidens.",
  );
  process.exit(2);
}
if (!e2eEmail || !e2ePassword) {
  console.error(
    "E2E_EMAIL och E2E_PASSWORD måste anges explicit för webbacceptansen.",
  );
  process.exit(2);
}

mkdirSync(runDir, { recursive: true });
cpSync(join(root, "docs", "customer-acceptance"), join(runDir, "protocols"), {
  recursive: true,
});
mkdirSync(join(runDir, "attachments"), { recursive: true });
writeFileSync(
  join(runDir, "attachments", "README.txt"),
  "Lägg endast versionsbundna skärmbilder och exportfiler här. Registrera dem i protocols/attachment-index.csv. Inga hemligheter eller personuppgifter.\n",
);
const metadata = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  baseUrl,
  systemVersion,
  windowsVersion: process.env.ACCEPTANCE_WINDOWS_VERSION ?? "EJ_VERIFIERAD",
  operator,
  commands: [],
};

function readJunitSummary(file) {
  if (!existsSync(file)) {
    return { tests: 0, failures: 0, errors: 1, skipped: 0, valid: false };
  }
  const xml = readFileSync(file, "utf8");
  const root =
    xml.match(/<testsuites\b([^>]*)>/) ?? xml.match(/<testsuite\b([^>]*)>/);
  if (!root) {
    return { tests: 0, failures: 0, errors: 1, skipped: 0, valid: false };
  }
  const numberAttribute = (name) => {
    const match = root[1].match(new RegExp(`\\b${name}="(\\d+)"`));
    return match ? Number.parseInt(match[1], 10) : 0;
  };
  return {
    tests: numberAttribute("tests"),
    failures: numberAttribute("failures"),
    errors: numberAttribute("errors"),
    skipped: numberAttribute("skipped"),
    valid: true,
  };
}

function run(name, command, args, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const logPath = join(runDir, `${name}.log`);
    const log = createWriteStream(logPath);
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      log.write(`Kunde inte starta kommandot: ${error.message}\n`);
    });
    child.stdout.on("data", (chunk) => log.write(chunk));
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("close", (exitCode) => {
      log.end(() => {
        metadata.commands.push({
          name,
          command: [command, ...args].join(" "),
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          log: relative(runDir, logPath),
        });
        resolveRun(exitCode ?? 1);
      });
    });
  });
}

const steps = [
  [
    "web-main-flows",
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "e2e/import-entrypoints.spec.ts",
      "e2e/planner-route-adjustments.spec.ts",
      "e2e/dispatch-assignment.spec.ts",
      "e2e/dispatch-resize.spec.ts",
    ],
    { ACCEPTANCE_EVIDENCE_DIR: runDir },
  ],
  ["ten-driver-planning", "pnpm", ["run", "test:acceptance:ten-drivers"], {}],
  ["tenant-isolation", "pnpm", ["run", "test:tenant-isolation"], {}],
  [
    "mobile-production-export",
    "pnpm",
    ["--filter", "@workspace/driver-app", "run", "validate:production-export"],
    {},
  ],
];

let failed = false;
for (const [name, command, args, env] of steps) {
  const exitCode = await run(name, command, args, env);
  if (exitCode !== 0) failed = true;
  if (name === "web-main-flows") {
    metadata.webTestSummary = readJunitSummary(
      join(runDir, "playwright-junit.xml"),
    );
    const summary = metadata.webTestSummary;
    if (
      !summary.valid ||
      summary.tests < 6 ||
      summary.failures > 0 ||
      summary.errors > 0 ||
      summary.skipped > 0
    ) {
      failed = true;
      console.error(
        `Webbacceptansen underkänd: ${summary.tests} tester, ${summary.failures} fel, ${summary.errors} rapportfel, ${summary.skipped} skippade.`,
      );
    }
  }
}

metadata.finishedAt = new Date().toISOString();
metadata.automatedResult = failed ? "UNDERKÄND" : "GODKÄND";
metadata.externalSignOff = {
  isolatedEnvironmentAndRestore: "KRÄVER_MANUELLT_PROTOKOLL",
  windowsChrome: "KRÄVER_MANUELLT_PROTOKOLL",
  windowsEdge: "KRÄVER_MANUELLT_PROTOKOLL",
  physicalAndroid: "KRÄVER_MANUELLT_PROTOKOLL",
  physicalIPhone: "KRÄVER_MANUELLT_PROTOKOLL",
};
writeFileSync(
  join(runDir, "run-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (!path.endsWith("SHA256SUMS")) files.push(path);
  }
}
walk(runDir);
const sums = files
  .sort()
  .map(
    (file) =>
      `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${relative(runDir, file)}`,
  )
  .join("\n");
writeFileSync(join(runDir, "SHA256SUMS"), `${sums}\n`);
console.log(`\nBevispaket: ${relative(root, runDir)}`);
process.exit(failed ? 1 : 0);
