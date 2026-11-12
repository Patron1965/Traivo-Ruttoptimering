import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  CreateStopBody,
  GetPortalOrdersQueryParams,
  UpdateStopBody,
} from "@workspace/api-zod";
import sharp from "sharp";

test("generated schemas preserve PostgreSQL UUID identifiers but reject malformed IDs", () => {
  const input = {
    organizationId: "00000000-0000-0000-0000-000000000001",
    address: "Kundgatan 1",
    latitude: 59.33,
    longitude: 18.07,
  };
  assert.equal(CreateStopBody.safeParse(input).success, true);
  for (const organizationId of ["not-a-uuid", "__proto__", "00000000-0000-0000-0000-00000000000x"]) {
    assert.equal(CreateStopBody.safeParse({ ...input, organizationId }).success, false);
  }
});

test("query coercion produces validated numbers and keeps pagination defaults", () => {
  assert.equal(GetPortalOrdersQueryParams.parse({}).limit, 25);
  assert.equal(GetPortalOrdersQueryParams.parse({ limit: "10" }).limit, 10);
  assert.equal(GetPortalOrdersQueryParams.safeParse({ limit: "invalid" }).success, false);
  assert.equal(GetPortalOrdersQueryParams.safeParse({ limit: "-1" }).success, false);
});

test("partial updates preserve omitted fields versus explicit null and date coercion", () => {
  const empty = UpdateStopBody.parse({});
  assert.deepEqual(empty, {});
  const parsed = UpdateStopBody.parse({ planningDate: "2026-03-29", notes: null });
  assert.equal(parsed.notes, null);
  assert.equal(parsed.planningDate?.toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(Object.hasOwn(parsed, "address"), false);
});

test("oversized constrained arrays stop before collecting per-element issues", () => {
  const parsed = z.array(z.string()).max(10).safeParse(Array(20_000).fill(123));
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.deepEqual(parsed.error.issues.map(issue => issue.code), ["too_big"]);
});

test("updated sharp loads its native codec and round-trips proof PNG bytes", async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#123456" },
  }).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
});
