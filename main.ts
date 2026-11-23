// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool-call edits), finds the lines each edit names at the
// first of three matching tiers (exact, trailing-whitespace drift, full
// whitespace drift), and writes every change or none. SPEC.md is the whole
// contract. Node 22 and its standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line of a patch's new side: a context line (written as the file's own
 * matched line, oIndex its index in O) or a fresh line (text). */
interface NLine {
  ctx: boolean;
  oIndex: number;
  text: string;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

function classifyBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'del', text: l.slice(1) };
  if (c === '+') return { kind: 'add', text: l.slice(1) };
  return { kind: 'bs', text: l.slice(1) };
}

/** Old lines O and new lines N of a hunk or chunk body, in body order. */
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ ctx: true, oIndex: O.length - 1, text: '' });
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else if (b.kind === 'add') {
      N.push({ ctx: false, oIndex: -1, text: b.text });
    }
  }
  return { O, N };
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs at one tier. */
function occursAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  const n = O.length;
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs
 * at or after `from`, with its positions. When endOnly, only occurrences that
 * end at the file's last line count. Null when O occurs at no tier.
 */
function findTierFrom(
  lines: string[],
  O: string[],
  from: number,
  strict: boolean,
  endOnly: boolean,
): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    let p = occursAt(lines, O, tier, from);
    if (endOnly) p = p.filter((pos) => pos + O.length === lines.length);
    if (p.length > 0) return { tier, positions: p };
  }
  return null;
}

function findTier(lines: string[], O: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  return findTierFrom(lines, O, from, strict, false);
}

/** Replace O at pos by N: context lines come from the file, other lines are
 * re-indented at tier 2 (the patch's first-line indent P becomes the file's F). */
function applyReplacement(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const F = leadingWs(lines[pos] ?? '');
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  for (const nl of N) {
    if (nl.ctx) {
      out.push(lines[pos + nl.oIndex]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** Whether a `\` line follows the hunk or chunk's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'add') last = j;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === 'bs';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit. It throws Fail when it cannot apply (and then changes nothing:
 * the caller restores the tree), and returns the move it made, if any. */
type Edit = (tree: Tree) => { move?: [string, string] } | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = f.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  diffA: string;
  diffB: string;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  headerSeen: boolean;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): USection => ({
    diffA: '',
    diffB: '',
    dashOld: null,
    dashNew: null,
    renameFrom: null,
    renameTo: null,
    create: false,
    del: false,
    hunks: [],
    headerSeen: false,
  });
  const startSection = (s: USection): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const readDiffGit = (l: string, lineNo: number): [string, string] => {
    const m = /^diff --git a\/(.+?) b\/(.+?)\s*$/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    return [m[1]!, m[2]!];
  };
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const dashPath = (l: string): string => {
    let t = l.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return stripPrefix(t.trim());
  };
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const [a, b] = readDiffGit(l, i + 1);
      const s = fresh();
      s.diffA = a;
      s.diffB = b;
      startSection(s);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.body.push(classifyBodyLine(bl));
          i++;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt !== undefined && nxt.startsWith('+++ ')) {
          if (!cur.headerSeen) {
            cur.dashOld = dashPath(l);
            cur.dashNew = dashPath(nxt);
            cur.headerSeen = true;
            i += 2;
            continue;
          }
          const s = fresh();
          s.dashOld = dashPath(l);
          s.dashNew = dashPath(nxt);
          s.headerSeen = true;
          startSection(s);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur.dashNew = dashPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
      const s = fresh();
      s.dashOld = dashPath(l);
      s.dashNew = dashPath(lines[i + 1]!);
      s.headerSeen = true;
      startSection(s);
      i += 2;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.dashOld ?? s.renameFrom ?? s.diffA;
    const newPath = s.dashNew ?? s.renameTo ?? s.diffB;
    const oldIsNull = oldPath === '/dev/null';
    const newIsNull = newPath === '/dev/null';
    const isCreate = oldIsNull || s.create;
    const isDelete = !isCreate && (newIsNull || s.del);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    if (!oldIsNull && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!newIsNull && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastAdd: { h: Hunk; j: number } | null = null;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'add') {
            plus.push(h.body[j]!.text);
            lastAdd = { h, j };
          }
        }
      }
      let noBreak = false;
      if (lastAdd !== null) {
        const next = lastAdd.h.body[lastAdd.j + 1];
        noBreak = next !== undefined && next.kind === 'bs';
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return undefined;
    }
    if (isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return undefined;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let lines = f.lines.slice();
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = bodyON(h.body);
      if (O.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), lines.length);
        const added = N.map((nl) => nl.text);
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
        if (atEnd && added.length > 0) final = !backslashAfterLast(h.body);
        d += N.length;
        continue;
      }
      const found = findTier(lines, O, 0, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const endsAtEnd = best + O.length === lines.length;
      lines = applyReplacement(lines, best, O, N, found.tier);
      if (endsAtEnd) {
        if (N.length > 0) final = !backslashAfterLast(h.body);
        else final = best > 0;
      }
      d += N.length - O.length;
    }
    const out = joinFile({ lines, br: f.br, final });
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      return { move: [oldPath, newPath] };
    }
    tree.now.set(oldPath, out);
    return undefined;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let m = i - 1; m >= prevEnd; m--) {
      const t = lines[m]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return undefined;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const N: NLine[] = newLines.map((t) => ({ ctx: false, oIndex: -1, text: t }));
    const out = applyReplacement(f.lines, pos, oldLines, N, found.tier);
    tree.now.set(path, joinFile({ lines: out, br: f.br, final: f.final }));
    return undefined;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : 'update';
    const path = l.slice(l.indexOf(':') + 1).trim();
    const headerLine = i + 1;
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (kind === 'delete') {
      for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    let idx = 0;
    let moveTo: string | null = null;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
      moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let afterEof = false;
    for (; idx < raw.length; idx++) {
      const r = raw[idx]!;
      const t = r.text;
      if (t.trim() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${r.no}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        afterEof = true;
        continue;
      }
      if (t.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        cur = { anchor: t.slice(2).trim(), body: [], eof: false };
        afterEof = false;
        continue;
      }
      if (t.startsWith('*** ')) throw new Exit2(`error: parse ${r.no}`);
      if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        if (cur === null) {
          if (chunks.length === 0 && !afterEof) cur = { anchor: null, body: [], eof: false };
          else throw new Exit2(`error: parse ${r.no}`);
        }
        cur.body.push(classifyBodyLine(t));
        continue;
      }
      throw new Exit2(`error: parse ${r.no}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return undefined;
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    return undefined;
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let lines = f.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTier(lines, [ch.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const added = N.map((nl) => nl.text);
        lines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
        cursor = at + added.length;
      } else {
        const found = findTierFrom(lines, O, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        lines = applyReplacement(lines, pos, O, N, found.tier);
        cursor = pos + N.length;
      }
    }
    const out = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return { move: [path, moveTo] };
    }
    tree.now.set(path, out);
    return undefined;
  };
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)   */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r !== undefined && r.move !== undefined) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const suppressed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
