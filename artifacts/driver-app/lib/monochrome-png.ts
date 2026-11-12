// Binary-only PNG encoding: no Buffer, TextEncoder, TextDecoder, DOM or native
// module. A one-bit grayscale image is sufficient for a black/white signature.
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) chunk[index + 4] = type.charCodeAt(index);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < data.length + 8; index++) {
    crc = crcTable[(crc ^ chunk[index]) & 255] ^ (crc >>> 8);
  }
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

function storedZlib(data: Uint8Array): Uint8Array {
  // RFC 1950 header + byte-aligned, uncompressed DEFLATE blocks (RFC 1951).
  const blocks = Math.ceil(data.length / 65535);
  const result = new Uint8Array(2 + blocks * 5 + data.length + 4);
  result.set([0x78, 0x01]);
  let offset = 2;
  let sum1 = 1;
  let sum2 = 0;
  for (let start = 0; start < data.length; start += 65535) {
    const length = Math.min(65535, data.length - start);
    const inverse = (~length) & 0xffff;
    result[offset++] = start + length === data.length ? 1 : 0;
    result[offset++] = length & 255;
    result[offset++] = length >>> 8;
    result[offset++] = inverse & 255;
    result[offset++] = inverse >>> 8;
    result.set(data.subarray(start, start + length), offset);
    offset += length;
    for (let index = start; index < start + length; index++) {
      sum1 = (sum1 + data[index]) % 65521;
      sum2 = (sum2 + sum1) % 65521;
    }
  }
  new DataView(result.buffer).setUint32(offset, ((sum2 << 16) | sum1) >>> 0);
  return result;
}

export function encodeMonochromePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 1024 || height > 1024
    || pixels.length !== width * height) {
    throw new Error("PNG_DIMENSIONS_INVALID");
  }
  const rowBytes = Math.ceil(width / 8);
  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    // The first byte of every scanline is PNG filter type 0.
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] !== 0) {
        scanlines[y * (rowBytes + 1) + 1 + (x >>> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 1; // one-bit depth; grayscale color type 0
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", storedZlib(scanlines)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
