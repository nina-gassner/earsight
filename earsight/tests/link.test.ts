import { describe, it, expect } from 'vitest';
import { generateCode, normalizeCode, peerIdFor, CODE_ALPHABET, CODE_LENGTH } from '../src/link';

describe('pairing code', () => {
  it('has the right length and only unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      expect([...c].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it('normalises what a person types', () => {
    expect(normalizeCode('k7m2qx')).toBe('K7M2QX');
    expect(normalizeCode(' k7m-2qx ')).toBe('K7M2QX');
    expect(normalizeCode('K7M2Q')).toBeNull(); // too short
    expect(normalizeCode('K7M2Q0')).toBeNull(); // 0 is not part of the alphabet
  });
  it('maps a code to a peer id', () => {
    expect(peerIdFor('K7M2QX')).toBe('earsight-K7M2QX');
  });
});
