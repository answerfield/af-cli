import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { IssueCodes, createItemServices, isLibrarySource, loadBuiltinDocuments, optionTextEdits } from '@answerfield/language';
import { compileDocument, registerCompilerChecks } from '@answerfield/compiler';
import { assetFileName, type AssetInfo, type Bundle } from '@answerfield/bundle';
import { loadOptional, type IqbImport, type TypstExport } from './optional.js';
import { ACCOMMODATION_NAMES, adaptationReport, type AdaptationReport } from '@answerfield/runtime-core';

const USAGE = `af: Werkzeuge für die AF-Aufgabensprache

  af check [ordner|datei] [--release]       .af-Dateien prüfen (Fehler → Exit-Code 1); --release: fehlende
             [--versions]                   Mediendateien sind Fehler wie bei compile; --versions: je Aufgabe,
                                            was ausgeschlossen ist und welchen Texten und Grafiken noch eine
                                            Sprachstufe bzw. Beschreibung fehlt
  af format <datei|ordner …> [--check]      Formatieren; --check: nur prüfen (unformatiert → Exit-Code 1)
  af compile <datei.af> [--out ordner]    Release-Bundle erzeugen (bricht bei Fehlern ab)
             [--root ordner] [--dev]        --root: Arbeitsbereich (Standard: aktueller Ordner, liegt die
                                            Datei außerhalb, ihr Ordner)
             [--assets ordner]              --dev: Dev-Bundle mit Quellbezug, auch bei Fehlern
             [--no-feedback]                --assets: Medien als <hash><endung> ablegen (z. B. für ein CDN)
                                            --no-feedback: Rückmeldungen zum Üben weglassen (Testauslieferung)
  af import iqb <unit.xml|ordner …>         IQB-Units (Aspect, Kodierschema) übersetzen; schreibt .af, Medien
             [--out ordner]                 und import-report.json (kept / approximated / missing)
  af pdf <datei.af> [--name name]         Druckfassung (Typst → PDF) einer Aufgabe oder eines Testhefts
             [--accommodations a,b]         --accommodations: z. B. easy_language,magnification; --typst: auch .typ
             [--out d] [--root ordner]      --brand: Kopf, Fuß, Deckblatt eines Landes (Ordner mit brand.json),
             [--typst] [--brand ordner,…]   mehrere: je Marke ein PDF`;

/** Sink for CLI output; tests pass their own to capture lines. */
export interface Output {
    log(line: string): void;
    error(line: string): void;
}

const console_: Output = { log: l => console.log(l), error: l => console.error(l) };

/** CLI entry point; returns the exit code. */
export async function main(args: string[], out: Output = console_): Promise<number> {
    const [command, ...rest] = args;
    const flags = parseFlags(rest);
    // Reject unknown options (e.g. typos like --outt) instead of ignoring them
    const unknown = Object.keys(flags.options).filter(o => !(OPTIONS[command ?? ''] ?? []).includes(o));
    if (unknown.length > 0) {
        out.error(`Unbekannte Option ${unknown.map(o => `--${o}`).join(', ')} für '${command}'.\n\n${USAGE}`);
        return 2;
    }
    try {
        switch (command) {
            case 'check': return await check(resolve(flags.positional[0] ?? '.'), 'release' in flags.options, 'versions' in flags.options, out);
            case 'format': {
                if (flags.positional.length === 0) break;
                return await format(flags.positional.map(p => resolve(p)), 'check' in flags.options, out);
            }
            case 'compile': {
                if (!flags.positional[0]) break;
                return await compile(resolve(flags.positional[0]), {
                    root: rootFor(resolve(flags.positional[0]), flags.options.root),
                    out: resolve(flags.options.out ?? '.'),
                    dev: 'dev' in flags.options,
                    noFeedback: 'no-feedback' in flags.options,
                    ...(flags.options.assets ? { assets: resolve(flags.options.assets) } : {})
                }, out);
            }
            case 'pdf': {
                if (!flags.positional[0]) break;
                return await pdf(resolve(flags.positional[0]), {
                    root: rootFor(resolve(flags.positional[0]), flags.options.root),
                    ...(flags.options.name ? { name: flags.options.name } : {}),
                    accommodations: (flags.options.accommodations ?? '').split(',').map(a => a.trim()).filter(Boolean),
                    ...(flags.options.out ? { out: resolve(flags.options.out) } : {}),
                    typst: 'typst' in flags.options,
                    brands: (flags.options.brand ?? '').split(',').map(m => m.trim()).filter(Boolean).map(m => resolve(m))
                }, out);
            }
            case 'import': {
                if (flags.positional[0] !== 'iqb' || !flags.positional[1]) break;
                return await importIqb(flags.positional.slice(1).map(p => resolve(p)), resolve(flags.options.out ?? '.'), out);
            }
        }
    } catch (e) {
        out.error(e instanceof Error ? e.message : String(e));
        return 2;
    }
    out.error(USAGE);
    return command === undefined || command === 'help' ? 0 : 2;
}

async function check(path: string, release: boolean, versions: boolean, out: Output): Promise<number> {
    if (!existsSync(path)) throw new Error(`Nicht gefunden: ${path}`);
    // Folder: check every file in it; single file: check it within its folder's workspace
    const file = statSync(path).isFile() ? path : undefined;
    const root = file ? rootFor(file) : path;
    const { documents, Item } = await load(root, ...(file ? [file] : []));
    const checked = file ? documents.filter(d => sameFile(d, file)) : documents;
    const errors = report(checked, root, out, release);
    if (versions) {
        for (const document of checked) {
            // Dev bundle: items carry their document, so only those of this file are listed
            const { bundle } = compileDocument(Item, document, { dev: true });
            const items = bundle.items.filter(i => !i.instruction && i.src?.[0] === 0);
            if (items.length === 0) continue;
            out.log(relative(root, document.uri.fsPath));
            for (const item of items) out.log(describeAdaptation(adaptationReport(bundle, item.name)));
        }
    }
    out.log(errors === 0 ? `${checked.length} Datei(en) geprüft, keine Fehler.` : `${errors} Fehler.`);
    return errors === 0 ? 0 : 1;
}

const LEVEL_NAMES = { simple: 'Einfache Sprache', easy: 'Leichte Sprache' } as const;

/** Overview of one item as lines for the terminal. */
function describeAdaptation(r: AdaptationReport): string {
    const lines = [`  ${r.item}${r.title ? ` „${r.title}“` : ''}`];
    if (r.denied.length > 0) lines.push(`    ausgeschlossen: ${r.denied.map(a => ACCOMMODATION_NAMES[a] ?? a).join(', ')}${r.reason ? ` (${r.reason})` : ''}`);
    for (const level of r.levels) {
        if (level.total === 0) continue;
        const unchanged = level.unchanged.slice(0, 3).map(t => `„${t.length > 50 ? t.slice(0, 49) + '…' : t}“`).join(', ');
        lines.push(`    ${LEVEL_NAMES[level.level]}: ${level.adapted} von ${level.total} Texten angepasst`
            + (level.unchanged.length > 0 ? `; unverändert: ${unchanged}${level.unchanged.length > 3 ? ' …' : ''}` : ''));
    }
    if (r.graphics && r.graphics.total > 0) lines.push(`    Bildbeschreibungen: ${r.graphics.described} von ${r.graphics.total} Grafiken`);
    if (r.varies) lines.push('    Zahlen hängen von Anpassungen ab: diese Fassungen sind leichter oder schwerer');
    return lines.join('\n');
}

/**
 * Workspace root for a file: the given one, else the current folder if it contains the file, else the file's own
 * folder (instead of scanning e.g. the whole home or /tmp directory).
 */
function rootFor(file: string, given?: string): string {
    if (given !== undefined) return resolve(given);
    const cwd = process.cwd();
    return file.startsWith(cwd + sep) ? cwd : dirname(file);
}

/** Whether the document is the given file; compared via URI so spellings like c:\ and C:\ (Windows) match. */
function sameFile(document: LangiumDocument, file: string): boolean {
    return document.uri.toString() === URI.file(file).toString();
}

/** Formats like "Format Document" in the editor (indentation, line breaks; aligned cases are kept). */
async function format(paths: string[], checkOnly: boolean, out: Output): Promise<number> {
    const files = paths.flatMap(p => (statSync(p).isDirectory() ? itemFiles(p) : [p]));
    const { documents, Item } = await load(paths.find(p => statSync(p).isDirectory()) ?? process.cwd(), ...files);
    let changed = 0;
    for (const file of files) {
        const document = documents.find(d => sameFile(d, file));
        if (!document) continue;
        if ((document.parseResult.parserErrors.length ?? 0) > 0) {
            out.error(`${relative(process.cwd(), file)}: Syntaxfehler, nicht formatiert`);
            changed++;
            continue;
        }
        const edits = await Item.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        const text = document.textDocument.getText();
        const formatted = TextDocument.applyEdits(document.textDocument, edits);
        if (formatted === text) continue;
        changed++;
        if (checkOnly) out.error(`${relative(process.cwd(), file)}: nicht formatiert`);
        else {
            writeFileSync(file, formatted);
            out.log(`${relative(process.cwd(), file)} formatiert`);
        }
    }
    if (checkOnly) {
        out.log(changed === 0 ? `${files.length} Datei(en) geprüft, alle sind formatiert.` : `${changed} von ${files.length} Datei(en) nicht formatiert.`);
        return changed === 0 ? 0 : 1;
    }
    return 0;
}

async function compile(file: string, options: { root: string; out: string; dev: boolean; noFeedback?: boolean; assets?: string }, out: Output): Promise<number> {
    const { documents, Item } = await load(options.root, file);
    const document = documents.find(d => sameFile(d, file));
    if (!document) throw new Error(`Datei nicht gefunden: ${file}`);
    const result = compileDocument(Item, document, { dev: options.dev, noFeedback: options.noFeedback });
    if (!options.dev) {
        // Release: every involved file must be free of errors
        const involved = documents.filter(d => result.documents.includes(d.uri.toString()));
        let errors = report(involved, options.root, out);
        if (errors === 0) {
            // Errors only found while compiling (validation already reported the rest)
            result.errors.forEach(e => out.error(`Fehler: ${e.message}`));
            errors = result.errors.length;
        }
        if (errors > 0) {
            out.error(`Kein Bundle erzeugt: ${errors} Fehler.`);
            return 1;
        }
    }
    // Media: record hash, size and type in the bundle; with --assets store content-addressed copies
    const missing: string[] = [];
    for (const [path, uri] of Object.entries(result.assets)) {
        const source = URI.parse(uri).fsPath;
        if (!existsSync(source)) {
            missing.push(path);
            continue;
        }
        const data = readFileSync(source);
        const info: AssetInfo = { hash: `sha256:${createHash('sha256').update(data).digest('hex')}`, size: data.length, type: mediaType(source) };
        result.bundle.assets![path] = info;
        if (options.assets) {
            mkdirSync(options.assets, { recursive: true });
            copyFileSync(source, join(options.assets, assetFileName(path, info)!));
        }
    }
    if (missing.length > 0) {
        missing.forEach(p => out.error(`${options.dev ? 'Warnung' : 'Fehler'}: Mediendatei '${p}' nicht gefunden.`));
        if (!options.dev) {
            out.error(`Kein Bundle erzeugt: ${missing.length} Mediendatei(en) fehlen.`);
            return 1;
        }
    }
    mkdirSync(options.out, { recursive: true });
    const target = join(options.out, basename(file).replace(/\.af$/, '') + (options.dev ? '.dev' : '') + '.bundle.json');
    const json = serialize(result.bundle);
    writeFileSync(target, json);
    out.log(`${relative(process.cwd(), target)}  sha256:${createHash('sha256').update(json).digest('hex')}`);
    // Separate checksum of the binding coding: feedback or text changes do not affect it
    out.log(`  Kodierung sha256:${createHash('sha256').update(JSON.stringify(result.bundle.codings)).digest('hex')}`);
    out.log(summary(result.bundle));
    if (options.assets && Object.keys(result.assets).length > 0) {
        out.log(`  ${Object.keys(result.assets).length} Mediendatei(en) in ${relative(process.cwd(), options.assets) || '.'}`);
    }
    return 0;
}

/** Print version: compile (like `compile`), then Typst → PDF. The export package is loaded lazily here. */
async function pdf(file: string, options: { root: string; name?: string; accommodations: string[]; out?: string; typst: boolean; brands: string[] }, out: Output): Promise<number> {
    const typstExport = await loadOptional<TypstExport>('@answerfield/export-typst');
    if (!typstExport) {
        out.error('PDF-Export nicht verfügbar: Das Paket @answerfield/export-typst ist nicht installiert.');
        return 1;
    }
    const { documents, Item } = await load(options.root, file);
    const document = documents.find(d => sameFile(d, file));
    if (!document) throw new Error(`Datei nicht gefunden: ${file}`);
    const result = compileDocument(Item, document, {});
    const errors = report(documents.filter(d => result.documents.includes(d.uri.toString())), options.root, out, true) + result.errors.length;
    result.errors.forEach(e => out.error(`Fehler: ${e.message}`));
    if (errors > 0) {
        out.error(`Kein PDF erzeugt: ${errors} Fehler.`);
        return 1;
    }
    const { exportTypst, renderPdf } = typstExport;
    // Edition: prefix of the bundle checksum (as printed by `compile`), so a printout can be traced to its bundle
    const edition = createHash('sha256').update(serialize(result.bundle)).digest('hex').slice(0, 8);
    const readAsset = (path: string) => {
        const uri = result.assets[path];
        return uri && existsSync(URI.parse(uri).fsPath) ? readFileSync(URI.parse(uri).fsPath) : undefined;
    };
    const brands = options.brands.length > 0 ? options.brands : [undefined];
    if (options.out && brands.length > 1) throw new Error('--out nur mit einer Marke; ohne --out landet je Marke ein PDF neben der Datei.');
    for (const dir of brands) {
        const brand = dir ? readBrand(dir) : undefined;
        const typst = exportTypst(result.bundle, options.name, { accommodations: options.accommodations, edition, ...(brand ? { brand } : {}) });
        const pdfData = await renderPdf(typst, readAsset);
        const suffix = [dir ? basename(dir) : '', ...options.accommodations].filter(Boolean).map(s => `.${s}`).join('');
        const target = options.out ?? join(dirname(file), `${options.name ?? basename(file).replace(/\.af$/, '')}${suffix}.pdf`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, pdfData);
        if (options.typst) writeFileSync(target.replace(/\.pdf$/, '') + '.typ', typst.source);
        out.log(`${relative(process.cwd(), target)}  ${Math.round(pdfData.length / 1024)} kB  Fassung ${edition}`);
        typst.notes.forEach(n => out.log(`  Hinweis: ${n}`));
    }
    return 0;
}

/** Reads a brand from a folder: brand.json with name, logo (file in the folder), header, footer, cover. */
function readBrand(dir: string) {
    const file = join(dir, 'brand.json');
    if (!existsSync(file)) throw new Error(`Keine Marke: ${relative(process.cwd(), file)} fehlt.`);
    const json = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; logo?: unknown; header?: unknown; footer?: unknown; cover?: { fields?: unknown } };
    if (typeof json.name !== 'string' || json.name === '') throw new Error(`${relative(process.cwd(), file)}: "name" fehlt.`);
    const strings = (v: unknown, field: string) => {
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${relative(process.cwd(), file)}: "${field}" ist eine Liste von Texten.`);
        return v as string[];
    };
    const logo = typeof json.logo === 'string' ? json.logo : undefined;
    if (logo && !existsSync(join(dir, logo))) throw new Error(`${relative(process.cwd(), file)}: Logo ${logo} nicht gefunden.`);
    const header = strings(json.header, 'header'), fields = strings(json.cover?.fields, 'cover.fields');
    return {
        name: json.name,
        ...(logo ? { logo: { name: basename(logo), data: readFileSync(join(dir, logo)) } } : {}),
        ...(header ? { header } : {}),
        ...(typeof json.footer === 'string' ? { footer: json.footer } : {}),
        ...(json.cover ? { cover: fields ? { fields } : {} } : {})
    };
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4'
};

function mediaType(file: string): string {
    return MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Stable, compact serialization: same source, same bytes. */
export function serialize(bundle: Bundle): string {
    return JSON.stringify(bundle) + '\n';
}

function summary(bundle: Bundle): string {
    const items = bundle.items.filter(i => !i.instruction).length;
    const booklets = bundle.booklets?.map(b => b.name).join(', ');
    return `  ${items} Aufgabe(n), ${Object.keys(bundle.components).length} Komponente(n), ${bundle.codings.length} Kodierung(en)` +
        (booklets ? `, Testheft: ${booklets}` : '');
}

/** Converts IQB units through the optional import package; the CLI then writes option texts into the items. */
async function importIqb(paths: string[], target: string, out: Output): Promise<number> {
    const iqb = await loadOptional<IqbImport>('@answerfield/import-iqb');
    if (!iqb) {
        out.error('IQB-Import nicht verfügbar: Das Paket @answerfield/import-iqb ist nicht installiert.');
        return 1;
    }
    const { exitCode, itemFiles } = iqb.importFolder(paths, target, out);
    await optionsAsText(target, itemFiles);
    return exitCode;
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

async function load(root: string, ...extra: string[]) {
    const { shared, Item } = createItemServices(NodeFileSystem);
    registerCompilerChecks(Item);
    await loadBuiltinDocuments(shared);
    const files = [...new Set([...itemFiles(root), ...extra])];
    const documents: LangiumDocument[] = [];
    for (const file of files) {
        documents.push(await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file)));
    }
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return { documents, Item };
}

function itemFiles(dir: string): string[] {
    return walk(dir, name => name.endsWith('.af')).filter(f => !isLibrarySource(f));
}

/**
 * Prints errors and warnings; returns the error count. With `release`, missing media files count as errors (as when
 * producing a bundle or PDF).
 */
function report(documents: LangiumDocument[], root: string, out: Output, release = false): number {
    let errors = 0;
    for (const document of documents) {
        for (const d of document.diagnostics ?? []) {
            if (d.severity !== 1 && d.severity !== 2) continue;
            const error = d.severity === 1 || (release && (d.data as { code?: string } | undefined)?.code === IssueCodes.MissingMedia);
            if (error) errors++;
            const where = `${relative(root, document.uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
            const text = `${where} ${error ? 'Fehler' : 'Warnung'}: ${typeof d.message === 'string' ? d.message : d.message.value}`;
            if (error) out.error(text); else out.log(text);
        }
    }
    return errors;
}

/** Imported codings compare choices by option text where the texts read well: greater == {"3/5"}. */
async function optionsAsText(root: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const { documents } = await load(root, ...files);
    for (const document of documents.filter(d => files.some(f => sameFile(d, f)))) {
        const edits = optionTextEdits(document.parseResult.value).sort((a, b) => b.start - a.start);
        if (edits.length === 0) continue;
        let text = document.textDocument.getText();
        for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
        writeFileSync(document.uri.fsPath, text);
    }
}

/** Options that take no value. */
const SWITCHES = new Set(['dev', 'check', 'typst', 'no-feedback', 'release', 'versions']);

/** Allowed options per command. */
const OPTIONS: Readonly<Record<string, string[]>> = {
    check: ['release', 'versions'],
    format: ['check'],
    compile: ['out', 'root', 'dev', 'assets', 'no-feedback'],
    pdf: ['name', 'accommodations', 'out', 'root', 'typst', 'brand'],
    import: ['out']
};

function parseFlags(args: string[]): { positional: string[]; options: Record<string, string> } {
    const positional: string[] = [];
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            const next = args[i + 1];
            if (SWITCHES.has(name) || next === undefined || next.startsWith('--')) options[name] = '';
            else { options[name] = next; i++; }
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}
