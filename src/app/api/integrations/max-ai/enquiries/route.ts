import {receiveMaxAiEnquiry} from '@/lib/max-ai-enquiries';
import {createAdmin} from '@/lib/supabase/server';

export const runtime='nodejs';
export async function POST(request:Request){
  return receiveMaxAiEnquiry(request,{
    signingKeys:process.env.SAFAR_MAX_AI_SIGNING_KEYS,
    ingest:async(event,hash)=>createAdmin().rpc('receive_max_ai_enquiry',{p_event:event,p_body_hash:hash}),
  });
}
