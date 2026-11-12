import type { NextFunction, Request, Response } from "express";
import { isUuidParam } from "./auth";
import {
  verifyDriverRouteOwnership,
  verifyDriverStopOwnership,
} from "../services/field-service";
import {
  DriverAssistanceError,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

type OwnershipVerifier = typeof verifyDriverStopOwnership;
type RouteOwnershipVerifier = typeof verifyDriverRouteOwnership;

export function requireBillingReadyReadAccess() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required" });
      return;
    }
    if (req.user.role !== "admin" && req.user.role !== "dispatcher") {
      res.status(403).json({ error: "Forbidden: billing data requires dispatcher or admin role" });
      return;
    }
    next();
  };
}

function requireOwnedStopReadAccess(
  allowViewer: boolean,
  verifyOwnership: OwnershipVerifier = verifyDriverStopOwnership,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required" });
      return;
    }

    if (req.user.role === "admin") {
      try {
        const rawStopId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        await validateDriverAssistanceContext(req, rawStopId ? { stopId: rawStopId } : {});
      } catch (error) {
        if (error instanceof DriverAssistanceError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
        return;
      }
      next();
      return;
    }
    if (req.user.role === "dispatcher") {
      next();
      return;
    }
    if (req.user.role === "viewer" && allowViewer) {
      next();
      return;
    }
    if (req.user.role !== "driver") {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    if (!req.user.driverProfileId) {
      res.status(403).json({ error: "Forbidden: driver account has no linked driver profile" });
      return;
    }

    const rawStopId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!rawStopId || !isUuidParam(rawStopId)) {
      res.status(400).json({ error: "Invalid stop id" });
      return;
    }

    try {
      const ownershipError = await verifyOwnership(
        rawStopId,
        req.user.organizationId,
        req.user.driverProfileId,
      );
      if (ownershipError) {
        res.status(ownershipError.statusCode).json({ error: ownershipError.message });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireStopReadAccess(
  verifyOwnership: OwnershipVerifier = verifyDriverStopOwnership,
) {
  return requireOwnedStopReadAccess(true, verifyOwnership);
}

export function requireProofReadAccess(
  verifyOwnership: OwnershipVerifier = verifyDriverStopOwnership,
) {
  return requireOwnedStopReadAccess(false, verifyOwnership);
}

export function requireServiceReportReadAccess(
  verifyOwnership: OwnershipVerifier = verifyDriverStopOwnership,
) {
  return requireOwnedStopReadAccess(false, verifyOwnership);
}

export function requireRouteReadAccess(
  verifyOwnership: RouteOwnershipVerifier = verifyDriverRouteOwnership,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required" });
      return;
    }
    if (req.user.role === "admin") {
      const rawRouteId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      try {
        await validateDriverAssistanceContext(req, rawRouteId ? { routeId: rawRouteId } : {});
      } catch (error) {
        if (error instanceof DriverAssistanceError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
        return;
      }
      next();
      return;
    }
    if (req.user.role === "dispatcher" || req.user.role === "viewer") {
      next();
      return;
    }
    if (req.user.role !== "driver" || !req.user.driverProfileId) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }

    const rawRouteId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!rawRouteId || !isUuidParam(rawRouteId)) {
      res.status(400).json({ error: "Invalid route id" });
      return;
    }

    try {
      const ownershipError = await verifyOwnership(
        rawRouteId,
        req.user.organizationId,
        req.user.driverProfileId,
      );
      if (ownershipError) {
        res.status(ownershipError.statusCode).json({ error: ownershipError.message });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}