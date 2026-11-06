// Imports IQB units (Aspect format with coding scheme) into the AF item language.

import { preferNumberGaps } from './numbers.js';
import { convertCoding } from './coding.js';
import { convertUnitBody, type Answer, type Context, type ReportEntry } from './convert.js';
import { analyzeFlow } from './flow.js';
import { Names, str } from './text.js';
import { Media, readUnit, type AspectElement, type IqbUnit } from './unit.js';

export type { Answer, ReportEntry } from './convert.js';
export { readUnit, type IqbUnit } from './unit.js';
export { importBooklet, isBookletXml, type BookletResult } from './booklet.js';
export { typed as typedMath } from './coding.js';
export { preferNumberGaps } from './numbers.js';

/** Result of importing one IQB unit. */
export interface ImportResult {
    unit: IqbUnit;
    /** Name of the AF item. */
    item: string;
    /** Source text of the `.af` file. */
    source: string;
    /** Media: path relative to the `.af` file → content. */
    media: Map<string, Buffer>;
    /** IQB variable ID → AF response. */
    answers: Map<string, Answer>;
    /** IQB variable ID → name of the AF coding rule. */
    rules: Map<string, string>;
    /** What was adopted, approximated or is missing. */
    report: ReportEntry[];
}

/** All elements of a unit by ID, including embedded ones (gaps, matrix rows, table cells). */
function index(value: unknown, into = new Map<string, AspectElement>()): Map<string, AspectElement> {
    if (Array.isArray(value)) value.forEach(v => index(v, into));
    else if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.alias === 'string' && typeof o.type === 'string') into.set(o.id, o as AspectElement);
        Object.values(o).forEach(v => index(v, into));
    }
    return into;
}

/** Converts a unit given by its Testcenter XML file. `mediaFolder`: media folder relative to the `.af` file. */
export function importUnit(xmlFile: string, mediaFolder = 'media'): ImportResult {
    const unit = readUnit(xmlFile);
    const names = new Names();
    const item = names.take(unit.id, 'aufgabe');
    const media = new Media(mediaFolder);
    const coded = new Set((unit.scheme?.variableCodings ?? [])
        .filter(vc => vc.sourceType === 'BASE' && (vc.codes ?? []).some(c => (c.ruleSets ?? []).length > 0))
        .map(vc => vc.id));
    const ctx: Context = {
        unit, names, media: (url, hint) => media.put(url, hint), answers: new Map(), report: [],
        byId: index(unit.definition), coded, prompt: '', audios: new Set(), rules: new Map(),
        flow: analyzeFlow(unit, alias => names.take(alias)), emitted: new Set(), deferred: new Map(), pools: new Map(),
        item, components: []
    };
    const body = convertUnitBody(ctx);
    const coding = convertCoding(ctx);
    const header = [
        `// ${unit.label} (importiert aus der IQB-Unit ${unit.id}, ${unit.player}, Unit-Format ${unit.definition.version})`,
        '// Automatisch übersetzt: Aussehen (Farben, Raster, Größen) entfällt, Ziehen und Ablegen wird zur Auswahl.',
        '// Was angenähert oder nicht übernommen ist, steht im Importbericht.',
        ''
    ];
    const source = preferNumberGaps([
        ...header,
        `item ${item} ${str(unit.label)} {`,
        ...body,
        '}',
        ...(coding.length > 0 ? ['', `coding ${item} {`, ...coding, '}'] : []),
        ...ctx.components.flatMap(c => ['', ...c]),
        ''
    ].join('\n'));
    return { unit, item, source, media: media.files, answers: ctx.answers, rules: ctx.rules, report: ctx.report };
}
export { importFolder, type FolderResult, type ImportLog } from './folder.js';
