import { describe, expect, it } from 'vitest';
import { checkEdits, editText, manualPatch } from '../src/apply/edits.js';
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

  it('does not append a line the file already has, whatever spaces either side carries', () => {
    const append = (after: string): Edit[] => [{ path: P, line: 0, op: 'append', after }];
    expect(editText('a\nport 3000\n', append('  port 3000'))).toBe('a\nport 3000\n');
    expect(editText('a\n  port 3000  \n', append('port 3000'))).toBe('a\n  port 3000  \n');
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

describe('manualPatch', () => {
  const MP = '/home/u/.claude/CLAUDE.md';
  const why = 'it is not inside a git repository';

  it('leaves out an append whose line is already in the file', () => {
    const patch = manualPatch(MP, 'a\nport 3000\n', [{ path: MP, line: 3, op: 'append', after: 'port 3000' }], why);
    expect(patch).not.toContain('@@');
    expect(patch).not.toContain('+port 3000');
  });

  it('keeps a new append and counts only it in the hunk', () => {
    const edits: Edit[] = [
      { path: MP, line: 3, op: 'append', after: 'port 3000' },
      { path: MP, line: 3, op: 'append', after: 'host 100.64.1.2' },
      { path: MP, line: 3, op: 'append', after: 'host 100.64.1.2' },
    ];
    const patch = manualPatch(MP, 'a\n  port 3000\n', edits, why);
    expect(patch.match(/^\+host 100\.64\.1\.2$/gm)).toHaveLength(1);
    expect(patch).not.toMatch(/^\+\s*port 3000$/m);
    expect(patch).toMatch(/^@@ -\d+,0 \+\d+,1 @@/m);
  });

  it('skips an append of a line a replace produced, whatever spaces the replace carries', () => {
    const edits: Edit[] = [
      { path: MP, line: 1, op: 'replace', lineHash: lineHash('a'), after: '  port 3000  ' },
      { path: MP, line: 3, op: 'append', after: 'port 3000' },
    ];
    expect(manualPatch(MP, 'a\n', edits, why)).not.toMatch(/^\+port 3000$/m);
  });

  it('does not let PORT=3000 suppress an append of PORT=30001', () => {
    const patch = manualPatch(MP, 'PORT=3000\n', [{ path: MP, line: 2, op: 'append', after: 'PORT=30001' }], why);
    expect(patch).toMatch(/^\+PORT=30001$/m);
  });

  it('skips an already-present append in a CRLF file', () => {
    const patch = manualPatch(MP, 'a\r\nport 3000\r\n', [{ path: MP, line: 3, op: 'append', after: 'port 3000' }], why);
    expect(patch).not.toContain('@@');
  });
});
