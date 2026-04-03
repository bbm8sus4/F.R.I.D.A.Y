import { describe, it, expect } from 'vitest';
import { extractKeywords } from '../src/lib/context.js';

describe('extractKeywords', () => {
  it('extracts Thai + English keywords, ignoring stop words', () => {
    const result = extractKeywords('ระบบ payment ล่มครับ ด่วนมาก');
    expect(result).toContain('ระบบ');
    expect(result).toContain('payment');
    expect(result).not.toContain('ครับ'); // stop word
  });

  it('deduplicates keywords', () => {
    const result = extractKeywords('hello hello hello world');
    expect(result).toEqual(['hello', 'world']);
  });

  it('returns max 5 keywords', () => {
    const result = extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel');
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('filters single-char words', () => {
    const result = extractKeywords('a b c longer');
    expect(result).toEqual(['longer']);
  });

  it('handles empty string', () => {
    expect(extractKeywords('')).toEqual([]);
  });
});
