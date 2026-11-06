// Reads an IQB unit: Testcenter XML, Aspect unit definition (.voud) and coding scheme (.vocs).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Element of an Aspect unit; only the fields the importer reads are typed. */
export interface AspectElement {
    id: string;
    alias: string;
    type: string;
    [key: string]: unknown;
}

/** Section of an Aspect page, optionally shown only under visibility rules. */
export interface AspectSection {
    elements: AspectElement[];
    visibilityRules?: { id: string; operator: string; value: string }[];
    logicalConnectiveOfRules?: 'disjunction' | 'conjunction';
    /** Milliseconds until the section appears. */
    visibilityDelay?: number;
}

/** Page of an Aspect unit. */
export interface AspectPage {
    sections: AspectSection[];
    alwaysVisible?: boolean;
}

/** Aspect unit definition (.voud). */
export interface AspectUnit {
    type: string;
    version: string;
    pages: AspectPage[];
    stateVariables?: { id: string; alias?: string; value: string }[];
}

/** Coding scheme (.vocs) types; only the fields the importer reads. */
export interface CodingRule { method: string; parameters?: string[]; fragment?: number; valueArrayPos?: unknown }
export interface CodingRuleSet { rules: CodingRule[]; ruleOperatorAnd?: boolean; valueArrayPos?: unknown }
export interface CodingCode {
    id: number | string | null;
    type?: string;
    label?: string;
    score?: number;
    ruleSets?: CodingRuleSet[];
    ruleSetOperatorAnd?: boolean;
    manualInstruction?: string;
}
export interface VariableCoding {
    id: string;
    alias?: string;
    sourceType: string;
    deriveSources?: string[];
    processing?: string[];
    /** Regular expression splitting the value into fragments (e.g. a GeoGebra point "I(13.2 | 0)"). */
    fragmenting?: string;
    codes?: CodingCode[];
}
export interface CodingScheme { variableCodings: VariableCoding[] }

/** A unit as read from its Testcenter XML file. */
export interface IqbUnit {
    id: string;
    label: string;
    player: string;
    definition: AspectUnit;
    scheme?: CodingScheme;
}

function tag(xml: string, name: string): { attrs: string; text: string } | undefined {
    const m = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? { attrs: m[1], text: m[2].trim() } : undefined;
}

function attr(attrs: string, name: string): string | undefined {
    return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

/** Text of an XML element; decodes only the entities that occur in file names and titles. */
function xmlText(text: string): string {
    return text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function readJson(xmlFile: string, file: string): unknown {
    const path = join(dirname(xmlFile), xmlText(file));
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new Error(`${xmlFile}: ${file} nicht lesbar (${e instanceof Error ? e.message : String(e)})`);
    }
}

/**
 * Unit formats before about 4.5 (e.g. VERA 2024, 4.2.0) have no `alias`: there the `id` is already the readable name
 * that variables and coding refer to. Everything with an id but no alias (elements, drag items) gets its id.
 */
function withAliases(value: unknown): void {
    if (Array.isArray(value)) value.forEach(withAliases);
    else if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        if (typeof o.id === 'string' && o.alias === undefined) o.alias = o.id;
        Object.values(o).forEach(withAliases);
    }
}

/**
 * Older coding schemes (VERA 2024) put `rules` directly on a code, without `type`: an ELSE rule marks the automatic
 * residual code. Codes that only describe the answer (label, score, no rule) go to the human coder: they are collected
 * into a manual residual code, as newer schemes do with RESIDUAL.
 */
function withRuleSets(vc: VariableCoding): void {
    type OldCode = CodingCode & { rules?: CodingRule[] };
    const old = vc as VariableCoding & { valueTransformations?: string[] };
    if (old.processing === undefined && Array.isArray(old.valueTransformations)) old.processing = old.valueTransformations;
    const codes = (vc.codes ?? []) as OldCode[];
    if (!codes.some(c => Array.isArray(c.rules) && c.ruleSets === undefined)) return;
    const described: string[] = [];
    for (const c of codes) {
        const rules = c.rules ?? [];
        delete c.rules;
        const auto = rules.filter(r => r.method !== 'ELSE');
        if (auto.length > 0) c.ruleSets = [{ rules: auto, ruleOperatorAnd: false }];
        else if (rules.length > 0) c.type = 'RESIDUAL_AUTO';
        else if (c.label) described.push(`Code ${c.id} (${c.score ?? 0} P.): ${c.label}`);
    }
    if (described.length > 0 && !codes.some(c => c.ruleSets?.length)) {
        const residual = codes.find(c => c.type === 'RESIDUAL_AUTO');
        const instruction = described.join('; ');
        if (residual) Object.assign(residual, { type: 'RESIDUAL', manualInstruction: instruction });
        else codes.push({ id: 0, type: 'RESIDUAL', score: 0, manualInstruction: instruction });
    }
}

/** Reads a unit via its Testcenter XML file. */
export function readUnit(xmlFile: string): IqbUnit {
    const xml = readFileSync(xmlFile, 'utf8');
    const definition = tag(xml, 'DefinitionRef');
    if (!definition) throw new Error(`${xmlFile}: keine DefinitionRef (eingebettete Definitionen werden nicht unterstützt)`);
    const unit = readJson(xmlFile, definition.text) as AspectUnit;
    if (unit?.type !== 'aspect-unit-definition' || !Array.isArray(unit.pages)) throw new Error(`${xmlFile}: keine Aspect-Unit (${unit?.type})`);
    withAliases(unit);
    const schemeRef = tag(xml, 'CodingSchemeRef');
    const scheme = schemeRef?.text ? readJson(xmlFile, schemeRef.text) as CodingScheme : undefined;
    scheme?.variableCodings?.forEach(withRuleSets);
    return {
        id: xmlText(tag(xml, 'Id')?.text ?? ''),
        label: xmlText(tag(xml, 'Label')?.text ?? ''),
        player: attr(definition.attrs, 'player') ?? '',
        definition: unit,
        ...(scheme ? { scheme: { variableCodings: Array.isArray(scheme.variableCodings) ? scheme.variableCodings : [] } } : {})
    };
}

/** Media from data: URLs, named by content hash so identical files are stored once. */
export class Media {
    readonly files = new Map<string, Buffer>();

    constructor(private readonly folder: string) { }

    put(dataUrl: string, hint: string): string {
        // data:[type][;param…][;base64],content
        const m = /^data:([^;,]*)([^,]*),(.*)$/s.exec(dataUrl);
        if (!m) return dataUrl;
        let data: Buffer;
        try {
            data = /;base64$/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
        } catch {
            data = Buffer.from(m[3]);
        }
        const type = m[1].toLowerCase();
        const ext = EXT[type] ?? /^\w+\/([a-z0-9]+)$/.exec(type)?.[1] ?? 'bin';
        const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
        const safeHint = hint.normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'file';
        const path = `${this.folder}/${safeHint}-${hash}.${ext}`;
        this.files.set(path, data);
        return path;
    }
}

const EXT: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4'
};
