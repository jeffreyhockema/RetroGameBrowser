// The host names this server answers to. A page on some other site can point its own name at
// this PC's address (DNS rebinding) and then read this server's answers as if they were its
// own; checking the Host header stops that, since the request still carries that other name.

import os from 'node:os';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;

/**
 * A test of a request's Host header. Allowed are localhost, this PC's own name (what a phone on
 * the network may type), `extra` names (a tunnel's public hostname, from config.allowedHosts),
 * and any bare IP address, which no other site's page can make a browser send as the host.
 */
export function hostChecker(extra = [], computerName = os.hostname()) {
  const pc = String(computerName ?? '').toLowerCase();
  const names = new Set(['localhost', pc, pc && `${pc}.local`, ...extra.map((h) => String(h).toLowerCase())].filter(Boolean));
  return (hostHeader) => {
    const host = String(hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return names.has(host) || IPV4.test(host) || IPV6.test(host);
  };
}
