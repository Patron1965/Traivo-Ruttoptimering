export interface KeyedRouteGeometry {
  requestKey: string;
}

/**
 * A geometry response is allowed to update the map only when it belongs to
 * the request currently represented by that route entry.
 */
export function canCommitRouteGeometry(
  current: KeyedRouteGeometry | undefined,
  responseRequestKey: string,
): boolean {
  return !!current && current.requestKey === responseRequestKey;
}