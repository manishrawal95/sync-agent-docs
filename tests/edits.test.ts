import { describe, expect, it } from 'vitest';
import { checkEdits, editText } from '../src/apply/edits.js';
import { lineHash } from '../src/plan/lines.js';
import type { Edit } from '../src/plan/types.js';

const P = '/r/shop/CLAUDE.md';

describe('editText', () => {
  it('keeps CRLF line endings', () => {
    const edits: Edit[] = [{ path: P, line: 2, op: 'replace', lineHash: lineHash('b'), after: 'B' }, { path: P, line: 0, op: 'append', after: '@x' }];
    expect(editText('a\r\nb\r\n', edits)).toBe('a\r\nB\r\n@x\r\n');
  });

  it('keeps a file without a final newline that way', () => {
    expect(editText('a\nb', [{ path: P, line: 1, op: 'remove', lineHash: lineHash('a') }])).toBe('b');
  });
});

describe('checkEdits', () => {
  it('refuses a remove or replace without a line hash', () => {
    expect(() => checkEdits('a\n', [{ path: P, line: 1, op: 'remove' }], 'shop/CLAUDE.md')).toThrow(/shop\/CLAUDE\.md line 1: the remove edit in plan\.json has no lineHash/);
    expect(() => checkEdits('a\n', [{ path: P, line: 1, op: 'replace', after: 'b' }], 'shop/CLAUDE.md')).toThrow(/replace edit in plan\.json has no lineHash/);
  });

  it('refuses a replace or append without the new text', () => {
    expect(() => checkEdits('a\n', [{ path: P, line: 1, op: 'replace', lineHash: lineHash('a') }], 'shop/CLAUDE.md')).toThrow(/replace edit in plan\.json has no after/);
    expect(() => checkEdits('a\n', [{ path: P, line: 0, op: 'append' }], 'shop/CLAUDE.md')).toThrow(/append edit in plan\.json has no after/);
  });

  it('hashes a CRLF line without its carriage return', () => {
    expect(() => checkEdits('a\r\nb\r\n', [{ path: P, line: 2, op: 'remove', lineHash: lineHash('b') }], 'x')).not.toThrow();
  });
});
