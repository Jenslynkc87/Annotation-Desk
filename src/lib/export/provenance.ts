// Exports never name the app or the build it was made with (the owner's choice, November 16, 2026): nothing in a
// file should point back to the site or its code. The one exception is `software_versions.json` in the research
// zip (a private record): which build made each run and which one wrote the export.
import type { Run, Study } from '../types';
import { BARE_VERSION } from '../view';

/**
 * A run as exported: without its build id. A run of a version before October 22, 2026 keeps its bare version number
 * (e.g. "0.1.0"), which names nothing: the app reads it, when a backup is imported again, to count that version's
 * retries correctly (see retryCounts).
 */
export function runForExport(run: Run): Run {
  if (BARE_VERSION.test(run.snapshot.appVersion)) return run;
  return { ...run, snapshot: { ...run.snapshot, appVersion: '' } };
}

/** Study notes as exported: the sampling notes of earlier versions named the app ("Annotation Desk sampling method 3"). */
export function plainNotes(text: string): string {
  return text.replace(/Annotation Desk (sampling method)/g, '$1');
}

export function studyForExport(study: Study): Study {
  return study.description.includes('Annotation Desk') ? { ...study, description: plainNotes(study.description) } : study;
}

/** The research zip's private record of builds: this export's, and each run's (as stored). */
export function softwareVersions(runs: Run[], name: (run: Run) => string, exportedAt: string): string {
  return JSON.stringify(
    {
      note: 'The only file of this export that names the app and its builds. Keep it private: do not publish it.',
      software: 'Annotation Desk',
      exported_with: __APP_VERSION__,
      exported_at: exportedAt,
      runs: runs.map((r) => ({ run: name(r), id: r.id, made_with: r.snapshot.appVersion || 'not recorded' })),
    },
    null,
    2,
  );
}
