import { describe, expect, it } from 'vitest';
import type { StageWorkUnit } from '@acc/shared';
import { teamSummary } from './team';

let seq = 0;
const unit = (kind: StageWorkUnit['kind'], status: StageWorkUnit['status']) => ({ id: `u${++seq}`, kind, status }) as StageWorkUnit;

describe('teamSummary', () => {
  it('says judging while the judge compares finished variants, not done', () => {
    const variants = [unit('worker', 'SUCCESS'), unit('worker', 'SUCCESS'), unit('worker', 'SUCCESS')];
    expect(teamSummary([...variants, unit('judge', 'RUNNING')])).toBe('Team of 3 · judging');
    // The kept variant's files are written with no unit of their own (no lead pass): the team is done once judged.
    expect(teamSummary([...variants, unit('judge', 'SUCCESS')])).toBe('Team of 3 · done');
    // A fixed or adaptive write team's lead pass still reads as integrating.
    expect(teamSummary([unit('worker', 'SUCCESS'), unit('worker', 'SUCCESS'), unit('integration', 'RUNNING')])).toBe('Team of 2 · integrating');
  });

  it('counts only workers and reports running, waiting and failed ones first', () => {
    expect(teamSummary([unit('decomposer', 'RUNNING')])).toBeNull();
    expect(teamSummary([unit('worker', 'RUNNING'), unit('worker', 'SUCCESS'), unit('worker', 'QUEUED')])).toBe('Team 1/3 running');
    expect(teamSummary([unit('worker', 'QUEUED'), unit('worker', 'QUEUED')])).toBe('Team of 2 · waiting');
    expect(teamSummary([unit('worker', 'FAILED'), unit('worker', 'SUCCESS'), unit('judge', 'RUNNING')])).toBe('Team of 2 · 1 failed');
  });
});
