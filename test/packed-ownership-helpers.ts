import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Verify journal ownership in the actual packed module graph and a real independent peer process. */
export function assertPackedCloseOwnership(runtime: string, repo: string, pmRoot: string, host: string, env: NodeJS.ProcessEnv): void {
  const script = join(repo, 'verify-close-ownership.mjs');
  writeFileSync(script, `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PmClient, getHistoryPath, getItemPath, readHistoryEntries, getItemAt, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { SharedTracker, Swarm, ResourceReservations, trackerResourceBackend, withItemMutationObserver } from 'pm-swarm';
const client = new PmClient({cwd:process.cwd(),pmRoot:process.env.PM_PATH,author:'packed-worker'});
const shared = new SharedTracker(new Swarm(process.cwd(),process.env.PM_PATH,client,'packed-worker'));
const id=(await client.create({type:'Task',title:'Packed ownership fixture'})).item.id;
const claim=await shared.start(id);let failed=false;let peer=false;
await assert.rejects(shared.close(id,'Packed journal proof',claim.token,{onTransition:context=>{
  if(!failed&&context.transition==='step_recorded'){failed=true;throw new Error('Force compensation');}
  if(!peer&&context.transition==='step_compensating'){
    peer=true;const row=JSON.parse(readFileSync(getHistoryPath(process.env.PM_PATH,id),'utf8').trim().split('\\n').at(-1));
    const result=spawnSync(process.execPath,[process.argv[2],'update',id,'--title','Packed peer survives','--message',row.message,'--author','packed-worker','--json'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
}}),error=>error.code==='swarm_superseded');
assert.equal(peer,true);const before=readFileSync(getHistoryPath(process.env.PM_PATH,id),'utf8');
for(let retry=0;retry<3;retry++){
  await assert.rejects(shared.close(id,'Packed journal proof',claim.token),error=>error.code==='swarm_document_changed');
  assert.equal(readFileSync(getHistoryPath(process.env.PM_PATH,id),'utf8'),before);
  assert.equal((await client.get(id)).item.title,'Packed peer survives');
}
const failedId=(await client.create({type:'Task',title:'Packed lost return'})).item.id;
const update=client.update.bind(client);let lost=false;
client.update=new Proxy(update,{async apply(target,receiver,args){const result=await Reflect.apply(target,receiver,args);if(!lost){lost=true;throw new Error('Lost packed native return');}return result;}});
try{await assert.rejects(shared.start(failedId),error=>error.code==='swarm_partial_commit');}finally{client.update=update;}
assert.equal(lost,true);assert.equal((await client.get(failedId)).item.assignee,undefined);
let preserved=0;
for(const resource of [false,true]){
  const peerId=(await client.create({type:'Task',title:'Packed peer generation',...(resource?{tags:'swarm-resource'}:{})})).item.id;
  let interrupted=false;let peerBytes=[];
  const bytes=()=>[getItemPath(process.env.PM_PATH,'Task',peerId),getHistoryPath(process.env.PM_PATH,peerId)].map(path=>readFileSync(path,'utf8'));
  client.update=new Proxy(update,{async apply(target,receiver,args){
    const result=await Reflect.apply(target,receiver,args);
    if(!interrupted){interrupted=true;const peer=spawnSync(process.execPath,[process.argv[2],'update',peerId,'--field','swarm_token=9','--author','packed-worker','--json'],{encoding:'utf8'});assert.equal(peer.status,0,peer.stdout+peer.stderr);peerBytes=bytes();throw new Error('Lost packed generation return');}return result;
  }});
  try{const reservations=new ResourceReservations(trackerResourceBackend(shared.engine),'packed-worker');await assert.rejects(resource?reservations.reserve(peerId):shared.start(peerId),error=>error.code==='swarm_superseded');}finally{client.update=update;}
  assert.equal(interrupted,true);assert.deepEqual(bytes(),peerBytes);const current=(await client.get(peerId)).item;assert.equal(current.assignee,'packed-worker');assert.equal(current.swarm_token,'9');preserved++;
}
let historyPreserved=0;
for(const resource of [false,true]){
  const peerId=(await client.create({type:'Task',title:'Packed native history ABA',...(resource?{tags:'swarm-resource'}:{})})).item.id;
  const bytes=()=>[getItemPath(process.env.PM_PATH,'Task',peerId),getHistoryPath(process.env.PM_PATH,peerId)].map(path=>readFileSync(path,'utf8'));
  let lost=false;let peer=false;let peerBytes=[];
  client.update=new Proxy(update,{async apply(target,receiver,args){const result=await Reflect.apply(target,receiver,args);if(!lost){lost=true;throw new Error('Lost packed history return');}return result;}});
  try{
    const [attempt]=await Promise.allSettled([withItemMutationObserver(async boundary=>{
      if(!lost||peer||boundary!=='before_commit')return;peer=true;
      const history=await readHistoryEntries(getHistoryPath(process.env.PM_PATH,peerId),peerId);
      const before=await getItemAt(peerId,history.at(-1).ts,{pmRoot:process.env.PM_PATH});const original=bytes()[0];
      for(const args of [['release',peerId],['claim',peerId,'--force'],['restore',peerId,String(before.as_of_version),'--force']]){
        const result=spawnSync(process.execPath,[process.argv[2],...args,'--author','packed-worker','--json'],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
      }
      assert.equal(bytes()[0],original);assert.ok((await readHistoryEntries(getHistoryPath(process.env.PM_PATH,peerId),peerId)).length>history.length);peerBytes=bytes();
    },()=>resource?new ResourceReservations(trackerResourceBackend(shared.engine),'packed-worker').reserve(peerId):shared.start(peerId))]);
    assert.equal(peer,true);assert.deepEqual(bytes(),peerBytes);assert.equal(attempt.status,'rejected');assert.equal(attempt.reason.code,'swarm_superseded');historyPreserved++;
  }finally{client.update=update;}
}
const blocker=(await client.create({type:'Task',title:'Packed native lifecycle'})).item.id;
const dependent=(await client.create({type:'Task',title:'Packed blocked dependent',status:'blocked',blockedBy:blocker,blockedReason:'Public dependency'})).item.id;
const lifecycleClaim=await shared.start(blocker);await client.update(blocker,{blockedReason:'Public prior blocker'});
let interrupted=false;
await assert.rejects(shared.close(blocker,'Packed native completion',lifecycleClaim.token,{onTransition:context=>{
  if(!interrupted&&context.transition==='step_applied'&&context.stepId==='close'){interrupted=true;throw new WorkspaceTransactionInterruptedError('Interrupt packed native close');}
}}),WorkspaceTransactionInterruptedError);
const recoveredClose=await shared.close(blocker,'Packed native completion',lifecycleClaim.token);assert.equal(recoveredClose.warnings_unavailable,true);assert.match(recoveredClose.required,/dependent items/);
assert.equal((await client.get(blocker)).item.blocked_reason,undefined);assert.equal((await client.get(dependent)).item.status,'open');
const lifecycleHistory=readFileSync(getHistoryPath(process.env.PM_PATH,blocker),'utf8');
await shared.close(blocker,'Packed native completion',lifecycleClaim.token);assert.equal(readFileSync(getHistoryPath(process.env.PM_PATH,blocker),'utf8'),lifecycleHistory);
const closing=(await client.create({type:'Task',title:'Packed forward close ABA'})).item.id;const closingClaim=await shared.start(closing);
let closePeer=false;let closeBytes=[];
const [closeAttempt]=await Promise.allSettled([withItemMutationObserver(async boundary=>{
  if(closePeer||boundary!=='before_commit')return;closePeer=true;
  const history=await readHistoryEntries(getHistoryPath(process.env.PM_PATH,closing),closing);
  const before=await getItemAt(closing,history.at(-1).ts,{pmRoot:process.env.PM_PATH});
  for(const args of [['release',closing],['claim',closing,'--force'],['restore',closing,String(before.as_of_version),'--force']]){
    const result=spawnSync(process.execPath,[process.argv[2],...args,'--author','packed-worker','--json'],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
  }
  closeBytes=[getItemPath(process.env.PM_PATH,'Task',closing),getHistoryPath(process.env.PM_PATH,closing)].map(path=>readFileSync(path,'utf8'));
},()=>shared.close(closing,'Packed stale completion',closingClaim.token))]);
assert.equal(closePeer,true);assert.equal(closeAttempt.status,'rejected');assert.equal(closeAttempt.reason.code,'swarm_superseded');
assert.deepEqual([getItemPath(process.env.PM_PATH,'Task',closing),getHistoryPath(process.env.PM_PATH,closing)].map(path=>readFileSync(path,'utf8')),closeBytes);
const paired=(await client.create({type:'Task',title:'Packed snapshot window'})).item.id;const pairedClaim=await shared.start(paired);
const get=client.get.bind(client);let snapshotPeer=false;let snapshotBytes=[];
client.get=new Proxy(get,{async apply(target,receiver,args){const result=await Reflect.apply(target,receiver,args);if(!snapshotPeer){
  snapshotPeer=true;const history=await readHistoryEntries(getHistoryPath(process.env.PM_PATH,paired),paired);const version=(await getItemAt(paired,history.at(-1).ts,{pmRoot:process.env.PM_PATH})).as_of_version;
  for(const args of [['release',paired],['claim',paired,'--force'],['restore',paired,String(version),'--force']]){const peer=spawnSync(process.execPath,[process.argv[2],...args,'--author','packed-worker','--json'],{encoding:'utf8'});assert.equal(peer.status,0,peer.stdout+peer.stderr);}
  snapshotBytes=[getItemPath(process.env.PM_PATH,'Task',paired),getHistoryPath(process.env.PM_PATH,paired)].map(path=>readFileSync(path,'utf8'));
}return result;}});
try{await assert.rejects(shared.handoff(paired,'receiver','Packed paired handoff',pairedClaim.token),error=>error.code==='swarm_superseded');}finally{client.get=get;}
assert.equal(snapshotPeer,true);assert.deepEqual([getItemPath(process.env.PM_PATH,'Task',paired),getHistoryPath(process.env.PM_PATH,paired)].map(path=>readFileSync(path,'utf8')),snapshotBytes);
const rollbackBlocker=(await client.create({type:'Task',title:'Packed compensation domain'})).item.id;
const rollbackDependent=(await client.create({type:'Task',title:'Packed compensated dependent',status:'blocked',blockedBy:rollbackBlocker,blockedReason:'Public blocker'})).item.id;
const rollbackClaim=await shared.start(rollbackBlocker);const domain=[rollbackBlocker,rollbackDependent];const originals=domain.map(id=>readFileSync(getItemPath(process.env.PM_PATH,'Task',id),'utf8'));
await assert.rejects(shared.close(rollbackBlocker,'Packed full compensation',rollbackClaim.token,{onTransition:context=>{if(context.transition==='committing')throw new Error('Packed ordinary failure');}}),/Packed ordinary failure/);
assert.deepEqual(domain.map(id=>readFileSync(getItemPath(process.env.PM_PATH,'Task',id),'utf8')),originals);
let compensationCrash=false;
await assert.rejects(shared.close(rollbackBlocker,'Packed full compensation',rollbackClaim.token,{onTransition:context=>{
  if(context.transition==='committing')throw new Error('Packed compensation crash');
  if(context.transition==='compensating'){compensationCrash=true;throw new WorkspaceTransactionInterruptedError('Stop before packed compensation');}
}}));
assert.equal(compensationCrash,true);await shared.close(rollbackBlocker,'Packed full compensation',rollbackClaim.token);assert.equal((await client.get(rollbackDependent)).item.status,'open');
console.log(JSON.stringify({copied_message_retries:3,peer_edits_lost:0,lost_return_claims_released:1,superseded_claims_preserved:preserved,native_history_aba_preserved:historyPreserved,native_close_recovery:1,forward_close_aba_preserved:1,snapshot_window_aba_preserved:1,complete_close_compensation:1}));
`);
  const result = spawnSync(runtime, [script, host], { cwd: repo, env: { ...env, PM_PATH: pmRoot }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { copied_message_retries: 3, peer_edits_lost: 0, lost_return_claims_released: 1, superseded_claims_preserved: 2, native_history_aba_preserved: 2, native_close_recovery: 1, forward_close_aba_preserved: 1, snapshot_window_aba_preserved: 1, complete_close_compensation: 1 });
}
