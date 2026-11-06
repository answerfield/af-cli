import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { importFolder } from '../src/index.js';

describe('importFolder', () => {
    test('eine Unit: eine .af-Datei und der Importbericht', () => {
        const target = mkdtempSync(join(tmpdir(), 'af-folder-'));
        const lines: string[] = [];
        const result = importFolder([join(__dirname, 'fixtures/demo.xml')], target, { log: l => lines.push(l), error: l => lines.push(`! ${l}`) });
        expect(result.exitCode).toBe(0);
        expect(result.itemFiles).toHaveLength(1);
        expect(result.itemFiles[0]).toMatch(/\.af$/);
        expect(existsSync(result.itemFiles[0]!)).toBe(true);
        expect(existsSync(join(target, 'import-report.json'))).toBe(true);
    });
});
