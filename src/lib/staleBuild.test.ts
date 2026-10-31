import { describe, expect, it } from 'vitest';
import { errorMessage, STALE_BUILD } from './util';

describe('a part of an older version of the site that is gone', () => {
  it('says to reload, in the wording of each browser', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: https://x.github.io/Annotation-Desk/assets/exceljs.min-DPV6ZA4z.js',
      'error loading dynamically imported module: https://x/assets/a.js',
      'Importing a module script failed.',
    ])
      expect(errorMessage(new TypeError(m))).toBe(STALE_BUILD);
  });
  it('leaves other errors as they are', () => {
    expect(errorMessage(new Error('Quota exceeded'))).toBe('Quota exceeded');
    expect(errorMessage('plain')).toBe('plain');
  });
});
