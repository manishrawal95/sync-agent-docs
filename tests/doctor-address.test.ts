import { describe, expect, it } from 'vitest';
import { isGlobal, notGlobal } from '../src/doctor/live.js';

describe('doctor --live: only global unicast addresses are contacted', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.100.100.100', '100.127.255.255', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('refuses special-purpose IPv4 %s', (a) => expect(isGlobal(a)).toBe(false));

  it.each(['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.32.0.1', '198.20.0.1', '223.255.255.254'])(
    'allows global IPv4 %s', (a) => expect(isGlobal(a)).toBe(true));

  it.each([
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '2002:7f00:1::1', '2002:808:808::1', '2001:db8::1', '3fff::1',
    '2001::1', '2001:0:4136:e378::1', '4000::1', '100::1',
  ])('refuses non-global IPv6 %s', (a) => expect(isGlobal(a)).toBe(false));

  it.each(['2606:4700::1111', '2a00:1450:4001::1', '::ffff:8.8.8.8', '::ffff:808:808'])('allows global IPv6 %s', (a) => expect(isGlobal(a)).toBe(true));

  it('a name is refused when any one of its addresses is not global, and the reason names that address', () => {
    expect(notGlobal([{ address: '8.8.8.8', family: 4 }, { address: '::ffff:192.168.0.1', family: 6 }])).toBe('::ffff:192.168.0.1');
    expect(notGlobal([{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }])).toBeNull();
    expect(notGlobal([])).toBe('(no address)');
  });

  it('refuses text that is not an address', () => expect(isGlobal('example.invalid')).toBe(false));
});
