import { isIP } from 'node:net';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const [first, second = '0'] = address.toLowerCase().split(':');
    const prefix = Number.parseInt(first, 16);
    // Accept global unicast only; mapped IPv4, loopback, local/link-local,
    // multicast, documentation and transition ranges are not public targets.
    return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002
      && !(prefix === 0x2001 && [0, 2, 0x10, 0x20, 0xdb8].includes(Number.parseInt(second, 16)));
  }
  return false;
}
