import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { db, pool, organizationsTable, usersTable, sessionsTable, vehiclesTable, routesTable, stopsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession, validateAndTouchSession } from "./lib/session";
import { changeOrganizationLifecycle } from "./services/organization-lifecycle";

test("tenant lifecycle protects access, active routes and tenant boundaries; deletes completed history atomically", async () => {
  const home = randomUUID(), target = randomUUID(), other = randomUUID(), actor = randomUUID(), member = randomUUID();
  const name = `Lifecycle ${target}`;
  let server: ReturnType<typeof createServer> | undefined;
  const change = (action: "archive" | "restore" | "delete", overrides = {}) =>
    changeOrganizationLifecycle({ organizationId: target, actorOrganizationId: home, actorId: actor, confirmationName: name, action, ...overrides });
  try {
    await db.insert(organizationsTable).values([
      {id:home,name:`Operator ${home}`,email:`${home}@example.test`},
      {id:target,name,email:`${target}@example.test`},
      {id:other,name:`Untouched ${other}`,email:`${other}@example.test`},
    ]);
    await db.insert(usersTable).values([
      {id:actor,organizationId:home,name:"Operator",email:`${actor}@example.test`,role:"admin",isPlatformAdmin:true},
      {id:member,organizationId:target,name:"Member",email:`${member}@example.test`,role:"admin"},
    ]);
    const operatorSession = await createSession({organizationId:home,userId:actor});
    await db.update(sessionsTable).set({mfaVerifiedAt:new Date()}).where(eq(sessionsTable.id,operatorSession.session.id));
    const memberSession = await createSession({organizationId:target,userId:member});
    const { default: app } = await import("./app");
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0,"127.0.0.1",resolve));
    const address = server.address() as {port:number};
    const request = async (path:string, token:string, body?:unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: body ? "POST" : "GET", headers: {Authorization:`Bearer ${token}`,"Content-Type":"application/json",Connection:"close"},
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    const endpoint = `/platform/organizations/${target}/lifecycle`;
    assert.equal((await request(endpoint,memberSession.token,{action:"archive",confirmationName:name})).status,403);
    assert.equal((await request(endpoint,"",{action:"archive",confirmationName:name})).status,401);
    assert.equal((await request(endpoint,operatorSession.token,{action:"archive",confirmationName:"wrong"})).status,400);
    await assert.rejects(change("delete"),/Arkivera/);
    await assert.rejects(change("archive",{organizationId:home,confirmationName:`Operator ${home}`}),/superuser/);
    const [vehicle] = await db.insert(vehiclesTable).values({organizationId:target,name:"Test",licensePlate:"SYNTHETIC"}).returning();
    const [route] = await db.insert(routesTable).values({organizationId:target,name:"History",vehicleId:vehicle.id,date:new Date(),status:"in_progress"}).returning();
    await assert.rejects(change("archive"),/pågående/);
    await db.update(routesTable).set({status:"completed"}).where(eq(routesTable.id,route.id));
    await db.insert(stopsTable).values({organizationId:target,routeId:route.id,address:"Synthetic test only",latitude:59,longitude:18,status:"completed"});
    assert.equal((await request(endpoint,operatorSession.token,{action:"archive",confirmationName:name})).status,204);
    assert.equal(await validateAndTouchSession(memberSession.token),null);
    await assert.rejects(createSession({organizationId:target,userId:member}),/arkiverat/);
    const active = await (await request(`/platform/organizations?search=${target}`,operatorSession.token)).json() as {items:unknown[]};
    assert.equal(active.items.length,0);
    const archived = await (await request(`/platform/organizations?search=${target}&includeArchived=true`,operatorSession.token)).json() as {items:{archivedAt:string}[]};
    assert.equal(archived.items.length,1);
    assert.ok(archived.items[0].archivedAt);
    await change("restore");
    assert.ok((await createSession({organizationId:target,userId:member})).token);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId,target))).length,1);
    await change("archive");
    // A malformed cross-tenant FK must abort, including nullable/CASCADE edges.
    const [foreign] = await db.insert(stopsTable).values({organizationId:other,routeId:route.id,address:"Other tenant",latitude:59,longitude:18}).returning();
    await assert.rejects(change("delete"),/annat kundföretag/);
    assert.equal((await db.select().from(organizationsTable).where(eq(organizationsTable.id,target))).length,1);
    await db.delete(stopsTable).where(eq(stopsTable.id,foreign.id));
    const deleted = await request(endpoint,operatorSession.token,{action:"delete",confirmationName:name});
    assert.equal(deleted.status,204,await deleted.text());
    for (const table of [usersTable,vehiclesTable,routesTable,stopsTable]) {
      assert.equal((await db.select().from(table).where(eq(table.organizationId,target))).length,0);
    }
    assert.equal((await db.select().from(organizationsTable).where(eq(organizationsTable.id,target))).length,0);
    assert.equal((await db.select().from(organizationsTable).where(eq(organizationsTable.id,other))).length,1);
    const audit = await pool.query("SELECT action FROM audit_log WHERE resource_id=$1 AND action='platform.organization.delete'",[target]);
    assert.equal(audit.rowCount,1);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    // Only uniquely identified test fixtures; keep cleanup deterministic on failure.
    for (const table of ["stops","routes","vehicles","sessions","users","audit_log"]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,[[home,target,other]]);
    }
    await pool.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])",[[home,target,other]]);
    await pool.end();
  }
});
