import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.ts";
import { IdTokenVerifier, OidcClient } from "./oidc.ts";
import { AuthStores } from "./store.ts";
import { SecurityError } from "./security.ts";

const issuer = "https://federation-acc.sll.se/adfs";
const originalFetch = globalThis.fetch;

function regionConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    BASE_PATH: "/siths-care-poc/",
    SITHS_OIDC_PROFILE: "region-stockholm-test",
    SITHS_OIDC_ISSUER: issuer,
    SITHS_OIDC_CLIENT_ID: "synthetic-region-client",
    SITHS_OIDC_REDIRECT_URI: "https://test.example/siths-care-poc/api/siths/callback",
    // These are synthetic test contracts, not claims confirmed by the region.
    SITHS_OIDC_HSA_ID_CLAIM: "synthetic_hsa",
    SITHS_OIDC_LOA_CLAIM: "synthetic_acr",
    SITHS_OIDC_ACCEPTED_LOA_VALUES: "synthetic_siths_loa",
    SITHS_OIDC_ASSIGNMENTS_CLAIM: "synthetic_assignments",
    ...overrides,
  });
}

function discovery(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize/`,
    token_endpoint: `${issuer}/oauth2/token/`,
    jwks_uri: `${issuer}/discovery/keys`,
    ...overrides,
  }), { headers: { "Content-Type": "application/json" } });
}

test.afterEach(() => { globalThis.fetch = originalFetch; });

test("Region Stockholm test profile pins its issuer and disables the synthetic login harness", () => {
  const config = regionConfig({ SITHS_DEV_HARNESS: "true" });
  assert.equal(config.oidcProfile, "region-stockholm-test");
  assert.equal(config.oidcIssuer, issuer);
  assert.deepEqual(config.allowedMetadataOrigins, ["https://federation-acc.sll.se"]);
  assert.equal(config.devHarnessEnabled, false);
});

test("Region Stockholm test rejects other issuers and metadata origins", () => {
  for (const other of [
    "https://federation.sll.se/adfs",
    "https://federation-acc.sll.se/adfs/",
    "https://other.example/adfs",
  ]) {
    assert.throws(() => regionConfig({ SITHS_OIDC_ISSUER: other }), /exact test issuer/);
  }
  assert.throws(() => regionConfig({
    SITHS_OIDC_ALLOWED_METADATA_ORIGINS: "https://federation-acc.sll.se,https://other.example",
  }), /approved IdP origin/);
});

test("Region Stockholm test requires explicit identity and assurance claim agreements", () => {
  for (const name of [
    "SITHS_OIDC_HSA_ID_CLAIM",
    "SITHS_OIDC_LOA_CLAIM",
    "SITHS_OIDC_ACCEPTED_LOA_VALUES",
    "SITHS_OIDC_ASSIGNMENTS_CLAIM",
  ]) {
    assert.throws(() => regionConfig({ [name]: "" }), /explicitly agreed/);
  }
});

test("OIDC scope configuration preserves defaults, deduplicates and rejects invalid requests", () => {
  assert.deepEqual(regionConfig().oidcScopes, ["openid"]);
  assert.deepEqual(regionConfig({ SITHS_OIDC_SCOPES: " openid  base openid " }).oidcScopes, ["openid", "base"]);
  for (const scope of ["", "base", 'openid "base"', "openid bad\\scope"]) {
    assert.throws(() => regionConfig({ SITHS_OIDC_SCOPES: scope }), /valid scope tokens/);
  }
  const generic = loadConfig({ NODE_ENV: "test", PORT: "3000" });
  assert.equal(generic.oidcProfile, "generic");
  assert.equal(generic.devHarnessEnabled, true);
});

test("Region Stockholm authorization uses discovery, configured scopes, nonce and S256 PKCE", async () => {
  const requested: string[] = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return discovery();
  };
  const config = regionConfig({ SITHS_OIDC_SCOPES: "openid base" });
  const client = new OidcClient(config, new IdTokenVerifier(new AuthStores(900_000)));
  const { authorizationUrl, transaction } = await client.begin("/", "synthetic-correlation", "synthetic-binding");
  const url = new URL(authorizationUrl);
  assert.deepEqual(requested, [`${issuer}/.well-known/openid-configuration`]);
  assert.equal(url.origin, "https://federation-acc.sll.se");
  assert.equal(url.pathname, "/adfs/oauth2/authorize/");
  assert.equal(url.searchParams.get("scope"), "openid base");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), config.oidcRedirectUri);
  assert.equal(url.searchParams.get("nonce"), transaction.nonce);
  assert.equal(url.searchParams.get("state"), transaction.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(transaction.browserBindingHash, "synthetic-binding");
});

test("Region Stockholm discovery cannot switch the issuer or send tokens to another origin", async () => {
  for (const overrides of [
    { issuer: "https://other.example/adfs" },
    { token_endpoint: "https://other.example/token" },
    { jwks_uri: "https://other.example/keys" },
    { authorization_endpoint: "https://other.example/authorize" },
  ]) {
    globalThis.fetch = async () => discovery(overrides);
    const client = new OidcClient(regionConfig(), new IdTokenVerifier(new AuthStores(900_000)));
    await assert.rejects(
      client.begin("/", "synthetic-correlation", "synthetic-binding"),
      (error: unknown) => error instanceof SecurityError,
    );
  }
});
