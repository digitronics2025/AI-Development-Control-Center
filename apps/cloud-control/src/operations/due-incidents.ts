/** Each state branch stops at its index limit before the bounded merge/sort.
 * LIMIT on a multi-state sort alone can scan an entire due backlog. */
export function actionableIncidentQuery(owner:string,now:string,actionsEnabled:boolean) {
  const states=actionsEnabled?['verifying','recovering','investigating','detected','waiting_execution']:['verifying','recovering'];
  const sql=states.map((state,index)=>`SELECT * FROM (SELECT i.*,${index<2?0:1} AS priority FROM ops_incidents i
    JOIN ops_apps a ON a.id=i.app_id WHERE i.state=? AND i.next_action_at<=? AND a.enabled=1 AND a.owner_email=?
    ORDER BY i.next_action_at LIMIT 2)`).join(' UNION ALL ');
  return {sql:`SELECT * FROM (${sql}) ORDER BY priority,next_action_at LIMIT 2`,params:states.flatMap(state=>[state,now,owner])};
}
