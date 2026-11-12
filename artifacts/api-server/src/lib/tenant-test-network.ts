import assert from "node:assert/strict";
import { Socket } from "node:net";

/** Full-request fixtures may reach loopback providers and the workspace DB only. */
export function prohibitExternalTestConnections() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1", "Published deployments cannot run tenant fixtures");
  const database = new URL(process.env.DATABASE_URL!);
  assert.equal(database.hostname, "helium", "Only the local development database is permitted");
  const original = Socket.prototype.connect;
  const blocked: string[] = [];
  Socket.prototype.connect = function (this: Socket, ...args: Parameters<typeof original>) {
    // Node normalizes overloaded arguments to [options, callback] internally.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === "object" && first !== null ? first : null;
    const host = options?.host ?? (typeof args[1] === "string" ? args[1] : "localhost");
    const port = options?.port ?? first;
    const allowed = ["localhost", "127.0.0.1", "::1"].includes(host)
      || (host === database.hostname && String(port) === (database.port || "5432"));
    if (!allowed) {
      blocked.push(`${host}:${port}`);
      throw new Error(`External connection prohibited in tenant fixture: ${host}:${port}`);
    }
    return original.apply(this, args);
  } as typeof original;
  return () => {
    Socket.prototype.connect = original;
    assert.deepEqual(blocked, [], "The fixture attempted external provider calls");
  };
}
