import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';

export const migrationName='20261117000001_max_ai_enquiries.sql';
const migrations=new URL('../../supabase/migrations/',import.meta.url);
export const actors={
  boss:'11111111-1111-4111-8111-111111111111',
  staff:'22222222-2222-4222-8222-222222222222',
  other:'33333333-3333-4333-8333-333333333333',
  allCases:'44444444-4444-4444-8444-444444444444',
  profit:'55555555-5555-4555-8555-555555555555',
  inactive:'66666666-6666-4666-8666-666666666666',
  client:'77777777-7777-4777-8777-777777777777',
  mfa:'88888888-8888-4888-8888-888888888888',
  password:'99999999-9999-4999-8999-999999999999',
};

// These are only Supabase platform fixtures. Every application migration,
// authorization helper and trigger executes as checked in. No environment or
// network database is read; PGlite exists entirely in this Node process.
const platformFixture=`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create schema extensions;
  create schema storage;
  create schema cron;
  create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb not null default '{}',raw_user_meta_data jsonb not null default '{}');
  create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users(id),status text);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  create publication supabase_realtime;
  grant usage on schema public,auth,extensions to anon,authenticated,service_role;
  grant execute on all functions in schema auth to anon,authenticated,service_role;
  alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
  alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
  alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
`;

export async function asRole(db,role,actor,run,aal='aal2'){
  assert.ok(['postgres','anon','authenticated','service_role'].includes(role));
  await db.exec('BEGIN');
  try{
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(actor?{sub:actor}:{}),aal})]);
    const result=await run();
    await db.exec('COMMIT');
    return result;
  }catch(error){await db.exec('ROLLBACK');throw error;}
}

export async function businessSnapshot(db){
  const names=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'max_ai_enquir%' ORDER BY tablename")).rows.map(row=>row.tablename);
  const tables={};
  for(const name of names){
    assert.match(name,/^[a-z_]+$/);
    const result=await db.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS checksum FROM public.${name} t`);
    tables[name]=result.rows[0];
  }
  const sequences={};
  for(const row of (await db.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows){
    assert.match(row.sequencename,/^[a-z_]+$/);
    sequences[row.sequencename]=(await db.query(`SELECT last_value::text,is_called FROM public.${row.sequencename}`)).rows[0];
  }
  return {tables,sequences};
}

async function seedBusiness(db){
  for(const [kind,id] of Object.entries(actors)){
    await db.query('INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,$3::jsonb)',[id,`${kind}@synthetic.invalid`,JSON.stringify({role:kind==='boss'?'boss':kind==='client'?'client':'staff',full_name:`Synthetic ${kind}`})]);
  }
  await db.query('UPDATE public.profiles SET active=false WHERE id=$1',[actors.inactive]);
  await db.query('UPDATE public.profiles SET can_see_all_cases=true WHERE id=$1',[actors.allCases]);
  await db.query('UPDATE public.profiles SET can_see_profit=true WHERE id=$1',[actors.profit]);
  await db.query('UPDATE public.profiles SET must_change_password=true WHERE id=$1',[actors.password]);
  await db.query("INSERT INTO auth.mfa_factors(id,user_id,status) VALUES(gen_random_uuid(),$1,'verified')",[actors.mfa]);
  const customer=(await db.query("INSERT INTO public.customers(first_name,last_name,mobile,email,assigned_to) VALUES('Existing','Customer','+919000000001','existing@synthetic.invalid',$1) RETURNING id",[actors.boss])).rows[0].id;
  const caseId=(await db.query("INSERT INTO public.cases(customer_id,title,assigned_to,status) VALUES($1,'Existing real-work fixture',$2,'enquiry') RETURNING id",[customer,actors.boss])).rows[0].id;
  await db.query("INSERT INTO public.booking_lines(case_id,service,selling_price,supplier_cost,reference,details) VALUES($1,'hotel',5000,4000,'EXISTING-SUPPLIER','{}')",[caseId]);
  await db.query("INSERT INTO public.payments(direction,case_id,amount,mode,reference,received_by) VALUES('in',$1,2500,'bank','EXISTING-PAYMENT',$2)",[caseId,actors.boss]);
  await db.query("INSERT INTO public.expenses(case_id,name,amount) VALUES($1,'Existing transport',100)",[caseId]);
  await db.query("INSERT INTO public.invoices(number,fy,seq,case_id,customer_id,issued_on,bill_to,case_ref,lines,subtotal,gst,total) VALUES('SYNTHETIC/26/0001','26-27',1,$1,$2,current_date,'{}','{}','[]',5000,0,5000)",[caseId,customer]);
}

export async function createFixture(){
  const db=await PGlite.create({extensions:{pgcrypto,pg_trgm}});
  try{
    await db.exec(platformFixture);
    const names=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
    assert.ok(names.includes(migrationName),'New enquiry migration must exist');
    const previous=names.filter(name=>name<migrationName);
    for(const name of previous){
      let sql=await readFile(new URL(name,migrations),'utf8');
      // PGlite has no background scheduler. Only this legacy infrastructure
      // extension statement is replaced; cron.schedule is the inert fixture above.
      if(name==='20261108000001_core.sql'){
        assert.equal(sql.split('create extension if not exists pg_cron;').length,2);
        sql=sql.replace('create extension if not exists pg_cron;','-- pg_cron platform fixture; no background jobs run in tests.');
      }
      try{await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);}catch(error){throw new Error(`Migration ${name}: ${error.message}`,{cause:error});}
    }
    await seedBusiness(db);
    const baseline=await businessSnapshot(db);
    await db.exec(`BEGIN;\n${await readFile(new URL(migrationName,migrations),'utf8')}\nCOMMIT;`);
    assert.deepEqual(await businessSnapshot(db),baseline,'Adding enquiry schema must not alter existing business rows or sequences');
    return {db,baseline,migrationsApplied:previous.length+1,migrationPath:fileURLToPath(new URL(migrationName,migrations))};
  }catch(error){await db.close();throw error;}
}
