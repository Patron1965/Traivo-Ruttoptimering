import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const generatedApi = path.resolve(packageDirectory, "..", "api-zod", "src", "generated", "api.ts");
const zodIndex = path.resolve(packageDirectory, "..", "api-zod", "src", "index.ts");

// PostgreSQL accepts UUID-shaped identifiers without RFC version/variant bits.
// Keep the existing Zod 3 contract, including historical IDs, on Zod 4.
// GUID still enforces the complete hexadecimal 8-4-4-4-12 representation.
const source = await readFile(generatedApi, "utf8");
await writeFile(generatedApi, source.replaceAll("zod.uuid()", "zod.guid()"), "utf8");
await writeFile(zodIndex, 'export * from "./generated/api";\n', "utf8");