import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

// A fake git whose stdin breaks with a non-EPIPE error while git itself exits 128: a real git cannot be made to do both.
vi.mock('node:child_process', () => {
  const execFile = () => { throw new Error('execFile is only used through promisify'); };
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (_file: string, args: string[]) => {
    const stdin = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => stdin.emit('error', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }))),
    });
    const done = args[0] === 'config'
      ? Promise.resolve({ stdout: '', stderr: '' })
      : new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('git failed'), { code: 128, stderr: 'fatal: bad\n' })), 10));
    return Object.assign(done, { child: { stdin } });
  };
  return { execFile };
});

const { GitError, ignoredPaths } = await import('../src/git.js');

describe('git stdin errors', () => {
  it('a stdin error other than EPIPE stays on the error when git also fails', async () => {
    const err = await ignoredPaths('/tmp/example-repo', ['a.md'], 'scan').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(GitError);
    const cause = err?.cause as { cause?: { code?: string } } | undefined;
    expect(cause?.cause?.code).toBe('ECONNRESET');
  });
});
