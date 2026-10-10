import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';

export interface FleetApp {id:string;name:string;jobs:Array<{id:string;heartbeatExpected:boolean;intervalSeconds:number;graceSeconds:number}>;}
export interface FleetIncident {
  id:string;app_id:string;state:string;classification:string;title:string;detail:string;
  first_seen_at:string;last_seen_at:string;resolved_at:string|null;proof:string|null;
  task_id:string|null;node_id:string|null;prevention_required:number;
}
export interface FleetStatus {
  runtime:{last_completed_at:string|null;last_result:string|null}|null;
  probes:Array<{app_id:string;state:string;observed_at:string|null;next_due_at:string}>;
  nodes:Array<{id:string;label:string;connected:boolean;protocolReady:boolean}>;
  monitoring:string;deploymentGrace:boolean;oldestPendingNoticeAt:string|null;notificationBacklog:boolean;
  flags:{enabled:boolean;investigation:boolean;recovery:boolean};budget:{units:number}|null;
  limits:{workUnitsPerDay:number};
}
export function useOperations(appId?:string,cursor?:string,incidentId?:string) {
  const {api,mode}=useRuntime();
  const [visible,setVisible]=useState(()=>document.visibilityState==='visible');
  useEffect(()=>{const update=()=>setVisible(document.visibilityState==='visible');document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update);},[]);
  const options={enabled:mode==='cloud'&&visible,staleTime:300_000,refetchInterval:visible?300_000:false as const,refetchIntervalInBackground:false};
  const apps=useQuery({...options,queryKey:['operations','apps'],queryFn:({signal})=>api.get<{apps:FleetApp[]}>('/api/cloud/operations/apps',signal)});
  const status=useQuery({...options,queryKey:['operations','status'],queryFn:({signal})=>api.get<FleetStatus>('/api/cloud/operations/status',signal)});
  const validApp=!!appId&&!!apps.data?.apps.some(a=>a.id===appId);
  const incidents=useQuery({...options,enabled:options.enabled&&validApp,queryKey:['operations','incidents',appId,cursor??''],
    queryFn:({signal})=>api.get<{incidents:FleetIncident[];nextCursor:string|null}>(`/api/cloud/operations/incidents?appId=${encodeURIComponent(appId!)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,signal)});
  const selected=useQuery({...options,enabled:options.enabled&&validApp&&!!incidentId&&/^incident_[a-f0-9]{32}$/.test(incidentId),queryKey:['operations','incident',incidentId],
    queryFn:({signal})=>api.get<{incident:FleetIncident|null}>(`/api/cloud/operations/incidents/${encodeURIComponent(incidentId!)}`,signal)});
  return {apps,status,incidents,selected};
}
