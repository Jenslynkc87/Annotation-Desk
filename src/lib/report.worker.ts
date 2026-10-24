// The run-vs-run comparison report, built away from the page so it stays responsive (its bootstrap intervals
// take minutes on a full corpus). The texts themselves aren't needed: the page sends the texts without them.
// Also the exports' agreement figures (`AgreementJob`), for the same reason.
import { agreementHere, buildComparisonReport, type ExportData } from './export/packages';
import type { AgreementRow } from './export/tables';
import type { Doc, Result, Run } from './types';

export interface ReportJob {
  runA: Run;
  runB: Run;
  docs: Doc[];
  runs: Run[];
  results: Result[];
  tolerance: number;
  groupBy: string;
}

/** How far it has got (e.g. "field 2 of 5"), then the finished workbook or what went wrong. */
export type ReportMessage = { progress: string } | { blob: Blob } | { error: string };

/** The agreement rows of some runs of a study, for an export (`agreementHere`), in their order. */
export interface AgreementJob {
  agreement: { data: ExportData; runIds: string[] };
}
export type AgreementMessage = { rows: AgreementRow[][] } | { error: string };

const send = (m: ReportMessage | AgreementMessage) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<ReportJob | AgreementJob>) => {
  if ('agreement' in e.data) {
    const { data, runIds } = e.data.agreement;
    try {
      send({ rows: await agreementHere(data, runIds.map((id) => data.runs.find((r) => r.id === id)!)) });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const { runA, runB, docs, runs, results, tolerance, groupBy } = e.data;
  try {
    send({ blob: await buildComparisonReport(runA, runB, docs, runs, results, tolerance, groupBy, (progress) => send({ progress })) });
  } catch (err) {
    send({ error: err instanceof Error ? err.message : String(err) });
  }
};
