// The run-vs-run comparison report, built away from the page so it stays responsive (its bootstrap intervals
// take minutes on a full corpus). The texts themselves aren't needed: the page sends the texts without them.
import { buildComparisonReport } from './export/packages';
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

const send = (m: ReportMessage) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<ReportJob>) => {
  const { runA, runB, docs, runs, results, tolerance, groupBy } = e.data;
  try {
    send({ blob: await buildComparisonReport(runA, runB, docs, runs, results, tolerance, groupBy, (progress) => send({ progress })) });
  } catch (err) {
    send({ error: err instanceof Error ? err.message : String(err) });
  }
};
