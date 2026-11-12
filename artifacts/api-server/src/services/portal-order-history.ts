import { sql } from "drizzle-orm";
import { db, stopsTable, type PortalAccount } from "@workspace/db";
import { GetPortalOrdersResponse, GetPortalOrdersQueryParams } from "@workspace/api-zod";
import type { z } from "zod";
import { portalOrderWhere } from "./portal-orders";

type Order = z.infer<typeof GetPortalOrdersResponse>["items"][number];
type Query = z.output<typeof GetPortalOrdersQueryParams>;

// Preserve PostgreSQL microseconds: JS Date would round tied keyset boundaries.
export function parsePortalCursor(value?: string) {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})Z\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}Z`))
    || new Date(`${match[1]}Z`).toISOString().slice(0, 10) !== match[1].slice(0, 10)) throw new Error("Invalid cursor");
  return { createdAt: match[1], id: match[2] };
}

/**
 * One set-based read, with outgoing evidence materialized once per route.
 * No route-by-route queries or full stop payloads cross the database boundary.
 * These relational guards mirror outgoingRoute/outgoingStops: authenticated
 * snapshot version, active recipient, all actual stops present, unique membership
 * and BOTH current and snapshot customer grants. Broken evidence never uses drafts.
 */
export async function listPortalOrders(account: PortalAccount, query: Query = GetPortalOrdersQueryParams.parse({}), activeOnly = false,
  database: Pick<typeof db, "execute"> = db) {
  const limit = query.limit ?? 25;
  const asOf = query.asOf ? new Date(query.asOf).toISOString() : new Date().toISOString();
  const cursor = parsePortalCursor(query.cursor);
  const result = await database.execute(sql`
    with authorized as materialized (
      select * from ${stopsTable} where ${portalOrderWhere(account)}
        and created_at <= (${asOf}::timestamptz at time zone 'UTC')
    ), evidence as materialized (
      select r.id, r.status as route_status, r.handoff_status, s.route, s.stops,
        e.id as execution_id, e.status as execution_status, e.ended_at,
        (r.dispatch_snapshot_version = s.plan_revision
          and s.route->'__snapshotSchema' = '2'::jsonb
          and s.driver_id = r.handoff_driver_id and d.id is not null) as valid
      from routes r
      join route_dispatch_snapshots s on s.route_id = r.id and s.organization_id = r.organization_id
        and s.plan_revision = r.handoff_version
      left join drivers d on d.id = r.handoff_driver_id and d.organization_id = r.organization_id and d.is_active
      left join route_executions e on e.route_id = r.id and e.organization_id = r.organization_id
        and e.plan_version = s.plan_revision and e.driver_id = r.handoff_driver_id
      where r.organization_id = ${account.organizationId}
    ), members as materialized (
      select e.id as route_id, p.value as planning, actual.id as actual_id
      from evidence e cross join lateral jsonb_array_elements(e.stops) p
      left join stops actual on actual.id::text = p.value->>'id'
        and actual.organization_id = ${account.organizationId}
    ), integrity as (
      select route_id, bool_and(actual_id is not null) as complete from members group by route_id
    ), membership as (
      select m.planning->>'id' as stop_id, count(*) as copies,
        (array_agg(m.planning))[1] as planning, (array_agg(m.route_id))[1] as route_id
      from members m join authorized a on a.id::text = m.planning->>'id'
      group by m.planning->>'id'
    ), effective as (
      select a.id, a.created_at,
        case when m.stop_id is not null then
          case when m.copies = 1 and e.valid and i.complete
            and m.planning->>'organizationId' = ${account.organizationId}
            and (${JSON.stringify(account.stopIds)}::jsonb ? (m.planning->>'id')
              or ${JSON.stringify(account.customerIds)}::jsonb ? (m.planning->>'customerId'))
          then jsonb_build_object('id', a.id, 'reference', m.planning->>'externalRef',
            'address', m.planning->>'address',
            'date', to_char(coalesce(m.planning->>'planningDate', m.planning->>'timeWindowStart',
              e.route->>'date')::timestamptz at time zone 'Europe/Stockholm', 'YYYY-MM-DD'),
            'timeWindowStart', m.planning->>'timeWindowStart', 'timeWindowEnd', m.planning->>'timeWindowEnd',
            'status', case when a.status in ('completed','failed','skipped') then a.status::text
              when e.route_status = 'cancelled' then 'cancelled'
              when e.handoff_status = 'rejected' then 'unavailable'
              when e.execution_status = 'active' and e.ended_at is null and e.handoff_status = 'accepted' then 'started'
              when e.execution_id is not null then 'paused' else 'scheduled' end)
          else null end
        when working.handoff_version is not null then null
        else jsonb_build_object('id', a.id, 'reference', a.external_ref, 'address', a.address,
          'date', to_char(coalesce(a.planning_date,a.time_window_start) at time zone 'UTC' at time zone 'Europe/Stockholm','YYYY-MM-DD'),
          'timeWindowStart', to_char(a.time_window_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'timeWindowEnd', to_char(a.time_window_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'status', case when a.status in ('completed','failed','skipped') then a.status::text else 'scheduled' end)
        end as payload
      from authorized a
      left join membership m on m.stop_id = a.id::text
      left join evidence e on e.id = m.route_id
      left join integrity i on i.route_id = m.route_id
      left join routes working on working.id = a.route_id and working.organization_id = a.organization_id
    ), projected as (
      select id, created_at, coalesce(payload, jsonb_build_object('id', id, 'reference', null,
        'address', 'Leveransuppgifter granskas', 'date', null, 'timeWindowStart', null,
        'timeWindowEnd', null, 'status', 'unavailable')) as payload from effective
    ), filtered as materialized (
      select * from projected where
        (${query.from ?? null}::text is null or payload->>'date' >= ${query.from ?? null})
        and (${query.to ?? null}::text is null or payload->>'date' <= ${query.to ?? null})
        and (${activeOnly ? "started" : query.status ?? null}::text is null
          or payload->>'status' = ${activeOnly ? "started" : query.status ?? null})
        and (${query.search?.trim() ?? ""} = '' or strpos(
          lower(coalesce(payload->>'reference','') || ' ' || (payload->>'address')),
          lower(${query.search?.trim() ?? ""})) > 0)
    ), page as (
      select *, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || id::text as cursor
      from filtered where (${cursor?.createdAt ?? null}::timestamp is null
        or (created_at, id) < (${cursor?.createdAt ?? null}::timestamp, ${cursor?.id ?? null}::uuid))
      order by created_at desc, id desc limit ${limit + 1}
    )
    select (select count(*)::integer from filtered) as total,
      coalesce((select jsonb_agg(jsonb_build_object('order',payload,'cursor',cursor)
        order by created_at desc, id desc) from page), '[]'::jsonb) as rows
  `);
  const row = result.rows[0] as { total: number; rows: { order: Order; cursor: string }[] };
  const page = row.rows.slice(0, limit);
  return { items: page.map(item => item.order), total: row.total, asOf,
    nextCursor: row.rows.length > limit ? page[page.length - 1].cursor : null };
}
