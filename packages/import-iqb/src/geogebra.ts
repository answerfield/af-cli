// GeoGebra applets (Aspect element `geometry`) → AF plane. The construction (geogebra.xml in the base64 .ggb archive)
// is read, not executed: visible objects become plane shapes, free points draggable values in a generated component,
// the segment tools drawing on the point grid (Geoboard). Scripts, macros, the pen and other tools are reported.

import { inflateRawSync } from 'node:zlib';
import { DomUtils, parseDocument } from 'htmlparser2';
import type { Element } from 'domhandler';
import { str, verbatim } from './text.js';

/** How faithfully a part was converted (as in the import report). */
type Fidelity = 'kept' | 'approximated' | 'missing';

/** Result of translating one applet. */
export interface GeoGebra {
    /** `board`: drawing on a grid (Geoboard); `points`: draggable points; `none`: picture only. */
    kind: 'board' | 'points' | 'none';
    /** Item statements; `binding` names the response (ignored for `none`). */
    lines(binding: string, indent: string): string[];
    /** Top-level component for draggable points (kind `points`). */
    component: string[];
    /** GeoGebra point label → index in the response list (1-based), for the IQB's tracked variables. */
    tracked: Map<string, number>;
    notes: Array<{ fidelity: Fidelity; text: string }>;
}

/** Files of a ZIP archive (stored or deflated entries, as in .ggb files). */
export function unzip(data: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    // End of central directory: signature within the last 64 KiB (+22 bytes of the record itself)
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
        if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('kein ZIP-Archiv');
    let p = data.readUInt32LE(eocd + 16);
    for (let n = data.readUInt16LE(eocd + 10); n > 0 && data.readUInt32LE(p) === 0x02014b50; n--) {
        const method = data.readUInt16LE(p + 10), size = data.readUInt32LE(p + 20);
        const nameLength = data.readUInt16LE(p + 28), extra = data.readUInt16LE(p + 30), comment = data.readUInt16LE(p + 32);
        const local = data.readUInt32LE(p + 42);
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const raw = data.subarray(start, start + size);
        files.set(data.toString('utf8', p + 46, p + 46 + nameLength), method === 8 ? inflateRawSync(raw) : raw);
        p += 46 + nameLength + extra + comment;
    }
    return files;
}

/** Pixel size of a PNG or JPEG image. */
function imageSize(b: Buffer): { w: number; h: number } | undefined {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
        for (let p = 2; p + 9 < b.length && b[p] === 0xff;) {
            const marker = b[p + 1];
            // SOF0..SOF15 except DHT, JPG and DAC carry the size
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
            p += 2 + b.readUInt16BE(p + 2);
        }
    }
    return undefined;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };

/** Tools that move, delete, pan or write (everything else constructs). */
const PASSIVE_TOOLS = new Set([0, 6, 17, 40, 62]);
/** Segment and polygon tools: drawing on the grid is a faithful counterpart. */
const DRAW_TOOLS = new Set([15, 16]);
const PEN = 62;

interface Point { x: number; y: number }

interface Obj {
    type: string;
    label: string;
    el: Element;
    visible: boolean;
    labelShown: boolean;
    fixed: boolean;
    selectable: boolean;
    /** Caption shown instead of the name (e.g. a number on a card). */
    caption?: string;
    at?: Point;
}

const tag = (el: Element, name: string): Element | undefined =>
    el.children.find((c): c is Element => c.type === 'tag' && (c as Element).name === name);
const num = (v: string | undefined): number | undefined => v === undefined || v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);

/** Number for AF source: at most four decimals, never "-0". */
function fmt(v: number): string {
    const r = Math.round(v * 10000) / 10000;
    return String(Object.is(r, -0) ? 0 : r);
}

/** A round step close to `v` (1, 2 or 5 times a power of ten). */
function niceStep(v: number): number {
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 5, 10].map(f => f * p).find(s => s >= v) ?? v;
}

/** Shown name of an object: its caption, else the label without subscript markup ("C'_{1}" → "C'1"). */
function display(o: { label: string; caption?: string }): string {
    return o.caption ?? o.label.replace(/_\{?([^}]*)\}?/, '$1');
}

/**
 * Translates a GeoGebra applet. `appDefinition`: data URL or base64 of the .ggb file; `component`: name for the
 * generated component; `media`: stores an image and returns its path.
 */
export function translateGeoGebra(appDefinition: string, opts: {
    component: string;
    label: string;
    tracked: string[];
    media: (dataUrl: string, hint: string) => string;
}): GeoGebra {
    const notes: GeoGebra['notes'] = [];
    const files = unzip(Buffer.from(appDefinition.replace(/^data:[^,]*,/, ''), 'base64'));
    const xml = files.get('geogebra.xml')?.toString('utf8');
    if (!xml) throw new Error('GeoGebra-Datei ohne geogebra.xml');
    const doc = parseDocument(xml, { xmlMode: true });
    const first = (name: string) => DomUtils.findOne(e => e.name === name, doc.children, true) ?? undefined;
    const all = (name: string) => DomUtils.findAll(e => e.name === name, doc.children);

    // --- View: pixels per unit, grid, axes ----------------------------------------------------------------------------
    const view = first('euclidianView');
    const cs = view && tag(view, 'coordSystem');
    const settings = view && tag(view, 'evSettings');
    const gridEl = view && tag(view, 'grid');
    const size = view && tag(view, 'size');
    const scale = num(cs?.attribs.scale) ?? 50, yscale = num(cs?.attribs.yscale) ?? scale;
    const xZero = num(cs?.attribs.xZero) ?? 0, yZero = num(cs?.attribs.yZero) ?? 0;
    // AF planes keep the aspect ratio: different x and y scales are evened out by stretching x
    const k = Math.abs(scale / yscale - 1) < 1e-6 ? 1 : scale / yscale;
    if (k !== 1) notes.push({ fidelity: 'approximated', text: 'x- und y-Achse verschieden skaliert → x gestreckt, Achsen ohne Zahlen' });
    const showGrid = settings?.attribs.grid === 'true';
    const axes = settings?.attribs.axes === 'true';
    const snapping = (num(settings?.attribs.pointCapturing) ?? 3) !== 0;
    const distX = (num(gridEl?.attribs.distX) ?? 1) * k, distY = num(gridEl?.attribs.distY) ?? 1;
    const fromScreen = (sx: number, sy: number): Point => ({ x: (sx - xZero) / scale * k, y: (yZero - sy) / yscale });

    const toolbar = (first('toolbar')?.attribs.items ?? '').split(/[|,\s]+/).map(Number).filter(n => Number.isInteger(n));
    const tools = new Set(toolbar);
    const constructing = toolbar.filter(t => !PASSIVE_TOOLS.has(t));
    const drawing = constructing.length > 0;
    if (constructing.some(t => !DRAW_TOOLS.has(t))) notes.push({ fidelity: 'approximated', text: `Konstruktionswerkzeuge (${constructing.join(', ')}) → Strecken auf dem Raster` });
    if (all('javascript').some(e => (e.attribs.val ?? '').trim() !== '') || all('ggbscript').some(e => (e.attribs.val ?? '').trim() !== '')) {
        notes.push({ fidelity: 'approximated', text: 'Skripte nicht übernommen' });
    }

    // --- Construction: objects, defining commands, expressions --------------------------------------------------------
    const construction = first('construction');
    const commands = new Map<string, { name: string; inputs: string[]; outputs: string[] }>();   // output label → command
    const expressions = new Map<string, string>();
    const objects = new Map<string, Obj>();
    for (const c of construction?.children ?? []) {
        if (c.type !== 'tag') continue;
        const e = c as Element;
        if (e.name === 'command') {
            const io = (n: string) => Object.entries(tag(e, n)?.attribs ?? {}).filter(([a]) => /^a\d+$/.test(a)).map(([, v]) => v);
            const cmd = { name: e.attribs.name ?? '', inputs: io('input'), outputs: io('output') };
            cmd.outputs.forEach(o => commands.set(o, cmd));
        } else if (e.name === 'expression') {
            expressions.set(e.attribs.label ?? '', e.attribs.exp ?? '');
        } else if (e.name === 'element') {
            const show = tag(e, 'show');
            const coords = tag(e, 'coords');
            const z = num(coords?.attribs.z) ?? 1;
            const x = num(coords?.attribs.x), y = num(coords?.attribs.y);
            objects.set(e.attribs.label ?? '', {
                type: e.attribs.type ?? '', label: e.attribs.label ?? '', el: e,
                visible: show?.attribs.object !== 'false', labelShown: show?.attribs.label === 'true',
                fixed: tag(e, 'fixed')?.attribs.val === 'true', selectable: tag(e, 'selectionAllowed')?.attribs.val !== 'false',
                // captions with placeholders (%v value, %n name) are computed by GeoGebra
                ...(tag(e, 'caption')?.attribs.val && !tag(e, 'caption')!.attribs.val.includes('%') ? { caption: tag(e, 'caption')!.attribs.val } : {}),
                ...(e.attribs.type === 'point' && x !== undefined && y !== undefined && z !== 0 ? { at: { x: x / z * k, y: y / z } } : {})
            });
        }
    }
    // User-defined tools (macros) are not executed; only the objects they produced are drawn
    const defined = [...(files.get('geogebra_macro.xml')?.toString('utf8') ?? '').matchAll(/<macro\b[^>]*\bcmdName="([^"]*)"/g)].map(m => m[1]);
    const macros = new Set([...commands.values()].map(c => c.name).filter(n => defined.includes(n)));
    if (macros.size > 0) notes.push({ fidelity: 'approximated', text: `Makro ${[...macros].join(', ')}: nur die gezeichneten Objekte` });

    // Draggable: a visible free point, one bound to a path (Point[path]), or a movable point a macro made
    const isDraggable = (o: Obj) => {
        if (o.type !== 'point' || !o.visible || o.fixed || !o.selectable || !o.at) return false;
        const cmd = commands.get(o.label);
        if (cmd) return (cmd.name === 'Point' && cmd.inputs.length === 1) || macros.has(cmd.name);
        const exp = expressions.get(o.label);
        return exp === undefined || !/[A-Za-z]/.test(exp);
    };
    const draggable = [...objects.values()].filter(isDraggable);
    // A movable polygon on free (hidden) corners is dragged as a whole, e.g. a template over a number grid
    const isFree = (label: string) => {
        const o = objects.get(label);
        return !!o?.at && o.type === 'point' && !o.fixed && !commands.has(label) && !/[A-Za-z]/.test(expressions.get(label) ?? '');
    };
    const movable = [...objects.values()].filter(o => o.type === 'polygon' && o.visible && !o.fixed && o.selectable &&
        commands.get(o.label)?.name === 'Polygon' && commands.get(o.label)!.inputs.every(isFree) &&
        commands.get(o.label)!.inputs.every(l => !isDraggable(objects.get(l)!)));

    // --- Shapes -------------------------------------------------------------------------------------------------------
    type Ref = { at: Point; state?: string };
    const states = new Map<string, string>();   // point label → state name in the component
    const pointRef = (label: string): Ref | undefined => {
        const o = objects.get(label);
        if (!o?.at) return undefined;
        return { at: o.at, ...(states.has(label) ? { state: states.get(label)! } : {}) };
    };
    const shapes: Array<{ kind: 'polygon' | 'segment' | 'line' | 'ray'; points: Ref[]; neutral?: boolean }> = [];
    const skipped = new Map<string, number>();
    const skip = (what: string) => skipped.set(what, (skipped.get(what) ?? 0) + 1);
    const texts: Array<{ at: Point; text: string; latex: boolean }> = [];
    let background: { path: string; x0: number; y0: number; x1: number; y1: number } | undefined;

    const pointsOf = (cmd: { inputs: string[] } | undefined) => {
        const refs = (cmd?.inputs ?? []).map(pointRef);
        return refs.length > 0 && refs.every((r): r is Ref => r !== undefined) ? refs : undefined;
    };
    const plan = () => {
        for (const o of objects.values()) {
            if (!o.visible) continue;
            const cmd = commands.get(o.label);
            switch (o.type) {
                case 'point': break;
                case 'segment': case 'vector': case 'ray': case 'line': {
                    // sides of a polygon are drawn with the polygon
                    if (cmd?.name === 'Polygon') break;
                    const points = pointsOf(cmd);
                    if (points?.length === 2) shapes.push({ kind: o.type === 'vector' ? 'segment' : o.type as 'segment' | 'ray' | 'line', points });
                    else skip(o.type);
                    break;
                }
                case 'polygon': {
                    const points = pointsOf(cmd);
                    const alpha = num(tag(o.el, 'objColor')?.attribs.alpha) ?? 0.1;
                    if (points && points.length >= 3) shapes.push({ kind: 'polygon', points, neutral: alpha === 0 });
                    else skip('polygon');
                    break;
                }
                case 'text': {
                    const exp = expressions.get(o.label) ?? '';
                    const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(exp.trim());
                    if (!literal) { skip('Text mit Formel'); break; }
                    const start = tag(o.el, 'startPoint');
                    const screen = tag(o.el, 'absoluteScreenLocation');
                    const at = start?.attribs.exp ? objects.get(start.attribs.exp)?.at
                        : start ? { x: (num(start.attribs.x) ?? 0) * k, y: num(start.attribs.y) ?? 0 }
                        : screen ? fromScreen(num(screen.attribs.x) ?? 0, num(screen.attribs.y) ?? 0) : undefined;
                    const text = literal[1].replace(/\\(.)/g, '$1').trim();
                    if (!at || text === '') break;
                    // GeoGebra anchors a text at its lower left corner, AF captions are centered
                    const lines = text.split('\n');
                    const wide = Math.max(...lines.map(l => l.length)) * 0.55 * 16 / scale * k;
                    const high = lines.length * 18 / yscale;
                    texts.push({ at: { x: at.x + wide / 2, y: at.y + high / 2 }, text: lines.join(' '), latex: tag(o.el, 'isLaTeX')?.attribs.val === 'true' });
                    break;
                }
                case 'image': {
                    const file = tag(o.el, 'file')?.attribs.name;
                    const data = file ? files.get(file) : undefined;
                    const corners = new Map(o.el.children.filter((c): c is Element => c.type === 'tag' && (c as Element).name === 'startPoint')
                        .map(c => [Number(c.attribs.number ?? 0), c.attribs.exp ? objects.get(c.attribs.exp)?.at : { x: (num(c.attribs.x) ?? 0) * k, y: num(c.attribs.y) ?? 0 }]));
                    const ll = corners.get(0), px = data ? imageSize(data) : undefined;
                    if (!data || !ll || background) { skip('Bild'); break; }
                    const lr = corners.get(1) ?? (px ? { x: ll.x + px.w / scale * k, y: ll.y } : undefined);
                    const ul = corners.get(2) ?? (px && lr ? { x: ll.x, y: ll.y + (lr.x - ll.x) / k * px.h / px.w } : undefined);
                    if (!lr || !ul) { skip('Bild'); break; }
                    const ext = (file!.split('.').pop() ?? 'png').toLowerCase();
                    const path = opts.media(`data:${MIME[ext] ?? 'application/octet-stream'};base64,${data.toString('base64')}`, file!.split('/').pop() ?? 'bild');
                    background = { path, x0: ll.x, y0: ll.y, x1: lr.x, y1: ul.y };
                    break;
                }
                case 'numeric': case 'boolean': case 'list': case 'function': break;
                default: skip(o.type);
            }
        }
    };

    // --- Grids for drawing: the applet's fixed grid points, else a grid over its window -----------------------------
    const isLattice = (o: Obj) => o.type === 'point' && o.visible && !isDraggable(o) && !!o.at &&
        Number.isInteger(o.at.x) && Number.isInteger(o.at.y);
    type Board = { x0: number; y0: number; cols: number; rows: number };
    const boards: Board[] = [];
    const latticeUsed = new Set<string>();
    if (drawing && k === 1) {
        // connected groups of grid points; a group that mostly fills its rectangle is a board
        const lattice = [...objects.values()].filter(isLattice);
        const key = (p: Point) => `${p.x},${p.y}`;
        const byKey = new Map(lattice.map(o => [key(o.at!), o]));
        const seen = new Set<string>();
        const groups: Array<{ members: Obj[]; x0: number; y0: number; x1: number; y1: number }> = [];
        let gaps = false;
        for (const o of lattice) {
            if (seen.has(key(o.at!))) continue;
            const members: Obj[] = [], queue = [o];
            seen.add(key(o.at!));
            while (queue.length > 0) {
                const m = queue.pop()!;
                members.push(m);
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const n = byKey.get(`${m.at!.x + dx},${m.at!.y + dy}`);
                    if (n && !seen.has(key(n.at!))) { seen.add(key(n.at!)); queue.push(n); }
                }
            }
            const xs = members.map(m => m.at!.x), ys = members.map(m => m.at!.y);
            const g = { members, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
            const cells = new Set(members.map(m => key(m.at!)));
            const fill = cells.size / ((g.x1 - g.x0 + 1) * (g.y1 - g.y0 + 1));
            // a closed frame of grid points around a field of squares counts as the field
            const border = 2 * (g.x1 - g.x0 + g.y1 - g.y0);
            let onBorder = 0;
            for (let x = g.x0; x <= g.x1; x++) for (const y of [g.y0, g.y1]) if (cells.has(`${x},${y}`)) onBorder++;
            for (let y = g.y0 + 1; y < g.y1; y++) for (const x of [g.x0, g.x1]) if (cells.has(`${x},${y}`)) onBorder++;
            const frame = g.x1 - g.x0 >= 2 && g.y1 - g.y0 >= 2 && onBorder === border;
            if (members.length >= 4 && (fill >= 0.6 || frame)) {
                groups.push(g);
                gaps ||= fill < 1 && !frame;
            }
        }
        if (gaps) notes.push({ fidelity: 'approximated', text: 'Punktraster mit Lücken → vollständiges Raster' });
        // Several boards: the empty ones are for drawing (e.g. copy a figure onto the second board). A figure has a
        // corner inside the board; grid lines run from edge to edge.
        const touched = (g: typeof groups[number]) => [...objects.values()].some(o => o.visible && o.type !== 'point' &&
            pointsOf(commands.get(o.label))?.some(r => r.at.x > g.x0 && r.at.x < g.x1 && r.at.y > g.y0 && r.at.y < g.y1));
        const empty = groups.filter(g => !touched(g));
        for (const g of groups.length > 1 && empty.length > 0 ? empty : groups) {
            boards.push({ x0: g.x0, y0: g.y0, cols: g.x1 - g.x0, rows: g.y1 - g.y0 });
            g.members.forEach(m => latticeUsed.add(m.label));
        }
        if (boards.length === 0) {
            // No grid points: grid lines at distance 1 (faithful), or a grid added for constructing
            const width = num(size?.attribs.width) ?? 600, height = num(size?.attribs.height) ?? 400;
            const a = fromScreen(0, height), b = fromScreen(width, 0);
            const x0 = Math.ceil(a.x), y0 = Math.ceil(a.y);
            const cols = Math.min(40, Math.floor(b.x) - x0), rows = Math.min(30, Math.floor(b.y) - y0);
            if (cols >= 1 && rows >= 1) {
                boards.push({ x0, y0, cols, rows });
                if (!(showGrid && distX === 1 && distY === 1)) notes.push({ fidelity: 'approximated', text: 'kein Raster in der Datei → Raster im Abstand 1 über dem Fenster' });
            }
        }
    }
    const board = boards[0];

    // Handles: one per draggable point, one per movable polygon (its first corner; the others follow at their offsets)
    const handles: Array<{ obj: Obj; at: Point; name: string; spread?: { x0: number; y0: number; x1: number; y1: number } }> = [];
    if (!board) {
        for (const o of draggable) {
            const name = `p${handles.length + 1}`;
            states.set(o.label, name);
            handles.push({ obj: o, at: o.at!, name });
        }
        for (const o of movable) {
            const corners = commands.get(o.label)!.inputs.map(l => objects.get(l)!);
            const name = `p${handles.length + 1}`;
            const origin = corners[0].at!;
            const offset = (v: number) => v === 0 ? '' : v > 0 ? ` + ${fmt(v)}` : ` - ${fmt(-v)}`;
            corners.forEach((c, i) => states.set(c.label, i === 0 ? name
                : `(${name}.x${offset(c.at!.x - origin.x)} | ${name}.y${offset(c.at!.y - origin.y)})`));
            const dx = corners.map(c => c.at!.x - origin.x), dy = corners.map(c => c.at!.y - origin.y);
            handles.push({ obj: o, at: origin, name, spread: { x0: Math.min(...dx), y0: Math.min(...dy), x1: Math.max(...dx), y1: Math.max(...dy) } });
        }
    }
    const interactive = !!board || handles.length > 0;
    if (tools.has(PEN)) {
        notes.push(interactive ? { fidelity: 'approximated', text: 'Stift zum Notieren entfällt' }
            : { fidelity: 'missing', text: 'Stift (frei zeichnen, einkreisen) hat kein Gegenstück' });
    }
    plan();
    for (const [what, n] of skipped) notes.push({ fidelity: 'approximated', text: `${n} × ${what} nicht übernommen` });
    const onBoard = (p: Point) => Number.isInteger(p.x) && Number.isInteger(p.y) &&
        boards.some(b => p.x >= b.x0 && p.x <= b.x0 + b.cols && p.y >= b.y0 && p.y <= b.y0 + b.rows);
    const dotKeys = new Set<string>();
    const dots = [...objects.values()].filter(o => {
        if (o.type !== 'point' || !o.visible || !o.at || latticeUsed.has(o.label) || states.has(o.label) || onBoard(o.at)) return false;
        const key = `${fmt(o.at.x)},${fmt(o.at.y)},${o.labelShown ? display(o) : ''}`;
        if (dotKeys.has(key)) return false;
        dotKeys.add(key);
        return true;
    });
    // the same side twice (e.g. a segment and its part up to a point on it) or of length zero
    const shapeKeys = new Set<string>();
    for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        const refs = s.points.map(p => p.state ?? `${fmt(p.at.x)},${fmt(p.at.y)}`);
        const key = `${s.kind}:${s.kind === 'polygon' ? refs.join(';') : [...refs].sort().join(';')}`;
        if (shapeKeys.has(key) || (s.kind !== 'polygon' && refs[0] === refs[1])) shapes.splice(i, 1);
        else shapeKeys.add(key);
    }


    // --- Frame: the background image, else everything visible plus a margin ------------------------------------------
    const visiblePoints: Point[] = [
        ...shapes.flatMap(s => s.kind === 'ray' || s.kind === 'line' ? [s.points[0].at] : s.points.map(p => p.at)),
        ...dots.map(o => o.at!), ...handles.map(h => h.at), ...texts.map(t => t.at)
    ];
    for (const b of boards) visiblePoints.push({ x: b.x0, y: b.y0 }, { x: b.x0 + b.cols, y: b.y0 + b.rows });
    let frame: { x0: number; y0: number; x1: number; y1: number };
    if (background) {
        frame = background;
    } else if (visiblePoints.length > 0) {
        const xs = visiblePoints.map(p => p.x), ys = visiblePoints.map(p => p.y);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        const pad = board || showGrid ? Math.max(0.5, Math.min(distX, distY) / 2) : Math.max(w, h, 1) * 0.05;
        frame = { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
    } else {
        const width = num(size?.attribs.width) ?? 600, height = num(size?.attribs.height) ?? 400;
        const a = fromScreen(0, height), b = fromScreen(width, 0);
        frame = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    }
    if (axes) {
        // keep the axes in view
        frame = { x0: Math.min(frame.x0, -Math.min(distX, 1) / 2), y0: Math.min(frame.y0, -Math.min(distY, 1) / 2), x1: frame.x1, y1: frame.y1 };
    }
    const em = Math.round(Math.min(48, Math.max(12, (frame.x1 - frame.x0) / k * scale / 16)));

    // Rays and lines end at the frame
    const clip = (a: Point, b: Point): Point => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const ts = [dx > 0 ? (frame.x1 - a.x) / dx : dx < 0 ? (frame.x0 - a.x) / dx : Infinity,
            dy > 0 ? (frame.y1 - a.y) / dy : dy < 0 ? (frame.y0 - a.y) / dy : Infinity];
        const t = Math.min(...ts);
        return Number.isFinite(t) ? { x: a.x + t * dx, y: a.y + t * dy } : b;
    };
    const pt = (p: Point) => `(${fmt(p.x)} | ${fmt(p.y)})`;
    const ref = (r: Ref) => r.state ?? pt(r.at);

    // --- Output ---------------------------------------------------------------------------------------------------
    const grid = showGrid && Math.abs(distX - distY) < 1e-9 ? distY : undefined;
    if (showGrid && grid === undefined) notes.push({ fidelity: 'approximated', text: 'Gitter mit verschiedenen Abständen weggelassen' });
    const planeArgs = [`x: ${fmt(frame.x0)} .. ${fmt(frame.x1)}`, `y: ${fmt(frame.y0)} .. ${fmt(frame.y1)}`,
        ...(grid !== undefined ? [`grid: ${fmt(grid)}`] : []), `width: ${em}em`,
        ...(axes ? ['x_axis: ""', 'y_axis: ""'] : []), ...(background ? [`background: ${str(background.path)}`] : [])];
    const body = (indent: string): string[] => [
        ...shapes.map(s => {
            switch (s.kind) {
                case 'polygon': return `polygon(points: [${s.points.map(ref).join(', ')}]${s.neutral ? ', tone: neutral' : ''})`;
                case 'segment': return `segment(${ref(s.points[0])}, ${ref(s.points[1])})`;
                case 'line': return `line(${ref(s.points[0])}, ${ref(s.points[1])})`;
                case 'ray': return `segment(${ref(s.points[0])}, ${pt(clip(s.points[0].at, s.points[1].at))})`;
            }
        }),
        ...dots.map(o => `dot(at: ${pt(o.at!)}${o.labelShown ? `, label: ${str(display(o))}` : ''})`),
        ...texts.map(t => `caption(at: ${pt(t.at)}, text: ${t.latex ? `math(${verbatim(t.text)})` : str(t.text)})`)
    ].map(l => indent + l);

    // Step of the draggable points: the grid if points snap to it, else a hundredth of the frame
    const step = snapping && gridEl ? Math.min(distX, distY) : niceStep((frame.x1 - frame.x0) / 100);
    const tracked = new Map<string, number>();
    const boardCall = (b: Board, extra = '') =>
        `Geoboard(cols: ${b.cols}, rows: ${b.rows}, at: ${pt({ x: b.x0, y: b.y0 })}, label: ${str(`Raster mit ${b.cols + 1} mal ${b.rows + 1} Punkten`)}${extra})`;
    if (boards.length === 1) {
        return {
            kind: 'board', component: [], tracked, notes,
            lines: (binding, indent) => [`${indent}plane(${planeArgs.join(', ')}) {`, ...body(indent + '  '),
                `${indent}  ${binding} = ${boardCall(board)}`, `${indent}}`]
        };
    }
    if (boards.length > 1) {
        // one response from several grids: each Geoboard writes into its own state, the answer is the union
        const component = [
            `/** ${opts.label.replace(/\*\//g, '* /')}: GeoGebra-Konstruktion mit ${boards.length} Rastern; Antwort: alle gezeichneten Strecken. @intern */`,
            `component ${opts.component}(): response Set<List<Point?>> {`,
            ...boards.map((_, i) => `  state lines${i + 1}: Set<List<Point?>> = {}`),
            `  plane(${planeArgs.join(', ')}) {`, ...body('    '),
            ...boards.map((b, i) => `    ${boardCall(b, `, lines: lines${i + 1}`)}`), '  }',
            `  response ${boards.map((_, i) => `lines${i + 1}`).join(' + ')}`, '}'
        ];
        return { kind: 'board', component, tracked, notes, lines: (binding, indent) => [`${indent}${binding} = ${opts.component}()`] };
    }
    if (handles.length > 0) {
        handles.forEach((h, i) => tracked.set(h.obj.label, i + 1));
        const path = (h: typeof handles[number]) => {
            if (h.spread) {
                // the whole polygon stays inside the frame
                return { min: { x: frame.x0 - h.spread.x0, y: frame.y0 - h.spread.y0 }, max: { x: frame.x1 - h.spread.x1, y: frame.y1 - h.spread.y1 } };
            }
            // A point on an axis or on a horizontal/vertical segment slides along it
            const cmd = commands.get(h.obj.label);
            if (cmd && macros.has(cmd.name)) {
                // made by a macro: slides along the line of the macro's other points at the same height (e.g. a bar)
                const level = cmd.outputs.map(l => objects.get(l)).filter(p => p?.type === 'point' && p !== h.obj && p.at && p.at.y === h.at.y);
                if (level.length > 0) return { min: { x: Math.min(...level.map(p => p!.at!.x)), y: h.at.y }, max: { x: frame.x1, y: h.at.y } };
                notes.push({ fidelity: 'approximated', text: `Punkt ${display(h.obj)} aus dem Makro: frei in der Ebene verschiebbar` });
                return { min: { x: frame.x0, y: frame.y0 }, max: { x: frame.x1, y: frame.y1 } };
            }
            const on = cmd?.name === 'Point' ? cmd.inputs[0] : undefined;
            if (on === 'xAxis') return { min: { x: frame.x0, y: 0 }, max: { x: frame.x1, y: 0 } };
            if (on === 'yAxis') return { min: { x: 0, y: frame.y0 }, max: { x: 0, y: frame.y1 } };
            const pathCmd = on ? commands.get(on) : undefined;
            let ends = pointsOf(pathCmd)?.map(r => r.at);
            // rays and lines run on to the frame
            if (ends?.length === 2 && pathCmd?.name === 'Ray') ends = [ends[0], clip(ends[0], ends[1])];
            if (ends?.length === 2 && pathCmd?.name === 'Line') ends = [clip(ends[1], ends[0]), clip(ends[0], ends[1])];
            if (ends?.length === 2 && (ends[0].x === ends[1].x || ends[0].y === ends[1].y)) {
                return { min: { x: Math.min(ends[0].x, ends[1].x), y: Math.min(ends[0].y, ends[1].y) },
                    max: { x: Math.max(ends[0].x, ends[1].x), y: Math.max(ends[0].y, ends[1].y) } };
            }
            if (on) notes.push({ fidelity: 'approximated', text: `Punkt ${display(h.obj)} auf ${on}: frei in der Ebene verschiebbar` });
            return { min: { x: frame.x0, y: frame.y0 }, max: { x: frame.x1, y: frame.y1 } };
        };
        const values = handles.map(h => {
            const { min, max } = path(h);
            const label = h.spread ? (h.obj.caption ? `${h.obj.caption} verschieben` : 'Figur verschieben') : `Punkt ${display(h.obj)}`;
            return `value(bind: ${h.name}, min: ${pt(min)}, max: ${pt(max)}, step: ${fmt(step)}, label: ${str(label)}` +
                `${!h.spread && h.obj.labelShown ? `, display: ${str(display(h.obj))}` : ''})`;
        });
        const answer = handles.map(h => k === 1 ? h.name : `(${h.name}.x / ${fmt(k)} | ${h.name}.y)`);
        const what = handles.map(h => h.spread ? 'Lage der Figur (erste Ecke)' : display(h.obj)).join(', ');
        const component = [
            `/** ${opts.label.replace(/\*\//g, '* /')}: GeoGebra-Konstruktion zum Ziehen; Antwort: ${what}. @intern */`,
            `component ${opts.component}(): response List<Point?> {`,
            ...handles.map(h => `  state ${h.name}: Point? = ${pt(h.at)}`),
            `  plane(${planeArgs.join(', ')}) {`, ...body('    '), ...values.map(v => `    ${v}`), '  }',
            `  response [${answer.join(', ')}]`, '}'
        ];
        return { kind: 'points', component, tracked, notes, lines: (binding, indent) => [`${indent}${binding} = ${opts.component}()`] };
    }
    if (!tools.has(PEN)) notes.push({ fidelity: 'kept', text: 'GeoGebra-Konstruktion als Zeichnung' });
    return { kind: 'none', component: [], tracked, notes, lines: (_binding, indent) => [`${indent}plane(${planeArgs.join(', ')}) {`, ...body(indent + '  '), `${indent}}`] };
}

