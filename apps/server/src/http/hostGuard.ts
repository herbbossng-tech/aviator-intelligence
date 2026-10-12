import type { RequestHandler } from 'express';
import { LOOPBACK_HOSTS } from '../config/env.js';

/** host [":" port], where host is a bracketed IPv6 literal or a plain name / IPv4 address. */
const AUTHORITY = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::(\d{1,5}))?$/i;

/**
 * Lower-cased hostname of a Host header value ("127.0.0.1:4317" -> "127.0.0.1",
 * "[::1]:4317" -> "::1"), or null if the whole value is not a well-formed authority.
 * Malformed values such as "[::1]evil.example" or "localhost:1:2" are rejected rather
 * than reduced to a loopback-looking prefix.
 */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const match = AUTHORITY.exec(hostHeader);
  if (!match) return null;
  if (match[3] !== undefined && Number(match[3]) > 65_535) return null;
  return (match[1] ?? match[2] ?? '').toLowerCase() || null;
}

/**
 * Mitigates DNS rebinding while the API is bound to loopback: a page on another domain that
 * re-points its name at 127.0.0.1 still sends its own Host header, so only the loopback names
 * localhost, 127.0.0.1 and [::1] are accepted. This is not authentication: any local process
 * can still call the API, so it must not be exposed to a network.
 * (The Vite dev proxy forwards Host 127.0.0.1:5173.)
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
