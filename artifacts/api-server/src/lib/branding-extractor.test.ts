import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  assertPublicUrl,
  BrandingFetchError,
  extractBranding,
  fetchPublicResource,
  isPublicAddress,
  normalizeBrandingColor,
  requestOnceForTests,
  type ResolvedPublicAddress,
} from "./branding-extractor";
import { validateAndScanImage } from "./file-scan";

let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(Buffer.alloc(1024, 0x41));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://example.test:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("SSRF validation rejects private, mapped, documentation, credentials, and unsafe ports", async () => {
  for (const value of [
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://192.0.2.10/",
    "http://localhost/",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
  ]) {
    await assert.rejects(assertPublicUrl(value), BrandingFetchError, value);
  }
});

test("IPv6 normalization rejects compatible, translated, and non-global ranges", () => {
  for (const value of [
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "::c0a8:101", // IPv4-compatible 192.168.1.1
    "::192.168.1.1", // dotted IPv4-compatible spelling
    "::ffff:7f00:1", // IPv4-mapped hexadecimal spelling
    "64:ff9b::c000:201", // NAT64 well-known prefix
    "64:ff9b:1::c000:201", // NAT64 local-use prefix
    "2002:c000:0201::", // 6to4
    "2001:0000::1", // Teredo
    "2001:db8::1", // documentation
    "fc00::1", // unique-local
    "fe80::1", // link-local
  ]) {
    assert.equal(isPublicAddress(value), false, value);
  }
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("the real HTTP transport pins connections to the resolved address", async () => {
  const port = new URL(baseUrl).port;
  const response = await requestOnceForTests(
    new URL(`http://unresolvable-public-name.test:${port}/pinned`),
    [{ address: "127.0.0.1", family: 4 }],
    2_048,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 1_024);
});

test("bounded transport rejects oversized responses", async () => {
  await assert.rejects(
    requestOnceForTests(
      new URL(`${baseUrl}/too-large`),
      [{ address: "127.0.0.1", family: 4 }],
      32,
    ),
    (error: unknown) => error instanceof BrandingFetchError && error.statusCode === 413,
  );
});

test("absolute resource deadline aborts a slow transport", async () => {
  let aborted = false;
  await assert.rejects(
    fetchPublicResource(
      "https://branding.example/slow",
      { maxBytes: 1024 },
      {
        timeoutMs: 25,
        resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async (_url, _addresses, _maxBytes, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
      },
    ),
    (error: unknown) => error instanceof BrandingFetchError && error.statusCode === 504,
  );
  assert.equal(aborted, true);
});

test("absolute resource deadline includes DNS resolution", async () => {
  let aborted = false;
  await assert.rejects(
    fetchPublicResource(
      "https://branding.example/dns",
      { maxBytes: 1024 },
      {
        timeoutMs: 25,
        resolveAddresses: async (_url, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
      },
    ),
    (error: unknown) => error instanceof BrandingFetchError && error.statusCode === 504,
  );
  assert.equal(aborted, true);
});

test("logo candidate validation caps rejected attempts before accepting candidates", async () => {
  let candidateResolutions = 0;
  const rejectedUrls = Array.from({ length: 50 }, (_, index) => `https://private.example/logo-${index}.png`);
  const html = rejectedUrls.map((url) => `<img src="${url}">`).join("");
  const result = await extractBranding(
    "https://branding.example/page",
    {
      timeoutMs: 1_000,
      overallTimeoutMs: 1_000,
      resolveAddresses: async (url) => {
        if (url.hostname === "private.example") {
          candidateResolutions += 1;
          throw new BrandingFetchError("private candidate", 400);
        }
        return [{ address: "93.184.216.34", family: 4 }];
      },
      request: async () => ({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(html),
      }),
    },
  );
  assert.equal(result.logos.length, 0);
  assert.equal(candidateResolutions, 12);
});

test("extracted numeric CSS colors normalize to schema-safe hex", () => {
  assert.equal(normalizeBrandingColor("rgb(255, 0, 128)"), "#ff0080");
  assert.equal(normalizeBrandingColor("rgba(0, 0, 0, 0.5)"), "#808080");
  assert.equal(normalizeBrandingColor("hsl(120, 100%, 50%)"), "#00ff00");
  assert.equal(normalizeBrandingColor("hsla(240 100% 50% / 0)"), "#ffffff");
  assert.equal(normalizeBrandingColor("rgb(not-a-color)"), null);
});

test("safe fetch follows at most three redirects and revalidates every target", async () => {
  const publicAddress: ResolvedPublicAddress = { address: "93.184.216.34", family: 4 };
  const resolveAddresses = async (url: URL) => {
    if (url.hostname === "127.0.0.1") {
      await assertPublicUrl(url.toString());
    }
    return [publicAddress];
  };
  const redirects = new Map([
    ["/start", { statusCode: 302, location: "/one" }],
    ["/one", { statusCode: 302, location: "/two" }],
    ["/two", { statusCode: 302, location: "/final" }],
    ["/final", { statusCode: 200 }],
  ]);

  const result = await fetchPublicResource(
    "https://branding.example/start",
    { maxBytes: 1024, acceptedContentTypes: ["text/html"] },
    {
      resolveAddresses,
      request: async (url, addresses) => {
        assert.deepEqual(addresses, [publicAddress]);
        const target = redirects.get(url.pathname);
        assert.ok(target);
        return {
          statusCode: target.statusCode,
          headers: target.statusCode === 200
            ? { "content-type": "text/html; charset=utf-8" }
            : { location: target.location },
          body: target.statusCode === 200 ? Buffer.from("<html/>") : Buffer.alloc(0),
        };
      },
    },
  );
  assert.equal(result.finalUrl, "https://branding.example/final");

  await assert.rejects(
    fetchPublicResource(
      "https://branding.example/start",
      { maxBytes: 1024 },
      {
        resolveAddresses,
        request: async (url) => ({
          statusCode: 302,
          headers: { location: url.pathname === "/start" ? "/one" : "/two" },
          body: Buffer.alloc(0),
        }),
      },
    ),
    (error: unknown) => error instanceof BrandingFetchError && /too many redirects/i.test(error.message),
  );

  await assert.rejects(
    fetchPublicResource(
      "https://branding.example/start",
      { maxBytes: 1024 },
      {
        resolveAddresses,
        request: async () => ({
          statusCode: 302,
          headers: { location: "http://127.0.0.1/private" },
          body: Buffer.alloc(0),
        }),
      },
    ),
    BrandingFetchError,
  );
});

test("raster validation trusts magic bytes and rejects mismatches and polyglots", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.deepEqual(validateAndScanImage({ buffer: png, declaredType: "image/png" }), {
    ok: true,
    contentType: "image/png",
  });
  assert.equal(validateAndScanImage({ buffer: png, declaredType: "image/jpeg" }).ok, false);
  assert.equal(
    validateAndScanImage({
      buffer: Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]),
      declaredType: "image/png",
    }).ok,
    false,
  );
  assert.equal(
    validateAndScanImage({ buffer: Buffer.concat([png, Buffer.alloc(64)]), maxBytes: 16 }).ok,
    false,
  );
});