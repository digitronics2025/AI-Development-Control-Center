import { test, expect } from '@playwright/test';

const incident={id:'incident_'+'a'.repeat(32),app_id:'messenger',state:'pending_investigation',classification:'technical',title:'Owner notice retry remains unverified',detail:'A retry does not establish delivery. Fresh native evidence is required.',first_seen_at:'2026-10-09T00:00:00Z',last_seen_at:'2026-10-09T01:00:00Z',resolved_at:null,proof:null,task_id:'TASK-0001',node_id:'local',prevention_required:1};
for(const theme of ['light','dark']) for(const width of [390,1440]) {
  test(`Operations ${theme} ${width}: held actions, proof, task link, keyboard and hidden polling`,async({page},testInfo)=>{
    await page.setViewportSize({width,height:900});
    await page.route('**/api/settings',route=>route.fulfill({json:{theme}}));
    let reads=0;
    await page.route('**/api/cloud/operations/**',async route=>{
      reads++;
      const url=new URL(route.request().url());
      const data=url.pathname.endsWith('/apps')?{apps:[{id:'messenger',name:'Messenger',jobs:[{id:'daily',heartbeatExpected:false,intervalSeconds:300,graceSeconds:900}]}]}:
        url.pathname.endsWith('/status')?{runtime:{last_completed_at:'2026-10-09T01:00:00Z',last_result:'{"budgetLimited":1}'},probes:[],nodes:[{id:'local',label:'Offline owner',connected:false,protocolReady:true}],monitoring:'stale',deploymentGrace:false,oldestPendingNoticeAt:null,notificationBacklog:false,flags:{enabled:true,investigation:false,recovery:false},budget:{units:6000},limits:{workUnitsPerDay:6000}}:
        {incidents:[incident],nextCursor:null};
      await route.fulfill({json:data});
    });
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/operations?appId=messenger');
    await expect(page.getByRole('heading',{name:'Operations',exact:true})).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await expect(page.getByText('Investigations held · native recovery held')).toBeVisible();
    await expect(page.getByText('Waiting for a connected, current execution node')).toBeVisible();
    await expect(page.getByText('0 of 1 job receipt contracts enabled. Other job outcomes remain unverified.')).toBeVisible();
    await expect(page.getByRole('article',{name:incident.title})).toBeVisible();
    const link=page.getByRole('link',{name:'Open investigation task'});
    await expect(link).toHaveAttribute('href','/tasks/TASK-0001');
    await link.focus();await expect(link).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`operations-${theme}-${width}.png`),fullPage:true});
    await page.clock.install();
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(100);
    const before=reads;
    await page.clock.fastForward(301_000);
    await page.waitForTimeout(100);
    expect(reads).toBe(before);
    expect(errors).toEqual([]);
  });
}
test('Operations error and empty states preserve unknown health',async({page})=>{
  await page.route('**/api/cloud/operations/**',route=>route.fulfill({status:403,json:{error:'Forbidden'}}));
  await page.goto('/operations');
  await expect(page.getByRole('alert').filter({hasText:'Monitoring could not be loaded'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry'})).toBeVisible();
  await expect(page.getByText('Evidence is unavailable.')).toBeVisible();
});
