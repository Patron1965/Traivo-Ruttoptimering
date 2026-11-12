import { broadcast } from "../ws";

export type EntityType =
  | "route"
  | "vehicle"
  | "stop"
  | "driver"
  | "policy"
  | "certification";
export type ChangeType = "created" | "updated" | "deleted";

export function broadcastDataChange(
  organizationId: string,
  entity: EntityType,
  change: ChangeType,
  data: Record<string, unknown>
) {
  broadcast(organizationId, `data:${entity}:${change}`, {
    entity,
    change,
    ...data,
  });
}
