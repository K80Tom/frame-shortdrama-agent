const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve,dirname,basename}=require('node:path');
const {readMigrations}=require('../dist/db/migrate');

test('duplicate migration versions fail before any database connection, even if their SQL is identical',async t=>{
 const base=resolve(tmpdir()),dir=await mkdtemp(join(base,'lyra-migration-numbering-'));
 t.after(async()=>{
  if(dirname(resolve(dir))!==base||!basename(dir).startsWith('lyra-migration-numbering-'))throw Error('测试目录越界，拒绝清理。');
  await rm(dir,{recursive:true,force:true});
 });
 await writeFile(join(dir,'042_first.sql'),'SELECT 1;\n');
 await writeFile(join(dir,'042_second.sql'),'SELECT 1;\n');
 await assert.rejects(readMigrations(dir),error=>error.message.includes('042_first.sql')&&error.message.includes('042_second.sql')&&error.message.includes('重复'));
});

test('the merged canvas/assistant migrations and evolution upgrade retain separate authoritative version numbers',async()=>{
 const migrations=await readMigrations(join(__dirname,'../migrations'));
 assert.equal(new Set(migrations.map(m=>m.version)).size,migrations.length);
 const files=new Map(migrations.map(m=>[m.version,m.fileName]));
 assert.equal(files.get('032'),'032_canvas_documents.sql');
 assert.equal(files.get('039'),'039_assistant_turns.sql');
 assert.equal(files.get('045'),'045_evolution_registry_tenancy.sql');
 assert.equal(files.get('054'),'054_retrieval_policy_observations.sql');
});
