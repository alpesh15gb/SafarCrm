import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {actors,asRole,businessSnapshot,createFixture} from './max-ai-enquiries-fixture.mjs';

function envelope(service='CRUISE',patch={},environment='live'){
  const enquiryId=randomUUID();
  const draft={service,destination:'Singapore',travelWindow:'March 2030, flexible',adults:2,childAges:[],
    ...(service==='VISA'?{nationality:'Indian',purpose:'Tourism',budgetRupees:123.45,budgetBasis:'TOTAL'}:{}),
    ...(service==='INSURANCE'?{travellerAges:[35,40]}:{}),
    ...(service==='HOLIDAY'?{departureCity:'Hyderabad',budgetRupees:100000000,budgetBasis:'PER_PERSON'}:{}),...patch};
  return {schemaVersion:2,environment,eventId:randomUUID(),eventType:'enquiry.created',aggregateId:enquiryId,occurredAt:'2030-01-01T10:00:00.000Z',revision:1,
    payload:{enquiryId,reference:'ME-'+enquiryId.replaceAll('-','').slice(0,12).toUpperCase(),service,draft,
      contact:{name:'Existing Customer',email:'existing@synthetic.invalid',preferredChannel:'EMAIL'},contactVerified:false,consentAt:'2030-01-01T10:00:00.000Z',createdAt:'2030-01-01T10:00:00.000Z'}};
}
const hash=event=>createHash('sha256').update(JSON.stringify(event)).digest('hex');
const errorCode=code=>error=>{assert.equal(error.code,code,error.message);return true;};
const value=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0].value;
const receive=(db,event,bodyHash=hash(event),role='service_role',actor=null)=>asRole(db,role,actor,()=>value(db,'SELECT public.receive_max_ai_enquiry($1::jsonb,$2) AS value',[JSON.stringify(event),bodyHash]));
const list=(db,actor,filters={},aal='aal2')=>asRole(db,'authenticated',actor,()=>value(db,
  `SELECT public.max_ai_enquiry_list($1,$2,$3,$4,$5::uuid${Object.hasOwn(filters,'environment')?',$6':''}) AS value`,
  [filters.q??'',filters.status??null,filters.service??null,filters.page??1,filters.id??null,...(Object.hasOwn(filters,'environment')?[filters.environment]:[])]),aal);
const update=(db,actor,id,version,status='CONTACTED',note='',assign=false,assignee=null)=>asRole(db,'authenticated',actor,()=>value(db,'SELECT public.update_max_ai_enquiry($1::uuid,$2,$3,$4,$5,$6::uuid) AS value',[id,version,status,note,assign,assignee]));
const rawRows=(db,actor,aal='aal2')=>asRole(db,'authenticated',actor,async()=> (await db.query('SELECT id,draft,contact,status FROM public.max_ai_enquiries ORDER BY id')).rows,aal);

test('isolated PostgreSQL migration, enquiry RPCs and RLS preserve existing Safar transactions',async t=>{
  const {db,baseline,migrationsApplied}=await createFixture();
  const events={},receipts={},assigned={};
  try{
    t.diagnostic(`Loaded ${migrationsApplied} application migrations; ${Object.keys(baseline.tables).length} pre-existing business tables and their sequences are protected by checksum assertions.`);

    await t.test('all four services save only in the inbox with unverified contacts and exact budgets',async()=>{
      for(const service of ['VISA','INSURANCE','HOLIDAY','CRUISE']){
        const event=envelope(service);events[service]=event;
        const receipt=await receive(db,event);receipts[service]=receipt;
        assert.equal(receipt.accepted,true);assert.equal(receipt.receiver,'safar');
        assert.equal(receipt.environment,event.environment);
        assert.equal(receipt.enquiryId,event.payload.enquiryId);assert.equal(receipt.reference,event.payload.reference);
        assert.match(receipt.recordId,/^[0-9a-f-]{36}$/);assert.doesNotMatch(JSON.stringify(receipt),/existing@|Customer|budget/i);
        const stored=(await db.query('SELECT * FROM public.max_ai_enquiries WHERE id=$1',[receipt.recordId])).rows[0];
        assert.equal(stored.status,'NEW');assert.equal(stored.assigned_to,null);assert.equal(stored.contact_verified,false);
        assert.equal(stored.source_environment,'live');
        assert.equal(stored.draft.budgetRupees,undefined);assert.equal(stored.draft.budgetBasis,undefined);
        assert.deepEqual(stored.contact,event.payload.contact);
      }
      const money=(await db.query('SELECT amount_rupees::text,basis FROM private.max_ai_enquiry_financial ORDER BY amount_rupees::numeric')).rows;
      assert.deepEqual(money,[{amount_rupees:'123.45',basis:'TOTAL'},{amount_rupees:'100000000',basis:'PER_PERSON'}]);
      assert.deepEqual(await businessSnapshot(db),baseline);
    });

    await t.test('exact replay is idempotent and changed event, aggregate or payload identities conflict',async()=>{
      const event=events.VISA,receipt=receipts.VISA;
      assert.deepEqual(await receive(db,event),receipt);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM private.max_ai_enquiry_audit WHERE enquiry_id=$1',[receipt.recordId])).rows[0].n,1);
      const changed=structuredClone(event);changed.payload.draft.destination='Different country';
      await assert.rejects(receive(db,changed),errorCode('23505'));
      await assert.rejects(receive(db,{...event,eventId:randomUUID()}),errorCode('23505'));
      const foreign=envelope('VISA');foreign.eventId=event.eventId;
      await assert.rejects(receive(db,foreign),errorCode('23505'));
      // The same unverified email is a separate inbox item, never a customer merge.
      const separate=await receive(db,envelope('VISA'));
      assert.notEqual(separate.recordId,receipt.recordId);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.customers')).rows[0].n,baseline.tables.customers.count);
    });

    await t.test('failed financial writes roll back inbox and audit; booking events cannot enter the receiver',async()=>{
      const counts=async()=> (await db.query("SELECT (SELECT count(*)::int FROM public.max_ai_enquiries) AS inbox,(SELECT count(*)::int FROM private.max_ai_enquiry_financial) AS financial,(SELECT count(*)::int FROM private.max_ai_enquiry_audit) AS audit")).rows[0];
      const before=await counts();
      await assert.rejects(receive(db,envelope('HOLIDAY',{budgetRupees:-1})),errorCode('23514'));
      const missingBasis=envelope('HOLIDAY');delete missingBasis.payload.draft.budgetBasis;
      await assert.rejects(receive(db,missingBasis),errorCode('22023'));
      const booking=envelope();booking.eventType='booking.confirmed';
      await assert.rejects(receive(db,booking),errorCode('22023'));
      const verified=envelope();verified.payload.contactVerified=true;
      await assert.rejects(receive(db,verified),errorCode('22023'));
      const legacy=envelope();legacy.schemaVersion=1;
      await assert.rejects(receive(db,legacy),errorCode('22023'));
      const missingEnvironment=envelope();delete missingEnvironment.environment;
      await assert.rejects(receive(db,missingEnvironment),errorCode('22023'));
      for(const environment of [null,'production','TEST',''])await assert.rejects(receive(db,envelope('CRUISE',{},environment)),errorCode('22023'));
      const duplicateRef=envelope();duplicateRef.payload.reference=events.VISA.payload.reference;
      await assert.rejects(receive(db,duplicateRef),errorCode('23505'));
      assert.deepEqual(await counts(),before);
    });

    await t.test('receiver and raw writes are service-only; unassigned contacts are visible only to the boss',async()=>{
      await assert.rejects(receive(db,envelope(),undefined,'anon'),errorCode('42501'));
      await assert.rejects(receive(db,envelope(),undefined,'authenticated',actors.boss),errorCode('42501'));
      await assert.rejects(asRole(db,'anon',null,()=>value(db,'SELECT public.max_ai_enquiry_list() AS value')),errorCode('42501'));
      await assert.rejects(asRole(db,'service_role',null,()=>db.query('SELECT * FROM public.max_ai_enquiries')),errorCode('42501'));
      await assert.rejects(asRole(db,'authenticated',actors.boss,()=>db.query("UPDATE public.max_ai_enquiries SET status='CLOSED'")),errorCode('42501'));
      for(const actor of [actors.staff,actors.other,actors.allCases,actors.profit]){
        assert.equal((await list(db,actor)).total,0);assert.deepEqual(await rawRows(db,actor),[]);
      }
      assert.equal((await list(db,actors.boss)).total,5);
    });

    await t.test('assignment scopes both RPC and direct RLS reads while profit permission controls the separate budget',async()=>{
      assigned.VISA=await update(db,actors.boss,receipts.VISA.recordId,1,'NEW','',true,actors.staff);
      assigned.INSURANCE=await update(db,actors.boss,receipts.INSURANCE.recordId,1,'NEW','',true,actors.other);
      assigned.HOLIDAY=await update(db,actors.boss,receipts.HOLIDAY.recordId,1,'NEW','',true,actors.profit);
      const mine=await list(db,actors.staff),other=await list(db,actors.other),all=await list(db,actors.allCases);
      assert.deepEqual(mine.rows.map(row=>row.id),[receipts.VISA.recordId]);assert.equal(mine.rows[0].requestedBudget,null);
      assert.equal(other.total,1);assert.equal(other.rows[0].requestedBudget,null);assert.equal(all.total,3);
      assert.equal((await rawRows(db,actors.staff)).length,1);assert.equal((await rawRows(db,actors.allCases)).length,3);
      assert.equal((await list(db,actors.staff,{id:receipts.HOLIDAY.recordId})).enquiry,null);
      assert.doesNotMatch(JSON.stringify(mine),/123\.45|budgetRupees|budgetBasis|body_hash|SYNTHETIC_PRIVATE/);
      const finance=(await list(db,actors.profit,{id:receipts.HOLIDAY.recordId})).enquiry;
      assert.deepEqual(finance.requestedBudget,{amountRupees:100000000,basis:'PER_PERSON'});
      const boss=(await list(db,actors.boss,{id:receipts.VISA.recordId})).enquiry;
      assert.deepEqual(boss.requestedBudget,{amountRupees:123.45,basis:'TOTAL'});
      await assert.rejects(asRole(db,'authenticated',actors.staff,()=>db.query('SELECT * FROM private.max_ai_enquiry_financial')),errorCode('42501'));
      await assert.rejects(asRole(db,'authenticated',actors.profit,()=>db.query('SELECT * FROM private.max_ai_enquiry_financial')),errorCode('42501'));
    });

    await t.test('scoped follow-up is versioned, assignment is boss-only and audit does not duplicate private notes',async()=>{
      const note='SYNTHETIC_PRIVATE_FOLLOW_UP';
      const updated=await update(db,actors.staff,receipts.VISA.recordId,assigned.VISA.version,'CONTACTED',note);
      assert.equal(updated.version,3);assert.equal(updated.internalNote,note);assert.equal(updated.status,'CONTACTED');
      await assert.rejects(update(db,actors.staff,updated.id,2,'CLOSED','stale overwrite'),errorCode('40001'));
      await assert.rejects(update(db,actors.other,updated.id,3,'CLOSED','foreign edit'),errorCode('42501'));
      await assert.rejects(update(db,actors.staff,updated.id,3,'CONTACTED',note,true,actors.other),errorCode('42501'));
      for(const invalid of [actors.client,actors.inactive])await assert.rejects(update(db,actors.boss,updated.id,3,'CONTACTED',note,true,invalid),errorCode('22023'));
      const current=(await list(db,actors.staff,{id:updated.id})).enquiry;
      assert.equal(current.version,3);assert.equal(current.internalNote,note);
      const audit=(await db.query('SELECT detail FROM private.max_ai_enquiry_audit WHERE enquiry_id=$1',[updated.id])).rows;
      assert.doesNotMatch(JSON.stringify(audit),/SYNTHETIC_PRIVATE|existing@/);
      await assert.rejects(asRole(db,'authenticated',actors.boss,()=>db.query('SELECT * FROM private.max_ai_enquiry_audit')),errorCode('42501'));
    });

    await t.test('inactive, client, password-reset and incomplete MFA sessions cannot read or modify enquiries',async()=>{
      const mfaReceipt=await receive(db,envelope('INSURANCE'));
      await update(db,actors.boss,mfaReceipt.recordId,1,'NEW','',true,actors.mfa);
      for(const actor of [actors.inactive,actors.client,actors.password]){
        await assert.rejects(list(db,actor),errorCode('42501'));assert.deepEqual(await rawRows(db,actor),[]);
        await assert.rejects(update(db,actor,receipts.CRUISE.recordId,1),errorCode('42501'));
      }
      await assert.rejects(list(db,actors.mfa,{},'aal1'),errorCode('42501'));
      assert.deepEqual(await rawRows(db,actors.mfa,'aal1'),[]);
      assert.equal((await list(db,actors.mfa,{},'aal2')).total,1);
      assert.equal((await rawRows(db,actors.mfa,'aal2')).length,1);
    });

    await t.test('SQL pagination and literal filters remain scoped and do not disclose foreign contacts',async()=>{
      await receive(db,envelope('CRUISE',{destination:'Synthetic 100%_Place'}));
      for(let index=0;index<22;index++)await receive(db,envelope('CRUISE',{destination:`Synthetic port ${index}`}));
      const first=await list(db,actors.boss),second=await list(db,actors.boss,{page:2});
      assert.equal(first.rows.length,25);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
      assert.equal(first.total,29);assert.equal(second.rows.length,4);
      assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,29);
      assert.equal((await list(db,actors.boss,{q:'%_'})).total,1);
      assert.equal((await list(db,actors.staff,{q:'Synthetic port'})).total,0);
      assert.equal((await list(db,actors.boss,{status:'CONTACTED',service:'VISA'})).total,1);
      for(const invalid of [{q:'x'.repeat(101)},{status:'PAID'},{service:'FLIGHT'},{page:0}])await assert.rejects(list(db,actors.boss,invalid),errorCode('22023'));
    });

    await t.test('test enquiries stay outside the default live inbox and retain environment identity on replay and follow-up',async()=>{
      const liveBefore=await list(db,actors.boss);
      const testEvent=envelope('VISA',{destination:'Synthetic test-only destination'},'test');
      const receipt=await receive(db,testEvent);
      assert.equal(receipt.environment,'test');
      assert.equal((await db.query('SELECT source_environment FROM public.max_ai_enquiries WHERE id=$1',[receipt.recordId])).rows[0].source_environment,'test');
      assert.deepEqual(await receive(db,testEvent),receipt);
      assert.equal((await list(db,actors.boss)).total,liveBefore.total);
      assert.equal((await list(db,actors.boss,{q:'test-only'})).total,0);
      assert.equal((await list(db,actors.boss,{id:receipt.recordId})).enquiry,null);
      assert.equal((await list(db,actors.boss,{id:receipts.VISA.recordId,environment:'test'})).enquiry,null);
      const tests=await list(db,actors.boss,{environment:'test'});
      assert.equal(tests.total,1);assert.equal(tests.rows[0].id,receipt.recordId);assert.equal(tests.rows[0].environment,'test');
      assert.equal((await list(db,actors.boss,{id:receipt.recordId,environment:'test'})).enquiry.id,receipt.recordId);
      for(const environment of [null,'production','TEST',''])await assert.rejects(list(db,actors.boss,{environment}),errorCode('22023'));

      // Even a caller reusing the original body hash cannot relabel an accepted item.
      for(const [event,environment] of [[testEvent,'live'],[events.VISA,'test']]){
        const changed={...event,environment};
        await assert.rejects(receive(db,changed),errorCode('23505'));
        await assert.rejects(receive(db,changed,hash(event)),errorCode('23505'));
        await assert.rejects(receive(db,{...changed,eventId:randomUUID()}),errorCode('23505'));
      }
      assert.deepEqual(await receive(db,testEvent),receipt);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM private.max_ai_enquiry_audit WHERE enquiry_id=$1',[receipt.recordId])).rows[0].n,1);
      await assert.rejects(asRole(db,'authenticated',actors.boss,()=>db.query("UPDATE public.max_ai_enquiries SET source_environment='live' WHERE id=$1",[receipt.recordId])),errorCode('42501'));

      assert.equal((await list(db,actors.staff,{environment:'test'})).total,0);
      const assignedTest=await update(db,actors.boss,receipt.recordId,1,'NEW','',true,actors.staff);
      assert.equal(assignedTest.environment,'test');
      const mine=await list(db,actors.staff,{environment:'test'});
      assert.equal(mine.total,1);assert.equal(mine.rows[0].requestedBudget,null);
      assert.equal((await list(db,actors.other,{id:receipt.recordId,environment:'test'})).enquiry,null);
      assert.equal((await list(db,actors.staff)).total,1);
      const followed=await update(db,actors.staff,receipt.recordId,assignedTest.version,'CONTACTED','Test follow-up');
      assert.equal(followed.environment,'test');
      for(const actor of [actors.inactive,actors.client,actors.password])await assert.rejects(list(db,actor,{environment:'test'}),errorCode('42501'));
      await assert.rejects(list(db,actors.mfa,{environment:'test'},'aal1'),errorCode('42501'));
      assert.equal((await list(db,actors.boss)).total,liveBefore.total);
      assert.equal((await list(db,actors.boss,{environment:'test'})).total,1);
    });

    await t.test('all pre-existing business rows, financial totals and numbering remain byte-for-byte unchanged',async()=>{
      assert.ok(baseline.tables.customers.count>0);assert.ok(baseline.tables.cases.count>0);
      assert.ok(baseline.tables.booking_lines.count>0);assert.ok(baseline.tables.payments.count>0);assert.ok(baseline.tables.invoices.count>0);
      assert.deepEqual(await businessSnapshot(db),baseline);
    });
  }finally{await db.close();}
});
