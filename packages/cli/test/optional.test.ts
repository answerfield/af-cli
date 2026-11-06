import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadOptional } from '../src/optional.js';

// Each test uses its own package name: vitest caches resolved modules by specifier across the temp projects.
/** A temp project whose `host.mjs` imports like the CLI would, resolving against the temp `node_modules`. */
async function project(packages: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'af-optional-'));
    for (const [name, code] of Object.entries(packages)) {
        const pkg = join(dir, 'node_modules', name);
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
        writeFileSync(join(pkg, 'index.js'), code);
    }
    writeFileSync(join(dir, 'host.mjs'), 'export const load = specifier => import(specifier);\n');
    const host = await import(pathToFileURL(join(dir, 'host.mjs')).href) as { load: (s: string) => Promise<unknown> };
    return host.load;
}

describe('loadOptional', () => {
    test('fehlendes Paket: undefined', async () => {
        expect(await loadOptional('@answerfield/import-iqb', await project({}))).toBeUndefined();
    });

    test('vorhandenes Paket: das Modul', async () => {
        const load = await project({ '@answerfield/export-typst': 'export const answer = 42;\n' });
        expect(await loadOptional<{ answer: number }>('@answerfield/export-typst', load)).toMatchObject({ answer: 42 });
    });

    test('vorhandenes Paket mit fehlender Abhängigkeit: Fehler wird weitergeworfen', async () => {
        const load = await project({ '@answerfield/import-iqb': "import 'missing-dep';\n" });
        await expect(loadOptional('@answerfield/import-iqb', load)).rejects.toThrow(/missing-dep/);
    });
});
