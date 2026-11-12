export const DISPATCH_DRAG_ACTIVATION_DISTANCE = 5;

export interface DispatchDragPointer {
  clientX: number;
  clientY: number;
}

export interface DispatchDragSession {
  stopIds: string[];
  sourceRouteId: string;
  pointerDown: DispatchDragPointer;
  active: boolean;
}

export function createDispatchDragSession(
  stopIds: string[],
  sourceRouteId: string,
  pointerDown: DispatchDragPointer,
): DispatchDragSession {
  return {
    stopIds,
    sourceRouteId,
    pointerDown,
    active: false,
  };
}

export function hasDispatchDragActivationDistance(
  session: DispatchDragSession,
  pointer: DispatchDragPointer,
): boolean {
  return (
    Math.hypot(
      pointer.clientX - session.pointerDown.clientX,
      pointer.clientY - session.pointerDown.clientY,
    ) >= DISPATCH_DRAG_ACTIVATION_DISTANCE
  );
}

export function activateDispatchDrag(
  session: DispatchDragSession,
  pointer: DispatchDragPointer,
): DispatchDragSession {
  if (session.active || !hasDispatchDragActivationDistance(session, pointer)) {
    return session;
  }
  return { ...session, active: true };
}

export function cancelDispatchDrag(_session: DispatchDragSession | null): null {
  return null;
}

/** Review owns the selection after a drop; drag cleanup must run first. */
export function handoffDispatchDrag(
  clear: () => void,
  openReview: () => void,
): void {
  clear();
  openReview();
}

export function firstDispatchTouchPoint(
  touches: ArrayLike<DispatchDragPointer>,
  changedTouches: ArrayLike<DispatchDragPointer>,
): DispatchDragPointer | null {
  return touches.length > 0
    ? touches[0]
    : changedTouches.length > 0
      ? changedTouches[0]
      : null;
}