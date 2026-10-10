import { Link, useSearchParams } from 'react-router';
import { Badge, Banner, Button, EmptyState, PageHeader, Panel, Select } from '@acc/ui';
import { useOperations, type FleetIncident } from '../api/operations';
import { useBreadcrumb } from '../app/breadcrumbs';
import { useSelectedNode } from '../app/runtime';

function time(value:string|null) {
  return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(value))+' (Asia/Shanghai)':'Not observed';
}
const classification:Record<string,string>={technical:'Technical fault',business:'Business decision',staff_attention:'Staff handoff',policy_hold:'Policy hold',uncertain_delivery:'Uncertain delivery',expected_pause:'Expected pause'};
function Incident({incident}:{incident:FleetIncident}) {
  const node=useSelectedNode();
  return <article className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4" aria-label={incident.title}>
    <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="text-body font-semibold text-fg wrap-anywhere">{incident.title}</h2><Badge>{incident.state.replaceAll('_',' ')}</Badge></div>
    <p className="text-small text-fg-secondary">{classification[incident.classification]??'Unclassified'} · Last observed {time(incident.last_seen_at)}</p>
    <p className="text-body text-fg wrap-anywhere">{incident.detail}</p>
    {incident.state==='resolved'?<p className="text-small text-fg-secondary">{incident.proof?'Native proof recorded':'Resolution evidence unavailable'} · {time(incident.resolved_at)}</p>:<p className="text-small text-fg-secondary">Recovery remains unverified until fresh native proof is recorded.</p>}
    {incident.prevention_required?<p className="text-small text-fg-secondary">A recurrence prevention review is required.</p>:null}
    {incident.task_id&&incident.node_id?<Link className="inline-flex min-h-11 items-center text-body font-semibold text-accent underline" to={`/tasks/${encodeURIComponent(incident.task_id)}`} onClick={()=>node.select(incident.node_id!)}>Open investigation task</Link>:<p className="text-small text-fg-secondary">No linked investigation task.</p>}
  </article>;
}
export function OperationsPage() {
  useBreadcrumb([{label:'Operations'}]);
  const [params,setParams]=useSearchParams();
  const appId=params.get('appId')??undefined,cursor=params.get('cursor')??undefined,incidentId=params.get('incidentId')??undefined;
  const q=useOperations(appId,cursor,incidentId),status=q.status.data;
  const app=q.apps.data?.apps.find(a=>a.id===appId);
  const probe=status?.probes.find(p=>p.app_id===appId);
  const monitorLimited=(()=>{try{return JSON.parse(status?.runtime?.last_result??'{}').budgetLimited===1;}catch{return true;}})();
  const selected=q.selected.data?.incident;
  const incidents=selected&&selected.app_id===appId?[selected]:q.incidents.data?.incidents??[];
  return <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
    <PageHeader title="Operations" description="Fleet incidents, monitoring coverage and verified outcomes." />
    {q.apps.isError||q.status.isError?<Banner tone="danger" role="alert" title="Monitoring could not be loaded">Evidence is unavailable. <Button onClick={()=>{void q.apps.refetch();void q.status.refetch();}}>Retry</Button></Banner>:null}
    {q.status.isLoading?<p role="status">Loading monitoring…</p>:status?<Panel title="Supervision">
      <dl className="grid gap-3 text-body sm:grid-cols-2"><div><dt className="text-fg-secondary">Monitor</dt><dd className="font-semibold text-fg">{status.monitoring.replaceAll('_',' ')}{status.deploymentGrace?' · deployment grace':''}</dd></div><div><dt className="text-fg-secondary">Last completed tick</dt><dd className="text-fg">{time(status.runtime?.last_completed_at??null)}</dd></div><div><dt className="text-fg-secondary">Execution</dt><dd className="text-fg">{status.nodes.some(n=>n.connected&&n.protocolReady)?'Connected node; repository and policy checks apply':'Waiting for a connected, current execution node'}</dd></div><div><dt className="text-fg-secondary">Automatic actions</dt><dd className="text-fg">Investigations {status.flags.investigation?'enabled':'held'} · native recovery {status.flags.recovery?'enabled':'held'}</dd></div></dl>
      {monitorLimited?<p role="status" className="mt-3 text-body text-fg">Monitoring reached an admission limit. Pending work is retained; coverage is incomplete.</p>:null}
      {status.notificationBacklog?<p role="status" className="mt-3 text-body text-fg">Owner notice delivery is pending for more than 30 minutes.</p>:null}
      <p className="mt-3 text-small text-fg-secondary">Daily work units: {status.budget?.units??0} / {status.limits.workUnitsPerDay}. Completion and service probes do not certify individual jobs.</p>
    </Panel>:null}
    <div className="max-w-xl"><Select aria-label="App incidents" value={appId} onValueChange={id=>setParams({appId:id})} options={q.apps.data?.apps.map(a=>({value:a.id,label:a.name}))??[]} placeholder="Choose an app" disabled={q.apps.isLoading} /></div>
    {appId&&!app&&q.apps.isSuccess?<EmptyState title="App unavailable" description="Choose an app registered for your account." />:null}
    {app?<>
      <p className="text-body text-fg-secondary">{probe?`Service observation: ${probe.state} · ${time(probe.observed_at)}${Date.parse(probe.next_due_at)<Date.now()?' · refresh overdue; current health unknown':''}`:'No recurring service adapter. Native events are required.'}</p>
      <p className="text-body text-fg-secondary">{app.jobs.filter(j=>j.heartbeatExpected).length} of {app.jobs.length} job receipt contracts enabled. Other job outcomes remain unverified.</p>
      {q.incidents.isLoading||q.selected.isLoading?<p role="status">Loading incidents…</p>:q.incidents.isError||q.selected.isError?<Banner tone="danger" role="alert" title="Incidents unavailable">Access or evidence changed. <Button onClick={()=>{void q.incidents.refetch();if(incidentId)void q.selected.refetch();}}>Retry</Button></Banner>:incidents.length?<div className="grid gap-4 lg:grid-cols-2">{incidents.map(i=><Incident key={i.id} incident={i} />)}</div>:<EmptyState title="No recorded incidents" description="An empty incident page does not establish healthy apps or complete job coverage." />}
      {incidentId&&(!selected||selected.app_id!==appId)&&q.selected.isSuccess?<p role="alert" className="text-body text-fg">The linked incident is unavailable for this app.</p>:null}
      {q.incidents.data?.nextCursor&&!incidentId?<Button onClick={()=>setParams({appId:app.id,cursor:q.incidents.data!.nextCursor!})}>Next 25 incidents</Button>:null}
      {cursor?<Button variant="ghost" onClick={()=>setParams({appId:app.id})}>First page</Button>:null}
    </>:!appId?<EmptyState title="Choose an app" description="Select an app to inspect its incidents and monitoring gaps." />:null}
  </div>;
}
