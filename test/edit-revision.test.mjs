import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instructions } from '../src/instructions.mjs';
import { Skills } from '../src/skills.mjs';
import { fileRevision } from '../src/edit-revision.mjs';
import { Commands } from '../src/commands.mjs';
const first='---\nname: demo\ndescription: first\n---\nfirst';
const second=first.replaceAll('first','second');
test('the same file precondition protects instructions, skills and commands from stale edits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'extensions-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'demo.md');await writeFile(path,first);const before=await fileRevision(path);
 const owner={effect(){}}, scope={};
 const instructions=new Instructions(owner,{});
 instructions.withFiles=(_scope,use)=>use({files:[{path,exists:true,maxBytes:4096}]},async()=>{});
 const skills=new Skills(owner);skills.find=async()=>({path,editable:true,candidate:{source:'user-dsh'}});
 Object.assign(skills,{registry(){},assertOwner(){},validateFile(){},invalidate(){}});
 const commands=new Commands(owner,{dsh:root});
 Object.assign(commands,{run:fn=>fn({}),views:()=>[],builtin:()=>[],locate:async()=>root,requireOwner(){},afterChange(){}});
 await instructions.save(scope,path,second,undefined,before);
 for(const save of [()=>instructions.save(scope,path,first,undefined,before),()=>skills.save(scope,path,first,before),
  ()=>commands.save(scope,{location:'user',name:'demo',previous:'demo',body:'old',revision:before}),()=>commands.remove(scope,'user','demo',before)]){
  await assert.rejects(save(),{code:'edit-conflict'});assert.equal(await readFile(path,'utf8'),second);
 }
 await assert.rejects(instructions.save(scope,path,first,undefined,'absent'),{code:'edit-conflict'});
 await commands.save(scope,{location:'user',name:'demo',previous:'demo',body:'latest',revision:await fileRevision(path)});
 assert.match(await readFile(path,'utf8'),/latest/);
});
