import test from 'node:test';
import assert from 'node:assert/strict';
import { emailHealth } from '../../deploy/email-health.mjs';

test('email monitor reports only aggregate metadata and raises actionable failure conditions',async()=>{
  const zero={pending:0,overdue:0,review_required:0,failed_last_hour:0,missing_delivery_confirmation:0,open_incidents:0};
  for(const key of [null,'pending','overdue','review_required','failed_last_hour','missing_delivery_confirmation','open_incidents']){
    const metrics={...zero,...(key?{[key]:1}:{})};let calls=0;
    const result=await emailHealth({query:async(sql:string)=>{calls++;assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/payload|recipient|provider_message_id|INSERT|UPDATE|DELETE/);return {rows:[metrics]};}});
    assert.equal(calls,1);assert.deepEqual(result,{...metrics,needsAttention:key==='overdue'||key==='open_incidents'});
  }
});
