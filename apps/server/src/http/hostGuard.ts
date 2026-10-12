import type { RequestHandler } from 'express';
import { LOOPBACK_HOSTS } from '../config/env.js';

/** Hostname part of a Host header value: "127.0.0.1:4317" -> "127.0.0.1", "[::1]:4317" -> "::1". */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.split(':')[0] || null;
}

/**
 * DNS-rebinding guard. While the API is bound to a loopback address, a web page on another
 * domain can still reach it if that domain is re-pointed at 127.0.0.1; such requests carry
 * the attacker's Host header. Only loopback host names are accepted, so a rebound page can
 * neither read local data nor write rounds. (The Vite dev proxy forwards Host 127.0.0.1:5173.)
 */
export const loopbackHostGuard: RequestHandler = (req, res, next) => {
  const hostname = hostnameOf(req.headers.host);
  if (hostname !== null && LOOPBACK_HOSTS.has(hostname)) {
    next();
    return;
  }
  res.status(403).json({
    error: {
      code: 'forbidden_host',
      message: 'This local API only accepts requests addressed to localhost, 127.0.0.1 or [::1].',
    },
  });
};
