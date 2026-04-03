import { describe, it, expect } from 'vitest';
import { detectBossMention, parseCommand } from '../src/lib/auth.js';

// ===== parseCommand =====
describe('parseCommand', () => {
  it('parses simple command', () => {
    expect(parseCommand('/send hello')).toEqual({ cmd: '/send', args: 'hello' });
  });

  it('parses command with bot mention', () => {
    expect(parseCommand('/send@FridayBot hello')).toEqual({ cmd: '/send', args: 'hello' });
  });

  it('parses command with no args', () => {
    expect(parseCommand('/tasks')).toEqual({ cmd: '/tasks', args: '' });
  });

  it('parses command with multiline args', () => {
    const result = parseCommand('/remember line1\nline2');
    expect(result.cmd).toBe('/remember');
    expect(result.args).toBe('line1\nline2');
  });

  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('not a /command')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

// ===== detectBossMention =====
describe('detectBossMention', () => {
  const bossId = 12345;
  const bossUsername = 'bossuser';
  const env = {};

  it('detects @username tag via entity', () => {
    const message = {
      text: 'Hey @bossuser check this',
      entities: [{ type: 'mention', offset: 4, length: 9 }],
    };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe('tag');
  });

  it('detects text_mention (user without username)', () => {
    const message = {
      text: 'Hey Boss check this',
      entities: [{ type: 'text_mention', offset: 4, length: 4, user: { id: bossId } }],
    };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe('tag');
  });

  it('detects reply to boss message', () => {
    const message = {
      text: 'I agree',
      reply_to_message: { from: { id: bossId } },
    };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe('reply');
  });

  it('ignores reply in forum topic', () => {
    const message = {
      text: 'I agree',
      is_topic_message: true,
      reply_to_message: { from: { id: bossId } },
    };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe(false);
  });

  it('detects nickname mention (default nicknames)', () => {
    const message = { text: 'พี่บ๊อบ ช่วยดูหน่อย' };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe('nickname');
  });

  it('detects nickname from env.BOSS_NICKNAMES', () => {
    const customEnv = { BOSS_NICKNAMES: '["มิว","มิวว์"]' };
    const message = { text: 'มิว ช่วยดูหน่อย' };
    expect(detectBossMention(message, bossId, bossUsername, customEnv)).toBe('nickname');
  });

  it('returns false when no mention', () => {
    const message = { text: 'just chatting with friends' };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe(false);
  });

  it('returns false for empty text and no entities', () => {
    const message = { text: '' };
    expect(detectBossMention(message, bossId, bossUsername, env)).toBe(false);
  });
});
