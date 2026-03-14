import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

export type UserRole = "admin" | "dispatcher" | "driver";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string;
  driverProfileId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.headers["x-user-id"] as string;
    if (!userId) {
      next();
      return;
    }

    try {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);

      if (user) {
        req.user = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role as UserRole,
          organizationId: user.organizationId,
          driverProfileId: user.driverProfileId,
        };
      }
    } catch {}

    next();
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      next();
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }

    next();
  };
}

export function requireAuth() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      next();
      return;
    }

    next();
  };
}
