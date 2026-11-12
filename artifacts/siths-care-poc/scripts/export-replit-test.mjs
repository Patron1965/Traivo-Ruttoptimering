import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifact = "artifacts/siths-care-poc";
const sourceId = process.env.REPL_ID;
if (!sourceId) throw new Error("The originating Replit project ID is required for the isolation guard");
const destination = path.join(root, "generated-artifacts/region-stockholm-replit-test.zip");
const temporaryArchive = `${destination}.${randomUUID()}.zip`;
const stage = await mkdtemp(path.join(os.tmpdir(), "siths-replit-export-"));
const forbidden = new Set(["node_modules", "dist", ".env", ".git", ".replit-artifact"]);
const pkg = JSON.parse(await readFile(path.join(root, artifact, "package.json"), "utf8"));
const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
try {
  // Explicit allowlist: no database, main API, main app, uploads, memory or secrets.
  for (const relative of [
    `${artifact}/src`, `${artifact}/server`, `${artifact}/public`, `${artifact}/docs`,
    `${artifact}/index.html`, `${artifact}/vite.config.ts`, `${artifact}/tsconfig.json`,
    `${artifact}/README.md`, "lib/api-client-react/src", "lib/api-client-react/package.json",
    "lib/api-client-react/tsconfig.json", "tsconfig.base.json", "pnpm-workspace.yaml",
  ]) {
    await cp(path.join(root, relative), path.join(stage, relative), {
      recursive: true,
      filter: (source) => !forbidden.has(path.basename(source)) && !path.basename(source).startsWith(".env"),
    });
  }
  await mkdir(path.join(stage, artifact, "scripts"), { recursive: true });
  await cp(path.join(root, artifact, "scripts/export-replit-test.mjs"), path.join(stage, artifact, "scripts/export-replit-test.mjs"));
  await writeFile(path.join(stage, artifact, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(path.join(stage, artifact, "server/standalone-isolation.ts"),
    `// Originating shared project: this app must run in a DIFFERENT project.\nexport const SOURCE_PROJECT_ID: string | null = ${JSON.stringify(sourceId)};\n`);
  await writeFile(path.join(stage, "package.json"), JSON.stringify({
    name: "region-stockholm-federation-test", private: true,
    packageManager: rootPkg.packageManager || "pnpm@10.26.1",
    scripts: {
      dev: `pnpm --filter @workspace/siths-care-poc run dev`,
      build: `pnpm run typecheck && pnpm --filter @workspace/siths-care-poc run build`,
      start: `pnpm --filter @workspace/siths-care-poc run serve`,
      test: `pnpm --filter @workspace/siths-care-poc run test`,
      typecheck: `tsc -b lib/api-client-react && pnpm --filter @workspace/siths-care-poc run typecheck`,
    },
    devDependencies: { typescript: rootPkg.devDependencies.typescript },
    ...(rootPkg.pnpm ? { pnpm: rootPkg.pnpm } : {}),
  }, null, 2) + "\n");
  await writeFile(path.join(stage, ".replit"), `run = "pnpm run dev"
modules = ["nodejs-22"]

[env]
PORT = "3000"
BASE_PATH = "/"

[deployment]
build = ["sh", "-c", "pnpm install --frozen-lockfile && pnpm run build"]
run = ["sh", "-c", "pnpm run start"]
deploymentTarget = "autoscale"

[[ports]]
localPort = 3000
externalPort = 80
`);
  await writeFile(path.join(stage, ".gitignore"), "node_modules/\n**/dist/\n.env*\n*.tsbuildinfo\n");
  await cp(path.join(root, artifact, "docs/replit-test.md"), path.join(stage, "README.md"));
  // Generate a lockfile for the trimmed workspace rather than shipping main-app importers.
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: stage, stdio: "inherit" });
  if (process.argv.includes("--verify")) {
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: stage, stdio: "inherit" });
    const env = { ...process.env, PORT: "3000", BASE_PATH: "/" };
    execFileSync("pnpm", ["run", "build"], { cwd: stage, env, stdio: "inherit" });
    execFileSync("pnpm", ["run", "test"], { cwd: stage, env, stdio: "inherit" });
  }
  // Exclude verification output, installed modules and declaration build products.
  await rm(path.join(stage, "node_modules"), { recursive: true, force: true });
  for (const relative of [artifact, "lib/api-client-react"]) {
    await rm(path.join(stage, relative, "node_modules"), { recursive: true, force: true });
    await rm(path.join(stage, relative, "dist"), { recursive: true, force: true });
    await rm(path.join(stage, relative, "tsconfig.tsbuildinfo"), { force: true });
  }
  await mkdir(path.dirname(destination), { recursive: true });
  execFileSync("zip", ["-qr", temporaryArchive, "."], { cwd: stage, stdio: "inherit" });
  const { size } = await stat(temporaryArchive);
  if (size === 0) throw new Error("The exported ZIP archive is empty");
  execFileSync("unzip", ["-tqq", temporaryArchive], { stdio: "inherit" });
  // Only replace the delivery file once a complete, valid archive exists.
  await rename(temporaryArchive, destination);
  console.log(`Standalone source package created: generated-artifacts/region-stockholm-replit-test.zip (${size} bytes; ZIP integrity verified)`);
} finally {
  await rm(temporaryArchive, { force: true });
  await rm(stage, { recursive: true, force: true });
}
