// Imports IQB units and booklets from files and folders: one .af file per unit, media in a subfolder, one report.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { importBooklet, importUnit, isBookletXml } from './index.js';

/** Where the import writes its messages. */
export interface ImportLog { log(line: string): void; error(line: string): void }

/** Outcome of a folder import: exit code and the `.af` files written. */
export interface FolderResult { exitCode: number; itemFiles: string[] }

/** Converts IQB units: one .af file per unit, media in a subfolder, one shared report. */
export function importFolder(paths: string[], target: string, out: ImportLog): FolderResult {
    const xml = paths.flatMap(p => statSync(p).isDirectory() ? xmlFiles(p) : [p]);
    const units = newestUnits(xml.filter(f => isUnitFile(readFileSync(f, 'utf8'))), out);
    const booklets = xml.filter(f => isBookletXml(readFileSync(f, 'utf8')));
    if (units.length === 0) throw new Error('Keine IQB-Unit (Testcenter-XML) gefunden.');
    mkdirSync(target, { recursive: true });
    const report: Record<string, unknown> = {};
    const written = new Map<string, { file: string; source: string }>();   // item name → unit file and AF source
    const itemOf = new Map<string, string>();                              // unit ID → item name
    let failed = 0, duplicates = 0;
    for (const file of units) {
        try {
            const r = importUnit(file);
            const earlier = written.get(r.item);
            if (earlier && earlier.source === r.source) {
                // the same unit in several modules: one item suffices
                duplicates++;
                continue;
            }
            if (earlier) throw new Error(`${r.item}.af schon aus ${relative(process.cwd(), earlier.file)} erzeugt (gleiche Unit-ID, anderer Inhalt); Ordner einzeln importieren`);
            written.set(r.item, { file, source: r.source });
            itemOf.set(r.unit.id, r.item);
            writeFileSync(join(target, `${r.item}.af`), r.source);
            for (const [path, data] of r.media) {
                mkdirSync(dirname(join(target, path)), { recursive: true });
                writeFileSync(join(target, path), data);
            }
            const counts = { kept: 0, approximated: 0, missing: 0 };
            r.report.forEach(e => counts[e.fidelity]++);
            report[r.unit.id] = { label: r.unit.label, item: r.item, ...counts, entries: r.report.filter(e => e.fidelity !== 'kept') };
            out.log(`${r.unit.id.padEnd(10)} ${r.item}.af  übernommen ${counts.kept} · angenähert ${counts.approximated} · fehlt ${counts.missing}`);
        } catch (e) {
            failed++;
            out.error(`${relative(process.cwd(), file)}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    // Testcenter booklets → AF booklets over the imported items
    const bookletSources = new Map<string, string>();                     // booklet name → AF source
    for (const file of booklets) {
        const b = importBooklet(readFileSync(file, 'utf8'), itemOf);
        if (!b.source) continue;
        const earlier = bookletSources.get(b.name);
        if (earlier === b.source) continue;   // the same booklet delivered twice
        if (earlier !== undefined) {
            failed++;
            out.error(`${relative(process.cwd(), file)}: Testheft ${b.name} schon mit anderem Inhalt gelesen; Ordner einzeln importieren`);
            continue;
        }
        bookletSources.set(b.name, b.source);
        out.log(`Testheft ${b.name}${b.missing.length > 0 ? `  (${b.missing.length} Unit(s) nicht importiert, ausgelassen)` : ''}`);
    }
    const sources = [...bookletSources.values()];
    if (sources.length > 0) writeFileSync(join(target, 'booklets.af'), sources.join('\n'));
    writeFileSync(join(target, 'import-report.json'), JSON.stringify(report, null, 2) + '\n');
    const done = units.length - failed - duplicates;
    out.log(`${done} von ${units.length - duplicates} Unit(s) übersetzt${duplicates > 0 ? ` (${duplicates} doppelt in mehreren Modulen)` : ''}` +
        `${sources.length > 0 ? `, ${sources.length} Testheft(e) in booklets.af` : ''}; Bericht: ${relative(process.cwd(), join(target, 'import-report.json'))}`);
    return { exitCode: failed === 0 ? 0 : 1, itemFiles: [...written.keys()].map(item => join(target, `${item}.af`)) };
}

/**
 * One file per unit ID: a unit delivered more than once (e.g. a module downloaded twice) is taken in its newest
 * version, judged by the latest `lastChange` stamp in the unit XML (definition, coding scheme).
 */
function newestUnits(files: string[], out: ImportLog): string[] {
    const stamp = (xml: string) => [...xml.matchAll(/lastChange="([^"]+)"/g)].map(m => m[1]).sort().at(-1) ?? '';
    const byId = new Map<string, { file: string; stamp: string }>();
    for (const file of files) {
        const xml = readFileSync(file, 'utf8');
        const id = /<Id>\s*([^<]+?)\s*<\/Id>/.exec(xml)?.[1] ?? file;
        const candidate = { file, stamp: stamp(xml) };
        const earlier = byId.get(id);
        if (!earlier) { byId.set(id, candidate); continue; }
        if (readFileSync(earlier.file, 'utf8') === xml) continue;
        const newer = candidate.stamp > earlier.stamp ? candidate : earlier;
        out.log(`${id}: mehrfach geliefert, neuere Fassung ${relative(process.cwd(), newer.file)} (${newer.stamp || 'ohne Datum'})`);
        byId.set(id, newer);
    }
    return files.filter(f => [...byId.values()].some(v => v.file === f));
}

/** Testcenter unit XML: root element `<Unit>` (booklets also mention `<Unit id=…>`, but their root is `<Booklet>`). */
function isUnitFile(xml: string): boolean {
    return /^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<Unit[\s>]/.test(xml);
}

function xmlFiles(dir: string): string[] {
    return walk(dir, name => extname(name) === '.xml');
}

/**
 * Files of a folder (recursive), skipping node_modules and hidden folders. Symbolic links are not followed (no
 * cycles); unreadable entries such as dangling links are skipped instead of aborting.
 */
function walk(dir: string, wanted: (name: string) => boolean): string[] {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.flatMap(entry => {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.isSymbolicLink()) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path, wanted);
        return entry.isFile() && wanted(entry.name) ? [path] : [];
    });
}
