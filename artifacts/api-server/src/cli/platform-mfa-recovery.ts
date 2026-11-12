import { open, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pool } from "@workspace/db";
import { issueOperatorRecovery } from "../lib/platform-mfa-recovery";

async function main() {
  const { values } = parseArgs({ options: {
    "user-id": { type: "string" }, "expected-email": { type: "string" },
    "operator-ref": { type: "string" }, "incident-ref": { type: "string" },
    confirm: { type: "string" }, "production-confirm": { type: "string" },
    "token-file": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values["token-file"]) throw new Error("Explicit token file required");
  // Exclusive creation refuses existing paths and symlinks. Never print the token.
  const file = await open(values["token-file"], "wx", 0o600);
  let success = false;
  try {
    await issueOperatorRecovery({
      userId: values["user-id"]!, expectedEmail: values["expected-email"]!,
      operatorRef: values["operator-ref"]!, incidentRef: values["incident-ref"]!,
      confirmation: values.confirm as "REVOKE-AND-REQUIRE-MFA",
      productionConfirmation: values["production-confirm"],
    }, async token => { await file.writeFile(token + "\n"); await file.sync(); });
    success = true;
    process.stdout.write("Recovery grant issued. Deliver the protected file through a secure channel. It expires in 15 minutes.\n");
  } finally {
    await file.close();
    if (!success) await unlink(values["token-file"]);
  }
}
main().catch(() => {
  // Database and validation exceptions may contain credentials or attacker input.
  process.stderr.write("Recovery issuance failed. Check policy/key configuration, target identity, confirmations and exclusive file permissions.\n");
  process.exitCode = 1;
}).finally(() => pool.end());