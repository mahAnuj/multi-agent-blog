import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// The admin secret lives only in the environment. If it is unset, every
// admin route refuses rather than falling open.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// token -> expiry epoch ms. In-memory on purpose: a restart invalidates
// every session, and there is nothing to leak at rest.
const sessions = new Map<string, number>();

function sweepExpired(): void {
  const now = Date.now();
  // forEach rather than for..of: the build targets a pre-ES2015 iteration mode.
  sessions.forEach((expiry, token) => {
    if (expiry <= now) sessions.delete(token);
  });
}

export function isAdminConfigured(): boolean {
  return Boolean(ADMIN_PASSWORD && ADMIN_PASSWORD.length > 0);
}

/** Constant-time compare that tolerates differing lengths. */
export function verifyPassword(candidate: unknown): boolean {
  if (!ADMIN_PASSWORD) return false;
  if (typeof candidate !== "string") return false;

  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(ADMIN_PASSWORD, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so failure timing does not reveal length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function issueToken(): string {
  sweepExpired();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function revokeToken(token: string | null): void {
  if (token) sessions.delete(token);
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function tokenIsValid(token: string): boolean {
  const expiry = sessions.get(token);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Gate for every mutating and admin-only route. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminConfigured()) {
    res.status(503).json({
      message: "Admin access is not configured. Set ADMIN_PASSWORD in the environment.",
    });
    return;
  }

  const token = bearerToken(req);
  if (!token || !tokenIsValid(token)) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  next();
}
