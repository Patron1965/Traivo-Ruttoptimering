import { beforeEach, afterEach } from "node:test";

/** Synthetic Common API credentials; never send a request without mocking fetch. */
export function useLinkSmsTestEnvironment(): void {
  const keys = ["LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID", "LINK_GATE_ID"];
  let previous: Array<string | undefined>;
  beforeEach(() => {
    previous = keys.map(key => process.env[key]);
    keys.forEach(key => { process.env[key] = "synthetic-sms-test"; });
  });
  afterEach(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
}
