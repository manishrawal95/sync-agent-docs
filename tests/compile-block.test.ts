import { describe, expect, it } from 'vitest';
import { editReason, outsideCompiled, type CompiledBlock, readCompiledBlock, writeCompiledBlock } from '../src/compile/block.js';
import { blockHash, mergeView, readBlocks } from '../src/views/render.js';

const BODY = '## Facts from the truth store\n\n| port | 3300 | verified |';

describe('compiled block', () => {
  it('reads back what it wrote, with a matching hash', () => {
    const text = writeCompiledBlock('# Shop\n', BODY);
    const block = readCompiledBlock(text);
    expect(block?.body).toBe(BODY);
    expect(block?.recorded).toBe(blockHash(BODY));
    expect(block?.actual).toBe(block?.recorded);
  });

  it('keeps every byte outside the markers when it rewrites a block', () => {
    const before = 'Top line\n\n';
    const after = '\nBottom line, no final newline';
    const first = writeCompiledBlock(`${before}PLACE${after}`.replace('PLACE', ''), BODY);
    const placed = `${before}${first.slice(first.indexOf('<!--'), first.lastIndexOf('-->') + 3)}${after}`;
    const rewritten = writeCompiledBlock(placed, 'new body');
    expect(rewritten.startsWith(before)).toBe(true);
    expect(rewritten.endsWith(after)).toBe(true);
    expect(readCompiledBlock(rewritten)?.body).toBe('new body');
  });

  it('tells a hand edit inside the block apart from a clean one', () => {
    const text = writeCompiledBlock('', BODY).replace('3300', '3301');
    const block = readCompiledBlock(text);
    expect(block?.recorded).not.toBeNull();
    expect(block?.recorded).not.toBe(block?.actual);
  });

  it('reads a block whose hash line was deleted as unrecorded', () => {
    const text = writeCompiledBlock('', BODY).replace(/<!-- sync-agent-docs:hash [0-9a-f]+ -->\n/, '');
    expect(readCompiledBlock(text)?.recorded).toBeNull();
  });

  it('keeps CRLF line endings and reads them back unedited', () => {
    const text = writeCompiledBlock('# Shop\r\n\r\nNotes\r\n', BODY);
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
    const block = readCompiledBlock(text);
    expect(block?.recorded).toBe(block?.actual);
    const again = writeCompiledBlock(text, 'other');
    expect(again.replaceAll('\r\n', '')).not.toContain('\n');
    expect(again.startsWith('# Shop\r\n\r\nNotes\r\n')).toBe(true);
  });

  it('appends a block to a file without one after one blank line', () => {
    expect(writeCompiledBlock('# Shop\n\n\n', 'b')).toMatch(/^# Shop\n\n<!-- sync-agent-docs:begin compiled -->\n/);
    expect(writeCompiledBlock(null, 'b', '---\nx: 1\n---\n\n')).toMatch(/^---\nx: 1\n---\n\n<!-- sync-agent-docs:begin compiled -->\n/);
  });

  it('returns null for a file with no compiled block', () => {
    expect(readCompiledBlock('# Shop\n')).toBeNull();
  });

  it('refuses a begin marker with no end, naming the block', () => {
    expect(() => readCompiledBlock('<!-- sync-agent-docs:begin compiled -->\nhalf')).toThrow(/compiled has no end marker/);
    expect(() => writeCompiledBlock('<!-- sync-agent-docs:begin compiled -->\nhalf', 'b')).toThrow(/compiled/);
  });

  it('markers inside a fenced code block are an example, not a block', () => {
    const example = '# Docs\n\n```md\n<!-- sync-agent-docs:begin compiled -->\nexample\n<!-- sync-agent-docs:end compiled -->\n```\n\n~~~\n<!-- sync-agent-docs:begin x -->\n~~~\n';
    expect(readCompiledBlock(example)).toBeNull();
    expect(readBlocks(example)).toEqual({});
    const written = writeCompiledBlock(example, 'real');
    expect(written.startsWith(example.trimEnd())).toBe(true);
    expect(readCompiledBlock(written)?.body).toBe('real');
    expect(writeCompiledBlock(written, 'again')).toBe(writeCompiledBlock(example, 'again'));
    expect(outsideCompiled(written)).toContain('example');
    expect(mergeView(example, 'Docs', [])).toContain('example');
  });

  it('an empty or blank existing file is written as new, with the prefix', () => {
    const prefix = '---\nalwaysApply: true\n---\n\n';
    expect(writeCompiledBlock('', BODY, prefix)).toBe(writeCompiledBlock(null, BODY, prefix));
    expect(writeCompiledBlock(' \n\n', BODY, prefix)).toBe(writeCompiledBlock(null, BODY, prefix));
  });

  it('a fence that never closes is ignored, so the block appended after it is found and a rerun changes nothing', () => {
    const once = writeCompiledBlock('# notes\n```\nnever closed\n', BODY);
    expect(readCompiledBlock(once)?.actual).toBeDefined();
    expect(writeCompiledBlock(once, BODY)).toBe(once);
  });

  it('says whether the hash line is gone or the body changed', () => {
    const text = writeCompiledBlock('', BODY);
    const reason = (t: string) => editReason(readCompiledBlock(t) as CompiledBlock);
    expect(reason(text)).toBeNull();
    expect(reason(text.replace('3300', '3301'))).toBe('body-changed');
    expect(reason(text.replace(/<!-- sync-agent-docs:hash [0-9a-f]{16} -->\n/, ''))).toBe('hash-missing');
  });
});
