import { join } from 'node:path';
import { plainCompiler } from '../content.js';

export const copilot = plainCompiler('copilot', join('.github', 'copilot-instructions.md'));
