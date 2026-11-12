-- Additive pilot migration. No legacy locks/snapshots are synthesized.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS optimization_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS frozen_driver_id uuid;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS dispatch_snapshot_version integer;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS locked_vehicle_id uuid;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS locked_driver_id uuid;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS locked_service_start_at timestamptz;
CREATE TABLE IF NOT EXISTS route_dispatch_snapshots (
  route_id uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plan_revision integer NOT NULL,
  driver_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  route jsonb NOT NULL,
  stops jsonb NOT NULL,
  PRIMARY KEY (route_id, plan_revision)
);

CREATE OR REPLACE FUNCTION planner_snapshot_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Utskickad ögonblicksbild är oföränderlig.' USING ERRCODE = 'P0001';
END $$;
CREATE OR REPLACE TRIGGER planner_snapshot_immutable_guard BEFORE UPDATE ON route_dispatch_snapshots
FOR EACH ROW EXECUTE FUNCTION planner_snapshot_immutable_guard();

CREATE OR REPLACE FUNCTION planner_route_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'cancelled' AND EXISTS (
      SELECT 1 FROM route_dispatch_snapshots ds, jsonb_array_elements(ds.stops) entry
      JOIN stops s ON s.id::text = entry->>'id'
      WHERE ds.route_id = OLD.id AND ds.organization_id = OLD.organization_id
        AND ds.plan_revision = OLD.handoff_version
        AND s.organization_id = OLD.organization_id AND s.status IN ('pending','in_progress')
    ) THEN
      RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Rutten har fortfarande aktiva utskickade uppdrag. Skicka ny version eller avbryt uttryckligen före radering.' USING ERRCODE='P0001';
    END IF;
    IF OLD.optimization_frozen OR EXISTS (
      SELECT 1 FROM stops WHERE route_id = OLD.id AND
      (locked_vehicle_id IS NOT NULL OR locked_service_start_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Lås upp rutten och uppdragen före borttagning.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  -- Canonical planners invalidate approval/handoff as part of saving a working
  -- proposal. Keep the *outgoing* receipt/recipient identity independent until
  -- a real dispatch explicitly installs another non-null version.
  IF OLD.dispatch_snapshot_version IS NOT NULL AND OLD.handoff_version IS NOT NULL AND NEW.handoff_version IS NULL
     AND NEW.plan_revision IS DISTINCT FROM OLD.plan_revision
     AND NEW.status <> 'cancelled' THEN
    NEW.handoff_version := OLD.handoff_version;
    NEW.handoff_driver_id := OLD.handoff_driver_id;
    NEW.handoff_status := OLD.handoff_status;
    NEW.sent_at := OLD.sent_at;
    NEW.received_at := OLD.received_at;
    NEW.opened_at := OLD.opened_at;
    NEW.accepted_at := OLD.accepted_at;
    NEW.rejected_at := OLD.rejected_at;
    NEW.rejection_reason := OLD.rejection_reason;
  END IF;
  IF OLD.optimization_frozen AND (
    ROW(NEW.vehicle_id, NEW.date, NEW.planner_itinerary, NEW.workday_timeline, NEW.depot_snapshot, NEW.total_stops)
    IS DISTINCT FROM
    ROW(OLD.vehicle_id, OLD.date, OLD.planner_itinerary, OLD.workday_timeline, OLD.depot_snapshot, OLD.total_stops)
  ) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Ruttens medlemskap, resurspar, ordning och planerade tider är frysta. Lås upp först.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id AND EXISTS (
    SELECT 1 FROM stops WHERE route_id = OLD.id AND locked_vehicle_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Uppdrag är låsta till ruttens resurspar.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER planner_route_lock_guard BEFORE UPDATE OR DELETE ON routes
FOR EACH ROW EXECUTE FUNCTION planner_route_lock_guard();

CREATE OR REPLACE FUNCTION planner_stop_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_route routes%ROWTYPE; new_route routes%ROWTYPE;
BEGIN
  -- Serialize membership writes with route mutations, including alternate API paths.
  IF TG_OP <> 'INSERT' AND OLD.route_id IS NOT NULL THEN
    SELECT * INTO old_route FROM routes WHERE id = OLD.route_id FOR UPDATE;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.route_id IS NOT NULL THEN
    SELECT * INTO new_route FROM routes WHERE id = NEW.route_id FOR UPDATE;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF new_route.optimization_frozen THEN
      RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Nya uppdrag kan inte läggas till på fryst rutt.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('pending','in_progress') AND EXISTS (
      SELECT 1 FROM routes r JOIN route_dispatch_snapshots ds
        ON ds.route_id = r.id AND ds.plan_revision = r.handoff_version
        AND ds.organization_id = r.organization_id
      WHERE r.organization_id = OLD.organization_id AND r.status <> 'cancelled'
        AND ds.stops @> jsonb_build_array(jsonb_build_object('id', OLD.id::text))
    ) THEN
      RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Uppdraget är fortfarande utskickat; flytta ur arbetsförslaget och skicka om före fysisk radering.' USING ERRCODE='P0001';
    END IF;
    IF old_route.optimization_frozen OR OLD.locked_vehicle_id IS NOT NULL OR OLD.locked_service_start_at IS NOT NULL THEN
      RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Lås upp före borttagning.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  -- Fulfilled pending-stop locks must never obstruct real execution. Preserve
  -- the immutable route/order history; only release the completed obligation.
  IF NEW.status IN ('completed', 'failed', 'skipped') AND OLD.status IN ('pending', 'in_progress') THEN
    NEW.locked_vehicle_id := NULL;
    NEW.locked_driver_id := NULL;
    NEW.locked_service_start_at := NULL;
  END IF;
  IF OLD.status <> 'pending' AND
    (to_jsonb(NEW) - ARRAY['status','terminal_at','skip_reason','skip_comment','actual_duration_min',
      'execution_comment','archived_at','locked_vehicle_id','locked_driver_id','locked_service_start_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','terminal_at','skip_reason','skip_comment','actual_duration_min',
      'execution_comment','archived_at','locked_vehicle_id','locked_driver_id','locked_service_start_at']) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Utförd eller aktiv uppdragshistorik får inte skrivas om av arbetsförslag.' USING ERRCODE = 'P0001';
  END IF;
  IF (old_route.optimization_frozen OR new_route.optimization_frozen) AND
    ROW(NEW.route_id, NEW.organization_id, NEW.sequence_order, NEW.address, NEW.latitude, NEW.longitude,
        NEW.service_duration_min, NEW.time_window_start, NEW.time_window_end, NEW.archived_at)
    IS DISTINCT FROM
    ROW(OLD.route_id, OLD.organization_id, OLD.sequence_order, OLD.address, OLD.latitude, OLD.longitude,
        OLD.service_duration_min, OLD.time_window_start, OLD.time_window_end, OLD.archived_at) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Uppdragets planering ingår i en fryst rutt.' USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.locked_vehicle_id IS NOT NULL OR OLD.locked_service_start_at IS NOT NULL) AND
    ROW(NEW.route_id, NEW.organization_id, NEW.archived_at) IS DISTINCT FROM
    ROW(OLD.route_id, OLD.organization_id, OLD.archived_at) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Lås upp uppdraget före flytt eller arkivering.' USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.locked_vehicle_id IS NOT NULL AND NEW.locked_vehicle_id IS NOT NULL AND
      ROW(NEW.locked_vehicle_id, NEW.locked_driver_id) IS DISTINCT FROM ROW(OLD.locked_vehicle_id, OLD.locked_driver_id))
     OR (OLD.locked_service_start_at IS NOT NULL AND NEW.locked_service_start_at IS NOT NULL AND
         NEW.locked_service_start_at IS DISTINCT FROM OLD.locked_service_start_at) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Befintligt lås måste uttryckligen låsas upp före ersättning.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER planner_stop_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON stops
FOR EACH ROW EXECUTE FUNCTION planner_stop_lock_guard();

CREATE OR REPLACE FUNCTION planner_validate_locks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deferred until commit: optimizer/preview-apply may write stops and itinerary
  -- in separate statements, but the final transaction must satisfy every lock.
  IF EXISTS (
    SELECT 1 FROM stops s LEFT JOIN routes r ON r.id = s.route_id
    WHERE s.organization_id = NEW.organization_id AND
    ((s.locked_vehicle_id IS NOT NULL AND (
      r.id IS NULL OR r.organization_id <> s.organization_id OR r.vehicle_id IS DISTINCT FROM s.locked_vehicle_id OR
      (r.handoff_version = r.plan_revision AND r.handoff_driver_id IS DISTINCT FROM s.locked_driver_id) OR
      NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = s.locked_driver_id
        AND d.organization_id = s.organization_id AND d.vehicle_id = s.locked_vehicle_id AND d.is_active)
    )) OR (s.locked_service_start_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r.workday_timeline, '[]'::jsonb)) e
      WHERE e->>'type' = 'service' AND e->>'stopId' = s.id::text
      AND (e->>'startAt')::timestamptz = s.locked_service_start_at
    )))
  ) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Resurspar eller exakt planerad servicestart bryter ett beständigt uppdragslås.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM routes r WHERE r.organization_id = NEW.organization_id AND r.optimization_frozen
    AND ((r.handoff_version = r.plan_revision AND r.handoff_driver_id IS DISTINCT FROM r.frozen_driver_id)
      OR NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = r.frozen_driver_id
      AND d.organization_id = r.organization_id AND d.vehicle_id = r.vehicle_id AND d.is_active))
  ) THEN
    RAISE EXCEPTION 'PLANNING_LOCK_CONFLICT: Fryst rutts resurspar har ändrats.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS planner_validate_route_locks ON routes;
CREATE CONSTRAINT TRIGGER planner_validate_route_locks AFTER INSERT OR UPDATE ON routes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION planner_validate_locks();
DROP TRIGGER IF EXISTS planner_validate_stop_locks ON stops;
CREATE CONSTRAINT TRIGGER planner_validate_stop_locks AFTER INSERT OR UPDATE ON stops
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION planner_validate_locks();
DROP TRIGGER IF EXISTS planner_validate_driver_locks ON drivers;
CREATE CONSTRAINT TRIGGER planner_validate_driver_locks AFTER UPDATE ON drivers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION planner_validate_locks();
