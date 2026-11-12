import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class PlatformMfaUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "PLATFORM_MFA_UNAVAILABLE";
  constructor() {
    super("Tvåstegsverifieringen är tillfälligt otillgänglig. Kontakta Traivos administratör för att kontrollera den säkra krypteringsnyckeln.");
  }
}

export function platformMfaKey(): Buffer {
  const raw = process.env.PLATFORM_MFA_ENCRYPTION_KEY;
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw)) {
    throw new PlatformMfaUnavailableError();
  }
  return Buffer.from(raw, "hex");
}

export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", platformMfaKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptMfaSecret(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 29) throw new Error("Invalid MFA ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", platformMfaKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newMfaSecret(): string {
  return Array.from(randomBytes(32), (byte) => alphabet[byte & 31]).join("");
}

function decodeBase32(value: string): Buffer {
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const letter of value) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error("Invalid MFA secret");
    acc = (acc << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 255);
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

export function matchingTotpStep(secret: string, code: string, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(12).toString("hex").toUpperCase());
}