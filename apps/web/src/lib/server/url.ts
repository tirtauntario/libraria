/**
 * Server addresses. Users type all sorts of things ("books.example.org",
 * "https://host/api/v1/info", "localhost:8080/"); normalize to an origin
 * plus optional base path, without a trailing slash.
 */
import { API_PREFIX } from '@libraria/core';

export class ServerUrlError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid' | 'insecure',
  ) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** Normalized base URL of a server, e.g. `https://books.example.org` or `http://localhost:8080`. */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new ServerUrlError('Enter the address of the server.', 'invalid');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // No scheme: local addresses default to http, everything else to https.
    const host = raw.split(/[/:?#]/)[0] ?? '';
    raw = `${isLocalHost(host.toLowerCase()) ? 'http' : 'https'}://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerUrlError('That does not look like a web address.', 'invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ServerUrlError('The address must start with https://', 'invalid');
  }
  if (url.username || url.password) throw new ServerUrlError('Leave the user name out of the address.', 'invalid');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new ServerUrlError(
      'Libraria servers must use HTTPS. Plain http:// only works for localhost. Put the server behind Caddy, Tailscale or a Cloudflare Tunnel to get a certificate.',
      'insecure',
    );
  }
  let path = url.pathname.replace(/\/+$/, '');
  // People paste API links; strip the API part.
  const api = path.indexOf(API_PREFIX);
  if (api >= 0) path = path.slice(0, api);
  // A link to the web app served by the server (index.html) also points at the server.
  path = path.replace(/\/index\.html$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** True when this page cannot call `serverUrl` because of mixed content. */
export function isMixedContent(serverUrl: string, pageProtocol = typeof location !== 'undefined' ? location.protocol : 'https:'): boolean {
  return pageProtocol === 'https:' && serverUrl.startsWith('http:');
}

/** `#/join?server=…&invite=…` link for an invite. `appUrl` is where this app is served. */
export function inviteLink(appUrl: string, serverUrl: string, token: string): string {
  const base = appUrl.replace(/#.*$/, '');
  return `${base}#/join?server=${encodeURIComponent(serverUrl)}&invite=${encodeURIComponent(token)}`;
}

/** The address of this app (without the hash). */
export function appBaseUrl(): string {
  if (typeof location === 'undefined') return '';
  return location.href.replace(/#.*$/, '');
}
