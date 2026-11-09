import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Kill packed Node/Bun consumers at every compensation member boundary on a real non-Git tracker. */
export function assertPackedCrashRecovery(runtime: string, repo: string, environment: NodeJS.ProcessEnv): void {
  const worker = join(repo, 'packed-close-crash-worker.mjs');
  writeFileSync(worker, `
import {PmClient} from '@unbrained/pm-cli/sdk';
import {Swarm,SharedTracker,withCloseObserver} from 'pm-swarm';
const input=JSON.parse(process.argv[2]);let restored=0;
const client=new PmClient({cwd:process.cwd(),pmRoot:process.env.PM_PATH,author:'packed-crash'});
await withCloseObserver((boundary)=>{
  if(boundary===input.boundary||boundary==='compensating'&&input.kill===0||boundary==='restored'&&++restored===input.kill)process.kill(process.pid,'SIGKILL');
  if(boundary==='before_commit')throw new Error('Packed ordinary failure');
},()=>new SharedTracker(new Swarm(process.cwd(),process.env.PM_PATH,client,'packed-crash')).close(input.id,'Packed crash proof',input.token));
`);
  const driver = join(repo, 'packed-close-crash-driver.mjs');
  writeFileSync(driver, `
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import filesystem from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
${runtime === process.execPath ? '' : "import {mock} from 'bun:test';"}
import {PmClient,getItemPath,getHistoryPath} from '@unbrained/pm-cli/sdk';
import {Swarm,SharedTracker,withCloseObserver,CLOSE_INTENT} from 'pm-swarm';
const root=process.env.PM_PATH;const client=new PmClient({cwd:process.cwd(),pmRoot:root,author:'packed-crash'});
// Bun retains named builtin bindings; explicitly replace and restore the filesystem module in that runtime.
const setRead=readFile=>{filesystem.readFile=readFile;${runtime === process.execPath ? 'syncBuiltinESMExports();' : "mock.module('node:fs/promises',()=>({default:filesystem,...filesystem,readFile}));"}};
const shared=new SharedTracker(new Swarm(process.cwd(),root,client,'packed-crash'));let killed=0;
for(const count of [1,2,3])for(let kill=0;kill<=count+1;kill++){
  const id=(await client.create({type:'Task',title:'Packed crash domain'})).item.id;const claim=await shared.start(id);const members=[id];
  for(let n=0;n<count;n++)members.push((await client.create({type:'Task',title:'Packed dependent',status:'blocked',blockedBy:id,blockedReason:'Public dependency'})).item.id);
  const paths=members.map(member=>getItemPath(root,'Task',member));const streams=members.map(member=>getHistoryPath(root,member));
  const bytes=()=>paths.map(path=>readFileSync(path,'utf8'));const before=bytes();const history=streams.map(path=>readFileSync(path,'utf8'));
  const child=spawnSync(process.execPath,[process.argv[2],JSON.stringify({id,token:claim.token,kill})],{encoding:'utf8',timeout:120000});
  assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);killed++;
  for(let retry=0;retry<2;retry++){
    await assert.rejects(shared.close(id,'Packed crash proof',claim.token),error=>error.code==='swarm_close_compensated');assert.deepEqual(bytes(),before);
    for(const [index,path]of streams.entries())assert.ok(readFileSync(path,'utf8').startsWith(history[index]));
  }
  for(const member of members)await client.delete(member,{force:true});
}
let transferRefusals=0;
for(const phase of ['applying','compensating','malformed']){
  const id=(await client.create({type:'Task',title:'Packed pending ownership'})).item.id;const claim=await shared.start(id);
  const child=spawnSync(process.execPath,[process.argv[2],JSON.stringify({id,token:claim.token,boundary:phase==='compensating'?'compensating':'intent'})],{encoding:'utf8',timeout:120000});
  assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);
  if(phase==='compensating')await client.update(id,{force:true,status:'in_progress',assignee:'packed-crash'});
  if(phase==='malformed')await client.update(id,{force:true,field:[CLOSE_INTENT+'=malformed']});
  const paths=[getItemPath(root,'Task',id),getHistoryPath(root,id)];const bytes=()=>paths.map(path=>readFileSync(path,'utf8'));const before=bytes();
  await assert.rejects(shared.start(id),error=>error.code==='swarm_close_transfer_refused');
  await assert.rejects(shared.handoff(id,'receiver','Packed transfer',claim.token),error=>error.code==='swarm_close_transfer_refused');
  const receiver=new SharedTracker(new Swarm(process.cwd(),root,client,'receiver'));
  for(const dry of [true,false])for(const to of [undefined,'receiver']){
    const result=await receiver.reclaim(0.000001,to,dry);assert.deepEqual(result.recovered,[]);assert.equal(result.refused.find(row=>row.id===id)?.code,'swarm_close_transfer_refused');
    for(const json of [false,true]){
      const replay=spawnSync(process.execPath,[process.argv[3],'swarm','reclaim','--stale-after','0.000001','--author','receiver',...(to?['--to',to]:[]),...(dry?['--dry-run']:[]),...(json?['--json']:[])],{encoding:'utf8',timeout:120000});
      assert.equal(replay.status,0,replay.stdout+replay.stderr);assert.ok(replay.stdout.includes('swarm_close_transfer_refused'),replay.stdout);transferRefusals++;
    }
  }
  assert.deepEqual(bytes(),before);await client.delete(id,{force:true});
}
let confirmations=0;
for(const count of [0,1,3])for(const artifact of ['item','history']){
  const id=(await client.create({type:'Task',title:'Packed lost confirmation'})).item.id;const claim=await shared.start(id);const members=[id];
  for(let n=0;n<count;n++)members.push((await client.create({type:'Task',title:'Packed confirmation dependent',status:'blocked',blockedBy:id,blockedReason:'Public dependency'})).item.id);
  const paths=members.flatMap(member=>[getItemPath(root,'Task',member),getHistoryPath(root,member)]);const bytes=()=>paths.map(path=>readFileSync(path,'utf8'));
  const target=artifact==='item'?getItemPath(root,'Task',id):getHistoryPath(root,id);const read=filesystem.readFile;let armed=false;let failures=0;let saved;
  setRead(new Proxy(read,{apply(fn,receiver,args){if(armed&&args[0]===target){armed=false;failures++;throw Object.assign(new Error('Packed read outage'),{code:'EIO'});}return Reflect.apply(fn,receiver,args);}}));
  try{await assert.rejects(withCloseObserver(boundary=>{if(boundary==='committed'){saved=bytes();armed=true;throw new Error('Packed lost return');}},()=>shared.close(id,'Packed confirmation proof',claim.token)),error=>error.code==='swarm_partial_commit');}
  finally{setRead(read);}
  if(artifact==='history')assert.equal(failures,1,'The native consumer must encounter the injected read outage');
  assert.deepEqual(bytes(),saved);assert.equal(JSON.parse((await client.get(id)).item[CLOSE_INTENT]).phase,'committed');
  assert.equal((await shared.close(id,'Packed confirmation proof',claim.token)).closed,true);
  for(const json of [false,true]){
    const replay=spawnSync(process.execPath,[process.argv[3],'swarm','close',id,'--author','packed-crash','--token',claim.token,'--note','Packed confirmation proof',...(json?['--json']:[])],{encoding:'utf8',timeout:120000});
    assert.equal(replay.status,0,replay.stdout+replay.stderr);assert.ok(json?JSON.parse(replay.stdout).closed:replay.stdout.includes('closed: true'));
  }
  assert.deepEqual(bytes(),saved);confirmations++;
  for(const member of members)await client.delete(member,{force:true});
}
console.log(JSON.stringify({packed_sigkill_cases:killed,packed_confirmation_cases:confirmations,packed_transfer_refusals:transferRefusals,exact_native_bytes:true}));
`);
  const result = spawnSync(runtime, [driver, worker, join(repo, 'node_modules/.bin/pm')], { cwd: repo, env: environment, encoding: 'utf8', timeout: 900000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { packed_sigkill_cases: 12, packed_confirmation_cases: 6, packed_transfer_refusals: 24, exact_native_bytes: true });
}
