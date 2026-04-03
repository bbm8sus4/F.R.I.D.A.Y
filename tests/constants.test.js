import { describe, it, expect } from 'vitest';
import { URGENT_PATTERNS, MEMBER_COMMANDS, MEMBER_CALLBACKS } from '../src/lib/constants.js';

describe('URGENT_PATTERNS', () => {
  it('matches Thai urgent keywords', () => {
    const match = URGENT_PATTERNS.find(p => p.pattern.test('ด่วนมาก ช่วยดูหน่อย'));
    expect(match).toBeTruthy();
    expect(match.type).toBe('urgent');
  });

  it('matches system down pattern', () => {
    const match = URGENT_PATTERNS.find(p => p.pattern.test('ระบบล่มแล้ว'));
    expect(match).toBeTruthy();
    expect(match.type).toBe('system');
  });

  it('matches customer complaint pattern', () => {
    const match = URGENT_PATTERNS.find(p => p.pattern.test('ลูกค้าร้องเรียน'));
    expect(match).toBeTruthy();
    expect(match.type).toBe('customer');
  });

  it('does not match normal text', () => {
    const match = URGENT_PATTERNS.find(p => p.pattern.test('สวัสดีครับ วันนี้อากาศดี'));
    expect(match).toBeUndefined();
  });
});

describe('MEMBER_COMMANDS', () => {
  it('includes allowed member commands', () => {
    expect(MEMBER_COMMANDS.has('/tasks')).toBe(true);
    expect(MEMBER_COMMANDS.has('/recap')).toBe(true);
    expect(MEMBER_COMMANDS.has('/readlink')).toBe(true);
  });

  it('excludes boss-only commands', () => {
    expect(MEMBER_COMMANDS.has('/send')).toBe(false);
    expect(MEMBER_COMMANDS.has('/remember')).toBe(false);
    expect(MEMBER_COMMANDS.has('/allow')).toBe(false);
  });
});

describe('MEMBER_CALLBACKS', () => {
  it('includes allowed callback prefixes', () => {
    expect(MEMBER_CALLBACKS.has('tk:')).toBe(true);
    expect(MEMBER_CALLBACKS.has('rl:')).toBe(true);
  });

  it('excludes boss-only callbacks', () => {
    expect(MEMBER_CALLBACKS.has('send:')).toBe(false);
    expect(MEMBER_CALLBACKS.has('pa:')).toBe(false);
  });
});
