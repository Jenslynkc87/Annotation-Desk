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

export async function buildBackup(study: Study, docs: Doc[], runs: Run[], results: Result[], includeLogs: boolean): Promise<StudyBackup> {
  const logs: ResultLog[] = [];
  if (includeLogs) for (const r of runs) logs.push(...(await dbApi.getLogsForRun(r.id)));
  return { format: BACKUP_FORMAT, version: 1, exportedAt: nowIso(), appVersion: __APP_VERSION__, study, docs, runs, results, logs };
}

/** Import a backup as a new study (fresh ids, so importing twice never overwrites). */
export async function importBackup(json: string): Promise<Study> {
  const b = JSON.parse(json) as StudyBackup;
  if (b?.format !== BACKUP_FORMAT || !b.study) throw new Error('Not an Annotation Desk study backup.');
  const studyId = uid();
  const docMap = new Map<string, string>();
  const runMap = new Map<string, string>();
  const study: Study = { ...b.study, id: studyId, name: `${b.study.name} (imported)`, updatedAt: nowIso() };
  const docs = (b.docs ?? []).map((d) => {
    const id = uid();
    docMap.set(d.id, id);
    return { ...d, id, studyId };
  });
  const runs = (b.runs ?? []).map((r) => {
    const id = uid();
    runMap.set(r.id, id);
    const batch = r.batch
      ? { ...r.batch, map: Object.fromEntries(Object.entries(r.batch.map).map(([k, [d, rep]]) => [k, [docMap.get(d) ?? d, rep] as [string, number]])) }
      : null;
    return { ...r, id, studyId, docIds: r.docIds.map((d) => docMap.get(d) ?? d), batch };
  });
  const resultId = (r: { runId: string; id: string }) => {
    const [, oldDoc, rep] = r.id.split(':');
    return `${runMap.get(r.runId)}:${docMap.get(oldDoc) ?? oldDoc}:${rep}`;
  };
  await dbApi.putStudy(study);
  await dbApi.putDocs(docs);
  for (const r of runs) await dbApi.putRun(r);
  const logsById = new Map((b.logs ?? []).map((l) => [l.id, l]));
  for (const r of b.results ?? []) {
    const id = resultId(r);
    const log = logsById.get(r.id);
    await dbApi.putResult(
      { ...r, id, studyId, runId: runMap.get(r.runId) ?? r.runId, docId: docMap.get(r.docId) ?? r.docId },
      log ? { ...log, id, studyId, runId: runMap.get(log.runId) ?? log.runId } : null,
    );
  }
  return study;
}
