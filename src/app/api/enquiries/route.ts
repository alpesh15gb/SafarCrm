import {getMe} from '@/lib/auth';
import {createClient} from '@/lib/supabase/server';
import {boundedEnquiryBody,enquiryStatuses,enquiryServices,enquiryUuid} from '@/lib/max-ai-enquiries';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
async function context(){
  const me=await getMe();
  if(!me||me.role==='client'||me.mfa_pending||me.must_change_password)return null;
  return {me,sb:await createClient()};
}
export async function GET(request:Request){
  try{
    const ctx=await context();if(!ctx)return json({error:'Team access is required.'},403);
    const {me,sb}=ctx,params=new URL(request.url).searchParams;
    for(const key of ['q','status','service','page','id','environment'])if(params.getAll(key).length>1)return json({error:'Use one value per filter.'},400);
    const q=(params.get('q')??'').trim(),status=params.get('status')||null,service=params.get('service')||null,page=Number(params.get('page')??1),id=params.get('id');
    const environment=params.get('environment')??'live';
    if(!['test','live'].includes(environment)||q.length>100||!Number.isInteger(page)||page<1||page>10000||status&&!enquiryStatuses.includes(status as typeof enquiryStatuses[number])||service&&!enquiryServices.includes(service as typeof enquiryServices[number])||id!==null&&!enquiryUuid(id))return json({error:'Check the enquiry filters.'},400);
    const {data,error}=await sb.rpc('max_ai_enquiry_list',{p_q:q,p_status:status,p_service:service,p_page:page,p_id:id,p_environment:environment});
    if(error)return json({error:'Enquiries could not be loaded.'},error.code==='42501'?403:503);
    let staff:unknown[]=[];
    if(me.role==='boss'){
      const members=await sb.from('profiles').select('id,full_name,role').eq('active',true).in('role',['boss','staff']).order('full_name');
      if(members.error)return json({error:'The team list could not be loaded.'},503);
      staff=members.data??[];
    }
    return json({...data,canAssign:me.role==='boss',staff});
  }catch{return json({error:'Enquiries could not be loaded.'},503);}
}
export async function PATCH(request:Request){
  try{
    const origin=request.headers.get('origin'),expected=process.env.NEXT_PUBLIC_APP_URL;
    if(!origin||!expected||new URL(origin).origin!==new URL(expected).origin||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Reload this page before saving.'},403);
    const ctx=await context();if(!ctx)return json({error:'Team access is required.'},403);
    let input:Record<string,unknown>;
    try{input=JSON.parse(await boundedEnquiryBody(request,16384));}catch{return json({error:'Check the enquiry details.'},400);}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','version','status','internalNote','assignedTo'].includes(key))||!enquiryUuid(input.id)||!Number.isInteger(input.version)||Number(input.version)<1||typeof input.status!=='string'||!enquiryStatuses.includes(input.status as typeof enquiryStatuses[number])||typeof input.internalNote!=='string'||input.internalNote.length>2000||Object.hasOwn(input,'assignedTo')&&input.assignedTo!==null&&!enquiryUuid(input.assignedTo))return json({error:'Check the enquiry details.'},400);
    const assign=Object.hasOwn(input,'assignedTo');
    if(assign&&ctx.me.role!=='boss')return json({error:'Only the boss can assign enquiries.'},403);
    const {data,error}=await ctx.sb.rpc('update_max_ai_enquiry',{p_id:input.id,p_version:input.version,p_status:input.status,p_internal_note:input.internalNote.trim(),p_assign:assign,p_assigned_to:assign?input.assignedTo:null});
    if(error){const status=error.code==='42501'?403:error.code==='40001'?409:error.code==='22023'?400:503;return json({error:status===409?'This enquiry changed. Refresh before saving.':status===403?'You cannot change this enquiry.':status===400?'Choose an active team member and valid details.':'The save could not be confirmed. Refresh before trying again.'},status);}
    return json({enquiry:data});
  }catch{return json({error:'The save could not be confirmed. Refresh before trying again.'},503);}
}
