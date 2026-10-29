import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDir, linkLoop, nextStep, resolveReal } from '../src/paths.js';
import { readJsonFile } from '../src/store/io.js';

const coded = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code });

describe('nextStep', () => {
  it('names a link loop', () => {
    expect(nextStep(coded('ELOOP'))).toBe('A link in the path leads back to itself; fix or delete that link.');
  });

  it('names a file where a folder should be', () => {
    expect(nextStep(coded('ENOTDIR'))).toBe('Part of the path is a file, not a folder; move it or pick another path.');
  });

  it('points at permissions for EACCES and EPERM', () => {
    expect(nextStep(coded('EACCES'))).toBe('Check its permissions.');
    expect(nextStep(coded('EPERM'))).toBe('Check its permissions.');
  });

  it('names a folder read as a file, a full or read-only disk and too many open files', () => {
    expect(nextStep(coded('EISDIR'))).toBe('The path is a folder, not a file; pick the file inside it.');
    expect(nextStep(coded('ENOSPC'))).toBe('The disk is full; free some space and try again.');
    expect(nextStep(coded('EROFS'))).toBe('The disk is read-only; pick a writable path.');
    expect(nextStep(coded('EMFILE'))).toBe('Too many files are open; close some programs and try again.');
    expect(nextStep(coded('ENFILE'))).toBe('Too many files are open; close some programs and try again.');
  });

  it('falls back to the path for any other failure', () => {
    expect(nextStep(coded('EIO'))).toBe('Check the path and try again.');
    expect(nextStep(new Error('no code'))).toBe('Check the path and try again.');
  });
});

describe('filesystem errors carry the real next step', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'next-step-'));
    await symlink(join(dir, 'b'), join(dir, 'a'));
    await symlink(join(dir, 'a'), join(dir, 'b'));
    await writeFile(join(dir, 'file'), 'x');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('a store file read through a link loop names the loop', async () => {
    await expect(readJsonFile(join(dir, 'a', 'store.json'), 'plan')).rejects.toThrow(
      /^plan: could not read .*\(ELOOP\)\. A link in the path leads back to itself; fix or delete that link\.$/,
    );
  });

  it('a path under a file names the file', async () => {
    await expect(readJsonFile(join(dir, 'file', 'store.json'), 'plan')).rejects.toThrow(
      /^plan: could not read .*\(ENOTDIR\)\. Part of the path is a file, not a folder; move it or pick another path\.$/,
    );
  });

  it('isDir and linkLoop read a path under a file as not there', async () => {
    await expect(isDir(join(dir, 'file', 'x'), 'scan')).resolves.toBe(false);
    await expect(linkLoop(join(dir, 'file', 'x'), 'compile')).resolves.toBe(false);
  });

  it('isDir names a link loop instead of reading it as not there', async () => {
    await expect(isDir(join(dir, 'a'), 'doctor')).rejects.toThrow(/^doctor: could not check .*\(ELOOP\)\. A link in the path leads back to itself/);
  });

  it('resolveReal names the loop for a path through one', async () => {
    await expect(resolveReal(join(dir, 'a', 'x'), 'plan')).rejects.toThrow(/\(ELOOP\)\. A link in the path leads back to itself/);
  });
});
