import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {parseEnquiryEvent,receiveMaxAiEnquiry,validEnquiryReceipt,type EnquiryEvent} from '../../src/lib/max-ai-enquiries.ts';

const secret='synthetic-max-ai-signing-key-at-least-32-characters',now=Date.UTC(2030,0,1),timestamp=String(now/1000);
function fixture(service='VISA'):EnquiryEvent{
  const id=randomUUID(),date=new Date(now).toISOString();
  return {schemaVersion:2,environment:'test',eventId:randomUUID(),eventType:'enquiry.created',aggregateId:id,occurredAt:date,revision:1,payload:{enquiryId:id,reference:'ME-'+id.replaceAll('-','').slice(0,12).toUpperCase(),service,
    draft:{service,destination:'Synthetic destination',travelWindow:'December 2030',adults:1,childAges:[6],...(service==='VISA'?{nationality:'Indian',purpose:'Tourism'}:{}),...(service==='INSURANCE'?{travellerAges:[30,6]}:{}),...(service==='HOLIDAY'?{departureCity:'Hyderabad'}:{}),budgetRupees:10000,budgetBasis:'PER_PERSON'},
    contact:{name:'Synthetic customer',email:'synthetic@example.test',preferredChannel:'EMAIL'},contactVerified:false,consentAt:date,createdAt:date}};
}
function request(event:EnquiryEvent,options:{raw?:string;signature?:string;timestamp?:string;eventId?:string;keyId?:string}={}){
  const raw=options.raw??JSON.stringify(event),ts=options.timestamp??timestamp,id=options.eventId??event.eventId;
  return new Request('https://crm.example.test/api/integrations/max-ai/enquiries',{method:'POST',body:raw,headers:{'content-type':'application/json','x-maxtravel-key-id':options.keyId??'synthetic','x-maxtravel-timestamp':ts,'x-maxtravel-event-id':id,'x-maxtravel-signature':options.signature??createHmac('sha256',secret).update(`${ts}.${id}.${raw}`).digest('hex')}});
}
test('enquiry wire schema accepts the four services and child-only applications; rejects injected and inconsistent data',()=>{
  for(const service of ['VISA','INSURANCE','HOLIDAY','CRUISE'])assert.deepEqual(parseEnquiryEvent(fixture(service)).payload.service,service);
  assert.equal(parseEnquiryEvent({...fixture(),environment:'live'}).environment,'live');
  for(const service of ['VISA','INSURANCE']){const e=fixture(service);e.payload.draft.adults=0;if(service==='INSURANCE')e.payload.draft.travellerAges=[6];assert.doesNotThrow(()=>parseEnquiryEvent(e));}
  const bad:unknown[]=[];
  const changed=(change:(e:EnquiryEvent)=>void)=>{const e=fixture();change(e);bad.push(e);};
  changed(e=>{e.payload.draft.service='CRUISE';});changed(e=>{delete e.payload.draft.nationality;});changed(e=>{e.payload.draft.travelStart='2030-02-31';});
  changed(e=>{e.payload.draft.travelEnd='2030-12-31';});changed(e=>{delete e.payload.draft.budgetBasis;});changed(e=>{e.payload.contact.preferredChannel='WHATSAPP';});
  changed(e=>{e.payload.draft.adults=0;e.payload.draft.childAges=[];});changed(e=>{e.payload.contact.phone='+12';});changed(e=>{e.payload.draft.crmCustomerId=randomUUID();});
  bad.push({...fixture(),payload:{...fixture().payload,contactVerified:true}});bad.push({...fixture(),operatorRole:'boss'});
  bad.push({...fixture(),schemaVersion:1});bad.push({...fixture(),environment:undefined});bad.push({...fixture(),environment:'production'});
  const insurance=fixture('INSURANCE');insurance.payload.draft.travellerAges=[6,7];bad.push(insurance);
  for(const e of bad)assert.throws(()=>parseEnquiryEvent(e),/Invalid enquiry/);
});
test('signed receiver authenticates exact bounded raw body before any database access',async()=>{
  let calls=0;
  const event=fixture(),recordId=randomUUID(),receipt={accepted:true,receiver:'safar',enquiryId:event.aggregateId,recordId,reference:event.payload.reference,environment:'test'};
  const options={signingKeys:JSON.stringify({synthetic:secret}),now,ingest:async(received:EnquiryEvent,hash:string)=>{calls++;assert.deepEqual(received,event);assert.match(hash,/^[0-9a-f]{64}$/);return {data:receipt,error:null};}};
  assert.equal((await receiveMaxAiEnquiry(request(event,{signature:'0'.repeat(64)}),options)).status,401);
  assert.equal((await receiveMaxAiEnquiry(request(event,{timestamp:'1000000000'}),options)).status,401);
  assert.equal((await receiveMaxAiEnquiry(request(event,{keyId:'__proto__'}),options)).status,401);
  assert.equal((await receiveMaxAiEnquiry(request(event,{eventId:randomUUID()}),options)).status,400);
  assert.equal((await receiveMaxAiEnquiry(request(event,{raw:JSON.stringify({...event,payload:{...event.payload,contactVerified:true}})}),options)).status,400);
  assert.equal((await receiveMaxAiEnquiry(request(event,{raw:'x'.repeat(65537)}),options)).status,413);
  assert.equal((await receiveMaxAiEnquiry(request(event),{...options,signingKeys:undefined})).status,503);
  assert.equal(calls,0);
  const response=await receiveMaxAiEnquiry(request(event),options);assert.equal(response.status,200);assert.deepEqual(await response.json(),receipt);assert.equal(calls,1);assert.match(response.headers.get('cache-control')??'',/no-store/);
});
test('receiver never acknowledges old CRM success, a mismatched receipt or failed persistence',async()=>{
  const event=fixture(),options={signingKeys:JSON.stringify({synthetic:secret}),now};
  for(const data of [{ok:true},{accepted:true,receiver:'maxtravel',enquiryId:event.aggregateId,recordId:randomUUID(),reference:event.payload.reference},{accepted:true,receiver:'safar',enquiryId:randomUUID(),recordId:randomUUID(),reference:event.payload.reference}]){
    assert.equal(validEnquiryReceipt(data,event.aggregateId,event.environment),false);
    assert.equal((await receiveMaxAiEnquiry(request(event),{...options,ingest:async()=>({data,error:null})})).status,503);
  }
  assert.equal((await receiveMaxAiEnquiry(request(event),{...options,ingest:async()=>({data:null,error:{code:'23505'}})})).status,409);
  const wrongEnvironment={accepted:true,receiver:'safar',enquiryId:event.aggregateId,recordId:randomUUID(),reference:event.payload.reference,environment:'live'};
  assert.equal((await receiveMaxAiEnquiry(request(event),{...options,ingest:async()=>({data:wrongEnvironment,error:null})})).status,503);
  assert.equal((await receiveMaxAiEnquiry(request(event),{...options,ingest:async()=>{throw Error('private database detail');}})).status,503);
});
