import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export const enquiryServices=['VISA','INSURANCE','HOLIDAY','CRUISE'] as const;
export const enquiryStatuses=['NEW','CONTACTED','QUOTED','CLOSED'] as const;
type Obj=Record<string,unknown>;
export type EnquiryEvent={schemaVersion:2;environment:'test'|'live';eventId:string;eventType:'enquiry.created';aggregateId:string;occurredAt:string;revision:1;payload:{enquiryId:string;reference:string;service:string;draft:Obj;contact:Obj;contactVerified:false;consentAt:string;createdAt:string}};
const object=(value:unknown):value is Obj=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const keys=(value:Obj,allowed:string[],required=allowed)=>Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const text=(value:unknown,min:number,max:number)=>typeof value==='string'&&value===value.trim()&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export const enquiryUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const day=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const instant=(value:unknown)=>typeof value==='string'&&value.length<=35&&/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value)&&Number.isFinite(Date.parse(value));
const has=(values:readonly string[],value:unknown)=>typeof value==='string'&&values.includes(value);

/** Immutable wire contract. The sender already collects contact outside model chat. */
export function parseEnquiryEvent(value:unknown):EnquiryEvent{
  const bad=()=>{throw new Error('Invalid enquiry');};
  if(!object(value)||!keys(value,['schemaVersion','environment','eventId','eventType','aggregateId','occurredAt','revision','payload'])||value.schemaVersion!==2||!has(['test','live'],value.environment)||value.eventType!=='enquiry.created'||value.revision!==1||!enquiryUuid(value.eventId)||!enquiryUuid(value.aggregateId)||!instant(value.occurredAt)||!object(value.payload))return bad();
  const p=value.payload;
  if(!keys(p,['enquiryId','reference','service','draft','contact','contactVerified','consentAt','createdAt'])||p.enquiryId!==value.aggregateId||typeof p.reference!=='string'||!/^ME-[A-F0-9]{12}$/.test(p.reference)||!has(enquiryServices,p.service)||p.contactVerified!==false||!instant(p.consentAt)||!instant(p.createdAt)||!object(p.draft)||!object(p.contact))return bad();
  const d=p.draft,c=p.contact;
  const required=['service','destination','travelWindow','adults','childAges'];
  if(!keys(d,[...required,'departureCity','travelStart','travelEnd','durationNights','nationality','countryOfResidence','purpose','travellerAges','budgetRupees','budgetBasis','cabinPreference','notes'],required)||d.service!==p.service||!text(d.destination,2,150)||!text(d.travelWindow,2,120)||!integer(d.adults,0,50)||!Array.isArray(d.childAges)||d.childAges.length>20||!d.childAges.every(age=>integer(age,0,17))||d.adults+d.childAges.length<1)return bad();
  for(const [field,max] of Object.entries({departureCity:120,nationality:80,countryOfResidence:80,purpose:120,cabinPreference:120,notes:800}))if(d[field]!==undefined&&!text(d[field],2,max))return bad();
  if(d.travelStart!==undefined&&!day(d.travelStart)||d.travelEnd!==undefined&&(!day(d.travelEnd)||!d.travelStart||String(d.travelEnd)<String(d.travelStart))||d.durationNights!==undefined&&!integer(d.durationNights,1,365))return bad();
  if(d.travellerAges!==undefined&&(!Array.isArray(d.travellerAges)||d.travellerAges.length>70||!d.travellerAges.every(age=>integer(age,0,100))))return bad();
  if(d.service==='VISA'&&(!d.nationality||!d.purpose)||d.service==='HOLIDAY'&&!d.departureCity)return bad();
  if(d.service==='INSURANCE'){
    const ages=d.travellerAges;
    if(!Array.isArray(ages)||ages.filter(age=>age>=18).length!==d.adults||JSON.stringify(ages.filter(age=>age<18).sort((a,b)=>a-b))!==JSON.stringify([...d.childAges].sort((a,b)=>Number(a)-Number(b))))return bad();
  }
  if((d.budgetRupees!==undefined)!==(d.budgetBasis!==undefined)||d.budgetRupees!==undefined&&(typeof d.budgetRupees!=='number'||!Number.isFinite(d.budgetRupees)||d.budgetRupees<=0||d.budgetRupees>100000000||!has(['TOTAL','PER_PERSON'],d.budgetBasis)))return bad();
  if(!keys(c,['name','email','phone','preferredChannel'],['name','preferredChannel'])||!text(c.name,2,120)||!has(['EMAIL','PHONE','WHATSAPP'],c.preferredChannel))return bad();
  if(c.email!==undefined&&(!text(c.email,3,254)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email)))||c.phone!==undefined&&(typeof c.phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(c.phone)))return bad();
  if(c.preferredChannel==='EMAIL'?!c.email:!c.phone)return bad();
  return value as EnquiryEvent;
}

export type EnquiryReceipt={accepted:true;receiver:'safar';enquiryId:string;recordId:string;reference:string;environment:'test'|'live'};
export function validEnquiryReceipt(value:unknown,enquiryId:string,environment:'test'|'live'):value is EnquiryReceipt{
  return object(value)&&keys(value,['accepted','receiver','enquiryId','recordId','reference','environment'])&&value.accepted===true&&value.receiver==='safar'&&value.enquiryId===enquiryId&&value.environment===environment&&enquiryUuid(value.recordId)&&typeof value.reference==='string'&&/^ME-[A-F0-9]{12}$/.test(value.reference);
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
export async function boundedEnquiryBody(request:Request,max=65536){
  if(Number(request.headers.get('content-length')??0)>max)throw new Error('body_size');
  const reader=request.body?.getReader();if(!reader)throw new Error('body_missing');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('body_size');}chunks.push(value);}
  return Buffer.concat(chunks).toString('utf8');
}

/** Authentication precedes all database access; diagnostics never include payloads or keys. */
export async function receiveMaxAiEnquiry(request:Request,options:{signingKeys:string|undefined;ingest:(event:EnquiryEvent,hash:string)=>Promise<{data:unknown;error:{code?:string}|null}>;now?:number}){
  let keyMap:Obj;
  try{const parsed=JSON.parse(options.signingKeys??'');if(!object(parsed)||Object.keys(parsed).length>10)throw Error();keyMap=parsed;}catch{return json({error:'Enquiry integration is unavailable.'},503);}
  const keyId=request.headers.get('x-maxtravel-key-id')??'',timestamp=request.headers.get('x-maxtravel-timestamp')??'',eventId=request.headers.get('x-maxtravel-event-id')??'',signature=request.headers.get('x-maxtravel-signature')??'';
  const secret=Object.hasOwn(keyMap,keyId)?keyMap[keyId]:null;
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)||typeof secret!=='string'||secret.length<32||secret.length>4096||!/^\d{10}$/.test(timestamp)||Math.abs((options.now??Date.now())/1000-Number(timestamp))>300||!enquiryUuid(eventId)||!/^[0-9a-f]{64}$/i.test(signature))return json({error:'Invalid integration signature.'},401);
  let raw:string;
  try{raw=await boundedEnquiryBody(request);}catch{return json({error:'Invalid enquiry body.'},413);}
  const expected=createHmac('sha256',secret).update(`${timestamp}.${eventId}.${raw}`).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return json({error:'Invalid integration signature.'},401);
  let event:EnquiryEvent;
  try{event=parseEnquiryEvent(JSON.parse(raw));if(event.eventId!==eventId)throw Error();}catch{return json({error:'Check the enquiry details.'},400);}
  try{
    const {data,error}=await options.ingest(event,createHash('sha256').update(raw).digest('hex'));
    if(error){const conflict=['23505','40001'].includes(error.code??'');return json({error:conflict?'This enquiry conflicts with an existing submission.':'Enquiry delivery could not be recorded.'},conflict?409:503);}
    if(!validEnquiryReceipt(data,event.aggregateId,event.environment))return json({error:'Enquiry receipt unavailable.'},503);
    return json(data);
  }catch{return json({error:'Enquiry delivery could not be recorded.'},503);}
}
