import { describe, expect, it } from 'vitest';
import { floorFromHost, previewAddress, previewOrigin, previewSrc } from './previewAddress.ts';

describe('previewAddress', () => {
  it('accepts an empty address (off)', () => {
    expect(previewAddress('')).toBe('');
    expect(previewAddress('   ')).toBe('');
  });

  it('accepts {floor} in the host', () => {
    expect(previewAddress('https://office-floor{floor}.example.com')).toBe('https://office-floor{floor}.example.com');
  });

  it('accepts {floor} in the port', () => {
    expect(previewAddress('http://office.example.com:4{floor}')).toBe('http://office.example.com:4{floor}');
  });

  it('rejects a template with no {floor}', () => {
    expect(previewAddress('https://office.example.com')).toBeNull();
  });

  it('rejects {floor} only in the path', () => {
    expect(previewAddress('https://office.example.com/{floor}')).toBeNull();
  });

  it('rejects a non-http(s) scheme', () => {
    expect(previewAddress('ftp://office-floor{floor}.example.com')).toBeNull();
  });

  it('rejects junk', () => {
    expect(previewAddress('not a url')).toBeNull();
    expect(previewAddress(42)).toBeNull();
    expect(previewAddress('javascript:alert(1)//{floor}')).toBeNull();
  });

  it('matches a Host to its floor, case-insensitively', () => {
    const t = 'https://office-floor{floor}.example.com';
    expect(floorFromHost('office-floor3.example.com', t)).toBe(3);
    expect(floorFromHost('OFFICE-FLOOR3.EXAMPLE.COM', t)).toBe(3);
    expect(floorFromHost('office-floor0.example.com', t)).toBeNull(); // floor 0 doesn't exist
    expect(floorFromHost('office-floor3x.example.com', t)).toBeNull();
    expect(floorFromHost('something-else.example.com', t)).toBeNull();
  });

  it('matches a Host with the floor in the port', () => {
    const t = 'http://office.example.com:4{floor}';
    expect(floorFromHost('office.example.com:41', t)).toBe(1);
    expect(floorFromHost('office.example.com:412', t)).toBe(12);
    expect(floorFromHost('office.example.com:5317', t)).toBeNull();
  });

  it('never matches with an empty (off) template', () => {
    expect(floorFromHost('office-floor1.example.com', '')).toBeNull();
  });

  it("builds the floor's origin from the template", () => {
    expect(previewOrigin('https://office-floor{floor}.example.com', 2)).toBe('https://office-floor2.example.com');
    expect(previewOrigin('http://office.example.com:4{floor}', 7)).toBe('http://office.example.com:47');
  });

  it('previewSrc keeps the url as is on a local page', () => {
    const t = 'https://office-floor{floor}.example.com';
    expect(previewSrc('http://localhost:6301/assets/app.js', 1, t, 'localhost')).toBe('http://localhost:6301/assets/app.js');
    expect(previewSrc('http://localhost:6301/', 1, t, '127.0.0.1')).toBe('http://localhost:6301/');
    expect(previewSrc('http://localhost:6301/', 1, t, '[::1]')).toBe('http://localhost:6301/');
  });

  it('previewSrc rewrites to the floor origin on a remote page', () => {
    const t = 'https://office-floor{floor}.example.com';
    expect(previewSrc('http://localhost:6301/assets/app.js?x=1#y', 1, t, 'phone.example.net')).toBe('https://office-floor1.example.com/assets/app.js?x=1#y');
  });

  it('previewSrc keeps the url as is with no template', () => {
    expect(previewSrc('http://localhost:6301/', 1, '', 'phone.example.net')).toBe('http://localhost:6301/');
  });
});
