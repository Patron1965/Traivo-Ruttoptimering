import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { decode } from "fast-png";
import { signaturePngDataUrl } from "./signature-image.ts";
import { validateAndScanImage } from "../../api-server/src/lib/file-scan.ts";

function decodeSignature(bytes) {
  const image = decode(bytes, { checkCrc: true });
  assert.equal(image.depth, 1);
  assert.equal(image.channels, 1);
  const rowBytes = Math.ceil(image.width / 8);
  assert.equal(image.data.length, rowBytes * image.height);
  // fast-png returns one-bit images packed; independently expand the decoded
  // rows for pixel assertions, including padding for non-byte-aligned widths.
  const data = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const bit = (image.data[y * rowBytes + (x >>> 3)] >>> (7 - (x & 7))) & 1;
      data[y * image.width + x] = bit ? 255 : 0;
    }
  }
  return { ...image, data };
}

test("signature exports a valid raster PNG accepted by the server scanner", () => {
  const uri = signaturePngDataUrl([[{ x: 10, y: 20 }, { x: 100, y: 70 }]]);
  assert.ok(uri.startsWith("data:image/png;base64,"));
  const bytes = Buffer.from(uri.split(",")[1], "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const scan = validateAndScanImage({ buffer: bytes });
  assert.equal(scan.ok, true);
  const image = decodeSignature(bytes);
  assert.equal(image.width, 300);
  assert.equal(image.height, 200);
  assert.ok(image.data.some((pixel) => pixel === 0));
  assert.equal(image.data[0], 255);
});

test("signature preserves separate strokes and the full measured pad width", () => {
  const bytes = Buffer.from(signaturePngDataUrl([
    [{ x: 350, y: 50 }, { x: 380, y: 50 }],
    [{ x: 10, y: 100 }, { x: 20, y: 100 }],
  ], 400, 200).split(",")[1], "base64");
  const image = decodeSignature(bytes);
  assert.equal(image.width, 400);
  assert.equal(image.data[50 * 400 + 365], 0);
  assert.equal(image.data[100 * 400 + 15], 0);
  assert.equal(image.data[75 * 400 + 195], 255);
});

test("signature rejects blank, nonfinite or oversized input", () => {
  assert.throws(() => signaturePngDataUrl([]), /POINTS_INVALID/);
  assert.throws(() => signaturePngDataUrl([[{ x: 1, y: 2 }]]), /POINTS_INVALID/);
  assert.throws(() => signaturePngDataUrl([[{ x: NaN, y: 0 }, { x: 1, y: 1 }]]), /POINTS_INVALID/);
  assert.throws(() => signaturePngDataUrl([[{ x: 1, y: 1 }, { x: 2, y: 2 }]], 10_000), /DIMENSIONS_INVALID/);
});

test("signature loads and encodes in a fresh runtime without any text encoding APIs or Buffer", () => {
  const moduleUrl = new URL("./signature-image.ts", import.meta.url).href;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    globalThis.TextDecoder = class { constructor() { throw new Error("Unsupported encoding in mobile runtime"); } };
    globalThis.TextEncoder = undefined;
    globalThis.Buffer = undefined;
    const { signaturePngDataUrl } = await import(${JSON.stringify(moduleUrl)});
    console.log(signaturePngDataUrl([[{ x: 1, y: 1 }, { x: 9, y: 9 }]], 17, 13));
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const uri = run.stdout.trim();
  const bytes = Buffer.from(uri.split(",")[1], "base64");
  assert.equal(validateAndScanImage({ buffer: bytes }).ok, true);
  const image = decodeSignature(bytes);
  assert.equal(image.width, 17);
  assert.equal(image.height, 13);
  assert.ok(image.data.some((pixel) => pixel === 0));
});

test("maximum-size signature has valid CRCs and crosses stored-DEFLATE block boundaries", () => {
  const uri = signaturePngDataUrl([[{ x: 0, y: 0 }, { x: 1023, y: 1023 }]], 1024, 1024);
  const bytes = Buffer.from(uri.split(",")[1], "base64");
  assert.ok(bytes.length < 140000, "one-bit packing keeps offline payloads bounded");
  assert.equal(validateAndScanImage({ buffer: bytes }).ok, true);
  const image = decodeSignature(bytes);
  assert.equal(image.width, 1024);
  assert.equal(image.height, 1024);
  assert.equal(image.data[512 * 1024 + 512], 0);
});
