import { randomBytes } from "node:crypto";
import type { RoutingProviderBinding } from "./routing-provider-config";

// No source coordinates or original fields retained. Restart/expiry requires a new
// explicit check; a client cannot manufacture proof of a completed position check.
const previews=new Map<string,{organizationId:string;planId:string;zoneId:string;sourceHash:string;binding:string;expires:number}>();
export function recordBulkPreview(organizationId:string,planId:string,zoneId:string,sourceHash:string,binding:RoutingProviderBinding) {
  for(const [key,value] of previews) if(value.expires<=Date.now()) previews.delete(key);
  if(previews.size>=128) throw new Error("För många förkontroller. Försök igen efter fem minuter.");
  const token=randomBytes(32).toString("hex");
  previews.set(token,{organizationId,planId,zoneId,sourceHash,binding:JSON.stringify(binding),expires:Date.now()+300000});
  return token;
}
export function validBulkPreview(token:string|undefined,organizationId:string,planId:string,zoneId:string,
  sourceHash:string,binding:RoutingProviderBinding) {
  const value=token?previews.get(token):undefined;
  return !!value && value.expires>Date.now() && value.organizationId===organizationId && value.planId===planId &&
    value.zoneId===zoneId && value.sourceHash===sourceHash && value.binding===JSON.stringify(binding);
}
