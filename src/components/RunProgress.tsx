import { cancelJob, useStore } from '../lib/store';
import { Icon } from './ui';

/**
 * The progress of a run (or of Retry failed) with its Cancel button, or what is being uploaded or deleted.
 * Shown on the Workbench and above the list of runs, so a retry started there can be followed and stopped there.
 */
export function RunProgress() {
  const job = useStore((s) => s.job);
  const submitting = useStore((s) => s.submitting);
  const deletingWhat = useStore((s) => s.deletingWhat);
  return (
    <>
      {(submitting || deletingWhat) && !job && <div className="progress-label">{submitting || deletingWhat}</div>}
      {job && (
        <div>
          <div className="progress">
            <div style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
          </div>
          <div className="progress-label">
            <span>
              {job.done} of {job.total} requests{job.failed ? ` · ${job.failed} failed` : ''}
            </span>
            <button className="btn small danger" onClick={cancelJob}>
              <Icon name="stop" size={12} /> Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
