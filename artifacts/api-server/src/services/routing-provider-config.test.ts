import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getRoutingConfigurationStatus, getRoutingServerForAssignment, validateRoutingBaseUrl } from "./routing-provider-config";

const previousOsrm = process.env.OSRM_BASE_URL;
const previousCatalog = process.env.ROUTING_SERVER_CATALOG_JSON;
const previousNodeEnv = process.env.NODE_ENV;
const previousRoutingToken = process.env.TEST_ROUTING_TOKEN;
after(() => {
  if (previousOsrm === undefined) delete process.env.OSRM_BASE_URL;
  else process.env.OSRM_BASE_URL = previousOsrm;
  if (previousCatalog === undefined) delete process.env.ROUTING_SERVER_CATALOG_JSON;
  else process.env.ROUTING_SERVER_CATALOG_JSON = previousCatalog;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousRoutingToken === undefined) delete process.env.TEST_ROUTING_TOKEN;
  else process.env.TEST_ROUTING_TOKEN = previousRoutingToken;
});

test("routing endpoints reject the public demo, credentials, fragments, and production HTTP", () => {
  assert.throws(() => validateRoutingBaseUrl("https://router.project-osrm.org"));
  assert.throws(() => validateRoutingBaseUrl("https://user:secret@routes.example.net"));
  assert.throws(() => validateRoutingBaseUrl("https://routes.example.net/#token"));
  assert.throws(() => validateRoutingBaseUrl("http://routes.example.net", true));
  assert.equal(validateRoutingBaseUrl("https://routes.example.net/osrm/"), "https://routes.example.net/osrm");
  assert.equal(validateRoutingBaseUrl("http://routes.internal", false), "http://routes.internal");
});

test("status exposes safe catalog identities and config errors, never configured endpoints", () => {
  process.env.NODE_ENV = "production";
  process.env.OSRM_BASE_URL = "https://routing.private.example/osrm";
  process.env.ROUTING_SERVER_CATALOG_JSON = JSON.stringify([
    { id: "north", name: "North routing", baseUrl: "https://north.private.example/osrm" },
  ]);
  const status = getRoutingConfigurationStatus();
  assert.deepEqual(status.shared, {
    id: "shared", name: "Traivos gemensamma vägdatatjänst", configured: true,
  });
  assert.deepEqual(status.dedicated, [{ id: "north", name: "North routing", configured: true }]);
  assert.equal(JSON.stringify(status).includes("private.example"), false);

  process.env.ROUTING_SERVER_CATALOG_JSON = "not-json";
  const invalid = getRoutingConfigurationStatus();
  assert.ok(invalid.catalogError);
  assert.deepEqual(invalid.dedicated, [{
    id: "catalog", name: "Operatörens serverkatalog", configured: false,
    error: "Operatörens routing-serverkatalog är ogiltig JSON.",
  }]);
});

test("catalog token environment names are identifiers, missing secrets disable assignment, and values stay private", () => {
  process.env.OSRM_BASE_URL = "https://routing.private.example";
  process.env.ROUTING_SERVER_CATALOG_JSON = JSON.stringify([{
    id: "secured",
    name: "Secured routing",
    baseUrl: "https://secured.private.example",
    authTokenEnv: "TEST_ROUTING_TOKEN",
  }]);
  delete process.env.TEST_ROUTING_TOKEN;
  const missing = getRoutingConfigurationStatus();
  assert.equal(missing.dedicated[0]?.configured, false);
  assert.equal(getRoutingServerForAssignment("secured"), null);

  process.env.TEST_ROUTING_TOKEN = "do-not-return-this-value";
  const configured = getRoutingConfigurationStatus();
  assert.equal(configured.dedicated[0]?.configured, true);
  assert.equal(getRoutingServerForAssignment("secured")?.id, "secured");
  assert.equal(JSON.stringify(configured).includes(process.env.TEST_ROUTING_TOKEN), false);
});

test("shared district status requires the development token and never exposes it", () => {
  const keys = ["NODE_ENV", "DISTRICT_OSRM_BASE_URL", "DISTRICT_OSRM_AUTH_TOKEN"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.DISTRICT_OSRM_BASE_URL = "https://district-pilot.example.invalid";
    delete process.env.DISTRICT_OSRM_AUTH_TOKEN;
    assert.equal(getRoutingConfigurationStatus().shared.configured, false);
    assert.equal(getRoutingServerForAssignment("shared"), null);
    process.env.DISTRICT_OSRM_AUTH_TOKEN = "b".repeat(64);
    const status = getRoutingConfigurationStatus();
    assert.equal(status.shared.configured, true);
    assert.equal(getRoutingServerForAssignment("shared")?.id, "shared");
    assert.equal(JSON.stringify(status).includes(process.env.DISTRICT_OSRM_AUTH_TOKEN), false);
    assert.equal(JSON.stringify(status).includes("district-pilot.example.invalid"), false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});