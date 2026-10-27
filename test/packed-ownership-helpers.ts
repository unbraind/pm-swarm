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
import { PmClient, getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { SharedTracker, Swarm, ResourceReservations, trackerResourceBackend } from 'pm-swarm';
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
}}),error=>error.code==='swarm_document_changed');
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
console.log(JSON.stringify({copied_message_retries:3,peer_edits_lost:0,lost_return_claims_released:1,superseded_claims_preserved:preserved}));
`);
  const result = spawnSync(runtime, [script, host], { cwd: repo, env: { ...env, PM_PATH: pmRoot }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { copied_message_retries: 3, peer_edits_lost: 0, lost_return_claims_released: 1, superseded_claims_preserved: 2 });
}
