// Full-fidelity study backup (re-importable into Annotation Desk).
import * as dbApi from '../db';
import type { Doc, Result, ResultLog, Run, Study } from '../types';
import { nowIso, uid } from '../util';

export const BACKUP_FORMAT = 'annotation-desk-study';

export interface StudyBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  appVersion: string;
  study: Study;
  docs: Doc[];
  runs: Run[];
  results: Result[];
  logs: ResultLog[];
}

type Section = 'docs' | 'runs' | 'results' | 'logs';
const SECTIONS: Section[] = ['docs', 'runs', 'results', 'logs'];

/**
 * The backup as a file. It is one JSON document, written one record per line:
 *
 *   {"format":"annotation-desk-study",…,"study":{…},
 *   "docs":[
 *   {…},
 *   {…}
 *   ],
 *   "runs":[ …
 *
 * so a large study (thousands of long texts, several full runs with their logs) never has to fit in a
 * single string, which browsers cap at about 500 million characters.
 */
export async function buildBackup(study: Study, docs: Doc[], runs: Run[], results: Result[], includeLogs: boolean): Promise<Blob> {
  const head = JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: nowIso(), appVersion: __APP_VERSION__, study });
  const parts: BlobPart[] = [head.slice(0, -1) + ',\n'];
  const section = async (name: Section, write: (add: (item: unknown) => void) => Promise<void> | void, last: boolean) => {
    parts.push(`"${name}":[\n`);
    let first = true;
    await write((item) => {
      parts.push((first ? '' : ',\n') + JSON.stringify(item));
      first = false;
    });
    parts.push(last ? '\n]}\n' : '\n],\n');
  };
  await section('docs', (add) => docs.forEach(add), false);
  await section('runs', (add) => runs.forEach(add), false);
  await section('results', (add) => results.forEach(add), false);
  await section(
    'logs',
    async (add) => {
      if (!includeLogs) return;
      for (const r of runs) {
        // A few hundred logs at a time (each holds a whole text), each page folded into a Blob before the next is
        // read, so the browser can keep them out of memory. (Includes earlier attempts replaced by a retry.)
        for await (const page of dbApi.logPagesForRun(r.id)) {
          const start = parts.length;
          for (const l of page) add(l);
          parts.splice(start, parts.length - start, new Blob(parts.slice(start)));
        }
      }
    },
    true,
  );
  return new Blob(parts, { type: 'application/json' });
}

/** Lines of a file, read piece by piece (without the line breaks). */
async function* readLines(file: Blob): AsyncGenerator<string> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  // Pieces of the current line; joined once the line is complete (a single-line file is read only once).
  let pending: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let start = 0;
    let i: number;
    while ((i = value.indexOf('\n', start)) >= 0) {
      pending.push(value.slice(start, i));
      yield pending.join('').replace(/\r$/, '');
      pending = [];
      start = i + 1;
    }
    if (start < value.length) pending.push(value.slice(start));
  }
  if (pending.length) yield pending.join('');
}

/** Writes an imported study under fresh ids (so importing twice never overwrites), section by section. */
class Importer {
  readonly studyId = uid();
  private docMap = new Map<string, string>();
  private runMap = new Map<string, string>();
  study: Study | null = null;

  async start(b: Pick<StudyBackup, 'format' | 'study'>) {
    if (b?.format !== BACKUP_FORMAT || !b.study) throw new Error('Not an Annotation Desk study backup.');
    // Marked until the whole file has been read: if the page is closed meanwhile, the next start removes it. (A mark
    // in the backup's own study is replaced by this one, and removed with it.)
    this.study = { ...b.study, id: this.studyId, name: `${b.study.name} (imported)`, updatedAt: nowIso(), importIncomplete: true };
    await dbApi.putStudy(this.study);
  }

  /** Everything is in: the study is no longer a partial import. */
  async finish(): Promise<Study> {
    const study = this.study!;
    delete study.importIncomplete;
    await dbApi.putStudy(study);
    return study;
  }

  /** `run:doc:replicate`, or `run:doc:replicate#attempt` for an earlier attempt's log: the run and doc are renamed. */
  private newId(r: { runId: string; id: string }): string {
    const [, oldDoc, rep] = r.id.split(':');
    return `${this.runMap.get(r.runId)}:${this.docMap.get(oldDoc) ?? oldDoc}:${rep}`;
  }

  async add(section: Section, items: unknown[]) {
    const studyId = this.studyId;
    if (!items.length) return;
    if (section === 'docs') {
      await dbApi.putDocs(
        (items as Doc[]).map((d) => {
          const id = uid();
          this.docMap.set(d.id, id);
          return { ...d, id, studyId };
        }),
      );
    } else if (section === 'runs') {
      for (const r of items as Run[]) {
        const id = uid();
        this.runMap.set(r.id, id);
        const batch = r.batch
          ? { ...r.batch, map: Object.fromEntries(Object.entries(r.batch.map).map(([k, [d, rep]]) => [k, [this.docMap.get(d) ?? d, rep] as [string, number]])) }
          : null;
        await dbApi.putRun({ ...r, id, studyId, docIds: r.docIds.map((d) => this.docMap.get(d) ?? d), batch });
      }
    } else if (section === 'results') {
      await dbApi.putMany(
        'results',
        (items as Result[]).map((r) => ({ ...r, id: this.newId(r), studyId, runId: this.runMap.get(r.runId) ?? r.runId, docId: this.docMap.get(r.docId) ?? r.docId })),
      );
    } else {
      await dbApi.putMany(
        'logs',
        (items as ResultLog[]).map((l) => ({ ...l, id: this.newId(l), studyId, runId: this.runMap.get(l.runId) ?? l.runId })),
      );
    }
  }
}

/** Import a backup (a file from buildBackup, or an older one written as a single line) as a new study. */
export async function importBackup(file: Blob): Promise<Study> {
  const imp = new Importer();
  try {
    const lines = readLines(file);
    const first = await lines.next();
    if (first.done) throw new Error('The file is empty.');
    let head: Pick<StudyBackup, 'format' | 'study'> | null = null;
    if (first.value.endsWith(',')) {
      try {
        head = JSON.parse(first.value.slice(0, -1) + '}');
      } catch {
        head = null;
      }
    }
    if (head?.format !== BACKUP_FORMAT || !head.study) {
      // One JSON document in any other layout (older backups are a single line): read it whole.
      const rest: string[] = [first.value];
      for await (const line of lines) rest.push(line);
      let b: StudyBackup;
      try {
        b = JSON.parse(rest.join('\n'));
      } catch {
        throw new Error('Not an Annotation Desk study backup (the file is not valid JSON).');
      }
      await imp.start(b);
      for (const s of SECTIONS) await imp.add(s, b[s] ?? []);
      return await imp.finish();
    }
    // One record per line: write in chunks, so even a very large backup never has to be in memory at once.
    await imp.start(head);
    let section: Section | null = null;
    let complete = false;
    let chunk: unknown[] = [];
    const flush = async () => {
      if (section) await imp.add(section, chunk);
      chunk = [];
    };
    for await (const line of lines) {
      const open = /^"(docs|runs|results|logs)":\[$/.exec(line);
      if (open) {
        section = open[1] as Section;
      } else if (/^\][,}]$/.test(line)) {
        await flush();
        section = null;
        complete = line === ']}';
      } else if (line.trim() && section) {
        chunk.push(JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line));
        if (chunk.length >= 500) await flush();
      }
    }
    if (!complete) throw new Error('The backup file is incomplete (it ends too early); nothing was imported.');
    return await imp.finish();
  } catch (e) {
    // Don't leave half a study behind (if even that fails, it is still marked, and the next start removes it).
    if (imp.study) await dbApi.deleteStudy(imp.studyId).catch(() => undefined);
    throw e;
  }
}
