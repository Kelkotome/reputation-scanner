import {it,expect,vi,afterEach} from 'vitest';
import {stopItemFollowups,forgetRecordMetadata} from '../public/followup-control.js';
afterEach(()=>vi.unstubAllGlobals());
function setup() {
  const values=new Map([['rep-email-send:receipt',JSON.stringify({record_id:'local-case',hit_id:4,request_id:'email-receipt',followup:{status:'queued'}})]]);
  vi.stubGlobal('localStorage',{length:1,key:i=>[...values.keys()][i],getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);return {fetch,values};
}
it('cancels matching queued email before local closure without sharing case identity',async()=>{
  const {fetch,values}=setup();
  fetch.mockResolvedValueOnce(Response.json({connected:true,jobs:[{request_id:'email-receipt',status:'queued'}]})).mockResolvedValueOnce(Response.json({ok:true}));
  await stopItemFollowups('local-case',4);
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1][1].body).not.toContain('local-case');
  expect(JSON.parse(values.values().next().value).followup.status).toBe('closed');
});
it('blocks closure when cancellation is unconfirmed and ignores unrelated items',async()=>{
  const {fetch}=setup();await stopItemFollowups('different',4);expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(new Response('',{status:503}));await expect(stopItemFollowups('local-case',4)).rejects.toThrow('stop the queued follow-up');
});
it('erases identifying receipt metadata but retains the duplicate-send guard',()=>{
  const {values}=setup(); forgetRecordMetadata('local-case');
  expect(JSON.parse(values.values().next().value)).toEqual({request_id:'email-receipt'});
});
