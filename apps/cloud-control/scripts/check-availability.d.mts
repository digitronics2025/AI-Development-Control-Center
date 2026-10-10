export interface AvailabilityInput {
  messengerScheduledAt: number | null;
  supervisorEnabled: boolean;
  runtime?: {last_completed_at?:string|null;last_result?:string|null}|null;
  oldestPendingNoticeAt?:string|null;
  deployedAt?:string|null;
}
export interface AvailabilityResult {
  observedAt:string;state:string;issues:string[];deploymentGrace:boolean;
  supervisorCompletedAt:string|null;messengerScheduledAt:string|null;
  oldestPendingNoticeAt:string|null;evidence:string;
}
export function assessAvailability(input:AvailabilityInput,now?:number):AvailabilityResult;
export function readAvailability():Promise<AvailabilityResult>;
