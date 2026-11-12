import assert from "node:assert/strict";
import test from "node:test";
import { formatResourcePhone, normalizeResourcePhone, phoneCountry } from "./resource-phone";

test("Swedish numbers display grouped but persist without formatting", () => {
  assert.equal(formatResourcePhone("0701234567"), "+46 (701) 234-567");
  assert.equal(normalizeResourcePhone("+46 (701) 234-567"), "+46701234567");
  assert.equal(normalizeResourcePhone("0046701234567"), "+46701234567");
  assert.equal(normalizeResourcePhone(""), "");
  assert.equal(formatResourcePhone(""), "");
});

test("Selected country and pasted international numbers preserve their identity", () => {
  assert.equal(normalizeResourcePhone("91234567", "47"), "+4791234567");
  assert.equal(phoneCountry("+358401234567"), "358");
  assert.equal(phoneCountry("+447123456789"), "other");
  assert.equal(formatResourcePhone("+447123456789"), "+447123456789");
});
