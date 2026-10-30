import { describe,it,expect,vi } from 'vitest';
import { reportMarkup } from '../public/report-export.js';
import { createBrowserApi } from '../src/browser-api.js';
const record = {id:'case-1',kind:'case',name:'Private Person',reporter_email:'private@example.com',created_at:1,items:[{id:1,url:'https://publisher.example/private-path',title:'Private title',status:'sent'}]};
describe('branded report export',()=>{
  it('escapes notes, URLs and metadata rather than executing them',()=>{
    const html=reportMarkup({...record,name:'<script>alert(1)</script>'},{notes:{narrative:'<img src=x onerror=alert(1)>'}});
    expect(html).not.toContain('<script>');expect(html).not.toContain('<img src=x');expect(html).toContain('&lt;script&gt;');
  });
  it('omits identifying content and free text in PR exports',()=>{
    const html=reportMarkup(record,{version:'pr',notes:{narrative:'Secret narrative',reporter:'Secret reporter',evidence:'Secret evidence'},receipts:[{record_id:'case-1',hit_id:1,to:'recipient@example.com',subject:'Secret subject',request_id:'receipt',status:'accepted'}]});
    for(const secret of ['Private Person','Private title','private@example.com','private-path','Secret narrative','Secret reporter','Secret evidence','recipient@example.com','Secret subject']) expect(html).not.toContain(secret);
    expect(html).toContain('publisher.example');
  });
  it('caps scan export at twenty and excludes unrelated or locked email receipts',()=>{
    const html=reportMarkup({...record,kind:'scan',items:Array.from({length:21},(_,i)=>({id:i,url:`https://example.com/${i===20?'LOCKED':'shown'}`}))},{receipts:[{record_id:'case-1',hit_id:20,to:'LOCKED',status:'accepted'},{record_id:'other',hit_id:1,to:'OTHER'}]});
    expect(html).not.toContain('LOCKED');expect(html).not.toContain('OTHER');
  });
  it('labels demo results and never claims provider acceptance proves removal',()=>{
    const html=reportMarkup({...record,provider:'mock'});expect(html).toContain('FICTIONAL TEST DATA');expect(html).toContain('does not confirm delivery or removal');
  });
  it('labels known-URL demos and warns about stale email status',()=>{
    const html=reportMarkup({...record,is_demo:true});
    expect(html).toContain('FICTIONAL TEST DATA');expect(html).toContain('may be out of date');
    expect(reportMarkup(record,{emailCheckedAt:1})).toContain('statuses checked at');
  });
  it('reads export data without triggering search or sharing stored drafts',async()=>{
    const fetchImpl=vi.fn();const row={id:'case-1',affected_name:'Name',items:[{id:1,url:'https://example.com',edited_drafts:{initial:{body:'PRIVATE DRAFT'}}}]};
    const store={get:vi.fn(async()=>row),put:vi.fn(),update:vi.fn(),remove:vi.fn(),list:vi.fn()};
    const app=createBrowserApi({store,fetchImpl}); const data=await app.reportData('case','case-1');
    expect(JSON.stringify(data)).not.toContain('PRIVATE DRAFT');expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['police','legal','pr'])('labels earlier observations with their original timestamp in %s exports',version=>{
    const observed=Date.UTC(2026,8,25,12), carried=Date.UTC(2026,8,30,12);
    const html=reportMarkup({...record,id:'PRIVATE-SCAN-ID',kind:'scan',provider:'searxng',created_at:carried,
      items:[{...record.items[0],discovery_origin:'previous_scan',previous_observed_at:observed,last_seen_at:observed,
        carried_into_at:carried,previous_scan_id:'PRIVATE-PREVIOUS-SCAN',previous_hit_id:998}]},{version,generated:carried});
    expect(html).toContain('Retained from an earlier scan');
    expect(html).toContain('Earlier observation: 2026-09-25 12:00:00 UTC');
    expect(html).toContain('does not verify that the source is still available');
    expect(html).not.toContain('PRIVATE-PREVIOUS-SCAN');
    expect(html).not.toContain('Returned again in this scan');
    if(version==='pr') for(const secret of ['PRIVATE-SCAN-ID','Private Person','Private title','private-path','https://publisher.example/private-path']) expect(html).not.toContain(secret);
    else expect(html).toContain('PRIVATE-SCAN-ID');
  });
  it('distinguishes a real current rediscovery from copying a historical record',()=>{
    const observed=Date.UTC(2026,8,25,12), returned=Date.UTC(2026,8,30,12);
    const html=reportMarkup({...record,kind:'scan',items:[{...record.items[0],discovery_origin:'search',
      previous_observed_at:observed,last_seen_at:returned,reobserved_at:returned}]});
    expect(html).toContain('Earlier observation: 2026-09-25 12:00:00 UTC');
    expect(html).toContain('Returned again in this scan: 2026-09-30 12:00:00 UTC');
    expect(html).toContain('Includes an earlier saved observation');
    expect(html).not.toContain('not returned');
  });
  it('omits historical origin and dates for findings beyond the twenty-row allowance',()=>{
    const hiddenObservation=Date.UTC(2020,0,2,3,4,5);
    const items=Array.from({length:21},(_,i)=>({...record.items[0],id:i,...(i===20?
      {discovery_origin:'previous_scan',previous_observed_at:hiddenObservation,previous_scan_id:'HIDDEN-SCAN'}:{})}));
    const html=reportMarkup({...record,kind:'scan',items});
    expect(html).not.toContain('Retained from an earlier scan');
    expect(html).not.toContain('2020-01-02 03:04:05');
    expect(html).not.toContain('HIDDEN-SCAN');
  });
});
