import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { main } from '../src/index.js';
import { loadOptional } from '../src/optional.js';

// Delegates to the real loader unless a test makes it report a missing package.
vi.mock('../src/optional.js', async importOriginal => {
    const original = await importOriginal<typeof import('../src/optional.js')>();
    return { ...original, loadOptional: vi.fn(original.loadOptional) };
});

const FIXTURES = join(__dirname, 'fixtures');

function capture() {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`! ${l}`) } };
}

describe('af', () => {
    test('check: Testaufgaben sind fehlerfrei', async () => {
        const { lines, out } = capture();
        expect(await main(['check', FIXTURES], out)).toBe(0);
        expect(lines.at(-1)).toMatch(/Datei\(en\) geprüft, keine Fehler/);
    });

    test('check --versions: Übersicht je Aufgabe', async () => {
        const { lines, out } = capture();
        expect(await main(['check', join(FIXTURES, 'reading3.af'), '--versions'], out)).toBe(0);
        expect(lines.join('\n')).toContain('reading3 „Der Leuchtturm“\n    ausgeschlossen: Vorlesen, Einfache Sprache, Leichte Sprache (misst Leseverstehen)\n    Bildbeschreibungen: 1 von 1 Grafiken');
    });

    test('compile: Testheft als Release-Bundle mit Hash, zweimal gleich', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-'));
        const run = async () => {
            const { lines, out } = capture();
            expect(await main(['compile', join(FIXTURES, 'fractions/booklet.af'), '--root', FIXTURES, '--out', dir], out)).toBe(0);
            return lines;
        };
        const first = await run(), second = await run();
        expect(first[0]).toMatch(/booklet\.bundle\.json {2}sha256:[0-9a-f]{64}$/);
        expect(first[0].split('sha256:')[1]).toBe(second[0].split('sha256:')[1]);
        expect(first[1]).toMatch(/^ {2}Kodierung sha256:[0-9a-f]{64}$/);
        expect(first[2]).toBe('  3 Aufgabe(n), 7 Komponente(n), 3 Kodierung(en), Testheft: brueche');
        const bundle = JSON.parse(readFileSync(join(dir, 'booklet.bundle.json'), 'utf8'));
        expect(bundle.booklets[0].parts[1].entries).toEqual(['fraction1', 'fraction2', 'fraction3']);
    }, 30000);

    test('compile: Medien mit Hash im Bundle, --assets legt sie nach Inhalt ab; fehlende Medien brechen ab', async () => {
        const root = mkdtempSync(join(tmpdir(), 'af-'));
        mkdirSync(join(root, 'images'));
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
        writeFileSync(join(root, 'images', 'circle.svg'), svg);
        writeFileSync(join(root, 'a.af'), 'item a { image(src: "images/circle.svg", alt: "Kreis") image(src: "https://example.org/x.png", alt: "x") }');
        const { lines, out } = capture();
        expect(await main(['compile', join(root, 'a.af'), '--root', root, '--out', join(root, 'out'), '--assets', join(root, 'cdn')], out)).toBe(0);
        const hex = createHash('sha256').update(svg).digest('hex');
        const bundle = JSON.parse(readFileSync(join(root, 'out', 'a.bundle.json'), 'utf8'));
        expect(bundle.assets).toEqual({ 'images/circle.svg': { hash: `sha256:${hex}`, size: svg.length, type: 'image/svg+xml' } });
        expect(JSON.stringify(bundle.items)).toContain('"value":"https://example.org/x.png"');
        expect(readFileSync(join(root, 'cdn', `${hex}.svg`), 'utf8')).toBe(svg);
        expect(lines.at(-1)).toMatch(/1 Mediendatei\(en\) in /);

        // Paths passed to image through a component count as well
        writeFileSync(join(root, 'c.af'), `component Pics(srcs: List<Text>) { for s in srcs { image(src: s, alt: "Bild") } }
            item c { Pics(srcs: ["images/circle.svg"]) }`);
        expect(await main(['compile', join(root, 'c.af'), '--root', root, '--out', join(root, 'out')], capture().out)).toBe(0);
        expect(Object.keys(JSON.parse(readFileSync(join(root, 'out', 'c.bundle.json'), 'utf8')).assets)).toEqual(['images/circle.svg']);

        writeFileSync(join(root, 'b.af'), 'item b { image(src: "missing.png", alt: "x") }');
        const missing = capture();
        expect(await main(['compile', join(root, 'b.af'), '--root', root, '--out', join(root, 'out')], missing.out)).toBe(1);
        expect(missing.lines.join('\n')).toMatch(/Mediendatei 'missing.png' nicht gefunden/);
        expect(existsSync(join(root, 'out', 'b.bundle.json'))).toBe(false);
    });

    test('format: formatiert Dateien, --check meldet unformatierte ohne zu schreiben', async () => {
        const root = mkdtempSync(join(tmpdir(), 'af-'));
        const file = join(root, 'f.af');
        writeFileSync(file, 'item f {\na = Gap("x")\n}\n');
        const check = capture();
        expect(await main(['format', '--check', root], check.out)).toBe(1);
        expect(readFileSync(file, 'utf8')).toBe('item f {\na = Gap("x")\n}\n');
        expect(await main(['format', file], capture().out)).toBe(0);
        expect(readFileSync(file, 'utf8')).toBe('item f {\n  a = Gap("x")\n}\n');
        expect(await main(['format', '--check', root], capture().out)).toBe(0);
    });

    test('compile bricht bei Fehlern ab, --dev erzeugt trotzdem ein Bundle', async () => {
        const root = mkdtempSync(join(tmpdir(), 'af-'));
        mkdirSync(join(root, 'out'));
        writeFileSync(join(root, 'kaputt.af'), 'item k { page { x = FreeText(label: 3, max: "viel") } }');
        const release = capture();
        expect(await main(['compile', join(root, 'kaputt.af'), '--root', root, '--out', join(root, 'out')], release.out)).toBe(1);
        expect(release.lines.join('\n')).toMatch(/kaputt\.af:1:\d+ Fehler: Argument 'max'/);
        expect(release.lines.at(-1)).toBe('! Kein Bundle erzeugt: 1 Fehler.');
        const dev = capture();
        expect(await main(['compile', join(root, 'kaputt.af'), '--root', root, '--out', join(root, 'out'), '--dev'], dev.out)).toBe(0);
        expect(dev.lines[0]).toMatch(/kaputt\.dev\.bundle\.json/);
    });

    test('robust: unbekannte Option, einzelne Datei, fehlende Medien mit --release, Ordner mit toten Links', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-'));
        writeFileSync(join(dir, 'm.af'), 'item m1 { image("missing.png", "Bild") }\n');
        symlinkSync('/nonexistent/x', join(dir, 'tot'));
        symlinkSync('..', join(dir, 'schleife'));
        const run = async (...args: string[]) => { const c = capture(); return { code: await main(args, c.out), lines: c.lines }; };

        const unknown = await run('compile', join(dir, 'm.af'), '--outt', 'x');
        expect(unknown.code).toBe(2);
        expect(unknown.lines[0]).toMatch(/Unbekannte Option --outt für 'compile'/);

        expect((await run('check', join(dir, 'm.af'))).code).toBe(0);              // warning only
        const release = await run('check', join(dir, 'm.af'), '--release');
        expect(release.code).toBe(1);
        expect(release.lines.join('\n')).toMatch(/Fehler: Datei 'missing.png' nicht gefunden/);

        const folder = await run('check', dir);
        expect(folder.code).toBe(0);
        expect(folder.lines.at(-1)).toBe('1 Datei(en) geprüft, keine Fehler.');
    });

    test('import iqb: ohne das Paket eine Meldung mit Paketnamen, auch bei fehlender Datei', async () => {
        vi.mocked(loadOptional).mockResolvedValueOnce(undefined);
        const { lines, out } = capture();
        expect(await main(['import', 'iqb', 'x.xml'], out)).toBe(1);
        expect(lines.join('\n')).toMatch(/@answerfield\/import-iqb.*nicht installiert/);
        expect(lines.join('\n')).not.toContain('npm install');
    });

    test('pdf: ohne das Paket eine Meldung mit Paketnamen, auch bei fehlender Datei', async () => {
        vi.mocked(loadOptional).mockResolvedValueOnce(undefined);
        const { lines, out } = capture();
        expect(await main(['pdf', 'x.af'], out)).toBe(1);
        expect(lines.join('\n')).toMatch(/@answerfield\/export-typst.*nicht installiert/);
        expect(lines.join('\n')).not.toContain('npm install');
    });
});
