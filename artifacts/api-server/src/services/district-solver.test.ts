import assert from "node:assert/strict";
import { test } from "node:test";
import { DISTRICT_MAX_STOPS, configuredDistrictOsrmProvider, createDistrictOsrmProvider, solveDistrict, type DistrictCoordinate, type DistrictRoadProvider } from "./district-solver";

const point = (id: string, longitude: number, latitude = 57.7) => ({ id, latitude, longitude });
const callbacks = { onProgress: (_value: number) => {}, isCancelled: () => false };

function provider(distance: (a: DistrictCoordinate, b: DistrictCoordinate) => number): DistrictRoadProvider {
  return {
    async table(sources, destinations) {
      return {
        distances: sources.map(a => destinations.map(b => distance(a, b))),
        durations: sources.map(a => destinations.map(b => 2 * distance(a, b))),
      };
    },
    async route(points) {
      return { geometry: points.map(p => ({ ...p })), waypoints: points.map(p => ({ ...p })) };
    },
  };
}
const directed = provider((a, b) => a.longitude === b.longitude ? 0 :
  a.longitude < b.longitude ? (b.longitude - a.longitude) * 100 : (a.longitude - b.longitude) * 1000);

test("directed asymmetry, closed loop and fixed endpoint; stop endpoint remains a visit", async () => {
  const points = [point("a", 1), point("b", 2), point("c", 3)];
  const start = { latitude: 57.7, longitude: 0 };
  const loop = await solveDistrict({
    points, start, mode: "loop", serviceMinutes: 0,
  }, callbacks, { provider: directed });
  assert.deepEqual(loop.orderedPointIds.slice().sort(), ["a", "b", "c"]);
  const map = new Map(points.map(p => [p.id, p]));
  let prev = start.longitude, expected = 0;
  for (const id of loop.orderedPointIds) {
    const next = map.get(id)!.longitude;
    expected += prev < next ? (next - prev) * 100 : (prev - next) * 1000;
    prev = next;
  }
  expected += prev * 1000;
  assert.equal(loop.distanceMeters, expected);
  assert.equal(loop.driveSeconds, expected * 2);
  assert.equal(loop.geometry.at(-1)?.longitude, start.longitude);

  const open = await solveDistrict({
    points, start, mode: "open", end: { pointId: "b" }, serviceMinutes: 15,
  }, callbacks, { provider: directed });
  assert.deepEqual(open.orderedPointIds.slice().sort(), ["a", "b", "c"]);
  assert.equal(open.orderedPointIds.at(-1), "b");
  assert.equal(open.geometry.at(-1)?.longitude, 2);
  assert.equal(open.geometry.length, 4); // start + 3 visits; pinned end ID is not repeated
});

test("duplicate coordinates retain distinct source IDs, including start and end", async () => {
  const points = [point("001", 1), point("002", 1), point("003", 2)];
  const result = await solveDistrict({
    points, start: { pointId: "001" }, end: { pointId: "002" }, mode: "open", serviceMinutes: 0,
  }, callbacks, { provider: directed });
  assert.deepEqual(result.orderedPointIds.slice().sort(), ["001", "002", "003"]);
  assert.equal(result.orderedPointIds[0], "001");
  assert.equal(result.orderedPointIds.at(-1), "002");
  assert.equal(result.geometry.length, 4); // start + all 3 IDs, including co-located distinct IDs
  assert.equal(result.geometry[1].longitude, result.geometry[3].longitude);
  const loop = await solveDistrict({
    points, start: { pointId: "002" }, mode: "loop", serviceMinutes: 0,
  }, callbacks, { provider: directed });
  assert.equal(loop.orderedPointIds[0], "002");
  assert.deepEqual(loop.orderedPointIds.slice().sort(), ["001", "002", "003"]);
  await assert.rejects(solveDistrict({
    points, start: { pointId: "001" }, end: { pointId: "001" },
    mode: "open", serviceMinutes: 0,
  }, callbacks, { provider: directed }), /Samma stopp kan inte vara både först och sist/);
  const singleton = await solveDistrict({
    points: [points[0]], start: { pointId: "001" }, end: { pointId: "001" },
    mode: "open", serviceMinutes: 0,
  }, callbacks, { provider: directed });
  assert.deepEqual(singleton.orderedPointIds, ["001"]);
  assert.equal(singleton.geometry.length, 2); // external start + one stop, not a repeated end
});

test("refuses incomplete, null, nonfinite and failed provider matrices without geometric fallback", async () => {
  const points = [point("a", 1), point("b", 2)];
  const input = { points, start: { pointId: "a" }, mode: "open" as const, serviceMinutes: 0 };
  for (const broken of [null, Infinity, -1]) {
    const bad = provider((a, b) => a.longitude === 0 && b.longitude === 1 ? broken as number : 10);
    // Source at longitude 0 is introduced explicitly.
    await assert.rejects(solveDistrict({ ...input, start: { latitude: 57.7, longitude: 0 } }, callbacks,
       { provider: bad }), /Vägförbindelse saknas eller är ogiltig/);
  }
  await assert.rejects(solveDistrict(input, callbacks, {
    provider: { ...directed, table: async () => { throw new Error("provider unavailable"); } },
   }), /Vägmatrisens block .* misslyckades.*Kontrollera OSRM-serverns tillgänglighet/);
  await assert.rejects(solveDistrict(input, callbacks, {
    provider: { ...directed, route: async () => { throw new Error("geometry unavailable"); } },
   }), /Väggeometrins del .* misslyckades.*Kontrollera OSRM-serverns tillgänglighet/);
});

test("cancellation interrupts an in-flight table call", async () => {
  let cancelled = false;
  const slow = provider(() => 10);
  slow.table = (_sources, _destinations, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const pending = solveDistrict({
    points: [point("a", 1)], start: { latitude: 57.7, longitude: 0 }, mode: "open", serviceMinutes: 0,
  }, { onProgress: () => {}, isCancelled: () => cancelled }, { provider: slow });
  setTimeout(() => { cancelled = true; }, 20);
  await assert.rejects(pending, /Avbruten/);
});

test("configured provider refuses the public OSRM demo", () => {
  const previous = process.env.OSRM_BASE_URL;
  try {
    process.env.OSRM_BASE_URL = "https://router.project-osrm.org";
    assert.throws(() => configuredDistrictOsrmProvider(), /publika OSRM-demonstrationen får inte användas/);
    delete process.env.OSRM_BASE_URL;
    assert.throws(() => configuredDistrictOsrmProvider(), /OSRM_BASE_URL saknas/);
  } finally {
    if (previous === undefined) delete process.env.OSRM_BASE_URL;
    else process.env.OSRM_BASE_URL = previous;
  }
});

test("routing binding cache identities isolate servers and versions without optimization or network access", () => {
  const v1=createDistrictOsrmProvider("https://routing.invalid", "osrm:server-a:version-1");
  const v2=createDistrictOsrmProvider("https://routing.invalid", "osrm:server-a:version-2");
  const differentServer=createDistrictOsrmProvider("https://routing.invalid", "osrm:server-b:version-1");
  assert.equal(v1.cacheKey,"osrm:server-a:version-1");
  assert.equal(v2.cacheKey,"osrm:server-a:version-2");
  assert.equal(differentServer.cacheKey,"osrm:server-b:version-1");
  assert.equal(new Set([v1.cacheKey,v2.cacheKey,differentServer.cacheKey]).size,3);
});

test("refuses disconnected road-geometry seams rather than drawing a straight bridge", async () => {
  const points = Array.from({length:60},(_,i)=>point(String(i),1+i*0.001));
  let chunk = 0;
  const broken = provider((a, b) => Math.abs(a.longitude - b.longitude) * 100);
  broken.route = async coords => {
    chunk++;
    const waypoints = coords.map(c => ({ ...c }));
    if (chunk === 2) waypoints[0].longitude += 0.0002;
    return { geometry: waypoints, waypoints };
  };
  await assert.rejects(solveDistrict({
    points, start: { pointId: "0" }, mode: "open", serviceMinutes: 0,
  }, callbacks, { provider: broken }), /Väggeometrins skarv .*hänger inte ihop/);
});

test("capacity refused explicitly and 500 stops are a conserved permutation with chunked geometry", async () => {
  const points = Array.from({ length: 500 }, (_, i) =>
    point(`row-${i}`, 11.85 + (i % 25) * 0.002, 57.65 + Math.floor(i / 25) * 0.002));
  let calls = 0, maxCoords = 0, routes = 0;
  const mocked = provider((a, b) =>
    (Math.abs(a.latitude - b.latitude) * 110_000 + Math.abs(a.longitude - b.longitude) * 60_000) *
    (a.longitude < b.longitude ? 1.1 : 1.3));
  const realTable = mocked.table;
  mocked.table = (sources, destinations, signal) => {
    calls++;
    maxCoords = Math.max(maxCoords, sources === destinations ? sources.length : sources.length + destinations.length);
    return realTable(sources, destinations, signal);
  };
  const realRoute = mocked.route;
  mocked.route = (coords, signal) => { routes++; assert.ok(coords.length <= 50); return realRoute(coords, signal); };
  const result = await solveDistrict({
    points, start: { pointId: "row-0" }, mode: "loop", serviceMinutes: 0,
  }, callbacks, { provider: mocked });
  assert.equal(result.orderedPointIds.length, 500);
  assert.equal(new Set(result.orderedPointIds).size, 500);
  assert.deepEqual(result.orderedPointIds.slice().sort(), points.map(p => p.id).sort());
  assert.ok(result.distanceMeters > 0 && result.driveSeconds > 0);
  assert.ok(calls <= 121 && calls > 0 && maxCoords <= 100 && routes > 1);
  await assert.rejects(solveDistrict({
    points: Array.from({ length: DISTRICT_MAX_STOPS + 1 }, (_, i) => point(String(i), 1)),
    start: { pointId: "0" }, mode: "open", serviceMinutes: 0,
  }, callbacks, { provider: mocked }), /Dela upp större zoner/);
});

test("OSRM CH negative costs, including former rounding cases, require fresh verified road evidence", async () => {
  const originalFetch=globalThis.fetch;
  const cases = [
    { distance: -0.1, duration: 0, location: [11.8, 58.0] },
    { distance: -0.2, duration: 0, location: [11.800004, 58.0] },
    { distance: -0.6, duration: 0, location: [11.8, 58.0] },
    { distance: -0.1, duration: 1, location: [11.8, 58.0] },
    { distance: -0.1, duration: 0, location: [11.80002, 58.0] },
  ];

  try {
    for(const sample of cases) {
      let requests = 0;
      globalThis.fetch=async url=>{
        requests++;
        return new Response(JSON.stringify(String(url).includes("/table/") ? {
          code:"Ok",distances:[[sample.distance]],durations:[[sample.duration]],
          sources:[{location:[11.8,58.0]}],destinations:[{location:sample.location}],
        } : pairResponse([[11.8,58.0], sample.location], 3, 2)));
      };
      const response=await createDistrictOsrmProvider("http://127.0.0.1:5001").table(
        [point("source",11.8,58.0)],[point("destination",11.8,58.0)],new AbortController().signal,
      );
      assert.equal(response.distances[0][0],3);
      assert.equal(response.durations[0][0],2);
      assert.equal(requests, 2);
      assert.equal(response.matrixRepairs?.[0].table.distance, sample.distance);
      assert.deepEqual(response.matrixRepairs?.[0].replacement, { distance: 3, duration: 2 });
    }
  } finally {globalThis.fetch=originalFetch;}
});

function pairResponse(locations: number[][], distance = 12, duration = 4) {
  return {
    code: "Ok", waypoints: locations.map(location => ({ location })),
    routes: [{ distance, duration, legs: [{ distance, duration }],
      geometry: { type: "LineString", coordinates: locations } }],
  };
}

test("recovery preserves directed asymmetry, exact co-location and unmodified raw evidence", async () => {
  const originalFetch = globalThis.fetch;
  const points = [point("a", 11.8, 58), point("b", 11.8001, 58)];
  const locations = points.map(p => [p.longitude, p.latitude]);
  const raw = { code: "Ok", distances: [[-0.8, -1.2], [-2.4, 0]], durations: [[0, 2], [3, 0]],
    sources: locations.map(location => ({ location })), destinations: locations.map(location => ({ location })) };
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal((init?.headers as Record<string,string>).Authorization, "Bearer test-only");
      if (String(url).includes("/table/")) return Response.json(raw);
      const coords = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map(p => p.split(",").map(Number));
      return Response.json(pairResponse(coords, coords[0][0] === coords[1][0] ? 0 :
        coords[0][0] < coords[1][0] ? 12 : 31, coords[0][0] === coords[1][0] ? 0 : 4));
    };
    const osrm = createDistrictOsrmProvider("https://bound.invalid/data", "dataset:fixed", { Authorization: "Bearer test-only" });
    const table = await osrm.table(points, points, new AbortController().signal);
    assert.deepEqual(table.distances, [[0,12],[31,0]]);
    assert.equal(table.matrixRepairs?.length, 3);
    assert.deepEqual(raw.distances, [[-0.8,-1.2],[-2.4,0]]);
    assert.ok(table.matrixRepairs?.every(e => e.providerIdentity === "dataset:fixed"));
    assert.ok(calls.every(url => url.startsWith("https://bound.invalid/data/") &&
      new URL(url).searchParams.get("radiuses")?.split(";").every(v => v === "250")));
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test("recovery rejects missing geometry, invalid legs, disconnection and changed snaps", async () => {
  const originalFetch = globalThis.fetch;
  const locations = [[11.8,58], [11.8001,58]];
  const mutations: ((body: any) => void)[] = [
    b => { delete b.routes[0].geometry; },
    b => { b.routes[0].geometry.coordinates = [locations[0]]; },
    b => { b.routes[0].geometry.coordinates[1] = [12,58]; },
    b => { b.routes[0].geometry.coordinates.splice(1,0,[NaN,58]); },
    b => { b.routes[0].legs = []; },
    b => { b.routes[0].legs[0].distance = -0.1; },
    b => { b.routes[0].legs[0].duration = -1; },
    b => { b.routes[0].distance = null; },
    b => { b.routes[0].duration = Infinity; },
    b => { b.routes[0].distance = 99; },
    b => { b.waypoints.pop(); },
    b => { b.waypoints[1].location = [11.8002,58]; },
    b => { b.waypoints[1].location = [12,58]; },
    b => { b.code = "NoRoute"; },
    b => { b.routes.push(b.routes[0]); },
  ];
  try {
    for (const mutate of mutations) {
      globalThis.fetch = async url => {
        if (String(url).includes("/table/")) return Response.json({
          code:"Ok",distances:[[-0.6]],durations:[[0]],
          sources:[{location:locations[0]}],destinations:[{location:locations[1]}],
        });
        const body = pairResponse(structuredClone(locations));
        mutate(body);
        return Response.json(body);
      };
      await assert.rejects(createDistrictOsrmProvider("https://bound.invalid").table(
        [point("a",11.8,58)], [point("b",11.8001,58)], new AbortController().signal),
        /verifieras|väganknytning|vägtäckningen/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid matrix costs fail before recovery and the shared repair budget is bounded", async () => {
  const originalFetch = globalThis.fetch;
  let routeCalls = 0;
  try {
    for (const [d,t] of [[null,0], [Infinity,0], [-1,-1], [-1,null], [-1,NaN]]) {
      globalThis.fetch = async url => {
        if (String(url).includes("/route/")) routeCalls++;
        return Response.json({code:"Ok",distances:[[d]],durations:[[t]],
          sources:[{location:[11.8,58]}],destinations:[{location:[11.8,58]}]});
      };
      await assert.rejects(createDistrictOsrmProvider("https://bound.invalid").table(
        [point("a",11.8,58)], [point("b",11.8,58)], new AbortController().signal), /Vägförbindelse/);
    }
    const points = Array.from({length:6}, (_, i) => point(String(i),11.8+i*0.00001,58));
    globalThis.fetch = async url => {
      if (String(url).includes("/route/")) routeCalls++;
      return Response.json({code:"Ok",distances:points.map(()=>points.map(()=>-1)),
        durations:points.map(()=>points.map(()=>0)),sources:points.map(p=>({location:[p.longitude,p.latitude]})),
        destinations:points.map(p=>({location:[p.longitude,p.latitude]}))});
    };
    await assert.rejects(createDistrictOsrmProvider("https://bound.invalid").table(
      points,points,new AbortController().signal), /För många negativa matrisposter/);
    assert.equal(routeCalls,0);
  } finally { globalThis.fetch = originalFetch; }
});

test("cancellation reaches the separate verification request and prevents further recovery", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let routeCalls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/table/")) return Response.json({
        code:"Ok",distances:[[-1]],durations:[[0]],sources:[{location:[11.8,58]}],destinations:[{location:[11.8,58]}],
      });
      routeCalls++;
      return new Promise((_resolve,reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("Avbruten")), {once:true});
        controller.abort();
      });
    };
    await assert.rejects(createDistrictOsrmProvider("https://bound.invalid").table(
      [point("a",11.8,58)],[point("b",11.8,58)],controller.signal), /Avbruten/);
    assert.equal(routeCalls,1);
  } finally { globalThis.fetch = originalFetch; }
});

test("repair budget is shared across table blocks and provider failures never replace a cell", async () => {
  const originalFetch = globalThis.fetch;
  const points = Array.from({length:4}, (_, i) => point(String(i),11.8+i*0.00001,58));
  let routeCalls = 0;
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("/table/")) return Response.json({
        code:"Ok",distances:points.map(()=>points.map(()=>-1)),durations:points.map(()=>points.map(()=>0)),
        sources:points.map(p=>({location:[p.longitude,p.latitude]})),
        destinations:points.map(p=>({location:[p.longitude,p.latitude]})),
      });
      routeCalls++;
      const coords = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map(p=>p.split(",").map(Number));
      return Response.json(pairResponse(coords));
    };
    const osrm = createDistrictOsrmProvider("https://bound.invalid");
    await osrm.table(points,points,new AbortController().signal);
    await osrm.table(points,points,new AbortController().signal);
    await assert.rejects(osrm.table(points,points,new AbortController().signal), /För många negativa matrisposter/);
    assert.equal(routeCalls,32);
    for (const unavailable of [
      async () => { throw new Error("network unavailable"); },
      async () => Response.json({code:"Error"}, {status:503}),
    ]) {
      globalThis.fetch = async url => String(url).includes("/table/") ? Response.json({
        code:"Ok",distances:[[-1]],durations:[[0]],
        sources:[{location:[11.8,58]}],destinations:[{location:[11.8,58]}],
      }) : unavailable();
      await assert.rejects(createDistrictOsrmProvider("https://bound.invalid").table(
        [points[0]],[points[0]],new AbortController().signal), /network unavailable|HTTP 503/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("repair evidence survives solve persistence and warm-cache reuse without shared mutation", async () => {
  const originalFetch = globalThis.fetch;
  const p = point("a",11.8,58);
  const input = {points:[p, {...p,id:"b"}],start:{pointId:"a"},mode:"loop" as const,serviceMinutes:0};
  let tableCalls = 0;
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("/table/")) {
        tableCalls++;
        return Response.json({code:"Ok",distances:[[-0.8]],durations:[[0]],
          sources:[{location:[11.8,58]}],destinations:[{location:[11.8,58]}]});
      }
      const coords = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map(p => p.split(",").map(Number));
      return Response.json(pairResponse(coords,0,0));
    };
    const osrm = createDistrictOsrmProvider("https://bound.invalid", "evidence-cache-test");
    const first = await solveDistrict(input,callbacks,{provider:osrm,warmMatrixCache:true});
    assert.deepEqual(first.orderedPointIds.slice().sort(),["a","b"]);
    const persisted = JSON.parse(JSON.stringify(first));
    assert.equal(persisted.matrixRepairs[0].table.distance,-0.8);
    first.matrixRepairs![0].table.distance = 999;
    const second = await solveDistrict(input,callbacks,{provider:osrm,warmMatrixCache:true});
    assert.equal(second.matrixRepairs![0].table.distance,-0.8);
    assert.equal(tableCalls,1);
  } finally { globalThis.fetch = originalFetch; }
});

test("OSRM Table and Route reject distant snaps even when a provider returns finite zero costs", async () => {
  const originalFetch=globalThis.fetch;
  const requests:string[]=[];
  const stockholm=[point("outside",18.06,59.33)];
  const road=[11.8,58.07];
  try {
    globalThis.fetch=async url=>{
      requests.push(String(url));
      return new Response(JSON.stringify({
        code:"Ok",distances:[[0]],durations:[[0]],
        sources:[{location:road}],destinations:[{location:road}],
        waypoints:[{location:road}],routes:[{geometry:{coordinates:[road,road]}}],
      }),{headers:{"Content-Type":"application/json"}});
    };
    const provider=createDistrictOsrmProvider("http://127.0.0.1:5001");
    await assert.rejects(provider.table(stockholm,stockholm,new AbortController().signal),/väganknytning inom 250 meter/);
    await assert.rejects(provider.route(stockholm,new AbortController().signal),/väganknytning inom 250 meter/);
    assert.ok(requests.every(url=>new URL(url).searchParams.get("radiuses")?.split(";").every(value=>value==="250")));
    // External start/end cannot be hidden behind an otherwise in-coverage stop.
    const valid=[point("valid",11.8,58.07)];
    const badGeometry=providerForGeometry();
    await assert.rejects(solveDistrict({
      points:valid,start:{latitude:59.33,longitude:18.06},mode:"open",serviceMinutes:0,
    },callbacks,{provider:badGeometry}),/väganknytning inom 250 meter/);
    await assert.rejects(solveDistrict({
      points:valid,start:{pointId:"valid"},end:{latitude:59.33,longitude:18.06},mode:"open",serviceMinutes:0,
    },callbacks,{provider:badGeometry}),/väganknytning inom 250 meter/);
  } finally {globalThis.fetch=originalFetch;}
  function providerForGeometry():DistrictRoadProvider {
    return {
      async table(sources,destinations) {
        return {distances:sources.map(()=>destinations.map(()=>0)),durations:sources.map(()=>destinations.map(()=>0))};
      },
      async route(points) {
        const waypoints=points.map(()=>({latitude:58.07,longitude:11.8}));
        return {waypoints,geometry:waypoints};
      },
    };
  }
});
