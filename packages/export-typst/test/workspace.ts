import { join } from 'node:path';
import { workspace as workspaceIn } from '@answerfield/compiler/testing';

/** Loads this package's own fixtures (`test/fixtures`) plus inline sources into one workspace. */
export const workspace = (extra: Record<string, string> = {}) => workspaceIn(extra, join(__dirname, 'fixtures'));
