import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { CodingSchemeFactory } from '@iqb/responses';
import { createItemServices, loadBuiltinDocuments } from '@answerfield/language';
import { compileDocument } from '@answerfield/compiler';
import { codeResponses } from '@answerfield/runtime-core';
import type { ResponseSet } from '@answerfield/bundle';
import { importBooklet, importUnit, isBookletXml } from '../src/index.js';
import { parseHtml, renderBlocks } from '../src/html.js';
import { analyzeFlow } from '../src/flow.js';
import { Names, str } from '../src/text.js';
import { Media } from '../src/unit.js';
import { translateGeoGebra } from '../src/geogebra.js';

const FIXTURE = join(__dirname, 'fixtures/demo.xml');

describe('Bausteine', () => {
    test('Namen aus IQB-Aliassen: eindeutig, gültig', () => {
        const names = new Names();
        expect(names.take('01a')).toBe('a01a');
        expect(names.take('text-field_1')).toBe('text_field_1');
        expect(names.take('01a')).toBe('a01a_2');
        expect(names.take('in')).toBe('in_');
    });

    test('Texte: nur nötige Escapes, LaTeX bleibt lesbar', () => {
        expect(str('Er sagt "ja"')).toBe('"Er sagt \\"ja\\""');
        expect(str('\\frac{1}{2}')).toBe('"\\frac{1}{2}"');
    });

    test('HTML: Bedeutung statt Aussehen, Formeln als LaTeX', () => {
        const html = '<p style="x"><strong>Wichtig</strong> und <u>markiert</u>&nbsp;x<sup>2</sup></p>' +
            '<p><aspect-nodeview-math-formula><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></aspect-nodeview-math-formula></p>' +
            '<ul><li>eins</li><li>zwei</li></ul>';
        expect(renderBlocks(parseHtml(html), () => '', '')).toEqual([
            'p { strong("Wichtig") " und " mark("markiert") " x" sup("2") }',
            'p { math("x^2") }',
            'list {', '  p { "eins" }', '  p { "zwei" }', '}'
        ]);
    });

    test('robust: „>“ in Attributen, loses „<“, data:-URLs mit Parametern', () => {
        const html = '<p><span data-tip="a > b">x</span> < y<img data-src="falsch" src="b.png" alt="B"></p>';
        expect(renderBlocks(parseHtml(html), () => '', '')).toEqual(['p { "x < y" image("b.png", "B") }']);
        const media = new Media('m');
        expect(media.put('data:image/png;name=a.png;base64,AAAA', 'a')).toMatch(/^m\/a-[0-9a-f]{12}\.png$/);
        expect(media.put('data:text/plain,%E0%A4%A', 'b')).toMatch(/\.plain$/);
    });
});

describe('Import einer Unit', () => {
    const result = importUnit(FIXTURE);

    test('Aufbau: Material, Elemente, Medien, Bericht', () => {
        expect(result.item).toBe('demo1');
        expect(result.source).toContain('stimulus(label: "Demo") {');
        expect(result.source).toContain('p { "Lies den " strong("Text") " über " emph("Brüche") "." }');
        expect(result.source).toContain('a01a = Gap("Wie heißt die Zahl über dem Bruchstrich?")');
        expect(result.source).toContain('a02a = Choice("Welcher Bruch ist größer als 1/2?", ["2/5", "3/5"])');
        expect(result.source).toContain('p { "Es sind " a03a = Gap("Es sind") " Stunden." }');
        expect(result.source).toContain('lik = Matrix(rows: ["Aussage A", "Aussage B"], columns: ["ja", "nein"])');
        expect(result.source).toContain('a05a = Check("trifft zu")');
        expect([...result.media.keys()]).toEqual([expect.stringMatching(/^media\/kreis_png-[0-9a-f]{12}\.png$/)]);
        expect(result.report).toContainEqual(expect.objectContaining({ element: 'image_1', fidelity: 'approximated' }));
        expect(result.report).toContainEqual(expect.objectContaining({ element: 'frame_1', fidelity: 'kept' }));
    });

    test('Kodierung: Vorverarbeitung, Rückfall an Kodierende, Teilaufgabe, Summe', () => {
        expect(result.source).toContain('a01a: correct(normalize(a01a, case: false, spaces: remove) in {"zähler", "derzähler"} or manual("Code 1: Zähler"))');
        expect(result.source).toContain('a03a: correct(number(a03a) == 6)');
        expect(result.source).toContain('a04: correct(((lik[1] == 1) and (lik[2] == 2)))');
        expect(result.source).toContain('summe: sum_score(a01a, a02a, a03a)');
    });

    test('übersetzt fehlerfrei und kodiert wie das IQB-Kodierschema', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-import-'));
        writeFileSync(join(dir, 'demo1.af'), result.source);
        for (const [p, data] of result.media) {
            mkdirSync(join(dir, p, '..'), { recursive: true });
            writeFileSync(join(dir, p), data);
        }
        const { shared, Item } = createItemServices(NodeFileSystem);
        await loadBuiltinDocuments(shared);
        const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(join(dir, 'demo1.af')));
        await shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect((document.diagnostics ?? []).filter(d => d.severity === 1)).toEqual([]);
        const bundle = compileDocument(Item, document, {}).bundle;

        const scheme = result.unit.scheme!;
        const iqb = (values: Record<string, unknown>) => CodingSchemeFactory.code(
            scheme.variableCodings.filter(v => v.sourceType === 'BASE').map(v => (v.alias! in values
                ? { id: v.id, value: values[v.alias!], status: 'VALUE_CHANGED' }
                : { id: v.id, value: null, status: 'DISPLAYED' })) as never, scheme.variableCodings as never);
        const af = (variables: ResponseSet['variables']) => {
            const set: ResponseSet = { item: 'demo1', accommodations: [], variables: {} };
            for (const v of bundle.items[0].variables) set.variables[v.id] = { value: null, changed: false, displayed: true };
            Object.assign(set.variables, variables);
            return codeResponses(bundle, set).variables;
        };
        const changed = (value: unknown) => ({ value: value as never, changed: true, displayed: true });

        // text with preprocessing
        expect(iqb({ '01a': ' DER  Zähler' }).find(r => r.id === '01a')?.code).toBe(1);
        expect(af({ a01a: changed(' DER  Zähler') }).a01a.code).toBe(1);
        // otherwise left to human coders
        expect(iqb({ '01a': 'Nenner' }).find(r => r.id === '01a')?.status).toBe('CODING_INCOMPLETE');
        expect(af({ a01a: changed('Nenner') }).a01a.pending).toHaveLength(1);
        // choice, and a subtask over two matrix rows
        expect(af({ a02a: changed([2]) }).a02a.code).toBe(1);
        expect(iqb({ '04a': 1, '04b': 2 }).find(r => r.id === '04')?.code).toBe(1);
        expect(af({ lik: changed([1, 2]) }).a04.code).toBe(1);
        expect(af({ lik: changed([1, 1]) }).a04.code).toBe(0);
        // checkbox
        expect(af({ a05a: changed(true) }).a05a.code).toBe(1);
    });
});

describe('Ablaufsteuerung', () => {
    const el = (type: string, id: string, extra: Record<string, unknown> = {}) => ({ type, id, alias: id, ...extra });
    const sec = (elements: unknown[], visibilityRules?: unknown[]) => ({ elements, ...(visibilityRules ? { visibilityRules } : {}) });
    const unit = {
        id: 'U1', label: 'Ablauf', player: 'aspect',
        definition: {
            type: 'aspect-unit-definition', version: '4', stateVariables: [
                { id: 'go', alias: 'Aufgaben', value: '0' }, { id: 'view', alias: 'Seite', value: '0' }, { id: 'auto', alias: 'Teil', value: '0' }],
            pages: [
                { alwaysVisible: true, sections: [
                    sec([el('text', 't1', { text: '<p>Text mit <aspect-anchor data-anchor-id="A1">Stelle</aspect-anchor></p>' })]),
                    sec([el('button', 'b1', { label: 'Kapitel eins', action: 'stateVariableChange', actionParam: { id: 'view', value: '0' } }),
                        el('button', 'b2', { label: 'Kapitel zwei', action: 'stateVariableChange', actionParam: { id: 'view', value: '1' } })]),
                    sec([el('text', 't2', { text: '<p>weiter zum Lesen</p>' }), el('button', 'b3', { action: 'stateVariableChange', actionParam: { id: 'go', value: '1' } })])] },
                { sections: [sec([el('trigger', 'tr1', { action: 'removeHighlights' })])] },
                { sections: [sec([el('trigger', 'tr2', { action: 'highlightText', actionParam: 'A1' }),
                    el('trigger', 'tr3', { action: 'stateVariableChange', actionParam: { id: 'auto', value: '1' } })])] },
                { sections: [sec([el('trigger', 'tr4', { action: 'removeHighlights' }), el('button', 'b4', { action: 'unitNav', actionParam: 'next' })])] }]
        }
    } as unknown as Parameters<typeof analyzeFlow>[0];
    const flow = analyzeFlow(unit, a => new Names().take(a));

    test('Knöpfe werden zu Button bzw. Tabs, Navigation übernimmt die Runtime', () => {
        expect(flow.controls.get('go')?.line).toBe('aufgaben = Button("weiter zum Lesen", once: true)');
        expect(flow.controls.get('view')?.line).toBe('seite = Tabs(label: "Seite", options: ["Kapitel eins", "Kapitel zwei"])');
        expect(flow.stateRule('view', '=', '1', () => undefined)).toBe('seite == 2');
        expect(flow.handled.get('b4')?.note).toBe('Navigation übernimmt die Runtime');
    });

    test('Trigger setzen Zustände je Seite, Hervorhebungen gelten auf ihrer Seite', () => {
        expect(flow.stateRule('auto', '=', '1', () => undefined)).toBe('current_page() in {2, 3}');
        expect(flow.anchors.get('A1')).toBe('current_page() == 2');
        expect(renderBlocks(parseHtml('<p>Text mit <aspect-anchor data-anchor-id="A1">Stelle</aspect-anchor></p>'), () => '', '', id => flow.anchors.get(id)))
            .toEqual(['p { "Text mit " if current_page() == 2 then mark("Stelle") else "Stelle" }']);
    });
});

describe('Ziehen und Ablegen', () => {
    test('Ablagen → Select mit Sperre in group(cards: end), Vorrat entfällt; übersetzt fehlerfrei', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-drag-'));
        const list = (id: string, extra: Record<string, unknown>) => ({ id, alias: id, type: 'drop-list', ...extra });
        const unit = {
            type: 'aspect-unit-definition', version: '4', pages: [{ sections: [{ elements: [
                { id: 't1', alias: 't1', type: 'text', text: '<p>Ruka</p>' },
                list('z1', { onlyOneItem: true, connectedTo: ['Karten'], value: [] }),
                { id: 't2', alias: 't2', type: 'text', text: '<p>Fenni</p>' },
                list('z2', { onlyOneItem: true, connectedTo: ['Karten'], value: [] }),
                list('Karten', { onlyOneItem: false, connectedTo: ['z1', 'z2'], value: [
                    { id: 'v1', alias: 'v1', text: 'Bett' }, { id: 'v2', alias: 'v2', text: 'Ball' }] })] }] }]
        };
        writeFileSync(join(dir, 'drag.voud'), JSON.stringify(unit));
        writeFileSync(join(dir, 'drag.xml'), '<Unit><Metadata><Id>DRAG1</Id><Label>Ziehen</Label></Metadata>' +
            '<DefinitionRef player="iqb-player-aspect@2.11">drag.voud</DefinitionRef></Unit>');
        const result = importUnit(join(dir, 'drag.xml'));
        expect(result.source).toContain('z1 = Select("Ruka", ["Bett", "Ball"], taken: [z1, z2])');
        expect(result.source).toContain('group(cards: end) {');
        expect(result.report.filter(r => r.type === 'drop-list').every(r => r.fidelity === 'kept')).toBe(true);

        writeFileSync(join(dir, 'drag1.af'), result.source);
        const { shared } = createItemServices(NodeFileSystem);
        await loadBuiltinDocuments(shared);
        const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(join(dir, 'drag1.af')));
        await shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect((document.diagnostics ?? []).filter(d => d.severity === 1)).toEqual([]);
    });
});

describe('Formelfelder', () => {
    test('Anteil über proportion(); Codes je Schreibweise bleiben; lange Felder mit Zeichenleiste', () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-math-'));
        const field = (id: string, type = 'math-field') => ({ id, alias: id, type });
        writeFileSync(join(dir, 'math.voud'), JSON.stringify({ type: 'aspect-unit-definition', version: '4', pages: [{ sections: [{ elements: [
            { id: 't', alias: 't', type: 'text', text: '<p>Welcher Anteil?</p>' }, field('a'), field('b'), field('c', 'text-area-math')] }] }] }));
        const code = (id: number, ...rules: { method: string; p: string }[]) => ({ id, type: 'FULL_CREDIT', score: 1,
            ruleSets: [{ rules: rules.map(r => ({ method: r.method, parameters: [r.p] })) }] });
        writeFileSync(join(dir, 'math.vocs'), JSON.stringify({ variableCodings: [
            { id: 'a', alias: 'a', sourceType: 'BASE', codes: [code(1, { method: 'MATCH', p: '\\frac{1}{9}' }, { method: 'NUMERIC_MATCH', p: '0,11' }, { method: 'MATCH', p: '11\\%' })] },
            { id: 'b', alias: 'b', sourceType: 'BASE', codes: [code(1, { method: 'NUMERIC_MATCH', p: '0,875' }), code(2, { method: 'MATCH', p: '\\frac78' })] }] }));
        writeFileSync(join(dir, 'math.xml'), '<Unit><Metadata><Id>MATH1</Id><Label>Anteil</Label></Metadata>' +
            '<DefinitionRef player="iqb-player-aspect@2.11">math.voud</DefinitionRef><CodingSchemeRef>math.vocs</CodingSchemeRef></Unit>');
        const { source } = importUnit(join(dir, 'math.xml'));
        // one proportion in every spelling, plus IQB's rounded values
        expect(source).toContain('a: correct(proportion(a) == 1/9 or normalize(a, spaces: collapse) in {"0,11", "0.11", "11%"})');
        // one code per spelling: spellings are still compared
        expect(source).toContain('code(1, score: 1, when: normalize(b, spaces: collapse) in {"0,875", "0.875"})');
        expect(source).toContain('code(2, score: 1, when: normalize(b, spaces: collapse) == "7/8")');
        expect(source).toContain('c = FreeText("Welcher Anteil?", keys: ["·", ":", "²", "³", "√", "π", "≈", "≤", "≥", "°"])');
    });
});

describe('Älteres Unit-Format (4.2.0)', () => {
    test('ohne Aliasse, Kodes mit rules, Knopf hebt Textstelle hervor; übersetzt fehlerfrei', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-old-'));
        // no `alias` anywhere: the id is the readable name
        const list = (id: string, extra: Record<string, unknown>) => ({ id, type: 'drop-list', ...extra });
        writeFileSync(join(dir, 'old.voud'), JSON.stringify({ type: 'aspect-unit-definition', version: '4.2.0', pages: [{ sections: [{ elements: [
            { id: 'text_1', type: 'text', text: '<p><aspect-anchor data-anchor-id="a1">Die Stelle</aspect-anchor> im Text.</p>' },
            { id: 'button_1', type: 'button', label: 'Stelle zeigen', action: 'highlightText', actionParam: 'a1' },
            { id: 'X01a', type: 'text-field', label: 'Wie viel?' },
            list('X02a', { onlyOneItem: true, connectedTo: ['X02list'], value: [] }),
            list('X02list', { connectedTo: ['X02a'], value: [{ id: 'k1', text: 'Bett' }, { id: 'k2', text: 'Ball' }] }),
            { id: 'X03a', type: 'radio', label: 'Welche?', options: [{ text: 'A' }, { text: 'B' }] }] }] }] }));
        writeFileSync(join(dir, 'old.vocs'), JSON.stringify({ variableCodings: [
            { id: 'X01a', sourceType: 'BASE', valueTransformations: ['IGNORE_CASE'], codes: [
                { id: 1, label: '', score: 1, rules: [{ method: 'MATCH', parameters: ['583'] }] },
                { id: 0, label: '', score: 0, rules: [{ method: 'ELSE', parameters: [] }] }] },
            { id: 'X03a', sourceType: 'BASE', codes: [
                { id: 1, label: '1. Feld gewählt', score: 0, rules: [] },
                { id: 2, label: '2. Feld gewählt', score: 1, rules: [] }] }] }));
        writeFileSync(join(dir, 'old.xml'), '<Unit><Metadata><Id>OLD1</Id><Label>Alt</Label></Metadata>' +
            '<DefinitionRef player="iqb-player-aspect@2.2">old.voud</DefinitionRef><CodingSchemeRef>old.vocs</CodingSchemeRef></Unit>');
        const result = importUnit(join(dir, 'old.xml'));
        expect(result.source).toContain('stelle_zeigen = Button("Stelle zeigen")');
        expect(result.source).toContain('if stelle_zeigen then mark("Die Stelle") else "Die Stelle"');
        expect(result.source).toContain('x02a = Select(');
        expect(result.source).toContain('["Bett", "Ball"]');
        expect(result.source).toMatch(/x01a: correct\(.*"583"/);
        // codes without rules go to the human coder
        expect(result.source).toContain('x03a: correct(manual("Code 1 (0 P.): 1. Feld gewählt; Code 2 (1 P.): 2. Feld gewählt"))');

        writeFileSync(join(dir, 'old1.af'), result.source);
        const { shared } = createItemServices(NodeFileSystem);
        await loadBuiltinDocuments(shared);
        const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(join(dir, 'old1.af')));
        await shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect((document.diagnostics ?? []).filter(d => d.severity === 1)).toEqual([]);
    });

    test('Testheft findet Units ohne Rücksicht auf Groß- und Kleinschreibung (wie das Testcenter)', () => {
        const xml = '<Booklet><Metadata><Id>B</Id><Label>B</Label></Metadata><Units><Unit id="ABwarte"/></Units></Booklet>';
        expect(importBooklet(xml, new Map([['ABWarte', 'abwarte']])).source).toContain('    abwarte\n');
    });
});

/** A .ggb archive (stored ZIP) with the given geogebra.xml, as a data URL. */
function ggb(construction: string, toolbar = '0', view = '<grid distX="1" distY="1"/>'): string {
    const xml = Buffer.from(`<geogebra><gui><toolbar items="${toolbar}"/></gui><euclidianView><size width="400" height="300"/>` +
        `<coordSystem xZero="0" yZero="300" scale="40" yscale="40"/><evSettings axes="false" grid="false" pointCapturing="1"/>${view}</euclidianView>` +
        `<construction>${construction}</construction></geogebra>`);
    const name = Buffer.from('geogebra.xml');
    const crc = 0; // not checked by the reader
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(crc, 14); local.writeUInt32LE(xml.length, 18); local.writeUInt32LE(xml.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(xml.length, 20); central.writeUInt32LE(xml.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + xml.length, 16);
    return 'data:application/octet-stream;base64,' + Buffer.concat([local, name, xml, central, name, end]).toString('base64');
}

const point = (label: string, x: number, y: number, extra = '') =>
    `<element type="point" label="${label}"><show object="true" label="false"/><coords x="${x}" y="${y}" z="1"/>${extra}</element>`;
const fixed = '<fixed val="true"/>';

describe('GeoGebra', () => {
    test('Streckenwerkzeug auf Gitterpunkten → Geoboard; Figur bleibt, Raster aus der Datei', () => {
        const lattice = [0, 1, 2].flatMap(x => [0, 1, 2].map(y => point(`G${x}${y}`, x, y, fixed))).join('');
        const geo = translateGeoGebra(ggb(lattice + point('A', 0, 0, fixed) + point('B', 2, 2, fixed) +
            '<command name="Segment"><input a0="A" a1="B"/><output a0="s"/></command><element type="segment" label="s"><show object="true"/></element>',
            '15 | 6'), { component: 'GeoT', label: 'Zeichne', tracked: [], media: () => 'm.png' });
        expect(geo.kind).toBe('board');
        const lines = geo.lines('drawn', '').join('\n');
        expect(lines).toContain('segment((0 | 0), (2 | 2))');
        expect(lines).toContain('drawn = Geoboard(cols: 2, rows: 2, at: (0 | 0), label: "Raster mit 3 mal 3 Punkten")');
        expect(lines).not.toContain('dot(');
    });

    test('freie Punkte → ziehbare Werte in einer Komponente; Strecke folgt; IQB-Punktkodierung über x und y', () => {
        const geo = translateGeoGebra(ggb(point('C', 1, 1) + point('D', 3, 1) +
            '<command name="Segment"><input a0="C" a1="D"/><output a0="f"/></command><element type="segment" label="f"><show object="true"/></element>'),
        { component: 'GeoT', label: 'Miss', tracked: ['D'], media: () => 'm.png' });
        expect(geo.kind).toBe('points');
        const source = geo.component.join('\n');
        expect(source).toContain('state p1: Point? = (1 | 1)');
        expect(source).toContain('segment(p1, p2)');
        expect(source).toMatch(/value\(bind: p2, min: \([^)]*\), max: \([^)]*\), step: 1, label: "Punkt D"\)/);
        expect(source).toContain('response [p1, p2]');
        expect(geo.tracked.get('D')).toBe(2);
    });

    test('Vieleck auf freien, versteckten Ecken → als Ganzes ziehbar', () => {
        const hidden = (l: string, x: number, y: number) =>
            `<element type="point" label="${l}"><show object="false"/><coords x="${x}" y="${y}" z="1"/></element>`;
        const geo = translateGeoGebra(ggb(hidden('A', 1, 1) + hidden('B', 2, 1) + hidden('C', 2, 3) +
            '<command name="Polygon"><input a0="A" a1="B" a2="C"/><output a0="v"/></command><element type="polygon" label="v"><show object="true"/></element>'),
        { component: 'GeoT', label: 'Vorlage', tracked: [], media: () => 'm.png' });
        const source = geo.component.join('\n');
        expect(source).toContain('polygon(points: [p1, (p1.x + 1 | p1.y), (p1.x + 1 | p1.y + 2)])');
        expect(source).toContain('label: "Figur verschieben"');
    });
});

describe('Testhefte', () => {
    test('Testcenter-Testheft → booklet: Einheiten am Anfang ein Teil, Testlet mit Freigabewort wartet auf die Testleitung', () => {
        const xml = `<?xml version="1.0"?>
<Booklet><Metadata><Id>H7-2030_X_Probe</Id><Label>Probeheft Rechnen &amp; Aufbau</Label></Metadata>
 <Units>
  <Unit id="Start" label="Begrüßung"/>
  <Unit id="Fehlt" label="nicht importiert"/>
  <Testlet id="T1" label="Aufgaben">
    <Restrictions><CodeToEnter code="x">Bitte warte.</CodeToEnter><TimeMax minutes="40"/></Restrictions>
    <Unit id="M1" label="Eins"/><Unit id="M1" label="doppelt"/><Unit id="M2" label="Zwei"/>
  </Testlet>
  <Unit id="Ende" label="Testende"/>
 </Units></Booklet>`;
        expect(isBookletXml(xml)).toBe(true);
        const items = new Map([['Start', 'start'], ['M1', 'm1'], ['M2', 'm2'], ['Ende', 'ende']]);
        const b = importBooklet(xml, items);
        expect(b.name).toBe('h7_2030_x_probe');
        expect(b.missing).toEqual(['Fehlt']);
        expect(b.source).toContain('booklet h7_2030_x_probe "Probeheft Rechnen & Aufbau" {');
        expect(b.source).toContain('  part("Aufgaben", time: 40min, start: released) {\n    m1\n    m2\n  }');
        expect(b.source).toContain('  part("Fortsetzung") {\n    ende\n  }');
        expect(importBooklet(xml, new Map()).source).toBe('');
    });
});

describe('Zahlenfelder', () => {
    test('nur als number(x) gelesene Lücke wird NumberGap; Grenzen werden ein Bereich', async () => {
        const { preferNumberGaps } = await import('../src/numbers.js');
        const source = [
            'item z1 {',
            '  p { "Länge: " ab = Gap(label: "Länge", width: 4em) " cm" }',
            '  wort = Gap(label: "Wort")',
            '  begr = Gap(label: "Begründung")',
            '  fix = Gap(label: "Text", initial: "3")',
            '}',
            'coding z1 {',
            '  ab: correct(number(ab) >= 69/10 and number(ab) <= 71/10)',
            '  wort: correct(wort == "sieben")',
            '  begr: correct(number(begr) == 7 and manual("nennt den Grund", about: [begr]))',
            '  fix: correct(number(fix) == 3)',
            '}'].join('\n');
        const out = preferNumberGaps(source);
        expect(out).toContain('ab = NumberGap(label: "Länge", width: 4em)');
        expect(out).toContain('ab: correct(ab in 69/10 .. 71/10)');
        expect(out).toContain('wort = Gap(');
        expect(out).toContain('begr = Gap(');            // also read as text (manual)
        expect(out).toContain('fix = Gap(');             // NumberGap has no `initial`
        expect(preferNumberGaps('item z2 { a = Gap("a") }')).toBe('item z2 { a = Gap("a") }');
    });
});
