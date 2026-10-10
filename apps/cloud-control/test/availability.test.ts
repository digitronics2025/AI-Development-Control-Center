import { describe,expect,it } from 'vitest';
import { assessAvailability } from '../scripts/check-availability.mjs';
const now=Date.parse('2026-10-10T05:00:00Z');
const ago=(minutes:number)=>new Date(now-minutes*60000).toISOString();
const baseline={supervisorEnabled:true,messengerScheduledAt:now-60000,runtime:{last_completed_at:ago(1),last_result:'{}'},oldestPendingNoticeAt:null};
describe('independent availability thresholds',()=>{
  it('keeps the disabled baseline pending, with no fabricated supervisor outage',()=>{
    expect(assessAvailability({...baseline,supervisorEnabled:false,runtime:null},now)).toMatchObject({state:'pending_rollout',issues:[]});
  });
  it.each([null,NaN,now+1])('marks missing/invalid/future Messenger proof unknown: %s',stamp=>{
    expect(assessAvailability({...baseline,messengerScheduledAt:stamp},now).issues).toContain('messenger_scheduler_unknown');
  });
  it.each([null,'invalid',new Date(now+1).toISOString()])('keeps missing/invalid/future monitor proof unknown during grace: %s',stamp=>{
    expect(assessAvailability({...baseline,runtime:{last_completed_at:stamp},deployedAt:ago(1)},now).issues).toContain('supervisor_completion_unknown');
  });
  it('uses 45/20/30 minute thresholds and reports a saturated completed tick',()=>{
    expect(assessAvailability({...baseline,messengerScheduledAt:now-46*60000,runtime:{last_completed_at:ago(21),last_result:'{"budgetLimited":1}'},oldestPendingNoticeAt:ago(31)},now).issues)
      .toEqual(['messenger_scheduler_stale','supervisor_completion_stale','supervisor_coverage_limited','owner_delivery_pending']);
  });
  it('allows deployment propagation for stale valid stamps, and then reports it',()=>{
    expect(assessAvailability({...baseline,runtime:{last_completed_at:ago(21)},deployedAt:ago(19)},now).issues).toEqual([]);
    expect(assessAvailability({...baseline,runtime:{last_completed_at:ago(21)},deployedAt:ago(20)},now).issues).toContain('supervisor_completion_stale');
  });
  it('reports restored liveness without certifying a repair or phone push',()=>{
    expect(assessAvailability(baseline,now)).toMatchObject({state:'current',issues:[]});
    expect(assessAvailability(baseline,now).evidence).toContain('separately verified');
  });
});
