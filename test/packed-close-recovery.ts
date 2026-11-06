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
  if(boundary==='compensating'&&input.kill===0||boundary==='restored'&&++restored===input.kill)process.kill(process.pid,'SIGKILL');
  if(boundary==='before_commit')throw new Error('Packed ordinary failure');
},()=>new SharedTracker(new Swarm(process.cwd(),process.env.PM_PATH,client,'packed-crash')).close(input.id,'Packed crash proof',input.token));
`);
  const driver = join(repo, 'packed-close-crash-driver.mjs');
  writeFileSync(driver, `
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {PmClient,getItemPath,getHistoryPath} from '@unbrained/pm-cli/sdk';
import {Swarm,SharedTracker} from 'pm-swarm';
const root=process.env.PM_PATH;const client=new PmClient({cwd:process.cwd(),pmRoot:root,author:'packed-crash'});
const shared=new SharedTracker(new Swarm(process.cwd(),root,client,'packed-crash'));let killed=0;
for(const count of [1,2,3])for(let kill=0;kill<=count+1;kill++){
  const id=(await client.create({type:'Task',title:'Packed crash domain'})).item.id;const claim=await shared.start(id);const members=[id];
  for(let n=0;n<count;n++)members.push((await client.create({type:'Task',title:'Packed dependent',status:'blocked',blockedBy:id,blockedReason:'Public dependency'})).item.id);
  const paths=members.map(member=>getItemPath(root,'Task',member));const streams=members.map(member=>getHistoryPath(root,member));
  const bytes=()=>paths.map(path=>readFileSync(path,'utf8'));const before=bytes();const history=streams.map(path=>readFileSync(path,'utf8'));
  const child=spawnSync(process.execPath,[process.argv[2],JSON.stringify({id,token:claim.token,kill})],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);killed++;
  for(let retry=0;retry<2;retry++){
    await assert.rejects(shared.close(id,'Packed crash proof',claim.token),error=>error.code==='swarm_close_compensated');assert.deepEqual(bytes(),before);
    for(const [index,path]of streams.entries())assert.ok(readFileSync(path,'utf8').startsWith(history[index]));
  }
  for(const member of members)await client.delete(member,{force:true});
}
console.log(JSON.stringify({packed_sigkill_cases:killed,exact_native_bytes:true}));
`);
  const result = spawnSync(runtime, [driver, worker], { cwd: repo, env: environment, encoding: 'utf8', timeout: 300000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { packed_sigkill_cases: 12, exact_native_bytes: true });
}
