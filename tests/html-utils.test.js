import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeHtml, stripHtmlTags, splitMessage, balanceHtmlTags, htmlToText, truncateDesc } from '../src/lib/html-utils.js';

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('sanitizeHtml', () => {
  it('keeps allowed tags', () => {
    expect(sanitizeHtml('<b>bold</b> <i>italic</i>')).toBe('<b>bold</b> <i>italic</i>');
  });

  it('strips unsupported tags but keeps content', () => {
    expect(sanitizeHtml('<div>hello</div>')).toBe('hello');
    expect(sanitizeHtml('<span>world</span>')).toBe('world');
  });

  it('converts headings to bold', () => {
    expect(sanitizeHtml('<h1>Title</h1>')).toBe('<b>Title</b>');
    expect(sanitizeHtml('<h3>Sub</h3>')).toBe('<b>Sub</b>');
  });

  it('auto-closes unclosed tags', () => {
    expect(sanitizeHtml('<b>unclosed')).toBe('<b>unclosed</b>');
  });

  it('sanitizes <a> href to only allow http/https/mailto', () => {
    expect(sanitizeHtml('<a href="https://example.com">link</a>')).toBe('<a href="https://example.com">link</a>');
    expect(sanitizeHtml('<a href="javascript:alert(1)">xss</a>')).toBe('<a>xss</a>');
  });
});

describe('stripHtmlTags', () => {
  it('removes all tags and unescapes entities', () => {
    expect(stripHtmlTags('<b>bold &amp; italic</b>')).toBe('bold & italic');
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMessage('short text', 4096)).toEqual(['short text']);
  });

  it('splits long text at newline boundaries', () => {
    const text = 'line1\n\n' + 'x'.repeat(4090);
    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('line1');
  });

  it('balances HTML tags across chunks', () => {
    const text = '<b>' + 'x'.repeat(4090) + ' more text</b>';
    const chunks = splitMessage(text, 4096, true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should close the <b> tag
    expect(chunks[0]).toContain('</b>');
    // Second chunk should reopen <b>
    expect(chunks[1]).toMatch(/^<b>/);
  });
});

describe('balanceHtmlTags', () => {
  it('detects unclosed tags', () => {
    const { closeTags, reopenTags } = balanceHtmlTags('<b>hello <i>world');
    expect(closeTags).toBe('</i></b>');
    expect(reopenTags).toBe('<b><i>');
  });

  it('handles fully balanced tags', () => {
    const { closeTags, reopenTags } = balanceHtmlTags('<b>hello</b>');
    expect(closeTags).toBe('');
    expect(reopenTags).toBe('');
  });
});

describe('htmlToText', () => {
  it('strips tags and converts block elements to newlines', () => {
    const result = htmlToText('<p>Hello</p><p>World</p>');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('removes script and style tags entirely', () => {
    expect(htmlToText('<script>alert(1)</script>hello')).toBe('hello');
    expect(htmlToText('<style>.x{}</style>hello')).toBe('hello');
  });

  it('unescapes HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });
});

describe('truncateDesc', () => {
  it('returns first line if short enough', () => {
    expect(truncateDesc('short desc')).toBe('short desc');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'a'.repeat(100);
    const result = truncateDesc(long, 60);
    expect(result.length).toBe(61); // 60 chars + …
    expect(result).toMatch(/…$/);
  });

  it('returns empty string for null/undefined', () => {
    expect(truncateDesc(null)).toBe('');
    expect(truncateDesc(undefined)).toBe('');
  });
});
